// =============================================================================
// meters.jsx — account usage-limit instruments for the "Limits & budget"
// group (sections/Limits.jsx). Command Center system: every colour is a token,
// nothing loops, styles live in sections/Limits.css scoped under .sec-limits.
//
//   <AccountLimits meters codexMeters codexUsage thresholds onRecheck />
//     the c-8 "Account limits" panel: a hairline grid of MeterCells for every
//     Claude + Codex bucket, the Claude login / loading / stale states, and the
//     Codex account-tokens row.
//   <MeterCell b provider thresholds />   one bucket (% used, bar, reset)
//   <Countdown ts />                      "resets in 2h 12m" + "Fri 09:07"
//
// Colour thresholds are the configured ALERT thresholds (payload
// .alertThresholds, default 80/95) via lib.meterTone — never the old 60/85 —
// so bars, the alert strip and desktop notifications always agree.
// =============================================================================
import { useState } from 'react';
import { Icon } from './icons.jsx';
import { FamilyMark } from './logos.jsx';
import { Badge, Btn, InfoTip, MeterBar, Panel, cx } from './ui.jsx';
import { BRAND, ago, dur, formatReset, localDateStr, meterTone, num, shortDate, tokens, useTick } from './lib.js';

const HOUR = 3600e3;

// ---- names ------------------------------------------------------------------
// Short cell names; the full provider-prefixed server label stays in the
// cell's title and the meter's aria-label.
const METER_NAMES = {
  five_hour: '5-hour session',
  seven_day: 'Weekly · all models',
  codex_primary: 'Codex · 5-hour',
  codex_secondary: 'Codex · weekly',
};
export function meterName(b, provider) {
  if (b && METER_NAMES[b.key]) return METER_NAMES[b.key];
  let s = String((b && (b.label || b.key)) || '').replace(/^(Claude|Codex)\s*·\s*/i, '').trim();
  s = s.replace(/^weekly\b/, 'Weekly');
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return provider === 'codex' ? 'Codex · ' + s : s;
}

// ---- countdown ------------------------------------------------------------------
// "resets in 2h 12m" · "Fri 09:07". Ticks every 30 s, or every second in the
// last hour (lib.dur shows seconds there), so it stays honest between polls.
export function Countdown({ ts, prefix = 'resets in' }) {
  const left = ts - Date.now();
  useTick(left > 0 && left < HOUR ? 1000 : 30000);
  if (ts == null || !isFinite(ts)) return null;
  if (left <= 0) return <span>resetting…</span>;
  return (
    <>
      <span>{prefix} <b>{dur(left)}</b></span>
      <span>{formatReset(ts)}</span>
    </>
  );
}

// ---- one bucket -------------------------------------------------------------------
export function MeterCell({ b, provider, thresholds }) {
  const stale = !!b.stale;
  const pct = isFinite(b.pct) ? Number(b.pct) : 0;
  const tone = stale ? '' : meterTone(pct, thresholds);
  const projUsed = !stale && b.projLeftAtReset != null && isFinite(b.projLeftAtReset)
    ? Math.round(Math.max(0, Math.min(100, 100 - b.projLeftAtReset)))
    : null;
  const name = meterName(b, provider);
  let proj = null;
  if (projUsed != null) {
    proj = (
      <span className={cx('mc-proj', meterTone(projUsed, thresholds))} title="Straight-line projection of % used at the reset, from the recent trend">
        → {projUsed}% at reset
      </span>
    );
  } else if (provider === 'codex' && !stale) {
    proj = <span className="mc-proj" title="Codex meters come from the snapshot your last local Codex turn wrote">snapshot</span>;
  }
  return (
    <div className={cx('mc', tone, stale && 'stale')}>
      <div className="mc-top" title={b.label}>
        <FamilyMark family={provider === 'codex' ? 'openai' : 'claude'} size={14} title="" />
        <span className="nm">{name}</span>
      </div>
      <div className="mc-val">
        <span className="mc-pct">{Math.round(pct)}<small>%</small></span>
        {proj}
      </div>
      <MeterBar
        pct={pct}
        proj={projUsed}
        thresholds={thresholds}
        tone={stale ? '' : undefined}
        stale={stale}
        label={`${b.label || name}: ${Math.round(pct)}% used${projUsed != null ? `, about ${projUsed}% at reset` : ''}`}
      />
      <div className="mc-foot">
        {stale
          ? <span>window rolled over · run a turn to refresh</span>
          : b.resetsAt ? <Countdown ts={b.resetsAt} /> : null}
      </div>
    </div>
  );
}

