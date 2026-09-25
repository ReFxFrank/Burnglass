// Ported from CheesyPoofs346/openusage-windows (tray/) under the MIT License,
// Copyright (c) 2026 Robin Ebers. Renamed per that project's trademark policy;
// adapted to be fed by Burnglass's (formerly Pulse's) local /api/summary. See strip/LICENSE-openusage.

using System.Drawing.Drawing2D;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace BurnglassStrip;

// Burnglass Strip host for Windows. A borderless strip painted onto the taskbar band; a left-click pops
// a borderless, rounded WebView2 window (web/index.html) rendering the popover UI, fed by the running
// Burnglass server's local HTTP API instead of the upstream Swift engine.
static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();

        // Headless end-to-end check: show the popover, fetch + render real data, write what the
        // WebView actually rendered to %TEMP%\burnglass_strip_selftest.json, then exit. Verifies the full
        // path (window → HTTP API → transform → DOM) without a human clicking the strip.
        if (args.Contains("--selftest"))
        {
            var form = new PopoverForm(selfTest: true);
            Application.Run();
            GC.KeepAlive(form);
            return;
        }

        // Render the page's built-in demo payload to a PNG for the README, so the docs never show
        // anyone's real usage numbers.
        if (args.Contains("--shots"))
        {
            var shots = new PopoverForm(sampleShots: true);
            Application.Run();
            GC.KeepAlive(shots);
            return;
        }

        if (args.Contains("--striptest"))
        {
            var strip = new StripForm { IsDark = () => true };
            // `--striptest <file.json>` renders a supplied payload instead of a live read (used for docs).
            int at = Array.IndexOf(args, "--striptest");
            string stripJson = (at >= 0 && at + 1 < args.Length && File.Exists(args[at + 1]))
                ? File.ReadAllText(args[at + 1])
                : (ServerApi.FetchSummary() is string s ? SummaryTransform.ToUi(s) : "[]");
            strip.SetData(stripJson);
            strip.RenderToFile(Path.Combine(Path.GetTempPath(), "burnglass_striptest_usage.png"), showPrice: false);
            strip.RenderToFile(Path.Combine(Path.GetTempPath(), "burnglass_striptest_price.png"), showPrice: true);
            return;
        }

        // FROZEN name (predates the rename): a Pulse-era pulse-strip.exe and a new burnglass-strip.exe
        // must exclude each other, or both would paint the taskbar.
        using var mutex = new Mutex(true, "PulseStrip_SingleInstance", out bool isNew);
        if (!isNew) return; // already running

        using var app = new AppHost();
        Application.Run();
    }
}

// Owns the taskbar strip + the popover. No system-tray icon — the strip is the whole surface.
//
// Two deliberately separate feeds, so values stay fresh WITHOUT hammering Anthropic's shared usage
// endpoint:
//   1. /api/statusline every 45s — LIFECYCLE ONLY (stripEnabled:false → quit; reachability heartbeat
//      with the 30s-retry / 40-failure exit policy). Its meter percentages are NOT folded into the
//      strip: they come from the same server-side meter cache the summary uses, so they can never be
//      fresher than the 5-minute summary re-fetch below — patching them in would add a second writer
//      for zero freshness gain. A version change in the feed is ignored (keep running).
//   2. /api/summary on popover open, on the menu "Refresh", and passively every 5 minutes — the ONE
//      data feed. It is transformed once (SummaryTransform) and the SAME providers[] payload feeds
//      both the strip cells (StripForm.SetData extracts progress % + "Last 30 Days" spend) and the
//      popover page, exactly like upstream's single shared Cli.Fetch. Opening the popover is a
//      foreground fetch, so the server refreshes its account meters per its own cache and what the user
//      sees matches Claude Code's /usage panel.
sealed class AppHost : IDisposable
{
    private readonly PopoverForm _popover;
    private readonly StripForm _strip;
    private readonly System.Windows.Forms.Timer _refresh;      // passive summary re-fetch, 5 min
    private readonly System.Windows.Forms.Timer _status;       // statusline heartbeat, 45s ok / 30s failing
    private int _statusFailures;
    private bool _statusBusy;

    private const int StatusOkMs = 45_000;
    private const int StatusRetryMs = 30_000;
    private const int StatusMaxFailures = 40; // 40 × 30s ≈ 20 min unreachable → exit

    public AppHost()
    {
        _popover = new PopoverForm { OnOpenDashboard = OpenDashboard };
        _strip = new StripForm
        {
            IsDark = () => true, // the strip is dark-only; no theme toggle
            OnClick = OpenPopover,
            OnRefresh = () => RefreshAll(),
            OnQuit = Quit,
            OnOpenDashboard = OpenDashboard
        };
        _strip.Show();
        // Show the persisted last-known payload right away — meters/spend are on screen before the
        // first fetch finishes.
        _strip.SetData(_lastJson);
        _popover.SetData(_lastJson);
        RefreshAll();

        _refresh = new System.Windows.Forms.Timer { Interval = 5 * 60 * 1000 };
        _refresh.Tick += (_, _) => RefreshAll();
        _refresh.Start();

        _status = new System.Windows.Forms.Timer { Interval = StatusOkMs };
        _status.Tick += (_, _) => StatusTick();
        _status.Start();
    }

    private string _lastJson = LoadLastPayload(); // last-known payload, so meters show instantly at launch

    // Strip-click: prime the popover with the last-known data so it opens INSTANTLY, then freshen in
    // the background (the foreground /api/summary fetch is what makes the meters match /usage).
    private void OpenPopover()
    {
        if (_popover.IsShown) { _popover.Toggle(); return; } // second click closes it
        _popover.SetData(_lastJson);
        _popover.Toggle();
        RefreshAll();
    }

    private void OpenDashboard()
    {
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = ServerApi.BaseUrl() + "/",
                UseShellExecute = true
            });
        }
        catch { }
    }

    // One shared fetch feeds both the strip and the popover. The result is merged with the last
    // payload so meters survive a refresh that comes back without progress lines, then persisted so
    // they're on screen immediately at next launch too.
    //
    // Deviation from upstream (flagged in host-logic.md as the "improved port"): a fetch FAILURE
    // (null) returns without touching _lastJson — upstream let a total failure clobber the popover's
    // payload to "[]" while only the strip was cache-protected. Here both surfaces keep last-good.
    private void RefreshAll()
    {
        Task.Run(() =>
        {
            string? summary = ServerApi.FetchSummary();
            if (summary is null) return; // degrade to last-good; the statusline heartbeat owns failure counting
            string ui = SummaryTransform.ToUi(summary);
            string merged = UsageMerge.Merge(_lastJson, ui);
            try
            {
                _strip.BeginInvoke(() =>
                {
                    _lastJson = merged;
                    SaveLastPayload(merged);
                    _strip.SetData(merged);
                    _popover.SetData(merged);
                });
            }
            catch { /* shutting down */ }
        });
    }

    // Heartbeat against the cheap statusline feed. Unreachable server (no live server.json, or a dead
    // port) → retry every 30s with the strip resting on last-good cells (a fresh install with no cache
    // shows the "Burnglass" resting state); 40 consecutive failures → clean exit.
    // stripEnabled:false in the feed (the dashboard toggle turned the strip off) → clean exit.
    private void StatusTick()
    {
        if (_statusBusy) return;
        _statusBusy = true;
        Task.Run(() =>
        {
            string? s = ServerApi.FetchStatusline();
            try
            {
                _strip.BeginInvoke(() =>
                {
                    _statusBusy = false;
                    if (s is null)
                    {
                        _statusFailures++;
                        _status.Interval = StatusRetryMs;
                        if (_statusFailures >= StatusMaxFailures) Quit();
                        return;
                    }
                    _statusFailures = 0;
                    _status.Interval = StatusOkMs;
                    try
                    {
                        using var doc = JsonDocument.Parse(s);
                        // Quit only on an EXPLICIT stripEnabled:false — an older server without the
                        // key must not kill a manually-started strip. Version changes are ignored.
                        if (doc.RootElement.TryGetProperty("stripEnabled", out var se)
                            && se.ValueKind == JsonValueKind.False)
                        {
                            Quit();
                        }
                    }
                    catch { /* malformed feed — treat as alive */ }
                });
            }
            catch { _statusBusy = false; /* shutting down */ }
        });
    }

    private const string LastPayloadName = "strip-ui.json";

    private static void SaveLastPayload(string json)
    {
        try
        {
            Directory.CreateDirectory(AppPaths.Home);
            File.WriteAllText(AppPaths.PathOf(LastPayloadName), json);
        }
        catch { }
    }

    private static string LoadLastPayload()
    {
        try
        {
            string file = AppPaths.ReadPath(LastPayloadName);
            return SafeJson(File.Exists(file) ? File.ReadAllText(file) : "[]");
        }
        catch { return "[]"; }
    }

    // Anything that isn't well-formed JSON becomes an empty payload rather than
    // flowing on toward a script string (see PopoverForm.Inject).
    internal static string SafeJson(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return "[]";
        try { return JsonNode.Parse(raw)?.ToJsonString() ?? "[]"; }
        catch { return "[]"; }
    }

    private void Quit()
    {
        _strip.Hide();
        Application.Exit();
    }

    public void Dispose() { _refresh.Dispose(); _status.Dispose(); _strip.Dispose(); _popover.Dispose(); }
}

