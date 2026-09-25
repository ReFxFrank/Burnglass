#!/bin/bash
# Account meters survive a restart / update relaunch. The last GOOD reading
# (and an active 429 backoff) persist to <home>/meters-cache.json, so a new
# process shows the numbers at once and does NOT ask the shared usage endpoint
# again moments after the old process did (that is what earned the 429 that
# left the card blank for ~an hour after a one-click update).
#   - restart after a good fetch: buckets in the FIRST payload, with their real
#     age (fetchedAt/lastGoodAt), no request before fetchedAt + cadence, and
#     the restored reading is not replayed as a projection sample
#   - a 429 backoff is persisted and honored across a restart (capped at 1h),
#     then resumes; Recheck now forces a fetch and clears the saved backoff
#   - windows whose resetsAt passed are dropped (and trigger an immediate check)
#   - too old / corrupt / foreign files are ignored without a crash
#   - meters off: the file is removed (route AND a start with meters off), is
#     never written, and a leftover is never loaded
#   - the fake token never appears in the cache file or the logs; mode 0600
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
MOCKP=4871
PORT=4873
CADENCE=10000 # PULSE_METERS_CACHE_MS: the normal meters cadence (METERS_OK_MS)
SRV=""; MOCK=""
cleanup() {
  [ -n "$SRV" ] && kill "$SRV" 2>/dev/null
  [ -n "$MOCK" ] && kill "$MOCK" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT
CL=$TMP/claude; PH=$TMP/home
CACHE=$PH/meters-cache.json
mkdir -p "$CL/projects/demo" "$PH"
echo '{"accountMeters": true}' > "$PH/config.json"
# fake login (the mock validates this exact token; NEVER a real one)
echo '{"claudeAiOauth":{"accessToken":"sk-test-oauth-token","expiresAt":9999999999999}}' > "$CL/.credentials.json"

for p in $MOCKP $PORT; do
  if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$p/"; then echo "port $p is busy — aborting"; exit 1; fi
done

node "$ROOT/test/mocks/mock-meters.js" $MOCKP >/dev/null 2>&1 &
MOCK=$!
sleep 0.4

FAIL=0
ok() { if [ "$1" = "1" ]; then echo "PASS  $2"; else echo "FAIL  $2"; FAIL=1; fi; }
# jv FILE EXPR — evaluate EXPR with s = FILE's parsed JSON (null if unreadable), now = Date.now()
jv() {
  node -e '
let s = null; try { s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch (_) {}
const now = Date.now(); let v;
try { v = eval(process.argv[2]); } catch (e) { v = "ERR:" + e.message; }
console.log(typeof v === "string" ? v : JSON.stringify(v));' "$1" "$2"
}
# wcache JS-OBJECT-EXPR — write the cache file by hand (now = Date.now())
wcache() { node -e 'const now = Date.now(); require("fs").writeFileSync(process.argv[1], JSON.stringify(eval("(" + process.argv[2] + ")")));' "$CACHE" "$1"; }
mode() { curl -s "http://127.0.0.1:$MOCKP/mode?$1" >/dev/null; }
count() { curl -s "http://127.0.0.1:$MOCKP/count" > "$TMP/cnt.json"; jv "$TMP/cnt.json" 's.hits'; }
summary() { curl -s "http://127.0.0.1:$PORT/api/summary" > "$1"; }
statusline() { curl -s "http://127.0.0.1:$PORT/api/statusline" >/dev/null; }
recheck() { curl -s -X POST -H 'X-Pulse: 1' "http://127.0.0.1:$PORT/api/meters/recheck" > "$1"; }
sleep_until() { node -e 'setTimeout(() => {}, Math.max(0, +process.argv[1] - Date.now()))' "$1"; }
N=0
start() {
  N=$((N + 1))
  PULSE_HOME=$PH CLAUDE_DIR=$CL CODEX_DIR=$TMP/nocodex \
  PULSE_METERS_API=http://127.0.0.1:$MOCKP/usage PULSE_METERS_CACHE_MS=$CADENCE \
  PULSE_SUMMARY_MEMO_MS=0 PULSE_METER_PROJ_MIN_MS=1 \
  node "$ROOT/server.js" --port $PORT --no-update-check >"$TMP/srv-$N.log" 2>&1 &
  SRV=$!
  for _ in $(seq 1 60); do
    curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/health" && return 0
    sleep 0.2
  done
  echo "server did not start:"; cat "$TMP/srv-$N.log"; exit 1
}
stop() { [ -n "$SRV" ] && { kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; }; SRV=""; }
has_cache() { [ -f "$CACHE" ] && echo 1 || echo 0; }
no_cache() { [ -f "$CACHE" ] && echo 0 || echo 1; }

# ---- A: a good fetch is persisted ---------------------------------------------------
mode "m=ok"
start
for _ in $(seq 1 30); do
  summary "$TMP/a.json"
  [ "$(jv "$TMP/a.json" 's && s.meters && s.meters.status')" = "ok" ] && break
  sleep 0.3
done
ok "$(jv "$TMP/a.json" 's.meters.status === "ok" && s.meters.buckets.length >= 5 ? 1 : 0')" "A: first run fetched live buckets"
ok "$(has_cache)" "A: the good reading was persisted to meters-cache.json"
cp "$CACHE" "$TMP/snap-a.json" 2>/dev/null
MODE=$(node -e 'try { console.log((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8)); } catch (_) { console.log("none"); }' "$CACHE")
ok "$([ "$MODE" = "600" ] && echo 1 || echo 0)" "A: cache file mode 0600 (got $MODE)"
ok "$(jv "$CACHE" 'Object.keys(s).sort().join() === "buckets,fetchedAt,v" && s.v === 1 && typeof s.fetchedAt === "number" && s.buckets.every((b) => Object.keys(b).sort().join() === "key,label,pct,resetsAt") && s.buckets.some((b) => b.key === "five_hour") ? 1 : 0')" \
  "A: file = {v:1, fetchedAt, buckets[{key,label,pct,resetsAt}]} and no backoff while none is active"
C1=$(count)
FA=$(jv "$CACHE" 's.fetchedAt')

# ---- B: restart right away -> last good in the FIRST payload, no request before the cadence
stop; start
summary "$TMP/b1.json"
ok "$(jv "$TMP/b1.json" 's.meters.status === "ok" && s.meters.buckets.length >= 5 ? 1 : 0')" \
  "B: restart: last good buckets are in the very first payload ($(jv "$TMP/b1.json" 's.meters.status + " / " + s.meters.buckets.length'))"
ok "$(jv "$TMP/b1.json" "s.meters.fetchedAt === $FA && s.meters.lastGoodAt === $FA ? 1 : 0")" \
  "B: fetchedAt/lastGoodAt = the saved reading's real time (the UI shows its age)"
ok "$(jv "$TMP/b1.json" 'const b = (k) => s.meters.buckets.find((x) => x.key === k); b("tangelo").label === "Claude · tangelo" && b("model_scoped:fable").label === "Claude · weekly · Fable" && b("five_hour").label === "Claude · 5-hour session" && Math.abs(b("five_hour").pct - 0.9) < 1e-9 ? 1 : 0')" \
  "B: restored rows keep their labels and exact percentages"
ok "$(jv "$TMP/b1.json" 's.meters.buckets.every((b) => b.projLeftAtReset === null) ? 1 : 0')" "B: a restored reading projects nothing on its own"
for _ in 1 2 3 4 5; do summary "$TMP/b2.json"; statusline; sleep 0.25; done
T_B2=$(node -e 'console.log(Date.now())')
C2=$(count)
ok "$([ "$C2" = "$C1" ] && echo 1 || echo 0)" "B: no request to the usage endpoint before fetchedAt + cadence (hits $C1 -> $C2)"
ok "$([ "$T_B2" -lt $((FA + CADENCE)) ] && echo 1 || echo 0)" "B: (timing sanity: those polls ran inside the cadence window)"
grep -q "account meters: restored" "$TMP/srv-$N.log"; ok "$([ $? -eq 0 ] && echo 1 || echo 0)" "B: the restore is logged"
sleep_until $((FA + CADENCE + 400))
summary "$TMP/b3.json"; sleep 0.7; summary "$TMP/b4.json"
C3=$(count)
ok "$([ "$C3" = "$((C1 + 1))" ] && echo 1 || echo 0)" "B: once the cadence is up the dashboard fetches again — exactly once (hits $C2 -> $C3)"
ok "$(jv "$TMP/b4.json" "s.meters.status === 'ok' && s.meters.fetchedAt > $FA ? 1 : 0")" "B: the fresh reading replaced the restored one"
ok "$(jv "$TMP/b4.json" 's.meters.buckets.every((b) => b.projLeftAtReset === null) ? 1 : 0')" \
  "B: the restored reading was NOT fed as a projection sample (one live sample -> no projection yet)"
cp "$CACHE" "$TMP/snap-b.json" 2>/dev/null

# ---- C: a 429 backoff is persisted and honored across a restart -------------------------
mode "m=429&retry=600"
recheck "$TMP/c0.json"
ok "$(jv "$TMP/c0.json" 's.meters.status === "rate-limited" && s.meters.buckets.length >= 5 ? 1 : 0')" "C: 429 -> rate-limited, last good buckets kept"
cp "$CACHE" "$TMP/snap-c.json" 2>/dev/null
ok "$(jv "$CACHE" 's.nextAttemptAt > now + 590e3 && s.nextAttemptAt <= now + 600e3 && s.streak === 1 && s.buckets.length >= 5 && typeof s.fetchedAt === "number" ? 1 : 0')" \
  "C: backoff persisted {nextAttemptAt ≈ +10m (Retry-After), streak 1} beside the last good buckets"
FA_C=$(jv "$CACHE" 's.fetchedAt')
C4=$(count)
stop; start
summary "$TMP/c1.json"
ok "$(jv "$TMP/c1.json" 's.meters.status === "rate-limited" && s.meters.buckets.length >= 5 ? 1 : 0')" \
  "C: restart during the backoff: status rate-limited with the last good buckets ($(jv "$TMP/c1.json" 's.meters.status'))"
ok "$(jv "$TMP/c1.json" '/HTTP 429/.test(s.meters.error) && /retrying in ~(9|10)m/.test(s.meters.error) ? 1 : 0')" \
  "C: the message is computed from the remaining wait ($(jv "$TMP/c1.json" '(s.meters.error || "").slice(0, 70)'))"
ok "$(jv "$TMP/c1.json" "s.meters.lastGoodAt === $FA_C ? 1 : 0")" "C: lastGoodAt carries the reading's real time"
for _ in 1 2 3 4 5 6; do summary "$TMP/c2.json"; statusline; sleep 0.3; done
C5=$(count)
ok "$([ "$C5" = "$C4" ] && echo 1 || echo 0)" "C: the endpoint is not hit before the saved nextAttemptAt (hits $C4 -> $C5)"
grep -q "still rate-limited" "$TMP/srv-$N.log"; ok "$([ $? -eq 0 ] && echo 1 || echo 0)" "C: the carried-over backoff is logged"

# ---- D: Recheck now forces a fetch and clears the saved backoff -----------------------------
mode "m=ok"
recheck "$TMP/d0.json"
C6=$(count)
ok "$([ "$C6" = "$((C5 + 1))" ] && echo 1 || echo 0)" "D: recheck forces an immediate fetch despite the saved backoff (hits $C5 -> $C6)"
ok "$(jv "$TMP/d0.json" 's.meters.status === "ok" ? 1 : 0')" "D: recheck -> status ok"
ok "$(jv "$CACHE" '!("nextAttemptAt" in s) && !("streak" in s) && s.buckets.length >= 5 ? 1 : 0')" "D: the good fetch left no backoff in the file"
# a forced fetch that FAILS (not a 429) must still clear a saved backoff
mode "m=429&retry=600"; recheck "$TMP/d1.json"
ok "$(jv "$CACHE" 's.nextAttemptAt > now ? 1 : 0')" "D: (a new 429 backoff is saved again)"
mode "m=500"; recheck "$TMP/d2.json"
ok "$(jv "$TMP/d2.json" 's.meters.status === "error" ? 1 : 0')" "D: forced fetch that fails -> status error"
ok "$(jv "$CACHE" '!("nextAttemptAt" in s) && s.buckets.length >= 5 ? 1 : 0')" "D: ...and the saved backoff is gone anyway (recheck cleared it)"
C7=$(count)
stop; start
summary "$TMP/d3.json"; sleep 0.5; summary "$TMP/d4.json"
ok "$(jv "$TMP/d3.json" 's.meters.status === "ok" && s.meters.buckets.length >= 5 ? 1 : 0')" "D: restart after the recheck: no resurrected backoff ($(jv "$TMP/d3.json" 's.meters.status'))"
ok "$([ "$(count)" = "$C7" ] && echo 1 || echo 0)" "D: ...and no request (the reading is younger than the cadence)"

# ---- E: a far-future backoff is capped at 1h; a short one is honored, then resumes -------------
stop
mode "m=ok"
wcache '{ v: 1, fetchedAt: now - 60e3, nextAttemptAt: now + 5 * 3600e3, streak: 3, buckets: [
  { key: "five_hour", label: "whatever", pct: 40, resetsAt: now + 2 * 3600e3 },
  { key: "seven_day", label: "Claude · weekly (all models)", pct: 55, resetsAt: now + 3 * 86400e3 } ] }'
