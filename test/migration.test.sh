#!/bin/bash
# Pulse -> Burnglass (v2.0.0) home migration + rename compatibility, e2e.
# Unlike every other suite this one pins NO *_HOME: it sets a fake $HOME per
# case so the IMPLICIT resolution (~/.burnglass, legacy ~/.pulse) is what runs.
#  M1 fresh v2: no ~/.pulse is ever created; ~/.burnglass appears on the first
#     write; short-lived commands don't create a legacy home; read-only Claude
#     Code integration check flags a settings.json pointing at a deleted exe
#  M2 populated ~/.pulse is COPIED (allowlist, byte-identical), skipped names
#     are listed in the marker, config/history/modes/discord/meshy/strip state
#     arrive, the Meshy key is scrubbed from the legacy config (and exists in
#     exactly one file afterwards), a stale sentinel'd staging dir is swept
#     while decoys are kept, and ~/.pulse loses NOTHING (only server.json
#     mirror, tray.ps1 refresh and the key scrub touch it)
#  M3 restart is idempotent (marker unchanged); later v1 edits to the legacy
#     config are ignored; legacy history written after the move is MERGED
#     (new home wins ties, more-complete cell wins); a legacy-only modes.jsonl
#     record still yields its effort chip
#  M4 an existing (empty) ~/.burnglass means no copy
#  M5 BURNGLASS_HOME > PULSE_HOME > implicit; an explicit home never
#     migrates or mirrors; an empty BURNGLASS_* never masks PULSE_*
#  M6 migration failure (~/.burnglass is a FILE) -> degraded on ~/.pulse, no crash
#  M7 two servers racing the same HOME -> exactly one marker, no staging dirs
#  M8 port taken -> migration DEFERRED (nothing published); the next start does it
#  M9 --statusline picks the FRESHEST LIVE server.json across both homes
#  L1-L3 same-folder homes: ~/.pulse -> ~/.burnglass, ~/.burnglass -> ~/.pulse,
#     and a per-file config.json link (both directions) are ONE home — the
#     legacy Meshy-key scrub must never delete the only copy, at start or on a
#     dashboard key save
#  P1 permissions never widen: a 0700 ~/.pulse (+ 0700 history/) becomes a
#     0700 ~/.burnglass, file modes are kept, the key-holding config stays
#     0600 through a key save and the legacy scrub; P2 the default 755/644
#     layout is unchanged and a NEW key-holding config is created 0600
#  A1 a ~/.pulse with no Pulse file (PulseAudio's) is not migrated, mirrored
#     or reported; A2 one holding only a log + server.json switches homes but
#     never claims "settings and history were copied"
#  Q1 a home path with typographic apostrophes (U+2018..U+201B) yields a tray
#     script whose $logFile literal parses to the exact path (PowerShell's
#     quoting rule, unit harness) + psQuote round-trips every quote kind
#  I1 integrations exists-check: Git Bash /c/... and /cygdrive/c/... are
#     checked as C:\...; drive-less rooted and unfound ~ paths are unknown
#     (null) on Windows, never a false "missing"
#  H1 legacy history + custom-source rename: a legacy c-cell under a retired
#     name is not added beside its renamed new-home cell (no double count),
#     a removed source's legacy cells survive, a rename re-reads the cache
#  U1 updater: asset matching its own filename first, then new, then legacy;
#     follows a repo-rename 301; versionNum ranks 2.0.0-rc.1 BELOW 2.0.0
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
MOCKS=""
# KEEP_TMP=1 keeps the fixture homes for debugging (mocks are always killed).
cleanup() { for p in $MOCKS; do kill "$p" 2>/dev/null; done; if [ -n "${KEEP_TMP:-}" ]; then echo "TMP=$TMP"; else rm -rf "$TMP"; fi; }
trap cleanup EXIT
# This suite owns ports 5831-5856; a leftover listener would make results lie.
for p in $(seq 5831 5856); do
  curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$p/"; rc=$?
  if [ $rc -ne 7 ]; then echo "FAIL  port $p is already in use (curl rc=$rc) — stop whatever holds it"; exit 1; fi
done
CL=$TMP/claude
mkdir -p "$CL/projects/demo"
SECRET="msy-SECRET-KEY-do-not-leak-4711"

# Transcripts: two sessions today (s1 100k tokens, s2 200k) so effort chips
# from the modes sidecar(s) are measurable per session. settings.json points
# the status line at an exe that no longer exists (read-only check).
node -e '
const fs = require("fs"); const now = Date.now();
const A = (ms, sid, id, out) => ({ type: "assistant", timestamp: new Date(ms).toISOString(), sessionId: sid,
  requestId: "r" + id, cwd: "/p", message: { id: "m" + id, model: "claude-fable-5", usage: { input_tokens: 0, output_tokens: out } } });
fs.writeFileSync(process.argv[1] + "/projects/demo/s.jsonl",
  [A(now - 3600e3, "s1", 1, 100000), A(now - 3500e3, "s2", 2, 200000)].map(JSON.stringify).join("\n") + "\n");
fs.writeFileSync(process.argv[1] + "/settings.json", JSON.stringify({
  statusLine: { type: "command", command: "\"/nonexistent/gone/pulse-linux\" --statusline" },
  hooks: { SessionStart: [{ hooks: [{ type: "command", command: "\"" + process.execPath + "\" --mode-hook" }] }] },
}));
' "$CL"

