#!/usr/bin/env node
'use strict';

/*
 * Burnglass (formerly Pulse) — a local, zero-dependency usage dashboard for
 * Claude Code, OpenAI Codex and other coding agents.
 *
 * Reads the newline-delimited JSON session logs Claude Code writes under
 * ~/.claude/projects, aggregates them, and serves a self-refreshing
 * dashboard on http://localhost:4747.
 *
 * HARD RULE: this tool only ever READS from ~/.claude. It never writes,
 * moves, or deletes anything under that tree.
 *
 * Node >= 18 built-ins only. No dependencies, no telemetry. Usage data never
 * leaves this machine. NETWORK CALLS, EXHAUSTIVELY — every one of them is
 * either opt-out or opt-in, and none of them sends anything about you:
 *   - api.github.com — version check + community-reach counters (PUBLIC repo
 *     numbers read IN, nothing sent OUT). Opt-out: --no-update-check.
 *   - api.anthropic.com — Claude account limit meters. Opt-in.
 *   - chatgpt.com — Codex account token totals. Opt-in.
 *   - api.meshy.ai — Meshy 3D credit balance + task credit usage. Opt-in
 *     TWICE (config `meshy: true` AND a stored `meshyApiKey`). The API key is
 *     the one credential Burnglass stores: header-only, never logged, never
 *     in a payload, never in a URL, sent to no other host.
 *   - the Discord desktop client's LOCAL socket (opt-in; not the network).
 *
 * FROZEN COMPATIBILITY IDENTIFIERS (the product was called Pulse up to v1.34;
 * these still say "pulse" ON PURPOSE — old and new processes, companions and
 * browser tabs meet each other during every upgrade): the `X-Pulse: 1`
 * mutation header (X-Burnglass is accepted too, but requestShutdown SENDS
 * X-Pulse so v2 can stop a running v1), the `PulseTray<port>` and
 * `PulseStrip_SingleInstance` mutexes, the HKCU Run value name `Pulse`, the
 * `pulse-*` localStorage keys, the Discord client id + `pulse` asset key,
 * every CLI flag, the /api response shapes, port 4747, the PULSE_* env vars
 * (BURNGLASS_* aliases win), the PULSE_VERSION constant name (make-exe greps
 * it) and the v1 release-asset names (pulse.exe / pulse-linux / pulse-macos
 * must stay on every 2.x release: v1.x self-updaters match them exactly).
 */

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const os = require('os');
const url = require('url');
const crypto = require('crypto');

// Version — keep in sync with package.json (build/make-exe.mjs enforces this).
// The constant keeps its v1 NAME: make-exe's drift check greps for it.
const PULSE_VERSION = '2.0.0-rc.1';
const BRAND = 'Burnglass';

// BURNGLASS_<NAME> wins; PULSE_<NAME> (the v1 spelling) stays a permanent,
// silent alias so no user setup or test harness breaks. An empty value counts
// as unset, so `BURNGLASS_X=` can never mask a real PULSE_X.
function envv(name) {
  const v = process.env['BURNGLASS_' + name];
  if (v !== undefined && v !== '') return v;
  return process.env['PULSE_' + name];
}
const SERVER_START = Date.now();
let IS_DAEMON_CHILD = false; // set when running as the hidden background child
let IS_AFTER_UPDATE = false; // set on the relaunch right after a self-update
// Sources that are NOT the Claude Code subscription (each has its own limits /
// billing). Used to keep the Claude 5-hour block honest — it must count ONLY
// Claude Code usage, never Codex or the other ingested agents. GLM stays in
// (it flows through Claude Code itself).
const AGENT_SOURCES = new Set(['codex', 'gemini', 'cline', 'continue', 'roo']);
// Sources whose numbers are self-reported estimates (Continue computes token
// counts locally rather than reading provider billing). Constant so the "est"
// badge survives after the live logs are pruned and only the archive remains.
const KNOWN_ESTIMATE_SOURCES = new Set(['continue']);
// True when an entry is NOT Claude Code subscription usage (it has its own
// limits/billing): the fixed agent roster above plus any config-defined custom
// source (provider 'custom'). Gates the 5h block, selfCheck, and Discord art —
// the roster alone can't know config-defined names, the provider tag can.
function nonClaudeEntry(e) { return AGENT_SOURCES.has(e.source) || e.provider === 'custom'; }

// ---------------------------------------------------------------------------
// LOGGING
// Everything logged via console.* is mirrored into a ring buffer — served at
// /api/logs for the dashboard's Server panel — and, when running as a hidden
// background process, appended to ~/.burnglass/burnglass.log.
// ---------------------------------------------------------------------------
const LOG_RING_MAX = 400;
const LOG_FILE_MAX = 2 * 1024 * 1024;
const logRing = [];
let logFileStream = null;
let logFilePath = null;
let logFileBytes = 0;
let logRotating = false;

function pushLogLine(level, args) {
  let text;
  try {
    text = args.map((a) => (typeof a === 'string' ? a : (a && a.stack) || String(a))).join(' ');
  } catch (_) { text = '[unprintable]'; }
  logRing.push({ ts: Date.now(), level, text });
  if (logRing.length > LOG_RING_MAX) logRing.splice(0, logRing.length - LOG_RING_MAX);
  if (logFileStream) {
    const line = new Date().toISOString() + ' ' + level.toUpperCase().padEnd(5) + ' ' + text + '\n';
    try { logFileStream.write(line); logFileBytes += Buffer.byteLength(line); } catch (_) {}
    if (logFileBytes > LOG_FILE_MAX) rotateLogFile(); // rotate during the run, not just at open
  }
}

function rotateLogFile() {
  if (logRotating || !logFileStream || !logFilePath) return;
  logRotating = true;
  try {
    const old = logFileStream;
    logFileStream = null;
    try { old.end(); } catch (_) {}
    try { fs.unlinkSync(logFilePath + '.1'); } catch (_) {}
    try { fs.renameSync(logFilePath, logFilePath + '.1'); } catch (_) {}
  } catch (_) {}
  openLogFile();
  logRotating = false;
}

{
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origErr = console.error.bind(console);
  console.log = (...a) => { pushLogLine('info', a); try { origLog(...a); } catch (_) {} };
  console.warn = (...a) => { pushLogLine('warn', a); try { origWarn(...a); } catch (_) {} };
  console.error = (...a) => { pushLogLine('error', a); try { origErr(...a); } catch (_) {} };
}

// ---------------------------------------------------------------------------
// HOME — ~/.burnglass is the ONLY place Burnglass writes (config, logs,
// history, caches, effort sidecar). Resolution, first match wins:
//   1. BURNGLASS_HOME, else PULSE_HOME (v1 alias) — the user pinned it: used
//      VERBATIM, never migrated, and no legacy compat reads/writes apply.
//   2. ~/.burnglass when it exists.
//   3. ~/.pulse (Pulse <= 1.34) when only IT exists and holds Pulse files
//      (isPulseHome — PulseAudio's legacy ~/.pulse is not ours) — the
//      pre-migration state.
//      Deliberately NOT memoized: the first v2 SERVER that owns its port
//      copies ~/.pulse to ~/.burnglass (migrateHome, called from the listen
//      callback) and flips this. Short-lived commands (--statusline,
//      --mode-hook, --summary, setup printers, --startup, --stop) only
//      RESOLVE — before the first v2 server run they keep using ~/.pulse,
//      which the migration then copies.
//   4. ~/.burnglass (fresh install; created lazily by the first write).
// A failed migration memoizes ~/.pulse ("degraded": fully working, retried
// on the next start).
// ---------------------------------------------------------------------------
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };
const isFileAt = (p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } };
const samePathAbs = (a, b) => {
  const ra = path.resolve(String(a)), rb = path.resolve(String(b));
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
};
// Are a and b the SAME file or folder on disk? A string compare is not
// enough: `~/.pulse -> ~/.burnglass` (a symlink / junction left for old
// companions), the reverse, or a per-file config.json link all make two
// different path strings name ONE object — and the legacy compat writers
// (the Meshy-key scrub most of all) would then edit the live home while
// believing it is an inert backup. dev+ino identifies the object (stat
// follows links and junctions); a filesystem reporting no inode falls back
// to comparing the resolved real paths. A missing path is never "the same".
function sameEntry(a, b) {
  if (samePathAbs(a, b)) return true;
  let sa, sb;
  try { sa = fs.statSync(a, { bigint: true }); sb = fs.statSync(b, { bigint: true }); } catch (_) { return false; }
  if (sa.ino && sb.ino) return sa.dev === sb.dev && sa.ino === sb.ino;
  try { return samePathAbs(fs.realpathSync.native(a), fs.realpathSync.native(b)); } catch (_) { return false; }
}
// Does this folder hold something PULSE wrote? `~/.pulse` is also the name
// of PulseAudio's legacy per-user folder (and some homes just have an empty
// one): without a Pulse file in it, it is neither the pre-migration home nor
// something to migrate, mirror into or list as "your data".
const PULSE_HOME_FILES = ['config.json', 'meshy.json', 'modes.jsonl', 'discord-presence.json',
  'strip.json', 'strip-ui.json', 'strip_cells.json', 'server.json', 'pulse.log', 'tray.ps1'];
function isPulseHome(dir) {
  if (!isDir(dir)) return false;
  for (const f of PULSE_HOME_FILES) if (isFileAt(path.join(dir, f))) return true;
  return isDir(path.join(dir, 'history'));
}
function explicitHome() { return envv('HOME') || null; }
function newHomePath() { return path.join(os.homedir(), '.burnglass'); }
function legacyHomePath() { return path.join(os.homedir(), '.pulse'); }
let homeResolved = null;
function appHome() {
  if (homeResolved) return homeResolved;
  const ex = explicitHome();
  if (ex) return (homeResolved = ex);
  const next = newHomePath();
  if (isDir(next)) return (homeResolved = next);
  const legacy = legacyHomePath();
  if (isPulseHome(legacy)) return legacy; // pre-migration: NOT memoized (see above)
  return (homeResolved = next);
}
// True while ~/.pulse is still the home and the first v2 server has not yet
// copied it (used to defer the daemon's log file until after the migration,
// so nothing new is created in ~/.pulse just to be abandoned).
function homeMigrationPending() {
  return !homeResolved && !explicitHome() && !isDir(newHomePath()) && isPulseHome(legacyHomePath());
}
// The legacy home, when the v1 compat reads/writes apply: not pinned, it
// holds Pulse files, and it is not itself the active home — by IDENTITY, not
// by path string (pre-migration and degraded runs ARE ~/.pulse, and so is a
// ~/.pulse linked to ~/.burnglass or the other way round: there is nothing
// to be compatible with, and a "backup" write would hit the live home).
function legacyCompatHome() {
  if (explicitHome()) return null;
  const legacy = legacyHomePath();
  if (!isPulseHome(legacy) || sameEntry(appHome(), legacy)) return null;
  return legacy;
}
// A display form for messages: "~/.burnglass" rather than an absolute path
// when the home lives in the user's home directory.
function homeLabel(sub) {
  const h = appHome();
  const rel = path.relative(os.homedir(), h);
  const base = (!rel.startsWith('..') && !path.isAbsolute(rel)) ? '~/' + rel.split(path.sep).join('/') : h;
  return sub ? base + '/' + sub : base;
}

function configFilePath() { return path.join(appHome(), 'config.json'); }
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFilePath(), 'utf8')) || {}; } catch (_) { return {}; }
}

// Runtime discovery file (<home>/server.json): lets the short-lived
// `--statusline` / `--summary` processes find the running server's port.
// Best-effort. When the legacy ~/.pulse/server.json EXISTS it is mirrored
// (compat write): a not-yet-updated pulse-strip.exe hard-codes that path and
// an old `pulse --statusline` copy reads it — without the mirror both go
// dark (and the strip exits after 40 misses).
function runtimeFilePath() { return path.join(appHome(), 'server.json'); }
function writeRuntimeFile(port, host) {
  // The statusline always connects over loopback; record 127.0.0.1 unless
  // bound loopback already, so a LAN bind still yields a reachable local URL.
  const connectHost = (host === '0.0.0.0' || host === '::') ? '127.0.0.1' : host;
  const json = JSON.stringify({ port, host: connectHost, pid: process.pid, startedAt: SERVER_START, version: PULSE_VERSION });
  try {
    fs.mkdirSync(appHome(), { recursive: true });
    fs.writeFileSync(runtimeFilePath(), json);
  } catch (_) { /* non-fatal — statusline falls back to the default port */ }
  const legacy = legacyCompatHome();
  if (legacy && isFileAt(path.join(legacy, 'server.json'))) {
    try { fs.writeFileSync(path.join(legacy, 'server.json'), json); } catch (_) {}
  }
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}
// Reads the home's server.json AND (when compat applies) the legacy one, and
// returns the FRESHEST LIVE record: nothing ever deletes a server.json, so
// "new home first" would let a stale ~/.burnglass/server.json shadow a v1
// server that is the one actually running. Live pid beats dead; newer
// startedAt breaks ties; a dead record is still better than none (the caller
// then fails open to its no-server path).
function readRuntimeFile() {
  const files = [runtimeFilePath()];
  const legacy = legacyCompatHome();
  if (legacy) files.push(path.join(legacy, 'server.json'));
  let best = null, bestAlive = false;
  for (const f of files) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { continue; }
    if (!j || typeof j !== 'object' || !Number.isInteger(j.port)) continue;
    const alive = pidAlive(j.pid);
    const newer = !best || (+j.startedAt || 0) > (+best.startedAt || 0);
    if (!best || (alive && !bestAlive) || (alive === bestAlive && newer)) { best = j; bestAlive = alive; }
  }
  return best;
}
function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  try {
    fs.mkdirSync(appHome(), { recursive: true });
    // An existing file keeps its mode (written in place, never replaced). A
    // NEW one that carries the user's Meshy key is created user-only; the
    // mode only applies on creation, so a user's own chmod is never undone.
    fs.writeFileSync(configFilePath(), JSON.stringify(next, null, 2) + '\n', next.meshyApiKey ? { mode: 0o600 } : undefined);
  } catch (e) {
    console.warn('[burnglass] could not write config: ' + e.message);
  }
  // Clearing or changing the Meshy key must not leave the OLD plaintext key
  // behind in the v1 home, where a stale v1 copy would keep using it.
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'meshyApiKey')) scrubLegacyMeshyKey();
  // Config affects the summary payload (budget, meters, alerts, …) and the
  // statusline feed (trayEnabled drives the tray's handoff) — a
  // memoized copy must never outlive a settings change.
  summaryMemo = { at: 0, payload: null };
  statuslineMemo = { at: 0, data: null };
  openusageMemo = { at: 0, key: null, path: null };
  stripMemo = { at: 0, key: null, path: null };
  return next;
}

// backfill: write the ring buffer's lines first — a daemon whose log opening
// was deferred until after the home migration keeps its early lines.
function openLogFile(backfill) {
  try {
    fs.mkdirSync(appHome(), { recursive: true });
    const p = path.join(appHome(), 'burnglass.log');
    logFilePath = p;
    try { // rotate an oversized file from a previous run
      const st = fs.statSync(p);
      if (st.size > LOG_FILE_MAX) { try { fs.unlinkSync(p + '.1'); } catch (_) {} fs.renameSync(p, p + '.1'); }
    } catch (_) {}
    logFileBytes = 0;
    try { logFileBytes = fs.statSync(p).size; } catch (_) {}
    const s = fs.createWriteStream(p, { flags: 'a' });
    // An async write error (disk full, folder removed) must never crash the
    // hidden daemon — drop file logging and keep the ring buffer working.
    s.on('error', () => {
      try { s.destroy(); } catch (_) {}
      if (logFileStream === s) logFileStream = null;
    });
    logFileStream = s;
    if (backfill) {
      for (const l of logRing) {
        const line = new Date(l.ts).toISOString() + ' ' + l.level.toUpperCase().padEnd(5) + ' ' + l.text + '\n';
        try { s.write(line); logFileBytes += Buffer.byteLength(line); } catch (_) {}
      }
    }
  } catch (_) {}
}
let logOpenDeferred = false; // see main(): set while the migration is pending

// ---------------------------------------------------------------------------
// HOME MIGRATION  ~/.pulse → ~/.burnglass  (one-way COPY, atomic publish)
// Runs ONLY in a server process, ONLY after it owns its port (top of the
// listen callback): a v2 that loses the bind to a still-running v1 must not
// use the migration up on a snapshot the v1 keeps changing for weeks.
//   - Allowlisted copy of user data + small state (never logs, the runtime
//     file, tray.ps1, the strip's regenerated web/ + WebView2 profile, or the
//     105 MB bin/). Skipped names are recorded in the marker.
//   - Staged in ~/.burnglass.migrating-<pid>-<6 hex>, which gets a SENTINEL
//     file before anything else; cleanup (ours on failure, stale >1h ones on
//     a later start) only ever deletes a directory whose name matches that
//     exact pattern AND that holds the sentinel — never a glob sweep of $HOME.
//   - Published with ONE rename: readers see no ~/.burnglass or a complete
//     one. Two racing servers: the loser's rename fails, it adopts the
//     winner's home.
//   - ~/.pulse is NEVER renamed, moved or deleted. Afterwards it is touched
//     only by compat writes: the server.json mirror, a refresh of an
//     EXISTING tray.ps1 (a running v1 tray relaunches that file on the
//     version change — a stale copy would respawn forever), and stripping the
//     plaintext meshyApiKey out of its config.json (the key moved).
//   - Any failure: keep running on ~/.pulse (degraded, retried next start),
//     payload.homeMigration.status = 'failed'. Never a crash, never a
//     half-switch.
//   - Permissions never widen: the stage is created 0700 and gets the legacy
//     folder's mode (and history/ its own) right before the publish; files
//     keep theirs (copyFileSync). A ~/.pulse without a Pulse file in it
//     (PulseAudio's, an empty one) is not migrated at all, and a copy that
//     moved nothing is not reported as a migration.
// ---------------------------------------------------------------------------
const MIGRATE_FILES = ['config.json', 'meshy.json', 'modes.jsonl', 'discord-presence.json',
  'strip.json', 'strip-ui.json', 'strip_cells.json'];
const MIGRATE_DIRS = { history: /^\d{4}-\d{2}\.json$/ }; // skips *.tmp partials
const MIGRATION_MARKER = 'migrated-from-pulse.json';
const STAGE_PREFIX = '.burnglass.migrating-';
const STAGE_RE = /^\.burnglass\.migrating-\d+-[0-9a-f]{6}$/;
const STAGE_SENTINEL = 'BURNGLASS-MIGRATION-STAGE';
const STAGE_STALE_MS = 3600 * 1000;
let homeMigration = null; // → payload.homeMigration

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {}
}
function isMigrationStage(dir) {
  if (!STAGE_RE.test(path.basename(dir))) return false;
  try {
    if (!fs.lstatSync(dir).isDirectory()) return false; // never follow a link
    return fs.lstatSync(path.join(dir, STAGE_SENTINEL)).isFile();
  } catch (_) { return false; }
}
function removeMigrationStage(dir) {
  if (!isMigrationStage(dir)) return;
  // Sentinel LAST: if anything is locked (Windows AV), the half-removed stage
  // keeps its sentinel and the next start's sweep can still recognise it.
  try {
    for (const n of fs.readdirSync(dir)) {
      if (n !== STAGE_SENTINEL) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}
function sweepStaleMigrationStages() {
  let names;
  try { names = fs.readdirSync(os.homedir()); } catch (_) { return; }
  for (const n of names) {
    if (!STAGE_RE.test(n)) continue;
    const dir = path.join(os.homedir(), n);
    let age;
    try { age = Date.now() - fs.lstatSync(path.join(dir, STAGE_SENTINEL)).mtimeMs; } catch (_) { continue; }
    if (age > STAGE_STALE_MS) removeMigrationStage(dir); // a racing peer's fresh stage is left alone
  }
}
function renameWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      // Windows AV / indexers briefly lock freshly written files. Never retry
      // once the target exists — that is a lost race, not a lock.
      if (i >= 8 || !e || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || fs.existsSync(to)) throw e;
      sleepSync(125);
    }
  }
}
// A marker whose copy list is EMPTY (a ~/.pulse holding only a log / a
// runtime file) moved no settings or history: report no migration, so the
// dashboard never claims "your settings and history were copied".
function readMigrationMarker(home) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, MIGRATION_MARKER), 'utf8'));
    if (!j || typeof j !== 'object') return null;
    const copied = Array.isArray(j.copied) ? j.copied.length : null;
    if (copied === 0) return null;
    return { status: 'migrated', from: j.from || null, at: +j.at || null, by: j.by || null, copied };
  } catch (_) {}
  return null;
}
// POSIX permission bits (links followed), or null. The migration carries a
// user's `chmod 700 ~/.pulse` over to ~/.burnglass — the folder mode may be
// the ONLY thing keeping the plaintext Meshy key from other local users.
function modeBits(p) { try { return fs.statSync(p).mode & 0o777; } catch (_) { return null; } }
function copyModeBits(from, to) {
  if (process.platform === 'win32') return; // chmod there only flips read-only
  const m = modeBits(from);
  // Owner rwx is always kept (a home the server cannot write is no home);
  // group/other bits are copied verbatim — never wider than the source.
  if (m != null) { try { fs.chmodSync(to, m | 0o700); } catch (_) {} }
}
// Every per-home cache must forget what it read from the previous home.
function adoptHome(dir) {
  homeResolved = dir;
  historyCache = { sig: '', data: null };
  modesCache = { sig: '', bySession: {} };
  meshyStore = null;
  summaryMemo = { at: 0, payload: null };
  statuslineMemo = { at: 0, data: null };
  openusageMemo = { at: 0, key: null, path: null };
  stripMemo = { at: 0, key: null, path: null };
}
function migrateHome() {
  if (explicitHome()) { homeMigration = null; return; }
  const next = newHomePath(), legacy = legacyHomePath();
  sweepStaleMigrationStages();
  if (isDir(next)) { adoptHome(next); homeMigration = readMigrationMarker(next); scrubLegacyMeshyKeyIfCopied(); return; }
  if (!isPulseHome(legacy)) { adoptHome(next); homeMigration = null; return; } // absent, empty, or PulseAudio's
  const stage = path.join(os.homedir(), STAGE_PREFIX + process.pid + '-' + crypto.randomBytes(3).toString('hex'));
  const at = Date.now();
  const copied = [], skipped = [];
  try {
    // NOT recursive: must be a directory this call created. Private while it
    // fills (the umask can only remove bits); the legacy folder's own mode is
    // applied just before the publish. copyFileSync keeps each file's mode.
    fs.mkdirSync(stage, { mode: 0o700 });
    fs.writeFileSync(path.join(stage, STAGE_SENTINEL), JSON.stringify({ pid: process.pid, at }) + '\n');
    for (const f of MIGRATE_FILES) {
      const src = path.join(legacy, f);
      if (!isFileAt(src)) continue; // statSync follows a dotfile-synced symlink: its CONTENT is copied
      fs.copyFileSync(src, path.join(stage, f));
      copied.push(f);
    }
    for (const [d, re] of Object.entries(MIGRATE_DIRS)) {
      const srcDir = path.join(legacy, d);
      if (!isDir(srcDir)) continue;
      fs.mkdirSync(path.join(stage, d), { mode: 0o700 });
      for (const n of fs.readdirSync(srcDir)) {
        if (!re.test(n) || !isFileAt(path.join(srcDir, n))) continue;
        fs.copyFileSync(path.join(srcDir, n), path.join(stage, d, n));
        copied.push(d + '/' + n);
      }
      copyModeBits(srcDir, path.join(stage, d));
    }
    try {
      for (const n of fs.readdirSync(legacy)) {
        if (!MIGRATE_FILES.includes(n) && !Object.prototype.hasOwnProperty.call(MIGRATE_DIRS, n)) skipped.push(n);
      }
    } catch (_) {}
    fs.writeFileSync(path.join(stage, MIGRATION_MARKER), JSON.stringify(
      { from: legacy, at, by: PULSE_VERSION, copied, skipped }, null, 2) + '\n');
    copyModeBits(legacy, stage);
    renameWithRetry(stage, next);
    try { fs.unlinkSync(path.join(next, STAGE_SENTINEL)); } catch (_) {}
    adoptHome(next);
    if (copied.length) {
      homeMigration = { status: 'migrated', from: legacy, at, by: PULSE_VERSION, justNow: true, copied: copied.length };
      console.log('[burnglass] moved your settings and history: copied ' + copied.length + ' item(s) from ' +
        legacy + ' to ' + next + ' (the old folder is kept, untouched, as a backup)');
    } else {
      homeMigration = null; // nothing moved — never claim it did
      console.log('[burnglass] now using ' + next + ' (' + legacy + ' held no settings or history to copy; it is left untouched)');
    }
    scrubLegacyMeshyKeyIfCopied();
  } catch (e) {
    removeMigrationStage(stage);
    if (isDir(next)) { adoptHome(next); homeMigration = readMigrationMarker(next); return; } // a racing peer won
    adoptHome(legacy); // degraded: fully working on ~/.pulse, retried next start
    homeMigration = { status: 'failed', from: legacy, error: (e && e.message) || String(e) };
    console.warn('[burnglass] could not move ' + legacy + ' to ' + next + ' (' + homeMigration.error +
      ') — running from the old folder for now; retried on the next start.');
  }
}
// Strip the plaintext Meshy key out of the legacy config — the one compat
// write that edits a ~/.pulse file. onlyIf: remove it only when it equals
// that value (i.e. it was copied into the new home); omitted: remove it
// unconditionally (the user changed or cleared the key in v2).
function scrubLegacyMeshyKey(onlyIf) {
  const legacy = legacyCompatHome();
  if (!legacy) return false;
  const f = path.join(legacy, 'config.json');
  // A config.json linked to the live one (either direction) is not a backup:
  // "scrubbing" it would delete the user's ONLY copy of the key.
  if (sameEntry(f, configFilePath())) return false;
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return false; }
  if (!j || typeof j !== 'object' || Array.isArray(j) || !j.meshyApiKey) return false;
  if (onlyIf !== undefined && j.meshyApiKey !== onlyIf) return false;
  delete j.meshyApiKey;
  const tmp = f + '.burnglass-tmp';
  const body = JSON.stringify(j, null, 2) + '\n';
  try {
    // tmp + rename keeps a crash from truncating the file — except for a
    // dotfile-synced SYMLINK, which a rename would replace with a plain file:
    // write through the link instead. The replacement keeps the original's
    // mode (a fresh file would get the umask default: 0600 -> 0644).
    let link = false;
    try { link = fs.lstatSync(f).isSymbolicLink(); } catch (_) {}
    if (link) fs.writeFileSync(f, body);
    else {
      const m = modeBits(f);
      fs.writeFileSync(tmp, body, m != null ? { mode: m } : undefined);
      if (m != null && process.platform !== 'win32') fs.chmodSync(tmp, m);
      fs.renameSync(tmp, f);
    }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    console.warn('[burnglass] could not remove the Meshy API key from ' + f + ': ' + e.message +
      ' — delete the "meshyApiKey" line there yourself.');
    return false;
  }
  console.log('[burnglass] removed the Meshy API key from the old ' + f + ' (it now lives only in ' + configFilePath() + ')');
  return true;
}
function scrubLegacyMeshyKeyIfCopied() {
  const k = readConfig().meshyApiKey;
  if (typeof k === 'string' && k) scrubLegacyMeshyKey(k);
}
// An old, still-running v1 tray relaunches ITS OWN script ($PSCommandPath =
// ~/.pulse/tray.ps1) the moment /api/statusline reports a new version. Keep
// an EXISTING legacy tray.ps1 current, or that relaunch re-runs the v1 script,
// sees the mismatch again, and respawns forever. Never creates the file.
function refreshLegacyTrayScript(port) {
  const legacy = legacyCompatHome();
  if (!legacy) return;
  const f = path.join(legacy, 'tray.ps1');
  if (!isFileAt(f)) return;
  const next = trayScript(port);
  try { if (fs.readFileSync(f, 'utf8') === next) return; } catch (_) {}
  try { fs.writeFileSync(f, next); } catch (_) {}
}

// Wrap a callback so multiple emission paths (stream error + end, request
// error + timeout) can never fire it twice — a double res.writeHead from a
// double callback would crash the whole server.
function once(fn) {
  let called = false;
  return function (...a) { if (called) return; called = true; return fn && fn(...a); };
}

// ---------------------------------------------------------------------------
// §5  COST MODEL  — the first of two areas that must be exactly right.
//
// Prices are Anthropic API list prices in US dollars per MILLION tokens.
// On a Pro/Max subscription these are NOT a bill — they express relative
// usage. This is stated in the UI.
//
// Verified against Anthropic list pricing (platform.claude.com) — 2026-09.
// This object is the single source of truth: updating a price is a one-line
// edit here.
// ---------------------------------------------------------------------------
const PRICING = {
  // model string : { input, output }  in $/MTok
  //
  // Current generation.
  // fastInput/fastOutput = the fast-mode premium (Claude Code's `/fast`, API
  // `speed: "fast"`), applied per-entry when the transcript records
  // usage.speed === 'fast'. Only Opus 5.5 ($8/$40), Opus 5 and Opus 4.8
  // ($10/$50) have fast mode: 4.7 rejects the flag and 4.6 runs standard and
  // bills standard, so neither carries a fast row. Cache multipliers stack on top of the fast rate,
  // which falls out of pricing cache tokens off price.input (per the docs).
  // cacheReadMult = per-row cache-READ multiplier when a model departs from the
  // standard 0.10×: Fable 5.1 / Mythos 5.1 bill cache reads at $0.25/M (0.025×),
  // Opus 5.5 at $0.20/M (0.05×).
  // Mythos = the Glasswing-only twins of Fable (same list price). Mythos
  // Preview (deprecated → Mythos 5) is priced per Anthropic's Project Glasswing
  // page: $25/$125 — its cache multipliers were never published (standard
  // 1.25×/2×/0.1× assumed). Explicit keys only: an unknown future mythos id
  // must still LOG rather than silently take a guessed rate.
  'claude-fable-5-1':  { input: 10, output: 50, cacheReadMult: 0.025 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheReadMult: 0.025 },
  'claude-fable-5':    { input: 10, output: 50 },
  'claude-mythos-5':   { input: 10, output: 50 },
  'claude-mythos-preview': { input: 25, output: 125 },
  // Opus 5.5 (2026-09-22; Claude Code's default Opus since 2.1.280). Cheaper
  // than Opus 5 at $4/$20, 0.05× cache reads, fast mode $8/$40. Verified
  // 2026-09-24 against platform.claude.com pricing + fast-mode pages.
  'claude-opus-5-5':   { input: 4,  output: 20, cacheReadMult: 0.05, fastInput: 8, fastOutput: 40 },
  'claude-opus-5':     { input: 5,  output: 25, fastInput: 10, fastOutput: 50 },
  'claude-opus-4-8':   { input: 5,  output: 25, fastInput: 10, fastOutput: 50 },
  'claude-opus-4-7':   { input: 5,  output: 25 },
  'claude-opus-4-6':   { input: 5,  output: 25 },
  'claude-opus-4-5':   { input: 5,  output: 25 },
  // Sonnet 5 launched at an "introductory" $2/$10 through 2026-08-31; on
  // 2026-08-10 Anthropic made that the permanent list price (the scheduled
  // $3/$15 step-up never happened), so the row is plain. priceFor still
  // honours intro* fields for any future time-limited launch price.
  'claude-sonnet-5':   { input: 2,  output: 10 },
  'claude-sonnet-4-6': { input: 3,  output: 15 },
  'claude-sonnet-4-5': { input: 3,  output: 15 },
  'claude-haiku-4-5':  { input: 1,  output: 5 },

  // Older strings that still appear in real history
  'claude-opus-4-1':   { input: 15, output: 75 },
  'claude-opus-4-0':   { input: 15, output: 75 },
  'claude-sonnet-4-0': { input: 3,  output: 15 },
  // Retired Opus 4 / Sonnet 4 dated + alternate ids. No bare 'claude-opus-4'
  // key prefixes them (…-4-0/-4-1/-4-5 do not prefix a '-4-2025…' string), so
  // without explicit rows they fell to __default__ — Opus 4 history billed 5×
  // under. Explicit (not a bare prefix) so an unknown future 4.x id still logs.
  'claude-opus-4-20250514':   { input: 15, output: 75 },
  'claude-4-opus-20250514':   { input: 15, output: 75 },
  'claude-sonnet-4-20250514': { input: 3,  output: 15 },
  'claude-4-sonnet-20250514': { input: 3,  output: 15 },
  'claude-3-7-sonnet': { input: 3,  output: 15 },
  'claude-3-5-sonnet': { input: 3,  output: 15 },
  'claude-3-5-haiku':  { input: 0.8, output: 4 },
  'claude-3-opus':     { input: 15, output: 75 },
  'claude-3-haiku':    { input: 0.25, output: 1.25 },

  // Zhipu / Z.ai GLM — commonly used THROUGH Claude Code via Z.ai's
  // Anthropic-compatible endpoint, so glm-* model ids land in ~/.claude and are
  // priced here (Claude-style cache multipliers apply). Z.ai list prices
  // ($/MTok), 2026-07. priceFor picks the LONGEST key that prefixes the model,
  // so the specific variants (…-air/-airx/-x/-flash/-v) must each be listed or
  // a longer name would fall back to the base row.
  'glm-5.2':           { input: 1.4,  output: 4.4 },
  'glm-5.1':           { input: 1.4,  output: 4.4 },
  'glm-5-turbo':       { input: 1.2,  output: 4.0 },
  'glm-5':             { input: 1,    output: 3.2 },
  'glm-4.7-flashx':    { input: 0.07, output: 0.4 },
  'glm-4.7-flash':     { input: 0,    output: 0 },
  'glm-4.7':           { input: 0.6,  output: 2.2 },
  'glm-4.6v-flash':    { input: 0,    output: 0 },
  'glm-4.6v':          { input: 0.3,  output: 0.9 },
  'glm-4.6':           { input: 0.6,  output: 2.2 },
  'glm-4.5v':          { input: 0.6,  output: 1.8 },
  'glm-4.5-airx':      { input: 1.1,  output: 4.5 },
  'glm-4.5-air':       { input: 0.2,  output: 1.1 },
  'glm-4.5-flash':     { input: 0,    output: 0 },
  'glm-4.5-x':         { input: 2.2,  output: 8.9 },
  'glm-4.5':           { input: 0.6,  output: 2.2 },
  'glm-4-32b':         { input: 0.1,  output: 0.1 },

  // Claude Code's placeholder for non-billable internal turns — free, and not
  // a real model. Priced at zero and hidden from the by-model breakdown.
  '<synthetic>':       { input: 0, output: 0 },

  // Fallback for unknown / new model strings. The string is logged once so it
  // can be added to this map.
  '__default__':       { input: 3, output: 15 },
};

// Models excluded from the by-model list (internal placeholders, no real cost).
const HIDDEN_MODELS = new Set(['<synthetic>']);

// Cache-token multipliers, applied against the model's INPUT price.
const CACHE_WRITE_5M_MULT = 1.25; // 5-minute TTL cache write
const CACHE_WRITE_1H_MULT = 2.00; // 1-hour TTL cache write
const CACHE_READ_MULT     = 0.10; // cache read

const WEB_SEARCH_PER_1K = 10; // $ per 1000 web_search requests

const HOUR_MS  = 3600 * 1000;
const BLOCK_MS = 5 * HOUR_MS; // rolling 5-hour usage window
const MINUTE_MS = 60 * 1000;

const _unknownModels = new Set();
function logUnknownModel(model, borrowedFrom) {
  if (model && !_unknownModels.has(model)) {
    _unknownModels.add(model);
    console.warn(borrowedFrom
      ? `[burnglass] unknown model "${model}" — priced as "${borrowedFrom}" (closest known row). Add it to PRICING.`
      : `[burnglass] unknown model "${model}" — using __default__ pricing. Add it to PRICING.`);
  }
}

// Local-time YYYY-MM-DD for an epoch-ms timestamp (used for the Sonnet-5
// intro-price date check and for day bucketing).
function localDateStr(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Resolve the {input, output} price for a model at a given entry timestamp,
// honouring any time-limited introductory price.
// Partner-cloud forms of a Claude id, as Claude Code logs them on Bedrock /
// Vertex: "[<region>.]anthropic.<id>[-v1[:0]]" and "<id>@YYYYMMDD". The region
// prefix is matched generically (global./us./eu./apac./jp., but also us-gov.
// on GovCloud and au. — AWS keeps adding them) so a new one can never silently
// drop an id onto the $3/$15 default. Reduced to the canonical id for the
// price lookup ONLY — the raw string stays the display model everywhere else.
function canonicalClaudeModel(model) {
  if (!model) return model;
  return model
    .replace(/^(?:[a-z]+(?:-[a-z]+)*\.)?anthropic\./, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/@(\d{8})$/, '-$1');
}
function priceFor(model, ts, speed) {
  const m = canonicalClaudeModel(model);
  let p = PRICING[m];
  if (!p && m) {
    // Dated / suffixed variants (e.g. claude-haiku-4-5-20251001) price as their
    // base model: longest PRICING key that prefixes the model string wins.
    let best = '';
    for (const key of Object.keys(PRICING)) {
      if (key !== '__default__' && m.startsWith(key) && key.length > best.length) best = key;
    }
    if (best) p = PRICING[best];
    // A claude-* id whose remainder is not a date stamp (or "-latest") is a
    // model Pulse has NO row for — typically a point release (claude-sonnet-5-5
    // lands on claude-sonnet-5). Keep the parent's rate as the closest
    // estimate, but say so: claude-opus-5-5 sat silently on Opus 5's $5/$25
    // (vs its real $4/$20) until this was made visible.
    if (best && best.startsWith('claude-') && !/^(?:-v\d+)?-(?:\d{8}|latest)$/.test(m.slice(best.length))) {
      logUnknownModel(model, best);
    }
  }
  if (!p) {
    logUnknownModel(model);
    p = PRICING.__default__;
  }
  // Cache reads bill at the ROW's multiplier when it has one (Fable/Mythos 5.1
  // = 0.025×), else the standard 0.10× — carried on the resolved price so every
  // cost path (cost, standard baseline, cache economics) agrees.
  const cacheReadMult = p.cacheReadMult != null ? p.cacheReadMult : CACHE_READ_MULT;
  // Fast mode is a per-request premium, so it wins over the (model-level)
  // introductory price — no current model carries both.
  if (speed === 'fast' && p.fastInput != null) {
    return { input: p.fastInput, output: p.fastOutput, cacheReadMult };
  }
  if (p.introUntil && localDateStr(ts) <= p.introUntil) {
    return { input: p.introInput, output: p.introOutput, cacheReadMult };
  }
  return { input: p.input, output: p.output, cacheReadMult };
}

// Token-category cost on the Claude path at a resolved price row. Cache reads
// use the row's multiplier. `usage.inference_geo === "us"` (US-only inference,
// 4.6+ models) bills EVERY token category at 1.1× — the surcharge applies to
// the token terms only, never to per-call server tools (web search).
const INFERENCE_GEO_US_MULT = 1.1;
function claudeTokenCost(e, price) {
  const tokens =
    (e.inputTokens  / 1e6) * price.input +
    (e.outputTokens / 1e6) * price.output +
    (e.cacheWrite5m / 1e6) * price.input * CACHE_WRITE_5M_MULT +
    (e.cacheWrite1h / 1e6) * price.input * CACHE_WRITE_1H_MULT +
    (e.cacheRead    / 1e6) * price.input * price.cacheReadMult;
  return e.geoUs ? tokens * INFERENCE_GEO_US_MULT : tokens;
}

// §5 per-entry cost. Cache-creation tokens without a TTL breakdown are treated
// as 5-minute writes (×1.25) — documented assumption, handled at normalize().
function costForEntry(e) {
  if (e.provider === 'openai') return openaiTokenCost(e, priceForOpenAI(e.model, e.ts), e.speed);
  if (e.provider === 'google') {
    const p = priceForGoogle(e.model);
    // Gemini context caching bills cached input at ~10% of the input rate.
    const cachedPrice = p.cachedInput != null ? p.cachedInput : p.input * GOOGLE_CACHE_READ_MULT;
    return (
      (e.inputTokens  / 1e6) * p.input +
      (e.outputTokens / 1e6) * p.output +
      (e.cacheRead    / 1e6) * cachedPrice
    );
  }
  return claudeTokenCost(e, priceFor(e.model, e.ts, e.speed)) +
    (e.webSearches / 1000) * WEB_SEARCH_PER_1K;
}

// What prompt caching actually bought on ONE entry, at that entry's own price
// row (fast mode and intro prices included — never a single global rate):
//   saved        cache reads at the FULL input price minus what they really cost
//   writePremium the surcharge paid to CREATE cache entries (5m +0.25x input,
//                1h +1.0x input) — the other half of the trade.
// Netting the two is what makes "caching saved you $X" honest; a session that
// writes more cache than it reads back is genuinely a loss, and must show as one.
function cacheEconomicsForEntry(e) {
  const read = e.cacheRead || 0;
  // Entries whose cost came from the agent's OWN ledger (Cline/Roo record a real
  // per-request `cost`, which we display verbatim) must not be re-priced here:
  // their model id is frequently the literal 'unknown', which falls to
  // __default__ and would invent a "saved" figure with no relationship to the
  // cost shown beside it. No price row we trust ⇒ no savings claim.
  if (e.costFromSource) return { read: 0, saved: 0, writePremium: 0 };
  if (e.provider === 'openai' || e.provider === 'google') {
    const p = e.provider === 'openai' ? priceForOpenAI(e.model, e.ts) : priceForGoogle(e.model);
    const mult = e.provider === 'openai' ? OPENAI_CACHE_READ_MULT : GOOGLE_CACHE_READ_MULT;
    const cached = p.cachedInput != null ? p.cachedInput : p.input * mult;
    // The long-context tier scales the input AND cached rates alike, so the
    // read saving scales with it (openaiTokenCost applies the same test).
    const isOpenAI = e.provider === 'openai';
    const im = isOpenAI && openaiLongContext(e, p) ? OPENAI_LONG_CTX_INPUT_MULT : 1;
    // Fast scales every rate, so the read saving and write premium scale too.
    const fm = isOpenAI && e.speed === 'fast' && p.fastMult ? p.fastMult : 1;
    // Only OpenAI rows with a PUBLISHED cache-write price (cacheWriteMult)
    // carry a write premium; Gemini caching is implicit, no surcharge.
    const wp = isOpenAI && p.cacheWriteMult
      ? (e.cacheWrite5m / 1e6) * p.input * (p.cacheWriteMult - 1) * im * fm : 0;
    // read is reported only when the input price is non-zero: a free row saves
    // nothing, and counting its reads would pad the "off N cached read tokens"
    // denominator with tokens that contributed $0 of the savings above it.
    return { read: p.input > 0 ? read : 0, saved: (read / 1e6) * (p.input - cached) * im * fm, writePremium: wp };
  }
  const price = priceFor(e.model, e.ts, e.speed);
  const geo = e.geoUs ? INFERENCE_GEO_US_MULT : 1; // the surcharge scales savings and premiums alike
  return {
    // Same zero-price rule as above — covers "<synthetic>" and the free
    // glm-*-flash rows, whose reads are real tokens but worth nothing saved.
    read: price.input > 0 ? read : 0,
    saved: (read / 1e6) * price.input * (1 - price.cacheReadMult) * geo,
    writePremium: ((e.cacheWrite5m / 1e6) * price.input * (CACHE_WRITE_5M_MULT - 1)
                 + (e.cacheWrite1h / 1e6) * price.input * (CACHE_WRITE_1H_MULT - 1)) * geo,
  };
}

// costForEntry with the fast-mode premium taken back out — the baseline the
// "what fast mode cost you extra" figure is measured against. Two providers
// carry speed === 'fast': Anthropic (usage.speed) and OpenAI Codex (the
// rollout's effective service_tier "priority"); each prices through its own
// table, forced to standard.
function standardCostForEntry(e) {
  if (e.provider === 'openai') return openaiTokenCost(e, priceForOpenAI(e.model, e.ts), 'standard');
  return claudeTokenCost(e, priceFor(e.model, e.ts, 'standard')) +
    (e.webSearches / 1000) * WEB_SEARCH_PER_1K;
}

// ---------------------------------------------------------------------------
// OPENAI / CODEX PRICING
// $/MTok at OpenAI API list prices (platform.openai.com/pricing). On a
// ChatGPT Plus/Pro subscription these are relative-usage estimates, exactly
// like the Claude table above. Cached input bills at ~10% of the input price
// for the gpt-5 family; output prices include reasoning tokens.
// ---------------------------------------------------------------------------
// Each row: { input, output, cachedInput } in $/MTok. cachedInput is the
// published cached-input rate for that model (it is NOT a fixed fraction of
// input across the lineup: 10% for gpt-5 family, 25% for o3/o4-mini/gpt-4.1,
// 50% for gpt-4o/o3-mini; models without cache discounts bill cached at full
// input price). Rows without cachedInput default to 10% of input.
//   longContext: true — the model has a >272K-input tier: a request whose
//   prompt (uncached + cached input) exceeds OPENAI_LONG_CONTEXT_TOKENS bills
//   the WHOLE request at 2× input/cached and 1.5× output (every such model
//   publishes exactly those multiples). Applied per entry in openaiTokenCost.
//   history: [{ until, ...price }] — OLDER prices, each in force through its
//   `until` (inclusive, entry-local date); an entry dated before a price cut
//   keeps the rate it was actually billed at (priceStep). Ascending by until.
//   fastMult — the row's published Fast-mode (service_tier "priority")
//   multiplier on EVERY rate. Not uniform: 2× for the GPT-6 / 5.6 families,
//   5.4, 5.2, 5.1, 5; 2.5× for gpt-5.5; 1.8× gpt-5-mini. No fastMult = no
//   published Fast price (a "fast" entry then prices at standard).
//   cacheWriteMult — rows with a PUBLISHED cache-write price (1.25× input:
//   GPT-6 Astra/Sol/Luna, the 5.6 family, 5.6-cyber). Without it, cache-write
//   tokens bill as plain input (older models have no write surcharge).
// Verified 2026-09-06, rows added/extended 2026-09-24 against the
// developers.openai.com pricing page (Standard / Fast / Daybreak tables).
const GPT56_SOL = {
  // Cut 2026-08-21 from $5/$30 — "promotional pricing available at least
  // through November 21, 2026": re-check then; if it reverts, add a step.
  input: 4, output: 20, cachedInput: 0.4, longContext: true, fastMult: 2, cacheWriteMult: 1.25,
  history: [{ until: '2026-08-20', input: 5, output: 30, cachedInput: 0.5 }],
};
const PRICING_OPENAI = {
  // GPT-6 Astra (2026-09-03) — Codex's bundled default since 0.153.4
  // (2026-09-04). "-wm" is Codex's undocumented daybreak variant of the same
  // model (codex-rs daybreak.rs maps both ids to Astra) — priced identically.
  'gpt-6-astra':        { input: 10,   output: 50,  cachedInput: 1, longContext: true, fastMult: 2, cacheWriteMult: 1.25 },
  'gpt-6-astra-wm':     { input: 10,   output: 50,  cachedInput: 1, longContext: true, fastMult: 2, cacheWriteMult: 1.25 },
  // GPT-6 Sol + Luna (2026-09-22; in Codex's catalog since 0.156). Codex's
  // TUI runs BOTH on Fast (service_tier "priority") by default — the rollout
  // records the effective tier, see parseCodexFile.
  'gpt-6-sol':          { input: 2,    output: 10,  cachedInput: 0.2, longContext: true, fastMult: 2, cacheWriteMult: 1.25 },
  'gpt-6-luna':         { input: 0.1,  output: 0.5, cachedInput: 0.01, longContext: true, fastMult: 2, cacheWriteMult: 1.25 },
  // GPT-5.6 family (GA 2026-07-09). Terra and Luna were cut 2026-07-30 (−20% /
  // −80%); Sol on 2026-08-21. Bare "gpt-5.6" is an OFFICIAL alias for Sol
  // (model page, API changelog, models overview) — same row object.
  'gpt-5.6-sol':        GPT56_SOL,
  'gpt-5.6':            GPT56_SOL,
  'gpt-5.6-terra':      { input: 2,    output: 12,  cachedInput: 0.2, longContext: true, fastMult: 2, cacheWriteMult: 1.25,
                          history: [{ until: '2026-07-29', input: 2.5, output: 15, cachedInput: 0.25 }] },
  'gpt-5.6-luna':       { input: 0.2,  output: 1.2, cachedInput: 0.02, longContext: true, fastMult: 2, cacheWriteMult: 1.25,
                          history: [{ until: '2026-07-29', input: 1, output: 6, cachedInput: 0.1 }] },
  // Cyber (Daybreak Red, separately provisioned; Responses API only; 400K
  // window with a 272K max input, so no long-context tier; no fast mode).
  'gpt-5.6-cyber':      { input: 12.5, output: 75,  cachedInput: 1.25, cacheWriteMult: 1.25 },
  // Daybreak aliases (2026-08-07) — follow the underlying model's price; they
  // point at 5.6-sol / 5.6-cyber today (Blue shares Sol's DATED row object).
  'gpt-daybreak-blue-latest': GPT56_SOL,
  'gpt-daybreak-red-latest':  { input: 12.5, output: 75, cachedInput: 1.25, cacheWriteMult: 1.25 },
  'gpt-5.5-cyber':      { input: 12.5, output: 75,  cachedInput: 1.25 },
  'gpt-5.5-pro':        { input: 30,   output: 180, cachedInput: 30 },
  'gpt-5.5':            { input: 5,    output: 30,  cachedInput: 0.5, longContext: true, fastMult: 2.5 },
  // gpt-5.4 / -mini retired from Codex (ChatGPT sign-in) 2026-08-31 → terra /
  // luna; still on the API, prices unchanged.
  'gpt-5.4-mini':       { input: 0.75, output: 4.5, cachedInput: 0.075, fastMult: 2 },
  'gpt-5.4-nano':       { input: 0.2,  output: 1.25, cachedInput: 0.02 },
  'gpt-5.4-pro':        { input: 30,   output: 180, cachedInput: 30 },
  'gpt-5.4':            { input: 2.5,  output: 15,  cachedInput: 0.25, longContext: true, fastMult: 2 },
  'gpt-5.3-codex':      { input: 1.75, output: 14,  cachedInput: 0.175 },
  'gpt-5.2-pro':        { input: 21,   output: 168, cachedInput: 21 },
  'gpt-5.2-codex':      { input: 1.75, output: 14,  cachedInput: 0.175 },
  'gpt-5.2':            { input: 1.75, output: 14,  cachedInput: 0.175, fastMult: 2 },
  // Codex's sandbox auto-reviewer: runs GPT-5.4 (low reasoning), which has no
  // published row of its own — priced at gpt-5.4 rates.
  'codex-auto-review':  { input: 2.5,  output: 15,  cachedInput: 0.25, fastMult: 2 },
  'gpt-5.1-codex-mini': { input: 0.25, output: 2,   cachedInput: 0.025 },
  'gpt-5.1-codex-max':  { input: 1.25, output: 10,  cachedInput: 0.125 },
  'gpt-5.1-codex':      { input: 1.25, output: 10,  cachedInput: 0.125 },
  'gpt-5.1':            { input: 1.25, output: 10,  cachedInput: 0.125, fastMult: 2 },
  'gpt-5-codex':        { input: 1.25, output: 10,  cachedInput: 0.125 },
  'gpt-5-mini':         { input: 0.25, output: 2,   cachedInput: 0.025, fastMult: 1.8 },
  'gpt-5-nano':         { input: 0.05, output: 0.4, cachedInput: 0.005 },
  'gpt-5-pro':          { input: 15,   output: 120, cachedInput: 15 },
  'gpt-5':              { input: 1.25, output: 10,  cachedInput: 0.125, fastMult: 2 },
  'codex-mini-latest':  { input: 1.5,  output: 6,   cachedInput: 0.375 },
  // Older strings that can appear in history. NOTE: unlike Anthropic's dated
  // snapshots, OpenAI suffixes (-mini/-pro/-nano) are DIFFERENT models at
  // different prices — each needs its own exact row. Shutdowns (prices hold
  // until then; rows stay for history): o3-mini + o4-mini 2026-10-23; the
  // dated gpt-5 / gpt-5-mini / gpt-5-nano / gpt-5-pro / o3 / o3-pro snapshots
  // 2026-12-11 (→ the 5.6 family).
  'o3-deep-research':   { input: 10,   output: 40,  cachedInput: 2.5 },
  'o3-mini':            { input: 1.1,  output: 4.4, cachedInput: 0.55 },
  'o3-pro':             { input: 20,   output: 80,  cachedInput: 20 },
  'o3':                 { input: 2,    output: 8,   cachedInput: 0.5 },
  'o4-mini':            { input: 1.1,  output: 4.4, cachedInput: 0.275 },
  'gpt-4.1-mini':       { input: 0.4,  output: 1.6, cachedInput: 0.1 },
  'gpt-4.1-nano':       { input: 0.1,  output: 0.4, cachedInput: 0.025 },
  'gpt-4.1':            { input: 2,    output: 8,   cachedInput: 0.5 },
  'gpt-4o-mini':        { input: 0.15, output: 0.6, cachedInput: 0.075 },
  'gpt-4o':             { input: 2.5,  output: 10,  cachedInput: 1.25 },
  // Fallback for unknown / new model strings (logged once, same as Claude).
  '__default__':        { input: 1.25, output: 10 },
};
const OPENAI_CACHE_READ_MULT = 0.10; // default when a row has no cachedInput
// Long-context tier (rows flagged longContext): prompt > 272K tokens bills the
// whole request at 2× input/cached, 1.5× output.
const OPENAI_LONG_CONTEXT_TOKENS = 272000;
const OPENAI_LONG_CTX_INPUT_MULT = 2;
const OPENAI_LONG_CTX_OUTPUT_MULT = 1.5;

// Bedrock-routed Codex sessions log "[<region>.]openai.<id>" — reduced to the
// bare id for the lookup only (raw string stays the display model). Same
// generic region match as the Claude side.
function canonicalOpenAIModel(model) {
  return model ? model.replace(/^(?:[a-z]+(?:-[a-z]+)*\.)?openai\./, '') : model;
}
// The price in force at an entry's own date: `history` steps are older prices,
// each valid through its `until` (inclusive); the first step the date falls
// within wins, else the row's current price. The step inherits row-level
// flags (longContext) it doesn't restate.
function priceStep(p, ts) {
  if (!p.history || ts == null) return p;
  const ds = localDateStr(ts);
  for (const h of p.history) if (ds <= h.until) return { ...p, ...h, history: undefined };
  return p;
}
function priceForOpenAI(model, ts) {
  const m = canonicalOpenAIModel(model);
  let p = PRICING_OPENAI[m];
  if (!p && m) {
    // Prefix fallback ONLY for dated snapshots ("gpt-4.1-2025-04-14"). OpenAI
    // family suffixes (-mini/-pro/-nano) are different models at different
    // prices, so any non-date remainder falls through to the logged default —
    // mispricing must be visible, never silent.
    let best = '';
    for (const key of Object.keys(PRICING_OPENAI)) {
      if (key === '__default__' || !m.startsWith(key) || key.length <= best.length) continue;
      const rest = m.slice(key.length);
      if (/^-(\d{4}-\d{2}-\d{2}|\d{8})$/.test(rest)) best = key;
    }
    if (best) p = PRICING_OPENAI[best];
  }
  if (!p) {
    logUnknownModel(model);
    p = PRICING_OPENAI.__default__;
  }
  return priceStep(p, ts);
}
// OpenAI token cost at a resolved row. Cached input bills at the row's own
// published rate; the long-context tier scales the whole request.
// Rollout cache-WRITE tokens (`cache_write_input_tokens`, a subset of input)
// arrive in cacheWrite5m and bill at the row's cacheWriteMult (else as plain
// input). `speed === 'fast'` (Codex service_tier "priority") multiplies EVERY
// rate by the row's published fastMult; a row without one prices standard.
// The prompt size for the long-context test is uncached + written + cached.
function openaiLongContext(e, p) {
  return !!p.longContext && (e.inputTokens + e.cacheWrite5m + e.cacheRead) > OPENAI_LONG_CONTEXT_TOKENS;
}
function openaiTokenCost(e, p, speed) {
  const cachedPrice = p.cachedInput != null ? p.cachedInput : p.input * OPENAI_CACHE_READ_MULT;
  const long = openaiLongContext(e, p);
  const im = long ? OPENAI_LONG_CTX_INPUT_MULT : 1;
  const om = long ? OPENAI_LONG_CTX_OUTPUT_MULT : 1;
  const fm = speed === 'fast' && p.fastMult ? p.fastMult : 1;
  const cw = p.cacheWriteMult || 1;
  return fm * (
    (e.inputTokens  / 1e6) * p.input * im +
    (e.cacheWrite5m / 1e6) * p.input * cw * im +
    (e.outputTokens / 1e6) * p.output * om +
    (e.cacheRead    / 1e6) * cachedPrice * im
  );
}

// ---------------------------------------------------------------------------
// GOOGLE / GEMINI PRICING
// $/MTok at Google Gemini API list prices (ai.google.dev/gemini-api/docs/pricing),
// July 2026. Reached via the Gemini CLI (source 'gemini'), whose logs carry the
// real per-turn token counts. On a paid key these are actual API rates; on the
// free tier they express relative usage, same caveat as the other tables.
// Context caching bills cached input at ~10% of the input rate. Longest-prefix
// match, but fallback is allowed ONLY for snapshot-style suffixes
// (-preview/-latest/-exp/-thinking plus an optional date/build stamp, or a
// bare stamp like -001). Tier and modality suffixes (-lite, -8b, -image,
// -preview-tts, …) are DIFFERENT models at different prices: without a row of
// their own they fall through to the LOGGED default — "gemini-3.5-flash-lite"
// must never silently price at gemini-3.5-flash rates (same rule as the
// OpenAI table's -mini/-pro).
// ---------------------------------------------------------------------------
const PRICING_GOOGLE = {
  'gemini-3-pro':          { input: 2,    output: 12 },
  'gemini-3.1-pro':        { input: 2,    output: 12 },
  'gemini-3.5-flash':      { input: 1.5,  output: 9 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'gemini-3-flash':        { input: 0.5,  output: 3 },
  'gemini-2.5-pro':        { input: 1.25, output: 10 }, // >200k prompt: 2.50/15 (not modelled)
  'gemini-2.5-flash-lite': { input: 0.1,  output: 0.4 },
  'gemini-2.5-flash':      { input: 0.3,  output: 2.5 },
  // Fallback for unknown / new gemini strings (logged once, same as the others).
  '__default__':           { input: 1.25, output: 10 },
};
const GOOGLE_CACHE_READ_MULT = 0.10;

function priceForGoogle(model) {
  let p = PRICING_GOOGLE[model];
  if (!p && model) {
    // Longest PRICING_GOOGLE key that prefixes the model string wins, but only
    // when the remainder is a snapshot-style suffix: -preview/-latest/-exp/
    // -thinking, optionally followed by ONE date/build stamp ("-preview-05-20",
    // "-exp-1206"), or a bare stamp ("-001", "-11-2025", "-20250520"). Any
    // other remainder — a tier like "-lite"/"-8b", a modality like "-image" or
    // "-preview-tts" — is a DIFFERENT model at a different price: mispricing
    // must be visible, never silent, so it falls through to the logged default
    // instead of the parent tier's rate.
    let best = '';
    for (const key of Object.keys(PRICING_GOOGLE)) {
      if (key === '__default__' || !model.startsWith(key) || key.length <= best.length) continue;
      const rest = model.slice(key.length);
      if (/^-(?:(?:preview|latest|exp|thinking)(?:-(?:\d{1,2}-\d{2,4}|\d{4}-\d{2}-\d{2}|\d{8}|\d{3,4}))?|\d{3,4}|\d{1,2}-\d{2,4}|\d{4}-\d{2}-\d{2}|\d{8})$/.test(rest)) best = key;
    }
    if (best) p = PRICING_GOOGLE[best];
  }
  if (!p) {
    logUnknownModel(model);
    p = PRICING_GOOGLE.__default__;
  }
  return p;
}

// ---------------------------------------------------------------------------
// PATHS & FILE DISCOVERY
// ---------------------------------------------------------------------------

// Resolve the .claude directory. Precedence:
//   1. CLAUDE_DIR         — Pulse's own override
//   2. CLAUDE_CONFIG_DIR  — Claude Code's own env var (so if Claude Code writes
//                           to a custom location, Pulse follows it automatically)
//   3. ~/.claude          — the default
// IMPORTANT for Windows users running Claude Code under WSL: the WSL home is a
// different filesystem from C:\Users\<you>. Run Pulse inside the same
// environment as Claude Code, or point CLAUDE_DIR at the right .claude.
function claudeDir() {
  return process.env.CLAUDE_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Hand-rolled recursive walker for *.jsonl files. We deliberately avoid
// fs.readdir(..., {recursive:true}) because its availability varies across the
// Node 18.x line. READ-ONLY: only readdirSync/statSync/realpathSync, never a
// write op.
//
// Cycle-safe: symlinks and (on Windows) directory junctions can point back at
// an ancestor, which would make a naive recursion loop forever. We canonicalize
// each directory with realpathSync and skip any real path already visited, and
// cap recursion depth as a backstop. Without this, a single junction cycle in
// ~/.claude wedges the whole server (the request never returns).
const WALK_MAX_DEPTH = 40;
function walkJsonl(dir, out, seen, depth) {
  if (out === undefined) { out = []; seen = new Set(); depth = 0; }
  if (depth > WALK_MAX_DEPTH) return out;

  // Canonical path (breaks symlink / junction cycles).
  let real;
  try {
    real = (fs.realpathSync.native || fs.realpathSync)(dir);
  } catch (_) {
    real = dir;
  }
  if (seen.has(real)) return out; // already walked this directory — cycle
  seen.add(real);

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out; // missing / unreadable dir — skip silently
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    let isDir = ent.isDirectory();
    let isFile = ent.isFile();
    // Resolve symlinks defensively (still read-only).
    if (ent.isSymbolicLink()) {
      try {
        const st = fs.statSync(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch (_) { continue; }
    }
    if (isDir) {
      walkJsonl(full, out, seen, depth + 1);
    } else if (isFile && ent.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

function projectsRoot() {
  return path.join(claudeDir(), 'projects');
}

// OpenAI Codex CLI home (same read-only rules as ~/.claude). Codex writes
// rollout logs to ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.
function codexDir() {
  return process.env.CODEX_DIR || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function codexSessionsRoot() {
  return path.join(codexDir(), 'sessions');
}

// --- Other agents (all read-only, same as ~/.claude) --------------------------
// Pulse also ingests a few other coding agents whose local logs carry per-turn
// model + token counts in a plain-JSON format we can read with Node builtins:
// Gemini CLI, Continue, and Cline. Each shows up as its own `source`, only when
// its logs are actually present on the machine.

// Gemini CLI — ~/.gemini/tmp/<projectHash>/chats/session-*.jsonl (one JSON
// record per line, with a `tokens` object and a `model`). GEMINI_DIR /
// GEMINI_CLI_HOME relocate the home (mirrors Gemini CLI's own env var).
function geminiDir() {
  return process.env.GEMINI_DIR || process.env.GEMINI_CLI_HOME || path.join(os.homedir(), '.gemini');
}
function geminiChatsRoot() { return path.join(geminiDir(), 'tmp'); }

// Continue — ~/.continue/dev_data/<version>/tokensGenerated.jsonl (one record
// per generation: model/provider + promptTokens/generatedTokens). These are
// Continue's own LOCAL estimates, not provider-billed, so entries are flagged
// `estimate`. CONTINUE_DIR / CONTINUE_GLOBAL_DIR relocate the home.
function continueDir() {
  return process.env.CONTINUE_DIR || process.env.CONTINUE_GLOBAL_DIR || path.join(os.homedir(), '.continue');
}
function continueDevDataRoot() { return path.join(continueDir(), 'dev_data'); }

// Cline — a VS Code extension: task history lives under the editor's
// globalStorage/saoudrizwan.claude-dev/tasks/<taskId>/ as ui_messages.json (+
// task_metadata.json). We probe every common editor flavour × OS. CLINE_DIR
// overrides with an explicit .../saoudrizwan.claude-dev directory.
// Roo Code is a Cline fork with the SAME task layout, under its own extension
// ids (it shipped as roo-cline, later roo-code — probe both). ROO_DIR overrides.
const CLINE_EXT_ID = 'saoudrizwan.claude-dev';
const ROO_EXT_IDS = ['rooveterinaryinc.roo-cline', 'rooveterinaryinc.roo-code'];
function vscodeGlobalStorageBases() {
  const home = os.homedir();
  const editors = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf'];
  const bases = [];
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    for (const e of editors) bases.push(path.join(appdata, e, 'User', 'globalStorage'));
  } else if (process.platform === 'darwin') {
    for (const e of editors) bases.push(path.join(home, 'Library', 'Application Support', e, 'User', 'globalStorage'));
  } else {
    for (const e of editors) bases.push(path.join(home, '.config', e, 'User', 'globalStorage'));
    bases.push(path.join(home, '.vscode-server', 'data', 'User', 'globalStorage')); // remote/SSH/WSL
  }
  return bases;
}
function clineExtensionDirs() {
  if (process.env.CLINE_DIR) return [process.env.CLINE_DIR];
  return vscodeGlobalStorageBases().map((b) => path.join(b, CLINE_EXT_ID));
}
function rooExtensionDirs() {
  if (process.env.ROO_DIR) return [process.env.ROO_DIR];
  const out = [];
  for (const b of vscodeGlobalStorageBases()) for (const id of ROO_EXT_IDS) out.push(path.join(b, id));
  return out;
}
// Discover every task's ui_messages.json under the given extension dirs.
// READ-ONLY: readdirSync/statSync only.
function taskFilesUnder(extDirs) {
  const out = [];
  for (const ext of extDirs) {
    const tasksDir = path.join(ext, 'tasks');
    let ids;
    try { ids = fs.readdirSync(tasksDir, { withFileTypes: true }); } catch (_) { continue; }
    for (const d of ids) {
      if (!d.isDirectory()) continue;
      const f = path.join(tasksDir, d.name, 'ui_messages.json');
      try { if (fs.statSync(f).isFile()) out.push(f); } catch (_) { /* no ui_messages here */ }
    }
  }
  return out;
}
function clineTaskFiles() { return taskFilesUnder(clineExtensionDirs()); }
function rooTaskFiles() { return taskFilesUnder(rooExtensionDirs()); }

// ---- custom user-defined sources (config `customSources`) ------------------
// The user's OWN tooling (a local model harness, a homemade agent) appends one
// JSON object per line to a JSONL log; Pulse reads it READ-ONLY like every
// other source. Record schema is documented in README "Custom sources".
// Config row: { name, path, label? } — `name` is the source key everywhere
// (filters, CSV columns, colors), `path` is a .jsonl file or a directory
// walked for *.jsonl, `label` is the display name (defaults to the name).
const CUSTOM_SOURCE_NAME_RE = /^[a-z][a-z0-9_-]{0,23}$/;
// Names that would collide with (or spoof) a built-in source — including
// 'mixed', the sessions table's multi-source label.
const CUSTOM_SOURCE_RESERVED = new Set(['cli', 'claude', 'codex', 'gemini', 'cline', 'continue', 'roo', 'mixed']);
const CUSTOM_SOURCES_MAX = 8;
const customSourceWarned = new Set(); // warn ONCE per dropped row / oversized file
function customSourcesConfig() {
  const raw = readConfig().customSources;
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  const takenLabels = new Set(); // lowercased display identities (names + labels)
  for (const row of raw) {
    if (out.length >= CUSTOM_SOURCES_MAX) break;
    if (!row || typeof row !== 'object') continue;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const p = typeof row.path === 'string' ? row.path.trim() : '';
    if (!CUSTOM_SOURCE_NAME_RE.test(name) || CUSTOM_SOURCE_RESERVED.has(name) || seen.has(name) || !p) {
      // Dropped rows must be diagnosable (this runs per aggregate — warn once).
      const why = !CUSTOM_SOURCE_NAME_RE.test(name)
        ? 'invalid name (letter-first lowercase slug of a-z 0-9 _ -, max 24 chars)'
        : CUSTOM_SOURCE_RESERVED.has(name) ? 'reserved name'
        : seen.has(name) ? 'duplicate name' : 'missing path';
      const k = JSON.stringify(row.name);
      if (!customSourceWarned.has(k)) {
        customSourceWarned.add(k);
        console.warn('[burnglass] customSources: dropped ' + k + ' — ' + why);
      }
      continue;
    }
    seen.add(name);
    takenLabels.add(name);
    // The label reaches the DOM, CSV headers and the terminal — sanitize like
    // the plan label: control chars stripped BEFORE the length cap. It is a
    // display alias, so it must not read as a built-in source or as another
    // source's name/label (case-insensitively) — fall back to the name.
    let label = typeof row.label === 'string'
      ? row.label.replace(CONTROL_CHARS, '').trim().slice(0, 24) : '';
    const lc = label.toLowerCase();
    if (!label || CUSTOM_SOURCE_RESERVED.has(lc) || (takenLabels.has(lc) && lc !== name)) label = name;
    else takenLabels.add(lc);
    out.push({ name, path: p, label });
  }
  return out;
}
// The currently-configured custom source names, as a Set — the identity roster
// the archive-merge paths check stale custom cells against.
function customSourceNames() { return new Set(customSourcesConfig().map((s) => s.name)); }
// One source's files: the configured path itself when it's a file (any
// extension — the config names it explicitly), else every *.jsonl under the
// directory. A missing path yields [] — the harness just hasn't logged yet.
function customSourceFiles(src) {
  try {
    const st = fs.statSync(src.path);
    if (st.isDirectory()) return walkJsonl(src.path);
    if (st.isFile()) return [src.path];
  } catch (_) { /* not created yet */ }
  return [];
}
// Display metadata for custom sources: { key: { label } }, only where the
// label differs from the raw key (the UI falls back to the key otherwise).
// Config-derived, so it is identical in filtered and unfiltered builds.
function sourceMetaForPayload() {
  const meta = {};
  for (const src of customSourcesConfig()) {
    if (src.label !== src.name) meta[src.name] = { label: src.label };
  }
  return meta;
}

// ---------------------------------------------------------------------------
// §3  RECORD ACCESSORS — read field names via small helpers with fallbacks.
// Field names have drifted across Claude Code versions; never assume a key
// exists. (Phase 0 confirmed the shapes on the target machine.)
// ---------------------------------------------------------------------------

function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

// Stable dedup key identifying a unique assistant message.
//
// The brief describes a composite `message.id + ":" + requestId`. In practice
// message.id is a globally-unique per-message id that is CONSISTENT across the
// duplicate lines the log writes as a message streams — so we key on it alone
// when present. Folding requestId into the key would SPLIT a message whose
// requestId is present on some copies but absent on others (a real log quirk),
// double-counting its usage; message.id alone dedups those copies correctly.
// We fall back to requestId, then uuid, then a timestamp+model+token-count
// composite so two genuinely-distinct messages at the same instant are not
// collapsed while true duplicate writes (identical counts) still dedup.
function dedupKey(rec) {
  const msg = rec.message || {};
  if (msg.id) return 'm:' + msg.id;
  if (rec.requestId) return 'r:' + rec.requestId;
  if (rec.uuid) return 'u:' + rec.uuid;
  const u = msg.usage || {};
  return 't:' + (rec.timestamp || '') + ':' + (msg.model || '') + ':' +
    num(u.input_tokens) + ':' + num(u.output_tokens);
}

// Extract the plain-text of a user record's content (string, or an array of
// blocks with {type:'text', text}). Used only for the title fallback.
function userText(rec) {
  const c = rec.message && rec.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    for (const block of c) {
      if (block && block.type === 'text' && typeof block.text === 'string') return block.text;
      if (typeof block === 'string') return block;
    }
  }
  return '';
}

// LIVE CONVERSATION STATE (for the Discord state art). parseFile/parseCodexFile
// record, in the pass they already make, where each conversation's MAIN
// thread stopped: the kind of its last meaningful line and any tool calls
// still waiting for a result. computeAgentState() turns that — plus Claude
// Code's own live status file — into working / thinking / waiting / idle.
// Tools whose open call means Claude is waiting on YOU, not working.
const WAITING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
// Classify one main-thread transcript record, updating `open` (tool_use id →
// tool name) as calls start and resolve. Returns the step kind or null.
function claudeConvStep(rec, open, st) {
  // st.caveat: the previous main-thread line was Claude Code's isMeta
  // <local-command-caveat> ("DO NOT respond…"), written before local
  // commands and before `!` shell lines that Claude will NOT answer.
  const cav = st.caveat;
  st.caveat = false;
  if (rec.type === 'system') return rec.subtype === 'compact_boundary' ? 'prompt' : null; // compaction ends → model resumes
  const content = rec.message && rec.message.content;
  if (rec.type === 'user') {
    if (rec.isMeta) {
      if (/<local-command-caveat>/.test(userText(rec))) st.caveat = true;
      return null;
    }
    if (Array.isArray(content)) {
      let results = 0;
      for (const b of content) if (b && b.type === 'tool_result') { open.delete(b.tool_use_id); results++; }
      // Parallel / sequential calls resolve one line at a time: while others
      // are still open, a tool is still running.
      if (results) return open.size ? 'tool_use' : 'tool_result';
    }
    const txt = userText(rec).trim();
    if (!txt) return null;
    if (/^\[Request interrupted by user/.test(txt)) { open.clear(); return 'interrupt'; }
    if (parseLocalCommand(txt)) return 'command';
    if (/^<user-memory-input>/.test(txt)) return 'command'; // `#` memory line
    // `!` shell mode: since Claude Code 2.1.186 Claude ANSWERS the output by
    // default (respondToBashCommands) — a prompt. Only with the caveat line
    // before it (respondToBashCommands:false) is it context-only.
    if (/^<(?:bash-input|bash-stdout|bash-stderr)>/.test(txt) && cav) { st.caveat = true; return 'command'; }
    open.clear(); // a new prompt: anything still "open" was abandoned
    return 'prompt';
  }
  if (rec.type === 'assistant') {
    if (rec.isApiErrorMessage) return 'error';
    let tools = 0;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b && b.type === 'tool_use' && typeof b.id === 'string') { open.set(b.id, String(b.name || '')); tools++; }
      }
    }
    return tools ? 'tool_use' : 'reply';
  }
  return null;
}

// Reasoning-effort level names Claude Code accepts for `/effort` (ultracode is
// handled separately — it is xhigh plus workflow orchestration, shown as ULTRA).
const EFFORT_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

// Detect a local-command user record (`/effort`, `/model`, …). Claude Code
// writes these into the transcript as XML-ish tags:
//   <command-name>/effort</command-name> ... <command-args>max</command-args>
// and echoes their output in a follow-up <local-command-stdout> record.
// Returns { name, args } for a command record, { name: '', args: '', stdout }
// for a stdout echo, or null for a real prompt.
function parseLocalCommand(txt) {
  const m = /<command-name>\s*(\/[\w:.-]+)\s*<\/command-name>/.exec(txt);
  if (m) {
    const a = /<command-args>([\s\S]*?)<\/command-args>/.exec(txt);
    return { name: m[1], args: a ? a[1].trim() : '' };
  }
  if (txt.indexOf('<local-command-stdout>') !== -1) {
    const s = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(txt);
    return { name: '', args: '', stdout: s ? s[1].trim() : '' };
  }
  return null;
}

// Parse an /effort confirmation echo into an effort event, or null. Bare
// `/effort` opens an interactive picker — the command record carries NO args
// (so the args path yields nothing), but the CLI-generated confirmation names
// the chosen level:
//   "Set effort level to high (this session only)"
//   "Set effort level to ultracode (this session only): xhigh + dynamic ..."
//   "Kept effort level as max" · "Effort level set to auto"
// Only CLI-written stdout is matched (never prompt text), anchored at the
// start, so a user QUOTING these words can't forge an event.
function parseEffortStdout(stdout) {
  const m = /^(?:Set effort level to|Kept effort level as|Effort level set to)\s+([a-z]+)/i.exec(stdout || '');
  if (!m) return null;
  const lvl = m[1].toLowerCase();
  if (lvl === 'ultracode') return { effort: null, ultracode: true };
  if (lvl === 'auto') return { effort: null, ultracode: false }; // back to default → no chip
  if (EFFORT_LEVELS.has(lvl)) return { effort: lvl, ultracode: false };
  return null;
}

// String intern pool. model/source/project/sessionId values repeat across
// tens of thousands of retained entries, and JSON.parse allocates a FRESH
// string for each occurrence — interning keeps one copy per distinct value,
// which is a real RSS win on large histories. Capped so a pathological log
// (e.g. unique session ids forever) can't grow the pool unbounded; overflow
// strings simply skip the pool.
const _intern = new Map();
function intern(s) {
  if (typeof s !== 'string' || !s) return s;
  const hit = _intern.get(s);
  if (hit !== undefined) return hit;
  if (_intern.size < 50000) _intern.set(s, s);
  return s;
}

// Turn one assistant-with-usage record into a normalized Entry, or null if the
// record carries no usage.
function normalize(rec) {
  const msg = rec.message;
  if (!msg || !msg.usage) return null; // skip non-usage records for cost
  const u = msg.usage;

  const ts = Date.parse(rec.timestamp);
  if (!isFinite(ts)) return null;

  // Cache-creation TTL breakdown (§5). If the breakdown object is present, use
  // it and DO NOT also add the lump `cache_creation_input_tokens` (it is the
  // sum of the two). If absent, treat the whole lump as a 5-minute write.
  let cacheWrite5m, cacheWrite1h;
  const cc = u.cache_creation;
  if (cc && (typeof cc.ephemeral_5m_input_tokens === 'number' ||
             typeof cc.ephemeral_1h_input_tokens === 'number')) {
    cacheWrite5m = num(cc.ephemeral_5m_input_tokens);
    cacheWrite1h = num(cc.ephemeral_1h_input_tokens);
  } else {
    cacheWrite5m = num(u.cache_creation_input_tokens);
    cacheWrite1h = 0;
  }

  const stu = u.server_tool_use || {};

  const e = {
    ts,
    provider: 'anthropic',
    model: intern(msg.model || 'unknown'),
    source: intern(rec.entrypoint || 'cli'), // §3.4 — default cli when absent
    // Execution mode as recorded by Claude Code. `speed` (fast vs standard)
    // and `service_tier` live in usage. Reasoning effort: Claude Code ≥ 2.1.212
    // records it per assistant entry (top-level `effort`, captured below as
    // parseEffort); older transcripts lack it and "ultracode" is never logged —
    // both are recovered from the effort sidecar / echoes in annotateModes().
    speed: intern(u.speed || 'standard'),
    serviceTier: intern(u.service_tier || 'standard'),
    // US-only inference (`inference_geo: "us"`) bills all token categories at
    // 1.1× on 4.6+ models — applied in claudeTokenCost. Absent/other = 1×.
    geoUs: u.inference_geo === 'us',
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheWrite5m,
    cacheWrite1h,
    cacheRead: num(u.cache_read_input_tokens),
    webSearches: num(stu.web_search_requests),
    sessionId: intern(rec.sessionId || ''),
    project: intern(rec.cwd || ''),
    // Subagent / workflow transcript line (Claude Code marks them isSidechain;
    // they carry the PARENT's sessionId). Used to pick the main conversation's
    // model for the live Discord line.
    sidechain: rec.isSidechain === true,
    // messageId/requestId are folded into `key` (dedupKey) at parse time and
    // never read again — retaining two unique strings per entry was pure RSS.
    key: dedupKey(rec),
  };
  // `effort` = the level Claude Code actually SENT (written only when set).
  // `perTurnEffort` (≥ 2.1.281) is deliberately IGNORED: it is always written
  // but only sent when a beta is active, so a level taken from it may never
  // have run — and a parseEffort is authoritative, so it would also BLOCK a
  // real /effort echo from filling this entry in annotateModes.
  const recorded = recordedEffort(rec.effort);
  if (recorded) e.parseEffort = recorded; // authoritative for this message — see annotateModes
  e.cost = costForEntry(e);
  return e;
}
// The per-message reasoning-effort level Claude Code ≥ 2.1.212 writes on each
// assistant transcript entry (a short lowercase word: low/medium/high/xhigh/max).
// Non-levels: "auto"/"default" mean "no explicit level" (the /effort echo
// parser already clears the chip for "set to auto") — never a chip or an
// effort-spend bucket of their own.
const NON_EFFORT_LEVELS = new Set(['auto', 'default', 'none', 'off', 'unset', 'adaptive']);
function recordedEffort(v) {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  return /^[a-z]{1,12}$/.test(s) && !NON_EFFORT_LEVELS.has(s) ? intern(s) : undefined;
}

// Advisor-tool sub-inferences (Claude Code's advisor, API server tool
// advisor_20260301): each is a usage.iterations[] item of type
// "advisor_message" with its OWN model and token counts, billed at the
// advisor model's rates and EXCLUDED from the top-level usage — so without
// this they were invisible spend. One extra entry per advisor iteration,
// inheriting the executor entry's time/session/project/source; key suffix
// keeps them unique and replay-stable.
function advisorEntries(parent, mark) {
  const its = mark && mark.adv;
  if (!its || !its.length) return [];
  const out = [];
  its.forEach((it, i) => {
    const cc = it.cache_creation;
    let w5, w1;
    if (cc && (typeof cc.ephemeral_5m_input_tokens === 'number' || typeof cc.ephemeral_1h_input_tokens === 'number')) {
      w5 = num(cc.ephemeral_5m_input_tokens); w1 = num(cc.ephemeral_1h_input_tokens);
    } else { w5 = num(it.cache_creation_input_tokens); w1 = 0; }
    const e = {
      ts: parent.ts,
      provider: 'anthropic',
      model: intern(typeof it.model === 'string' && it.model ? it.model : (mark.advModel || parent.model)),
      source: parent.source,
      speed: 'standard',
      serviceTier: parent.serviceTier,
      geoUs: parent.geoUs,
      inputTokens: num(it.input_tokens),
      outputTokens: num(it.output_tokens),
      cacheWrite5m: w5,
      cacheWrite1h: w1,
      cacheRead: num(it.cache_read_input_tokens),
      webSearches: 0,
      sessionId: parent.sessionId,
      project: parent.project,
      sidechain: parent.sidechain,
      advisor: true,
      key: parent.key + ':adv' + i,
    };
    e.cost = costForEntry(e);
    out.push(e);
  });
  return out;
}

// ---------------------------------------------------------------------------
// PARSE + mtime CACHE
//
// In-memory cache keyed by filepath: { mtimeMs, entries, sessionMeta }.
// Parsing is the expensive part and is skipped entirely for files whose mtime
// is unchanged; the arithmetic rollup is cheap and redone every request.
// ---------------------------------------------------------------------------

const fileCache = new Map();

// Parse a single .jsonl file into normalized entries + per-session metadata,
// with per-file dedup applied. Malformed lines (incl. a partial trailing write
// on a live session) are caught and skipped — this is normal, not an error.
function parseFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    // Read failed — e.g. the file is locked mid-write by Claude Code (common on
    // Windows). Return null (not empty) so the caller does NOT cache this as
    // "no data" and instead retries on the next request.
    return null;
  }
  const lines = raw.split('\n');
  const entries = [];
  const seen = new Map();       // per-file dedup: key -> index in entries
  const marks = [];             // parallel to entries: parse-time marks (see below)
  const sessionMeta = {};       // sessionId -> { firstUserText, project }
  const ultracodeSessions = []; // sessions whose prompts invoked ultracode
  const effortEvents = [];      // time-stamped /effort changes parsed from the transcript
  // Where the MAIN thread stopped (see claudeConvStep) + newest subagent line.
  const openTools = new Map();
  const convSt = { caveat: false };
  let convKind = null, convTs = 0, convSid = '', sideTs = 0;

  for (const line of lines) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (_) {
      continue; // partial/truncated line — skip
    }
    if (!rec || typeof rec !== 'object') continue;

    if (rec.type === 'user' || rec.type === 'assistant' || rec.type === 'system') {
      const t = Date.parse(rec.timestamp);
      if (isFinite(t)) {
        if (rec.isSidechain === true) {
          if (t > sideTs) sideTs = t;
          if (!convSid && typeof rec.sessionId === 'string') convSid = rec.sessionId;
        } else {
          const k = claudeConvStep(rec, openTools, convSt);
          if (k) {
            convKind = k; convTs = t;
            if (typeof rec.sessionId === 'string' && rec.sessionId) convSid = rec.sessionId;
          }
        }
      }
    }

    // Each user record is either a real prompt or a local-command invocation
    // (`/effort`, `/model`, …, plus their <local-command-stdout> echoes).
    if (rec.type === 'user') {
      const sid = rec.sessionId || '';
      const txt = userText(rec);
      const cmd = parseLocalCommand(txt);
      // First real prompt per session → title fallback (commands make bad titles).
      if (sid && !cmd && !sessionMeta[sid]) {
        sessionMeta[sid] = {
          firstUserText: txt.trim(),
          project: rec.cwd || '',
        };
      }
      if (cmd) {
        // `/effort <level>` applies to the live session only and is persisted
        // nowhere — but the invocation IS in the transcript. Parse it into a
        // time-stamped event: works retroactively, no hook required.
        if (sid && cmd.name === '/effort' && cmd.args) {
          const ts = Date.parse(rec.timestamp);
          const lvl = cmd.args.toLowerCase().split(/\s+/)[0];
          if (isFinite(ts)) {
            if (lvl === 'ultracode') effortEvents.push({ sessionId: sid, ts, effort: null, ultracode: true });
            else if (EFFORT_LEVELS.has(lvl)) effortEvents.push({ sessionId: sid, ts, effort: lvl, ultracode: false });
          }
        }
        // Bare `/effort` (the interactive picker, the desktop-app default)
        // leaves args empty — the chosen level only exists in the CLI's
        // confirmation echo. Parse that too. Inline usage produces both a
        // command event and an echo event with the same value — harmless,
        // the join reads them as identical state snapshots.
        if (sid && cmd.stdout) {
          const ev = parseEffortStdout(cmd.stdout);
          const ts = Date.parse(rec.timestamp);
          if (ev && isFinite(ts)) effortEvents.push({ sessionId: sid, ts, ...ev });
        }
        // Command records and their stdout echoes are not prompt text —
        // never keyword-flag ultracode from them.
      } else if (sid && /\bultracode\b/i.test(txt)) {
        // The keyword in a real prompt opts the whole session in — works
        // retroactively, even before any effort source was set up.
        ultracodeSessions.push(sid);
      }
      continue;
    }

    if (rec.type !== 'assistant') continue;
    const e = normalize(rec);
    if (!e) continue;
    // Parse-time marks kept in a SIDE array, never on the entry: adding then
    // deleting properties flips a V8 object into slow dictionary mode — on
    // every entry (current transcripts carry iterations on nearly every line)
    // that was 3.4× the heap. iters = this line carries usage.iterations (only
    // the FINAL line of a multi-block message does); adv = its advisor calls.
    const its = rec.message.usage.iterations;
    const mark = Array.isArray(its) && its.length ? {
      iters: true,
      adv: its.filter((it) => it && it.type === 'advisor_message'),
      advModel: typeof rec.advisorModel === 'string' ? rec.advisorModel : '',
    } : null;
    const at = seen.get(e.key);
    if (at !== undefined) {
      // Per-file dedup. Claude Code ≥ 2.1.281 writes one line per content
      // block, all sharing message.id; in subagent transcripts the EARLY lines
      // carry the streaming PARTIAL usage (e.g. 8 output tokens) and a later
      // line the final count (297). First-wins kept the partial copy and lost
      // ~99% of those messages' output. Keep the FULLER copy (more output;
      // tie → the one carrying usage.iterations, which only the final line
      // has) at the FIRST line's timestamp — when the request was made.
      const prev = entries[at];
      if (e.outputTokens > prev.outputTokens || (e.outputTokens === prev.outputTokens && mark && !marks[at])) {
        e.ts = prev.ts;
        e.cost = costForEntry(e);
        entries[at] = e;
        marks[at] = mark;
      }
      continue;
    }
    seen.set(e.key, entries.length);
    entries.push(e);
    marks.push(mark);

    // Record project path for sessions even if no user record was seen.
    if (e.sessionId && !sessionMeta[e.sessionId]) {
      sessionMeta[e.sessionId] = { firstUserText: '', project: e.project };
    } else if (e.sessionId && sessionMeta[e.sessionId] && !sessionMeta[e.sessionId].project) {
      sessionMeta[e.sessionId].project = e.project;
    }
  }
  // Expand advisor sub-inferences from the KEPT copy of each message. The
  // marks array is local, so nothing transient ever reaches the mtime cache.
  let expanded = entries;
  if (marks.some((m) => m && m.adv.length)) {
    expanded = [];
    entries.forEach((e, i) => {
      expanded.push(e);
      for (const a of advisorEntries(e, marks[i])) expanded.push(a);
    });
  }
  const conv = convSid && (convKind || sideTs)
    ? { provider: 'claude', sessionId: convSid, kind: convKind, ts: convTs, open: Array.from(openTools.values()), sideTs }
    : null;
  return { entries: expanded, sessionMeta, ultracodeSessions, effortEvents, conv };
}

// ---------------------------------------------------------------------------
// OPENAI CODEX PARSER
// Codex rollout files are JSONL event streams:
//   {"timestamp":"ISO","type":"session_meta"|"turn_context"|"event_msg"|…,
//    "payload":{…}}
// Usage arrives in event_msg payloads of type "token_count":
//   payload.info.last_token_usage   — this turn's usage (preferred)
//   payload.info.total_token_usage  — cumulative session usage (delta fallback)
// with { input_tokens (INCLUDES cached), cached_input_tokens, output_tokens
// (includes reasoning), reasoning_output_tokens, total_tokens }.
// Model + reasoning effort come from turn_context; the session id, cwd and
// first user prompt from session_meta / user_message events.
// Shapes verified against a real rollout written by codex 0.144.3.
// ---------------------------------------------------------------------------
function diffUsage(tot, prev) {
  const d = {};
  for (const k of ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']) {
    d[k] = Math.max(0, num(tot[k]) - num(prev[k]));
  }
  return d;
}

function parseCodexFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null; // locked mid-write — retry next request, do not cache
  }
  const entries = [];
  const sessionMeta = {};
  let sid = '';
  let groupSid = ''; // session the rollout's usage belongs to (see session_meta)
  let isSub = false; // a subagent rollout (spawned agent, auto-reviewer, /review)
  // Where the turn stopped (live state for the Discord art): turn start/end
  // events and tool calls still waiting for their output.
  const openCalls = new Map();
  let convKind = null, convTs = 0;
  let project = '';
  let model = 'gpt-unknown';
  let effort = null;
  let serviceTier = 'standard'; // effective tier from thread_settings_applied (state snapshot)
  let prevTotal = null;
  // Codex token_count events also carry a rate_limits snapshot of the ChatGPT
  // account's Codex allowance (primary=session window, secondary=weekly) —
  // official meters, straight from the local log. Keep the newest one.
  let rateSnapshot = null;
  // token_count events can precede the first turn_context in a rollout; buffer
  // those entries and backfill the model (and cost) once it is known instead
  // of leaving a "gpt-unknown" row on the dashboard.
  const preModelEntries = [];

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; } // partial trailing write
    if (!rec || typeof rec !== 'object') continue;
    const p = rec.payload || {};

    if (rec.type === 'event_msg' || rec.type === 'response_item') {
      const k = codexConvStep(rec.type, p, openCalls);
      const t = k ? Date.parse(rec.timestamp) : NaN;
      if (k && isFinite(t)) { convKind = k; convTs = t; }
    }

    if (rec.type === 'session_meta') {
      sid = p.session_id || p.id || sid;
      // Subagent rollouts (spawn_agent threads, the auto-reviewer, /review):
      // source {subagent: …} and/or parent_thread_id. Current Codex already
      // gives them the ROOT's session_id; legacy ones (< 0.144) only carry
      // their own thread id, so group them under the parent — one session,
      // like Claude Code subagents. `sid` stays the file's own identity for
      // the replay-safe dedup key.
      const src = p.source && typeof p.source === 'object' ? p.source.subagent : null;
      isSub = !!(src || p.parent_thread_id || p.thread_source === 'subagent');
      const parentId = p.parent_thread_id || (src && src.thread_spawn && src.thread_spawn.parent_thread_id) || '';
      groupSid = p.session_id || (isSub && parentId) || sid;
      project = p.cwd || project;
      if (sid && !sessionMeta[sid]) sessionMeta[sid] = { firstUserText: '', project };
      continue;
    }
    if (rec.type === 'turn_context') {
      if (p.model) {
        model = String(p.model);
        while (preModelEntries.length) {
          const pe = preModelEntries.pop();
          pe.model = model;
          pe.cost = costForEntry(pe);
        }
      }
      const eff = p.effort ||
        (p.collaboration_mode && p.collaboration_mode.settings && p.collaboration_mode.settings.reasoning_effort);
      if (eff) effort = String(eff);
      continue;
    }
    // Effective service tier (state snapshot, latest wins). Codex persists a
    // thread_settings_applied event whose thread_settings.service_tier is the
    // tier the session actually runs — including a MODEL DEFAULT the TUI
    // resolved (GPT-6 Sol/Luna default to "priority" = Fast = 2× list).
    if (rec.type === 'event_msg' && p.type === 'thread_settings_applied') {
      const st = p.thread_settings && p.thread_settings.service_tier;
      serviceTier = typeof st === 'string' && st ? st.toLowerCase() : 'standard';
      continue;
    }
    if (rec.type === 'event_msg' && p.type === 'user_message') {
      if (sid && sessionMeta[sid] && !sessionMeta[sid].firstUserText && typeof p.message === 'string') {
        sessionMeta[sid].firstUserText = p.message.replace(/\s+/g, ' ').trim();
      }
      continue;
    }
    if (rec.type === 'event_msg' && p.type === 'token_count') {
      const info = p.info || {};
      const ts = Date.parse(rec.timestamp);
      if (!isFinite(ts)) continue;
      const rl = p.rate_limits;
      const rlUsable = rl && typeof rl === 'object' && [rl.primary, rl.secondary].some(
        (w) => w && typeof w === 'object' && typeof w.used_percent === 'number' && isFinite(w.used_percent));
      if (rlUsable && (!rateSnapshot || ts >= rateSnapshot.ts)) {
        rateSnapshot = { ts, limits: rl };
      }
      const tot = info.total_token_usage || null;
      let u = info.last_token_usage || null;
      if (!u && tot) u = prevTotal ? diffUsage(tot, prevTotal) : tot;
      if (tot) prevTotal = tot;
      if (!u) continue;
      const input = num(u.input_tokens), cached = num(u.cached_input_tokens), output = num(u.output_tokens);
      if (input + output <= 0) continue;
      // cache_write_input_tokens (rollouts ≥ 0.145) is ALSO a subset of input,
      // disjoint from cached; absent in older rollouts → 0.
      const written = Math.min(num(u.cache_write_input_tokens), Math.max(0, input - cached));
      const fast = serviceTier === 'priority' || serviceTier === 'fast';
      const e = {
        ts,
        provider: 'openai',
        model,
        source: 'codex',
        speed: fast ? 'fast' : 'standard',
        serviceTier: intern(serviceTier),
        // OpenAI semantics: input INCLUDES cached and cache-written; split so
        // tokensOf() and the per-category cost both come out right.
        inputTokens: Math.max(0, input - cached - written),
        outputTokens: output,
        cacheWrite5m: written,
        cacheWrite1h: 0,
        cacheRead: cached,
        webSearches: 0,
        sessionId: groupSid || sid || path.basename(filePath, '.jsonl'),
        project,
        sidechain: isSub, // never the "what you're running" model (activeNow)
        // Parse-time effort lives in its own immutable field; annotateModes
        // seeds from it every pass, so e.effort stays a pure per-pass output
        // (cached entries are re-annotated on every request).
        parseEffort: effort,
        // Replay-safe key: a resumed rollout replaying the same cumulative
        // snapshot at the same timestamp dedups to one entry. Falls back to
        // the filename so sid-less files can never collide with each other.
        key: 'cx:' + (sid || path.basename(filePath, '.jsonl')) + ':' + ts + ':' + (tot ? num(tot.total_tokens) : input + output),
      };
      e.cost = costForEntry(e);
      entries.push(e);
      if (model === 'gpt-unknown') preModelEntries.push(e);
      continue;
    }
  }
  const convSid = groupSid || sid || path.basename(filePath, '.jsonl');
  // A subagent rollout only ever signals "the session's helpers are busy".
  const conv = convKind
    ? (isSub ? { provider: 'codex', sessionId: convSid, kind: null, ts: 0, open: [], sideTs: convTs }
      : { provider: 'codex', sessionId: convSid, kind: convKind, ts: convTs, open: Array.from(openCalls.values()), sideTs: 0 })
    : null;
  return { entries, sessionMeta, ultracodeSessions: [], effortEvents: [], codexRateSnapshot: rateSnapshot, conv };
}

// Codex counterpart of claudeConvStep: turn_started/task_started open a turn
// (model thinking), a function/custom/shell call without its output yet is a
// running tool, task_complete / turn_aborted end the turn. Codex never
// persists approval requests, so it has no "waiting on you" state.
function codexConvStep(type, p, open) {
  const t = p && p.type;
  if (type === 'event_msg') {
    // A new turn: calls left open by a killed turn (no turn_aborted) are dead.
    // A mid-turn user_message is injected into the running turn — keep them.
    if (t === 'task_started' || t === 'turn_started') { open.clear(); return 'prompt'; }
    if (t === 'user_message') return 'prompt';
    if (t === 'task_complete' || t === 'turn_complete' || t === 'turn_aborted') { open.clear(); return 'reply'; }
    return null;
  }
  if (t === 'function_call' || t === 'custom_tool_call' || t === 'local_shell_call') {
    const id = p.call_id || p.id;
    if (typeof id === 'string') open.set(id, String(p.name || t));
    return 'tool_use';
  }
  if (t === 'function_call_output' || t === 'custom_tool_call_output' || t === 'local_shell_call_output') {
    if (typeof p.call_id === 'string') open.delete(p.call_id);
    return open.size ? 'tool_use' : 'tool_result'; // other calls still running
  }
  return null;
}

// ---------------------------------------------------------------------------
// OTHER-AGENT PARSERS — Gemini CLI, Continue, Cline.
// Each returns the same shape as parseFile/parseCodexFile so parseAll() can
// treat them uniformly. Read-only; formats reverse-engineered from each tool's
// open-source logs. Entries carry provider/source so pricing + breakdowns route
// correctly; a synthetic per-agent fixture covers each in test/.
// ---------------------------------------------------------------------------

// Shared skeleton for an agent usage entry (fields every aggregation reads).
function agentEntry(fields) {
  const e = {
    speed: 'standard', serviceTier: 'standard',
    inputTokens: 0, outputTokens: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0,
    webSearches: 0, sessionId: '', project: '',
    ...fields,
  };
  // Same interning as normalize() — agent logs repeat these just as heavily.
  e.model = intern(e.model); e.source = intern(e.source);
  e.sessionId = intern(e.sessionId); e.project = intern(e.project);
  return e;
}

// Gemini CLI — one JSON object per line; usage records carry a `tokens` object
// ({input,output,cached,thoughts,tool}) and a `model`. `input` includes cached
// (Gemini usageMetadata semantics), so uncached input = input - cached; thoughts
// (reasoning) bill as output. Dedup within a file by message id, LAST write wins
// (an edited turn is rewritten in place).
function parseGeminiFile(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (_) { return null; }
  const byId = new Map();
  let idx = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    if (!rec || typeof rec !== 'object') continue;
    const tk = rec.tokens;
    if (!tk || typeof tk !== 'object') continue; // not a usage record
    const ts = Date.parse(rec.timestamp || rec.time || rec.createdAt || rec.date || '');
    if (!isFinite(ts)) continue;
    const cached = num(tk.cached);
    const input = num(tk.input);
    const inputTokens = Math.max(0, input - cached) + num(tk.tool);
    const outputTokens = num(tk.output) + num(tk.thoughts);
    if (inputTokens + outputTokens + cached <= 0) continue;
    const sid = String(rec.sessionId || rec.session_id || path.basename(filePath, '.jsonl'));
    const id = String(rec.id || rec.messageId || (sid + ':' + ts + ':' + idx));
    idx++;
    const e = agentEntry({
      ts, provider: 'google', model: String(rec.model || 'gemini-unknown'), source: 'gemini',
      inputTokens, outputTokens, cacheRead: cached,
      sessionId: sid, project: String(rec.projectRoot || rec.cwd || ''),
      key: 'gm:' + id, // the id lives on in the key; a separate field was pure RSS
    });
    e.cost = costForEntry(e);
    byId.set(id, e); // last write wins
  }
  const entries = [...byId.values()];
  const sessionMeta = {};
  for (const e of entries) if (e.sessionId && !sessionMeta[e.sessionId]) sessionMeta[e.sessionId] = { firstUserText: '', project: e.project };
  return { entries, sessionMeta, ultracodeSessions: [], effortEvents: [] };
}

// Continue — dev_data/<ver>/tokensGenerated.jsonl. Records are camelCase
// (model/provider + promptTokens/generatedTokens), sometimes wrapped in a
// {name,timestamp,data} envelope. These are Continue's OWN local estimates (not
// provider-billed), so every entry is flagged `estimate`. No per-record id →
// dedup by file path + line index (stable across appends).
function parseContinueFile(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (_) { return null; }
  const entries = [];
  let i = -1;
  for (const line of raw.split('\n')) {
    i++;
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    if (!rec || typeof rec !== 'object') continue;
    const d = (rec.data && typeof rec.data === 'object') ? rec.data : rec;
    const model = String(d.model || rec.model || '');
    const promptTokens = num(d.promptTokens);
    const generatedTokens = num(d.generatedTokens);
    if (!model || promptTokens + generatedTokens <= 0) continue;
    const ts = Date.parse(rec.timestamp || d.timestamp || rec.eventTime || d.eventTime || '');
    if (!isFinite(ts)) continue;
    const prov = String(d.provider || rec.provider || '').toLowerCase();
    const m = model.toLowerCase();
    // Route to the right pricing table by model family (Continue's provider
    // label is a hint; the model string is authoritative).
    let provider = 'anthropic';
    if (/^(gpt|o[0-9]|codex|chatgpt)/.test(m) || prov.includes('openai')) provider = 'openai';
    else if (m.startsWith('gemini') || prov.includes('google') || prov.includes('gemini')) provider = 'google';
    const e = agentEntry({
      ts, provider, model, source: 'continue', estimate: true,
      inputTokens: promptTokens, outputTokens: generatedTokens,
      sessionId: 'continue', project: '',
      key: 'ct:' + filePath + ':' + i,
    });
    e.cost = costForEntry(e);
    entries.push(e);
  }
  const sessionMeta = entries.length ? { continue: { firstUserText: '', project: '' } } : {};
  return { entries, sessionMeta, ultracodeSessions: [], effortEvents: [] };
}

// Cline — VS Code extension. ui_messages.json is a JSON array of ClineMessage;
// usage lives on `api_req_started` "say" messages whose `text` is itself a
// JSON string ({tokensIn,tokensOut,cacheWrites,cacheReads,cost}). Cline records
// its OWN cost, so we use it directly. Model id comes from the sibling
// task_metadata.json `model_usage` (state-snapshot: latest entry ≤ req.ts).
// Roo Code (a Cline fork) writes the same task layout, so it parses through
// this same function with source 'roo'; if its api_req_started payload carries
// a modelId, that wins over the metadata timeline (Roo keeps precise model
// state in a SQLite DB Pulse deliberately does not read — zero-dep rule — so
// tasks without either fall back to the 'unknown' label).
function parseClineFile(filePath, source = 'cline') {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (_) { return null; }
  let msgs;
  try { msgs = JSON.parse(raw); } catch (_) { return { entries: [], sessionMeta: {}, ultracodeSessions: [], effortEvents: [] }; }
  if (!Array.isArray(msgs)) return { entries: [], sessionMeta: {}, ultracodeSessions: [], effortEvents: [] };
  const taskDir = path.dirname(filePath);
  const taskId = path.basename(taskDir);
  // Model usage timeline from task_metadata.json (optional; older tasks lack it).
  let modelUsage = [];
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(taskDir, 'task_metadata.json'), 'utf8'));
    if (meta && Array.isArray(meta.model_usage)) {
      modelUsage = meta.model_usage
        .filter((u) => u && typeof u.ts === 'number' && u.model_id)
        .sort((a, b) => a.ts - b.ts);
    }
  } catch (_) { /* no metadata → model stays unknown */ }
  const modelAt = (ts) => {
    let m = null;
    for (const u of modelUsage) { if (u.ts <= ts) m = u.model_id; else break; }
    return m || (modelUsage.length ? modelUsage[0].model_id : 'unknown');
  };
  const entries = [];
  let i = -1;
  for (const msg of msgs) {
    i++;
    if (!msg || msg.type !== 'say' || msg.say !== 'api_req_started' || typeof msg.text !== 'string') continue;
    let info;
    try { info = JSON.parse(msg.text); } catch (_) { continue; }
    if (!info || typeof info !== 'object') continue;
    const ts = num(msg.ts);
    // ts is a raw numeric epoch here (not via Date.parse), so reject anything
    // outside JS's valid Date range — an out-of-range value from a corrupt file
    // would otherwise become NaN in `new Date(ts)` downstream (e.g. the heatmap).
    if (!ts || !isFinite(new Date(ts).getTime())) continue;
    const tokensIn = num(info.tokensIn), tokensOut = num(info.tokensOut);
    const cacheWrites = num(info.cacheWrites), cacheReads = num(info.cacheReads);
    if (tokensIn + tokensOut + cacheWrites + cacheReads <= 0) continue;
    // Roo can carry the model right on the request record; Cline relies on the
    // metadata timeline. The record-level probe is ROO-ONLY so a future Cline
    // that writes a modelId field with different semantics can't silently
    // override the metadata path for existing Cline users.
    const recModel = source === 'roo' && typeof info.modelId === 'string' && info.modelId ? info.modelId : null;
    const model = String(recModel || modelAt(ts));
    const mlow = model.toLowerCase();
    let provider = 'anthropic';
    if (/^(gpt|o[0-9]|codex|chatgpt)/.test(mlow)) provider = 'openai';
    else if (mlow.startsWith('gemini')) provider = 'google';
    const e = agentEntry({
      ts, provider, model, source,
      inputTokens: tokensIn, outputTokens: tokensOut, cacheWrite5m: cacheWrites, cacheRead: cacheReads,
      sessionId: taskId, project: '',
      key: source + ':' + taskId + ':' + ts + ':' + i,
    });
    // Cline records real per-request cost — trust it; fall back to our estimate
    // only if it's absent (very old tasks). When we take the source's own
    // number, flag it: anything that re-prices the entry from OUR table (cache
    // economics) would then be talking about a different cost than the one on
    // screen — the model here is often just 'unknown'.
    if (typeof info.cost === 'number' && isFinite(info.cost)) { e.cost = info.cost; e.costFromSource = true; }
    else e.cost = costForEntry(e);
    entries.push(e);
  }
  const sessionMeta = entries.length ? { [taskId]: { firstUserText: '', project: '' } } : {};
  return { entries, sessionMeta, ultracodeSessions: [], effortEvents: [] };
}

// Parse one custom-source JSONL file (config `customSources`). Tolerant by
// design — the writer is the user's own tooling. Per line: `ts` (ISO string,
// epoch ms, or epoch seconds) is required; `input`/`output`/`cached` are token
// counts with `cached` a SUBSET of `input` (Gemini convention), so
// inputTokens = input − cached and cacheRead = cached — tokensOf() sums back
// to the harness's own total. Dedup: record `id` when present (id-keyed, LAST
// write wins — a replayed/rewritten request never double-counts), else file
// path + line index (Continue pattern). Cost: a finite record-level `cost` is
// trusted verbatim (Cline pattern), else $0 — custom models are typically
// local, and pricing an unknown model from our tables would invent spend.
// Either way costFromSource is set so nothing ever re-prices the entry.
// Malformed lines are skipped; only a failed READ returns null (parseAll
// keeps prior cached entries and retries next cycle).
const CUSTOM_SOURCE_MAX_BYTES = 50 * 1024 * 1024; // user logs have no rotation guarantee — cap the sync read
function parseCustomFile(filePath, src) {
  // Size guard BEFORE the read: an unbounded readFileSync of a user-pointed
  // file would block the event loop (or throw at >512MB) on every cycle.
  // Returning the empty shape (not null) caches the skip under the current
  // mtime, so an oversized file costs one statSync per change, not a re-read.
  try {
    if (fs.statSync(filePath).size > CUSTOM_SOURCE_MAX_BYTES) {
      if (!customSourceWarned.has(filePath)) {
        customSourceWarned.add(filePath);
        console.warn(`[burnglass] custom source "${src.name}": ${filePath} exceeds ${CUSTOM_SOURCE_MAX_BYTES / 1048576} MB — skipped (rotate the log into a directory of smaller files)`);
      }
      return { entries: [], sessionMeta: {}, ultracodeSessions: [], effortEvents: [] };
    }
  } catch (_) { return null; }
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch (_) { return null; }
  const byId = new Map();
  // Null-prototype: sid comes from the record ("__proto__" as a key on a plain
  // object literal would silently rewrite the prototype instead of storing).
  const sessionMeta = Object.create(null);
  const lines = text.split('\n');
  const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    let ts;
    if (typeof rec.ts === 'number' && isFinite(rec.ts)) {
      // Numeric: epoch ms, or epoch seconds → ms. Unambiguous — an ms value
      // below 1e12 would be a pre-2001 date, impossible for real usage.
      ts = rec.ts < 1e12 ? rec.ts * 1000 : rec.ts;
    } else {
      ts = Date.parse(rec.ts);
    }
    if (!isFinite(ts) || ts <= 0) continue;
    const input = num(rec.input);
    const output = num(rec.output);
    const cached = Math.min(num(rec.cached), input);
    if (input + output === 0) continue; // nothing measured — not a usage record
    const id = typeof rec.id === 'string' && rec.id ? rec.id.slice(0, 200) : filePath + ':' + i;
    const sid = typeof rec.sessionId === 'string' && rec.sessionId
      ? rec.sessionId.replace(CONTROL_CHARS, '').slice(0, 120) : src.name;
    const e = agentEntry({
      ts,
      provider: 'custom',
      source: src.name,
      model: typeof rec.model === 'string' && rec.model
        ? rec.model.replace(CONTROL_CHARS, '').slice(0, 80) : src.name,
      inputTokens: input - cached,
      outputTokens: output,
      cacheRead: cached,
      sessionId: sid,
      project: typeof rec.project === 'string'
        ? rec.project.replace(CONTROL_CHARS, '').slice(0, 200) : '',
      key: 'cs:' + src.name + ':' + id,
    });
    if (rec.estimate === true) e.estimate = true;
    e.cost = typeof rec.cost === 'number' && isFinite(rec.cost) && rec.cost >= 0 ? rec.cost : 0;
    e.costFromSource = true;
    byId.set(id, e);
    if (!sessionMeta[sid]) sessionMeta[sid] = { firstUserText: '', project: e.project };
  }
  return { entries: Array.from(byId.values()), sessionMeta, ultracodeSessions: [], effortEvents: [] };
}

// Turn the newest Codex rate_limits snapshot into display buckets. resets_at
// has been absolute (epoch seconds or ISO) in recent versions and
// resets_in_seconds (relative to the event) in older ones — handle all three.
// used_percent is 0–100. A bucket whose reset time has already passed is
// marked stale: the window rolled over since the snapshot, so its percentage
// no longer means anything.
function codexMetersFromSnapshot(snap) {
  if (!snap || !snap.limits) return null;
  const buckets = [];
  const addWindow = (key, w) => {
    if (!w || typeof w !== 'object') return;
    const pct = w.used_percent;
    if (typeof pct !== 'number' || !isFinite(pct)) return;
    const mins = num(w.window_minutes || w.window_duration_mins);
    let resetsAt = null;
    const ra = w.resets_at;
    if (typeof ra === 'number' && isFinite(ra)) resetsAt = ra < 1e12 ? ra * 1000 : ra;
    else if (typeof ra === 'string') { const t = Date.parse(ra); if (isFinite(t)) resetsAt = t; }
    else if (typeof w.resets_in_seconds === 'number' && isFinite(w.resets_in_seconds)) {
      resetsAt = snap.ts + w.resets_in_seconds * 1000;
    }
    let label;
    if (mins && mins <= 360) label = 'Codex · session (5h)';
    else if (mins && mins >= 8000 && mins <= 12000) label = 'Codex · weekly';
    else if (mins) label = 'Codex · ' + (mins % 1440 === 0 ? (mins / 1440) + '-day' : mins + '-min');
    else label = key === 'primary' ? 'Codex · session' : 'Codex · weekly';
    buckets.push({
      key: 'codex_' + key,
      label,
      pct: Math.max(0, Math.min(100, pct)),
      resetsAt,
      stale: resetsAt != null && resetsAt < Date.now(),
    });
  };
  addWindow('primary', snap.limits.primary);
  addWindow('secondary', snap.limits.secondary);
  if (!buckets.length) return null;
  return { asOf: snap.ts, buckets };
}

// Walk all files; reuse cached parse when mtime is unchanged. Returns the merged
// (globally deduped) entry list plus a merged sessionId->meta map. Logs a
// one-line "parsed X, skipped Y (cached)" so the mtime cache is observable.
function parseAll() {
  const walkT0 = Date.now();
  const claudeFiles = walkJsonl(projectsRoot());
  const codexFiles = walkJsonl(codexSessionsRoot());
  // Other agents — each discovered independently; absent dirs yield [] so the
  // source simply never appears. Continue's dev_data holds several .jsonl kinds;
  // only tokensGenerated.jsonl carries usage. Cline's are .json (not .jsonl).
  const geminiFiles = walkJsonl(geminiChatsRoot());
  const continueFiles = walkJsonl(continueDevDataRoot()).filter((f) => path.basename(f) === 'tokensGenerated.jsonl');
  const clineFiles = clineTaskFiles();
  const rooFiles = rooTaskFiles();
  const codexSet = new Set(codexFiles);
  const geminiSet = new Set(geminiFiles);
  const continueSet = new Set(continueFiles);
  const clineSet = new Set(clineFiles);
  const rooSet = new Set(rooFiles);
  // Config-defined custom sources: map each file → its source descriptor. A
  // file already claimed by auto-discovery is NEVER re-claimed by a custom
  // source: the builtin identity is what past days were sealed under, so
  // re-sourcing it would double-count against the archive. Warn once so a
  // custom source that silently stays empty is diagnosable.
  const builtinClaimed = new Set(claudeFiles.concat(codexFiles, geminiFiles, continueFiles, clineFiles, rooFiles));
  const customByFile = new Map();
  for (const src of customSourcesConfig()) {
    for (const f of customSourceFiles(src)) {
      if (builtinClaimed.has(f)) {
        const k = 'overlap:' + f;
        if (!customSourceWarned.has(k)) {
          customSourceWarned.add(k);
          console.warn(`[burnglass] customSources: "${src.name}" points at ${f}, which another source already ingests — ignored (custom sources must have their own log files)`);
        }
        continue;
      }
      if (!customByFile.has(f)) customByFile.set(f, src);
    }
  }
  const customFiles = Array.from(customByFile.keys());
  const walkMs = Date.now() - walkT0;
  const files = claudeFiles.concat(codexFiles, geminiFiles, continueFiles, clineFiles, rooFiles, customFiles);
  const liveFiles = new Set(files);

  let parsed = 0, skipped = 0, failed = 0;
  for (const f of files) {
    let st;
    try { st = fs.statSync(f); } catch (_) { continue; }
    // The cached parse depends on WHICH parser/source claimed the file, not
    // just its content — a customSources config edit (rename/add/remove) must
    // invalidate it even when the file's mtime is unchanged. Labels don't
    // affect parse output (applied at payload time), so the name suffices.
    const customSrc = customByFile.get(f);
    const route = customSrc ? 'custom:' + customSrc.name
      : codexSet.has(f) ? 'codex'
      : geminiSet.has(f) ? 'gemini'
      : continueSet.has(f) ? 'continue'
      : clineSet.has(f) ? 'cline'
      : rooSet.has(f) ? 'roo'
      : 'claude';
    const cached = fileCache.get(f);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.route === route) {
      skipped++;
      continue;
    }
    const result = customSrc ? parseCustomFile(f, customSrc)
      : codexSet.has(f) ? parseCodexFile(f)
      : geminiSet.has(f) ? parseGeminiFile(f)
      : continueSet.has(f) ? parseContinueFile(f)
      : clineSet.has(f) ? parseClineFile(f)
      : rooSet.has(f) ? parseClineFile(f, 'roo')
      : parseFile(f);
    if (result === null) {
      // Read failed this cycle (e.g. locked mid-write). Keep any prior cached
      // entries and retry next request — do NOT cache the failure.
      failed++;
      continue;
    }
    fileCache.set(f, {
      mtimeMs: st.mtimeMs,
      route,
      entries: result.entries,
      sessionMeta: result.sessionMeta,
      ultracodeSessions: result.ultracodeSessions || [],
      effortEvents: result.effortEvents || [],
      codexRateSnapshot: result.codexRateSnapshot || null,
      conv: result.conv || null,
    });
    parsed++;
  }
  // Drop cache entries for files that have disappeared.
  for (const key of fileCache.keys()) {
    if (!liveFiles.has(key)) fileCache.delete(key);
  }

  // Merge all cached files → global dedup. First occurrence wins — EXCEPT for
  // custom-source keys, where the same record id legitimately reappears across
  // rotated files and the documented semantics are last-write-wins: the record
  // with the newer timestamp replaces the older one (>= so a same-ts rewrite in
  // a later file also wins). Builtin keys never collide across files except as
  // identical stream duplicates, where first-vs-last is equivalent.
  const merged = [];
  const globalSeen = new Map(); // key -> index in merged
  const sessionMeta = Object.create(null); // sids are record-supplied strings
  const ultracodeSessions = new Set();
  const effortEvents = [];
  let codexRateSnapshot = null;
  // Live conversation state per session: the newest main-thread end state
  // across that session's files, and the newest subagent activity.
  const conv = Object.create(null);
  for (const { entries, sessionMeta: sm, ultracodeSessions: us, effortEvents: ev, codexRateSnapshot: rs, conv: c } of fileCache.values()) {
    if (c && c.sessionId) {
      const cur = conv[c.sessionId] || (conv[c.sessionId] = { provider: c.provider, kind: null, ts: 0, open: [], sideTs: 0 });
      if (c.kind && c.ts >= cur.ts) { cur.kind = c.kind; cur.ts = c.ts; cur.open = c.open; cur.provider = c.provider; }
      if (c.sideTs > cur.sideTs) cur.sideTs = c.sideTs;
    }
    for (const e of entries) {
      const prevIdx = globalSeen.get(e.key);
      if (prevIdx !== undefined) {
        if (e.provider === 'custom' && e.ts >= merged[prevIdx].ts) merged[prevIdx] = e;
        continue;
      }
      globalSeen.set(e.key, merged.length);
      merged.push(e);
    }
    for (const sid of us || []) ultracodeSessions.add(sid);
    for (const e of ev || []) effortEvents.push(e);
    if (rs && (!codexRateSnapshot || rs.ts > codexRateSnapshot.ts)) codexRateSnapshot = rs;
    for (const sid of Object.keys(sm)) {
      const cur = sessionMeta[sid];
      const inc = sm[sid];
      if (!cur) {
        sessionMeta[sid] = { firstUserText: inc.firstUserText || '', project: inc.project || '' };
      } else {
        if (!cur.firstUserText && inc.firstUserText) cur.firstUserText = inc.firstUserText;
        if (!cur.project && inc.project) cur.project = inc.project;
      }
    }
  }

  const agentBits = [];
  if (geminiFiles.length) agentBits.push(`${geminiFiles.length} gemini`);
  if (continueFiles.length) agentBits.push(`${continueFiles.length} continue`);
  if (clineFiles.length) agentBits.push(`${clineFiles.length} cline`);
  if (rooFiles.length) agentBits.push(`${rooFiles.length} roo`);
  if (customFiles.length) agentBits.push(`${customFiles.length} custom`);
  const agentStr = agentBits.length ? ', ' + agentBits.join(', ') : '';
  console.log(`[burnglass] walked ${files.length} file(s) (${claudeFiles.length} claude, ${codexFiles.length} codex${agentStr}) in ${walkMs}ms; parsed ${parsed}, skipped ${skipped} (cached)${failed ? `, ${failed} unreadable (will retry)` : ''}; ${merged.length} unique usage records`);
  return {
    entries: merged, sessionMeta, ultracodeSessions, effortEvents,
    fileCount: files.length, codexFileCount: codexFiles.length,
    codexRateSnapshot, conv,
  };
}

// ---------------------------------------------------------------------------
// EFFORT / MODE SOURCES
//
// Two complementary sources reconstruct the reasoning effort level:
//   1. `/effort <level>` commands parsed straight out of the transcripts
//      (parseFile) — session-scoped changes, retroactive, zero setup.
//   2. An optional hook (see --effort-setup) that logs the settings-persisted
//      effortLevel to a sidecar JSONL — catches levels applied across sessions
//      without a per-session /effort command. One line per change:
//        { ts, sessionId, event, effort, ultracode?, model? }
// Both are merged (mergeModes) into per-session state snapshots and
// time-joined onto entries (annotateModes). The sidecar is cached by mtime
// like transcript files, and lives outside ~/.claude on purpose.
// ---------------------------------------------------------------------------

function modesFilePath() {
  return envv('MODES_FILE') || path.join(appHome(), 'modes.jsonl');
}
// Read side: the home's sidecar plus, after the migration, the legacy
// ~/.pulse/modes.jsonl — a not-yet-updated exe registered as the Claude Code
// hook (its path is frozen in settings.json) keeps appending THERE, and a
// record written during the copy lands there too. Duplicates are harmless:
// annotateModes is a state-snapshot join.
function modesReadPaths() {
  const own = modesFilePath();
  if (envv('MODES_FILE')) return [own];
  const legacy = legacyCompatHome();
  return legacy ? [own, path.join(legacy, 'modes.jsonl')] : [own];
}

let modesCache = { sig: '', bySession: {} };
function readModes() {
  const files = [];
  let sig = '';
  for (const f of modesReadPaths()) {
    let st;
    try { st = fs.statSync(f); } catch (_) { continue; } // no log — hook not installed
    files.push(f);
    sig += f + ':' + st.mtimeMs + ':' + st.size + ';';
  }
  if (!files.length) return {};
  if (sig === modesCache.sig) return modesCache.bySession;
  const bySession = {};
  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let r;
      try { r = JSON.parse(line); } catch (_) { continue; }
      if (!r || !r.sessionId) continue;
      const ts = typeof r.ts === 'number' && isFinite(r.ts) ? r.ts : 0;
      (bySession[r.sessionId] = bySession[r.sessionId] || [])
        .push({ ts, effort: r.effort ? String(r.effort) : null, ultracode: !!r.ultracode });
    }
  }
  for (const k of Object.keys(bySession)) bySession[k].sort((a, b) => a.ts - b.ts);
  modesCache = { sig, bySession };
  return bySession;
}

// Merge the hook sidecar with transcript-parsed /effort events into one
// per-session, time-sorted snapshot list. Copies the cached sidecar arrays —
// never mutates them.
function mergeModes(sidecarBySession, effortEvents) {
  const out = {};
  for (const sid of Object.keys(sidecarBySession || {})) out[sid] = sidecarBySession[sid].slice();
  for (const ev of effortEvents || []) {
    if (!ev.sessionId) continue;
    (out[ev.sessionId] = out[ev.sessionId] || []).push({ ts: ev.ts, effort: ev.effort || null, ultracode: !!ev.ultracode });
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.ts - b.ts);
  return out;
}

// Annotate entries in place with { effort, ultracode }. Mode records — hook
// sidecar lines and transcript /effort events — are state snapshots; each
// entry takes the latest snapshot at or before it in its session. So an
// /effort mid-session applies from that point on, and switching (e.g.
// ultracode → max) turns the previous state off. The ultracode keyword in a
// real prompt still opts the whole session in.
function annotateModes(entriesAsc, modesBySession, ultracodeSessions) {
  for (const e of entriesAsc) {
    // Codex entries carry effort from their rollout's turn_context, stored in
    // the immutable parseEffort field. Seed from THAT (never from e.effort,
    // which is this function's own output — cached entries are re-annotated
    // every request and must not feed a prior pass back in as input).
    let effort = e.parseEffort || null;
    let ultra = ultracodeSessions.has(e.sessionId);
    const recs = modesBySession[e.sessionId];
    if (recs && recs.length) {
      let chosen = null;
      for (const r of recs) {
        if (r.ts <= e.ts) chosen = r; else break;
      }
      if (chosen) {
        // A parse-time recorded level (Codex turn_context, Claude Code ≥ 2.1.212
        // per-message `effort`) is authoritative for that entry; the sidecar /
        // echo events only fill the gaps. Ultracode is never recorded, so it
        // always comes from the events.
        if (!e.parseEffort) effort = chosen.effort;
        if (chosen.ultracode) ultra = true;
      }
    }
    e.effort = effort;
    e.ultracode = ultra;
  }
}

// ---------------------------------------------------------------------------
// §4.1  5-HOUR BLOCKS — the second area that must be exactly right.
// Implemented precisely as the usage monitor does.
// ---------------------------------------------------------------------------

function floorToHour(ts) {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0); // start of the local hour
  return d.getTime();
}

function computeBlocks(entriesAsc) {
  const blocks = [];
  let current = null;
  let lastTs = null;

  for (const e of entriesAsc) {
    if (current === null) {
      const start = floorToHour(e.ts);
      current = { start, end: start + BLOCK_MS, entries: [e] };
    } else {
      const newBlock = (e.ts - lastTs >= BLOCK_MS) || (e.ts >= current.end);
      if (newBlock) {
        blocks.push(current);
        const start = floorToHour(e.ts);
        current = { start, end: start + BLOCK_MS, entries: [e] };
      } else {
        current.entries.push(e);
      }
    }
    lastTs = e.ts;
  }
  if (current) blocks.push(current);
  return blocks;
}

function summarizeBlock(b) {
  let cost = 0, tokens = 0;
  for (const e of b.entries) {
    cost += e.cost;
    tokens += tokensOf(e);
  }
  return {
    start: b.start,
    end: b.end,
    cost,
    tokens,
    messages: b.entries.length,
  };
}

// Total billable tokens for an entry (input + output + all cache tokens).
function tokensOf(e) {
  return e.inputTokens + e.outputTokens + e.cacheWrite5m + e.cacheWrite1h + e.cacheRead;
}

// ---------------------------------------------------------------------------
// §4  AGGREGATIONS
// ---------------------------------------------------------------------------

function startOfLocalDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function aggregate(entries, sessionMeta, desktopTitles, now, modesBySession, ultracodeSessions, officialFiveHour, history) {
  const asc = entries.slice().sort((a, b) => a.ts - b.ts);
  annotateModes(asc, modesBySession || {}, ultracodeSessions || new Set());
  const modesLogged = Object.keys(modesBySession || {}).length > 0;
  // Days present in the live logs — the archive only fills days NOT here, so
  // live and archived data can never double-count.
  const hist = history && history.byDay ? history : EMPTY_HISTORY;
  const liveDays = new Set(asc.map((e) => localDateStr(e.ts)));

  // ---- 5-hour blocks + active block ----
  // Claude Code entries only: the 5h window is the Claude Code subscription's
  // rate-limit concept. Every other ingested agent (Codex, Gemini, Cline,
  // Continue, custom sources) has its own separate limits/billing and must not
  // distort the reset countdown — gate by SOURCE, not model provider (a Cline
  // turn on a Claude model is still not Claude Code usage).
  const claudeAsc = asc.filter((e) => !nonClaudeEntry(e));
  const rawBlocks = computeBlocks(claudeAsc);
  const blocks = rawBlocks.map(summarizeBlock);
  let activeBlock = null;
  for (const b of blocks) {
    if (b.start <= now && now < b.end) { activeBlock = b; break; }
  }
  const timeToReset = activeBlock ? (activeBlock.end - now) : null;

  // "vs your heaviest past block" — % of the max over all OTHER (completed)
  // blocks. Guard against a lone/first block (peak 0 → null).
  let currentBlock = null;
  // When the official account meter has a live five-hour reset time, IT is
  // the window — Anthropic's clock, not our reconstruction. The window spans
  // [reset - 5h, reset]; cost/tokens are this machine's contribution inside
  // it. Reconstruction remains the fallback (meters off, stale, or expired).
  const officialEnd = officialFiveHour && officialFiveHour.resetsAt;
  if (officialEnd && officialEnd > now && officialEnd - now <= BLOCK_MS + 5 * MINUTE_MS) {
    const start = officialEnd - BLOCK_MS;
    let cost = 0, tokens = 0, messages = 0;
    for (const e of claudeAsc) {
      if (e.ts >= start && e.ts <= now) { cost += e.cost; tokens += tokensOf(e); messages++; }
    }
    let peakCost = 0, peakTokens = 0;
    for (const b of blocks) {
      if (b.end > start) continue; // only fully-past reconstructed blocks compare fairly
      if (b.cost > peakCost) peakCost = b.cost;
      if (b.tokens > peakTokens) peakTokens = b.tokens;
    }
    currentBlock = {
      start,
      end: officialEnd,
      cost,
      tokens,
      messages,
      timeToReset: officialEnd - now,
      vsPeakCostPct: peakCost > 0 ? (cost / peakCost) * 100 : null,
      vsPeakTokensPct: peakTokens > 0 ? (tokens / peakTokens) * 100 : null,
      official: true,
    };
  } else if (activeBlock) {
    let peakCost = 0, peakTokens = 0;
    for (const b of blocks) {
      if (b === activeBlock) continue;
      if (b.cost > peakCost) peakCost = b.cost;
      if (b.tokens > peakTokens) peakTokens = b.tokens;
    }
    currentBlock = {
      start: activeBlock.start,
      end: activeBlock.end,
      cost: activeBlock.cost,
      tokens: activeBlock.tokens,
      messages: activeBlock.messages,
      timeToReset,
      vsPeakCostPct: peakCost > 0 ? (activeBlock.cost / peakCost) * 100 : null,
      vsPeakTokensPct: peakTokens > 0 ? (activeBlock.tokens / peakTokens) * 100 : null,
      official: false,
    };
  }

  // ---- §4.2 burn rate (trailing 60 minutes) ----
  const windowStart = now - 60 * MINUTE_MS;
  let brTokens = 0, brCost = 0, earliest = null;
  for (const e of asc) {
    if (e.ts >= windowStart && e.ts <= now) {
      brTokens += tokensOf(e);
      brCost += e.cost;
      if (earliest === null) earliest = e.ts; // asc → first is earliest
    }
  }
  let burnRate = null;
  if (earliest !== null) {
    const spanMin = (now - earliest) / MINUTE_MS;
    // min(60, span) with a 1-minute floor so early-session data isn't a
    // divide-by-near-zero blowup.
    const elapsedMin = Math.max(1, Math.min(60, spanMin));
    burnRate = {
      tokensPerMin: brTokens / elapsedMin,
      dollarsPerHour: brCost / (elapsedMin / 60),
      windowTokens: brTokens,
      windowCost: brCost,
      elapsedMin,
    };
  }

  // ---- rollups ----
  // Today / last-7-days tiles are LIVE-only: with any normal retention setting
  // (cleanupPeriodDays >= 7, incl. the default 30) the last week is always fully
  // on disk, so the archive would add nothing. The archive backfills the longer
  // windows and all-time totals, where pruning actually bites.
  const midnight = startOfLocalDay(now);
  const sevenDaysAgo = now - 7 * 24 * HOUR_MS;

  const today = { cost: 0, tokens: 0, messages: 0 };
  const week  = { cost: 0, tokens: 0, messages: 0 };
  for (const e of asc) {
    const tk = tokensOf(e);
    if (e.ts >= midnight) { today.cost += e.cost; today.tokens += tk; today.messages++; }
    if (e.ts >= sevenDaysAgo) { week.cost += e.cost; week.tokens += tk; week.messages++; }
  }

  // ---- distinct sources / models across all time (stable color assignment) ----
  const allSourcesSet = new Set(), allModelsSet = new Set(), monthKeySet = new Set();
  // Sources whose numbers are self-reported estimates (e.g. Continue computes
  // its own token counts locally rather than reading provider billing). The UI
  // badges these so they aren't read as metered truth.
  const estimatedSourcesSet = new Set();
  for (const e of asc) {
    allSourcesSet.add(e.source);
    if (e.estimate) estimatedSourcesSet.add(e.source);
    if (!HIDDEN_MODELS.has(e.model)) allModelsSet.add(e.model);
    monthKeySet.add(localDateStr(e.ts).slice(0, 7)); // YYYY-MM
  }
  // Archived-only sources/models/months must appear too, so colors stay stable
  // and old months remain selectable after their logs are pruned.
  for (const s of hist.sources) allSourcesSet.add(s);
  for (const m of hist.models) allModelsSet.add(m);
  for (const ds of Object.keys(hist.byDay)) if (!liveDays.has(ds)) monthKeySet.add(ds.slice(0, 7));
  const allSources = Array.from(allSourcesSet).sort();
  const allModels = Array.from(allModelsSet).sort();

  // ---- §4.3 spend PERIODS: rolling windows + one entry per calendar month ----
  // Each period carries its own daily buckets (split by source), by-model and
  // by-source rollups, and totals — so the spend section can be re-scoped to a
  // rolling window or any past month. Day walks use setDate (DST-safe).
  // Note: Claude Code prunes transcripts after ~cleanupPeriodDays (30 by
  // default), so long windows only show what is still on disk — documented.
  const periods = [];
  // Build a period's totals for an arbitrary window and return just the
  // {cost,tokens,messages} — reusing buildPeriod so the PREVIOUS window is
  // merged (live + archive, per cell) exactly like a period's OWN cost. This
  // keeps the delta chip apples-to-apples with the figure it's compared against.
  const windowTotals = (dayList) => {
    const set = new Set(dayList);
    const inWin = asc.filter((e) => set.has(localDateStr(e.ts)));
    const p = buildPeriod('_prev', '', inWin, dayList, allSources, hist, liveDays);
    return { cost: p.cost, tokens: p.tokens, messages: p.messages };
  };

  // Rolling windows (newest first in the dropdown).
  for (const [key, label, nDays] of [
    ['last30', 'Last 30 days', 30],
    ['last90', 'Last 90 days', 90],
    ['last180', 'Last 180 days', 180],
  ]) {
    const days = localDayStartsBack(now, nDays);
    const daySet = new Set(days);
    const inWin = asc.filter((e) => daySet.has(localDateStr(e.ts)));
    const p = buildPeriod(key, label, inWin, days, allSources, hist, liveDays);
    // Previous equal-length window: the nDays immediately before this one.
    const prevAnchor = new Date(now); prevAnchor.setDate(prevAnchor.getDate() - nDays);
    p.prev = windowTotals(localDayStartsBack(prevAnchor.getTime(), nDays));
    periods.push(p);
  }
  // One period per calendar month present in the data (newest first, capped).
  const months = Array.from(monthKeySet).sort().reverse().slice(0, 24);
  for (const mk of months) {
    const [y, m] = mk.split('-').map(Number);
    const days = monthDayList(y, m - 1);
    const inMonth = asc.filter((e) => localDateStr(e.ts).slice(0, 7) === mk);
    periods.push(buildPeriod(mk, monthLabel(y, m), inMonth, days, allSources, hist, liveDays));
  }
  // Month-over-month prev: a month's previous window IS the prior calendar
  // month, already built above as its own period — reference it directly (same
  // merge, no recompute). Missing prior month (no data / beyond the cap) → zero.
  const periodByKey = {};
  for (const p of periods) periodByKey[p.key] = p;
  for (const mk of months) {
    const [y, m] = mk.split('-').map(Number);
    const pm = new Date(y, m - 2, 1);
    const pmk = pm.getFullYear() + '-' + String(pm.getMonth() + 1).padStart(2, '0');
    const prev = periodByKey[pmk];
    periodByKey[mk].prev = prev
      ? { cost: prev.cost, tokens: prev.tokens, messages: prev.messages }
      : { cost: 0, tokens: 0, messages: 0 };
  }

  // ---- recent sessions (newest first) ----
  // Null-prototype: keyed by record-supplied sessionIds ("__proto__" etc.).
  const sessMap = Object.create(null);
  for (const e of asc) {
    const sid = e.sessionId || '(unknown)';
    let s = sessMap[sid];
    if (!s) {
      s = sessMap[sid] = {
        sessionId: sid, cost: 0, tokens: 0, messages: 0,
        models: new Set(), sources: new Set(), speeds: new Set(), efforts: new Set(),
        ultracode: false, lastTs: 0, firstTs: e.ts,
      };
    }
    s.cost += e.cost; s.tokens += tokensOf(e); s.messages++;
    if (!HIDDEN_MODELS.has(e.model)) s.models.add(e.model);
    s.sources.add(e.source); s.speeds.add(e.speed);
    if (e.effort) s.efforts.add(e.effort);
    if (e.ultracode) s.ultracode = true;
    if (e.ts > s.lastTs) s.lastTs = e.ts;
  }
  const recentSessions = Object.values(sessMap)
    .sort((a, b) => b.lastTs - a.lastTs)
    .slice(0, 20)
    .map((s) => ({
      sessionId: s.sessionId,
      title: sessionTitle(s.sessionId, sessionMeta, desktopTitles),
      source: s.sources.size === 1 ? Array.from(s.sources)[0] : 'mixed',
      models: Array.from(s.models),
      speeds: Array.from(s.speeds).sort(),
      efforts: Array.from(s.efforts).sort(),
      ultracode: s.ultracode,
      cost: s.cost,
      tokens: s.tokens,
      messages: s.messages,
      lastTs: s.lastTs,
    }));

  // All-time totals include archived days the live logs no longer hold, so the
  // totals tile (and Discord's all-time page) reflect true history, not just
  // the ~30 days still on disk. Merged per (day, source, model) cell — the
  // more-complete of live vs archive — so a partially-pruned day isn't
  // undercounted and nothing double-counts. Sessions stays live-only (archived
  // per-day counts can't be de-duplicated across days).
  const liveCellsByDay = {};
  for (const e of asc) {
    const ds = localDateStr(e.ts);
    const k = cellKey(e.source, e.model);
    const day = liveCellsByDay[ds] || (liveCellsByDay[ds] = Object.create(null));
    const cell = day[k] || (day[k] = { source: e.source, model: e.model, cost: 0, tokens: 0, messages: 0 });
    cell.cost += e.cost; cell.tokens += tokensOf(e); cell.messages++;
    if (e.provider === 'custom') cell.c = 1;
  }
  const totals = { cost: 0, tokens: 0, messages: 0, sessions: Object.keys(sessMap).length, bySource: Object.create(null) };
  const allDays = new Set(Object.keys(liveCellsByDay));
  for (const ds of Object.keys(hist.byDay)) allDays.add(ds);
  const totCustomNames = customSourceNames();
  for (const ds of allDays) {
    const lc = liveCellsByDay[ds] || {};
    const ac = indexCells(hist.byDay[ds] && hist.byDay[ds].rows);
    const keys = new Set(Object.keys(lc));
    for (const k of Object.keys(ac)) keys.add(k);
    // Same stale-custom-cell retirement as buildPeriod pass 2 — see there.
    const liveHasCustom = Object.keys(lc).some((k2) => lc[k2].c);
    for (const k of keys) {
      if (!lc[k] && ac[k] && ac[k].c && liveHasCustom && !totCustomNames.has(ac[k].source)) continue;
      const cell = pickCell(lc[k], ac[k]);
      totals.cost += cell.cost; totals.tokens += cell.tokens; totals.messages += cell.messages;
      // Same merged cell, split by source — so an archived-only source (its live
      // logs long pruned) still shows an all-time row, and nothing is counted twice.
      const bs = totals.bySource[cell.source] || (totals.bySource[cell.source] = { cost: 0, tokens: 0, messages: 0 });
      bs.cost += cell.cost; bs.tokens += cell.tokens; bs.messages += cell.messages;
    }
  }

  // Which provider is in active use right now — the newest activity within the
  // last 15 minutes — for the Discord presence logo. null == idle.
  const ACTIVE_MS = 15 * 60 * 1000;
  // How far back activeNow looks for a live session's MAIN-thread entry when
  // only its subagents wrote inside ACTIVE_MS (a long-running workflow).
  const ACTIVE_MAIN_LOOKBACK_MS = 24 * 60 * 60 * 1000;
  let activeProvider = null;
  if (asc.length && now - asc[asc.length - 1].ts <= ACTIVE_MS) {
    // Only Claude Code / Codex have dedicated Discord art. The other agents
    // (custom sources included) map to null (Pulse art) rather than falsely
    // claiming "Using Claude Code".
    const last = asc[asc.length - 1];
    activeProvider = last.source === 'codex' ? 'codex' : nonClaudeEntry(last) ? null : 'claude';
  }
  // What you're doing right now, for the Discord line: the model + effort of
  // the newest MAIN-conversation entry of the active provider (never a
  // subagent's or an advisor call's — those would flicker the line to a Haiku
  // explorer or the advisor model), plus how many distinct sessions had any
  // activity inside the same window (subagents share their parent's id).
  let activeNow = null;
  if (activeProvider) {
    const cutoff = now - ACTIVE_MS;
    const provOf = (e) => (e.source === 'codex' ? 'codex' : nonClaudeEntry(e) ? null : 'claude');
    // Helper calls are neither "what you're using" nor a session of yours:
    // advisor sub-inferences, Codex's background auto-reviewer (its own
    // rollout — legacy Codex even gave it its own session id), synthetic rows.
    const helper = (e) => e.advisor || e.model === 'codex-auto-review' || HIDDEN_MODELS.has(e.model);
    const sessions = new Set();
    let main = null, fallback = null, i = asc.length - 1;
    for (; i >= 0 && asc[i].ts >= cutoff; i--) {
      const e = asc[i];
      if (helper(e)) continue;
      if (e.sessionId) sessions.add(e.sessionId);
      if (provOf(e) !== activeProvider) continue;
      if (!fallback) fallback = e;
      if (!main && !e.sidechain) main = e;
    }
    // A long workflow: the main thread dispatched it and waits while only
    // subagents write, so its newest entry is older than the window — but the
    // session is live. Keep showing the main model (bounded look-back) rather
    // than falling to a Haiku explorer.
    if (!main && fallback) {
      const floor = cutoff - ACTIVE_MAIN_LOOKBACK_MS;
      for (; i >= 0 && asc[i].ts >= floor; i--) {
        const e = asc[i];
        if (!e.sidechain && !helper(e) && provOf(e) === activeProvider && sessions.has(e.sessionId)) { main = e; break; }
      }
    }
    const pick = main || fallback;
    if (pick) {
      activeNow = { provider: activeProvider, model: pick.model, effort: pick.effort || null,
        ultracode: !!pick.ultracode, sessions: sessions.size };
    }
  }

  // Activity heatmap — cost/tokens/messages by local weekday (0=Sun … 6=Sat) ×
  // hour (0–23), over all live entries. Reveals when you actually work.
  const hmGrid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ cost: 0, tokens: 0, messages: 0 })));
  let hmMaxCost = 0, hmMaxMsgs = 0;
  for (const e of asc) {
    const d = new Date(e.ts);
    const dow = d.getDay(), hr = d.getHours();
    if (!(dow >= 0 && dow <= 6) || !(hr >= 0 && hr <= 23)) continue; // guard a bad ts (Invalid Date → NaN index)
    const cell = hmGrid[dow][hr];
    cell.cost += e.cost; cell.tokens += tokensOf(e); cell.messages++;
    if (cell.cost > hmMaxCost) hmMaxCost = cell.cost;
    if (cell.messages > hmMaxMsgs) hmMaxMsgs = cell.messages;
  }
  const heatmap = { grid: hmGrid, maxCost: hmMaxCost, maxMessages: hmMaxMsgs };

  const payload = {
    generatedAt: now,
    latestTs: asc.length ? asc[asc.length - 1].ts : null, // newest record on this machine
    activeProvider, // 'claude' | 'codex' | null (idle)
    activeNow, // { provider, model, effort, ultracode, sessions } | null (idle)
    totals,
    currentBlock,
    idle: activeBlock === null,
    burnRate,
    today,
    week,
    periods,
    budget: computeBudget(periods, week, now),
    // Account-level by definition (the subscription covers everything), so a
    // source-filtered build overwrites this with the unfiltered figure — see
    // buildSummary.
    planValue: computePlanValue(periods, now),
    allSources,
    allModels,
    // Display metadata for config-defined custom sources: { key: { label } }.
    // Keys everywhere else (filters, CSV columns, colors) stay the raw name;
    // config-derived, so identical in filtered and unfiltered builds.
    sourceMeta: sourceMetaForPayload(),
    // Union live-flagged estimate sources with the known set AND the archive's
    // persisted est marks, over allSources — so an estimated source (Continue,
    // or a flagged custom source) stays badged even after its live logs are
    // pruned and only the archive remains.
    estimatedSources: allSources.filter((s) => estimatedSourcesSet.has(s) || KNOWN_ESTIMATE_SOURCES.has(s) || (hist.estSources && hist.estSources.has(s))),
    recentSessions,
    heatmap,
    pricing: buildPricingView(now),
    hasData: entries.length > 0,
    // effort/mode sidecar status — lets the UI hint at setup when absent
    modesLogged,
    modesFile: modesFilePath(),
  };

  payload.selfCheck = selfCheck(payload, asc, rawBlocks);
  return payload;
}

// Build one spend period: daily buckets (split by source) + by-model/by-source
// rollups + totals, over the given entries and ordered day list.
function buildPeriod(key, label, entries, dayList, allSources, hist, liveDays) {
  const index = {};
  const daily = [];
  for (const ds of dayList) {
    const bucket = { date: ds, total: 0, tokens: 0, bySource: {} };
    for (const s of allSources) bucket.bySource[s] = 0;
    index[ds] = bucket;
    daily.push(bucket);
  }
  // Null-prototype accumulators: keys come from record-supplied strings (model,
  // project) — on a plain object literal a key like "__proto__" would rewrite
  // the prototype instead of storing a row. Object.keys/values/stringify are
  // unaffected by the null prototype.
  const byModel = Object.create(null), bySource = Object.create(null), srcSet = new Set(), sess = new Set();
  let cost = 0, tokens = 0, messages = 0;
  // Analytics breakdowns — live-only (the archive keeps day/source/model totals,
  // not per-entry effort or project), so these cover the sessions still in your
  // logs. Effort bucket = ultracode | <level> | default (no explicit level).
  const effortSpend = Object.create(null), byProject = Object.create(null);
  // Cache economics and fast-mode spend are per-ENTRY facts (token type, speed,
  // the model's price row at that timestamp) — the archive keeps none of that,
  // so both are LIVE-only, exactly like effortSpend/byProject above.
  const cacheSavings = { readTokens: 0, saved: 0, writePremium: 0, net: 0 };
  const speedSpend = {
    fast: { cost: 0, tokens: 0, messages: 0 },
    standard: { cost: 0, tokens: 0, messages: 0 },
    fastPremium: 0,
  };

  // Pass 1: fold live entries into per-(day,source,model) cells, and accumulate
  // the decorative chips (speed/tier/effort/ultracode) + distinct sessions from
  // the live logs only.
  const liveCells = {};
  for (const e of entries) {
    const ds = localDateStr(e.ts);
    const k = cellKey(e.source, e.model);
    const day = liveCells[ds] || (liveCells[ds] = Object.create(null));
    const cell = day[k] || (day[k] = { source: e.source, model: e.model, cost: 0, tokens: 0, messages: 0 });
    cell.cost += e.cost; cell.tokens += tokensOf(e); cell.messages++;
    if (e.provider === 'custom') cell.c = 1; // custom identity — see the archive-merge rule
    if (e.sessionId) sess.add(e.sessionId);
    const ce = cacheEconomicsForEntry(e);
    cacheSavings.readTokens += ce.read;
    cacheSavings.saved += ce.saved;
    cacheSavings.writePremium += ce.writePremium;
    const sb = e.speed === 'fast' ? speedSpend.fast : speedSpend.standard;
    sb.cost += e.cost; sb.tokens += tokensOf(e); sb.messages++;
    // Only fast entries carry a premium — an entry whose model has no fast
    // price prices identically either way, so it contributes 0 rather than
    // being special-cased. The provider test keeps that invariant LOCAL:
    // standardCostForEntry prices ONLY Anthropic and OpenAI entries through
    // their own tables, so another parser emitting speed:'fast' can never
    // produce a premium computed at the wrong provider's list prices.
    if ((e.provider === 'anthropic' || e.provider === 'openai') && e.speed === 'fast') {
      speedSpend.fastPremium += e.cost - standardCostForEntry(e);
    }
    // Hidden placeholders (e.g. "<synthetic>") still count toward the daily/day
    // totals (they are $0 / 0-token) but never get a by-model row or chips.
    if (!HIDDEN_MODELS.has(e.model)) {
      const tk = tokensOf(e);
      const m = byModel[e.model] || (byModel[e.model] = { cost: 0, tokens: 0, messages: 0, speeds: {}, tiers: {} });
      m.speeds[e.speed] = (m.speeds[e.speed] || 0) + 1;
      m.tiers[e.serviceTier] = (m.tiers[e.serviceTier] || 0) + 1;
      if (e.effort) m.efforts = m.efforts || {}, m.efforts[e.effort] = (m.efforts[e.effort] || 0) + 1;
      if (e.ultracode) m.ultracode = (m.ultracode || 0) + 1;
      const eb = e.ultracode ? 'ultracode' : (e.effort || 'default');
      const es = effortSpend[eb] || (effortSpend[eb] = { cost: 0, tokens: 0, messages: 0 });
      es.cost += e.cost; es.tokens += tk; es.messages++;
      const proj = e.project || '(unknown)';
      const pb = byProject[proj] || (byProject[proj] = { cost: 0, tokens: 0, messages: 0, sessions: new Set() });
      pb.cost += e.cost; pb.tokens += tk; pb.messages++;
      if (e.sessionId) pb.sessions.add(e.sessionId);
    }
    const s = bySource[e.source] || (bySource[e.source] = { cost: 0, tokens: 0, messages: 0, speeds: {}, tiers: {} });
    s.speeds[e.speed] = (s.speeds[e.speed] || 0) + 1;
  }

  // Pass 2: for each day, take the MORE-COMPLETE observation of every cell —
  // live or archived — and fold it into the daily buckets and rollups. Merging
  // per cell (not all-or-nothing per day) recovers a provider/session pruned
  // from the live logs while another remains, and each cell contributes exactly
  // once, so nothing is double-counted.
  const customNames = customSourceNames();
  for (const ds of dayList) {
    const lc = liveCells[ds] || {};
    const ac = hist ? indexCells(hist.byDay[ds] && hist.byDay[ds].rows) : {};
    const keys = new Set(Object.keys(lc));
    for (const k of Object.keys(ac)) keys.add(k);
    const b = index[ds];
    // Custom-source archive rows are keyed by a config-mutable name. When a
    // day still has LIVE custom coverage, an archived custom cell whose source
    // is no longer configured is the pre-rename duplicate of data now counted
    // under the new name — retire it. Days with no live custom entries keep
    // everything (a removed source's genuinely pruned history must survive).
    const liveHasCustom = Object.keys(lc).some((k2) => lc[k2].c);
    for (const k of keys) {
      if (!lc[k] && ac[k] && ac[k].c && liveHasCustom && !customNames.has(ac[k].source)) continue;
      const cell = pickCell(lc[k], ac[k]);
      if (b) { b.total += cell.cost; b.tokens += cell.tokens; b.bySource[cell.source] = (b.bySource[cell.source] || 0) + cell.cost; }
      cost += cell.cost; tokens += cell.tokens; messages += cell.messages; srcSet.add(cell.source);
      if (!HIDDEN_MODELS.has(cell.model)) {
        const m = byModel[cell.model] || (byModel[cell.model] = { cost: 0, tokens: 0, messages: 0, speeds: {}, tiers: {} });
        m.cost += cell.cost; m.tokens += cell.tokens; m.messages += cell.messages;
      }
      const s = bySource[cell.source] || (bySource[cell.source] = { cost: 0, tokens: 0, messages: 0, speeds: {}, tiers: {} });
      s.cost += cell.cost; s.tokens += cell.tokens; s.messages += cell.messages;
    }
  }
  const sources = Array.from(srcSet).sort();
  // Project breakdown: resolve session Sets to counts, keep the top 30 by cost
  // and fold the long tail into "(other)" so the payload stays small.
  const projEntries = Object.keys(byProject).map((p) => {
    const v = byProject[p];
    return { project: p, cost: v.cost, tokens: v.tokens, messages: v.messages, sessions: v.sessions.size };
  }).sort((a, b) => b.cost - a.cost);
  const TOP_PROJECTS = 30;
  const byProjectOut = projEntries.slice(0, TOP_PROJECTS);
  if (projEntries.length > TOP_PROJECTS) {
    const rest = projEntries.slice(TOP_PROJECTS).reduce((a, p) => {
      a.cost += p.cost; a.tokens += p.tokens; a.messages += p.messages; a.sessions += p.sessions; return a;
    }, { project: '(other)', cost: 0, tokens: 0, messages: 0, sessions: 0 });
    byProjectOut.push(rest);
  }
  // Live-only spend covered by the effort/project breakdowns (period cost also
  // includes archived days, which don't retain effort/project) — lets the UI
  // say what fraction the breakdowns account for.
  const liveCost = Object.values(effortSpend).reduce((a, b) => a + b.cost, 0);
  // Deliberately NOT clamped at 0: caching can be a net loss (lots of writes,
  // few reads), and that is exactly the case worth surfacing.
  cacheSavings.net = cacheSavings.saved - cacheSavings.writePremium;
  // sessions is live-only: archived per-day session counts can't be de-duplicated
  // across days or split by source, so they are not summed here.
  return {
    key, label, cost, tokens, messages, sessions: sess.size,
    daily, byModel, bySource, sources, singleSource: sources.length <= 1,
    effortSpend, byProject: byProjectOut, liveCost, cacheSavings, speedSpend,
  };
}

// The periods planValue reads, rebuilt from the UNFILTERED entries + archive.
// Only used when the dashboard's source filter is active: what a subscription
// buys you is an account-level figure and must not shrink when a source is
// hidden. Builds just those windows instead of re-running the whole aggregation.
function planPeriods(entries, history, now) {
  const hist = history && history.byDay ? history : EMPTY_HISTORY;
  const monthKeys = new Set();
  for (const e of entries) monthKeys.add(localDateStr(e.ts).slice(0, 7));
  for (const ds of Object.keys(hist.byDay)) monthKeys.add(ds.slice(0, 7));
  // allSources only pre-seeds the daily bySource buckets, which planValue never
  // reads — an empty list keeps this build cheap.
  const d30 = localDayStartsBack(now, 30);
  const s30 = new Set(d30);
  const out = [buildPeriod('last30', 'Last 30 days',
    entries.filter((e) => s30.has(localDateStr(e.ts))), d30, [], hist, null)];
  for (const mk of Array.from(monthKeys).sort().slice(-PLAN_MONTHS)) {
    const [y, m] = mk.split('-').map(Number);
    out.push(buildPeriod(mk, mk,
      entries.filter((e) => localDateStr(e.ts).slice(0, 7) === mk), monthDayList(y, m - 1), [], hist, null));
  }
  return out;
}

// Ordered list of the last n local calendar dates ending today (oldest first),
// DST-safe via setDate.
function localDayStartsBack(now, n) {
  const out = [];
  const c = new Date(now);
  c.setHours(0, 0, 0, 0);
  c.setDate(c.getDate() - (n - 1));
  for (let i = 0; i < n; i++) {
    out.push(localDateStr(c.getTime()));
    c.setDate(c.getDate() + 1);
  }
  return out;
}

// Ordered list of every local calendar date in a given month (oldest first).
function monthDayList(year, monthIdx) {
  const out = [];
  const c = new Date(year, monthIdx, 1); // local midnight, day 1
  while (c.getMonth() === monthIdx) {
    out.push(localDateStr(c.getTime()));
    c.setDate(c.getDate() + 1);
  }
  return out;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthLabel(year, month /* 1-based */) {
  return (MONTH_NAMES[month - 1] || '?') + ' ' + year;
}

// ---------------------------------------------------------------------------
// HISTORICAL RETENTION  (§5)
// Claude Code prunes transcripts after ~cleanupPeriodDays (30 by default),
// which would blank the 90/180-day windows and understate all-time totals for
// older data. Pulse keeps a daily rollup — cost/tokens/messages per
// (day, source, model), plus a per-day session count — under ~/.burnglass/history,
// one JSON file per calendar month. Only SEALED (fully-past) days are written;
// today is always live. On read, a day is taken from the live logs if it has
// ANY entry, else from the archive — so live and archive never double-count.
// Writes ONLY to ~/.burnglass; sources stay read-only. On by default; disable with
// {"history": false}. Test override: PULSE_HISTORY_DIR.
// ---------------------------------------------------------------------------
function historyEnabled() { return readConfig().history !== false; }
function historyDir() {
  return envv('HISTORY_DIR') || path.join(appHome(), 'history');
}
// After the migration, a v1 process that still runs somewhere (a downgrade,
// an un-updated portable copy, a side-by-side port) keeps sealing into
// ~/.pulse/history — and a day it alone sealed is gone for good once Claude
// Code prunes the transcript. So the legacy archive is also READ (never
// written), merged per cell with the same pickCell rule as everything else,
// the new home's archive as argument `a` so it wins every tie.
function legacyHistoryDir() {
  if (envv('HISTORY_DIR')) return null;
  const legacy = legacyCompatHome();
  if (!legacy) return null;
  const d = path.join(legacy, 'history');
  return isDir(d) ? d : null;
}

const EMPTY_HISTORY = { byDay: {}, sources: new Set(), models: new Set(), months: new Set(), estSources: new Set() };
let historyCache = { sig: '', data: null };

function listHistoryMonths(dir) {
  try { return fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort(); }
  catch (_) { return null; }
}
// One month file → { 'YYYY-MM-DD': { rows, sessions } } with validated rows.
function readHistoryMonth(file) {
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const ds of Object.keys(obj)) {
    const rec = obj[ds];
    if (!rec || !Array.isArray(rec.rows)) continue;
    const rows = [];
    for (const r of rec.rows) {
      if (!r || typeof r.source !== 'string' || typeof r.model !== 'string') continue;
      const row = { source: r.source, model: r.model, cost: +r.cost || 0, tokens: +r.tokens || 0, messages: +r.messages || 0 };
      // Identity marks written by sealHistory — est keeps the badge after
      // the live logs prune, c lets the merges retire renamed custom cells.
      if (r.est) row.est = 1;
      if (r.c) row.c = 1;
      rows.push(row);
    }
    out[ds] = { rows, sessions: +rec.sessions || 0 };
  }
  return out;
}

// Read every archived month into { byDay, sources, models, months }. Cached by
// the set of month files and their mtimes, so we reparse only on change.
function readHistory() {
  if (!historyEnabled()) return EMPTY_HISTORY;
  const dirs = [];
  const own = listHistoryMonths(historyDir());
  if (own) dirs.push({ dir: historyDir(), files: own });
  const ld = legacyHistoryDir();
  const legacyFiles = ld ? listHistoryMonths(ld) : null;
  if (legacyFiles && legacyFiles.length) dirs.push({ dir: ld, files: legacyFiles });
  if (!dirs.length) return EMPTY_HISTORY;
  // The legacy merge below retires by the CONFIGURED custom names, so a
  // rename must invalidate the cache even though no month file changed.
  const customNames = dirs.length > 1 ? customSourceNames() : null;
  let sig = customNames ? Array.from(customNames).sort().join(',') + '#' : '';
  for (const { dir, files } of dirs) {
    sig += dir + '|';
    for (const f of files) {
      try { sig += f + ':' + fs.statSync(path.join(dir, f)).mtimeMs + ';'; } catch (_) {}
    }
  }
  if (historyCache.sig === sig && historyCache.data) return historyCache.data;
  const byDay = {}, sources = new Set(), models = new Set(), months = new Set(), estSources = new Set();
  dirs.forEach(({ dir, files }, i) => {
    for (const f of files) {
      const month = readHistoryMonth(path.join(dir, f));
      if (!month) continue;
      months.add(f.slice(0, 7));
      for (const ds of Object.keys(month)) {
        if (i === 0 || !byDay[ds]) { byDay[ds] = month[ds]; continue; }
        // Legacy day also present in the new archive: per-cell union, new
        // archive first (pickCell keeps `a` on an equal message count).
        const cells = indexCells(byDay[ds].rows);
        // The legacy archive is never healed by a re-seal, so the rename
        // retirement mergeDayRecord applies to the new home's file is applied
        // here: when the new archive's day carries custom cells under a
        // CONFIGURED name, a legacy custom cell under a name no longer
        // configured is that data's pre-rename identity — adding it would
        // count the day twice once its log lines roll off (the live-coverage
        // guard in buildPeriod/totals no longer fires then). A day with no
        // configured custom cells in the new archive keeps its legacy cells:
        // removing a source is not renaming it.
        const renamed = byDay[ds].rows.some((r) => r.c && customNames.has(r.source));
        for (const r of month[ds].rows) {
          const k = cellKey(r.source, r.model);
          if (renamed && r.c && !cells[k] && !customNames.has(r.source)) continue;
          cells[k] = pickCell(cells[k], r);
        }
        byDay[ds] = { rows: Object.values(cells), sessions: Math.max(byDay[ds].sessions, month[ds].sessions) };
      }
    }
  });
  for (const ds of Object.keys(byDay)) {
    for (const r of byDay[ds].rows) {
      sources.add(r.source);
      if (r.est) estSources.add(r.source);
      if (!HIDDEN_MODELS.has(r.model)) models.add(r.model);
    }
  }
  const data = { byDay, sources, models, months, estSources };
  historyCache = { sig, data };
  return data;
}

// Restrict an archive view to a set of sources (mirrors the dashboard's source
// filter). Session counts aren't source-split, so they carry over as-is.
function filterHistory(history, sourceSet) {
  const byDay = {}, sources = new Set(), models = new Set(), estSources = new Set();
  for (const ds of Object.keys(history.byDay)) {
    const rows = history.byDay[ds].rows.filter((r) => sourceSet.has(r.source));
    if (!rows.length) continue;
    byDay[ds] = { rows, sessions: history.byDay[ds].sessions };
    for (const r of rows) {
      sources.add(r.source);
      if (r.est) estSources.add(r.source);
      if (!HIDDEN_MODELS.has(r.model)) models.add(r.model);
    }
  }
  return { byDay, sources, models, months: history.months, estSources };
}

// Live logs for a single past day can SHRINK over time — ~/.claude and ~/.codex
// prune independently, and Claude prunes per session file by mtime — so a day
// can be partial in the logs while the archive still holds the pruned cells.
// Both the seal (mergeDayRecord) and the read (pickCell) therefore merge per
// (source,model) cell and keep the more-complete observation, so a re-seal
// never shrinks a day and reads never miss a pruned cell. Keys are in-memory
// only (never persisted — rows store source/model separately); a space
// separator is safe since source/model identifiers contain none.
const cellKey = (source, model) => source + ' ' + model;
function indexCells(rows) {
  const o = {};
  if (Array.isArray(rows)) for (const r of rows) {
    if (r && typeof r.source === 'string' && typeof r.model === 'string') o[cellKey(r.source, r.model)] = r;
  }
  return o;
}
// Pruning only ever removes messages, so the observation with MORE messages is
// the more complete one and wins. On an EQUAL count the two describe the same
// requests, and `a` — the LIVE (read paths) or freshly-sealed (mergeDayRecord)
// side at EVERY call site — wins: its cost was just computed from the current
// price table, while the archived copy carries whatever price was in force the
// day it was sealed. The old tie-break kept the DEARER row, so a price cut
// (Sonnet 5, the GPT-5.6 family) could never reach an already-sealed day and
// the non-shrinking re-seal made the stale figure permanent. A day whose live
// logs have already pruned keeps its sealed cost — the archive stores no token
// breakdown to re-price from.
// The est/c marks are facts about the cell's IDENTITY (estimated counts /
// custom source), not its completeness — never lose them to whichever
// observation happened to be fuller.
function pickCell(a, b) {
  if (!a) return b;
  if (!b) return a;
  const win = b.messages > a.messages ? b : a;
  if ((a.est || b.est) && !win.est) win.est = 1;
  if ((a.c || b.c) && !win.c) win.c = 1;
  return win;
}
// Non-shrinking union of an archived day and a freshly-sealed one: keep the
// more-complete observation of every cell, so a cell since pruned from the live
// logs is preserved rather than overwritten with the now-partial value.
function mergeDayRecord(existing, fresh, customNames) {
  if (!existing || !Array.isArray(existing.rows)) return fresh;
  const cells = indexCells(existing.rows);
  // Fresh first: pickCell's tie-break keeps argument `a`, so a re-seal at
  // today's prices overwrites a stale-priced archived row of the same size.
  for (const r of fresh.rows) { const k = cellKey(r.source, r.model); cells[k] = pickCell(r, cells[k]); }
  let rows = Object.values(cells);
  // A custom-flagged cell whose source is no longer configured is the
  // pre-rename identity of data the fresh seal carries under the new name —
  // retiring it here heals an already-poisoned month file. Only applied when
  // the fresh seal itself has custom rows (a rename, not a removal: a source
  // deleted from config seals no custom rows, and its history is preserved).
  if (customNames && fresh.rows.some((r) => r.c)) {
    rows = rows.filter((r) => !r.c || customNames.has(r.source));
  }
  return { rows, sessions: Math.max(+existing.sessions || 0, fresh.sessions || 0) };
}

// Fold live entries into per-(day,source,model) rollups for SEALED days only,
// then write the month files that changed. Gated so summary builds don't churn
// the disk; a still-present day is re-sealed (kept fresh) until it's pruned.
let lastSealAt = 0;
function sealHistory(entries) {
  if (!historyEnabled()) return;
  const now = Date.now();
  if (lastSealAt && now - lastSealAt < 5 * 60 * 1000) return; // at most every 5 min
  lastSealAt = now;
  const today = localDateStr(now);
  const byDay = {}, sessByDay = {};
  for (const e of entries) {
    const ds = localDateStr(e.ts);
    if (ds >= today) continue; // never seal today (still accumulating)
    const key = cellKey(e.source, e.model);
    const d = byDay[ds] || (byDay[ds] = Object.create(null));
    const cell = d[key] || (d[key] = { source: e.source, model: e.model, cost: 0, tokens: 0, messages: 0 });
    cell.cost += e.cost; cell.tokens += tokensOf(e); cell.messages++;
    // Persist identity marks: est so the badge survives archive-only retention,
    // c so the merge paths can retire renamed-away custom identities.
    if (e.estimate) cell.est = 1;
    if (e.provider === 'custom') cell.c = 1;
    if (e.sessionId) (sessByDay[ds] || (sessByDay[ds] = new Set())).add(e.sessionId);
  }
  const months = {};
  for (const ds of Object.keys(byDay)) {
    (months[ds.slice(0, 7)] || (months[ds.slice(0, 7)] = {}))[ds] = {
      rows: Object.values(byDay[ds]),
      sessions: sessByDay[ds] ? sessByDay[ds].size : 0,
    };
  }
  let wrote = false;
  for (const mk of Object.keys(months)) {
    const file = path.join(historyDir(), mk + '.json');
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) {}
    // Re-seal keeps the more-complete cell for each recomputed day (never
    // shrinks); days not recomputed (already pruned) are preserved untouched.
    const sealCustomNames = customSourceNames();
    const merged = { ...existing };
    for (const ds of Object.keys(months[mk])) merged[ds] = mergeDayRecord(existing[ds], months[mk][ds], sealCustomNames);
    const ordered = {};
    for (const k of Object.keys(merged).sort()) ordered[k] = merged[k];
    const next = JSON.stringify(ordered);
    let prev = null;
    try { prev = fs.readFileSync(file, 'utf8'); } catch (_) {}
    if (prev === next) continue;
    try {
      fs.mkdirSync(historyDir(), { recursive: true });
      // Atomic write: a crash mid-write must never truncate the file and lose
      // already-pruned days. Write a temp, then rename over the target.
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, next);
      fs.renameSync(tmp, file);
      wrote = true;
    } catch (err) { console.warn('[burnglass] history write failed: ' + err.message); }
  }
  if (wrote) historyCache = { sig: '', data: null }; // force reload on next read
}

// A compact view of the active price table, for the UI "estimates" note.
function buildPricingView(now) {
  const out = {};
  for (const model of Object.keys(PRICING)) {
    if (model === '__default__' || HIDDEN_MODELS.has(model)) continue;
    const p = priceFor(model, now);
    out[model] = { input: p.input, output: p.output };
  }
  return out;
}

// Resolve a human-readable session title, degrading gracefully:
//   desktop store title  ->  derived "<project> · <first prompt> · <short id>"
function sessionTitle(sessionId, sessionMeta, desktopTitles) {
  if (desktopTitles && desktopTitles[sessionId]) return desktopTitles[sessionId];
  const meta = sessionMeta[sessionId] || {};
  const proj = meta.project ? path.basename(meta.project) : '';
  let prompt = (meta.firstUserText || '').replace(/\s+/g, ' ').trim();
  if (prompt.length > 60) prompt = prompt.slice(0, 57) + '…';
  const shortId = sessionId ? sessionId.slice(0, 8) : '';
  const parts = [];
  if (proj) parts.push(proj);
  if (prompt) parts.push(prompt);
  if (shortId) parts.push(shortId);
  return parts.length ? parts.join(' · ') : (sessionId || 'session');
}

// §4 internal-consistency invariants. Logs warnings; returns a summary the UI
// can surface. Never throws.
function selfCheck(payload, asc, rawBlocks) {
  const issues = [];
  const EPS = 1e-6;

  // For each spend period, the daily buckets must sum to the period total.
  for (const p of payload.periods) {
    const dailySum = p.daily.reduce((a, b) => a + b.total, 0);
    if (Math.abs(dailySum - p.cost) > 1e-4) {
      issues.push(`period ${p.key}: daily sum ${dailySum.toFixed(6)} != total ${p.cost.toFixed(6)}`);
    }
  }

  // today ⊆ 7-day (cost & messages)
  if (payload.today.cost - payload.week.cost > EPS || payload.today.messages > payload.week.messages) {
    issues.push('today is not a subset of the 7-day window');
  }

  // every block's entries ⊆ Claude entries (blocks are Claude-only; Codex has
  // its own limit windows and is excluded from block reconstruction)
  const blockEntryCount = rawBlocks.reduce((a, b) => a + b.entries.length, 0);
  const claudeCount = asc.reduce((a, e) => a + (nonClaudeEntry(e) ? 0 : 1), 0);
  if (blockEntryCount !== claudeCount) {
    issues.push(`block entries (${blockEntryCount}) != claude entries (${claudeCount})`);
  }

  // no duplicate dedup keys remain
  const keys = new Set();
  let dups = 0;
  for (const e of asc) { if (keys.has(e.key)) dups++; else keys.add(e.key); }
  if (dups > 0) issues.push(`${dups} duplicate dedup key(s) survived`);

  if (issues.length) {
    for (const i of issues) console.warn('[burnglass] self-check: ' + i);
  }
  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// §3.5  SESSION TITLES from the desktop store (cross-platform, optional).
// Attempt to read sessionId->title. Absent store or unrecognized format => {}.
// Purely additive; never blocks or throws.
// ---------------------------------------------------------------------------

function desktopStoreDir() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Claude', 'claude-code-sessions');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  }
  return path.join(home, '.config', 'Claude', 'claude-code-sessions');
}

// Best-effort extraction of a sessionId->title map from an unknown-format store.
// We look for JSON files and pull common title-ish keys. READ-ONLY.
function readDesktopTitles() {
  const dir = desktopStoreDir();
  const map = {};
  let files;
  try {
    files = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return map; // no store (headless server) — expected
  }
  for (const ent of files) {
    if (!ent.isFile()) continue;
    const full = path.join(dir, ent.name);
    let text;
    try { text = fs.readFileSync(full, 'utf8'); } catch (_) { continue; }

    // Try whole-file JSON first, then line-delimited JSON.
    const candidates = [];
    try { candidates.push(JSON.parse(text)); }
    catch (_) {
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { candidates.push(JSON.parse(line)); } catch (_) {}
      }
    }
    for (const obj of candidates) collectTitles(obj, ent.name, map);
  }
  return map;
}

// Pull {sessionId -> title} out of an arbitrary parsed object. Handles a map
// keyed by session id, an array of records, or a single record.
function collectTitles(obj, fileName, map) {
  if (!obj || typeof obj !== 'object') return;

  const titleOf = (r) => (r && typeof r === 'object')
    ? (r.title || r.name || r.summary || r.displayName || null) : null;
  const idOf = (r, fallbackKey) => (r && typeof r === 'object')
    ? (r.sessionId || r.session_id || r.id || r.uuid || fallbackKey) : fallbackKey;

  if (Array.isArray(obj)) {
    for (const r of obj) {
      const id = idOf(r, null);
      const t = titleOf(r);
      if (id && t) map[id] = String(t);
    }
    return;
  }

  // A single record that looks like a session?
  const directTitle = titleOf(obj);
  const directId = obj.sessionId || obj.session_id || obj.id || obj.uuid ||
    (fileName.endsWith('.json') ? fileName.slice(0, -5) : null);
  if (directTitle && directId) {
    map[directId] = String(directTitle);
  }

  // Or a map keyed by session id -> record/string.
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string') {
      // heuristically only treat as title if key looks like a session id
      if (/^[0-9a-f-]{8,}$/i.test(k)) map[k] = v;
    } else if (v && typeof v === 'object') {
      const t = titleOf(v);
      if (t) map[k] = String(t);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP SERVER  (§6)
// ---------------------------------------------------------------------------

// sourceFilter: optional Set of source names — the dashboard's source filter.
// The WHOLE payload (blocks, burn, periods, sessions) reflects the filtered
// view, while allSources/allModels stay unfiltered so the filter UI can list
// every option and colors stay stable across filter changes.
// opts.background — true when a background consumer (status line, Discord)
// drives the build rather than the dashboard. Background builds only TRICKLE
// the account-meter refresh (see metersForPayload); the dashboard drives it at
// the normal cadence. This keeps Pulse from polling the shared, rate-limited
// usage endpoint every couple of minutes around the clock.
// Unfiltered payloads are shared this long. PULSE_SUMMARY_MEMO_MS is a test
// hook (0 disables) — timing-sensitive suites assert the METERS trickle
// discipline and must not race the memo window.
const _smm = parseInt(envv('SUMMARY_MEMO_MS') || '', 10);
const SUMMARY_MEMO_MS = isFinite(_smm) && _smm >= 0 ? _smm : 2500;
let summaryMemo = { at: 0, payload: null };
function buildSummary(sourceFilter, opts) {
  const background = !!(opts && opts.background);
  // Unfiltered builds share a short-lived memo: the dashboard poll (10s), the
  // Discord tick (15s), and the statusline feed (3s memo of its own) all want
  // the same payload, and with several consumers active the full aggregation
  // used to run back-to-back — pure allocation churn for identical output.
  // Busted by writeConfig() so a settings change is never masked.
  if (!sourceFilter && summaryMemo.payload && Date.now() - summaryMemo.at < SUMMARY_MEMO_MS) {
    return summaryMemo.payload;
  }
  const buildT0 = Date.now();
  const { entries, sessionMeta, ultracodeSessions, effortEvents, fileCount, codexFileCount, codexRateSnapshot, conv } = parseAll();
  const desktopTitles = readDesktopTitles();
  const now = Date.now();
  const history = readHistory();
  sealHistory(entries); // gated internally; archives sealed days to <home>/history
  let scoped = entries;
  let scopedHistory = history;
  let appliedFilter = null;
  if (sourceFilter && sourceFilter.size) {
    scoped = entries.filter((e) => sourceFilter.has(e.source));
    scopedHistory = filterHistory(history, sourceFilter);
    appliedFilter = Array.from(sourceFilter).sort();
  }
  const payload = aggregate(scoped, sessionMeta, desktopTitles, now,
    mergeModes(readModes(), effortEvents), ultracodeSessions, officialFiveHourBucket(), scopedHistory);
  if (appliedFilter) {
    // Recompute the all-time lists from UNFILTERED entries + archive: the filter
    // chips must keep showing every source (live or archived-only), and color
    // assignment must not reshuffle.
    const srcSet = new Set(history.sources), modelSet = new Set(history.models);
    for (const e of entries) {
      srcSet.add(e.source);
      if (!HIDDEN_MODELS.has(e.model)) modelSet.add(e.model);
    }
    payload.allSources = Array.from(srcSet).sort();
    payload.allModels = Array.from(modelSet).sort();
    // Plan value answers "is the subscription worth it" — an account-level
    // question. Recompute it from the unfiltered entries so hiding a source
    // can't make the plan look worse than it is.
    payload.planValue = computePlanValue(planPeriods(entries, history, now), now);
  }
  payload.sourceFilter = appliedFilter;
  // What the agent is doing right now (not source-scoped: it's live state).
  payload.agentState = computeAgentState(conv, now);
  // Surface what Pulse is actually reading, so a wrong-directory setup (e.g.
  // Claude Code under WSL while Pulse runs in native Windows) is diagnosable.
  payload.claudeDir = claudeDir();
  payload.fileCount = fileCount;
  payload.codexDir = codexDir();
  payload.codexFileCount = codexFileCount || 0;
  payload.hasCodex = (codexFileCount || 0) > 0;
  // Retention status: how many past days Pulse has archived beyond the logs.
  payload.history = { enabled: historyEnabled(), archivedDays: Object.keys(history.byDay).length };
  // Server panel: identity + update state.
  payload.version = PULSE_VERSION;
  payload.serverStartTs = SERVER_START;
  payload.pid = process.pid;
  payload.daemon = IS_DAEMON_CHILD;
  payload.packaged = !!seaApi;
  // Rename support (all additive): the product name, the REAL home folder
  // (the UI must never hard-code ~/.pulse or ~/.burnglass — a pinned or
  // degraded home differs), the running executable's own filename (a
  // self-updated v1 install is still called pulse.exe; null from source),
  // the one-time ~/.pulse → ~/.burnglass move, and the read-only Claude Code
  // settings.json check (status line / effort hook pointing at a deleted exe).
  payload.brand = BRAND;
  payload.home = appHome();
  payload.exeName = seaApi ? path.basename(process.execPath) : null;
  payload.homeMigration = homeMigration;
  // Public view only: the raw command line stays out of the payload (users
  // put env assignments in front of commands; nothing needs them here).
  try {
    payload.integrations = claudeIntegrations().map((i) => (
      { kind: i.kind, event: i.event, target: i.target, exists: i.exists, legacyName: i.legacyName }));
  } catch (_) { payload.integrations = []; }
  payload.update = updateState;
  // Community reach (public GitHub counters) — present only once fetched; the
  // fetch itself is scheduled alongside the update check and shares its opt-out.
  payload.reach = reachForPayload();
  payload.meters = metersForPayload(background);
  // Codex official meters come from rate_limits snapshots already present in
  // the local rollout logs — no opt-in needed, nothing leaves the machine.
  // Account-level, so computed from the unfiltered parse.
  payload.codexMeters = codexMetersFromSnapshot(codexRateSnapshot);
  // Codex account TOKEN totals (all devices) — opt-in, ChatGPT endpoint.
  payload.codexUsage = codexUsageForPayload(background);
  // Meshy 3D credits — opt-in, api.meshy.ai, API-key authenticated. CREDITS
  // ARE NOT DOLLARS: this block is deliberately self-contained and is never
  // folded into totals/periods/planValue/budget, because Meshy publishes no
  // credit→dollar rate. Account-level like the meters, so it is NOT rescoped
  // by ?sources= — it has no per-source detail to filter.
  payload.meshy = meshyForPayload(background);
  // Limit alerts: which windows are at/above a warning threshold right now.
  // Stateless — the dashboard de-dups notifications per reset cycle client-side.
  payload.alerts = computeAlerts(payload.meters, payload.codexMeters);
  // The configured thresholds themselves, so the dashboard's meter ticks and
  // warn/crit colouring use the same numbers the alerts fire on.
  payload.alertThresholds = alertThresholds();
  // Spend anomaly (opt-in) leads the list — a runaway day outranks a window
  // that is merely approaching its limit. Computed ONLY on the unfiltered
  // view: like the meter alerts it is an account-level signal, and a
  // source-filtered baseline would fire spurious "unusual spend"
  // notifications (and burn the once-per-day dedup) off a scope the wording
  // never mentions.
  if (!appliedFilter) {
    const anomaly = computeSpendAnomaly(payload.periods, Date.now());
    if (anomaly) payload.alerts.unshift(anomaly);
  }
  // Discord Rich Presence status (opt-in) — state only, no work done here.
  payload.discord = discordForPayload();
  // Windows tray state — the Server panel shows the toggle only where the
  // feature exists.
  payload.tray = { supported: process.platform === 'win32', enabled: trayDesired !== null ? trayDesired : readConfig().tray === true };
  payload.openusage = { supported: process.platform === 'win32', enabled: readConfig().openusage === true, path: findOpenUsage() };
  payload.strip = { supported: process.platform === 'win32', enabled: readConfig().strip === true, path: findPulseStrip() };
  // Run at startup: registry-backed (not config), memoized so this costs
  // nothing per build.
  payload.startup = startupForPayload();
  // Server-panel visibility into the process footprint (RSS + JS heap).
  try {
    const mu = process.memoryUsage();
    payload.memory = { rss: mu.rss, heapUsed: mu.heapUsed };
  } catch (_) { /* never let a stats call break the payload */ }
  // Stamped BEFORE the memo store so memo hits carry the timing of the build
  // they actually serve — request handlers must never mutate a shared payload.
  payload.buildMs = Date.now() - buildT0;
  if (!sourceFilter) summaryMemo = { at: Date.now(), payload };
  return payload;
}

// ---------------------------------------------------------------------------
// LIMIT ALERTS
// Flag any usage window (Claude 5h/weekly/model-scoped, Codex session/weekly)
// that has crossed a warning threshold, so the dashboard can warn you before
// you hit a cap. Thresholds are configurable; on by default (disable with
// {"alerts": false}). This is purely a projection of the meters Pulse already
// has — account meters are account-wide, so alerts cover EVERY surface
// (Claude Code, claude.ai, Cowork, other devices), not just this machine.
// ---------------------------------------------------------------------------
function alertsEnabled() { return readConfig().alerts !== false; }
function alertThresholds() {
  const c = readConfig().alertThresholds;
  const list = Array.isArray(c) ? c.filter((n) => typeof n === 'number' && n > 0 && n <= 100) : [];
  return (list.length ? list : [80, 95]).slice().sort((a, b) => a - b);
}
function computeAlerts(meters, codexMeters) {
  if (!alertsEnabled()) return [];
  const thresholds = alertThresholds();
  const lowest = thresholds[0];
  const out = [];
  const consider = (b, provider) => {
    if (!b || typeof b.pct !== 'number' || b.stale) return;
    // A window that's already maxed out isn't one you're *approaching* — you've
    // hit it. Drop it from the warning banner (and its notifications) so a
    // reached limit doesn't sit stacked next to genuinely-approaching windows.
    // Keyed off the rounded pct so it matches the number the UI shows.
    if (Math.round(b.pct) >= 100) return;
    if (b.pct < lowest) return;
    // Highest threshold this window has reached.
    let hit = null;
    for (const t of thresholds) if (b.pct >= t) hit = t;
    if (hit == null) return;
    out.push({ key: (provider === 'codex' ? 'codex:' : 'claude:') + b.key, label: b.label, pct: b.pct, threshold: hit, resetsAt: b.resetsAt || null, provider });
  };
  if (meters && meters.enabled && Array.isArray(meters.buckets)) for (const b of meters.buckets) consider(b, 'claude');
  if (codexMeters && Array.isArray(codexMeters.buckets)) for (const b of codexMeters.buckets) consider(b, 'codex');
  // Most urgent first.
  out.sort((a, b) => b.pct - a.pct);
  return out;
}

// ---------------------------------------------------------------------------
// SPEND-ANOMALY ALERT (opt-in) — flags a day whose spend is far above the
// user's own recent baseline (a runaway loop, an accidental ultracode
// marathon). Baseline = mean of ACTIVE days (spend > 0) in the trailing-30d
// window, excluding today — quiet weekends must not drag the average down and
// cause false alarms. Requires a real history and real money before it will
// ever fire; off unless {"anomalyAlerts": true} ({"anomalyMultiplier": N}
// tunes the trigger ratio, default 3, floor 1.5). Rides the master `alerts`
// switch and the same banner/notification plumbing as the limit alerts.
// ---------------------------------------------------------------------------
const ANOMALY_MIN_ACTIVE_DAYS = 5; // baseline needs at least this many active days
const ANOMALY_MIN_TODAY_USD = 5;   // never flag pocket change
function anomalyConfig() {
  const c = readConfig();
  // Coerce (a hand-edited "25" means 25) then CLAMP to the 1.5 floor — a user
  // asking for 1.2 gets the most sensitive supported setting, not a silent
  // reset to the default. Only non-numeric/absent falls back to 3.
  const n = Number(c.anomalyMultiplier);
  const m = isFinite(n) && n > 0 ? Math.max(1.5, n) : 3;
  return { enabled: c.anomalyAlerts === true, multiplier: m };
}
function computeSpendAnomaly(periods, now) {
  const { enabled, multiplier } = anomalyConfig();
  if (!enabled || !alertsEnabled()) return null;
  const p = (periods || []).find((x) => x.key === 'last30');
  if (!p || !Array.isArray(p.daily)) return null;
  const todayStr = localDateStr(now);
  let today = 0;
  const prior = [];
  for (const d of p.daily) {
    if (d.date === todayStr) today = d.total;
    else if (d.date < todayStr && d.total > 0) prior.push(d.total);
  }
  if (prior.length < ANOMALY_MIN_ACTIVE_DAYS || today < ANOMALY_MIN_TODAY_USD) return null;
  const baseline = prior.reduce((a, b) => a + b, 0) / prior.length;
  if (!(baseline > 0) || today < baseline * multiplier) return null;
  const ratio = today / baseline;
  return {
    // Date in the key → the client's notification dedup fires once per day.
    key: 'pulse:anomaly:' + todayStr,
    kind: 'anomaly',
    provider: 'pulse',
    label: "Today's spend",
    detail: 'today $' + today.toFixed(2) + ' — ' + ratio.toFixed(1) + '× your recent daily average ($' + baseline.toFixed(2) + ')',
    ratio, todayCost: today, baseline,
    threshold: multiplier,
    pct: null,
    resetsAt: null,
  };
}

// ---------------------------------------------------------------------------
// BUDGET GOAL — an optional self-set spend target (`budget` USD +
// `budgetPeriod` month|week in ~/.burnglass/config.json, set via the dashboard).
// Reports progress against the CURRENT period's spend across all sources.
// month = current calendar month (resets on the 1st); week = trailing 7 days
// (payload.week, rolling — no hard reset). Returns null when unset.
// ---------------------------------------------------------------------------
function budgetConfig() {
  const c = readConfig();
  const target = typeof c.budget === 'number' && isFinite(c.budget) && c.budget > 0 ? c.budget : null;
  const period = c.budgetPeriod === 'week' ? 'week' : 'month';
  return { target, period };
}
function computeBudget(periods, week, now) {
  const { target, period } = budgetConfig();
  if (!target) return null;
  let spent = 0, resetsAt = null, label, projected = null;
  if (period === 'week') {
    spent = (week && week.cost) || 0; // trailing 7 days
    label = 'last 7 days';
    // No projection for the rolling week: a trailing window has no fixed end
    // to project to (its "pace" IS its spend), so `projected` stays null.
  } else {
    const mk = localDateStr(now).slice(0, 7);
    const p = (periods || []).find((x) => x.key === mk);
    spent = p ? p.cost : 0;
    const d = new Date(now);
    const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    resetsAt = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(); // start of next month
    label = 'this month';
    // Straight-line month-end projection: spent scaled by the fraction of the
    // month elapsed. Suppressed for the first ~half day of a month, where the
    // tiny denominator would turn one morning session into an absurd figure.
    const elapsed = (now - monthStart) / (resetsAt - monthStart);
    if (elapsed > 0.017) projected = spent / elapsed;
  }
  const pct = (spent / target) * 100;
  const state = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok';
  return { target, period, label, spent, pct, remaining: Math.max(0, target - spent), resetsAt, state, projected };
}

// ---------------------------------------------------------------------------
// PLAN VALUE — "is the subscription paying for itself?". `planCost` (USD/month
// the user actually pays) + optional `planLabel` in ~/.burnglass/config.json, set
// via /api/plan/set. Compares that outlay against the API list-price value of
// the usage Pulse observed. Always present in the payload (configured:false
// when unset) so the UI can offer the setup card without a second shape.
// ---------------------------------------------------------------------------
// C0 + C1 control characters. The plan label is user text that ends up printed
// to a terminal by --summary and appended to ~/.burnglass/burnglass.log, where an ESC
// byte is an executable ANSI command rather than a character — strip on the way
// in (the route) AND on the way out (rendering), so a label stored by an older
// version can't still hijack the terminal.
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;
const stripControl = (s) => String(s).replace(CONTROL_CHARS, '');
// Plausible range for a monthly subscription. Guards against denormals at the
// bottom (Infinity multipliers) and nonsense at the top.
const PLAN_COST_MIN = 0.01, PLAN_COST_MAX = 1e6;
function planConfig() {
  const c = readConfig();
  const cost = typeof c.planCost === 'number' && isFinite(c.planCost) && c.planCost > 0 ? c.planCost : null;
  const label = cost && typeof c.planLabel === 'string' && c.planLabel ? c.planLabel : null;
  return { cost, label };
}
const PLAN_MONTHS = 6;
// periods must be the SAME period objects the dashboard shows (live + archive
// already merged per cell) — the multiplier has to agree with the spend figures
// on screen, and archive-backed months must count.
function computePlanValue(periods, now) {
  const { cost, label } = planConfig();
  const list = periods || [];
  const last30 = list.find((p) => p.key === 'last30');
  const spend30 = last30 ? last30.cost : 0;
  // The CURRENT calendar month is only partly spent, but it is divided by a
  // FULL month of plan cost — so on the 2nd of the month a perfectly healthy
  // month reads as "the plan isn't paying for itself". Flag it (and say how far
  // through the month we are) so the UI can render it as in-progress instead of
  // as a failure. Same local-time elapsed fraction computeBudget projects with.
  const nowMs = now == null ? Date.now() : now;
  const d = new Date(nowMs);
  const curKey = localDateStr(nowMs).slice(0, 7);
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  const elapsedFraction = Math.min(1, Math.max(0, (nowMs - monthStart) / (monthEnd - monthStart)));
  const months = list
    .filter((p) => /^\d{4}-\d{2}$/.test(p.key))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) // periods are newest-first; the chart wants oldest-first
    .slice(-PLAN_MONTHS)
    .map((p) => {
      const m = { key: p.key, spend: p.cost, multiplier: cost ? p.cost / cost : null };
      if (p.key === curKey) { m.partial = true; m.elapsedFraction = elapsedFraction; }
      return m;
    });
  return {
    configured: !!cost,
    cost,
    label,
    spend30,
    multiplier: cost ? spend30 / cost : null,
    months,
  };
}

// ---------------------------------------------------------------------------
// CSV EXPORT (GET /api/export) — serializes aggregations the dashboard already
// computes; no data is computed here, so an export always matches the screen.
// Hand-rolled CSV: RFC-4180 quoting, CRLF rows, cost rounded to 4 decimals so
// spreadsheets don't inherit float noise.
// ---------------------------------------------------------------------------
function csvCell(v) {
  let s = v == null ? '' : String(v);
  // Formula-injection defusal (OWASP): a TEXT cell starting with = + - @ would
  // execute as a formula when the CSV is opened in Excel/Sheets — prefix it
  // with a quote. Only strings: numeric cells (costs, tokens) must stay
  // numeric, and a number can legitimately start with "-".
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvTable(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
const csvMoney = (n) => Number((n || 0).toFixed(4));
function exportCsv(payload, period, data) {
  if (data === 'daily') {
    const srcs = period.sources || [];
    const rows = [['date', 'cost_usd', 'tokens', ...srcs.map((s) => 'cost_' + s)]];
    for (const d of period.daily || []) {
      rows.push([d.date, csvMoney(d.total), d.tokens, ...srcs.map((s) => csvMoney(d.bySource[s]))]);
    }
    return csvTable(rows);
  }
  if (data === 'models' || data === 'sources') {
    const map = (data === 'models' ? period.byModel : period.bySource) || {};
    const keys = Object.keys(map).sort((a, b) => map[b].cost - map[a].cost);
    const rows = [[data === 'models' ? 'model' : 'source', 'cost_usd', 'tokens', 'messages']];
    for (const k of keys) rows.push([k, csvMoney(map[k].cost), map[k].tokens, map[k].messages]);
    return csvTable(rows);
  }
  if (data === 'projects') {
    const rows = [['project', 'cost_usd', 'tokens', 'messages', 'sessions']];
    for (const p of period.byProject || []) rows.push([p.project, csvMoney(p.cost), p.tokens, p.messages, p.sessions]);
    return csvTable(rows);
  }
  if (data === 'sessions') {
    // Whole-session totals (the Recent-sessions table) — not period-scoped.
    const rows = [['title', 'source', 'models', 'effort', 'cost_usd', 'tokens', 'messages', 'last_activity']];
    for (const s of payload.recentSessions || []) {
      rows.push([s.title, s.source, (s.models || []).join('|'),
        (s.ultracode ? ['ultracode'] : []).concat(s.efforts || []).join('|'),
        csvMoney(s.cost), s.tokens, s.messages, new Date(s.lastTs).toISOString()]);
    }
    return csvTable(rows);
  }
  return null;
}

// ---------------------------------------------------------------------------
// SINGLE-EXECUTABLE (SEA) SUPPORT
// When packaged as pulse.exe / pulse-linux (see build/make-exe.mjs), the
// frontend is embedded as SEA assets keyed "web/dist/<relpath>" and read via
// node:sea instead of the filesystem. In a normal checkout seaApi is null and
// everything reads from disk as before.
// ---------------------------------------------------------------------------
let seaApi = null;
try {
  const sea = require('node:sea');
  if (sea.isSea && sea.isSea()) seaApi = sea;
} catch (_) { /* Node 18 has no node:sea — repo mode only */ }

function seaAsset(key) {
  if (!seaApi) return null;
  try { return Buffer.from(seaApi.getRawAsset(key)); } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// UPDATES
// Burnglass's only DEFAULT-ON network calls (the opt-in ones — account
// meters, Codex usage, Meshy — live in their own sections; see CLAUDE.md),
// and only when enabled (default on; --no-update-check /
// BURNGLASS_NO_UPDATE_CHECK (PULSE_NO_UPDATE_CHECK) / {"updateCheck":false}
// in <home>/config.json disable it):
//   - check: GET the GitHub Releases API for the latest version tag
//   - install (packaged builds, user-clicked): download the platform asset,
//     verify its sha256 digest from the API, swap executables via rename
//     (a running exe can be renamed, just not deleted), relaunch, exit.
// Any failure leaves the current install untouched and points at the
// releases page instead. No usage data is ever transmitted.
//
// REPO RENAMES: the repo was claudeusage → Pulse-Usage-Monitor → Burnglass.
// GitHub 301-redirects every old name (API and web) as long as nobody
// re-creates a repo under an old name — NEVER reuse `claudeusage` or
// `Pulse-Usage-Monitor` under ReFxFrank, or every v1.x updater (which still
// calls the old slug) loses its update path. fetchUrl follows the 301.
// ---------------------------------------------------------------------------
const UPDATE_REPO = 'ReFxFrank/Burnglass';
const RELEASES_PAGE = 'https://github.com/' + UPDATE_REPO + '/releases';
const UPDATE_API_URL = envv('UPDATE_API') ||
  'https://api.github.com/repos/' + UPDATE_REPO + '/releases/latest';

const updateState = {
  status: 'idle', // idle | checking | uptodate | available | downloading | installing | error
  current: PULSE_VERSION,
  latest: null,
  error: null,
  checkedAt: null,
  installSupported: false, // packaged build with a downloadable asset
  releasesUrl: RELEASES_PAGE,
  assetName: null, // which release asset this build would install
};
let updateAsset = null; // { url, digest, size, name } for this platform

// Comparable number for a version tag. A pre-release ("2.0.0-rc.1") ranks
// BELOW its release ("2.0.0"), so an RC tester is still offered the final
// build (v1's parser read "0-rc" as 0 and treated the two as equal). Build
// metadata ("+sha") is ignored. Within one base version: alpha < beta < rc,
// each ordered by its trailing number.
function versionNum(v) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(v || '').trim());
  if (!m) {
    const p = String(v || '').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
    return ((p[0] || 0) * 1e6 + (p[1] || 0) * 1e3 + (p[2] || 0)) * 1000 + 999;
  }
  const base = (+m[1] || 0) * 1e6 + (+m[2] || 0) * 1e3 + (+m[3] || 0);
  if (!m[4]) return base * 1000 + 999;
  const pre = m[4].toLowerCase().slice(0, 64);
  const kind = /^rc/.test(pre) ? 600 : /^beta/.test(pre) ? 300 : 0;
  const n = /(\d+)(?!.*\d)/.exec(pre);
  return base * 1000 + kind + Math.min(299, n ? parseInt(n[1], 10) : 0);
}

// Minimal GET with redirect-following (release assets 302 to a CDN). http is
// accepted only for the PULSE_UPDATE_API test override; production URLs are
// https.
function fetchUrl(u, opts, cb) {
  cb = once(cb); // error + end / timeout can otherwise both fire it
  const { asStream = false, timeoutMs = 20000, redirects = 5, headers = null } = opts || {};
  let mod;
  try { mod = u.startsWith('https:') ? require('https') : http; } catch (e) { return cb(e); }
  // mod.get can throw SYNCHRONOUSLY (bad URL, header values with invalid
  // characters → ERR_INVALID_CHAR). Route that to the callback like any other
  // fetch error — a corrupt credentials file must never 500 the caller or
  // strand its in-flight flag.
  let req;
  try {
  req = mod.get(u, {
    headers: {
      'User-Agent': 'burnglass/' + PULSE_VERSION,
      'Accept': 'application/vnd.github+json, application/octet-stream, */*',
      ...(headers || {}),
    },
    timeout: timeoutMs,
  }, (res) => {
    const sc = res.statusCode || 0;
    if (sc >= 300 && sc < 400 && res.headers.location && redirects > 0) {
      res.resume();
      let next;
      try { next = new URL(res.headers.location, u).toString(); } catch (e) { return cb(e); }
      return fetchUrl(next, { asStream, timeoutMs, redirects: redirects - 1 }, cb);
    }
    if (sc !== 200) {
      res.resume();
      const e = new Error('HTTP ' + sc);
      e.status = sc;
      if (res.headers && res.headers['retry-after']) e.retryAfter = res.headers['retry-after'];
      return cb(e);
    }
    if (asStream) return cb(null, res);
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { body += d; if (body.length > 4e6) req.destroy(new Error('response too large')); });
    res.on('end', () => cb(null, body));
    res.on('error', (e) => cb(e));
  });
  } catch (e) { return cb(e); }
  req.on('timeout', () => req.destroy(new Error('timed out')));
  req.on('error', (e) => cb(e));
}

// Release asset names. v2 publishes burnglass-* AND byte-identical legacy
// pulse-* copies (v1.x updaters match those exact names). The updater picks
// the asset matching its OWN filename first, so a self-updated pulse.exe keeps
// pulling pulse.exe; then the new name, then the legacy one — robust to a
// release that is missing either spelling. BURNGLASS_SELF_EXE_NAME is a test
// hook (the suites run under plain `node`).
function platformAssetNames() {
  const names = process.platform === 'win32' ? ['burnglass.exe', 'pulse.exe']
    : process.platform === 'darwin' ? ['burnglass-macos', 'pulse-macos']
      : ['burnglass-linux', 'pulse-linux'];
  const me = String(envv('SELF_EXE_NAME') || path.basename(process.execPath)).toLowerCase();
  const own = names.find((n) => n === me);
  return own ? [own, ...names.filter((n) => n !== own)] : names;
}

function checkForUpdate(done) {
  if (['checking', 'downloading', 'installing'].includes(updateState.status)) {
    return done && done(updateState);
  }
  updateState.status = 'checking';
  updateState.error = null;
  fetchUrl(UPDATE_API_URL, {}, (err, body) => {
    updateState.checkedAt = Date.now();
    if (err) {
      updateState.status = 'error';
      updateState.error = 'update check failed: ' + err.message;
      console.warn('[burnglass] ' + updateState.error);
      return done && done(updateState);
    }
    let rel = null;
    try { rel = JSON.parse(body); } catch (_) {}
    const tag = rel && (rel.tag_name || rel.name);
    if (!tag) {
      updateState.status = 'error';
      updateState.error = 'update check failed: unexpected API response';
      return done && done(updateState);
    }
    updateState.latest = String(tag).replace(/^v/i, '');
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    const a = platformAssetNames().map((n) => assets.find((x) => x && x.name === n)).find(Boolean);
    updateAsset = a ? {
      url: a.browser_download_url || a.url,
      digest: typeof a.digest === 'string' ? a.digest.replace(/^sha256:/, '') : null,
      size: a.size || 0,
      name: a.name,
    } : null;
    updateState.assetName = updateAsset ? updateAsset.name : null;
    if (versionNum(updateState.latest) > versionNum(PULSE_VERSION)) {
      updateState.status = 'available';
      // One-click install requires a verifiable download: no published sha256
      // digest → the UI offers the releases page instead (fail closed).
      updateState.installSupported = !!(seaApi && updateAsset && updateAsset.url && updateAsset.digest);
      console.log(`[burnglass] update available: v${updateState.latest} (running v${PULSE_VERSION}) — ${RELEASES_PAGE}`);
    } else {
      updateState.status = 'uptodate';
      console.log(`[burnglass] up to date (v${PULSE_VERSION})`);
    }
    done && done(updateState);
  });
}

function installUpdate(done) {
  done = once(done);
  if (updateState.status !== 'available') return done(new Error('no update staged — run a check first'));
  if (!seaApi) return done(new Error('running from source — update with git pull'));
  if (!updateAsset || !updateAsset.url) return done(new Error('no downloadable asset for this platform'));
  // Integrity is not optional: without a published digest there is nothing to
  // verify the download against, so refuse and point at the releases page.
  if (!updateAsset.digest) return done(new Error('release asset has no sha256 digest — download manually: ' + RELEASES_PAGE));

  const exePath = process.execPath;
  const downloadPath = exePath + '.download';
  const oldPath = exePath + '.old';
  updateState.status = 'downloading';
  updateState.error = null;
  console.log(`[burnglass] downloading v${updateState.latest} (${updateAsset.name})…`);

  fetchUrl(updateAsset.url, { asStream: true, timeoutMs: 300000 }, (err, res) => {
    if (err) return failInstall('download failed: ' + err.message, done);
    let out;
    try { out = fs.createWriteStream(downloadPath); } catch (e) {
      return failInstall('cannot write next to the exe: ' + e.message, done);
    }
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    res.on('data', (d) => { hash.update(d); bytes += d.length; });
    res.on('error', (e) => { try { out.destroy(); } catch (_) {} failInstall('download failed: ' + e.message, done); });
    out.on('error', (e) => failInstall('write failed: ' + e.message, done));
    res.pipe(out);
    out.on('finish', () => {
      try {
        const digest = hash.digest('hex');
        if (bytes < 5 * 1024 * 1024) return failInstall(`download too small (${bytes} bytes)`, done);
        if (updateAsset.size > 0 && bytes !== updateAsset.size) {
          return failInstall(`size mismatch (got ${bytes}, expected ${updateAsset.size})`, done);
        }
        if (digest !== updateAsset.digest) { // digest presence enforced above
          return failInstall('sha256 mismatch — refusing to install', done);
        }
        updateState.status = 'installing';
        console.log(`[burnglass] verified download (${(bytes / 1048576).toFixed(1)} MB, sha256 ok) — swapping executables`);
        try { fs.unlinkSync(oldPath); } catch (_) {}
        fs.renameSync(exePath, oldPath);
        try {
          fs.renameSync(downloadPath, exePath);
        } catch (e) {
          try { fs.renameSync(oldPath, exePath); } catch (_) {} // roll back
          throw e;
        }
        if (process.platform !== 'win32') { try { fs.chmodSync(exePath, 0o755); } catch (_) {} }
        refreshCompatTwins(exePath);
        done && done(null); // answer the HTTP request before the process exits
        if (envv('UPDATE_NO_RELAUNCH')) {
          console.log('[burnglass] UPDATE_NO_RELAUNCH set — staying on the old process');
          return;
        }
        relaunchAfterUpdate(exePath);
      } catch (e) {
        try { fs.unlinkSync(downloadPath); } catch (_) {}
        failInstall('swap failed: ' + ((e && e.message) || e), done);
      }
    });
  });
}

// An installer-upgraded folder holds burnglass.exe AND a compat pulse.exe
// twin (Claude Code hooks, pinned taskbar items and old Run values point at
// the old name). After a verified swap, refresh the twin from the new bytes
// the same rename-aside way — a running `--statusline` copy can be renamed,
// not overwritten. Never fatal: a stale twin still works (/api changes are
// additive) and the next update retries it.
function compatTwins(exePath) {
  if (process.platform !== 'win32') return [];
  const dir = path.dirname(exePath), me = path.basename(exePath).toLowerCase();
  return ['burnglass.exe', 'pulse.exe'].filter((n) => n !== me)
    .map((n) => path.join(dir, n)).filter(isFileAt);
}
function refreshCompatTwins(exePath) {
  for (const twin of compatTwins(exePath)) {
    try {
      fs.copyFileSync(exePath, twin + '.download');
      try { fs.unlinkSync(twin + '.old'); } catch (_) {}
      fs.renameSync(twin, twin + '.old');
      try { fs.renameSync(twin + '.download', twin); } catch (e) {
        try { fs.renameSync(twin + '.old', twin); } catch (_) {}
        throw e;
      }
      console.log('[burnglass] refreshed ' + path.basename(twin) + ' (same folder, same version)');
    } catch (e) {
      try { fs.unlinkSync(twin + '.download'); } catch (_) {}
      console.warn('[burnglass] could not refresh ' + path.basename(twin) + ': ' + ((e && e.message) || e));
    }
  }
}

function failInstall(msg, done) {
  updateState.status = 'error';
  updateState.error = msg + ' — download manually: ' + RELEASES_PAGE;
  console.error('[burnglass] ' + updateState.error);
  try { fs.unlinkSync(process.execPath + '.download'); } catch (_) {}
  done && done(new Error(msg));
}

function relaunchAfterUpdate(exePath) {
  const passthrough = process.argv.slice(2).filter((a) => a !== '--after-update');
  // Respect an explicit console run: --no-daemon relaunches into a fresh
  // visible console window instead of silently going hidden.
  const wantConsole = passthrough.includes('--no-daemon');
  if (process.platform === 'win32' && !wantConsole && !passthrough.includes('--daemon-child')) {
    passthrough.push('--daemon-child');
  }
  console.log(`[burnglass] restarting as v${updateState.latest}…`);
  if (wantConsole && process.platform === 'win32') {
    console.log('[burnglass] (Burnglass reopens in a new console window)');
  }
  const relaunchFailed = (e) => {
    updateState.status = 'error';
    updateState.error = 'relaunch failed: ' + ((e && e.message) || e) +
      ` — the new version is installed at ${exePath}; start it manually.`;
    console.error('[burnglass] ' + updateState.error);
  };
  setTimeout(() => {
    let child;
    try {
      child = require('child_process').spawn(exePath, [...passthrough, '--after-update'],
        { detached: true, stdio: 'ignore', windowsHide: !wantConsole });
      child.unref();
    } catch (e) {
      relaunchFailed(e); // keep serving on the old process instead of dying
      return;
    }
    let failed = false;
    child.once('error', (e) => { failed = true; relaunchFailed(e); });
    // Exit only if the spawn didn't error out (ENOENT etc. fire quickly).
    setTimeout(() => { if (!failed) process.exit(0); }, 700);
  }, 300);
}

// After an update the previous exe sits renamed aside — remove it once it is
// no longer locked (called at startup; failures are retried on the next run).
function cleanupOldExecutable() {
  if (!seaApi) return;
  const oldPath = process.execPath + '.old';
  try {
    if (fs.existsSync(oldPath)) {
      fs.unlinkSync(oldPath);
      console.log('[burnglass] removed previous version (' + path.basename(oldPath) + ')');
    }
  } catch (_) { /* still locked — next start */ }
  // A crash mid-download can strand a partial .download file too.
  try {
    const dl = process.execPath + '.download';
    if (fs.existsSync(dl)) fs.unlinkSync(dl);
  } catch (_) { /* next start */ }
  // …and the compat twin's aside copies (see refreshCompatTwins).
  for (const twin of compatTwins(process.execPath)) {
    for (const ext of ['.old', '.download']) {
      try { if (fs.existsSync(twin + ext)) fs.unlinkSync(twin + ext); } catch (_) { /* still locked */ }
    }
  }
}

// ---------------------------------------------------------------------------
// COMMUNITY REACH — how many people use Pulse, from PUBLIC GitHub data only.
// A live "who's online" counter would mean every install phoning home; Pulse
// promises the opposite ("usage data never leaves the machine"). So instead we
// read two PUBLIC, already-there numbers off the same GitHub API the update
// check uses: total release-asset download_count (the best proxy for "people
// using Pulse") and the repo star count. NOTHING about the user is sent — it's
// an outbound GET for public counters, gated by the SAME opt-out as the update
// check (--no-update-check / {"updateCheck":false}). Cached for hours so it
// never approaches GitHub's unauthenticated rate limit.
// ---------------------------------------------------------------------------
const REACH_RELEASES_API = envv('REACH_API') ||
  'https://api.github.com/repos/' + UPDATE_REPO + '/releases?per_page=100';
const REACH_REPO_API = envv('REACH_REPO_API') ||
  'https://api.github.com/repos/' + UPDATE_REPO;
const REACH_CACHE_MS = Number(envv('REACH_CACHE_MS')) || 6 * 3600 * 1000;
const reachState = { downloads: null, stars: null, fetchedAt: 0, status: 'idle' };
let reachInFlight = false;

// Fetch the public counters. Downloads (sum over every release's assets) and
// stars come from two GETs; each independently retains its last-good value on
// error, exactly like the account meters, so a rate-limit blip never blanks the
// badge. Cheap and self-throttled via REACH_CACHE_MS.
function refreshReach(done) {
  if (reachInFlight) return done && done(reachState);
  if (reachState.fetchedAt && Date.now() - reachState.fetchedAt < REACH_CACHE_MS) {
    return done && done(reachState);
  }
  reachInFlight = true;
  fetchUrl(REACH_RELEASES_API, {}, (err, body) => {
    let downloads = null;
    if (!err) {
      try {
        const rels = JSON.parse(body);
        if (Array.isArray(rels)) {
          downloads = 0;
          for (const r of rels) for (const a of (Array.isArray(r.assets) ? r.assets : [])) {
            downloads += num(a.download_count);
          }
        }
      } catch (_) { /* leave null → keep last-good */ }
    }
    fetchUrl(REACH_REPO_API, {}, (err2, body2) => {
      let stars = null;
      if (!err2) {
        try {
          const repo = JSON.parse(body2);
          if (repo && typeof repo.stargazers_count === 'number') stars = repo.stargazers_count;
        } catch (_) { /* leave null → keep last-good */ }
      }
      reachInFlight = false;
      reachState.fetchedAt = Date.now();
      if (downloads != null) reachState.downloads = downloads;
      if (stars != null) reachState.stars = stars;
      reachState.status = (reachState.downloads != null || reachState.stars != null) ? 'ok' : 'error';
      if (downloads != null || stars != null) {
        console.log(`[burnglass] community reach: ${reachState.downloads != null ? reachState.downloads : '?'} downloads, ${reachState.stars != null ? reachState.stars : '?'} stars`);
      }
      done && done(reachState);
    });
  });
}

// Payload view: expose the counters only once at least one has been fetched
// (so a disabled/never-fetched reach simply omits the badge).
function reachForPayload() {
  if (reachState.downloads == null && reachState.stars == null) return null;
  return {
    downloads: reachState.downloads,
    stars: reachState.stars,
    fetchedAt: reachState.fetchedAt,
    repo: UPDATE_REPO,
  };
}

// ---------------------------------------------------------------------------
// ACCOUNT METERS (opt-in) — Anthropic's OFFICIAL usage gauges.
// Claude Pro/Max limits are unified: claude.ai chats, Claude Code, cloud
// sessions and other machines all drain the same 5-hour and weekly windows.
// The same endpoint Claude Code's /usage command reads —
// GET api.anthropic.com/api/oauth/usage — reports that account-wide
// utilization with TRUE reset times, covering usage no local log ever sees.
//
// Privacy contract (documented in README, enforced here):
//   - OFF by default; enabled only via the dashboard toggle
//     ({"accountMeters": true} in ~/.burnglass/config.json).
//   - The OAuth token is read from ~/.claude/.credentials.json READ-ONLY,
//     never logged, never included in any payload, and sent ONLY to the
//     meters endpoint. Pulse never refreshes tokens (that would mean writing
//     credentials): an expired login shows "open Claude Code to re-login".
//   - PULSE_METERS_API overrides the endpoint for tests (mock server).
// The endpoint is internal/undocumented — parse defensively, degrade quietly.
// ---------------------------------------------------------------------------
const METERS_API_URL = envv('METERS_API') || 'https://api.anthropic.com/api/oauth/usage';
// Base cadence 120s; 429s back off (Retry-After honored, else 10m doubling to
// 1h) and other errors wait 5m — the endpoint is shared with Claude Code
// itself, so Pulse must be a polite citizen. Env override is a test hook.
const METERS_OK_MS = parseInt(envv('METERS_CACHE_MS'), 10) || 120 * 1000;
const METERS_ERR_MS = Math.min(METERS_OK_MS * 2, 5 * 60 * 1000);
const METERS_429_BASE_MS = Math.min(METERS_OK_MS * 5, 10 * 60 * 1000);
const METERS_429_MAX_MS = 60 * 60 * 1000;

const metersState = {
  status: 'off',   // off | ok | no-login | expired | error | rate-limited
  buckets: [],     // [{ key, label, pct, resetsAt }] — kept through errors
  fetchedAt: null,
  lastGoodAt: null,
  nextAttemptAt: 0,
  error: null,
};
let metersInFlight = false;
let meters429Streak = 0;

function metersEnabled() {
  return readConfig().accountMeters === true;
}

// Parse a credentials JSON blob (file or Keychain item — same shape) into
// { token, expiresAt } or null. NEVER log or transmit the token anywhere
// except the meters endpoint.
function parseCredentials(raw) {
  try {
    const j = JSON.parse(String(raw).trim());
    const o = (j && j.claudeAiOauth) || j || {};
    const token = o.accessToken;
    if (typeof token !== 'string' || !token) return null;
    let expiresAt = typeof o.expiresAt === 'number' && isFinite(o.expiresAt) ? o.expiresAt : null;
    if (expiresAt && expiresAt < 1e12) expiresAt *= 1000; // tolerate seconds-unit stamps
    return { token, expiresAt };
  } catch (_) {
    return null;
  }
}

// Async token lookup: ~/.claude/.credentials.json first (Windows/Linux), then
// the macOS login Keychain, where Claude Code stores credentials by default on
// Macs. The Keychain read shells out to /usr/bin/security ASYNCHRONOUSLY — it
// can pop a one-time permission dialog, and that must never block the server.
// Results (including misses) are cached briefly so the dialog can't nag.
const IS_MAC = process.platform === 'darwin' || envv('FAKE_DARWIN') === '1'; // env: test hook
const SECURITY_BIN = envv('SECURITY_BIN') || '/usr/bin/security';
const KEYCHAIN_SERVICES = ['Claude Code-credentials', 'Claude Code'];
let credCache = { at: 0, cred: null };
const CRED_CACHE_MS = 5 * 60 * 1000;

function readOauthTokenAsync(cb) {
  cb = once(cb);
  if (Date.now() - credCache.at < CRED_CACHE_MS) return cb(credCache.cred);
  const remember = (cred) => { credCache = { at: Date.now(), cred }; cb(cred); };

  try {
    const raw = fs.readFileSync(path.join(claudeDir(), '.credentials.json'), 'utf8');
    const cred = parseCredentials(raw);
    if (cred) return remember(cred);
  } catch (_) { /* no file — fall through */ }

  if (!IS_MAC) return remember(null);

  // Try each known Keychain service name in turn.
  const tryService = (i) => {
    if (i >= KEYCHAIN_SERVICES.length) return remember(null);
    let fired = false;
    const child = require('child_process').execFile(
      SECURITY_BIN, ['find-generic-password', '-s', KEYCHAIN_SERVICES[i], '-w'],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 }, // generous: a permission dialog may be up
      (err, stdout) => {
        if (fired) return;
        fired = true;
        const cred = !err && stdout ? parseCredentials(stdout) : null;
        if (cred) return remember(cred);
        tryService(i + 1);
      }
    );
    child.on('error', () => { if (!fired) { fired = true; tryService(i + 1); } });
  };
  tryService(0);
}

// Two providers share the Account-limits card — every row names its provider.
const METER_LABELS = {
  five_hour: 'Claude · 5-hour session',
  seven_day: 'Claude · weekly (all models)',
  seven_day_overall: 'Claude · weekly (all models)',
  seven_day_opus: 'Claude · weekly · Opus',
  seven_day_sonnet: 'Claude · weekly · Sonnet',
  seven_day_oauth_apps: 'Claude · weekly · apps',
  seven_day_cowork: 'Claude · weekly · Cowork',
};

// Normalize one usage bucket from the API response. utilization is a 0–100
// percentage — Claude Code's own schema: "Percentage of the window used,
// 0-100". (The 0–1 FRACTIONS some tools report come from the
// anthropic-ratelimit-unified-*-utilization response HEADERS, not this
// endpoint.) The old "≤ 1 means a fraction" rule rendered a real 0.9% as 90%
// at the start of every window — and could fire a false 80% alert.
function parseMeterBucket(key, v) {
  if (!v || typeof v !== 'object') return null;
  let u = v.utilization;
  if (typeof u !== 'number' || !isFinite(u)) return null;
  const pct = u;
  // Undisclosed top-level keys — rotating codenames (`nimbus_quill`,
  // `cinder_cove`, `omelette_promotional`…) Anthropic has never documented,
  // usually at 0 with no reset — stay hidden until they carry real usage, so
  // the card doesn't fill with meaningless 0% rows. Known keys always render.
  if (!METER_LABELS[key] && !(pct > 0)) return null;
  let resetsAt = null;
  if (v.resets_at) {
    const t = typeof v.resets_at === 'number' ? v.resets_at * (v.resets_at < 1e12 ? 1000 : 1) : Date.parse(v.resets_at);
    if (isFinite(t)) resetsAt = t;
  }
  return { key, label: METER_LABELS[key] || 'Claude · ' + key.replace(/_/g, ' '), pct: Math.max(0, Math.min(100, pct)), resetsAt };
}

function refreshAccountMeters(done) {
  if (!metersEnabled()) { metersState.status = 'off'; return done && done(metersState); }
  if (metersInFlight) return done && done(metersState);
  metersInFlight = true; // guards the credential lookup too (Keychain dialogs)
  const schedule = (ms) => { metersState.nextAttemptAt = Date.now() + ms; };
  readOauthTokenAsync((cred) => {
  if (!cred) {
    metersInFlight = false;
    schedule(METERS_OK_MS);
    metersState.status = 'no-login';
    metersState.error = IS_MAC
      ? 'No Claude Code login found — Burnglass checked ~/.claude/.credentials.json and the macOS Keychain. ' +
        'If a Keychain permission dialog appeared, choose "Always Allow"; if you have never used Claude Code ' +
        'on this Mac, run `claude` in Terminal once.'
      : 'No Claude Code login found on this machine — run `claude` in a terminal once to log in.';
    return done && done(metersState);
  }
  // NOTE: even if the stored expiresAt looks past, ATTEMPT the request — the
  // API is the source of truth for token validity. A local timestamp (odd
  // units, clock skew, refreshed-out-of-band tokens) must never brick the
  // card; only a real 401/403 means expired.
  const looksExpired = !!(cred.expiresAt && cred.expiresAt < Date.now());
  fetchUrl(METERS_API_URL, {
    timeoutMs: 8000,
    headers: {
      'Authorization': 'Bearer ' + cred.token,
      'Content-Type': 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
    },
  }, (err, body) => {
    metersInFlight = false;
    // Disabled while the request was in flight: don't resurrect cleared state.
    if (!metersEnabled()) { metersState.status = 'off'; return done && done(metersState); }
    metersState.fetchedAt = Date.now();
    if (err) {
      if (err.status === 429) {
        // Rate-limited: honor Retry-After when given, else exponential backoff.
        // Last good buckets stay on screen — being throttled is not data loss.
        meters429Streak++;
        let waitMs = null;
        const ra = err.retryAfter;
        if (ra != null) {
          const sec = parseInt(ra, 10);
          if (isFinite(sec) && sec > 0) waitMs = sec * 1000;
          else { const t = Date.parse(ra); if (isFinite(t)) waitMs = t - Date.now(); }
        }
        if (waitMs == null || !isFinite(waitMs) || waitMs <= 0) {
          waitMs = Math.min(METERS_429_BASE_MS * Math.pow(2, meters429Streak - 1), METERS_429_MAX_MS);
        }
        waitMs = Math.max(5000, Math.min(waitMs, METERS_429_MAX_MS));
        schedule(waitMs);
        metersState.status = 'rate-limited';
        metersState.error = metersRateLimitMessage(waitMs);
        console.warn('[burnglass] account meters: ' + metersState.error);
        // The backoff survives a restart: a relaunch must not ask again at once.
        persistMetersCache();
        return done && done(metersState);
      }
      schedule(METERS_ERR_MS);
      metersState.status = /HTTP 401|HTTP 403/.test(err.message) ? 'expired' : 'error';
      metersState.error = metersState.status === 'expired'
        ? 'Claude rejected the login (' + err.message + ')' +
          (looksExpired ? ' — the token file is stale. ' : ' — ') +
          'Start a Claude Code CLI session on this machine (run `claude` in a terminal) to refresh ' +
          '~/.claude/.credentials.json; the desktop app keeps its own login and may not update that file. ' +
          'Burnglass never writes credentials.'
        : 'meters fetch failed: ' + err.message;
      console.warn('[burnglass] account meters: ' + metersState.error);
      return done && done(metersState);
    }
    meters429Streak = 0;
    schedule(METERS_OK_MS);
    let j = null;
    try { j = JSON.parse(body); } catch (_) {}
    if (!j || typeof j !== 'object') {
      schedule(METERS_ERR_MS);
      metersState.status = 'error';
      metersState.error = 'unexpected meters response';
      return done && done(metersState);
    }
    const buckets = [];
    for (const key of Object.keys(j)) {
      const b = parseMeterBucket(key, j[key]);
      if (b) buckets.push(b);
    }
    // Newer accounts report per-model weekly windows (the /usage panel's
    // "Weekly · Fable" row) in a limits[] array — kind "weekly_scoped" with
    // scope.model.display_name — not as dedicated seven_day_* keys.
    if (Array.isArray(j.limits)) {
      for (const lim of j.limits) {
        if (!lim || typeof lim !== 'object' || lim.kind !== 'weekly_scoped') continue;
        const name = lim.scope && lim.scope.model && typeof lim.scope.model.display_name === 'string'
          ? lim.scope.model.display_name.trim() : '';
        if (!name || typeof lim.percent !== 'number' || !isFinite(lim.percent)) continue;
        const pct = lim.percent; // "Share of the window used, 0-100" — same scale as utilization
        let resetsAt = null;
        if (lim.resets_at) {
          const t = typeof lim.resets_at === 'number'
            ? lim.resets_at * (lim.resets_at < 1e12 ? 1000 : 1) : Date.parse(lim.resets_at);
          if (isFinite(t)) resetsAt = t;
        }
        const label = 'Claude · weekly · ' + name;
        // Skip if a legacy key already produced this row (e.g. seven_day_opus).
        if (buckets.some((b) => b.label.toLowerCase() === label.toLowerCase())) continue;
        buckets.push({ key: 'model_scoped:' + name.toLowerCase(), label, pct: Math.max(0, Math.min(100, pct)), resetsAt });
      }
    }
    // Stable, meaningful order: 5h, then overall weekly, then scoped windows.
    const rank = (k) => (k === 'five_hour' ? 0 : k === 'seven_day' || k === 'seven_day_overall' ? 1 : 2);
    buckets.sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
    recordMeterSamples(buckets);
    metersState.buckets = buckets;
    metersState.status = 'ok';
    metersState.lastGoodAt = Date.now();
    metersState.error = buckets.length ? null : 'no usage buckets in response';
    console.log(`[burnglass] account meters refreshed (${buckets.length} bucket(s))`);
    persistMetersCache();
    done && done(metersState);
  });
  }); // readOauthTokenAsync
}

function metersRateLimitMessage(waitMs) {
  return 'Anthropic rate-limited the usage check (HTTP 429) — retrying in ~' +
    Math.max(1, Math.round(waitMs / 60000)) + 'm. If this persists, something else on this machine ' +
    '(e.g. a statusline script) may be polling the usage endpoint heavily.';
}

// ---- Last good reading across restarts ---------------------------------------
// <home>/meters-cache.json carries the last GOOD snapshot (and an active 429
// backoff) over a restart or an update relaunch. Without it the new process
// started blank and asked the endpoint at once — moments after the old
// process had, while Claude Code polls the same endpoint — and the 429 that
// earned left the card empty for up to an hour.
//   - Contents: {v:1, fetchedAt, buckets:[{key,label,pct,resetsAt}]} plus
//     {nextAttemptAt, streak} while a 429 backoff is active. Percentages,
//     labels and times only — never the token or anything derived from it.
//   - Written (tmp + rename, 0600 on POSIX) only while accountMeters is on,
//     and only by the process that owns the port (restoreMetersCache, from
//     the listen callback — a short-lived --summary never writes it);
//     deleted when the user turns the meters off.
//   - Restored buckets are the same last-good data an in-memory error keeps:
//     lastGoodAt/fetchedAt carry their real age, windows whose resetsAt has
//     passed are dropped, and they are NOT fed to recordMeterSamples (a
//     replayed reading would bend the projection slope).
// A different Claude login between runs shows the old account's numbers only
// until the next good fetch replaces them.
const METERS_CACHE_FILE = 'meters-cache.json';
const METERS_CACHE_MAX_AGE_MS = 12 * 3600e3; // older than this is not "last good", it's history
const METERS_CACHE_MAX_BYTES = 256 * 1024;
const METERS_CACHE_MAX_BUCKETS = 64;
const HAS_CONTROL = /[\x00-\x1f\x7f-\x9f]/; // no /g: .test() must not carry lastIndex
let metersCacheOwner = false;
let metersCacheWarned = false;

function metersCachePath() {
  const home = appHome();
  // Hard rule 3(b): nothing under ~/.pulse is ever deleted, and this file is
  // deleted when the meters go off — so a run whose home IS the legacy folder
  // (a degraded migration, a pin or link onto it) keeps the reading in memory
  // only, as before.
  if (sameEntry(home, legacyHomePath())) return null;
  return path.join(home, METERS_CACHE_FILE);
}

function removeMetersCache() {
  if (!metersCacheOwner) return;
  const f = metersCachePath();
  if (!f) return;
  try { fs.unlinkSync(f); console.log('[burnglass] account meters off — removed ' + homeLabel(METERS_CACHE_FILE)); } catch (_) { /* none */ }
}

function persistMetersCache() {
  if (!metersCacheOwner || !metersEnabled()) return;
  const f = metersCachePath();
  if (!f) return;
  const now = Date.now();
  const throttled = metersState.status === 'rate-limited' && metersState.nextAttemptAt > now;
  const good = metersState.lastGoodAt != null;
  if (!good && !throttled) { // e.g. a cleared backoff with no reading yet: nothing to carry over
    try { fs.unlinkSync(f); } catch (_) {}
    return;
  }
  const snap = {
    v: 1,
    fetchedAt: good ? metersState.lastGoodAt : null,
    buckets: good ? (metersState.buckets || []).map((b) => ({ key: b.key, label: b.label, pct: b.pct, resetsAt: b.resetsAt })) : [],
  };
  if (throttled) { snap.nextAttemptAt = metersState.nextAttemptAt; snap.streak = meters429Streak; }
  // Per-process temp name: an old process finishing a fetch while its
  // successor starts must not interleave into one temp file.
  const tmp = f + '.' + process.pid + '.tmp';
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(snap), { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, f);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    if (!metersCacheWarned) {
      metersCacheWarned = true;
      console.warn('[burnglass] account meters: could not save ' + homeLabel(METERS_CACHE_FILE) + ' (' + e.message +
        ') — the last reading will not survive a restart');
    }
  }
}

// One bucket from the file, re-validated (it is only data on disk).
function cachedMeterBucket(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const key = b.key;
  if (typeof key !== 'string' || !key || key.length > 160 || HAS_CONTROL.test(key)) return null;
  if (typeof b.pct !== 'number' || !isFinite(b.pct)) return null;
  let resetsAt = null;
  if (b.resetsAt != null) {
    if (typeof b.resetsAt !== 'number' || !isFinite(b.resetsAt) || b.resetsAt <= 0) return null;
    resetsAt = b.resetsAt;
  }
  // Known keys take today's label; others keep the one they were fetched with.
  let label = METER_LABELS[key];
  if (!label) {
    label = typeof b.label === 'string' && b.label.length <= 200 && !HAS_CONTROL.test(b.label) && /^Claude · /.test(b.label)
      ? b.label : 'Claude · ' + key.replace(/_/g, ' ');
  }
  return { key, label, pct: Math.max(0, Math.min(100, b.pct)), resetsAt };
}

// Startup (listen callback, after the home migration): load the last good
// snapshot + any live backoff, or remove the file when the meters are off.
function restoreMetersCache() {
  metersCacheOwner = true;
  if (!metersEnabled()) { removeMetersCache(); return; }
  const f = metersCachePath();
  if (!f) return;
  let raw;
  try {
    const st = fs.statSync(f);
    if (!st.isFile()) return;
    if (st.size > METERS_CACHE_MAX_BYTES) throw new Error('too large');
    raw = fs.readFileSync(f, 'utf8');
  } catch (e) {
    if (e && e.code !== 'ENOENT') console.warn('[burnglass] account meters: ignoring ' + homeLabel(METERS_CACHE_FILE) + ' (' + e.message + ')');
    return;
  }
  let j = null;
  try { j = JSON.parse(raw); } catch (_) {}
  if (!j || typeof j !== 'object' || Array.isArray(j) || j.v !== 1) {
    console.warn('[burnglass] account meters: ignoring an unrecognised ' + homeLabel(METERS_CACHE_FILE));
    return;
  }
  const now = Date.now();

  // The snapshot: recent enough to still be "last good", windows still open.
  let buckets = null, fetchedAt = null, rolled = 0;
  const fa = j.fetchedAt;
  if (typeof fa === 'number' && isFinite(fa) && fa > 0 && fa <= now + 60e3 &&
      now - fa <= METERS_CACHE_MAX_AGE_MS && Array.isArray(j.buckets)) {
    const seen = new Set();
    buckets = [];
    for (const rb of j.buckets.slice(0, METERS_CACHE_MAX_BUCKETS)) {
      const b = cachedMeterBucket(rb);
      if (!b || seen.has(b.key)) continue;
      seen.add(b.key);
      // The window rolled since: its old value says nothing about the new one.
      if (b.resetsAt != null && b.resetsAt <= now) { rolled++; continue; }
      buckets.push(b);
    }
    fetchedAt = Math.min(fa, now);
    if (!buckets.length && rolled) buckets = null; // every window rolled — nothing left to show
  }

  // The backoff: honored while still in the future (capped like a live one).
  // A streak whose backoff ended within the last cap window carries on, so
  // the next 429 keeps doubling instead of starting over.
  const na = j.nextAttemptAt;
  const hasBackoff = typeof na === 'number' && isFinite(na);
  if (hasBackoff && na > now - METERS_429_MAX_MS) {
    meters429Streak = Number.isInteger(j.streak) && j.streak > 0 ? Math.min(j.streak, 16) : 1;
  }
  const throttled = hasBackoff && na > now;
  if (!buckets && !throttled) return;

  if (buckets) {
    metersState.buckets = buckets;
    metersState.fetchedAt = fetchedAt;
    metersState.lastGoodAt = fetchedAt;
    metersState.status = 'ok';
    metersState.error = buckets.length ? null : 'no usage buckets in response';
    // Next check at the normal cadence from when the reading was taken — or
    // right away when a window rolled (its new value is unknown).
    metersState.nextAttemptAt = rolled ? 0 : fetchedAt + METERS_OK_MS;
  }
  if (throttled) {
    const at = Math.min(na, now + METERS_429_MAX_MS);
    metersState.nextAttemptAt = at;
    metersState.status = 'rate-limited';
    metersState.error = metersRateLimitMessage(at - now);
  }
  const parts = [];
  if (buckets) {
    parts.push(`restored ${buckets.length} bucket(s) from ${Math.max(0, Math.round((now - fetchedAt) / 60000))}m ago` +
      (rolled ? ` (${rolled} rolled-over window(s) dropped)` : ''));
  }
  if (throttled) parts.push('still rate-limited — next check in ~' + Math.max(1, Math.round((metersState.nextAttemptAt - now) / 60000)) + 'm');
  else if (metersState.nextAttemptAt > now) parts.push('next check in ~' + Math.max(1, Math.round((metersState.nextAttemptAt - now) / 1000)) + 's');
  console.log('[burnglass] account meters: ' + parts.join('; '));
}

// The freshest official five-hour bucket, if usable: its resets_at is an
// absolute timestamp, so even a snapshot fetched a while ago (or during a
// rate-limit backoff) keeps telling the exact true reset time.
function officialFiveHourBucket() {
  if (!metersEnabled()) return null;
  const b = (metersState.buckets || []).find((x) => x.key === 'five_hour');
  return b && b.resetsAt ? b : null;
}

// ---------------------------------------------------------------------------
// CODEX ACCOUNT TOKEN USAGE (opt-in — same switch as the account meters)
// GET chatgpt.com/backend-api/wham/profiles/me — the endpoint behind the
// Codex TUI's own token chart (TokenUsageProfile in openai/codex). Unlike
// Anthropic's usage endpoint (percentages only), this returns REAL token
// counts, account-wide across every device: lifetime, peak day, streaks and
// per-day buckets. The ChatGPT OAuth token is read from ~/.codex/auth.json
// READ-ONLY, never logged, and sent only to this endpoint. Polled gently —
// the numbers move at day granularity.
// ---------------------------------------------------------------------------
const CODEX_USAGE_API_URL = envv('CODEX_USAGE_API') ||
  'https://chatgpt.com/backend-api/wham/profiles/me';
const CODEX_USAGE_OK_MS = parseInt(envv('CODEX_USAGE_CACHE_MS'), 10) || 10 * 60 * 1000;
const CODEX_USAGE_ERR_MS = Math.min(CODEX_USAGE_OK_MS * 2, 20 * 60 * 1000);
const CODEX_USAGE_429_MAX_MS = 60 * 60 * 1000;

const codexUsageState = {
  status: 'off',   // off | ok | no-login | expired | error | rate-limited
  stats: null,     // normalized token totals — kept through errors
  fetchedAt: null,
  lastGoodAt: null,
  nextAttemptAt: 0,
  error: null,
};
let codexUsageInFlight = false;
let codexUsage429Streak = 0;

// ~/.codex/auth.json → { token, accountId } or null. An API-key-only login
// (no ChatGPT tokens) can't call the account endpoint — treated as no-login.
// Values go into HTTP headers, so anything with header-invalid characters
// (a corrupt or hand-edited file) is rejected here rather than allowed to
// blow up the request.
const HEADER_SAFE = /^[\x21-\x7e]+$/; // printable ASCII, no whitespace/CTLs
function readCodexAuth() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(codexDir(), 'auth.json'), 'utf8'));
    const t = j && j.tokens;
    if (t && typeof t.access_token === 'string' && HEADER_SAFE.test(t.access_token)) {
      return {
        token: t.access_token,
        accountId: typeof t.account_id === 'string' && HEADER_SAFE.test(t.account_id) ? t.account_id : null,
      };
    }
  } catch (_) { /* missing/unreadable → no-login */ }
  return null;
}

// Normalize TokenUsageProfile.stats. All fields are optional server-side;
// aggregates (today / last 7 / last 30 days) are computed here so the UI
// stays dumb. Bucket dates are YYYY-MM-DD (UTC day keys).
function normalizeCodexUsage(j) {
  if (!j || typeof j !== 'object') return null;
  const hasStats = j.stats && typeof j.stats === 'object';
  const s = hasStats ? j.stats : j;
  const n = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const buckets = [];
  if (Array.isArray(s.daily_usage_buckets)) {
    for (const b of s.daily_usage_buckets) {
      if (!b || typeof b.start_date !== 'string' || typeof b.tokens !== 'number' || !isFinite(b.tokens)) continue;
      const date = b.start_date.slice(0, 10);
      // Aggregates compare dates lexicographically — a malformed string
      // (e.g. "N/A") would sort past every cutoff and pollute the sums.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      buckets.push({ date, tokens: b.tokens });
    }
    buckets.sort((a, b) => a.date.localeCompare(b.date));
  }
  const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
  const today = dayKey(Date.now());
  const cutoff7 = dayKey(Date.now() - 6 * 24 * 3600 * 1000);
  const cutoff30 = dayKey(Date.now() - 29 * 24 * 3600 * 1000);
  let todayTokens = 0, last7 = 0, last30 = 0;
  for (const b of buckets) {
    if (b.date === today) todayTokens += b.tokens;
    if (b.date >= cutoff7) last7 += b.tokens;
    if (b.date >= cutoff30) last30 += b.tokens;
  }
  // A response with a stats object is valid even when every field is absent
  // or zero (brand-new account) — that's "ok, zero usage", not an error.
  // Only a shape with no stats object AND no recognizable fields at the root
  // is genuinely unexpected.
  const hasSignal = buckets.length > 0 || n(s.lifetime_tokens) != null || n(s.peak_daily_tokens) != null;
  if (!hasStats && !hasSignal) return null;
  return {
    lifetimeTokens: n(s.lifetime_tokens),
    peakDailyTokens: n(s.peak_daily_tokens),
    currentStreakDays: n(s.current_streak_days),
    todayTokens, last7Tokens: last7, last30Tokens: last30,
    buckets: buckets.slice(-30), // enough for the daily mini-chart
  };
}

// Separate consent from the Claude meters: users who opted in before v1.6.0
// consented to api.anthropic.com only. The dashboard's enable button (a fresh
// gesture, with copy naming both endpoints) sets BOTH keys; a pre-existing
// {accountMeters: true} alone keeps the ChatGPT call off until re-toggled.
function codexUsageEnabled() {
  return readConfig().codexAccountUsage === true;
}

function refreshCodexUsage(done) {
  if (!codexUsageEnabled()) { codexUsageState.status = 'off'; return done && done(codexUsageState); }
  if (codexUsageInFlight) return done && done(codexUsageState);
  codexUsageInFlight = true;
  const schedule = (ms) => { codexUsageState.nextAttemptAt = Date.now() + ms; };
  const auth = readCodexAuth();
  if (!auth) {
    codexUsageInFlight = false;
    schedule(CODEX_USAGE_OK_MS);
    codexUsageState.status = 'no-login';
    codexUsageState.error = 'No ChatGPT login found in ~/.codex/auth.json — run `codex` once to sign in. ' +
      '(API-key-only logins have no account usage endpoint.)';
    return done && done(codexUsageState);
  }
  const headers = {
    'Authorization': 'Bearer ' + auth.token,
    'Content-Type': 'application/json',
    'User-Agent': 'burnglass/' + PULSE_VERSION,
  };
  if (auth.accountId) headers['ChatGPT-Account-Id'] = auth.accountId;
  fetchUrl(CODEX_USAGE_API_URL, { timeoutMs: 8000, headers }, (err, body) => {
    codexUsageInFlight = false;
    // Disabled while the request was in flight: the off-handler already
    // cleared the state — don't resurrect it with a stale write.
    if (!codexUsageEnabled()) { codexUsageState.status = 'off'; return done && done(codexUsageState); }
    codexUsageState.fetchedAt = Date.now();
    if (err) {
      if (err.status === 429) {
        codexUsage429Streak++;
        let waitMs = null;
        const ra = err.retryAfter;
        if (ra != null) {
          const sec = parseInt(ra, 10);
          if (isFinite(sec) && sec > 0) waitMs = sec * 1000;
          else { const t = Date.parse(ra); if (isFinite(t)) waitMs = t - Date.now(); }
        }
        if (waitMs == null || !isFinite(waitMs) || waitMs <= 0) {
          waitMs = Math.min(CODEX_USAGE_OK_MS * Math.pow(2, codexUsage429Streak - 1), CODEX_USAGE_429_MAX_MS);
        }
        waitMs = Math.max(5000, Math.min(waitMs, CODEX_USAGE_429_MAX_MS));
        schedule(waitMs);
        codexUsageState.status = 'rate-limited';
        codexUsageState.error = 'ChatGPT rate-limited the usage check (HTTP 429) — retrying in ~' +
          Math.max(1, Math.round(waitMs / 60000)) + 'm.';
        console.warn('[burnglass] codex account usage: ' + codexUsageState.error);
        return done && done(codexUsageState);
      }
      schedule(CODEX_USAGE_ERR_MS);
      codexUsageState.status = /HTTP 401|HTTP 403/.test(err.message) ? 'expired' : 'error';
      codexUsageState.error = codexUsageState.status === 'expired'
        ? 'ChatGPT rejected the Codex login (' + err.message + ') — run `codex` in a terminal once to ' +
          'refresh ~/.codex/auth.json. Burnglass never writes credentials.'
        : 'codex usage fetch failed: ' + err.message;
      console.warn('[burnglass] codex account usage: ' + codexUsageState.error);
      return done && done(codexUsageState);
    }
    codexUsage429Streak = 0;
    schedule(CODEX_USAGE_OK_MS);
    let j = null;
    try { j = JSON.parse(body); } catch (_) {}
    const stats = normalizeCodexUsage(j);
    if (!stats) {
      schedule(CODEX_USAGE_ERR_MS);
      codexUsageState.status = 'error';
      codexUsageState.error = 'unexpected codex usage response';
      return done && done(codexUsageState);
    }
    codexUsageState.stats = stats;
    codexUsageState.status = 'ok';
    codexUsageState.lastGoodAt = Date.now();
    codexUsageState.error = null;
    console.log('[burnglass] codex account usage refreshed (' + stats.buckets.length + ' day bucket(s))');
    done && done(codexUsageState);
  });
}

// Lazily refresh on summary builds; serve the cached state immediately.
// Same background trickle as the Claude meters — a status line / Discord build
// only pokes chatgpt.com when the token totals are already stale.
function codexUsageForPayload(background) {
  if (!codexUsageEnabled()) return { enabled: false };
  const due = Date.now() >= (codexUsageState.nextAttemptAt || 0);
  const bgOk = !background || (Date.now() - (codexUsageState.fetchedAt || 0) >= BACKGROUND_METERS_MS);
  if (due && bgOk) {
    refreshCodexUsage(); // async; next poll picks it up
  }
  return {
    enabled: true,
    status: codexUsageState.status === 'off' ? 'loading' : codexUsageState.status,
    stats: codexUsageState.stats,
    fetchedAt: codexUsageState.fetchedAt,
    lastGoodAt: codexUsageState.lastGoodAt,
    error: codexUsageState.error,
  };
}

// ---------------------------------------------------------------------------
// MESHY 3D CREDITS (opt-in, API-key authenticated)
//
// Meshy generates 3D assets and is the first source Pulse reads that has NO
// local log — there is nothing on disk to parse, so this is an authenticated
// API integration modelled on the account meters above, NOT on the transcript
// parsers. Two consents are required before a single byte leaves the machine:
// `meshy: true` in ~/.burnglass/config.json AND a stored `meshyApiKey`.
//
// CREDITS ARE THEIR OWN UNIT. Meshy bills in credits and publishes no
// credit→dollar rate, so credits NEVER enter totals.cost, any period cost,
// planValue, or any other dollar figure in the payload. Inventing a rate would
// produce exactly the kind of confidently-wrong number this project exists to
// remove. payload.meshy is a self-contained block with its own unit.
//
// THE KEY IS A SECRET, AND IT IS THE FIRST CREDENTIAL PULSE STORES (every
// other one is read read-only from a file some other tool wrote). Therefore:
// never logged (not even truncated), never in a payload (`hasKey` is a
// boolean), never in a URL or query string (it travels in an Authorization
// header, and is SET through a POST body for the same reason), and sent to no
// host but Meshy's. fetchUrl deliberately drops custom headers when it
// follows a redirect, so a redirected request can never carry the key
// somewhere else.
//
// Fetching is deliberately gentle — this is a shared third-party API. One
// refresh every ~15 minutes at most; task pages are persisted to
// ~/.burnglass/meshy.json so a restart doesn't re-page the world; paging stops as
// soon as it reaches tasks already known or older than the window; 401 stops
// retrying until the configured key changes; 429/5xx back off and keep the
// last-good numbers on screen.
// ---------------------------------------------------------------------------
const MESHY_API_BASE = String(envv('MESHY_API') || 'https://api.meshy.ai').replace(/\/+$/, '');
// Explicit 0 is honored (timing-sensitive suites disable the cache) — hence
// the isFinite check rather than the usual `|| default`.
const MESHY_OK_MS = (() => {
  const v = parseInt(envv('MESHY_CACHE_MS'), 10);
  return isFinite(v) && v >= 0 ? v : 15 * 60 * 1000;
})();
const MESHY_ERR_MS = Math.min(Math.max(MESHY_OK_MS, 60 * 1000) * 2, 30 * 60 * 1000);
const MESHY_429_MAX_MS = 60 * 60 * 1000;
const MESHY_PAGE_SIZE = 50;   // the API maximum
const MESHY_MAX_PAGES = 6;    // per family per refresh — a hard ceiling on politeness
const MESHY_WINDOW_DAYS = 30; // what `daily` / `month` report
const MESHY_RETAIN_DAYS = 45; // what the sidecar keeps (slack so the window is always full)

// Task families. ONLY text-to-3d is confirmed against the published docs; the
// rest are probed defensively — a 404/405/anything on an unconfirmed family is
// skipped silently and must never fail the refresh. `families` in the payload
// reports which ones actually answered, so the UI can be honest about coverage
// instead of implying a total it cannot see.
const MESHY_FAMILIES = [
  { type: 'text-to-3d', path: '/openapi/v2/text-to-3d', confirmed: true },
  { type: 'image-to-3d', path: '/openapi/v1/image-to-3d' },
  { type: 'multi-image-to-3d', path: '/openapi/v1/multi-image-to-3d' },
  { type: 'text-to-texture', path: '/openapi/v1/text-to-texture' },
  { type: 'retexture', path: '/openapi/v1/retexture' },
  { type: 'remesh', path: '/openapi/v1/remesh' },
  { type: 'rigging', path: '/openapi/v1/rigging' },
  { type: 'animation', path: '/openapi/v1/animation' },
];

const meshyState = {
  status: 'idle',    // idle | ok | stale | error | no-key | disabled
  balance: null,     // credits remaining — kept through errors (last good)
  families: [],      // families that answered on the last successful refresh
  fetchedAt: null,   // when the DATA being served was fetched (last GOOD fetch)
  nextAttemptAt: 0,
  error: null,
  badKeyHash: null,  // fingerprint of the key the API rejected — NEVER the key
};
let meshyInFlight = false;
let meshy429Streak = 0;

function meshyEnabled() { return readConfig().meshy === true; }

// The configured key, if any (presence only — used for `hasKey`).
function meshyConfiguredKey() {
  const k = readConfig().meshyApiKey;
  return typeof k === 'string' && k.trim() ? k.trim() : null;
}
// The key in usable form. It goes straight into an Authorization header, so
// anything with header-invalid characters (a paste that dragged in a newline)
// is rejected here rather than allowed to throw inside http.get.
function meshyApiKey() {
  const k = meshyConfiguredKey();
  return k && HEADER_SAFE.test(k) ? k : null;
}
// Identity of a key WITHOUT the key: lets the 401 latch tell "same bad key
// still configured" from "user changed it" without ever holding the secret in
// a comparable field that could be logged or serialized by accident.
function meshyKeyHash(key) {
  try { return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16); }
  catch (_) { return null; }
}

// ~/.burnglass/meshy.json — the incremental task cache. Meshy tasks are immutable
// once finished, so remembering them means a restart re-reads one page per
// family instead of the whole account history.
function meshyStorePath() { return path.join(appHome(), 'meshy.json'); }
function emptyMeshyStore() {
  return { version: 1, tasks: {}, pruned: { credits: 0, tasks: 0, byType: {} } };
}
let meshyStore = null;
function readMeshyStore() {
  if (meshyStore) return meshyStore;
  let j = null;
  try { j = JSON.parse(fs.readFileSync(meshyStorePath(), 'utf8')); } catch (_) { /* first run */ }
  const store = emptyMeshyStore();
  if (j && typeof j === 'object') {
    if (j.tasks && typeof j.tasks === 'object') {
      for (const id of Object.keys(j.tasks)) {
        const t = j.tasks[id];
        if (!t || typeof t !== 'object') continue;
        if (typeof t.ts !== 'number' || !isFinite(t.ts)) continue;
        store.tasks[id] = {
          t: typeof t.t === 'string' && t.t ? t.t : 'unknown',
          c: typeof t.c === 'number' && isFinite(t.c) ? t.c : 0,
          ts: t.ts,
          s: typeof t.s === 'string' ? t.s : '',
        };
      }
    }
    const p = j.pruned;
    if (p && typeof p === 'object') {
      if (typeof p.credits === 'number' && isFinite(p.credits)) store.pruned.credits = p.credits;
      if (typeof p.tasks === 'number' && isFinite(p.tasks)) store.pruned.tasks = p.tasks;
      if (p.byType && typeof p.byType === 'object') {
        for (const k of Object.keys(p.byType)) {
          const b = p.byType[k];
          if (!b || typeof b !== 'object') continue;
          store.pruned.byType[k] = {
            credits: typeof b.credits === 'number' && isFinite(b.credits) ? b.credits : 0,
            tasks: typeof b.tasks === 'number' && isFinite(b.tasks) ? b.tasks : 0,
          };
        }
      }
    }
  }
  meshyStore = store;
  return meshyStore;
}
function writeMeshyStore(store) {
  try {
    fs.mkdirSync(appHome(), { recursive: true });
    fs.writeFileSync(meshyStorePath(), JSON.stringify(store));
  } catch (e) {
    // ~/.burnglass unwritable → Burnglass just re-pages next start. Never fatal.
    console.warn('[burnglass] meshy: could not write task cache: ' + e.message);
  }
}

// Drop detail older than the retention window. The task's credits are folded
// into the `pruned` accumulators FIRST, so `allTime` never shrinks merely
// because Pulse stopped keeping the per-task detail.
function pruneMeshyStore(store, now) {
  const cutoff = now - MESHY_RETAIN_DAYS * 86400000;
  for (const id of Object.keys(store.tasks)) {
    const t = store.tasks[id];
    if (t && t.ts >= cutoff) continue;
    if (t) {
      const c = typeof t.c === 'number' && isFinite(t.c) ? t.c : 0;
      store.pruned.credits += c;
      store.pruned.tasks += 1;
      const b = store.pruned.byType[t.t] || (store.pruned.byType[t.t] = { credits: 0, tasks: 0 });
      b.credits += c;
      b.tasks += 1;
    }
    delete store.tasks[id];
  }
}

// Meshy timestamps are documented as epoch MILLISECONDS. Tolerate a seconds
// stamp and an ISO string anyway — a misread timestamp silently moves credits
// into the wrong day.
function meshyTs(v) {
  if (typeof v === 'number' && isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v) { const t = Date.parse(v); if (isFinite(t)) return t; }
  return null;
}

// A list response, whatever envelope it arrives in. The confirmed endpoint
// returns a bare array; the unconfirmed families are probed, so accept the
// common wrappers rather than mis-reporting a real answer as "no such family".
function meshyTaskList(body) {
  let j = null;
  try { j = JSON.parse(body); } catch (_) { return null; }
  if (Array.isArray(j)) return j;
  if (j && typeof j === 'object') {
    for (const k of ['result', 'data', 'tasks', 'items']) {
      if (Array.isArray(j[k])) return j[k];
    }
  }
  return null;
}

// Roll the stored tasks into the payload shape. Day bucketing uses
// localDateStr / localDayStartsBack — the same helpers every other Pulse
// period uses — so a Meshy day lines up exactly with a Pulse day.
function meshyAggregate(store, now) {
  const days = localDayStartsBack(now, MESHY_WINDOW_DAYS);
  const idx = new Map();
  days.forEach((d, i) => idx.set(d, i));
  const daily = days.map((date) => ({ date, credits: 0, tasks: 0 }));
  const todayStr = days[days.length - 1];
  const weekSet = new Set(days.slice(-7));
  const byType = {};
  let today = 0, week = 0, month = 0;
  // allTime starts from the pruned accumulator so it survives retention.
  let allTime = store.pruned.credits || 0;
  for (const id of Object.keys(store.tasks)) {
    const t = store.tasks[id];
    const c = typeof t.c === 'number' && isFinite(t.c) ? t.c : 0;
    allTime += c;
    const b = byType[t.t] || (byType[t.t] = { credits: 0, tasks: 0 });
    b.credits += c;
    b.tasks += 1;
    const ds = localDateStr(t.ts);
    const i = idx.get(ds);
    if (i === undefined) continue; // outside the reported window
    daily[i].credits += c;
    daily[i].tasks += 1;
    // `month` is the trailing 30 local days — the SAME window `daily` covers,
    // so the chart always sums to the headline figure.
    month += c;
    if (weekSet.has(ds)) week += c;
    if (ds === todayStr) today += c;
  }
  // byType is all-time, matching `allTime`, so it folds in the pruned totals.
  for (const k of Object.keys(store.pruned.byType || {})) {
    const p = store.pruned.byType[k];
    const b = byType[k] || (byType[k] = { credits: 0, tasks: 0 });
    b.credits += p.credits || 0;
    b.tasks += p.tasks || 0;
  }
  // Credits are usually whole numbers; round anyway so a fractional plan can
  // never surface float noise like 0.30000000000000004.
  const r = (n) => Math.round(n * 1000) / 1000;
  for (const k of Object.keys(byType)) byType[k].credits = r(byType[k].credits);
  for (const d of daily) d.credits = r(d.credits);
  return {
    credits: { today: r(today), week: r(week), month: r(month), allTime: r(allTime) },
    byType,
    daily,
  };
}

// One authenticated GET. The key rides in a header — NEVER a query string,
// which would land in URLs, logs and Referer headers.
function meshyFetch(pathname, key, cb) {
  fetchUrl(MESHY_API_BASE + pathname, {
    timeoutMs: 10000,
    headers: { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' },
  }, cb);
}

// Retry-After (seconds or HTTP-date), else exponential backoff — same shape as
// the meters code, which is the established polite-citizen pattern here.
function meshyBackoffMs(err, streak) {
  let waitMs = null;
  const ra = err && err.retryAfter;
  if (ra != null) {
    const sec = parseInt(ra, 10);
    if (isFinite(sec) && sec > 0) waitMs = sec * 1000;
    else { const t = Date.parse(ra); if (isFinite(t)) waitMs = t - Date.now(); }
  }
  if (waitMs == null || !isFinite(waitMs) || waitMs <= 0) {
    waitMs = Math.min(Math.max(MESHY_OK_MS, 60 * 1000) * Math.pow(2, Math.max(0, streak - 1)), MESHY_429_MAX_MS);
  }
  return Math.max(5000, Math.min(waitMs, MESHY_429_MAX_MS));
}

function refreshMeshy(done) {
  const finish = (st) => { done && done(st); };
  if (!meshyEnabled()) { meshyState.status = 'disabled'; return finish(meshyState); }
  const key = meshyApiKey();
  if (!key) {
    meshyState.status = 'no-key';
    meshyState.error = meshyConfiguredKey()
      ? 'The stored Meshy API key has characters that cannot go in an HTTP header — re-paste it.'
      : 'No Meshy API key stored — add one from the dashboard (or set "meshyApiKey" in ' + homeLabel('config.json') + ').';
    return finish(meshyState);
  }
  const keyHash = meshyKeyHash(key);
  if (meshyState.badKeyHash) {
    // A 401 means the key is wrong, not that the network hiccuped. Retrying on
    // a timer would hammer someone else's API forever, so the latch only opens
    // when the CONFIGURED key actually changes.
    if (meshyState.badKeyHash === keyHash) return finish(meshyState);
    meshyState.badKeyHash = null;
    meshyState.error = null;
  }
  if (meshyInFlight) return finish(meshyState);
  meshyInFlight = true;
  const schedule = (ms) => { meshyState.nextAttemptAt = Date.now() + ms; };
  const startedAt = Date.now();
  const cutoffMs = startedAt - MESHY_RETAIN_DAYS * 86400000;
  const store = readMeshyStore();
  const families = [];
  let added = 0, updated = 0;
  let throttled = null;

  const fail = (status, message, backoffMs) => {
    meshyInFlight = false;
    schedule(backoffMs);
    // Keep the last-good balance and the stored tasks on screen: being
    // throttled or offline is not data loss. Only a never-succeeded state is
    // a hard 'error'.
    meshyState.status = status;
    meshyState.error = message;
    console.warn('[burnglass] meshy: ' + message);
    return finish(meshyState);
  };
  const softStatus = () => (meshyState.fetchedAt ? 'stale' : 'error');

  // 1) Balance — the confirmed endpoint, and the auth canary. If this fails
  //    there is no point probing eight list endpoints behind the same key.
  meshyFetch('/openapi/v1/balance', key, (err, body) => {
    if (!meshyEnabled()) { // disabled mid-flight: don't resurrect cleared state
      meshyInFlight = false;
      meshyState.status = 'disabled';
      return finish(meshyState);
    }
    if (err) {
      if (err.status === 401 || err.status === 403) {
        meshyState.badKeyHash = keyHash;
        meshyInFlight = false;
        schedule(MESHY_ERR_MS);
        meshyState.status = 'error';
        meshyState.error = 'Meshy rejected the API key (' + err.message + ') — check the key in the ' +
          'dashboard or ' + homeLabel('config.json') + '. Burnglass will not retry until it changes.';
        console.warn('[burnglass] meshy: ' + meshyState.error);
        return finish(meshyState);
      }
      if (err.status === 429) {
        meshy429Streak++;
        const waitMs = meshyBackoffMs(err, meshy429Streak);
        return fail(softStatus(), 'Meshy rate-limited the usage check (HTTP 429) — retrying in ~' +
          Math.max(1, Math.round(waitMs / 60000)) + 'm.', waitMs);
      }
      return fail(softStatus(), 'meshy balance fetch failed: ' + err.message, MESHY_ERR_MS);
    }
    meshy429Streak = 0;
    let balance = null;
    try {
      const j = JSON.parse(body);
      if (j && typeof j.balance === 'number' && isFinite(j.balance)) balance = j.balance;
    } catch (_) { /* handled below */ }
    if (balance == null) {
      return fail(softStatus(), 'unexpected meshy balance response', MESHY_ERR_MS);
    }

    // 2) Task families, SEQUENTIALLY (never eight parallel requests at a
    //    third-party API), each paged only as far as it needs to be.
    const walkFamily = (fi) => {
      if (throttled || fi >= MESHY_FAMILIES.length) return finishRefresh();
      const fam = MESHY_FAMILIES[fi];
      let answered = false;
      const page = (pageNum) => {
        if (pageNum > MESHY_MAX_PAGES) return walkFamily(fi + 1);
        const q = '?page_num=' + pageNum + '&page_size=' + MESHY_PAGE_SIZE + '&sort_by=-created_at';
        meshyFetch(fam.path + q, key, (err2, body2) => {
          if (err2) {
            if (err2.status === 429) { throttled = err2; return finishRefresh(); }
            // Anything else on an UNCONFIRMED family (404/405/500/parse) just
            // means this account or API version has no such list endpoint.
            // Skip it silently — one missing family must never fail the run.
            return walkFamily(fi + 1);
          }
          const list = meshyTaskList(body2);
          if (!Array.isArray(list)) return walkFamily(fi + 1);
          if (!answered) { answered = true; families.push(fam.type); }
          let changed = 0, reachedOld = false;
          for (const raw of list) {
            if (!raw || typeof raw !== 'object') continue;
            const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
            if (!id) continue;
            const ts = meshyTs(raw.created_at);
            if (ts == null) continue;
            // Sorted newest-first, so an old task means the rest of this
            // family is older still.
            if (ts < cutoffMs) { reachedOld = true; continue; }
            const credits = typeof raw.consumed_credits === 'number' && isFinite(raw.consumed_credits)
              ? raw.consumed_credits : 0;
            // Prefer the task's OWN type when it reports one — a family
            // endpoint can return more than one task type.
            const type = typeof raw.type === 'string' && raw.type ? raw.type.toLowerCase() : fam.type;
            const status = typeof raw.status === 'string' ? raw.status : '';
            const prev = store.tasks[id];
            // Already known AND unchanged → nothing to record. (A running task
            // whose credits or status moved still counts as changed, so an
            // in-progress task is not frozen at its first-seen value.)
            if (prev && prev.c === credits && prev.s === status && prev.t === type) continue;
            store.tasks[id] = { t: type, c: credits, ts, s: status };
            if (prev) updated++; else added++;
            changed++;
          }
          // Stop paging this family when the page told us nothing new, when it
          // ran past the retention window, or when it was the last page.
          if (changed === 0 || reachedOld || list.length < MESHY_PAGE_SIZE) return walkFamily(fi + 1);
          page(pageNum + 1);
        });
      };
      page(1);
    };

    const finishRefresh = () => {
      meshyInFlight = false;
      if (!meshyEnabled()) { meshyState.status = 'disabled'; return finish(meshyState); }
      pruneMeshyStore(store, Date.now());
      writeMeshyStore(store);
      meshyState.balance = balance;
      if (throttled) {
        // A throttled walk stopped early, so `families` is a partial list —
        // publishing it would understate coverage. Keep the last complete one.
        meshy429Streak++;
        const waitMs = meshyBackoffMs(throttled, meshy429Streak);
        schedule(waitMs);
        // Partial data was still merged and the balance is fresh — 'stale'
        // says "some of this may be behind", which is the honest word.
        meshyState.status = 'stale';
        meshyState.error = 'Meshy rate-limited the task listing (HTTP 429) — retrying in ~' +
          Math.max(1, Math.round(waitMs / 60000)) + 'm.';
        console.warn('[burnglass] meshy: ' + meshyState.error);
        return finish(meshyState);
      }
      // A complete walk: report exactly what answered THIS time, even if that
      // is nothing — a stale coverage list would imply totals Pulse can't see.
      meshyState.families = families;
      schedule(MESHY_OK_MS);
      meshyState.status = 'ok';
      meshyState.fetchedAt = Date.now();
      meshyState.error = families.length ? null : 'no Meshy task endpoints answered — credits shown are balance only';
      // NOTE: nothing here logs the key, the balance aside. Task prompts are
      // never stored or logged either.
      console.log('[burnglass] meshy refreshed (' + balance + ' credits left, ' +
        families.length + ' family/families, +' + added + ' new / ' + updated + ' updated task(s), ' +
        (Date.now() - startedAt) + 'ms)');
      return finish(meshyState);
    };

    walkFamily(0);
  });
}

// Lazily refresh on summary builds and serve the cached aggregate immediately —
// same trickle discipline as the meters: a status line / Discord build only
// pokes Meshy when the numbers are already well out of date.
function meshyForPayload(background) {
  const enabled = meshyEnabled();
  const hasKey = !!meshyConfiguredKey();
  const blank = () => ({ credits: { today: 0, week: 0, month: 0, allTime: 0 }, byType: {}, daily: [] });
  if (!enabled) {
    // No consent → nothing fetched, nothing read, nothing reported.
    return { enabled: false, hasKey, status: 'disabled', balance: null, ...blank(), families: [], fetchedAt: null, error: null };
  }
  if (!hasKey) {
    return {
      enabled: true, hasKey: false, status: 'no-key', balance: null, ...blank(), families: [], fetchedAt: null,
      error: 'No Meshy API key stored — add one from the dashboard (or set "meshyApiKey" in ' + homeLabel('config.json') + ').',
    };
  }
  const due = Date.now() >= (meshyState.nextAttemptAt || 0);
  const bgOk = !background || (Date.now() - (meshyState.fetchedAt || 0) >= BACKGROUND_METERS_MS);
  if (due && bgOk) refreshMeshy(); // async; the next poll picks it up
  const agg = meshyAggregate(readMeshyStore(), Date.now());
  return {
    enabled: true,
    hasKey: true, // the boolean is the ONLY thing about the key that ever ships
    // 'idle' means the first fetch hasn't landed yet: the stored numbers are
    // real but unconfirmed, which is exactly what 'stale' says.
    status: meshyState.status === 'idle' || meshyState.status === 'disabled' ? 'stale' : meshyState.status,
    balance: meshyState.balance,
    credits: agg.credits,
    byType: agg.byType,
    daily: agg.daily,
    families: (meshyState.families || []).slice(),
    fetchedAt: meshyState.fetchedAt,
    error: meshyState.error,
  };
}

// ---------------------------------------------------------------------------
// DISCORD RICH PRESENCE (opt-in, off by default)
// Talks the Discord desktop client's local IPC protocol directly — a named
// pipe on Windows, a Unix socket elsewhere; 8-byte header (op + length,
// little-endian) followed by JSON. No SDK, no network: the socket is local,
// and Discord's own client does the publishing. Zero-dependency by design.
// NOTE: presence is PUBLIC to anyone who can see your Discord profile —
// that's the whole point, but it's why this is opt-in and the copy says so.
// Requires a Discord Application ID (free, discord.com/developers) in
// config discordClientId — client IDs are public identifiers, not secrets.
// ---------------------------------------------------------------------------
// The official application (registered by the repo owner as "Pulse" and
// renamed "Burnglass" in the Developer Portal — the id is FROZEN, and so is
// the `pulse` idle-art asset key: the art behind it is swapped, not the key).
// Client IDs are public identifiers — every rich-presence tool ships one.
// Override with config discordClientId / env BURNGLASS_DISCORD_CLIENT_ID
// (PULSE_DISCORD_CLIENT_ID) to use your own app.
const DISCORD_CLIENT_ID_DEFAULT = '1527236432375189535';
const DISCORD_TICK_MS = parseInt(envv('DISCORD_TICK_MS'), 10) || 15 * 1000;
const DISCORD_RETRY_MS = 30 * 1000;
const DISCORD_FAST_RETRY_MS = 4 * 1000; // quick re-sweeps right after a miss (startup race)
const BURNGLASS_REPO_URL = 'https://github.com/' + UPDATE_REPO;

function discordEnabled() { return readConfig().discordPresence === true; }
function discordClientId() {
  const c = readConfig();
  return envv('DISCORD_CLIENT_ID') ||
    (typeof c.discordClientId === 'string' && /^\d{5,25}$/.test(c.discordClientId) ? c.discordClientId : '') ||
    DISCORD_CLIENT_ID_DEFAULT;
}

const discordState = {
  status: 'off', // off | no-client-id | connecting | ok | discord-not-found | error
  error: null,
  connectedAt: null,
};
let discordSock = null;
let discordReady = false;
let discordConnecting = false;
let discordNonce = 0;
let discordLastActivity = '';
let discordNextAttemptAt = 0;
let discordNotFoundStreak = 0; // consecutive failed sweeps → fast retries first, then back off

// Candidate IPC socket paths, most likely first. Discord numbers them 0-9;
// Linux packagings (snap/flatpak) nest them one directory deeper.
function discordIpcCandidates() {
  if (envv('DISCORD_IPC')) return [envv('DISCORD_IPC')];
  const out = [];
  if (process.platform === 'win32') {
    // Discord's named pipe lives in the same object namespace under either
    // prefix; some Node/Windows combos connect via one but not the other, so
    // try both forms of each index (\\.\pipe\ then \\?\pipe\).
    for (let i = 0; i < 10; i++) {
      out.push('\\\\.\\pipe\\discord-ipc-' + i);
      out.push('\\\\?\\pipe\\discord-ipc-' + i);
    }
    return out;
  }
  const bases = [];
  for (const b of [process.env.XDG_RUNTIME_DIR, process.env.TMPDIR, '/tmp']) {
    if (b && !bases.includes(b)) bases.push(b);
  }
  for (const b of bases) {
    for (const sub of ['', 'snap.discord', 'app/com.discordapp.Discord']) {
      for (let i = 0; i < 10; i++) out.push(path.join(b, sub, 'discord-ipc-' + i));
    }
  }
  return out;
}

function discordFrame(op, obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(8);
  head.writeUInt32LE(op, 0);
  head.writeUInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

function discordDisconnect() {
  if (discordSock) { try { discordSock.destroy(); } catch (_) {} }
  discordSock = null;
  discordReady = false;
  discordLastActivity = '';
}

// Try each candidate socket in order; first successful handshake wins.
function discordConnect() {
  if (discordConnecting || discordSock) return;
  const id = discordClientId();
  if (!id) {
    discordState.status = 'no-client-id';
    discordState.error = 'No Discord application ID configured — set discordClientId in ' + homeLabel('config.json') + ' ' +
      '(create one free at discord.com/developers/applications).';
    return;
  }
  discordConnecting = true;
  const candidates = discordIpcCandidates();
  let idx = 0;
  const tryNext = () => {
    if (idx >= candidates.length) {
      discordConnecting = false;
      discordState.status = 'discord-not-found';
      discordState.error = 'Discord desktop client not found — is it running? (Browser Discord has no local IPC.) ' +
        'If Discord is open, make sure it and Burnglass run at the same privilege level (both normal, or both as admin). ' +
        'Burnglass retries automatically.';
      // Fast re-sweeps for the first few misses (covers a Discord/Pulse startup
      // race — heals in seconds instead of leaving "not found" up for 30s),
      // then back off. A one-shot timer drives the quick retries so they don't
      // wait for the slower 15s tick.
      discordNotFoundStreak++;
      const wait = discordNotFoundStreak <= 4 ? DISCORD_FAST_RETRY_MS : DISCORD_RETRY_MS;
      discordNextAttemptAt = Date.now() + wait;
      if (wait < DISCORD_TICK_MS) {
        const t = setTimeout(() => {
          if (discordEnabled() && !discordSock && !discordConnecting && Date.now() >= discordNextAttemptAt) discordConnect();
        }, wait + 50);
        if (t.unref) t.unref();
      }
      return;
    }
    const p = candidates[idx++];
    let sock;
    try { sock = net.connect(p); } catch (_) { return tryNext(); } // bad path → next candidate
    let buf = Buffer.alloc(0);
    let settled = false;
    const fail = () => {
      if (settled) return; settled = true;
      try { sock.destroy(); } catch (_) {}
      tryNext();
    };
    sock.setTimeout(3000, fail); // connect + handshake; dead Windows pipes still error instantly
    sock.on('error', () => {
      if (settled) return fail();
      // post-handshake error: drop and retry later
      discordDisconnect();
      discordState.status = 'connecting';
      discordNextAttemptAt = Date.now() + DISCORD_RETRY_MS;
    });
    sock.on('connect', () => {
      sock.write(discordFrame(0, { v: 1, client_id: id }));
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 8) {
        const len = buf.readUInt32LE(4);
        if (buf.length < 8 + len) break;
        let msg = null;
        try { msg = JSON.parse(buf.slice(8, 8 + len).toString('utf8')); } catch (_) {}
        buf = buf.slice(8 + len);
        if (!msg) continue;
        if (!settled && msg.evt === 'READY') {
          settled = true;
          discordConnecting = false;
          discordNotFoundStreak = 0; // connected — reset the fast-retry counter
          discordSock = sock;
          discordReady = true;
          discordState.status = 'ok';
          discordState.error = null;
          discordState.connectedAt = Date.now();
          console.log('[burnglass] discord presence connected (' + p + ')');
          sock.setTimeout(0);
          discordTick(); // publish immediately
        } else if (msg.evt === 'ERROR') {
          // e.g. invalid client id, or an activity Discord rejected (a bad
          // image URL) — surface it, don't hammer (the same activity is never
          // re-sent; the next real change is)
          discordState.status = 'error';
          discordState.error = 'Discord: ' + ((msg.data && msg.data.message) || 'unknown error');
          console.warn('[burnglass] discord presence: ' + discordState.error);
        } else if (settled && msg.cmd === 'SET_ACTIVITY' && !msg.evt && discordState.status === 'error') {
          // A later activity was accepted — the error is over. Without this
          // the panel showed "error" until the next reconnect.
          discordState.status = 'ok';
          discordState.error = null;
        }
      }
    });
    sock.on('close', () => {
      if (!settled) return fail();
      // Discord quit or restarted — reconnect on a later tick.
      discordDisconnect();
      if (discordEnabled()) {
        discordState.status = 'connecting';
        discordNextAttemptAt = Date.now() + 5000;
      }
    });
  };
  discordState.status = 'connecting';
  tryNext();
}

// $ and token formatting for the activity strings (server-side, tiny).
function fmtMoney(v) { return '$' + (v >= 100 ? v.toFixed(0) : v.toFixed(2)); }
function fmtTok(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return String(Math.round(v));
}
// ---------------------------------------------------------------------------
// LIVE AGENT STATE — working / thinking / waiting / idle, for the Discord
// state art. Two read-only sources:
//  1. Claude Code's own live-session registry (≥ 2.1.119):
//     ~/.claude/sessions/<pid>.json = {pid, sessionId, status, …} with status
//     busy | shell | waiting | idle, rewritten on every state change and
//     deleted on a clean exit. Undocumented — only `status` is read, anything
//     else is tolerated, nothing is ever written. `waiting` is the one signal
//     transcripts cannot give (a pending permission prompt is never logged).
//  2. Where each transcript/rollout's main thread stopped (the `conv` state
//     parseAll merges) — decides working vs thinking, and is the whole story
//     for Codex and for Claude Code builds that don't write the registry.
const LIVE_STATE_RANK = { waiting: 4, working: 3, thinking: 2, idle: 1 };
const SIDE_ACTIVE_MS = 30 * 1000;       // a subagent line this recent = the session is working
const LIVE_STATE_MAX_AGE_MS = 15 * 60 * 1000; // transcript-only states expire (crashed sessions)
function liveStateMemoMs() {
  const v = Number(envv('LIVE_STATE_MEMO_MS'));
  return Number.isFinite(v) && v >= 0 ? v : 3000;
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
}
// A crash, kill or reboot leaves <pid>.json behind, and the OS later reuses
// the pid — so "that pid is alive" is not enough. A record is only trusted
// when its file was written during THIS boot and (on Linux, where /proc gives
// the start time for free) after its process started; computeAgentState
// additionally caps how old a busy/waiting record may be.
// Boot time, fixed when Pulse starts: recomputing Date.now() − uptime on
// every scan moves with wall-clock steps (NTP, a VM resumed after host
// sleep) and would reject files written earlier in THIS boot. Only used
// where no process start time exists (not Linux); on Windows with Fast
// Startup it can be weeks old — the image-name check below is the real
// guard there.
const BOOT_AT_START = Date.now() - os.uptime() * 1000;
// Linux: a process's real start time = boot (btime in /proc/stat, re-read
// each scan because the kernel recomputes it after clock steps) + field 22
// of /proc/<pid>/stat in clock ticks (USER_HZ, 100). NOT the /proc/<pid>
// directory's ctime — procfs stamps that when the inode is first looked up.
// This alone rejects every leftover from a previous boot or a dead process.
function procBtime() {
  try { return Number((fs.readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)/m) || [])[1]) || 0; } catch (_) { return 0; }
}
function pidStartedAfter(pid, ms, btime) {
  if (process.platform !== 'linux' || !btime) return false;
  try {
    const st = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const ticks = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[19]); // comm may contain spaces/parens
    return Number.isFinite(ticks) && (btime + ticks / 100) * 1000 > ms + 2000;
  } catch (_) { return false; }
}
// Windows / macOS have no cheap start time, and PIDs are reused quickly (a
// terminal closed at a permission prompt leaves its file behind). Check what
// the pid IS: tasklist / ps (OS builtins, argv arrays) run asynchronously and
// are cached per pid; a record whose pid now runs something other than
// Claude Code is ignored. Unknown or pending = trusted for that scan.
const PID_IMAGE_TTL_MS = 10 * 60 * 1000;
const CLAUDE_IMAGE_RE = /^(claude|node|bun)\b/i;
const pidImages = new Map(); // pid -> { name, at, pending }
function pidImageMode() {
  const v = envv('IMAGE_CHECK'); // test/dev hook: ps | tasklist | off
  if (v === 'ps' || v === 'tasklist' || v === 'off') return v;
  return process.platform === 'win32' ? 'tasklist' : process.platform === 'darwin' ? 'ps' : 'off';
}
function pidLooksLikeClaude(pid, now) {
  const mode = pidImageMode();
  if (mode === 'off') return true;
  const hit = pidImages.get(pid);
  const fresh = hit && !hit.pending && now >= hit.at && now - hit.at < PID_IMAGE_TTL_MS;
  if (!fresh && !(hit && hit.pending)) {
    if (pidImages.size > 512) pidImages.clear();
    pidImages.set(pid, { name: hit ? hit.name : null, at: hit ? hit.at : 0, pending: true });
    const done = (name) => pidImages.set(pid, { name, at: Date.now(), pending: false });
    try {
      const args = mode === 'tasklist' ? ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'] : ['-o', 'comm=', '-p', String(pid)];
      require('child_process').execFile(mode === 'tasklist' ? 'tasklist' : 'ps', args, { windowsHide: true, timeout: 5000 }, (err, out) => {
        let name = null;
        if (!err && typeof out === 'string') {
          const s = out.trim();
          if (mode === 'tasklist') {
            const m = s.match(/^"([^"]+)","(\d+)"/); // "claude.exe","1234",…
            if (m && Number(m[2]) === pid) name = m[1];
          } else if (s) name = path.basename(s.split('\n')[0].trim());
        }
        done(name);
      });
    } catch (_) { done(null); }
  }
  return !hit || !hit.name || CLAUDE_IMAGE_RE.test(hit.name);
}
let claudeRegistryMemo = { at: 0, list: [] };
function claudeLiveRegistry(now) {
  if (now >= claudeRegistryMemo.at && now - claudeRegistryMemo.at < liveStateMemoMs()) return claudeRegistryMemo.list;
  const list = [];
  const dir = path.join(claudeDir(), 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) {}
  // Filter by name and by the pid in the NAME (Claude Code names the file
  // after its own pid) BEFORE capping: the directory also holds a
  // <pid>.<hash>.key peer-token file per session (never read) and leftovers.
  const live = names.filter((n) => /^\d{1,10}\.json$/.test(n) && pidAlive(parseInt(n, 10))).slice(0, 256);
  const linux = process.platform === 'linux';
  const btime = linux ? procBtime() : 0;
  for (const n of live) {
    const f = path.join(dir, n);
    let st, j = null;
    try { st = fs.statSync(f); } catch (_) { continue; }
    if (!st.isFile() || st.size > 64 * 1024) continue;
    const pid = parseInt(n, 10);
    if (linux ? pidStartedAfter(pid, st.mtimeMs, btime) // pid reused by a newer process
      : st.mtimeMs < BOOT_AT_START - 60 * 1000) continue; // written before this boot
    if (!pidLooksLikeClaude(pid, now)) continue; // Windows/macOS: the pid now runs something else
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { continue; }
    if (!j || typeof j !== 'object' || typeof j.status !== 'string') continue;
    list.push({ sessionId: typeof j.sessionId === 'string' ? j.sessionId : '', status: j.status, writtenAt: st.mtimeMs });
  }
  claudeRegistryMemo = { at: now, list };
  return list;
}

// One session's state from its transcript alone (null = not live).
function convState(c, now) {
  if (!c) return null;
  const sideLive = !!c.sideTs && now - c.sideTs <= SIDE_ACTIVE_MS;
  // A long Agent/Task run: the main thread is quiet but its subagents write.
  if (!c.kind || now - c.ts > LIVE_STATE_MAX_AGE_MS) return sideLive ? 'working' : null;
  if (c.kind === 'tool_use' && c.open.length) return c.open.some((n) => WAITING_TOOLS.has(n)) ? 'waiting' : 'working';
  if (c.kind === 'prompt' || c.kind === 'tool_result' || c.kind === 'tool_use') return sideLive ? 'working' : 'thinking';
  return sideLive ? 'working' : 'idle';
}
// How long a registry record may go without any sign of life before it is
// treated as a leftover (Windows/macOS have no cheap process start time).
const REG_BUSY_MAX_MS = Number(envv('REG_BUSY_MAX_MS')) || 6 * 60 * 60 * 1000; // env: test hook
const REG_IDLE_MAX_MS = 24 * 60 * 60 * 1000;

// → { provider, state, sessions, source } for the most urgent live session,
// or null. Ranking: waiting > working > thinking > idle.
function computeAgentState(conv, now) {
  conv = conv || {};
  const states = [];
  const reg = claudeLiveRegistry(now);
  let trusted = 0;
  // `claude --resume` keeps the sessionId, so a crashed process's record and
  // the resumed one can share it: only the newest may borrow the transcript
  // as its sign of life, or the leftover would never age out.
  const newestBySid = new Map();
  for (const r of reg) if (!(newestBySid.get(r.sessionId) >= r.writtenAt)) newestBySid.set(r.sessionId, r.writtenAt);
  for (const r of reg) {
    const c = conv[r.sessionId];
    const sideLive = !!(c && c.sideTs) && now - c.sideTs <= SIDE_ACTIVE_MS;
    const lastSign = r.writtenAt >= newestBySid.get(r.sessionId)
      ? Math.max(r.writtenAt, c ? c.ts : 0, c ? c.sideTs : 0) : r.writtenAt;
    let state = null;
    if (r.status === 'waiting') {
      if (now - r.writtenAt <= REG_IDLE_MAX_MS) state = 'waiting';
    } else if (r.status === 'busy' || r.status === 'shell') {
      if (now - lastSign <= REG_BUSY_MAX_MS) {
        const open = c ? c.open : [];
        state = open.some((n) => WAITING_TOOLS.has(n)) ? 'waiting'
          : open.length || sideLive || r.status === 'shell' ? 'working' : 'thinking';
      }
    } else if (r.status === 'idle') {
      if (now - lastSign <= REG_IDLE_MAX_MS) state = sideLive ? 'working' : 'idle';
    }
    if (state) { trusted++; states.push({ provider: 'claude', state, source: 'claude-status' }); }
  }
  // The registry is authoritative for Claude whenever it lists a trusted
  // live session: a session missing from it has exited. Otherwise (older
  // Claude Code, a build that doesn't write it, only leftovers) fall back to
  // the transcripts.
  for (const sid in conv) {
    const c = conv[sid];
    if (c.provider === 'claude' && trusted) continue;
    const state = convState(c, now);
    if (state) states.push({ provider: c.provider, state, source: 'transcript' });
  }
  if (!states.length) return null;
  let best = states[0];
  const byProvider = {};
  for (const s of states) {
    if (LIVE_STATE_RANK[s.state] > LIVE_STATE_RANK[best.state]) best = s;
    const cur = byProvider[s.provider];
    if (!cur || LIVE_STATE_RANK[s.state] > LIVE_STATE_RANK[cur]) byProvider[s.provider] = s.state;
  }
  return { provider: best.provider, state: best.state, sessions: states.length, source: best.source, byProvider };
}

// Human model name for the presence line: claude-opus-5-5 → "Opus 5.5",
// claude-3-5-sonnet-20241022 → "Sonnet 3.5", gpt-6-sol → "GPT-6 Sol",
// gpt-5.3-codex → "GPT-5.3 Codex", glm-5.1 → "GLM-5.1". Partner-cloud forms
// are canonicalized first and date stamps (Anthropic -YYYYMMDD, OpenAI
// -YYYY-MM-DD) and -latest dropped; anything unrecognised is shown as-is.
function prettyModelName(model) {
  if (!model) return '';
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  let m = canonicalClaudeModel(canonicalOpenAIModel(String(model))).replace(/\[1m\]$/, '')
    .replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2}|latest)$/, '');
  if (m.startsWith('claude-')) {
    const parts = m.slice(7).split('-');
    const fam = parts.filter((p) => /^[a-z]/.test(p) && !/^v\d+$/.test(p));
    const ver = parts.filter((p) => /^\d+$/.test(p));
    return fam.length ? fam.map(cap).join(' ') + (ver.length ? ' ' + ver.join('.') : '') : m;
  }
  if (m.startsWith('gpt-')) {
    const [v, ...rest] = m.slice(4).split('-');
    return /^\d/.test(v) ? 'GPT-' + v + (rest.length ? ' ' + rest.map(cap).join(' ') : '')
      : 'GPT ' + [v, ...rest].map(cap).join(' ');
  }
  if (m.startsWith('glm-')) return 'GLM-' + m.slice(4);
  return m;
}
// Effort level as the presence shows it ("Sonnet 5 · Medium"): xhigh reads as
// "Extra High"; unknown levels are just capitalised.
const EFFORT_LABELS = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max' };
function effortLabel(effort) {
  if (!effort) return '';
  return EFFORT_LABELS[effort] || effort.charAt(0).toUpperCase() + effort.slice(1);
}

// Compose the activity from the same aggregates the dashboard shows.
// buildSummary() is mtime-cached, so a 15s cadence costs ~the same as one
// dashboard poll. Numbers shown: today's spend/tokens + live window meters.
// Page rotation cadence: default 45s (comfortably above Discord's 15s update
// floor), configurable via discordRotateSecs (clamped 15–300) or the test
// hook PULSE_DISCORD_ROTATE_MS. Pages derive from the wall clock, so no
// rotation state survives reconnects — it just keeps cycling.
const DISCORD_ROTATE_MS_DEFAULT = 45 * 1000;
function discordRotateMs() {
  const env = parseInt(envv('DISCORD_ROTATE_MS'), 10);
  if (isFinite(env) && env >= 500) return env;
  const c = readConfig().discordRotateSecs;
  if (typeof c === 'number' && isFinite(c)) return Math.min(300, Math.max(15, c)) * 1000;
  return DISCORD_ROTATE_MS_DEFAULT;
}

// Discord's elapsed-time counter is anchored to `timestamps.start`. Anchoring
// it to SERVER_START would reset the timer to 0 on every process restart —
// including the relaunch a self-update performs — which is jarring (your
// "Pulse for 3h" jumps back to 0s just because it updated). So we PERSIST the
// anchor to ~/.burnglass and reuse it when Burnglass was only briefly down: definitely
// on a post-update relaunch (IS_AFTER_UPDATE), and on a quick manual restart
// (last heartbeat within the grace window). A cold start after a long gap
// resets, so the counter never shows a misleading multi-day age.
const DISCORD_START_GRACE_MS = 10 * 60 * 1000;
function discordStartFilePath() { return path.join(appHome(), 'discord-presence.json'); }
let discordStart = null;         // resolved presence anchor (ms epoch)
let discordStartLastSaved = 0;   // last heartbeat write (throttle)
function persistDiscordStart(now) {
  if (discordStart == null) return;
  try {
    fs.mkdirSync(appHome(), { recursive: true });
    fs.writeFileSync(discordStartFilePath(), JSON.stringify({ start: discordStart, savedAt: now }));
    discordStartLastSaved = now;
  } catch (_) { /* home unwritable → timer just resets next relaunch */ }
}
function discordPresenceStart() {
  if (discordStart != null) return discordStart;
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(discordStartFilePath(), 'utf8')); } catch (_) {}
  // Anchor must be a plausible recent epoch: not in the future, and not absurdly
  // old (a corrupt/zero value would otherwise show a nonsense multi-year timer).
  const validPrev = prev && typeof prev.start === 'number' && isFinite(prev.start)
    && prev.start <= SERVER_START && (SERVER_START - prev.start) < 400 * 86400e3;
  const recent = validPrev && typeof prev.savedAt === 'number' && (SERVER_START - prev.savedAt) < DISCORD_START_GRACE_MS;
  // Reuse the old anchor across an update relaunch or a brief restart; else
  // begin a fresh session at this process's start.
  discordStart = (validPrev && (IS_AFTER_UPDATE || recent)) ? prev.start : SERVER_START;
  persistDiscordStart(SERVER_START);
  return discordStart;
}

// Per-state Claude art (Server panel → Discord images); an empty slot falls
// back to the Claude Code image.
const DISCORD_STATE_SLOTS = { working: 'discordClaudeWorkingImage', thinking: 'discordClaudeThinkingImage', waiting: 'discordClaudeWaitingImage' };
const DISCORD_STATE_TEXT = { working: 'working', thinking: 'thinking', waiting: 'waiting for you' };
// Working ↔ thinking flip every few seconds — faster than a 15 s tick can
// show honestly, and every image swap makes viewers reload a GIF. Once one of
// the two is on screen, the other must persist for the hold before taking
// over. Waiting and idle switch at once: those you want to see immediately.
// The same goes for the PROVIDER: with Claude and Codex both mid-turn the
// top-ranked one alternates with Claude's tool/think phase, so while the
// shown provider is still busy, another busy one doesn't take over inside
// the hold. The hold only ever applies within one provider.
let discordShownState = { prov: null, state: null, since: 0 };
function discordStateHoldMs() {
  const v = Number(envv('DISCORD_STATE_HOLD_MS'));
  return Number.isFinite(v) && v >= 0 ? v : 45 * 1000;
}
// ag = computeAgentState() result or null → the { prov, state } to show.
function heldAgentState(ag, now) {
  const cur = discordShownState;
  const busy = (st) => st === 'working' || st === 'thinking';
  let prov = ag ? ag.provider : null;
  let state = ag ? ag.state : null;
  if (ag && cur.prov && busy(cur.state) && now - cur.since < discordStateHoldMs()) {
    const curNow = ag.byProvider ? ag.byProvider[cur.prov] : null; // the shown provider, right now
    if (prov !== cur.prov && busy(state) && busy(curNow)) { prov = cur.prov; state = curNow; }
    if (prov === cur.prov && busy(state) && state !== cur.state) state = cur.state;
  }
  if (prov !== cur.prov || state !== cur.state) discordShownState = { prov, state, since: now };
  return { prov, state };
}

function buildDiscordActivity() {
  let s = null;
  try { s = buildSummary(null, { background: true }); } catch (_) { return null; }
  if (!s) return null;
  // One period per page — Today / Past 7 days / All-time — alternating on
  // the shared clock. First line: tokens + spend, nothing else.
  const pages = [
    { label: 'Today', tokens: s.today.tokens, cost: s.today.cost },
    { label: 'Past 7 days', tokens: s.week.tokens, cost: s.week.cost },
    { label: 'All-time', tokens: s.totals.tokens, cost: s.totals.cost },
  ];
  const p = pages[Math.floor(Date.now() / discordRotateMs()) % pages.length];
  const details = p.label + ': ' + fmtTok(p.tokens) + ' tokens · ' + fmtMoney(p.cost);
  // The large logo tracks who you're actively using: Claude → the Claude art,
  // Codex → the Codex art, idle → Pulse. Asset keys must exist in the Discord
  // application's Rich Presence art (upload images keyed claude / codex / pulse);
  // an unknown key just renders no image, so this degrades cleanly. Each key is
  // overridable in config (discordClaudeImage / discordCodexImage / discordLargeImage).
  const cfg = readConfig();
  // Live state (working / thinking / waiting / idle — see computeAgentState).
  // A session that is working or waiting on you keeps its provider's art
  // even after 15 quiet minutes: a pending permission prompt writes nothing.
  const ag = cfg.discordShowState === false ? null : s.agentState;
  const shown = heldAgentState(ag, Date.now());
  let prov = s.activeProvider;
  if (shown.prov && shown.state && shown.state !== 'idle') prov = shown.prov;
  const live = shown.prov === prov ? shown.state : null;
  const claudeArt = (live && DISCORD_STATE_SLOTS[live] && cfg[DISCORD_STATE_SLOTS[live]]) || cfg.discordClaudeImage || 'claude';
  const asset = prov === 'codex' ? (cfg.discordCodexImage || 'codex')
    : prov === 'claude' ? claudeArt
    : (cfg.discordLargeImage || 'pulse');
  const verb = live && DISCORD_STATE_TEXT[live];
  const assetText = prov === 'codex' ? (verb ? 'OpenAI Codex · ' + verb : 'Using OpenAI Codex')
    : prov === 'claude' ? (verb ? 'Claude Code · ' + verb : 'Using Claude Code')
    : 'Burnglass — idle';
  // Second line while active: "Opus 5.5 · Extra High · 3 sessions" — the
  // model + effort you're running and how many sessions are live. Absent when
  // idle (the activity collapses back to one line). Friends can see presence,
  // so it can be turned off with config `discordShowModel: false`.
  let state;
  const an = s.activeNow;
  if (an && an.provider === prov && cfg.discordShowModel !== false) {
    const parts = [prettyModelName(an.model), an.ultracode ? 'Ultracode' : effortLabel(an.effort)];
    if (an.sessions > 0) parts.push(an.sessions + (an.sessions === 1 ? ' session' : ' sessions'));
    const line = parts.filter(Boolean).join(' · ').slice(0, 128);
    if (line.length >= 2) state = line; // Discord rejects a 1-char state
  }
  return {
    details: details.slice(0, 128),
    ...(state ? { state } : {}),
    timestamps: { start: discordPresenceStart() }, // persisted → survives update relaunches
    assets: {
      large_image: asset,
      large_text: assetText,
    },
    buttons: [{ label: 'Get Burnglass', url: BURNGLASS_REPO_URL }],
    instance: false,
  };
}

function discordSetActivity(activity) {
  if (!discordSock || !discordReady) return;
  try {
    discordSock.write(discordFrame(1, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity },
      nonce: String(++discordNonce),
    }));
  } catch (_) { discordDisconnect(); }
}

function discordTick() {
  if (!discordEnabled()) return;
  if (!discordSock) {
    if (Date.now() >= discordNextAttemptAt) discordConnect();
    return;
  }
  const act = buildDiscordActivity();
  if (!act) return;
  // Heartbeat the persisted anchor (throttled) so a brief manual restart also
  // continues the timer, not just post-update relaunches.
  const nowTs = Date.now();
  if (nowTs - discordStartLastSaved >= 60000) persistDiscordStart(nowTs);
  const key = JSON.stringify(act);
  if (key === discordLastActivity) return; // only send real changes
  discordLastActivity = key;
  discordSetActivity(act);
}

let discordTimer = null;
function startDiscordLoop() {
  if (discordTimer) return;
  discordTimer = setInterval(discordTick, DISCORD_TICK_MS);
  if (discordTimer.unref) discordTimer.unref(); // never keep the process alive
  if (discordEnabled()) discordTick();
}

// The three large-image slots and their config keys. A slot holds a
// Developer-Portal Art Asset key, an https link (the ONLY way Discord
// animates a GIF / animated WebP), or nothing (= the built-in key).
const DISCORD_IMAGE_SLOTS = {
  claude: 'discordClaudeImage', claudeWorking: 'discordClaudeWorkingImage', claudeThinking: 'discordClaudeThinkingImage',
  claudeWaiting: 'discordClaudeWaitingImage', codex: 'discordCodexImage', idle: 'discordLargeImage',
};
const DISCORD_IMAGE_MAX = 256; // Discord's external-asset URL limit

// Validate one slot value from the dashboard → { value } (null clears the
// slot) or { error }. Discord's image proxy — never Pulse — fetches a link,
// so this only has to keep junk and non-https schemes out of the presence.
function validDiscordImage(raw) {
  if (raw === null || raw === undefined) return { value: null };
  if (typeof raw !== 'string') return { error: 'must be text' };
  const v = raw.trim();
  if (!v) return { value: null };
  if (v.length > DISCORD_IMAGE_MAX) return { error: 'is longer than ' + DISCORD_IMAGE_MAX + ' characters (Discord\'s limit)' };
  if (!/^[\x21-\x7e]+$/.test(v)) return { error: 'contains spaces or unsupported characters' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) {
    // The raw string must itself be a well-formed https://host link: the URL
    // parser forgives "https:host/x", "https:/host" and backslashes, but
    // Discord gets the raw string, not the normalized one.
    let u = null;
    try { u = new URL(v); } catch (_) {}
    if (!u || u.protocol !== 'https:' || !u.hostname || !/^https:\/\/[^/\\?#@]/i.test(v) || v.includes('\\')) {
      return { error: 'must be an https:// link (Discord ignores http and other schemes)' };
    }
    // The presence is public: never publish credentials embedded in a link.
    if (u.username || u.password) return { error: 'must not contain a username or password' };
    return { value: 'https://' + v.slice(8) }; // lowercase scheme
  }
  // Art Asset key: Discord lowercases keys on upload.
  if (!/^[a-z0-9_.-]{1,64}$/i.test(v)) return { error: 'is neither an https:// link nor an art-asset key' };
  return { value: v.toLowerCase() };
}

function discordImagesForPayload() {
  const cfg = readConfig();
  const out = {};
  for (const [slot, key] of Object.entries(DISCORD_IMAGE_SLOTS)) {
    out[slot] = typeof cfg[key] === 'string' && cfg[key] ? cfg[key] : null;
  }
  return out;
}

function discordForPayload() {
  const images = discordImagesForPayload();
  if (!discordEnabled()) return { enabled: false, status: 'off', images };
  return { enabled: true, status: discordState.status === 'off' ? 'connecting' : discordState.status, error: discordState.error, images };
}

// ---------------------------------------------------------------------------
// STATUSLINE FEED (§7)
// A tiny projection for `pulse --statusline` — today's cross-tool spend, the
// current 5-hour block, and the official meter percentages Pulse already
// caches. Memoized ~3s so the frequently-invoked statusline never triggers a
// heavy rebuild, and (crucially) so it reads Pulse's CACHED meters rather than
// hitting the provider endpoints itself — one shared poller, no 429 storms.
// ---------------------------------------------------------------------------
let statuslineMemo = { at: 0, data: null };
function statuslineMeterPcts(s) {
  const out = {};
  if (s.meters && s.meters.enabled && Array.isArray(s.meters.buckets)) {
    const fh = s.meters.buckets.find((b) => b.key === 'five_hour');
    const wk = s.meters.buckets.find((b) => b.key === 'seven_day' || b.key === 'seven_day_overall');
    if (fh) out.claudeFiveHour = Math.round(fh.pct);
    // Additive: the tray shows its neutral base icon for stale data (the
    // tooltip still carries the last %).
    if (fh && fh.stale) out.claudeFiveHourStale = true;
    if (wk) out.claudeWeekly = Math.round(wk.pct);
  }
  if (s.codexMeters && Array.isArray(s.codexMeters.buckets)) {
    const cw = s.codexMeters.buckets.find((b) => b.key === 'codex_secondary' && !b.stale);
    if (cw) out.codexWeekly = Math.round(cw.pct);
  }
  return out;
}
function trayLevels() {
  const th = alertThresholds();
  const warn = th[0];
  const crit = th.length > 1 ? th[th.length - 1] : Math.max(95, warn);
  return { warn, crit };
}
function statuslineData() {
  const now = Date.now();
  if (statuslineMemo.data && now - statuslineMemo.at < 3000) return statuslineMemo.data;
  let s = null;
  try { s = buildSummary(null, { background: true }); } catch (_) {}
  const d = s ? {
    today: { cost: s.today.cost, tokens: s.today.tokens },
    week: { cost: s.week.cost, tokens: s.week.tokens },
    block: (s.currentBlock && s.currentBlock.end > now)
      ? { cost: s.currentBlock.cost, endsAt: s.currentBlock.end, official: !!s.currentBlock.official }
      : null,
    meters: statuslineMeterPcts(s),
    // The tray polls this feed; when the toggle turns the tray off it sees
    // trayEnabled:false here and exits itself. trayDesired covers a
    // flag-started tray with no config key.
    trayEnabled: trayDesired !== null ? trayDesired : readConfig().tray === true,
    stripEnabled: readConfig().strip === true,
    // Additive: the tray's warn/crit levels = the dashboard's alertThresholds,
    // so the icon, the meters and the notifications always agree.
    trayLevels: trayLevels(),
    version: PULSE_VERSION,
  } : { today: null, trayEnabled: trayDesired !== null ? trayDesired : readConfig().tray === true, stripEnabled: readConfig().strip === true, version: PULSE_VERSION };
  statuslineMemo = { at: now, data: d };
  return d;
}

// How stale a background consumer (status line / Discord) tolerates before it
// trickles a refresh. The dashboard refreshes at the normal cadence
// (METERS_OK_MS); background paths only poll the shared usage endpoint this
// rarely, so Pulse isn't hammering it 24/7 when no one's watching the card.
// With the TRAY enabled the strip/icon is a live gauge on the taskbar — a
// permanently-visible consumer — so the trickle tightens to 5 minutes.
const BACKGROUND_METERS_MS = 15 * 60 * 1000;
const TRAY_METERS_MS = 5 * 60 * 1000;

// Lazily refresh on summary builds; serve the cached state immediately.
// background=true (status line, Discord) only triggers a refresh when the data
// is already quite stale; the dashboard (background=false) uses the normal gate.
// Per-bucket (ts, pct) sample history for the "~N% left at reset" projection.
// In-memory only, bounded, and self-clearing when a window rolls over (a pct
// DROP means the window reset — earlier samples describe a dead window).
const METER_PROJ_MIN_MS = parseInt(envv('METER_PROJ_MIN_MS') || '', 10) || 10 * 60e3;
const METER_PROJ_WINDOW_MS = 2 * 3600e3; // project from at most the last 2h
const _meterSamples = new Map(); // key -> { resetsAt, arr: [{ts, pct}] }
function recordMeterSamples(buckets) {
  const now = Date.now();
  for (const b of buckets) {
    if (typeof b.pct !== 'number' || !isFinite(b.pct)) continue;
    let st = _meterSamples.get(b.key);
    if (!st) { st = { resetsAt: b.resetsAt || null, arr: [] }; _meterSamples.set(b.key, st); }
    // A window roll shows up as the pct FALLING or resets_at JUMPING a whole
    // window forward — and a roll under load can land the new pct HIGHER than
    // the old one, so the pct check alone is not enough. Dead-window samples
    // must never pollute the new window's slope. The 2-minute tolerance
    // absorbs server-side jitter in the reported reset time.
    const resetJumped = b.resetsAt && st.resetsAt && Math.abs(b.resetsAt - st.resetsAt) > 120e3;
    const pctDropped = st.arr.length && b.pct < st.arr[st.arr.length - 1].pct - 0.5;
    if (resetJumped || pctDropped) st.arr.length = 0;
    if (b.resetsAt) st.resetsAt = b.resetsAt;
    st.arr.push({ ts: now, pct: b.pct });
    while (st.arr.length && now - st.arr[0].ts > METER_PROJ_WINDOW_MS) st.arr.shift();
    if (st.arr.length > 200) st.arr.splice(0, st.arr.length - 200);
  }
}
// Straight-line projection of "% left when the window resets" from the recent
// burn rate. Only offered with enough observation time and a real reset time;
// a flat or falling trend projects to the CURRENT remaining (no invention).
function projectedLeftAtReset(b) {
  if (typeof b.pct !== 'number' || !b.resetsAt) return null;
  const st = _meterSamples.get(b.key);
  const arr = st && st.arr;
  if (!arr || arr.length < 2) return null;
  const first = arr[0], last = arr[arr.length - 1];
  if (last.ts - first.ts < METER_PROJ_MIN_MS) return null;
  const slope = (last.pct - first.pct) / (last.ts - first.ts); // pct per ms
  const remainingMs = b.resetsAt - Date.now();
  if (remainingMs <= 0) return null;
  const projUsed = b.pct + Math.max(0, slope) * remainingMs;
  return Math.max(0, Math.round(100 - projUsed));
}

function metersForPayload(background) {
  if (!metersEnabled()) return { enabled: false };
  const due = Date.now() >= (metersState.nextAttemptAt || 0);
  const trayOn = trayDesired !== null ? trayDesired : readConfig().tray === true;
  const bgWindow = trayOn ? TRAY_METERS_MS : BACKGROUND_METERS_MS;
  const bgOk = !background || (Date.now() - (metersState.fetchedAt || 0) >= bgWindow);
  if (due && bgOk) {
    refreshAccountMeters(); // async; next poll picks it up
  }
  return {
    enabled: true,
    status: metersState.status === 'off' ? 'loading' : metersState.status,
    // Attach the burn-rate projection per bucket (null until observed long
    // enough). Fresh objects — the state buckets stay unclobbered.
    buckets: (metersState.buckets || []).map((b) => ({ ...b, projLeftAtReset: projectedLeftAtReset(b) })),
    fetchedAt: metersState.fetchedAt,
    lastGoodAt: metersState.lastGoodAt,
    error: metersState.error,
  };
}

// The built React frontend (Vite output). Served as static files; the server
// itself keeps zero RUNTIME dependencies — the React toolchain is build-time
// only (see web/). Run `npm run build` if this directory is missing.
const WEB_DIR = path.join(__dirname, 'web', 'dist');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

// Serve a file from WEB_DIR for the given request path. Returns true if handled.
// Path-traversal safe: the resolved path must stay within WEB_DIR. Unknown
// non-asset routes fall back to index.html (SPA). Returns false only when the
// frontend build is missing entirely.
function serveStatic(route, res) {
  let rel = decodeURIComponent(route);
  if (rel === '/' || rel === '') rel = '/index.html';

  // Packaged binary: serve from embedded SEA assets.
  if (seaApi) {
    let target = rel;
    let buf = seaAsset('web/dist' + rel);
    if (!buf) { target = '/index.html'; buf = seaAsset('web/dist/index.html'); } // SPA fallback
    if (!buf) return false;
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': target === '/index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    });
    res.end(buf);
    return true;
  }

  const indexFile = path.join(WEB_DIR, 'index.html');
  if (!fs.existsSync(indexFile)) return false; // not built
  // Resolve within WEB_DIR and reject anything that escapes it.
  const resolved = path.normalize(path.join(WEB_DIR, rel));
  let target = resolved;
  if (!target.startsWith(WEB_DIR) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    target = indexFile; // SPA fallback (also covers deep links / unknown routes)
  }
  const ext = path.extname(target).toLowerCase();
  const type = CONTENT_TYPES[ext] || 'application/octet-stream';
  // Immutable hashed assets can cache hard; index.html must not.
  const cache = target === indexFile ? 'no-store' : 'public, max-age=31536000, immutable';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
  res.end(fs.readFileSync(target));
  return true;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

// Guard for endpoints with side effects (stop, update). Any web page can fire
// simple POSTs at localhost, so require a custom header — that forces a CORS
// preflight no cross-origin page ever passes (we send no CORS headers) — plus
// a loopback source address and a localhost Host header (DNS-rebinding guard).
function allowMutation(req, res) {
  const ra = req.socket.remoteAddress || '';
  const isLoop = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
  const hostHdr = String(req.headers.host || '')
    .replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  // `X-Pulse: 1` is the FROZEN wire header (v1 servers accept only it, and
  // the web app, tray and old strips send it); `X-Burnglass: 1` is an alias.
  const marked = req.headers['x-pulse'] === '1' || req.headers['x-burnglass'] === '1';
  if (req.method === 'POST' && isLoop && LOOPBACK_HOSTS.has(hostHdr) && marked) {
    return true;
  }
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'forbidden' }));
  return false;
}

// DNS-rebinding guard for data reads. A malicious page can point its own
// hostname at 127.0.0.1 and fetch same-origin — the browser then happily
// exposes the response. When Pulse is bound to loopback, only answer requests
// whose Host header is a loopback name. (An explicit --host network bind is
// the documented VPS opt-in, where foreign Hosts are expected.)
function allowRead(req, res, boundLoopback) {
  if (!boundLoopback) return true;
  const hostHdr = String(req.headers.host || '')
    .replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (LOOPBACK_HOSTS.has(hostHdr)) return true;
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'forbidden' }));
  return false;
}

// Read a small JSON request body. Pulse's mutation routes are otherwise all
// query-string driven; this exists because a SECRET (the Meshy API key) must
// not travel in a URL, where it would land in server logs, browser history
// and Referer headers — and it also carries the Discord image links, which
// are URLs themselves. Size-capped, and every failure path answers the
// callback exactly once.
function readJsonBody(req, limitBytes, cb) {
  cb = once(cb);
  let body = '';
  let overflowed = false;
  req.setEncoding('utf8');
  req.on('data', (d) => {
    if (overflowed) return;
    body += d;
    if (body.length > limitBytes) {
      overflowed = true;
      body = ''; // don't keep a partial secret around any longer than needed
      req.destroy();
      cb(new Error('request body too large'));
    }
  });
  req.on('end', () => {
    if (overflowed) return;
    if (!body.trim()) return cb(null, {}); // empty body is a valid "no fields"
    let j;
    try { j = JSON.parse(body); } catch (e) { return cb(new Error('invalid JSON body')); }
    cb(null, j && typeof j === 'object' ? j : {});
  });
  req.on('error', (e) => cb(e));
  req.on('aborted', () => cb(new Error('request aborted')));
}

// Probe whether a running instance answers /api/health on the port.
// cb receives { kind: 'pulse', version } | { kind: 'other' } | { kind: 'free' }.
function probeInstance(port, cb) {
  cb = once(cb); // error/timeout/end can otherwise race a double call
  const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; if (body.length > 65536) req.destroy(); });
    res.on('end', () => {
      try {
        const j = JSON.parse(body);
        if (j && j.ok) return cb({ kind: 'pulse', version: j.version || null });
      } catch (_) {}
      cb({ kind: 'other' });
    });
    res.on('error', () => cb({ kind: 'other' }));
  });
  req.on('timeout', () => { req.destroy(); cb({ kind: 'other' }); });
  req.on('error', (e) => cb(e && e.code === 'ECONNREFUSED' ? { kind: 'free' } : { kind: 'other' }));
}

// What to call a running instance by its /api/health version: v1 was Pulse.
function instanceName(version) {
  return version && versionNum(version) >= versionNum('2.0.0-alpha') ? BRAND : 'Pulse';
}

// Port taken — say WHO has it. The classic upgrade trap is double-clicking a
// new pulse.exe while the old one still runs; name that case explicitly.
function diagnosePortConflict(port) {
  probeInstance(port, (inst) => {
    if (inst.kind === 'pulse') {
      const v = inst.version ? 'v' + inst.version : 'an older version (v1.0.3 or earlier)';
      console.error(`\n[burnglass] Another ${instanceName(inst.version)} — ${v} — is already running on port ${port}.`);
      if (inst.version === PULSE_VERSION) {
        console.error(`[burnglass] The dashboard is already available: http://localhost:${port}`);
      } else {
        console.error(`[burnglass] This is v${PULSE_VERSION}. Stop the old one first — from its dashboard`);
        console.error('[burnglass] (Server panel → Stop), its console window, or Task Manager →');
        console.error('[burnglass] burnglass.exe / pulse.exe → End task — then run this again.');
      }
    } else {
      console.error(`\n[burnglass] Port ${port} is already in use by another program.`);
      console.error('[burnglass] Try: --port 4748   (or set PORT=)');
    }
    holdOpenAndExit(1);
  });
}

// A double-clicked exe's console closes with the process — pause so the
// message is actually readable. No-op when piped, scripted, or headless.
function holdOpenAndExit(code) {
  if (seaApi && process.platform === 'win32' && process.stdin.isTTY && !IS_DAEMON_CHILD) {
    console.error('\nPress Enter to close…');
    try {
      process.stdin.resume();
      process.stdin.once('data', () => process.exit(code));
      return;
    } catch (_) {}
  }
  process.exit(code);
}

function openBrowser(port) {
  if (process.platform !== 'win32') return;
  // windowsHide: launched from the hidden daemon, cmd.exe must not flash a
  // console; `start` (ShellExecute) still opens the default browser fine.
  try { require('child_process').exec(`start "" "http://localhost:${port}"`, { windowsHide: true }); } catch (_) {}
}

// ---------------------------------------------------------------------------
// WINDOWS TRAY (opt-in: --tray or {"tray": true})
// A hand-rolled notification-area icon with zero dependencies: Burnglass
// writes a PowerShell script to its home (the only writable location) and
// spawns it detached. The script owns a WinForms NotifyIcon: tooltip refreshed
// from the slim /api/statusline feed (loopback only — the tray never talks to
// any provider), left-click opens the mini overview, right-click menu offers
// the dashboard / mini / Stop Burnglass / Exit tray. A named mutex (per port,
// FROZEN as `PulseTray<port>` so a v1 icon and a v2 icon exclude each other
// during the upgrade handoff) makes it single-instance, and it exits by
// itself once the server stops answering.
//
// Icons follow the brand guide (BRAND.md "Tray"): the tray NEVER loads the app
// icon (its ember dot sits in the status slot and would read as a warning).
// It shows `tray-base` (ice dot) when meters are off / no login / stale /
// loading, and swaps the WHOLE icon to `tray-status-{good,warn,crit}` for the
// live Claude 5-hour window — good = solid green disc, warn = yellow ring,
// crit = red disc with a white bar — at the dashboard's alertThresholds
// (default 80 / 95). Shape carries the state; the tooltip carries the %.
// The per-size PNGs (16/20/24/32, picked from the DPI's small-icon size) are
// embedded below as base64, decoded once at start: no per-tick GDI churn.
// ---------------------------------------------------------------------------
// Generated from the brand kit (tray-base-N.png, tray-status-<state>-N.png).
const TRAY_ICONS = {
  base: {
    16: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAB/ElEQVR4nIxTzWsTURD/vdetrGklVqNJiPjVkwXxJHowEA+KsaDgQXvQgwe9eLOlKOLJSKpS/CtEbyJSvw5qsvTmRTx40BaKFI0nixabpDvTeS/7tkm/6MDs7G9+M495M2+8noGjGc3qIYNPK6XSzAylALCo/DgsRqzDqib8O1I86inixwwaMjldiV4YWZz/BwUTTBbb5MhGOC38FcXo1qCwaDxEhOyp81YNZgpbGeJ3fDs2vCIqagFJFqfSGrkzF6xyVDPHwcK3Her8xJTULSdh17EC/FTa6u7jhSiI4PjOQyjmtTtxz7lLcNJ/8Soye/fF5aZ29GFsrIRq9T2C4APK5RJSO/ssrxL7B9h09+TLT2iXy1kfs9NTGL9xDXdvj2Bw8GwHPzHxCsM3R+HZCqJur5TcwX7UZSL5fH4VZ31yHR13ex2x/LokL/dgLZmd+g5/awJBpbKKMz6T59nuytT+fP2M7YeOWHJh5htuXR9GbWbaFle+V0Kj2cSJ6CqTQYBH5Qd2CsrPHrD1pwtFHL4zbgO+3Jfkj6+xGdHuUfyqvMH/3z+t1qpvOx7RRtZMYU6mkDQz/fHiSas3zQYQ70K75ah3ESaeU1tSuafyDoYM2b0taYPC+b9u6za0GnjW5ff4kyEp2S5kwvpCLzXqHWu3llVMNfk+93RjZAkAAP//EzMXwwAAAAZJREFUAwDaZmael8H3YwAAAABJRU5ErkJggg==',
    20: 'iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAACl0lEQVR4nJRUXUiTURh+zuey5VxmoU5XytZNI6iLoqC0hUYESWgX3UUXtroYdSNhN5ndRRBEMai8sViXy1ALqs0uzFiSgUyZNxsxNNykmI5hi/adzjnb2R/7Zr0Xe77nvM95937nfO+jAwvjviPdUOhN9rifUuwghADsAQwpw0ocVI0zXIBK7iYWZyaI0Xaoh1IyylJgEugbTfgVW4HkMiQvxcI8CO1VaJoOEPZvlKogW6pxYPABFIaciy74ejYPqSvgxXkMKOzXJpPN9jOoMZlhYijFKNlcidO0alOoqtZxoqoqzN0XRPscORei/0HQOkWShqMnYNjdJgpy5LxE/E9cEe0y0nr+Igojw7Ovg/wmu70d7hcj8Pun4P88Bbd7BPaTHbk8MVj4lwJ0jn9BaVi+voP/zTgWZvyik65TnXC5HqJcOJ3X4fNOQpFtl4vjZ8+h3zWM+699aNrTCoejD1rhuNwn6ugyr0NRKeobG7GRWIfVatXUWPdaxa2LDgkqF+SROaPNRBRK/pa042c0im21RoRDIU0Nz+VvWeMMp8de4d6VS+g/3YGVb2EMP36iWfApz7E6VTpj/RA/x52H26FvMOUE8eAcJm5cxepSRAj5rIZYF4FAAM3mFhgMtUilUpifD2Do1iA+vJ/ktwGiN1mEuuFYFw7eeZQrOHf7GlY/+co7QgVU5Ecbm/YiGQmLYhxjH73FE4FNJkZOippW18QZMhLxPBcFI55nGRcBijZLTrITVJpny2usQzUoXWP5rQfJ5QjDl0WDn3MVDWPIu046SKp3tfQQooxmnBjY2mRGKvo958zFKI2alM2zE+ytSm8kFnU1xllmkm1sbfuf5Lo+58VidyFmL6A4H2d7Z4lCnL9/LI39BQAA//9YQZ7sAAAABklEQVQDABA6GbCf5kYjAAAAAElFTkSuQmCC',
    24: 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAADeElEQVR4nKRVW0hUTxj/zdnjX3cV/9nF1VXaWI0uECwUSBe6YBeiixV0pZ7KLq8R9NJDRL1FT4GVBSH0VhH0UJRm9RAU0QUqwW1XS7PVas0t012PM30z58xxrcTcBpbf/OZ8M9/8vsusCWcUzl2wFmAnhUAIjE0CTQgJBAHD33F8JYgZTBxLvnl6S57rAbZ68md7TzGwOggETK83Dx4TYnhIbbL32jg+Rx5hKdFdedPKzNTnxQ9Zwaz5K2jxnnMhBNdswqA1jHjjTWRcNAsUXBjGGoOmR2mq3MuPFRu2wb96s5QLdz0rhME4P2IIzsP2IkdwQRUKyoPwls+Ab3YYej1rFCIsFfglkSEMb95hZ5ykTKmuGWWsQjxx7jdAciQpnh4kBQttBxRE35wwTH8Z9He9eaLc0B5nVS2CO1RVGMitnDdKNtwY/z03lRy6cVFJqUqsVkBmMMtDMIumwUr0qMRJu0xcvmIZamv3oXJmhdr2NhJFff1FPLj/0LXz5BQVH5c3XrxlO3IDQfRZAv1pC6nUEAYGBuFfsgplVUvx/9RiDCW/IvUtqRRWr6pGXd1ZBAKlyMvNVT85X79+HVpaWtAWa1ciKAdcef+TAiO/UFFfSTkqa3ai5uwV7L50FYwasXbfXow1pCpk5kCSyYEyNWWwu0Wi4SuQ3uSy69swPBBDaYQqQmM6CIVC0OcabkJgnyIgXAXM6X82YqGrAOMN3XSGTTh62mMj+xwFVrI3Q4GtgXNLVVgsGh3zcPub3dGOAqC7LfpbDrhyIDAQ70Tr9QbcOLQdDXs2gg9buHDu/JgO6s9fcEvVZI6nRNcH+H9RkO6I4l3DaaQ/xUc/ZGTfdOcu9u+txYFDB6lMZ6ptkUgE9XXn0NzU7NqZKlZEvnzo/E2B9T6CdM9H5+GDW/+aP6CD7jfeg04Sc/4fMu0N3XGRJ4/A6ZnWCmQFDLY8R7YdrLlbRYmuTkSab7sK+h43Y7i3599eU1lFpKZbJ/rltStuHySabkCvZ4ukpFsqeGETjo5nT9DX1oofHTH0v34GvZ4tUh2+8OR4C+IUsd1MXp0Lldze1y/xPfLKKRtki5wJccBjDXyL5eQX+kjJEllayfa36G9vBU+nR/2hTxghTqQ+d13WhYn/JpfMpaI6TNOV5D84chMG9zEan7+jQDRSaM6kE/E38tyfAAAA//8nUVWSAAAABklEQVQDAMmy84ygYp3pAAAAAElFTkSuQmCC',
    32: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAGCElEQVR4nJxXWUxUZxT+7r2zMGxFYQaorKbCII5gFbTWmi5qrRV5ahqjL0olNmmtPrWJaUrbtI9Nl5jGKKV9sT41qba2MS5NDS5gK8VSKKBgAWFYZGBghlnu/fvf/c7G4k8ud757zr+d851z/t8EQ8uorMzILF7fYOaYaobjnAzLLSOEgGEYgL7pDzwOBhEmBZ7vEsKkZaz/jwZPW5tHnZNRf2Rt2r4nM6/w9JR72B4O+BHy+yGEw5KM0D9GV10yZkwcrLYUmKw2pOVkjz0a6Ksbv3nlvCjjpMmrd+xenld4brSnM2XO6wEfDIKuWBpCGkzZSdaadTBlORAcd8s7jZInwqI1QoE5hHyz8E95UuxFJXsFW8afc8N93dwTLtcyR/Hqy+6ezmQ+GIDSS28GXHHkOGylazH6269x5YvBAh8WFwHHylXbQkxSI5vt3HTU436YxdMVSpqCIL9F3xlwrmsdMumTVlaB1FJXjHwpWHTx1OhDe075mndYFtjIz/kMStCVDfjF+rdQaGWlDTn27FtQfyHMU46xINX0IRVBv09hK5Hfko6OMwuKsHuDCymc3D+VusHkeDKh/mJwwDdD/7OVLOVLjkg6VciItBHNZsBlz29HYRKLbp+geJIg9ektCfUXg4VQCAwRclhoYyqsFUgM3l5bC3eQ+k7jEyMtIJH+YrHYTLJvBLzwYwui29XaaqRnZqF0RS4eBAQ5t0AOLUt2HpjUdBAatvJgYugJhsEXxuKbJRExE9WoqLDchVwL0D9HtNTCyIaEOX+VwceCwrMlYNECslkEXK2pMiQRfafFa9ai3U/gDRuXKu8gfesuCA+6EPROKYsS5P7UzFu3bsGRo28jPz9P6jE4MIgvPv8S1641S3JGWQSX5axsmB4Z0nK4/IaGdxyoRygzFzM8gY929IV4hEJhBEXi2tJQsbMGjvwCzA4PIuCdlvocO3YEH3z4PrIdDiRZrdLjcNixu+ZVsDTwb7fepulAQEZuHg1FIDJUot7ZRSvVuhJhGXHHPP3ImS0oebkW+09+D0tKGqqqNqD+8CG5IEU18dvhN+tRvbFKo4LCAaL4SI1THZstlojJjRyQiKV8629tphaYwhuH6jBfEy1wsO6AwgEickBMjwQvXbgToXhl1zqZaBarMhViOCBAX9TsxLi0eGeZEws1p9NJc4BsYVaOy9hI0KuZPrlkCcUGUAmr6IuuYOaLqATjm1Rw+ZWKuEp+rxckdVlcDjBED83skjJJv6uzE3b7c/NOLurIbiZiPTBkJgJEY7/E7PgcUJkgtpzScmSsKEDjqcZ5JxfZf+rkKW18ViuZ8tFJ1dLw9MRYQg7QXA6BhuO/v/yA03t3wjPQjxvN1/HdN98mXMCJr07g1vUbykYFmIwhJycRwZAPGIz03UO6a0NcDoSH+nDt648Qnp2O6P/px5/g7JmzOEgjYvOzm6Ue15ub0XS6Cb09Pdr4YlM4IGDbxY6Y1V7aUY7+9jasqnk9Lgc8v/+M0MyU9IXRcr38vt/bi+PvvqctNiJ0qVzWN3IgXqOintabCTkQ7L6ruU3N9UvFJtnnBJe2rVZHj4jKiYeDGOnuAlNYEsGB4MB98BNuWV8tsSBLw7oFiJaZiHKG0zIixR0Xf4rhwPTNK1H6ifvPJ6eJiH/EcCalOhkICf349M+lC0onaFVspuVqlH7i/vHknMkEcW5WvLFYk22yknJuUzureJKG1/CdFj3tdrYhODqUUH8x2GxLFu8enWw4EPjLZE2OLEQCicHtZ5s0DrjPnVlQfyFsTrLR43mgnQsEpjuyisvqfJ5HVkJvQ/p5ABHng8n+e3CsfwZTw0N40PRZjHwp2GyzYXl+kXek6+5+Ljwz4wmB7c0pWf2az0MrGr0PqplPjl+9IPmGBzDZdgt+eoCJJ18MFneeXebCWG/vPt9Qzw3t1JBW4KyxP+Vs9LgH7Lx/DoHZGWUxxrse81hYrJRmejm1UL+n5eSOjffdq/P2dZwHDLdjqWUUZRRUrm0wsaiiN9oyluH0Mqju5TGwIIQnERY6Q2G+9b/2vxvg6deu5/8DAAD//+68UE8AAAAGSURBVAMARXwYNOTsPrkAAAAASUVORK5CYII=',
  },
  good: {
    16: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAB+klEQVR4nIxTv2tTcRD/3Dcv+kwrz6GahhRRM7Ug1aHo4BAHxSwKDlqwDg66OCoiOLsIRf8BwUHRTcTBH5MVxUFRioOgppJKsNElRYtJzLvzvt+893ihaenBvXuf+9x9Oe6HNzQxNWqEbgjkKBHlRQREAERVf2KsRm2MqaH8cya54hHLTQFP25xMbhhWuit/QLDB7LBLjmyE88qfJUHWgMOK9TAzCkdOOLVYOOxlqD/m09jyxFwxCgJRJxmD4rGTTiWqWZJg5VOPxn4WDkzPydh+oAx/JO90x8FyFMSI+f5HOOE996Lq2PHTiKV06hxM7TOWat8c5mAzwpkp8GTRYZqvw7v7FqbZAuV2TYjt7uHH75CWmYKP+kIVsxfP49eZccihUh9Pr6rI3pqLK2AMkuKeEto6Ed435qaQFuvTAcAk3V5DHL8mKTBJVwdIvfoV/pYczPvFVZz12TzPdVfra36ax7bxSUe2al9w9cIlNGoLrrjM7Sa63RCyf2cv+cMizJ03bgrkF3a7+vPlCvZem3UBH69r8osn2IiYeCmW5p7i788fThsvn/Ut0XrWTmFZpxDYFf3+6F6vN/86QHILaStR7yLMskybRor3dQ+mLZndGrigcOV3fHXrWgM8yPhD/uuQSa8Lo2G7Ncyddt/ZDbIk3NDvQ890Lv8HAAD//2zbtpoAAAAGSURBVAMAu6NldOjNawsAAAAASUVORK5CYII=',
    20: 'iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAACpElEQVR4nJRUQWhTQRB9u4kxrY1JtWljY1vwokEoiEUPFgVBUCzSePDm2YN4EmlBlHrzIggiHvSiJw+N0RIPQgUFgzYQQUTSg2gbEzHRatqQVoN/19n9+Ul+TFIdSN5/O7Pz5+/bGSfIPLv2jYHLSXrcLSV8jDGAHkAoCdtxSFEgfAfBrhbnEzHmCe0dl5JFyQUKgbs3gJ/5L7C4ZRZvxHo/mAxzacgJRm+TUoBtcGH48nVwQsV1FWq94ocVV8ftfkxw+g9Zzm2HjqIzEESA0ApGw+Z2XBoixKUQXkWEEAiOndLlK1RcB/0PQnq5Rfz7D2LT9iGdUKHiDcH/xJ36TEitwZOnUW+Kf3v1rKqqFCYae4IwwsMQAz4dx9MFOB69BU9+0n6Hy+efUptC5y7ZErp7+nB45xDKq6vIZzO6EmNkAMbkEaCnC8zl1D/4uyBGdwAfl8CyBXCr7GZ24PgJnL95G9ceP0XfwCAEVdbKxPiwzuM0v12inXX39mKtuALR7zXvW7OEQa9WXVfI0D6hMvPg1wuS4DWVWtv3XA4dXR5wOqNWpnw1lVt8SHzmIeKxKFJzL7XafFrAuHisaSybfq0rdDg93VPqHLeMjMLtD1QDCqk3iF04g6+ZtA7Ur8z8AN7nIUlZ2eECygYYcX7rORyJRaUGiaIEoejF+3fgu3KjmlBxs72g/VKacXxuATyx8NekkBXk1g3Px2dRSn/QyRTmX8zaOwLrdEwFuTDEsk5PJB25pxOmI3fNKQLYNltc3QrZxE/Ly1ShSFlTI/skglI2TfjA1vjVqdJiMNSmjpFirq3944zxqNmzwMa+IH7lPtd62IbWoGZN/XSCYYexVpx3dnqSNCSHaG3z79KKuzqLK0LUsCKE3V+gvUnG2dnyUmbmDwAAAP//G1gbVgAAAAZJREFUAwD9+x5xiLxHUAAAAABJRU5ErkJggg==',
    24: 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAADXElEQVR4nKRVW0iUQRT+Zv6/clex2qj1lhsllNFlqSi6vEQ3eggTKip676G3CHooCKIegugp6CmIoLeCIqKgi1AQqOEl0khTV1dtNVtvmbruznRm/n9+11TUbf6HM2fmzJzznfOd+W24I3fjjqMAuyEl1oKxZaAJSRKSBMP8dAyQaOVMXh1q/PRS3WsBJ63sDb6bDOweJApsny8Llg2ZmtCHnLOOnFtHFsl8Us9mrSy0x/v2vmc567fvp8V3bkAIHTmOsWQKsTfPkRZoBlIKyfkRTtPLNNXu1ea6Y6cQPFyu4MJbz0iCMyEucSlE2FkUCO3YhZyiEHxFa+DfEIZZz1hKGVYIgkpRKQyXn3YqTlBWHCibYqxTvHA9yEFwlLKqOEQIdjsOKIn+0jDsYCHMvjm8UJ0bj+t37YE3NCs4lpRsngIbXo7nr9saDkW8PC9fF9YgIDPYRWthL1+JZLxXF07ZpUuxfTVSx7dAFC/Tx3jHAKynn2HVdHp2Nlw4K/ILtVMPAX123moUX7gG/9gwxr7Vo6f6A4a6o9o+tTOE1OWDTjzmWGkQydJDkLdew6qOaidUA6E3Z0LAs3O16s8rQknZGZTdfYRz9x+DUSMKiny2Icq3Auk1UEqgwEHAwDwE3J+j45NpUXJuQU4kIAqXzu6gYCnMvdwriItVQnoImNv/bNLCJANzDdN03FEEeiOt02qQHOpPQ+BgECKpGca7Bma93NlzOtpjUU9bC4Ilm1wkDgKhHAQCGI11oundM13kwWhE27PHNZBXjs7s4EktzL02cz3Fu7sQ/AdBItqC9oe3kfgZm/qQkb1V2QZcfwF5YhvRNODE1RGHRY5ZdbtnZ+tckfKrq3Mai5IdzUj0/nAfPnj8N7pFF8mqCCy3SMz9P6Tbc9NxzVUfIeiZNggUA8a+1iLTDja6x6J4dyeaK155CAYrK5Dq7/2/11SxiND0SLfZ6p888vog/vYpzHqmkpD0KAR1Lv8QranCYFsT/kRbMdJQA7OeqSQe1lmLfDkxytg5xTyVO/X1N9Tjd/MX8yPPVAom5XkrOTrcuig7109I9ilqDUW+YyTSBJFITPmhL1hCXh/v635giInFgbyNRKqLND1I/kOTkTB4j9Hcejsl4g2l5k4iHmtU9/4FAAD//322qAQAAAAGSURBVAMAYJbwVuJuTVMAAAAASUVORK5CYII=',
    32: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAF20lEQVR4nJxXWWxUVRj+7jIzDF1o6TalpQtKF9qhLUtFY4wLRSVAXeKC8EbCk1HjI740Pvjoiw+GBMKbEhM1gCIhUIxGxRKgHSytLdiBrtN12mlnOjP33uO599xtti6cyZ1zv3v+c85/zv/9/3+OCFvJa27OK6je3eEQuFZOEOo4XsgnhIDjOIDW9AVPgkGUOUWW+xWJdE35b3cEu7uDxpyc8VK4r+1IQXnlmfnAeJEUjSAeiUCRJK2N0B9nia4bc6IAlzsLosuNHE/J1Ozw0Inpm52X1DZBm7z1wKHN5ZUXJwf7spZDQcixGKjG2hDaYPpKChtbIBYWIzYdYCtNas+E1d2IR5cRDy8hMh/MKqqqOaq48+4sjw8NCJu83vzi6h3XA4N9G+VYFHovq9hw00efwV27E5O/XknbvhasyJKqBIq3bd8f5zac5Uvq9n0SDIwVylRDTVJRWK3azoZLvS0ooE9OfROya70p7evBqonnJ8eKPA2NH/M88Iy8HLYJwRK24ZdPfohKF68tqPjIsVXlV8My5RgP0kof0hSLhHW2ElZrMhYuqKjCoT1eZAmsfzY1g1i8JaP8WnA0vEj/+Wae8sWjks5o5FTaqNtmw/UvtqFyA4+BsKJbkiB71/MZ5deClXgcHFE8PMwxddYqJAW3tbcjEKO2M/nEaQpkkl8rVovIbKPgpQtdSC432luRW1CI2rJSPIoqLLaAuZazpBxcdi4IdVs2mOp6im3w1bFa8yTBZ5IKbaps8KLUCfiXiRlaOLaRcGzdbrOxovNsHVjdAbYtCm4c3msLItZKqxt3whchCEl2VdkKcl84COVRP2KheV0phfWn26y0lEF6fxeIJ0frwU+EIJy/DaF7TGvndCV4OzCU0danY3UHxqNsci3E63ugvjkra/DcF6fRevJTbNpSrn2lhoL8wS7ET7UBTxWCy3JpD6Hv8VMHEH+3mWpjzcez7bC5SlJdUrXNyCsJO6OuWKYfBYcTNa+24/jpb+HMygGp90B+q4klpKSifpPfboLS4DGpoHOA6DYy/NTCDqczYXI7BzRi6d/8t/5AlJpCetOLlQpHQ5/U3qhzgKgcUMMjwSuX7yYIdh5sYURzuvSpkMIBBZZSSzPTmvKkqgAcVi6kksrohOSZX6Z6gpXNrMmTOaARTpdXTcGt5FEZxhcNcP31prRCkVAIJDs/LQc4YrlmSU09G9Q/DeRXrDi5JgNmbt6eIBgdEnEktJCRAwYT1OKpbUBeWQWEH30rTq56mfB9jzk+b6ZMdnRiUja8MDOVkQM0lkOheeTfX37AmaOvITjsB98zAu5iT0YFhO/ugPeN6AtVINpdjgURxTrR0Hpi6CFyvXvSckAaHcLvX38OaWkhob945k/IV+6DvNEM0lzGenSPgL/gA/d41jorwuSAgv1Xe1O0vXagAX5fN7Yffi8tB4K//Yz44rz2hTNjPauF4TmQrzpNZRNcVwtCXBIH0hoMGLx1MyMHYgP3TLMZsX69WGQ2J7i2f4cxeoJXzoyNYGKgHxwNu3YOxIb/gzwTYPJGigVZH7Z2gJiRiehnODMiUtx79acUDizc7EySz9x/pXYaiORZThD1hGQjJKzj0/1rl/VOMBPXYteNJPnM/dO1C6IIdW5evbG4NrqZkH5uMzobeI661/jdLivs9nUjNjmaUX4t2OHeqN49+ngpGu0RXRsTE5FCUrDv/DmTA4GL36wqvxp2bHDT43nUJ0SjC72F1fUnwsFZF6G3IebPOuvNeADM+R+iePezmB8fxaNzX6a0rwc73G5s3loVmui/d1yQFheDcfAPPDU73gkHaUaj90Ej8jH/tRJSeHwYc91/IzIxmrZ9LVhdeUm9F1MPHhwLjw7+ZWbOnIq6w0VP150NBoaL5MgyokuLujL2ux73RFjNlA56OXVSu+d4Sqemhx6eCA31XgKQlLrzqvIqmnd2iDz20httPc8JVho01vIEWFGkOUhKX1ySbz32/dOBoN+8nv8PAAD///dQXgIAAAAGSURBVAMAdj0MtLQ82nQAAAAASUVORK5CYII=',
  },
  warn: {
    16: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACHUlEQVR4nIxTTWhTQRD+dvsiL2k0QmvTEAW1Fy3Un4PowUNKUcxFRUR7MKAHvXhUilC86UWoehe8iOhB0OrBH4p/6M2fioditZUgxaanVhPaxGbG2cl7MYFQHJg3+823s7vvm12vvXdXt2VzhcH7jTFJZoYxAFhcBiGWIDHEpiD8MzI85BniawwadDVtsTicLZeKMHCTSbEWBzHASeFzhhGxoGrWZYgIqX2H1B1mqtYqJB/yjdjxhihrBSRYksZapA8cUefgzFyfLHzDomGemBK2liSs252B35lU79qTCSYRQr55Earznq4ovv7gcYTWc+wUbH4Ss/nvirsSFVzKFTCwo6h4bDyOi7eSmJuPwMQ29rJTt//ROzTaiZSPmekpjJw9jeu59zi691cTf+/NGpy8uiE8AaGVpTf3oCwdyfSVFMcPb3G9RfHBBPq3SU5+x1M1tfGtrcaj3r9/m7FiW1e1hc1MfYMfjeHFeFRxcfQLSg8ndfz8Y0zrPFVXdpif+IS1W7cruZT/igtnzqGQn9bWD93owLLsMbBzUa/B2Icohm92aBeMn9qk9yuZyaJveEQX+HxZil8+xv+YDS/F7KsnWJz7qV54/bTpEq0UXRcWRJiEO9uP0ds1ef5UVO2aYI2RAy0DTLxgVnWm70gXBh0ZWZ3QSdXS7/DVrRgtcLfNb/ffVsnI60J3tbwUp0q56dm1ioapIN/7nq2c/wsAAP//Tg+SUgAAAAZJREFUAwB8eXHGiIgIpwAAAABJRU5ErkJggg==',
    20: 'iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAC1ElEQVR4nJRUX0iTURT/3c+5luvTLDenM2VJf0ZQD82CioJ8KZNQi6Cg5x7CIEQMgywq6KEgqJ56KqiX0kFaaCr0kGbmDAmZ9O9haqXTUMfyD+673Xu2b25rbXUevt/9nXPuuee7555jgBB1665KKPyCWG7jHGsZY4BYQCAXmIqDazMCh6GxG4GR/jamOndWcc7cwgThApPVhoXJH9C5LjpPxFg7GK9WeIg3MHEa5xpYphHbL92GIlByykLqI3bofjE83o4GRXydurHgwCFk2eywCdSdkbA5FechzalwTcuRRNM02CtPUPoSJSen/0HwHEUnlt37YS4qoYASJU9w/iduoDsR1SquOY1YkXyq71W0qlwLY4VrFuerp+AsWiA/76gJN1ssaPeoZGdmh3wpwMHWASSKY/Al+l60Yri/jzI57ArgSaMPyeTYtWJ0DKpQ9LSTyd4jR1F37z5uPe9G/oZi1NX4Se/uVeGq3Yiy2lJaS6k/7qc4SvQuUkiu1Yr5wBw2FS4Rv/ooDyOjRvG7mbj+OI90m+2LVHXKkIEjnZAfC/spLKYgPCYZypCnz/DnxARWr1HxccxIvPHkFGW0xT6Pi6emSSdtdKjJXspFbVDe8eGPQI537ehpc8P79g1Vu6IsiKdN35MeWtVUgE6PGRkGNfeyvMd1rn0wWWxRhxnvENrqz8A/5qNfkb36adyAwc9GlFiXkZ3F8WuR4f0XI87dtaBzwCyrITK0OcjbsqccO67ciQYcaqqFv7c7+URIgdEqT/Z0Iej7SsEkTr7uiu8IpOmYCCpaSJuldyiIr/khBfQ1PwhPkUh19c06l6+CJ7EL9azIUPPqU2O8oxnBcZ/AlrjGj06VvwyGlakT8jLj+sIqxhR3uGeBVfl2LE58W+nhONQHNUtqFzdYnRGaD4wYslSPGJIlQpe9HJwzRWcx7Y7FSAHi7TNir4cp7OzS9Niz3wAAAP//18gRvgAAAAZJREFUAwDBRCzZyT7GzwAAAABJRU5ErkJggg==',
    24: 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAADwUlEQVR4nKRVa2gUVxT+7uwk2d2kqdmu2Zhd3RLTmkgLC00b2ohQ+hChJZpiWsX//dNC6ZM+oA/sj9LQX4X+KoigYDCo+MMIPkBBMNGo4IuNiTEb4+bhxt0kZnd2Mtdz78yd7KqgWS8M555zH+d853znjg5nVK9v2QywXZyjAYytAE1IkuAkGJ5Nx30Swxrjv2SunT8q7vUA2zyVTb4/Gdh/4KjXfT4vPDr4Yl4ess/a8uk6vCRXkbrDuzKs56bbTrOqdW+8S8aTTkCIbtqCrLmI5PEjKAi0BMktrmmbNJr+QFPpXiyu/bgToQ+3Crhw7SVJaMyyvtW4ZcVso4VoSyuqIlH4Ii/D3xSDspcsOY8JBCGhiBTGtn5mV5ygvPRee9FmmeLl6yENBEcotWuihOBt2wEl0d8cgx4KQ62rw8vVNeVxXes7cIdkhYaKxteLYMPN8bPruoRDEdfUrZKFVQhoG/RIA/SalTBTk7JwYl+h/OitWXy1ZQrNq3Py2PWEF109QRwbqHb3ecpqan8TEbd1fIqK+ijSJse8YSKXy2NhIYvQhg8Qbt2IF4O1yGfuIzebkQg3vzmH7h9HEQma8JZz+UWCeXRuTONCvAJDyQoJgmpgSe9PQqBVVkvVXxdBY/t2tP+7Fzv/PwBGjfhNx5RcO3j2BbR8uRYtXzTIuRjfbZsGCmsglEB9WE4Z7G4RUvNXCW/C7PrWNA943sAr9YbUd+0L4sZoGW6Mlcu5GK+Gc1D3am5BYN/CwV0EzOl/trRDsYDWHAtX1OROKMrMFQKbUpMjw0u3OAjMzEwBAhuDZZmSYXGKWIyfd9wjNFk0rc7ip+3T0mav2U5dFk3cGkKo8bWiGljCQSCAheQY4icPY6L/DNKJEbn/7+4a9Px6Fx1tc/IrHH/tD0DdqzPHU2r8DkKPIDASQ7i9pwvGVLL4IaP9vf1+fPJ7Hb7vnEHzmjwWLUHTcnR1r8Cxfp9MoYNAVhb37ow9xiJzdBDG5F3n4YPLf6X39lXi6Dk/VJGY83+AvNzWNdVxg31nYdEzrRAIBmSvX0SpHax0l0Wp8TEMnup1EaTPncLizOTzvaaCRYRugjvNdrlnr9sHqROHoOylSkIyIRBccviHxEAf0rfieJAYxvzVASh7qZJ4eMlT5qtKUsZ2MhG6xWVxZ65extzgFYc2KFVajPPPPebC7HBZZbWfkGwQFMyM3MT8SByWYRT90Jctwf/ITY/vVsREeaBuPZHqa5q+T/6jS5EwuI/R0/XblIjjlJp/jFTymrj3IQAAAP//tI0tkQAAAAZJREFUAwC7HhPiRULuSQAAAABJRU5ErkJggg==',
    32: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAGMklEQVR4nJxXa2xURRT+7t1Xty9aum0XKH0pfdAubXlURENQCioBGoiPIJiYkPALxJCYgPxpUPmpUX4YIoRfIjEKARSUACUaFYtCKdbWtrCFUtrttnTbbXe7rzvOvXNf+6It02znfnfOzJw55zvn3DFC17Jqa7NySpY1mQxcPWcwVHC8IZsQAo7jANrTBzwNBhFGhUikUwiTFnfv302e1laPsienPNhWrtucU1B0bMw1kBsO+BHy+yGEw9IYoX+cJjprzBkNsFjTYLRYkWHPdz/uc+4cvn71vDhmkDavX79xbkHRuaHujrQprweRYBBUY2kJaTH5JLbqOhhteQgOu9hJY8aTYdEaocAUQr5J+Mc8abnFZdsEa9bNqQFnl2GOw5GdV7L4iqu7IzUSDECepTUdrnnvIKzlSzB07aeE4zPBQiQsKoG80kUNIS7lOJ9fsfJ9j+uRLUI1lCQFgfWi73R4nqMOOfSXUVmD9HJH3PhssOjisaFHufaq6r08DzwXmfLphKAJ6/DLu3ajyMJLB8rbvH1a+elwhHKMB6mnP1IT9PtkthLWSzIaziksxsblDqQZ2Px06gZj3vyk8jPBAd8E/c/X8pQvdpF0yiAn0kY0mw5XrlmHohQeXT5B9iRB+tIXk8rPBAuhEDgi2Hmoa8qsFUgcXtfYCFeQ+k7lEycpkEx+plhsRuYbAS+dbUFsa26sR2aODeUL5uF+QGC5BSy0zPkF4NIzQWjYssXE0BN0i0+PxZ4nUTET0+hQUZUD88xA7xRRUwvHDAnTwkU6Hwsyz2aBRQswswho3rRCl0S0k5ZUL0Gbn8Ab1qvKTpC5egOE+50IesdkpQQ2n5p5w4pxHHhzCKX2oDTDOWjGx6fy8PPNTGmck5Xg9UBRRjqfjEULDATY5lKKl20gPpmLyrDq8FHU79qHOfML1Pn7trjx7YEHqHtmCnPSBOlXS5+/O/gAeza6o9bnmTl0oRLT5xeXKnUlyjLiiSP0pcFkRtkrjdhx9BuY0zKwunoSh95xJfXqJ++6sMbhVakgc4DIPlLiVMMmszlqcz0HJGLJ73pv/IYAdcUHr7vVzc78noG63aVYuqcUp+kzZCvuaRyROUBEDojpkWDthVtRml7dUMeIZrbIWyGOAwI0pSZHhiXlq4oCqtRHX9vQ3W+WxA+ftGHrKnZyB5XhZELyLC7jI0GrZtrmsRyQCCfLi67gYtbhOSXutQwoveeJur5R2ezKazUJlfB7vSDp2Qk5wBEtNPPLKiX5O04L1tb5pHcfbnNLVuDpcQ++PaKue/ueRVXKiKiCIZ9V2Y1iv3ccXEZ2Qg4oTBCbvbwKWQsK8dn3k6oCW1+YkH7RhwI+PzOXPRApCuSSyT6dmJQOj4+4k3KA5nIItI78d/E0jm17FZ6+XjTfTsX+r3JAv2fimvhu/zEbrrWmyAcUYNSHHEsigvZFQ/tB511kOpYn5EC434lfvzyE8OR41PwjZ7Nx8a9U7N0yhgZqjXCEw7W2FHxxJhtdD02ygdVawJJQw6X2OI0vr69Cb1srFm16KyEHPL/8iNDEmPSGU3M963semrH7iE1VltM5jCUhdkge5Mm1oPvG9aR5INh1R3Wbkutni43M5wSXGxYrq0dF5cijhxjs6gRH066eA8G+e4iMuJi8UmJBZoc1CxA1MxH5G07NiBS3X/ohjgPj16/GyCef/6RxmogijzmDUS5IOkLqkse/ly/Ik6AWromW5hj55PMTjRuMNAPQvXnxxmJJtTIh+btNmazgURpeA7datLTb0YrgUH9S+ZlgkzVVvHt08OFA4LbRkhpdiAQSh9tOnVA54Dp3clr56bApxUo/zwNthkBgvN1WUrnT53lsITRTsHiWWa/mA2C09y7ylj2PsYF+3D/xadz4bLDJasXchcXewc47OwzhiQlPCHyPvWzxGz4PrWj0PqhkPha/WkHyDfRhtPVP+Af7E47PBIsnz690wN3Ts93X3/2H4lZkFFZsyn224rjH1Zcb8U8hMDkhK6O/63FPhcVKaaKXUzP1e4Z9nnvYeXen19l+HtDdjqWWVZxVWLukychjBb3RVvKcIVtfmGIL1UyxIIRHERY6QuHIjQdt/zTB06tez/8HAAD//7VJRYUAAAAGSURBVAMAOG0x4KWlBpkAAAAASUVORK5CYII=',
  },
  crit: {
    16: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACC0lEQVR4nHxTPWgUURD+3stGN8npXuTiRU4sPEUUxEKDYpXCiGkULDSNhYVir4hgJ1goiKUiVqKoIP5VaqdgFS2sBBMNRxCzQn6O5JLcXXYm897u29zCJQNzszPfzNzsNztez4GBfs3qLoNPKqWKzAylALCoPDhfjFjnq1DwT6T4uqeI7zNoxNR0dOdgZKW2AAWTTNa3xYlN/KLgFxSjU4OiYRMhIuwYOmPV+ExRXCFxh7f6BldEw1qcgCWotEbp1FmrnMzMabLgLU1dnJgCHQcJfUcH4ReKVrcfG0ySCA7PNqEU92xH0Z2nz8NJ+dxF6MovTFUmrN/bjHBpZgWHl2JOvnVpPN7mYdbT0K5zsO9g2sDfVcbtV+9x6+VbBIU+XJlu4kSN0Cv1Rofk2cTMHycTENpJaXcZddnIwCLhOI1nsAW9RwiNoFO21xGLrwvyGgft5O/vcfhd3Rj1q8jpvRls1Icl0rMcyNbmfv5Afv8hCy5XxnDj8lWElT92uAcBQ94YR+rK4t83Mx5thdsC2aTJ10+Qv3nPJow9fYhwYu2dp6XuTt7OnB2RON6C6TD1+QOW/v+zGn75mPmINrKGg6psITCf6OS7ZzE3zQaQ3kKr5YS7xCeuqk2F0nO5rhEDdm4JbFJUm3dXt6HVwIsOv8f/GpGS60J/VF/OUaOeObt2VjGF8vvG041rqwAAAP//pnYpBwAAAAZJREFUAwBQ53mxk1njTAAAAABJRU5ErkJggg==',
    20: 'iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAACrElEQVR4nJRUTUwTQRT+Zrpba6UCIqWK0otGGxMvGknQaMLJRGLAg5w8ezCejMGLBjx5MTEaT3rRExwQQ/BggokH0WrCwYMpIWrCCkZaf1ragtbujG9mu223lqIv2f3mm/fm7Zv39j0DJKH9R/rA5RVaHpASLYwxgBYglISNOKRIE76DYDeyc2+mWCh2qF9KNkEqkAkC4Qh+Jr/A5a64vBar9WBygEtbDjH6mpQCzPTj4LVb4ISK6yjUfkkP166Ke/UY4vSOucodJ04iGOlEhNA1Rs3hRlzaIsalEM2KCCHQ2XdWh69QcW30PwjZzF3S3n0cW3ZFtUOFitcY/xM3dE6oWl1nzqFaFP8af16uqhQOdud+YzBjI1oQ2m7B5BhrNRAP+rTe529pH1aHYhevehwGtnegd18UhdVVJJcWdSQ9uSKup4oI28Amqqt61Lo3L/DBBD6ZDNwNu54cPXUal+7ew80nz9Cxu0tHtp4Mpm3tx3DuLtFIWsNhrGVX0EXX7BHv69rk+B5ddR0hQ2OHSpzEb2SkItT/UWOH35eXsbkpBMtM4SXfW9fGMllVlZ3G+UtmJh9jZmoCidev9EfHmiRGftS3HW2Suhd9Rqh1WK22HT6GQHukbJBOvMXU5fNILVr6KsqNZUjMm0JXNkgZKNDevClxu1kgHlCJU1dWBSHrhdH7aBm5U3aouNNe0HqdFsK4n542WZo2qEwKlWNC7v7hyZlp5K2P2pnC5Itpb0dgg44pIRe2yOivEbHGHzoJHn/gTBHAc9jl+nJ19LSdoQhFwp0aS0/HkV+yCB95Gr88VdYZDJWpYyeYv21nP2N8wulZaqmOTvxa/lzpYQ+6g5rV1VMGB3z2WnbOCIZmaUhGaW9rMb8SKM/icuJrCuDVp+nsLOPsQuHb4uQfAAAA//+SqJzgAAAABklEQVQDAG3uIzU0SApYAAAAAElFTkSuQmCC',
    24: 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAADbElEQVR4nKRVXWxMQRT+ZvaudreroVLb6uoKFdVUsgkJyosQ4kHwQBGJJyHxJhIPJEJ4E69eRSLhQUI88OAnIVmKoImfaKmtrdoudnVVf7Z3Z5yZe+e2W5W2azbZM9/MmTnnOz9zLbijsmnVVoCdlRKLwdgc0IQkCUmCYXoYP0l0cSZP5t4+v63u9QG7fBWNgXMM7CIkFliBQDl8FmRhVB9yzjpyaoxykrUE95VX11kj39c9ZKFlKzfQ4n3XIUS37MCwXUDq7i2Mc7QEKYXkfAun6XGaavNqc8m23Qhv3qnowlsvSYIzIY5xKUTMWRSIrlqNUCSKQGQRgo0xmPWSpZQxxSCsgAphbOceJ+NEZd7G7UXKOsQzx2EOoqPA/PooMVjrGKAgBpfHYIXrYPbN4ZlibiwuW90Cb+iq4ChrWFFEG16Mp48tTYc8nltTqxNrGJAarMhiWHOrYWfSOnFKb7xcM1hA688CoqNCH+v2c1yb40NbheXpWXDpzKut00Y9BvSzahai/sgpBId/Yfh9O/qePUKuN6n1WwYFTn+zjUf6vzkv0Zy2capaIu4asaDouAzsCQx4RSWBAoI1EUQam7DmwGHIbBpXDraS50P412jtF4gHnHstE6uqBXVI625nHgMeDAFDOU3M2ObcBzmaRz2FpUV8mNTAAG/wcsC9hLhMleeGAXP7n41pmBhiqmGazstBOtFFbdxclAM7lwUs7jJwOAhh6wr77GeI86WTXq72nGrCWBX1ffqIcINrwGUglIGqKgyletBx/6ZOcn8yofWvhiTOZNmkBq7NdpzWVcTctyPT+wXhCVWUT35E9+XzyH9LFT9kpB8PACcgsHeAUZk6xxJ+upwMPy5jbrPpPtCZxY8vPX/1gf25E/n0V/fhg1f/BreVMzwpc7CTOqadMOFRmJtsdz6NQ9AzbRio8h1+9xKldrDBXhVlenvQ+eCOx6C/7QEK2fT/vaaql4hdnwOA9utXvD7I3LsBs16qJCZ9isErt/6QfPEU/Z86MJjswu83L2DWS5VUh698/kAoRRHbz5TrQurkZt+0Y6DztfmQlyoFk/KQzx761eWvqAwSk/WqBHOJD/id6IDI54s+6DOWkGdGvvde8jplVlVNExXVUZpuIvvRMU8YvMdoatxNgbhLobmQz6Teqnv/AAAA//9bVwBnAAAABklEQVQDAJQe9AGVL4fIAAAAAElFTkSuQmCC',
    32: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAF2ElEQVR4nJxXWWxUVRj+zr13ZphuTuku0AXpRhlaBCoSY1wAlQB9wSDCg4bEJ6O++9KY6Ju+EhIIL6gkBBPZNITFaFQsAqVYW7vYgdplus502pnOcs/x3P3O1oXTTM/97v+fc/5z/u///3sk2JqnpcVTVLO93SGSViKKDUQQCxljIIQAvOcPeBoMRmepLPfSBOuY9N1rD3R2Bow1ifFQvGvvoaL1VaeD/rGSRDSCeCQCmkioMsb/iKW6akwkES53LiSXG/nlZZMzw0Mnpu7cuqzIRHXx1n0H1q6vujTR35O7GApAjsXALVanUCfTd1K8ZRuk4lLEpvzaTlPk2bByGvHoIuLhBUSCgdyS6rqj1O25vzg21Cc+4/UWltZsvunv78mRY1Hoo6xmw80ffQp3/VZM/PRjRvlKMJUTihEo3Vi7J07WnBHKGnZ9EvCPFsvcQlWTUq1XfGfDFd5tKOK//MZm5NV70+SrwYqLgxOjJeVNWz4WBOAFeTFsU4KlbMOvffAhqlyCuqHSQ8eW1V8Oy5xjAlgr/7HmWCSss5Vpvapj4aLKahzY4UWuqI3P426QSp/Nqr8SHA3P8/9Ci8D5Uq6QzhAShTbKsdlw4yt7UbVGQF+Y6p5kyHv+paz6K8E0HgdhtFyAOafOWsrS8N62Nvhj3Hcmn4hqQDb9lWKlSZpvKF79vgOp7XZbKwqKilG/rgKPo1TLLdBCy1m2HiSvAIyHrTaZEnrUNvnyWOkFlhQzKY2Lqpq8qHACvkVmphaiHSQcG2ptPqY6z1aBlRPQjoXi9sGdtiRi7bRmy1Z0RRhCCbup2g4KXt4P+rgXsVBQN4pq4/kx7wzLeG82joqENmqcr3S2UMKfuZIqJ7oRkh1og6mVyXivnMBYVFtcTfH6GShPzqo67P7iFMKPOtB35QKCo8MgPIO+H5DxTlDWaoJ+bvlx4HN/HF8/Q3GOGyLrEkE7DluopPRl1RuNupJ0MsqOZf5SdDhR90Ybjp/6Fs7cfHi5q47OUX3x5Ka8e5cb1hyRTSroHGC6j4w4tbDD6Uxa3M4BlVj6O9/dXxHlrjgSlLFUU+L+8BzVOcAUDijpkeH1aw+SFG/t36YRzenSl0IaBygsoxamp1Tjn+PhupsOLGnEjLiJ5wBR1Re0uEyPBKuaWYunckDliq6vuIIsFVFZ5pcMcPOt5oxKkVAILK8wIwcIs0KzrK5R1R90Evwm1C65+KBLn0U5AdgLBgNScSQ0l5UDBhOUVl7fBM+6SlzIW3Jt7m2G8/nEnF8wS6b26aRrWXhuejIrB3guB+V15J8fvsPpo28iMOzD/TUEF3Oyu+JcAcFDp1EZlTxgC7lMeWB8aBAF3h0ZOZAYGcIvJz9DYmEuafxJD8FVbsThBYLtUW3EPRdwMY/AJ2nuY1Yt0JLQnuvdadbe2NcEX1cnag8eyciBwM9XEZ8Pqm+Imeu1/omD4EsPNY01MqUhN4ywOJCpcVH/3TtZORDre2S6zcj1q8WSzgzc2LPZmD0pKqdH/8N4Xy8IT7t2DsSG/4U87df0jRILtjpsnQAzMxPTv+HMjMhx9/UraRyYu3MrRT/7+KXkPBHJM0SU9IJkIySsz6e/b1zTB8EsXPMdt1P0s4/PJBclpSrKM4JyY3HluDUl/bvNGGzgWR5eYw86rLTb04nYxEhW/ZVghztHuXv0CIlo9KHkykkuRJSl4a7zZ00O+C99s6z+ctixxs0/z6NdYjQ6111c03giHJhxMV7LtXjWWW/mA2DWN4jS7S8iODaCx2e/SpOvBjvcbqzdUB0a7310XEzMzwfiEAbK6za/HQ7wisbvg0bm0+LXKkjhsWHMdv6ByPhIRvlKsLLzskYvJgcGjoVH+n83vxryKxsOlmxqOBPwD5fIkUVEF+Z1Y+x3PfJUWKmUDn45dXK/55dXTE4NDZ4IDXVfBmy3Y7V5qj2VLVvbJQE7+Y22USCiVQaNvTwFpjQxiwTtiSfku0+6/mpHwGdez/8HAAD//8qA+o4AAAAGSURBVAMAuh8SBdtJpYEAAAAASUVORK5CYII=',
  },
};
// Effective tray state: --tray starts it without touching config, and the
// dashboard toggle must override either source — the statusline feed reports
// THIS (falling back to config when nothing has decided yet), or a
// flag-started tray would read config tray!==true and kill itself in 30s.
let trayDesired = null;
function trayScript(port) {
  const pngTable = (state) => '@{ ' + [16, 20, 24, 32].map((n) => n + " = '" + TRAY_ICONS[state][n] + "'").join('; ') + ' }';
  return '﻿' + [ // BOM: PowerShell 5.1 reads a BOM-less script as ANSI and would garble a non-ASCII home path
    // The tray is spawned detached with stdio ignored, so anything it prints is
    // discarded — it logs to <home>/burnglass.log instead, which is exactly
    // what the Server panel tails. (v1 hard-coded ~/.pulse here and so ignored
    // a pinned home.)
    '$logFile = ' + psQuote(path.join(appHome(), 'burnglass.log')),
    // Same shape as the server's own lines so the tail reads uniformly.
    // ASCII only: PowerShell 5.1 + the log's other readers disagree about
    // encoding often enough that a stray em-dash shows up as mojibake.
    'function Write-BgLog([string]$msg) {',
    '  try {',
    "    $ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')",
    "    Add-Content -Path $logFile -Value ($ts + ' INFO  [burnglass] tray: ' + $msg) -Encoding UTF8 -ErrorAction Stop",
    '  } catch { }',
    '}',
    // FROZEN name: an old v1 tray holds 'PulseTray<port>' during the handoff.
    "$mtx = New-Object System.Threading.Mutex($false, 'PulseTray" + port + "')",
    // 10s (not 0): during a version handoff the new instance starts before
    // the old one has released the mutex.
    // Losing this race is NORMAL (a restart while an older icon is still up),
    // but exiting silently meant the dashboard reported the tray as enabled
    // with nothing on screen and nothing anywhere explaining why. Say it.
    'if (-not $mtx.WaitOne(10000)) {',
    "  Write-BgLog 'another instance already owns the icon on port " + port + "; this one is exiting. If no icon is visible, that owner is stale - end the powershell process running tray.ps1, or toggle the tray off and on in the Server panel.'",
    '  exit',
    '}',
    "$myVer = '" + PULSE_VERSION + "'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    // GetHicon handles must be destroyed once cloned into a managed Icon.
    "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class BurnglassIconUtil{[DllImport(\"user32.dll\")]public static extern bool DestroyIcon(IntPtr h);}'",
    "$base = 'http://127.0.0.1:" + port + "'",
    '$ni = New-Object System.Windows.Forms.NotifyIcon',
    // Windows asks for 16 at 100% scaling, 20 at 125%, 24 at 150%, 32 at 200%:
    // take the smallest drawn size that covers it (never a non-integer
    // rescale of a smaller drawing).
    '$want = [System.Windows.Forms.SystemInformation]::SmallIconSize.Width',
    '$px = 32',
    'foreach ($c in @(16, 20, 24, 32)) { if ($c -ge $want) { $px = $c; break } }',
    '$PNG = @{',
    '  base = ' + pngTable('base'),
    '  good = ' + pngTable('good'),
    '  warn = ' + pngTable('warn'),
    '  crit = ' + pngTable('crit'),
    '}',
    'function New-BgIcon([string]$b64) {',
    '  $bytes = [Convert]::FromBase64String($b64)',
    '  $ms = New-Object System.IO.MemoryStream(,$bytes)',
    '  $bmp = New-Object System.Drawing.Bitmap($ms)',
    '  $h = $bmp.GetHicon()',
    '  $icon = [System.Drawing.Icon]::FromHandle($h).Clone()',
    '  [void][BurnglassIconUtil]::DestroyIcon($h)',
    '  $bmp.Dispose(); $ms.Dispose()',
    '  return $icon',
    '}',
    '$icons = @{}',
    "foreach ($k in @('base', 'good', 'warn', 'crit')) { $icons[$k] = New-BgIcon $PNG[$k][$px] }",
    "$script:state = 'base'",
    "$ni.Icon = $icons['base']",
    "$ni.Text = 'Burnglass'",
    '$ni.Visible = $true',
    "Write-BgLog ('icon shown (v' + $myVer + ', port " + port + ", ' + $px + 'px). Windows hides new tray icons behind the ^ chevron until you drag one out or promote it in Taskbar settings.')",
    'function Set-BgState([string]$st) {',
    '  if ($st -ne $script:state) { $ni.Icon = $icons[$st]; $script:state = $st }',
    '}',
    // base = meters off / no login / stale / loading; otherwise the live
    // 5-hour used-% against the dashboard's own alert thresholds.
    'function Get-BgState($s) {',
    '  $m = $s.meters',
    "  if (-not $m -or $m.claudeFiveHour -eq $null -or $m.claudeFiveHourStale) { return 'base' }",
    '  $p = [double]$m.claudeFiveHour',
    '  $w = 80.0; $c = 95.0',
    '  if ($s.trayLevels) { $w = [double]$s.trayLevels.warn; $c = [double]$s.trayLevels.crit }',
    "  if ($p -ge $c) { return 'crit' }",
    "  if ($p -ge $w) { return 'warn' }",
    "  return 'good'",
    '}',
    // Left-click opens the mini overview as a chromeless app window (Edge is
    // on every Windows 11 box); falls back to the default browser.
    'function Open-BgMini {',
    "  try { Start-Process 'msedge' -ArgumentList ('--app=' + $base + '/#mini'), '--window-size=380,800' -ErrorAction Stop }",
    '  catch { Start-Process ($base + \'/#mini\') }',
    '}',
    '$menu = New-Object System.Windows.Forms.ContextMenuStrip',
    "[void]$menu.Items.Add('Open dashboard', $null, { Start-Process ($base + '/') })",
    "[void]$menu.Items.Add('Open mini overview', $null, { Open-BgMini })",
    "[void]$menu.Items.Add('-')",
    // X-Pulse is the FROZEN mutation header (a v1 server only accepts it).
    "[void]$menu.Items.Add('Stop Burnglass', $null, { try { Invoke-RestMethod -Method Post -Uri ($base + '/api/shutdown') -Headers @{ 'X-Pulse' = '1' } -TimeoutSec 3 | Out-Null } catch {}; $ni.Visible = $false; [System.Windows.Forms.Application]::Exit() })",
    "[void]$menu.Items.Add('Exit tray', $null, { $ni.Visible = $false; [System.Windows.Forms.Application]::Exit() })",
    '$ni.ContextMenuStrip = $menu',
    "$ni.add_MouseClick({ if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-BgMini } })",
    '$script:fails = 0',
    'function Update-BgTray {',
    '  try {',
    "    $s = Invoke-RestMethod -Uri ($base + '/api/statusline') -TimeoutSec 3",
    // The dashboard toggle turns the tray off by flipping this field.
    "    if ($s.trayEnabled -eq $false) { Write-BgLog 'turned off in the dashboard - hiding the icon and exiting.'; $ni.Visible = $false; [System.Windows.Forms.Application]::Exit(); return }",
    // Server updated under us: the server rewrote tray.ps1, so relaunch
    // from the fresh file and hand over the mutex.
    '    if ($s.version -and $s.version -ne $myVer) {',
    "      Write-BgLog ('server is now v' + $s.version + ' (icon was built for v' + $myVer + ') - relaunching from the rewritten script.')",
    "      Start-Process 'powershell.exe' -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('\"' + $PSCommandPath + '\"')",
    '      $ni.Visible = $false; [System.Windows.Forms.Application]::Exit(); return',
    '    }',
    "    $t = 'Burnglass'",
    "    if ($s.today) { $t = 'Burnglass - today $' + [math]::Round([double]$s.today.cost, 2) }",
    '    $m = $s.meters',
    "    if ($m -and $m.claudeFiveHour -ne $null) { $t = $t + ' - 5h ' + $m.claudeFiveHour + '%' }",
    "    if ($m -and $m.claudeWeekly -ne $null) { $t = $t + ' - wk ' + $m.claudeWeekly + '%' }",
    '    if ($t.Length -gt 63) { $t = $t.Substring(0, 63) }',
    '    $ni.Text = $t',
    '    Set-BgState (Get-BgState $s)',
    '    $script:fails = 0',
    '  } catch {',
    '    $script:fails = $script:fails + 1',
    "    $ni.Text = 'Burnglass - server not responding'",
    "    Set-BgState 'base'",
    "    if ($script:fails -ge 6) { Write-BgLog 'server unreachable for 6 polls (~3 min) - exiting. Start Burnglass again and the icon comes back.'; $ni.Visible = $false; [System.Windows.Forms.Application]::Exit() }",
    '  }',
    '}',
    '$timer = New-Object System.Windows.Forms.Timer',
    '$timer.Interval = 30000',
    '$timer.add_Tick({ Update-BgTray })',
    'Update-BgTray', // first paint immediately, not 30s in
    '$timer.Start()',
    '[System.Windows.Forms.Application]::Run()',
    '$ni.Visible = $false',
  ].join('\r\n') + '\r\n';
}

function startTray(port) {
  trayDesired = true;
  // Test hook FIRST, before the platform gate: its log line is the e2e proof
  // that a boot path reached startTray at all, and the suites run on Linux —
  // behind the win32 check the boot-path regression guard could never fire.
  if (envv('NO_TRAY_SPAWN')) {
    console.log('[burnglass] tray spawn suppressed (BURNGLASS_NO_TRAY_SPAWN / PULSE_NO_TRAY_SPAWN — test hook)');
    return;
  }
  if (process.platform !== 'win32') {
    console.log('[burnglass] --tray is Windows-only (notification-area icon) — ignored on this OS.');
    return;
  }
  const scriptPath = path.join(appHome(), 'tray.ps1');
  try {
    fs.mkdirSync(appHome(), { recursive: true });
    fs.writeFileSync(scriptPath, trayScript(port));
  } catch (e) {
    console.warn('[burnglass] tray: could not write script: ' + e.message);
    return;
  }
  try {
    const child = require('child_process').spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath],
      { detached: true, stdio: 'ignore', windowsHide: true });
    // Spawn failures surface as an ASYNC 'error' event, not a throw — without
    // this listener a blocked/missing powershell.exe would crash the whole
    // server (and with {"tray": true} persisted, crash-loop every start).
    child.on('error', (e) => console.warn('[burnglass] tray failed to start: ' + e.message));
    child.unref();
    console.log('[burnglass] tray icon started (Windows notification area) — right-click it for the menu.');
  } catch (e) {
    console.warn('[burnglass] tray failed to start: ' + e.message);
  }
}
// ---- OPENUSAGE COMPANION (opt-in, Windows) -------------------------------
// Launches CheesyPoofs346/openusage-windows (OpenUsageTray.exe — the taskbar
// strip + popover) alongside Pulse instead of Pulse drawing its own taskbar
// UI. Pulse only STARTS the app: it never installs, updates, or kills it,
// and disable just stops future auto-launches. Config: `openusage: true` +
// optional `openusagePath` (the app is portable — "unzip anywhere" — so
// auto-detection probes a few conventional folders).
// Memoized: payload.openusage calls this on every summary build, and the
// configured path is arbitrary — a dead UNC path would otherwise sync-block
// the server on each build. Busted by writeConfig alongside the other memos.
let openusageMemo = { at: 0, key: null, path: null };
function findOpenUsage() {
  const c = readConfig();
  const key = typeof c.openusagePath === 'string' ? c.openusagePath : '';
  const now = Date.now();
  if (openusageMemo.key === key && now - openusageMemo.at < 30000) return openusageMemo.path;
  // statSync().isFile(), not existsSync: the natural mistake is configuring
  // the unzipped FOLDER, which existsSync would happily accept and spawn.
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  let resolved = null;
  if (key) {
    resolved = isFile(key) ? key : null; // an explicit path that is missing should NOT fall back
  } else {
    const home = os.homedir();
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const candidates = [
      path.join(local, 'Programs', 'OpenUsage', 'OpenUsageTray.exe'),
      path.join(home, 'OneDrive', 'Desktop', 'OpenUsage', 'OpenUsageTray.exe'),
      path.join(home, 'Desktop', 'OpenUsage', 'OpenUsageTray.exe'),
      path.join(home, 'Downloads', 'OpenUsage', 'OpenUsageTray.exe'),
    ];
    for (const p of candidates) {
      if (isFile(p)) { resolved = p; break; }
    }
  }
  openusageMemo = { at: now, key, path: resolved };
  return resolved;
}
function openusageRunning(exe, cb) {
  // tasklist ships with Windows — still zero runtime dependencies.
  const name = path.basename(exe);
  try {
    require('child_process').execFile('tasklist', ['/FI', 'IMAGENAME eq ' + name, '/FO', 'CSV', '/NH'],
      { windowsHide: true }, (err, out) => {
        cb(!err && typeof out === 'string' && out.toLowerCase().includes(name.toLowerCase()));
      });
  } catch {
    cb(false);
  }
}
// Any of several image names running? One unfiltered tasklist (IMAGENAME
// filters can't be OR-ed) — still a Windows builtin, still zero-dep.
function imagesRunning(names, cb) {
  const want = new Set(names.map((n) => String(n).toLowerCase()));
  try {
    require('child_process').execFile('tasklist', ['/FO', 'CSV', '/NH'],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        if (err || typeof out !== 'string') return cb(false);
        for (const line of out.split(/\r?\n/)) {
          const m = /^"([^"]+)"/.exec(line);
          if (m && want.has(m[1].toLowerCase())) return cb(true);
        }
        cb(false);
      });
  } catch {
    cb(false);
  }
}
function launchOpenUsage() {
  if (process.platform !== 'win32') return;
  if (envv('NO_OPENUSAGE_SPAWN')) {
    console.log('[burnglass] openusage spawn suppressed (BURNGLASS_NO_OPENUSAGE_SPAWN — test hook)');
    return;
  }
  const exe = findOpenUsage();
  if (!exe) {
    console.warn('[burnglass] openusage: OpenUsageTray.exe not found — set "openusagePath" in ' + homeLabel('config.json') + ' (get it from github.com/CheesyPoofs346/openusage-windows/releases)');
    return;
  }
  openusageRunning(exe, (running) => {
    if (running) return; // already on the taskbar — never start a second one
    try {
      // OpenUsage's popover hard-codes a 100%-DPI window width (372px) while
      // WebView2 zooms content by the monitor scale — on 125%/150% displays
      // the popover clips. Forcing scale 1 for THIS process makes the whole
      // window/content contract consistent (the author's intended look).
      // Respect the var if the user already set their own.
      const env = Object.assign({}, process.env);
      if (!env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS) {
        env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-device-scale-factor=1';
      }
      const child = require('child_process').spawn(exe, [],
        { detached: true, stdio: 'ignore', cwd: path.dirname(exe), env });
      // Same async-'error' trap as the tray: a bad/blocked exe must warn,
      // not crash the server (and crash-loop every start via the config).
      child.on('error', (e) => console.warn('[burnglass] openusage failed to start: ' + e.message));
      child.unref();
      console.log('[burnglass] openusage companion started (' + exe + ')');
    } catch (e) {
      console.warn('[burnglass] openusage failed to start: ' + e.message);
    }
  });
}
// ---- PULSE STRIP (opt-in, Windows) ---------------------------------------
// Pulse's own taskbar strip + popover: pulse-strip.exe, a compiled companion
// (strip/ in the repo — ported from openusage-windows under MIT, fed by this
// server's /api/summary). Same launch discipline as the OpenUsage companion:
// Pulse only STARTS it (dedupe via tasklist); disable stops future launches
// and the strip exits itself when the statusline feed says stripEnabled off.
let stripMemo = { at: 0, key: null, path: null };
function findPulseStrip() {
  const c = readConfig();
  const key = typeof c.stripPath === 'string' ? c.stripPath : '';
  const now = Date.now();
  if (stripMemo.key === key && now - stripMemo.at < 30000) return stripMemo.path;
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  let resolved = null;
  if (key) {
    resolved = isFile(key) ? key : null; // explicit-but-missing must NOT fall back
  } else {
    // New name first at every spot, then the v1 name (upgraders put
    // pulse-strip.exe beside pulse.exe or in ~/.pulse/bin — the 105 MB bin/
    // folder is deliberately NOT copied by the migration, so it is looked up
    // in place).
    const exeDir = path.dirname(process.execPath);
    const legacy = legacyCompatHome();
    const candidates = [
      path.join(exeDir, 'burnglass-strip.exe'), // beside the packaged exe
      path.join(exeDir, 'pulse-strip.exe'),
      path.join(appHome(), 'bin', 'burnglass-strip.exe'),
      path.join(appHome(), 'bin', 'pulse-strip.exe'),
      ...(legacy ? [path.join(legacy, 'bin', 'burnglass-strip.exe'), path.join(legacy, 'bin', 'pulse-strip.exe')] : []),
      path.join(__dirname, 'strip', 'dist-strip', 'burnglass-strip.exe'), // dev builds
      path.join(__dirname, 'strip', 'dist-strip', 'pulse-strip.exe'),
    ];
    for (const p of candidates) {
      if (isFile(p)) { resolved = p; break; }
    }
  }
  stripMemo = { at: now, key, path: resolved };
  return resolved;
}
function launchPulseStrip() {
  if (process.platform !== 'win32') return;
  if (envv('NO_STRIP_SPAWN')) {
    console.log('[burnglass] strip spawn suppressed (BURNGLASS_NO_STRIP_SPAWN — test hook)');
    return;
  }
  const exe = findPulseStrip();
  if (!exe) {
    console.warn('[burnglass] strip: burnglass-strip.exe not found — download it from the Burnglass release next to your server binary, or set "stripPath" in ' + homeLabel('config.json'));
    return;
  }
  // Dedupe on BOTH image names: an old pulse-strip.exe still on the taskbar
  // means don't start burnglass-strip.exe (the frozen PulseStrip_SingleInstance
  // mutex would bounce it anyway, but this avoids the flash).
  imagesRunning(['burnglass-strip.exe', 'pulse-strip.exe', path.basename(exe)], (running) => {
    if (running) return;
    try {
      // The strip resolves its home from BURNGLASS_HOME first, so a pinned or
      // degraded home reaches it (v1's strip hard-coded ~/.pulse).
      const env = Object.assign({}, process.env, { BURNGLASS_HOME: appHome() });
      const child = require('child_process').spawn(exe, [],
        { detached: true, stdio: 'ignore', cwd: path.dirname(exe), env });
      child.on('error', (e) => console.warn('[burnglass] strip failed to start: ' + e.message));
      child.unref();
      console.log('[burnglass] strip started (' + exe + ')');
    } catch (e) {
      console.warn('[burnglass] strip failed to start: ' + e.message);
    }
  });
}

// ---- RUN AT STARTUP (opt-in, Windows) -------------------------------------
// The ONE thing Burnglass deliberately writes outside ~/.burnglass: a value under the
// per-user Run key. That is inherent — a startup entry has to live where
// Windows looks for one. It stays honest by being opt-in, reversible from the
// same UI/CLI that created it, and HKCU-only (no admin rights, no machine-wide
// state). Written with reg.exe, a Windows builtin, via execFile with an argv
// array (never a shell string) so the quoted path can't be re-parsed.
const STARTUP_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
// FROZEN at 'Pulse' across the rename (it is invisible — Settings > Startup
// shows the exe, not the value name). One name = one slot: the installer's
// startup task, --install, and this toggle keep overwriting the SAME value as
// in v1, so a portable v1 entry and a v2 install can never both launch at
// sign-in, and a still-v1 Inno uninstaller (which only knows 'Pulse') can
// still remove whatever v2 wrote.
const STARTUP_VALUE_NAME = 'Pulse';
// Test hook: PULSE_STARTUP_STUB=<file> routes the whole feature through a JSON
// file instead of the registry, so the suites can exercise enable/disable
// without ever touching a real machine's Run key (same convention as
// PULSE_METERS_API / PULSE_DISCORD_IPC / PULSE_MODES_FILE; BURNGLASS_STARTUP_STUB
// is the v2 spelling).
function startupStubFile() { return envv('STARTUP_STUB') || ''; }
// `--no-open` suppresses the browser, so signing in starts the server silently.
// From a source checkout the value has to carry node + the script path; that
// still works, it's just tied to wherever node lives.
// exe: --install passes the INSTALLED copy it just wrote.
function startupCommand(exe) {
  if (exe) return `"${exe}" --no-open`;
  return seaApi
    ? `"${process.execPath}" --no-open`
    : `"${process.execPath}" "${__filename}" --no-open`;
}
// Windows-only in the real world; the stub also flips support on so a suite
// can drive the feature end-to-end wherever it runs.
function startupSupported() { return process.platform === 'win32' || !!startupStubFile(); }

let startupWarned = false; // reg.exe failures warn once, never per payload
function readStartupEntry() {
  const stub = startupStubFile();
  if (stub) {
    try {
      const j = JSON.parse(fs.readFileSync(stub, 'utf8')) || {};
      return { enabled: !!j.enabled, command: typeof j.command === 'string' ? j.command : '' };
    } catch (_) { return { enabled: false, command: '' }; } // no stub file yet = not enabled
  }
  if (process.platform !== 'win32') return { enabled: false, command: '' };
  try {
    const out = require('child_process').execFileSync('reg.exe',
      ['query', STARTUP_RUN_KEY, '/v', STARTUP_VALUE_NAME],
      { windowsHide: true, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    // "    Pulse    REG_SZ    "C:\...\pulse.exe" --no-open"  (lazy + \s*$ keeps
    // interior spaces of the command but trims the CRLF padding)
    const m = new RegExp('^\\s*' + STARTUP_VALUE_NAME + '\\s+REG_[A-Z_]+\\s+(.*?)\\s*$', 'm').exec(out || '');
    return m ? { enabled: true, command: m[1] } : { enabled: false, command: '' };
  } catch (e) {
    // reg.exe reports "no such value" as exit status 1 — that is the ordinary
    // not-enabled case, not an error. Anything else (reg.exe missing, hive
    // unreadable) fails CLOSED to disabled and warns once: a checkbox must
    // never be able to throw out of a payload build.
    if (!e || e.status !== 1) {
      if (!startupWarned) {
        startupWarned = true;
        console.warn('[burnglass] could not read the startup registry entry: ' + ((e && e.message) || e));
      }
    }
    return { enabled: false, command: '' };
  }
}
// Memoized like findPulseStrip/findOpenUsage: payload.startup is built on every
// summary, and spawning reg.exe per build is not acceptable.
let startupMemo = { at: 0, state: null };
function startupState(force) {
  const now = Date.now();
  if (!force && startupMemo.state && now - startupMemo.at < 30000) return startupMemo.state;
  const state = readStartupEntry();
  startupMemo = { at: now, state };
  return state;
}
function startupForPayload() {
  return { supported: startupSupported(), enabled: !!startupState().enabled };
}
// Returns { ok, command, error } — callers report, never throw.
function setStartup(on, exe) {
  const command = startupCommand(exe);
  startupMemo = { at: 0, state: null }; // a write must never be shadowed by the read memo
  const stub = startupStubFile();
  if (stub) {
    try {
      fs.mkdirSync(path.dirname(stub), { recursive: true });
      fs.writeFileSync(stub, JSON.stringify({ enabled: !!on, command: on ? command : '' }, null, 2) + '\n');
      return { ok: true, command: on ? command : '' };
    } catch (e) { return { ok: false, command: '', error: (e && e.message) || String(e) }; }
  }
  if (process.platform !== 'win32') return { ok: false, command: '', error: 'run at startup is Windows-only' };
  const cp = require('child_process');
  const opts = { windowsHide: true, timeout: 10000, stdio: ['ignore', 'ignore', 'pipe'] };
  try {
    if (on) {
      cp.execFileSync('reg.exe',
        ['add', STARTUP_RUN_KEY, '/v', STARTUP_VALUE_NAME, '/t', 'REG_SZ', '/d', command, '/f'], opts);
    } else {
      try {
        cp.execFileSync('reg.exe', ['delete', STARTUP_RUN_KEY, '/v', STARTUP_VALUE_NAME, '/f'], opts);
      } catch (e) {
        if (!e || e.status !== 1) throw e; // status 1 = already absent, which IS the goal
      }
    }
    return { ok: true, command: on ? command : '' };
  } catch (e) { return { ok: false, command: '', error: (e && e.message) || String(e) }; }
}

function startServer(port, host, opts) {
  const boundLoopback = LOOPBACK_HOSTS.has(host);
  const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url);
    const route = parsed.pathname;

    try {
      // Every API route — including plain reads — refuses foreign Host
      // headers on a loopback bind (DNS-rebinding guard). Mutations add
      // stricter checks on top (allowMutation).
      if (route.startsWith('/api/') && !allowRead(req, res, boundLoopback)) return;
      if (route === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, version: PULSE_VERSION, pid: process.pid }));
        return;
      }
      if (route === '/api/summary') {
        const t0 = Date.now();
        // ?sources=cli,codex — scope the whole payload to those sources.
        let sourceFilter = null;
        const rawSources = new URLSearchParams(parsed.query || '').get('sources');
        if (rawSources) {
          const names = rawSources.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
          if (names.length) sourceFilter = new Set(names);
        }
        const payload = buildSummary(sourceFilter);
        console.log(`[burnglass] /api/summary built in ${payload.buildMs}ms`);
        // charset matters: PowerShell 5.1 consumers (the tray) decode JSON as
        // Latin-1 without it, mojibaking "·" in meter labels.
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
        return;
      }
      if (route === '/api/statusline') {
        // Slim, memoized feed for `pulse --statusline` (see STATUSLINE FEED).
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(statuslineData()));
        return;
      }
      if (route === '/api/export') {
        // Download the dashboard's aggregations. Read-only: covered by the
        // allowRead DNS-rebinding guard above like every /api route. Accepts
        // the same ?sources= scoping as /api/summary so a download matches
        // exactly what the dashboard shows.
        const q = new URLSearchParams(parsed.query || '');
        let sourceFilter = null;
        const rawSources = q.get('sources');
        if (rawSources) {
          const names = rawSources.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
          if (names.length) sourceFilter = new Set(names);
        }
        const payload = buildSummary(sourceFilter);
        const stamp = localDateStr(Date.now()).replace(/-/g, '');
        if (q.get('format') === 'json') {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': 'attachment; filename="burnglass-export-' + stamp + '.json"',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(payload, null, 2));
          return;
        }
        const periodKey = q.get('period') || '';
        const period = (payload.periods || []).find((p) => p.key === periodKey) || (payload.periods || [])[0];
        const data = q.get('data') || 'daily';
        if (!period) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'no data to export yet' }));
          return;
        }
        const csv = exportCsv(payload, period, data);
        if (!csv) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unknown data set "' + data + '" — use daily|models|sources|projects|sessions' }));
          return;
        }
        // Sessions is the whole-session recent list, not period-scoped — its
        // filename must not imply a period.
        const fname = data === 'sessions'
          ? 'burnglass-sessions-' + stamp + '.csv'
          : 'burnglass-' + data + '-' + period.key + '-' + stamp + '.csv';
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="' + fname + '"',
          'Cache-Control': 'no-store',
        });
        res.end(String.fromCharCode(0xFEFF) + csv); // UTF-8 BOM so Excel opens the file correctly
        return;
      }
      if (route === '/api/logs') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ lines: logRing }));
        return;
      }
      if (route === '/api/shutdown') {
        if (!allowMutation(req, res)) return;
        console.log('[burnglass] stop requested — shutting down');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, stopping: true }));
        setTimeout(() => {
          try { server.close(() => process.exit(0)); } catch (_) {}
          setTimeout(() => process.exit(0), 1000);
        }, 200);
        return;
      }
      if (route === '/api/meters/enable' || route === '/api/meters/disable') {
        if (!allowMutation(req, res)) return;
        const on = route.endsWith('enable');
        // One dashboard gesture covers both providers — the button copy names
        // both endpoints. Pre-1.6.0 configs with accountMeters alone never
        // gain the ChatGPT call until the user re-toggles here.
        writeConfig({ accountMeters: on, codexAccountUsage: on });
        console.log('[burnglass] account meters ' + (on ? 'enabled' : 'disabled') + ' from the dashboard');
        if (!on) {
          metersState.status = 'off';
          metersState.buckets = [];
          metersState.error = null;
          metersState.fetchedAt = null;
          metersState.lastGoodAt = null;
          removeMetersCache(); // consent withdrawn: the saved reading goes too
          codexUsageState.status = 'off';
          codexUsageState.stats = null;
          codexUsageState.error = null;
          codexUsageState.fetchedAt = null;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, meters: { enabled: false } }));
          return;
        }
        // Fresh credential lookup + immediate attempt on every enable.
        credCache = { at: 0, cred: null };
        meters429Streak = 0;
        metersState.nextAttemptAt = 0;
        persistMetersCache(); // drop a saved backoff — this attempt is deliberate
        codexUsage429Streak = 0;
        codexUsageState.nextAttemptAt = 0;
        refreshCodexUsage(); // async; the summary poll picks it up
        // Respond after the first fetch so the card can render immediately.
        refreshAccountMeters(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, meters: metersForPayload() }));
        });
        return;
      }
      if (route === '/api/meters/recheck') {
        if (!allowMutation(req, res)) return;
        // "Recheck now" from the connect card: force a fresh credential lookup +
        // immediate attempt (e.g. the user just logged into Claude Code) so
        // meters light up without restarting or waiting for the poll cadence.
        if (!metersEnabled()) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, meters: metersForPayload() }));
          return;
        }
        credCache = { at: 0, cred: null };
        meters429Streak = 0;
        metersState.nextAttemptAt = 0;
        // Forced: the saved backoff (restored across a restart or live) is
        // cleared too, so a restart after this doesn't resurrect it.
        persistMetersCache();
        codexUsage429Streak = 0;
        codexUsageState.nextAttemptAt = 0;
        refreshCodexUsage();
        refreshAccountMeters(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, meters: metersForPayload() }));
        });
        return;
      }
      if (route === '/api/discord/enable' || route === '/api/discord/disable') {
        if (!allowMutation(req, res)) return;
        const on = route.endsWith('enable');
        writeConfig({ discordPresence: on });
        console.log('[burnglass] discord presence ' + (on ? 'enabled' : 'disabled') + ' from the dashboard');
        if (!on) {
          discordSetActivity(null); // clear the presence before dropping the socket
          discordDisconnect();
          discordState.status = 'off';
          discordState.error = null;
        } else {
          discordNextAttemptAt = 0;
          discordState.error = null;
          discordTick(); // connect + publish now, not on the next 15s tick
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, discord: discordForPayload() }));
        return;
      }
      if (route === '/api/discord/images') {
        if (!allowMutation(req, res)) return;
        // JSON body {claude?, claudeWorking?, claudeThinking?, claudeWaiting?,
        // codex?, idle?}: only the slots present change;
        // an empty value restores the built-in art key. All-or-nothing — one
        // bad value rejects the whole request and nothing is written.
        readJsonBody(req, 4096, (bodyErr, body) => {
          const fail = (msg) => {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: msg }));
          };
          if (bodyErr) return fail(bodyErr.message);
          const patch = {};
          for (const [slot, key] of Object.entries(DISCORD_IMAGE_SLOTS)) {
            if (!Object.prototype.hasOwnProperty.call(body, slot)) continue;
            const r = validDiscordImage(body[slot]);
            if (r.error) return fail(slot + ' image ' + r.error);
            patch[key] = r.value;
          }
          if (!Object.keys(patch).length) return fail('no image slots given (' + Object.keys(DISCORD_IMAGE_SLOTS).join(', ') + ')');
          writeConfig(patch);
          console.log('[burnglass] discord images updated from the dashboard (' +
            Object.keys(patch).map((k) => k + '=' + (patch[k] ? 'set' : 'default')).join(', ') + ')');
          // Publish now rather than on the next 15s tick.
          discordLastActivity = '';
          if (discordEnabled()) discordTick();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, discord: discordForPayload() }));
        });
        return;
      }
      if (route === '/api/tray/enable' || route === '/api/tray/disable') {
        if (!allowMutation(req, res)) return;
        const on = route.endsWith('enable');
        writeConfig({ tray: on });
        trayDesired = on;
        console.log('[burnglass] tray ' + (on ? 'enabled' : 'disabled') + ' from the dashboard');
        // Enable starts it right now (Windows only). Disable is picked up by
        // the running tray's own poll: the feed carries trayEnabled.
        if (on && process.platform === 'win32' && boundLoopback) startTray(port);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, tray: { supported: process.platform === 'win32', enabled: on } }));
        return;
      }
      if (route === '/api/strip/enable' || route === '/api/strip/disable') {
        if (!allowMutation(req, res)) return;
        const on = route.endsWith('enable');
        // Like openusage: NO path parameter — a spawn path must come from the
        // user-gated config file, never from a loopback-reachable route.
        writeConfig({ strip: on });
        console.log('[burnglass] strip ' + (on ? 'enabled' : 'disabled') + ' from the dashboard');
        // Enable launches now; disable is picked up by the strip's own
        // statusline poll (stripEnabled:false -> it exits itself).
        if (on && process.platform === 'win32' && boundLoopback) launchPulseStrip();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, strip: { supported: process.platform === 'win32', enabled: on, path: findPulseStrip() } }));
        return;
      }
      if (route === '/api/meshy/enable' || route === '/api/meshy/disable') {
        if (!allowMutation(req, res)) return;
        const on = route.endsWith('enable');
        if (!on) {
          writeConfig({ meshy: false });
          // Consent withdrawn: stop fetching and clear the live numbers. The
          // stored key is left alone (re-enabling shouldn't demand a re-paste)
          // — clearing it is an explicit enable with an empty key. The task
          // cache in ~/.burnglass/meshy.json also stays: it is the user's own
          // local history, and keeping it means re-enabling doesn't re-page
          // the whole account.
          meshyState.status = 'disabled';
          meshyState.balance = null;
          meshyState.families = [];
          meshyState.fetchedAt = null;
          meshyState.nextAttemptAt = 0;
          meshyState.error = null;
          console.log('[burnglass] meshy credits disabled from the dashboard');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, meshy: meshyForPayload() }));
          return;
        }
        // The key arrives in the POST BODY, never a query string — see
        // readJsonBody. 8 KB is far more than any API key needs.
        readJsonBody(req, 8192, (bodyErr, body) => {
          if (bodyErr) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: bodyErr.message }));
            return;
          }
          const patch = { meshy: true };
          if (body && Object.prototype.hasOwnProperty.call(body, 'key')) {
            const raw = typeof body.key === 'string' ? body.key.trim() : '';
            if (raw && !HEADER_SAFE.test(raw)) {
              // Rejected without ever echoing the value back.
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'api key contains characters that cannot go in an HTTP header' }));
              return;
            }
            if (raw.length > 512) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'api key is implausibly long' }));
              return;
            }
            // An empty key CLEARS the stored key (documented behaviour).
            patch.meshyApiKey = raw || null;
          }
          writeConfig(patch);
          // Deliberately logs the ACT, never the key or any part of it.
          console.log('[burnglass] meshy credits enabled from the dashboard' +
            (Object.prototype.hasOwnProperty.call(patch, 'meshyApiKey')
              ? (patch.meshyApiKey ? ' (api key set)' : ' (api key cleared)') : ''));
          // A new key deserves a fresh attempt: drop the 401 latch and any
          // backoff so the card can render immediately.
          meshyState.badKeyHash = null;
          meshyState.nextAttemptAt = 0;
          meshy429Streak = 0;
          if (meshyState.status === 'disabled') meshyState.status = 'idle';
          refreshMeshy(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, meshy: meshyForPayload() }));
          });
        });
        return;
      }
      if (route === '/api/startup/enable' || route === '/api/startup/disable') {
        if (!allowMutation(req, res)) return;
        const on = route.endsWith('enable');
        // No path/command parameter, for the same reason as strip/openusage:
        // what gets written into the Run key comes from THIS binary's own
        // path, never from anything a loopback caller supplies.
        const r = setStartup(on);
        console.log('[burnglass] run at startup ' + (on ? 'enabled' : 'disabled') + ' from the dashboard'
          + (r.ok ? '' : ' — FAILED: ' + r.error));
        res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.ok
          ? { ok: true, startup: startupForPayload() }
          : { ok: false, error: r.error, startup: startupForPayload() }));
        return;
      }
      if (route === '/api/openusage/enable' || route === '/api/openusage/disable') {
        if (!allowMutation(req, res)) return;
        const on = route.endsWith('enable');
        // Deliberately NO path parameter: allowMutation proves loopback, not
        // same-user — any local account can reach 127.0.0.1, and a spawn path
        // must not be settable by a different user. openusagePath comes only
        // from ~/.burnglass/config.json, which the OS user-gates.
        writeConfig({ openusage: on });
        console.log('[burnglass] openusage companion ' + (on ? 'enabled' : 'disabled') + ' from the dashboard');
        // Enable launches it right now (Windows only); disable only stops
        // future auto-launches — Pulse never kills the user's own app.
        if (on && process.platform === 'win32' && boundLoopback) launchOpenUsage();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, openusage: { supported: process.platform === 'win32', enabled: on, path: findOpenUsage() } }));
        return;
      }
      if (route === '/api/budget/set') {
        if (!allowMutation(req, res)) return;
        const q = url.parse(req.url, true).query || {};
        const amount = parseFloat(q.amount);
        const period = q.period === 'week' ? 'week' : 'month';
        // amount <= 0 / blank / NaN clears the budget.
        const target = isFinite(amount) && amount > 0 ? amount : null;
        writeConfig({ budget: target, budgetPeriod: period });
        console.log('[burnglass] budget ' + (target ? '$' + target + '/' + period : 'cleared') + ' from the dashboard');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, budget: target ? { target, period } : null }));
        return;
      }
      if (route === '/api/plan/set') {
        if (!allowMutation(req, res)) return;
        const q = url.parse(req.url, true).query || {};
        const amount = parseFloat(q.amount);
        // amount <= 0 / blank / NaN clears the plan — and the label with it, so
        // a stale "Max 20x" can never outlive the number it described.
        const clearing = !(isFinite(amount) && amount > 0);
        // Anything in range is a plan someone could actually pay for. Outside it
        // is rejected rather than stored: a denormal like 5e-324 passes
        // "finite and > 0" but makes every multiplier Infinity (→ JSON null →
        // a "—x" rendered beside a confident dollar figure), and --summary would
        // report the plan as costing "$0.00/mo".
        if (!clearing && (amount < PLAN_COST_MIN || amount > PLAN_COST_MAX)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'amount must be between ' + PLAN_COST_MIN + ' and ' + PLAN_COST_MAX }));
          return;
        }
        const planCost = clearing ? null : amount;
        // Strip C0/C1 control characters BEFORE the length slice (slicing first
        // could cut a multi-byte escape and leave a fragment). An unsanitized
        // label reaches the terminal via --summary OUTSIDE the colour gate, so
        // an embedded ESC would run as an ANSI command (\x1b[2J clears the
        // screen) even under NO_COLOR, and be replayed from ~/.burnglass/burnglass.log.
        const rawLabel = typeof q.label === 'string' ? q.label.replace(CONTROL_CHARS, '').trim() : '';
        const planLabel = planCost && rawLabel ? rawLabel.slice(0, 60) : null;
        writeConfig({ planCost, planLabel });
        console.log('[burnglass] plan ' + (planCost ? '$' + planCost + '/mo' + (planLabel ? ' (' + planLabel + ')' : '') : 'cleared') + ' from the dashboard');
        // Echo the payload block, not just the config, so the caller can render
        // the new state without a second round trip. writeConfig busted the
        // summary memo, so this build already reflects the new plan. If the
        // rebuild fails the write still stands — answer with the spend-less
        // block rather than a 500 that implies nothing was saved.
        let planValue;
        try { planValue = buildSummary(null).planValue; }
        catch (_) { planValue = computePlanValue([]); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, planValue }));
        return;
      }
      if (route === '/api/update/check') {
        if (!allowMutation(req, res)) return;
        checkForUpdate((st) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(st));
        });
        return;
      }
      if (route === '/api/update/install') {
        if (!allowMutation(req, res)) return;
        installUpdate((err) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(err
            ? { ok: false, error: err.message, state: updateState }
            : { ok: true, state: updateState }));
        });
        return;
      }
      // Everything else: the built frontend (SPA).
      if (serveStatic(route, res)) return;

      // Frontend not built.
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>Burnglass frontend not built</h1><p>Run <code>npm run build</code> (installs and builds <code>web/</code>), then reload.</p>');
    } catch (err) {
      console.error('[burnglass] request error:', err && err.stack ? err.stack : err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err && err.message || err) }));
    }
  });

  // After an update (or when replacing an older instance) the old process may
  // hold the port for a moment — retry briefly instead of giving up.
  const retryBindUntil = (opts && opts.retryBindUntil) || 0;
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      if (Date.now() < retryBindUntil) {
        setTimeout(() => { try { server.listen(port, host); } catch (_) {} }, 400);
        return;
      }
      // The bind is lost for good. A daemon whose log was deferred for the
      // migration opens it now (in the still-legacy home — the migration is
      // NOT run: this process never owned the port), so the reason lands
      // somewhere a hidden process can be diagnosed from.
      if (logOpenDeferred) { logOpenDeferred = false; openLogFile(true); }
      diagnosePortConflict(port);
      return;
    }
    throw err;
  });

  // Local-only by default: bind to loopback (§2). A non-loopback host is an
  // explicit opt-in (--host / HOST) for VPS/LAN use and is warned about.
  server.listen(port, host, () => {
    // FIRST, before anything reads the home: this process owns the port now,
    // so it is the one that may copy ~/.pulse → ~/.burnglass (a v2 that lost
    // the bind to a running v1 must not use the migration up — see
    // migrateHome). Every earlier read resolved to ~/.pulse, whose content is
    // exactly what was just copied.
    migrateHome();
    if (logOpenDeferred) { logOpenDeferred = false; openLogFile(true); }
    console.log(`\n  Burnglass v${PULSE_VERSION} — local usage dashboard for Claude Code, Codex and more`);
    console.log(`  reading (read-only): ${claudeDir()}`);
    console.log(`  home: ${appHome()}${homeMigration && homeMigration.status === 'failed' ? '  (the old Pulse folder — the move to ~/.burnglass failed, retried next start)' : ''}`);
    console.log(`  listening: http://${host}:${port}${IS_DAEMON_CHILD ? '  (background)' : ''}`);
    // Record where this instance is listening so the short-lived `--statusline`
    // process (and any other helper) can find it. Writes ONLY to the home
    // (+ the legacy server.json mirror when that file exists).
    writeRuntimeFile(port, host);
    // A still-running v1 tray relaunches ~/.pulse/tray.ps1 on the version
    // change — keep an existing copy current (any platform: the file check
    // is the gate, which also lets the Linux suites assert it).
    refreshLegacyTrayScript(port);
    warnBrokenIntegrations();
    // The last good account-meter reading (and any 429 backoff) from before
    // this restart — or the file's removal when the meters are off. Only the
    // port owner does this, after the migration settled the home.
    restoreMetersCache();
    // Packaged exe on Windows: open the dashboard for the user.
    if (seaApi && process.platform === 'win32' && (!opts || opts.open !== false) && LOOPBACK_HOSTS.has(host)) {
      openBrowser(port);
    }
    // Windows notification-area icon (opt-in) — loopback only, self-exits
    // when the server stops.
    // Always refresh tray.ps1 when the tray is configured, even when the
    // spawn is skipped (non-loopback bind): a surviving pre-1.24 strip
    // version-handoff relaunches from this file, and without the rewrite it
    // would respawn its own old script in a loop.
    if (process.platform === 'win32' && !envv('NO_TRAY_SPAWN') &&
        ((opts && opts.tray) || readConfig().tray === true)) {
      try { fs.mkdirSync(appHome(), { recursive: true }); fs.writeFileSync(path.join(appHome(), 'tray.ps1'), trayScript(port)); } catch {}
    }
    // Spawn from the CONFIG too, not just the --tray flag. `tray: true` is a
    // persisted preference (the dashboard toggle writes it), so a flag-only
    // spawn meant every restart silently lost the icon while payload.tray kept
    // reporting enabled:true — the toggle looked on with nothing on screen.
    // Matches how openusage/strip launch from config on the next two lines.
    if (((opts && opts.tray) || readConfig().tray === true) && LOOPBACK_HOSTS.has(host)) startTray(port);
    // OpenUsage companion (opt-in) — start the taskbar app alongside Burnglass.
    if (readConfig().openusage === true && LOOPBACK_HOSTS.has(host)) launchOpenUsage();
    // Burnglass Strip (opt-in) — the own taskbar strip companion.
    if (readConfig().strip === true && LOOPBACK_HOSTS.has(host)) launchPulseStrip();
    if (LOOPBACK_HOSTS.has(host)) {
      console.log(`  open: http://localhost:${port}\n`);
    } else {
      console.log('');
      console.log(`  ⚠  Bound to ${host} — reachable from the network.`);
      console.log('     The dashboard exposes usage metadata (project paths, session');
      console.log('     titles, costs). Prefer 127.0.0.1 + an SSH tunnel, or put a');
      console.log('     firewall / authenticating reverse proxy in front of it.\n');
    }
    cleanupOldExecutable();
    if (opts && opts.updateCheck) {
      setTimeout(() => checkForUpdate(), 2500);
      const iv = setInterval(() => checkForUpdate(), 24 * 3600 * 1000);
      if (iv.unref) iv.unref();
      // Community reach shares the update check's opt-out and network path.
      // Its own 6h cache means the interval is just a ceiling, never a poll.
      setTimeout(() => refreshReach(), 3200);
      const riv = setInterval(() => refreshReach(), 6 * 3600 * 1000);
      if (riv.unref) riv.unref();
    }
    startDiscordLoop(); // no-ops every tick unless discordPresence is on
    // Seal history even on a headless daemon that no one is viewing (viewers
    // and the Discord tick would otherwise be the only triggers).
    try { sealHistory(parseAll().entries); } catch (_) {}
    const sealIv = setInterval(() => { try { sealHistory(parseAll().entries); } catch (_) {} }, 30 * 60 * 1000);
    if (sealIv.unref) sealIv.unref();
  });
  return server;
}

// ---------------------------------------------------------------------------
// BACKGROUND MODE (Windows packaged exe)
// Double-clicking pulse.exe should not leave a console window around: the
// visible parent preflights the port (so conflicts are readable — including
// auto-replacing an older running Pulse), then hands off to a hidden child
// (--daemon-child) that logs to ~/.burnglass/burnglass.log and is controlled from the
// dashboard's Server panel. --no-daemon keeps it in the console.
// ---------------------------------------------------------------------------
function shouldDaemonize(args) {
  return !!(seaApi && process.platform === 'win32' && !args.daemonChild && !args.noDaemon);
}

function daemonize(args, port, host) {
  probeInstance(port, (inst) => {
    // Same version OR NEWER already running → just open its dashboard. Never
    // auto-replace a newer Pulse with an older exe (silent downgrade).
    if (inst.kind === 'pulse' && versionNum(inst.version) >= versionNum(PULSE_VERSION)) {
      // --no-open is what the sign-in (Run key) launch passes: a second copy
      // racing the first at sign-in must not pop a browser window.
      console.log(`[burnglass] v${inst.version || PULSE_VERSION} is already running` +
        (args.noOpen ? ' — nothing to do (--no-open).' : ' — opening the dashboard.'));
      if (!args.noOpen) openBrowser(port);
      setTimeout(() => process.exit(0), 1200);
      return;
    }
    if (inst.kind === 'pulse') {
      // An OLDER Pulse holds the port. v1.1.0+ accepts a local stop request;
      // anything older must be closed by hand.
      console.log(`[burnglass] replacing running ${instanceName(inst.version)} ${inst.version ? 'v' + inst.version : '(pre-1.1.0)'}…`);
      requestShutdown(port, (ok) => {
        if (!ok) {
          console.error('\n[burnglass] The running Pulse is too old to stop automatically.');
          console.error('[burnglass] Close it (Task Manager → pulse.exe → End task), then run this again.');
          holdOpenAndExit(1);
          return;
        }
        waitForPortFree(port, 8000, (free) => {
          if (!free) {
            console.error('[burnglass] The old instance did not exit — close it manually and retry.');
            holdOpenAndExit(1);
            return;
          }
          spawnDaemon(args, port, host);
        });
      });
      return;
    }
    if (inst.kind === 'other') {
      console.error(`\n[burnglass] Port ${port} is already in use by another program.`);
      console.error('[burnglass] Try: ' + path.basename(process.execPath) + ' --port 4748');
      holdOpenAndExit(1);
      return;
    }
    spawnDaemon(args, port, host);
  });
}

function requestShutdown(port, cb) {
  cb = once(cb);
  const req = http.request({
    host: '127.0.0.1', port, path: '/api/shutdown', method: 'POST',
    headers: { 'X-Pulse': '1', 'Host': 'localhost' }, timeout: 2500,
  }, (res) => {
    // Pre-1.1.0 Pulse serves the SPA fallback (200 text/html) for unknown
    // routes — only a real {ok:true} JSON acknowledgment counts as stopped.
    let body = '';
    res.on('data', (d) => { body += d; if (body.length > 65536) req.destroy(); });
    res.on('end', () => {
      let ok = false;
      try { ok = res.statusCode === 200 && JSON.parse(body).ok === true; } catch (_) {}
      cb(ok);
    });
    res.on('error', () => cb(false));
  });
  req.on('error', () => cb(false));
  req.on('timeout', () => { req.destroy(); cb(false); });
  req.end();
}

function waitForPortFree(port, ms, cb) {
  const deadline = Date.now() + ms;
  (function poll() {
    probeInstance(port, (inst) => {
      if (inst.kind === 'free') return cb(true);
      if (Date.now() > deadline) return cb(false);
      setTimeout(poll, 350);
    });
  })();
}

function spawnDaemon(args, port, host) {
  const passthrough = process.argv.slice(2).filter((a) => a !== '--no-daemon');
  try {
    const child = require('child_process').spawn(process.execPath, [...passthrough, '--daemon-child'],
      { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (e) {
    console.error('[burnglass] failed to start the background process: ' + e.message);
    console.error('[burnglass] falling back to running in this window.');
    startServer(port, host, serverOpts(args));
    return;
  }
  console.log(`\n  Burnglass v${PULSE_VERSION} is starting in the background.`);
  console.log(`  Dashboard: http://localhost:${port}  (opens automatically)`);
  console.log(`  Logs, updates and Stop live in the dashboard's Server panel.`);
  console.log('  Tip: ' + path.basename(process.execPath) + ' --install-shortcuts adds Start/Stop buttons to your Desktop.');
  console.log('  (Run with --no-daemon to keep it in a console window.)');
  setTimeout(() => process.exit(0), 2500);
}

// ---------------------------------------------------------------------------
// START / STOP CONVENIENCES
// `--stop` stops a running instance from anywhere (shortcut, script, console).
// `--install-shortcuts` (Windows) drops "Pulse" (start / open dashboard —
// starting is idempotent) and "Pulse - Stop" shortcuts on the Desktop: a real
// start/stop button pair, since a stopped server cannot render one.
// ---------------------------------------------------------------------------
function stopRunning(port) {
  // Double-clicked stop shortcut: keep the window up long enough to read.
  const exitSoon = (code) => setTimeout(() => process.exit(code),
    seaApi && process.platform === 'win32' && process.stdin.isTTY ? 1600 : 0);
  probeInstance(port, (inst) => {
    if (inst.kind === 'free') {
      console.log(`[burnglass] nothing is running on port ${port}.`);
      return exitSoon(0);
    }
    if (inst.kind === 'other') {
      console.log(`[burnglass] port ${port} is in use by another program — nothing to stop.`);
      return exitSoon(1);
    }
    requestShutdown(port, (ok) => {
      if (!ok) {
        console.error(`[burnglass] the running ${instanceName(inst.version)} (${inst.version ? 'v' + inst.version : 'pre-1.1.0'}) does not support remote stop.`);
        console.error('[burnglass] Close it via Task Manager → pulse.exe / burnglass.exe → End task.');
        return exitSoon(1);
      }
      waitForPortFree(port, 8000, (free) => {
        console.log(free
          ? `[burnglass] stopped ${instanceName(inst.version)} ${inst.version ? 'v' + inst.version + ' ' : ''}on port ${port}.`
          : '[burnglass] stop acknowledged — the instance is taking a while to exit.');
        exitSoon(free ? 0 : 1);
      });
    });
  });
}

// Shortcut plumbing shared by --install-shortcuts and --install: WScript.Shell
// driven from powershell.exe. Both are Windows builtins, so no dependency.
// PowerShell ends a single-quoted string at ANY of ' \u2018 \u2019 \u201A
// \u201B (about_Quoting_Rules; the tray script is read as UTF-8 via its BOM),
// so every one is doubled — a quote followed by a quote is one literal of the
// SECOND kind, and doubling each in place round-trips the exact string. A
// profile folder like C:\Users\Seán O\u2019Neill must never end the literal.
function psQuote(s) { return "'" + String(s).replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&') + "'"; }
function createShortcuts(specs) {
  const lines = ['$W = New-Object -ComObject WScript.Shell;'];
  specs.forEach((s, i) => {
    lines.push(`$s${i} = $W.CreateShortcut(${psQuote(s.path)});`);
    lines.push(`$s${i}.TargetPath = ${psQuote(s.target)};`);
    if (s.args) lines.push(`$s${i}.Arguments = ${psQuote(s.args)};`);
    lines.push(`$s${i}.WorkingDirectory = ${psQuote(path.dirname(s.target))};`);
    if (s.description) lines.push(`$s${i}.Description = ${psQuote(s.description)};`);
    lines.push(`$s${i}.Save();`);
  });
  require('child_process').execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', lines.join(' ')],
    { stdio: 'ignore', windowsHide: true, timeout: 30000 });
}
// The Desktop is routinely redirected (OneDrive), so ask Windows for it rather
// than assuming %USERPROFILE%\Desktop — and keep the conventional spots as
// fallbacks, which --uninstall also sweeps. One powershell spawn per process.
let desktopDirsMemo = null;
function desktopDirs() {
  if (desktopDirsMemo) return desktopDirsMemo;
  const out = [];
  try {
    const s = require('child_process').execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('Desktop')"],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
    if (s) out.push(s);
  } catch (_) { /* fall back below */ }
  const home = os.homedir();
  const fallbacks = [path.join(home, 'Desktop')];
  if (process.env.ONEDRIVE) fallbacks.push(path.join(process.env.ONEDRIVE, 'Desktop'));
  for (const p of fallbacks) {
    if (!out.some((x) => samePath(x, p))) out.push(p);
  }
  desktopDirsMemo = out;
  return out;
}

// targetExe: what the shortcuts should point at (--install passes the INSTALLED
// copy; on its own this defaults to the running exe). Returns success.
function installShortcuts(targetExe) {
  const me = path.basename(process.execPath);
  if (process.platform !== 'win32') {
    console.log('[burnglass] Desktop shortcuts are Windows-only.');
    console.log('[burnglass] Start: run the binary (idempotent). Stop: --stop.');
    return false;
  }
  if (!seaApi) {
    console.log('[burnglass] run this from the packaged burnglass.exe so shortcuts point at it.');
    return false;
  }
  const exe = targetExe || process.execPath;
  const desktop = desktopDirs()[0];
  try {
    createShortcuts([
      { path: path.join(desktop, 'Burnglass.lnk'), target: exe,
        description: 'Start Burnglass (opens the dashboard if already running)' },
      { path: path.join(desktop, 'Burnglass - Stop.lnk'), target: exe, args: '--stop',
        description: 'Stop the running Burnglass' },
    ]);
    console.log('[burnglass] created Desktop shortcuts (-> ' + (targetExe ? path.basename(exe) : me) + '):');
    console.log('  "Burnglass"        — start (or open the dashboard if already running)');
    console.log('  "Burnglass - Stop" — stop the running Burnglass');
    return true;
  } catch (e) {
    console.error('[burnglass] could not create shortcuts: ' + ((e && e.message) || e));
    return false;
  }
}

// ---------------------------------------------------------------------------
// `--install` / `--uninstall` (Windows, packaged exe)
//
// The primitives the Inno Setup installer wraps, usable on their own: copy the
// exe into the per-user Programs folder, add Start Menu + Desktop shortcuts,
// and register in Add/Remove Programs. Everything lands under HKCU and
// %LOCALAPPDATA%/%APPDATA% — no admin rights anywhere, and nothing
// machine-wide. Uninstall reverses it but NEVER touches either home
// (~/.burnglass or the old ~/.pulse): a user's config and archived history
// are not ours to delete.
//
// PARITY WITH THE INSTALLER (build/installer.iss) — both must pick the SAME
// folder, or a v1 `--install` user who runs BurnglassSetup ends up with two
// installs, two Apps entries and two sign-in launches:
//   1. an Inno install (its {AppId}_is1 key's InstallLocation) — the installer
//      reuses it via UsePreviousAppDir;
//   2. else %LOCALAPPDATA%\Programs\Pulse when it holds pulse.exe or
//      burnglass.exe (a v1 install of either kind) — the installer's
//      DefaultDirName applies the same rule;
//   3. else %LOCALAPPDATA%\Programs\Burnglass (fresh).
// The main exe is burnglass.exe; a pulse.exe already in that folder is kept
// and refreshed as a byte-identical COMPAT TWIN (Claude Code hooks, pinned
// taskbar items and old Run values hold its absolute path, and Burnglass may
// never edit ~/.claude to re-point them). The HKCU Run value keeps its FROZEN
// name 'Pulse'. Inno-managed folders (unins000.exe present) are left to the
// installer: files written there outside it would be orphaned by its log.
// Removal only ever touches Run values, shortcuts and Apps entries whose
// target / InstallLocation is inside THIS install's folder.
// ---------------------------------------------------------------------------
const UNINSTALL_ROOT = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const UNINSTALL_KEY = UNINSTALL_ROOT + '\\Burnglass';
const LEGACY_UNINSTALL_KEY = UNINSTALL_ROOT + '\\Pulse'; // written by v1 --install
const INNO_UNINSTALL_KEY = UNINSTALL_ROOT + '\\{76C28179-9CBE-42EA-B9E6-7BE166115AD3}_is1'; // installer AppId: NEVER change
function localProgramsDir() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'Programs');
}
// reg.exe query → the value's data, or null (absent / unreadable / not win32).
function regQueryValue(key, name) {
  if (process.platform !== 'win32') return null;
  try {
    const out = require('child_process').execFileSync('reg.exe', ['query', key, '/v', name],
      { windowsHide: true, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp('^\\s*' + esc + '\\s+REG_[A-Z_]+\\s+(.*?)\\s*$', 'm').exec(out || '');
    return m ? m[1] : null;
  } catch (_) { return null; }
}
function regDeleteKey(key) {
  try {
    require('child_process').execFileSync('reg.exe', ['delete', key, '/f'],
      { windowsHide: true, timeout: 10000, stdio: ['ignore', 'ignore', 'pipe'] });
    return true;
  } catch (e) {
    if (e && e.status === 1) return false; // already gone
    throw e;
  }
}
const stripTrailingSep = (p) => String(p || '').replace(/[\\/]+$/, '');
// Is file p inside dir (case-insensitive on Windows)?
function pathInside(p, dir) {
  if (!p || !dir) return false;
  const norm = (x) => { const r = path.resolve(String(x)); return process.platform === 'win32' ? r.toLowerCase() : r; };
  const rel = path.relative(norm(dir), norm(p));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
function innoInstallDir() {
  const v = stripTrailingSep(regQueryValue(INNO_UNINSTALL_KEY, 'InstallLocation'));
  return v && isDir(v) ? v : null;
}
function programsDir() {
  const inno = innoInstallDir();
  if (inno) return inno;
  const legacy = path.join(localProgramsDir(), 'Pulse');
  if (isFileAt(path.join(legacy, 'pulse.exe')) || isFileAt(path.join(legacy, 'burnglass.exe'))) return legacy;
  return path.join(localProgramsDir(), 'Burnglass');
}
function installManagedByInno(dir) { return isFileAt(path.join(dir, 'unins000.exe')); }
function installedExePath(dir) { return path.join(dir || programsDir(), 'burnglass.exe'); }
function startMenuDir() {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
}
function startMenuLnk() { return path.join(startMenuDir(), 'Burnglass.lnk'); }
// Every shortcut name either version creates (Start Menu + each Desktop).
function shortcutCandidates() {
  const out = [path.join(startMenuDir(), 'Burnglass.lnk'), path.join(startMenuDir(), 'Pulse.lnk'),
    path.join(startMenuDir(), 'Burnglass - Stop.lnk'), path.join(startMenuDir(), 'Pulse - Stop.lnk')];
  for (const d of desktopDirs()) {
    for (const n of ['Burnglass.lnk', 'Burnglass - Stop.lnk', 'Pulse.lnk', 'Pulse - Stop.lnk']) out.push(path.join(d, n));
  }
  return out;
}
// .lnk → TargetPath via WScript.Shell (one powershell spawn). A shortcut whose
// target cannot be read is reported as '' — callers then leave it alone.
function shortcutTargets(paths) {
  const existing = paths.filter(isFileAt);
  const out = {};
  if (!existing.length || process.platform !== 'win32') return out;
  const lines = ['[Console]::OutputEncoding = [Text.Encoding]::UTF8;', '$W = New-Object -ComObject WScript.Shell;', '$o = [ordered]@{};'];
  for (const p of existing) lines.push(`try { $o[${psQuote(p)}] = $W.CreateShortcut(${psQuote(p)}).TargetPath } catch { $o[${psQuote(p)}] = '' };`);
  lines.push('$o | ConvertTo-Json -Compress');
  try {
    const raw = require('child_process').execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', lines.join(' ')],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const j = JSON.parse(String(raw).replace(/^﻿/, '').trim() || '{}');
    for (const p of existing) out[p] = typeof j[p] === 'string' ? j[p] : '';
  } catch (_) { for (const p of existing) out[p] = ''; }
  return out;
}
const samePath = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const errMsg = (e) => (e && e.message) || String(e);
// Copy src over dst the rename-aside way (dst may be running — a Claude Code
// --statusline copy — which blocks overwriting but not renaming).
function replaceFileFrom(src, dst) {
  fs.copyFileSync(src, dst + '.download');
  try { fs.unlinkSync(dst + '.old'); } catch (_) {}
  let aside = false;
  if (isFileAt(dst)) { fs.renameSync(dst, dst + '.old'); aside = true; }
  try { fs.renameSync(dst + '.download', dst); } catch (e) {
    if (aside) { try { fs.renameSync(dst + '.old', dst); } catch (_) {} }
    try { fs.unlinkSync(dst + '.download'); } catch (_) {}
    throw e;
  }
  if (aside) { try { fs.unlinkSync(dst + '.old'); } catch (_) { /* still running — removed on the next update */ } }
}

function installApp() {
  const me = path.basename(process.execPath);
  if (process.platform !== 'win32') {
    console.log('[burnglass] --install is Windows-only. Elsewhere: put the binary on your PATH.');
    return;
  }
  if (!seaApi) {
    console.log('[burnglass] run --install from the packaged burnglass.exe (a source checkout has nothing to install).');
    return;
  }
  const dir = programsDir();
  if (installManagedByInno(dir)) {
    console.log('[burnglass] ' + dir + ' is managed by the Burnglass (formerly Pulse) installer.');
    console.log('  Update it with BurnglassSetup.exe or the dashboard\'s one-click update;');
    console.log('  remove it from Settings > Apps. Nothing was changed.');
    return;
  }
  const target = installedExePath(dir);
  const twin = path.join(dir, 'pulse.exe');
  const changed = [];

  if (samePath(process.execPath, target)) {
    changed.push('already installed at ' + target + ' (no copy needed)');
  } else {
    try {
      fs.mkdirSync(dir, { recursive: true });
      replaceFileFrom(process.execPath, target);
      changed.push('copied ' + me + ' -> ' + target);
    } catch (e) {
      console.error('[burnglass] could not copy the executable to ' + target + ': ' + errMsg(e));
      console.error('[burnglass] if Burnglass is running from there, stop it first:  ' + me + ' --stop');
      return;
    }
  }
  // Upgrading a v1 --install folder: keep pulse.exe as a same-bytes twin.
  if (isFileAt(twin) && !samePath(process.execPath, twin)) {
    try { replaceFileFrom(target, twin); changed.push('refreshed the compat copy ' + twin + ' (older shortcuts, hooks and sign-in entries point at it)'); }
    catch (e) { console.warn('[burnglass] could not refresh ' + twin + ': ' + errMsg(e) + ' (it keeps working; retry after stopping it)'); }
  }

  // Shortcuts point at the INSTALLED copy, not at wherever this exe was run
  // from (the download in ~/Downloads is often deleted afterwards). Old
  // "Pulse" shortcuts are replaced only when they point into this folder — a
  // portable copy's own shortcuts are not ours.
  const olds = shortcutTargets(shortcutCandidates().filter((p) => /[\\/]Pulse( - Stop)?\.lnk$/i.test(p)));
  for (const [lnk, tgt] of Object.entries(olds)) {
    if (!pathInside(tgt, dir)) continue;
    try { fs.unlinkSync(lnk); changed.push('removed old shortcut ' + lnk); } catch (_) {}
  }
  try {
    fs.mkdirSync(startMenuDir(), { recursive: true });
    createShortcuts([{ path: startMenuLnk(), target, description: 'Start Burnglass (local usage dashboard)' }]);
    changed.push('Start Menu shortcut -> ' + startMenuLnk());
  } catch (e) {
    console.warn('[burnglass] could not create the Start Menu shortcut: ' + errMsg(e));
  }
  if (installShortcuts(target)) changed.push('Desktop shortcuts "Burnglass" and "Burnglass - Stop"');

  // Add/Remove Programs. HKCU\...\Uninstall is the per-user list, so this shows
  // up in Settings > Apps without any elevation.
  const vals = [
    ['DisplayName', 'REG_SZ', BRAND],
    ['DisplayVersion', 'REG_SZ', PULSE_VERSION],
    ['Publisher', 'REG_SZ', 'ReFxFrank'],
    ['InstallLocation', 'REG_SZ', dir],
    ['UninstallString', 'REG_SZ', `"${target}" --uninstall`],
    ['DisplayIcon', 'REG_SZ', target + ',0'],
    ['NoModify', 'REG_DWORD', '1'],
    ['NoRepair', 'REG_DWORD', '1'],
  ];
  try {
    for (const [name, type, data] of vals) {
      require('child_process').execFileSync('reg.exe',
        ['add', UNINSTALL_KEY, '/v', name, '/t', type, '/d', data, '/f'],
        { windowsHide: true, timeout: 10000, stdio: ['ignore', 'ignore', 'pipe'] });
    }
    changed.push('registered in Add/Remove Programs (uninstall with:  burnglass --uninstall)');
    // v1 --install's own entry for this same folder → one Apps entry, not two.
    if (samePath(stripTrailingSep(regQueryValue(LEGACY_UNINSTALL_KEY, 'InstallLocation') || ''), stripTrailingSep(dir))) {
      try { if (regDeleteKey(LEGACY_UNINSTALL_KEY)) changed.push('removed the old "Pulse" Add/Remove Programs entry'); } catch (_) {}
    }
  } catch (e) {
    console.warn('[burnglass] could not register in Add/Remove Programs: ' + errMsg(e));
  }

  // A sign-in entry (FROZEN value name 'Pulse') that launches a copy in this
  // folder is re-pointed at burnglass.exe; one elsewhere is not ours to touch.
  const st = startupState(true);
  if (st.enabled && pathInside(commandTarget(st.command), dir)) {
    const r = setStartup(true, target);
    if (r.ok) changed.push('run-at-startup entry now starts ' + target);
  }

  console.log('');
  console.log('[burnglass] installed v' + PULSE_VERSION + ':');
  for (const c of changed) console.log('  • ' + c);
  console.log('');
  console.log('  Your data stays in ' + appHome() + ' (config + archived history).');
  console.log('  Run at sign-in:  burnglass --startup on   (off again with --startup off)');
  console.log('  Note: Burnglass binaries are UNSIGNED, so Windows SmartScreen may warn');
  console.log('  the first time you run one. "More info" -> "Run anyway".');
  console.log('');
}

function uninstallApp() {
  if (process.platform !== 'win32') {
    console.log('[burnglass] --uninstall is Windows-only. Elsewhere: delete the binary you downloaded.');
    return;
  }
  if (!seaApi) {
    console.log('[burnglass] run --uninstall from the packaged burnglass.exe (a source checkout was never installed).');
    return;
  }
  // The folder to remove: the one this exe runs from when it is an install
  // folder (the Apps entry's UninstallString runs exactly that), else the
  // folder --install would pick.
  const exeDir = path.dirname(process.execPath);
  const isInstallDir = (d) => samePath(stripTrailingSep(d), stripTrailingSep(path.join(localProgramsDir(), 'Burnglass'))) ||
    samePath(stripTrailingSep(d), stripTrailingSep(path.join(localProgramsDir(), 'Pulse'))) ||
    samePath(stripTrailingSep(regQueryValue(UNINSTALL_KEY, 'InstallLocation') || ''), stripTrailingSep(d)) ||
    samePath(stripTrailingSep(regQueryValue(LEGACY_UNINSTALL_KEY, 'InstallLocation') || ''), stripTrailingSep(d));
  const dir = isInstallDir(exeDir) ? exeDir : programsDir();
  if (installManagedByInno(dir)) {
    console.log('[burnglass] ' + dir + ' was installed by the Burnglass (formerly Pulse) installer —');
    console.log('  uninstall it from Settings > Apps so its own uninstaller cleans up. Nothing was changed.');
    return;
  }
  const removed = [], left = [], kept = [];

  // 1. Startup entry first — an uninstalled copy must not be launched at
  // sign-in. Only when it launches a copy in THIS folder.
  const st = startupState(true);
  if (st.enabled) {
    if (pathInside(commandTarget(st.command), dir)) {
      const r = setStartup(false);
      if (r.ok) removed.push('run-at-startup entry (' + STARTUP_RUN_KEY + '\\' + STARTUP_VALUE_NAME + ')');
      else left.push('startup entry — ' + r.error);
    } else {
      kept.push('run-at-startup entry — it starts ' + st.command + ', not this install');
    }
  }

  // 2. Add/Remove Programs entries that describe THIS folder.
  for (const key of [UNINSTALL_KEY, LEGACY_UNINSTALL_KEY]) {
    const loc = regQueryValue(key, 'InstallLocation');
    if (loc == null || !samePath(stripTrailingSep(loc), stripTrailingSep(dir))) continue;
    try { if (regDeleteKey(key)) removed.push('Add/Remove Programs entry (' + key.split('\\').pop() + ')'); }
    catch (e) { left.push('Add/Remove Programs entry — ' + errMsg(e)); }
  }

  // 3. Shortcuts of either name whose target is inside this folder (every
  // Desktop candidate: the folder may be OneDrive-redirected).
  for (const [lnk, tgt] of Object.entries(shortcutTargets(shortcutCandidates()))) {
    if (!pathInside(tgt, dir)) continue;
    try { fs.unlinkSync(lnk); removed.push('shortcut ' + lnk); }
    catch (e) { if (e && e.code !== 'ENOENT') left.push('shortcut ' + lnk + ' — ' + errMsg(e)); }
  }

  // 4. The installed copies. Windows will not let a running process delete
  // its own image, so say so plainly instead of pretending it worked.
  let selfLeft = null;
  for (const n of ['burnglass.exe', 'pulse.exe', 'burnglass-strip.exe', 'pulse-strip.exe']) {
    const f = path.join(dir, n);
    if (!fs.existsSync(f)) continue;
    if (samePath(process.execPath, f)) {
      selfLeft = f;
      left.push(f + ' — still running as this process; delete it after this exits');
      continue;
    }
    try { fs.unlinkSync(f); removed.push(f); }
    catch (e) {
      left.push(f + ' — ' + errMsg(e) + (String(errMsg(e)).match(/EBUSY|EPERM/) ? ' (stop it first:  burnglass --stop)' : ''));
    }
  }
  if (!selfLeft) { try { fs.rmdirSync(dir); } catch (_) { /* other files there: leave the folder */ } }

  console.log('');
  console.log('[burnglass] uninstalled:');
  if (!removed.length) console.log('  • nothing to remove — Burnglass was not installed in ' + dir);
  for (const r of removed) console.log('  • removed ' + r);
  for (const l of left) console.log('  ! could not remove ' + l);
  for (const k of kept) console.log('  • kept ' + k);
  console.log('');
  const homes = [appHome()];
  const legacyKept = legacyCompatHome(); // a separate Pulse folder — not a link to this home, not PulseAudio's
  if (legacyKept) homes.push(legacyKept);
  for (const h of homes) console.log('  KEPT: ' + h + ' — your config, budget and archived history are untouched.');
  console.log('  Delete a folder yourself if you want it gone.');
  if (selfLeft) console.log('  KEPT: ' + selfLeft + ' (this executable) — remove it manually.');
  console.log('');
}

// `--startup on|off|status` — the CLI face of the Run-key entry. Writes the
// registry directly rather than going through a running server: the entry is
// per-user state that exists with or without a server, and a running one picks
// the change up when its 30s read memo expires. Always exits 0.
function startupCli(mode) {
  const m = String(mode || 'status').trim().toLowerCase();
  const where = startupStubFile()
    ? 'stub file ' + startupStubFile() + ' (BURNGLASS_STARTUP_STUB)'
    : STARTUP_RUN_KEY + '\\' + STARTUP_VALUE_NAME;
  if (!startupSupported()) {
    console.log('[burnglass] run at startup is Windows-only.');
    console.log('[burnglass] on macOS/Linux use launchd / a systemd --user unit running:');
    console.log('        ' + startupCommand());
    return;
  }
  if (m !== 'on' && m !== 'off' && m !== 'status') {
    console.log('[burnglass] usage: burnglass --startup on|off|status  (got "' + mode + '")');
  }
  if (m === 'on' || m === 'off') {
    const r = setStartup(m === 'on');
    if (!r.ok) {
      console.error('[burnglass] could not ' + (m === 'on' ? 'enable' : 'disable') + ' run at startup: ' + r.error);
      return; // still exit 0 — a startup toggle is never worth a failing shell
    }
    if (m === 'on') {
      console.log('[burnglass] run at startup ENABLED.');
      console.log('  ' + where);
      console.log('  = ' + r.command);
      if (!seaApi) console.log('  (source checkout — the entry runs node with this script; it breaks if either moves)');
      console.log('  Burnglass will start silently at sign-in (--no-open: no browser tab).');
      console.log('  Turn it off with:  burnglass --startup off');
    } else {
      console.log('[burnglass] run at startup DISABLED — removed ' + where);
    }
    return;
  }
  const s = startupState(true); // status must never answer from the memo
  console.log('[burnglass] run at startup: ' + (s.enabled ? 'ON' : 'off'));
  console.log('  ' + where);
  if (s.enabled) console.log('  = ' + s.command);
  console.log('  Change with:  burnglass --startup ' + (s.enabled ? 'off' : 'on'));
}

// ---------------------------------------------------------------------------
// CONFIG + CLI ENTRY
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// EFFORT / MODE HOOK  (`--mode-hook`)
//
// Claude Code does NOT write the reasoning effort level to transcripts, and
// (verified against the installed CLI) does not currently put it in the hook
// payload either. It DOES persist the level chosen with /effort to settings.json
// as `effortLevel`. Registered as a SessionStart + UserPromptSubmit hook (see
// --effort-setup), this subcommand reads that level (plus any payload/env source)
// and appends changes to the sidecar log that readModes() joins in. Reading
// settings.json is model-independent, so it captures effort for Fable too.
// It must never disturb a session: always exits 0, prints nothing, swallows
// every error. Writes ONLY to ~/.burnglass — reads ~/.claude but never writes there.
// ---------------------------------------------------------------------------

// Read the configured reasoning effort (`effortLevel`) from Claude Code's
// settings, honoring project-local overrides over the user-level file. Purely
// read-only. Returns a level string (e.g. "max") or null if none is set —
// which is also the case when the level equals the model default (the /effort
// picker stores the default as absent).
function readConfiguredEffort(cwd) {
  const files = [];
  if (cwd && typeof cwd === 'string') {
    files.push(path.join(cwd, '.claude', 'settings.local.json'));
    files.push(path.join(cwd, '.claude', 'settings.json'));
  }
  files.push(path.join(claudeDir(), 'settings.json'));
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { continue; }
    const v = j && j.effortLevel;
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && isFinite(v)) return String(v);
  }
  return null;
}

function runModeHook() {
  try {
    let raw = '';
    try { raw = fs.readFileSync(0, 'utf8'); } catch (_) {}
    let p = {};
    try { p = raw.trim() ? JSON.parse(raw) : {}; } catch (_) {}

    const sessionId = p.session_id || '';
    if (!sessionId) return;

    // Where the effort level comes from, in priority order:
    //   1. p.effort.level / p.effort — the hook payload field. NOTE: current
    //      Claude Code (verified against 2.1.x) does NOT put effort in the hook
    //      payload; this is future-proofing for versions/docs that do.
    //   2. CLAUDE_CODE_EFFORT_LEVEL / CLAUDE_EFFORT — env, if the CLI exports it.
    //   3. settings.json `effortLevel` — the value the /effort picker persists.
    //      This is the reliable source TODAY and is model-independent, so it is
    //      what makes Fable (and every other model) show real effort. Caveat:
    //      the picker only writes effortLevel when it differs from the model's
    //      default (default "high" is stored as absent), so a session left at
    //      the default has no explicit level to record.
    // Recorded verbatim so any future level name is preserved.
    let effort = null;
    if (p.effort && typeof p.effort === 'object' && p.effort.level) effort = String(p.effort.level);
    else if (typeof p.effort === 'string') effort = p.effort;
    else if (process.env.CLAUDE_CODE_EFFORT_LEVEL) effort = String(process.env.CLAUDE_CODE_EFFORT_LEVEL);
    else if (process.env.CLAUDE_EFFORT) effort = String(process.env.CLAUDE_EFFORT);
    else effort = readConfiguredEffort(p.cwd);

    const prompt = typeof p.prompt === 'string' ? p.prompt : '';
    const ultracode = /\bultracode\b/i.test(prompt) || /^ultracode$/i.test(effort || '');
    if (!effort && !ultracode) return;

    const rec = { ts: Date.now(), sessionId, event: p.hook_event_name || '', effort: effort || null };
    if (ultracode) rec.ultracode = true;
    if (p.model) rec.model = String(p.model);

    const file = modesFilePath();
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (_) {}

    // Append only when something changed for this session (hooks fire every
    // prompt; the log should only grow on change).
    try {
      const st = fs.statSync(file);
      if (st.size > 0 && st.size < 10 * 1024 * 1024) {
        const tail = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
        for (let i = tail.length - 1; i >= 0 && i >= tail.length - 200; i--) {
          let last;
          try { last = JSON.parse(tail[i]); } catch (_) { continue; }
          if (last.sessionId !== sessionId) continue;
          if (last.effort === rec.effort && !!last.ultracode === !!rec.ultracode) return;
          break;
        }
      }
    } catch (_) {}

    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  } catch (_) {}
}

// `--effort-setup` — print (never write) the settings.json snippet that
// enables effort logging. Pulse never modifies ~/.claude itself.
function effortSetup() {
  const cmdValue = seaApi
    ? `${q(process.execPath)} --mode-hook`
    : `${q(process.execPath)} ${q(__filename)} --mode-hook`;
  const hookEntry = [{ hooks: [{ type: 'command', command: cmdValue }] }];
  const snippet = { hooks: { SessionStart: hookEntry, UserPromptSubmit: hookEntry } };

  const settingsPath = path.join(claudeDir(), 'settings.json');
  console.log('\nBurnglass — effort logging setup');
  console.log('─'.repeat(64));
  console.log('Burnglass already reads `/effort <level>` commands straight from your');
  console.log('session transcripts — that needs NO setup and works retroactively.');
  console.log('This optional hook covers the one remaining case: an effort level');
  console.log('persisted in settings.json (applied across sessions) rather than');
  console.log('set per-session with /effort.');
  console.log('');
  printExistingIntegration('effort-hook', cmdValue);
  console.log(`1. Open:  ${settingsPath}`);
  console.log('   (create it if missing; if a "hooks" section exists, merge the');
  console.log('   two entries into it instead of replacing it)');
  console.log('');
  console.log('2. Add:');
  console.log(JSON.stringify(snippet, null, 2));
  console.log('');
  console.log('3. Restart your Claude Code sessions. New sessions log their');
  console.log(`   effort level to ${modesFilePath()}`);
  console.log('   and Burnglass picks it up automatically (nothing is ever written');
  console.log('   under ~/.claude by Burnglass).');
  console.log('');
  console.log('Note: /effort only stores a level when it differs from the model');
  console.log('default, so a session left at the default has no explicit level to');
  console.log('record and shows no effort chip. Pick a non-default level (or type');
  console.log('"ultracode") and it appears.');
  console.log('');
}

function q(s) {
  return /[\s"]/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s;
}

// ---------------------------------------------------------------------------
// `--statusline` — a Claude Code status line fed by Pulse.
// Claude Code pipes a JSON payload on stdin (model, context %, cost,
// rate_limits, …) and displays our stdout. We enrich it with Pulse's CACHED
// numbers — today's cross-tool spend, the current 5-hour block, official meter
// percentages — fetched from the running server over loopback, so the status
// line reflects ALL your usage without ever hitting a provider endpoint itself
// (the server is the single, throttled poller). Fast, and fail-open: any error
// still prints a useful line from the stdin payload alone, and we always exit 0
// (a non-zero exit blanks the status line).
// ---------------------------------------------------------------------------
// maxBytes guards a runaway response. The statusline feed is tiny; --summary
// pulls the full payload, which with two years of month periods is comfortably
// larger than 1 MB — hence the parameter rather than a shared constant.
function slHttpGetJson(url, timeoutMs, cb, maxBytes) {
  let done = false;
  const cap = maxBytes || 1e6;
  const finish = (e, d) => { if (!done) { done = true; cb(e, d); } };
  try {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return finish(new Error('HTTP ' + res.statusCode)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (body.length > cap) req.destroy(new Error('too large')); });
      res.on('end', () => { try { finish(null, JSON.parse(body)); } catch (e) { finish(e); } });
      res.on('error', finish);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', finish);
  } catch (e) { finish(e); }
}

function slDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + 'h' + (m ? m + 'm' : '');
  if (m > 0) return m + 'm';
  return s + 's';
}
function formatStatusline(ctx, data) {
  const noColor = !!process.env.NO_COLOR;
  const wrap = (open, s) => noColor ? s : '\x1b[' + open + 'm' + s + '\x1b[0m';
  const dim = (s) => wrap('2', s);
  const bold = (s) => wrap('1', s);
  const accent = (s) => wrap('38;5;141', s);
  const heat = (pct) => (s) => wrap(pct >= 85 ? '38;5;167' : pct >= 60 ? '38;5;179' : '38;5;71', s);
  const seg = [];

  const model = (ctx.model && (ctx.model.display_name || ctx.model.id)) || 'Claude';
  seg.push(accent('◉ ' + model));

  const cw = ctx.context_window;
  if (cw && typeof cw.used_percentage === 'number') {
    const p = Math.round(cw.used_percentage);
    seg.push(dim('ctx ') + heat(p)(p + '%'));
  }

  if (data && data.today) {
    seg.push(dim('today ') + bold(fmtMoney(data.today.cost)));
    if (data.block) {
      const left = data.block.endsAt - Date.now();
      seg.push(dim('5h ') + bold(fmtMoney(data.block.cost)) + (left > 0 ? dim(' ' + slDur(left)) : ''));
    }
  }

  // Weekly %: prefer Pulse's official meter (all devices); fall back to the
  // rate_limits Claude Code itself passes on stdin.
  let wk = data && data.meters && typeof data.meters.claudeWeekly === 'number' ? data.meters.claudeWeekly : null;
  if (wk == null && ctx.rate_limits && ctx.rate_limits.seven_day && typeof ctx.rate_limits.seven_day.used_percentage === 'number') {
    wk = Math.round(ctx.rate_limits.seven_day.used_percentage);
  }
  if (wk != null) seg.push(dim('wk ') + heat(wk)(wk + '%'));
  if (data && data.meters && typeof data.meters.codexWeekly === 'number') {
    seg.push(dim('cx ') + heat(data.meters.codexWeekly)(data.meters.codexWeekly + '%'));
  }

  return seg.join(noColor ? ' · ' : dim(' · '));
}

function runStatusline() {
  let input = '';
  let finished = false;
  const guard = setTimeout(() => finish(), 1500); // stdin should be instant; never hang the shell
  const finish = () => {
    if (finished) return; finished = true; clearTimeout(guard);
    let ctx = {};
    try { ctx = JSON.parse(input) || {}; } catch (_) {}
    const rt = readRuntimeFile();
    const host = (rt && rt.host) || '127.0.0.1';
    const port = (rt && rt.port) || (process.env.PORT ? parseInt(process.env.PORT, 10) : 4747);
    slHttpGetJson('http://' + host + ':' + port + '/api/statusline', 700, (err, data) => {
      let line;
      try { line = formatStatusline(ctx, err ? null : data); }
      catch (_) { line = (ctx.model && (ctx.model.display_name || ctx.model.id)) || BRAND; }
      // Exit from the write callback: process.exit() before stdout (a pipe)
      // flushes would truncate the line to nothing. A short backstop timer
      // guarantees we still exit if the callback never fires.
      const bail = setTimeout(() => process.exit(0), 400);
      if (bail.unref) bail.unref();
      try { process.stdout.write(line + '\n', () => process.exit(0)); }
      catch (_) { process.exit(0); }
    });
  };
  try {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { input += d; if (input.length > 1e6) finish(); });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  } catch (_) { finish(); }
}

// ---------------------------------------------------------------------------
// `--summary` — the dashboard's headline numbers in the terminal, no browser.
// Same discovery + fail-open discipline as --statusline: ask the RUNNING server
// (it already has everything parsed and cached) via ~/.burnglass/server.json, and
// only fall back to an in-process build when nothing is listening. Always
// exits 0 — a summary that fails to format must never break a shell script.
// ---------------------------------------------------------------------------
function summaryLines(s) {
  const noColor = !!process.env.NO_COLOR || !process.stdout.isTTY;
  const wrap = (open, t) => noColor ? t : '\x1b[' + open + 'm' + t + '\x1b[0m';
  const dim = (t) => wrap('2', t);
  const bold = (t) => wrap('1', t);
  const accent = (t) => wrap('38;5;141', t);
  const heat = (pct, t) => wrap(pct >= 85 ? '38;5;167' : pct >= 60 ? '38;5;179' : '38;5;71', t);
  const out = [];
  const row = (label, value, tail) => out.push('  ' + dim(label.padEnd(10)) + value + (tail ? ' ' + dim(tail) : ''));

  out.push('');
  out.push('  ' + accent(BRAND + ' v' + (s.version || PULSE_VERSION)) + dim(' — usage summary'));
  out.push('');

  const p30 = (s.periods || []).find((p) => p.key === 'last30');
  const spend = (label, o) => { if (o) row(label, bold(fmtMoney(o.cost || 0).padStart(9)), fmtTok(o.tokens || 0) + ' tokens'); };
  spend('today', s.today);
  spend('7 days', s.week);
  spend('30 days', p30);

  // Meter percentages, when the (opt-in) account meters are on. Codex's come
  // from the local rollout snapshots, so they can be present on their own.
  const meterRows = [];
  const buckets = (s.meters && s.meters.enabled && Array.isArray(s.meters.buckets)) ? s.meters.buckets : [];
  const fh = buckets.find((b) => b.key === 'five_hour');
  const wk = buckets.find((b) => b.key === 'seven_day' || b.key === 'seven_day_overall');
  if (fh) meterRows.push(['5h', fh]);
  if (wk) meterRows.push(['weekly', wk]);
  const cx = (s.codexMeters && Array.isArray(s.codexMeters.buckets) ? s.codexMeters.buckets : [])
    .find((b) => b.key === 'codex_secondary' && !b.stale);
  if (cx) meterRows.push(['codex wk', cx]);
  if (meterRows.length) {
    out.push('');
    for (const [label, b] of meterRows) {
      const pct = Math.round(b.pct || 0);
      const left = b.resetsAt && b.resetsAt > Date.now() ? 'resets in ' + slDur(b.resetsAt - Date.now()) : '';
      row(label, heat(pct, (pct + '%').padStart(9)), left); // pad the plain text, THEN color — escapes have width 0
    }
  }

  const pv = s.planValue;
  if (pv && pv.configured) {
    out.push('');
    const mult = pv.multiplier != null ? pv.multiplier.toFixed(1) + 'x' : '—';
    // Re-strip on render: the label is printed outside the colour gate, so a
    // control character stored by an older Pulse must not reach the terminal.
    const plabel = pv.label ? stripControl(pv.label) : '';
    row('plan', bold(mult), (plabel ? plabel + ' · ' : '') + fmtMoney(pv.cost) + '/mo vs ' + fmtMoney(pv.spend30) + ' in 30 days');
  }

  const byModel = (p30 && p30.byModel) || {};
  const top = Object.keys(byModel).sort((a, b) => byModel[b].cost - byModel[a].cost).slice(0, 3);
  if (top.length) {
    out.push('');
    out.push('  ' + dim('top models (30 days)'));
    for (const m of top) out.push('    ' + m.padEnd(26) + bold(fmtMoney(byModel[m].cost).padStart(9)));
  }
  out.push('');
  return out.join('\n');
}

function runSummary() {
  const done = (text) => {
    const bail = setTimeout(() => process.exit(0), 400); // stdout is a pipe; never hang
    if (bail.unref) bail.unref();
    try { process.stdout.write(text + '\n', () => process.exit(0)); }
    catch (_) { process.exit(0); }
  };
  const render = (s) => {
    let text;
    try { text = summaryLines(s); }
    catch (_) { text = '\n  Burnglass — summary unavailable (could not format the payload).\n'; }
    done(text);
  };
  const local = () => {
    // Nothing listening: parse in this process. Slower and it can't see the
    // server's cached meters, but it is the same code path the server runs.
    // parseAll and the pricing table narrate to the console; a readout piped
    // into another command has to be the readout alone, so mute them for the
    // build and restore before anything else can need them.
    const saved = [console.log, console.warn, console.error];
    console.log = console.warn = console.error = () => {};
    let s = null, err = null;
    try { s = buildSummary(null, { background: true }); } catch (e) { err = e; }
    [console.log, console.warn, console.error] = saved;
    if (err) return done('\n  Burnglass — could not read your usage logs: ' + (err.message || err) + '\n');
    render(s);
  };
  const rt = readRuntimeFile();
  const host = (rt && rt.host) || '127.0.0.1';
  const port = (rt && rt.port) || (process.env.PORT ? parseInt(process.env.PORT, 10) : 4747);
  slHttpGetJson('http://' + host + ':' + port + '/api/summary', 4000, (err, data) => {
    if (err || !data) return local();
    render(data);
  }, 32e6);
}

// ---------------------------------------------------------------------------
// CLAUDE CODE INTEGRATIONS — READ-ONLY health check
// The status line and the effort hook live in Claude Code's settings.json as
// an ABSOLUTE path to whichever exe printed the snippet (…\Programs\Pulse\
// pulse.exe, ~/Downloads/pulse-linux, ~/pulse/server.js …). The rename keeps
// those paths valid (in-place self-update, the installer's compat twin) —
// they only break if the file is deleted. Burnglass may never write under
// ~/.claude, so the fix is detection: parse the commands that carry
// --statusline / --mode-hook, resolve their target, and say so (server log,
// payload.integrations, the setup printers) when it no longer exists.
// ---------------------------------------------------------------------------
// First token of a command line ("quoted" or bare); for `node <script>` the
// script. Returns '' when there is nothing path-like. commandToken keeps a
// leading ~ as written; commandTarget expands it (the display form).
function commandTarget(cmd) { return expandTilde(commandToken(cmd)); }
function commandToken(cmd) {
  const toks = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(cmd || ''))) && toks.length < 12) toks.push(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]);
  // Skip a leading `env` and NAME=value assignments — a value there may be a
  // secret, and it is never the program anyway.
  while (toks.length && (toks[0] === 'env' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0]))) toks.shift();
  if (!toks.length) return '';
  let t = toks[0];
  if (/^node(\.exe)?$/i.test(path.basename(t)) && toks[1] && !toks[1].startsWith('-')) t = toks[1];
  return t;
}
function isTildePath(t) { return t === '~' || t.startsWith('~/') || t.startsWith('~\\'); }
function expandTilde(t) { return t && isTildePath(t) ? path.join(os.homedir(), t.slice(1)) : t; }
// Does the command's target exist? true / false, or null when it cannot be
// VERIFIED from here — never a false "missing" (that is a permanent warning
// bar over a status line that works). On Windows, Claude Code runs these
// commands through Git Bash: `/c/Users/…` (and `/cygdrive/c/…`) is the MSYS
// spelling of `C:\Users\…` and is checked as such; any other drive-less
// rooted path (`/usr/bin/…`, `\foo`) is a Git Bash mount or the current
// drive — unverifiable; and `~` is Git Bash's $HOME, which need not be the
// profile folder, so a tilde path that is not found there is unknown, not
// gone. opts (tests): { platform, home, exists }.
function integrationTargetExists(raw, opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  const win = platform === 'win32';
  const P = win ? path.win32 : path.posix;
  const exists = o.exists || fs.existsSync;
  if (!raw) return null;
  let t = String(raw);
  const tilde = isTildePath(t);
  if (tilde) t = P.join(o.home || os.homedir(), t.slice(1));
  else if (win) {
    const m = /^\/(?:cygdrive\/)?([a-zA-Z])(?:\/(.*))?$/.exec(t);
    if (m) t = m[1].toUpperCase() + ':\\' + (m[2] || '').replace(/\//g, '\\');
    else if (/^[\\/](?![\\/])/.test(t)) return null; // rooted, no drive: not checkable
  }
  if (!P.isAbsolute(t)) return null; // on PATH, relative, $VAR/…, %VAR%\…
  if (exists(t)) return true;
  return win && tilde ? null : false;
}
let integrationsMemo = { sig: '', list: [] };
function claudeIntegrations() {
  const f = path.join(claudeDir(), 'settings.json');
  let st;
  try { st = fs.statSync(f); } catch (_) { return []; }
  const sig = f + ':' + st.mtimeMs + ':' + st.size;
  if (integrationsMemo.sig === sig) return integrationsMemo.list;
  const list = [];
  let j = null;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
  const add = (kind, command, event) => {
    if (typeof command !== 'string') return;
    const flag = kind === 'statusline' ? '--statusline' : '--mode-hook';
    if (!command.includes(flag)) return;
    const raw = commandToken(command);
    const target = expandTilde(raw);
    list.push({
      kind, event: event || null, command, target: target || null,
      exists: integrationTargetExists(raw), // null = not a path we can check (on PATH, env var, Git Bash mount…)
      legacyName: !!target && /^pulse([.-]|$)/i.test(path.basename(target)),
    });
  };
  if (j && typeof j === 'object') {
    if (j.statusLine && typeof j.statusLine === 'object') add('statusline', j.statusLine.command);
    if (j.hooks && typeof j.hooks === 'object') {
      for (const ev of Object.keys(j.hooks)) {
        const arr = Array.isArray(j.hooks[ev]) ? j.hooks[ev] : [];
        for (const g of arr) for (const h of (g && Array.isArray(g.hooks) ? g.hooks : [])) add('effort-hook', h && h.command, ev);
      }
    }
  }
  integrationsMemo = { sig, list };
  return list;
}
let integrationsWarned = '';
function warnBrokenIntegrations() {
  let broken = [];
  try { broken = claudeIntegrations().filter((i) => i.exists === false); } catch (_) {}
  const key = broken.map((b) => b.kind + b.target).join('|');
  if (!broken.length || key === integrationsWarned) return;
  integrationsWarned = key;
  const me = seaApi ? path.basename(process.execPath) : 'node server.js';
  for (const b of broken) {
    console.warn('[burnglass] Claude Code ' + (b.kind === 'statusline' ? 'status line' : 'effort hook (' + b.event + ')') +
      ' points at a file that no longer exists: ' + b.target + ' — run `' + me + ' ' +
      (b.kind === 'statusline' ? '--statusline-setup' : '--effort-setup') + '` for the command to paste (Burnglass never edits ~/.claude).');
  }
}
// For the setup printers: what an existing entry of this kind needs.
function printExistingIntegration(kind, cmdValue) {
  let mine = [];
  try { mine = claudeIntegrations().filter((i) => i.kind === kind); } catch (_) {}
  const cur = mine.find((i) => i.command !== cmdValue);
  if (!cur) return;
  if (cur.exists === false) {
    console.log('! Your settings.json currently runs ' + cur.target + ',');
    console.log('  which no longer exists. Replace that command with the one below.');
  } else {
    console.log('Note: your settings.json already runs:  ' + cur.command);
    console.log('  ' + (cur.legacyName ? 'That older Pulse name still works; to' : 'To') + ' use THIS copy instead, replace it with the command below.');
  }
  console.log('');
}

// `--statusline-setup` — print (never write) the settings.json snippet. As with
// --effort-setup, Pulse never edits ~/.claude itself.
function statuslineSetup() {
  const cmdValue = seaApi
    ? `${q(process.execPath)} --statusline`
    : `${q(process.execPath)} ${q(__filename)} --statusline`;
  const snippet = { statusLine: { type: 'command', command: cmdValue, padding: 0, refreshInterval: 30 } };
  const settingsPath = path.join(claudeDir(), 'settings.json');
  console.log('\nBurnglass — status line setup');
  console.log('─'.repeat(64));
  console.log('Adds a Claude Code status line fed by Burnglass: your model + context');
  console.log('from Claude Code, plus today\'s cross-tool spend, the current 5-hour');
  console.log('block, and official meter %s that Burnglass already caches (so the');
  console.log('status line never polls a provider endpoint itself).');
  console.log('');
  printExistingIntegration('statusline', cmdValue);
  console.log(`1. Make sure Burnglass is running (the status line reads it over loopback).`);
  console.log('');
  console.log(`2. Open:  ${settingsPath}`);
  console.log('   (create it if missing; merge this key if the file already exists)');
  console.log('');
  console.log('3. Add:');
  console.log(JSON.stringify(snippet, null, 2));
  console.log('');
  console.log('4. Start a new Claude Code session. Burnglass never writes under ~/.claude;');
  console.log('   if Burnglass is stopped the line still shows model + context from');
  console.log('   Claude Code alone. Set NO_COLOR=1 to disable the ANSI colors.');
  console.log('');
}

function parseArgs(argv) {
  const out = {
    port: null, host: null, inspectSchema: false, modeHook: false, effortSetup: false,
    noOpen: false, noDaemon: false, daemonChild: false, afterUpdate: false,
    noUpdateCheck: false, version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') { out.port = parseInt(argv[++i], 10); }
    else if (a.startsWith('--port=')) { out.port = parseInt(a.slice(7), 10); }
    else if (a === '--host') { out.host = argv[++i]; }
    else if (a.startsWith('--host=')) { out.host = a.slice(7); }
    else if (a === '--inspect-schema') { out.inspectSchema = true; }
    else if (a === '--mode-hook') { out.modeHook = true; }
    else if (a === '--effort-setup') { out.effortSetup = true; }
    else if (a === '--summary') { out.summary = true; }
    else if (a === '--statusline') { out.statusline = true; }
    else if (a === '--statusline-setup') { out.statuslineSetup = true; }
    else if (a === '--no-open') { out.noOpen = true; }
    else if (a === '--tray') { out.tray = true; }
    else if (a === '--no-daemon') { out.noDaemon = true; }
    else if (a === '--daemon-child') { out.daemonChild = true; }
    else if (a === '--after-update') { out.afterUpdate = true; }
    else if (a === '--no-update-check') { out.noUpdateCheck = true; }
    else if (a === '--stop') { out.stop = true; }
    else if (a === '--install-shortcuts') { out.installShortcuts = true; }
    // `--startup` alone is a status read, so a missing argument is not an error.
    else if (a === '--startup') { out.startup = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : 'status'; }
    else if (a.startsWith('--startup=')) { out.startup = a.slice(10) || 'status'; }
    else if (a === '--install') { out.install = true; }
    else if (a === '--uninstall') { out.uninstall = true; }
    else if (a === '--version' || a === '-v') { out.version = true; }
    else if (a === '--help' || a === '-h') { out.help = true; }
  }
  return out;
}

function updateCheckEnabled(args) {
  if (args.noUpdateCheck || envv('NO_UPDATE_CHECK')) return false;
  return readConfig().updateCheck !== false;
}

function serverOpts(args) {
  return {
    // After a self-update the existing dashboard tab reloads itself — opening
    // another tab would duplicate it.
    open: !args.noOpen && !args.afterUpdate,
    updateCheck: updateCheckEnabled(args),
    // Windows tray icon: --tray flag or {"tray": true} in config.
    tray: !!args.tray || readConfig().tray === true,
    // an updated/replacing instance may need a moment for the old one's port
    retryBindUntil: (args.afterUpdate || args.daemonChild) ? Date.now() + 10000 : 0,
  };
}

function resolvePort(args) {
  if (args.port && !isNaN(args.port)) return args.port;
  if (process.env.PORT && !isNaN(parseInt(process.env.PORT, 10))) return parseInt(process.env.PORT, 10);
  return 4747;
}

function resolveHost(args) {
  return args.host || process.env.HOST || '127.0.0.1';
}

// Phase 0 helper: print the observed top-level keys and usage keys from a
// handful of real records so accessors can be confirmed against real data.
function inspectSchema() {
  const files = walkJsonl(projectsRoot());
  console.log(`[burnglass] --inspect-schema: found ${files.length} .jsonl file(s) under ${projectsRoot()}`);
  const topKeys = {}, msgKeys = {}, usageKeys = {}, entrypoints = {}, models = {};
  let sampled = 0, assistantWithUsage = 0;
  const SAMPLE_FILES = 8, SAMPLE_RECS = 200;

  for (const f of files.slice(0, SAMPLE_FILES)) {
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    let n = 0;
    for (const line of raw.split('\n')) {
      if (!line || n >= SAMPLE_RECS) continue;
      n++;
      let rec; try { rec = JSON.parse(line); } catch (_) { continue; }
      sampled++;
      for (const k of Object.keys(rec)) topKeys[k] = (topKeys[k] || 0) + 1;
      if (rec.entrypoint) entrypoints[rec.entrypoint] = (entrypoints[rec.entrypoint] || 0) + 1;
      if (rec.message && typeof rec.message === 'object') {
        for (const k of Object.keys(rec.message)) msgKeys[k] = (msgKeys[k] || 0) + 1;
        if (rec.message.model) models[rec.message.model] = (models[rec.message.model] || 0) + 1;
        if (rec.message.usage) {
          assistantWithUsage++;
          for (const k of Object.keys(rec.message.usage)) usageKeys[k] = (usageKeys[k] || 0) + 1;
        }
      }
    }
  }
  const show = (label, obj) => {
    console.log(`\n${label}:`);
    for (const [k, v] of Object.entries(obj).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k}  (${v})`);
    }
  };
  console.log(`\nsampled ${sampled} record(s); ${assistantWithUsage} assistant records with usage`);
  show('top-level keys', topKeys);
  show('message.* keys', msgKeys);
  show('message.usage.* keys', usageKeys);
  show('entrypoint values', entrypoints);
  show('models', models);
  console.log('');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    const me = seaApi ? path.basename(process.execPath) : 'node server.js';
    console.log(`Burnglass v${PULSE_VERSION} (formerly Pulse) — local usage dashboard for Claude Code, Codex and more\n`);
    console.log('Usage: ' + me + ' [--port N] [--host H] [--inspect-schema]');
    console.log('  --port N          listen port (default 4747, or $PORT)');
    console.log('  --host H          bind address (default 127.0.0.1, or $HOST).');
    console.log('                    Use 0.0.0.0 to expose on the network — see the');
    console.log('                    warning it prints; prefer an SSH tunnel instead.');
    console.log('  --effort-setup    print the Claude Code hooks snippet that enables');
    console.log('                    reasoning-effort logging (Burnglass never edits ~/.claude)');
    console.log('  --summary         print today / 7d / 30d spend, limit meters and top');
    console.log('                    models to the terminal and exit (no browser). Reads');
    console.log('                    the running server when there is one. NO_COLOR works.');
    console.log('  --statusline      run as a Claude Code status line (reads the JSON on');
    console.log('                    stdin, prints a line enriched with Burnglass\'s numbers)');
    console.log('  --statusline-setup  print the settings.json snippet to enable it');
    console.log('  --mode-hook       (internal) run as a Claude Code hook — records the');
    console.log('                    effort level to ' + modesFilePath());
    console.log('  --no-open         do not auto-open the browser (packaged exe only)');
    console.log('  --stop            stop the running Burnglass (or Pulse) instance and exit');
    console.log('  --tray            (Windows) notification-area icon: live spend/limit');
    console.log('                    tooltip, open dashboard/mini, stop. Or {"tray": true}.');
    console.log('  --install-shortcuts  (Windows) add "Burnglass" and "Burnglass - Stop"');
    console.log('                    shortcuts to the Desktop');
    console.log('  --startup on|off|status  (Windows) start Burnglass silently when you');
    console.log('                    sign in. Written outside ' + homeLabel() + ': a value under');
    console.log('                    HKCU\\...\\CurrentVersion\\Run (no admin).');
    console.log('  --install         (Windows exe) install to %LOCALAPPDATA%\\Programs\\Burnglass');
    console.log('                    (or the existing Programs\\Pulse folder when upgrading)');
    console.log('                    with Start Menu + Desktop shortcuts and an');
    console.log('                    Add/Remove Programs entry. The binaries are unsigned,');
    console.log('                    so SmartScreen may still warn.');
    console.log('  --uninstall       (Windows exe) undo --install and the startup entry.');
    console.log('                    Your ' + homeLabel() + ' config and history are kept.');
    console.log('  --no-daemon       (Windows exe) keep running in this console window');
    console.log('                    instead of backgrounding');
    console.log('  --no-update-check disable the GitHub version check and community counters');
    console.log('                    (Burnglass\'s only default-on network calls; also:');
    console.log('                    BURNGLASS_NO_UPDATE_CHECK=1 or {"updateCheck":false} in');
    console.log('                    ' + homeLabel('config.json') + ')');
    console.log('  --version         print the version and exit');
    console.log('  --inspect-schema  print observed record schema and exit');
    console.log('  env BURNGLASS_HOME  settings/history folder (default ~/.burnglass; a v1');
    console.log('                    ~/.pulse is copied there once, and kept as a backup).');
    console.log('                    Every BURNGLASS_* variable also answers to PULSE_*.');
    console.log('  env CLAUDE_DIR    override ~/.claude location');
    console.log('  env CODEX_DIR     override ~/.codex location (OpenAI Codex CLI logs,');
    console.log('                    ingested automatically when present)');
    return;
  }
  if (args.version) { console.log('burnglass v' + PULSE_VERSION); return; }
  if (args.modeHook) { runModeHook(); return; }
  if (args.summary) { runSummary(); return; }
  if (args.statusline) { runStatusline(); return; }
  if (args.statuslineSetup) { statuslineSetup(); return; }
  if (args.effortSetup) { effortSetup(); return; }
  if (args.inspectSchema) { inspectSchema(); return; }
  if (args.installShortcuts) { installShortcuts(); return; }
  if (args.startup) { startupCli(args.startup); return; }
  if (args.install) { installApp(); return; }
  if (args.uninstall) { uninstallApp(); return; }
  const port = resolvePort(args);
  const host = resolveHost(args);
  if (args.stop) { stopRunning(port); return; }
  if (args.daemonChild) IS_DAEMON_CHILD = true;
  if (args.afterUpdate) IS_AFTER_UPDATE = true;
  // Detached processes (hidden daemon, post-update relaunch on any platform)
  // have no console — their output must land in <home>/burnglass.log. While
  // the ~/.pulse → ~/.burnglass move is still pending the file is opened only
  // after it (listen callback, with the lines so far backfilled), so the
  // first v2 boot never litters the old folder with a log it abandons.
  if (args.daemonChild || args.afterUpdate) {
    if (homeMigrationPending()) logOpenDeferred = true;
    else openLogFile();
  }
  if (shouldDaemonize(args)) { daemonize(args, port, host); return; }
  startServer(port, host, serverOpts(args));
}

if (require.main === module) main();

// Exported for tests / self-check harnesses.
module.exports = {
  PRICING, priceFor, costForEntry, normalize, dedupKey,
  computeBlocks, floorToHour, aggregate, parseAll, tokensOf, localDateStr,
  psQuote, trayScript, integrationTargetExists, sameEntry,
};
