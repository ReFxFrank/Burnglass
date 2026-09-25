#!/bin/bash
# Burnglass Strip refresh after a one-click update (refreshStripAfterUpdate),
# e2e against the real server + a mock GitHub release on localhost.
#
# The feature is Windows + packaged only; the suite forces those two gates
# with PULSE_STRIP_REFRESH_FORCE (BURNGLASS_* in one case, to exercise the
# alias), points "beside the server exe" at a fixture folder
# (PULSE_STRIP_EXE_DIR), the release lookup at the mock
# (PULSE_STRIP_RELEASE_API) and tasklist/taskkill/spawn at a stub folder
# (PULSE_STRIP_PROC_STUB: running / kills.log / launches.log / sticky). The
# after-update condition is the REAL --after-update flag. Strip "exes" are a
# few MB of random bytes. Every case runs with a fake $HOME.
#  S1  stale (v1 layout: pulse-strip.exe beside the exe + burnglass-strip.exe
#      in <home>/bin) -> both swapped under their OWN names, ONE download of
#      the own-name asset (via a 302 like GitHub's CDN), .old kept, bytes =
#      the asset, release looked up by tag v<version>, payload basenames only,
#      strip not server-managed -> no kill, no launch
#  S2  second after-update start is idempotent: current, nothing downloaded,
#      the .old leftovers removed by the start-up cleanup
#  S3  current from scratch -> untouched (same inode + mtime, no .old)
#  S4  release asset without a sha256 digest -> skipped, nothing downloaded
#  S5  sha256 mismatch on download -> failed, original intact, no leftovers
#  S6  "stripPath" configured -> skipped, nothing fetched, file untouched
#  S7  no managed strip -> skipped, nothing fetched
#  S8  strip only in the legacy ~/.pulse/bin (unpinned home, migration runs)
#      -> fresh burnglass-strip.exe in ~/.burnglass/bin, ~/.pulse tree
#      byte-identical, payload.strip.path follows, the running strip is
#      stopped and the new one launched once
#  S9  "strip": true + a running stale strip -> taskkill argv carries BOTH
#      image names, exactly ONE launch, after the swap (the normal start-up
#      launch is deferred, not doubled)
#  S10 "strip": true + current -> no kill; the single launch is deduped
#  S11 a strip that will not die -> bounded wait (~5 s), warned, launch
#      attempted once (deduped by the running check)
#  S12 not an after-update start -> nothing fetched, refresh null, the normal
#      launch happens once
#  S13 --no-update-check / {"updateCheck": false} -> skipped, nothing fetched
#  S14 without the force hook (not a packaged Windows exe) -> null, nothing
#      fetched
#  S15 release tag missing (404) -> skipped; release w/o strip assets -> skipped
#  S16 release carries only the pulse-strip.exe alias -> burnglass-strip.exe
#      is refreshed from it (under its own name)
#  S17 the home IS ~/.pulse (a failed migration's degraded run, a PULSE_HOME
#      pinned to it) or the server exe itself sits in ~/.pulse: skipped, and
#      the ~/.pulse tree stays byte-identical (hard rule 3b: nothing there is
#      renamed, replaced, created or cleaned up)
#  S7b the "no strip" reason carries no path (payload: basenames only)
#  S18 the strip is turned off from the dashboard while a refresh restarts it
#      (after the kill, during the pause before the relaunch) -> not launched
#  S19 the same while waiting for a strip that will not die (~5 s window)
#  S20 a FAILED refresh (release lookup HTTP 500) is kept in
#      <home>/strip-refresh.json and retried on the next (normal) start, which
#      swaps the file and removes the marker; a third start fetches nothing
#  S21 within one process a failure is retried on a timer
#      (PULSE_STRIP_REFRESH_RETRY_MS); the running managed strip is restarted
#      on the new file
#  S22 after STRIP_REFRESH_MAX_ATTEMPTS (5) nothing is fetched any more, but
#      the failure stays in the payload (retriesLeft 0)
#  S23 an interrupted attempt ("pending" marker, dead pid) is retried; one
#      whose pid is alive (another server's attempt in flight) is not
#  S24 a marker from another version is ignored and removed
#  S25 a failed refresh on a server whose home IS ~/.pulse writes no marker
#      there (hard rule 3b)
#  hygiene: server.js runs Windows builtins (tasklist / taskkill / reg /
#      powershell) only by absolute System32 path, never by bare name
# STRIP_HEAL_SERVER=<server.js> runs the suite against another server copy
# (e.g. an older tree, to prove a regression).
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SERVER=${STRIP_HEAL_SERVER:-$ROOT/server.js}
TMP=$(mktemp -d)
MOCKS=""
cleanup() { for p in $MOCKS; do kill "$p" 2>/dev/null; done; if [ -n "${KEEP_TMP:-}" ]; then echo "TMP=$TMP"; else rm -rf "$TMP"; fi; }
trap cleanup EXIT
# This suite owns ports 5861-5895; a leftover listener would make results lie.
for p in $(seq 5861 5895); do
  curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$p/"; rc=$?
  if [ $rc -ne 7 ]; then echo "FAIL  port $p is already in use (curl rc=$rc) — stop whatever holds it"; exit 1; fi
done
FAILS=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }
VER=$(node -p "require('$ROOT/package.json').version")
MP=5861

# ------------------------------------------------------------------ fixtures
mkdir -p "$TMP/assets" "$TMP/claude/projects"
head -c 3145728 /dev/urandom > "$TMP/new.bin"
head -c 3145728 /dev/urandom > "$TMP/old.bin"
head -c 3145728 /dev/urandom > "$TMP/old2.bin"
cp "$TMP/new.bin" "$TMP/assets/burnglass-strip.exe"
cp "$TMP/new.bin" "$TMP/assets/pulse-strip.exe"
NEWSHA=$(sha256sum "$TMP/new.bin" | cut -d' ' -f1)
SIZE=$(stat -c %s "$TMP/new.bin")

