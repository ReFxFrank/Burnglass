// =============================================================================
// sections/Breakdown.jsx — "Breakdown": by model, by effort, by project.
// OWNER: the Breakdown section engineer. Styles: ./Breakdown.css, scoped .sec-breakdown.
//
// PROPS (SectionProps — built in App.jsx):
//   id          'breakdown' — root <Section id={id} title="Breakdown" meta={period.label}>
//   data        payload; reads modesLogged (tooltip wording)
//   period      byModel{model:{cost,tokens,messages,speeds{fast?,standard?},tiers,
//               efforts{level:msgs},ultracode}}, effortSpend{level:{cost,tokens,messages}}
//               (levels low…max, ultracode, default), byProject[]{project,cost,tokens,
//               messages,sessions} (top 30 + "(other)"/"(unknown)"), cost, label,
//               liveCost (may be undefined → render nothing)
//   (colorMap, srcFilter, thresholds, notify, gfx, theme, onStopped, onPeriod: unused)
//
// LAYOUT: ≥1361 By model c-8 + By effort c-4, By project c-12 (wide: tokens + msgs
// columns). ≤1360 By model full width, then By effort (5) + By project (7).
// ≤1024 effort + project pair up 6/6 until the phone breakpoint (760), where
// everything is full width and By model collapses to 3-line cards.
//
// DATA NOTES
// - byModel cost/tokens/messages merge live logs AND the archive; speeds,
//   efforts and ultracode are LIVE-only. The effort mix therefore uses the live
//   message count (Σ speeds) as its denominator, so archived messages never
//   masquerade as "Default".
// - effortSpend and byProject are LIVE-only: shares are of their own totals,
//   and a coverage note appears when the live logs hold < 99% of period.cost.
// - The fast-mode premium lives in the Spend section's econ strip; here a
//   model row only carries its fast-message count.
// - "By source" (SourceTable) is the Spend section's c-4 panel.
// =============================================================================
import { Section, Panel, MBar, EffortLabel, FastChip, Tip, Empty, useClamp, cx } from '../ui.jsx';
import { ModelLogo } from '../logos.jsx';
import {
  money, tokens, num, prettyModel, projectBase, effortLabel,
  EFFORT_LEVELS, EFFORT_RAMP, useMedia, BP,
} from '../lib.js';
import './Breakdown.css';

// Effort buckets in display order. Unknown recorded levels (a future level the
// UI has no name for) slot in before ultracode so they are never dropped.
const EFFORT_ORDER = [...EFFORT_LEVELS, 'ultracode', 'default'];
const HIGH_OR_ABOVE = new Set(['high', 'xhigh', 'max', 'ultracode']);
const effortColor = (k) => EFFORT_RAMP[k] || EFFORT_RAMP.default;

// Share of a total as text: 39.7% · 0.31% (two decimals under 1%) · 0%.
function shareText(v, total) {
  if (!(total > 0) || !(v > 0)) return '0%';
  const f = (v / total) * 100;
  return f.toFixed(f < 1 ? 2 : 1) + '%';
}
const sum = (arr, f) => arr.reduce((a, x) => a + (f ? f(x) : x), 0);

// "covers $X of this period's $Y" — for LIVE-only breakdowns on long windows.
function coverage(period) {
  const cost = period.cost || 0;
  const live = period.liveCost;
  if (typeof live !== 'number' || cost <= 0 || live >= cost * 0.99) return null;
  return (
    <div className="hint bd-cov">
      Covers <b>{money(live)}</b> of this period’s {money(cost)} still in your logs. Archived days keep
      day and model totals only.
    </div>
  );
}

// Ordered effort parts for one model row: recorded levels, ultracode (hatched),
// and the live messages with no recorded level ("Default").
function mixParts(r) {
  const eff = r.efforts || {};
  const parts = [];
  for (const k of EFFORT_LEVELS) if (eff[k] > 0) parts.push({ key: k, n: eff[k] });
  for (const k of Object.keys(eff)) {
    if (!EFFORT_LEVELS.includes(k) && eff[k] > 0) parts.push({ key: k, n: eff[k] });
  }
  if (r.ultracode > 0) parts.push({ key: 'ultracode', n: r.ultracode });
  const live = sum(Object.values(r.speeds || {}));
  const rec = sum(parts, (p) => p.n);
  if (live - rec > 0) parts.push({ key: 'default', n: live - rec });
  return parts;
}

