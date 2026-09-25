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

# --- tray self-diagnosis (rc.3) ----------------------------------------------
# PULSE_TRAY_TEST_SCRIPT swaps powershell + tray.ps1 for a node stand-in
# (spawned as `node <fake> <port> <tray.ps1>` with the same detached spawn,
# stdout+stderr → <home>/tray-error.log and exit watch), so on Linux:
# - a failing tray (PowerShell-style stderr + exit 3) lands in
#   payload.tray.lastError {code, message, kind} + ONE warning log line, with
#   ANSI stripped and the profile folder shown as ~;
# - a healthy one is "starting" until its first ?from=tray poll, then running,
#   and that poll clears lastError;
# - a lost icon lock (exit 4) is an info line, and running is null (can't tell)
#   until something polls; a plain status-line poll does NOT count, a
#   WindowsPowerShell User-Agent (a pre-rc.3 tray) does;
# - an early exit 0 while wanted is an error, one after disable is not, and
#   neither is one whose LAST line says the menu asked — even after a
#   non-fatal WARN line (the summary's pick) earlier in the same run;
# - a non-loopback bind records why nothing started;
# - the generated tray.ps1 (written by the same path): UTF-8 BOM + ASCII +
#   CRLF, the FROZEN mutex name, the starting line as the first action, the
#   setup try/catch (exit 2), NO script-level trap, ?from=tray polls, no bare
#   'powershell.exe' relaunch, balanced brackets outside strings, no
#   PowerShell 7-only operators; parsed by pwsh when available (PWSH=…), and
#   with pwsh its browser-opening menu handlers are dispatched the way
#   WinForms does (a .NET EventHandler whose caller catches exceptions) with
#   Start-Process failing: each must return normally and log a WARN — a
#   script-level trap made the error escape into WinForms.
PH2=$TMP/home-diag
mkdir -p "$PH2"
echo '{}' > "$PH2/config.json"
FAKE=$TMP/fake-tray.js
MODE=$TMP/fake-mode
: > "$TMP/fake-pids"
trap 'kill $(cat "$TMP/fake-pids" 2>/dev/null) 2>/dev/null; [ -n "${KEEP_TMP:-}" ] || rm -rf "$TMP"' EXIT
cat > "$FAKE" <<'EOF'
const fs = require('fs'), http = require('http'), os = require('os'), path = require('path');
const port = process.argv[2];
let mode = 'good';
try { mode = fs.readFileSync(process.env.FAKE_TRAY_MODE_FILE, 'utf8').trim(); } catch (_) {}
fs.appendFileSync(process.env.FAKE_TRAY_PIDS, process.pid + '\n');
const ts = () => new Date().toISOString();
const own = (level, msg) => process.stdout.write(ts() + ' ' + level.padEnd(5) + ' [burnglass] tray: ' + msg + '\r\n');
if (mode === 'policy') {
  // What powershell.exe prints BEFORE the script runs when a policy blocks it.
  process.stderr.write('\x1b[31mFile ' + path.join(os.homedir(), '.burnglass', 'tray.ps1') +
    ' cannot be loaded because running scripts is disabled on this system. For more\r\n' +
    'information, see about_Execution_Policies at https:/go.microsoft.com/fwlink/?LinkID=135170.\x1b[0m\r\n' +
    '    + CategoryInfo          : SecurityError: (:) [], ParentContainsErrorRecordException\r\n' +
    '    + FullyQualifiedErrorId : UnauthorizedAccess\r\n');
  process.exit(3);
} else if (mode === 'lock') {
  own('INFO', 'starting (fake)');
  own('WARN', 'another instance already owns the icon on port ' + port + '; this one is exiting.');
  process.exit(4);
} else if (mode === 'quick') {
  own('INFO', 'starting (fake)');
  setTimeout(() => process.exit(0), 300);
} else if (mode === 'menu') {
  own('INFO', 'starting (fake)');
  own('INFO', 'Exit tray chosen from the menu - exiting.');
  setTimeout(() => process.exit(0), 300);
} else if (mode === 'menuwarn') {
  // The real script's lines when the DestroyIcon helper can't compile: a
  // non-fatal WARN (the summary's pick) before the deliberate last line.
  own('INFO', 'starting (fake)');
  own('WARN', 'icon-handle helper unavailable (Cannot add type. Compilation errors occurred.) - continuing without it.');
  own('INFO', 'icon shown (fake)');
  own('INFO', 'Exit tray chosen from the menu - exiting.');
  setTimeout(() => process.exit(0), 300);
} else {
  // good: first poll after 2.5 s (so "starting" is observable), then every
  // 700 ms; exits like the real one on trayEnabled:false, an unreachable
  // server, or after 30 s.
  own('INFO', 'starting (fake)');
  const poll = () => {
    http.get({ host: '127.0.0.1', port, path: '/api/statusline?from=tray&pid=' + process.pid }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        let s = {};
        try { s = JSON.parse(b); } catch (_) {}
        if (s.trayEnabled === false) { own('INFO', 'turned off in the dashboard - hiding the icon and exiting.'); process.exit(0); }
        setTimeout(poll, 700);
      });
    }).on('error', () => process.exit(5));
  };
  setTimeout(poll, 2500);
  setTimeout(() => process.exit(0), 30000);
}
EOF
diagEnv() { # the common environment of the diagnosis servers (no NO_TRAY_SPAWN);
  # exec, so a backgrounded call's $! IS the server (kill must reach node)
  exec env PULSE_HOME="$PH2" CLAUDE_DIR="$CL" CODEX_DIR="$TMP/nc" PULSE_SUMMARY_MEMO_MS=0 PULSE_NO_STRIP_SPAWN=1 \
    PULSE_TRAY_TEST_SCRIPT="$FAKE" FAKE_TRAY_MODE_FILE="$MODE" FAKE_TRAY_PIDS="$TMP/fake-pids" "$@"
}
S="http://127.0.0.1:$PORT"
post() { curl -s -X POST -H 'X-Pulse: 1' "$S$1"; }