SRV=""
start_srv() { # home port log [NAME=VALUE ...]
  local H=$1 P=$2 L=$3; shift 3
  env -u PULSE_HOME -u BURNGLASS_HOME -u PULSE_HISTORY_DIR -u PULSE_MODES_FILE \
    HOME="$H" CLAUDE_DIR="$CL" CODEX_DIR="$TMP/no-codex" \
    BURNGLASS_NO_TRAY_SPAWN=1 BURNGLASS_NO_STRIP_SPAWN=1 \
    BURNGLASS_MESHY_API=http://127.0.0.1:9 BURNGLASS_SUMMARY_MEMO_MS=0 "$@" \
    node "$ROOT/server.js" --port "$P" --no-update-check >"$L" 2>&1 &
  SRV=$!
}
wait_up() { for _ in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$1/api/health" && return 0; sleep 0.15; done; return 1; }
stop_srv() { kill "$1" 2>/dev/null; wait "$1" 2>/dev/null; }
summary() { curl -s "http://127.0.0.1:$1/api/summary" > "$2"; }
hash_tree() { (cd "$1" && find . -type f | LC_ALL=C sort | while read -r f; do printf '%s %s\n' "$(sha256sum "$f" | cut -c1-16)" "$f"; done) > "$2"; }

# ---------------------------------------------------------------- M1 fresh
H1=$TMP/h1; mkdir -p "$H1"
start_srv "$H1" 5831 "$TMP/m1.log"; wait_up 5831
summary 5831 "$TMP/m1.json"
stop_srv $SRV
env -u PULSE_HOME -u BURNGLASS_HOME HOME="$H1" CLAUDE_DIR="$CL" node "$ROOT/server.js" --statusline-setup > "$TMP/m1-setup.txt" 2>&1
echo '{"session_id":"sX","effort":"high"}' | env -u PULSE_HOME -u BURNGLASS_HOME HOME="$H1" CLAUDE_DIR="$CL" node "$ROOT/server.js" --mode-hook
H1B=$TMP/h1b; mkdir -p "$H1B" # short-lived commands only, never a server
echo '{}' | env -u PULSE_HOME -u BURNGLASS_HOME HOME="$H1B" PORT=4999 node "$ROOT/server.js" --statusline >/dev/null 2>&1
node "$ROOT/server.js" --version > "$TMP/version.txt"

# ---------------------------------------------------------------- M2 migrate
H2=$TMP/h2; LP=$H2/.pulse
mkdir -p "$LP/history" "$LP/webview-strip/Default" "$LP/bin" "$LP/strip-web"
node -e '
const fs = require("fs"); const [LP, SECRET, OUT] = process.argv.slice(1);
const now = Date.now(), dayMs = 86400e3;
const ds = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); };
const D1 = ds(now - 40 * dayMs), D2 = ds(now - 41 * dayMs), D3 = ds(now - 42 * dayMs);
const months = {};
const put = (d, rec) => { (months[d.slice(0, 7)] = months[d.slice(0, 7)] || {})[d] = rec; };
put(D1, { rows: [{ source: "cli", model: "claude-fable-5", cost: 1, tokens: 1000, messages: 5 }], sessions: 1 });
put(D3, { rows: [{ source: "cli", model: "claude-fable-5", cost: 2, tokens: 2000, messages: 2 }], sessions: 1 });
for (const m of Object.keys(months)) fs.writeFileSync(LP + "/history/" + m + ".json", JSON.stringify(months[m]));
fs.writeFileSync(LP + "/history/" + D1.slice(0, 7) + ".json.tmp", "partial");
fs.writeFileSync(LP + "/config.json", JSON.stringify({ budget: 42, meshy: true, meshyApiKey: SECRET, alertThresholds: [70, 90] }, null, 2) + "\n");
fs.writeFileSync(LP + "/meshy.json", JSON.stringify({ version: 1, tasks: {}, pruned: { credits: 37, tasks: 3, byType: {} } }));
fs.writeFileSync(LP + "/modes.jsonl", JSON.stringify({ ts: now - 7200e3, sessionId: "s1", event: "SessionStart", effort: "max" }) + "\n");
fs.writeFileSync(LP + "/discord-presence.json", JSON.stringify({ start: now - 3600e3, savedAt: now - 60e3 }));
fs.writeFileSync(LP + "/strip.json", JSON.stringify({ x: 10, y: 20 }));
fs.writeFileSync(LP + "/strip-ui.json", JSON.stringify({ theme: "dark" }));
fs.writeFileSync(LP + "/server.json", JSON.stringify({ port: 1, host: "127.0.0.1", pid: 999999999, startedAt: 1, version: "1.34.0" }));
fs.writeFileSync(LP + "/tray.ps1", "$myVer = \x271.34.0\x27\r\n# v1 tray\r\n");
fs.writeFileSync(LP + "/pulse.log", "old log\n");
fs.writeFileSync(LP + "/webview-strip/Default/Cookies", "x");
fs.writeFileSync(LP + "/bin/pulse-strip.exe", "MZ fake");
fs.writeFileSync(LP + "/strip-web/index.html", "<html>");
fs.writeFileSync(OUT, JSON.stringify({ D1, D2, D3 }));
' "$LP" "$SECRET" "$TMP/dates.json"
# staging dirs: a crashed run's stale stage (sentinel, >1h) must be swept; a
# same-pattern dir WITHOUT the sentinel and an off-pattern one WITH it are kept.
mkdir -p "$H2/.burnglass.migrating-123-abcdef" "$H2/.burnglass.migrating-124-abcdef" "$H2/.burnglass.migrating-x"
echo '{}' > "$H2/.burnglass.migrating-123-abcdef/BURNGLASS-MIGRATION-STAGE"
echo '{}' > "$H2/.burnglass.migrating-x/BURNGLASS-MIGRATION-STAGE"
echo keep > "$H2/.burnglass.migrating-124-abcdef/user-file"
touch -d '3 hours ago' "$H2/.burnglass.migrating-123-abcdef/BURNGLASS-MIGRATION-STAGE" "$H2/.burnglass.migrating-124-abcdef/user-file" "$H2/.burnglass.migrating-x/BURNGLASS-MIGRATION-STAGE"
cp -a "$LP" "$TMP/pulse-before"
start_srv "$H2" 5832 "$TMP/m2.log"; wait_up 5832
summary 5832 "$TMP/m2.json"
stop_srv $SRV
cp "$H2/.burnglass/migrated-from-pulse.json" "$TMP/marker-1.json" 2>/dev/null
grep -rl -- "$SECRET" "$H2" > "$TMP/secret-files.txt" 2>/dev/null
# snapshot BOTH homes as M2 left them (M3 below changes the legacy one on purpose)
cp -a "$LP" "$TMP/pulse-after-m2"; cp -a "$H2/.burnglass" "$TMP/burnglass-after-m2"

# ---------------------------------------------------------------- M3 restart
node -e '
const fs = require("fs"); const [LP, DATES] = process.argv.slice(1);
const { D1, D2, D3 } = JSON.parse(fs.readFileSync(DATES, "utf8"));
// a v1 process keeps running and writes the OLD home after the move:
const c = JSON.parse(fs.readFileSync(LP + "/config.json", "utf8")); c.budget = 99;
fs.writeFileSync(LP + "/config.json", JSON.stringify(c, null, 2) + "\n");
const months = {};
const load = (m) => months[m] || (months[m] = (() => { try { return JSON.parse(fs.readFileSync(LP + "/history/" + m + ".json", "utf8")); } catch (_) { return {}; } })());
load(D1.slice(0, 7))[D1] = { rows: [{ source: "cli", model: "claude-fable-5", cost: 9, tokens: 1000, messages: 5 }], sessions: 1 }; // tie -> new home wins
load(D2.slice(0, 7))[D2] = { rows: [{ source: "cli", model: "claude-fable-5", cost: 7, tokens: 700, messages: 3 }], sessions: 1 };  // legacy-only day
load(D3.slice(0, 7))[D3] = { rows: [{ source: "cli", model: "claude-fable-5", cost: 4, tokens: 4000, messages: 4 }], sessions: 1 }; // more complete -> wins
for (const m of Object.keys(months)) fs.writeFileSync(LP + "/history/" + m + ".json", JSON.stringify(months[m]));
fs.appendFileSync(LP + "/modes.jsonl", JSON.stringify({ ts: Date.now() - 7200e3, sessionId: "s2", event: "UserPromptSubmit", effort: "xhigh" }) + "\n");
' "$LP" "$TMP/dates.json"
start_srv "$H2" 5833 "$TMP/m3.log"; wait_up 5833
summary 5833 "$TMP/m3.json"
stop_srv $SRV
cp "$H2/.burnglass/migrated-from-pulse.json" "$TMP/marker-2.json" 2>/dev/null

# ---------------------------------------------------------------- M4 existing
H4=$TMP/h4; mkdir -p "$H4/.pulse" "$H4/.burnglass"
echo '{"budget": 11}' > "$H4/.pulse/config.json"
start_srv "$H4" 5834 "$TMP/m4.log"; wait_up 5834
summary 5834 "$TMP/m4.json"
stop_srv $SRV

# ---------------------------------------------------------------- M5 env precedence
H5=$TMP/h5; mkdir -p "$H5/.pulse" "$TMP/bh" "$TMP/ph"
echo '{"budget": 5}' > "$H5/.pulse/config.json"
echo '{"port":1,"pid":1,"startedAt":1}' > "$H5/.pulse/server.json"
echo '{"budget": 1}' > "$TMP/bh/config.json"
echo '{"budget": 2}' > "$TMP/ph/config.json"
cp -a "$H5/.pulse" "$TMP/h5-pulse-before"
start_srv "$H5" 5835 "$TMP/m5a.log" BURNGLASS_HOME="$TMP/bh" PULSE_HOME="$TMP/ph"; wait_up 5835
summary 5835 "$TMP/m5a.json"; stop_srv $SRV
start_srv "$H5" 5835 "$TMP/m5b.log" PULSE_HOME="$TMP/ph"; wait_up 5835
summary 5835 "$TMP/m5b.json"; stop_srv $SRV
start_srv "$H5" 5835 "$TMP/m5c.log" BURNGLASS_HOME= PULSE_HOME="$TMP/ph"; wait_up 5835
summary 5835 "$TMP/m5c.json"; stop_srv $SRV
# env alias precedence on a CLI path: BURNGLASS_STARTUP_STUB beats PULSE_STARTUP_STUB
env -u PULSE_HOME HOME="$H5" BURNGLASS_HOME="$TMP/bh" BURNGLASS_STARTUP_STUB="$TMP/stub-new.json" PULSE_STARTUP_STUB="$TMP/stub-old.json" \
  node "$ROOT/server.js" --startup on > "$TMP/m5-startup.txt" 2>&1

