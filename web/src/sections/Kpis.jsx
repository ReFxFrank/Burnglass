// =============================================================================
// sections/Kpis.jsx — the KPI strip ("Overview"): hero period spend + 4 tiles.
// OWNER: the Kpis section engineer. Styles: ./Kpis.css, scoped .sec-kpis.
//
// PROPS (SectionProps — see CONTRACT.md):
//   id          'kpis' — render on the root <Section id={id}> (no title/label;
//               the rail's "Overview" item points here)
//   data        payload; reads today{cost,tokens,messages}, week{…},
//               burnRate{dollarsPerHour,tokensPerMin,elapsedMin,windowCost}|null,
//               currentBlock{start,end,cost,tokens,messages,vsPeakCostPct,official}|null
//   period      selected period: cost, tokens, messages, sessions, daily[]{date,total},
//               prev{cost,tokens,messages}, label, key  (may be undefined)
//   (colorMap, srcFilter, thresholds, notify, gfx, theme, onStopped, onPeriod: unused)
//
// TARGET (mockup row 1): grid "2.5fr + 4×1fr" (→ 4 cols ≤1360, 2 cols ≤760):
//   hero  <Kpi hero label="Spend · Last 30 days" info=…> 36 px money(period.cost),
//         <Spark values={daily totals} cap={[first date, 'Today']}>, <Delta> vs
//         prev ("vs $710.73 in the previous 30 days"), facts row tokens (+Δ%) · msgs · sessions
//   Today (Δ vs daily avg) · Last 7 days (avg/day) · Burn rate · 60 min (window $, span)
//   5-hour block (Official badge when currentBlock.official, .kbar elapsed bar,
//   facts Resets in / Window hh:mm–hh:mm / vs heaviest). Idle block + no-burn states.
//   Countdowns tick with lib.useTick(1000) — keep that inside the tile that needs it.
//
// STUB: legacy tiles (CurrentBlock, BurnRate, Rollup ×2). The period hero is
// still the summary line at the top of the Spend stub.
// =============================================================================
import { Section } from '../ui.jsx';
import { CurrentBlock, BurnRate, Rollup } from '../panels.jsx';
import './Kpis.css';

export default function Kpis({ id, data }) {
  return (
    <Section id={id}>
      <div className="legacy">
        <div className="grid stats">
          <CurrentBlock cb={data.currentBlock} delay={0} />
          <BurnRate burn={data.burnRate} delay={0} />
          <Rollup label="Today" r={data.today} delay={0} />
          <Rollup label="Last 7 days" r={data.week} delay={0} />
        </div>
      </div>
    </Section>
  );
}
