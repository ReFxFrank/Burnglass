// =============================================================================
// App.jsx — the Command Center frame.
//   Rail (≥1024 px): brand, section nav with active tracking, PERIOD radios,
//                    SOURCE checkboxes, all-time totals, Mini view, Stop.
//   TopBar (≥1024):  title + context crumb, live chip, Updated time, reach,
//                    update pill, mini, theme toggle.
//   <1024:           MobileHeader + sticky FilterBar; period / sources / menu
//                    open bottom Sheets.
//   Dashboard:       sections in order, each from src/sections/<Name>.jsx.
// App owns every piece of cross-section state (period, source filter, theme,
// graphics mode, notification permission) and hands it down as SectionProps.
// =============================================================================
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import {
  BRAND, EXE_NAME, useSummary, makeColorMap, srcLabel, money, num, clockTime, hm, ago, prettyModel, effortLabel,
  alertThresholds, readGraphicsMode, effectiveLite, applyGraphicsMode, useTheme, motionReduced,
  readSourceFilter, writeSourceFilter, readPeriod, writePeriod,
  fireAlertNotifications, requestAlertPermission, notifyPermission,
} from './lib.js';
import { Icon } from './icons.jsx';
import { Btn, IconBtn, Pill, Sheet, StopButton, WarnBar, Empty, Swatch, Est, Seg, Panel, Section, cx } from './ui.jsx';
import { MiniOverview } from './mini.jsx';

import Alerts from './sections/Alerts.jsx';
import Kpis from './sections/Kpis.jsx';
import Limits from './sections/Limits.jsx';
import Spend from './sections/Spend.jsx';
import Breakdown from './sections/Breakdown.jsx';
import Activity from './sections/Activity.jsx';
import Meshy from './sections/Meshy.jsx';
import System from './sections/System.jsx';

// Rail / menu navigation. `id` is the DOM id each section renders on its
// <Section id={id}> root (App passes it in as the `id` prop). Items whose
// section is not on the page (e.g. Meshy when off) are hidden automatically.
const NAV = [
  { id: 'kpis', label: 'Overview', icon: 'overview' },
  { id: 'limits', label: 'Limits & budget', icon: 'gauge' },
  { id: 'spend', label: 'Spend', icon: 'chart' },
  { id: 'breakdown', label: 'Breakdown', icon: 'layers' },
  { id: 'activity', label: 'Activity', icon: 'clock' },
  { id: 'meshy', label: 'Meshy credits', icon: 'cube' },
  { id: 'system', label: 'System', icon: 'server' },
];
const NAV_IDS = NAV.map((n) => n.id);

function openMini() {
  window.open(window.location.pathname + '#mini', 'pulse-mini', 'width=340,height=760,popup=yes');
}

// Scroll a section into view under the sticky header (Overview = page top).
function goTo(id, e) {
  if (e) e.preventDefault();
  const behavior = motionReduced() ? 'auto' : 'smooth';
  if (id === NAV_IDS[0]) window.scrollTo({ top: 0, behavior });
  else {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior, block: 'start' });
  }
  try { window.history.replaceState(null, '', id === NAV_IDS[0] ? window.location.pathname + window.location.search : '#' + id); } catch (_) {}
}

// Which nav targets exist in the DOM (re-checked after every render).
function usePresentSections() {
  const [present, setPresent] = useState([]);
  useLayoutEffect(() => {
    const now = NAV_IDS.filter((id) => document.getElementById(id));
    if (now.join(',') !== present.join(',')) setPresent(now);
  });
  return present;
}