# Mock GitHub: /repos/.../releases/tags/<tag> serves rel.json (or 404 when it
# says NOTFOUND), an asset's browser_download_url 302s to /cdn/<name> (like
# GitHub's objects CDN), /__stats + /__reset expose the request log.
node -e '
const http = require("http"), fs = require("fs"), path = require("path");
const [DIR, PORT] = process.argv.slice(1);
let log = [];
http.createServer((q, s) => {
  if (q.url === "/__stats") { s.writeHead(200, { "Content-Type": "application/json" }); return s.end(JSON.stringify(log)); }
  if (q.url === "/__reset") { log = []; s.writeHead(200); return s.end("ok"); }
  log.push(q.url);
  if (q.url.startsWith("/repos/")) {
    const body = fs.readFileSync(path.join(DIR, "rel.json"), "utf8");
    if (body.trim() === "NOTFOUND") { s.writeHead(404, { "Content-Type": "application/json" }); return s.end("{\"message\":\"Not Found\"}"); }
    if (body.trim() === "ERROR500") { s.writeHead(500, { "Content-Type": "application/json" }); return s.end("{\"message\":\"Server Error\"}"); }
    s.writeHead(200, { "Content-Type": "application/json" }); return s.end(body);
  }
  const dl = /^\/dl\/([\w.-]+)$/.exec(q.url);
  if (dl) { s.writeHead(302, { Location: "/cdn/" + dl[1] }); return s.end(); }
  const cdn = /^\/cdn\/([\w.-]+)$/.exec(q.url);
  if (cdn) {
    const f = path.join(DIR, "assets", cdn[1]);
    if (!fs.existsSync(f)) { s.writeHead(404); return s.end(); }
    s.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": fs.statSync(f).size });
    return fs.createReadStream(f).pipe(s);
  }
  s.writeHead(404); s.end();
}).listen(+PORT, "127.0.0.1");
' "$TMP" "$MP" &
MOCKS="$MOCKS $!"
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$MP/__stats" && break; sleep 0.1; done

# mkrel <mode>: ok | nodigest | baddigest | notfound | error500 | nostrip | aliasonly
mkrel() {
  node -e '
const [mode, sha, size, port, out] = process.argv.slice(1);
if (mode === "notfound") { require("fs").writeFileSync(out, "NOTFOUND"); process.exit(0); }
if (mode === "error500") { require("fs").writeFileSync(out, "ERROR500"); process.exit(0); }
const a = (name, digest) => ({ name, size: +size, browser_download_url: "http://127.0.0.1:" + port + "/dl/" + name,
  url: "http://127.0.0.1:" + port + "/api-asset/" + name, ...(digest ? { digest } : {}) });
const d = mode === "nodigest" ? null : mode === "baddigest" ? "sha256:" + "0".repeat(64) : "sha256:" + sha;
const assets = [a("burnglass.exe", "sha256:" + "1".repeat(64)), a("pulse.exe", "sha256:" + "1".repeat(64))];
if (mode !== "nostrip" && mode !== "aliasonly") assets.push(a("burnglass-strip.exe", d));
if (mode !== "nostrip") assets.push(a("pulse-strip.exe", d));
require("fs").writeFileSync(out, JSON.stringify({ tag_name: "v0", assets }));
' "$1" "$NEWSHA" "$SIZE" "$MP" "$TMP/rel.json"
}
reset_mock() { curl -s "http://127.0.0.1:$MP/__reset" >/dev/null; }
# stats <js expr over `l` = the request path list> -> prints the value
stats() { curl -s "http://127.0.0.1:$MP/__stats" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{const l=JSON.parse(b);console.log(new Function("l","return ("+process.argv[1]+")")(l))})' "$1"; }
api_count() { stats 'l.filter((u) => u.startsWith("/repos/")).length'; }
dl_count() { stats 'l.filter((u) => u.startsWith("/cdn/")).length'; }