// Column count for the hairline grid: rows stay full where possible
// (8 → 4+4, 6 → 3+3, 5 → 3+2); phones get 2 (1 for a single cell).
function gridCols(n) {
  if (n <= 4) return Math.max(1, n);
  if (n === 5 || n === 6 || n === 9) return 3;
  return 4;
}

// ---- Claude login states ------------------------------------------------------------
// no-login / expired-without-bars: the app only ever READS the token, so the
// fix is always "sign in to Claude Code", then Recheck (POST /api/meters/recheck).
export function ConnectClaude({ expired, checking, onRecheck, err }) {
  return (
    <div className="lim-state">
      <FamilyMark family="claude" size={16} title="" />
      <div className="ls-body">
        <b className="ls-t">{expired ? 'Reconnect Claude to refresh official limits' : 'Connect Claude to see official limits'}</b>
        <p className="hint">
          {expired
            ? <>Your saved Claude Code login looks stale. Start any Claude Code session (desktop, IDE or <code>claude</code> in a terminal) to refresh it. </>
            : <>No Claude Code login found. Sign in to Claude Code — desktop, IDE or <code>claude</code> in a terminal. </>}
          {BRAND} only reads the saved login; it never writes credentials.
        </p>
        <div className="ls-act">
          <Btn size="sm" icon="refresh" onClick={onRecheck} disabled={checking} aria-busy={checking || undefined}>
            {checking ? 'Checking…' : 'Recheck now'}
          </Btn>
          {err ? <span className="hint ls-err" role="alert">Recheck failed: {err}</span> : null}
        </div>
      </div>
    </div>
  );
}

function StateLine({ icon, tone, children }) {
  return (
    <div className={cx('lim-state', 'line', tone)}>
      {icon === 'claude' ? <FamilyMark family="claude" size={16} title="" /> : <Icon name={icon || 'info'} size={14} />}
      <div className="ls-body hint">{children}</div>
    </div>
  );
}

// ---- Codex account tokens ----------------------------------------------------------
// REAL account-wide counts from chatgpt.com (opt-in). Stats row + a 30-bar
// spark; hovering/tapping a bar reads it out in the caption.
function CodexBars({ buckets }) {
  const [hi, setHi] = useState(null);
  const n = buckets.length;
  const max = Math.max(1, ...buckets.map((b) => b.tokens || 0));
  const last = buckets[n - 1];
  const lastIsToday = last && last.date === localDateStr();
  const peak = buckets.reduce((a, b) => ((b.tokens || 0) > (a.tokens || 0) ? b : a), buckets[0]);
  const at = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width) return null;
    return Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n)));
  };
  const cur = hi != null ? buckets[hi] : null;
  return (
    <div className="cx-spark">
      <div
        className="cx-bars"
        role="img"
        aria-label={`Codex tokens per day, ${shortDate(buckets[0].date)} to ${lastIsToday ? 'today' : shortDate(last.date)}; peak ${tokens(peak.tokens)} on ${shortDate(peak.date)}`}
        onPointerMove={(e) => setHi(at(e))}
        onPointerDown={(e) => setHi(at(e))}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHi(null); }}
      >
        {buckets.map((b, i) => (
          <i
            key={b.date}
            className={cx(i === n - 1 && lastIsToday && 'today', i === hi && 'on')}
            style={{ height: Math.max(2, ((b.tokens || 0) / max) * 100).toFixed(1) + '%' }}
          />
        ))}
      </div>
      <div className="cx-cap">
        <span>{shortDate(buckets[0].date)}</span>
        <span className="cx-read" aria-live="polite">{cur ? <><b>{tokens(cur.tokens)}</b> · {shortDate(cur.date)}</> : 'tokens / day'}</span>
        <span>{lastIsToday ? 'Today' : shortDate(last.date)}</span>
      </div>
    </div>
  );
}