// Active section = the last one whose top has passed under the sticky header;
// the last section wins once the page is scrolled to the bottom.
function useActiveSection(present) {
  const [active, setActive] = useState(NAV_IDS[0]);
  useEffect(() => {
    let raf = 0;
    const compute = () => {
      raf = 0;
      let off = 56;
      try { off = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sticky-h')) || 56; } catch (_) {}
      off += 24;
      let cur = present[0] || NAV_IDS[0];
      for (const id of present) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= off) cur = id;
      }
      const doc = document.documentElement;
      if (present.length && window.innerHeight + window.scrollY >= doc.scrollHeight - 4 && window.scrollY > 0) cur = present[present.length - 1];
      setActive(cur);
    };
    const on = () => { if (!raf) raf = requestAnimationFrame(compute); };
    compute();
    window.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    return () => {
      window.removeEventListener('scroll', on);
      window.removeEventListener('resize', on);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [present.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  return active;
}

export default function App() {
  // Graphics mode — 'auto' detects software rendering; lite drops transitions.
  // Applied in the initializer so the very first paint is already correct.
  const [gfxMode, setGfxMode] = useState(() => {
    const m = readGraphicsMode();
    applyGraphicsMode(m);
    return m;
  });
  useEffect(() => { applyGraphicsMode(gfxMode); }, [gfxMode]);
  const liteActive = effectiveLite(gfxMode);
  const theme = useTheme();

  // Source filter — [] = all sources. Persisted; scopes the payload server-side.
  const [srcFilter, setSrcFilter] = useState(readSourceFilter);
  const { data, error } = useSummary(10000, srcFilter);
  const [periodKey, setPeriodKeyState] = useState(readPeriod);
  const [stopped, setStopped] = useState(false);
  const [sheet, setSheet] = useState(null); // 'menu' | 'period' | 'sources' | null
  const [notifyState, setNotifyState] = useState(notifyPermission);

  // #mini — the compact side overview (narrow docked window / tray popup).
  const [route, setRoute] = useState(() => window.location.hash);
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const miniView = route === '#mini';

  useEffect(() => {
    if (!miniView) document.title = BRAND + ' — usage';
  }, [miniView]);

  function updateFilter(next) {
    setSrcFilter(next);
    writeSourceFilter(next);
  }
  function setPeriodKey(k) {
    setPeriodKeyState(k);
    writePeriod(k);
  }

  const colorMap = useMemo(() => makeColorMap(data?.allSources), [data?.allSources]);
  const periods = data?.periods || [];
  const period = periods.find((p) => p.key === periodKey) || periods.find((p) => p.key === 'last30') || periods[0];
  const thresholds = alertThresholds(data);

  // Limit/anomaly alerts → desktop notifications (de-duplicated per reset cycle in lib).
  const alerts = data?.alerts || [];
  const alertSig = alerts.map((a) => a.key + a.threshold + a.resetsAt).join(',');
  useEffect(() => {
    if (data && !miniView) fireAlertNotifications(alerts);
  }, [alertSig, miniView, !!data]); // eslint-disable-line react-hooks/exhaustive-deps
  const notify = {
    permission: notifyState,
    request: async () => {
      try { await requestAlertPermission(); } catch (_) {}
      setNotifyState(notifyPermission());
      setTimeout(() => setNotifyState(notifyPermission()), 400); // callback-style browsers
    },
  };

  const present = usePresentSections();
  const active = useActiveSection(present);

  // Deep link (#system etc.) — jump once the first payload has rendered.
  const [jumped, setJumped] = useState(false);
  useEffect(() => {
    if (jumped || !data || miniView) return;
    setJumped(true);
    const h = window.location.hash.slice(1);
    if (h && NAV_IDS.includes(h)) requestAnimationFrame(() => { const el = document.getElementById(h); if (el) el.scrollIntoView({ block: 'start' }); });
  }, [data, jumped, miniView]);

  if (stopped) {
    return (
      <PageState icon="power" title={`${BRAND} is stopped`}>
        This page can’t restart a stopped server. To start {BRAND} again, double-click <code>{EXE_NAME}</code> or
        your “{BRAND}” Desktop / Start Menu shortcut (create the shortcuts once with <code>{EXE_NAME} --install-shortcuts</code>).
      </PageState>
    );
  }
  if (!data) {
    return error ? (
      <PageState icon="alert" title="Can’t reach the server">
        Is the {BRAND} server running? Start it by double-clicking <code>{EXE_NAME}</code> (or <code>node server.js</code> from source).
        <span className="paths" style={{ display: 'block', marginTop: 8 }}>{error}</span>
      </PageState>
    ) : (
      <PageState icon="pulse" title="Reading your Claude Code history…">
        The first read can take a few seconds on a large history.
      </PageState>
    );
  }
  if (miniView) return <MiniOverview data={data} />;

  const gfx = { mode: gfxMode, lite: liteActive, set: setGfxMode };
  const onStopped = () => setStopped(true);
  const sectionProps = {
    data, period, colorMap, srcFilter, thresholds, notify, gfx, theme, onStopped, onPeriod: setPeriodKey,
  };
  const activeLabel = (NAV.find((n) => n.id === active) || NAV[0]).label;
  const allSrc = data.allSources || [];
  const srcSummary = sourceSummary(srcFilter, allSrc, data.sourceMeta);

  return (
    <>
      <div className="app">
        <Rail
          data={data}
          periods={periods}
          period={period}
          onPeriod={setPeriodKey}
          srcFilter={srcFilter}
          onFilter={updateFilter}
          colorMap={colorMap}
          present={present}
          active={active}
          onStopped={onStopped}
        />
        <main className="main">
          <TopBar data={data} error={error} title={activeLabel} period={period} srcSummary={srcSummary} theme={theme} />
          <MobileHeader
            data={data}
            error={error}
            period={period}
            srcSummary={srcSummary}
            multiSource={allSrc.length >= 2}
            onOpen={setSheet}
          />
          <div className="content">
            {error && (
              <WarnBar>
                Server unreachable ({error}), showing data from {clockTime(data.generatedAt)}. Retrying every 10 s — if you
                stopped it, double-click <code>{EXE_NAME}</code> to start it again.
              </WarnBar>
            )}
            {data.selfCheck && !data.selfCheck.ok && (
              <WarnBar tone="crit">Internal self-check: {(data.selfCheck.issues || []).join('; ')}</WarnBar>
            )}
            {data.hasData ? (
              <>
                <Alerts id="alerts" {...sectionProps} />
                <Kpis id="kpis" {...sectionProps} />
                <Limits id="limits" {...sectionProps} />
                <Spend id="spend" {...sectionProps} />
                <Breakdown id="breakdown" {...sectionProps} />
                <Activity id="activity" {...sectionProps} />
                <Meshy id="meshy" {...sectionProps} />
                <System id="system" {...sectionProps} />
              </>
            ) : (
              <>
                <Section id="kpis">
                  <Panel>
                    <Empty icon="chart" title="No usage recorded yet">
                      {BRAND} is watching your Claude Code and Codex folders. Run a session and it appears here within
                      10 seconds.
                      <span className="paths" style={{ display: 'block', marginTop: 10 }}>{data.claudeDir}</span>
                    </Empty>
                  </Panel>
                </Section>
                {/* Meshy has no local logs, so it can have plenty to show on a
                    machine with no Claude/Codex history; the server must stay
                    controllable even with no data. */}
                <Alerts id="alerts" {...sectionProps} />
                <Limits id="limits" {...sectionProps} />
                <Meshy id="meshy" {...sectionProps} />
                <System id="system" {...sectionProps} />
              </>
            )}
            <Footer data={data} />
          </div>
        </main>
      </div>

      {/* phone / tablet sheets (<1024 px) */}
      <Sheet open={sheet === 'period'} onClose={() => setSheet(null)} title="Period">
        <PeriodList periods={periods} value={period?.key} onChange={(k) => { setPeriodKey(k); setSheet(null); }} />
      </Sheet>
      <Sheet
        open={sheet === 'sources'}
        onClose={() => setSheet(null)}
        title="Sources"
        footer={(
          <>
            <Btn onClick={() => updateFilter([])} disabled={!srcFilter.length}>Select all</Btn>
            <Btn variant="primary" onClick={() => setSheet(null)}>Done</Btn>
          </>
        )}
      >
        <SourceList all={allSrc} filter={srcFilter} onChange={updateFilter} colorMap={colorMap} period={period} data={data} noOnly />
      </Sheet>
      <Sheet open={sheet === 'menu'} onClose={() => setSheet(null)} title={BRAND}>
        <nav className="menu-nav" aria-label="Sections">
          {NAV.filter((n) => present.includes(n.id)).map((n) => (
            <a
              key={n.id}
              href={'#' + n.id}
              className={active === n.id ? 'on' : undefined}
              aria-current={active === n.id ? 'location' : undefined}
              onClick={(e) => { e.preventDefault(); setSheet(null); requestAnimationFrame(() => goTo(n.id)); }}
            >
              <Icon name={n.icon} />{n.label}
              {n.id === 'limits' && alerts.length > 0 ? <span className="count">{alerts.length}</span> : null}
            </a>
          ))}
        </nav>
        <div className="sheet-sec">
          <div className="rail-h">Theme</div>
          <Seg
            className="block"
            label="Theme"
            value={theme.pref}
            onChange={theme.set}
            options={[{ value: 'system', label: 'System', icon: 'monitor' }, { value: 'dark', label: 'Dark', icon: 'moon' }, { value: 'light', label: 'Light', icon: 'sun' }]}
          />
        </div>
        <div className="sheet-sec">
          <AllTime data={data} />
          {data.reach && (data.reach.downloads != null || data.reach.stars != null) && <ReachPill reach={data.reach} />}
        </div>
        <div className="sheet-sec">
          <div className="sheet-row">
            <Btn icon="mini" onClick={() => { setSheet(null); openMini(); }}>Mini view</Btn>
            <StopButton onStopped={onStopped} size="" />
          </div>
        </div>
      </Sheet>
    </>
  );
}

// ---- rail ----------------------------------------------------------------------------
function Rail({ data, periods, period, onPeriod, srcFilter, onFilter, colorMap, present, active, onStopped }) {
  const allSrc = data.allSources || [];
  const alertsN = (data.alerts || []).length;
  return (
    <aside className="rail" aria-label="Navigation and filters">
      <div className="rail-in">
        <div className="brand">
          <span className="logo"><Icon name="pulse" /></span>
          <div className="mh-brand">
            <div className="brand-name">{BRAND}</div>
            <div className="brand-sub">Usage monitor · <span className="mono">v{data.version}</span></div>
          </div>
        </div>

        <nav className="nav" aria-label="Sections">
          {NAV.filter((n) => present.includes(n.id)).map((n) => (
            <a
              key={n.id}
              href={'#' + n.id}
              className={active === n.id ? 'on' : undefined}
              aria-current={active === n.id ? 'location' : undefined}
              onClick={(e) => goTo(n.id, e)}
            >
              <Icon name={n.icon} />{n.label}
              {n.id === 'limits' && alertsN > 0 ? <span className="count" title={`${alertsN} active alert${alertsN === 1 ? '' : 's'}`}>{alertsN}</span> : null}
            </a>
          ))}
        </nav>

        {periods.length > 0 && (
          <div className="rail-grp">
            <div className="rail-h" id="rail-period-h">Period</div>
            <PeriodList periods={periods} value={period?.key} onChange={onPeriod} labelledBy="rail-period-h" />
          </div>
        )}

        {allSrc.length >= 2 && (
          <div className="rail-grp">
            <div className="rail-h">
              <span id="rail-src-h">Sources</span>
              {srcFilter.length > 0 && <button type="button" className="link" onClick={() => onFilter([])}>Select all</button>}
            </div>
            <SourceList all={allSrc} filter={srcFilter} onChange={onFilter} colorMap={colorMap} period={period} data={data} labelledBy="rail-src-h" />
          </div>
        )}
        {allSrc.length === 1 && (
          <div className="rail-grp">
            <div className="rail-h">Source</div>
            <div className="opt on" aria-disabled="true"><Swatch color={colorMap.get(allSrc[0])} /><span className="lbl">{srcLabel(allSrc[0], data.sourceMeta)}</span></div>
          </div>
        )}

        <div className="rail-foot">
          <AllTime data={data} />
          <div className="rail-actions">
            <Btn size="sm" icon="mini" onClick={openMini} title="Open the compact side view (limits, resets, spend at a glance)">Mini view</Btn>
            <StopButton variant="icon" onStopped={onStopped} />
          </div>
        </div>
      </div>
    </aside>
  );
}

function AllTime({ data }) {
  const t = data.totals || {};
  return (
    <div className="alltime">
      All time <b>{money(t.cost)}</b>{data.sourceFilter && data.sourceFilter.length ? <span> · selected</span> : null}<br />
      {num(t.messages)} msgs · {num(t.sessions)} sessions
    </div>
  );
}

// Single-choice period list (radiogroup, roving focus, arrow keys).
function PeriodList({ periods, value, onChange, labelledBy }) {
  const rolling = periods.filter((p) => p.key.startsWith('last'));
  const months = periods.filter((p) => !p.key.startsWith('last'));
  const order = [...rolling, ...months];
  const cur = order.findIndex((p) => p.key === value);
  function onKey(e, i) {
    let n = null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') n = (i + 1) % order.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') n = (i - 1 + order.length) % order.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = order.length - 1;
    if (n == null) return;
    e.preventDefault();
    onChange(order[n].key);
    const el = e.currentTarget.parentElement && e.currentTarget.parentElement.querySelector(`[data-pk="${order[n].key}"]`);
    if (el) el.focus();
  }
  const opt = (p) => {
    const i = order.indexOf(p);
    const on = p.key === value;
    return (
      <button
        key={p.key}
        type="button"
        role="radio"
        aria-checked={on}
        data-pk={p.key}
        tabIndex={on || (cur < 0 && i === 0) ? 0 : -1}
        className={cx('opt', on && 'on')}
        onClick={() => onChange(p.key)}
        onKeyDown={(e) => onKey(e, i)}
      >
        <span className="radio" aria-hidden="true" />
        <span className="lbl">{p.label}</span>
        <span className="amt">{money(p.cost)}</span>
      </button>
    );
  };
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : 'Period'}>
      {rolling.map(opt)}
      {months.length > 0 && <div className="rail-sub" role="presentation">Calendar months</div>}
      {months.map(opt)}
    </div>
  );
}