/// Where the strip keeps its state. Burnglass 2.0 moved the server's home from ~/.pulse to
/// ~/.burnglass (a one-time COPY the server makes on its first start; ~/.pulse stays as a backup).
/// Resolution mirrors the server's:
///   1. BURNGLASS_HOME, else its permanent alias PULSE_HOME — verbatim, never mixed with ~/.pulse
///      (the server passes BURNGLASS_HOME when it launches the strip);
///   2. ~/.burnglass when it exists;
///   3. ~/.pulse when THAT exists — a Pulse 1.x server, or one that has not migrated yet. Creating
///      ~/.burnglass here instead would make the server skip its one-time copy of the user's data;
///   4. ~/.burnglass on a machine that has neither.
/// Nothing under ~/.pulse is ever deleted by the strip: the folders it cleans (the extracted popover
/// UI) or hands to WebView2 (which deletes and rotates files in its profile at will) go through
/// ScratchPathOf, which keeps them out of ~/.pulse whenever the home IS ~/.pulse — including a home
/// PINNED there (the server passes BURNGLASS_HOME=~/.pulse after a failed migration).
static class AppPaths
{
    public static readonly string LegacyHome;
    public static readonly string NewHome;
    public static readonly string Home;
    /// Home came from an environment variable: use it alone.
    public static readonly bool Pinned;

    static AppPaths()
    {
        string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        LegacyHome = Path.Combine(profile, ".pulse");
        NewHome = Path.Combine(profile, ".burnglass");
        string? env = Environment.GetEnvironmentVariable("BURNGLASS_HOME");
        if (string.IsNullOrWhiteSpace(env)) env = Environment.GetEnvironmentVariable("PULSE_HOME");
        if (!string.IsNullOrWhiteSpace(env))
        {
            Home = env;
            Pinned = true;
        }
        else if (Directory.Exists(NewHome)) Home = NewHome;
        else if (Directory.Exists(LegacyHome)) Home = LegacyHome;
        else Home = NewHome;
        HomeIsLegacyLazy = new(() => SameDir(Home, LegacyHome));
    }

    private static readonly Lazy<bool> HomeIsLegacyLazy;

    /// The home IS the Pulse-era ~/.pulse: picked because only ~/.pulse exists, OR pinned there by
    /// BURNGLASS_HOME / PULSE_HOME (the server does exactly that after a failed migration, and a user
    /// may pin PULSE_HOME to it). Decided by the folder itself, links followed: being pinned says
    /// nothing about WHICH folder the home is.
    public static bool HomeIsLegacy => HomeIsLegacyLazy.Value;

    /// Where a state file is written.
    public static string PathOf(string name) => Path.Combine(Home, name);

    /// Where a folder the strip regenerates and cleans, or lets WebView2 churn, lives: in the home,
    /// except when the home is ~/.pulse, where nothing may ever be deleted. Then it goes to a folder
    /// in the user's temp directory instead, and ~/.pulse is not touched for it at all.
    public static string ScratchPathOf(string name) =>
        HomeIsLegacy ? Path.Combine(Path.GetTempPath(), "burnglass-strip", name) : PathOf(name);

    /// Where a small state file is read from: the home's own copy, else — until the strip has written
    /// one there — the Pulse-era copy in ~/.pulse (read only; never modified from here).
    public static string ReadPath(string name)
    {
        string own = PathOf(name);
        if (Pinned || HomeIsLegacy) return own;
        try
        {
            if (File.Exists(own)) return own;
            string legacy = Path.Combine(LegacyHome, name);
            return File.Exists(legacy) ? legacy : own;
        }
        catch { return own; }
    }

    /// Homes whose server.json may describe the running server, best first.
    public static IEnumerable<string> ServerJsonCandidates()
    {
        var seen = new List<string>();
        foreach (var dir in Pinned ? new[] { Home } : new[] { Home, NewHome, LegacyHome })
        {
            if (seen.Any(d => SamePath(d, dir))) continue;
            seen.Add(dir);
            yield return Path.Combine(dir, "server.json");
        }
    }

    public static bool SamePath(string a, string b)
    {
        try
        {
            return string.Equals(Path.GetFullPath(a).TrimEnd('\\', '/'), Path.GetFullPath(b).TrimEnd('\\', '/'),
                StringComparison.OrdinalIgnoreCase);
        }
        catch { return string.Equals(a, b, StringComparison.OrdinalIgnoreCase); }
    }

    /// SamePath, or one of the two folders is a symbolic link / junction that resolves to the other
    /// (a user who moved ~/.pulse elsewhere and linked it back, or linked ~/.burnglass to ~/.pulse).
    public static bool SameDir(string a, string b)
    {
        if (SamePath(a, b)) return true;
        string? la = LinkTarget(a), lb = LinkTarget(b);
        return (la != null || lb != null) && SamePath(la ?? a, lb ?? b);
    }

    private static string? LinkTarget(string dir)
    {
        try
        {
            string full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(dir));
            return Directory.ResolveLinkTarget(full, returnFinalTarget: true)?.FullName;
        }
        catch { return null; }
    }
}

/// Talks to the running server over loopback. Discovery via <home>/server.json {port,host,pid,startedAt};
/// contract: never throw, null on any failure, per-call timeouts (5s statusline / 30s summary).
static class ServerApi
{
    private const int DefaultPort = 4747;
    private static readonly HttpClient Http = new(); // no global timeout — per-call CTS below

    private sealed record ServerFile(string Host, int Port, bool Alive, double StartedAt);

    // server.json is only ever (re)written, never removed, so a stale one outlives its server — and
    // during the Pulse → Burnglass switch there can be one in each home (a v1 server writes ~/.pulse, a
    // v2 one ~/.burnglass). Use the file whose pid is still alive; among those (or if none is), the
    // most recently started. Reading a stale file first would point the strip at a dead port.
    private static ServerFile? Discover()
    {
        ServerFile? best = null;
        foreach (var file in AppPaths.ServerJsonCandidates())
        {
            try
            {
                if (!File.Exists(file)) continue;
                using var doc = JsonDocument.Parse(File.ReadAllText(file));
                var r = doc.RootElement;
                if (r.ValueKind != JsonValueKind.Object) continue;
                int port = r.TryGetProperty("port", out var p) && p.ValueKind == JsonValueKind.Number && p.TryGetInt32(out var pv) && pv > 0 && pv < 65536 ? pv : DefaultPort;
                string host = r.TryGetProperty("host", out var h) && h.ValueKind == JsonValueKind.String
                    && h.GetString() is string hs && hs.Length > 0 ? hs : "127.0.0.1";
                bool alive = r.TryGetProperty("pid", out var pidEl) && pidEl.ValueKind == JsonValueKind.Number
                    && pidEl.TryGetInt32(out var pid) && PidAlive(pid);
                double started = r.TryGetProperty("startedAt", out var sa) && sa.ValueKind == JsonValueKind.Number
                    && sa.TryGetDouble(out var sv) ? sv : File.GetLastWriteTimeUtc(file).Subtract(DateTime.UnixEpoch).TotalMilliseconds;
                var cand = new ServerFile(host, port, alive, started);
                if (best is null || (cand.Alive && !best.Alive) || (cand.Alive == best.Alive && cand.StartedAt > best.StartedAt))
                    best = cand;
            }
            catch { /* unreadable / half-written file: try the next one */ }
        }
        return best;
    }

    private static bool PidAlive(int pid)
    {
        if (pid <= 0) return false;
        try
        {
            using var proc = System.Diagnostics.Process.GetProcessById(pid);
            return true;
        }
        catch { return false; }
    }

    public static string BaseUrl()
    {
        var found = Discover();
        string host = found?.Host ?? "127.0.0.1";
        int port = found?.Port ?? DefaultPort;
        if (host == "0.0.0.0" || host == "::") host = "127.0.0.1";
        if (host.Contains(':') && !host.StartsWith('[')) host = "[" + host + "]"; // bare IPv6
        return $"http://{host}:{port}";
    }

    public static string? FetchStatusline() => Get("/api/statusline", timeoutSeconds: 5);
    public static string? FetchSummary() => Get("/api/summary", timeoutSeconds: 30);

    private static string? Get(string route, int timeoutSeconds)
    {
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(timeoutSeconds));
            using var resp = Http.GetAsync(BaseUrl() + route, cts.Token).GetAwaiter().GetResult();
            if (!resp.IsSuccessStatusCode) return null;
            var bytes = resp.Content.ReadAsByteArrayAsync(cts.Token).GetAwaiter().GetResult();
            string text = Encoding.UTF8.GetString(bytes);
            return string.IsNullOrWhiteSpace(text) ? null : text;
        }
        catch
        {
            return null;
        }
    }
}

/// Usage-meter scale shared by SummaryTransform (the summary's alertThresholds → the UI payload's
/// "thresholds"), StripForm (tints the taskbar numbers) and — in JS — the popover page. All three
/// mirror the dashboard's web/src/lib.js alertThresholds + meterTone, so a window turns amber / red
/// at the same numbers in the dashboard, the popover and on the taskbar.
static class MeterScale
{
    public static readonly double[] DefaultThresholds = { 80, 95 };

    /// Finite numbers in (0, 100], ascending (the dashboard's filter); anything else, or none left,
    /// → the default 80 / 95. Accepts any element (a missing property is ValueKind.Undefined).
    public static List<double> Sanitize(JsonElement arr)
    {
        var list = new List<double>();
        if (arr.ValueKind == JsonValueKind.Array)
            foreach (var t in arr.EnumerateArray())
                if (t.ValueKind == JsonValueKind.Number && t.TryGetDouble(out var v) && double.IsFinite(v) && v > 0 && v <= 100)
                    list.Add(v);
        if (list.Count == 0) list.AddRange(DefaultThresholds);
        list.Sort();
        return list;
    }

    /// 0 = plain, 1 = warn (at/above the lowest threshold), 2 = crit (at/above the highest, when
    /// there are two or more) — lib.js meterTone.
    public static int Tone(double pctUsed, IReadOnlyList<double> thresholds)
    {
        if (!double.IsFinite(pctUsed) || thresholds.Count == 0) return 0;
        if (thresholds.Count > 1 && pctUsed >= thresholds[^1]) return 2;
        return pctUsed >= thresholds[0] ? 1 : 0;
    }