export function CodexTokens({ cxu, hasCodexRows }) {
  if (!cxu) return null;
  const s = cxu.stats;
  if (!s) {
    if (cxu.status === 'expired' && hasCodexRows && cxu.error) {
      return <StateLine icon="alert" tone="warn">Codex account tokens: {cxu.error}</StateLine>;
    }
    return null; // loading / no-login / nothing yet — stay quiet
  }
  const stale = cxu.status !== 'ok' && cxu.lastGoodAt;
  const facts = [
    ['Today', s.todayTokens, tokens],
    ['7 days', s.last7Tokens, tokens],
    ['30 days', s.last30Tokens, tokens],
    ['Lifetime', s.lifetimeTokens, tokens],
    ['Peak day', s.peakDailyTokens, tokens],
    ['Streak', s.currentStreakDays, (v) => num(v) + (v === 1 ? ' day' : ' days')],
  ].filter(([, v]) => v != null && isFinite(v));
  const buckets = Array.isArray(s.buckets) ? s.buckets.filter((b) => b && b.date) : [];
  return (
    <div className={cx('cx', buckets.length < 2 && 'solo')}>
      <div className="cx-l">
        <div className="cx-h">
          <FamilyMark family="openai" size={14} title="" />
          <span>Codex account tokens</span>
          <Badge>All devices</Badge>
          <InfoTip text="Real token counts from your ChatGPT account (chatgpt.com) — the same numbers as Codex’s own usage chart, across every device. Anthropic’s API reports percentages only, so Claude has no equivalent." />
          {stale ? <span className="cx-stale">showing numbers from {ago(cxu.lastGoodAt)}</span> : null}
        </div>
        <dl className="cx-stats">
          {facts.map(([k, v, f]) => <div key={k}><dt>{k}</dt><dd>{f(v)}</dd></div>)}
        </dl>
      </div>
      {buckets.length > 1 ? <CodexBars buckets={buckets} /> : null}
    </div>
  );
}

// ---- the panel -------------------------------------------------------------------------
const LIMITS_INFO = 'Official 5-hour and weekly utilisation, not estimates. Claude (opt-in): Anthropic’s own account meter — unified across claude.ai, cloud sessions and every device — read from api.anthropic.com with your existing Claude Code login, read-only. Codex: the rate-limit snapshot your newest local Codex rollout recorded; nothing leaves your machine, but it is only as fresh as your last Codex turn.';

