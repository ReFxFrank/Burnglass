# Configuration

Every setting Burnglass reads: the `config.json` keys, the command-line flags and the environment variables.

[← Back to the README](../README.md) · [All docs](README.md)

---

Everything is optional. Burnglass works with no configuration, and most settings have a
control in the dashboard (mostly in **System**), so you rarely need to edit anything by hand.

## The config file

Settings live in `~/.burnglass/config.json` (in the folder `BURNGLASS_HOME` names, if you
set it). On Windows that's `C:\Users\<you>\.burnglass\config.json`. The **System** section
shows the data folder in use.

- Changes made in the dashboard are saved to this file and apply at once.
- If you edit the file by hand, most settings apply on the next refresh. Restarting
  Burnglass (`burnglass --stop`, then start it again) always picks everything up.
- Keep it valid JSON. If the file doesn't parse, Burnglass runs on its defaults, and the
  next change you save from the dashboard rewrites the file with only that change.

Example:

```json
{
  "accountMeters": true,
  "codexAccountUsage": true,
  "alertThresholds": [75, 90],
  "budget": 400,
  "budgetPeriod": "month",
  "planCost": 200,
  "planLabel": "Max 20x",
  "discordPresence": true
}
```

## Config keys

### General

| Key | Default | Effect |
| --- | --- | --- |
| `updateCheck` | on | `false` turns off the GitHub version check, the community download and star counters, and the strip refresh after a one-click update. Same as `--no-update-check`. |
| `history` | on | `false` stops archiving past days to `~/.burnglass/history/`. See [How it works](how-it-works.md#history). |

### Limits, alerts and budgets

See [Limits, alerts and budgets](limits-and-budgets.md) for how each one behaves.

| Key | Default | Effect |
| --- | --- | --- |
| `accountMeters` | off | Anthropic's account-wide limit meters (`api.anthropic.com`). |
| `codexAccountUsage` | off | Your ChatGPT account's Codex token totals (`chatgpt.com`). The dashboard's **Account meters** switch sets both keys; a config from before Pulse 1.6.0 with only `accountMeters` keeps this call off until you toggle the switch again. |
| `alerts` | on | `false` turns limit alerts off. |
| `alertThresholds` | `[80, 95]` | Alert thresholds in %, each above 0 and at most 100. They also set the tick marks on every limit bar, the tray icon's levels and the strip's amber and red. |
| `anomalyAlerts` | off | `true` turns on the spend-anomaly alert. |
| `anomalyMultiplier` | `3` | How many times your recent daily average today's spend must reach to count as an anomaly (minimum 1.5). |
| `budget` | unset | Spend target in USD. Unset or 0 means no budget. |
| `budgetPeriod` | `month` | `month` (resets on the 1st) or `week` (trailing 7 days). |
| `planCost` | unset | What your subscription costs per month, in USD. |
| `planLabel` | unset | A name for the plan, such as `"Max 20x"`. |

### Sources

| Key | Default | Effect |
| --- | --- | --- |
| `customSources` | none | Your own JSONL usage logs, as an array of `{ "name", "path", "label" }`. See [Custom sources](custom-sources.md). |

### Discord Rich Presence

See [Discord Rich Presence](discord.md).

| Key | Default | Effect |
| --- | --- | --- |
| `discordPresence` | off | Publish your usage as a Discord activity. |
| `discordClientId` | Burnglass's app | Present as your own Discord application instead. |
| `discordRotateSecs` | `45` | Seconds per page (Today, Past 7 days, All-time), 15 to 300. |
| `discordShowModel` | on | `false` hides the model · effort · sessions line. |
| `discordShowState` | on | `false` turns off the images and hover text that follow Claude's live state. |
| `discordClaudeImage` | `claude` | The **Claude Code** image, also the fallback for an empty state slot. |
| `discordClaudeWorkingImage` | the Claude Code image | Shown while Claude is working. |
| `discordClaudeThinkingImage` | the Claude Code image | Shown while Claude is thinking. |
| `discordClaudeWaitingImage` | the Claude Code image | Shown while Claude is waiting on you. |
| `discordCodexImage` | `codex` | The **Codex** image. |
| `discordLargeImage` | `pulse` | The **Idle** image, shown when neither Claude Code nor Codex is active. |

Each image value is an art-asset key of the Discord application or an `https://` link
(at most 256 characters).

### Meshy credits

| Key | Default | Effect |
| --- | --- | --- |
| `meshy` | off | Track Meshy 3D credits. |
| `meshyApiKey` | unset | Your Meshy API key. Best set from the dashboard, which sends it in a request body; the dashboard never shows it back. |

### Windows companions

See the [Windows guide](windows.md).

| Key | Default | Effect |
| --- | --- | --- |
| `tray` | off | The notification-area icon. Same as `--tray`. |
| `strip` | off | Start Burnglass Strip with Burnglass. |
| `stripPath` | unset | Full path of the strip exe, if you keep it somewhere Burnglass doesn't look. A path that doesn't exist is not replaced by a search. With `stripPath` set, Burnglass never updates the strip for you. |

Start with Windows is not a config key: it's a registry value, set with the **System**
toggle, the installer or `--startup on`.

## Command-line flags

| Flag | Effect |
| --- | --- |
| `--port N` | Listen port (default `4747`, or `$PORT`). |
| `--host H` | Bind address (default `127.0.0.1`, or `$HOST`). `0.0.0.0` exposes Burnglass on the network and prints a warning; prefer an SSH tunnel. |
| `--no-open` | Don't open the browser (packaged exe). |
| `--no-daemon` | (Windows exe) Stay in the console window instead of running in the background. |
| `--no-update-check` | Turn off the GitHub version check, the community counters and the post-update strip refresh. |
| `--stop` | Stop the running Burnglass (or Pulse) instance and exit. |
| `--summary` | Print today / 7-day / 30-day spend, limits and top models, then exit. |
| `--statusline` | Run as a Claude Code status line (reads Claude Code's JSON on stdin). |
| `--statusline-setup` | Print the `settings.json` snippet for the status line. |
| `--effort-setup` | Print the optional effort-logging hook snippet. |
| `--mode-hook` | Internal: the hook that `--effort-setup` sets up. |
| `--tray` | (Windows) Show the notification-area icon. |
| `--startup on\|off\|status` | (Windows) Start Burnglass silently when you sign in. |
| `--install` · `--uninstall` | (Windows exe) Per-user install with shortcuts and an Add/Remove Programs entry · undo it. See the [Windows guide](windows.md#install-from-the-portable-exe). |
| `--install-shortcuts` | (Windows) Add **Burnglass** and **Burnglass - Stop** shortcuts to the Desktop. |
| `--inspect-schema` | Print the record keys observed in a sample of your Claude Code transcripts, then exit (a troubleshooting aid). |
| `--version` · `--help` | Print the version or the help text. |

Every flag from Pulse 1.x still works.

## Environment variables

Every Burnglass variable has a `BURNGLASS_` name and an older `PULSE_` alias. When both
are set, `BURNGLASS_` wins, and an empty `BURNGLASS_X=` doesn't hide a real `PULSE_X`.

| Variable | Effect |
| --- | --- |
| `BURNGLASS_HOME` | Where Burnglass keeps its own files (default `~/.burnglass`). Used exactly as given and never migrated from `~/.pulse`. Alias `PULSE_HOME`. |
| `BURNGLASS_NO_UPDATE_CHECK=1` | Same as `--no-update-check`. |
| `PORT` · `HOST` | Default port and bind address when `--port` / `--host` aren't given. |
| `CLAUDE_DIR` · `CLAUDE_CONFIG_DIR` | Where Claude Code keeps its data (default `~/.claude`). |
| `CODEX_DIR` · `CODEX_HOME` | Where Codex keeps its data (default `~/.codex`). |
| `GEMINI_DIR` · `GEMINI_CLI_HOME` | Gemini CLI's folder (default `~/.gemini`). |
| `CONTINUE_DIR` · `CONTINUE_GLOBAL_DIR` | Continue's folder (default `~/.continue`). |
| `CLINE_DIR` | Cline's extension folder, the `…/globalStorage/saoudrizwan.claude-dev` directory. |
| `ROO_DIR` | Roo Code's extension folder. |
| `NO_COLOR` | Plain output for `--statusline` and `--summary`. |

The VPS installer (`install.sh`) reads `BURNGLASS_PORT`, `BURNGLASS_HOST`,
`BURNGLASS_DIR`, `BURNGLASS_BRANCH` and `BURNGLASS_REPO` (and their `PULSE_` names), plus
`CLAUDE_DIR`.

Other `PULSE_*` / `BURNGLASS_*` variables in the source are test hooks for the automated
suites; they are listed in `CLAUDE.md`.

## Files in `~/.burnglass`

| File | What it holds |
| --- | --- |
| `config.json` | Your settings (above). |
| `history/YYYY-MM.json` | Sealed daily totals, one file per month. |
| `burnglass.log` | The server log, written when Burnglass runs in the background (the Windows exe) or restarts after an update; from a terminal it prints to the console instead. **System** shows the latest lines either way. |
| `server.json` | The running server's port and pid, so `--statusline` and `--summary` can find it. |
| `meters-cache.json` | The last good account-meter reading (percentages and reset times, never a token). Deleted when you turn meters off. |
| `meshy.json` | Meshy task history (credits and task types, never your prompts). |
| `modes.jsonl` | Effort levels logged by the optional hook. |
| `discord-presence.json` | The Discord elapsed-timer start, so updates and quick restarts don't reset it. |
| `tray.ps1` · `tray-error.log` | The tray icon's script and its own output (Windows). |
| `strip.json` · `strip-ui.json` · `strip_cells.json` · `strip-web/` · `webview-strip/` | Burnglass Strip's position, cached data, unpacked popover and WebView2 profile (Windows). |
| `bin/` | An optional home for `burnglass-strip.exe`. |
| `strip-refresh.json` | Exists only while a strip update after a one-click update is still owed (Windows). |
| `migrated-from-pulse.json` | Written once, if your settings were copied from `~/.pulse`. |
