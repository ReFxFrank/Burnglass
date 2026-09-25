# How it works

Where Burnglass's numbers come from, how they're priced, how accurate they are, and what it can and can't see.

[← Back to the README](../README.md) · [All docs](README.md)

---

## Reading the logs

- **Source of truth.** Claude Code writes newline-delimited JSON transcripts under
  `~/.claude/projects/`, and Codex writes rollouts under `~/.codex/sessions/`. Burnglass
  walks those trees (and the [other agents' logs](#other-agents)), parses every entry
  that carries usage, and normalizes it. It only ever reads them.
- **Fast rebuilds.** Parsed files are cached by modification time, so unchanged files are
  never re-read and even large histories rebuild in milliseconds. The dashboard polls
  every 10 seconds.
- **Sources.** Claude Code usage is split by where it ran (its `entrypoint`): Claude CLI,
  Claude VS Code, Claude JetBrains, Claude Desktop or the SDK. Codex, Gemini CLI,
  Continue, Cline, Roo Code and each custom source are sources of their own.

### Claude Code

- **Deduplication.** Claude Code writes the same message several times as it streams.
  Burnglass dedupes on `message.id + requestId`; without this, costs would be inflated
  about 3×. When the copies differ, Burnglass keeps the fullest one: Claude Code ≥ 2.1.281
  writes subagent messages as several lines whose *first* line carries a partial
  streaming count.
- **Subagents** are counted with their parent session.
- **Advisor calls.** Claude Code's advisor runs as a separate server-side inference whose
  usage appears only inside the message's `usage.iterations`. Burnglass counts each call
  as its own entry at the advisor model's price.

### Codex

- `gpt-*` models appear in **By model**, `codex` in **By source**, and sessions in the
  table with their reasoning effort, read from each turn's context.
- Rollouts of spawned agents, the auto-reviewer and `/review` are grouped under their
  parent session.
- This covers the Codex **CLI**, which logs locally. ChatGPT in the browser or the mobile
  app writes no local logs (same as claude.ai), so it can't appear on any local dashboard.

### Other agents

| Agent | What Burnglass reads | Cost |
| --- | --- | --- |
| **Gemini CLI** | `~/.gemini/tmp/*/chats/session-*.jsonl` | Google Gemini API list prices |
| **Continue** | `~/.continue/dev_data/*/tokensGenerated.jsonl` | Priced from Continue's own **local token estimates**, so the source is badged `est` |
| **Cline** | the extension's task history (`globalStorage/saoudrizwan.claude-dev/tasks/`) | Cline's own recorded per-request cost |
| **Roo Code** | the same layout under `rooveterinaryinc.roo-cline` / `.roo-code` | Roo's own recorded cost |

- Each appears only when its logs are present; there's nothing to set up.
- Cline and Roo are found in VS Code, Insiders, VSCodium, Cursor and Windsurf, plus
  `~/.vscode-server` on Linux remote installs.
- A Cline task's model comes from the task's own metadata. Roo records the model on each
  request when it can; otherwise it comes from the task metadata, or shows as `unknown`
  (Roo keeps its exact model state in a SQLite database Burnglass doesn't read).
- Gemini's input count already includes its cached tokens; Burnglass splits them.
- None of these agents count toward the Claude 5-hour block, even when they run a Claude model.
- **Not supported:** agents that keep usage only in SQLite (Crush, Goose, opencode ≥ 1.16).
  Reading SQLite would break the zero-dependency rule. Aider's default history has no
  exact per-call token counts.

Your own agent can be added as a [custom source](custom-sources.md).

## Pricing

Every entry is priced at its provider's **API list price**, at the rate in force on the
entry's own date. The rates live in three commented tables near the top of `server.js`:
`PRICING` (Anthropic, plus Z.ai GLM models used through Claude Code), `PRICING_OPENAI` and
`PRICING_GOOGLE`.

**Claude:**

- cache writes cost ×1.25 (5-minute) or ×2.0 (1-hour) of the input rate;
- cache reads cost ×0.1, or ×0.05 for Opus 5.5 and ×0.025 for Fable / Mythos 5.1;
- fast mode has its own rates on the models that offer it (Opus 5.5, Opus 5 and Opus 4.8),
  applied only when the entry records `speed: "fast"`;
- US-only inference (`inference_geo: "us"`) costs ×1.1;
- web searches are $10 per 1,000.

Dated ids and Bedrock / Vertex ids price as their base model.

**OpenAI (Codex):** list prices including the cached-input discount, the cache-write rate
where OpenAI publishes one, the >272K-token long-context tier on the models that have one, and **Fast mode** with each
model's published multiplier. The Codex TUI runs GPT-6 Sol and Luna on Fast by default.
Fast mode is priced only where the rollout records the tier, and Codex doesn't record it
for a brand-new session until it's resumed, compacted or its settings change. Until then,
those turns price at standard: Burnglass can under-count, but it never guesses high.

**Google Gemini:** Gemini API list prices, with cached input at 10% of the input rate.

**Unknown models** fall back to a default price and are logged once in the server log. An
unpriced point release (for example a new `claude-*-5-5`) borrows its parent's rate and is
logged too, so a gap is never silent.

**Price changes** reach every day that's still in your logs, and the archive heals on
its next seal. A day whose logs have already been pruned keeps the cost it was archived with.

### Prompt cache and fast mode

The **Spend** section's strip shows:

- **Prompt cache:** what cache reads saved you against paying the full input rate, *net*
  of what cache writes cost above plain input. Caching isn't free, so a write-heavy
  window can be genuinely negative, and it's shown that way.
- **Fast mode:** what fast mode cost above standard rates. A fast entry on a model with
  no fast price contributes nothing.

## Costs are estimates, not a bill

Costs are computed at each provider's API list prices (Anthropic, OpenAI, Google, Z.ai).
On a Pro / Max or ChatGPT subscription they express your **relative** usage (which
sessions, models and time windows are heavy), not an amount you'll be charged.

- Cline and Roo report their own recorded cost, which Burnglass uses as-is.
- Continue's token counts are its own local estimates (badged `est`).
- Custom sources are $0 unless their records carry a cost.

Check current list prices with each provider (for Claude,
[docs.claude.com](https://docs.claude.com)) before relying on absolute figures.

## Reasoning effort

Burnglass shows which sessions ran at which reasoning effort (`low` → `max`, plus
ultracode) and when fast mode was used, with **zero setup**:

- Claude Code ≥ 2.1.212 records the effort level on every assistant message, and
  Burnglass reads it directly.
- For older sessions, Burnglass reads the `/effort` commands you typed (including the
  interactive picker's confirmation) straight from the transcripts, **retroactively**.
- `/effort ultracode`, or typing `ultracode` in a prompt, flags the session ULTRA
  (ultracode is never recorded as data).
- Codex effort comes from each turn's context in the rollout.
- A session that never set a level shows no chip. Burnglass won't guess, and `auto` /
  `default` never become chips.

The levels feed the **By effort** breakdown and the effort mix in **By model**.

**Optional hook:** for older Claude Code builds with an effort level persisted in
`settings.json` (applied across sessions), `burnglass --effort-setup` prints a hook
snippet to paste into `~/.claude/settings.json` (Burnglass never edits `~/.claude`
itself). New sessions then log their level to `~/.burnglass/modes.jsonl`.

## Live state

The top bar (and the Discord presence) shows what Claude or Codex is doing right now:
*working*, *thinking*, *waiting on you* or *idle*, with the model, effort and session
count. For Claude, Burnglass reads Claude Code's own live-session files
(`~/.claude/sessions/`, read-only) together with the transcript, and falls back to the
transcript alone on older builds. For Codex it reads the rollout.

## 5-hour blocks

With [account meters](limits-and-budgets.md#account-meters) on, the 5-hour block uses
Anthropic's official window (marked *official*). Otherwise Burnglass reconstructs it
from this machine's logs: the first message after a gap of 5 hours or more (or past the
previous window's end) opens a block, floored to the hour.

> [!WARNING]
> **A reconstructed countdown can differ from Claude's.** The *real* window is opened by
> your first message on **any** surface: claude.ai in the browser, mobile, or another
> computer. Those messages aren't in this machine's logs. If they anchored the real
> window earlier, the actual reset happens **earlier** than Burnglass shows. Treat a
> reconstructed countdown as an upper bound, or turn on account meters for the true one.

## History

Each fully past day's totals (cost, tokens and messages per source and model) are sealed
to `~/.burnglass/history/`, one small JSON file per month, and merged back in, so long
windows and all-time totals survive log pruning. A live day always wins over its
archived copy, so nothing is counted twice. History is on by default;
`{"history": false}` turns it off.

The archive keeps only day, source and model totals. By effort, By project, the heatmap,
the cache savings and the fast-mode figures are computed from entries still in your logs.
The cards' ⓘ tooltips say so, and the cache and fast-mode figures state their coverage
when it's well below the period total.

## What Burnglass can and can't see

- Burnglass reads the logs on **this machine only**. Usage from other computers,
  claude.ai in the browser or the mobile apps won't appear in spend. Only the opt-in
  account meters cover them, and only as percentages.
- **Claude Code prunes old transcripts** (after about 30 days by default, via
  `cleanupPeriodDays`). Burnglass archives each past day's totals before they're pruned,
  so long windows and all-time totals stay intact from your first Burnglass run on (the
  spend chart and by-model / by-source; per-session detail stays recent-only). To keep
  older raw logs, raise the retention in `~/.claude/settings.json`:

  ```json
  { "cleanupPeriodDays": 3650 }
  ```

- *Last 30 days* is a **rolling window**. Use the calendar months in the period list for
  fixed month totals.
- **Recent sessions** shows whole-session totals, so summing that column won't match a
  period total when sessions straddle the window edge.
- Account meters are percentages only: Anthropic exposes no token counts for individual
  accounts. Codex's account endpoint does expose real token counts.

## Meshy credits

[Meshy](https://www.meshy.ai) has no local log, so it's the one source Burnglass reads over
the network with a key **you** provide (opt-in; see
[Privacy & security](privacy-security.md#meshy-api-key)).

- Credits stay credits. There's no published credit-to-dollar rate, so they never enter
  your spend, budget or plan value.
- Burnglass refreshes at most every 15 minutes and keeps task history in
  `~/.burnglass/meshy.json` (credits and task types, never your prompts), so the all-time
  total never shrinks as old tasks age out.
- A rejected key isn't retried until you change it, and 429 / 5xx responses back off while
  the last good numbers stay on screen.
- Meshy documents only its text-to-3D list endpoint, so the card says which task types it
  could actually count.
