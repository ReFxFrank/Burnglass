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
/// Nothing under ~/.pulse is ever deleted by the strip.
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
    }

    public static bool HomeIsLegacy => !Pinned && SamePath(Home, LegacyHome);

    /// Where a state file is written.
    public static string PathOf(string name) => Path.Combine(Home, name);

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

/// Transforms the server's /api/summary JSON into the providers[] schema the ported popover page and
/// StripForm consume (ui-schema.md). Sources are classified: 'codex' → Codex; gemini/cline/roo/
/// continue → their own providers; everything else (cli, claude-desktop, unknown, …) → Claude.
/// Never throws — any parse trouble yields an empty wrapper.
static class SummaryTransform
{
    private static readonly string[] AgentSources = { "gemini", "cline", "roo", "continue" };
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

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
        if (hasLast30 && last30.TryGetProperty("bySource", out var bys) && bys.ValueKind == JsonValueKind.Object)
            foreach (var prop in bys.EnumerateObject())
            {
                string cls = Classify(prop.Name);
                Bump(cost30, cls, Num(prop.Value, "cost"));
                Bump(tokens30, cls, Num(prop.Value, "tokens"));
            }

        // daily[] buckets: {date:'YYYY-MM-DD', total, tokens, bySource:{src:cost}} — last bucket is today.
        var daily = new List<(string Date, Dictionary<string, double> ByClass)>();
        if (hasLast30 && last30.TryGetProperty("daily", out var dl) && dl.ValueKind == JsonValueKind.Array)
            foreach (var b in dl.EnumerateArray())
            {
                var byClass = new Dictionary<string, double>();
                if (b.TryGetProperty("bySource", out var bsx) && bsx.ValueKind == JsonValueKind.Object)
                    foreach (var prop in bsx.EnumerateObject())
                        if (prop.Value.ValueKind == JsonValueKind.Number)
                            Bump(byClass, Classify(prop.Name), prop.Value.GetDouble());
                string date = b.TryGetProperty("date", out var dt) ? dt.GetString() ?? "" : "";
                daily.Add((date, byClass));
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
                    string key = b.TryGetProperty("key", out var kk) ? kk.GetString() ?? "" : "";
                    double pct = Num(b, "pct");
                    long? resetsAt = Millis(b, "resetsAt");
                    string label;
                    long period;
                    if (key == "five_hour") { label = "Session"; period = 18_000_000; }               // 5h
                    else if (key == "seven_day" || key == "seven_day_overall") { label = "Weekly"; period = 604_800_000; }
                    else { label = ScopedLabel(b); period = 604_800_000; }                            // per-model weekly
                    claudeProgress.Add(Progress(label, pct, resetsAt, period));
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
                codexProgress.Add(Progress(label, pct, resetsAt, period));
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

        return new JsonObject { ["providers"] = providers, ["errors"] = errors }
            .ToJsonString(new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
    }

    private static JsonObject Provider(string id, string name, JsonArray lines) => new()
    {
        ["providerId"] = id,
        ["displayName"] = name,
        ["fetchedAt"] = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", Inv),
        ["lines"] = lines,
    };

    // format.kind:"percent" is REQUIRED — StripForm only counts progress lines carrying it.
    private static JsonObject Progress(string label, double usedPct, long? resetsAtMs, long periodMs)
    {
        var o = new JsonObject
        {
            ["label"] = label,
            ["type"] = "progress",
            ["used"] = (int)Math.Round(Math.Clamp(usedPct, 0, 100)),
            ["limit"] = 100,
            ["format"] = new JsonObject { ["kind"] = "percent" },
            ["periodDurationMs"] = periodMs,
        };
        if (resetsAtMs is long ms)
            o["resetsAt"] = DateTimeOffset.FromUnixTimeMilliseconds(ms).UtcDateTime
                .ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", Inv);
        return o;
    }

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
    private const int RadiusCss = 20;

    private float Dpi => DeviceDpi / 96f;
    private int W => (int)MathF.Round(WidthCss * Dpi);
    private int Margin_ => (int)MathF.Round(MarginCss * Dpi);

    // Popover backdrop = the page's own background (--tray in web/index.html, the Command Center
    // dark --bg #0a0b0f), so the spring-open never flashes a mismatched box. Dark-only.
    private static readonly Color Backdrop = Color.FromArgb(0x0a, 0x0b, 0x0f);

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

        // NOT docked: the WebView keeps a FIXED size and stays pinned to the window's bottom-right while
        // the window itself grows during the open animation. That way the whole panel (background +
        // rounded corners + content) scales out of the corner instead of the background popping in at
        // full size, and the page never reflows mid-animation.
        _web.Dock = DockStyle.None;
        Controls.Add(_web);
        // Click-away close. Only ignore deactivation for a brief moment right after showing (the
        // show/resize can fire a spurious one); ignoring it for the whole grow animation meant a
        // deactivation landing mid-animation was swallowed and the popover then never closed at all.
        Deactivate += (_, _) =>
        {
            if ((DateTime.UtcNow - _shownAt).TotalMilliseconds > 250) Hide();
        };

        _grow = new System.Windows.Forms.Timer { Interval = 16 };
        _grow.Tick += (_, _) => GrowTick();

        // Safety net: if the popover somehow never receives a Deactivate (a borderless tool window
        // doesn't always), close it once focus has demonstrably moved to another application.
        _focusWatch = new System.Windows.Forms.Timer { Interval = 250 };
        _focusWatch.Tick += (_, _) => WatchFocus();

        _ = InitWebAsync();
    }