    /// The whole-number "% used" the popover and the strip print for a progress line (JS
    /// Math.round semantics: halves round up, not to even).
    public static int UsedPct(double used, double limit)
    {
        double pct = limit > 0 && double.IsFinite(used) ? used * 100 / limit : 0;
        return (int)Math.Round(Math.Clamp(pct, 0, 100), MidpointRounding.AwayFromZero);
    }

    /// The UNROUNDED "% used" of a progress line, for Tone: its "pct" when present (SummaryTransform
    /// writes it), else used / limit as before (a payload saved by an older strip). The dashboard's
    /// meterTone and the server's alerts compare the raw value, so the strip must too — 79.5% is
    /// plain there, while its printed (rounded) 80 would have been amber here.
    public static double LinePct(JsonElement line)
    {
        if (line.ValueKind == JsonValueKind.Object && line.TryGetProperty("pct", out var p)
            && p.ValueKind == JsonValueKind.Number && p.TryGetDouble(out var pv) && double.IsFinite(pv))
            return Math.Clamp(pv, 0, 100);
        double used = line.ValueKind == JsonValueKind.Object && line.TryGetProperty("used", out var u)
            && u.ValueKind == JsonValueKind.Number && u.TryGetDouble(out var uv) && double.IsFinite(uv) ? uv : 0;
        double limit = line.ValueKind == JsonValueKind.Object && line.TryGetProperty("limit", out var l)
            && l.ValueKind == JsonValueKind.Number && l.TryGetDouble(out var lv) && lv > 0 ? lv : 100;
        return Math.Clamp(used * 100 / limit, 0, 100);
    }
}

/// Transforms the server's /api/summary JSON into the providers[] schema the ported popover page and
/// StripForm consume (ui-schema.md). Sources are classified: 'codex' → Codex; gemini/cline/roo/
/// continue → their own providers; everything else (cli, claude-desktop, unknown, …) → Claude.
/// Additive top-level keys beside providers/errors:
///   "sources"    — one row per SOURCE for the popover's spend donut, coloured and labelled exactly
///                  like the dashboard (see Sources below);
///   "thresholds" — the summary's alertThresholds (MeterScale.Sanitize), for meter ticks + tones.
/// Never throws — any parse trouble yields an empty wrapper.
static class SummaryTransform
{
    private static readonly string[] AgentSources = { "gemini", "cline", "roo", "continue" };
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    /// The dashboard's categorical source series, DARK values (web/src/styles.css --s1…--s6; the
    /// popover is dark-only). Assigned by position in the server's allSources, like lib.js
    /// makeColorMap, so every source wears the same colour here as on the dashboard.
    internal static readonly string[] SourceSeries = { "#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300" };

    /// The dashboard's built-in source labels (web/src/lib.js SOURCE_LABELS). A custom source's own
    /// label (payload.sourceMeta) wins; an unknown key shows raw — lib.js srcLabel.
    private static readonly Dictionary<string, string> SourceLabels = new(StringComparer.Ordinal)
    {
        ["cli"] = "Claude CLI",
        ["claude-vscode"] = "Claude VS Code",
        ["claude-desktop"] = "Claude Desktop",
        ["claude-jetbrains"] = "Claude JetBrains",
        ["sdk-cli"] = "Claude SDK",
        ["sdk-ts"] = "Claude SDK (TS)",
        ["sdk-py"] = "Claude SDK (Python)",
        ["codex"] = "Codex",
        ["gemini"] = "Gemini CLI",
        ["continue"] = "Continue",
        ["cline"] = "Cline",
        ["roo"] = "Roo Code",
    };

    public static string ToUi(string summaryJson)
    {
        try { return Build(summaryJson); }
        catch { return "{\"providers\":[],\"errors\":[]}"; }
    }

