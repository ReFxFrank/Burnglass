#!/bin/bash
# Tray toggle endpoints + feed plumbing (cross-platform parts — the icon
# itself is Windows-only and manually verified):
# - payload.tray reports {supported, enabled}; enabled follows the config.
# - POST /api/tray/enable|disable writes the config and flips the state.
# - /api/statusline carries trayEnabled so a running tray can self-exit.
# - the endpoints are allowMutation-guarded (GET refused).
# Retired OpenUsage companion (removed in 2.0.0-rc.3 — Burnglass Strip
# replaced it):
# - the summary carries no `openusage` key, even with a leftover
#   `openusage: true` + `openusagePath` in config.json;
# - /api/openusage/enable|disable answer a JSON 404 (any unknown /api route
#   does; non-API paths still reach the frontend);
# - the leftover config keys are left alone (never rewritten just to drop
#   them) and a start with them launches / logs nothing about OpenUsage.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
CL=$TMP/claude; PH=$TMP/pulse
mkdir -p "$CL/projects/demo" "$PH"
echo '{}' > "$PH/config.json"

node -e '
const fs = require("fs");
fs.writeFileSync(process.argv[1] + "/projects/demo/s.jsonl", JSON.stringify({
  type: "assistant", timestamp: new Date().toISOString(), sessionId: "s", requestId: "r", cwd: "/p",
  message: { id: "m", model: "claude-fable-5", usage: { input_tokens: 0, output_tokens: 10000 } } }) + "\n");
' "$CL"

# A pre-rc.3 config that still has the retired OpenUsage keys (with a real
# file at the path, so nothing could be "not found" by accident). Nothing may
# read, launch, report or strip them. On Git Bash the /tmp path is virtual —
# hand the server a native path.
FAKEEXE=$TMP/OpenUsage/OpenUsageTray.exe
mkdir -p "$TMP/OpenUsage"
echo fake > "$FAKEEXE"
if command -v cygpath >/dev/null 2>&1; then FAKEEXE_NATIVE=$(cygpath -w "$FAKEEXE"); else FAKEEXE_NATIVE=$FAKEEXE; fi
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ openusage: true, openusagePath: process.argv[2] }))' "$PH/config.json" "$FAKEEXE_NATIVE"

PORT=4887
PULSE_HOME=$PH CLAUDE_DIR=$CL CODEX_DIR=$TMP/nc PULSE_SUMMARY_MEMO_MS=0 PULSE_NO_TRAY_SPAWN=1 PULSE_NO_STRIP_SPAWN=1 \
node "$ROOT/server.js" --port $PORT --no-update-check >"$TMP/srv.log" 2>&1 &
SRV=$!
sleep 2.2

curl -s "http://127.0.0.1:$PORT/api/summary" > "$TMP/before.json"
GETCODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/tray/enable")
curl -s -X POST -H 'X-Pulse: 1' "http://127.0.0.1:$PORT/api/tray/enable" > "$TMP/en.json"
curl -s "http://127.0.0.1:$PORT/api/summary" > "$TMP/on.json"
curl -s "http://127.0.0.1:$PORT/api/statusline" > "$TMP/sl-on.json"
curl -s -X POST -H 'X-Pulse: 1' "http://127.0.0.1:$PORT/api/tray/disable" > "$TMP/dis.json"
GETST=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/strip/enable")
curl -s -X POST -H 'X-Pulse: 1' "http://127.0.0.1:$PORT/api/strip/enable" > "$TMP/st-en.json"
curl -s "http://127.0.0.1:$PORT/api/statusline" > "$TMP/sl-strip.json"
curl -s -X POST -H 'X-Pulse: 1' "http://127.0.0.1:$PORT/api/strip/disable" > "$TMP/st-dis.json"
GETOU=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/openusage/enable")
OUEN=$(curl -s -o "$TMP/ou-en.json" -w "%{http_code}" -X POST -H 'X-Pulse: 1' "http://127.0.0.1:$PORT/api/openusage/enable")
OUDIS=$(curl -s -o "$TMP/ou-dis.json" -w "%{http_code}" -X POST -H 'X-Pulse: 1' "http://127.0.0.1:$PORT/api/openusage/disable")
curl -s "http://127.0.0.1:$PORT/api/summary" > "$TMP/ou-after.json"
NOPE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/no-such-route")
SPA=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/some/deep/link")
sleep 3.2
curl -s "http://127.0.0.1:$PORT/api/statusline" > "$TMP/sl-off.json"
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null

# --- boot path: `tray: true` in config must spawn the icon on a plain start ---
# Regression guard. The tray used to spawn ONLY for the --tray flag, so every
# restart silently dropped the icon while payload.tray kept saying enabled:true.
# PULSE_NO_TRAY_SPAWN makes startTray log instead of spawning, so the log line
# is the proof that the boot path reached it — no real tray process involved.
setTray() { # merge, never clobber — later assertions read the rest of this config
  node -e 'const fs=require("fs"),p=process.argv[1];const c=JSON.parse(fs.readFileSync(p,"utf8"));c.tray=process.argv[2]==="true";fs.writeFileSync(p,JSON.stringify(c))' "$PH/config.json" "$1"
}
setTray true
PULSE_HOME=$PH CLAUDE_DIR=$CL CODEX_DIR=$TMP/nc PULSE_SUMMARY_MEMO_MS=0 PULSE_NO_TRAY_SPAWN=1 PULSE_NO_STRIP_SPAWN=1 \
node "$ROOT/server.js" --port $PORT --no-update-check >"$TMP/boot-on.log" 2>&1 &
SRV2=$!
sleep 2.2
kill $SRV2 2>/dev/null; wait $SRV2 2>/dev/null

