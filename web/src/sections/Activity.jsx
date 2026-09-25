// =============================================================================
// sections/Activity.jsx — "Activity": when-you-work heatmap + recent sessions.
// OWNER: the Activity section engineer. Styles: ./Activity.css, scoped .sec-activity.
//
// PROPS (SectionProps — see CONTRACT.md):
//   id          'activity' — root <Section id={id} title="Activity">
//   data        payload; reads heatmap{grid[7][24]{cost,tokens,messages},maxCost,maxMessages}
//               (LIVE logs only; Sun-first rows; hide the panel when maxCost ≤ 0),
//               recentSessions[≤20]{sessionId,title,source,models[],speeds[],efforts[],
//               ultracode,cost,tokens,messages,lastTs} — NOT period-scoped,
//               sourceMeta, estimatedSources
//   period      only for the sessions CSV link's `period` param (may be undefined)
//   colorMap    source swatches in the sessions table
//   srcFilter   carried by the sessions CSV link (lib.exportHref)
//   (thresholds, notify, gfx, theme, onStopped, onPeriod: unused)
//
// TARGET (mockup "When you work" + "Recent sessions"): heatmap with marginal
// hour totals (top bars) and weekday totals (right column), 7-step --q1…--q7
// ramp (not alpha), Spend | Messages <Seg> (heatmap.maxMessages), legend,
// "Busiest: Tue 2p–3p · $ · msgs" caption, <Tip> per cell (tap on touch).
// Sessions: single-line grid rows (project tag, prompt, short id, source
// swatch + srcLabel + est, <ModelLogo> prettyModel +N, <EffortLabel>/<FastChip>,
// $, tokens, msgs, ago), 2-line card < 760 px, useClamp 12 (6 on phone),
// header "CSV" button = exportHref({format:'csv',data:'sessions'}, period.key, srcFilter).
// Title format from the server: "project · first prompt… · 8-hex id".
//
// STUB: legacy Heatmap + SessionsTable.
// =============================================================================
import { Section, Panel, Btn } from '../ui.jsx';
import { Heatmap, SessionsTable } from '../panels.jsx';
import { exportHref } from '../lib.js';
import './Activity.css';

export default function Activity({ id, data, period, srcFilter }) {
  const hm = data.heatmap;
  return (
    <Section id={id} title="Activity">
      {hm && hm.maxCost > 0 && (
        <Panel
          span={12}
          title="When you work"
          ctx="live logs · local time"
          info="Spend by local day-of-week and hour, across all sessions in your logs. Darker = more spend in that hour. Hover a cell for the details."
        >
          <div className="legacy"><Heatmap heatmap={hm} /></div>
        </Panel>
      )}
      <Panel
        span={12}
        title="Recent sessions"
        ctx={`latest ${(data.recentSessions || []).length} across all periods`}
        actions={(
          <Btn size="sm" icon="download" href={exportHref({ format: 'csv', data: 'sessions' }, period && period.key, srcFilter)} download="">
            CSV
          </Btn>
        )}
      >
        <div className="legacy"><SessionsTable sessions={data.recentSessions} meta={data.sourceMeta} /></div>
      </Panel>
    </Section>
  );
}