C8=$(count)
start
summary "$TMP/e1.json"
ok "$(jv "$TMP/e1.json" 's.meters.status === "rate-limited" && /retrying in ~60m/.test(s.meters.error) ? 1 : 0')" \
  "E: a saved backoff 5h out is capped at 1h ($(jv "$TMP/e1.json" '(s.meters.error || "").slice(0, 70)'))"
ok "$(jv "$TMP/e1.json" 'const b = (k) => s.meters.buckets.find((x) => x.key === k); b("five_hour").pct === 40 && b("five_hour").label === "Claude · 5-hour session" && b("seven_day").pct === 55 ? 1 : 0')" \
  "E: buckets come from the file (known keys take today's label)"
ok "$(jv "$TMP/e1.json" 'const fh = s.meters.buckets.find((x) => x.key === "five_hour"); s.currentBlock && s.currentBlock.official === true && s.currentBlock.end === fh.resetsAt ? 1 : 0')" \
  "E: the restored five_hour reset drives the official 5-hour block at once"
sleep 0.8; summary "$TMP/e2.json"
ok "$([ "$(count)" = "$C8" ] && echo 1 || echo 0)" "E: no request while the capped backoff runs"
stop
wcache '{ v: 1, fetchedAt: now - 60e3, nextAttemptAt: now + 5000, streak: 2, buckets: [
  { key: "seven_day", label: "Claude · weekly (all models)", pct: 55, resetsAt: now + 3 * 86400e3 } ] }'
