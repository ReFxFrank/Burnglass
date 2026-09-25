// =============================================================================
// sections/Limits.jsx — "Limits & budget": account meters, Codex account
// tokens, budget gauge, plan value.
// OWNER: the Limits section engineer. Styles: ./Limits.css, scoped .sec-limits.
//
// PROPS (SectionProps — see CONTRACT.md):
//   id          'limits' — root <Section id={id} title="Limits & budget" meta=…>
//   data        payload; reads
//                 meters{enabled,status,buckets[]{key,label,pct,resetsAt,stale,projLeftAtReset},
//                        lastGoodAt,fetchedAt,error}  (status: ok|loading|no-login|expired|error|rate-limited)
//                 codexMeters{asOf,buckets[]} · codexUsage{enabled,status,stats{todayTokens,
//                        last7Tokens,last30Tokens,lifetimeTokens,peakDailyTokens,currentStreakDays,buckets[]},lastGoodAt,error}
//                 budget{target,period,label,spent,pct,remaining,resetsAt,state,projected}|null
//                 planValue{configured,cost,label,spend30,multiplier,months[]{key,spend,multiplier,partial,elapsedFraction}}
//                 generatedAt (to tell a post-save refetch from an older poll)
//   thresholds  alert thresholds → MeterBar ticks + lib.meterTone colours
//   srcFilter   budget spend follows the source filter (server-side); plan
//               value and meters are account-level
//   (period, colorMap, notify, gfx, theme, onStopped, onPeriod: unused)
//
// ENDPOINTS (mutations via lib.postJson, which adds X-Pulse: 1):
//   POST /api/meters/recheck            (Connect card "Recheck now")
//   POST /api/budget/set?amount&period  (amount ≤ 0 clears)
//   POST /api/plan/set?amount&label     (amount ≤ 0 clears both)
//   GET  /api/summary[?sources=…]       once after each of those, so the new
//                                       state shows at once instead of on the
//                                       next 10 s poll (same URL App polls)
//
// Layout: c-8 "Account limits" panel (meters.jsx) + c-4 stack (Budget gauge,
// Plan value). ≤1360 the stack goes full width as two columns; ≤760 one.
// =============================================================================
import { useEffect, useRef, useState } from 'react';
import { Section, Panel, Btn, Seg, InputGroup, Input, Tip, cx } from '../ui.jsx';
import { AccountLimits } from '../meters.jsx';
import { BRAND, MONTHS, dur, money, postJson } from '../lib.js';
import './Limits.css';

// A user-entered round target reads as "$1,200", not "$1,200.00" (as in the
// mockup); anything with cents falls back to money().
function moneyTarget(v) {
  if (v == null || !isFinite(v)) return '—';
  return Number.isInteger(v) ? '$' + v.toLocaleString('en-US') : money(v);
}
// "$1,200" / "1200" / " 1,200.50 " → number (NaN when unparseable)
function parseAmount(s) {
  return parseFloat(String(s == null ? '' : s).replace(/[$,\s]/g, ''));
}
// 13.6× / 2.4× / 0.62× — enough precision to move month to month without
// implying more accuracy than list-price estimates have.
function multFmt(m) {
  if (m == null || !isFinite(m)) return '—';
  return (m >= 10 ? m.toFixed(1) : m.toFixed(m < 1 ? 2 : 1)) + '×';
}
function monthLong(key) {
  const y = String(key).slice(0, 4), m = parseInt(String(key).slice(5, 7), 10);
  return (MONTHS[m - 1] || key) + ' ' + y;
}
function monthShort(key) {
  const m = parseInt(String(key).slice(5, 7), 10);
  return MONTHS[m - 1] || String(key);
}