# D1: toggled on from the dashboard, one scenario after another.
diagEnv node "$ROOT/server.js" --port $PORT --no-update-check >"$TMP/d1.log" 2>&1 &
D1=$!
sleep 2.2
echo policy > "$MODE"
post /api/tray/enable > "$TMP/d-policy-en.json"
sleep 1.5
curl -s "$S/api/summary" > "$TMP/d-policy.json"
cp "$PH2/tray-error.log" "$TMP/d-policy-err.log" 2>/dev/null
cp "$PH2/tray.ps1" "$TMP/tray.ps1" 2>/dev/null
echo good > "$MODE"
post /api/tray/enable > "$TMP/d-retry.json" # the dashboard's Retry
curl -s "$S/api/summary" > "$TMP/d-start.json"
sleep 4
curl -s "$S/api/summary" > "$TMP/d-run.json"
post /api/tray/disable > /dev/null
sleep 2
curl -s "$S/api/summary" > "$TMP/d-off.json"
echo quick > "$MODE"
post /api/tray/enable > /dev/null
sleep 1.5
curl -s "$S/api/summary" > "$TMP/d-quick.json"
echo menu > "$MODE"
post /api/tray/enable > /dev/null
sleep 1.5
curl -s "$S/api/summary" > "$TMP/d-menu.json"
echo menuwarn > "$MODE"
post /api/tray/enable > /dev/null
sleep 1.5
curl -s "$S/api/summary" > "$TMP/d-menuwarn.json"
curl -s "$S/api/logs" > "$TMP/d1-logs.json" # the dashboard log tail (level + text)
kill $D1 2>/dev/null; wait $D1 2>/dev/null

# D2: config tray:true, the boot spawn loses the icon lock; then polls.
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ tray: true }))' "$PH2/config.json"
echo lock > "$MODE"
diagEnv node "$ROOT/server.js" --port $PORT --no-update-check >"$TMP/d2.log" 2>&1 &
D2=$!
sleep 2.8
curl -s "$S/api/summary" > "$TMP/d-lock.json"
curl -s "$S/api/statusline" > /dev/null # a status-line helper: not a tray
curl -s "$S/api/summary" > "$TMP/d-lock2.json"
curl -s -A 'Mozilla/5.0 (Windows NT; Windows NT 10.0; en-US) WindowsPowerShell/5.1.22621.4391' "$S/api/statusline" > /dev/null
curl -s "$S/api/summary" > "$TMP/d-legacy.json"
curl -s "$S/api/logs" > "$TMP/d2-logs.json"
kill $D2 2>/dev/null; wait $D2 2>/dev/null

