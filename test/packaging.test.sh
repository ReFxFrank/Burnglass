#!/bin/bash
# Packaging: the Burnglass Strip's file-system contract and the release
# workflow's resilience. No server, no ports.
#
# 1. Strip (strip/Program.cs): the strip must never delete anything under the
#    legacy ~/.pulse - not when the server hands it BURNGLASS_HOME=~/.pulse
#    after a failed migration, not when PULSE_HOME pins it there, not through a
#    link, not before the migration - and elsewhere it only ever deletes files
#    it wrote itself (listed in its strip-web manifest). The strip is a Windows
#    app, but AppPaths + WebAssets are plain .NET: they are cut out of the REAL
#    Program.cs and compiled into a console harness, run against fake homes.
#    Needs a .NET 9 SDK (`dotnet` on PATH, or DOTNET=/path/to/dotnet); without
#    one that part SKIPs (BURNGLASS_REQUIRE_DOTNET=1 turns the skip into a FAIL).
#    The same harness also compiles MeterScale + SummaryTransform and checks
#    the popover payload against fixture summaries: per-SOURCE spend rows in
#    the dashboard's order, colours (--s1..--s6, dark) and labels (sourceMeta >
#    built-in > raw key), and the alert thresholds / meter tones the strip,
#    the popover and the dashboard share — tones from the UNROUNDED % (79.5 is
#    plain like on the dashboard, though it prints 80), spend amounts not
#    pre-rounded (12.344996 must not become $12.35), a stale (rolled-over)
#    Claude window dropped like a Codex one. With Playwright + Chromium the
#    popover page (strip/web/index.html) then renders that payload (else SKIP).
# 2. release.yml: test/packaging/release-workflow.py (python3 + PyYAML).
#
# Overrides, for proving a regression against an older tree:
#   STRIP_DIR=<dir holding Program.cs etc.>  RELEASE_YML=<workflow file>
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$DIR/.." && pwd)
STRIP_DIR=${STRIP_DIR:-$ROOT/strip}
RELEASE_YML=${RELEASE_YML:-$ROOT/.github/workflows/release.yml}
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
FAILS=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAILS=$((FAILS + 1)); }

# ---------------------------------------------------------------------------
echo "--- release workflow"
if python3 -c 'import yaml' 2>/dev/null; then
  python3 "$DIR/packaging/release-workflow.py" "$RELEASE_YML" || FAILS=$((FAILS + 1))
else
  echo "SKIP: release workflow checks (python3 with PyYAML not found)"
fi