SRV=""
# start_srv <port> <log> [NAME=VALUE ...] [-- server args]: fake HOME always,
# no home pin unless the case passes PULSE_HOME=...
start_srv() {
  local P=$1 L=$2; shift 2
  local envs=() args=()
  while [ $# -gt 0 ]; do
    if [ "$1" = "--" ]; then shift; args=("$@"); break; fi
    envs+=("$1"); shift
  done
  env -u PULSE_HOME -u BURNGLASS_HOME -u PULSE_HISTORY_DIR -u PULSE_MODES_FILE \
    CLAUDE_DIR="$TMP/claude" CODEX_DIR="$TMP/no-codex" GEMINI_DIR="$TMP/none" CONTINUE_DIR="$TMP/none" \
    CLINE_DIR="$TMP/none" ROO_DIR="$TMP/none" \
    PULSE_NO_TRAY_SPAWN=1 PULSE_NO_STRIP_SPAWN=1 \
    PULSE_MESHY_API=http://127.0.0.1:9 PULSE_SUMMARY_MEMO_MS=0 \
    PULSE_UPDATE_API=http://127.0.0.1:9/update PULSE_REACH_API=http://127.0.0.1:9/reach \
    PULSE_REACH_REPO_API=http://127.0.0.1:9/repo \
    PULSE_STRIP_RELEASE_API="http://127.0.0.1:$MP/" \
    "${envs[@]}" node "$SERVER" --port "$P" "${args[@]}" >"$L" 2>&1 &
  SRV=$!
}
wait_up() { for _ in $(seq 1 80); do curl -s -o /dev/null "http://127.0.0.1:$1/api/health" && return 0; sleep 0.15; done; return 1; }
stop_srv() { kill "$1" 2>/dev/null; wait "$1" 2>/dev/null; }
# wait_refresh <port> <out>: poll /api/summary until strip.refresh is set
wait_refresh() {
  for _ in $(seq 1 100); do
    curl -s "http://127.0.0.1:$1/api/summary" > "$2" 2>/dev/null
    node -e 'try { const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(s.strip && s.strip.refresh ? 0 : 1); } catch (_) { process.exit(1); }' "$2" && return 0
    sleep 0.2
  done
  return 1
}
summary() { curl -s "http://127.0.0.1:$1/api/summary" > "$2"; }
# wait_status <port> <out> <status>: poll /api/summary until strip.refresh.status is <status>
wait_status() {
  for _ in $(seq 1 100); do
    curl -s "http://127.0.0.1:$1/api/summary" > "$2" 2>/dev/null
    node -e 'try { const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(s.strip && s.strip.refresh && s.strip.refresh.status === process.argv[2] ? 0 : 1); } catch (_) { process.exit(1); }' "$2" "$3" && return 0
    sleep 0.2
  done
  return 1
}
# marker <file> <expr over m = the parsed file> -> exit status
marker() { node -e 'let m = null; try { m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch (_) {} process.exit(m && new Function("m", "return (" + process.argv[2] + ")")(m) ? 0 : 1)' "$1" "$2"; }
strip_off() { curl -s -X POST -H 'X-Pulse: 1' "http://127.0.0.1:$1/api/strip/disable" > "$2"; }
# js <summary.json> <expr over s> -> exit status
js() { node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(new Function("s", "return (" + process.argv[2] + ")")(s) ? 0 : 1)' "$1" "$2"; }
wait_file() { for _ in $(seq 1 60); do [ -s "$1" ] && return 0; sleep 0.2; done; return 1; }
lines() { if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }
hash_tree() { (cd "$1" && find . -type f | LC_ALL=C sort | while read -r f; do printf '%s %s\n' "$(sha256sum "$f" | cut -c1-16)" "$f"; done) > "$2"; }
same() { cmp -s "$1" "$2"; }
# case_dirs <name>: fresh $C (case root) with fake home, pinned home, exe dir, stub dir
case_dirs() {
  C=$TMP/$1; mkdir -p "$C/fakehome" "$C/home" "$C/exe" "$C/stub"
  echo '{}' > "$C/home/config.json"
}
FORCE=(PULSE_STRIP_REFRESH_FORCE=1)
common() { echo HOME="$C/fakehome" PULSE_HOME="$C/home" PULSE_STRIP_EXE_DIR="$C/exe" PULSE_STRIP_PROC_STUB="$C/stub"; }

# ------------------------------------------------------------------ S1 stale
case_dirs s1; S1=$C
cp "$TMP/old.bin" "$C/exe/pulse-strip.exe"
mkdir -p "$C/home/bin"; cp "$TMP/old2.bin" "$C/home/bin/burnglass-strip.exe"
touch "$C/stub/running"
mkrel ok; reset_mock
start_srv 5862 "$TMP/s1.log" $(common) BURNGLASS_STRIP_REFRESH_FORCE=1 -- --after-update
wait_up 5862; wait_refresh 5862 "$TMP/s1.json"
sleep 0.5; summary 5862 "$TMP/s1.json"
stop_srv $SRV
check "S1 status updated, both files reported under their own names" \
  "js '$TMP/s1.json' 's.strip.refresh.status === \"updated\" && s.strip.refresh.version === \"$VER\" && JSON.stringify(s.strip.refresh.files.map((f) => [f.file, f.where, f.result]).sort()) === JSON.stringify([[\"burnglass-strip.exe\",\"home-bin\",\"updated\"],[\"pulse-strip.exe\",\"exe-folder\",\"updated\"]])'"
check "S1 beside-exe pulse-strip.exe now holds the release bytes" "same '$TMP/new.bin' '$C/exe/pulse-strip.exe'"
check "S1 <home>/bin burnglass-strip.exe now holds the release bytes" "same '$TMP/new.bin' '$C/home/bin/burnglass-strip.exe'"
check "S1 previous bytes kept as .old (each its own)" "same '$TMP/old.bin' '$C/exe/pulse-strip.exe.old' && same '$TMP/old2.bin' '$C/home/bin/burnglass-strip.exe.old'"
check "S1 no .download left behind" "[ ! -e '$C/exe/pulse-strip.exe.download' ] && [ ! -e '$C/home/bin/burnglass-strip.exe.download' ]"
check "S1 no burnglass-strip.exe invented beside the exe" "[ ! -e '$C/exe/burnglass-strip.exe' ]"
check "S1 release looked up once, by tag v$VER" "[ \"\$(stats 'l.filter((u) => u.startsWith(\"/repos/\")).join(\",\")')\" = '/repos/ReFxFrank/Burnglass/releases/tags/v$VER' ]"
check "S1 ONE download, of the own-name asset (pulse-strip.exe), via the 302" \
  "[ \"\$(stats 'l.filter((u) => u.startsWith(\"/cdn/\") || u.startsWith(\"/dl/\")).join(\",\")')\" = '/dl/pulse-strip.exe,/cdn/pulse-strip.exe' ]"
check "S1 payload carries basenames only (no fixture path)" "! grep -q \"$TMP\" <<< \"\$(node -e 'console.log(JSON.stringify(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).strip.refresh))' '$TMP/s1.json')\""
check "S1 strip not server-managed: no kill, no launch, still 'running'" "[ ! -e '$C/stub/kills.log' ] && [ ! -e '$C/stub/launches.log' ] && [ -e '$C/stub/running' ]"
check "S1 log says the strip runs the new version from its next start" "grep -q 'strip runs v$VER from its next start' '$TMP/s1.log'"

# ------------------------------------------------------------------ S2 idempotent
MT1=$(stat -c '%i %Y' "$C/exe/pulse-strip.exe")
reset_mock
start_srv 5863 "$TMP/s2.log" $(common) "${FORCE[@]}" -- --after-update
wait_up 5863; wait_refresh 5863 "$TMP/s2.json"
stop_srv $SRV
check "S2 second after-update start reports current" \
  "js '$TMP/s2.json' 's.strip.refresh.status === \"current\" && s.strip.refresh.files.length === 2 && s.strip.refresh.files.every((f) => f.result === \"current\")'"
check "S2 nothing downloaded (release looked up once)" "[ \"\$(dl_count)\" = 0 ] && [ \"\$(api_count)\" = 1 ]"
check "S2 files untouched (same inode + mtime), still the release bytes" "[ \"\$(stat -c '%i %Y' '$C/exe/pulse-strip.exe')\" = '$MT1' ] && same '$TMP/new.bin' '$C/exe/pulse-strip.exe'"
check "S2 start-up cleanup removed the .old copies" "[ ! -e '$C/exe/pulse-strip.exe.old' ] && [ ! -e '$C/home/bin/burnglass-strip.exe.old' ]"
check "S2 cleanup logged" "grep -q 'removed previous strip version (pulse-strip.exe.old)' '$TMP/s2.log'"

# ------------------------------------------------------------------ S3 current from scratch
case_dirs s3
cp "$TMP/new.bin" "$C/exe/burnglass-strip.exe"; touch -d '2 days ago' "$C/exe/burnglass-strip.exe"
MT3=$(stat -c '%i %Y' "$C/exe/burnglass-strip.exe")
reset_mock
start_srv 5864 "$TMP/s3.log" $(common) "${FORCE[@]}" -- --after-update
wait_up 5864; wait_refresh 5864 "$TMP/s3.json"
stop_srv $SRV
check "S3 current: status current, file untouched, no .old, nothing downloaded" \
  "js '$TMP/s3.json' 's.strip.refresh.status === \"current\"' && [ \"\$(stat -c '%i %Y' '$C/exe/burnglass-strip.exe')\" = '$MT3' ] && [ ! -e '$C/exe/burnglass-strip.exe.old' ] && [ \"\$(dl_count)\" = 0 ]"

# ------------------------------------------------------------------ S4 no digest
case_dirs s4
cp "$TMP/old.bin" "$C/exe/burnglass-strip.exe"
mkrel nodigest; reset_mock
start_srv 5865 "$TMP/s4.log" $(common) "${FORCE[@]}" -- --after-update
wait_up 5865; wait_refresh 5865 "$TMP/s4.json"
stop_srv $SRV
check "S4 no digest: skipped (fail closed), reason names the digest" \
  "js '$TMP/s4.json' 's.strip.refresh.status === \"skipped\" && /digest/.test(s.strip.refresh.reason)'"
check "S4 nothing downloaded, file untouched, no .old/.download" \
  "[ \"\$(dl_count)\" = 0 ] && same '$TMP/old.bin' '$C/exe/burnglass-strip.exe' && [ ! -e '$C/exe/burnglass-strip.exe.old' ] && [ ! -e '$C/exe/burnglass-strip.exe.download' ]"

# ------------------------------------------------------------------ S5 sha mismatch
case_dirs s5
cp "$TMP/old.bin" "$C/exe/burnglass-strip.exe"
touch "$C/stub/running"; echo '{"strip": true}' > "$C/home/config.json"
mkrel baddigest; reset_mock
start_srv 5866 "$TMP/s5.log" $(common) "${FORCE[@]}" -- --after-update
wait_up 5866; wait_refresh 5866 "$TMP/s5.json"
wait_file "$C/stub/launches.log"; sleep 0.5
stop_srv $SRV
check "S5 sha mismatch: failed with the reason, basenames only" \
  "js '$TMP/s5.json' 's.strip.refresh.status === \"failed\" && /sha256 mismatch/.test(s.strip.refresh.error) && !s.strip.refresh.error.includes(\"/\") && s.strip.refresh.files[0].result === \"failed\"'"
check "S5 original intact, no .old, no .download (downloaded once)" \
  "same '$TMP/old.bin' '$C/exe/burnglass-strip.exe' && [ ! -e '$C/exe/burnglass-strip.exe.old' ] && [ ! -e '$C/exe/burnglass-strip.exe.download' ] && [ \"\$(dl_count)\" = 1 ]"
check "S5 nothing swapped -> the running strip is not killed (launch deduped once)" \
  "[ ! -e '$C/stub/kills.log' ] && [ \"\$(lines '$C/stub/launches.log')\" = 1 ] && grep -q '^already-running ' '$C/stub/launches.log'"

# ------------------------------------------------------------------ S6 stripPath
case_dirs s6
cp "$TMP/old.bin" "$C/exe/burnglass-strip.exe"; cp "$TMP/old.bin" "$C/exe/burnglass-strip.exe.old"
printf '{"stripPath": "%s"}\n' "$C/exe/burnglass-strip.exe" > "$C/home/config.json"
mkrel ok; reset_mock
start_srv 5867 "$TMP/s6.log" $(common) "${FORCE[@]}" -- --after-update
wait_up 5867; wait_refresh 5867 "$TMP/s6.json"
stop_srv $SRV
check "S6 stripPath set: skipped, reason names stripPath" "js '$TMP/s6.json' 's.strip.refresh.status === \"skipped\" && /stripPath/.test(s.strip.refresh.reason)'"
check "S6 nothing fetched, the user's file (and its .old) untouched" \
  "[ \"\$(stats 'l.length')\" = 0 ] && same '$TMP/old.bin' '$C/exe/burnglass-strip.exe' && [ -e '$C/exe/burnglass-strip.exe.old' ]"

# ------------------------------------------------------------------ S7 no strip
case_dirs s7
reset_mock
start_srv 5868 "$TMP/s7.log" $(common) "${FORCE[@]}" -- --after-update
wait_up 5868; wait_refresh 5868 "$TMP/s7.json"
stop_srv $SRV
check "S7 no managed strip: skipped, nothing fetched, nothing created" \
  "js '$TMP/s7.json' 's.strip.refresh.status === \"skipped\" && /no Burnglass Strip/.test(s.strip.refresh.reason)' && [ \"\$(stats 'l.length')\" = 0 ] && [ ! -e '$C/home/bin' ]"
check "S7b the skip reason carries no path" "js '$TMP/s7.json' '!s.strip.refresh.reason.includes(\"/\") && !s.strip.refresh.reason.includes(\"$TMP\")'"

# ------------------------------------------------------------------ S8 legacy ~/.pulse/bin
C=$TMP/s8; H8=$C/fakehome; mkdir -p "$H8/.pulse/bin" "$C/exe" "$C/stub"
echo '{"strip": true, "budget": 7}' > "$H8/.pulse/config.json"
cp "$TMP/old.bin" "$H8/.pulse/bin/pulse-strip.exe"
touch "$C/stub/running"
hash_tree "$H8/.pulse" "$TMP/s8-before.txt"
reset_mock
start_srv 5869 "$TMP/s8.log" HOME="$H8" PULSE_STRIP_EXE_DIR="$C/exe" PULSE_STRIP_PROC_STUB="$C/stub" "${FORCE[@]}" -- --after-update
wait_up 5869; wait_refresh 5869 "$TMP/s8.json"
wait_file "$C/stub/launches.log"; sleep 0.8; summary 5869 "$TMP/s8.json"
stop_srv $SRV
hash_tree "$H8/.pulse" "$TMP/s8-after.txt"
check "S8 the migration ran first (config read from ~/.burnglass)" "[ -f '$H8/.burnglass/config.json' ] && grep -q '\"strip\": true' '$H8/.burnglass/config.json'"
check "S8 fresh burnglass-strip.exe placed in ~/.burnglass/bin (release bytes, no .old)" \
  "same '$TMP/new.bin' '$H8/.burnglass/bin/burnglass-strip.exe' && [ ! -e '$H8/.burnglass/bin/burnglass-strip.exe.old' ] && [ ! -e '$H8/.burnglass/bin/burnglass-strip.exe.download' ]"
check "S8 ~/.pulse byte-identical (nothing renamed, replaced or added)" "cmp -s '$TMP/s8-before.txt' '$TMP/s8-after.txt'"
check "S8 payload: updated, the file reported as created in home-bin" \
  "js '$TMP/s8.json' 's.strip.refresh.status === \"updated\" && JSON.stringify(s.strip.refresh.files) === JSON.stringify([{ file: \"burnglass-strip.exe\", where: \"home-bin\", result: \"created\" }])'"
check "S8 payload.strip.path now the new ~/.burnglass/bin copy" "js '$TMP/s8.json' 's.strip.path === \"$H8/.burnglass/bin/burnglass-strip.exe\"'"
check "S8 the running (v1) strip stopped: taskkill argv names both images" \
  "[ \"\$(lines '$C/stub/kills.log')\" = 1 ] && grep -qF '[\"/F\",\"/IM\",\"burnglass-strip.exe\",\"/IM\",\"pulse-strip.exe\"]' '$C/stub/kills.log'"
check "S8 launched ONCE, from ~/.burnglass/bin" "[ \"\$(lines '$C/stub/launches.log')\" = 1 ] && grep -qx 'launch $H8/.burnglass/bin/burnglass-strip.exe' '$C/stub/launches.log'"

# ------------------------------------------------------------------ S9 kill + single launch
case_dirs s9
cp "$TMP/old.bin" "$C/exe/burnglass-strip.exe"; cp "$TMP/old.bin" "$C/exe/pulse-strip.exe"
touch "$C/stub/running"; echo '{"strip": true}' > "$C/home/config.json"
mkrel ok; reset_mock
start_srv 5870 "$TMP/s9.log" $(common) "${FORCE[@]}" -- --after-update
wait_up 5870; wait_refresh 5870 "$TMP/s9.json"
wait_file "$C/stub/launches.log"; sleep 1
stop_srv $SRV
check "S9 both beside-exe files updated from ONE download" \
  "js '$TMP/s9.json' 's.strip.refresh.status === \"updated\" && s.strip.refresh.files.length === 2' && same '$TMP/new.bin' '$C/exe/burnglass-strip.exe' && same '$TMP/new.bin' '$C/exe/pulse-strip.exe' && [ \"\$(dl_count)\" = 1 ]"
check "S9 running strip killed once, taskkill argv has both image names" \
  "[ \"\$(lines '$C/stub/kills.log')\" = 1 ] && grep -qF '\"/IM\",\"burnglass-strip.exe\",\"/IM\",\"pulse-strip.exe\"' '$C/stub/kills.log'"
check "S9 exactly ONE launch (the start-up launch was deferred, not doubled)" \
  "[ \"\$(lines '$C/stub/launches.log')\" = 1 ] && grep -qx 'launch $C/exe/burnglass-strip.exe' '$C/stub/launches.log'"
check "S9 the swap is logged BEFORE the restart" \
  "[ \"\$(grep -n 'strip refresh: updated burnglass-strip.exe' '$TMP/s9.log' | cut -d: -f1)\" -lt \"\$(grep -n 'restarting the running strip' '$TMP/s9.log' | cut -d: -f1)\" ]"

# ------------------------------------------------------------------ S10 current + managed
case_dirs s10
cp "$TMP/new.bin" "$C/exe/burnglass-strip.exe"
touch "$C/stub/running"; echo '{"strip": true}' > "$C/home/config.json"
reset_mock
start_srv 5871 "$TMP/s10.log" $(common) "${FORCE[@]}" -- --after-update
wait_up 5871; wait_refresh 5871 "$TMP/s10.json"
wait_file "$C/stub/launches.log"; sleep 0.8
stop_srv $SRV
check "S10 current + running: no kill, one (deduped) launch" \
  "js '$TMP/s10.json' 's.strip.refresh.status === \"current\"' && [ ! -e '$C/stub/kills.log' ] && [ \"\$(lines '$C/stub/launches.log')\" = 1 ] && grep -q '^already-running ' '$C/stub/launches.log'"

# ------------------------------------------------------------------ S11 strip that will not die
case_dirs s11
cp "$TMP/old.bin" "$C/exe/burnglass-strip.exe"
touch "$C/stub/running" "$C/stub/sticky"; echo '{"strip": true}' > "$C/home/config.json"
reset_mock
start_srv 5872 "$TMP/s11.log" $(common) "${FORCE[@]}" -- --after-update
wait_up 5872; wait_refresh 5872 "$TMP/s11.json"
T0=$(date +%s)
for _ in $(seq 1 60); do [ -s "$C/stub/launches.log" ] && break; sleep 0.25; done
T1=$(date +%s); sleep 0.5
stop_srv $SRV
check "S11 bounded wait: warned after ~5 s, launch attempted once (deduped)" \
  "grep -q 'did not exit within 5 s' '$TMP/s11.log' && [ \"\$(lines '$C/stub/launches.log')\" = 1 ] && grep -q '^already-running ' '$C/stub/launches.log' && [ \$((T1 - T0)) -le 9 ]"
check "S11 the file was still swapped" "same '$TMP/new.bin' '$C/exe/burnglass-strip.exe'"

# ------------------------------------------------------------------ S12 not after-update
case_dirs s12
cp "$TMP/old.bin" "$C/exe/burnglass-strip.exe"; echo '{"strip": true}' > "$C/home/config.json"
reset_mock
start_srv 5873 "$TMP/s12.log" $(common) "${FORCE[@]}"
wait_up 5873; wait_file "$C/stub/launches.log"; sleep 1.5; summary 5873 "$TMP/s12.json"
stop_srv $SRV
check "S12 normal start: nothing fetched, refresh null, file untouched" \
  "[ \"\$(stats 'l.length')\" = 0 ] && js '$TMP/s12.json' 's.strip.refresh === null && s.strip.enabled === true' && same '$TMP/old.bin' '$C/exe/burnglass-strip.exe'"
check "S12 the normal start-up launch happens once, no kill" \
  "[ \"\$(lines '$C/stub/launches.log')\" = 1 ] && grep -qx 'launch $C/exe/burnglass-strip.exe' '$C/stub/launches.log' && [ ! -e '$C/stub/kills.log' ]"

# ------------------------------------------------------------------ S13 update checks off
case_dirs s13
cp "$TMP/old.bin" "$C/exe/burnglass-strip.exe"
reset_mock
start_srv 5874 "$TMP/s13a.log" $(common) "${FORCE[@]}" -- --after-update --no-update-check
wait_up 5874; wait_refresh 5874 "$TMP/s13a.json"
stop_srv $SRV
check "S13 --no-update-check: skipped, nothing fetched" \
  "js '$TMP/s13a.json' 's.strip.refresh.status === \"skipped\" && /update checks are off/.test(s.strip.refresh.reason)' && [ \"\$(stats 'l.length')\" = 0 ] && same '$TMP/old.bin' '$C/exe/burnglass-strip.exe'"
echo '{"updateCheck": false}' > "$C/home/config.json"
start_srv 5875 "$TMP/s13b.log" $(common) "${FORCE[@]}" -- --after-update
wait_up 5875; wait_refresh 5875 "$TMP/s13b.json"
stop_srv $SRV
check "S13 {\"updateCheck\": false}: skipped, nothing fetched" \
  "js '$TMP/s13b.json' 's.strip.refresh.status === \"skipped\"' && [ \"\$(stats 'l.length')\" = 0 ]"

# ------------------------------------------------------------------ S14 not packaged Windows
case_dirs s14
cp "$TMP/old.bin" "$C/exe/burnglass-strip.exe"
reset_mock
start_srv 5876 "$TMP/s14.log" $(common) -- --after-update
wait_up 5876; sleep 1.5; summary 5876 "$TMP/s14.json"
stop_srv $SRV
check "S14 no force hook on Linux: refresh null, nothing fetched" \
  "js '$TMP/s14.json' 's.strip.refresh === null' && [ \"\$(stats 'l.length')\" = 0 ] && same '$TMP/old.bin' '$C/exe/burnglass-strip.exe'"

# ------------------------------------------------------------------ S15 404 / no strip asset
case_dirs s15
cp "$TMP/old.bin" "$C/exe/burnglass-strip.exe"
mkrel notfound; reset_mock
start_srv 5877 "$TMP/s15a.log" $(common) "${FORCE[@]}" -- --after-update
wait_up 5877; wait_refresh 5877 "$TMP/s15a.json"
stop_srv $SRV
check "S15 no release for this tag (404): skipped, nothing downloaded" \
  "js '$TMP/s15a.json' 's.strip.refresh.status === \"skipped\" && /no v$VER release/.test(s.strip.refresh.reason)' && [ \"\$(dl_count)\" = 0 ] && same '$TMP/old.bin' '$C/exe/burnglass-strip.exe'"
mkrel nostrip; reset_mock
start_srv 5878 "$TMP/s15b.log" $(common) "${FORCE[@]}" -- --after-update
wait_up 5878; wait_refresh 5878 "$TMP/s15b.json"
stop_srv $SRV
check "S15 release without strip assets: skipped" \
  "js '$TMP/s15b.json' 's.strip.refresh.status === \"skipped\" && /no strip asset/.test(s.strip.refresh.reason)' && [ \"\$(dl_count)\" = 0 ]"

# ------------------------------------------------------------------ S16 alias only
case_dirs s16
cp "$TMP/old.bin" "$C/exe/burnglass-strip.exe"
mkrel aliasonly; reset_mock
start_srv 5879 "$TMP/s16.log" $(common) "${FORCE[@]}" -- --after-update
wait_up 5879; wait_refresh 5879 "$TMP/s16.json"
stop_srv $SRV
check "S16 only the pulse-strip.exe alias published: burnglass-strip.exe refreshed from it, own name kept" \
  "js '$TMP/s16.json' 's.strip.refresh.status === \"updated\" && s.strip.refresh.files[0].file === \"burnglass-strip.exe\"' && same '$TMP/new.bin' '$C/exe/burnglass-strip.exe' && [ ! -e '$C/exe/pulse-strip.exe' ] && [ \"\$(stats 'l.filter((u) => u.startsWith(\"/cdn/\")).join(\",\")')\" = '/cdn/pulse-strip.exe' ]"

# ------------------------------------------------------------------ S17 ~/.pulse is off limits
# A server running ON ~/.pulse (the degraded / pinned cases) uses it as its
# home — server.json, burnglass.log — so there only bin/, the strip's folder,
# is compared; case c (home = ~/.burnglass) compares the whole tree.
hash_strip_tree() { hash_tree "$1/bin" "$2"; }
# a) degraded: ~/.burnglass is a FILE, so the migration fails and the server
#    runs on ~/.pulse, whose bin/ holds a stale strip + an aside copy that the
#    start-up cleanup must not delete either
C=$TMP/s17a; H17=$C/fakehome; mkdir -p "$H17/.pulse/bin" "$C/exe" "$C/stub"
echo '{"strip": true}' > "$H17/.pulse/config.json"
echo 'not a folder' > "$H17/.burnglass"
cp "$TMP/old.bin" "$H17/.pulse/bin/pulse-strip.exe"; cp "$TMP/old2.bin" "$H17/.pulse/bin/pulse-strip.exe.old"
hash_strip_tree "$H17/.pulse" "$TMP/s17a-before.txt"
mkrel ok; reset_mock
start_srv 5880 "$TMP/s17a.log" HOME="$H17" PULSE_STRIP_EXE_DIR="$C/exe" PULSE_STRIP_PROC_STUB="$C/stub" "${FORCE[@]}" -- --after-update
wait_up 5880; wait_refresh 5880 "$TMP/s17a.json"
stop_srv $SRV
hash_strip_tree "$H17/.pulse" "$TMP/s17a-after.txt"
check "S17a degraded run on ~/.pulse: skipped (old Pulse folder), nothing fetched" \
  "js '$TMP/s17a.json' 's.homeMigration && s.homeMigration.status === \"failed\" && s.strip.refresh.status === \"skipped\" && /old Pulse folder/.test(s.strip.refresh.reason)' && [ \"\$(stats 'l.length')\" = 0 ]"
check "S17a ~/.pulse byte-identical (strip, its .old kept, nothing added to bin/)" "cmp -s '$TMP/s17a-before.txt' '$TMP/s17a-after.txt'"
# b) PULSE_HOME pinned to ~/.pulse (a pinned home is used verbatim)
C=$TMP/s17b; H17=$C/fakehome; mkdir -p "$H17/.pulse/bin" "$C/exe" "$C/stub"
echo '{}' > "$H17/.pulse/config.json"
cp "$TMP/old.bin" "$H17/.pulse/bin/burnglass-strip.exe"
hash_strip_tree "$H17/.pulse" "$TMP/s17b-before.txt"
reset_mock
start_srv 5881 "$TMP/s17b.log" HOME="$H17" PULSE_HOME="$H17/.pulse" PULSE_STRIP_EXE_DIR="$C/exe" PULSE_STRIP_PROC_STUB="$C/stub" "${FORCE[@]}" -- --after-update
wait_up 5881; wait_refresh 5881 "$TMP/s17b.json"
stop_srv $SRV
hash_strip_tree "$H17/.pulse" "$TMP/s17b-after.txt"
check "S17b PULSE_HOME=~/.pulse: skipped, nothing fetched, ~/.pulse untouched" \
  "js '$TMP/s17b.json' 's.strip.refresh.status === \"skipped\" && /old Pulse folder/.test(s.strip.refresh.reason)' && [ \"\$(stats 'l.length')\" = 0 ] && cmp -s '$TMP/s17b-before.txt' '$TMP/s17b-after.txt'"
# c) the server exe (and its strip) live in ~/.pulse/bin; the home is ~/.burnglass
C=$TMP/s17c; H17=$C/fakehome; mkdir -p "$H17/.pulse/bin" "$H17/.burnglass" "$C/stub"
echo '{}' > "$H17/.burnglass/config.json"; echo '{}' > "$H17/.pulse/config.json"
cp "$TMP/old.bin" "$H17/.pulse/bin/pulse-strip.exe"; cp "$TMP/old2.bin" "$H17/.pulse/bin/pulse-strip.exe.old"
hash_tree "$H17/.pulse" "$TMP/s17c-before.txt"
reset_mock
start_srv 5882 "$TMP/s17c.log" HOME="$H17" PULSE_STRIP_EXE_DIR="$H17/.pulse/bin" PULSE_STRIP_PROC_STUB="$C/stub" "${FORCE[@]}" -- --after-update
wait_up 5882; wait_refresh 5882 "$TMP/s17c.json"
stop_srv $SRV
hash_tree "$H17/.pulse" "$TMP/s17c-after.txt"
check "S17c strip beside a server exe inside ~/.pulse: skipped, nothing fetched, no ~/.burnglass/bin copy" \
  "js '$TMP/s17c.json' 's.strip.refresh.status === \"skipped\" && /old Pulse folder/.test(s.strip.refresh.reason)' && [ \"\$(stats 'l.length')\" = 0 ] && [ ! -e '$H17/.burnglass/bin' ]"
check "S17c ~/.pulse byte-identical (incl. the .old the cleanup must not touch)" "cmp -s '$TMP/s17c-before.txt' '$TMP/s17c-after.txt'"

# ------------------------------------------------------------------ S18 off during the relaunch pause
case_dirs s18
cp "$TMP/old.bin" "$C/exe/burnglass-strip.exe"
touch "$C/stub/running"; echo '{"strip": true}' > "$C/home/config.json"
mkrel ok; reset_mock
start_srv 5883 "$TMP/s18.log" $(common) "${FORCE[@]}" -- --after-update
wait_up 5883
for _ in $(seq 1 300); do [ -s "$C/stub/kills.log" ] && break; sleep 0.03; done
strip_off 5883 "$TMP/s18-off.json"   # lands inside the 1.5 s pause before the relaunch
sleep 3
summary 5883 "$TMP/s18.json"
stop_srv $SRV
check "S18 (the swap + kill happened; the disable answered and stuck)" \
  "[ \"\$(lines '$C/stub/kills.log')\" = 1 ] && same '$TMP/new.bin' '$C/exe/burnglass-strip.exe' && js '$TMP/s18-off.json' 's.ok === true && s.strip.enabled === false' && js '$TMP/s18.json' 's.strip.enabled === false'"
check "S18 turned off during the pause before the relaunch: NOT launched" "[ ! -e '$C/stub/launches.log' ]"
check "S18 the skipped relaunch is logged after the dashboard's disable" \
  "grep -q 'strip was turned off meanwhile' '$TMP/s18.log' && [ \"\$(grep -n 'strip disabled from the dashboard' '$TMP/s18.log' | cut -d: -f1)\" -lt \"\$(grep -n 'turned off meanwhile' '$TMP/s18.log' | cut -d: -f1)\" ]"

# ------------------------------------------------------------------ S19 off while waiting for a stuck strip
case_dirs s19
cp "$TMP/old.bin" "$C/exe/burnglass-strip.exe"
touch "$C/stub/running" "$C/stub/sticky"; echo '{"strip": true}' > "$C/home/config.json"
reset_mock
start_srv 5884 "$TMP/s19.log" $(common) "${FORCE[@]}" -- --after-update
wait_up 5884
for _ in $(seq 1 300); do [ -s "$C/stub/kills.log" ] && break; sleep 0.03; done
strip_off 5884 "$TMP/s19-off.json"   # inside the ~5 s wait for the old strip to exit
for _ in $(seq 1 60); do grep -q 'did not exit within' "$TMP/s19.log" && break; sleep 0.2; done
sleep 0.8
stop_srv $SRV
check "S19 turned off while waiting for a strip that will not die: no launch attempt" \
  "grep -q 'did not exit within' '$TMP/s19.log' && [ ! -e '$C/stub/launches.log' ] && grep -q 'strip was turned off meanwhile' '$TMP/s19.log'"

# ------------------------------------------------------------------ S20 failed -> retried on the next start
case_dirs s20; S20=$C
cp "$TMP/old.bin" "$C/exe/burnglass-strip.exe"
MK=$C/home/strip-refresh.json
mkrel error500; reset_mock
start_srv 5885 "$TMP/s20a.log" $(common) "${FORCE[@]}" -- --after-update
wait_up 5885; wait_refresh 5885 "$TMP/s20a.json"
stop_srv $SRV
check "S20 release lookup HTTP 500: failed, file untouched" \
  "js '$TMP/s20a.json' 's.strip.refresh.status === \"failed\" && /HTTP 500/.test(s.strip.refresh.error)' && same '$TMP/old.bin' '$C/exe/burnglass-strip.exe'"
check "S20 payload says how it heals: attempt 1, 4 retries left, an in-process retry scheduled" \
  "js '$TMP/s20a.json' 's.strip.refresh.attempts === 1 && s.strip.refresh.retriesLeft === 4 && s.strip.refresh.retryAt > Date.now() && s.strip.refresh.checking === false'"
check "S20 the failure is kept in <home>/strip-refresh.json (no path in it)" \
  "marker '$MK' 'm.v === 1 && m.version === \"$VER\" && m.status === \"failed\" && m.attempts === 1 && /HTTP 500/.test(m.error) && !JSON.stringify(m).includes(\"$TMP\")'"
mkrel ok; reset_mock
start_srv 5886 "$TMP/s20b.log" $(common) "${FORCE[@]}"
wait_up 5886; wait_status 5886 "$TMP/s20b.json" updated
stop_srv $SRV
check "S20 a NORMAL start retries it: updated, the file swapped" \
  "js '$TMP/s20b.json' 's.strip.refresh.status === \"updated\" && s.strip.refresh.attempts === 2' && same '$TMP/new.bin' '$C/exe/burnglass-strip.exe'"
check "S20 one lookup + one download for the retry, logged as a retry" \
  "[ \"\$(api_count)\" = 1 ] && [ \"\$(dl_count)\" = 1 ] && grep -q 'retrying the failed refresh to v$VER (attempt 2 of 5)' '$TMP/s20b.log'"
check "S20 success removes the marker" "[ ! -e '$MK' ]"
reset_mock
start_srv 5887 "$TMP/s20c.log" $(common) "${FORCE[@]}"
wait_up 5887; sleep 1.2; summary 5887 "$TMP/s20c.json"
stop_srv $SRV
check "S20 the next normal start: nothing owed, nothing fetched, refresh null" \
  "[ \"\$(stats 'l.length')\" = 0 ] && js '$TMP/s20c.json' 's.strip.refresh === null'"

# ------------------------------------------------------------------ S21 in-process retry timer
case_dirs s21
cp "$TMP/old.bin" "$C/exe/burnglass-strip.exe"
touch "$C/stub/running"; echo '{"strip": true}' > "$C/home/config.json"
mkrel error500; reset_mock
start_srv 5888 "$TMP/s21.log" $(common) "${FORCE[@]}" PULSE_STRIP_REFRESH_RETRY_MS=2500 -- --after-update
wait_up 5888; wait_refresh 5888 "$TMP/s21a.json"
mkrel ok
wait_status 5888 "$TMP/s21b.json" updated
for _ in $(seq 1 40); do [ "$(lines "$C/stub/launches.log")" -ge 2 ] && break; sleep 0.2; done
sleep 0.5
stop_srv $SRV
check "S21 first attempt failed with a retry scheduled ~2.5 s out" \
  "js '$TMP/s21a.json' 's.strip.refresh.status === \"failed\" && s.strip.refresh.retryAt - s.strip.refresh.at > 1500 && s.strip.refresh.retryAt - s.strip.refresh.at < 4000'"
check "S21 the timer retried in-process: updated (attempt 2), file swapped, marker gone" \
  "js '$TMP/s21b.json' 's.strip.refresh.attempts === 2' && same '$TMP/new.bin' '$C/exe/burnglass-strip.exe' && [ ! -e '$C/home/strip-refresh.json' ]"
check "S21 the running managed strip was restarted on the new file (killed once, launched once more)" \
  "[ \"\$(lines '$C/stub/kills.log')\" = 1 ] && [ \"\$(lines '$C/stub/launches.log')\" = 2 ] && head -1 '$C/stub/launches.log' | grep -q '^already-running ' && tail -1 '$C/stub/launches.log' | grep -qx 'launch $C/exe/burnglass-strip.exe'"

# ------------------------------------------------------------------ S22 gave up
case_dirs s22
cp "$TMP/old.bin" "$C/exe/burnglass-strip.exe"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ v: 1, version: process.argv[2], status: "failed", at: Date.now() - 60e3, attempts: 5, error: "release lookup failed: HTTP 500" }))' "$C/home/strip-refresh.json" "$VER"
mkrel ok; reset_mock
start_srv 5889 "$TMP/s22.log" $(common) "${FORCE[@]}"
wait_up 5889; sleep 1.2; summary 5889 "$TMP/s22.json"
stop_srv $SRV
check "S22 five failed attempts: nothing fetched, file untouched, marker kept" \
  "[ \"\$(stats 'l.length')\" = 0 ] && same '$TMP/old.bin' '$C/exe/burnglass-strip.exe' && [ -e '$C/home/strip-refresh.json' ]"