# D3: tray:true on a non-loopback bind: nothing spawns, and it says why.
echo good > "$MODE"
diagEnv node "$ROOT/server.js" --port $PORT --host 0.0.0.0 --no-update-check >"$TMP/d3.log" 2>&1 &
D3=$!
sleep 2.2
curl -s "$S/api/summary" > "$TMP/d-nolo.json"
kill $D3 2>/dev/null; wait $D3 2>/dev/null

# pwsh parse of the generated script (the icon itself only runs on Windows).
PWSH=${PWSH:-$(command -v pwsh 2>/dev/null || true)}
PARSE=skip
if [ -n "$PWSH" ] && [ -f "$TMP/tray.ps1" ]; then
  cat > "$TMP/parse.ps1" <<'EOF'
param([string]$p)
$tokens = $null; $errs = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$tokens, [ref]$errs)
if ($errs.Count) { foreach ($e in $errs) { Write-Output ('line ' + $e.Extent.StartLineNumber + ': ' + $e.Message) }; exit 1 }
Write-Output 'parsed'
EOF
  if "$PWSH" -NoProfile -NonInteractive -File "$TMP/parse.ps1" "$TMP/tray.ps1" > "$TMP/parse.out" 2>&1; then PARSE=ok; else PARSE=fail; fi
fi

# pwsh: the tray's browser-opening menu handlers, dispatched the way WinForms
# does it (a .NET EventHandler whose caller catches what escapes), with
# Start-Process failing like the cmdlet does when nothing can be started (a
# statement-terminating error; the stub also means nothing is ever launched).
# The harness is the REAL tray.ps1: everything before the setup `try {` (so a
# script-level trap would be in force) + stand-ins for the WinForms objects the
# setup creates + the script from `$ErrorActionPreference = 'Continue'`
# through the click handler. Each handler must return normally and log a WARN.
HANDLERS=skip
if [ -n "$PWSH" ] && [ -f "$TMP/tray.ps1" ]; then
  mkdir -p "$TMP/hh"
  if node - "$TMP/tray.ps1" "$TMP/handlers.ps1" "$TMP/hh/burnglass.log" <<'EOF'
const fs = require("fs");
const [file, out, log] = process.argv.slice(2);
const lines = fs.readFileSync(file, "utf8").replace(/^﻿/, "").split("\r\n");
const tryAt = lines.indexOf("try {");
const contAt = lines.indexOf("$ErrorActionPreference = 'Continue'");
const clickAt = lines.findIndex((l) => /^\$ni\.add_MouseClick\(/.test(l));
if (tryAt < 0 || contAt < tryAt || clickAt < contAt) { console.error("tray.ps1 layout changed: extend the handler harness"); process.exit(1); }
const psq = (s) => "'" + s.replace(/'/g, "''") + "'";
const ps = [
  ...lines.slice(0, tryAt).map((l) => (/^\$logFile = /.test(l) ? "$logFile = " + psq(log) : l)),
  "$base = 'http://127.0.0.1:9'",
  "$script:handlers = @{}",
  "$items = New-Object PSObject",
  "$items | Add-Member -MemberType ScriptMethod -Name Add -Value { param($t, $i, $h) if ($h) { $script:handlers[$t] = $h } }",
  "$menu = New-Object PSObject -Property @{ Items = $items }",
  "$ni = New-Object PSObject -Property @{ ContextMenuStrip = $null; Visible = $true }",
  "$ni | Add-Member -MemberType ScriptMethod -Name add_MouseClick -Value { param($h) $script:handlers['(click)'] = $h }",
  "function Start-Process {",
  "  [CmdletBinding()]",
  "  param([Parameter(Position = 0)] $FilePath, $ArgumentList, $WindowStyle)",
  "  $PSCmdlet.ThrowTerminatingError((New-Object System.Management.Automation.ErrorRecord((New-Object System.InvalidOperationException ('test: cannot start ' + $FilePath)), 'BurnglassTestNoBrowser', 'NotSpecified', $FilePath)))",
  "}",
  ...lines.slice(contAt, clickAt + 1).filter((l) => !/^\$menu = New-Object /.test(l)),
  "Add-Type -TypeDefinition 'using System; public static class BurnglassTestDispatch { public static string Click(EventHandler h) { if (h == null) return \"missing\"; try { h(null, EventArgs.Empty); return \"returned\"; } catch (Exception e) { return \"escaped: \" + e.GetType().Name + \": \" + e.Message; } } }'",
  "foreach ($n in @('Open dashboard', 'Open mini overview')) { [Console]::Out.WriteLine('HANDLER ' + $n + ' = ' + [BurnglassTestDispatch]::Click($script:handlers[$n])) }",
];
fs.writeFileSync(out, "﻿" + ps.join("\r\n") + "\r\n");
EOF
  then "$PWSH" -NoProfile -NonInteractive -File "$TMP/handlers.ps1" > "$TMP/handlers.out" 2>&1; HANDLERS=ran
  else HANDLERS=layout; fi
fi

cat > "$TMP/diag-check.js" <<'EOF'
const fs = require("fs"), os = require("os");
const T = process.argv[2], PORT = process.argv[3], PARSE = process.argv[4];
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + "  " + m); if (!c) fail = 1; };
const J = (f) => { try { return JSON.parse(fs.readFileSync(T + "/" + f, "utf8")); } catch (_) { return {}; } };
const R = (f) => { try { return fs.readFileSync(T + "/" + f, "utf8"); } catch (_) { return ""; } };
const tr = (f) => J(f).tray || {};