# ---------------------------------------------------------------- M6 failure
H6=$TMP/h6; mkdir -p "$H6/.pulse"
echo '{"budget": 6}' > "$H6/.pulse/config.json"
echo "not a folder" > "$H6/.burnglass"
start_srv "$H6" 5836 "$TMP/m6.log"; wait_up 5836
summary 5836 "$TMP/m6.json"; stop_srv $SRV

# ---------------------------------------------------------------- M7 race
H7=$TMP/h7; mkdir -p "$H7/.pulse/history"
echo '{"budget": 7}' > "$H7/.pulse/config.json"
for i in 1 2 3 4 5 6; do echo "{}" > "$H7/.pulse/history/2025-0$i.json"; done
start_srv "$H7" 5837 "$TMP/m7a.log"; S7A=$SRV
start_srv "$H7" 5838 "$TMP/m7b.log"; S7B=$SRV
wait_up 5837; wait_up 5838
summary 5837 "$TMP/m7a.json"; summary 5838 "$TMP/m7b.json"
stop_srv $S7A; stop_srv $S7B
ls -a "$H7" > "$TMP/m7-ls.txt"

# ---------------------------------------------------------------- M8 port taken
H8=$TMP/h8; mkdir -p "$H8/.pulse"
echo '{"budget": 8}' > "$H8/.pulse/config.json"
hash_tree "$H8/.pulse" "$TMP/h8-before.txt"
node -e 'require("http").createServer((q, s) => { s.writeHead(404); s.end("not burnglass"); }).listen(5839, "127.0.0.1")' &
BLOCK=$!; MOCKS="$MOCKS $BLOCK"
sleep 0.4
start_srv "$H8" 5839 "$TMP/m8a.log"; S8=$SRV
( sleep 12; kill $S8 2>/dev/null && echo "still-running" > "$TMP/m8-alive.txt" ) & WD=$!
wait $S8 2>/dev/null; echo "exit:$?" > "$TMP/m8-exit.txt"
kill $WD 2>/dev/null; wait $WD 2>/dev/null
hash_tree "$H8/.pulse" "$TMP/h8-after.txt"
[ -e "$H8/.burnglass" ] && echo yes > "$TMP/m8-published.txt"
ls -a "$H8" > "$TMP/m8-ls.txt"
kill $BLOCK 2>/dev/null; wait $BLOCK 2>/dev/null
sleep 0.3
start_srv "$H8" 5839 "$TMP/m8b.log"; wait_up 5839
summary 5839 "$TMP/m8b.json"; stop_srv $SRV

# ---------------------------------------------------------------- M9 freshest server.json
H9=$TMP/h9; mkdir -p "$H9/.pulse" "$H9/.burnglass"
mock_sl() { # port cost
  node -e 'const [p, c] = process.argv.slice(1); require("http").createServer((q, s) => { s.writeHead(200, { "Content-Type": "application/json" });
    s.end(JSON.stringify({ today: { cost: +c, tokens: 1 }, meters: {}, version: "1.34.0" })); }).listen(+p, "127.0.0.1")' "$1" "$2" &
}
mock_sl 5840 12.34; ML=$!; mock_sl 5841 56.78; MN=$!; MOCKS="$MOCKS $ML $MN"
DEAD=999999999
sleep 0.6
NOW=$(node -e 'console.log(Date.now())')
# (a) the NEW home's file is newer but its pid is dead -> the live legacy one wins
echo "{\"port\":5842,\"host\":\"127.0.0.1\",\"pid\":$DEAD,\"startedAt\":$((NOW+5000))}" > "$H9/.burnglass/server.json"
echo "{\"port\":5840,\"host\":\"127.0.0.1\",\"pid\":$ML,\"startedAt\":$NOW}" > "$H9/.pulse/server.json"
echo '{}' | env -u PULSE_HOME -u BURNGLASS_HOME HOME="$H9" NO_COLOR=1 node "$ROOT/server.js" --statusline > "$TMP/m9a.txt" 2>/dev/null
# (b) both alive -> the newer one wins
echo "{\"port\":5841,\"host\":\"127.0.0.1\",\"pid\":$MN,\"startedAt\":$((NOW+5000))}" > "$H9/.burnglass/server.json"
echo '{}' | env -u PULSE_HOME -u BURNGLASS_HOME HOME="$H9" NO_COLOR=1 node "$ROOT/server.js" --statusline > "$TMP/m9b.txt" 2>/dev/null
kill $ML $MN 2>/dev/null

# ---------------------------------------------------------------- L1-L3 same-folder homes
KEY1="msy-LINKED-key-1"; KEY2="msy-LINKED-key-2"
meshy_set() { # port key out
  curl -s -X POST -H 'X-Pulse: 1' -H 'Content-Type: application/json' -d "{\"key\":\"$2\"}" \
    "http://127.0.0.1:$1/api/meshy/enable" > "$3"
}
link_case() { # tag port home — start, summary, save KEY2 from the dashboard, stop
  start_srv "$3" "$2" "$TMP/$1.log"; wait_up "$2"
  summary "$2" "$TMP/$1-a.json"
  meshy_set "$2" "$KEY2" "$TMP/$1-set.json"
  summary "$2" "$TMP/$1-b.json"
  stop_srv $SRV
}
cfg_key() { printf '{"meshy":true,"meshyApiKey":"%s","budget":%s}\n' "$1" "$2"; }
# L1: data moved, a link left for old companions
HL1=$TMP/hl1; mkdir -p "$HL1/.burnglass/history"
cfg_key "$KEY1" 51 > "$HL1/.burnglass/config.json"
ln -s .burnglass "$HL1/.pulse"
link_case l1 5846 "$HL1"
# L2: "just point Burnglass at my old folder"
HL2=$TMP/hl2; mkdir -p "$HL2/.pulse/history"
cfg_key "$KEY1" 52 > "$HL2/.pulse/config.json"
ln -s .pulse "$HL2/.burnglass"
link_case l2 5847 "$HL2"
# L3: two real folders, only config.json shared (new -> old, then old -> new)
HL3=$TMP/hl3; mkdir -p "$HL3/.pulse/history" "$HL3/.burnglass"
cfg_key "$KEY1" 53 > "$HL3/.pulse/config.json"
ln -s ../.pulse/config.json "$HL3/.burnglass/config.json"
link_case l3 5848 "$HL3"
HL4=$TMP/hl4; mkdir -p "$HL4/.pulse/history" "$HL4/.burnglass"
cfg_key "$KEY1" 54 > "$HL4/.burnglass/config.json"
ln -s ../.burnglass/config.json "$HL4/.pulse/config.json"
link_case l4 5849 "$HL4"

