// =============================================================================
// sections/Limits.jsx — "Limits & budget": account meters, Codex account
// tokens, budget gauge, plan value.
// OWNER: the Limits section engineer. Styles: ./Limits.css, scoped .sec-limits.
//
// PROPS (SectionProps — see CONTRACT.md):
//   id          'limits' — root <Section id={id} title="Limits & budget"
//               meta="account-level · not affected by the source filter">
//   data        payload; reads
//                 meters{enabled,status,buckets[]{key,label,pct,resetsAt,stale,projLeftAtReset},
//                        lastGoodAt,fetchedAt,error}  (status: ok|loading|no-login|expired|error|rate-limited)
//                 codexMeters{asOf,buckets[]} · codexUsage{enabled,status,stats{todayTokens,
//                        last7Tokens,last30Tokens,lifetimeTokens,peakDailyTokens,currentStreakDays,buckets[]},lastGoodAt,error}
//                 budget{target,period,label,spent,pct,remaining,resetsAt,state,projected}|null
//                 planValue{configured,cost,label,spend30,multiplier,months[]{key,spend,multiplier,partial,elapsedFraction}}
//   thresholds  alert thresholds → <MeterBar thresholds> ticks + lib.meterTone colours
//   onPeriod    optional: clicking a plan-value month may select that month period
//   (period, colorMap, srcFilter, notify, gfx, theme, onStopped: unused)
//
// ENDPOINTS (all via lib.postJson, which adds X-Pulse: 1):
//   POST /api/meters/recheck            → { meters } (Connect card "Recheck now")
//   POST /api/budget/set?amount&period  (amount ≤ 0 clears)
//   POST /api/plan/set?amount&label     (amount ≤ 0 clears both)
//
// TARGET (mockup row 2): c-8 "Account limits" panel = hairline grid of
// MeterCells (4 cols / 2 on phone): provider mark, name, big % used, → N% at
// reset (100 − projLeftAtReset), <MeterBar pct proj thresholds>, "resets in
// 3d 4h" (lib.dur) + formatReset; stale cells dimmed; Codex "snapshot"; then
// the Codex account-tokens row (6 stats + 30-bar spark, today in accent).
// Connect-Claude / loading / rate-limited / expired states as normal panel
// states (spec sheet). c-4 stack: Budget arc gauge with pace marker + facts
// (edit form: InputGroup "$" + Seg Month|Week + Save/Clear/Cancel) and Plan
// value (28 px multiple, month bars vs a labelled 1× line, hatched partial).
// Colour thresholds come from `thresholds`, never 60/85.
//
// STUB: legacy MetersCard + BudgetCard + PlanValueCard.
// =============================================================================
import { Section } from '../ui.jsx';
import { BudgetCard, PlanValueCard } from '../panels.jsx';
import { MetersCard } from '../meters.jsx';
import './Limits.css';

export default function Limits({ id, data }) {
  const meters = (
    <MetersCard meters={data.meters} codex={data.codexMeters} codexUsage={data.codexUsage} delay={0} />
  );
  return (
    <Section id={id} title="Limits & budget" meta="account-level · not affected by the source filter">
      <div className="legacy c-8">{meters}</div>
      <div className="legacy c-4 stack lim-stub">
        <BudgetCard budget={data.budget} />
        <PlanValueCard plan={data.planValue} />
      </div>
    </Section>
  );
}