# ---------------------------------------------------------------------------
echo "--- strip source"
# The ONLY deletes the strip may perform: File.Delete inside the manifest-gated
# WebAssets.DeleteOwnFile. A recursive Directory.Delete anywhere is how
# ~/.pulse/strip-web used to be wiped.
node - "$STRIP_DIR" <<'JS'
const fs = require('fs'), path = require('path');
const dir = process.argv[2];
let bad = [], ok = 0;
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.cs'))) {
  const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
  let fn = '';
  lines.forEach((l, i) => {
    const m = l.match(/^\s*(?:private|public|internal|static|\s)*[\w<>?\[\]]+\s+(\w+)\s*\(/);
    if (m && !/^\s*(if|for|foreach|while|using|return|catch)\b/.test(l)) fn = m[1];
    if (/\b(Directory\.Delete|File\.Delete|FileSystemInfo\.Delete|\.Delete\()/.test(l.replace(/\/\/.*$/, ''))) {
      if (f === 'Program.cs' && fn === 'DeleteOwnFile' && /File\.Delete\(/.test(l)) ok++;
      else bad.push(`${f}:${i + 1} (${fn}) ${l.trim()}`);
    }
  });
}
const says = (c, m) => console.log((c ? 'PASS: ' : 'FAIL: ') + m);
says(bad.length === 0 && ok >= 1, 'the strip deletes only through WebAssets.DeleteOwnFile' +
  (bad.length ? ' - found: ' + bad.join(' | ') : ''));
const prog = fs.readFileSync(path.join(dir, 'Program.cs'), 'utf8');
says(/ScratchPathOf\("webview-strip"\)/.test(prog) && !/[^h]PathOf\("webview-strip"\)/.test(prog),
  'the WebView2 profile folder goes through AppPaths.ScratchPathOf (WebView2 deletes inside it)');
process.exit(bad.length === 0 && ok >= 1 ? 0 : 1);
JS
[ $? -eq 0 ] || FAILS=$((FAILS + 1))

# ---------------------------------------------------------------------------
echo "--- strip home + web extraction (compiled from $STRIP_DIR/Program.cs)"
DOTNET=${DOTNET:-$(command -v dotnet || true)}
if [ -z "$DOTNET" ] || [ ! -x "$DOTNET" ]; then
  if [ "${BURNGLASS_REQUIRE_DOTNET:-}" = 1 ]; then fail "strip harness: no dotnet (set DOTNET=/path/to/dotnet)"
  else echo "SKIP: strip harness (no .NET SDK; set DOTNET=/path/to/dotnet to run it)"; fi
  [ $FAILS -eq 0 ] && echo "packaging: all passed" || echo "packaging: $FAILS failure(s)"
  exit $((FAILS > 0))
fi

H=$T/harness
mkdir -p "$H/web/icons"
printf 'HARNESS-UI-2' > "$H/web/index.html"
printf '<svg/>' > "$H/web/icons/claude.svg"
cat > "$H/harness.csproj" <<'XML'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net9.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <LangVersion>latest</LangVersion>
    <UseAppHost>false</UseAppHost>
    <AssemblyName>harness</AssemblyName>
  </PropertyGroup>
  <ItemGroup>
    <EmbeddedResource Include="web\**\*">
      <LogicalName>web/%(RecursiveDir)%(Filename)%(Extension)</LogicalName>
    </EmbeddedResource>
  </ItemGroup>
</Project>
XML
# Cut `static class AppPaths` and `WebAssets` (required), plus `MeterScale` and
# `SummaryTransform` (the popover payload; optional, so STRIP_DIR can still
# point at an older tree for the home checks) out of the real Program.cs
# (brace matching that skips comments, strings and char literals).
if ! node - "$STRIP_DIR/Program.cs" "$H" <<'JS'
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(process.argv[2], 'utf8');
function cut(name, optional) {
  const m = new RegExp('^static class ' + name + '\\b', 'm').exec(src);
  if (!m) { if (optional) return null; throw new Error('no static class ' + name); }
  let i = src.indexOf('{', m.index), depth = 0;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '$' && (n === '"' || n === '@')) throw new Error('interpolated string in ' + name + ': extend the extractor');
    if (c === '@' && n === '"') { i += 2; while (!(src[i] === '"' && src[i + 1] !== '"')) i += src[i] === '"' ? 2 : 1; continue; }
    if (c === '"') { i++; while (src[i] !== '"') i += src[i] === '\\' ? 2 : 1; continue; }
    if (c === "'") { i++; while (src[i] !== "'") i += src[i] === '\\' ? 2 : 1; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return src.slice(m.index, i + 1);
  }
  throw new Error('unbalanced ' + name);
}
const head = 'using System.Globalization;\nusing System.Text.Json;\nusing System.Text.Json.Nodes;\n\nnamespace BurnglassStrip;\n\n';
fs.writeFileSync(path.join(process.argv[3], 'Extracted.cs'), head + cut('AppPaths') + '\n\n' + cut('WebAssets') + '\n');
const ms = cut('MeterScale', true), st = cut('SummaryTransform', true);
if (ms && st) fs.writeFileSync(path.join(process.argv[3], 'ExtractedUi.cs'), head + ms + '\n\n' + st + '\n');
JS
then
  fail "could not extract AppPaths/WebAssets from $STRIP_DIR/Program.cs"
  exit 1
fi
cat > "$H/Harness.cs" <<'CS'
namespace BurnglassStrip;

// What the strip does at startup, minus the UI: resolve the home, extract the
// popover UI (WebAssets.Dir), create the WebView2 profile folder the popover
// uses (PopoverForm.InitWebAsync; ScratchPathOf when the build has it).
// Any argument makes it a UiHarness command instead (compiled only when the
// tree has MeterScale + SummaryTransform).
static class Harness
{
    static int Main(string[] args)
    {
        if (args.Length > 0)
        {
            var ui = Type.GetType("BurnglassStrip.UiHarness");
            if (ui == null) { Console.WriteLine("NO-UI-HARNESS"); return 3; }
            return (int)ui.GetMethod("Run")!.Invoke(null, new object[] { args })!;
        }
        Console.WriteLine("HOME=" + AppPaths.Home);
        Console.WriteLine("DIR=" + WebAssets.Dir);
        var scratch = typeof(AppPaths).GetMethod("ScratchPathOf");
        string webview = scratch != null
            ? (string)scratch.Invoke(null, new object[] { "webview-strip" })!
            : AppPaths.PathOf("webview-strip");
        Directory.CreateDirectory(webview);
        Console.WriteLine("WEBVIEW=" + webview);
        return 0;
    }
}
CS
if [ -f "$H/ExtractedUi.cs" ]; then
  cat > "$H/UiHarness.cs" <<'CS'
using System.Globalization;
using System.Text.Json;

namespace BurnglassStrip;

// `transform <summary.json>` prints SummaryTransform.ToUi of the file;
// `tones <thresholds-json> <pct>...` prints the sanitized thresholds, then each
// pct's MeterScale.Tone; `used <used> <limit>` prints MeterScale.UsedPct.
static class UiHarness
{
    public static int Run(string[] args)
    {
        var inv = CultureInfo.InvariantCulture;
        if (args.Length >= 2 && args[0] == "transform")
        {
            Console.Write(SummaryTransform.ToUi(File.ReadAllText(args[1])));
            return 0;
        }
        if (args.Length >= 2 && args[0] == "tones")
        {
            using var doc = JsonDocument.Parse(args[1]);
            var th = MeterScale.Sanitize(doc.RootElement);
            Console.WriteLine("TH=" + string.Join(",", th.Select(t => t.ToString(inv))));
            foreach (var a in args.Skip(2))
                Console.WriteLine(a + "=" + MeterScale.Tone(double.Parse(a, inv), th));
            return 0;
        }
        if (args.Length >= 3 && args[0] == "used")
        {
            Console.WriteLine(MeterScale.UsedPct(double.Parse(args[1], inv), double.Parse(args[2], inv)));
            return 0;
        }
        // `linetone <thresholds-json> <progress-line-json>...` prints "<printed %>/<tone>" per line,
        // the tone as StripForm computes it (MeterScale.LinePct; by reflection, so an older tree
        // without it still compiles and reports NO-LINEPCT).
        if (args.Length >= 3 && args[0] == "linetone")
        {
            var linePct = typeof(MeterScale).GetMethod("LinePct");
            if (linePct == null) { Console.WriteLine("NO-LINEPCT"); return 0; }
            using var thDoc = JsonDocument.Parse(args[1]);
            var th = MeterScale.Sanitize(thDoc.RootElement);
            foreach (var a in args.Skip(2))
            {
                using var ld = JsonDocument.Parse(a);
                var l = ld.RootElement;
                double used = l.TryGetProperty("used", out var u) && u.TryGetDouble(out var uv) ? uv : 0;
                double limit = l.TryGetProperty("limit", out var li) && li.TryGetDouble(out var lv) && lv > 0 ? lv : 100;
                double raw = (double)linePct.Invoke(null, new object[] { l })!;
                Console.WriteLine(MeterScale.UsedPct(used, limit) + "/" + MeterScale.Tone(raw, th));
            }
            return 0;
        }
        Console.WriteLine("usage: transform <file> | tones <json> <pct>... | used <used> <limit> | linetone <json> <line>...");
        return 2;
    }
}
CS
fi
if ! DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 "$DOTNET" build "$H/harness.csproj" -c Release -o "$H/out" > "$H/build.log" 2>&1; then
  grep -E "error" "$H/build.log" | sed 's|^.*/harness/||' | sort -u | head -20
  fail "strip harness does not compile (see errors above)"
  exit 1
fi

# run <fake home> [VAR=value ...]: the harness with only these home variables.
run() {
  local home=$1; shift
  mkdir -p "$home.tmp"
  env -u BURNGLASS_HOME -u PULSE_HOME HOME="$home" USERPROFILE="$home" TMPDIR="$home.tmp" "$@" \
    "$DOTNET" "$H/out/harness.dll" > "$home.out" 2>&1
}
val() { sed -n "s/^$2=//p" "$1.out"; }
# A tree's full state: every entry's type + path, every file's bytes.
snap() { (cd "$1" && find . -printf '%y %p %l\n' | sort && find . -type f -print0 | sort -z | xargs -0 -r sha256sum); }
pulse_fixture() { # a Pulse 1.x home with a v1 strip's leftovers + something the user put there
  mkdir -p "$1/.pulse/strip-web/icons" "$1/.pulse/webview-strip/EBWebView"
  printf '{"strip":true}' > "$1/.pulse/config.json"
  printf 'PULSE-UI' > "$1/.pulse/strip-web/index.html"
  printf 'mine' > "$1/.pulse/strip-web/keep-me.txt"
  printf '<svg/>' > "$1/.pulse/strip-web/icons/old.svg"
  printf 'cache' > "$1/.pulse/webview-strip/EBWebView/cache.bin"
}
# legacy_case <name> <home> [VAR=value ...]: nothing under ~/.pulse may change.
legacy_case() {
  local name=$1 home=$2; shift 2
  local before; before=$(snap "$home/.pulse")
  run "$home" "$@"
  local after; after=$(snap "$home/.pulse")
  # Physical paths: a folder reached through a link to ~/.pulse IS ~/.pulse.
  local legacy; legacy=$(readlink -f "$home/.pulse")
  local dir; dir=$(val "$home" DIR); [ -n "$dir" ] && dir=$(readlink -f "$dir")
  local wv; wv=$(val "$home" WEBVIEW); [ -n "$wv" ] && wv=$(readlink -f "$wv")
  if [ "$before" = "$after" ]; then pass "$name: nothing under ~/.pulse deleted or rewritten"
  else fail "$name: ~/.pulse changed:"; diff <(echo "$before") <(echo "$after") | head -8; fi
  [ -f "$home/.pulse/strip-web/keep-me.txt" ] || fail "$name: ~/.pulse/strip-web/keep-me.txt was deleted"
  case "$dir" in
    "$legacy"*|"") fail "$name: popover UI extracted into ~/.pulse ($dir)" ;;
    *) if [ "$(cat "$dir/index.html" 2>/dev/null)" = HARNESS-UI-2 ]; then pass "$name: popover UI extracted outside ~/.pulse ($dir)"
       else fail "$name: no usable popover UI at $dir"; fi ;;
  esac
  case "$wv" in
    "$legacy"*|"") fail "$name: WebView2 profile folder under ~/.pulse ($wv)" ;;
    *) pass "$name: WebView2 profile folder outside ~/.pulse" ;;
  esac
}

