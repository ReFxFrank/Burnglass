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
#    Claude window dropped like a Codex one. The display currency
#    (DisplayCurrency, also compiled from Program.cs): no summary "currency"
#    block = the dollar strings as before; EUR / JPY (0 digits) / CHF blocks
#    convert every card line, chart point and source amount and are echoed as
#    {code, prefix, digits}; the taskbar price (StripForm's parse + compact) in
#    the same currency; hostile blocks fall back to dollars. With Playwright + Chromium the
#    popover page (strip/web/index.html) then renders that payload (else SKIP)
#    and plays its open motion: primeOpen holds the first frame and posts
#    {primed}, playOpen / a lost playOpen / resetOpen / reduced motion all end
#    fully visible, fresh data mid-open never fades in twice, fills are
#    backwards-only, and the host's window-slide curve (OpenMotion, compiled
#    from Program.cs) equals the page's --ease-decel as Chromium evaluates it.
#    The popover's click-away rules (PopoverDismiss, compiled from Program.cs)
#    are played against open timelines wired like PopoverForm: a click on
#    another app closes it however soon after the reveal it comes (the 250 ms
#    guard counts from Show, and a held-back click-away is closed by the focus
#    poll once the rise is over), while no click-away, or our own strip/menu
#    taking the foreground, never closes it.
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
# Cut `static class AppPaths` and `WebAssets` (required), plus `MeterScale`,
# `DisplayCurrency` and `SummaryTransform` (the popover payload; optional, so
# STRIP_DIR can still point at an older tree for the home checks) out of the
# real Program.cs (brace matching that skips comments, strings and char literals).
if ! node - "$STRIP_DIR/Program.cs" "$H" <<'JS'
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(process.argv[2], 'utf8');
function cut(name, optional) {
  const m = new RegExp('^(?:static |sealed )?class ' + name + '\\b', 'm').exec(src);
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
// The display currency (the transform converts with it, StripForm prices with it); a tree before it
// has none, and its transform does not reference it.
const dc = cut('DisplayCurrency', true);
if (ms && st) fs.writeFileSync(path.join(process.argv[3], 'ExtractedUi.cs'), head + ms + '\n\n' + (dc ? dc + '\n\n' : '') + st + '\n');
// The popover's open-motion curve (the host's window slide); optional like the above.
const om = cut('OpenMotion', true);
if (om) fs.writeFileSync(path.join(process.argv[3], 'ExtractedMotion.cs'), head + om + '\n');
// The popover's click-away rules (PopoverForm's Deactivate + WatchFocus); optional like the above.
const pd = cut('PopoverDismiss', true);
if (pd) fs.writeFileSync(path.join(process.argv[3], 'ExtractedDismiss.cs'), head + pd + '\n');
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
        // `ease <t>...` prints OpenMotion.Ease(t) per t (the popover window's slide curve; by
        // reflection, so a tree without it still compiles and reports NO-MOTION).
        if (args.Length >= 2 && args[0] == "ease")
        {
            var ease = Type.GetType("BurnglassStrip.OpenMotion")?.GetMethod("Ease");
            if (ease == null) { Console.WriteLine("NO-MOTION"); return 0; }
            foreach (var a in args.Skip(1))
                Console.WriteLine(a + "=" + ((double)ease.Invoke(null, new object[] { double.Parse(a, inv) })!).ToString("R", inv));
            return 0;
        }
        // `money <currency-json> <n>...` prints "<n>=<Compact>|<Exact>" per n under
        // DisplayCurrency.FromUi(json) (the taskbar price / an exact amount). `stripprice <ui-file>`
        // prints "<providerId>=<price>" per provider of a UI payload the way StripForm.SetData builds
        // the taskbar price: the payload currency echo (FromUi), the "Last 30 Days" line amount
        // (ParseAmount), compact (Compact) when > 0. By reflection, so a tree without
        // DisplayCurrency still compiles and reports NO-CURRENCY.
        if (args.Length >= 2 && (args[0] == "money" || args[0] == "stripprice"))
        {
            var dc = Type.GetType("BurnglassStrip.DisplayCurrency");
            if (dc == null) { Console.WriteLine("NO-CURRENCY"); return 0; }
            var fromUi = dc.GetMethod("FromUi")!;
            var compact = dc.GetMethod("Compact")!;
            var parse = dc.GetMethod("ParseAmount")!;
            if (args[0] == "money")
            {
                var exact = dc.GetMethod("Exact")!;
                using var cdoc = JsonDocument.Parse(args[1]);
                var cur = fromUi.Invoke(null, new object[] { cdoc.RootElement })!;
                foreach (var a in args.Skip(2))
                {
                    double n = double.Parse(a, inv);
                    Console.WriteLine(a + "=" + compact.Invoke(cur, new object[] { n }) + "|" + exact.Invoke(cur, new object[] { n }));
                }
                return 0;
            }
            using var udoc = JsonDocument.Parse(File.ReadAllText(args[1]));
            var root = udoc.RootElement;
            bool wrapped = root.ValueKind == JsonValueKind.Object;
            var echo = wrapped && root.TryGetProperty("currency", out var cu) ? cu : default;
            var sc = fromUi.Invoke(null, new object[] { echo })!;
            var provs = wrapped && root.TryGetProperty("providers", out var pv) ? pv : root;
            if (provs.ValueKind == JsonValueKind.Array)
                foreach (var p in provs.EnumerateArray())
                {
                    string id = p.TryGetProperty("providerId", out var pid) ? pid.GetString() ?? "" : "";
                    double? spend30 = null;
                    if (p.TryGetProperty("lines", out var lines))
                        foreach (var l in lines.EnumerateArray())
                            if (l.TryGetProperty("type", out var t) && t.GetString() == "text"
                                && l.TryGetProperty("label", out var lab) && lab.GetString() == "Last 30 Days"
                                && l.TryGetProperty("value", out var val))
                                spend30 = (double?)parse.Invoke(sc, new object?[] { val.GetString() });
                    Console.WriteLine(id + "=" + (spend30 is > 0 ? (string)compact.Invoke(sc, new object[] { spend30.Value })! : ""));
                }
            return 0;
        }
        // `dismiss <case>...`: DismissHarness (compiled only when Program.cs has PopoverDismiss).
        if (args.Length >= 2 && args[0] == "dismiss")
        {
            var dh = Type.GetType("BurnglassStrip.DismissHarness");
            if (dh == null) { Console.WriteLine("NO-DISMISS"); return 0; }
            return (int)dh.GetMethod("Run")!.Invoke(null, new object[] { args })!;
        }
        Console.WriteLine("usage: transform <file> | tones <json> <pct>... | used <used> <limit> | linetone <json> <line>... | money <json> <n>... | stripprice <file> | ease <t>... | dismiss <case>...");
        return 2;
    }
}
CS
fi
if [ -f "$H/ExtractedDismiss.cs" ]; then
  cat > "$H/DismissHarness.cs" <<'CS'