// Tooltip body shared by the model effort-mix bars and the by-effort share bar.
function MixTip({ title, parts }) {
  const total = sum(parts, (p) => p.n);
  return (
    <div className="bd-tip">
      {title ? <div className="bd-tip-h">{title}</div> : null}
      {parts.map((p) => (
        <div className="bd-tip-r" key={p.key}>
          <i className={cx('bd-tip-k', p.key === 'ultracode' && 'hatch')} style={{ backgroundColor: effortColor(p.key) }} />
          <span className="bd-tip-l">{effortLabel(p.key)}</span>
          <span className="bd-tip-n">{num(p.n)} msgs</span>
          <span className="bd-tip-p">{shareText(p.n, total)}</span>
        </div>
      ))}
    </div>
  );
}
const mixAria = (lead, parts) => {
  const total = sum(parts, (p) => p.n);
  return lead + ': ' + parts.map((p) => `${effortLabel(p.key)} ${shareText(p.n, total)}`).join(', ');
};

// Stacked 100% bar of effort parts. Focusable so keyboard users reach the tip.
function MixBar({ parts, title, className }) {
  if (!parts.length) return <span className="muted" title="No per-message detail (archived days only)">—</span>;
  return (
    <Tip content={<MixTip title={title} parts={parts} />}>
      <span className={cx('mix', className)} tabIndex={0} role="img" aria-label={mixAria(title || 'Effort mix', parts)}>
        {parts.map((p) => (
          <i
            key={p.key}
            className={p.key === 'ultracode' ? 'hatch' : undefined}
            style={{ flex: `${p.n} 1 0`, backgroundColor: effortColor(p.key) }}
          />
        ))}
      </span>
    </Tip>
  );
}

// ---- By model -----------------------------------------------------------------
function ModelTable({ period }) {
  const phone = useMedia(BP.sm);
  const byModel = period.byModel || {};
  const rows = Object.keys(byModel)
    .map((m) => ({ model: m, ...byModel[m] }))
    .sort((a, b) => b.cost - a.cost || b.messages - a.messages);
  const total = sum(rows, (r) => r.cost) || period.cost || 0;
  const max = rows.length ? Math.max(...rows.map((r) => r.cost)) : 0;
  const [shown, toggle] = useClamp(rows, phone ? 5 : 8, 'models');
  const hasMinimal = rows.some((r) => r.efforts && r.efforts.minimal > 0);
  // the legend only earns its place when some row carries a recorded level
  const anyEffort = rows.some((r) => r.ultracode > 0 || Object.values(r.efforts || {}).some((n) => n > 0));

  if (!rows.length) return <Empty title="No model usage in this window" />;
  return (
    <>
      <div className="tbl tbl-model" role="table" aria-label="Spend by model">
        <div className="tr th" role="row">
          <span role="columnheader">Model</span>
          <span role="columnheader">Spend</span>
          <span role="columnheader" className="r">Share</span>
          <span role="columnheader" className="r">Tokens</span>
          <span role="columnheader" className="r">Msgs</span>
          <span role="columnheader">Effort mix</span>
          <span role="columnheader" className="r">Fast</span>
        </div>
        {shown.map((r) => {
          const name = prettyModel(r.model) || r.model;
          const parts = mixParts(r);
          const fast = (r.speeds && r.speeds.fast) || 0;
          return (
            <div className="tr" role="row" key={r.model}>
              <span className="cell-name c-n" role="cell" title={r.model}>
                <ModelLogo model={r.model} size={14} title="" />
                <span className="two">
                  <span className="t">{name}</span>
                  {name !== r.model ? <span className="sub">{r.model}</span> : null}
                </span>
              </span>
              <span className="barcell c-b" role="cell">
                <MBar value={r.cost} max={max} />
                <span className="v">{money(r.cost)}</span>
              </span>
              <span className="r muted c-share" role="cell">{shareText(r.cost, total)}</span>
              <span className="r muted c-tok" role="cell">{tokens(r.tokens)}</span>
              <span className="r muted c-msg" role="cell">{num(r.messages)}</span>
              <span className="c-mix" role="cell"><MixBar parts={parts} title={name + ' · effort mix'} /></span>
              <span className="r c-mode" role="cell">
                {fast > 0 ? <FastChip count={fast} /> : <span className="muted" aria-label="No fast-mode messages">—</span>}
              </span>
              {/* phone card (≤760): value top-right + one meta line; hidden on desktop */}
              <span className="r c-v" role="cell">{money(r.cost)}</span>
              <span className="c-meta" role="cell">
                <span className="tn">{tokens(r.tokens)} tok</span>
                <span className="tn">{num(r.messages)} msgs</span>
                {parts.length ? <span className="c-meta-mix"><MixBar parts={parts} title={name + ' · effort mix'} /></span> : null}
                {fast > 0 ? <FastChip count={fast} /> : null}
              </span>
            </div>
          );
        })}
      </div>
      {toggle}
      {anyEffort ? <div className="eff-key" aria-hidden="true">
        {(hasMinimal ? EFFORT_LEVELS : EFFORT_LEVELS.filter((k) => k !== 'minimal')).map((k) => (
          <span key={k}><i style={{ backgroundColor: effortColor(k) }} />{effortLabel(k)}</span>
        ))}
        <span><i className="hatch" style={{ backgroundColor: effortColor('ultracode') }} />Ultracode</span>
        <span><i style={{ backgroundColor: effortColor('default') }} />Default</span>
      </div> : null}
    </>
  );
}

