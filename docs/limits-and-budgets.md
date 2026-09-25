# Limits, alerts and budgets

How Burnglass shows your Claude and Codex limits, warns you before you hit them, and tracks your spend against a budget and your plan.

[← Back to the README](../README.md) · [All docs](README.md)

---

<img src="../.github/assets/limits.png" alt="Limits and budget: eight limit gauges for Claude and Codex with alert ticks and projections, Codex account tokens with a daily chart, a budget gauge and a plan value card" width="920" />

The **Limits & budget** section puts every limit in one grid. Each bar shows **% used**,
a tick mark at each of your alert thresholds, a striped **projection at reset** once
there's enough recent data, and a live reset countdown. The limits are account-level, so the
source filter doesn't change them (the budget does follow it).

## Account meters

Local logs can never show claude.ai chats, the mobile apps, browser-only cloud sessions
or other computers. But your Pro / Max limits are **unified**: everything drains the same
5-hour and weekly windows. Anthropic exposes that account-wide meter to Claude Code
(`/usage`), and Burnglass can read the same gauge.

**Turn it on** with **Account meters** in **System** (config `accountMeters`). Off by default.

- You get one bar per limit: the 5-hour session, the weekly limit for all models, per-model
  weekly limits (such as Opus, Sonnet or Fable), Cowork and apps, each with the
  **official utilization %** and its true reset time. Anthropic's endpoint also carries
  undocumented internal buckets; Burnglass hides them until they show real usage.
- The **5-hour block** tile in the overview switches to Anthropic's official window
  (marked *official*) instead of a reconstruction from this machine's logs.
- **Your token:** Burnglass reads your Claude Code login **read-only** from
  `~/.claude/.credentials.json` or, on macOS, the login Keychain (approve the Keychain
  prompt with *Always Allow* once). The token is never logged, shown, written or
  refreshed, and it's sent only to `api.anthropic.com/api/oauth/usage`, Anthropic's own
  endpoint.
- **Polite polling:** that's the endpoint Claude Code polls too, so Burnglass asks about
  every 2 minutes while the dashboard is open, and at most every 15 minutes (5 with the
  tray icon on) when only the status line, Discord or the tray is reading. It backs off on
  HTTP 429 and keeps the last good numbers; the card's *rate-limited* note counts down
  to the next try.
- **Survives restarts:** the last good reading (percentages and reset times, never the
  token) and any active backoff are kept in `~/.burnglass/meters-cache.json`, so after a
  restart or an update the grid shows them at once, with their real age. Readings older
  than 12 hours and windows that have reset since are not shown. Turning meters off
  deletes the file.
- **Stale readings:** a saved window whose reset time has passed while no fresh reading
  arrived is marked stale: dimmed on the dashboard, left out of alerts, the status line,
  the tray and the strip.
- **Not logged in?** The card shows **Connect your Claude account**. Log in from any
  Claude Code surface, then click **Recheck now**; no restart needed.
- **Limits of the feature:** it's an aggregate gauge, not per-chat line items; no
  per-conversation breakdown exists anywhere. The endpoint is internal to Anthropic and
  could change; the card degrades gracefully if it does. If you switch Claude logins
  between runs, the old account's numbers show until the next good reading.

### Codex account tokens

With a Codex login present (`~/.codex/auth.json`, read-only), the same switch also shows
your ChatGPT account's **real token counts** across **all devices**: today, 7 days,
30 days, lifetime, peak day and streak, plus a 30-day daily chart. They come from the
endpoint behind Codex's own usage chart on `chatgpt.com`, polled every 10 minutes.
Anthropic's API exposes percentages only, so there's no Claude equivalent.

Consent is explicit: turning meters on **from the dashboard** sets both
`accountMeters` and `codexAccountUsage`. A config from before Pulse 1.6.0 that only has
`accountMeters` keeps the ChatGPT call off until you toggle the switch again.

## Codex limits (automatic)

Every Codex turn records a snapshot of your ChatGPT plan's Codex allowance (the 5-hour
and weekly windows) in its rollout log. Burnglass shows the newest snapshot in the grid
automatically: no login, nothing leaves your machine. The bars are labelled *snapshot*
with how fresh it is; run any Codex turn to refresh it. A window that rolled over since
the snapshot shows as stale rather than as a made-up number.

These are your plan's Codex windows, not chatgpt.com chat limits (which aren't exposed
anywhere). ChatGPT in the browser or the mobile app writes no local logs.

## Projection at reset

Burnglass samples each Claude limit as it refreshes and, once it has at least 10 minutes
of samples from the last 2 hours, draws a straight line to the window's reset: the
striped part of the bar and the *→ N% at reset* label. A falling trend never projects a
refill, and the samples start over when a window resets.

## Limit alerts

When any Claude limit (5-hour, weekly, model-scoped) or Codex window crosses one of your
thresholds, an alert strip appears above the overview, most urgent first, with the
provider and the reset time, and *Limits & budget* in the rail gets a count.

- Thresholds default to **80%** and **95%**. Change them with `alertThresholds`, for
  example `[75, 90]`; the same numbers set the bar ticks, the tray icon and the strip's colours.
- A window already at 100% has been reached, not approached, so it stays out of the
  alert strip and shows only in its bar.
- **Desktop notifications:** click **Enable desktop alerts** in the alert strip or turn
  on **Desktop alerts** in **System**, and allow notifications in your browser. Each alert
  notifies once per threshold per window. Turn them off in your browser's notification
  settings for the page.
- `{"alerts": false}` turns limit alerts off.

### Spend anomaly (opt-in)

`{"anomalyAlerts": true}` adds an alert when today's spend blows past your own baseline,
for example *today $62.00 — 3.1× your recent daily average ($20.00)*. The baseline is the
mean of the days in the last 30 on which you spent anything. It needs at least 5 such
days and $5 spent today, and it notifies at most once a day. Tune the trigger with
`anomalyMultiplier` (default 3, minimum 1.5). It follows the `alerts` switch.

## Budget goals

Set a spend target inline (the **Edit** button on the budget card) or with `budget` and
`budgetPeriod`:

- **Monthly** budgets cover the calendar month and reset on the 1st. Once the month is
  about half a day old, the card shows a straight-line **month-end projection**
  (*on pace for ~$1,082*) and the gauge marks it with a pace dot.
- **Weekly** budgets cover the trailing 7 days (a rolling window, so there's no end to
  project to).
- The gauge turns amber at 80% of the target and red once the target is reached. An
  amount of 0 clears the budget.
- The budget counts the sources selected in the filter.

## Plan value

Enter what your subscription costs (the **Edit** button on the plan card, or `planCost`
plus an optional `planLabel`). The card leads with your last 30 days of list-priced usage
as a multiple of that cost, for example *5.3× your plan's cost*, and shows up to six
calendar months against a 1× break-even line. Click a month's bar to select that month as
the period.

It always covers **all sources**, because your plan doesn't change with the filter.
Every tool is repriced at list prices (Continue's local estimates and Cline's and Roo's
own recorded costs are folded in as they are), so it's a measure of value, not a bill.
A month under 1× is shown neutrally, never in red. Setting the amount to 0 clears both
the cost and the label.

## The 5-hour block

The overview's **5-hour block** tile shows the current window's spend, its time left and
how it compares with your heaviest block. It covers Claude Code only: Codex has its own
windows, and other agents and custom sources never count toward it.

With account meters on, the window is Anthropic's official one. Without them, Burnglass
reconstructs it from this machine's logs, which can differ from Claude's real window; see
[How it works](how-it-works.md#5-hour-blocks).
