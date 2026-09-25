# HTTP API

The routes the Burnglass server answers on `http://localhost:4747`, for scripts and companions.

[← Back to the README](../README.md) · [All docs](README.md)

---

The dashboard, the status line, the tray and Burnglass Strip all use this API. The routes
they call keep their methods and response shapes across versions (fields are only ever
added), so companions from Pulse 1.x keep working with a Burnglass server.

## Read routes

| Route | Method | Returns |
| --- | --- | --- |
| `/` | GET | The dashboard (`/#mini` for the mini view). |
| `/api/health` | GET | `{ ok, version, pid }` |
| `/api/summary` | GET | The full payload: every period and breakdown plus server state. `?sources=a,b` scopes it to those sources. |
| `/api/statusline` | GET | A slim, memoized feed for `--statusline`, the tray and Burnglass Strip. |
| `/api/logs` | GET | `{ lines }`: recent server log lines (the log view in **System**). |
| `/api/export` | GET | A download of the dashboard's data (below). |

### Export

`/api/export` returns an attachment, with the same `?sources=` scoping as `/api/summary`:

- `?format=json`: the full payload.
- `?format=csv&data=<set>&period=<key>`: a CSV table (UTF-8 with a BOM so Excel opens it
  cleanly, CRLF line endings, costs to 4 decimals). `<set>` is one of:
  - `daily`: one row per day, with a cost column per source;
  - `models`, `sources`, `projects`: the period's breakdowns;
  - `sessions`: the recent-sessions list (not scoped to a period).

  `period` is a period key from the payload (such as `last30` or a month); without it,
  the first period is used. An unknown `data` set answers 400.

The dashboard's **Export** menu (in **Spend**) builds these links for the period and
sources you have selected.

### The summary payload

Among the top-level fields of `/api/summary`:

| Field | What it holds |
| --- | --- |
| `periods` | One entry per period (rolling windows and calendar months) with its cost, tokens, daily series, by-model, by-source, by-effort and by-project breakdowns, cache and fast-mode figures, and `prev` for the previous equal window. |
| `today`, `week`, `totals`, `currentBlock`, `burnRate` | Today, the last 7 days, all-time totals, the current 5-hour block and the burn rate. |
| `recentSessions` | The recent-sessions table. |
| `heatmap` | The weekday × hour grid. |
| `meters`, `codexMeters`, `codexUsage` | Claude account meters, the Codex snapshot and Codex account tokens. |
| `alerts`, `alertThresholds` | Active limit (and anomaly) alerts and your thresholds. |
| `budget`, `planValue` | The budget goal and plan value. |
| `agentState`, `activeNow` | What Claude or Codex is doing right now. |
| `allSources`, `sourceMeta`, `sourceFilter` | Every source seen, custom-source labels, and the applied filter. |
| `meshy`, `discord`, `tray`, `strip`, `startup` | Integration state (`meshy.hasKey`, never the key). |
| `version`, `update`, `reach`, `history`, `memory` | Server facts. |
| `brand`, `home`, `exeName`, `homeMigration`, `integrations` | The product name, the data folder in use, the running exe's file name, the Pulse migration result and the Claude Code status line / effort hook check. |

No login token or API key ever appears in a payload.

## Action routes

Every route below is **POST** and requires:

- the header `X-Pulse: 1` (the header keeps its pre-2.0 name so older companions keep
  working; `X-Burnglass: 1` is accepted too),
- a loopback client (`127.0.0.1` / `::1`),
- a loopback `Host` header (`127.0.0.1`, `::1` or `localhost`).

Otherwise the answer is 403. On a loopback bind, read routes also refuse a foreign `Host`
header (a DNS-rebinding guard).

| Route | Effect |
| --- | --- |
| `/api/shutdown` | Stop the server. |
| `/api/update/check` · `/api/update/install` | Check for a release now · install it (packaged executables). |
| `/api/meters/enable` · `/api/meters/disable` | Turn account meters on or off (Anthropic and ChatGPT together). Turning them off deletes the saved reading. |
| `/api/meters/recheck` | Look for a Claude Code login again and check now. |
| `/api/discord/enable` · `/api/discord/disable` | Turn Discord Rich Presence on or off. |
| `/api/discord/images` | JSON body with any of `claude`, `claudeWorking`, `claudeThinking`, `claudeWaiting`, `codex`, `idle`. Only the slots present change; an empty value restores the built-in art. One invalid value rejects the whole request. |
| `/api/meshy/enable` · `/api/meshy/disable` | Turn Meshy credits on or off. Enable takes an optional JSON body `{ "key": "…" }`; an empty key clears it. |
| `/api/budget/set?amount=…&period=month\|week` | Set the budget; `amount` of 0 or less clears it. |
| `/api/plan/set?amount=…&label=…` | Set the plan cost (0.01 to 1,000,000) and an optional label; `amount` of 0 or less clears both. |
| `/api/tray/enable` · `/api/tray/disable` | Turn the tray icon on or off (Windows). Enable also starts it again (the dashboard's **Retry**). |
| `/api/strip/enable` · `/api/strip/disable` | Turn Burnglass Strip on or off (Windows). |
| `/api/startup/enable` · `/api/startup/disable` | Turn start with Windows on or off. |

None of these take a file path: anything Burnglass launches or writes into the sign-in
entry comes from its own location or your `config.json`, never from a request.

An `/api/…` path that doesn't exist answers a JSON 404.

## Example

```sh
curl -s http://localhost:4747/api/health
curl -s -X POST -H 'X-Pulse: 1' 'http://localhost:4747/api/budget/set?amount=400&period=month'
curl -s -o daily.csv 'http://localhost:4747/api/export?format=csv&data=daily&period=last30'
```