check "S22 ...and the failure stays in the payload (retriesLeft 0, no retry scheduled)" \
  "js '$TMP/s22.json' 's.strip.refresh.status === \"failed\" && s.strip.refresh.retriesLeft === 0 && s.strip.refresh.retryAt === null && /HTTP 500/.test(s.strip.refresh.error)'"

# ------------------------------------------------------------------ S23 interrupted attempt
case_dirs s23
cp "$TMP/old.bin" "$C/exe/burnglass-strip.exe"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ v: 1, version: process.argv[2], status: "pending", at: Date.now() - 60e3, attempts: 1, pid: 999999999 }))' "$C/home/strip-refresh.json" "$VER"
mkrel ok; reset_mock
start_srv 5890 "$TMP/s23a.log" $(common) "${FORCE[@]}"
wait_up 5890; wait_status 5890 "$TMP/s23a.json" updated
stop_srv $SRV
check "S23 an attempt interrupted mid-way (pending, its process gone) is retried on the next start" \
  "js '$TMP/s23a.json' 's.strip.refresh.attempts === 2' && same '$TMP/new.bin' '$C/exe/burnglass-strip.exe' && grep -q 'retrying the interrupted refresh' '$TMP/s23a.log' && [ ! -e '$C/home/strip-refresh.json' ]"
