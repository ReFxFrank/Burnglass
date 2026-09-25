// =============================================================================
// sections/Spend.jsx — "Spend": daily stacked chart by source + economics
// strip, and the By-source table.
// OWNER: the Spend section engineer. Styles: ./Spend.css, scoped .sec-spend.
//
// PROPS (SectionProps — see CONTRACT.md):
//   id          'spend' — root <Section id={id} title="Spend" meta="<period> · <sources>">
//   data        payload; reads sourceMeta, estimatedSources, totals{cost,messages,bySource}
//               (the "All time" share bar)
//   period      label, key, cost, liveCost, daily[]{date,total,tokens,bySource{src:$}},
//               sources[], singleSource, bySource{src:{cost,tokens,messages}},
//               cacheSavings{readTokens,saved,writePremium,net},
//               speedSpend{fast,standard,fastPremium} (may be undefined → render nothing)
//   colorMap    colorMap.get(src) → 'var(--sN)' — the ONLY colours for sources
//   srcFilter   active filter → exports carry it (lib.exportHref)
//   (thresholds, notify, gfx, theme, onStopped, onPeriod: unused)
//
// LAYOUT: c-8 "Daily spend by source" (legend + SpendChart from charts.jsx +
// EconStrip) beside c-4 "By source" (share bar, table, all-time bar). ≤1360 the
// chart goes full width and By source follows it full width (lg-12), where a
// container query lays its table and all-time block out side by side.
// =============================================================================
import { Section, Panel, Menu, InfoTip, Swatch, Est } from '../ui.jsx';
import { Icon } from '../icons.jsx';
import { SpendChart, Sparkline } from '../charts.jsx';
import {
  money, tokens, num, srcLabel, shortDate, localDateStr, exportHref, EXPORT_SETS,
  useMedia, BP,
} from '../lib.js';
import './Spend.css';

// Same wording as the legacy CacheSavings / FastSpendNote tooltips (these carry
// the corrected OpenAI cache-write rule — keep them in step with server.js).
const CACHE_INFO = 'Cache reads bill at a fraction of the input rate; cache writes bill above it (25% extra for the 5-minute TTL, 100% for the 1-hour TTL). Net is the read saving minus that write premium, priced per entry at each model’s own rate — so it can be negative when a window writes more cache than it reuses. Anthropic bills cache writes above input; OpenAI does too on models with a published cache-write price (GPT-6, 5.6 family, at 1.25×); Google bills none — each entry uses its own provider’s rule. Covers the sessions still in your logs — the long-window archive keeps day/model totals, not per-entry token types.';
const FAST_INFO = 'Fast mode bills at a higher per-token rate on the models that offer it. The premium is what those same messages would have cost at that model’s standard rate, subtracted from what they actually cost. Covers the sessions still in your logs — the long-window archive keeps day/model totals, not per-entry speed.';
const PATTERN_INFO = 'Peak = the most expensive single day in this window. The average spreads the window’s spend over its days so far (a calendar month counts only the days up to today); a day is active when it recorded any spend.';

// Per-period figures shared by the chart, the legend and the econ strip.
export function periodStats(period) {
  const days = period.daily || [];
  const today = localDateStr();
  const todayIdx = days.findIndex((d) => d.date === today);
  // days that have happened: a calendar month still carries its future days
  const past = days.filter((d) => d.date <= today);
  const elapsed = past.length || days.length;
  const active = past.filter((d) => d.total > 0).length;
  const avg = elapsed ? (period.cost || 0) / elapsed : 0;
  let peak = null;
  for (const d of days) if (d.total > 0 && (!peak || d.total > peak.total)) peak = d;
  return { days, todayIdx, elapsed, active, avg, peak };
}

function sourcesText(srcFilter, meta) {
  if (!srcFilter || !srcFilter.length) return 'all sources';
  if (srcFilter.length > 2) return srcFilter.length + ' sources';
  return srcFilter.map((s) => srcLabel(s, meta)).join(' + ');
}

function sharePct(v, total) {
  if (!(total > 0)) return '—';
  const p = (v / total) * 100;
  if (p <= 0) return '0%';
  if (p < 0.01) return '<0.01%';
  return p.toFixed(p < 1 ? 2 : 1) + '%';
}

export default function Spend({ id, data, period, colorMap, srcFilter }) {
  if (!period) return null;
  const meta = data.sourceMeta;
  const scope = sourcesText(srcFilter, meta);
  return (
    <Section id={id} title="Spend" meta={`${period.label} · ${scope}`}>
      <SpendPanel data={data} period={period} colorMap={colorMap} srcFilter={srcFilter} scope={scope} />
      <SourcePanel data={data} period={period} colorMap={colorMap} />
    </Section>
  );
}