# ---------------------------------------------------------------- P1/P2 permissions
HP1=$TMP/hp1; mkdir -p "$HP1/.pulse/history"
cfg_key "$KEY1" 61 > "$HP1/.pulse/config.json"
echo '{}' > "$HP1/.pulse/history/2025-01.json"
echo '{"version":1,"tasks":{}}' > "$HP1/.pulse/meshy.json"
chmod 700 "$HP1/.pulse" "$HP1/.pulse/history"; chmod 600 "$HP1/.pulse/config.json" "$HP1/.pulse/history/2025-01.json"; chmod 640 "$HP1/.pulse/meshy.json"
( umask 022; start_srv "$HP1" 5850 "$TMP/p1.log"; wait_up 5850
  stat -c '%n %a' "$HP1/.burnglass" "$HP1/.burnglass/history" "$HP1/.burnglass/config.json" \
    "$HP1/.burnglass/history/2025-01.json" "$HP1/.burnglass/meshy.json" "$HP1/.pulse/config.json" > "$TMP/p1-modes-a.txt"
  meshy_set 5850 "$KEY2" "$TMP/p1-set.json"
  stat -c '%n %a' "$HP1/.burnglass/config.json" "$HP1/.pulse/config.json" > "$TMP/p1-modes-b.txt"
  stop_srv $SRV )
HP2=$TMP/hp2; mkdir -p "$HP2/.pulse/history" "$TMP/hp2b"
echo '{"budget": 62}' > "$HP2/.pulse/config.json"; echo '{}' > "$HP2/.pulse/history/2025-01.json"
chmod 755 "$HP2/.pulse" "$HP2/.pulse/history"; chmod 644 "$HP2/.pulse/config.json" "$HP2/.pulse/history/2025-01.json"
( umask 022; start_srv "$HP2" 5851 "$TMP/p2.log"; wait_up 5851
  stat -c '%n %a' "$HP2/.burnglass" "$HP2/.burnglass/history" "$HP2/.burnglass/config.json" "$HP2/.burnglass/history/2025-01.json" > "$TMP/p2-modes.txt"
  stop_srv $SRV
  start_srv "$TMP/hp2b" 5851 "$TMP/p2b.log"; wait_up 5851   # fresh home: the key creates config.json
  meshy_set 5851 "$KEY2" "$TMP/p2b-set.json"
  stat -c '%n %a' "$TMP/hp2b/.burnglass/config.json" > "$TMP/p2b-modes.txt"
  stop_srv $SRV )

# ---------------------------------------------------------------- A1/A2 not-a-Pulse-home
HA1=$TMP/ha1; mkdir -p "$HA1/.pulse"
for f in 0123456789abcdef0123456789abcdef-default-sink 0123456789abcdef0123456789abcdef-stream-volumes.tdb \
  0123456789abcdef0123456789abcdef-card-database.tdb; do echo pa > "$HA1/.pulse/$f"; done
hash_tree "$HA1/.pulse" "$TMP/ha1-before.txt"
start_srv "$HA1" 5852 "$TMP/a1.log"; wait_up 5852
summary 5852 "$TMP/a1.json"; stop_srv $SRV
hash_tree "$HA1/.pulse" "$TMP/ha1-after.txt"
HA2=$TMP/ha2; mkdir -p "$HA2/.pulse"
echo "old log" > "$HA2/.pulse/pulse.log"
echo '{"port":1,"host":"127.0.0.1","pid":999999999,"startedAt":1,"version":"1.34.0"}' > "$HA2/.pulse/server.json"
start_srv "$HA2" 5853 "$TMP/a2.log"; wait_up 5853
summary 5853 "$TMP/a2.json"; stop_srv $SRV
start_srv "$HA2" 5853 "$TMP/a2b.log"; wait_up 5853
summary 5853 "$TMP/a2b.json"; stop_srv $SRV

# ---------------------------------------------------------------- Q1 typographic quotes
HQ="$TMP/hq/Seán O’Neill ‘x‚‛ 'y'"; mkdir -p "$HQ/.pulse"
echo '{"budget": 71}' > "$HQ/.pulse/config.json"
printf '$myVer = %s1.34.0%s\r\n# v1 tray\r\n' "'" "'" > "$HQ/.pulse/tray.ps1"
start_srv "$HQ" 5854 "$TMP/q1.log"; wait_up 5854
summary 5854 "$TMP/q1.json"; stop_srv $SRV
cp "$HQ/.pulse/tray.ps1" "$TMP/q1-tray.ps1" 2>/dev/null
# unit harness: the SAME rule PowerShell's tokenizer applies (CharTraits
# IsSingleQuote = ' U+2018 U+2019 U+201A U+201B; a quote followed by any
# quote is one escaped literal of the second kind; else it ends the string)
env -u PULSE_HOME -u BURNGLASS_HOME HOME="$HQ" node -e '
const fs = require("fs"), path = require("path");
const [ROOT, T, HQ] = process.argv.slice(1);
const SQ = new Set(["\x27", "\u2018", "\u2019", "\u201A", "\u201B"]);
function scanSq(s, i) { // s[i] is the opening quote -> { value, end } | null (unterminated)
  let out = ""; i++;
  for (;;) {
    if (i >= s.length) return null;
    const c = s[i];
    if (SQ.has(c)) { if (SQ.has(s[i + 1])) { out += s[i + 1]; i += 2; continue; } return { value: out, end: i + 1 }; }
    out += c; i++;
  }
}
const logLine = (script) => {
  const line = script.replace(/^\uFEFF/, "").split(/\r\n/)[0];
  const pre = "$logFile = ";
  if (!line.startsWith(pre) || !SQ.has(line[pre.length])) return { line, lit: null };
  const lit = scanSq(line, pre.length);
  return { line, lit, rest: lit ? line.slice(lit.end) : null };
};
const res = {};
try {
  const s = require(ROOT + "/server.js");
  const samples = ["C:\\Users\\Se\u00e1n O\u2019Neill\\.burnglass", "\u2018\u2019\u201A\u201B\x27", "a\x27\u2019b", "", "\u201B\u201B"];
  res.roundTrip = samples.map((x) => { const q = s.psQuote(x); const r = scanSq(q, 0); return !!r && r.value === x && r.end === q.length; });
  const l = logLine(s.trayScript(4747));
  res.unit = { value: l.lit && l.lit.value, rest: l.rest, expect: path.join(HQ, ".burnglass", "burnglass.log") };
  // the self-relaunch must pass its own path QUOTED (profiles with spaces)
  res.relaunchQuoted = /\x27-File\x27, \(\x27"\x27 \+ \$PSCommandPath \+ \x27"\x27\)/.test(s.trayScript(4747));
} catch (e) { res.err = String(e && e.message || e); }
try { const l = logLine(fs.readFileSync(T + "/q1-tray.ps1", "utf8")); res.file = { value: l.lit && l.lit.value, rest: l.rest }; } catch (e) { res.fileErr = String(e.message); }
fs.writeFileSync(T + "/q1-unit.json", JSON.stringify(res));
' "$ROOT" "$TMP" "$HQ" >/dev/null 2>&1