# S1 - the review finding: the migration failed (~/.burnglass is a FILE), so
# the server runs on ~/.pulse and launches the strip with BURNGLASS_HOME=~/.pulse.
S=$T/s1; pulse_fixture "$S"; printf 'not a folder' > "$S/.burnglass"
legacy_case "failed migration, BURNGLASS_HOME=~/.pulse" "$S" BURNGLASS_HOME="$S/.pulse"
# S2 - the alias variable, spelled with a trailing slash.
S=$T/s2; pulse_fixture "$S"
legacy_case "PULSE_HOME=~/.pulse/" "$S" PULSE_HOME="$S/.pulse/"
# S3 - no variable, only ~/.pulse exists (before the server's first v2 start).
S=$T/s3; pulse_fixture "$S"
legacy_case "pre-migration, no home variable" "$S"
[ -e "$S/.burnglass" ] && fail "pre-migration: the strip created ~/.burnglass (would block the migration)" \
  || pass "pre-migration: ~/.burnglass not created"
# S4 - the pinned home is a LINK to ~/.pulse.
S=$T/s4; pulse_fixture "$S"; ln -s "$S/.pulse" "$S/pulse-link"
legacy_case "BURNGLASS_HOME = a link to ~/.pulse" "$S" BURNGLASS_HOME="$S/pulse-link"
# S5 - ~/.burnglass is a link to ~/.pulse (one folder under two names).
S=$T/s5; pulse_fixture "$S"; ln -s "$S/.pulse" "$S/.burnglass"
# shellcheck disable=SC2088 # a test label, not a path
legacy_case "~/.burnglass is a link to ~/.pulse" "$S"