case_dirs s23b
cp "$TMP/old.bin" "$C/exe/burnglass-strip.exe"
LIVEPID=${MOCKS##* }
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ v: 1, version: process.argv[2], status: "pending", at: Date.now(), attempts: 1, pid: +process.argv[3] }))' "$C/home/strip-refresh.json" "$VER" "$LIVEPID"
reset_mock
start_srv 5891 "$TMP/s23b.log" $(common) "${FORCE[@]}"
wait_up 5891; sleep 1.2; summary 5891 "$TMP/s23b.json"
stop_srv $SRV
check "S23 a pending attempt whose process is alive (another server) is left alone" \
  "[ \"\$(stats 'l.length')\" = 0 ] && js '$TMP/s23b.json' 's.strip.refresh === null' && same '$TMP/old.bin' '$C/exe/burnglass-strip.exe' && [ -e '$C/home/strip-refresh.json' ]"

# ------------------------------------------------------------------ S24 another version's marker
case_dirs s24
cp "$TMP/old.bin" "$C/exe/burnglass-strip.exe"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ v: 1, version: "0.0.1", status: "failed", at: Date.now(), attempts: 1, error: "x" }))' "$C/home/strip-refresh.json"
reset_mock
start_srv 5892 "$TMP/s24.log" $(common) "${FORCE[@]}"
wait_up 5892; sleep 1.2; summary 5892 "$TMP/s24.json"
stop_srv $SRV
check "S24 a marker from another version: ignored (nothing fetched, refresh null) and removed" \
  "[ \"\$(stats 'l.length')\" = 0 ] && js '$TMP/s24.json' 's.strip.refresh === null' && [ ! -e '$C/home/strip-refresh.json' ]"