NA_E=$(jv "$CACHE" 's.nextAttemptAt')
start
summary "$TMP/e3.json"
ok "$(jv "$TMP/e3.json" 's.meters.status === "rate-limited" ? 1 : 0')" "E: a short saved backoff is honored ($(jv "$TMP/e3.json" 's.meters.status'))"
ok "$([ "$(count)" = "$C8" ] && echo 1 || echo 0)" "E: ...no request before it ends"
sleep_until $((NA_E + 300))
summary "$TMP/e4.json"; sleep 0.7; summary "$TMP/e5.json"
ok "$([ "$(count)" = "$((C8 + 1))" ] && echo 1 || echo 0)" "E: ...then the next poll fetches (hits $C8 -> $(count))"
ok "$(jv "$TMP/e5.json" 's.meters.status === "ok" && s.meters.buckets.length >= 5 ? 1 : 0')" "E: ...and the live reading takes over"
# a streak whose backoff ended minutes ago carries on: the next 429 doubles
# from it (base 5 x cadence = 50s; streak 3 -> 4 = 50s x 8 = 400s), not from 1
stop
mode "m=429"
wcache '{ v: 1, fetchedAt: now - 30e3, nextAttemptAt: now - 10 * 60e3, streak: 3, buckets: [
  { key: "seven_day", label: "Claude · weekly (all models)", pct: 55, resetsAt: now + 3 * 86400e3 } ] }'
