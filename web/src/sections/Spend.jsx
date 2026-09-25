// =============================================================================
// sections/Spend.jsx — "Spend": daily stacked chart by source + economics
// strip, and the By-source table.
// OWNER: the Spend section engineer. Styles: ./Spend.css, scoped .sec-spend.
//
// PROPS (SectionProps — see CONTRACT.md):
//   id          'spend' — root <Section id={id} title="Spend" meta="<period> · <sources>">
//   data        payload; reads sourceMeta, estimatedSources, allSources,
//               totals{cost,messages,bySource} (the "All time" share bar)
//   period      label, key, cost, tokens, messages, sessions, liveCost,
//               daily[]{date,total,tokens,bySource{src:$}}, sources[], singleSource,
//               bySource{src:{cost,tokens,messages}}, cacheSavings{readTokens,saved,
//               writePremium,net}, speedSpend{fast,standard,fastPremium}, prev{cost,…}
//               (may be undefined → render nothing)
//   colorMap    colorMap.get(src) → 'var(--sN)' — the ONLY colours for sources
//   srcFilter   active filter → exports carry it (lib.exportHref)
//   (thresholds, notify, gfx, theme, onStopped, onPeriod: unused)
//
// TARGET (mockup "Spend" group): c-8 panel "Daily spend by source" (ctx: label ·
// first – last date) with the Export <Menu> in the header (items from
// lib.EXPORT_SETS + "Full payload · JSON"; links = lib.exportHref, same-origin
// `download`), legend (lib.srcLabel + <Swatch>) + "daily average" key, chart
// with y-axis (lib.niceScale + moneyAxis), gridlines, avg line, 2 px gaps
// between stacked segments computed in SVG, bars ≤ 24 px with 3 px top radius,
// hover column + tooltip that flips near the right edge, tap-to-pin on touch,
// width-aware date ticks. Econ strip (3 cells): prompt cache net (negative
// allowed, never clamped), fast-mode premium (hide when fast.messages = 0),
// daily pattern; coverage note when period.liveCost < 99% of period.cost.
// c-4 panel "By source": share bar, table (label + raw-key sub-line, spend,
// share, tokens, `est`), All-time share bar from data.totals.bySource;
// single-source → cumulative <Spark> state.
//
// STUB: the export Menu is already the new keyboard menu; the body is the
// legacy summary line + CacheSavings + SpendChart / BarList.
// =============================================================================
import { Section, Panel, Menu } from '../ui.jsx';
import { SpendChart, Sparkline } from '../charts.jsx';
import { BarList, CacheSavings, Legend } from '../panels.jsx';
import { money, tokens, num, srcLabel, sourceLabel, exportHref, EXPORT_SETS, pctChange } from '../lib.js';
import './Spend.css';

export default function Spend({ id, data, period, colorMap, srcFilter }) {
  if (!period) return null;
  const sourcesText = srcFilter.length ? srcFilter.map((s) => srcLabel(s, data.sourceMeta)).join(' + ') : 'all sources';
  const d = pctChange(period.cost, period.prev && period.prev.cost);
  const sourceRows = Object.keys(period.bySource || {})
    .sort((a, b) => period.bySource[b].cost - period.bySource[a].cost)
    .map((s) => ({ name: s, label: srcLabel(s, data.sourceMeta), ...period.bySource[s], color: colorMap.get(s) }));

  const exportItems = [
    { header: `CSV · ${period.label}` },
    ...EXPORT_SETS.map(([label, set]) => ({ label, hint: set, href: exportHref({ format: 'csv', data: set }, period.key, srcFilter), download: '' })),
    { separator: true },
    { label: 'Full payload', hint: 'JSON', href: exportHref({ format: 'json' }, period.key, srcFilter), download: '' },
  ];

  return (
    <Section id={id} title="Spend" meta={`${period.label} · ${sourcesText}`}>
      <Panel
        span={8}
        title="Daily spend by source"
        ctx={period.label}
        actions={<Menu label="Export" icon="download" items={exportItems} title="Download this view as CSV or JSON" />}
      >
        <div className="legacy">
          <div className="sub spend-stub-sum">
            <b className="spend-stub-cost">{money(period.cost)}</b>
            {d != null && <span className={'perioddelta ' + (Math.abs(d) < 0.5 ? 'flat' : d > 0 ? 'up' : 'down')}> {d > 0 ? '+' : ''}{d.toFixed(0)}% <span className="pdlabel">vs previous window</span></span>}
            {' · '}{tokens(period.tokens)} tokens · {num(period.messages)} msgs · {num(period.sessions)} sessions
          </div>
          <CacheSavings cache={period.cacheSavings} period={period} />
          <Legend period={period} colorMap={colorMap} single={period.singleSource} meta={data.sourceMeta} />
          <SpendChart period={period} colorMap={colorMap} meta={data.sourceMeta} />
        </div>
      </Panel>
      <Panel span={4} title="By source" ctx={period.label}>
        <div className="legacy">
          {period.singleSource ? (
            <>
              <div className="sub">Single source — <b>{sourceLabel(period.sources[0] || 'cli', data.sourceMeta)}</b> accounts for 100% of this period.</div>
              <Sparkline period={period} />
            </>
          ) : (
            <BarList rows={sourceRows} estimatedSources={data.estimatedSources || []} />
          )}
        </div>
      </Panel>
    </Section>
  );
}