# ------------------------------------------------------------------ S25 home IS ~/.pulse
C=$TMP/s25; H25=$C/fakehome; mkdir -p "$H25/.pulse" "$C/exe" "$C/stub"
echo '{}' > "$H25/.pulse/config.json"; echo 'not a folder' > "$H25/.burnglass"
cp "$TMP/old.bin" "$C/exe/burnglass-strip.exe"
hash_tree "$H25/.pulse" "$TMP/s25-before.txt"
mkrel error500; reset_mock
start_srv 5893 "$TMP/s25.log" HOME="$H25" PULSE_STRIP_EXE_DIR="$C/exe" PULSE_STRIP_PROC_STUB="$C/stub" "${FORCE[@]}" -- --after-update
wait_up 5893; wait_refresh 5893 "$TMP/s25.json"
stop_srv $SRV
check "S25 degraded run on ~/.pulse, the strip beside the exe failed to refresh: no marker written into ~/.pulse" \
  "js '$TMP/s25.json' 's.homeMigration && s.homeMigration.status === \"failed\" && s.strip.refresh.status === \"failed\"' && [ ! -e '$H25/.pulse/strip-refresh.json' ] && ! ls '$H25/.pulse' | grep -q 'strip-refresh'"

# ------------------------------------------------------------------ hygiene
check "no server log mentions an unexpected crash" "! grep -l 'TypeError\|ReferenceError\|Unhandled' '$TMP'/s*.log >/dev/null 2>&1"
# A bare name is looked up in the CURRENT folder first on Windows (libuv's
# search_path), and the server's cwd can be Downloads: every Windows builtin
# goes through system32Exe / powershellExe (absolute System32 path).
bare_builtins() {
  node -e '
const src = require("fs").readFileSync(process.argv[1], "utf8").split("\n");
const re = /\b(execFile|execFileSync|spawn|spawnSync)\(\s*(?:[^,()]*\?\s*)?["\x27](tasklist|taskkill|reg|powershell)(\.exe)?["\x27]/;
const hits = src.map((l, i) => [i + 1, l]).filter(([, l]) => re.test(l.replace(/\/\/.*$/, "")));
for (const [n, l] of hits) console.log(n + ": " + l.trim());
process.exit(hits.length ? 1 : 0);' "$SERVER"
}
check "server.js runs tasklist / taskkill / reg / powershell only by absolute System32 path" "bare_builtins"

[ $FAILS -eq 0 ] && echo "strip-heal: all passed" || echo "strip-heal: $FAILS failure(s)"
exit $((FAILS > 0))