# ---------------------------------------------------------------- I1 integrations (Windows paths)
node -e '
const fs = require("fs"); const [ROOT, T] = process.argv.slice(1);
const res = {};
try {
  const { integrationTargetExists: X } = require(ROOT + "/server.js");
  const have = new Set(["C:\\Users\\frank\\AppData\\Local\\Programs\\Pulse\\pulse.exe", "C:\\Users\\frank\\bin\\pulse.exe",
    "C:/Users/frank/tools/pulse.exe"]); // a C:/ path is passed through as written (Windows accepts it)
  const W = { platform: "win32", home: "C:\\Users\\frank", exists: (p) => have.has(p) };
  const L = { platform: "linux", home: "/home/frank", exists: (p) => p === "/home/frank/bin/pulse-linux" };
  res.cases = [
    ["msys existing",       X("/c/Users/frank/AppData/Local/Programs/Pulse/pulse.exe", W), true],
    ["cygdrive existing",   X("/cygdrive/c/Users/frank/AppData/Local/Programs/Pulse/pulse.exe", W), true],
    ["msys gone",           X("/c/Users/frank/Downloads/pulse.exe", W), false],
    ["native gone",         X("C:\\Users\\frank\\Downloads\\pulse.exe", W), false],
    ["forward-slash drive", X("C:/Users/frank/tools/pulse.exe", W), true],
    ["git-bash mount",      X("/usr/bin/pulse", W), null],
    ["drive-less rooted",   X("\\tools\\pulse.exe", W), null],
    ["tilde found",         X("~/bin/pulse.exe", W), true],
    ["tilde not found",     X("~/gone/pulse.exe", W), null],
    ["on PATH",             X("pulse", W), null],
    ["posix tilde found",   X("~/bin/pulse-linux", L), true],
    ["posix tilde gone",    X("~/gone/pulse-linux", L), false],
    ["posix absolute gone", X("/opt/gone/pulse-linux", L), false],
  ].map(([n, got, want]) => ({ n, got, want }));
} catch (e) { res.err = String(e && e.message || e); }
fs.writeFileSync(T + "/i1.json", JSON.stringify(res));
' "$ROOT" "$TMP" >/dev/null 2>&1

# ---------------------------------------------------------------- H1 legacy history x custom rename
HH=$TMP/hh; mkdir -p "$HH/.pulse/history" "$HH/.burnglass/history"
node -e '
const fs = require("fs"); const [HH, OUT] = process.argv.slice(1);
const now = Date.now(), dayMs = 86400e3;
const ds = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); };
const D = ds(now - 40 * dayMs), E = ds(now - 41 * dayMs), F = ds(now - 42 * dayMs);
const nh = {}, lh = {};
const put = (o, d, rows) => { const m = d.slice(0, 7); (o[m] = o[m] || {})[d] = { rows, sessions: 1 }; };
const cli = { source: "cli", model: "claude-fable-5", cost: 1, tokens: 100, messages: 1 };
// D: renamed myagent -> agent2 in v2; the re-seal healed ONLY the new home
put(nh, D, [cli, { source: "agent2", model: "m1", cost: 10, tokens: 1000, messages: 2, c: 1 }]);
put(lh, D, [cli, { source: "myagent", model: "m1", cost: 10, tokens: 1000, messages: 2, c: 1 },
            { source: "codex", model: "gpt-5.5", cost: 3, tokens: 300, messages: 1 }]);
// E: a source REMOVED from config (no configured custom cell that day) keeps its legacy cells
put(nh, E, [cli]);
put(lh, E, [{ source: "removedtool", model: "m1", cost: 5, tokens: 500, messages: 1, c: 1 }]);
// F: same configured name on both sides -> the more complete cell wins
put(nh, F, [{ source: "agent2", model: "m1", cost: 4, tokens: 400, messages: 2, c: 1 }]);
put(lh, F, [{ source: "agent2", model: "m1", cost: 6, tokens: 600, messages: 3, c: 1 }]);
for (const m of Object.keys(nh)) fs.writeFileSync(HH + "/.burnglass/history/" + m + ".json", JSON.stringify(nh[m]));
for (const m of Object.keys(lh)) fs.writeFileSync(HH + "/.pulse/history/" + m + ".json", JSON.stringify(lh[m]));
fs.writeFileSync(HH + "/.burnglass/config.json", JSON.stringify({ customSources: [{ name: "agent2", path: HH + "/agent.jsonl" }] }));
fs.writeFileSync(OUT, JSON.stringify({ D, E, F }));
' "$HH" "$TMP/h1-dates.json"
start_srv "$HH" 5855 "$TMP/h1.log"; wait_up 5855
summary 5855 "$TMP/h1a.json"
node -e 'require("fs").writeFileSync(process.argv[1] + "/.burnglass/config.json", JSON.stringify({ customSources: [
  { name: "agent2", path: process.argv[1] + "/agent.jsonl" }, { name: "myagent", path: process.argv[1] + "/agent.jsonl" }] }))' "$HH"
summary 5855 "$TMP/h1b.json"
stop_srv $SRV

# ---------------------------------------------------------------- U1 updater
REL=$TMP/release.json
node -e '
const http = require("http"), fs = require("fs"); const REL = process.argv[1];
http.createServer((q, s) => {
  if (q.url.startsWith("/repos/ReFxFrank/Pulse-Usage-Monitor/")) { s.writeHead(301, { Location: "/repositories/1/releases/latest" }); return s.end(); }
  s.writeHead(200, { "Content-Type": "application/json" }); s.end(fs.readFileSync(REL, "utf8"));
}).listen(5843, "127.0.0.1");
' "$REL" &
MU=$!; MOCKS="$MOCKS $MU"
asset() { printf '{"name":"%s","browser_download_url":"http://127.0.0.1:9/%s","digest":"sha256:%064d","size":6000000}' "$1" "$1" 0; }
rel() { echo "{\"tag_name\":\"$1\",\"assets\":[$2]}" > "$REL"; }
check() { curl -s -X POST -H 'X-Pulse: 1' "http://127.0.0.1:$1/api/update/check" > "$2"; }
H10=$TMP/h10; mkdir -p "$H10"
sleep 0.3
start_upd() { # port [NAME=VALUE]
  local P=$1; shift
  env -u PULSE_HOME HOME="$H10" CLAUDE_DIR="$CL" CODEX_DIR="$TMP/no-codex" BURNGLASS_NO_TRAY_SPAWN=1 \
    PULSE_UPDATE_API="http://127.0.0.1:5843/repos/ReFxFrank/Pulse-Usage-Monitor/releases/latest" "$@" \
    node "$ROOT/server.js" --port "$P" --no-update-check >"$TMP/u-$P.log" 2>&1 &
  SRV=$!
}
start_upd 5844; wait_up 5844
# mock "newer" releases use 99.x so they stay newer than whatever version is running
rel v99.0.1 "$(asset pulse-linux),$(asset burnglass-linux)"; check 5844 "$TMP/u1.json"
rel v99.0.1 "$(asset pulse-linux)";                          check 5844 "$TMP/u2.json"
rel v2.0.0-rc.1 "$(asset burnglass-linux)";                  check 5844 "$TMP/u3.json"
rel v99.0.1-rc.2 "$(asset burnglass-linux)";                 check 5844 "$TMP/u4.json"
rel v1.34.0 "$(asset pulse-linux)";                          check 5844 "$TMP/u5.json"
stop_srv $SRV
start_upd 5845 BURNGLASS_SELF_EXE_NAME=pulse-linux; wait_up 5845
rel v99.0.1 "$(asset burnglass-linux),$(asset pulse-linux)"; check 5845 "$TMP/u6.json"
stop_srv $SRV

# ---------------------------------------------------------------- assertions
node -e '
const fs = require("fs"), path = require("path");
const [T, SECRET, ROOT] = process.argv.slice(1);
const V = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + "  " + m); if (!c) fail = 1; };
const J = (f) => { try { return JSON.parse(fs.readFileSync(path.join(T, f), "utf8")); } catch (_) { return null; } };
const R = (f) => { try { return fs.readFileSync(path.join(T, f), "utf8"); } catch (_) { return ""; } };
const exists = (p) => fs.existsSync(path.join(T, p));
const stages = (h) => fs.readdirSync(path.join(T, h)).filter((n) => /^\.burnglass\.migrating-/.test(n));