    private static string Build(string summaryJson)
    {
        using var doc = JsonDocument.Parse(summaryJson);
        var root = doc.RootElement;

        // ---- last30 period: per-class 30d totals + per-day cost series -------------------------
        JsonElement last30 = default;
        bool hasLast30 = false;
        if (root.TryGetProperty("periods", out var periods) && periods.ValueKind == JsonValueKind.Array)
            foreach (var p in periods.EnumerateArray())
                if (p.TryGetProperty("key", out var k) && k.GetString() == "last30") { last30 = p; hasLast30 = true; break; }

        var cost30 = new Dictionary<string, double>();
        var tokens30 = new Dictionary<string, double>();
        var srcCost30 = new Dictionary<string, double>(StringComparer.Ordinal); // per SOURCE, for "sources"
        if (hasLast30 && last30.TryGetProperty("bySource", out var bys) && bys.ValueKind == JsonValueKind.Object)
            foreach (var prop in bys.EnumerateObject())
            {
                string cls = Classify(prop.Name);
                Bump(cost30, cls, Num(prop.Value, "cost"));
                Bump(tokens30, cls, Num(prop.Value, "tokens"));
                Bump(srcCost30, prop.Name, Num(prop.Value, "cost"));
            }

        // daily[] buckets: {date:'YYYY-MM-DD', total, tokens, bySource:{src:cost}} — last bucket is today.
        var daily = new List<(string Date, Dictionary<string, double> ByClass)>();
        var dailySrc = new List<Dictionary<string, double>>(); // the same buckets per SOURCE
        if (hasLast30 && last30.TryGetProperty("daily", out var dl) && dl.ValueKind == JsonValueKind.Array)
            foreach (var b in dl.EnumerateArray())
            {
                var byClass = new Dictionary<string, double>();
                var bySrc = new Dictionary<string, double>(StringComparer.Ordinal);
                if (b.TryGetProperty("bySource", out var bsx) && bsx.ValueKind == JsonValueKind.Object)
                    foreach (var prop in bsx.EnumerateObject())
                        if (prop.Value.ValueKind == JsonValueKind.Number && prop.Value.TryGetDouble(out var dv) && double.IsFinite(dv))
                        {
                            Bump(byClass, Classify(prop.Name), dv);
                            Bump(bySrc, prop.Name, dv);
                        }
                string date = b.TryGetProperty("date", out var dt) && dt.ValueKind == JsonValueKind.String ? dt.GetString() ?? "" : "";
                daily.Add((date, byClass));
                dailySrc.Add(bySrc);
            }

        double TodayFor(string cls) => daily.Count > 0 ? daily[^1].ByClass.GetValueOrDefault(cls) : 0;
        double Week7For(string cls)
        {
            double sum = 0;
            for (int i = Math.Max(0, daily.Count - 7); i < daily.Count; i++)
                sum += daily[i].ByClass.GetValueOrDefault(cls);
            return sum;
        }

        var providers = new JsonArray();
        var errors = new JsonArray();

        // ---- Claude ----------------------------------------------------------------------------
        bool metersEnabled = false;
        string metersStatus = "";
        var claudeProgress = new List<JsonObject>();
        if (root.TryGetProperty("meters", out var meters) && meters.ValueKind == JsonValueKind.Object)
        {
            metersEnabled = meters.TryGetProperty("enabled", out var en) && en.ValueKind == JsonValueKind.True;
            metersStatus = meters.TryGetProperty("status", out var st) ? st.GetString() ?? "" : "";
            if (metersEnabled && meters.TryGetProperty("buckets", out var bks) && bks.ValueKind == JsonValueKind.Array)
                foreach (var b in bks.EnumerateArray())
                {
                    // A window that rolled over since the reading (the server marks it stale — a
                    // restored or rate-limited last-good row outlives its window) has no current %,
                    // exactly like a stale Codex window below. With none left and a login problem,
                    // the sign-in card shows.
                    if (b.TryGetProperty("stale", out var cst) && cst.ValueKind == JsonValueKind.True) continue;
                    string key = b.TryGetProperty("key", out var kk) && kk.ValueKind == JsonValueKind.String ? kk.GetString() ?? "" : "";
                    double pct = Num(b, "pct");
                    long? resetsAt = Millis(b, "resetsAt");
                    string label;
                    long period;
                    if (key == "five_hour") { label = "Session"; period = 18_000_000; }               // 5h
                    else if (key == "seven_day" || key == "seven_day_overall") { label = "Weekly"; period = 604_800_000; }
                    else { label = ScopedLabel(b); period = 604_800_000; }                            // per-model weekly
                    claudeProgress.Add(Progress(label, pct, resetsAt, period, ProjectedUsed(b)));
                }
        }
        double claude30 = cost30.GetValueOrDefault("claude");
        if (claudeProgress.Count > 0 || claude30 > 0)
        {
            var lines = new JsonArray();
            foreach (var pr in claudeProgress) lines.Add(pr);
            AddSpendLines(lines, "claude", TodayFor("claude"), Week7For("claude"), claude30,
                tokens30.GetValueOrDefault("claude"), daily);
            providers.Add(Provider("claude", "Claude", lines));
        }
        // No usable meters + a login problem → an actionable error card ("session" keeps it past the
        // page's actionableErrors filter). Joins the Claude section as a ⚠ when spend rows exist.
        if (metersEnabled && claudeProgress.Count == 0 && (metersStatus == "no-login" || metersStatus == "expired"))
        {
            errors.Add(new JsonObject
            {
                ["providerId"] = "claude",
                ["displayName"] = "Claude",
                ["message"] = "No Claude Code session found — sign in with Claude Code and Burnglass picks it up."
            });
        }

        // ---- Codex -----------------------------------------------------------------------------
        var codexProgress = new List<JsonObject>();
        if (root.TryGetProperty("codexMeters", out var cm) && cm.ValueKind == JsonValueKind.Object
            && cm.TryGetProperty("buckets", out var cbk) && cbk.ValueKind == JsonValueKind.Array)
            foreach (var b in cbk.EnumerateArray())
            {
                if (b.TryGetProperty("stale", out var stl) && stl.ValueKind == JsonValueKind.True) continue;
                double pct = Num(b, "pct");
                long? resetsAt = Millis(b, "resetsAt");
                // Label-driven, not key-driven: the server's codex_primary bucket IS the weekly
                // window (label "Codex · weekly") — keying on the name mislabeled it "Session".
                string raw = b.TryGetProperty("label", out var lb) ? (lb.GetString() ?? "") : "";
                string label;
                long period;
                if (raw.Contains("weekly", StringComparison.OrdinalIgnoreCase)) { label = "Weekly"; period = 604_800_000; }
                else if (raw.Contains("5h")) { label = "Session"; period = 18_000_000; }
                else { label = ScopedLabel(b); period = 604_800_000; }
                codexProgress.Add(Progress(label, pct, resetsAt, period, ProjectedUsed(b)));
            }
        double codex30 = cost30.GetValueOrDefault("codex");
        if (codexProgress.Count > 0 || codex30 > 0)
        {
            var lines = new JsonArray();
            foreach (var pr in codexProgress) lines.Add(pr);
            AddSpendLines(lines, "codex", TodayFor("codex"), Week7For("codex"), codex30,
                tokens30.GetValueOrDefault("codex"), daily);
            providers.Add(Provider("codex", "Codex", lines));
        }

        // ---- Other agents (spend + trend only) -------------------------------------------------
        foreach (var src in AgentSources)
        {
            double c30 = cost30.GetValueOrDefault(src);
            if (c30 <= 0) continue;
            var lines = new JsonArray();
            AddSpendLines(lines, src, TodayFor(src), Week7For(src), c30, tokens30.GetValueOrDefault(src), daily);
            providers.Add(Provider(src, char.ToUpperInvariant(src[0]) + src[1..], lines));
        }

        var thresholds = new JsonArray();
        foreach (var t in MeterScale.Sanitize(root.TryGetProperty("alertThresholds", out var at) ? at : default))
            thresholds.Add(t);

        return new JsonObject
        {
            ["providers"] = providers,
            ["errors"] = errors,
            ["sources"] = Sources(root, srcCost30, dailySrc),
            ["thresholds"] = thresholds,
        }.ToJsonString(new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
    }

    // The popover's spend donut, per SOURCE like the dashboard's (#mini MiniDonut): one row per key
    // of the server's allSources — alphabetical, and the order the dashboard colours by — with
    // colour SourceSeries[i % 6], the dashboard's label, and today (the last daily bucket), week7 (the
    // last 7 daily buckets: the strip's calendar-day week) and cost30 (last30.bySource). A server
    // without allSources falls back to the period's source keys, ordinal-sorted like a JS sort().
    private static JsonArray Sources(JsonElement root, Dictionary<string, double> cost30,
        List<Dictionary<string, double>> daily)
    {
        var order = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        if (root.TryGetProperty("allSources", out var all) && all.ValueKind == JsonValueKind.Array)
            foreach (var s in all.EnumerateArray())
                if (s.ValueKind == JsonValueKind.String && s.GetString() is string k && k.Length > 0 && seen.Add(k))
                    order.Add(k);
        // Anything with spend the list does not name still gets a row (after it, never reshuffling it).
        var extra = cost30.Keys.Concat(daily.SelectMany(d => d.Keys)).Where(k => k.Length > 0 && seen.Add(k)).ToList();
        extra.Sort(StringComparer.Ordinal);
        order.AddRange(extra);

        JsonElement meta = root.TryGetProperty("sourceMeta", out var sm) && sm.ValueKind == JsonValueKind.Object ? sm : default;
        var rows = new JsonArray();
        for (int i = 0; i < order.Count; i++)
        {
            string id = order[i];
            double today = daily.Count > 0 ? daily[^1].GetValueOrDefault(id) : 0;
            double week7 = 0;
            for (int d = Math.Max(0, daily.Count - 7); d < daily.Count; d++) week7 += daily[d].GetValueOrDefault(id);
            // Raw amounts, NOT pre-rounded: the popover rounds to cents once, like the dashboard's
            // money() and this transform's own Money() for the provider card. A 4-decimal round
            // first turned 12.344996 into 12.345 → "$12.35" beside "$12.34" everywhere else.
            rows.Add(new JsonObject
            {
                ["id"] = id,
                ["label"] = SourceLabel(id, meta),
                ["color"] = SourceSeries[i % SourceSeries.Length],
                ["today"] = Finite(today),
                ["week7"] = Finite(week7),
                ["cost30"] = Finite(cost30.GetValueOrDefault(id)),
            });
        }
        return rows;
    }

    // lib.js srcLabel: the custom source's own label (payload.sourceMeta) → the built-in label → the
    // raw key. The server already sanitizes custom labels; control characters are dropped here too.
    private static string SourceLabel(string id, JsonElement meta)
    {
        if (meta.ValueKind == JsonValueKind.Object && meta.TryGetProperty(id, out var m) && m.ValueKind == JsonValueKind.Object
            && m.TryGetProperty("label", out var lb) && lb.ValueKind == JsonValueKind.String)
        {
            string clean = new string((lb.GetString() ?? "").Where(c => !char.IsControl(c)).ToArray()).Trim();
            if (clean.Length > 64) clean = clean[..64];
            if (clean.Length > 0) return clean;
        }
        return SourceLabels.TryGetValue(id, out var builtin) ? builtin : id;
    }

    private static JsonObject Provider(string id, string name, JsonArray lines) => new()
    {
        ["providerId"] = id,
        ["displayName"] = name,
        ["fetchedAt"] = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", Inv),
        ["lines"] = lines,
    };

    // format.kind:"percent" is REQUIRED — StripForm only counts progress lines carrying it.
    // "projected" (additive) = the server's straight-line % used at the reset, for the dashboard's
    // projection hatch; absent until the server has observed the window long enough.
    // "pct" (additive) = the UNROUNDED % used: tones are computed from it (MeterScale.LinePct), as
    // the dashboard's meterTone and the server's alerts compare the raw value — a rounded 79.5 → 80
    // turned amber here while the dashboard stayed plain. "used" stays the whole number printed.
    private static JsonObject Progress(string label, double usedPct, long? resetsAtMs, long periodMs, int? projectedUsed = null)
    {
        var o = new JsonObject
        {
            ["label"] = label,
            ["type"] = "progress",
            ["used"] = (int)Math.Round(Math.Clamp(usedPct, 0, 100), MidpointRounding.AwayFromZero), // JS Math.round, as the dashboard
            ["pct"] = Math.Clamp(Finite(usedPct), 0, 100),
            ["limit"] = 100,
            ["format"] = new JsonObject { ["kind"] = "percent" },
            ["periodDurationMs"] = periodMs,
        };
        if (resetsAtMs is long ms)
            o["resetsAt"] = DateTimeOffset.FromUnixTimeMilliseconds(ms).UtcDateTime
                .ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", Inv);
        if (projectedUsed is int pu) o["projected"] = pu;
        return o;
    }

    // Bucket projLeftAtReset (% LEFT at the reset) → % USED at the reset, as the dashboard's meters do.
    private static int? ProjectedUsed(JsonElement bucket) =>
        bucket.TryGetProperty("projLeftAtReset", out var v) && v.ValueKind == JsonValueKind.Number
            && v.TryGetDouble(out var left) && double.IsFinite(left)
            ? (int)Math.Round(Math.Clamp(100 - left, 0, 100), MidpointRounding.AwayFromZero)
            : null;

    // The donut regex-parses "$X" out of lines labeled EXACTLY Today / Last 7 Days / Last 30 Days —
    // keep the labels verbatim. No "All Time" line: per-source all-time isn't in the payload.
    private static void AddSpendLines(JsonArray lines, string cls, double today, double week7,
        double cost30, double tokens30, List<(string Date, Dictionary<string, double> ByClass)> daily)
    {
        lines.Add(new JsonObject { ["label"] = "Today", ["type"] = "text", ["value"] = Money(today) });
        lines.Add(new JsonObject { ["label"] = "Last 7 Days", ["type"] = "text", ["value"] = Money(week7) });
        lines.Add(new JsonObject
        {
            ["label"] = "Last 30 Days",
            ["type"] = "text",
            ["value"] = Money(cost30) + " · " + Tokens(tokens30) + " tokens"
        });
        if (cost30 > 0 && daily.Count > 0)
        {
            var points = new JsonArray();
            foreach (var (date, byClass) in daily)
            {
                double v = byClass.GetValueOrDefault(cls);
                points.Add(new JsonObject
                {
                    ["label"] = date,
                    ["value"] = Math.Round(v, 4),
                    ["valueLabel"] = Money(v),
                });
            }
            lines.Add(new JsonObject
            {
                ["label"] = "Daily Spend",
                ["type"] = "barChart",
                ["note"] = "Last 30 days",
                ["points"] = points,
            });
        }
    }

    // Per-model weekly rows: prefer scope.model.display_name if the bucket carries it, else take the
    // tail of the server label ("Claude · weekly · Fable" → "Fable").
    private static string ScopedLabel(JsonElement bucket)
    {
        if (bucket.TryGetProperty("scope", out var sc) && sc.ValueKind == JsonValueKind.Object
            && sc.TryGetProperty("model", out var mo) && mo.ValueKind == JsonValueKind.Object
            && mo.TryGetProperty("display_name", out var dn) && dn.GetString() is string name && name.Trim().Length > 0)
            return Capitalize(name.Trim());
        string label = bucket.TryGetProperty("label", out var lb) ? lb.GetString() ?? "" : "";
        int i = label.LastIndexOf('·');
        string tail = (i >= 0 ? label[(i + 1)..] : label).Trim();
        return tail.Length > 0 ? Capitalize(tail) : "Weekly";
    }

    private static string Capitalize(string s) => s.Length > 0 ? char.ToUpperInvariant(s[0]) + s[1..] : s;

    private static string Money(double n) => "$" + n.ToString("#,##0.00", Inv);

    private static string Tokens(double n) =>
        n >= 1e9 ? (n / 1e9).ToString("0.0", Inv) + "B" :
        n >= 1e6 ? (n / 1e6).ToString("0.0", Inv) + "M" :
        n >= 1e3 ? (n / 1e3).ToString("0.0", Inv) + "K" :
        n.ToString("0", Inv);

    private static string Classify(string source) =>
        source == "codex" ? "codex" :
        AgentSources.Contains(source) ? source : "claude";

    // JSON has no NaN/Infinity (System.Text.Json throws on them): anything non-finite becomes 0.
    private static double Finite(double v) => double.IsFinite(v) ? v : 0;

    private static double Num(JsonElement el, string prop) =>
        el.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var d) && double.IsFinite(d) ? d : 0;