C8B=$(count)
start
summary "$TMP/e6.json"; sleep 0.7; summary "$TMP/e7.json"
ok "$([ "$(count)" = "$((C8B + 1))" ] && echo 1 || echo 0)" "E: an expired saved backoff does not block the check"
ok "$(jv "$TMP/e7.json" 's.meters.status === "rate-limited" && s.meters.buckets.length === 1 ? 1 : 0')" "E: (that check got a 429)"
ok "$(jv "$CACHE" 's.streak === 4 && s.nextAttemptAt - now > 380e3 && s.nextAttemptAt - now <= 400e3 ? 1 : 0')" \
  "E: ...and the backoff doubled on from the saved streak (streak $(jv "$CACHE" 's.streak'), wait ~$(jv "$CACHE" 'Math.round((s.nextAttemptAt - now) / 1000)')s)"

# ---- F: a window that rolled since the save is dropped --------------------------------------
stop
mode "m=500"
wcache '{ v: 1, fetchedAt: now - 30e3, buckets: [
  { key: "five_hour", label: "Claude · 5-hour session", pct: 40, resetsAt: now - 60e3 },
  { key: "seven_day", label: "Claude · weekly (all models)", pct: 55, resetsAt: now + 3 * 86400e3 },
  { key: "model_scoped:fable", label: "Claude · weekly · Fable", pct: 33, resetsAt: now + 3 * 86400e3 } ] }'