// ---- M1
const m1 = J("m1.json") || {};
ok(m1.brand === "Burnglass" && m1.version === V, "M1: payload brand Burnglass v" + V + " (" + m1.brand + " " + m1.version + ")");
ok(m1.home === path.join(T, "h1", ".burnglass"), "M1: fresh home is ~/.burnglass (" + m1.home + ")");
ok(!exists("h1/.pulse"), "M1: no ~/.pulse is ever created");
ok(exists("h1/.burnglass/server.json"), "M1: ~/.burnglass appears on the first write (server.json)");
ok(m1.homeMigration === null, "M1: homeMigration null on a fresh install");
ok(exists("h1/.burnglass/modes.jsonl") && /"sX"/.test(R("h1/.burnglass/modes.jsonl")), "M1: --mode-hook writes the new home");
ok(!exists("h1b/.pulse") && !exists("h1b/.burnglass"), "M1: a short-lived --statusline creates no home at all");
ok(R("version.txt").split(/\r?\n/).includes("burnglass v" + V), "M1: --version says burnglass v" + V);
const integ = m1.integrations || [];
const sl = integ.find((i) => i.kind === "statusline"), hk = integ.find((i) => i.kind === "effort-hook");
ok(sl && sl.exists === false && sl.target === "/nonexistent/gone/pulse-linux" && sl.legacyName === true,
   "M1: integrations flags the status line pointing at a deleted exe (" + JSON.stringify(sl) + ")");
ok(hk && hk.exists === true && hk.event === "SessionStart", "M1: an effort hook whose exe exists reads exists:true");
ok(/points at a file that no longer exists: \/nonexistent\/gone\/pulse-linux/.test(R("m1.log")), "M1: server log warns about the dead status-line target (read-only)");
ok(/no longer exists/.test(R("m1-setup.txt")), "M1: --statusline-setup tells the user to replace the dead command");
ok(!/\[pulse\]/.test(R("m1.log")) && /\[burnglass\]/.test(R("m1.log")), "M1: log lines carry the [burnglass] tag");

// ---- M2
const m2 = J("m2.json") || {};
// M2 state as the first run left it (M3 later edits ~/.pulse on purpose);
// payload paths still name the real homes.
const NB_REAL = path.join(T, "h2", ".burnglass"), LP_REAL = path.join(T, "h2", ".pulse");
const NB = path.join(T, "burnglass-after-m2"), LP = path.join(T, "pulse-after-m2"), BEFORE = path.join(T, "pulse-before");
ok(m2.home === NB_REAL, "M2: home switched to ~/.burnglass (" + m2.home + ")");
ok(m2.homeMigration && m2.homeMigration.status === "migrated" && m2.homeMigration.from === LP_REAL,
   "M2: payload.homeMigration = migrated from ~/.pulse (" + JSON.stringify(m2.homeMigration) + ")");
ok(m2.budget && m2.budget.target === 42, "M2: migrated config honoured (budget 42)");
ok(JSON.stringify(m2.alertThresholds) === "[70,90]", "M2: migrated alertThresholds honoured");
const same = (rel) => { try { return fs.readFileSync(path.join(BEFORE, rel)).equals(fs.readFileSync(path.join(NB, rel))); } catch (_) { return false; } };
for (const f of ["config.json", "meshy.json", "modes.jsonl", "discord-presence.json", "strip.json", "strip-ui.json"]) {
  ok(same(f), "M2: " + f + " copied byte-identical");
}
const hist = fs.readdirSync(path.join(BEFORE, "history")).filter((n) => /\.json$/.test(n));
ok(hist.length > 0 && hist.every((n) => same("history/" + n)), "M2: every history month copied byte-identical (" + hist.join(",") + ")");
ok(!fs.readdirSync(path.join(NB, "history")).some((n) => /\.tmp$/.test(n)), "M2: history *.tmp partials NOT copied");
for (const n of ["pulse.log", "tray.ps1", "webview-strip", "bin", "strip-web", "burnglass.log"]) ok(!fs.existsSync(path.join(NB, n)), "M2: " + n + " not copied");
const sj = JSON.parse(fs.readFileSync(path.join(NB, "server.json"), "utf8"));
ok(sj.port === 5832 && sj.version === V, "M2: new server.json is this server, not the stale copy");
const mk = J("marker-1.json") || {};
ok(mk.from === LP_REAL && mk.by === V && Array.isArray(mk.copied) && mk.copied.includes("config.json") && mk.copied.some((c) => /^history\//.test(c)),
   "M2: marker records source, version and copied items");
ok(Array.isArray(mk.skipped) && ["pulse.log", "server.json", "tray.ps1", "webview-strip", "bin", "strip-web"].every((n) => mk.skipped.includes(n)),
   "M2: marker lists the skipped names (" + (mk.skipped || []).join(",") + ")");
ok(m2.meshy && m2.meshy.hasKey === true, "M2: the Meshy key moved with the config (hasKey)");
// the legacy home: nothing removed, nothing added; only the three compat writes changed bytes
const walk = (d, b = d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name), b) : [path.relative(b, path.join(d, e.name))]).sort();
const before = walk(BEFORE), after = walk(LP);
ok(JSON.stringify(before) === JSON.stringify(after), "M2: ~/.pulse keeps exactly its files — nothing deleted, nothing added");
const changed = before.filter((f) => !fs.readFileSync(path.join(BEFORE, f)).equals(fs.readFileSync(path.join(LP, f))));
ok(JSON.stringify(changed.sort()) === JSON.stringify(["config.json", "server.json", "tray.ps1"]),
   "M2: only config.json (key scrub), server.json (mirror) and tray.ps1 (refresh) changed (" + changed.join(",") + ")");
const lc = JSON.parse(fs.readFileSync(path.join(LP, "config.json"), "utf8"));
ok(!("meshyApiKey" in lc) && lc.budget === 42 && lc.meshy === true, "M2: legacy config lost ONLY meshyApiKey");
const secretFiles = R("secret-files.txt").trim().split("\n").filter(Boolean);
ok(secretFiles.length === 1 && secretFiles[0] === path.join(NB_REAL, "config.json"),
   "M2: the Meshy key exists in exactly one file afterwards (" + secretFiles.join(",") + ")");
ok(!R("m2.log").includes(SECRET), "M2: the Meshy key never reaches the server log");
const lsj = JSON.parse(fs.readFileSync(path.join(LP, "server.json"), "utf8"));
ok(lsj.port === 5832 && lsj.version === V, "M2: legacy server.json mirrored for old strips/statuslines");
const tray = fs.readFileSync(path.join(LP, "tray.ps1"), "utf8");
ok(tray.includes("$myVer = \x27" + V + "\x27") && /PulseTray5832/.test(tray) && tray.includes(path.join(NB_REAL, "burnglass.log")),
   "M2: legacy tray.ps1 refreshed to v2 (frozen PulseTray mutex, new log path)");