// ---- By effort ----------------------------------------------------------------
function EffortPanelBody({ period }) {
  const spend = period.effortSpend || {};
  const keys = [
    ...EFFORT_ORDER.filter((k) => k !== 'ultracode' && k !== 'default'),
    ...Object.keys(spend).filter((k) => !EFFORT_ORDER.includes(k)),
    'ultracode', 'default',
  ].filter((k) => spend[k] && (spend[k].messages > 0 || spend[k].cost > 0));
  if (!keys.some((k) => k !== 'default')) {
    return (
      <div className="hint bd-none">
        No effort recorded in this window — set a level with <code>/effort</code> and it appears here.
      </div>
    );
  }
  const msgs = sum(keys, (k) => spend[k].messages || 0);
  const costTot = sum(keys, (k) => spend[k].cost || 0);
  const max = Math.max(...keys.map((k) => spend[k].cost || 0));
  const hi = sum(keys.filter((k) => HIGH_OR_ABOVE.has(k)), (k) => spend[k].cost || 0);
  const parts = keys.filter((k) => spend[k].messages > 0).map((k) => ({ key: k, n: spend[k].messages }));
  return (
    <>
      <div className="sublab">Share of messages<span className="tn">{num(msgs)} msgs</span></div>
      <MixBar parts={parts} title="Share of messages" className="bd-effshare" />
      <div className="tbl tbl-eff" role="table" aria-label="Spend by effort level">
        <div className="tr th" role="row">
          <span role="columnheader">Level</span>
          <span role="columnheader">Spend</span>
          <span role="columnheader" className="r">Msgs</span>
        </div>
        {keys.map((k) => {
          const r = spend[k];
          return (
            <div className="tr" role="row" key={k}>
              <span role="cell"><EffortLabel level={k} /></span>
              <span className="barcell" role="cell">
                <MBar value={r.cost} max={max} color={effortColor(k)} hatch={k === 'ultracode'} />
                <span className="v">{money(r.cost)}</span>
              </span>
              <span className="r muted" role="cell" title={`${tokens(r.tokens)} tokens`}>{num(r.messages)}</span>
            </div>
          );
        })}
      </div>
      <div className="hint bd-hi">
        Share of spend at <b>High or above</b>: <span className="tn">{costTot > 0 ? Math.round((hi / costTot) * 100) : 0}%</span>
      </div>
      {coverage(period)}
    </>
  );
}