// Multi-select source list. Semantics identical to the old chips: [] = all;
// selecting every source resets to []; the last checked source can't be
// unchecked (an empty selection would silently mean "all" again).
function SourceList({ all, filter, onChange, colorMap, period, data, labelledBy, noOnly }) {
  const set = new Set(filter);
  const allOn = set.size === 0;
  const est = new Set(data.estimatedSources || []);
  const isOn = (s) => allOn || set.has(s);
  const inOrder = (xs) => all.filter((s) => xs.has(s));
  function toggle(s) {
    const cur = allOn ? new Set(all) : new Set(set);
    if (cur.has(s)) {
      if (cur.size === 1) return;
      cur.delete(s);
    } else cur.add(s);
    onChange(cur.size === all.length ? [] : inOrder(cur));
  }
  function only(s) {
    onChange(all.length <= 1 ? [] : [s]);
  }
  return (
    <div role="group" aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : 'Sources'}>
      {all.map((s) => {
        const on = isOn(s);
        const row = period && period.bySource ? period.bySource[s] : null;
        const amt = row ? money(row.cost) : (on ? money(0) : '—');
        const label = srcLabel(s, data.sourceMeta);
        return (
          <div className="srcrow" key={s}>
            <button
              type="button"
              role="checkbox"
              aria-checked={on}
              className={cx('opt', on && 'on')}
              onClick={() => toggle(s)}
              title={s !== label ? s : undefined}
            >
              <span className={cx('cbox', on && 'on')} aria-hidden="true"><Icon name="check" size={12} /></span>
              <Swatch color={colorMap.get(s)} />
              <span className="lbl">{label}</span>
              {est.has(s) && <Est />}
              <span className="amt">{amt}</span>
            </button>
            {!noOnly && (
              <button type="button" className="only" tabIndex={-1} onClick={() => only(s)} title={`Show only ${label}`}>only</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function sourceSummary(filter, all, meta) {
  if (!all.length) return 'No sources';
  if (!filter.length) return all.length === 1 ? srcLabel(all[0], meta) : `All ${all.length} sources`;
  if (filter.length === 1) return srcLabel(filter[0], meta);
  return `${filter.length} of ${all.length} sources`;
}

// ---- live status -------------------------------------------------------------------------
function liveStatus(data, error) {
  if (error) return { tone: 'warn', head: 'Offline', parts: ['server unreachable, retrying'], latest: null, stale: false };
  const st = data.agentState;
  const an = data.activeNow;
  const who = (p) => (p === 'codex' ? 'Codex' : 'Claude');
  let head;
  if (st) head = who(st.provider) + ' ' + (st.state === 'waiting' ? 'waiting on you' : st.state);
  else if (an) head = who(an.provider) + ' active';
  else head = data.latestTs ? 'No live session' : 'No usage yet';
  const parts = [];
  if (an) {
    if (an.model) parts.push(prettyModel(an.model));
    if (an.ultracode) parts.push('Ultracode');
    else if (an.effort) parts.push(effortLabel(an.effort));
    if (an.sessions) parts.push(an.sessions + (an.sessions === 1 ? ' session' : ' sessions'));
  }
  const stale = !!(data.latestTs && data.generatedAt - data.latestTs > 3 * 3600 * 1000);
  return { tone: 'ok', head, parts, latest: data.latestTs ? ago(data.latestTs) : null, stale };
}

function LiveText({ s }) {
  return (
    <>
      <b>{s.head}</b>
      {s.parts.map((p, i) => <span key={i}> · {p}</span>)}
      {s.latest ? <span className={s.stale ? 'warnc' : 'muted'}> · {s.latest}</span> : null}
    </>
  );
}

// ---- top bar (≥1024) -----------------------------------------------------------------------
function TopBar({ data, error, title, period, srcSummary, theme }) {
  const s = liveStatus(data, error);
  const upd = data.update || {};
  return (
    <header className="topbar">
      <div className="tb-title">
        <h1>{title}</h1>
        <span className="crumb">
          <b>{period ? period.label : '—'}</b>
          {(data.allSources || []).length ? <> · {srcSummary.replace(/^All /, 'all ')}</> : null}
        </span>
      </div>
      <div className="tb-sp" />
      <span className="live" title="What your agents are doing right now (latest main-conversation activity)">
        <span className={cx('dot', s.tone === 'warn' && 'warn')} aria-hidden="true" />
        <span className="lt"><LiveText s={s} /></span>
      </span>
      <div className="tb-meta" title="Refreshes every 10 seconds">
        <span className="tb-ref">Updated </span>
        <b key={data.generatedAt} className="tick-flash">{clockTime(data.generatedAt)}</b>
      </div>
      <span className="vsep" aria-hidden="true" />
      <div className="tb-actions">
        {data.reach && (data.reach.downloads != null || data.reach.stars != null) && <ReachPill reach={data.reach} className="reach" />}
        {upd.status === 'available' && (
          <Pill tone="accent" icon="arrowup" href="#system" title="Update available — see System">v{upd.latest} available</Pill>
        )}
        <IconBtn icon="mini" label="Open the mini view" onClick={openMini} />
        <ThemeToggle theme={theme} />
      </div>
    </header>
  );
}

function ReachPill({ reach, className }) {
  const bits = [];
  if (reach.downloads != null) bits.push(num(reach.downloads) + ' downloads');
  if (reach.stars != null) bits.push(num(reach.stars) + ' stars');
  return (
    <Pill
      className={className}
      href={`https://github.com/${reach.repo}`}
      target="_blank"
      rel="noreferrer"
      title={`${BRAND}'s public GitHub reach: ${bits.join(' · ')}. Public counts only — nothing about you leaves this machine.`}
    >
      {reach.downloads != null && <><Icon name="arrowdown" size={12} /><b>{num(reach.downloads)}</b></>}
      {reach.stars != null && <><Icon name="star" size={12} /><b>{num(reach.stars)}</b></>}
    </Pill>
  );
}

function ThemeToggle({ theme }) {
  const dark = theme.effective === 'dark';
  const label = `Theme: ${dark ? 'dark' : 'light'}${theme.pref === 'system' ? ' (system)' : ''} — switch to ${dark ? 'light' : 'dark'}`;
  return <IconBtn icon={dark ? 'moon' : 'sun'} label={label} onClick={() => theme.set(dark ? 'light' : 'dark')} />;
}

// ---- mobile header + filter bar (<1024) ------------------------------------------------------
function MobileHeader({ data, error, period, srcSummary, multiSource, onOpen }) {
  const s = liveStatus(data, error);
  const upd = data.update || {};
  return (
    <>
      <header className="mhead">
        <div className="mh-row">
          <span className="logo"><Icon name="pulse" /></span>
          <div className="mh-brand">
            <h1 className="brand-name">{BRAND}</h1>
            <div className="brand-sub">v{data.version} · updated {hm(data.generatedAt)}</div>
          </div>
          <span className="sp" />
          {upd.status === 'available' && (
            <Pill tone="accent" icon="arrowup" href="#system" title={`v${upd.latest} available — see System`}>v{upd.latest}</Pill>
          )}
          <IconBtn icon="mini" label="Open the mini view" onClick={openMini} />
          <IconBtn icon="menu" label="Menu" aria-haspopup="dialog" onClick={() => onOpen('menu')} />
        </div>
        <div className="mh-status">
          <span className={cx('dot', s.tone === 'warn' && 'warn')} aria-hidden="true" />
          <span className="t"><LiveText s={s} /></span>
        </div>
      </header>
      <div className={cx('mfilters', !multiSource && 'one')}>
        <button type="button" className="fbtn" aria-haspopup="dialog" onClick={() => onOpen('period')} disabled={!period}>
          <span className="l">Period{period ? ' · ' + money(period.cost) : ''}</span>
          <span className="v">{period ? period.label : '—'}</span>
          <Icon name="down" size={14} />
        </button>
        {multiSource && (
          <button type="button" className="fbtn" aria-haspopup="dialog" onClick={() => onOpen('sources')}>
            <span className="l">Sources</span>
            <span className="v">{srcSummary}</span>
            <Icon name="down" size={14} />
          </button>
        )}
      </div>
    </>
  );
}

// ---- footer ------------------------------------------------------------------------------------
function Footer({ data }) {
  const sessionFiles = (data.fileCount || 0) - (data.codexFileCount || 0);
  return (
    <footer className="foot">
      <div>
        <p>
          <b>Costs are estimates</b> at each provider’s API list prices (or the cost an agent recorded itself). On a Pro,
          Max or ChatGPT plan they show relative usage, not a bill. {BRAND} runs on this machine and reads your agents’
          logs (<code>~/.claude</code>, <code>~/.codex</code>, …) read-only. Usage data never leaves it.
        </p>
        <p>
          <b>Network:</b> a GitHub version check and public download/star counts (turn both off with{' '}
          <code>--no-update-check</code>). Opt-in only: api.anthropic.com and chatgpt.com meters with the logins those
          tools already saved, and api.meshy.ai with your key. Discord presence uses the desktop app’s local socket.
        </p>
        <div className="paths">
          reading {data.claudeDir} · {num(sessionFiles)} session file{sessionFiles === 1 ? '' : 's'}
          {data.hasCodex ? <> + {data.codexDir} · {num(data.codexFileCount)} codex file{data.codexFileCount === 1 ? '' : 's'}</> : null}
        </div>
      </div>
      <div className="foot-r">
        {BRAND} v{data.version}
        {data.reach && (data.reach.downloads != null || data.reach.stars != null) && (
          <>
            <br />
            <a href={`https://github.com/${data.reach.repo}`} target="_blank" rel="noreferrer">
              {data.reach.downloads != null && <><Icon name="arrowdown" size={12} />{num(data.reach.downloads)}</>}
              {data.reach.stars != null && <><Icon name="star" size={12} />{num(data.reach.stars)}</>}
            </a>
          </>
        )}
      </div>
    </footer>
  );
}

// ---- whole-page states (no payload yet / stopped) -------------------------------------------------
function PageState({ icon, title, children }) {
  return (
    <div className="boot">
      <div className="boot-in">
        <span className="logo" aria-hidden="true"><Icon name={icon} /></span>
        <h2>{title}</h2>
        <p className="hint">{children}</p>
      </div>
    </div>
  );
}