ok(!/app-icon|burnglass\.ico/i.test(tray) && /tray-base|\$PNG/.test(tray) && /crit = @\{/.test(tray), "M2: tray script embeds only the tray base/status icons (never the app icon)");
const st = stages("h2");
ok(!st.includes(".burnglass.migrating-123-abcdef"), "M2: a stale sentinel-marked staging dir was swept");
ok(st.includes(".burnglass.migrating-124-abcdef") && st.includes(".burnglass.migrating-x"),
   "M2: decoys kept — no sentinel, or not the exact name pattern (" + st.join(",") + ")");
ok(st.length === 2, "M2: no staging dir of our own left behind");
const es2 = ((m2.periods || []).find((p) => p.key === "last30") || {}).effortSpend || {};
ok(es2.max && es2.max.tokens === 100000, "M2: migrated modes.jsonl yields the s1 effort chip (max 100k)");

// ---- M3
const m3 = J("m3.json") || {};
ok(R("marker-1.json") && R("marker-1.json") === R("marker-2.json"), "M3: restart leaves the marker untouched (idempotent)");
ok(m3.homeMigration && m3.homeMigration.status === "migrated" && !m3.homeMigration.justNow, "M3: restart reports the earlier migration");
ok(m3.budget && m3.budget.target === 42, "M3: later v1 edits to ~/.pulse/config.json are ignored (budget stays 42, got " + (m3.budget && m3.budget.target) + ")");
const D = J("dates.json");
const p90 = (m3.periods || []).find((p) => p.key === "last90");
const b = (d) => p90 && p90.daily.find((x) => x.date === d);
ok(b(D.D1) && Math.abs(b(D.D1).total - 1) < 1e-9, "M3: legacy history tie -> the new home wins (D1 = $1, got " + (b(D.D1) && b(D.D1).total) + ")");
ok(b(D.D2) && Math.abs(b(D.D2).total - 7) < 1e-9, "M3: a day only v1 sealed after the move is merged in (D2 = $7)");
ok(b(D.D3) && Math.abs(b(D.D3).total - 4) < 1e-9, "M3: the more complete legacy cell wins (D3 = $4)");
ok(!fs.readdirSync(path.join(NB_REAL, "history")).some((f) => { try { return JSON.parse(fs.readFileSync(path.join(NB_REAL, "history", f), "utf8"))[D.D2]; } catch (_) { return false; } }),
   "M3: the legacy archive is only READ (D2 never written into the new home)");
const es3 = ((m3.periods || []).find((p) => p.key === "last30") || {}).effortSpend || {};
ok(es3.xhigh && es3.xhigh.tokens === 200000, "M3: a record only in the legacy modes.jsonl still yields its chip (xhigh 200k)");
ok(es3.max && es3.max.tokens === 100000, "M3: ...and the migrated one still applies (max 100k)");

// ---- M4
const m4 = J("m4.json") || {};
ok(m4.home === path.join(T, "h4", ".burnglass") && !m4.budget, "M4: an existing empty ~/.burnglass wins — no copy (budget unset)");
ok(!exists("h4/.burnglass/migrated-from-pulse.json") && m4.homeMigration === null, "M4: no marker, no migration reported");

// ---- M5
const a5 = J("m5a.json") || {}, b5 = J("m5b.json") || {}, c5 = J("m5c.json") || {};
ok(a5.home === path.join(T, "bh") && a5.budget && a5.budget.target === 1, "M5: BURNGLASS_HOME beats PULSE_HOME (" + a5.home + ")");
ok(b5.home === path.join(T, "ph") && b5.budget && b5.budget.target === 2, "M5: PULSE_HOME alone is honoured verbatim");
ok(c5.home === path.join(T, "ph"), "M5: an EMPTY BURNGLASS_HOME does not mask PULSE_HOME");
ok(!exists("h5/.burnglass"), "M5: an explicit home never migrates (no ~/.burnglass)");
ok(fs.readFileSync(path.join(T, "h5/.pulse/server.json"), "utf8") === fs.readFileSync(path.join(T, "h5-pulse-before/server.json"), "utf8"),
   "M5: an explicit home never mirrors into ~/.pulse");
ok(a5.homeMigration === null, "M5: homeMigration null for a pinned home");
ok(exists("stub-new.json") && !exists("stub-old.json"), "M5: BURNGLASS_STARTUP_STUB beats PULSE_STARTUP_STUB");
ok(/BURNGLASS_STARTUP_STUB/.test(R("m5-startup.txt")), "M5: --startup names the v2 variable");

// ---- M6
const m6 = J("m6.json") || {};
ok(m6.homeMigration && m6.homeMigration.status === "failed" && m6.homeMigration.error, "M6: failed migration reported (" + JSON.stringify(m6.homeMigration) + ")");
ok(m6.home === path.join(T, "h6", ".pulse") && m6.budget && m6.budget.target === 6, "M6: degraded run works on ~/.pulse (budget 6)");
ok(stages("h6").length === 0, "M6: its staging copy was removed");
ok(fs.statSync(path.join(T, "h6/.burnglass")).isFile(), "M6: the blocking file was left alone");

// ---- M7
const a7 = J("m7a.json") || {}, b7 = J("m7b.json") || {};
ok(a7.home === path.join(T, "h7", ".burnglass") && b7.home === a7.home, "M7: both racing servers end on ~/.burnglass");
ok(a7.homeMigration && a7.homeMigration.status === "migrated" && b7.homeMigration && b7.homeMigration.status === "migrated", "M7: both report migrated");
ok(stages("h7").length === 0, "M7: no staging dirs left after the race");
ok(fs.readdirSync(path.join(T, "h7/.burnglass/history")).length === 6, "M7: one complete copy (6 months)");
ok(a7.budget && a7.budget.target === 7 && b7.budget && b7.budget.target === 7, "M7: both read the migrated config");

// ---- M8
ok(!exists("m8-alive.txt") && /exit:1/.test(R("m8-exit.txt")), "M8: a v2 that cannot bind exits (" + R("m8-exit.txt").trim() + ")");
ok(!exists("m8-published.txt"), "M8: port taken -> NOTHING published (no ~/.burnglass)");
ok(R("h8-before.txt") === R("h8-after.txt"), "M8: ~/.pulse byte-identical after the failed start");
ok(!/\.burnglass\.migrating-/.test(R("m8-ls.txt")), "M8: no staging dir");
ok(/already in use/.test(R("m8a.log")), "M8: the port conflict is explained");
const m8 = J("m8b.json") || {};
ok(m8.homeMigration && m8.homeMigration.status === "migrated" && m8.budget && m8.budget.target === 8, "M8: the next start that owns the port migrates");

// ---- M9
ok(/12\.34/.test(R("m9a.txt")), "M9: a stale-but-newer ~/.burnglass/server.json (dead pid) loses to the live legacy one (" + R("m9a.txt").trim() + ")");
ok(/56\.78/.test(R("m9b.txt")), "M9: both alive -> the newer server.json wins (" + R("m9b.txt").trim() + ")");

// ---- L1-L3 same-folder homes
const K1 = "msy-LINKED-key-1", K2 = "msy-LINKED-key-2";
for (const [tag, home, real, desc] of [
  ["l1", "hl1", "hl1/.burnglass/config.json", "~/.pulse -> ~/.burnglass"],
  ["l2", "hl2", "hl2/.pulse/config.json", "~/.burnglass -> ~/.pulse"],
  ["l3", "hl3", "hl3/.pulse/config.json", "~/.burnglass/config.json -> ~/.pulse/config.json"],
  ["l4", "hl4", "hl4/.burnglass/config.json", "~/.pulse/config.json -> ~/.burnglass/config.json"],
]) {
  const a = J(tag + "-a.json") || {}, set = J(tag + "-set.json") || {}, b = J(tag + "-b.json") || {};
  ok(a.meshy && a.meshy.hasKey === true, "L: " + desc + ": the Meshy key survives the start (hasKey " + (a.meshy && a.meshy.hasKey) + ")");
  ok(set.ok === true && set.meshy && set.meshy.hasKey === true && b.meshy && b.meshy.hasKey === true,
     "L: " + desc + ": a key saved from the dashboard is kept (" + JSON.stringify(set.meshy && set.meshy.hasKey) + ")");
  let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(T, real), "utf8")); } catch (_) {}
  ok(cfg.meshyApiKey === K2, "L: " + desc + ": the one real config.json holds the new key");
  ok(!/removed the Meshy API key/.test(R(tag + ".log")), "L: " + desc + ": no legacy scrub of the live config");
  ok(a.homeMigration === null && stages(home).length === 0, "L: " + desc + ": no migration, no staging dir");
}