# ...and must NOT spawn when the config says otherwise (no flag, tray:false).
setTray false
PULSE_HOME=$PH CLAUDE_DIR=$CL CODEX_DIR=$TMP/nc PULSE_SUMMARY_MEMO_MS=0 PULSE_NO_TRAY_SPAWN=1 PULSE_NO_STRIP_SPAWN=1 \
node "$ROOT/server.js" --port $PORT --no-update-check >"$TMP/boot-off.log" 2>&1 &
SRV3=$!
sleep 2.2
kill $SRV3 2>/dev/null; wait $SRV3 2>/dev/null

node -e '
const fs = require("fs"); const T = process.argv[1];
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + "  " + m); if (!c) fail = 1; };
const J = (f) => JSON.parse(fs.readFileSync(T + "/" + f, "utf8"));
const before = J("before.json");
ok(before.tray && before.tray.enabled === false && typeof before.tray.supported === "boolean",
   "payload.tray present, disabled by default (supported=" + before.tray.supported + ")");
ok(!Object.prototype.hasOwnProperty.call(before, "openusage"),
   "payload has no openusage key (retired), despite openusage:true in config");
ok(process.argv[2] === "403" || process.argv[2] === "404" || process.argv[2] === "405",
   "GET on the tray endpoint is refused (got " + process.argv[2] + ")");
ok(process.argv[4] === "404", "GET /api/openusage/enable -> 404 (got " + process.argv[4] + ")");
ok(J("en.json").ok === true && J("en.json").tray.enabled === true, "POST enable -> enabled");
ok(J("on.json").tray.enabled === true, "summary reflects enabled");
ok(J("sl-on.json").trayEnabled === true, "statusline carries trayEnabled:true while on");
ok(J("dis.json").tray.enabled === false, "POST disable -> disabled");
ok(before.strip && before.strip.enabled === false && typeof before.strip.supported === "boolean",
   "payload.strip present, disabled by default");
ok(process.argv[5] === "403" || process.argv[5] === "404" || process.argv[5] === "405",
   "GET on the strip endpoint is refused (got " + process.argv[5] + ")");
ok(J("st-en.json").ok === true && J("st-en.json").strip.enabled === true, "POST strip/enable -> enabled");
ok(J("sl-strip.json").stripEnabled === true, "statusline carries stripEnabled:true while on");
ok(J("st-dis.json").strip.enabled === false, "POST strip/disable -> disabled");
ok(process.argv[6] === "404" && J("ou-en.json").ok === false && !("openusage" in J("ou-en.json")),
   "POST /api/openusage/enable (X-Pulse) -> JSON 404 (got " + process.argv[6] + " " + JSON.stringify(J("ou-en.json")) + ")");
ok(process.argv[7] === "404" && J("ou-dis.json").ok === false,
   "POST /api/openusage/disable (X-Pulse) -> JSON 404 (got " + process.argv[7] + ")");
ok(!Object.prototype.hasOwnProperty.call(J("ou-after.json"), "openusage"),
   "summary still has no openusage key after the retired toggles were hit");
ok(process.argv[8] === "404", "any unknown /api route -> 404, not the SPA (got " + process.argv[8] + ")");
ok(process.argv[9] !== "404", "a non-API deep link still reaches the frontend (got " + process.argv[9] + ")");
const cfg = JSON.parse(fs.readFileSync(process.argv[3] + "/config.json", "utf8"));
ok(cfg.tray === false, "config ends tray-disabled (persisted writes)");
ok(cfg.openusage === true && typeof cfg.openusagePath === "string",
   "leftover openusage / openusagePath config keys left alone (not rewritten away)");
ok(J("sl-off.json").trayEnabled === false, "statusline flips to trayEnabled:false (tray self-exit signal)");
// Boot path: config alone (no --tray flag) must reach startTray, and must not
// when the config is off. Regression guard for the icon vanishing on restart.
const bootOn = fs.readFileSync(T + "/boot-on.log", "utf8");
const bootOff = fs.readFileSync(T + "/boot-off.log", "utf8");
ok(/tray spawn suppressed/.test(bootOn),
   "config tray:true spawns the icon on a plain start (no --tray flag)");
ok(!/tray spawn suppressed/.test(bootOff),
   "config tray:false does NOT spawn on start");
const srvLog = fs.readFileSync(T + "/srv.log", "utf8");
ok(![srvLog, bootOn, bootOff].some((l) => /openusage/i.test(l)),
   "a start with openusage:true in config launches / logs nothing about OpenUsage");
process.exit(fail);
' "$TMP" "$GETCODE" "$PH" "$GETOU" "$GETST" "$OUEN" "$OUDIS" "$NOPE" "$SPA"
RES=$?
echo "---- exit $RES"
exit $RES