// ---- c-8: daily chart + econ strip -------------------------------------------------
function SpendPanel({ data, period, colorMap, srcFilter, scope }) {
  const phone = useMedia(BP.sm);
  const meta = data.sourceMeta;
  const st = periodStats(period);
  const days = st.days;
  const range = days.length ? `${shortDate(days[0].date)} – ${shortDate(days[days.length - 1].date)}` : '';
  const legendSrcs = (period.sources || []).length ? period.sources : Object.keys(period.bySource || {});

  const exportItems = [
    { header: `CSV · ${period.label} · ${scope}` },
    ...EXPORT_SETS.map(([label, set]) => ({
      label, hint: set, href: exportHref({ format: 'csv', data: set }, period.key, srcFilter), download: '',
    })),
    { separator: true },
    { label: 'Full payload', hint: 'JSON', href: exportHref({ format: 'json' }, period.key, srcFilter), download: '' },
  ];

  return (
    <Panel
      span={8}
      flush
      className="spend-panel"
      title="Daily spend by source"
      ctx={range ? `${period.label} · ${range}` : period.label}
      actions={<Menu label="Export" icon="download" items={exportItems} title="Download this view as CSV or JSON" menuClassName="spend-menu" />}
    >
      <div className="pb spend-pb">
        <div className="legend spend-legend" aria-label="Legend">
          {legendSrcs.map((s) => (
            <span key={s}><Swatch color={colorMap.get(s)} />{srcLabel(s, meta)}</span>
          ))}
          {st.avg > 0 ? (
            <span className="spend-lg-avg"><i className="lg-line" />daily average <b>{money(st.avg)}</b></span>
          ) : null}
        </div>
        <SpendChart
          period={period}
          colorMap={colorMap}
          meta={meta}
          avg={st.avg > 0 ? st.avg : null}
          height={phone ? 180 : 232}
          estimated={data.estimatedSources || []}
        />
      </div>
      <EconStrip period={period} stats={st} />
    </Panel>
  );
}

// Coverage caveat: cache/fast are LIVE-only, so when the archive carries part
// of the headline, say how much of it the live logs cover (<1% gap = rounding).
function coverage(period) {
  const cost = period.cost || 0;
  const live = period.liveCost;
  if (typeof live !== 'number' || cost <= 0) return { full: true, live: cost, cost };
  return { full: live >= cost * 0.99, live, cost };
}

function EconStrip({ period, stats }) {
  const cache = period.cacheSavings;
  const speed = period.speedSpend;
  const cov = coverage(period);
  const hasCache = cache && (cache.readTokens > 0 || cache.writePremium > 0);
  const hasFast = speed && speed.fast && speed.fast.messages > 0;
  const neg = hasCache && cache.net < 0;
  const std = (speed && speed.standard) || { cost: 0, messages: 0 };

  const cells = [];
  cells.push(
    <div className="spend-econ-c" key="cache">
      <div className="spend-econ-l">Prompt cache <InfoTip text={CACHE_INFO} label="About prompt-cache savings" /></div>
      {hasCache ? (
        <>
          <div className="spend-econ-v">
            <Icon name={neg ? 'arrowup' : 'arrowdown'} size={14} className={neg ? 'spend-cost' : 'spend-good'} />
            <span className="tn">{money(cache.net)}</span>
            <span className="spend-econ-u">{neg ? 'net cost' : 'net saved'}</span>
          </div>
          <div className="spend-econ-s">
            <b>{money(cache.saved)}</b> off {tokens(cache.readTokens)} cached reads, less <b>{money(cache.writePremium)}</b> write premium
          </div>
        </>
      ) : (
        <>
          <div className="spend-econ-v spend-econ-none">—</div>
          <div className="spend-econ-s">No prompt-cache reads or writes in this window’s live logs.</div>
        </>
      )}
    </div>,
  );
  if (hasFast) {
    cells.push(
      <div className="spend-econ-c" key="fast">
        <div className="spend-econ-l"><Icon name="bolt" size={12} className="spend-bolt" />Fast mode <InfoTip text={FAST_INFO} label="About the fast-mode premium" /></div>
        <div className="spend-econ-v">
          <Icon name="arrowup" size={14} className="spend-cost" />
          <span className="tn">{money(speed.fastPremium)}</span>
          <span className="spend-econ-u">above standard</span>
        </div>
        <div className="spend-econ-s">
          <b>{money(speed.fast.cost)}</b> over {num(speed.fast.messages)} fast msgs ({tokens(speed.fast.tokens)})
          {std.messages ? <> · <b>{money(std.cost)}</b> standard</> : null}
        </div>
      </div>,
    );
  }
  cells.push(
    <div className="spend-econ-c" key="pattern">
      <div className="spend-econ-l">Daily pattern <InfoTip text={PATTERN_INFO} label="About the daily pattern" /></div>
      {stats.peak ? (
        <div className="spend-econ-v">
          <span className="tn">{money(stats.peak.total)}</span>
          <span className="spend-econ-u">peak · {shortDate(stats.peak.date)}</span>
        </div>
      ) : (
        <div className="spend-econ-v spend-econ-none">—</div>
      )}
      <div className="spend-econ-s">
        avg <b>{money(stats.avg)}</b>/day · <b>{num(stats.active)}</b> of {num(stats.elapsed)} days active
        {!(cov.cost > 0) ? null : cov.full
          ? <> · all {money(cov.cost)} still in live logs</>
          : <> · <span className="spend-cov">cache &amp; fast cover the <b>{money(cov.live)}</b> of {money(cov.cost)} still in your logs</span></>}
      </div>
    </div>,
  );
  return <div className={'spend-econ n' + cells.length}>{cells}</div>;
}