// After a save, fetch the summary once so the panel shows the new state now.
// The fetched payload is used only while it is NEWER than the one App last
// polled (server generatedAt), so the next regular poll takes over cleanly.
function useFreshAfterSave(data, srcFilter) {
  const [fresh, setFresh] = useState(null);
  async function refresh() {
    const key = srcFilter && srcFilter.length ? srcFilter.slice().sort().join(',') : '';
    const r = await fetch('/api/summary' + (key ? '?sources=' + encodeURIComponent(key) : ''), { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (j && isFinite(j.generatedAt)) setFresh(j);
  }
  const cur = fresh && isFinite(data.generatedAt) && fresh.generatedAt > data.generatedAt ? fresh : null;
  return [cur, refresh];
}

// Focus returns to the panel's Edit button once a form closes (keyboard users
// keep their place) — only when focus was inside the form.
function useReturnFocus(editing) {
  const btn = useRef(null);
  const form = useRef(null);
  const hadFocus = useRef(false);
  useEffect(() => {
    if (editing) return undefined;
    if (hadFocus.current && btn.current) btn.current.focus();
    hadFocus.current = false;
    return undefined;
  }, [editing]);
  const track = () => { hadFocus.current = !!(form.current && form.current.contains(document.activeElement)); };
  return { btn, form, track };
}

// ---- budget gauge -------------------------------------------------------------
const R = 70, CX = 86, CY = 84;
const arcPt = (f) => { const a = Math.PI * (1 - f); return [CX + R * Math.cos(a), CY - R * Math.sin(a)]; };
const arcD = (f0, f1) => {
  const [x0, y0] = arcPt(f0), [x1, y1] = arcPt(f1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${R} ${R} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};
function tickLine(f) {
  const a = Math.PI * (1 - f);
  const p = (r) => [CX + r * Math.cos(a), CY - r * Math.sin(a)];
  const [x0, y0] = p(R - 10), [x1, y1] = p(R + 10);
  return <line className="g-tick" x1={x0.toFixed(2)} y1={y0.toFixed(2)} x2={x1.toFixed(2)} y2={y1.toFixed(2)} />;
}

function BudgetGauge({ budget }) {
  const pct = isFinite(budget.pct) ? budget.pct : 0;
  const bf = Math.max(0, Math.min(1, pct / 100));
  const hasPace = budget.projected != null && isFinite(budget.projected) && budget.target > 0;
  const pf = hasPace ? Math.max(0, Math.min(1, budget.projected / budget.target)) : null;
  const tone = pct >= 100 ? 'crit' : pct >= 80 ? 'warn' : '';
  const paceTone = !hasPace ? '' : budget.projected >= budget.target ? 'crit' : budget.projected >= budget.target * 0.8 ? 'warn' : '';
  const [px, py] = hasPace ? arcPt(pf) : [0, 0];
  const pacePct = hasPace ? Math.round((budget.projected / budget.target) * 100) : null;
  return (
    <svg
      className={cx('gauge-svg', tone)}
      viewBox="0 0 172 100"
      role="img"
      aria-label={`Budget ${Math.round(pct)}% used of ${moneyTarget(budget.target)}${hasPace ? `; on pace for ${pacePct}%` : ''}`}
    >
      <path className="g-track" d={arcD(0, 1)} />
      {hasPace && pf > bf + 0.005 ? <path className="g-proj" d={arcD(bf, pf)} /> : null}
      {bf > 0.002 ? <path className="g-fill" d={arcD(0, bf)} /> : null}
      {tickLine(0.8)}
      {hasPace ? <circle className={cx('g-pace', paceTone)} cx={px.toFixed(2)} cy={py.toFixed(2)} r="5" /> : null}
      <text className="g-pct" x={CX} y={CY - 14}>{Math.round(pct)}%</text>
      <text className="g-sub" x={CX} y={CY + 4}>of {moneyTarget(budget.target)} used</text>
    </svg>
  );
}

const BUDGET_INFO_MONTH = 'Your spend target for the calendar month; it resets on the 1st. “On pace for” is a straight-line month-end projection from the spend so far. Amber from 80% of the target, red once it is reached. Counts the sources selected in the filter.';
const BUDGET_INFO_WEEK = 'Your spend target for the trailing 7 days — a rolling window with no hard reset, so there is no pace projection. Amber from 80% of the target, red once it is reached. Counts the sources selected in the filter.';

function BudgetPanel({ budget, filtered, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState('');
  const [period, setPeriod] = useState('month');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const { btn, form, track } = useReturnFocus(editing);

  function open() {
    setAmount(budget ? String(budget.target) : '');
    setPeriod(budget ? budget.period : 'month');
    setErr(null);
    setEditing(true);
  }
  function cancel() { track(); setEditing(false); setErr(null); }
  async function save(clear) {
    const amt = clear ? 0 : parseAmount(amount);
    if (!clear && !(amt > 0)) return;
    track();
    setBusy(true); setErr(null);
    try {
      await postJson('/api/budget/set?amount=' + (isFinite(amt) ? amt : 0) + '&period=' + period);
      try { await onSaved(); } catch (_) { /* the next poll brings it */ }
      setEditing(false);
      if (clear) setAmount('');
    } catch (e) {
      setErr(e && e.message ? e.message : 'Could not save');
    }
    setBusy(false);
  }

  const showForm = editing || !budget;
  const ctx = filtered ? 'selected sources' : null;
  const title = budget && !editing ? `Budget · ${budget.label}` : 'Budget';
  const actions = budget && !editing
    ? <Btn ref={btn} size="sm" variant="ghost" icon="edit" aria-label="Edit budget" onClick={open}>Edit</Btn>
    : null;

  if (showForm) {
    const valid = parseAmount(amount) > 0;
    return (
      <Panel title={title} info={period === 'week' ? BUDGET_INFO_WEEK : BUDGET_INFO_MONTH} ctx={ctx} className="lim-budget">
        <div
          className="lim-form"
          ref={form}
          onKeyDown={(e) => { if (e.key === 'Escape' && budget) { e.preventDefault(); cancel(); } }}
        >
          {!budget ? (
            <p className="hint">Set a spend target for the calendar month or a rolling 7 days. The gauge turns amber at 80% and red once it is reached.</p>
          ) : null}
          <div className="lf-row">
            <InputGroup
              prefix="$"
              className="lf-amt"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="1,200"
              aria-label="Budget amount in US dollars"
              value={amount}
              autoFocus={editing}
              readOnly={busy}
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(false); } }}
            />
            <Seg
              label="Budget period"
              value={period}
              onChange={setPeriod}
              options={[{ value: 'month', label: 'Month' }, { value: 'week', label: 'Week' }]}
            />
          </div>
          <div className="formacts">
            <Btn size="sm" variant="primary" disabled={busy || !valid} onClick={() => save(false)}>{busy ? 'Saving…' : 'Save'}</Btn>
            {budget ? <Btn size="sm" variant="ghost" disabled={busy} onClick={() => save(true)}>Clear</Btn> : null}
            {budget ? <Btn size="sm" variant="ghost" disabled={busy} onClick={cancel}>Cancel</Btn> : null}
            {err ? <span className="hint lf-err" role="alert">{err}</span> : null}
          </div>
        </div>
      </Panel>
    );
  }

  const over = budget.state === 'over' || budget.spent > budget.target;
  const hasPace = budget.projected != null && isFinite(budget.projected);
  const paceTone = !hasPace ? '' : budget.projected >= budget.target ? 'crit' : budget.projected >= budget.target * 0.8 ? 'warn' : '';
  const msLeft = budget.resetsAt ? budget.resetsAt - Date.now() : null;
  return (
    <Panel
      title={title}
      info={budget.period === 'week' ? BUDGET_INFO_WEEK : BUDGET_INFO_MONTH}
      ctx={ctx}
      actions={actions}
      className="lim-budget"
    >
      <div className="gauge">
        <BudgetGauge budget={budget} />
        <dl className="facts">
          <div><dt>Spent</dt><dd>{money(budget.spent)}</dd></div>
          {over
            ? <div><dt>Over by</dt><dd className="crit">{money(budget.spent - budget.target)}</dd></div>
            : <div><dt>Remaining</dt><dd>{money(budget.remaining)}</dd></div>}
          {hasPace ? <div><dt>On pace for</dt><dd className={paceTone}>~{money(budget.projected)}</dd></div> : null}
          <div>
            <dt>{msLeft != null ? 'Resets' : 'Window'}</dt>
            <dd>{msLeft != null ? (msLeft > 0 ? 'in ' + dur(msLeft) : 'now') : 'rolling 7 days'}</dd>
          </div>
        </dl>
      </div>
    </Panel>
  );
}

// ---- plan value ------------------------------------------------------------------
const PLAN_INFO = `Every tool ${BRAND} tracks — Claude Code, Codex, Gemini CLI, Continue, Cline, Roo — repriced at each provider’s API list prices over the last 30 days and divided by what you pay for the plan each month. Always all sources: the source filter narrows the dashboard, not what your subscription costs. Not a bill and not a counterfactual — your plan never covered the non-Claude tools, and sources that record only local estimates (Continue) or their own cost (Cline, Roo) are folded in as-is.`;

function monthTip(m, mult) {
  if (!m.partial) {
    return <><b>{monthLong(m.key)}</b><br />{money(m.spend)} of list-priced usage · {multFmt(mult)} the plan cost</>;
  }
  const el = typeof m.elapsedFraction === 'number' ? m.elapsedFraction : null;
  // Too little of the month elapsed for a straight-line pace to mean anything.
  const pace = el != null && el >= 0.05 ? <><br />on pace for ~{money(m.spend / el)}</> : null;
  return (
    <>
      <b>{monthLong(m.key)}</b> · month so far{el != null ? ` (${Math.round(el * 100)}% elapsed)` : ''}
      <br />{money(m.spend)} of list-priced usage · {multFmt(mult)} the plan cost so far{pace}
    </>
  );
}

function PlanMonths({ months, cost }) {
  const mults = months.map((m) => (m.multiplier != null && isFinite(m.multiplier) ? m.multiplier : cost > 0 ? m.spend / cost : 0));
  const top = Math.max(1.25, ...mults);
  const H = 76; // % of the plot the tallest bar may use; the rest holds its value label
  const be = (1 / top) * H;
  const many = months.length > 4;
  return (
    <div className="pmw">
      <div className="pm" role="group" aria-label="Monthly multiple of the plan cost against the 1× break-even line">
        <div className="pm-be" style={{ bottom: be.toFixed(1) + '%' }}><span>1×</span></div>
        {months.map((m, i) => (
          <Tip key={m.key} content={monthTip(m, mults[i])}>
            <span
              className="pm-col"
              tabIndex={0}
              aria-label={`${monthLong(m.key)}${m.partial ? ' so far' : ''}: ${multFmt(mults[i])} the plan cost, ${money(m.spend)}`}
            >
              {!many || m.partial || i === months.length - 1 ? <span className="pm-val">{multFmt(mults[i])}</span> : null}
              <span
                className={cx('pm-bar', m.partial && 'partial')}
                style={{ height: Math.max(1.5, (mults[i] / top) * H).toFixed(1) + '%' }}
              />
            </span>
          </Tip>
        ))}
      </div>
      <div className="pm-x" aria-hidden="true">
        {months.map((m) => <span key={m.key}>{monthShort(m.key)}{m.partial ? '*' : ''}</span>)}
      </div>
    </div>
  );
}

function PlanPanel({ plan, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const { btn, form, track } = useReturnFocus(editing);
  if (!plan) return null; // a server without the planValue block — stay silent

  function open() {
    setAmount(plan.cost ? String(plan.cost) : '');
    setLabel(plan.label || '');
    setErr(null);
    setEditing(true);
  }
  function cancel() { track(); setEditing(false); setErr(null); }
  async function save(clear) {
    const amt = clear ? 0 : parseAmount(amount);
    if (!clear && !(amt > 0)) return;
    track();
    setBusy(true); setErr(null);
    try {
      await postJson('/api/plan/set?amount=' + (isFinite(amt) ? amt : 0)
        + '&label=' + encodeURIComponent(clear ? '' : label.trim()));
      try { await onSaved(); } catch (_) { /* the next poll brings it */ }
      setEditing(false);
      if (clear) { setAmount(''); setLabel(''); }
    } catch (e) {
      setErr(e && e.message ? e.message : 'Could not save');
    }
    setBusy(false);
  }

  if (editing || !plan.configured) {
    const valid = parseAmount(amount) > 0;
    return (
      <Panel title="Plan value" info={PLAN_INFO} className="lim-plan">
        <div
          className="lim-form"
          ref={form}
          onKeyDown={(e) => { if (e.key === 'Escape' && plan.configured) { e.preventDefault(); cancel(); } }}
        >
          {!plan.configured ? (
            <p className="hint">
              {plan.spend30 > 0
                ? <>You ran <b>{money(plan.spend30)}</b> of list-priced usage across all tracked tools in the last 30 days. Enter what your plan costs to see it as a multiple.</>
                : <>Enter what your subscription costs each month to see your usage across all tracked tools as a multiple of it.</>}
            </p>
          ) : null}
          <div className="lf-row">
            <InputGroup
              prefix="$"
              suffix="/mo"
              className="lf-amt"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="200"
              aria-label="Plan cost per month in US dollars"
              value={amount}
              autoFocus={editing}
              readOnly={busy}
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(false); } }}
            />
            <Input
              className="lf-name"
              type="text"
              maxLength={40}
              autoComplete="off"
              placeholder="Plan name, e.g. Max 20x"
              aria-label="Plan name (optional)"
              value={label}
              readOnly={busy}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(false); } }}
            />
          </div>
          <div className="formacts">
            <Btn size="sm" variant="primary" disabled={busy || !valid} onClick={() => save(false)}>{busy ? 'Saving…' : 'Save'}</Btn>
            {plan.configured ? <Btn size="sm" variant="ghost" disabled={busy} onClick={() => save(true)}>Clear</Btn> : null}
            {plan.configured ? <Btn size="sm" variant="ghost" disabled={busy} onClick={cancel}>Cancel</Btn> : null}
            {err ? <span className="hint lf-err" role="alert">{err}</span> : null}
          </div>
        </div>
      </Panel>
    );
  }

  const under = plan.multiplier != null && plan.multiplier < 1;
  const months = Array.isArray(plan.months) ? plan.months.filter((m) => m && m.key) : [];
  return (
    <Panel
      title={'Plan value' + (plan.label ? ' · ' + plan.label : '')}
      info={PLAN_INFO}
      actions={<Btn ref={btn} size="sm" variant="ghost" icon="edit" aria-label="Edit plan cost" onClick={open}>Edit</Btn>}
      className="lim-plan"
      bodyClassName="lim-plan-b"
    >
      <div className={cx('plan', !months.length && 'solo', months.length > 4 && 'many')}>
        <div className="plan-l">
          <div className="plan-v">
            {multFmt(plan.multiplier)}
            <small>{under ? 'of your plan’s cost' : 'your plan’s cost'}</small>
          </div>
          <p className="hint plan-h">
            <b>{money(plan.spend30)}</b> of list-priced usage in 30 days against <b>{moneyTarget(plan.cost)}/mo</b>.
          </p>
        </div>
        {months.length ? <PlanMonths months={months} cost={plan.cost} /> : null}
      </div>
    </Panel>
  );
}

// ---- section ------------------------------------------------------------------------
export default function Limits({ id, data, thresholds, srcFilter }) {
  const [fresh, refresh] = useFreshAfterSave(data, srcFilter);
  const src = fresh || data;
  const th = thresholds && thresholds.length ? thresholds : [80, 95];
  const filtered = !!(srcFilter && srcFilter.length);
  async function recheck() {
    await postJson('/api/meters/recheck');
    try { await refresh(); } catch (_) { /* the next poll brings it */ }
  }
  return (
    <Section
      id={id}
      title="Limits & budget"
      meta={filtered ? 'meters and plan value are account-level · the budget follows the source filter' : 'account-level · not affected by the source filter'}
    >
      <AccountLimits
        className="c-8"
        meters={src.meters}
        codexMeters={src.codexMeters}
        codexUsage={src.codexUsage}
        thresholds={th}
        onRecheck={recheck}
      />
      <div className="c-4 lg-12 stack lim-side">
        <BudgetPanel budget={src.budget || null} filtered={filtered} onSaved={refresh} />
        <PlanPanel plan={src.planValue} onSaved={refresh} />
      </div>
    </Section>
  );
}