# S6 - the normal v2 home, whose strip-web the strip did NOT create (no
# manifest): written into, never cleaned.
S=$T/s6; mkdir -p "$S/.burnglass/strip-web"; pulse_fixture "$S"
printf 'OLD-UI' > "$S/.burnglass/strip-web/index.html"
printf 'user note' > "$S/.burnglass/strip-web/user-note.txt"
before=$(snap "$S/.pulse")
run "$S"
[ "$(val "$S" DIR)" = "$S/.burnglass/strip-web" ] && pass "v2 home: UI extracted to ~/.burnglass/strip-web" \
  || fail "v2 home: UI extracted to $(val "$S" DIR)"
[ "$(cat "$S/.burnglass/strip-web/index.html")" = HARNESS-UI-2 ] && pass "v2 home: index.html current" \
  || fail "v2 home: index.html not rewritten"
[ "$(cat "$S/.burnglass/strip-web/user-note.txt" 2>/dev/null)" = 'user note' ] \
  && pass "v2 home: a file the strip did not write survives (no recursive delete)" \
  || fail "v2 home: user-note.txt the strip never wrote was deleted"
M=$S/.burnglass/strip-web/.burnglass-strip-web
if [ -f "$M" ] && [ "$(head -1 "$M")" = 'BURNGLASS-STRIP-WEB 1' ] && grep -qx 'index.html' "$M" \
   && grep -qx 'icons/claude.svg' "$M" && ! grep -q 'user-note' "$M"; then
  pass "v2 home: manifest lists exactly the files the strip wrote"
else fail "v2 home: manifest missing or wrong: $(tr '\n' '|' 2>/dev/null < "$M")"; fi
[ "$before" = "$(snap "$S/.pulse")" ] && pass "v2 home: ~/.pulse untouched" || fail "v2 home: ~/.pulse changed"

# S7 - the next launch after an update: only manifest-listed files the build
# no longer ships are removed; nothing the manifest points outside the folder,
# through a link, or never listed.
W=$S/.burnglass/strip-web
printf 'stale' > "$W/old-asset.js"; printf '<svg/>' > "$W/icons/gone.svg"
mkdir -p "$S/elsewhere"; printf 'x' > "$S/elsewhere/x.txt"; ln -s "$S/elsewhere" "$W/linked"
printf 'outside' > "$S/.burnglass/outside.txt"; printf 'victim' > "$S/victim.txt"
if [ -f "$M" ]; then
  printf '%s\n' old-asset.js icons/gone.svg ../outside.txt "$S/victim.txt" 'icons/../../victim.txt' linked/x.txt >> "$M"