export function AccountLimits({ meters, codexMeters, codexUsage, thresholds, onRecheck, className }) {
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState(null);
  async function recheck() {
    setChecking(true); setErr(null);
    try { await onRecheck(); } catch (e) { setErr(e && e.message ? e.message : String(e)); }
    setChecking(false);
  }

  const anth = meters && meters.enabled ? meters : null;
  const cxu = codexUsage && codexUsage.enabled ? codexUsage : null;
  const codexRows = codexMeters && Array.isArray(codexMeters.buckets) ? codexMeters.buckets : [];
  const claudeRows = anth && Array.isArray(anth.buckets) ? anth.buckets : [];
  const hasBars = claudeRows.length > 0;

  // What the Claude half shows: its cells, and/or one state block.
  let claudeState = null;
  let showClaude = false;
  let note = null;
  if (anth) {
    const st = anth.status;
    if (st === 'loading' || (checking && !hasBars)) {
      claudeState = <StateLine icon="claude">Fetching official usage from your Claude account…</StateLine>;
    } else if (st === 'no-login') {
      claudeState = <ConnectClaude checking={checking} onRecheck={recheck} err={err} />;
    } else if (st === 'expired' && !hasBars) {
      claudeState = <ConnectClaude expired checking={checking} onRecheck={recheck} err={err} />;
    } else if (st === 'expired' || st === 'error' || st === 'rate-limited') {
      // A throttled or failed refresh is not data loss: keep the last good
      // numbers on screen with an honest note about their age.
      const lead = st === 'rate-limited'
        ? 'Rate-limited by Anthropic — retrying automatically'
        : (anth.error || 'Could not refresh Claude’s meters');
      const age = anth.lastGoodAt ? ` · showing last good values from ${ago(anth.lastGoodAt)}` : '';
      const text = st === 'rate-limited' && anth.error ? anth.error : lead;
      if (hasBars) {
        showClaude = true;
        note = (
          <div className={cx('lim-note', st !== 'rate-limited' && 'warn')}>
            <Icon name="alert" size={14} />
            <span className="ln-t">{text}{age}</span>
            {st === 'expired' ? (
              <Btn size="sm" variant="ghost" icon="refresh" onClick={recheck} disabled={checking}>{checking ? 'Checking…' : 'Recheck'}</Btn>
            ) : null}
          </div>
        );
      } else {
        claudeState = <StateLine icon="alert" tone={st === 'rate-limited' ? '' : 'warn'}>{text}</StateLine>;
      }
    } else if (!hasBars) {
      claudeState = <StateLine icon="claude">No usage buckets reported for this Claude account.</StateLine>;
    } else {
      showClaude = true;
    }
  }

  const cells = [
    ...(showClaude ? claudeRows.map((b) => ({ b, provider: 'claude' })) : []),
    ...codexRows.map((b) => ({ b, provider: 'codex' })),
  ];

  // Header context: what the numbers are and how fresh each half is.
  const ctx = [];
  if (cells.length) ctx.push('% used');
  if (showClaude) {
    const t = anth.status === 'ok' ? anth.fetchedAt : anth.lastGoodAt;
    if (t) ctx.push(`Claude ${anth.status === 'ok' ? 'refreshed' : 'as of'} ${ago(t)}`);
  }
  if (codexRows.length && codexMeters.asOf) ctx.push(`Codex snapshot ${ago(codexMeters.asOf)}`);

  const legend = cells.length ? (
    <span className="legend-mini" aria-hidden="true">
      <span><i className="lg-tick" />alerts at {thresholds.join(' / ')}%</span>
      <span><i className="lg-proj" />projected at reset</span>
    </span>
  ) : null;

  const nothing = !anth && !codexRows.length && !cxu;
  const cols = gridCols(cells.length);
  return (
    <Panel
      title="Account limits"
      info={LIMITS_INFO}
      ctx={ctx.length ? ctx.join(' · ') : null}
      actions={legend}
      flush
      // No meter cells = only a short state block (connect / off / loading):
      // don't stretch it to the Budget + Plan column's height (an empty box).
      className={cx('lim-meters', !cells.length && 'lim-compact', className)}
    >
      {nothing ? (
        <div className="lim-state off">
          <Icon name="gauge" size={16} />
          <div className="ls-body">
            <b className="ls-t">Official limits are off</b>
            <p className="hint">
              Turn on <b>Account meters</b> in System to see your Claude 5-hour and weekly limits, read with your existing Claude Code
              login. Codex limits appear here on their own after your next Codex turn.
            </p>
            <div className="ls-act"><Btn size="sm" href="#system" iconRight="right">Open System</Btn></div>
          </div>
        </div>
      ) : null}
      {claudeState}
      {cells.length ? (
        <div className="mgrid-wrap">
          <div className="mgrid" style={{ '--mc-cols': cols, '--mc-cols-sm': Math.min(2, cols) }}>
            {cells.map(({ b, provider }) => <MeterCell key={provider + ':' + b.key} b={b} provider={provider} thresholds={thresholds} />)}
          </div>
        </div>
      ) : null}
      {note}
      <CodexTokens cxu={cxu} hasCodexRows={codexRows.length > 0} />
    </Panel>
  );
}