FA_F=$(jv "$CACHE" 's.fetchedAt')
C9=$(count)
start
summary "$TMP/f1.json"
ok "$(jv "$TMP/f1.json" 'const b = (k) => s.meters.buckets.find((x) => x.key === k); s.meters.status === "ok" && !b("five_hour") && b("seven_day").pct === 55 && b("model_scoped:fable").pct === 33 && b("model_scoped:fable").label === "Claude · weekly · Fable" ? 1 : 0')" \
  "F: the rolled 5-hour window is dropped, the open windows are shown ($(jv "$TMP/f1.json" 's.meters.buckets.map((b) => b.key).join(",")'))"
sleep 0.8; summary "$TMP/f2.json"
ok "$([ "$(count)" = "$((C9 + 1))" ] && echo 1 || echo 0)" "F: a rolled window makes the first check immediate (its new value is unknown)"
ok "$(jv "$TMP/f2.json" "s.meters.status === 'error' && s.meters.buckets.length === 2 && s.meters.lastGoodAt === $FA_F ? 1 : 0")" \
  "F: a failing check keeps the restored reading as last good ($(jv "$TMP/f2.json" 's.meters.status'))"

# ---- G: too old -> not restored ----------------------------------------------------------------
stop
mode "m=ok"
wcache '{ v: 1, fetchedAt: now - 13 * 3600e3, buckets: [
  { key: "seven_day", label: "Claude · weekly (all models)", pct: 55, resetsAt: now + 3 * 86400e3 } ] }'
start
summary "$TMP/g1.json"
ok "$(jv "$TMP/g1.json" 's.meters.status === "loading" && s.meters.buckets.length === 0 ? 1 : 0')" "G: a 13h-old reading is not restored ($(jv "$TMP/g1.json" 's.meters.status'))"
stop
wcache '{ v: 1, fetchedAt: now + 3600e3, buckets: [
  { key: "seven_day", label: "Claude · weekly (all models)", pct: 55, resetsAt: now + 3 * 86400e3 } ] }'
start
summary "$TMP/g2.json"
ok "$(jv "$TMP/g2.json" 's.meters.status === "loading" && s.meters.buckets.length === 0 ? 1 : 0')" "G: a reading stamped in the future is not restored"

# ---- H: corrupt / foreign files are ignored, no crash ---------------------------------------------
stop
printf '{not json' > "$CACHE"
start
summary "$TMP/h1.json"
ok "$(jv "$TMP/h1.json" 's.meters.status === "loading" ? 1 : 0')" "H: corrupt JSON ignored ($(jv "$TMP/h1.json" 's.meters.status'))"
grep -q "ignoring an unrecognised" "$TMP/srv-$N.log"; ok "$([ $? -eq 0 ] && echo 1 || echo 0)" "H: ...with a log line"
stop
wcache '{ v: 2, fetchedAt: now - 5e3, buckets: [ { key: "five_hour", label: "x", pct: 50, resetsAt: now + 3600e3 } ] }'
start
summary "$TMP/h2.json"
ok "$(jv "$TMP/h2.json" 's.meters.status === "loading" ? 1 : 0')" "H: an unknown file version is ignored"
stop
printf '[1,2,3]' > "$CACHE"
start
summary "$TMP/h3.json"
ok "$(jv "$TMP/h3.json" 's.meters.status === "loading" ? 1 : 0')" "H: a non-object file is ignored"
stop
wcache '{ v: 1, fetchedAt: now - 5e3, nextAttemptAt: "soon", streak: "lots", buckets: [
  { key: 5, pct: 1 }, { key: "five_hour", pct: "90" }, { key: "seven_day", pct: 44, resetsAt: "tomorrow" },
  { key: "seven_day_opus", label: "Claude · weekly · Opus", pct: 45, resetsAt: now + 3 * 86400e3 },
  { key: "bad\u001b[31m", label: "Claude · x", pct: 10 }, { key: "odd_one", label: "\u001b[2Jevil", pct: 250 }, null, [1] ] }'
