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
# Cut `static class AppPaths` and `static class WebAssets` out of the real
# Program.cs (brace matching that skips comments, strings and char literals).
if ! node - "$STRIP_DIR/Program.cs" "$H/Extracted.cs" <<'JS'
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
function cut(name) {
  const m = new RegExp('^static class ' + name + '\\b', 'm').exec(src);
  if (!m) throw new Error('no static class ' + name);
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
fs.writeFileSync(process.argv[3], 'namespace BurnglassStrip;\n\n' + cut('AppPaths') + '\n\n' + cut('WebAssets') + '\n');
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
static class Harness
{
    static int Main()
    {
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

[ $FAILS -eq 0 ] && echo "packaging: all passed" || echo "packaging: $FAILS failure(s)"
exit $((FAILS > 0))
