// =============================================================================
// sections/Alerts.jsx — limit + spend-anomaly alert strip (top of the page).
// OWNER: the Alerts section engineer. Styles: ./Alerts.css, scoped .sec-alerts.
//
// PROPS (SectionProps, identical for every section — see CONTRACT.md):
//   id          'alerts' — render it on the root <Section id={id}> (no title:
//               this strip sits above the KPIs without a group label)
//   data        payload; reads data.alerts[] = { key, label, pct, threshold,
//               resetsAt, provider, kind?: 'anomaly', detail?, ratio? }
//   notify      { permission: 'default'|'granted'|'denied'|'unsupported', request() }
//               → show "Enable desktop alerts" while permission === 'default'
//   thresholds  number[] (e.g. [80, 95]) — "past your 80% alert"
//   (period, colorMap, srcFilter, gfx, theme, onStopped, onPeriod: unused here)
//
// RENDERS NOTHING when there are no alerts (App hides nothing else for you).
// Notifications themselves are fired by App (lib.fireAlertNotifications,
// dedup key 'pulse-alerted') — this section only displays.
//
// TARGET (mockup "alert strip"): one line — alert icon, "Approaching a limit" /
// "Unusual spend" / "Heads up", body "Claude · weekly · Fable is at 84% — past
// your 80% alert · resets in 2d 18h (Mon 01:54)" (lib: dur, formatReset), anomaly
// rows render `detail`; actions: [Enable desktop alerts] (notify.request) and a
// ghost "View limits" link to #limits. Multiple alerts: most urgent first
// (server order), the rest summarised.
//
// STUB: renders the legacy AlertsBar until replaced.
// =============================================================================
import { Section } from '../ui.jsx';
import { AlertsBar } from '../panels.jsx';
import './Alerts.css';

export default function Alerts({ id, data, notify }) {
  const alerts = data.alerts || [];
  if (!alerts.length) return null;
  return (
    <Section id={id}>
      <div className="legacy">
        <AlertsBar alerts={alerts} notifyState={notify.permission} onEnableNotify={notify.request} />
      </div>
    </Section>
  );
}
