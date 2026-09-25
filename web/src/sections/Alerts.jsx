// =============================================================================
// sections/Alerts.jsx — limit + spend-anomaly alert strip (top of the page).
// OWNER: the Alerts section engineer. Styles: ./Alerts.css, scoped .sec-alerts.
//
// PROPS (SectionProps, identical for every section — built in App.jsx):
//   id          'alerts' — root <Section id={id}> (no group label: the strip
//               sits above the KPIs)
//   data        payload; reads data.alerts[] = { key, label, pct, threshold,
//               resetsAt, provider, kind?: 'anomaly', detail?, ratio?,
//               todayCost?, baseline? }
//   notify      { permission, request() } → "Enable desktop alerts" while
//               permission === 'default'
//   thresholds  number[] (ascending) — an alert past the TOP threshold turns
//               the strip red, like the meter it came from
//   (period, colorMap, srcFilter, gfx, theme, onStopped, onPeriod: unused here)
//
// Renders nothing when there are no alerts. Desktop notifications are fired by
// App (lib.fireAlertNotifications, dedup key 'pulse-alerted') — this section
// only displays. Server order is most-urgent-first (a spend anomaly first);
// the first alert gets the sentence, the rest a "+N more" tooltip.
// =============================================================================
import { Section, Btn, Tip, cx } from '../ui.jsx';
import { Icon } from '../icons.jsx';
import { dur, formatReset, money, useTick } from '../lib.js';
import './Alerts.css';

const HOUR = 3600e3;
const isAnomaly = (a) => a && a.kind === 'anomaly';
const num = (v) => typeof v === 'number' && isFinite(v);

// "resets in 2d 18h (Mon 01:54)" — ticks every 30 s, every second in the last hour.
function ResetIn({ ts }) {
  const left = ts - Date.now();
  useTick(left > 0 && left < HOUR ? 1000 : 30000);
  if (!num(ts)) return null;
  if (left <= 0) return <> · resetting now</>;
  return <> · resets in {dur(left)} ({formatReset(ts)})</>;
}

// Anomaly sentence: built from the numeric fields when the server sends them
// (money() formatting), else its preformatted `detail`.
function AnomalyText({ a }) {
  if (num(a.todayCost) && num(a.ratio) && num(a.baseline)) {
    return (
      <>Today <b className="tn">{money(a.todayCost)}</b> is <b className="tn">{a.ratio.toFixed(1)}×</b> your recent daily average{' '}
        <span className="muted">({money(a.baseline)})</span></>
    );
  }
  const d = String(a.detail || a.label || '');
  return <>{d.charAt(0).toUpperCase() + d.slice(1)}</>;
}

function LimitText({ a }) {
  return (
    <>
      {a.label} is at <b className="tn">{Math.round(a.pct)}%</b>{' '}
      <span className="muted">— past your {a.threshold}% alert{num(a.resetsAt) ? <ResetIn ts={a.resetsAt} /> : null}</span>
    </>
  );
}

function moreLine(a) {
  if (isAnomaly(a)) return a.detail || a.label;
  return `${a.label} · ${Math.round(a.pct)}% (past ${a.threshold}%)`;
}

export default function Alerts({ id, data, notify, thresholds }) {
  const alerts = (data.alerts || []).filter(Boolean);
  if (!alerts.length) return null;

  const hasAnomaly = alerts.some(isAnomaly);
  const anomalyOnly = hasAnomaly && alerts.every(isAnomaly);
  const title = anomalyOnly ? 'Unusual spend' : hasAnomaly ? 'Heads up' : 'Approaching a limit';
  const top = thresholds && thresholds.length > 1 ? thresholds[thresholds.length - 1] : null;
  const crit = top != null && alerts.some((a) => !isAnomaly(a) && (a.threshold >= top || a.pct >= top));
  const first = alerts[0];
  const rest = alerts.slice(1);
  const canNotify = notify && notify.permission === 'default';

  return (
    <Section id={id}>
      <div className={cx('alert', crit && 'crit')} role="status">
        <Icon name="alert" />
        <span className="a-t">{title}</span>
        <span className="a-body">
          {isAnomaly(first) ? <AnomalyText a={first} /> : <LimitText a={first} />}
          {rest.length ? (
            <>
              {' '}
              <Tip
                content={<ul className="alerts-more-list">{rest.map((a) => <li key={a.key}>{moreLine(a)}</li>)}</ul>}
                side="bottom"
              >
                <button type="button" className="a-more" aria-label={`${rest.length} more alert${rest.length === 1 ? '' : 's'}: ${rest.map(moreLine).join('; ')}`}>
                  +{rest.length} more
                </button>
              </Tip>
            </>
          ) : null}
        </span>
        <div className="a-act">
          {canNotify ? <Btn size="sm" onClick={notify.request}>Enable desktop alerts</Btn> : null}
          {anomalyOnly
            ? <Btn size="sm" variant="ghost" href="#spend">View spend</Btn>
            : <Btn size="sm" variant="ghost" href="#limits">View limits</Btn>}
        </div>
      </div>
    </Section>
  );
}