start
curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/health"; ok "$([ $? -eq 0 ] && echo 1 || echo 0)" "H: server healthy after a hostile file"
summary "$TMP/h4.json"
ok "$(jv "$TMP/h4.json" 's.meters.status === "ok" && s.meters.buckets.map((b) => b.key).sort().join() === "odd_one,seven_day_opus" ? 1 : 0')" \
  "H: only well-formed rows restored ($(jv "$TMP/h4.json" 's.meters.buckets.map((b) => b.key).join(",")'))"
ok "$(jv "$TMP/h4.json" 'const o = s.meters.buckets.find((b) => b.key === "odd_one"); o.label === "Claude · odd one" && o.pct === 100 ? 1 : 0')" \
  "H: a control-char label is replaced and pct clamped to 0–100"

# ---- I: meters off -> file removed, never written, never loaded ---------------------------------
ok "$(has_cache)" "I: (a cache file exists before turning the meters off)"
curl -s -X POST -H 'X-Pulse: 1' "http://127.0.0.1:$PORT/api/meters/disable" > "$TMP/i0.json"
ok "$(jv "$TMP/i0.json" 's.meters && s.meters.enabled === false ? 1 : 0')" "I: meters disabled from the dashboard"
ok "$(no_cache)" "I: turning the meters off removed meters-cache.json"
summary "$TMP/i1.json"; statusline; sleep 0.8; summary "$TMP/i2.json"
ok "$(no_cache)" "I: nothing is written while the meters are off"
stop
wcache '{ v: 1, fetchedAt: now - 5e3, buckets: [
  { key: "seven_day", label: "Claude · weekly (all models)", pct: 55, resetsAt: now + 3 * 86400e3 } ] }'
start
ok "$(no_cache)" "I: a start with the meters off removes a leftover cache file"
summary "$TMP/i3.json"
ok "$(jv "$TMP/i3.json" 's.meters && s.meters.enabled === false ? 1 : 0')" "I: payload says meters off"
# turn them on behind the server's back (config edit, no route): the leftover was not loaded
node -e 'const f = process.argv[1]; const j = JSON.parse(require("fs").readFileSync(f, "utf8")); j.accountMeters = true; require("fs").writeFileSync(f, JSON.stringify(j));' "$PH/config.json"
C10=$(count)
summary "$TMP/i4.json"
ok "$(jv "$TMP/i4.json" 's.meters.status === "loading" && s.meters.buckets.length === 0 ? 1 : 0')" "I: the removed leftover was never loaded ($(jv "$TMP/i4.json" 's.meters.status'))"
sleep 0.8
ok "$([ "$(count)" = "$((C10 + 1))" ] && echo 1 || echo 0)" "I: ...a fresh fetch happens instead"
stop

# ---- secrets ------------------------------------------------------------------------------------
if grep -l "sk-test-oauth-token" "$TMP"/srv-*.log "$TMP"/snap-*.json "$CACHE" 2>/dev/null | grep -q .; then LEAK=0; else LEAK=1; fi
ok "$LEAK" "the fake OAuth token never appears in a cache file or a server log"
ok "$(ls "$TMP"/snap-*.json 2>/dev/null | wc -l | awk '{print ($1 >= 3) ? 1 : 0}')" "(token check covered the saved snapshots)"
ok "$(ls "$PH" | grep -c '\.tmp$' | awk '{print ($1 == 0) ? 1 : 0}')" "no temp files left in the home"

echo "---- exit $FAIL"
exit $FAIL