    private static long? Millis(JsonElement el, string prop) =>
        el.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var ms) && ms > 0 ? ms : null;

    private static void Bump(Dictionary<string, double> d, string key, double v) =>
        d[key] = d.GetValueOrDefault(key) + v;
}

sealed class PopoverForm : Form
{
    /// Invoked by the page footer's "Open dashboard →" link (postMessage {open:'dashboard'}).
    public Action? OnOpenDashboard;
    private readonly WebView2 _web = new();
    private bool _ready;
    private bool _pendingShow;
    private int _lastHeightCss = 640; // CSS px as posted by the page; scaled by DPI at use
    private readonly bool _selfTest;

    // Base (96-dpi) metrics — every physical use is scaled by DeviceDpi/96 so the window is correctly
    // sized on high-DPI displays WITHOUT the force-device-scale-factor env var (WebView2's own zoom
    // keeps the page content crisp; only the window box needs scaling here).
    private const int WidthCss = 372;
    // Tall enough to show every provider without scrolling; the real limit is the screen work area
    // (MaxScreenHeight). MaxHeight is a CSS-px cap shared with the page's height postMessage.
    private const int MaxHeight = 2000;
    private const int MarginCss = 12;
    private const int MinHeightCss = 120;
    private const int RadiusCss = 20; // Windows 10 GDI region only; Windows 11 rounds the window itself

    private float Dpi => DeviceDpi / 96f;
    private int W => (int)MathF.Round(WidthCss * Dpi);
    private int Margin_ => (int)MathF.Round(MarginCss * Dpi);

    // Popover backdrop = the page's own background (--tray in web/index.html, the Command Center
    // dark --bg #0a0b0f), so nothing ever flashes a mismatched box. Dark-only.
    private static readonly Color Backdrop = Color.FromArgb(0x0a, 0x0b, 0x0f);
    // The page's --card-line (#22252f) as a COLORREF (0x00BBGGRR): the 1 px border Windows 11 draws.
    private const int BorderColorRef = 0x002F2522;