const p = tr("d-policy.json"), pe = p.lastError || {};
ok(p.enabled === true && p.supported === true, "test hook: tray supported + enabled");
ok(p.running === false && p.starting === false && p.alive === false, "failed tray: running/starting/alive all false");
ok(pe.code === 3 && pe.kind === "policy", "lastError carries exit code 3 + kind policy (got " + JSON.stringify(pe) + ")");
ok(/cannot be loaded because running scripts is disabled on this system\. For more information, see about_Execution_Policies/.test(pe.message || ""),
   "lastError.message = PowerShell's first paragraph, wrapped lines joined");
ok(!/\x1b|[\u0000-\u001f]/.test(pe.message || "x") && !(pe.message || "").includes(os.homedir()) && /~[\\/]\.burnglass[\\/]tray\.ps1/.test(pe.message || ""),
   "message: no ANSI/control chars, profile folder shown as ~");
ok((pe.message || "").length <= 300 && typeof pe.at === "number", "message capped, at stamped");
ok(/running scripts is disabled/.test(R("d-policy-err.log")), "stderr captured in <home>/tray-error.log");
const logs = (f) => (J(f).lines || []).map((x) => x.level + " " + x.text).join("\n"); // the dashboard log tail
const d1 = logs("d1-logs.json");
ok((d1.match(/^warn \[burnglass\] tray icon exited \(exit code 3, \d+ s after start\): File ~/gm) || []).length === 1,
   "one warning in the dashboard log for the failed start");
ok(typeof (J("d-policy-en.json").tray || {}).running !== "undefined", "enable reply carries the diagnosis fields (additive)");

const s = tr("d-start.json");
ok(s.starting === true && s.running === false && s.alive === true && s.lastError === null && typeof s.spawnedAt === "number",
   "Retry: starting, lastError cleared by the new spawn (got " + JSON.stringify(s) + ")");
const r = tr("d-run.json");
ok(r.running === true && r.starting === false && r.lastError === null && typeof r.lastSeen === "number",
   "healthy tray: running after its first ?from=tray poll");
