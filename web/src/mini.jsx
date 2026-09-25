import { useEffect, useState } from 'react';
import {
  BRAND, alertThresholds, dur, formatReset, localDateStr, makeColorMap, meterTone, money, moneyAxis,
  shortDate, srcLabel, staleNote, tokens, useTick,
} from './lib.js';
import { MeterBar, Seg, Tip, cx } from './ui.jsx';
import { Icon, BrandMark, Wordmark } from './icons.jsx';
import { FamilyMark } from './logos.jsx';
import './mini.css';

// Compact side overview (#mini) — stacked provider cards sized for a narrow
// docked window, the 340 px popup or the tray's 380 px app window: official
// Claude/Codex windows as "% used" meters (the SAME bar, threshold ticks,
// projection hatch and warn/crit colours as the dashboard's Limits section),
// plus spend by source for Today | Yesterday | 30 days and a 30-day trend.
// Read-only view over the same summary payload; no extra endpoints. Solid
// surfaces only, nothing animates — lite-graphics safe.

// "Claude · weekly · Fable" → "Weekly · Fable" (the card head names the provider).
function stripProvider(label) {
  const s = String(label || '').replace(/^(Claude|Codex) · /, '');
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function MiniRows({ buckets, thresholds, provider }) {
  return (
    <div className="mini-rows">
      {buckets.map((b) => {
        const pct = Math.max(0, Number(b.pct) || 0);
        const tone = b.stale ? '' : meterTone(pct, thresholds);
        const proj = b.projLeftAtReset != null && !b.stale ? Math.max(0, Math.min(100, 100 - b.projLeftAtReset)) : null;
        const remaining = b.resetsAt ? b.resetsAt - Date.now() : null;
        const label = stripProvider(b.label);
        return (
          <div className={cx('mini-row', b.stale && 'stale')} key={b.key}>
            <div className="top">
              <span className="mini-lbl">{label}</span>
              <b className={cx('mini-pct', tone)}>{b.stale ? '—' : Math.round(pct) + '% used'}</b>
            </div>
            <MeterBar
              pct={pct}
              proj={proj}
              thresholds={thresholds}
              stale={b.stale}
              label={`${provider} ${label}: ${Math.round(pct)}% used`}
            />
            <div className="bot">
              {proj != null && proj > pct ? (
                <Tip content="Straight-line projection from your recent burn rate: how much of this window would be used at reset if the current pace continues.">
                  <span className={cx('mini-proj', meterTone(proj, thresholds))} tabIndex={0}>→ {Math.round(proj)}% at reset</span>
                </Tip>
              ) : (
                <span>{b.resetsAt ? formatReset(b.resetsAt) : ''}</span>
              )}
              <span>
                {b.stale
                  ? staleNote(provider === 'Codex' ? 'codex' : 'claude', true)
                  : remaining != null && remaining > 0
                    ? <>resets in <b>{dur(remaining)}</b></>
                    : b.resetsAt ? 'resetting…' : ''}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Donut of per-source spend for the selected tab. SVG stroke segments on a
// single circle — colours from the dashboard's own source map (var(--sN)).
function MiniDonut({ slices, total, colorMap }) {
  const R = 42, C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <svg className="minidonut" viewBox="0 0 110 110" role="img" aria-label={`Spend by source: ${money(total)}`}>
      <circle cx="55" cy="55" r={R} fill="none" stroke="var(--m-track)" strokeWidth="12" />
      {total > 0 && slices.map((s) => {
        const frac = s.cost / total;
        const seg = (
          <circle key={s.name} cx="55" cy="55" r={R} fill="none"
            stroke={colorMap.get(s.name) || 'var(--accent)'} strokeWidth="12"
            strokeDasharray={`${Math.max(0.5, frac * C - (slices.length > 1 ? 1.5 : 0))} ${C}`}
            strokeDashoffset={-acc * C}
            transform="rotate(-90 55 55)" strokeLinecap="butt" />
        );
        acc += frac;
        return seg;
      })}
      <text x="55" y="55" textAnchor="middle" dominantBaseline="central" className="minidonutlbl">
        {total >= 10000 ? moneyAxis(total) : money(total)}
      </text>
    </svg>
  );
}

// Daily spend as tiny bars (the trend at a glance; exact figures live in the
// full dashboard's chart). Today is drawn in the accent.
function MiniTrend({ daily, todayDs }) {
  const days = daily || [];
  const max = Math.max(0.0001, ...days.map((d) => d.total || 0));
  return (
    <div className="minitrend" role="img" aria-label={`Daily spend, last ${days.length} days`}>
      {days.map((d) => (
        <Tip key={d.date} content={<><b>{shortDate(d.date)}</b> · {money(d.total || 0)}</>}>
          <span className="mt-col">
            <i className={d.date === todayDs ? 'today' : undefined} style={{ height: (d.total > 0 ? Math.max(2, (d.total / max) * 34) : 0) + 'px' }} />
          </span>
        </Tip>
      ))}
    </div>
  );
}

const TABS = [{ value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: '30d', label: '30 days' }];

export function MiniOverview({ data }) {
  useTick(1000); // live reset countdowns
  const [tab, setTab] = useState('30d');
  useEffect(() => {
    const prev = document.title;
    document.title = BRAND + ' — mini';
    return () => { document.title = prev; };
  }, []);
  const thresholds = alertThresholds(data);
  const m = data.meters;
  const cx2 = data.codexMeters;
  const last30 = (data.periods || []).find((p) => p.key === 'last30');
  const alerts = data.alerts || [];
  const colorMap = makeColorMap(data.allSources);

  // Per-tab totals + per-source split, all from data already in the payload.
  const dayBucket = (ds) => (last30 && (last30.daily || []).find((b) => b.date === ds)) || null;
  const todayDs = localDateStr(new Date());
  const yd = new Date(); yd.setDate(yd.getDate() - 1);
  const ydDs = localDateStr(yd);
  const tabData = (() => {
    if (tab === '30d') {
      const bySrc = last30 ? Object.keys(last30.bySource || {}).map((s) => ({ name: s, cost: last30.bySource[s].cost })) : [];
      return { cost: last30 ? last30.cost : 0, bySrc };
    }
    const b = dayBucket(tab === 'today' ? todayDs : ydDs);
    const bySrc = b ? Object.keys(b.bySource || {}).map((s) => ({ name: s, cost: b.bySource[s] })) : [];
    return { cost: b ? b.total : 0, bySrc };
  })();
  const slices = tabData.bySrc.filter((s) => s.cost > 0).sort((a, b) => b.cost - a.cost);
  const ydBucket = dayBucket(ydDs);

  const top = alerts[0];
  const alertText = !top ? null
    : top.kind === 'anomaly' ? 'Unusual spend today'
      : `${stripProvider(top.label)} ${Math.round(top.pct)}%`;

  const filtered = data.sourceFilter && data.sourceFilter.length;
  return (
    <div className="mini">
      <div className="minitop">
        {/* one-line lockup: the pixel-snapped 24 px mark + wordmark (cap 24·26/64 px, ≈13.4 px type) */}
        <span className="minibrand"><BrandMark size={24} /><Wordmark cap={9.75} centered label={BRAND} /></span>
        <a className="minifull" href="#">Full dashboard<Icon name="right" size={12} /></a>
      </div>
      {alerts.length > 0 && (
        <div className="minialert" role="status">
          <Icon name="alert" size={14} />
          <span>{alerts.length === 1 ? '1 alert' : alerts.length + ' alerts'} · {alertText}</span>
        </div>
      )}
      <div className="minicard">
        <div className="minihead"><FamilyMark family="claude" size={14} title="" />Claude</div>
        {m && m.enabled && (m.buckets || []).length
          ? <MiniRows buckets={m.buckets} thresholds={thresholds} provider="Claude" />
          : (
            <div className="minihint">
              {m && m.enabled
                ? (m.status === 'no-login'
                  ? 'No Claude Code login found. Connect on the full dashboard.'
                  : m.status === 'expired'
                    ? 'Claude login expired. Reconnect on the full dashboard.'
                    : m.status === 'error'
                      ? 'Meters unavailable. See the full dashboard.'
                      : 'Waiting for account meters…')
                : 'Turn on account meters on the full dashboard to see official limits here.'}
            </div>
          )}
      </div>
      {cx2 && (cx2.buckets || []).length > 0 && (
        <div className="minicard">
          <div className="minihead"><FamilyMark family="openai" size={14} title="" />Codex</div>
          <MiniRows buckets={cx2.buckets} thresholds={thresholds} provider="Codex" />
        </div>
      )}
      {last30 && (
        <div className="minicard">
          {/* The popup shares localStorage with the dashboard, so an active
              source filter carries over — the label must say what it shows. */}
          <div className="minihead minihead-spend">
            <span>Spend</span>
            <span className="minisub">
              {filtered ? data.sourceFilter.map((s) => srcLabel(s, data.sourceMeta)).join(' + ') : 'all sources'}
            </span>
          </div>
          <Seg label="Spend window" className="block minitabs" options={TABS} value={tab} onChange={setTab} />
          <div className="minidonutrow">
            <MiniDonut slices={slices} total={tabData.cost} colorMap={colorMap} />
            <div className="minilegend">
              {slices.length ? slices.map((s) => (
                <div className="minilegrow" key={s.name}>
                  <i style={{ background: colorMap.get(s.name) }} aria-hidden="true" />
                  <span className="minilegname">{srcLabel(s.name, data.sourceMeta)}</span>
                  <span className="minilegval">{money(s.cost)}</span>
                </div>
              )) : <div className="minihint">No spend in this window.</div>}
            </div>
          </div>
          <div className="ministats">
            <div className="ministat"><span>Today</span><em>{tokens(data.today ? data.today.tokens : 0)} tokens</em><b>{money(data.today ? data.today.cost : 0)}</b></div>
            <div className="ministat"><span>Yesterday</span><em>{tokens(ydBucket ? ydBucket.tokens : 0)} tokens</em><b>{money(ydBucket ? ydBucket.total : 0)}</b></div>
            <div className="ministat"><span>Last 30 days</span><em>{tokens(last30.tokens)} tokens</em><b>{money(last30.cost)}</b></div>
          </div>
          <div className="minitrendhead"><span>Daily spend</span><em>last {(last30.daily || []).length} days</em></div>
          <MiniTrend daily={last30.daily} todayDs={todayDs} />
        </div>
      )}
    </div>
  );
}