    // Windows 11 (build 22000+): DWM rounds the corners (anti-aliased) and draws the flyout's border
    // and shadow itself (OnHandleCreated). Windows 10 keeps the GDI region + class drop shadow.
    private static readonly bool Win11 = OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000);

    private readonly bool _sampleShots;

    public PopoverForm(bool selfTest = false, bool sampleShots = false)
    {
        _selfTest = selfTest;
        _sampleShots = sampleShots;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        BackColor = Backdrop;
        DoubleBuffered = true;
        Size = new Size(W, (int)MathF.Round(_lastHeightCss * Dpi));
        // NOTE: never set Opacity != 1 — it turns the form into a WS_EX_LAYERED window, and WebView2
        // (DirectComposition) renders BLANK in layered windows. That was the "blank popover" bug.
        // The open motion therefore never fades the WINDOW: it only moves it (and the page fades its
        // own content); the invisible first moment is DWM cloaking, which is not layering.

        // Docked: the window keeps ONE size for the whole open (it only moves), so the page never
        // reflows mid-animation; a new content height resizes it in a single step (SetContentHeight).
        _web.Dock = DockStyle.Fill;
        Controls.Add(_web);
        // Click-away close. Ignored until the window is actually on screen, and for a brief moment
        // after (the show can fire a spurious deactivation) — never for the whole animation: that once
        // swallowed a real click-away and the popover then never closed at all.
        Deactivate += (_, _) =>
        {
            if (_revealed && (DateTime.UtcNow - _shownAt).TotalMilliseconds > 250) Hide();
        };

        _revealFallback = new System.Windows.Forms.Timer { Interval = RevealFallbackMs };
        _revealFallback.Tick += (_, _) => RevealFallback();
        _slideTick = SlideTick;

        // Safety net: if the popover somehow never receives a Deactivate (a borderless tool window
        // doesn't always), close it once focus has demonstrably moved to another application.
        _focusWatch = new System.Windows.Forms.Timer { Interval = 250 };
        _focusWatch.Tick += (_, _) => WatchFocus();

        _ = InitWebAsync();
    }

    protected override bool ShowWithoutActivation => false;

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        _cloaked = false; // a (re)created window starts uncloaked
        // The open motion below is the only one: no DWM show/hide transition on top of it (Windows may
        // otherwise fade the popup in and out), which also keeps the close instant.
        DwmSetInt(DWMWA_TRANSITIONS_FORCEDISABLED, 1);
        if (Win11)
        {
            DwmSetInt(DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND);
            DwmSetInt(DWMWA_BORDER_COLOR, BorderColorRef);
        }
    }

    private async Task InitWebAsync()
    {
        // WebView2 deletes and rotates files inside its profile, so the profile must never be a
        // folder under ~/.pulse: ScratchPathOf moves it out when the home is ~/.pulse.
        var userData = AppPaths.ScratchPathOf("webview-strip");
        Directory.CreateDirectory(userData);
        var env = await CoreWebView2Environment.CreateAsync(null, userData);
        await _web.EnsureCoreWebView2Async(env);

        var core = _web.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        _web.DefaultBackgroundColor = Backdrop;

        // Skip the file's built-in sample payload; the host injects the real data.
        // In shots mode let the page render its own demo payload instead of suppressing it.
        if (!_sampleShots)
            await core.AddScriptToExecuteOnDocumentCreatedAsync("window.__NO_SAMPLE__ = true;");

        // Serve the web/ folder over a virtual host so the SVG icon masks resolve cleanly.
        // A web/ folder next to the exe wins (dev builds); otherwise the UI embedded in the
        // single-file exe is extracted to <home>/strip-web (the app's only writable location).
        var webDir = ResolveWebDir();
        core.SetVirtualHostNameToFolderMapping("burnglass.local", webDir,
            CoreWebView2HostResourceAccessKind.Allow);

        core.WebMessageReceived += OnWebMessage;
        core.NavigationCompleted += async (_, _) =>
        {
            _ready = true;
            // Dark-only; guarded in case the ported page drops setTheme entirely.
            try { await core.ExecuteScriptAsync("window.setTheme && window.setTheme('dark')"); } catch { }
            if (_sampleShots) { await CaptureSampleShots(); return; }
            if (_selfTest) { ShowPopover(); return; }
            // Opened before the page existed: the window is already up (sliding over the plain
            // backdrop); its content arrives now and plays its own part of the open.
            if (_pendingShow)
            {
                _pendingShow = false;
                if (Visible) { PrimeAsync(_openGen); PlayOpen(_motion); }
            }
        };

        // Cache-bust on the page's own mtime: WebView2 otherwise keeps serving a cached copy of
        // index.html after an update, so a new build's UI silently never appears.
        var indexPath = Path.Combine(webDir, "index.html");
        long version = File.Exists(indexPath) ? File.GetLastWriteTimeUtc(indexPath).Ticks : DateTime.UtcNow.Ticks;
        core.Navigate($"https://burnglass.local/index.html?v={version}");
    }

    private static string ResolveWebDir() => WebAssets.Dir;

    // The page posts its measured content height (CSS px) so the window hugs the content, and
    // {primed: n} once the first frame of open n is painted. Theme messages are ignored (dark-only).
    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return;
            if (root.TryGetProperty("height", out var h) && h.ValueKind == JsonValueKind.Number)
                SetContentHeight(h.GetDouble());
            if (root.TryGetProperty("primed", out var p) && p.ValueKind == JsonValueKind.Number
                && p.TryGetInt32(out int token))
                OnPrimed(token);
            // The popover footer's "Open dashboard →" link.
            if (root.TryGetProperty("open", out var o) && o.ValueKind == JsonValueKind.String
                && o.GetString() == "dashboard")
            {
                OnOpenDashboard?.Invoke();
                Hide();
            }
        }
        catch { /* ignore malformed messages */ }
    }

    public bool IsShown => Visible;

    public void Toggle()
    {
        if (Visible) { Hide(); return; }
        ShowPopover();
    }

    // ---- open motion: a Windows 11 flyout --------------------------------------------------------
    // 1. The window is placed at its FINAL size, SlideCss below its final spot, and shown CLOAKED
    //    (DWMWA_CLOAK: the window is "visible" to Windows — so WebView2 keeps rendering — but DWM does
    //    not put it on screen). The same script renders the cached data, returns the content height
    //    (the window is re-sized while still invisible) and holds the page on its first animation
    //    frame; two frames later the page posts {primed}. Without the cloak, the first frame on screen
    //    would be whatever the WebView painted before the LAST close.
    // 2. Reveal: un-cloak, then rise into place over SlideMs on the page's decelerate curve while the
    //    page fades its blocks in (playOpen). Position only — never a resize.
    // 3. Never invisible for long: no {primed} within RevealFallbackMs reveals anyway; twice in a row
    //    and this session stops cloaking (shows at once, the pre-rc.3 way).
    // Reduced motion (Windows "Animation effects" off): same priming, no slide, no page animation.
    // Close (Hide, from any path) is instant and resets all of it — see OnVisibleChanged.
    private const int SlideCss = 12;
    private const double SlideMs = 190;
    private const int RevealFallbackMs = 140;

    private readonly System.Windows.Forms.Timer _revealFallback;
    private readonly Action _slideTick;
    private readonly System.Diagnostics.Stopwatch _slideClock = new();
    private int _openGen;            // bumped by every open AND every close: stale callbacks compare it
    private volatile int _slideGen = -1; // the open whose slide is running (-1 = none)
    private int _tickQueued;         // 1 while a slide tick is queued on the UI thread
    private bool _revealed;          // this open is on screen
    private bool _opening;           // shown, and the slide has not finished yet (WatchFocus waits)
    private bool _cloaked;
    private bool _motion = true;
    private int _cloakMisses;
    private bool _cloakUnreliable;
    private int _slideOffset;        // physical px below the final Y the slide starts from
    private Rectangle _finalBounds;
    private Rectangle _workArea;     // the monitor this open is on (a re-target never follows the cursor)

    private void ShowPopover()
    {
        int gen = ++_openGen;
        _slideGen = -1;
        _revealFallback.Stop();
        _revealed = false;
        _opening = true;
        _hadFocus = false;
        _motion = !_selfTest && AnimationsEnabled();
        _workArea = Screen.FromPoint(Cursor.Position).WorkingArea;
        _finalBounds = ComputeFinalBounds();
        _slideOffset = _motion ? (int)MathF.Round(SlideCss * Dpi) : 0;
        PlaceWindow(_finalBounds.Y + _slideOffset);  // final size from here on; only the Y moves

        bool prime = _ready && !_selfTest && _web.CoreWebView2 != null;
        _cloaked = prime && !_cloakUnreliable && SetCloak(true);
        _shownAt = DateTime.UtcNow;
        Show();
        TopMost = true;
        Activate();
        NativeActivate();
        _focusWatch.Start();

        if (_selfTest) { Reveal(gen); RefreshFromServer(); return; } // selftest fetches its own data
        if (!prime) { _pendingShow = true; Reveal(gen); return; }   // page not loaded yet: see NavigationCompleted
        // Render the last-known data INSTANTLY — stale-while-revalidate. The host triggers a
        // background refresh separately, which calls SetData again when fresh data arrives.
        PrimeAsync(gen);
        if (_cloaked) _revealFallback.Start();
        else Reveal(gen); // no cloak: on screen right away (the page may show its previous frame once)
    }

    private async void PrimeAsync(int gen)
    {
        // SafeJson: see Inject. The page returns its content height; an older page without
        // primeOpen still renders and measures (and the fallback timer reveals it).
        string script =
            "(function(){try{window.renderData(" + AppHost.SafeJson(_data) + ");}catch(e){}" +
            "var h=0;try{if(window.primeOpen)h=window.primeOpen(" + gen + "," + (_motion ? "true" : "false") + ");}catch(e){}" +
            "return h||Math.min(document.body.scrollHeight," + MaxHeight + ");})()";
        string? result = null;
        try
        {
            var core = _web.CoreWebView2;
            if (core == null) return;
            result = await core.ExecuteScriptAsync(script);
        }
        catch { }
        if (gen != _openGen || !Visible) return; // closed (or re-opened) meanwhile
        if (double.TryParse(result, NumberStyles.Float, CultureInfo.InvariantCulture, out double h) && h > 0)
            SetContentHeight(h);
    }

    private void OnPrimed(int token)
    {
        if (token != _openGen || _revealed) return;
        _cloakMisses = 0;
        Reveal(token);
    }

    private void RevealFallback()
    {
        _revealFallback.Stop();
        if (_revealed || !Visible) return;
        // A cloaked page that never reports its first frame (it may not render while cloaked on some
        // WebView2 builds): stop paying this wait on every open.
        if (_cloaked && ++_cloakMisses >= 2) _cloakUnreliable = true;
        Reveal(_openGen);
    }

    private void Reveal(int gen)
    {
        if (gen != _openGen || _revealed || !Visible) return;
        _revealed = true;
        _revealFallback.Stop();
        if (_cloaked) { SetCloak(false); _cloaked = false; }
        _shownAt = DateTime.UtcNow;
        // Activation normally took at Show(); if Windows refused it for the cloaked window, take it
        // now (still inside the click's foreground grant) — click-away closing depends on it.
        if (GetForegroundWindow() != Handle) { Activate(); NativeActivate(); }
        if (_slideOffset > 0) StartSlide(gen);
        else { PlaceWindow(_finalBounds.Y); _opening = false; }
        if (_ready && _web.CoreWebView2 != null) PlayOpen(_motion);
    }

    // Closed — instantly, from any path (click-away, strip click, the dashboard link, WatchFocus).
    // Invalidate this open's prime/reveal/slide and put the page back to its resting state, so the
    // next open starts clean however quickly it follows.
    protected override void OnVisibleChanged(EventArgs e)
    {
        base.OnVisibleChanged(e);
        if (Visible) return;
        _openGen++;
        _slideGen = -1;
        _revealFallback.Stop();
        _revealed = false;
        _opening = false;
        if (_cloaked) { SetCloak(false); _cloaked = false; } // hidden already, so this shows nothing
        ResetPage();
    }

    private async void ResetPage()
    {
        try
        {
            if (!_ready || IsDisposed || _web.CoreWebView2 == null) return;
            await _web.CoreWebView2.ExecuteScriptAsync("window.resetOpen && window.resetOpen()");
        }
        catch { /* shutting down */ }
    }

    private void StartSlide(int gen)
    {
        _slideClock.Restart();
        _slideGen = gen;
        PlaceWindow(SlideY(0));
        var ticker = new Thread(() => VsyncTicker(gen))
        {
            IsBackground = true,
            Name = "popover-slide",
            Priority = ThreadPriority.AboveNormal
        };
        ticker.Start();
    }

    // Background thread: wakes once per DWM composition (DwmFlush) and queues ONE slide tick on the UI
    // thread, which owns the window and computes the position from the Stopwatch. So the slide is
    // frame-synced (60/120/144 Hz alike), time-based (a busy frame is skipped, never stretched), and
    // a close, a re-open or a height re-target is honoured on the very next frame — no stale moves
    // from another thread (SetWindowPos from here could land after a newer resize).
    private void VsyncTicker(int gen)
    {
        var life = System.Diagnostics.Stopwatch.StartNew();
        double last = 0;
        while (_slideGen == gen && life.Elapsed.TotalMilliseconds < SlideMs + 500)
        {
            int hr;
            try { hr = DwmFlush(); } catch { hr = -1; }
            double now = life.Elapsed.TotalMilliseconds;
            // No composition clock (RDP, a failure, or an idle desktop answering at once): pace ~6 ms.
            if (hr < 0 || now - last < 3) { Thread.Sleep(6); now = life.Elapsed.TotalMilliseconds; }
            last = now;
            if (_slideGen != gen) break;
            if (Interlocked.Exchange(ref _tickQueued, 1) == 0)
            {
                try { BeginInvoke(_slideTick); }
                catch { Interlocked.Exchange(ref _tickQueued, 0); break; } // handle gone (exiting)
            }
        }
    }

    private void SlideTick()
    {
        Interlocked.Exchange(ref _tickQueued, 0);
        int gen = _slideGen;
        if (gen < 0 || gen != _openGen) return;
        double t = SlideProgress();
        PlaceWindow(SlideY(t));
        if (t >= 1) { _slideGen = -1; _opening = false; }
    }

    private double SlideProgress() => Math.Min(1.0, _slideClock.Elapsed.TotalMilliseconds / SlideMs);

    private int SlideY(double t) =>
        _finalBounds.Y + (int)Math.Round(_slideOffset * (1 - OpenMotion.Ease(t)));

    // Where the window belongs right now: still cloaked, the slide's start; mid-slide, the same
    // progress towards the (new) target; otherwise the target itself.
    private int CurrentY()
    {
        if (!_revealed) return _finalBounds.Y + _slideOffset;
        int gen = _slideGen;
        return gen >= 0 && gen == _openGen ? SlideY(SlideProgress()) : _finalBounds.Y;
    }

    // Moves the window — and, when the target size changed, resizes it — in ONE SetWindowPos, so no
    // frame ever shows the new size at the old place. Z-order and activation are left alone.
    private void PlaceWindow(int y)
    {
        var b = _finalBounds;
        if (!IsHandleCreated) { Bounds = new Rectangle(b.X, y, b.Width, b.Height); return; }
        bool sameSize = Width == b.Width && Height == b.Height;
        if (sameSize && Left == b.X && Top == y) return;
        SetWindowPos(Handle, IntPtr.Zero, b.X, y, b.Width, b.Height,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER | (sameSize ? SWP_NOSIZE : 0));
    }

    // A new content height (the prime's measurement, a re-render, a tab switch): re-target at once —
    // one step, no resize animation. The bottom edge (nearest the strip) stays where it is, or keeps
    // sliding on its curve, so the change never reads as a jump of the panel.
    private void SetContentHeight(double cssHeight)
    {
        if (double.IsNaN(cssHeight) || cssHeight <= 0) return;
        _lastHeightCss = Math.Max(1, (int)Math.Ceiling(Math.Min(cssHeight, MaxHeight)));
        if (!Visible) return; // the next open sizes from _lastHeightCss
        var f = ComputeFinalBounds();
        if (f == _finalBounds) return;
        _finalBounds = f;
        PlaceWindow(CurrentY());
    }

    // Opened on a monitor with another scale: WinForms has just applied Windows' suggested rectangle;
    // put the box back where this open wants it, sized for the new DPI (the slide keeps its progress).
    protected override void OnDpiChanged(DpiChangedEventArgs e)
    {
        base.OnDpiChanged(e);
        if (_finalBounds.IsEmpty || _sampleShots) return;
        if (_slideOffset > 0) _slideOffset = (int)MathF.Round(SlideCss * Dpi);
        _finalBounds = ComputeFinalBounds();
        PlaceWindow(CurrentY());
    }

    private Rectangle ComputeFinalBounds()
    {
        var wa = WorkArea();
        int minH = (int)MathF.Round(MinHeightCss * Dpi);
        int h = Math.Clamp((int)MathF.Round(_lastHeightCss * Dpi), minH, Math.Max(minH, MaxScreenHeight()));
        int x = Math.Max(wa.Left + Margin_, wa.Right - W - Margin_);
        int y = Math.Max(wa.Top + Margin_, wa.Bottom - h - Margin_);
        return new Rectangle(x, y, W, h);
    }

    private Rectangle WorkArea() =>
        _workArea.IsEmpty ? Screen.FromPoint(Cursor.Position).WorkingArea : _workArea;

    // Windows' "Animation effects" setting (Settings → Accessibility → Visual effects). WebView2 maps
    // the same switch to prefers-reduced-motion inside the page; the host passes its answer too.
    private static bool AnimationsEnabled()
    {
        try { return !SystemParametersInfo(SPI_GETCLIENTAREAANIMATION, 0, out int on, 0) || on != 0; }
        catch { return true; }
    }

    private bool SetCloak(bool on)
    {
        try
        {
            int v = on ? 1 : 0;
            return DwmSetWindowAttribute(Handle, DWMWA_CLOAK, ref v, sizeof(int)) >= 0;
        }
        catch { return false; }
    }

    private void DwmSetInt(int attribute, int value)
    {
        try { DwmSetWindowAttribute(Handle, attribute, ref value, sizeof(int)); } catch { }
    }

    private string _data = "[]";

    /// Feed the popover the latest payload (from the host's shared fetch). Re-renders live if visible.
    public void SetData(string json)
    {
        _data = string.IsNullOrWhiteSpace(json) ? "[]" : json;
        if (_ready && Visible) Inject(_data);
    }

    /// Render the page's built-in demo payload to a PNG for the README, sized to the full content so
    /// nothing is cut off. Never touches real provider data. Dark-only (the popover has no light theme).
    private async Task CaptureSampleShots()
    {
        var core = _web.CoreWebView2;
        // The home is the only location the app writes to — never beside the exe
        // (which may be Program Files, or the read-only single-file extraction dir).
        var outDir = AppPaths.PathOf("shots");
        Directory.CreateDirectory(outDir);

        await core.ExecuteScriptAsync("window.setTheme && window.setTheme('dark')");
        await Task.Delay(500);                                  // let the theme + layout settle
        var h = await core.ExecuteScriptAsync("document.body.scrollHeight");
        int height = int.TryParse(h?.Trim('"'), out var v) ? v : 900;
        _finalBounds = new Rectangle(0, 0, WidthCss, height);
        base.SetBounds(0, 0, WidthCss, height, BoundsSpecified.All);
        Show();
        await Task.Delay(600);                                  // let the page settle
        using (var fs = File.Create(Path.Combine(outDir, "popover.png")))
            await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, fs);
        Application.Exit();
    }

    /// Start the page's part of the open (see "open motion" above); motion=false shows it at rest.
    private async void PlayOpen(bool motion)
    {
        try
        {
            if (_web.CoreWebView2 == null) return;
            await _web.CoreWebView2.ExecuteScriptAsync(
                "window.playOpen && window.playOpen(" + (motion ? "true" : "false") + ")");
        }
        catch { }
    }

    /// Fetch + transform a fresh summary on a background thread and inject it (selftest path; the
    /// AppHost owns fetching in normal operation).
    public void RefreshFromServer()
    {
        if (!_ready) { _pendingShow = true; return; }
        Task.Run(() =>
        {
            string? summary = ServerApi.FetchSummary();
            string payload = summary is null ? "[]" : SummaryTransform.ToUi(summary);
            try { BeginInvoke(() => Inject(payload)); } catch { }
        });
    }

    private async void Inject(string payload)
    {
        if (_web.CoreWebView2 == null) return;
        // Re-serialize through the JSON parser before it becomes part of a script
        // string: a truncated write or a planted <home>/strip-ui.json would
        // otherwise be concatenated straight into an eval. Then report height (CSS px).
        string safe = AppHost.SafeJson(payload);
        string script =
            "try{window.renderData(" + safe + ");}catch(e){}" +
            "window.chrome.webview.postMessage({height: window.contentHeight ? window.contentHeight()" +
            " : Math.min(document.body.scrollHeight, " + MaxHeight + ")});";
        try { await _web.CoreWebView2.ExecuteScriptAsync(script); } catch { }

        if (_selfTest)
        {
            string probe = await _web.CoreWebView2.ExecuteScriptAsync(
                "JSON.stringify({sections:document.querySelectorAll('.section').length," +
                "meters:document.querySelectorAll('.meter').length," +
                "spend:!!document.querySelector('.spend')," +
                "center:(document.querySelector('.donut .center')||{}).textContent||null," +
                "height:document.body.scrollHeight,textLen:document.body.innerText.length})");
            try
            {
                File.WriteAllText(Path.Combine(Path.GetTempPath(), "burnglass_strip_selftest.json"),
                    probe ?? "null");
                // Capture what the WebView actually paints, so the popover can be inspected headlessly.
                var png = Path.Combine(Path.GetTempPath(), "burnglass_strip_selftest.png");
                using (var fs = File.Create(png))
                {
                    await _web.CoreWebView2.CapturePreviewAsync(
                        CoreWebView2CapturePreviewImageFormat.Png, fs);
                }
            }
            catch { }
            Application.Exit();
        }
    }

    private int MaxScreenHeight()
    {
        var wa = WorkArea();
        return Math.Min((int)MathF.Round(MaxHeight * Dpi), wa.Height - 2 * Margin_);
    }

    // Windows 10 only: clip to a rounded rectangle (aliased — GDI regions cannot anti-alias). On
    // Windows 11 a region would switch DWM's own rounding, border and shadow OFF, so none is set.
    private Size _regionSize;
    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        if (Win11 || Size == _regionSize || Width <= 0 || Height <= 0) return;
        _regionSize = Size;
        ApplyRoundedRegion();
    }

    private void ApplyRoundedRegion()
    {
        using var path = new GraphicsPath();
        int r = Math.Max(2, (int)MathF.Round(RadiusCss * Dpi));
        var rect = new Rectangle(0, 0, Width, Height);
        path.AddArc(rect.X, rect.Y, r, r, 180, 90);
        path.AddArc(rect.Right - r, rect.Y, r, r, 270, 90);
        path.AddArc(rect.Right - r, rect.Bottom - r, r, r, 0, 90);
        path.AddArc(rect.X, rect.Bottom - r, r, r, 90, 90);
        path.CloseFigure();
        Region = new Region(path); // the setter disposes the previous region
    }

    protected override CreateParams CreateParams
    {
        get
        {
            const int CS_DROPSHADOW = 0x20000;
            const int WS_EX_TOOLWINDOW = 0x80; // keep it out of Alt-Tab
            var cp = base.CreateParams;
            // Windows 10: the legacy class shadow, a soft drop shadow for the borderless window.
            // Windows 11: DWM's own flyout shadow instead — the class shadow is a separate SQUARE
            // window that ignores the rounded corners.
            if (!Win11) cp.ClassStyle |= CS_DROPSHADOW;
            cp.ExStyle |= WS_EX_TOOLWINDOW;
            return cp;
        }
    }

    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW")]
    private static extern bool SystemParametersInfo(uint action, uint param, out int value, uint winIni);
    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hWnd, int attribute, ref int value, int size);
    [DllImport("dwmapi.dll")] private static extern int DwmFlush();
    private const uint SWP_NOSIZE = 0x0001, SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010, SWP_NOOWNERZORDER = 0x0200;
    private const uint SPI_GETCLIENTAREAANIMATION = 0x1042;
    private const int DWMWA_TRANSITIONS_FORCEDISABLED = 3, DWMWA_CLOAK = 13;
    private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33, DWMWA_BORDER_COLOR = 34, DWMWCP_ROUND = 2;
    private void NativeActivate() => SetForegroundWindow(Handle);

    private readonly System.Windows.Forms.Timer _focusWatch;
    private DateTime _shownAt;
    private bool _hadFocus;

    /// Hide once focus has actually moved to a different application. Waits until the popover has held
    /// focus at least once, so it can never slam shut during the open animation.
    private void WatchFocus()
    {
        if (!Visible) { _focusWatch.Stop(); return; }
        if (!_revealed || _opening) return;

        IntPtr foreground = GetForegroundWindow();
        if (foreground == Handle) { _hadFocus = true; return; }

        // Our own other windows (the strip, its context menu) must not close it — the strip's own
        // click handler owns that.
        GetWindowThreadProcessId(foreground, out uint pid);
        if (pid == (uint)Environment.ProcessId) return;

        if (_hadFocus) Hide();
    }
}

