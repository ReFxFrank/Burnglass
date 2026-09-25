// =============================================================================
// sections/Kpis.jsx — the KPI strip ("Overview"): hero period spend + 4 tiles.
// OWNER: the Kpis section engineer. Styles: ./Kpis.css, scoped .sec-kpis.
//
// PROPS (SectionProps — built in App.jsx):
//   id          'kpis' — render on the root <Section id={id}> (no title/label;
//               the rail's "Overview" item points here)
//   data        payload; reads today{cost,tokens,messages}, week{…},
//               burnRate{dollarsPerHour,tokensPerMin,elapsedMin,windowCost}|null,
//               currentBlock{start,end,cost,tokens,messages,vsPeakCostPct,official}|null,
//               periods[] (the last30 average is the Today tile's baseline)
//   period      selected period: cost, tokens, messages, sessions, daily[]{date,total},
//               prev{cost,tokens,messages}, label, key  (may be undefined)
//   (colorMap, srcFilter, thresholds, notify, gfx, theme, onStopped, onPeriod: unused)
//
// LAYOUT (mockup row 1): grid "2.5fr + 4×1fr"; ≤1360 the hero takes its own
// row above 4 tiles; ≤760 2 columns with the hero spanning both.
// Only the 5-hour tile ticks (useTick(1000) lives inside it).
// =============================================================================
import { Section, Kpi, Spark, Delta, Badge } from '../ui.jsx';
import {
  money, tokens, num, pctChange, shortDate, localDateStr, hm, dur, MONTHS, useTick, useMedia, BP,
} from '../lib.js';
import './Kpis.css';

const HERO_INFO = 'API list-price estimate across every selected source. On a Pro/Max plan this expresses relative usage, not a bill.';
const BURN_INFO = 'Spend and tokens in the trailing 60 minutes, spread over the time since the first message in that hour (at least a minute) — so a burst that just started reads at its current pace. Window = what that hour actually cost; Span = the minutes it covers.';
const BLOCK_INFO_OFFICIAL = 'Window timing comes from Anthropic’s official account meter (the same reset as /usage) — the exact true reset, covering usage on every device. Cost shown is this machine’s Claude contribution within that window; Codex has separate limits. “vs heaviest” compares it with your most expensive past 5-hour block.';
const BLOCK_INFO_LOCAL = 'Claude usage only (Codex has separate limits). Reconstructed from this machine’s logs: the first message after a ≥5h gap opens a 5-hour window. Claude’s real window is opened by your first message on any surface — claude.ai, mobile, another computer — so the actual reset can be earlier than shown. Turn on account meters in the System section and this tile switches to the official timer automatically.';

// "the previous 30 days" / "Aug 2026" — what period.prev covers.
function prevLabel(period) {
  const m = /^last(\d+)$/.exec(period.key || '');
  if (m) return `the previous ${m[1]} days`;
  const k = /^(\d{4})-(\d{2})$/.exec(period.key || '');
  if (k) {
    const d = new Date(Number(k[1]), Number(k[2]) - 2, 1);
    return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }
  return 'the previous window';
}

// Days of the period that have happened (a calendar month carries its future days).
function pastDays(period) {
  const today = localDateStr();
  const days = (period && period.daily) || [];
  const past = days.filter((d) => d.date <= today);
  return past.length ? past : days;
}

export default function Kpis({ id, data, period }) {
  // the Today tile compares against the 30-day average, whatever period is selected
  const last30 = (data.periods || []).find((p) => p.key === 'last30');
  const base = last30 ? pastDays(last30) : [];
  const avg30 = last30 && base.length ? (last30.cost || 0) / base.length : null;
  return (
    <Section id={id}>
      <div className="kpis">
        {period ? <HeroTile period={period} /> : null}
        <DayTile today={data.today} avg={avg30} />
        <WeekTile week={data.week} />
        <BurnTile burn={data.burnRate} />
        <BlockTile cb={data.currentBlock} />
      </div>
    </Section>
  );
}