else
  printf '%s\n' 'BURNGLASS-STRIP-WEB 1' index.html icons/claude.svg old-asset.js icons/gone.svg ../outside.txt \
    "$S/victim.txt" 'icons/../../victim.txt' linked/x.txt > "$M"
fi
run "$S"
[ ! -e "$W/old-asset.js" ] && [ ! -e "$W/icons/gone.svg" ] \
  && pass "update: files an older build shipped (listed) are removed" \
  || fail "update: stale listed files still there"
[ -f "$W/user-note.txt" ] && [ -f "$W/index.html" ] && [ -f "$W/icons/claude.svg" ] \
  && pass "update: unlisted and still-shipped files kept" || fail "update: a kept file is gone"
[ -f "$S/.burnglass/outside.txt" ] && [ -f "$S/victim.txt" ] && [ -f "$S/elsewhere/x.txt" ] \
  && pass "update: manifest entries outside the folder or through a link never delete" \
  || fail "update: a manifest entry deleted something outside strip-web"
! grep -q 'old-asset\|outside\|victim\|linked' "$M" 2>/dev/null \
  && pass "update: manifest rewritten without the removed/rejected entries" \
  || fail "update: manifest still lists: $(tr '\n' '|' 2>/dev/null < "$M")"

# S8 - a fresh machine: the extracted UI simply lands in ~/.burnglass.
S=$T/s8; mkdir -p "$S"
run "$S"
[ "$(cat "$S/.burnglass/strip-web/index.html" 2>/dev/null)" = HARNESS-UI-2 ] && [ ! -e "$S/.pulse" ] \
  && pass "fresh machine: UI in ~/.burnglass/strip-web, no ~/.pulse created" \
  || fail "fresh machine: DIR=$(val "$S" DIR)"

# ---------------------------------------------------------------------------
echo "--- strip popover payload (SummaryTransform + MeterScale from $STRIP_DIR/Program.cs)"
ui() { "$DOTNET" "$H/out/harness.dll" "$@"; }
if [ ! -f "$H/ExtractedUi.cs" ]; then
  fail "no MeterScale + SummaryTransform in $STRIP_DIR/Program.cs (popover payload unchecked)"