/// The popover's open-motion curve. The window's rise (PopoverForm's slide) uses the SAME
/// cubic-bezier as the page's --ease-decel (web/index.html, Fluent "decelerate max"), so the window
/// and its content decelerate together; test/packaging.test.sh compares this solver against
/// Chromium's own evaluation of the page's curve.
static class OpenMotion
{
    public const double X1 = 0.1, Y1 = 0.9, X2 = 0.2, Y2 = 1.0;

    public static double Ease(double t) => CubicBezier(X1, Y1, X2, Y2, t);

    /// CSS cubic-bezier(x1, y1, x2, y2) at time x in [0, 1] (Newton, bisection fallback).
    public static double CubicBezier(double x1, double y1, double x2, double y2, double x)
    {
        if (double.IsNaN(x) || x <= 0) return 0;
        if (x >= 1) return 1;
        static double B(double a, double b, double s) => 3 * a * (1 - s) * (1 - s) * s + 3 * b * (1 - s) * s * s + s * s * s;
        static double D(double a, double b, double s) => 3 * a * (1 - s) * (1 - s) + 6 * (b - a) * (1 - s) * s + 3 * (1 - b) * s * s;
        double s = x;
        for (int i = 0; i < 8; i++)
        {
            double err = B(x1, x2, s) - x;
            if (Math.Abs(err) < 1e-7) return B(y1, y2, s);
            double d = D(x1, x2, s);
            if (Math.Abs(d) < 1e-6) break;
            s -= err / d;
            if (s < 0 || s > 1) break;
        }
        double lo = 0, hi = 1;
        s = x;
        for (int i = 0; i < 50; i++)
        {
            double v = B(x1, x2, s);
            if (Math.Abs(v - x) < 1e-7) break;
            if (v < x) lo = s; else hi = s;
            s = (lo + hi) / 2;
        }
        return B(y1, y2, s);
    }
}