using System.Globalization;

namespace BurnglassStrip;

// `dismiss <case>...` plays one popover open per case against PopoverDismiss, wired the way
// PopoverForm wires it, in 1 ms steps, and prints "<case>=closed@<ms>" or "<case>=open" (5 s).
// Show at 0: the popover takes the foreground (refused=1: Windows refused it). The focus poll ticks
// every 250 ms from Show. Reveal at r (default 90): un-cloaked; when the popover is not the
// foreground it takes it back - and gets it unless the user has clicked elsewhere meanwhile. The
// rise lasts s ms (default 190; 0 = no motion). Then, at their times: a = the user clicks another
// application, own = our own other window (the strip's menu) takes the foreground, back = the user
// clicks the popover again. Leaving the popover fires a Deactivate unless nodeact=1 (the window
// never gets one: the focus poll alone must close it).
static class DismissHarness
{
    enum Fg { Self, Own, Other }

    public static int Run(string[] args)
    {
        foreach (var c in args.Skip(1)) Console.WriteLine(c + "=" + Play(c));
        return 0;
    }

    static string Play(string spec)
    {
        var kv = spec.Split(',', StringSplitOptions.RemoveEmptyEntries)
            .Select(p => p.Split('='))
            .ToDictionary(p => p[0], p => int.Parse(p[1], CultureInfo.InvariantCulture));
        int Get(string k, int d) => kv.TryGetValue(k, out var v) ? v : d;
        int reveal = Get("r", 90), rise = Get("s", 190), away = Get("a", -1), own = Get("own", -1), back = Get("back", -1);
        bool refused = Get("refused", 0) == 1, noDeact = Get("nodeact", 0) == 1;

        var d = new PopoverDismiss();
        d.Shown(0);
        var fg = refused ? Fg.Other : Fg.Self;
        bool revealed = false, opening = true, clickedAway = false;
        for (int t = 0; t <= 5000; t++)
        {
            if (t == reveal)
            {
                revealed = true;
                if (d.Revealed(t, fg == Fg.Self) && !clickedAway) fg = Fg.Self;
                if (rise <= 0) opening = false;
            }
            if (rise > 0 && t == reveal + rise) opening = false;
            Fg? to = t == away ? Fg.Other : t == own ? Fg.Own : t == back ? Fg.Self : null;
            if (to != null)
            {
                if (to == Fg.Other) clickedAway = true;
                bool left = fg == Fg.Self && to != Fg.Self;
                fg = to.Value;
                if (left && !noDeact && d.Deactivated(t, revealed)) return "closed@" + t;
            }
            if (t > 0 && t % 250 == 0 && d.Poll(revealed && !opening, fg == Fg.Self, fg == Fg.Own)) return "closed@" + t;
        }
        return "open";
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

  # F: the display currency. Every /api/summary amount is USD; a "currency" block
  # {code, rate, prefix, digits, ...} makes the transform convert (x rate) and
  # format (prefix, digits) every amount it emits, and echo {code, prefix, digits}.
  # The same data without a block, with an explicit USD one, in EUR at 0.5, in
  # JPY at 150 (0 digits), in CHF (a letter prefix) and under hostile blocks,
  # which must fall back to US dollars (or, for bad digits, to 2 digits).
  cat > "$T/summary-f.json" <<'JSON'
{
  "allSources": ["cli", "codex", "gemini"],
  "alertThresholds": [80, 95],
  "periods": [
    { "key": "last30",
      "bySource": { "cli": { "cost": 4357, "tokens": 2500000 }, "codex": { "cost": 7.2, "tokens": 1000 },
        "gemini": { "cost": 0.012, "tokens": 10 } },
      "daily": [
        { "date": "2026-09-24", "bySource": { "cli": 4000, "codex": 3 } },
        { "date": "2026-09-25", "bySource": { "cli": 357, "codex": 4.2, "gemini": 0.012 } } ] }
  ]
}
JSON
  node - "$T" <<'JS'
const fs = require('fs'), path = require('path');
const T = process.argv[2];
const base = JSON.parse(fs.readFileSync(path.join(T, 'summary-f.json'), 'utf8'));
const eur = { code: 'EUR', rate: 0.5, prefix: '€', symbol: '€', digits: 2, source: 'ecb', asOf: '2026-09-29', status: 'ok', requested: 'EUR' };
const V = {
  none: undefined,
  usd: { code: 'USD', rate: 1, prefix: '$', symbol: '$', digits: 2, source: 'usd', asOf: null, status: 'ok', requested: 'USD' },
  eur,
  jpy: { code: 'JPY', rate: 150, prefix: '¥', symbol: '¥', digits: 0, source: 'manual', asOf: null, status: 'ok', requested: 'JPY' },
  chf: { code: 'CHF', rate: 2, prefix: 'CHF ', symbol: 'CHF', digits: 2, source: 'ecb', asOf: '2026-09-29', status: 'ok', requested: 'CHF' },
  // Hostile blocks: US dollars.
  'rate-neg': { ...eur, rate: -1 }, 'rate-zero': { ...eur, rate: 0 }, 'rate-big': { ...eur, rate: 1e8 },
  'rate-str': { ...eur, rate: '0.5' }, 'rate-null': { ...eur, rate: null }, 'rate-none': { ...eur, rate: undefined },
  'prefix-ctrl': { ...eur, prefix: '€\u0007' }, 'prefix-long': { ...eur, prefix: 'ABCDEFGHI' },
  'prefix-bidi': { ...eur, prefix: '‮€' }, 'prefix-zw': { ...eur, prefix: '€​' },
  'prefix-empty': { ...eur, prefix: '' }, 'prefix-num': { ...eur, prefix: 5 }, 'prefix-lone': { ...eur, prefix: '€\ud800' },
  'not-object': 'EUR', array: [eur],
  // Bad digits alone: the currency stands, 2 digits. A bad code is dropped, not trusted.
  'digits-9': { ...eur, digits: 9 }, 'digits-frac': { ...eur, digits: 1.5 }, 'digits-neg': { ...eur, digits: -1 },
  'code-bad': { ...eur, code: '<b>' },
};
for (const [name, cur] of Object.entries(V)) {
  const s = JSON.parse(JSON.stringify(base));
  if (cur !== undefined) s.currency = cur;
  fs.writeFileSync(path.join(T, 'summary-f-' + name + '.json'), JSON.stringify(s));
}
JS
  for f in "$T"/summary-f-*.json; do
    n=${f##*/summary-f-}; n=${n%.json}
    ui transform "$f" > "$T/ui-f-$n.json" 2>&1
    ui stripprice "$T/ui-f-$n.json" > "$T/price-f-$n.txt" 2>&1
  done
  # Payloads an older strip saved (no currency echo, "$" lines) and a tampered echo.
  printf '%s' '{"providers":[{"providerId":"claude","lines":[{"label":"Last 30 Days","type":"text","value":"$2,263.58 · 1.2M tokens"}]}],"errors":[]}' > "$T/ui-legacy.json"
  printf '%s' '[{"providerId":"codex","lines":[{"label":"Last 30 Days","type":"text","value":"$12.00"}]}]' > "$T/ui-legacy-bare.json"
  printf '%s' '{"providers":[{"providerId":"claude","lines":[{"label":"Last 30 Days","type":"text","value":"$12.00 · 1 tokens"}]}],"currency":{"code":"EUR","prefix":"€","digits":2}}' > "$T/ui-mismatch.json"
  printf '%s' '{"providers":[{"providerId":"claude","lines":[{"label":"Last 30 Days","type":"text","value":"€12.00 · 1 tokens"}]}],"currency":{"code":"EUR","prefix":"€\u0007","digits":2}}' > "$T/ui-tampered.json"
  for n in legacy legacy-bare mismatch tampered; do ui stripprice "$T/ui-$n.json" > "$T/price-$n.txt" 2>&1; done
  node - "$T" <<'JS' || FAILS=$((FAILS + 1))
const fs = require('fs'), path = require('path');
const T = process.argv[2];
let bad = 0;
const says = (c, m) => { console.log((c ? 'PASS: ' : 'FAIL: ') + m); if (!c) bad++; };
const read = (n) => { try { return JSON.parse(fs.readFileSync(path.join(T, n), 'utf8')); } catch (e) { return { __err: String(e) }; } };
const lines = (n) => { try { return fs.readFileSync(path.join(T, n), 'utf8').trim().split('\n'); } catch (e) { return [String(e)]; } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => typeof x === 'number' && Math.abs(x - b[i]) < 1e-6);
// What the popover and the strip get from one UI payload.
const view = (name) => {
  const ui = read('ui-f-' + name + '.json');
  const prov = {};
  for (const p of ui.providers || []) {
    const ls = p.lines || [];
    prov[p.providerId] = {
      text: ls.filter((l) => l.type === 'text').map((l) => l.value),
      labels: ls.filter((l) => l.type === 'barChart').flatMap((l) => l.points.map((x) => x.valueLabel)),
      values: ls.filter((l) => l.type === 'barChart').flatMap((l) => l.points.map((x) => x.value)),
    };
  }
  const src = Object.fromEntries((ui.sources || []).map((s) => [s.id, [s.today, s.week7, s.cost30]]));
  return { ui, prov, src, currency: ui.currency, price: lines('price-f-' + name + '.txt') };
};
// fixture F: claude (cli) 4000 + 357 today, codex 3 + 4.2 today, gemini 0.012 today.
const WANT = {
  usd: { currency: { code: 'USD', prefix: '$', digits: 2 },
    text: { claude: ['$357.00', '$4,357.00', '$4,357.00 · 2.5M tokens'], codex: ['$4.20', '$7.20', '$7.20 · 1.0K tokens'], gemini: ['$0.01', '$0.01', '$0.01 · 10 tokens'] },
    labels: { claude: ['$4,000.00', '$357.00'], codex: ['$3.00', '$4.20'], gemini: ['$0.00', '$0.01'] },
    values: { claude: [4000, 357], codex: [3, 4.2], gemini: [0, 0.012] },
    src: { cli: [357, 4357, 4357], codex: [4.2, 7.2, 7.2], gemini: [0.012, 0.012, 0.012] },
    price: ['claude=$4.4K', 'codex=$7', 'gemini=$0'] },
  eur: { currency: { code: 'EUR', prefix: '€', digits: 2 },
    text: { claude: ['€178.50', '€2,178.50', '€2,178.50 · 2.5M tokens'], codex: ['€2.10', '€3.60', '€3.60 · 1.0K tokens'], gemini: ['€0.01', '€0.01', '€0.01 · 10 tokens'] },
    labels: { claude: ['€2,000.00', '€178.50'], codex: ['€1.50', '€2.10'], gemini: ['€0.00', '€0.01'] },
    values: { claude: [2000, 178.5], codex: [1.5, 2.1], gemini: [0, 0.006] },
    src: { cli: [178.5, 2178.5, 2178.5], codex: [2.1, 3.6, 3.6], gemini: [0.006, 0.006, 0.006] },
    price: ['claude=€2.2K', 'codex=€4', 'gemini=€0'] },
  jpy: { currency: { code: 'JPY', prefix: '¥', digits: 0 },
    text: { claude: ['¥53,550', '¥653,550', '¥653,550 · 2.5M tokens'], codex: ['¥630', '¥1,080', '¥1,080 · 1.0K tokens'], gemini: ['¥2', '¥2', '¥2 · 10 tokens'] },
    labels: { claude: ['¥600,000', '¥53,550'], codex: ['¥450', '¥630'], gemini: ['¥0', '¥2'] },
    values: { claude: [600000, 53550], codex: [450, 630], gemini: [0, 1.8] },
    src: { cli: [53550, 653550, 653550], codex: [630, 1080, 1080], gemini: [1.8, 1.8, 1.8] },
    price: ['claude=¥654K', 'codex=¥1.1K', 'gemini=¥2'] },
  chf: { currency: { code: 'CHF', prefix: 'CHF ', digits: 2 },
    text: { claude: ['CHF 714.00', 'CHF 8,714.00', 'CHF 8,714.00 · 2.5M tokens'], codex: ['CHF 8.40', 'CHF 14.40', 'CHF 14.40 · 1.0K tokens'], gemini: ['CHF 0.02', 'CHF 0.02', 'CHF 0.02 · 10 tokens'] },
    labels: { claude: ['CHF 8,000.00', 'CHF 714.00'], codex: ['CHF 6.00', 'CHF 8.40'], gemini: ['CHF 0.00', 'CHF 0.02'] },
    values: { claude: [8000, 714], codex: [6, 8.4], gemini: [0, 0.024] },
    src: { cli: [714, 8714, 8714], codex: [8.4, 14.4, 14.4], gemini: [0.024, 0.024, 0.024] },
    price: ['claude=CHF 8.7K', 'codex=CHF 14', 'gemini=CHF 0'] },
};
const IDS = ['claude', 'codex', 'gemini'];
const got = (v, k) => JSON.stringify(Object.fromEntries(IDS.map((id) => [id, v.prov[id] ? v.prov[id][k] : null])));
// One aspect per line for the real currencies; everything at once for a variant that must equal one.
function full(name, want, why) {
  const v = view(name);
  const text = IDS.every((id) => v.prov[id] && eq(v.prov[id].text, want.text[id]));
  const labels = IDS.every((id) => v.prov[id] && eq(v.prov[id].labels, want.labels[id]));
  const values = IDS.every((id) => v.prov[id] && near(v.prov[id].values, want.values[id]));
  const src = Object.keys(want.src).every((id) => near(v.src[id], want.src[id]));
  const cur = eq(v.currency, want.currency), price = eq(v.price, want.price);
  if (why) {
    says(text && labels && values && src && cur && price, why + ' (' + JSON.stringify({ currency: v.currency, claude: v.prov.claude && v.prov.claude.text, price: v.price }) + ')');
    return;
  }
  says(text, name + ': provider card lines = ' + got(v, 'text'));
  says(labels && values, name + ': daily chart points (value, valueLabel) = ' + got(v, 'values') + ' ' + got(v, 'labels'));
  says(src, name + ': sources amounts (today, 7d, 30d; raw, converted) = ' + JSON.stringify(v.src));
  says(cur, name + ': the payload carries currency ' + JSON.stringify(v.currency));
  says(price, name + ': the taskbar price (StripForm: Last 30 Days amount, compact) = ' + v.price.join(' '));
}
full('none', WANT.usd);
const noFetched = (n) => { try { return fs.readFileSync(path.join(T, n), 'utf8').replace(/"fetchedAt":"[^"]*"/g, ''); } catch (e) { return String(e); } };
says(noFetched('ui-f-none.json') === noFetched('ui-f-usd.json'),
  'usd: an explicit USD block (rate 1) yields exactly the payload of a summary without one');
full('eur', WANT.eur);
full('jpy', WANT.jpy);
const jv = view('jpy');
says(IDS.every((id) => jv.prov[id] && jv.prov[id].text.concat(jv.prov[id].labels).every((t) => /^¥[\d,]+( · |$)/.test(t))),
  'jpy: 0 digits - no decimals in any amount');
full('chf', WANT.chf);
for (const n of ['rate-neg', 'rate-zero', 'rate-big', 'rate-str', 'rate-null', 'rate-none', 'prefix-ctrl', 'prefix-long',
  'prefix-bidi', 'prefix-zw', 'prefix-empty', 'prefix-num', 'prefix-lone', 'not-object', 'array'])
  full(n, WANT.usd, 'hostile currency ' + n + ' -> US dollars, amounts unconverted');
for (const n of ['digits-9', 'digits-frac', 'digits-neg'])
  full(n, WANT.eur, 'hostile currency ' + n + ' -> the currency stands with 2 digits');
full('code-bad', { ...WANT.eur, currency: { code: '', prefix: '€', digits: 2 } }, 'currency code "<b>" is dropped (""), the amounts still in euros');
says(eq(lines('price-legacy.txt'), ['claude=$2.3K']) && eq(lines('price-legacy-bare.txt'), ['codex=$12']),
  'taskbar price: a payload an older strip saved (no currency echo, "$" lines) still prices in dollars (' + lines('price-legacy.txt').concat(lines('price-legacy-bare.txt')).join(' ') + ')');
says(eq(lines('price-mismatch.txt'), ['claude=']) && eq(lines('price-tampered.txt'), ['claude=']),
  'taskbar price: a line not in the echo currency, or a tampered echo (control char -> dollars), prices nothing rather than mixing units (' + lines('price-mismatch.txt').concat(lines('price-tampered.txt')).join(' ') + ')');
process.exit(bad ? 1 : 0);
JS
  out=$(ui money '{}' 2263.58 91.15 0 | tr '\n' ' ')
  [ "$out" = '2263.58=$2.3K|$2,263.58 91.15=$91|$91.15 0=$0|$0.00 ' ] \
    && pass "money: no currency = the dollar formats as before ($out)" || fail "money usd: $out"
  out=$(ui money '{"code":"KRW","prefix":"₩","digits":0}' 3049200 150000 1000 999.4 0.4 | tr '\n' ' ')
  [ "$out" = '3049200=₩3.0M|₩3,049,200 150000=₩150K|₩150,000 1000=₩1.0K|₩1,000 999.4=₩999|₩999 0.4=₩0|₩0 ' ] \
    && pass "money: 0 digits, K and M tiers on the taskbar ($out)" || fail "money krw: $out"
  out=$(ui money '{"code":"BHD","prefix":"BD ","digits":3}' 1.5 | tr '\n' ' ')
  [ "$out" = '1.5=BD 2|BD 1.500 ' ] && pass "money: 3 digits ($out)" || fail "money bhd: $out"

  # The popover page itself (strip/web/index.html) renders fixture D's payload.
  PWMOD=${PLAYWRIGHT_MODULE:-}
  [ -z "$PWMOD" ] && PWMOD=$(node -e 'try { console.log(require.resolve("playwright")) } catch (_) {}' 2>/dev/null)
  if [ -z "$PWMOD" ] && command -v npm >/dev/null 2>&1; then
    G=$(npm root -g 2>/dev/null); [ -n "$G" ] && [ -f "$G/playwright/index.js" ] && PWMOD="$G/playwright/index.js"
  fi
  CHROME=${PW_CHROMIUM:-}; [ -z "$CHROME" ] && [ -x /opt/pw-browsers/chromium ] && CHROME=/opt/pw-browsers/chromium
  # The popover window's slide curve as the host computes it (OpenMotion.Ease), for the page check below.
  ui ease 0.02 0.05 0.1 0.2 0.35 0.5 0.75 0.9 > "$T/ease.txt" 2>&1
  if [ -z "$PWMOD" ]; then
    echo "SKIP: popover render (Playwright not found; set PLAYWRIGHT_MODULE)"
  else
    node --input-type=module - "$PWMOD" "$CHROME" "$STRIP_DIR/web/index.html" "$T/ui-d.json" "$T/ease.txt" \
      "$T/ui-f-eur.json" "$T/ui-f-jpy.json" <<'JS' || FAILS=$((FAILS + 1))
const [pwmod, chrome, page0, uiFile, easeFile, eurFile, jpyFile] = process.argv.slice(2);
const { pathToFileURL } = await import('node:url');
const fs = await import('node:fs');
const pw = await import(pathToFileURL(pwmod).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);
let bad = 0;
const says = (c, m) => { console.log((c ? 'PASS: ' : 'FAIL: ') + m); if (!c) bad++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
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

// The open motion. Host (PopoverForm): cloaked window -> renderData + primeOpen -> {primed} -> reveal,
// slide on OpenMotion.Ease + playOpen; resetOpen on every close. The page must never end hidden.
const easeLines = fs.readFileSync(easeFile, 'utf8').trim().split('\n');
if (!/=/.test(easeLines[0] || '')) says(false, 'open motion: no OpenMotion in Program.cs, the window slide curve is unchecked (' + easeLines[0] + ')');
else {
  const host = easeLines.map((l) => l.split('=').map(Number));
  const curve = await page.evaluate((ts) => {
    const easing = getComputedStyle(document.documentElement).getPropertyValue('--ease-decel').trim();
    const el = document.createElement('div'); document.body.appendChild(el);
    const a = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1000, easing }); a.pause();
    const out = ts.map((t) => { a.currentTime = t * 1000; return a.effect.getComputedTiming().progress; });
    a.cancel(); el.remove();
    return { easing, out };
  }, host.map(([t]) => t));
  const worst = Math.max(...host.map(([, v], i) => Math.abs(v - curve.out[i])));
  says(curve.easing && worst < 0.002, `open motion: the window slide (OpenMotion.Ease) is the page's --ease-decel ${curve.easing} (max diff ${worst.toFixed(5)})`);
}
await page.evaluate(() => { window.__posted = []; window.chrome = window.chrome || {}; window.chrome.webview = { postMessage: (m) => window.__posted.push(m) }; });
const state = () => page.evaluate(() => ({
  cls: document.body.className,
  anims: document.getAnimations().filter((a) => a.animationName).length,
  minOp: Math.min(...[...document.getElementById('app').children].map((c) => +getComputedStyle(c).opacity)),
  primed: window.__posted.filter((m) => m && 'primed' in m).map((m) => m.primed),
}));
const h0 = await page.evaluate(() => window.contentHeight && window.contentHeight());
const hPrime = await page.evaluate(() => window.primeOpen && window.primeOpen(5, true));
await page.waitForTimeout(150);
const held = await state();
says(h0 > 0 && hPrime === h0 && /preopen/.test(held.cls) && held.minOp === 0 && held.primed.includes(5),
  'open motion: primeOpen returns the content height, holds the first frame (content hidden) and posts {primed} once painted (' + JSON.stringify({ h0, hPrime, ...held }) + ')');
await page.evaluate(() => window.playOpen(true));
await page.waitForFunction(() => +getComputedStyle(document.getElementById('app').children[0]).opacity > 0.05, null, { polling: 5, timeout: 2000 }).catch(() => {});
const joined = await page.evaluate((p) => {
  const op = () => [...document.getElementById('app').children].map((c) => +getComputedStyle(c).opacity);
  const b = op(); window.renderData(p); return { before: b, after: op() };
}, JSON.parse(fs.readFileSync(uiFile, 'utf8')));
says(joined.before[0] > 0 && joined.before[0] < 1 && joined.before.every((v, i) => Math.abs(v - joined.after[i]) < 0.01),
  'open motion: fresh data mid-open continues the fade where it was, no second fade-in (' + JSON.stringify(joined) + ')');
await page.waitForTimeout(800);
const played = await state();
says(played.cls === '' && played.anims === 0 && played.minOp === 1, 'open motion: playOpen ends at rest — every block visible, no class, no animation (' + JSON.stringify(played) + ')');
await page.evaluate(() => window.primeOpen(6, true)); // the host never calls playOpen (a lost message)
await page.waitForTimeout(900 + 800);
const healed = await state();
says(healed.cls === '' && healed.anims === 0 && healed.minOp === 1, 'open motion: primed but never played -> the safety timer shows it anyway (' + JSON.stringify(healed) + ')');
await page.evaluate(() => { window.primeOpen(7, true); window.playOpen(true); });
await page.waitForTimeout(30);
await page.evaluate(() => window.resetOpen()); // closed mid-open
const reset = await state();
says(reset.cls === '' && reset.anims === 0 && reset.minOp === 1, 'open motion: resetOpen (every close) puts the page back at rest (' + JSON.stringify(reset) + ')');
const fills = await page.evaluate(() => {
  const s = new Set();
  const walk = (rules) => { for (const r of rules) { if (r.style && r.style.animationFillMode) s.add(r.style.animationFillMode); if (r.cssRules && !(r instanceof CSSKeyframesRule)) walk(r.cssRules); } };
  for (const sh of document.styleSheets) walk(sh.cssRules);
  return [...s];
});
says(fills.includes('backwards') && fills.every((m) => m === 'backwards' || m === 'none'),
  'open motion: animations only ever fill BACKWARDS (never forwards/both — no hidden end state) (' + fills.join(', ') + ')');
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.evaluate(() => { window.primeOpen(8, true); });
const rm = await state();
says(rm.cls === '' && rm.anims === 0 && rm.minOp === 1, 'open motion: reduced motion (Windows "Animation effects" off) -> no animation, content visible at once (' + JSON.stringify(rm) + ')');

// The display currency: the host sends amounts already converted plus currency {code, prefix, digits};
// the page only formats them (fixture F: 30 Days = cli 2178.50 + codex 3.60 + gemini 0.006 EUR, which prints <€0.01).
const eurUi = JSON.parse(fs.readFileSync(eurFile, 'utf8')), jpyUi = JSON.parse(fs.readFileSync(jpyFile, 'utf8'));
const shown = () => page.evaluate(() => ({
  center: (document.querySelector('.donut .center') || {}).textContent || null,
  legend: [...document.querySelectorAll('.legend .row')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()),
  rows: [...document.querySelectorAll('.trow')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()),
  bars: [...document.querySelectorAll('.spark .b')].map((b) => b.title).filter(Boolean).slice(0, 2),
  dollar: /\$/.test(document.getElementById('app').textContent),
  tags: document.querySelectorAll('#app b').length,
}));
await page.evaluate((p) => window.renderData(p), eurUi);
const eurShown = await shown();
says(eurShown.center === '€2.2K' && eq(eurShown.legend, ['Claude CLI€2,178.50', 'Codex€3.60', 'Gemini CLI<€0.01'])
  && eurShown.rows.includes('Today€178.50') && eurShown.rows.includes('Last 30 Days€2,178.50 · 2.5M tokens')
  && eurShown.bars[0] === '2026-09-24 · €2,000.00' && !eurShown.dollar,
  'currency: a EUR payload shows € everywhere - donut centre, legend, card rows, chart titles - and no $ (' + JSON.stringify(eurShown) + ')');
await page.evaluate((p) => window.renderData({ providers: p.providers, errors: [], currency: p.currency }), eurUi);
const eurOld = await shown();
says(eurOld.legend.includes('Claude€2,178.50') && eurOld.legend.includes('Codex€3.60'),
  'currency: without sources the fallback donut reads the € card lines (' + JSON.stringify(eurOld.legend) + ')');
await page.evaluate((p) => window.renderData(p), jpyUi);
const jpyShown = await shown();
const jpyFmt = await page.evaluate(() => [moneyFull(0.4), moneyFull(15234), moneyFull(0), money(13400), money(850), money(3049200)]);
says(jpyShown.center === '¥655K' && eq(jpyShown.legend, ['Claude CLI¥653,550', 'Codex¥1,080', 'Gemini CLI¥2'])
  && eq(jpyFmt, ['<¥1', '¥15,234', '¥0', '¥13.4K', '¥850', '¥3M']),
  'currency: JPY (0 digits) - no decimals, <¥1 below one yen, compact ¥13.4K (' + JSON.stringify({ center: jpyShown.center, legend: jpyShown.legend, fmt: jpyFmt }) + ')');
const hostile = await page.evaluate((p) => {
  const q = JSON.parse(JSON.stringify(p)), out = {};
  q.currency = { code: 'EUR', prefix: '<b>€</b>', digits: 9 };
  window.renderData(q);
  out.markup = [document.querySelector('.donut .center').textContent, document.querySelectorAll('#app b').length, moneyFull(1.5)];
  for (const [k, pre] of [['bidi', '\u202e€'], ['ctrl', '€\u0007'], ['long', 'ABCDEFGHI'], ['empty', ''], ['num', 5]]) {
    q.currency = { code: 'EUR', prefix: pre, digits: 2 };
    window.renderData(q);
    out[k] = document.querySelector('.donut .center').textContent;
  }
  window.renderData({ providers: p.providers, errors: [], sources: p.sources, currency: 'EUR' });
  out.notObject = document.querySelector('.donut .center').textContent;
  return out;
}, eurUi);
says(eq(hostile.markup, ['<b>€</b>2.2K', 0, '<b>€</b>1.50']) && ['bidi', 'ctrl', 'long', 'empty', 'num', 'notObject'].every((k) => hostile[k] === '$2.2K'),
  'currency: the page re-checks the echo - a markup prefix stays text (digits 9 -> 2), a bidi / control / too long / empty / non-string prefix or a non-object block -> $ (' + JSON.stringify(hostile) + ')');
await page.evaluate((p) => window.renderData(p), JSON.parse(fs.readFileSync(uiFile, 'utf8')));
const usdFmt = await page.evaluate(() => [moneyFull(0.004), moneyFull(2178.09), money(13400), money(91.15), money(1500000)]);
says(eq(usdFmt, ['<$0.01', '$2,178.09', '$13.4K', '$91.15', '$1.5M']),
  'currency: back on a USD payload the formats are the dollar ones again (' + JSON.stringify(usdFmt) + ')');
await browser.close();
process.exit(bad ? 1 : 0);
JS
  fi
fi

# ---------------------------------------------------------------------------
echo "--- strip popover click-away (PopoverDismiss from $STRIP_DIR/Program.cs)"
if [ ! -f "$H/ExtractedUi.cs" ]; then
  fail "popover click-away unchecked (no UI harness: MeterScale + SummaryTransform missing)"
elif [ ! -f "$H/ExtractedDismiss.cs" ]; then
  fail "no PopoverDismiss in $STRIP_DIR/Program.cs (popover click-away rules unchecked)"
else
  # case:expected. Times in ms from the strip click (Show); the poll ticks every 250 ms.
  CASES=(
    # A click on another app right after the 250 ms guard closes it AT ONCE, whenever the
    # reveal came ({primed} at 30-90 ms, the 140 ms fallback): the guard counts from Show.
    "r=30,a=260:closed@260"
    "r=90,a=270:closed@270" "r=90,a=300:closed@300" "r=90,a=330:closed@330"
    "r=140,a=270:closed@270" "r=140,a=300:closed@300" "r=140,a=330:closed@330"
    "r=140,a=360:closed@360" "r=140,a=385:closed@385"
    # Held back (inside the guard, or while still cloaked): closed by the first poll after the rise.
    "r=90,a=200:closed@500" "r=140,a=100:closed@500" "r=0,s=0,a=100:closed@250"
    # Windows refused the activation at Show; the reveal takes the foreground back and the guard
    # restarts there - a click-away inside it is held back, not lost.
    "r=90,refused=1,a=300:closed@500" "r=90,refused=1,a=400:closed@400"
    # Later click-aways: the Deactivate, or the poll alone when no Deactivate arrives.
    "r=90,a=2000:closed@2000" "r=90,a=2100,nodeact=1:closed@2250"
    # Never closes by itself: no click-away (with the fallback, a refused activation, no motion),
    # our own strip menu taking the foreground inside the guard, or the popover clicked again
    # after that. (Our menu taking it AFTER the guard is an ordinary Deactivate, as before.)
    "r=90:open" "r=140:open" "r=90,refused=1:open" "r=0,s=0:open"
    "r=90,own=150:open" "r=90,own=150,back=600:open" "r=90,own=1000:closed@1000"
  )
  specs=(); for c in "${CASES[@]}"; do specs+=("${c%%:*}"); done
  out=$(ui dismiss "${specs[@]}" 2>&1)
  bad=""
  for c in "${CASES[@]}"; do
    spec=${c%%:*}; want=${c##*:}
    got=$(printf '%s\n' "$out" | awk -v k="$spec=" 'index($0, k) == 1 { print; exit }')
    got=${got#"$spec="}
    [ "$got" = "$want" ] || bad="$bad [$spec: expected $want, got ${got:-$(printf '%s' "$out" | head -1)}]"
  done
  if [ -z "$bad" ]; then pass "popover click-away: ${#CASES[@]} open timelines (a click-away 250-385 ms after Show closes at once; a held-back one at the first poll after the rise; nothing else closes it)"
  else fail "popover click-away:$bad"; fi
fi

[ $FAILS -eq 0 ] && echo "packaging: all passed" || echo "packaging: $FAILS failure(s)"
exit $((FAILS > 0))
