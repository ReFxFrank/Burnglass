<div align="center">
  <img src=".github/assets/logo.svg" alt="Pulse logo" width="88" height="88" />

# Pulse

**A live, local, zero-dependency usage dashboard for [Claude Code](https://claude.com/claude-code), [OpenAI Codex](https://github.com/openai/codex) and other coding agents.**

See what you're spending, which models you're spending it on, how close you are to
your 5-hour and weekly limits, when you work, and which sessions ran at which
reasoning effort. Pulse reads the logs already on your machine: Claude Code, Codex,
Gemini CLI, Continue, Cline, Roo Code, or your own tool's JSONL. It ships as one
small executable, needs no configuration, and your usage data never leaves your computer.

[![Release](https://img.shields.io/github/v/release/ReFxFrank/Pulse-Usage-Monitor?color=8f7ff5&label=release)](https://github.com/ReFxFrank/Pulse-Usage-Monitor/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/ReFxFrank/Pulse-Usage-Monitor/total?color=8f7ff5&label=downloads)](https://github.com/ReFxFrank/Pulse-Usage-Monitor/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-22b892.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20Linux%20%7C%20macOS-4a9bf5)](https://github.com/ReFxFrank/Pulse-Usage-Monitor/releases/latest)
[![Runtime deps](https://img.shields.io/badge/runtime%20deps-0-e0a132)](package.json)

  <img src=".github/assets/hero.png" alt="Pulse dashboard" width="920" />
</div>

---

> **New in v1.34:** Discord images that follow what Claude is doing (working,
> thinking, or waiting on you), set right from the Server panel. v1.31 through
> v1.33 fixed under-counted subagent and advisor spend, fixed account meters that
> showed 0.9% as 90%, added Opus 5.5, GPT-6 Sol / Luna and Codex Fast-mode pricing,
> and put your model, effort and live session count on Discord. Full history in
> [CHANGELOG.md](CHANGELOG.md).

## ✨ Features

**Track your spend**
- 💸 **Live spend**: the current 5-hour block with its reset countdown, burn rate, today,
  the last 7 days, and a stacked 30-day spend chart. Refreshes every 10 seconds.
- 📅 **Any period**: rolling 30 / 90 / 180 days or any calendar month, with a
  *▲ 18% vs prev 30 days* comparison against the previous equal window.
- 🤖 **Breakdowns** by model (with provider logos), source, reasoning effort and project,
  plus a recent-sessions table. **Source-filter chips** scope the whole dashboard to any
  mix of tools.
- 🕒 **"When you work" heatmap**: a 7×24 day-by-hour grid shaded by spend.
- 🧮 **Honest extras**: what prompt caching saved you *net* of cache-write costs, and
  what fast mode cost above standard rates.
- 📤 **CSV / JSON export** of whatever window and sources you're looking at.

**Every agent on the machine**
- 🟢 **Claude Code and OpenAI Codex**, read automatically. Subagents and advisor calls are counted too.
- 🧩 **Gemini CLI, Continue, Cline and Roo Code**, read from their own local logs with no setup.
- 🛠 **Custom sources**: point Pulse at a JSONL log your own agent writes.
- 🏷 **Current pricing** for Anthropic (Opus 5.5, Fable / Mythos, Sonnet 5 …), OpenAI (GPT-6
  Astra / Sol / Luna, GPT-5.x and Codex models, Fast mode, cache writes, long context),
  Google Gemini, and Z.ai GLM through Claude Code.

**Know your limits**
- 📡 **Official account meters**: Anthropic's account-wide 5-hour, weekly and per-model bars
  (opt-in) and your ChatGPT plan's Codex windows (automatic), with true reset times.
- 🔔 **Limit alerts** (80% / 95% by default) with optional desktop notifications, plus an opt-in
  **spend-anomaly** alert.
- 🎯 **Budget goals** (monthly or weekly, with a month-end projection) and 💎 **plan
  value**, which shows your usage as a multiple of what your subscription costs.

**See it anywhere**
- 📟 A **Claude Code status line**, and `pulse --summary` for a quick terminal readout.
- ◧ A **mini side overview** sized for a narrow docked window.
- 🎮 **Discord Rich Presence** (opt-in): your usage, model · effort · live sessions, and
  animated art that follows what Claude is doing.
- 🪟 **Windows extras**: a no-admin installer, start with Windows, a tray icon with a live %
  badge, the **Pulse Strip** taskbar companion, or OpenUsage launched alongside Pulse.
- 🧊 **Meshy 3D credits** (opt-in): balance and credit usage, kept in credits and never
  mixed into dollars.

**Built to be trusted**
- 🔒 **Local-first**: binds to `127.0.0.1`, reads every agent's logs strictly read-only, and
  keeps its own files in `~/.pulse`. It makes only a few network calls; each one is
  [listed below](#-privacy--security) and can be turned off.
- 🗄 **Durable history**: past days are archived, so long windows survive Claude Code's
  ~30-day transcript pruning.
- 🪶 **Zero runtime dependencies**: one Node process using built-ins only, shipped as a
  single-file executable for Windows, Linux and macOS.
- 🔄 **Self-updating** (sha256-verified). It runs hidden in the background on Windows, and a
  **Server panel** in the dashboard replaces the console.
- 🌍 **Community reach**: a header pill with public download and star counts. It uses the
  same opt-out as the update check.

<div align="center">
  <img src=".github/assets/panels.png" alt="Model breakdowns, effort chips and sessions" width="920" />
</div>

## 🚀 Quick start

### Download (easiest, no Node required)

Grab the latest release from
**[Releases](https://github.com/ReFxFrank/Pulse-Usage-Monitor/releases/latest)**:

| Platform | Get running |
| --- | --- |
| **Windows (installer)** | Run `PulseSetup.exe`. It's a per-user install (**no admin**) with Start Menu and optional Desktop shortcuts, an Add/Remove Programs entry, and opt-in checkboxes for **start at sign-in** and **include Pulse Strip**. Uninstalling keeps your settings and history. |
| **Windows (portable)** | Download `pulse.exe`, put it in a permanent folder, and double-click it. Pulse starts in the background and opens `http://localhost:4747`. |
| **Linux** | `chmod +x pulse-linux && ./pulse-linux` |
| **macOS** (Apple Silicon) | `chmod +x pulse-macos && xattr -d com.apple.quarantine pulse-macos; ./pulse-macos` (the `xattr` clears Gatekeeper's quarantine on the unsigned binary) |

The binaries are unsigned, so SmartScreen may warn on Windows: click **More info → Run anyway**.

Pulse finds each tool's logs for whoever runs it: `~/.claude` (or `CLAUDE_CONFIG_DIR`
if you relocated Claude Code), `~/.codex` (or `CODEX_HOME`), and the other agents'
default locations. There's nothing to configure.

With the portable exe, you can optionally run:

```bat
pulse.exe --install-shortcuts
```

This adds **"Pulse"** (start / open dashboard) and **"Pulse — Stop"** buttons to your Desktop.
Starting is idempotent: if Pulse is already running, double-clicking just opens the dashboard.

### Run from source

Node ≥ 18 with zero runtime dependencies. The pre-built frontend is committed:

```sh
git clone https://github.com/ReFxFrank/Pulse-Usage-Monitor && cd Pulse-Usage-Monitor
node server.js          # → http://localhost:4747
```

To work on the React frontend (`web/`): `npm run build` (Node ≥ 20) rebuilds it,
`npm run dev` runs Vite with hot reload, and `node build/make-exe.mjs` packages a
single-file executable for your OS.

### Deploy on an Ubuntu VPS (one command)

```sh
curl -fsSL https://raw.githubusercontent.com/refxfrank/Pulse-Usage-Monitor/main/install.sh | bash
```

This installs Pulse as a systemd service bound to `127.0.0.1` (auto-restart, start on
boot). Reach it over an SSH tunnel. The dashboard exposes usage metadata, so it
is deliberately **not** internet-facing:

```sh
ssh -N -L 4747:localhost:4747 <you>@<your-vps-ip>
```

Manage it with `sudo systemctl status|restart pulse` and read logs with `journalctl -u pulse -f`.
Overrides: `PULSE_PORT`, `PULSE_HOST`, `PULSE_DIR`, `PULSE_BRANCH`, `CLAUDE_DIR`.
Re-running the installer updates and restarts the service.

## 🎛 Options

| Flag / env | Effect |
| --- | --- |
| `--port N` / `PORT` | Listen port (default `4747`). |
| `--host H` / `HOST` | Bind address (default `127.0.0.1`). `0.0.0.0` exposes Pulse on the network and prints a warning. Prefer an SSH tunnel. |
| `--no-open` | Don't auto-open the browser (packaged exe). |
| `--no-daemon` | (Windows exe) Stay in the console window instead of backgrounding. |
| `--no-update-check` | Disable the GitHub version check and the community-reach counters. Also `PULSE_NO_UPDATE_CHECK=1`, or `{"updateCheck": false}` in `~/.pulse/config.json`. |
| `--stop` | Stop the running Pulse instance and exit. |
| `--summary` | Print today / 7-day / 30-day spend, meters and top models, then exit. See [Terminal summary](#terminal-summary). |
| `--statusline` · `--statusline-setup` | Run as a Claude Code status line · print the `settings.json` snippet for it. |
| `--effort-setup` | Print the optional effort-logging hook snippet. |
| `--tray` | (Windows) Notification-area icon. Also `{"tray": true}`. |
| `--startup on\|off\|status` | (Windows) Start Pulse silently when you sign in. |
| `--install` · `--uninstall` | (Windows exe) Per-user install to `%LOCALAPPDATA%\Programs\Pulse` with shortcuts and an Add/Remove Programs entry · undo it, along with the startup entry. `~/.pulse` is kept. |
| `--install-shortcuts` | (Windows) Add **"Pulse"** and **"Pulse — Stop"** Desktop shortcuts. |
| `--inspect-schema` | Print the record schema observed in your logs, then exit. |
| `--version` / `--help` | The usual. |
| `CLAUDE_DIR` / `CLAUDE_CONFIG_DIR` | Override the `~/.claude` location. |
| `CODEX_DIR` / `CODEX_HOME` | Override the `~/.codex` location. |
| `GEMINI_DIR` · `CONTINUE_DIR` · `CLINE_DIR` · `ROO_DIR` | Override the other agents' locations (`GEMINI_CLI_HOME` and `CONTINUE_GLOBAL_DIR` are honored too). |
| `PULSE_HOME` | Where Pulse keeps its own files (default `~/.pulse`). |
| `NO_COLOR` | Plain output for `--statusline` and `--summary`. |

## 📊 The dashboard

From top to bottom:

- **Header**: source-filter chips (multi-select, remembered in your browser), the
  **◧ mini** button, the community-reach pill, an update pill when a release is out,
  and **Stop**.
- **Alerts banner**: covered in [Budgets, plan value & alerts](#-budgets-plan-value--alerts).
- **Plan value** and **budget** cards, which you set inline.
- **Tiles**: the current 5-hour block, burn rate, today, and the last 7 days. The block is
  Claude Code only. It syncs to Anthropic's official clock when account meters are on.
- **Account limits**: covered in [Account meters](#-account-meters--regular-chats-included-opt-in).
- **Spend**: pick a period, compare it with the previous window, and see a cache-savings
  strip and a daily chart stacked by source. **⇩ export** downloads CSV (daily spend with a
  column per source, by model, source or project, or recent sessions) or the full JSON
  payload, and follows the selected period and source filter.
- **By model** shows effort and fast-mode chips and a fast-mode premium note. **By source**
  badges Continue's estimated numbers `est`.
- **By effort** and **By project**: spend by the effort level in force (`low` → `max`,
  ultracode, default) and by working directory.
- **When you work**: the day × hour heatmap. Hover a cell for cost, tokens and messages.
- **Recent sessions**: titles, models, mode, cost, tokens and recency.
- **Server panel**: see below.

By-effort, by-project, the heatmap, cache savings and the fast-mode note are computed from
entries still in your logs. The long-window archive keeps only day, source and model totals.
The cards' ⓘ tooltips say so, and the cache and fast-mode figures state their coverage
when it's well below the period total.

**◧ Mini side overview** (`/#mini`, or the header button): your Claude and Codex windows
as **% left** bars with true reset countdowns and a **"~N% left at reset"** projection
from your recent burn rate. It also has a Today / Yesterday / 30-Days spend donut by
source and a daily trend, sized for a narrow docked window or a browser "install as
app" side panel.

## 🖥 The Server panel

Everything you'd normally need a console for lives at the bottom of the dashboard:
version, uptime, memory, mode, live server logs, **Stop**, **Check for updates**, and
one-click **Update now**. Update now downloads the release asset, verifies its sha256 digest
against the GitHub API, swaps the executable atomically with rollback, restarts, and
reloads your page on the new version. A source checkout links to the release instead.

It's also where every opt-in switch lives: account meters, Discord presence (with its
image fields), Meshy credits, and on Windows the tray icon, Start with Windows,
Pulse Strip and OpenUsage launch. A **Graphics: auto / lite / rich** switch removes blur and
animation on machines without GPU acceleration. Auto detects software rendering.

<div align="center">
  <img src=".github/assets/server.png" alt="Server panel: logs, stop, updates" width="920" />
</div>

## 🟢 Codex / ChatGPT support

If the [OpenAI Codex CLI](https://github.com/openai/codex) is installed, Pulse
ingests its session logs (`~/.codex/sessions`, override with `CODEX_DIR`)
alongside Claude Code. There's nothing to configure:

- `gpt-*` models appear in **By model**, `codex` in **By source**, and sessions in the
  table with titles and reasoning-effort chips (read from each turn's context).
  Rollouts of spawned agents, the auto-reviewer and `/review` are grouped under their
  parent session.
- Costs use **OpenAI API list prices** at the rate in force on each entry's date. They
  include the cached-input discount, the cache-write rate where OpenAI publishes one,
  the >272K long-context tier, and **Fast mode** with each model's published multiplier.
  The Codex TUI runs GPT-6 Sol and Luna on Fast by default. Fast mode is priced only where the
  rollout records the tier. Codex doesn't record it for a brand-new session until it's
  resumed, compacted or its settings change. Until then, those turns price at standard:
  Pulse can under-count, but it never guesses high.
- Like the Claude numbers, these costs are relative-usage estimates on a ChatGPT
  subscription, not a bill.
- The **Current 5h block** stays Claude-only. Codex has its own separate limit windows
  and must not distort Claude's reset countdown.

**Codex official meters:** every Codex turn also records a snapshot of your
ChatGPT plan's Codex allowance (session and weekly windows) in the rollout log.
Pulse shows the newest snapshot in the **Account limits** card automatically.
There's no login, and nothing leaves your machine. The card is labeled with how fresh
the snapshot is (run any Codex turn to refresh it). A window that rolled over since the
snapshot shows as stale rather than as a made-up number.

**Scope:** this covers the Codex *CLI*, which logs locally. ChatGPT in the
browser or mobile app writes no local logs (same as claude.ai), so it can't
appear on any local dashboard. The Codex meters reflect your plan's Codex allowance,
not chatgpt.com chat limits (which aren't exposed anywhere).

## 🧩 More agents: Gemini CLI, Continue, Cline, Roo Code

Pulse reads these agents' own local logs. Each appears as its own source, only when its
logs are present:

| Agent | What Pulse reads | Cost |
| --- | --- | --- |
| **Gemini CLI** | `~/.gemini/tmp/*/chats/session-*.jsonl` | Google Gemini API list prices |
| **Continue** | `~/.continue/dev_data/*/tokensGenerated.jsonl` | Priced from Continue's own **local token estimates**, so the source is badged `est` |
| **Cline** | the extension's task history (`globalStorage/saoudrizwan.claude-dev/tasks/`) | Cline's own recorded per-request cost |
| **Roo Code** | the same layout under `rooveterinaryinc.roo-cline` / `.roo-code` | Roo's own recorded cost |

Cline and Roo are found in VS Code, Insiders, VSCodium, Cursor and Windsurf, plus
`~/.vscode-server` on Linux remote installs. None of these agents count toward the Claude
5-hour block, even when they run a Claude model.

**Not supported:** agents that keep usage only in SQLite (Crush, Goose, opencode ≥ 1.16).
Reading SQLite would break the zero-dependency rule. Aider's default history has
no exact per-call token counts.

## 🛠 Custom sources — bring your own agent

If you run your **own** model or agent (a local fine-tune, a homemade harness,
an internal tool), have it append one JSON line per completed request to a
JSONL file and declare it in `~/.pulse/config.json`:

```json
{
  "customSources": [
    { "name": "foreman", "label": "FOREMAN", "path": "C:\\Users\\you\\.foreman\\usage.jsonl" }
  ]
}
```

- `name`: a short lowercase slug of up to 24 characters: a letter first, then `a-z0-9_-`.
  It's the source key in filters, colors and CSV columns, **and the identity your history is
  archived under, so treat it as permanent**. Change the visible text with `label` instead.
  Pulse detects a renamed `name` and retires the old identity from days it still has logs
  for, but archive-only days keep the old name. Built-in names (`cli`, `codex`, `gemini`,
  `cline`, `continue`, `roo`, `claude`, `mixed`) are reserved. You can have up to 8 sources.
  Invalid rows are dropped with a one-time warning in the server log.
- `path`: a `.jsonl` file, or a **directory**. Pulse reads every `*.jsonl` under a directory,
  so monthly rotation just works. If the same record `id` appears across rotated files,
  only the newest record is kept. A missing path means no usage yet, not an error. A path
  another source already ingests (for example, inside `~/.claude`) is refused. Files over
  **50 MB** are skipped with a warning, so rotate into a directory of smaller files.
- `label`: an optional display name (for example, `FOREMAN`), shown everywhere the source
  appears. It defaults to the name. A label that impersonates a built-in source or collides
  with another source's name or label falls back to the name.

**Record schema:** one JSON object per line. Unknown keys are ignored:

```json
{"ts":"2026-08-14T21:03:07.412Z","id":"<uuid per request>","model":"foreman-7b","input":1234,"output":567,"cached":0,"sessionId":"run-42","project":"my-fivem-server","estimate":false}
```

- `ts` (required): ISO-8601, epoch ms, or epoch seconds.
- `input` / `output`: token counts. `cached` is the part of `input` served
  from a prompt cache. At least one token count must be non-zero.
- `id` (recommended): a stable per-request id. Pulse dedups on it with
  **last-write-wins**, so replays or rewrites never double-count. Without an id,
  a line is identified by its file position.
- `cost` (optional): if a record carries a finite USD cost, Pulse trusts it
  verbatim (as it does Cline's). Otherwise the source is **tokens-only at $0**. A
  local model has no API bill, and Pulse won't invent one.
- `estimate: true`: badges the source `est` when counts aren't tokenizer-exact.

Everything else is automatic: the source gets a filter chip, a stable color, a
By-source bar, sessions rows, a CSV export column, and archive retention. Custom
usage never touches the **Current 5h block** (that's Claude Code's own limit
concept) and never skews spend totals unless your records carry real costs.
As with every source, Pulse only ever **reads** the log. Known limitation: Pulse Strip
currently folds custom sources into its Claude card.

## 📡 Account meters — regular chats included (opt-in)

Local logs can never show claude.ai chats, browser-only cloud sessions, or other
machines. But your Pro/Max limits are **unified**: everything drains the same
5-hour and weekly windows. Anthropic exposes that account-wide meter to
Claude Code (`/usage`), and Pulse can read the same gauge:

- Enable it in the **Server panel** ("Enable account meters"). A card shows each limit
  (5-hour session, weekly, per-model weekly such as Opus, Sonnet or Fable, and Cowork)
  as a bar with the **official utilization %** and a live **true reset countdown**.
  Anthropic's endpoint also carries undocumented internal buckets. Pulse hides them
  until they show real usage.
- The **Current 5h block** tile switches to Anthropic's official window (marked
  *official*) instead of a reconstruction from local logs.
- **How it works / privacy:** Pulse reads your Claude Code OAuth token **read-only**
  from `~/.claude/.credentials.json` or, on macOS, the login Keychain (approve the
  Keychain prompt with *Always Allow* once). The token is never logged, never shown, never
  written and never refreshed. Pulse sends it only to `api.anthropic.com/api/oauth/usage`,
  Anthropic's own endpoint. That's the same endpoint Claude Code polls, so Pulse is polite:
  about every 2 minutes while the dashboard is open, and at most every 15 minutes (5 with
  the tray on) when only the status line, Discord or tray is reading. It backs off on
  HTTP 429 and keeps the last good numbers. Meters are off by default and one click
  turns them off again (`{"accountMeters": false}`).
- **Not logged in?** The card shows a **Connect your Claude account** panel. Log in from
  any Claude Code surface and hit **Recheck now**, with no restart.
- **Limits of the feature:** it's an aggregate gauge, not per-chat line items. No
  per-conversation breakdown exists anywhere. The endpoint is internal to Anthropic
  and could change. The card degrades gracefully if it does.
- **Codex token totals (same switch):** with a Codex login present
  (`~/.codex/auth.json`, read-only), the card also shows your ChatGPT
  account's **real token counts** across **all devices**: today, the past 7 days and
  lifetime, plus a 30-day daily mini-chart. They come from the endpoint behind Codex's
  own usage chart (`chatgpt.com`, polled every 10 minutes). Anthropic's API exposes
  percentages only, so there's no Claude equivalent. Consent is explicit: enabling
  meters **from the dashboard** turns on both providers
  (`{"accountMeters": true, "codexAccountUsage": true}`). A config that predates v1.6.0
  keeps the ChatGPT call off until you toggle it again.

## 🎯 Budgets, plan value & alerts

- **Plan value:** enter what your subscription costs (inline, or `planCost` + optional
  `planLabel`). The card leads with your last 30 days of list-priced usage as a multiple
  of it, for example *14.2× your plan*, plus a six-month history with a break-even line.
  It always covers **all sources**, because the plan doesn't change with the filter.
  A month under 1× is shown neutrally.
- **Budget goals:** set a monthly (resets on the 1st) or weekly (trailing 7 days) spend
  target inline, or use `budget` + `budgetPeriod`. The bar turns amber at 80% and red when
  you're over. Month budgets also show a **month-end projection** (*on pace for ~$47*).
- **Limit alerts:** a banner flags any Claude meter (5-hour, weekly, model-scoped) or
  Codex window crossing a threshold, most urgent first, with the provider and reset time.
  A window already at 100% has been reached, so it stays out of the banner and shows only
  in the gauges. Click **Enable desktop alerts** once to get browser notifications. Pulse
  sends each one once per threshold per window. Defaults are 80% / 95% (`alertThresholds`).
  Set `"alerts": false` to turn alerts off.
- **Spend anomaly** (opt-in, `{"anomalyAlerts": true}`): flags a day whose spend blows
  past your own baseline, for example *today $62 — 3.1× your recent daily average*. The
  baseline is the mean of your active days in the last 30. The alert needs at least 5
  active days and $5 spent today. Tune it with `anomalyMultiplier` (default 3, minimum 1.5).

## 🎮 Discord Rich Presence (opt-in)

Show Pulse as a Discord activity that rotates through your usage: **"Today:
80.0M tokens · $136" → "Past 7 days: 500M tokens · $980" → "All-time: 2.69B
tokens · $2,581"**. It shows one page every 45 s (`discordRotateSecs`, 15–300) and has a
**Get Pulse** button. The elapsed timer survives self-updates and quick restarts.

**What you're running:** while you're active, a second line shows your model, effort
and live session count, for example **"Opus 5.5 · Extra High · 3 sessions"**, or for
Codex, "GPT-6 Sol · High · 1 session". The model and effort come from your main
conversation, so subagents and advisor calls never make it flicker. A session counts as
live if it had activity in the last 15 minutes. The line disappears when you go idle.
Turn it off with `{"discordShowModel": false}`.

**Zero setup:** click **Discord presence: off → on** in the Server panel while
the Discord desktop app is running. Pulse ships with the official Pulse
application ID built in (a public identifier, which is how every rich-presence tool works).
To present as your own Discord application, set `{"discordClientId": "…"}`.

**Images that follow what you're doing:** the large image shows Claude art while you use
Claude Code, Codex art while you use Codex, and Pulse art when you're idle. With presence on,
the Server panel has a field for each slot: **Claude Code**, **Claude — working**,
**Claude — thinking**, **Claude — waiting on you**, **Codex** and **Idle**. Each field
takes an art-asset key or an `https://` link. An empty field falls back to the built-in
art (the three Claude state slots fall back to the Claude Code image). The built-in keys
`claude`, `codex` and `pulse` refer to art uploaded to the Discord application
(Developer Portal → Rich Presence → Art Assets). If you use your own application ID,
upload images under those keys. A missing key just shows no image.

- **Animated images:** Discord animates a GIF or animated WebP only when it's given as an
  **https link**. Uploaded art assets are always stills. Discord's image proxy fetches
  the link, not Pulse, so the panel deliberately shows no preview. Anyone who can see your
  presence can see where the image is hosted. Avoid Discord attachment links, because
  they expire. A link must start with `https://`, contain no spaces or embedded
  username/password, and be at most 256 characters. One bad value rejects the whole save.
  If Discord rejects an image, the Server panel shows the error until the next accepted
  update.
- **Claude states:** *working* means Claude is running a tool (or its subagents are).
  *Thinking* means the model is generating. *Waiting on you* means a permission prompt or
  a question is open. Pulse reads Claude Code's own live status file
  (`~/.claude/sessions/`, read-only) plus the transcript, and falls back to the transcript
  alone on older builds. A switch between working and thinking must hold for 45 s before
  the image changes, so viewers aren't reloading a GIF constantly. Waiting and idle switch
  at once. For Codex, the image's hover text shows working or thinking, but there are no
  per-state images. Turn states off with `{"discordShowState": false}`.
- The same slots can be set in config: `discordClaudeImage`, `discordClaudeWorkingImage`,
  `discordClaudeThinkingImage`, `discordClaudeWaitingImage`, `discordCodexImage`, and
  `discordLargeImage` (idle).

**How it works / privacy:** Pulse speaks the Discord **desktop client's local IPC
socket** directly (a named pipe on Windows), with no SDK and no network traffic from
Pulse. The Discord app does the publishing. Pulse updates at most every 15 s, and only
when something changes. **Your presence is visible to anyone who can see your Discord
profile.** That's the point, but it's why presence is off by default. It requires the
desktop app (browser Discord has no local socket). Turn it off any time and the activity
clears immediately.

## 📟 Status line for Claude Code

Show Pulse's numbers right in Claude Code's status line:

```
◉ Opus · ctx 25% · today $4.20 · 5h $1.10 2h24m · wk 41%
```

The model and context come from Claude Code. **Today's cross-tool spend, the
current 5-hour block, and the official meter percentages** (plus `cx`, your Codex weekly
%, when available) come from the running Pulse server over loopback. The server is the
single, throttled poller, so the status line reflects *all* your usage and
**never hits a provider endpoint itself**.

Setup: run `pulse --statusline-setup` and paste the printed snippet into
`~/.claude/settings.json` (Pulse never writes there itself):

```json
{
  "statusLine": { "type": "command", "command": "…/pulse --statusline", "padding": 0, "refreshInterval": 30 }
}
```

It's fail-open by design. If Pulse isn't running, the line still shows the model and
context from Claude Code alone, and it always exits cleanly (a status-line command
that errors would blank the line). `NO_COLOR=1` disables the ANSI colors.

### Terminal summary

`pulse --summary` prints today / 7-day / 30-day spend and tokens, live meter percentages
with reset countdowns, your plan multiplier and your top models. It then exits without
opening a browser. It reads the running server when there is one and computes locally
when there isn't. It respects `NO_COLOR` and always exits 0, so it's safe in a prompt or
script.

## 🪟 Windows extras

- **Installer:** `PulseSetup.exe` installs per-user to `%LOCALAPPDATA%\Programs\Pulse`
  (no admin, no UAC prompt). It adds Start Menu and optional Desktop shortcuts, an
  Add/Remove Programs entry, and opt-in **start at sign-in** and **include Pulse Strip**
  checkboxes. Uninstalling removes all of that and **keeps `~/.pulse`** (config, budget,
  plan cost, history). Prefer portable? `pulse.exe` works on its own, and
  `pulse --install` / `--uninstall` do the same job from a terminal.
- **Start with Windows** (opt-in): use the Server-panel toggle or
  `pulse --startup on|off|status`. It writes one per-user value (`Pulse`) under
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, which starts the server with
  `--no-open`, so nothing pops up. It never needs admin, and you can remove it from the
  same toggle or from Task Manager → Startup.
- **Tray icon** (opt-in): use the Server-panel toggle, `--tray`, or `{"tray": true}`. It
  shows the Pulse mark, and with account meters on, your Claude 5-hour usage % painted on
  it (green → amber ≥ 60% → red ≥ 85%). The tooltip shows today's spend and your 5h / weekly
  %. Left-click opens the mini overview as an app window. Right-click offers dashboard,
  mini and Stop. Windows hides new tray icons behind the `^` chevron, so drag Pulse out
  once to pin it. If the icon goes missing, the Server-panel log says why.
- **Pulse Strip** (opt-in): your usage right on the taskbar. It's a slim transparent strip
  with each provider's **% left** (rotating with today's spend), and clicking it opens a
  **popover** with meter bars, reset countdowns, a per-source spend donut, spend rows and
  daily trends. It's fed by your local Pulse server, so its values match the dashboard.
  Get `pulse-strip.exe` from the release (or tick it in the installer), put it next to
  `pulse.exe` (or in `~/.pulse/bin`), and flip **Pulse Strip** on in the Server panel
  (`{"strip": true}`; `stripPath` overrides the location). Its "Last 7 Days" covers 7
  calendar days, while the dashboard uses a rolling 168 hours. It's ported from
  [openusage-windows](https://github.com/CheesyPoofs346/openusage-windows) (MIT).
  Credit where due: their strip design is excellent.
- **OpenUsage companion** (opt-in): prefer the real
  [OpenUsage for Windows](https://github.com/CheesyPoofs346/openusage-windows)? Pulse can
  start it together with the server. Flip the Server-panel toggle or set
  `{"openusage": true}` (plus `"openusagePath"` if it lives somewhere unusual). Pulse only
  *starts* the app when it isn't already running. It never installs, updates or closes it.

## 🧊 Meshy 3D credits (opt-in)

[Meshy](https://www.meshy.ai) has no local log, so this is the one source Pulse reads
over the network with a key **you** provide. Turn on **Meshy credits** in the Server
panel and paste an API key from your Meshy account settings. The card shows credits
left, credits used today / in the last 7 and 30 days, a daily bar row, and a split by
task type.

- **Credits stay credits.** There's no published credit-to-dollar rate, so they never
  enter your spend, budget or plan value.
- **Your key is treated as a secret.** It's stored in `~/.pulse/config.json`
  (`meshyApiKey`), sent only to `api.meshy.ai` in a request header, and never logged,
  put in a URL, or included in the dashboard payload or exports. The payload only says
  whether a key is set.
- **Polite:** Pulse refreshes at most every 15 minutes and caches task history in
  `~/.pulse/meshy.json` (no prompts stored). A rejected key isn't retried until you
  change it, and 429 / 5xx responses back off while the last good numbers stay on screen.
  Meshy documents only its text-to-3D list endpoint, so the card says which task types it
  could actually count.

## 🧠 Reasoning-effort chips

Pulse shows which sessions ran at which reasoning effort (`low` → `max`, plus
ultracode) and when fast mode was used. It needs **zero setup**:

- Claude Code ≥ 2.1.212 records the effort level on every assistant message, and Pulse reads
  it directly.
- For older sessions, Pulse reads the `/effort` commands you typed (including the
  interactive picker's confirmation) straight from the transcripts, **retroactively**.
- `/effort ultracode`, or typing `ultracode` in a prompt, flags the session ULTRA
  (ultracode is never recorded as data).
- Codex effort comes from each turn's context in the rollout.
- A session that never set a level shows no chip. Pulse won't guess, and `auto` / `default`
  never become chips.

The chips feed the **By effort** breakdown. For older Claude Code builds with an effort
level persisted in `settings.json` (applied across sessions), there's an optional hook:
`pulse --effort-setup` prints a snippet to paste into `~/.claude/settings.json` (Pulse
never edits `~/.claude` itself). New sessions then log their level to
`~/.pulse/modes.jsonl`.

## 🔍 How it works — and how accurate it is

- **Source of truth.** Claude Code writes newline-delimited JSON session logs under
  `~/.claude/projects/`, and Codex writes rollouts under `~/.codex/sessions/`. Pulse walks
  those trees (and the other agents' logs), parses every entry that carries usage, and
  normalizes it. Parsed files are cached by mtime, so unchanged files are never re-read
  and even large histories rebuild in milliseconds.
- **Deduplication.** Claude Code writes the same message several times as it streams.
  Pulse dedupes on `message.id + requestId`. Without this, costs would be inflated ~3×.
  When the copies differ, Pulse keeps the fullest one. Claude Code ≥ 2.1.281 writes subagent
  messages as several lines whose *first* line carries a partial streaming count.
- **Advisor calls.** Claude Code's advisor runs as a separate server-side inference
  whose usage appears only inside the message's `usage.iterations`. Pulse counts each
  call as its own entry at the advisor model's price.
- **Cost model.** Every entry is priced at its provider's API list price. The rates live
  in three commented tables at the top of `server.js`: `PRICING` (Anthropic and Z.ai
  GLM), `PRICING_OPENAI` and `PRICING_GOOGLE`. The Claude pricing:
  - cache writes cost ×1.25 (5-minute) or ×2.0 (1-hour);
  - cache reads cost ×0.1, or ×0.05 for Opus 5.5 and ×0.025 for Fable / Mythos 5.1;
  - fast mode has its own rates on the models that offer it;
  - US-only inference (`inference_geo: "us"`) costs ×1.1;
  - web searches are $10 per 1,000.

  Dated ids and Bedrock / Vertex ids price as their base model. Unknown models fall back to
  a default price and are logged once. An unpriced point release (for example, a new
  `claude-*-5-5`) borrows its parent's rate and is logged too, so a gap is never silent.
- **5-hour blocks.** With account meters on, the block uses Anthropic's official
  window. Otherwise Pulse reconstructs it from this machine's logs: the first message
  after a ≥ 5h gap (or past the previous window's end) opens a block, floored to the hour.

  > ⚠ **Why a reconstructed countdown can differ from Claude's.** The *real* window is
  > opened by your first message on **any** surface: claude.ai in the browser, mobile, or
  > another computer. Those messages aren't in this machine's logs. If they anchored the
  > real window earlier, the actual reset happens **earlier** than Pulse shows. Treat a
  > reconstructed countdown as an upper bound, or enable account meters for the true one.
- **History.** Each fully past day's totals (cost, tokens and messages per source and
  model) are sealed to `~/.pulse/history/`, one small JSON file per month. They're merged
  back so long windows and all-time totals survive log pruning. A live day always wins
  over its archived copy, so a price correction reaches every day that's still in your
  logs. Turn history off with `{"history": false}`.

## 👁 What Pulse can and can't see

- Pulse reads the logs on **this machine only**. Usage from other computers,
  claude.ai in the browser, or the mobile apps won't appear in spend. Only the
  opt-in account meters cover them, and only as percentages.
- **Claude Code prunes old logs** (~30 days by default via `cleanupPeriodDays`).
  Pulse **archives each past day's totals** to `~/.pulse` before they're
  pruned, so the long windows and all-time totals stay intact going forward
  (spend chart and by-model / by-source; per-session detail stays recent-only).
  To keep history from before your first Pulse run in the raw logs,
  raise the retention window in `~/.claude/settings.json`:

  ```json
  { "cleanupPeriodDays": 3650 }
  ```

- "Last 30 days" is a **rolling window**. Use the month entries in the dropdown for
  fixed calendar-month totals.
- The **Recent sessions** table shows whole-session totals, so summing that column
  won't match a period total when sessions straddle the window edge.

## 💵 Costs are estimates, not a bill

Costs are computed at each provider's API list prices (Anthropic, OpenAI, Google,
Z.ai). On a Pro/Max or ChatGPT subscription they express your **relative** usage:
which sessions, models, and time windows are heavy. They aren't an amount you'll be
charged. Cline and Roo report their own recorded cost, which Pulse uses as-is.
Continue's token counts are its own local estimates (badged `est`). Custom sources are $0
unless their records carry a cost. Check current list prices with each provider
(for Claude, [docs.claude.com](https://docs.claude.com)) before relying on absolute figures.

## 🔒 Privacy & security

- Binds to `127.0.0.1` only, so it isn't reachable from the network.
- **Reads, never writes:** `~/.claude`, `~/.codex`, the other agents' logs, and your
  custom-source files. Pulse never writes, moves, or deletes anything there.
- **Writes only to `~/.pulse`** (config, logs, history, caches), apart from things you
  explicitly ask for: the Start-with-Windows entry, the installer / `--install` footprint
  (program folder, shortcuts, Add/Remove Programs entry), `--install-shortcuts`, and a
  self-update replacing Pulse's own executable. Uninstalling never deletes `~/.pulse`.
- **Outbound requests, exhaustively:**
  1. **GitHub**: the version check and community-reach counters. They're on by default;
     `--no-update-check` / `{"updateCheck": false}` disables both. They read **public**
     data (latest version, release download totals, star count) and send **nothing about
     you**. Clicking *Update now* also downloads the sha256-verified release asset.
  2. **Account meters (opt-in):** `api.anthropic.com` and `chatgpt.com`. Each provider's
     token is read read-only from its own login, never logged, never included in a
     payload, and sent only to that provider.
  3. **Meshy credits (opt-in):** `api.meshy.ai`, with the API key you paste.

  Discord presence (opt-in) talks to the Discord desktop app over its **local** socket,
  not the network. Discord itself fetches any image links. **No usage data ever leaves
  your machine.** With the update check off and nothing opted in, Pulse makes zero network
  calls. There's no CDN, no external fonts, no analytics, no telemetry, and no phone-home.
- Endpoints with side effects are POST-only, loopback-only, Host-header-checked, and
  require a custom header, so web pages you visit can't trigger them. Data reads are
  Host-checked too (CSRF and DNS-rebinding hardened).

## 🔧 Configuration reference

Everything is optional. Most settings have a dashboard control, so you rarely need to edit
`~/.pulse/config.json` by hand.

| Key | Default | Effect |
| --- | --- | --- |
| `updateCheck` | on | `false` disables the GitHub version check and reach counters. |
| `history` | on | `false` stops archiving past days. |
| `accountMeters` · `codexAccountUsage` | off | Anthropic meters · ChatGPT Codex token totals (the dashboard toggle sets both). |
| `alerts` · `alertThresholds` | on · `[80, 95]` | Limit alerts and their thresholds (%). |
| `anomalyAlerts` · `anomalyMultiplier` | off · `3` | Spend-anomaly alert and its trigger ratio (minimum 1.5). |
| `budget` · `budgetPeriod` | unset · `month` | Spend target in USD; `month` or `week`. |
| `planCost` · `planLabel` | unset | Monthly subscription cost (USD) and an optional name. |
| `customSources` | none | Your own JSONL logs, see [Custom sources](#-custom-sources--bring-your-own-agent). |
| `discordPresence` | off | Discord Rich Presence. |
| `discordClientId` | Pulse's app | Present as your own Discord application. |
| `discordRotateSecs` | `45` | Page rotation, 15–300 s. |
| `discordShowModel` | on | `false` hides the model / effort / sessions line. |
| `discordShowState` | on | `false` turns off the state-following Claude images. |
| `discordClaudeImage` · `discordClaudeWorkingImage` · `discordClaudeThinkingImage` · `discordClaudeWaitingImage` · `discordCodexImage` · `discordLargeImage` | built-in art | Art-asset key or `https://` link per image slot (`discordLargeImage` = idle). |
| `meshy` · `meshyApiKey` | off | Meshy credits and your API key (set from the dashboard). |
| `tray` | off | Windows tray icon. |
| `strip` · `stripPath` | off | Launch Pulse Strip · its exe location. |
| `openusage` · `openusagePath` | off | Launch OpenUsage · its exe location. |

## 🌐 API

| Route | Method | Description |
| --- | --- | --- |
| `/` | GET | The dashboard (`/#mini` for the mini overview). |
| `/api/summary` | GET | Full JSON payload: all aggregations plus server state. `?sources=a,b` scopes it to those sources. |
| `/api/health` | GET | `{ ok, version, pid }` |
| `/api/logs` | GET | Recent server log lines (the Server panel's log view). |
| `/api/statusline` | GET | Slim, memoized feed for `pulse --statusline`, the tray and Pulse Strip. |
| `/api/export` | GET | `?format=csv&data=daily\|models\|sources\|projects\|sessions&period=<key>` or `?format=json`; honors `&sources=`. |
| `/api/shutdown` | POST | Stop the server. |
| `/api/update/check` · `/api/update/install` | POST | Update flow. |
| `/api/meters/enable` · `/api/meters/disable` | POST | Toggle account meters (Anthropic + ChatGPT, one gesture). |
| `/api/meters/recheck` | POST | Re-detect the Claude Code login now. |
| `/api/discord/enable` · `/api/discord/disable` | POST | Toggle Discord Rich Presence. |
| `/api/discord/images` | POST | JSON body with any of `claude`, `claudeWorking`, `claudeThinking`, `claudeWaiting`, `codex`, `idle`; empty restores the built-in art. |
| `/api/meshy/enable` · `/api/meshy/disable` | POST | Toggle Meshy credits; enable takes an optional JSON body `{ "key": "…" }` (empty clears the key). |
| `/api/budget/set?amount&period` | POST | Set or clear the spend budget (`amount<=0` clears it). |
| `/api/plan/set?amount&label` | POST | Set or clear the plan cost and label (`amount<=0` clears both). |
| `/api/tray/enable` · `/api/tray/disable` | POST | Toggle the tray icon (Windows). Likewise `/api/startup/…`, `/api/strip/…` and `/api/openusage/…` for Start with Windows, Pulse Strip and the OpenUsage companion. |

Every POST route requires `X-Pulse: 1`, a loopback client, and a loopback `Host` header.

## 📁 Repository layout

| Path | What it is |
| --- | --- |
| `server.js` | The whole backend: parsers, pricing, aggregation, meters, Discord, HTTP, updates, background mode. Zero runtime dependencies. |
| `web/` | React frontend (Vite + Radix + Framer Motion). Built output in `web/dist` is committed and served. |
| `strip/` | Pulse Strip, the C# / WebView2 taskbar companion (build-time only; ported from openusage-windows, see `strip/LICENSE-openusage`). |
| `build/make-exe.mjs` · `build/installer.iss` | Single-executable packaging (Node SEA) · the Inno Setup script for `PulseSetup.exe`. |
| `.github/workflows/release.yml` | Builds `pulse.exe` / `pulse-linux` / `pulse-macos` (3-OS matrix) plus `pulse-strip.exe` and `PulseSetup.exe`, and publishes a Release. |
| `test/` | End-to-end suites against the real server with fixture homes and mock providers: `bash test/run-all.sh`. |
| `install.sh` / `pulse.sh` / `pulse.cmd` | VPS installer and launchers. |

## 📝 License

[MIT](LICENSE): do what you like, no warranty. Not affiliated with Anthropic.