// ---- c-4: by source ---------------------------------------------------------------
function SourcePanel({ data, period, colorMap }) {
  const narrowShell = useMedia(BP.md); // ≤1024: no rail, the filter lives in the top bar
  const meta = data.sourceMeta;
  const est = data.estimatedSources || [];
  const by = period.bySource || {};
  const order = (period.sources || []).length ? period.sources : Object.keys(by);
  const rows = Object.keys(by)
    .map((s) => ({ s, ...by[s] }))
    .sort((a, b) => (b.cost || 0) - (a.cost || 0) || (b.tokens || 0) - (a.tokens || 0));
  const total = period.cost || 0;
  const shareSrcs = order.filter((s) => by[s] && by[s].cost > 0);
  const totals = data.totals || {};
  const allBy = totals.bySource || {};
  const allOrder = (data.allSources || Object.keys(allBy)).filter((s) => allBy[s] && allBy[s].cost > 0);
  const filterHint = narrowShell ? 'Filter sources with the Sources button.' : 'Filter sources in the left rail.';

  const allTime = (
    <div className="spend-alltime">
      <div className="sublab">All time<span className="tn">{money(totals.cost)} · {num(totals.messages)} msgs</span></div>
      {allOrder.length > 1 ? (
        <div className="share spend-share-thin" role="img" aria-label="All-time share of spend by source">
          {allOrder.map((s) => (
            <i key={s} style={{ flex: `${allBy[s].cost} 1 0`, background: colorMap.get(s) }} title={`${srcLabel(s, meta)} ${money(allBy[s].cost)}`} />
          ))}
        </div>
      ) : null}
      <div className="hint spend-alltime-h">Colors identify a source everywhere on the page. {filterHint}</div>
    </div>
  );

  if (period.singleSource) {
    const s = (period.sources && period.sources[0]) || rows[0]?.s || '';
    return (
      <Panel span={4} className="lg-12 spend-src" title="By source" ctx={period.label} bodyClassName="fcol">
        <div className="spend-src-body single">
          <div className="spend-src-main">
            <div className="hint spend-single">
              Single source: <b>{srcLabel(s, meta)}</b>{est.includes(s) ? <> <Est /></> : null} accounts for 100% of this view.
            </div>
            <Sparkline period={period} color={s ? colorMap.get(s) : undefined} />
          </div>
          {allTime}
        </div>
      </Panel>
    );
  }

  return (
    <Panel span={4} className="lg-12 spend-src" title="By source" ctx={period.label} bodyClassName="fcol">
      <div className="spend-src-body">
        <div className="spend-src-main">
          {shareSrcs.length ? (
            <div className="share spend-share" role="img" aria-label="Share of spend by source">
              {shareSrcs.map((s) => (
                <i key={s} style={{ flex: `${by[s].cost} 1 0`, background: colorMap.get(s) }} title={`${srcLabel(s, meta)} ${sharePct(by[s].cost, total)}`} />
              ))}
            </div>
          ) : null}
          {rows.length ? null : <div className="hint">No source recorded any spend in this window.</div>}
          {rows.length ? <div className="tbl spend-tbl" role="table" aria-label={`Spend by source, ${period.label}`}>
            <div className="tr th" role="row">
              <span role="columnheader">Source</span>
              <span role="columnheader" className="r">Spend</span>
              <span role="columnheader" className="r">Share</span>
              <span role="columnheader" className="r c-tok">Tokens</span>
            </div>
            {rows.map((r) => (
              <div className="tr" role="row" key={r.s}>
                <span role="cell" className="cell-name">
                  <Swatch color={colorMap.get(r.s)} />
                  <span className="two">
                    <span className="t-row">
                      <span className="t">{srcLabel(r.s, meta)}</span>
                      {est.includes(r.s) ? <Est /> : null}
                    </span>
                    <span className="sub">{r.s}</span>
                  </span>
                </span>
                <span role="cell" className="r">{money(r.cost)}</span>
                <span role="cell" className="r muted">{sharePct(r.cost, total)}</span>
                <span role="cell" className="r muted c-tok">{tokens(r.tokens)}</span>
              </div>
            ))}
          </div> : null}
        </div>
        {allTime}
      </div>
    </Panel>
  );
}
