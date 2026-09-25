// =============================================================================
// notices.js — PURE helpers (no React, no DOM, no storage) behind the page-level
// fix-it notices and the help copy that names the program. Kept free of
// imports on purpose: test/web-notices.test.sh imports this file with plain
// Node, the same way model-families.test.sh imports model-families.js.
// lib.js re-exports what the sections use.
// =============================================================================

// The executable users double-click to start the server again. A DEFAULT only:
// prefer payload.exeName, the running exe's real filename — a self-updated v1
// install is still called pulse.exe (null when running from source).
export const EXE_NAME = 'burnglass.exe';

// The running exe's own file name when the server reports one (a self-updated
// v1 install is still pulse.exe), else the default. `data` may be null
// (whole-page states before the first payload). A FILE name for "double-click
// X" copy — for a command line use launchInfo(data).cmd.
export function exeName(data) {
  return (data && typeof data.exeName === 'string' && data.exeName) || EXE_NAME;
}

// How help copy tells the user to run THIS server again, from payload fields
// only (the payload has no platform field, and none is needed):
//   - from source (payload.packaged === false, exeName null): `node server.js`
//     on every OS — the same command the server's own log prints;
//   - a packaged Windows exe (its name ends in .exe): the bare file name, which
//     cmd runs from the exe's folder; double-click + shortcuts apply;
//   - a packaged Linux/macOS binary (burnglass-linux / -macos): `./<name>`,
//     as the README runs it — it is not on PATH;
//   - no payload yet: the Windows default (the unreachable page adds the
//     source form itself).
// A name with spaces or shell characters — a browser's "burnglass (1).exe" —
// is quoted so the command still works when pasted.
// Returns { cmd, file, source, windows, shortcuts }: `cmd` = the command
// prefix for a CLI flag, `file` = the file to double-click (null from
// source), `shortcuts` = --install-shortcuts exists here (packaged Windows).
const PLAIN_NAME = /^[A-Za-z0-9._+-]+$/;
export function launchInfo(data) {
  if (data && data.packaged === false) {
    return { cmd: 'node server.js', file: null, source: true, windows: false, shortcuts: false };
  }
  const file = exeName(data);
  const windows = /\.exe$/i.test(file);
  let cmd;
  if (windows) cmd = PLAIN_NAME.test(file) ? file : '"' + file + '"';
  else cmd = PLAIN_NAME.test(file) ? './' + file : "'./" + file.replace(/'/g, "'\\''") + "'";
  return { cmd, file, source: false, windows, shortcuts: windows };
}

// ---- Claude Code integrations (payload.integrations) ------------------------------
// The server reports ONE row per settings.json entry: the documented
// --effort-setup registers the same --mode-hook command under SessionStart AND
// UserPromptSubmit, so a moved exe arrives as several rows that differ only
// in `event`. Rendering rows one-to-one printed word-for-word duplicates.

const KIND_ORDER = { statusline: 0, 'effort-hook': 1 };
const byKind = (a, b) => (KIND_ORDER[a] ?? 9) - (KIND_ORDER[b] ?? 9) || (a < b ? -1 : a > b ? 1 : 0);

// System "Claude Code" fact rows: one per kind + target (first-seen order),
// with every hook event that runs it collected in `events`.
export function integrationRows(list) {
  const out = [];
  const seen = new Map();
  for (const i of Array.isArray(list) ? list : []) {
    if (!i || typeof i !== 'object' || !i.target) continue;
    const k = i.kind + '\u0000' + i.target;
    let row = seen.get(k);
    if (!row) {
      row = { kind: i.kind, target: i.target, exists: i.exists, legacyName: !!i.legacyName, events: [] };
      seen.set(k, row);
      out.push(row);
    } else {
      // Same file, so the same answer — but never let a later row hide "missing".
      if (i.exists === false) row.exists = false;
      if (i.legacyName) row.legacyName = true;
    }
    if (i.event && !row.events.includes(i.event)) row.events.push(i.event);
  }
  return out;
}

// Page-level fix-it notices: ONE per missing file, whatever points at it (a
// moved exe breaks the status line and the effort hook together; each
// affected kind needs its own setup command). `sig` identifies the issue for
// the per-issue dismissal: the missing file + which integrations run it — a
// new kind starting to run a dismissed file is a new issue and shows again.
export function integrationIssues(list) {
  const out = [];
  const seen = new Map();
  for (const i of Array.isArray(list) ? list : []) {
    if (!i || typeof i !== 'object' || i.exists !== false || !i.target) continue;
    let issue = seen.get(i.target);
    if (!issue) {
      issue = { target: i.target, kinds: [], events: [] };
      seen.set(i.target, issue);
      out.push(issue);
    }
    if (!issue.kinds.includes(i.kind)) issue.kinds.push(i.kind);
    if (i.event && !issue.events.includes(i.event)) issue.events.push(i.event);
  }
  for (const issue of out) {
    issue.kinds.sort(byKind);
    issue.sig = 'integration:' + issue.kinds.join('+') + ':' + issue.target;
  }
  return out;
}

export const INTEGRATION_SETUP_FLAG = { statusline: '--statusline-setup', 'effort-hook': '--effort-setup' };
export const INTEGRATION_NAME = { statusline: 'status line', 'effort-hook': 'effort hook' };

// ---- per-issue dismissals (stored by lib.js under a pulse-* localStorage key) ------
// Stored value: JSON {sig: dismissedAtMs}. Parsing never throws (a hand-edited
// or foreign value reads as "nothing dismissed"), and the newest
// DISMISS_MAX entries are kept so the value cannot grow without bound.
export const DISMISS_MAX = 24;
export function parseDismissed(raw) {
  let o = null;
  try { o = typeof raw === 'string' ? JSON.parse(raw) : null; } catch (_) { o = null; }
  const out = Object.create(null);
  if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
  for (const k of Object.keys(o)) {
    const t = o[k];
    if (k && typeof t === 'number' && Number.isFinite(t)) out[k] = t;
  }
  return out;
}
export function addDismissed(raw, sig, now) {
  const m = parseDismissed(raw);
  m[sig] = typeof now === 'number' ? now : Date.now();
  // The one just dismissed always survives the cap, even on a timestamp tie.
  const rest = Object.keys(m).filter((k) => k !== sig).sort((a, b) => m[b] - m[a]);
  const keep = [sig, ...rest].slice(0, DISMISS_MAX);
  const out = Object.create(null);
  for (const k of keep) out[k] = m[k];
  return JSON.stringify(out);
}
export function isDismissed(raw, sig) {
  return Object.prototype.hasOwnProperty.call(parseDismissed(raw), sig);
}
