# CLAUDE.md — working notes for agents on this repo

Burnglass (**formerly Pulse**, renamed in v2.0.0) is a **local,
zero-runtime-dependency usage dashboard** for Claude Code and OpenAI Codex
(plus Gemini CLI, Continue, Cline and Roo Code, read from their own local
logs). One Node server file + a prebuilt React frontend, shipped as
single-file executables. Owner: frank (ReFxFrank). The repo has been renamed
twice: `claudeusage` → `Pulse-Usage-Monitor` → `Burnglass` (session tooling
may still address it by an old name; git remotes and the GitHub API redirect
— which is also why an old name must NEVER be reused, see Frozen identifiers).
Many internal names still say "pulse" ON PURPOSE (the `PULSE_VERSION`
constant, `PULSE_*` env aliases, the `X-Pulse` header, `pulse-*` localStorage
keys, the `Pulse` Run value…): read "Frozen compatibility identifiers" before
renaming anything that still says pulse.

## Hard rules — never break these

1. **Read-only sources:** Burnglass only ever READS `~/.claude` and
   `~/.codex` (and the other agents' logs, and custom-source files). Never
   write, move, or delete anything under those trees — that includes Claude
   Code's `settings.json`: the status line / effort hook check is READ-only
   detection, the setup commands only PRINT snippets.
2. **Zero runtime dependencies:** `server.js` uses Node ≥ 18 builtins only.
   The React toolchain (web/) is build-time only. Don't add npm deps to the
   server, ever. New protocols get hand-rolled (see the Discord IPC client).
3. **`~/.burnglass` is the ONLY writable location** (config, logs, history,
   caches, effort sidecar; `BURNGLASS_HOME` overrides, `PULSE_HOME` is a
   permanent alias; a pinned home is used verbatim and never migrated).
   Documented exceptions, and nothing else:
   (a) the opt-in **run-at-startup** value under `HKCU\…\CurrentVersion\Run`
   — its value NAME stays **`Pulse`** forever (frozen: the installer, the
   toggle and `--install` must share ONE slot or a portable copy and an
   installed copy both start at sign-in) — and the `--install` / installer
   footprint (Start Menu/Desktop `.lnk`s, the HKCU Add/Remove Programs key,
   and the compat `pulse.exe` twin beside `burnglass.exe` in an upgraded
   install dir). Opt-in, per-user (never admin), reversible from the same
   UI; `--install`/`--uninstall` only touch Run values, shortcuts and ARP
   keys that point into their OWN folder, and refuse an Inno-managed folder
   (`unins000.exe` present). The legacy `Pulse*.lnk` / `Uninstall\Pulse` are
   only ever read or deleted on an explicit action, never newly created.
   The one-click update's in-place writes beside the RUNNING exe belong to
   the same footprint: its own swap (`.download` / `.old`), the compat twin,
   and — on the `--after-update` start only — the strip exes that already
   exist there (`burnglass-strip.exe` / `pulse-strip.exe`, each under its own
   name, with `.download` / `.old`; `refreshStripAfterUpdate`). The strip
   refresh NEVER writes inside `~/.pulse`: a strip found only in
   `~/.pulse/bin` gets a fresh copy in `<home>/bin`, and a home or exe folder
   inside `~/.pulse` skips it.
   (b) the **legacy home `~/.pulse`** (Pulse ≤ 1.34). Before the one-way
   migration it IS the home (short-lived commands and a not-yet-migrated
   server read/write it), and a FAILED migration keeps running on it
   (degraded, retried next start). After a successful migration exactly
   THREE compat writes touch it, all gated on the file already existing:
   mirroring `~/.pulse/server.json`, refreshing `~/.pulse/tray.ps1` (v1 tray
   respawn loop), and stripping `meshyApiKey` from `~/.pulse/config.json`
   (after the copy, and whenever v2 changes or clears the key — the user
   supplied it, so it must not survive in a backup they think is inert).
   Compat applies only when `~/.pulse` holds a Pulse file (`isPulseHome` —
   PulseAudio also owns a `~/.pulse`) and is NOT the live home by identity
   (`sameEntry`: dev+ino, realpath fallback — a `~/.pulse` ↔ `~/.burnglass`
   link, or a linked `config.json`, is one home, so the "backup" scrub
   would delete the live key). The strip, when its home IS `~/.pulse`,
   puts its extracted UI + WebView2 profile under
   `%TEMP%\burnglass-strip\` (`AppPaths.ScratchPathOf`) instead.
   Nothing under `~/.pulse` is ever moved, renamed or deleted — so a run
   whose home IS `~/.pulse` (degraded, pinned or linked) writes no file that
   Burnglass later deletes (`meters-cache.json` stays in memory,
   `metersCachePath()` null) and skips the strip refresh (so its retry
   marker `strip-refresh.json` only ever lives in `~/.burnglass`).
   (c) the migration **staging dir** `~/.burnglass.migrating-<pid>-<6hex>`,
   a sibling of the new home: it gets the `BURNGLASS-MIGRATION-STAGE`
   sentinel BEFORE anything else, and cleanup only ever deletes dirs that
   match `^\.burnglass\.migrating-\d+-[0-9a-f]{6}$` AND hold the sentinel
   (sentinel removed last). Never widen that pattern into a glob sweep of
   `$HOME`.
   Neither home is ever deleted by `--uninstall` or the uninstaller.
4. **Binds 127.0.0.1** by default; all state-changing endpoints require
   POST + `X-Pulse: 1` + loopback + Host allowlist (`allowMutation`), and all
   GET /api routes have a DNS-rebinding guard (`allowRead`); an `/api/…` path
   no handler claims answers a JSON 404 `{ok:false,error:'unknown API route'}`
   after that guard (before rc.3 it fell through to the SPA's index.html with
   a 200, which `postJson` read as success). The wire header
   stays **`X-Pulse`** (`X-Burnglass: 1` is accepted as an alias), and
   `requestShutdown` must keep SENDING `X-Pulse` so a v2 can stop a running v1.
5. **Credentials:** OAuth tokens are read read-only, never logged, never in
   payloads, and sent ONLY to their own provider's endpoint. Sync throws in
   `fetchUrl` are routed to callbacks (corrupt cred files must never 500).
6. **Network calls, exhaustively:** GitHub version check + community-reach
   counters (both opt-out, same `updateCheck` gate, public data only, repo
   `UPDATE_REPO = 'ReFxFrank/Burnglass'`) + on the `--after-update` start of
   a packaged Windows exe the SAME release's strip asset (release by tag
   `v<PULSE_VERSION>`, same `updateCheck` gate, public data, nothing sent),
   api.anthropic.com + chatgpt.com meters (opt-in), api.meshy.ai balance +
   task history (opt-in, Bearer key from config), Discord local socket (opt-in, not network). Usage data never
   leaves the machine — the reach counters are PUBLIC GitHub numbers read IN,
   never anything sent OUT. Meshy is the ONLY endpoint Burnglass
   authenticates to with a key the USER supplies rather than one another tool
   already wrote; that key is never logged, never in a payload (only
   `hasKey`), never in a URL, and goes nowhere but api.meshy.ai.

## Frozen compatibility identifiers (do NOT rename)

Old and new processes coexist during every upgrade (a v1 tray / strip /
status-line copy talking to a v2 server, a v2 parent stopping a v1 server,
v1 updaters reading a v2 release). Renaming any of these buys nothing a user
can see and breaks that handoff:

- Installer `AppId` GUID `{76C28179-9CBE-42EA-B9E6-7BE166115AD3}` (the
  upgrade identity), the Inno task names (`desktopicon`/`startup`/`strip`)
  and the `StopPulse` RunOnceId.
- HKCU Run value NAME **`Pulse`** (data points at `burnglass.exe` after an
  installer run; a self-updated `pulse.exe` keeps its own path).
- `X-Pulse: 1` request header; port 4747; every CLI flag; every `/api` route,
  method and response shape (`/api/health`, `/api/statusline`, `/api/summary`
  are parsed by old trays/strips — additive changes only). ONE exception,
  removed in 2.0.0-rc.3: POST `/api/openusage/enable|disable` (only the
  same-version dashboard ever called them — no tray, strip, status line,
  `--stop`/`--summary` or updater did), now a JSON 404. Every other route
  stays frozen.
- Mutex names `PulseTray<port>` and `PulseStrip_SingleInstance`.
- localStorage keys `pulse-graphics`, `pulse-alerted`, `pulse-source-filter`,
  `pulse-period`, `pulse-theme` (+ the new `pulse-home-notice` and
  `pulse-dismissed-notices`, same prefix).
- `PULSE_*` env vars (permanent aliases; `BURNGLASS_*` wins, an empty
  `BURNGLASS_X=` never masks a real `PULSE_X`); the `PULSE_VERSION` constant
  name (make-exe's drift check greps it; `BURNGLASS_VERSION` also accepted).
- Discord client id `DISCORD_CLIENT_ID_DEFAULT` and the art keys `claude`,
  `codex` and **`pulse`** (the idle key — the art behind it is swapped, the
  key is not; a new key would blank the idle art until uploaded + cached).
- Release asset aliases: EVERY 2.x release must also carry byte-identical
  `pulse.exe`, `pulse-linux`, `pulse-macos` (+ `pulse-strip.exe`) — v1.x
  `platformAssetName()` matches those exact names; without them the whole
  installed base can no longer update in one click (fails closed to manual).
- **Never create a new GitHub repo named `Pulse-Usage-Monitor` or
  `claudeusage`** under ReFxFrank: GitHub drops the rename redirect the moment
  an old name is reused, and every v1.x updater, reach counter and README link
  breaks at once.
- `alerts[].provider` values and other payload enums (e.g. `provider:'pulse'`
  on internal alerts) — the web app and old companions switch on them.

## Layout

- `server.js` — everything: parsers, pricing, aggregation, meters, Discord
  presence, self-update, home migration, daemon mode, HTTP server. ~8500
  lines, organized in ALL-CAPS banner sections; grep for `---` banners to
  navigate.
- `web/` — Vite + React frontend, **no UI kit** (Radix and framer-motion
  were removed in the v2 Command Center redesign); `web/dist` is committed
  (the server serves it; the SEA build embeds it). See "Web app" below.
- `build/make-exe.mjs` — Node SEA single-executable build (postject); writes
  `dist-exe/burnglass(.exe|-linux|-macos)`; errors if `PULSE_VERSION` (or
  `BURNGLASS_VERSION`) ≠ package.json version. On Windows it stamps the
  Burnglass icon + version resource into the node.exe copy BEFORE postject
  (kernel32 `UpdateResource` via powershell.exe, no deps) and falls back to a
  plain build if stamping/postject/`--version` fails (`BURNGLASS_EXE_ICON=0`
  skips it).
- `build/installer.iss` — Inno Setup 6 → `BurnglassSetup.exe`;
  `build/brand/burnglass.ico` — the app icon (exe, installer, shortcuts, ARP).
- `strip/` — Burnglass Strip, C# WinForms + WebView2 (`BurnglassStrip.csproj`
  → `burnglass-strip.exe`).
- `.github/workflows/release.yml` — 3-OS matrix (win/linux/mac arm64) via
  `workflow_dispatch` with `tag` (+ optional `prerelease`) inputs (tag pushes
  are blocked by the proxy in remote sessions — always dispatch, don't push
  tags).
- `.github/assets/` — README art: `logo.svg` / `logo-light.svg` (the Glass
  lockup for dark / light GitHub themes) and the 1440-dark
  screenshots `hero.png`, `panels.png`, `server.png` (keep each < 400 KB).
- `install.sh` (VPS; reuses an existing `~/pulse` checkout / `pulse.service`
  under their old names), `burnglass.sh` / `burnglass.cmd` launchers
  (`pulse.sh` / `pulse.cmd` are shims).
- `test/` — self-contained e2e suites + mock provider servers. `bash
  test/run-all.sh` runs everything (needs only Node + curl; no real logins).

## Web app (web/src) — the v2 "Command Center"

- `App.jsx` = the frame and ALL cross-section state: rail (≥1024 px: brand
  lockup, section nav with active tracking, period radios, source
  checkboxes, all-time, Mini view, Stop), top bar, `<1024` mobile header +
  bottom `Sheet`s, page-level `WarnBar`s (unreachable, self-check,
  `HomeNotices` = the one-time migration notice / failed-migration warning /
  missing status-line or hook exe — ONE bar per missing file via
  `integrationIssues` (the documented effort hook sits under TWO hook
  events, so the payload repeats it), each dismissible per issue signature
  stored in `pulse-dismissed-notices`), the whole-page states (loading,
  unreachable, stopped, no data) and the `#mini` route. Sections receive the
  same `SectionProps` `{id, data, period, colorMap, srcFilter, thresholds,
  notify, gfx, theme, onStopped, onPeriod}`.
- `sections/<Name>.jsx` + `<Name>.css` (CSS scoped under `.sec-<name>`), in
  page order: `Alerts` (strip above the KPIs), `Kpis`, `Limits` (Account
  limits grid from `meters.jsx` + `BudgetPanel` gauge + `PlanPanel` — a month
  bar click calls `onPeriod`), `Spend` (`SpendChart` from `charts.jsx`, Export
  `Menu`, By-source table, `EconStrip` = cache savings / fast mode / daily
  pattern), `Breakdown` (`ModelTable`, effort panel, `ProjectTable`),
  `Activity` (`Heatmap`, `SessionsTable`), `Meshy` (`MeshyKeyForm` shared
  with System), `System` (`ServerColumn` facts incl. data folder + Claude Code
  hooks, `Integrations` toggle grid, `DiscordImagesForm`, `LogTail`). The
  Tray icon row reads `payload.tray`'s diagnosis (`trayView`): Icon running
  (+ the ^ chevron hint) / Starting… / Checking… / No check-in / Not running
  with `lastError` (exit code, message, a `TRAY_HINTS` hint per kind, where
  `burnglass.log` + `tray-error.log` live) and Retry (re-POSTs
  `/api/tray/enable`). No OpenUsage row (retired in rc.3).
- Shared: `styles.css` (tokens — the Glass palette, dark/OS-light/forced-light
  blocks — base, 12-col grid, primitives), `ui.jsx` (Section, Panel, Btn,
  Switch, Seg, Tip/InfoTip, Menu, Sheet, MeterBar, WarnBar `tone: warn|crit|
  info`, StopButton…), `icons.jsx` (one 16 px icon set + `BrandMark` /
  `Wordmark`; `brand/` holds the mark/favicon assets Vite fingerprints),
  `lib.js` (formatters, `srcLabel`, `prettyModel`, `makeColorMap`,
  `meterTone`, `exportHref`, `postJson` (adds `X-Pulse`), prefs, `useSummary`).
- Brand in copy: `BRAND` only (never a literal product name; `FORMER_BRAND`
  exists solely for rename copy); paths via `homePath(data, sub)` (from
  `payload.home` — NEVER a literal `~/.pulse`/`~/.burnglass`); exe FILE
  names via `exeName(data)` (`payload.exeName`, a self-updated install is
  still `pulse.exe`) with `EXE_NAME` as the fallback; any COMMAND the user
  should type via `launchInfo(data)` — `.cmd` is `node server.js` from
  source (`packaged === false`, exeName null), `./burnglass-linux` for a
  POSIX binary, the (quoted if needed) name for a Windows exe; double-click /
  `--install-shortcuts` copy only when `.shortcuts` (packaged Windows).
  These + `integrationIssues`/`integrationRows` live in the React-free
  `notices.js` (re-exported by lib.js; unit-tested by
  `test/web-notices.test.sh`). The brand sub-line (`BrandSub`) WRAPS its
  parts instead of ellipsizing, so a pre-release version (`v2.0.0-rc.1`)
  is never cut in the 240 px rail.
- Colour only from tokens (no hex in JSX/section CSS); source colours
  `--s1…6` for SOURCES only; `--warn`/`--crit` for status only; the ember
  orange never becomes a UI token (it lives only inside the mark assets).
  No `backdrop-filter`, nothing animates forever, transitions only on
  hover/focus (lite + reduced motion drop them). 360–3840 px with no
  horizontal scroll.
- Width: NO content cap — `.content` fills `.main` at every width and the
  `.topbar` uses the same `0 var(--gutter)` padding, so its contents sit on
  the content edges (the owner runs 4K = 2560–3840 CSS px at 150–100 %
  scaling; a capped column — 1600, then a centred 2000 in rc.2's first cut —
  left a dead band the owner explicitly rejected; do not reintroduce a cap). Sections
  scale on the 12-col grid; the heatmap cells grow to 36 px via a container
  query and By-source keeps its stacked layout beside the chart (its
  side-by-side table/all-time split is ≤ 1360 px only). The rail stays pinned left. The rail is 8 px side padding + 8 px
  item padding (row content 16 px in, level with the brand mark — `.brand`
  padding 8 px); source rows (`.srcrow .opt`) use 6 px gaps and `.rail-in`
  `scrollbar-width: thin`, so "Claude Desktop" fits beside a four-figure
  amount in the 240 px rail (longer labels ellipsize, amounts never clip).
  With `scrollbar-color` set on body (inherited), Chromium 121+ IGNORES
  `::-webkit-scrollbar` — size scrollbars with `scrollbar-width`. Spend's
  side-by-side "wide By-source" container query (≥ 640 px) is nested in
  `@media (max-width: 1360px)` (only where the panel spans the row);
  Activity's `.hm-row` is an inline-size container, cell height
  `clamp(26px, (100cqi - 69px)/48, 36px)` (= half the cell width).

## Feature map (where things live in server.js)

| Feature | Key functions / constants |
|---|---|
| Claude transcript parsing | `parseFile`, `normalize`, `dedupKey`, mtime `fileCache`; per-file dedup keeps the FULLER copy of a duplicate key (more `outputTokens`; tie → the line carrying `usage.iterations`) at the FIRST line's ts — Claude Code ≥ 2.1.281 writes a subagent message as several lines (one per content block, `apiBlockIndex`) whose first line has PARTIAL streaming usage; `advisorEntries` turns each `usage.iterations[]` item of type `advisor_message` (own `model`, excluded from top-level usage, billed at the advisor's rates) into its own entry keyed `<key>:adv<i>`, model falling back to the entry's `advisorModel`; parse-time marks (`iters`, advisor list) live in a parallel `marks[]` array in `parseFile` — NEVER as properties added then deleted on entries (V8 dictionary mode: +50% heap on 50k entries, caught in review) |
| Codex rollout parsing | `parseCodexFile` (token_count deltas, `turn_context` model+effort, replay-safe keys, `preModelEntries` backfill; `cache_write_input_tokens` (≥ 0.145, subset of input, disjoint from cached) → `cacheWrite5m`; the EFFECTIVE service tier from the persisted `thread_settings_applied` event (`thread_settings.service_tier`, state snapshot, incl. a TUI-resolved model default — GPT-6 Sol/Luna default to `priority`) → `speed:'fast'` for `priority`/`fast`; LIMITATION: Codex does not persist the snapshot for a brand-new session until resume/compaction/fork/settings change (`emit_applied` skips an unmaterialized rollout; `TurnContextItem` has NO tier), so early fresh-session turns price standard — never infer the tier from the model default, `codex exec` doesn't apply it; SUBAGENT rollouts (spawn_agent threads, the `codex-auto-review` guardian, `/review`) = `session_meta.source.subagent` object and/or `parent_thread_id`/`thread_source:'subagent'` → `sidechain: true` in the entry literal; current Codex gives them the ROOT's `session_id`, legacy (< 0.144) only their own `id`, so `groupSid` = `session_id` → parent id → own id becomes `sessionId`, while the replay-safe dedup key keeps the file's own `sid`) |
| Other-agent parsing | `parseGeminiFile` (`~/.gemini/tmp/*/chats/session-*.jsonl`; `tokens{input(incl cached),output,cached,thoughts,tool}`+`model`; dedup by id last-write-wins; provider `google`/source `gemini`), `parseContinueFile` (`~/.continue/dev_data/*/tokensGenerated.jsonl`; camelCase, `{name,timestamp,data}` envelope; LOCAL ESTIMATES → `estimate:true`; dedup by path+lineIndex; provider inferred from model), `parseClineFile` (VS Code `globalStorage/saoudrizwan.claude-dev/tasks/*/ui_messages.json`; `api_req_started.text` is stringified JSON `{tokensIn,tokensOut,cacheWrites,cacheReads,cost}`; uses Cline's OWN `cost`; model from sibling `task_metadata.json` `model_usage` state-snapshot, else `unknown`), Roo Code = same function w/ `source='roo'` (Cline fork, same layout; ext ids `rooveterinaryinc.roo-cline` + `.roo-code`, `rooExtensionDirs`/`rooTaskFiles`, `ROO_DIR` override; trusts Roo's recorded cost; model precedence ROO-ONLY record-level `modelId` > metadata timeline > `unknown` — the record probe is deliberately not applied to Cline; precise Roo model state is in a SQLite DB Burnglass deliberately doesn't read); `agentEntry` skeleton; `taskFilesUnder`/`vscodeGlobalStorageBases` (Code/Insiders/VSCodium/Cursor/Windsurf + `.vscode-server`); all dispatched by set-membership in `parseAll` |
| Custom sources (config) | `customSourcesConfig` (validates `customSources[]` rows `{name,path,label?}` — letter-first slug regex, `CUSTOM_SOURCE_RESERVED` incl. `mixed`, max 8, dropped rows warn ONCE w/ reason via `customSourceWarned`; label control-char-stripped + capped 24 and anti-spoof/anti-collision — falls back to name), `customSourceFiles` (path = file OR dir walked for `*.jsonl`; missing → `[]`), `parseCustomFile` (schema `{ts req (ISO\|epoch ms\|epoch s), input/output/cached (cached ⊆ input → inputTokens=input−cached, cacheRead=cached), id? (dedup LAST-write-wins, else path+line), sessionId?, project?, cost? TRUSTED verbatim else $0, estimate?}`; provider `custom`, ALWAYS `costFromSource:true` so nothing re-prices; `CUSTOM_SOURCE_MAX_BYTES` 50MB size guard returns the EMPTY shape so the skip caches); parseAll: builtin-claimed files are REFUSED to custom sources (warned once — a re-sourced file would double-count vs archive), fileCache records carry `route` (`custom:<name>`\|builtin) so a config rename/add/remove invalidates cached parses w/o an mtime change, global merge is a key→idx Map where `provider==='custom'` + newer `ts` REPLACES (cross-rotated-file LWW); **name = archive identity**: seal marks custom cells `c:1` + estimated cells `est:1`, `pickCell` ORs the marks, buildPeriod pass 2 / totals merge retire archive-only `c` cells whose source ∉ `customSourceNames()` on days with live custom coverage, `mergeDayRecord(existing, fresh, customNames)` does the same on re-seal (HEALS the month file; removal ≠ rename — a source sealing no custom rows keeps its history), readHistory/filterHistory carry `est`/`c` + `hist.estSources` feeds `estimatedSources`; prototype-pollution hardening: `sessMap`/`byModel`/`bySource`/`effortSpend`/`byProject`/parse sessionMeta are null-prototype; `nonClaudeEntry(e)` (= `AGENT_SOURCES.has(source) \|\| provider==='custom'`) gates the 5h block, selfCheck and Discord `activeProvider`; `payload.sourceMeta` `{key:{label}}` → web `srcLabel(key, meta)` in lib.js threaded through the rail source list / chart legend + tooltip / By-source table / SessionsTable / mini — KEYS stay raw in filters/CSV/React keys. The strip popover's donut is per SOURCE (custom labels included); its per-provider cards + taskbar Claude price still fold custom sources into Claude (known limitation) |
| Pricing | `PRICING` (Anthropic + Zhipu/Z.ai `glm-*`, which arrive via Claude Code's Z.ai Anthropic-compatible proxy and price through the Claude path w/ longest-prefix match), `PRICING_OPENAI` (exact rows; prefix fallback ONLY for date suffixes — OpenAI `-mini`/`-pro` are different models; rows may carry `longContext: true` → `openaiTokenCost` bills a request whose prompt (inputTokens+cacheRead) exceeds `OPENAI_LONG_CONTEXT_TOKENS` 272K at 2×/1.5× (Astra, 5.6 family, 5.5, 5.4), and `history: [{until, …price}]` DATED steps → `priceStep(p, ts)` returns the price in force at the entry's own date (5.6 cuts: Terra/Luna 2026-07-30, Sol 2026-08-21 promo — re-check 2026-11-21); `gpt-5.6` is an official alias sharing Sol's row object (`GPT56_SOL`); `canonicalOpenAIModel` strips a generic `[<region>.]openai.`; per-row `fastMult` (published Fast multiplier, NOT uniform: 2× GPT-6/5.6/5.4/5.2/5.1/5, 2.5× gpt-5.5, 1.8× gpt-5-mini; absent → a fast entry prices standard) and `cacheWriteMult` (1.25× on rows with a PUBLISHED cache-write price: GPT-6 Astra/Sol/Luna, 5.6 family, 5.6-cyber; absent → writes bill as plain input), both applied in `openaiTokenCost(e, p, speed)` (long-context test = uncached + written + cached), mirrored in `standardCostForEntry` (OpenAI fast premium) and `cacheEconomicsForEntry` (write premium); Daybreak aliases share the underlying rows; flex tier + regional-processing uplift unmodelled; verified 2026-09-24), `PRICING_GOOGLE` (`priceForGoogle`, longest-prefix but fallback ONLY for snapshot suffixes — `-preview`/`-latest`/`-exp`/`-thinking` + optional date/build stamp, or a bare `-001`-style stamp; a tier/modality remainder like `-lite` or `-preview-tts` falls to the LOGGED default, never the parent tier's rate; cached=10% of input; July 2026 Gemini rates); `costForEntry` dispatches `openai`→OpenAI, `google`→Google, else Claude path; a `claude-*` PREFIX match whose remainder is not `-YYYYMMDD`/`-latest` (an unpriced point release) keeps the parent's rate but LOGS via `logUnknownModel(model, borrowedFrom)` ("priced as …"), so a new model can't silently ride its parent's price (Opus 5.5 did); `canonicalClaudeModel` reduces partner-cloud forms (`[global.\|us.\|eu.\|apac.\|jp.]anthropic.<id>[-v1[:0]]`, `<id>@YYYYMMDD`) to the canonical id for the lookup only (raw string stays the display model); retired Opus 4 / Sonnet 4 dated + alternate ids have EXPLICIT rows (no bare `claude-opus-4` prefix — an unknown 4.x id must still log); `claude-mythos-preview` = $25/$125 (Glasswing page), explicit key, no mythos prefix row; unknown models log once + `__default__`; **fast mode** — rows carry optional `fastInput`/`fastOutput` (Opus 5 + Opus 4.8 only, $10/$50) and `priceFor(model, ts, speed)` applies them when the entry's own `usage.speed === 'fast'`, ahead of the intro-price check; cache multipliers stack off the resulting input rate; **per-row `cacheReadMult`** (Fable 5.1 / Mythos 5.1 bill cache reads at 0.025×, $0.25/M — everything else the global `CACHE_READ_MULT` 0.10) is carried on the object `priceFor` returns so `claudeTokenCost` (the ONE Claude token-cost helper shared by `costForEntry`/`standardCostForEntry`) and `cacheEconomicsForEntry` agree; **`usage.inference_geo === 'us'`** → `e.geoUs` → `INFERENCE_GEO_US_MULT` 1.1× on every token category (never on web-search calls), savings/premiums scaled alike; Sonnet 5's $2/$10 launch price became permanent 2026-08-10 (plain row — the intro* machinery stays for future launches); `claude-mythos-5(-1)` rows; Anthropic rows verified 2026-09 |
| Effort chips | `recordedEffort(rec.effort)` → `parseEffort` (`effort` = the level actually sent; `perTurnEffort` (≥ 2.1.281) is deliberately IGNORED — always written but only sent under a beta, and a parseEffort is authoritative so it would block a real `/effort` echo; `NON_EFFORT_LEVELS` auto/default/none/off/unset/adaptive never chip) (Claude Code ≥ 2.1.212 writes the level top-level on each assistant entry — authoritative for THAT entry; `annotateModes` lets events fill only unrecorded entries, and ultracode still comes solely from events), `parseLocalCommand`, `parseEffortStdout` (interactive-picker confirmation echoes), `mergeModes`, `annotateModes` (state-snapshot join: latest event ≤ entry.ts; `parseEffort` is the immutable Codex-side input); CLI: `--effort-setup` (`effortSetup`) PRINTS (never writes) a Claude Code settings.json hook snippet, `--mode-hook` (`runModeHook`) is that hook — writes the settings-persisted effort level to the `<home>/modes.jsonl` sidecar (`readModes` also merges a legacy `~/.pulse/modes.jsonl` read-only — an un-updated v1 exe may still be the hook) (covers the cross-session case transcript parsing can't; still never writes under `~/.claude`) |
| Analytics breakdowns | `buildPeriod` also emits per-period `effortSpend` (bucket = ultracode\|level\|default), `byProject` (top 30 by cost + `(other)`), `liveCost` — all LIVE-only (archive keeps no per-entry effort/project); UI: `sections/Breakdown.jsx` (effort panel, `ProjectTable`) |
| Period comparison | each period carries `prev` = `{cost,tokens,messages}` for the immediately-preceding equal-length window (rolling: the N days before; month: prior calendar month), via the `windowTotals` closure in `aggregate` (reuses `buildPeriod` so the prev baseline merges live+archive identically to a period's own cost; month prev just references the prior month's already-built period); UI: the hero tile's delta in `sections/Kpis.jsx` (`HeroTile`), hidden when `prev.cost<=0` |
| Subscription value | `computePlanValue` → `payload.planValue` = `{configured,cost,label,spend30,multiplier,months[]}` (months = up to 6 most recent calendar-month periods, OLDEST FIRST, so live+archive merge exactly as the dashboard's own periods do); config `planCost` + `planLabel`, set via POST `/api/plan/set?amount&label` (allowMutation; amount≤0 clears BOTH). Account-level, so `buildSummary` overwrites it under `?sources=` — `spend30` stays unfiltered on purpose. UI: `PlanPanel` (`sections/Limits.jsx`, inline set like the budget; month bars against a 1× line, clicking a month bar selects that month via `onPeriod`; <1× renders neutral, never red) |
| Cache economics | `cacheEconomicsForEntry` (beside `costForEntry`) → per-period `cacheSavings` = `{readTokens,saved,writePremium,net}`. `saved` = reads × input × (1−`CACHE_READ_MULT`); `writePremium` = the EXTRA over plain input (5m `×0.25`, 1h `×1.0`) — caching is not free, so `net = saved − writePremium` and is deliberately NOT clamped (a write-heavy window is genuinely negative). OpenAI rows with a published `cacheWriteMult` (GPT-6, 5.6 family, 5.6-cyber) add their write premium (`cacheWrite5m` × input × (mult−1), long-context/fast scaled); other OpenAI rows and Google contribute `writePremium: 0`; both use their own cached-input rate. LIVE-only (archive keeps no per-entry token types); UI: `EconStrip` in `sections/Spend.jsx` |
| Fast-mode spend | `standardCostForEntry` (= `costForEntry` forced to `speed:'standard'`) → per-period `speedSpend` = `{fast:{cost,tokens,messages},standard:{…},fastPremium}`; `fastPremium` = actual − standard, so a `speed:'fast'` entry on a model with NO fast row contributes exactly 0 rather than being mispriced. LIVE-only; UI: `EconStrip` fast-mode cell (`sections/Spend.jsx`) + the By-model fast count |
| Summary CLI | `--summary` — terminal readout (today/7d/30d spend+tokens, meter % + reset countdowns, plan multiplier, top 3 models). Server discovery + fail-open modelled on `--statusline`: GET `/api/summary` from the running server via the freshest live `server.json` (`readRuntimeFile`), else compute in-process; `NO_COLOR` respected; ALWAYS exits 0 |
| Budget goal | `computeBudget(periods, week, now)` → `payload.budget` = `{target,period,label,spent,pct,remaining,resetsAt,state,projected}` (state ok\|warn≥80\|over≥100 on ACTUAL spend; `projected` = straight-line month-end pace `spent/elapsedFraction`, null for week budgets — a rolling window has no end to project to — and null in the first ~half day of a month); month = current calendar-month period cost (resets 1st), week = trailing-7d `week.cost` (rolling); config `budget`+`budgetPeriod`, set via POST `/api/budget/set?amount&period` (allowMutation; amount≤0 clears); UI: `BudgetPanel` (`sections/Limits.jsx`: arc gauge with a pace marker, settable inline; amber ≥80% of target / red > target) |
| CSV/JSON export | GET `/api/export` (allowRead-guarded like every read; same `?sources=` scoping as summary) — `format=json` → full payload w/ attachment headers; `format=csv&data=daily\|models\|sources\|projects\|sessions&period=<key>` → `exportCsv` (RFC-4180 via `csvCell`/`csvTable`, CRLF, UTF-8 BOM, cost 4dp via `csvMoney`; daily = per-source cost columns; sessions = recentSessions, NOT period-scoped; unknown data → 400); UI: the Export `Menu` on the Spend panel (`sections/Spend.jsx`; `lib.exportHref` builds plain same-origin GET links w/ `download`, carrying the active period + source filter) |
| 5h block | `aggregate` — official window from meters `five_hour.resets_at` when available (`official: true`), else log reconstruction; a `five_hour` restored from `meters-cache.json` makes it official right after a restart |
| Historical retention | `pickCell` breaks an equal-message tie toward argument `a` = the LIVE / freshly-sealed side at every call site (`mergeDayRecord` passes `fresh` first for exactly this), so a PRICE CHANGE reaches days that are still in the live logs and the next re-seal heals the month file; a day whose logs already pruned keeps its sealed cost (no token breakdown to re-price from). `sealHistory` (writes sealed past days → `<home>/history/YYYY-MM.json`, gated 5 min, re-seals until pruned), `readHistory` (mtime-cached), `filterHistory`; merged in `aggregate`/`buildPeriod` — live day wins, archive fills gaps (never double-counts); augments `totals`; on by default (`{"history": false}` off) |
| Claude account meters (opt-in) | `refreshAccountMeters`, `parseMeterBucket`, `METER_LABELS` (provider-prefixed; incl. `seven_day_cowork`/`seven_day_oauth_apps`), **undisclosed top-level keys** (rotating Anthropic codenames — `nimbus_quill`, `cinder_cove`, `omelette_promotional`… — never documented) are HIDDEN by `parseMeterBucket` while at 0% and shown with a humanized label only once they carry usage, **utilization and `limits[].percent` are 0–100 percentages** (Claude Code's schema; NO ≤1-means-fraction rescale — that rendered 0.9% as 90%; the 0–1 values come from rate-limit HEADERS, not this endpoint), `limits[]` array → model-scoped weekly rows (`kind === 'weekly_scoped'`, `scope.model.display_name`, e.g. Fable), 429 backoff + last-good retention, macOS Keychain via `readOauthTokenAsync`; refresh is DASHBOARD-driven — `metersForPayload(background)`/`buildSummary(_, {background})` make the status line & Discord only trickle it (`BACKGROUND_METERS_MS` 15m) so Burnglass doesn't 24/7-poll the shared endpoint. Burnglass only ever READS the token (never mints/refreshes one — no OAuth in Burnglass); `no-login`/`expired`-without-bars render a `ConnectClaude` card (meters.jsx) whose **Recheck now** hits POST `/api/meters/recheck` (allowMutation) → clears `credCache` + backoff + re-fetches, so a fresh Claude Code login is picked up with no restart. **Last-good snapshot survives a restart**: `<home>/meters-cache.json` (`persistMetersCache`/`restoreMetersCache`/`removeMetersCache`, `metersCachePath`) = `{v:1, fetchedAt, buckets[{key,label,pct,resetsAt}]}` + `{nextAttemptAt, streak}` only while a 429 backoff is active — NO token or token-derived value; tmp + rename, 0600 on POSIX; written after each good fetch or 429 and by recheck/enable (clears the backoff), only while accountMeters is on and only by the port owner (`metersCacheOwner`, set by `restoreMetersCache` in the listen callback after `migrateHome` — `--summary` never writes it); deleted by `/api/meters/disable` and at a start with meters off; null path (memory only) when the live home IS `~/.pulse` by `sameEntry` (rule 3b — this file gets deleted). Restore: readings ≤ `METERS_CACHE_MAX_AGE_MS` 12 h old (≤ 60 s in the future), every row re-validated (types, control chars, dup keys, pct clamped, known keys relabelled from `METER_LABELS`), rolled windows (resetsAt passed) dropped, `status:'ok'` with `fetchedAt` = `lastGoodAt` = the REAL time; restored rows are NOT fed to `recordMeterSamples`; next check at `fetchedAt + METERS_OK_MS` (at once if a window rolled); a saved backoff is honoured (capped `METERS_429_MAX_MS`) as 'rate-limited' via `metersRateLimitMessage(remaining)`, and a streak whose backoff ended < 1 h ago keeps doubling; corrupt/foreign/>256 KB files ignored with a log line. A different Claude login between runs shows the old account's numbers only until the next good fetch. `metersForPayload` marks EVERY Claude bucket `stale: resetsAt <= now` (the Codex rule) — last-good rows outlive their windows during a backoff, an expired login or after a restore — so `computeAlerts` skips it, `statuslineMeterPcts` drops a stale `claudeWeekly` and sets `claudeFiveHourStale`, `--summary` and the strip skip it, the web dims it (`staleNote(provider)`: Claude "waiting for the next check", Codex "run a turn"); a check failing with no-login/expired runs `dropRolledMeterBuckets` (every window rolled → the Connect card again). `METER_KEY_RESERVED` (`__proto__`/`constructor`/`prototype`) + own-property `meterLabelFor` in `parseMeterBucket` AND `cachedMeterBucket` (a proto key once produced an OBJECT label → React #31, blank page; web `meterName` mirrors it). The 429 text is RE-RENDERED from `nextAttemptAt` on every payload (`retryInText`: "in ~Nm", "now" ≤ 30 s; Codex usage too via `codexUsageRateLimitMessage`) — it used to freeze at the wait computed when the 429 arrived. Suite `test/meters-cache.test.sh` |
| Codex meters (automatic, local) | `codexMetersFromSnapshot` — newest rollout `rate_limits` snapshot; a snapshot only wins if a window has finite `used_percent` (at-limit snapshots can be empty) |
| Codex account tokens (opt-in) | `refreshCodexUsage` — GET chatgpt.com/backend-api/wham/profiles/me with `~/.codex/auth.json` token + `ChatGPT-Account-Id` header → `stats.{lifetime_tokens, peak_daily_tokens, daily_usage_buckets}`; `normalizeCodexUsage` (date-validated buckets, empty-stats = ok-with-zero) |
| Discord Rich Presence (opt-in) | `discordConnect` (hand-rolled IPC: 8-byte LE header + JSON over named pipe / unix socket, candidates incl. snap/flatpak), `buildDiscordActivity` (rotating pages Today / Past 7 days / All-time, wall-clock derived; large_image tracks `payload.activeProvider` — claude/codex art keys, else `pulse` (the FROZEN idle key, now holding the Burnglass art); `large_text` idle = 'Burnglass — idle', button 'Get Burnglass' → `BURNGLASS_REPO_URL`; second `state` line from `payload.activeNow` = newest MAIN-conversation entry of the active provider within ACTIVE_MS 15m — skips `sidechain` (Claude Code `isSidechain` in the normalize literal; Codex subagent rollouts in parseCodexFile), `advisor` entries, `codex-auto-review`, hidden models; if only sidechains wrote in the window, looks back ≤ `ACTIVE_MAIN_LOOKBACK_MS` 24h for a live session's main entry (long workflows) — + distinct live sessionIds, helpers excluded (subagents share the parent's id): "Opus 5.5 · Extra High · 3 sessions" via `prettyModelName`/`effortLabel`; absent when idle; config `discordShowModel: false` hides it; the image keys pass through VERBATIM, so an https URL works — the ONLY way Discord animates a GIF/animated WebP (uploaded Art Assets are PNG/JPEG/WebP stills, per Discord docs 2026-04); Discord's media proxy fetches it, not Burnglass; an `evt:'ERROR'` reply sets status error and a later accepted `SET_ACTIVITY` (`evt:null`) clears it on the same socket; the slots are settable from the dashboard via POST `/api/discord/images` (allowMutation, JSON body through `readJsonBody` `{claude?, codex?, idle?}` → `DISCORD_IMAGE_SLOTS` config keys; `validDiscordImage`: the RAW string must be `https://host…` (the URL parser forgives `https:host`/backslashes, Discord gets the raw string) + `new URL` https + no userinfo (public presence), printable ASCII, ≤ `DISCORD_IMAGE_MAX` 256, scheme lowercased; else an art-asset key lowercased; empty → null = built-in; ALL-or-nothing; resets `discordLastActivity` + ticks so it publishes immediately) and read back as `payload.discord.images`; UI `DiscordImagesForm` (`sections/System.jsx`) has NO preview on purpose — rendering the link would make the dashboard fetch it; it POSTs ONLY the edited slots, keeps the save reply as its baseline until a NEWER poll (`sig` of the payload images) arrives — the dashboard polls every ~10 s, so without that, Cancel/next-save used stale props and wiped the just-saved slot — and disables inputs while saving), `DISCORD_CLIENT_ID_DEFAULT` = the official app (public identifier; FROZEN — renamed to Burnglass in the Developer Portal, same id); reconnect is resilient — `discordIpcCandidates` tries both Windows pipe forms (`\\.\pipe\` + `\\?\pipe\`), `net.connect` is try/caught, and a failed sweep does fast re-sweeps (`DISCORD_FAST_RETRY_MS` 4s, `discordNotFoundStreak` ≤4 via a one-shot timer) before backing off to `DISCORD_RETRY_MS` 30s, so a server-restart-while-Discord-runs race heals in seconds; elapsed-timer anchor (`discordPresenceStart`) PERSISTED to `<home>/discord-presence.json` (copied by the migration, so the v1→v2 hop keeps the timer) so a self-update relaunch (`IS_AFTER_UPDATE`) or brief restart (heartbeat < `DISCORD_START_GRACE_MS` 10m) CONTINUES the timer instead of resetting to 0; long-gap cold start resets |
| Live agent state (Discord state art) | `claudeConvStep` (parseFile, same pass: MAIN-thread end state — prompt / tool_use (+ `open` tool_use id→name until its tool_result) / tool_result / reply / error / interrupt / command; compact_boundary = prompt; a new prompt or interrupt clears `open`; sidechain lines only bump `sideTs`) and `codexConvStep` (parseCodexFile: task_started/turn_started/user_message = prompt, function/custom/local_shell call = tool_use until its `*_output`, task_complete/turn_aborted = reply; a subagent rollout contributes only `sideTs`) → per-file `conv` in `fileCache` → parseAll merges per sessionId (newest main state, max sideTs). `computeAgentState(conv, now)` → `payload.agentState` = `{provider, state: waiting\|working\|thinking\|idle, sessions, source}`: Claude Code's live-session REGISTRY `claudeDir()/sessions/<pid>.json` (≥ 2.1.119, undocumented; `claudeLiveRegistry` reads ONLY `^\d+\.json$` files — the dir also holds `<pid>.<hash>.key` peer-token files that must never be read — filtered by name AND `pidAlive(<pid in the NAME>)` BEFORE the 256 cap (`pidAlive` = `process.kill(pid,0)`, EPERM = alive); a LEFTOVER on a reused pid is rejected: Linux `pidStartedAfter` (real start = `/proc/stat` btime RE-READ each scan (the kernel recomputes it after clock steps) + `/proc/<pid>/stat` field 22 / 100 — NOT the /proc dir ctime, procfs stamps that at first lookup; no wall-clock boot test on Linux); elsewhere mtime before `BOOT_AT_START` (fixed at server start — recomputing Date.now()−uptime per scan moved with clock steps; Windows Fast Startup makes it weeks old) AND `pidLooksLikeClaude` (async `tasklist /FI "PID eq n"` / `ps -o comm= -p n`, argv arrays, cached per pid 10 min, image must match `CLAUDE_IMAGE_RE` claude\|node\|bun, unknown/pending = trusted; test hook `PULSE_IMAGE_CHECK=ps|tasklist|off`, off on Linux by default); plus in computeAgentState `REG_BUSY_MAX_MS` 6 h (`PULSE_REG_BUSY_MAX_MS` test hook) / `REG_IDLE_MAX_MS` 24 h since the last sign of life, where only the NEWEST record per sessionId may borrow the transcript as a sign of life (`claude --resume` keeps the sessionId); only the `status` field is used; memo `PULSE_LIVE_STATE_MEMO_MS` 3 s): waiting → waiting; busy/shell → working if the session's transcript has an open tool_use (open `WAITING_TOOLS` AskUserQuestion/ExitPlanMode → waiting) or shell, else thinking; idle → working if a subagent wrote within `SIDE_ACTIVE_MS` 30 s, else idle. When the registry lists any TRUSTED live session it is authoritative for Claude (a session missing from it has exited — a transcript ending mid-tool must not show working); otherwise transcript fallback `convState` (expires after `LIVE_STATE_MAX_AGE_MS` 15 min). Codex always uses its rollouts (it never persists approval requests → no waiting). Rank waiting > working > thinking > idle. `buildDiscordActivity`: a non-idle live state overrides `activeProvider` (a pending prompt writes nothing for > 15 min), `heldAgentState(ag, now)` → `{prov, state}` holds working↔thinking for `PULSE_DISCORD_STATE_HOLD_MS` 45 s WITHIN one provider, and while the shown provider is still busy (`ag.byProvider`) another busy provider can't take over inside the hold (Claude's tool/think phase otherwise flips the Claude-vs-Codex ranking every tick); waiting/idle switch at once. A tool_result that leaves other calls open still counts as `tool_use` (parallel calls resolve one line at a time); `!` bash-mode lines are a PROMPT (Claude answers them by default since 2.1.186, `respondToBashCommands`) unless the isMeta `<local-command-caveat>` line precedes them (tracked in `claudeConvStep`'s `st.caveat`); Codex task_started/turn_started clear orphaned calls (a mid-turn user_message does not), and a subagent write within 30 s keeps an expired or thinking session `working`, `DISCORD_STATE_SLOTS` → config `discordClaudeWorkingImage`/`discordClaudeThinkingImage`/`discordClaudeWaitingImage` (fallback `discordClaudeImage`), `large_text` "Claude Code · working"; the second line only shows when `activeNow.provider` matches; config `discordShowState: false` off. Tests: `test/agent-state.test.sh` |
| Self-update | `checkForUpdate`, `installUpdate` — sha256 digest fail-closed, rename swap + rollback, no downgrades. The swap keeps `process.execPath` (a self-updated `pulse.exe` stays `pulse.exe` — hooks/Run values/pins hold that path). `platformAssetNames()`: the asset matching the running exe's OWN filename first (`BURNGLASS_SELF_EXE_NAME` test hook), then `burnglass-*`, then `pulse-*`; choice in `updateState.assetName`. `compatTwins`: on win32 the `burnglass.exe`/`pulse.exe` twin in the same dir is refreshed after a verified swap (copy → `.download` → rename; failure non-fatal, retried next update; `cleanupOldExecutable` also clears the twin's `.old`). `versionNum` ranks a pre-release BELOW its release (`2.0.0-rc.1` < `2.0.0`; alpha < beta < rc). The relaunch passes `--after-update` (v1.34 too), which drives the strip refresh (next row) |
| Strip refresh after update | `refreshStripAfterUpdate(opts, done)` (sub-banner STRIP REFRESH AFTER UPDATE, after `launchPulseStrip`), from the listen callback after `migrateHome`: only `IS_AFTER_UPDATE` + packaged win32 + `opts.updateCheck` + no `config.stripPath`. `stripRefreshTargets`: strip exes that EXIST beside the server exe (`stripExeDir()`, both names, each under its OWN name) and in `<home>/bin`, deduped by realpath; never dev `strip/dist-strip`, never inside `~/.pulse` (`insideLegacyHome`: realpath, links followed, case-insensitive on win32) — a strip only in `~/.pulse/bin` → a FRESH `burnglass-strip.exe` in `<home>/bin` (findPulseStrip prefers it); home or exe dir inside `~/.pulse` → skipped. Release BY TAG `GET /repos/<UPDATE_REPO>/releases/tags/v<PULSE_VERSION>` (404 → skipped); per target the same-name asset else its alias, sha256 digest required (none → skipped, fail closed); a local file with the same streamed sha256 is left alone (`current`). `runStripRefresh`: `downloadStripAsset` ONCE per digest → `<t>.download` (exact size + sha256 + `STRIP_MIN_BYTES` 2 MiB, `STRIP_DOWNLOAD_MAX_MS` 10 min), copies for other targets before any swap, then `swapStripFile` (drop old `.old`, `<t>` → `<t>.old`, `.download` → `<t>`, rollback). `launchStripAfterRefresh`: only `config.strip === true` (re-read), loopback, and something swapped → `stopStrips` (System32 `taskkill /F /IM burnglass-strip.exe /IM pulse-strip.exe`, argv array, windowsHide, NO `/T` — the strip's "Open dashboard" can parent the user's browser), `waitStripsGone` ≤ 5 s, 1.5 s pause for WebView2's profile lock, relaunch ONCE; on an after-update start the listen callback HANDS its usual strip launch to this path (`once`), other starts call back at once (launch unchanged); wrapped so it can never abort the callback, promise chain ends in `.catch`. `cleanupOldExecutable` first calls `cleanupStripLeftovers()` (`<strip>.old` / `.download` beside the exe + `<home>/bin`; own gate, skips `~/.pulse`, skips with `stripPath`). Additive `payload.strip.refresh` (also in the `/api/strip/enable\|disable` reply) = null \| `{status: updated\|current\|failed\|skipped, at, version, reason?, error?, files?[{file, where: exe-folder\|home-bin, result: updated\|created\|current\|failed}]}` — basenames only, fs errors reduced to `CODE (syscall)`. Known limits: `taskkill /IM` stops every same-named strip of the user; a strip still running from `.old` (not server-managed) blocks that cleanup and the next swap reports failed; a degraded/legacy-home start is not retried until the next update. RETRY: `<home>/strip-refresh.json` exists only while a refresh of THIS version is owed (`pending` written at attempt start, replaced by the result; any non-failure deletes it; never written when the home is `~/.pulse`); a later start of the same version retries a failed or interrupted attempt under the same gates, in-process retries run on a timer (30 min doubling, cap 6 h; `BURNGLASS_STRIP_REFRESH_RETRY_MS` test hook), ≤ 5 attempts per version, a `pending` marker whose pid is alive is left alone; an in-process retry only RESTARTS a running strip (`launchStripAfterRefresh(res, {onlyRestart})`), never launches one; the relaunch re-reads `config.strip` at launch time (a strip turned off during the stop/pause is not started). `payload.strip.refresh` adds `attempts`, `retriesLeft`, `retryAt`, `checking`; System's strip row shows the failure with the retry countdown / "next start" / the release link once attempts run out. Suite `test/strip-heal.test.sh` |
| Community reach | `refreshReach`/`reachForPayload` → `payload.reach` = `{downloads, stars, fetchedAt, repo}` from PUBLIC GitHub only (sum of every release's asset `download_count` + repo `stargazers_count`); last-good retention per counter; scheduled beside `checkForUpdate` (startup + 6h) and gated by the SAME opt-out (`updateCheck`/`--no-update-check`); 6h cache (`PULSE_REACH_CACHE_MS`), endpoints overridable (`PULSE_REACH_API`, `PULSE_REACH_REPO_API`); NOT a phone-home — nothing about the user is sent; UI: `ReachPill` in the top bar / menu sheet (App.jsx) |
| Meshy 3D credits (opt-in) | `refreshMeshy`/`meshyForPayload` (beside the Codex-usage section): `GET /openapi/v1/balance` (auth canary, runs first) + paged `GET /openapi/v2/text-to-3d` — only that family is documented, the rest are probed defensively and `payload.meshy.families` reports which answered. Store `<home>/meshy.json` is id-keyed `{t,c,ts,s}` (prompts NEVER stored); paging stops at the first known task or the retention edge; pruning folds credits into a `pruned` accumulator so `allTime` never shrinks. `MESHY_OK_MS` 15m (`PULSE_MESHY_CACHE_MS`, explicit `0` honored), 401 latches on a key fingerprint (`meshyKeyHash` — the raw key never lives in a comparable field), 429/5xx back off keeping last-good (`status:'stale'`). **Credits are their own unit** — never in `totals.cost`, any period cost, or `planValue`. Config `meshy === true` + `meshyApiKey` (set via POST **body**, never a query string); `payload.meshy` exposes `hasKey`, never the key. UI: `sections/Meshy.jsx` (+ `MeshyKeyForm`, shared with the System toggle row) |
| Run at startup (opt-in) | `startupState`/`setStartup`/`startupForPayload` (beside the Burnglass Strip section): `reg.exe` (Windows builtin, argv array + `windowsHide`, never a shell string) on `HKCU\…\CurrentVersion\Run` value `Pulse` (FROZEN name — see hard rule 3a) = `"<exe>" --no-open`; 30s memo like `findPulseStrip`, busted on write; reg "value not found" (status 1) is the ordinary off case, any other failure fails CLOSED to `enabled:false` + warns once, and can never throw out of a payload build. `payload.startup = {supported, enabled}`; POST `/api/startup/enable\|disable` (allowMutation); CLI `--startup on\|off\|status`. **Test hook `PULSE_STARTUP_STUB=<path>`** redirects the whole state to a JSON file so suites never touch a real registry |
| Installer | `build/installer.iss` (Inno Setup 6, `AppId` GUID `{76C28179-…}` — NEVER change it, it is the upgrade identity): `PrivilegesRequired=lowest`, `OutputBaseFilename=BurnglassSetup`, icons from `build/brand/burnglass.ico`; `DefaultDirName={code:DefaultInstallDir}` = `%LOCALAPPDATA%\Programs\Pulse` when it holds `pulse.exe`/`burnglass.exe` (or the `Uninstall\Pulse` key's InstallLocation holds the app) — so v1 `--install` users, which Inno's `UsePreviousAppDir` can't see (no `_is1` key), converge instead of splitting — else `Programs\Burnglass`; installs `burnglass.exe` + a `pulse.exe` twin when `{app}` already had one (hooks / pins / Run data point at it); `StopRunning` tries `{app}\burnglass.exe --stop`, then `{app}\pulse.exe`, then the `Programs\Pulse` copies, and ends strips running from `{app}` (else the twin write hits a locked file); tasks `desktopicon` (checked), `startup`/`strip` (unchecked) — names frozen (`UsePreviousTasks`); Run value NAME `#define RunValue "Pulse"` (frozen) w/ data `"{app}\burnglass.exe" --no-open` + `uninsdeletevalue`; post-install `RepointRunValue` re-aims a `Pulse` value at `{app}\pulse.exe` to `burnglass.exe`, deletes `Pulse*.lnk` ONLY when they target `{app}`, removes `Uninstall\Pulse` / `Uninstall\Burnglass` keys for `{app}` (one ARP entry); `CurUninstallStepChanged` deletes the `Pulse` (and a stray `Burnglass`) Run value only when it points into `{app}`; `[UninstallRun]` `--stop` keeps RunOnceId `StopPulse`; **nothing under `~/.pulse` or `~/.burnglass` is ever deleted**. CI: `choco install innosetup` + `ISCC /DMyAppVersion=<tag minus v> /DMyAppVersionNum=<numeric>` (Inno's `VersionInfoVersion` must be numeric — `2.0.0` for `2.0.0-rc.1`) on the windows job, retried without `SetupIconFile` if ISCC rejects the icon. Server-side equivalents: `--install` / `--uninstall` — `programsDir()` = the installer's own dir (its `{76C28179-…}_is1` key) > `Programs\Pulse` holding pulse.exe/burnglass.exe > `Programs\Burnglass`; `--install` writes `burnglass.exe` (+ refreshes an existing `pulse.exe`), `Burnglass`/`Burnglass - Stop` shortcuts, ARP `Uninstall\Burnglass` (and deletes `Uninstall\Pulse` when it points at the same dir); both refuse a dir holding `unins000.exe` (Inno-managed) and only touch entries pointing into their own dir |
| Home + ~/.pulse migration (v2.0.0) | `envv(name)` (`BURNGLASS_<name>` wins, `PULSE_<name>` permanent alias; empty BURNGLASS value = unset) is used for EVERY env read. `appHome()`: `BURNGLASS_HOME`/`PULSE_HOME` verbatim (never migrated) > `~/.burnglass` if it exists > `~/.pulse` if it holds a Pulse file (`isPulseHome`: config/meshy/modes/discord-presence/strip*/server.json/pulse.log/tray.ps1 or a `history/` dir — a PulseAudio or empty `~/.pulse` is NOT a Pulse home; pre-migration, NOT memoized) > `~/.burnglass` (fresh; writers mkdir lazily). `migrateHome()` runs FIRST in the listen callback — only once THIS process owns its port (a v2 losing the bind to a running v1 publishes nothing) and before anything reads config; short-lived commands (`--statusline`, `--summary`, `--mode-hook`, setup printers, `--startup`, `--stop`…) only resolve, never migrate. Copy = allowlist `MIGRATE_FILES` (config, meshy, modes.jsonl, discord-presence, strip*.json) + `history/YYYY-MM.json` (skips `*.tmp`); skipped names (server.json, tray.ps1, logs, strip-web/, webview-strip/, bin/…) are listed in the marker. Stage `~/.burnglass.migrating-<pid>-<6hex>` gets the `STAGE_SENTINEL` first; `renameWithRetry` publishes it atomically (EPERM/EACCES/EBUSY ×8 @125 ms, never once the target exists); POSIX modes carry over — stage + `history/` are created 0700 and `copyModeBits` gives them the `~/.pulse` counterpart's mode (owner rwx always kept, never wider than the source), `copyFileSync` keeps file modes, and a NEW `config.json` holding a Meshy key is created 0600; marker `migrated-from-pulse.json` `{from, at, by, copied, skipped}`; a copy that moved NOTHING sets `homeMigration` null (no notice) and logs that; a racing peer's win is adopted; any error → degraded run on `~/.pulse` (`homeMigration.status:'failed'`), retried next start; `sweepStaleMigrationStages` removes only exact-pattern dirs holding a sentinel older than 1 h. `adoptHome(dir)` resets every per-home cache. Legacy compat (only when `legacyCompatHome()` — not pinned, `isPulseHome`, and not the active home by IDENTITY via `sameEntry` (dev+ino, realpath fallback; a `~/.pulse` ↔ `~/.burnglass` link either way is one home); `--uninstall`'s KEPT list uses the same test): `server.json` mirror + freshest-live `readRuntimeFile`, `refreshLegacyTrayScript`, `readModes` merges `~/.pulse/modes.jsonl`, `readHistory` merges `legacyHistoryDir()` month files READ-ONLY per cell via `pickCell` (new home wins ties) and applies the custom-source RENAME retirement to them (a legacy `c` cell under a no-longer-configured name is skipped only when the new archive's day has configured custom cells — removal ≠ rename; the cache sig includes the configured names), `scrubLegacyMeshyKey` after the copy and on every v2 key change/clear (skips a legacy `config.json` that IS the live one; tmp+rename keeps the file's mode). Payload: `brand`, `home`, `exeName` (null from source), `homeMigration` (`{status:'migrated'\|'failed', from, at, by, justNow?, copied?, error?}` or null; `copied` = item count, additive). UI: App `HomeNotices` (dismiss stored in `pulse-home-notice` = the marker's `at`, shown ≤14 days) + System "Data folder" fact. Suite: `test/migration.test.sh` (fake `$HOME`, NO home env) |
| Claude Code integrations check (read-only) | `claudeIntegrations()` (mtime-memoized read of `claudeDir()/settings.json`): `statusLine.command` + `hooks.*[].hooks[].command` carrying `--statusline` / `--mode-hook` → `commandToken` (raw: quoted or first token, skipping `env` and leading `NAME=value` assignments — a value there may be a secret; `node <script>` → the script) / `commandTarget` (= `expandTilde(commandToken)`, the display form) → `{kind, event, target, exists, legacyName}`; `exists` comes from `integrationTargetExists(raw, {platform, home, exists})` — true/false, or NULL when it can't be verified (not absolute; on Windows Claude Code runs commands through Git Bash, so `/c/…` + `/cygdrive/c/…` are checked as `C:\…`, any other drive-less rooted path is null, and a `~` path not found under the profile is null — never a false "missing"; POSIX unchanged). `payload.integrations` strips the raw `command`; `warnBrokenIntegrations` logs once per distinct broken set at start; `printExistingIntegration` adds a "replace this" hint to `--statusline-setup` / `--effort-setup`. NEVER writes `~/.claude`. UI: App `HomeNotices` warn bar for `exists === false`, System "Claude Code" fact (status line / effort hook → exe name, "old name, still works") |
| Windows daemon | Windows builtins are ALWAYS spawned by absolute path — `system32Exe(...)` / `powershellExe()` (`%SystemRoot%\System32\…`; Windows resolves a bare name from the CURRENT folder first) for tasklist, taskkill, reg.exe and powershell.exe (tray, shortcuts, desktop lookup, `--install`, startup, strip dedupe + kill; `system32Exe` / `powershellExe` / `imagesRunning` live under the `WINDOWS BUILTINS` banner just before `PULSE STRIP`); `test/strip-heal.test.sh` has a hygiene check that fails on a bare name. `--daemon-child`, `windowsHide`, `<home>/burnglass.log` (`openLogFile` is DEFERRED until after the migration so nothing new lands in `~/.pulse`; earlier lines are back-filled), `--stop`, `--install-shortcuts` (`Burnglass` / `Burnglass - Stop`); the same-or-newer-already-running branch honours `--no-open` (a sign-in copy never pops a browser) |
| Status line | `--statusline` (reads Claude Code's stdin JSON, fetches slim `/api/statusline` from the running server via the `server.json` port — `readRuntimeFile` reads BOTH homes and picks the LIVE pid with the newest `startedAt` (nothing ever deletes a server.json, so "new home first" would let a stale one shadow the live server); `writeRuntimeFile` mirrors into `~/.pulse/server.json` when that file exists (old strips hard-code it) — prints an ANSI line; fail-open, always exit 0), `statuslineData`/`statuslineMemo` (3s), `--statusline-setup` prints the settings.json snippet (never writes `~/.claude`); `NO_COLOR` respected |
| Limit alerts | `computeAlerts(meters, codexMeters)` → `payload.alerts` (both Claude buckets + Codex snapshot buckets ≥ lowest threshold, deduped by `provider:key`, provider-labelled, sorted most-urgent-first, skips `stale`; **drops maxed windows** — rounded pct ≥ 100 is a reached limit, not "approaching", so it's excluded from the banner + notifications though it still shows in the meter gauges); `alertsEnabled()` (`{"alerts": false}` off), `alertThresholds()` (config `alertThresholds`, default `[80,95]`); **spend anomaly (opt-in)**: `computeSpendAnomaly(periods, now)` unshifted onto alerts — fires when today ≥ multiplier × mean of ACTIVE prior days in last30 (≥5 active days, today ≥ $5); config `anomalyAlerts === true` + `anomalyMultiplier` (default 3, floor 1.5); row has `kind:'anomaly'`, `detail`, `ratio`, pct null, date-keyed `pulse:anomaly:YYYY-MM-DD` so notifications fire once/day; UI: `sections/Alerts.jsx` (one-line strip above the KPIs; anomaly rows render `detail`; the count badges the rail's *Limits & budget*) + browser notifications in lib.js (`fireAlertNotifications` dedups via `localStorage` key `pulse-alerted`, alertKey `key\|threshold\|resetsAt`; anomaly body uses `detail`) |
| Activity heatmap | `aggregate` builds `payload.heatmap` = `{grid:[7][24]{cost,tokens,messages}, maxCost, maxMessages}` from `asc` entries via local `getDay()`/`getHours()`; LIVE-only (archive keeps no per-hour detail); UI: `Heatmap` (`sections/Activity.jsx`, spend/messages toggle), gated on `heatmap.maxCost > 0` |
| Mini side overview | hash route `#mini`: `MiniOverview` (web/src/mini.jsx) renders Claude/Codex meter buckets as **"% used"** rows on the SAME `MeterBar` as the Limits section (threshold ticks, projection hatch `→ N% at reset` from `projLeftAtReset`, warn/crit via `meterTone`, stale rows dimmed) + `MiniDonut` (SVG stroke segments, per-source colors via `makeColorMap`) with Today\|Yesterday\|30-Days tabs (day buckets from last30.daily) + Today/Yesterday/30d stat rows + `MiniTrend` daily bars; App.jsx hashchange listener + the Mini view buttons (`window.open` 340×760 popup); header = 24 px `BrandMark` + `Wordmark`; degrades to hints when meters are off/no-login/expired; Spend label follows `payload.sourceFilter`; solid surfaces only (lite-safe) |
| Meter burn projection | `recordMeterSamples` (on each meters refresh; per-key ring buffer, 2h window, clears on pct DROP = window rolled) + `projectedLeftAtReset` (straight-line slope over ≥ `PULSE_METER_PROJ_MIN_MS` (default 10m) of samples → `projLeftAtReset` per bucket in `metersForPayload`, null without resetsAt/enough data; `Math.max(0, slope)` so a falling trend never projects a refill) |
| Windows tray (opt-in) | `--tray` flag, config `tray: true`, or the System-section toggle (POST `/api/tray/enable\|disable`, allowMutation; enable spawns immediately, disable flips `trayEnabled` in the statusline feed and the tray self-exits ≤30s) → `startTray(port)` (win32 + loopback; `PULSE_NO_TRAY_SPAWN` test hook): writes `trayScript(port)` to `<home>/tray.ps1` (and REWRITES an existing `~/.pulse/tray.ps1` — `refreshLegacyTrayScript`: a running v1 tray relaunches its own `$PSCommandPath` on a version change, so a stale v1 script there would respawn forever), spawns detached hidden powershell w/ `child.on('error')` (NotifyIcon; named mutex `PulseTray<port>`; **brand-kit icons** (BRAND.md "Tray") — `TRAY_ICONS` embeds `tray-base` + `tray-status-{good,warn,crit}` PNGs at 16/20/24/32 as base64, picked by the DPI's small-icon size and decoded once; the WHOLE icon is swapped: base (ice dot) when meters off / no login / stale (`meters.claudeFiveHourStale`) / loading, good = green disc, warn = yellow RING ≥ first threshold, crit = red disc + white bar ≥ second — levels from the statusline feed's additive `trayLevels` (= `alertThresholds`, default 80/95); the tray NEVER loads the app icon (its ember dot sits in the status slot), not even as a fallback; the % lives in the tooltip, never painted on the icon; tooltip today $ + 5h/wk %; left-click + menu open `#mini` as an Edge `--app` window 380×800 w/ browser fallback; first paint immediate; self-exits after 6 failed polls or Stop). `payload.tray = {supported, enabled}` gates the UI toggle. **Self-diagnosis (rc.3):** the spawn (cwd = the home, absolute paths) hands stdout+stderr to `<home>/tray-error.log` (the server opens it, truncated per spawn), so PowerShell's OWN errors (Group Policy execution policy, AMSI, parse errors, Constrained Language) are captured; `trayProc` + the `onTrayExit` watcher turn a non-zero exit, or any exit within `TRAY_EARLY_EXIT_MS` 60 s while still wanted and not deliberate (exit 0 and the script's LAST own line — `summarizeTrayOutput().last`, never the ERROR > WARN pick, which an earlier non-fatal WARN such as the icon-handle helper would win — says menu / turned off / relaunch), into `payload.tray.lastError {code, at, message, kind}` + ONE log line (warn; info for kind `lock`). `summarizeTrayOutput` (pure, exported) picks the script's last ERROR line > last WARN line > PowerShell's own first paragraph + "(line N)" > the last own line as `message`, and returns that last own line as `last` (the deliberate-exit test and the info "its last line" log use it); ANSI/control chars stripped, homedir → `~`, capped `TRAY_MSG_MAX` 300; UTF-16 / CLIXML / NUL-hole aware; kinds policy \| antivirus \| language-mode \| lock \| unreachable \| spawn \| not-loopback \| no-output \| error. `payload.tray` gains additive `running` (a tray polled within `TRAY_SEEN_MS` 75 s; null while unknowable — the lock is held by another copy, or the server just started and spawned nothing), `starting` (< 20 s, not seen, alive), `alive`, `spawnedAt`, `lastSeen`, `lastError` (also in the enable/disable reply). `noteTrayPoll` on `/api/statusline`: `?from=tray&pid=` (additive) or a WindowsPowerShell User-Agent (a pre-rc.3 tray — nothing else polls that feed from PowerShell); a poll clears `lastError`, the exit of the polling pid ends `running` at once. A non-loopback bind or spawn error lands in `lastError` via `noteTrayNotStarted`. tray.ps1 contract (ASCII + BOM + CRLF, PS 5.1 syntax): first action logs `starting (v, port, PowerShell ver edition, LanguageMode, pid)`; every line also goes to stdout (Write-Host fallback under Constrained Language); mutex → icon shown sits in a try/catch (ErrorActionPreference Stop) that logs step + tray.ps1 line + message at ERROR and exits 2; NO script-level `trap` and no try/catch around `Application.Run()` — either one makes PowerShell propagate a statement-terminating error inside a menu / click / timer handler OUT of the .NET delegate into WinForms (an unhandled-exception dialog from the hidden process, or Run() unwinds and the icon vanishes; reproduced with pwsh 7, PS 5.1 by about_Trap), so a failing statement is skipped (text on stderr = `tray-error.log`) and the browser-opening handlers (`Open-BgDashboard`, `Open-BgMini`) catch LOCALLY and log a WARN; an abandoned mutex counts as acquired (explicitly), the lock is released on exit; the DestroyIcon Add-Type helper failing is non-fatal; exit codes 0 normal / 2 setup / 4 lock held / 5 unreachable; the version relaunch uses `$PSHOME\powershell.exe` (never a bare name); menu exits are logged. The dashboard's log tail is the server's in-memory ring — the tray's own lines are only in `burnglass.log` / `tray-error.log` |
| Burnglass Strip (opt-in) | `strip/` — C# WinForms+WebView2 companion (`BurnglassStrip.csproj` → `burnglass-strip.exe`, + a byte-identical `pulse-strip.exe` alias asset; home = `BURNGLASS_HOME` > `PULSE_HOME` > `~/.burnglass` if present > `~/.pulse` if present > `~/.burnglass` (never CREATES `~/.burnglass` while only `~/.pulse` exists — that would block the server's migration); state files fall back to read-only `~/.pulse` copies; server.json from both homes, freshest live wins; mutex `PulseStrip_SingleInstance` FROZEN; ported from openusage-windows MIT — see `strip/LICENSE-openusage`; build-time only, server stays zero-dep): StripForm = layered per-pixel-alpha taskbar strip (DPI-scaled via `mg.DpiY/96`, raw `SetWindowPos` keep-on-top, drag persists `<home>/strip.json`), PopoverForm = WebView2 popover (virtual host `burnglass.local`, Glass palette + mark/wordmark footer, DPI-scaled window box, never `Opacity!=1`; **open motion = a Windows 11 flyout** (rc.3): placed at its FINAL size `SlideCss` 12 px below its spot and shown DWM-cloaked (`DWMWA_CLOAK` — Windows treats it as visible, so WebView2 keeps drawing); `PrimeAsync` runs ONE script, renderData + `primeOpen(gen, motion)`, which returns the content height (applied while invisible) and holds the page on its first animation frame; the page posts `{primed: gen}` two frames later → `Reveal` un-cloaks (fallback `RevealFallbackMs` 140; 2 consecutive misses latch `_cloakUnreliable` = show at once for the session); then a 190 ms POSITION-only rise on `OpenMotion.Ease` = cubic-bezier(.1,.9,.2,1) = the page's `--ease-decel`, paced by a DwmFlush vsync ticker thread that BeginInvokes one tick at a time while the UI thread computes Y from a Stopwatch (SetWindowPos + SWP_NOSIZE); every open/close bumps `_openGen` (no stale slide/prime/reveal); click-away = `PopoverDismiss` (pure, no window calls — the Deactivate handler + the 250 ms `WatchFocus` poll delegate to it): a Deactivate closes at once unless the window is not revealed yet or it is ≤ `GuardMs` 250 after SHOW (the guard never restarts at the reveal — that swallowed click-aways at 250–390 ms in rc.3's first cut and left the popover open without focus; only a reveal that must re-activate restarts it), a held-back one is REMEMBERED and the poll closes the popover once the rise is over if another process has the foreground (after it held focus, or after a held-back click-away; our own strip/menu never close it); `OnVisibleChanged(false)` is the single close path (instant, `DWMWA_TRANSITIONS_FORCEDISABLED`, calls `resetOpen`); a height re-target = one SetWindowPos (size + position, slide progress kept); `_workArea` fixed per open, `OnDpiChanged` re-places the box; Win11 (build ≥ 22000) = `DWMWCP_ROUND` + `DWMWA_BORDER_COLOR` #22252f, NO Region, NO CS_DROPSHADOW; Win10 = Region (re-applied per size in OnResize) + CS_DROPSHADOW; `SPI_GETCLIENTAREAANIMATION` off → no slide, `playOpen(false)`; WebView2 is Dock=Fill. Page API `primeOpen`/`playOpen`/`resetOpen`/`contentHeight` (#app's own box): blocks rise 6 px over 180 ms, 22 ms stagger (`--i` capped at 4), meter fills scaleX 300 ms, donut conic-mask sweep (`@property --sweep`) 320 ms; RULE: animations fill BACKWARDS only and the resting state is visible — `body.preopen` = paused first frame with a `PRIME_SAFETY_MS` 900 self-heal; fresh data mid-open goes through `joinOpen` (new animations take the running ones' startTime, nothing fades twice); `prefers-reduced-motion` kills every animation/transition), `SummaryTransform.ToUi` = the ONE transformer `/api/summary`→providers[] schema (strip cells + popover both consume it; labels `Today`/`Last 7 Days`/`Last 30 Days` feed the popover's per-provider FALLBACK donut for a payload without `sources`), plus additive top-level `sources` `[{id,label,color,today,week7,cost30}]` (server `allSources` order — a server without it falls back to the period's own source keys, ordinal-sorted, and a source seen only in daily data is appended; colour = the dashboard's DARK `--s1…--s6` by index (`SourceSeries`, wraps like `makeColorMap`); label = `sourceMeta` > the `SOURCE_LABELS` mirror > raw key; today = last daily bucket, week7 = last 7 daily buckets, cost30 = `last30.bySource`) and `thresholds` (`alertThresholds` via `MeterScale.Sanitize`, filtered to (0,100] like lib.js, default [80,95]); progress lines carry additive `projected` (% used at reset from `projLeftAtReset`) and `used` rounds halves UP (JS `Math.round`). `MeterScale` (`Sanitize`/`Tone`/`UsedPct`) is the single source of the meter rules for the transform AND StripForm; the popover page mirrors them in JS. Popover = the dashboard's look: meters are `MeterBar` copies (fill = % used, ice < lowest threshold, amber ≥ it, red ≥ highest, a tick per threshold, projection hatch, "N% used" + "→ N% at reset" left, "Resets in …" right); per-SOURCE donut + legend built with DOM calls (colours must be `#rrggbb` — `strip-ui.json` on disk feeds the page, a colour string could inject markup), zero-spend sources hidden per tab, > 6 → top 5 + neutral "Other (n)", legend capped at the donut's 116 px so a tab switch keeps the height (the page also posts `{height}` as a fallback); daily bars neutral with today in the ice accent; letter badges neutral grey. StripForm taskbar cells print % USED (the popover's number), tinted `#f2aa3c` ≥ lowest / `#f47171` ≥ highest threshold (payload thresholds, default 80/95); `Cell` gains `TopTone`/`BottomTone`/`PctUsed` — a `strip_cells.json` without `PctUsed` (an rc.1-or-older % LEFT cache) keeps ONLY its prices until live data arrives, so an inverted number never shows; web UI embedded in the exe → extracted to `AppPaths.ScratchPathOf("strip-web")` = `<home>/strip-web`, or `%TEMP%\burnglass-strip\strip-web` when the home IS `~/.pulse` (`HomeIsLegacy` decided by the folder itself, links/junctions followed via `SameDir` — not by whether it was pinned; the WebView2 profile `webview-strip` goes the same way, since WebView2 deletes inside it); NO recursive delete — stale files are removed one by one only when listed in the strip's own `.burnglass-strip-web` manifest (`WebAssets.DeleteOwnFile`: never a folder, never outside the folder, never through a link; an unmarked folder is only written into) (exe-neighbor `web/` wins for dev); two feeds: statusline 45s = lifecycle only (`stripEnabled:false`→quit, 40 fails→exit), summary on popover-open/menu/5min = data (foreground open ⇒ meters match `/usage`); stale-while-revalidate at 3 layers (carried-forward meters are dropped once `resetsAt` passes, else an expired window chains forward forever); money parsed/formatted with `CultureInfo.InvariantCulture` (a culture-sensitive parse reads `$2,263.58` as 226358 on comma-decimal locales); payload re-serialized via `AppHost.SafeJson` before it reaches an `ExecuteScriptAsync` string; strip's per-provider "Last 7 Days" = 7 CALENDAR days (self-consistent with its donut), NOT the dashboard's rolling-168h `week`. Server side: `findPulseStrip` (config `stripPath` else `burnglass-strip.exe` then `pulse-strip.exe` beside the exe (`stripExeDir()`), in `<home>/bin`, in `~/.pulse/bin`, then dev `strip/dist-strip`; 30s memo; a `<home>/bin` copy placed by the post-update refresh therefore wins over `~/.pulse/bin`; the strip EXE itself is refreshed after a one-click update — see "Strip refresh after update"), `launchPulseStrip` (skips when EITHER image name is running; spawns with `BURNGLASS_HOME=appHome()`; `PULSE_NO_STRIP_SPAWN` hook), POST `/api/strip/enable\|disable`, `payload.strip`, statusline `stripEnabled`; CI: `setup-dotnet` + publish on the windows job, every step after the OS-binary upload `continue-on-error` (a strip/installer failure drops only those assets; the strip uploads only as a verified `burnglass-strip.exe`/`pulse-strip.exe` pair and the installer builds only with the strip). Look (rc.2, matches the dashboard): `SummaryTransform.ToUi` adds top-level `sources` [{id,label,color,today,week7,cost30}] (allSources order, dashboard `--s1..6` dark colours, sourceMeta/built-in labels; RAW amounts — rounded once at display) and `thresholds` (sanitised alertThresholds); progress lines carry `used` (rounded, JS Math.round) + an additive unrounded `pct` + `projected`; tone/fill/projection use `pct` (popover) / `MeterScale.LinePct` (taskbar), so they turn amber/red exactly where the dashboard does; taskbar cells print % USED tinted by `MeterScale.Tone`; stale Claude rows are dropped. Suite: `test/packaging.test.sh` |
| Memory footprint | never add-then-`delete` properties on entry objects (V8 dictionary mode — keep transient parse data in side arrays), `intern()` pool (capped 50k) for model/source/speed/serviceTier/sessionId/project in `normalize` + `agentEntry` (JSON.parse allocates fresh strings per occurrence); entries no longer retain messageId/requestId (folded into `key` at parse); `summaryMemo` (`SUMMARY_MEMO_MS` 2.5s, unfiltered builds only, busted by `writeConfig`); `payload.memory` = `{rss, heapUsed}` → System-section "Memory" fact. Measured 205→128 MB on a 50k-entry fixture |

## Config (`~/.burnglass/config.json`) and env overrides

Config keys: `accountMeters`, `codexAccountUsage` (separate consent — the
dashboard toggle sets both, a pre-1.6.0 `accountMeters` alone must NOT enable
the chatgpt.com call), `discordPresence`, `discordClientId`,
`discordRotateSecs` (15–300), `discordShowModel` (`false` hides the model · effort · sessions line), `discordShowState` (`false` = no live-state art/tooltip) + `discordClaudeWorkingImage`/`discordClaudeThinkingImage`/`discordClaudeWaitingImage` (per-state Claude art), `discordLargeImage` (idle/fallback art key) +
`discordClaudeImage`/`discordCodexImage` (per-provider large_image overrides),
`history` (retention; on
unless `false`), `alerts` (limit alerts; on unless `false`), `alertThresholds`
(array of pct 1–100; default `[80,95]`), `anomalyAlerts` (spend-anomaly alert;
opt-in, `=== true` only) + `anomalyMultiplier` (trigger ratio; default 3, floor
1.5), `budget` (USD spend target; unset =
off) + `budgetPeriod` (`month`|`week`, default month; set via `/api/budget/set`),
`planCost` (monthly subscription outlay in USD; unset/0 = the plan-value card
stays in its empty state) + `planLabel` (e.g. `"Max 20x"`; set via
`/api/plan/set`),
`tray` (Windows notification-area icon; also `--tray`), `strip` (`=== true` — launch Burnglass's
own `burnglass-strip.exe` companion (`pulse-strip.exe` still found)) + `stripPath` (exe override; an
explicit path that is missing does NOT fall back), `customSources` (array of `{name, path, label?}` —
user-written JSONL usage logs ingested as first-class sources; see the
Custom sources feature row), `updateCheck`. The v1.22–v1.23.x
`trayStyle`/strip implementation (our own PS-generated taskbar pill) was
REMOVED in v1.24.0 in favor of the OpenUsage companion — old `trayStyle`
config keys are ignored; hard-won strip lore lives in the v1.23.x
CHANGELOG entries if it's ever needed again.
**OpenUsage companion launcher: REMOVED in 2.0.0 (rc.3)** — Burnglass Strip
replaces it; `openusage` / `openusagePath` are ignored if present (never
rewritten away). The strip's MIT attribution MUST stay: `strip/LICENSE-openusage`,
the "Ported from openusage-windows" headers in `strip/*`, the csproj Copyright,
the installer's `LICENSE-openusage.txt` and the release-notes credit.

Env: EVERY Burnglass variable below is read through `envv()`, so each
`PULSE_X` also answers to `BURNGLASS_X` (which wins; an empty `BURNGLASS_X=`
doesn't mask a real `PULSE_X`). The suites deliberately keep using the
`PULSE_*` spellings (that exercises the alias); new docs and user-facing text
use `BURNGLASS_*`. Agent-dir overrides (`CLAUDE_DIR` …) have no prefix.

Test/dev env hooks: `PULSE_HOME` (= `BURNGLASS_HOME`; pinned home, never
migrated), `CLAUDE_DIR`/`CLAUDE_CONFIG_DIR`,
`CODEX_DIR`/`CODEX_HOME`, `GEMINI_DIR`/`GEMINI_CLI_HOME`,
`CONTINUE_DIR`/`CONTINUE_GLOBAL_DIR`, `CLINE_DIR`, `ROO_DIR`, `PULSE_HISTORY_DIR`, `PULSE_REACH_API`,
`PULSE_REACH_REPO_API`, `PULSE_REACH_CACHE_MS`, `PULSE_METERS_API`,
`PULSE_METERS_CACHE_MS`, `PULSE_CODEX_USAGE_API`, `PULSE_CODEX_USAGE_CACHE_MS`,
`PULSE_DISCORD_IPC`, `PULSE_DISCORD_TICK_MS`, `PULSE_DISCORD_ROTATE_MS`,
`PULSE_DISCORD_CLIENT_ID`, `PULSE_MODES_FILE`, `PULSE_FAKE_DARWIN`,
`PULSE_METER_PROJ_MIN_MS`, `PULSE_SUMMARY_MEMO_MS` (0 disables the memo — timing-sensitive suites),
`PULSE_LIVE_STATE_MEMO_MS` (registry read memo; 0 in tests), `PULSE_DISCORD_STATE_HOLD_MS` (working↔thinking hold), `PULSE_IMAGE_CHECK` (ps|tasklist|off — force the registry pid image check), `PULSE_REG_BUSY_MAX_MS` (busy-record age cap),
`PULSE_NO_STRIP_SPAWN` (suppress the Burnglass Strip launch),
`PULSE_NO_TRAY_SPAWN` (suppress the tray launch), `PULSE_TRAY_TEST_SCRIPT`
(a node script spawned as `node <file> <port> <tray.ps1>` instead of
powershell — bypasses the win32 gate and `NO_TRAY_SPAWN`, makes
`payload.tray.supported` true; used by `test/tray.test.sh`), `PULSE_MESHY_API` /
`PULSE_MESHY_CACHE_MS` (Meshy endpoint / cache; explicit `0` honored),
`PULSE_STARTUP_STUB` (redirect run-at-startup state to a JSON file instead of
the registry — REQUIRED by any suite touching startup),
`PULSE_UPDATE_API` (update-check endpoint override), `PULSE_NO_UPDATE_CHECK`
(env form of `--no-update-check`), `PULSE_UPDATE_NO_RELAUNCH` (test hook),
`PULSE_SECURITY_BIN` (macOS Keychain `security` binary override),
`BURNGLASS_SELF_EXE_NAME` (the updater's "my own filename" for the asset
choice, so a Linux suite can act as `pulse.exe`/`burnglass.exe`),
`PULSE_STRIP_REFRESH_FORCE=1` (forces ONLY the win32 + packaged gates of the
post-update strip refresh and its leftover cleanup; `--after-update`,
`updateCheck` and `stripPath` still apply), `PULSE_STRIP_EXE_DIR` (the folder
treated as "beside the server exe" by `findPulseStrip` and the refresh),
`PULSE_STRIP_RELEASE_API` (GitHub API ROOT for the release-by-tag lookup, not
a full URL), `PULSE_STRIP_PROC_STUB=<dir>` (replaces tasklist/taskkill/spawn
for the strip: `running` / `kills.log` / `launches.log` / `sticky`),
`PULSE_STRIP_REFRESH_RETRY_MS` (first in-process retry delay of a failed strip
refresh; default 30 min, doubling). Build-time
only: `BURNGLASS_EXE_ICON=0` (make-exe skips the Windows icon stamping).

## Release process (established, do not improvise)

1. Bump BOTH version strings: `package.json` `version` AND `PULSE_VERSION` in
   `server.js` (make-exe errors on drift; CI also fails when the tag ≠
   package.json, because a mismatch would offer the same "update" forever).
   For a release candidate both strings carry the suffix (`2.0.0-rc.1`). Add
   a CHANGELOG.md entry.
2. `npm run build` (rebuilds web/dist), `node -c server.js`,
   `bash test/run-all.sh`.
3. Commit to `main`, push (`git push -u origin main`, retry w/ backoff on
   network errors). `main` is the default branch.
4. Dispatch the release: GitHub Actions `release.yml` on ref `main` with
   input `{"tag": "vX.Y.Z"}` (in remote sessions use the GitHub MCP
   `actions_run_trigger`; the repo param may need an old name —
   `claudeusage` / `Pulse-Usage-Monitor` — until tooling is re-attached to
   `Burnglass`). **Prereleases:** a tag containing `-` (`v2.0.0-rc.1`) or
   input `prerelease: true` publishes with `prerelease: true` +
   `make_latest: false`, and a post-publish step verifies (and demotes) that
   it did not become latest — every installed copy checks
   `/releases/latest`, so an RC published as a normal release would be
   offered to the whole installed base. `versionNum` ranks an RC below its
   final, so RC testers are still offered the release.
5. Wait ~3–4 min, then verify via the release-by-tag API: all NINE assets —
   `BurnglassSetup.exe`, `burnglass.exe`, `burnglass-linux`,
   `burnglass-macos`, `burnglass-strip.exe` + the legacy aliases `pulse.exe`,
   `pulse-linux`, `pulse-macos`, `pulse-strip.exe` — uploaded with sha256
   digests, and **each `pulse-*` digest equal to its `burnglass-*` twin**
   (the workflow `cmp`s the pairs before publishing and compares published
   digests after; never drop the aliases in 2.x). The Windows extras (strip +
   installer + their aliases) are built only on the windows-latest job, in
   steps AFTER the OS-binary upload that are `continue-on-error`: a failed
   strip or installer build only drops those assets (the strip pair is
   all-or-nothing, the installer needs the strip), so check the asset
   COUNT, not just that a release appeared. A missing OS binary or
   `pulse-*` alias still skips the whole release (safe to re-dispatch — no
   tag is created).
6. Release day for 2.0.0 only: the user renames the Discord application to
   Burnglass and swaps the art behind the `pulse` key (same client id).

## Testing conventions

- Everything is tested e2e against the real server with fixture homes in a
  temp dir + env overrides + mock provider endpoints (`test/mocks/`): fake
  transcripts/rollouts, fake `.credentials.json` / `auth.json` (never real
  ones), mock Anthropic/ChatGPT/Discord servers on localhost.
- Never read real credentials, and never let a fake token string appear in
  server logs (there's an assertion for that).
- UI checks when needed: Playwright with the preinstalled Chromium
  (`executablePath: '/opt/pw-browsers/chromium'`, `--no-sandbox`).
  `test/web-notices.test.sh` part 2 is the committed one: it drives the
  COMMITTED `web/dist` (so run `npm run build` after changing web/src) and
  SKIPs cleanly where Playwright/Chromium are missing; `WEB_TEST_SERVER`
  points it at another server copy (e.g. a scratch build).
- `test/migration.test.sh` is the only suite WITHOUT a `*_HOME` pin (fake
  `$HOME`, implicit `~/.pulse` → `~/.burnglass` path); it owns ports
  5831–5856 and fails fast if one is busy. Any change to `appHome`,
  `migrateHome`, the legacy compat writers/readers, the updater's asset
  choice or `versionNum` must keep it green. Windows-only code (tray script,
  `--install`/`--uninstall`, reg.exe helpers, the twin refresh, the Inno
  installer, the make-exe icon stamping, the strip's junction detection)
  cannot run here — list it for the manual Windows RC pass instead of
  claiming it tested. `test/packaging.test.sh` compiles the strip's
  `AppPaths` + `WebAssets` (and, when present, `MeterScale` +
  `SummaryTransform`) out of the real `strip/Program.cs` into a .NET
  harness: it SKIPs without an SDK (`DOTNET=/path/to/dotnet`, and
  `BURNGLASS_REQUIRE_DOTNET=1` makes the skip a failure), and exercised
  links only as Linux symlinks. Its payload check runs `ToUi` on fixture
  summaries (`sources` order/colours/labels/amounts, thresholds, meters,
  projection, tones, used %); an older `STRIP_DIR` tree still runs the home
  checks and FAILs the payload check. It also cuts `OpenMotion` out of
  Program.cs (optional, reached by reflection; the harness prints
  `ease <t>…`), and its popover Playwright part checks the open motion: the
  host curve equals the page's `--ease-decel`, `primeOpen` primes/holds and
  posts `{primed}`, `playOpen` ends at rest, a lost `playOpen` still ends
  visible, `resetOpen` mid-open, a mid-open re-render does not replay,
  backwards-only fills, reduced motion. It also cuts `PopoverDismiss` (any
  `static`/`sealed class` is extractable) and plays 23 open timelines wired
  like PopoverForm (`dismiss r=90,a=300` → `closed@300` / `open`; missing
  class = FAIL). `test/tray.test.sh` starts 3 more
  servers on its own port 4887 with a fake tray (`PULSE_TRAY_TEST_SCRIPT`,
  ~30 s) and, when `PWSH=/path/to/pwsh` is set or pwsh is on PATH (else
  SKIP), parses the generated tray.ps1 and dispatches its browser-opening
  menu handlers through a .NET `EventHandler` (as WinForms does) with a
  failing `Start-Process` stub, cut from the real script: they must return
  normally and log a WARN. `test/strip-heal.test.sh` (mock GitHub
  release by tag, fake strip exes, `PULSE_STRIP_PROC_STUB`) owns ports
  5861–5895 and fails fast if one is busy; `STRIP_HEAL_SERVER=<server.js>`
  runs it against another copy. `test/meters-cache.test.sh` owns mock 4871 +
  server 4873 (`test/mocks/mock-meters.js` takes a port argument and has
  `/count` + a switchable `/usage` via `/mode?m=ok|429|500`).
  `test/web-notices.test.sh` part 2 also checks that the content fills the
  main area edge to edge with the top bar aligned (1440–3840, incl. the 4K
  widths 3072/3200/3840) and the rail source-row fit/ellipsis.
- Manual Windows RC pass, beyond the list above: the real taskbar strip
  (amber/red % used text, DPI layout with "% used" strings, `--striptest`,
  an rc.1 `strip_cells.json` upgrade inside the real exe), the popover in
  real WebView2 (Segoe UI metrics, the page-side `{height}` message,
  `--selftest` / `--shots`), and the post-update strip refresh end to end: a
  portable v1.34 `pulse.exe` beside `pulse-strip.exe` with `"strip": true`
  one-click-updated → `pulse-strip.exe` holds the 2.x bytes, `.old` exists,
  the strip restarted once, `payload.strip.refresh.status === 'updated'`;
  again with the strip only in `~/.pulse/bin` →
  `~/.burnglass/bin/burnglass-strip.exe`; also real `taskkill` / `tasklist`, renaming a running strip on
  NTFS, junctions in `insideLegacyHome`, and an Inno `{app}` refresh.
  rc.3 popover motion: WebView2 keeps rendering while DWM-cloaked (`{primed}`
  in ~30–50 ms, no 140 ms fallback, no stale first frame); DwmFlush slide
  smoothness at 60/120/144 Hz and 150 % DPI, and the fallback over RDP; the
  Win11 rounded corners + #22252f border + whether DWM draws a shadow for the
  borderless WS_EX_TOOLWINDOW popup without CS_DROPSHADOW (else: frame-style
  trick); Win10 Region + CS_DROPSHADOW (its shadow window may show 2–3 frames
  early); instant close (`DWMWA_TRANSITIONS_FORCEDISABLED`); SetForegroundWindow
  on a cloaked window, click-away close, rapid strip clicks; "Animation
  effects" off → no motion; `OnDpiChanged` on mixed-DPI monitors; a height
  change mid-slide; `--selftest` / `--shots` with Dock=Fill. rc.3 tray: real
  powershell.exe 5.1 parses and runs tray.ps1 (only pwsh 7 on Linux was
  tried), its own error text + encoding in `tray-error.log`, exit codes
  2/4/5 seen by Node, real Group Policy / AMSI / Constrained Language
  failures, abandoned-mutex takeover on a version relaunch via `$PSHOME`,
  the row reads Icon running after `?from=tray&pid=` polls, a pre-rc.3 tray
  recognised by its real Invoke-RestMethod User-Agent, left-click / msedge
  mini view with cwd = home; under real PS 5.1 + WinForms a menu "Open
  dashboard" / left-click with no Edge and a broken default-browser
  association logs a WARN and the icon stays (no .NET exception dialog).
  Popover click-away (`PopoverDismiss`): a click on another app 250–400 ms
  after the strip click closes it at once, one inside the first 250 ms
  closes it right after the rise, and a plain strip click never closes it
  by itself (a spurious early Deactivate to another app would now close it
  after the rise — watch for that). rc.3 OpenUsage removal: a start with
  `"openusage": true` + a real OpenUsageTray.exe launches and logs nothing;
  the System grid shows 7 Windows rows with Desktop alerts spanning the row.
- For risky/major features: adversarial review (independent finder lenses →
  verify each finding against the real code) has repeatedly found real bugs —
  fix confirmed findings before release.

## Domain knowledge worth keeping

- Claude Code ≥ 2.1.212 records the reasoning-effort level on every assistant
  transcript entry (top-level `effort`); the echo/hook join below is for older
  sessions and for ultracode (never recorded).
- `/effort` is session-only, never persisted; bare `/effort` opens a picker
  whose chosen level appears ONLY in the `<local-command-stdout>` echo.
- Anthropic's usage API exposes **percentages only** — no token counts exist
  for individual accounts (Admin API is org-only). Codex's
  `/wham/profiles/me` DOES expose real account-wide token counts.
- Codex at 100% utilization can write `rate_limits` snapshots with no
  `used_percent` fields.
- OpenAI prices (verified 2026-09-24): gpt-6-sol $2/$10 and gpt-6-luna
  $0.10/$0.50 (2026-09-22; Codex TUI runs both on Fast/priority by default;
  cache writes 1.25× on the GPT-6 + 5.6 families); gpt-5.2 / 5.2-codex
  $1.75/$14, 5.2-pro $21/$168; Daybreak aliases track 5.6 Sol / Cyber; Codex
  0.154 added a hidden `gpt-reserve` ("Luna Reserve", unpriced → logged
  default); gpt-5.5 leaves Codex 2026-10-14; gpt-6-astra $10/$50 (Codex default
  since 2026-09-04; `-wm` variant = same); gpt-5.6 sol $4/$20 (promo since
  2026-08-21, was $5/$30 — "at least through 2026-11-21"), terra $2/$12 and
  luna $0.20/$1.20 (since 2026-07-30; were $2.50/$15 and $1/$6), bare
  `gpt-5.6` = sol; gpt-5.6-cyber / gpt-5.5-cyber $12.50/$75; gpt-5.5 $5/$30;
  gpt-5.4 $2.50/$15 (mini $0.75/$4.50; both retired from Codex 2026-08-31 →
  terra/luna); gpt-5.3-codex $1.75/$14; `codex-auto-review` runs GPT-5.4.
  Cached input ≈ 10% of input. Long-context (>272K prompt) = 2× in / 1.5× out
  on Astra, 5.6, 5.5, 5.4. Shutdowns: o3-mini/o4-mini 2026-10-23; dated gpt-5*
  and o3* snapshots 2026-12-11.
- Anthropic prices (verified 2026-09-24): Opus 5.5 $4/$20 with 0.05× cache
  reads and fast $8/$40 (2026-09-22; Claude Code default Opus since 2.1.280;
  Sonnet 5.5 / Haiku 5.5 announced, unpriced); Fable 5.1 / Mythos 5.1 $10/$50 with
  0.025× cache reads (everything else 0.10×); Fable 5 / Mythos 5 $10/$50;
  Mythos Preview $25/$125 (Glasswing, deprecated → Mythos 5); Opus 5 / 4.8
  $5/$25 (+ fast $10/$50, the only fast-mode models); Sonnet 5 $2/$10
  (permanent since 2026-08-10); `inference_geo: "us"` = 1.1× on 4.6+. Claude
  Code ≥ 2.1.212 records `effort` per assistant entry. The usage endpoint
  carries undisclosed rotating codename buckets (`nimbus_quill` etc.) —
  hidden at 0%. Weekly limits: +25% permanent from 2026-09-14 (the +50%
  boost ends 2026-09-13).
- Claude Code prunes transcripts after ~30 days (`cleanupPeriodDays`) — long
  windows need users to raise it.
- The frontend has a lite-graphics mode (software-rendering detection) —
  avoid `backdrop-filter` and permanent animations in new UI.
- Brand ("Glass", v2.0.0): the brand kit's usage rules are summarised in the
  Web app section and the tray row. The accent is ice-cyan (`--accent`
  `#4cd4f7` dark / `#034d73` light); the ember orange appears ONLY inside the
  mark assets (app icon, favicon, lockup, Discord art), never as a UI token,
  chart series or tray paint. Tray status = SHAPE first (solid dot / ring /
  barred disc), colour second. README art: `.github/assets/logo.svg` (dark
  lockup) + `logo-light.svg` via `<picture>`.
- The rename's upgrade paths (all must keep working): one-click self-update
  of a portable exe, of an Inno install and of a v1 `--install` copy (file
  name and path kept); BurnglassSetup over PulseSetup or over a v1
  `--install` dir (converges on `Programs\Pulse`, twin `pulse.exe`); Linux /
  macOS binaries in place; VPS `install.sh` (reuses `~/pulse` +
  `pulse.service`). A v1 exe run while v2 serves just opens the dashboard (no
  downgrade); v1 run alone uses the frozen `~/.pulse` and is offered v2.
- Model-family recognition lives in `web/src/model-families.js` (pure
  classifier + `FAMILY_META`, unit-tested) and `web/src/logos.jsx` (SVG marks);
  it only classifies models that reach Burnglass.
- Other-agent ingestion (v1.14.0; Roo Code added v1.18.0): Gemini CLI,
  Continue, Cline, and Roo are read from their own local logs and folded in as
  sources (see the Other-agent parsing row). Feasibility gate = JSON/JSONL +
  default-on + Node-builtin-readable.
  Reverse-engineered format specifics worth remembering: Gemini `input`
  INCLUDES `cached`; Continue numbers are LOCAL ESTIMATES (badged `est`), not
  provider billing; Cline's `text` is double-encoded JSON and it records its own
  `cost` (trust it); Roo shares Cline's task layout (it's a fork) and also
  records its own cost — the per-request model id is `modelId` on the record
  when present, else task metadata, else a coarse `unknown` (Roo's exact model
  state lives in a SQLite DB we deliberately don't read). NOT feasible under
  the zero-dep rule (all SQLite-only):
  **Crush** (`crush.db`), **Goose** (`sessions.db`, v1.10+), **opencode** (v1.16+
  switched JSON→SQLite; only ≤1.15 was JSON). **Aider**'s exact per-call tokens
  need its `--analytics-log` opt-in (default history is rounded markdown).
  Adding the SQLite-only agents later
  means shipping a SQLite reader or raising the Node floor — deliberately not
  done.