    protected override bool ShowWithoutActivation => false;

    private async Task InitWebAsync()
    {
        var userData = AppPaths.PathOf("webview-strip");
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
            if (_pendingShow) { _pendingShow = false; Inject(_data); }
        };

        // Cache-bust on the page's own mtime: WebView2 otherwise keeps serving a cached copy of
        // index.html after an update, so a new build's UI silently never appears.
        var indexPath = Path.Combine(webDir, "index.html");
        long version = File.Exists(indexPath) ? File.GetLastWriteTimeUtc(indexPath).Ticks : DateTime.UtcNow.Ticks;
        core.Navigate($"https://burnglass.local/index.html?v={version}");
    }

    private static string ResolveWebDir() => WebAssets.Dir;

    // The page posts its measured content height (CSS px) so the window hugs the content. Multiply by
    // the DPI scale BEFORE clamping — the clamp bounds are physical px. Theme messages are ignored
    // (dark-only).
    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            var json = e.WebMessageAsJson;
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.TryGetProperty("height", out var h))
            {
                _lastHeightCss = Math.Max(1, (int)Math.Ceiling(h.GetDouble()));
                // Re-target the final bounds. While the open animation is still running it will land on
                // the new size by itself; otherwise snap straight to it.
                _finalBounds = ComputeFinalBounds();
                _web.Size = new Size(_finalBounds.Width, _finalBounds.Height);
                if (!_growing) ApplyGrow(1f);
            }
            // The popover footer's "Open dashboard →" link.
            if (doc.RootElement.TryGetProperty("open", out var o) && o.GetString() == "dashboard")
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

    private void ShowPopover()
    {
        _finalBounds = ComputeFinalBounds();
        _web.Size = new Size(_finalBounds.Width, _finalBounds.Height);
        _shownAt = DateTime.UtcNow;
        _hadFocus = false;
        StartGrow();                 // window starts small at the corner and grows to _finalBounds
        Show();
        _focusWatch.Start();
        TopMost = true;
        Activate();
        NativeActivate();
        PlayOpen();
        // Render the last-known data INSTANTLY — stale-while-revalidate. The host triggers a
        // background refresh separately, which calls SetData again when fresh data arrives.
        if (_selfTest) { RefreshFromServer(); return; } // selftest fetches its own data
        if (_ready) Inject(_data);
        else _pendingShow = true;
    }

    // ---- open animation: the WHOLE window (background, rounded corners and all) scales out of the
    // bottom-right corner, so nothing pops in at full size. Runs in lockstep with the page's CSS spring.
    private readonly System.Windows.Forms.Timer _grow;
    private bool _growing;
    private float _growT;
    private Rectangle _finalBounds;
    private const float GrowStart = 0.55f;
    private const float GrowMs = 440f;

    private Rectangle ComputeFinalBounds()
    {
        var wa = Screen.FromPoint(Cursor.Position).WorkingArea;
        int h = Math.Clamp((int)MathF.Round(_lastHeightCss * Dpi), (int)MathF.Round(MinHeightCss * Dpi), MaxScreenHeight());
        int x = Math.Max(wa.Left + Margin_, wa.Right - W - Margin_);
        int y = Math.Max(wa.Top + Margin_, wa.Bottom - h - Margin_);
        return new Rectangle(x, y, W, h);
    }

    private void StartGrow()
    {
        _growing = true;
        _growT = 0f;
        ApplyGrow(GrowStart);
        _grow.Start();
    }

    private void GrowTick()
    {
        _growT += 16f / GrowMs;
        if (_growT >= 1f) { _growT = 1f; _growing = false; _grow.Stop(); }
        float e = 1f - (float)Math.Pow(1 - _growT, 5); // easeOutQuint ≈ the page's cubic-bezier(.16,1,.3,1)
        ApplyGrow(GrowStart + (1f - GrowStart) * e);
    }

    private void ApplyGrow(float scale)
    {
        int w = Math.Max(8, (int)(_finalBounds.Width * scale));
        int h = Math.Max(8, (int)(_finalBounds.Height * scale));
        // Pin the bottom-right corner (nearest the strip) so it grows outward from there.
        base.SetBounds(_finalBounds.Right - w, _finalBounds.Bottom - h, w, h, BoundsSpecified.All);
        // Keep the fixed-size WebView glued to that same corner so the page never reflows.
        _web.Location = new Point(ClientSize.Width - _finalBounds.Width, ClientSize.Height - _finalBounds.Height);
        ApplyRoundedRegion();
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
        _web.Size = new Size(WidthCss, height);
        base.SetBounds(0, 0, WidthCss, height, BoundsSpecified.All);
        _web.Location = new Point(0, 0);
        Show();
        await Task.Delay(600);                                  // let entrance animations finish
        using (var fs = File.Create(Path.Combine(outDir, "popover.png")))
            await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, fs);
        Application.Exit();
    }

    /// Replay the spring-open animation inside the page each time the popover is shown.
    private async void PlayOpen()
    {
        if (_web.CoreWebView2 == null) return;
        try { await _web.CoreWebView2.ExecuteScriptAsync("window.playOpen && window.playOpen()"); } catch { }
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
            "window.chrome.webview.postMessage({height: Math.min(document.body.scrollHeight, " + MaxHeight + ")});";
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
        var wa = Screen.FromPoint(Cursor.Position).WorkingArea;
        return Math.Min((int)MathF.Round(MaxHeight * Dpi), wa.Height - 2 * Margin_);
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
        Region = new Region(path);
    }

    // Give the borderless window a soft drop shadow, like the floating macOS panel.
    protected override CreateParams CreateParams
    {
        get
        {
            const int CS_DROPSHADOW = 0x20000;
            const int WS_EX_TOOLWINDOW = 0x80; // keep it out of Alt-Tab
            var cp = base.CreateParams;
            cp.ClassStyle |= CS_DROPSHADOW;
            cp.ExStyle |= WS_EX_TOOLWINDOW;
            return cp;
        }
    }

    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    private void NativeActivate() => SetForegroundWindow(Handle);

    private readonly System.Windows.Forms.Timer _focusWatch;
    private DateTime _shownAt;
    private bool _hadFocus;

    /// Hide once focus has actually moved to a different application. Waits until the popover has held
    /// focus at least once, so it can never slam shut during the open animation.
    private void WatchFocus()
    {
        if (!Visible) { _focusWatch.Stop(); return; }
        if (_growing) return;

        IntPtr foreground = GetForegroundWindow();
        if (foreground == Handle) { _hadFocus = true; return; }

        // Our own other windows (the strip, its context menu) must not close it — the strip's own
        // click handler owns that.
        GetWindowThreadProcessId(foreground, out uint pid);
        if (pid == (uint)Environment.ProcessId) return;

        if (_hadFocus) Hide();
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
                // purpose (the server marks those buckets stale), and re-inserting it here
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

    // Dev layout (web/ beside the exe) wins; the shipped single-file exe extracts its embedded
    // web/** resources to <home>/strip-web on every launch (tiny — overwrite keeps it current
    // across updates without a version dance).
    private static string Resolve()
    {
        var local = Path.Combine(AppContext.BaseDirectory, "web");
        try { if (File.Exists(Path.Combine(local, "index.html"))) return local; } catch { }
        var target = AppPaths.PathOf("strip-web");
        try
        {
            // Clean slate: a stale file from an older build would otherwise linger
            // beside the new ones and be served over the virtual host. Not in the
            // Pulse-era home, where nothing is ever deleted — there the files are
            // just overwritten in place (index.html only references what ships).
            if (!AppPaths.HomeIsLegacy)
                try { if (Directory.Exists(target)) Directory.Delete(target, recursive: true); } catch { }
            var asm = System.Reflection.Assembly.GetExecutingAssembly();
            foreach (var name in asm.GetManifestResourceNames())
            {
                if (!name.StartsWith("web/")) continue;
                var rel = name.Substring(4).Replace('/', Path.DirectorySeparatorChar);
                var dest = Path.Combine(target, rel);
                // Per-file try: one unwritable file (locked, read-only) must not
                // abort the extraction and leave the rest of the UI missing.
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                    using var src = asm.GetManifestResourceStream(name)!;
                    using var dst = File.Create(dest);
                    src.CopyTo(dst);
                }
                catch { /* keep going — a partial UI beats no UI */ }
            }
        }
        catch { /* fall through — a previous extraction may still exist */ }
        return target;
    }
}