/// Keeps usage meters on screen at ALL times. A refresh can come back with spend rows but no
/// `progress` (meter) lines — e.g. the account meters are momentarily rate-limited or mid-recheck —
/// and without this the Session/Weekly bars would just vanish. This carries the last-known meters
/// forward into such a payload (stale-while-revalidate), so the bars stay visible until real values
/// return. Operates on the {providers, errors} wrapper form only (our transformer always emits it).
static class UsageMerge
{
    public static string Merge(string previousJson, string currentJson)
    {
        try
        {
            var current = JsonNode.Parse(currentJson);
            var previous = JsonNode.Parse(previousJson);
            var currentProviders = current?["providers"]?.AsArray();
            var previousProviders = previous?["providers"]?.AsArray();
            if (currentProviders is null || previousProviders is null) return currentJson;

            foreach (var providerNode in currentProviders)
            {
                var id = providerNode?["providerId"]?.GetValue<string>();
                var lines = providerNode?["lines"]?.AsArray();
                if (id is null || lines is null) continue;
                if (lines.Any(l => l?["type"]?.GetValue<string>() == "progress")) continue; // already has meters

                var previousLines = previousProviders
                    .FirstOrDefault(p => p?["providerId"]?.GetValue<string>() == id)?["lines"]?.AsArray();
                if (previousLines is null) continue;

                // Carry forward only meters that are still MEANINGFUL. A window whose
                // resetsAt has passed has rolled over — the transformer dropped it on
                // purpose (the server marks those buckets stale, Claude's and Codex's
                // alike, and ToUi skips them), and re-inserting it here
                // would chain a dead percentage forward through every later refresh and
                // across restarts, rendering "Resets in 1m" forever.
                var carried = previousLines
                    .Where(l => l?["type"]?.GetValue<string>() == "progress" && !MeterExpired(l))
                    .Select(l => l!.ToJsonString())
                    .ToList();
                // Meters lead the card, so re-insert them at the front in their original order.
                for (int i = carried.Count - 1; i >= 0; i--) lines.Insert(0, JsonNode.Parse(carried[i]));
            }
            return current!.ToJsonString();
        }
        catch { return currentJson; }
    }

    // True when the line carries a resetsAt that is already in the past. A line with no
    // resetsAt is never treated as expired — absence of a reset time is not evidence of
    // staleness, and dropping those would blank meters the transformer meant to keep.
    private static bool MeterExpired(JsonNode? line)
    {
        try
        {
            var raw = line?["resetsAt"]?.GetValue<string>();
            if (string.IsNullOrEmpty(raw)) return false;
            return DateTimeOffset.TryParse(raw, CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var when)
                && when <= DateTimeOffset.UtcNow;
        }
        catch { return false; }
    }
}

// Shared web-asset resolution: the popover serves WebAssets.Dir over the virtual host and the
// STRIP draws its provider glyphs from WebAssets.IconsDir — both must agree, especially in the
// single-file exe where nothing exists beside the binary.
static class WebAssets
{
    public static readonly string Dir = Resolve();
    public static string IconsDir => Path.Combine(Dir, "icons");

    /// Left in every folder the strip extracts into: a magic first line, then each file the strip
    /// wrote there ('/'-separated, relative). Removing what an older build shipped deletes ONLY
    /// paths listed here, one file at a time: never a folder, never a file the strip did not write.
    /// A folder without this manifest (a Pulse-era or pre-manifest strip-web, anything a user put
    /// beside the UI) is only ever written into.
    internal const string ManifestName = ".burnglass-strip-web";
    private const string ManifestMagic = "BURNGLASS-STRIP-WEB 1";

    // Dev layout (web/ beside the exe) wins; the shipped single-file exe extracts its embedded
    // web/** resources on every launch (tiny — overwrite keeps it current across updates without
    // a version dance) to <home>/strip-web, or, when the home is ~/.pulse, to the temp folder
    // ScratchPathOf picks, so nothing under ~/.pulse is rewritten or deleted for it.
    private static string Resolve()
    {
        var local = Path.Combine(AppContext.BaseDirectory, "web");
        try { if (File.Exists(Path.Combine(local, "index.html"))) return local; } catch { }
        var target = AppPaths.ScratchPathOf("strip-web");
        try
        {
            var asm = System.Reflection.Assembly.GetExecutingAssembly();
            var shipped = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var name in asm.GetManifestResourceNames())
            {
                if (!name.StartsWith("web/", StringComparison.Ordinal)) continue;
                // %(RecursiveDir) in the csproj uses the BUILD machine's separator: accept both.
                shipped[name.Substring(4).Replace('\\', '/')] = name;
            }
            Extract(target, shipped.Keys.ToList(), rel => asm.GetManifestResourceStream(shipped[rel])!);
        }
        catch { /* fall through — a previous extraction may still exist */ }
        return target;
    }

    /// Writes every shipped file into target, then removes the files an earlier launch listed in
    /// target's manifest that this build no longer ships (they would otherwise linger beside the new
    /// ones and be served over the virtual host), and rewrites the manifest.
    internal static void Extract(string target, IReadOnlyList<string> shipped, Func<string, Stream> open)
    {
        Directory.CreateDirectory(target);
        string manifest = Path.Combine(target, ManifestName);
        List<string>? listed = ReadManifest(manifest); // null: not a folder this strip marked
        var ship = new HashSet<string>(shipped, StringComparer.OrdinalIgnoreCase);
        var own = new List<string>();                  // what the new manifest lists
        foreach (var rel in shipped)
        {
            // Per-file try: one unwritable file (locked, read-only) must not
            // abort the extraction and leave the rest of the UI missing.
            try
            {
                string? dest = FileUnder(target, rel);
                if (dest is null) continue;
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                using (var src = open(rel))
                using (var dst = File.Create(dest))
                    src.CopyTo(dst);
                own.Add(rel);
            }
            catch
            {
                // Not rewritten this time, but still ours if an earlier launch wrote it.
                if (listed != null && listed.Contains(rel, StringComparer.OrdinalIgnoreCase)) own.Add(rel);
            }
        }
        if (listed != null)
            foreach (var rel in listed)
                if (!ship.Contains(rel) && !DeleteOwnFile(target, rel)) own.Add(rel); // retry next launch
        try { File.WriteAllText(manifest, ManifestMagic + "\n" + string.Join("\n", own) + "\n"); } catch { }
    }

    private static List<string>? ReadManifest(string file)
    {
        try
        {
            var info = new FileInfo(file);
            if (!info.Exists || info.Length > 256 * 1024) return null;
            var lines = File.ReadAllLines(file);
            if (lines.Length == 0 || lines[0].Trim() != ManifestMagic) return null;
            return lines.Skip(1).Select(l => l.Trim().Replace('\\', '/')).Where(l => l.Length > 0)
                .Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        }
        catch { return null; }
    }

    // target/rel when rel is a plain relative path that stays inside target, else null (a listed
    // "..\x", a rooted path, a drive or stream colon is never a file the strip wrote).
    private static string? FileUnder(string target, string rel)
    {
        if (string.IsNullOrWhiteSpace(rel) || rel.IndexOf('\0') >= 0 || Path.IsPathRooted(rel)) return null;
        var parts = rel.Split('/', '\\');
        if (parts.Any(p => p.Length == 0 || p == "." || p == ".." || p.Contains(':'))) return null;
        string root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(target));
        string full = Path.GetFullPath(Path.Combine(root, Path.Combine(parts)));
        return full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ? full : null;
    }

    // Deletes the listed FILE target/rel, never following a link or junction below target. True
    // when there is nothing left to track (deleted, already gone, or not a plain file of ours).
    private static bool DeleteOwnFile(string target, string rel)
    {
        string? full = FileUnder(target, rel);
        if (full is null) return true;
        try
        {
            string root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(target));
            for (var dir = Path.GetDirectoryName(full); dir != null && dir.Length > root.Length; dir = Path.GetDirectoryName(dir))
                if (Directory.Exists(dir) && File.GetAttributes(dir).HasFlag(FileAttributes.ReparsePoint)) return true;
            if (Directory.Exists(full)) return true;
            if (File.Exists(full)) File.Delete(full);
            return !File.Exists(full);
        }
        catch { return false; }
    }
}