const off = tr("d-off.json");
ok(off.enabled === false && off.alive === false && off.lastError === null, "disable: it exits 0 and that is not an error");
ok(off.running === false, "the polling tray exited: running ends at once (its ?pid= matched the child), not 75 s later");
ok(/^info \[burnglass\] tray icon exited after \d+s \(its last line: turned off in the dashboard/m.test(d1), "normal exit logged at info with its last line");
const q = tr("d-quick.json"), qe = q.lastError || {};
ok(qe.code === 0 && qe.kind === "error" && /starting \(fake\)/.test(qe.message || "") && q.running === false,
   "exit 0 seconds after start while wanted = an early-exit error, its last line as the message (got " + JSON.stringify(q) + ")");
const mn = tr("d-menu.json");
ok(mn.lastError === null && mn.running === false && mn.alive === false, "an early exit 0 after \"Exit tray chosen from the menu\" is not an error");
const mw = tr("d-menuwarn.json");
ok(mw.lastError === null && mw.alive === false,
   "the same after an earlier non-fatal WARN line: the LAST line decides, not the summary's pick (got " + JSON.stringify(mw.lastError) + ")");
ok(/^info \[burnglass\] tray icon exited after \d+s \(its last line: Exit tray chosen from the menu/m.test(d1) && !/^warn .*tray icon exited .*icon-handle helper/m.test(d1),
   "…logged at info with its real last line, no warning");

const l = tr("d-lock.json"), le = l.lastError || {};
ok(le.code === 4 && le.kind === "lock" && /already owns the icon/.test(le.message || ""), "lost icon lock: code 4, kind lock");
ok(l.running === null, "running is null (unknown) while another instance may hold the icon (got " + l.running + ")");
const d2 = logs("d2-logs.json");
ok(/^info \[burnglass\] tray icon exited \(exit code 4/m.test(d2) && !/^warn .*tray icon exited/m.test(d2), "lost lock logged at info, not as a warning");
ok(tr("d-lock2.json").running === null, "a plain /api/statusline poll (status line helper) is not a tray");
const lg = tr("d-legacy.json");
ok(lg.running === true && lg.lastError === null, "a WindowsPowerShell-UA poll (pre-rc.3 tray) counts as running and clears lastError");

const n = tr("d-nolo.json"), ne = n.lastError || {};
ok(ne.kind === "not-loopback" && ne.code === null && /listens on 0\.0\.0\.0/.test(ne.message || "") && n.alive === false,
   "non-loopback bind: not started, and says why");

// ---- the generated tray.ps1 ----
const buf = fs.readFileSync(T + "/tray.ps1");
ok(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, "tray.ps1 starts with a UTF-8 BOM");
ok(buf.subarray(3).every((b) => b < 0x80), "tray.ps1 is ASCII after the BOM");
const src = buf.subarray(3).toString("utf8");
ok(!/[^\r]\n/.test(src) && src.endsWith("\r\n"), "CRLF line endings");
const lines = src.split("\r\n");
ok((src.match(/PulseTray/g) || []).length === 1 && src.includes("New-Object System.Threading.Mutex($false, 'PulseTray" + PORT + "')"),
   "FROZEN mutex name PulseTray<port>, once");
const firstCall = lines.findIndex((x) => /^Write-BgLog\b/.test(x)); // script level
ok(firstCall >= 0 && /^Write-BgLog \('starting \(v/.test(lines[firstCall]) && /PowerShell ' \+ \$PSVersionTable\.PSVersion/.test(lines[firstCall]),
   "the starting line (version, port, PowerShell version) is the first thing it does");
const tryAt = lines.indexOf("try {"), mtxAt = lines.findIndex((x) => /System\.Threading\.Mutex/.test(x));
const shownAt = lines.findIndex((x) => /\$ni\.Visible = \$true/.test(x)), catchAt = lines.indexOf("} catch {");
ok(tryAt >= 0 && tryAt < mtxAt && mtxAt < shownAt && shownAt < catchAt, "setup try/catch spans the mutex through the icon being shown");
const catchBody = lines.slice(catchAt, catchAt + 8).join("\n");
ok(/ScriptLineNumber/.test(catchBody) && /'ERROR'/.test(catchBody) && /exit 2/.test(catchBody), "the catch logs the line + message at ERROR and exits 2");
ok(!/^\s*trap\b/im.test(src), "no trap anywhere: a trap makes a handler's error escape into WinForms");
ok(!/try \{[^\r\n]*Application\]::Run\(\)/.test(src) && /^\[System\.Windows\.Forms\.Application\]::Run\(\)$/m.test(src),
   "Application.Run() is a bare statement (a try around it would do the same)");
ok(/'Open dashboard', \$null, \{ Open-BgDashboard \}/.test(src) && /could not open the dashboard: /.test(src) && /could not open the mini overview: /.test(src),
   "the browser-opening handlers catch locally and log a WARN");
ok(/AbandonedMutexException/.test(src), "an abandoned icon lock still counts as acquired");
// The compiled guard: DPI awareness (the owner's 4K/150% log said "16px") and
// a C# ThreadException handler (no .NET "Unhandled exception" dialog), in its
// own try/catch, before the first control and before the icon size is read.
const guardAt = lines.findIndex((x) => /\[BurnglassTrayGuard\]::DpiAware\(\); \[BurnglassTrayGuard\]::Install\(\$logFile\)/.test(x));
const niAt = lines.findIndex((x) => /New-Object System\.Windows\.Forms\.NotifyIcon/.test(x));
const sizeAt = lines.findIndex((x) => /SmallIconSize/.test(x));
ok(guardAt > 0 && /^\s*try \{ Add-Type -ReferencedAssemblies System\.Windows\.Forms -TypeDefinition '/.test(lines[guardAt]) && /^\s*catch \{ Write-BgLog \('error guard unavailable/.test(lines[guardAt + 1]),
   "the guard is compiled in its own try/catch (a blocked compiler never stops the icon)");
ok(guardAt < niAt && guardAt < sizeAt, "the guard runs before the first control and before the icon size is read");
const guardLine = lines[guardAt] || "";
ok((guardLine.match(/'/g) || []).length === 2, "the C# source carries no single quote (it sits in a PowerShell single-quoted string)");
ok(/SetProcessDPIAware/.test(guardLine) && /SetUnhandledExceptionMode\(UnhandledExceptionMode\.CatchException\)/.test(guardLine)
   && /ThreadException\+=/.test(guardLine) && /FileShare\.ReadWrite/.test(guardLine) && /Environment\.Exit\(3\)/.test(guardLine),
   "the guard: DPI-aware, CatchException + a ThreadException handler that logs (shared file access) and exits 3");
ok(!/\$"/.test(guardLine) && !/\)\s*=>/.test(guardLine), "the guard is C# 5 (no interpolated strings, no lambdas/expression bodies)");
ok(src.includes("/api/statusline?from=tray&pid=' + $PID"), "polls identify the tray (?from=tray&pid=)");
ok(!/Start-Process 'powershell\.exe'/.test(src) && /Join-Path \$PSHOME 'powershell\.exe'/.test(src), "relaunch uses an absolute powershell.exe path");
ok(/^exit \$script:exitCode$/m.test(src) && /exit 4/.test(src) && /\$script:exitCode = 5/.test(src), "exit codes 2/4/5 for the server");
// brackets balance outside strings/comments; no PowerShell 7-only operators
let depth = { "(": 0, "{": 0, "[": 0 }, neg = false, seven = [];
const close = { ")": "(", "}": "{", "]": "[" };
for (let i = 0; i < src.length; i++) {
  const c = src[i];
  if (c === "'") { i++; while (i < src.length) { if (src[i] === "'") { if (src[i + 1] === "'") { i += 2; continue; } break; } i++; } continue; }
  if (c === "\"") { i++; while (i < src.length && src[i] !== "\"") { if (src[i] === "`") i++; i++; } continue; }
  if (c === "#") { while (i < src.length && src[i] !== "\n") i++; continue; }
  if (depth[c] !== undefined) depth[c]++;
  else if (close[c]) { depth[close[c]]--; if (depth[close[c]] < 0) neg = true; }
  const two = src.slice(i, i + 2);
  if (two === "&&" || two === "||" || two === "??" || two === "?.") seven.push(two);
}
ok(!neg && depth["("] === 0 && depth["{"] === 0 && depth["["] === 0, "(), {}, [] balance outside strings");
ok(seven.length === 0, "no PowerShell 7-only operators (&& || ?? ?.): it runs under 5.1");
if (PARSE === "skip") console.log("SKIP  pwsh parse (no pwsh here; set PWSH=/path/to/pwsh)");
else ok(PARSE === "ok", "pwsh parses tray.ps1 without errors" + (PARSE === "ok" ? "" : ": " + R("parse.out")));
const HANDLERS = process.argv[6];
if (HANDLERS === "skip") console.log("SKIP  tray menu handlers under pwsh (no pwsh here; set PWSH=/path/to/pwsh)");
else {
  const hout = R("handlers.out"), hlog = R("hh/burnglass.log");
  ok(HANDLERS === "ran", "menu-handler harness cut from the real tray.ps1 (" + HANDLERS + ")");
  ok(/^HANDLER Open dashboard = returned\r?$/m.test(hout) && /^HANDLER Open mini overview = returned\r?$/m.test(hout),
     "a failing Start-Process stays inside its menu handler, dispatched like WinForms (" + ((hout.match(/^HANDLER .*/mg) || []).join(" | ") || hout.slice(0, 400)) + ")");
  ok(/WARN  \[burnglass\] tray: could not open the dashboard: test: cannot start http:\/\/127\.0\.0\.1:9\//.test(hlog)
     && /WARN  \[burnglass\] tray: could not open the mini overview: test: cannot start http:\/\/127\.0\.0\.1:9\/#mini/.test(hlog),
     "…and is logged as a WARN in burnglass.log (" + JSON.stringify(hlog.split(/\r?\n/).filter((l) => /WARN|ERROR/.test(l))) + ")");
}

// ---- summarizeTrayOutput: the other shapes PowerShell prints ----
const { summarizeTrayOutput: S } = require(process.argv[5] + "/server.js");
const own = (lv, m) => "2026-09-25T10:00:00.000Z " + lv.padEnd(5) + " [burnglass] tray: " + m + "\r\n";
let o = S(Buffer.from("At " + os.homedir() + "/.burnglass/tray.ps1:25 char:3\r\n+   try {\r\n+   ~~~\r\nMissing closing '}' in statement block or type definition.\r\n    + CategoryInfo          : ParserError: (:) [], ParseException\r\n"), 1);
ok(o.message === "Missing closing '}' in statement block or type definition. (line 25)", "parse error: message + the line from the At line BEFORE it (" + o.message + ")");
o = S(Buffer.from("Exception calling \"WaitOne\" with \"1\" argument(s): \"boom\"\r\nAt C:\\x\\tray.ps1:18 char:5\r\n+ x\r\n"), 1);
ok(/"boom" \(line 18\)$/.test(o.message), "runtime error: the line from the At line AFTER it");
o = S(Buffer.from(own("INFO", "starting (v, port 1, PowerShell 5.1 Desktop, FullLanguage, pid 1)") + own("ERROR", "unexpected error at tray.ps1 line 90: a") + own("ERROR", "failed while decoding the icons (tray.ps1 line 65): b")), 2);
ok(o.message === "failed while decoding the icons (tray.ps1 line 65): b" && o.kind === "error", "own ERROR lines win, the LAST one (the one that ended it)");
o = S(Buffer.from(own("INFO", "starting (v, port 1, PowerShell 5.1 Desktop, ConstrainedLanguage, pid 1)") + own("ERROR", "failed while opening the single-instance lock (tray.ps1 line 24): Cannot create type.")), 2);
ok(o.kind === "language-mode", "Constrained Language mode in the starting line -> kind language-mode");
o = S(Buffer.from("This script contains malicious content and has been blocked by your antivirus software.\r\n"), 1);
ok(o.kind === "antivirus", "AMSI block -> kind antivirus");
o = S(Buffer.from("#< CLIXML\r\n<Objs Version=\"1.1.0.1\"><S S=\"Error\">File x is not digitally signed._x000D__x000A_</S></Objs>"), 1);
ok(o.message === "File x is not digitally signed." && o.kind === "policy", "CLIXML error records decoded");
o = S(Buffer.from("Oops in UTF-16\r\n", "utf16le"), 1);
ok(o.message === "Oops in UTF-16", "BOM-less UTF-16 output decoded");
o = S(Buffer.concat([Buffer.from(own("WARN", "another instance already owns the icon on port 1; x")), Buffer.alloc(300), Buffer.from("late\r\n")]), 4);
ok(o.kind === "lock" && /already owns the icon/.test(o.message), "a NUL hole (older instance writing past the truncation) is not read as UTF-16");
o = S(Buffer.alloc(0), 1);
ok(o.message === "" && o.kind === "no-output", "no output -> kind no-output");
o = S(Buffer.from(own("INFO", "starting (v, port 1, PowerShell 5.1 Desktop, FullLanguage, pid 1)") + own("WARN", "icon-handle helper unavailable (x) - continuing without it.") + own("INFO", "Exit tray chosen from the menu - exiting.") + "stray foreign text\r\n"), 0);
ok(o.message === "icon-handle helper unavailable (x) - continuing without it." && o.last === "Exit tray chosen from the menu - exiting.",
   "last = the script's own last line (foreign text ignored), message keeps ERROR > WARN (" + JSON.stringify(o) + ")");
ok(S(Buffer.from("plain foreign\r\n"), 1).last === "", "last is empty without a line of the script's own");
process.exit(fail);
EOF
node "$TMP/diag-check.js" "$TMP" "$PORT" "$PARSE" "$ROOT" "$HANDLERS"
RES2=$?
[ $RES2 -ne 0 ] && RES=$RES2
echo "---- exit $RES"
exit $RES
