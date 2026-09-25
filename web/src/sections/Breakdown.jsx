// =============================================================================
// sections/Breakdown.jsx — "Breakdown": by model, by effort, by project.
// OWNER: the Breakdown section engineer. Styles: ./Breakdown.css, scoped .sec-breakdown.
//
// PROPS (SectionProps — see CONTRACT.md):
//   id          'breakdown' — root <Section id={id} title="Breakdown" meta={period.label}>
//   data        payload; reads modesLogged (tooltip wording), allModels
//   period      byModel{model:{cost,tokens,messages,speeds{fast?,standard?},tiers,
//               efforts{level:msgs},ultracode}}, effortSpend{level:{cost,tokens,messages}}
//               (levels low…max, ultracode, default), byProject[]{project,cost,tokens,
//               messages,sessions} (top 30 + "(other)"/"(unknown)"), speedSpend, cost,
//               messages, label, liveCost (may be undefined → render nothing)
//   (colorMap, srcFilter, thresholds, notify, gfx, theme, onStopped, onPeriod: unused)
//
// TARGET (mockup "Breakdown" group; the mockup also put the heatmap here — it
// now belongs to Activity): By model table (<ModelLogo>, lib.prettyModel over
// the raw id as mono sub-line, <MBar> spend bar (neutral --bar, NOT source
// colours), share, tokens, msgs, stacked effort-mix bar (EFFORT_RAMP, ultracode
// hatched, default grey), <FastChip count>; useClamp at 8; 3-line card < 760 px);
// By effort (message-share bar, <EffortLabel> rows with <MBar color=EFFORT_RAMP[k]>,
// "share of spend at High or above"); By project (lib.projectBase name, full
// path in title, italic (other)/(unknown), clamp 8, sessions column). Suggested
// spans: model c-8 + effort c-4, project c-12 (or c-7/c-5 pairs) — your call.
//
// STUB: legacy BarList / FastSpendNote / EffortSpendBars / ProjectBars in panels.
// =============================================================================
import { Section, Panel } from '../ui.jsx';
import { BarList, FastSpendNote, EffortSpendBars, ProjectBars } from '../panels.jsx';
import './Breakdown.css';

export default function Breakdown({ id, data, period }) {
  if (!period) return null;
  const modelRows = Object.keys(period.byModel || {})
    .sort((a, b) => period.byModel[b].cost - period.byModel[a].cost)
    .map((m) => ({ name: m, ...period.byModel[m], color: 'var(--bar)' }));
  return (
    <Section id={id} title="Breakdown" meta={period.label}>
      <Panel
        span={8}
        title="By model"
        ctx={period.label}
        info={data.modesLogged
          ? 'Chips show the reasoning effort (low → max, plus ultracode): Claude Code ≥ 2.1.212 records the level on each message; older sessions come from /effort commands in the transcripts and from the optional hook. Plus execution speed when fast mode was used.'
          : 'Effort chips appear from the level Claude Code ≥ 2.1.212 records on each message, from /effort commands in older transcripts, or via the optional hook (--effort-setup). Ultracode is also detected from prompt text.'}
      >
        <div className="legacy">
          <BarList rows={modelRows} modelLogos />
          <FastSpendNote speed={period.speedSpend} period={period} />
        </div>
      </Panel>
      <Panel
        span={4}
        title="By effort"
        ctx={period.label}
        info="Spend grouped by the reasoning-effort level in force (low → max, ultracode, or default when none was set). Covers sessions still in your logs — the long-window archive keeps day/model totals, not per-entry effort."
      >
        <div className="legacy"><EffortSpendBars spend={period.effortSpend} /></div>
      </Panel>
      <Panel
        span={12}
        title="By project"
        ctx={period.label}
        info="Spend grouped by working directory (project). Folder name shown; hover for the full path. Top 30 by cost; the rest fold into “(other)”. Covers sessions still in your logs."
      >
        <div className="legacy"><ProjectBars rows={period.byProject} /></div>
      </Panel>
    </Section>
  );
}