function HeroTile({ period }) {
  const lg = useMedia(BP.lg);
  const days = pastDays(period);
  const today = localDateStr();
  const values = days.map((d) => d.total || 0);
  const last = days[days.length - 1];
  const cap = days.length > 1 ? [shortDate(days[0].date), last.date === today ? 'Today' : shortDate(last.date)] : null;
  const prev = period.prev || {};
  const dCost = pctChange(period.cost, prev.cost);
  const dTok = pctChange(period.tokens, prev.tokens);
  const value = money(period.cost);
  return (
    <Kpi
      hero
      className={'kpis-hero' + (value.length > 9 ? ' long' : '')}
      label={`Spend · ${period.label}`}
      info={HERO_INFO}
      value={value}
    >
      <Spark className="spark" values={values} height={lg ? 52 : 40} cap={cap} label={`Daily spend, ${period.label}`} />
      <div className="kpi-s kpi-d">
        {dCost != null ? (
          <><Delta pct={dCost} title="Change in spend vs the previous equal-length window" /> vs <b>{money(prev.cost)}</b> in {prevLabel(period)}</>
        ) : (
          <>No spend recorded in {prevLabel(period)} to compare with</>
        )}
      </div>
      <div className="kpi-s kpi-facts">
        <span>
          <b>{tokens(period.tokens)}</b> tokens
          {dTok != null ? <span className="muted"> ({dTok > 0 ? '+' : dTok < 0 ? '−' : '±'}{Math.abs(dTok).toFixed(0)}%)</span> : null}
        </span>
        <span><b>{num(period.messages)}</b> msgs</span>
        <span><b>{num(period.sessions)}</b> sessions</span>
      </div>
    </Kpi>
  );
}

function DayTile({ today, avg }) {
  const t = today || { cost: 0, tokens: 0, messages: 0 };
  const d = avg > 0 ? pctChange(t.cost, avg) : null;
  return (
    <Kpi
      label="Today"
      value={money(t.cost)}
      sub={d != null
        ? <span title={`30-day daily average ${money(avg)}`}><Delta pct={d} digits={0} /> vs daily avg</span>
        : <span>since midnight</span>}
      facts={[['Tokens', tokens(t.tokens)], ['Messages', num(t.messages)]]}
    />
  );
}

function WeekTile({ week }) {
  const w = week || { cost: 0, tokens: 0, messages: 0 };
  return (
    <Kpi
      label="Last 7 days"
      value={money(w.cost)}
      sub={<>avg <b>{money(w.cost / 7)}</b> per day</>}
      facts={[['Tokens', tokens(w.tokens)], ['Messages', num(w.messages)]]}
    />
  );
}

function BurnTile({ burn }) {
  if (!burn) {
    return (
      <Kpi
        label="Burn rate · 60 min"
        info={BURN_INFO}
        value={<span className="kpis-none">—</span>}
        sub="No activity in the last hour."
      />
    );
  }
  return (
    <Kpi
      label="Burn rate · 60 min"
      info={BURN_INFO}
      value={money(burn.dollarsPerHour)}
      unit="/hr"
      sub={<><b>{tokens(burn.tokensPerMin)}</b> tokens / min</>}
      facts={[
        ['Window', money(burn.windowCost != null ? burn.windowCost : (burn.dollarsPerHour * burn.elapsedMin) / 60)],
        ['Span', `${Math.max(1, Math.round(burn.elapsedMin || 0))} min`],
      ]}
    />
  );
}

function BlockTile({ cb }) {
  useTick(1000); // the countdown is the only thing on the strip that ticks
  if (!cb) {
    return (
      <Kpi
        className="kpis-block"
        label="5-hour block"
        info={BLOCK_INFO_LOCAL}
        value={<span className="kpis-none">Idle</span>}
      >
        <div className="kbar" role="img" aria-label="No active 5-hour window"><i style={{ width: 0 }} /></div>
        <div className="kpi-s">No active window — your next Claude request starts one.</div>
      </Kpi>
    );
  }
  const now = Date.now();
  const span = cb.end - cb.start;
  const elapsed = span > 0 ? Math.max(0, Math.min(1, (now - cb.start) / span)) : 0;
  const left = cb.end - now;
  const badge = cb.official
    ? <Badge tone="good" icon="check" title="Synced to Anthropic’s 5-hour reset"><span className="kpis-bl">Official</span></Badge>
    : <Badge icon="clock" title="Reconstructed from this machine’s logs"><span className="kpis-bl">Estimated</span></Badge>;
  return (
    <Kpi
      className="kpis-block"
      label="5-hour block"
      info={cb.official ? BLOCK_INFO_OFFICIAL : BLOCK_INFO_LOCAL}
      badge={badge}
      value={money(cb.cost)}
    >
      <div className="kbar" role="img" aria-label={`${Math.round(elapsed * 100)}% of the window elapsed`}>
        <i style={{ width: (elapsed * 100).toFixed(1) + '%' }} />
      </div>
      <dl className="kfacts">
        <div><dt>Resets in</dt><dd>{left > 0 ? dur(left) : 'now'}</dd></div>
        <div><dt>Window</dt><dd>{hm(cb.start)}–{hm(cb.end)}</dd></div>
        {cb.vsPeakCostPct != null && isFinite(cb.vsPeakCostPct) ? (
          <div><dt>vs heaviest</dt><dd>{Math.round(cb.vsPeakCostPct)}%</dd></div>
        ) : null}
      </dl>
    </Kpi>
  );
}