else
  # A: the dashboard's data as /api/summary carries it. 9 daily buckets (the
  # last is today), 8 listed sources + one ("stray") only in the daily data.
  cat > "$T/summary-a.json" <<'JSON'
{
  "allSources": ["claude-desktop", "cli", "codex", "continue", "foreman", "gemini", "roo", "zed"],
  "sourceMeta": { "foreman": { "label": "FOREMAN" }, "zed": {} },
  "alertThresholds": [95, 0, 150, "x", 70.5, -3],
  "periods": [
    { "key": "today", "bySource": { "codex": { "cost": 999 } } },
    { "key": "last30",
      "bySource": {
        "claude-desktop": { "cost": 2178.09, "tokens": 1200000 }, "cli": { "cost": 0, "tokens": 0 },
        "codex": { "cost": 3.45, "tokens": 90000 }, "continue": { "cost": 1.5, "tokens": 10 },
        "foreman": { "cost": 0, "tokens": 0 }, "gemini": { "cost": 0.25, "tokens": 10 },
        "roo": { "cost": 0.75, "tokens": 10 }, "zed": { "cost": 0, "tokens": 0 } },
      "daily": [
        { "date": "2026-09-17", "bySource": { "claude-desktop": 100, "continue": 1.5 } },
        { "date": "2026-09-18", "bySource": { "claude-desktop": 200, "roo": 0.75 } },
        { "date": "2026-09-19", "bySource": { "claude-desktop": 300 } },
        { "date": "2026-09-20", "bySource": { "claude-desktop": 400 } },
        { "date": "2026-09-21", "bySource": { "claude-desktop": 500 } },
        { "date": "2026-09-22", "bySource": { "claude-desktop": 600 } },
        { "date": "2026-09-23", "bySource": { "claude-desktop": 50.09, "codex": 1 } },
        { "date": "2026-09-24", "bySource": { "claude-desktop": 20, "codex": 2 } },
        { "date": "2026-09-25", "bySource": { "claude-desktop": 8, "codex": 0.45, "gemini": 0.25, "stray": 0.1 } }
      ] }
  ],
  "meters": { "enabled": true, "status": "ok", "buckets": [
    { "key": "five_hour", "label": "Claude · 5-hour session", "pct": 70.5, "resetsAt": 4102444800000, "projLeftAtReset": 12.4 },
    { "key": "seven_day", "label": "Claude · weekly", "pct": 36, "resetsAt": 4102444800000, "projLeftAtReset": null },
    { "key": "iguana_necktie", "label": "Claude · iguana necktie", "pct": 100, "resetsAt": 4102444800000 },
    { "key": "model_scoped:fable", "label": "Claude · weekly · Fable", "pct": 0, "resetsAt": 4102444800000 } ] },
  "codexMeters": { "buckets": [
    { "key": "codex_secondary", "label": "Codex · weekly", "pct": 11, "resetsAt": 4102444800000 },
    { "key": "codex_primary", "label": "Codex · session (5h)", "pct": 50, "stale": true } ] }
}
JSON
  # D: the review findings - five_hour 79.5 / weekly 94.5 (print 80 / 95, but
  # the dashboard's tone is plain / warn), a stale (rolled-over) scoped Claude
  # window, and an amount whose sub-cent part rounds down (12.344996 -> $12.34).
  cat > "$T/summary-d.json" <<'JSON'
{
  "allSources": ["cli"],
  "alertThresholds": [80, 95],
  "periods": [
    { "key": "last30", "bySource": { "cli": { "cost": 12.344996, "tokens": 1000 } },
      "daily": [ { "date": "2026-09-25", "bySource": { "cli": 12.344996 } } ] }
  ],
  "meters": { "enabled": true, "status": "rate-limited", "buckets": [
    { "key": "five_hour", "label": "Claude · 5-hour session", "pct": 79.5, "resetsAt": 4102444800000, "stale": false },
    { "key": "seven_day", "label": "Claude · weekly (all models)", "pct": 94.5, "resetsAt": 4102444800000, "stale": false },
    { "key": "model_scoped:fable", "label": "Claude · weekly · Fable", "pct": 97, "resetsAt": 1000, "stale": true } ] }
}
JSON
  # E: a restart with an expired login whose only restored window has rolled
  # over: no usable Claude meter -> the sign-in card, as before the restore.
  printf '%s' '{"periods":[{"key":"last30","bySource":{},"daily":[]}],"meters":{"enabled":true,"status":"expired","buckets":[{"key":"five_hour","label":"Claude · 5-hour session","pct":97,"resetsAt":1000,"stale":true}]}}' > "$T/summary-e.json"
  ui transform "$T/summary-d.json" > "$T/ui-d.json" 2>&1
  ui transform "$T/summary-e.json" > "$T/ui-e.json" 2>&1
  # B: an older server - no allSources / sourceMeta / alertThresholds.
  printf '%s' '{"periods":[{"key":"last30","bySource":{"b":{"cost":1},"a":{"cost":2},"B":{"cost":3}},"daily":[]}],"alertThresholds":"80"}' > "$T/summary-b.json"
  printf '%s' 'not json' > "$T/summary-c.json"
  ui transform "$T/summary-a.json" > "$T/ui-a.json" 2>&1
  ui transform "$T/summary-b.json" > "$T/ui-b.json" 2>&1
  ui transform "$T/summary-c.json" > "$T/ui-c.json" 2>&1
  node - "$T" <<'JS' || FAILS=$((FAILS + 1))
const fs = require('fs'), path = require('path');
const T = process.argv[2];
let bad = 0;
const says = (c, m) => { console.log((c ? 'PASS: ' : 'FAIL: ') + m); if (!c) bad++; };
const read = (n) => { try { return JSON.parse(fs.readFileSync(path.join(T, n), 'utf8')); } catch (e) { return { __err: String(e) }; } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// web/src/styles.css dark --s1..--s6, in order.
const S = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'];

const a = read('ui-a.json');
const src = a.sources || [];
says(eq(src.map((s) => s.id), ['claude-desktop', 'cli', 'codex', 'continue', 'foreman', 'gemini', 'roo', 'zed', 'stray']),
  'sources: allSources order, then an unlisted source that has spend (got ' + src.map((s) => s.id).join(',') + ')');
says(eq(src.map((s) => s.color), [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => S[i % 6])),
  'sources: colour = the dashboard series (--s1..--s6) by allSources position, wrapping at 6');
says(eq(src.map((s) => s.label), ['Claude Desktop', 'Claude CLI', 'Codex', 'Continue', 'FOREMAN', 'Gemini CLI', 'Roo Code', 'zed', 'stray']),
  'sources: labels = sourceMeta label > built-in label > raw key (got ' + src.map((s) => s.label).join(' | ') + ')');
const by = Object.fromEntries(src.map((s) => [s.id, s]));
const amt = (id) => by[id] ? [by[id].today, by[id].week7, by[id].cost30] : null;
// Amounts are raw sums now (no 4-decimal round), so compare to 1e-9.
const near = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => typeof x === 'number' && Math.abs(x - b[i]) < 1e-9);
says(near(amt('claude-desktop'), [8, 1878.09, 2178.09]), 'sources: claude-desktop today / 7 calendar days / 30d = ' + JSON.stringify(amt('claude-desktop')));
says(near(amt('codex'), [0.45, 3.45, 3.45]), 'sources: codex amounts = ' + JSON.stringify(amt('codex')));
says(near(amt('roo'), [0, 0, 0.75]) && near(amt('continue'), [0, 0, 1.5]), 'sources: spend outside the last 7 daily buckets counts only toward 30d');
says(near(amt('cli'), [0, 0, 0]) && near(amt('foreman'), [0, 0, 0]), 'sources: zero-spend sources keep their row (and colour slot)');
says(near(amt('stray'), [0.1, 0.1, 0]), 'sources: a daily-only source gets today/7d from the daily buckets');
says(eq(a.thresholds, [70.5, 95]), 'thresholds: alertThresholds sanitized to (0,100] ascending (got ' + JSON.stringify(a.thresholds) + ')');
const prov = (a.providers || []).map((p) => p.providerId);
says(prov[0] === 'claude' && prov[1] === 'codex', 'providers: Claude + Codex sections unchanged (got ' + prov.join(',') + ')');
const cl = ((a.providers || [])[0] || {}).lines || [];
const meters = cl.filter((l) => l.type === 'progress');
says(eq(meters.map((m) => [m.label, m.used]), [['Session', 71], ['Weekly', 36], ['Iguana necktie', 100], ['Fable', 0]]),
  'claude meters: labels + used % (70.5 rounds up like the dashboard) = ' + JSON.stringify(meters.map((m) => [m.label, m.used])));
