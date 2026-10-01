#!/bin/bash
# Anthropic rate-limits its usage endpoint per ACCOUNT (Claude Code, status-line
# tools and widgets share it), so Burnglass:
#   - keeps a journal of its own usage checks (result, Retry-After, trigger,
#     rate-limit headers) in payload.meters.checks;
#   - takes Claude Code's 5-hour / weekly readings from the status line's stdin
#     (forwarded by --statusline to POST /api/meters/observe): they keep the
#     meters live, merge by maximum within a window (an idle session can't
#     lower them, an older window is ignored), survive a 429 backoff, and while
#     fresh stretch the endpoint cadence to METERS_OBS_MS;
#   - after a 429, hints at other pollers (a non-Burnglass status line).
# Owns ports 4951 (mock Anthropic) + 4952 (server).
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
MOCKP=4951; PORT=4952
SRV=""; MOCK=""
cleanup() { [ -n "$SRV" ] && kill "$SRV" 2>/dev/null; [ -n "$MOCK" ] && kill "$MOCK" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT
for p in $MOCKP $PORT; do
  if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$p/"; then echo "FAIL  port $p is busy"; exit 1; fi
done
CL=$TMP/claude; PH=$TMP/home
mkdir -p "$CL/projects/demo" "$PH"
echo '{"accountMeters": true}' > "$PH/config.json"
echo '{"claudeAiOauth":{"accessToken":"sk-test-oauth-token","expiresAt":9999999999999}}' > "$CL/.credentials.json"
# A status-line tool that is not Burnglass (the hint names it after a 429).
echo '{"statusLine":{"type":"command","command":"SECRET_TOKEN=abc npx -y ccstatusline@latest"}}' > "$CL/settings.json"

node "$ROOT/test/mocks/mock-meters.js" $MOCKP >/dev/null 2>&1 & MOCK=$!
sleep 0.4
FAIL=0
ok() { if [ "$1" = 1 ]; then echo "PASS  $2"; else echo "FAIL  $2"; FAIL=1; fi; }
hits() { curl -s "http://127.0.0.1:$MOCKP/count" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).hits))'; }
sum() { curl -s "http://127.0.0.1:$PORT/api/summary" > "$TMP/$1.json"; }
jv() { node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const m=s.meters||{}; const B=(k)=>(m.buckets||[]).find(b=>b.key===k); let v; try{v=eval(process.argv[2])}catch(e){v="ERR:"+e.message} process.stdout.write(typeof v==="string"?v:JSON.stringify(v))' "$TMP/$1.json" "$2"; }
statusline() { # stdin JSON -> the status line (also forwards rate_limits)
  echo "$1" | CLAUDE_DIR=$CL PULSE_HOME=$PH NO_COLOR=1 node "$ROOT/server.js" --statusline
}

CLAUDE_DIR=$CL CODEX_DIR=$TMP/nc PULSE_HOME=$PH PULSE_METERS_API=http://127.0.0.1:$MOCKP/usage \
  PULSE_METERS_CACHE_MS=2000 PULSE_SUMMARY_MEMO_MS=0 PULSE_NO_TRAY_SPAWN=1 PULSE_NO_STRIP_SPAWN=1 \
  node "$ROOT/server.js" --port $PORT --no-update-check >"$TMP/srv.log" 2>&1 & SRV=$!
for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$PORT/api/health" && break; sleep 0.1; done
sum a0; sleep 1; sum a

# ---- A: the journal records our own checks ---------------------------------------
ok "$([ "$(jv a 'm.checks.lastHour.ok')" = 1 ] && [ "$(jv a 'm.checks.recent[0].trigger')" = dashboard ] && echo 1)" "A: one OK check, triggered by the dashboard ($(jv a 'm.checks.lastHour'))"
ok "$([ "$(jv a 'm.checks.cadenceMs.dashboard')" = 2000 ] && [ "$(jv a 'm.checks.cadenceMs.withStatusLine')" = 900000 ] && echo 1)" "A: the cadences are reported"
ok "$([ "$(jv a 'm.observed')" = null ] && [ "$(jv a 'm.hints')" = null ] && echo 1)" "A: no status-line readings and no hints yet"
R5=$(jv a 'Math.round(B("five_hour").resetsAt/1000)'); R7=$(jv a 'Math.round(B("seven_day").resetsAt/1000)')

# ---- B: the status line forwards Claude Code's readings --------------------------
OUT=$(statusline "{\"model\":{\"display_name\":\"Opus\"},\"rate_limits\":{\"five_hour\":{\"used_percentage\":37.5,\"resets_at\":$R5},\"seven_day\":{\"used_percentage\":70,\"resets_at\":$R7}}}")
ok "$(echo "$OUT" | grep -q 'Opus' && echo 1)" "B: the status line still prints ($OUT)"
sum b
ok "$([ "$(jv b 'B("five_hour").pct')" = 37.5 ] && [ "$(jv b 'B("five_hour").source')" = statusline ] && echo 1)" "B: 5-hour = the status-line reading 37.5 (endpoint said 0.9)"
ok "$([ "$(jv b 'B("seven_day").pct')" = 70 ] && echo 1)" "B: weekly = max(endpoint 61, status line 70) = 70"
ok "$([ "$(jv b 'B("seven_day_opus").pct')" = 88 ] && [ "$(jv b 'B("seven_day_opus").source||null')" = null ] && echo 1)" "B: rows the status line does not carry stay the endpoint's"
ok "$([ "$(jv b 'm.observed.fresh')" = true ] && [ "$(jv b 'm.observed.keys.join()')" = five_hour,seven_day ] && echo 1)" "B: payload.meters.observed reports fresh readings"
SL=$(curl -s "http://127.0.0.1:$PORT/api/statusline" | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(s.meters.claudeFiveHour+"/"+s.meters.claudeWeekly)')
ok "$([ "$SL" = 38/70 ] && echo 1)" "B: the tray / status-line feed uses them too (got $SL)"

# ---- C: an idle session can't lower a reading; an older window is ignored --------
statusline "{\"rate_limits\":{\"five_hour\":{\"used_percentage\":20,\"resets_at\":$R5}}}" >/dev/null
statusline "{\"rate_limits\":{\"five_hour\":{\"used_percentage\":99,\"resets_at\":$((R5 - 3600))}}}" >/dev/null
sum c
ok "$([ "$(jv c 'B("five_hour").pct')" = 37.5 ] && echo 1)" "C: a lower same-window reading and an older window leave 37.5 (got $(jv c 'B("five_hour").pct'))"
statusline "{\"rate_limits\":{\"five_hour\":{\"used_percentage\":41,\"resets_at\":$((R5 + 30))}}}" >/dev/null
sum c2
ok "$([ "$(jv c2 'B("five_hour").pct')" = 41 ] && echo 1)" "C: a higher same-window reading (reset 30 s apart) wins"

# ---- D: fresh readings stretch the endpoint cadence --------------------------------
H0=$(hits); sleep 3; sum d1; sleep 0.5; sum d2
ok "$([ "$(hits)" = "$H0" ] && echo 1)" "D: no endpoint request after the 2 s cadence while readings are fresh (hits $H0 -> $(hits))"

# ---- E: a 429 is journaled; readings still flow during the backoff -----------------
curl -s "http://127.0.0.1:$MOCKP/mode?m=429&retry=600" >/dev/null
curl -s -X POST -H 'X-Pulse: 1' "http://127.0.0.1:$PORT/api/meters/recheck" > "$TMP/e0.json"
sum e
ok "$([ "$(jv e 'm.status')" = rate-limited ] && [ "$(jv e 'm.checks.lastHour.limited')" = 1 ] && echo 1)" "E: the 429 is counted ($(jv e 'm.checks.lastHour'))"
ok "$([ "$(jv e 'm.checks.recent[0].trigger')" = recheck ] && [ "$(jv e 'm.checks.recent[0].retryAfterSec')" = 600 ] && echo 1)" "E: newest entry = recheck, Anthropic asked for 600 s"
ok "$([ "$(jv e 'm.checks.limitHeaders.headers["retry-after"]')" = 600 ] && echo 1)" "E: the rate-limit headers are kept (got $(jv e 'm.checks.limitHeaders'))"
statusline "{\"rate_limits\":{\"five_hour\":{\"used_percentage\":45,\"resets_at\":$R5}}}" >/dev/null
sleep 0.3; sum e2
ok "$([ "$(jv e2 'B("five_hour").pct')" = 45 ] && [ "$(jv e2 'm.status')" = rate-limited ] && echo 1)" "E: during the backoff the 5-hour meter still moves (45)"
sleep 0.5; sum e3
ok "$([ "$(jv e3 'm.hints&&m.hints.statusLine')" = ccstatusline ] && echo 1)" "E: after a 429 the hints name the other status line (got $(jv e3 'm.hints'))"
ok "$(grep -q 'SECRET_TOKEN\|abc npx' "$TMP/e3.json" && echo 0 || echo 1)" "E: the status-line command itself (and its env values) never reach the payload"
curl -s "http://127.0.0.1:$MOCKP/mode?m=ok" >/dev/null

# ---- F: the route is guarded and only works with meters on --------------------------
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"five_hour":{"used_percentage":1}}' "http://127.0.0.1:$PORT/api/meters/observe")
ok "$([ "$CODE" = 403 ] && echo 1)" "F: no X-Pulse -> 403 (got $CODE)"
R=$(curl -s -X POST -H 'X-Pulse: 1' -H 'Content-Type: application/json' -d '{"five_hour":{"used_percentage":"lots"},"seven_day":{"used_percentage":-5}}' "http://127.0.0.1:$PORT/api/meters/observe")
ok "$(echo "$R" | grep -q '"accepted":0' && echo 1)" "F: malformed readings are refused ($R)"
curl -s -X POST -H 'X-Pulse: 1' "http://127.0.0.1:$PORT/api/meters/disable" >/dev/null
R=$(curl -s -X POST -H 'X-Pulse: 1' -H 'Content-Type: application/json' -d "{\"five_hour\":{\"used_percentage\":50,\"resets_at\":$R5}}" "http://127.0.0.1:$PORT/api/meters/observe")
ok "$(echo "$R" | grep -q '"accepted":0' && echo 1)" "F: with meters off nothing is taken ($R)"
kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; SRV=""

# ---- I: an early reset (same resets_at, usage back down) is not held up forever ------
CLAUDE_DIR=$CL CODEX_DIR=$TMP/nc PULSE_HOME=$PH PULSE_METERS_API=http://127.0.0.1:$MOCKP/usage \
  PULSE_METERS_CACHE_MS=2000 PULSE_METER_OBS_FRESH_MS=1500 PULSE_SUMMARY_MEMO_MS=0 PULSE_NO_TRAY_SPAWN=1 PULSE_NO_STRIP_SPAWN=1 \
  node "$ROOT/server.js" --port $PORT --no-update-check >"$TMP/srv2.log" 2>&1 & SRV=$!
for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$PORT/api/health" && break; sleep 0.1; done
curl -s -X POST -H 'X-Pulse: 1' "http://127.0.0.1:$PORT/api/meters/enable" > "$TMP/i0.json"
R5=$(node -e 'const m=require(process.argv[1]).meters; process.stdout.write(String(Math.round(m.buckets.find(b=>b.key==="five_hour").resetsAt/1000)))' "$TMP/i0.json")
statusline "{\"rate_limits\":{\"five_hour\":{\"used_percentage\":50,\"resets_at\":$R5}}}" >/dev/null
sum i1
ok "$([ "$(jv i1 'B("five_hour").pct')" = 50 ] && echo 1)" "I: a reading after the fetch shows (50)"
sleep 2
statusline "{\"rate_limits\":{\"five_hour\":{\"used_percentage\":3,\"resets_at\":$R5}}}" >/dev/null
sum i2
ok "$([ "$(jv i2 'B("five_hour").pct')" = 3 ] && echo 1)" "I: a lower reading after the freshness window wins - an early reset shows (got $(jv i2 'B("five_hour").pct'))"
curl -s -X POST -H 'X-Pulse: 1' "http://127.0.0.1:$PORT/api/meters/recheck" >/dev/null
sum i3
ok "$([ "$(jv i3 'B("five_hour").pct')" = 0.9 ] && [ "$(jv i3 'B("five_hour").source||null')" = null ] && echo 1)" "I: a fetch newer than every reading is authoritative (endpoint 0.9; got $(jv i3 'B("five_hour").pct'))"
kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; SRV=""

# ---- G: the status line never hangs without a server --------------------------------
T0=$(date +%s%N)
OUT=$(echo "{\"model\":{\"display_name\":\"Opus\"},\"rate_limits\":{\"five_hour\":{\"used_percentage\":5,\"resets_at\":$R5}}}" | CLAUDE_DIR=$CL PULSE_HOME=$TMP/nohome NO_COLOR=1 PORT=4959 node "$ROOT/server.js" --statusline)
MS=$(( ($(date +%s%N) - T0) / 1000000 ))
ok "$([ "$MS" -lt 1500 ] && echo "$OUT" | grep -q Opus && echo 1)" "G: no server -> still prints, exits in ${MS} ms"

# ---- H: naming another status-line tool ----------------------------------------------
node -e '
const S = require(process.argv[1] + "/server.js"); let bad = 0;
const t = (cmd, want) => { const got = S.statusLineToolName(cmd); const p = got === want; if (!p) bad = 1; console.log((p ? "PASS" : "FAIL") + "  H: " + JSON.stringify(cmd) + " -> " + got); };
t("npx -y ccstatusline@latest", "ccstatusline");
t("bunx ccusage statusline", "ccusage");
t("\"C:\\\\Users\\\\x\\\\bin\\\\claude-hud.exe\"", "claude-hud");
t("node /home/x/.claude/statusline.js", "statusline");
t("FOO=1 BAR=2 ~/bin/my-line.sh", "my-line");
t("/opt/burnglass/burnglass-linux --statusline", null);
t("", null);
process.exit(bad);' "$ROOT" || FAIL=1

ok "$(grep -q 'sk-test-oauth-token' "$TMP/srv.log" && echo 0 || echo 1)" "the token never appears in the server log"
echo "---- exit $FAIL"
exit $FAIL