// ---- P1/P2 permissions
const modes = (f) => Object.fromEntries(R(f).trim().split("\n").filter(Boolean).map((l) => { const i = l.lastIndexOf(" "); return [path.relative(T, l.slice(0, i)), l.slice(i + 1)]; }));
const pa = modes("p1-modes-a.txt"), pb = modes("p1-modes-b.txt");
ok(pa["hp1/.burnglass"] === "700", "P1: a 0700 ~/.pulse becomes a 0700 ~/.burnglass (got " + pa["hp1/.burnglass"] + ")");
ok(pa["hp1/.burnglass/history"] === "700", "P1: history/ keeps its 0700 (got " + pa["hp1/.burnglass/history"] + ")");
ok(pa["hp1/.burnglass/config.json"] === "600" && pa["hp1/.burnglass/history/2025-01.json"] === "600" && pa["hp1/.burnglass/meshy.json"] === "640",
   "P1: file modes are copied (" + JSON.stringify(pa) + ")");
ok(pa["hp1/.pulse/config.json"] === "600", "P1: the legacy key scrub keeps the old config user-only (got " + pa["hp1/.pulse/config.json"] + ")");
ok((J("p1-set.json") || {}).ok === true && pb["hp1/.burnglass/config.json"] === "600", "P1: a dashboard key save keeps config.json 0600 (got " + pb["hp1/.burnglass/config.json"] + ")");
const p2 = modes("p2-modes.txt"), p2b = modes("p2b-modes.txt");
ok(p2["hp2/.burnglass"] === "755" && p2["hp2/.burnglass/history"] === "755" && p2["hp2/.burnglass/config.json"] === "644" && p2["hp2/.burnglass/history/2025-01.json"] === "644",
   "P2: the default 755/644 layout is unchanged (" + JSON.stringify(p2) + ")");
ok(p2b["hp2b/.burnglass/config.json"] === "600", "P2: a NEW config.json holding a Meshy key is created 0600 (got " + p2b["hp2b/.burnglass/config.json"] + ")");

// ---- A1/A2 not-a-Pulse-home
const a1 = J("a1.json") || {};
ok(a1.home === path.join(T, "ha1", ".burnglass") && a1.homeMigration === null, "A1: PulseAudio-style ~/.pulse -> fresh ~/.burnglass, no migration reported (" + JSON.stringify(a1.homeMigration) + ")");
ok(!exists("ha1/.burnglass/migrated-from-pulse.json") && !/moved your settings/.test(R("a1.log")), "A1: no marker, no \"moved your settings\" log line");
ok(R("ha1-before.txt") === R("ha1-after.txt") && !exists("ha1/.pulse/server.json"), "A1: PulseAudio files untouched, nothing mirrored into it");
const a2 = J("a2.json") || {}, a2b = J("a2b.json") || {};
ok(a2.home === path.join(T, "ha2", ".burnglass"), "A2: a ~/.pulse with only a log + server.json still hands over to ~/.burnglass");
ok(a2.homeMigration === null && a2b.homeMigration === null, "A2: ...but never claims settings/history were copied (" + JSON.stringify(a2.homeMigration) + ", restart " + JSON.stringify(a2b.homeMigration) + ")");
ok(!/moved your settings/.test(R("a2.log")), "A2: the log does not say \"moved your settings\"");
let a2sj = {}; try { a2sj = JSON.parse(R("ha2/.pulse/server.json")); } catch (_) {}
ok(a2sj.port === 5853, "A2: the old server.json is still mirrored for v1 companions");

// ---- Q1 typographic quotes
const q = J("q1-unit.json") || {};
const HQREAL = path.join(T, "hq", "Se\u00e1n O\u2019Neill \u2018x\u201A\u201B \x27y\x27");
ok(!q.err && Array.isArray(q.roundTrip) && q.roundTrip.length === 5 && q.roundTrip.every(Boolean), "Q1: psQuote round-trips every PowerShell single-quote kind (" + JSON.stringify(q.roundTrip || q.err) + ")");
ok(q.unit && q.unit.value === q.unit.expect && q.unit.rest === "", "Q1: trayScript $logFile literal parses to the exact home path (" + JSON.stringify(q.unit) + ")");
ok(q.relaunchQuoted === true, "Q1: the tray self-relaunch quotes $PSCommandPath (profile paths with spaces)");
ok(q.file && q.file.value === path.join(HQREAL, ".burnglass", "burnglass.log") && q.file.rest === "",
   "Q1: the refreshed legacy ~/.pulse/tray.ps1 parses too (" + JSON.stringify(q.file || q.fileErr) + ")");
ok((J("q1.json") || {}).home === path.join(HQREAL, ".burnglass"), "Q1: the quoted home migrated");

// ---- I1 integrations (Windows paths)
const i1 = J("i1.json") || {};
ok(!i1.err && Array.isArray(i1.cases), "I1: integrationTargetExists is available (" + (i1.err || "ok") + ")");
for (const c of i1.cases || []) ok(c.got === c.want, "I1: " + c.n + " -> " + JSON.stringify(c.got) + " (want " + JSON.stringify(c.want) + ")");

// ---- H1 legacy history x custom rename
const HD = J("h1-dates.json") || {};
const day = (f, d) => { const p = ((J(f) || {}).periods || []).find((x) => x.key === "last90"); return p && p.daily.find((x) => x.date === d); };
const hd = day("h1a.json", HD.D), he = day("h1a.json", HD.E), hf = day("h1a.json", HD.F);
ok(hd && Math.abs(hd.total - 14) < 1e-9 && !hd.bySource.myagent, "H1: a legacy cell under the renamed-away name is not counted beside its new name (D = $14, got " + (hd && hd.total) + " " + JSON.stringify(hd && hd.bySource) + ")");
ok(he && Math.abs(he.total - 6) < 1e-9 && he.bySource.removedtool === 5, "H1: a REMOVED source keeps its legacy history (E = $6, got " + (he && he.total) + ")");
ok(hf && Math.abs(hf.total - 6) < 1e-9, "H1: same name both sides -> the more complete cell wins (F = $6, got " + (hf && hf.total) + ")");
const ha = J("h1a.json") || {};
ok(Array.isArray(ha.allSources) && !ha.allSources.includes("myagent") && ha.allSources.includes("removedtool"), "H1: the retired name does not reappear (" + JSON.stringify(ha.allSources) + ")");
// the live transcripts are shared with M1 (no archive there): the archive adds exactly D+E+F
const archAdds = ha.totals && m1.totals ? ha.totals.cost - m1.totals.cost : NaN;
ok(Math.abs(archAdds - 26) < 1e-6, "H1: all-time counts each archived day once (+$26, got " + archAdds + ")");
const hd2 = day("h1b.json", HD.D);
ok(hd2 && Math.abs(hd2.total - 24) < 1e-9, "H1: configuring the old name again is picked up without a file change (D = $24, got " + (hd2 && hd2.total) + ")");

// ---- U1
const U = (f) => J(f) || {};
ok(U("u1.json").status === "available" && U("u1.json").assetName === "burnglass-linux", "U1: new asset name preferred (" + U("u1.json").assetName + ", via the repo-rename 301)");
ok(U("u2.json").assetName === "pulse-linux", "U1: falls back to the legacy asset name");
ok(U("u6.json").assetName === "pulse-linux", "U1: an exe named pulse-linux pulls pulse-linux first");
ok(U("u3.json").status === "uptodate", "U1: 2.0.0-rc.1 is not offered over the running " + V + " (" + U("u3.json").status + ")");
ok(U("u4.json").status === "available" && U("u4.json").latest === "99.0.1-rc.2", "U1: a prerelease of a NEWER version (99.0.1-rc.2) ranks above the running " + V);
ok(U("u5.json").status === "uptodate", "U1: v1.34.0 is not an update");
process.exit(fail);
' "$TMP" "$SECRET" "$ROOT"
RES=$?
echo "---- exit $RES"
exit $RES