says(meters[0] && meters[0].projected === 88 && meters.slice(1).every((m) => !('projected' in m)),
  'claude meters: projLeftAtReset 12.4 -> projected 88% used at reset; absent/null -> no projected');
const cx = (((a.providers || [])[1] || {}).lines || []).filter((l) => l.type === 'progress');
says(eq(cx.map((m) => [m.label, m.used]), [['Weekly', 11]]), 'codex meters: stale window dropped, weekly 11% used');
says(meters[0] && meters[0].pct === 70.5 && meters[1] && meters[1].pct === 36, 'claude meters: "pct" carries the unrounded % used (70.5 printed as 71)');

const d = read('ui-d.json');
const dcl = ((d.providers || []).find((p) => p.providerId === 'claude') || {}).lines || [];
const dm = dcl.filter((l) => l.type === 'progress');
says(eq(dm.map((m) => [m.label, m.used, m.pct]), [['Session', 80, 79.5], ['Weekly', 95, 94.5]]),
  'review D: a stale (rolled-over) Claude window is dropped; 79.5 / 94.5 print 80 / 95 and keep pct = ' + JSON.stringify(dm.map((m) => [m.label, m.used, m.pct])));
const dcli = (d.sources || []).find((x) => x.id === 'cli') || {};
says(dcli.today === 12.344996 && dcli.week7 === 12.344996 && dcli.cost30 === 12.344996,
  'review D: source amounts are not pre-rounded (12.344996, not 12.345) = ' + JSON.stringify([dcli.today, dcli.week7, dcli.cost30]));
says(dcl.some((l) => l.label === 'Today' && l.value === '$12.34'), 'review D: the Claude card prints $12.34 for the same amount');
const e = read('ui-e.json');
says(!((e.providers || []).some((p) => p.providerId === 'claude')) && (e.errors || []).some((x) => x.providerId === 'claude' && /sign in/i.test(x.message)),
  'review E: expired login + only a rolled-over Claude window -> no bars, the sign-in card (got ' + JSON.stringify({ p: (e.providers || []).map((p) => p.providerId), e: e.errors }) + ')');

const b = read('ui-b.json');
says(eq((b.sources || []).map((s) => [s.id, s.label, s.color]), [['B', 'B', S[0]], ['a', 'a', S[1]], ['b', 'b', S[2]]]),
  'older server (no allSources): period sources, ordinal-sorted like a JS sort(), raw labels');