// ---- By project -----------------------------------------------------------------
function ProjectTable({ period }) {
  const phone = useMedia(BP.sm);
  const rows = (period.byProject || []).slice().sort((a, b) => b.cost - a.cost);
  const total = sum(rows, (r) => r.cost);
  const max = rows.length ? Math.max(...rows.map((r) => r.cost)) : 0;
  const [shown, toggle] = useClamp(rows, phone ? 6 : 8, 'projects');
  if (!rows.length) return <Empty title="No project activity in this window" />;
  return (
    <>
      <div className="bd-cq">
        <div className="tbl tbl-proj" role="table" aria-label="Spend by project">
          <div className="tr th" role="row">
            <span role="columnheader">Project</span>
            <span role="columnheader">Spend</span>
            <span role="columnheader" className="r">Share</span>
            <span role="columnheader" className="r c-tok">Tokens</span>
            <span role="columnheader" className="r c-msg">Msgs</span>
            <span role="columnheader" className="r c-ses" title="Sessions">Sess</span>
          </div>
          {shown.map((r) => {
            const special = String(r.project).startsWith('(');
            return (
              <div className="tr" role="row" key={r.project}>
                <span className="cell-name" role="cell">
                  <Tip
                    className="bd-tip"
                    content={(
                      <>
                        <div className="bd-tip-path">{special ? (r.project === '(other)' ? 'Every project outside the top 30' : 'Sources that record no working directory') : r.project}</div>
                        <div className="muted">{money(r.cost)} · {tokens(r.tokens)} tokens · {num(r.messages)} msgs · {num(r.sessions)} sessions</div>
                      </>
                    )}
                  >
                    <span className={cx('t', special && 'italic')} tabIndex={0}>{projectBase(r.project)}</span>
                  </Tip>
                </span>
                <span className="barcell" role="cell">
                  <MBar value={r.cost} max={max} />
                  <span className="v">{money(r.cost)}</span>
                </span>
                <span className="r muted" role="cell">{shareText(r.cost, total)}</span>
                <span className="r muted c-tok" role="cell">{tokens(r.tokens)}</span>
                <span className="r muted c-msg" role="cell">{num(r.messages)}</span>
                <span className="r muted c-ses" role="cell">{num(r.sessions)}</span>
              </div>
            );
          })}
        </div>
      </div>
      {toggle}
      {coverage(period)}
    </>
  );
}

export default function Breakdown({ id, data, period }) {
  if (!period) return null;
  const nModels = Object.keys(period.byModel || {}).length;
  const nProj = (period.byProject || []).length;
  const effortSource = data.modesLogged
    ? 'Claude Code ≥ 2.1.212 records the level on each message; older sessions come from /effort commands in the transcripts and from the optional hook.'
    : `Claude Code ≥ 2.1.212 records the level on each message; older sessions come from /effort commands in the transcripts, or run --effort-setup for the optional hook. Ultracode is detected from prompt text.`;
  return (
    <Section id={id} title="Breakdown" meta={period.label}>
      <Panel
        span={8}
        title="By model"
        ctx={`${period.label} · ${nModels} ${nModels === 1 ? 'model' : 'models'}`}
        info={`Bar = spend. Effort mix = share of messages at each effort level actually sent (hatched = ultracode, grey = none recorded). ${effortSource} Fast = messages run in fast mode. Effort and speed come from the live logs; archived days keep day and model totals only.`}
      >
        <ModelTable period={period} />
      </Panel>
      <Panel
        span={4}
        className="lg-5 md-6"
        title="By effort"
        ctx={period.label}
        info="Spend grouped by the reasoning-effort level recorded on each message (low → max, ultracode, or default when none was set). Covers sessions still in your logs — the long-window archive keeps day/model totals, not per-message effort."
      >
        <EffortPanelBody period={period} />
      </Panel>
      <Panel
        span={12}
        className="lg-7 md-6"
        title="By project"
        ctx={`${period.label} · ${nProj} ${nProj === 1 ? 'project' : 'projects'}`}
        info="Folder the session ran in (working directory); hover or tap a name for the full path. Top 30 by cost; the rest fold into “(other)”, and “(unknown)” = sources that record no working directory. Covers sessions still in your logs."
      >
        <ProjectTable period={period} />
      </Panel>
    </Section>
  );
}