says(eq(b.thresholds, [80, 95]), 'older server (no / malformed alertThresholds): default thresholds [80,95]');
const c = read('ui-c.json');
says(eq(c, { providers: [], errors: [] }), 'unparseable summary: the empty wrapper, no throw');
process.exit(bad ? 1 : 0);
JS
  out=$(ui tones '[80,95]' 0 79 79.99 80 94.9 95 100 | tr '\n' ' ')
  [ "$out" = "TH=80,95 0=0 79=0 79.99=0 80=1 94.9=1 95=2 100=2 " ] \
    && pass "tones: plain < 80 <= warn < 95 <= crit (lib.js meterTone)" || fail "tones [80,95]: $out"
  out=$(ui tones '[90]' 89 90 100 | tr '\n' ' ')
  [ "$out" = "TH=90 89=0 90=1 100=1 " ] && pass "tones: a single threshold only ever warns" || fail "tones [90]: $out"
  out=$(ui tones '[95,"x",null,0,101,60]' 59 60 95 | tr '\n' ' ')
  [ "$out" = "TH=60,95 59=0 60=1 95=2 " ] && pass "tones: thresholds filtered to (0,100] and sorted" || fail "tones mixed: $out"
  out=$(ui tones '{}' 80 95 | tr '\n' ' ')
  [ "$out" = "TH=80,95 80=1 95=2 " ] && pass "tones: no thresholds -> 80/95" || fail "tones {}: $out"
  out="$(ui used 70.5 100) $(ui used 0.5 1) $(ui used 150 100) $(ui used -5 100) $(ui used 5 0)"
  [ "$out" = "71 50 100 0 0" ] && pass "used %: rounds halves up, clamps 0..100, limit 0 -> 0" || fail "used %: $out"
  # The taskbar tone (StripForm): from the line's unrounded "pct", not the printed number;
  # a line without "pct" (a payload an older strip saved) falls back to used/limit.
  out=$(ui linetone '[80,95]' '{"used":80,"limit":100,"pct":79.5}' '{"used":95,"limit":100,"pct":94.5}' \
    '{"used":80,"limit":100,"pct":80}' '{"used":80,"limit":100}' '{"used":95,"limit":100,"pct":"x"}' | tr '\n' ' ')
  [ "$out" = "80/0 95/1 80/1 80/1 95/2 " ] \
    && pass "taskbar tone from the unrounded %: 79.5 prints 80 but stays plain, 94.5 prints 95 but stays amber (dashboard meterTone)" \
    || fail "taskbar tone: $out"

  # The popover page itself (strip/web/index.html) renders fixture D's payload.
  PWMOD=${PLAYWRIGHT_MODULE:-}
  [ -z "$PWMOD" ] && PWMOD=$(node -e 'try { console.log(require.resolve("playwright")) } catch (_) {}' 2>/dev/null)
  if [ -z "$PWMOD" ] && command -v npm >/dev/null 2>&1; then
    G=$(npm root -g 2>/dev/null); [ -n "$G" ] && [ -f "$G/playwright/index.js" ] && PWMOD="$G/playwright/index.js"
  fi
  CHROME=${PW_CHROMIUM:-}; [ -z "$CHROME" ] && [ -x /opt/pw-browsers/chromium ] && CHROME=/opt/pw-browsers/chromium
  if [ -z "$PWMOD" ]; then
    echo "SKIP: popover render (Playwright not found; set PLAYWRIGHT_MODULE)"
  else
    node --input-type=module - "$PWMOD" "$CHROME" "$STRIP_DIR/web/index.html" "$T/ui-d.json" <<'JS' || FAILS=$((FAILS + 1))
const [pwmod, chrome, page0, uiFile] = process.argv.slice(2);
const { pathToFileURL } = await import('node:url');
const fs = await import('node:fs');
const pw = await import(pathToFileURL(pwmod).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);
let bad = 0;
const says = (c, m) => { console.log((c ? 'PASS: ' : 'FAIL: ') + m); if (!c) bad++; };
let browser;
try { browser = await chromium.launch({ ...(chrome ? { executablePath: chrome } : {}), args: ['--no-sandbox'] }); }
catch (e) { console.log('SKIP: popover render (Chromium did not launch: ' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const page = await browser.newPage({ viewport: { width: 372, height: 900 }, colorScheme: 'dark' });
await page.addInitScript(() => { window.__NO_SAMPLE__ = true; });
await page.goto(pathToFileURL(page0).href);
await page.evaluate((p) => window.renderData(p), JSON.parse(fs.readFileSync(uiFile, 'utf8')));
const r = await page.evaluate(() => ({
  meters: [...document.querySelectorAll('.mrow')].map((m) => [m.querySelector('.title').textContent, m.querySelector('.head').textContent, m.querySelector('.head').className, m.querySelector('.meter').className]),
  legend: [...document.querySelectorAll('.legend .row')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()),
  center: (document.querySelector('.donut .center') || {}).textContent || null,
  today: [...document.querySelectorAll('.trow')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()).filter((t) => /^Today/.test(t)),
}));
says(JSON.stringify(r.meters) === JSON.stringify([['Session', '80% used', 'head', 'meter'], ['Weekly', '95% used', 'head warn', 'meter warn']]),
  'popover: 79.5% prints 80 and stays plain, 94.5% prints 95 and stays amber — as #mini shows them (' + JSON.stringify(r.meters) + ')');
says(r.legend.some((t) => /Claude CLI\s*\$12\.34$/.test(t)) && !r.legend.some((t) => /12\.35/.test(t)) && !/12\.35/.test(r.center || ''),
  'popover: the donut legend / centre say $12.34 like the Claude card and the dashboard (' + JSON.stringify({ legend: r.legend, center: r.center, today: r.today }) + ')');
await browser.close();
process.exit(bad ? 1 : 0);
JS
  fi
fi

[ $FAILS -eq 0 ] && echo "packaging: all passed" || echo "packaging: $FAILS failure(s)"
exit $((FAILS > 0))
