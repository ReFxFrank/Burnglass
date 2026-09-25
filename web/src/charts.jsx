// =============================================================================
// charts.jsx — measured-SVG charts for the dashboard.
// Spend.jsx is the only caller (SpendChart + the single-source Sparkline).
//
// SpendChart — daily stacked bars by source (Command Center spec):
//   · y-axis with nice ticks (lib.niceScale, exact-precision labels) and hairline gridlines
//   · a daily-average reference line, labelled "avg" in the axis gutter
//   · bars ≤ 24 px, 3 px rounded top, square at the baseline
//   · 2 px surface gaps between stacked segments, carved OUT of each segment in
//     SVG so the stack top always lands exactly on the day's total
//   · hover column + tooltip that flips to the left near the right edge
//   · tap-to-pin on touch/pen, arrow keys when focused (a live region reads it)
//   · date ticks thinned by the measured width; edge labels are never clipped
// Every colour is a CSS token (the source colours come in via colorMap as
// var(--sN) strings); styles live in sections/Spend.css under .sec-spend.
// =============================================================================
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Spark } from './ui.jsx';
import {
  localDateStr, longDate, money, niceScale, shortDate, srcLabel, tokens,
} from './lib.js';

// Measure an element's content width (responsive SVG without distortion).
export function useMeasure() {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setW(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// Path for a bar with rounded TOP corners only (square at the baseline).
function topRoundedRect(x, y, w, h, r) {
  if (h <= 0 || w <= 0) return '';
  const rr = Math.max(0, Math.min(r, w / 2, h));
  if (rr <= 0) return `M${x},${y}h${w}v${h}h${-w}Z`;
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

// ---------- cumulative-spend sparkline (single-source state) ----------
// Kept under its old name; now the shared <Spark> with a caption.
export function Sparkline({ period, height = 56, color }) {
  const days = (period && period.daily) || [];
  let run = 0;
  const cum = days.map((b) => (run += b.total || 0));
  return (
    <Spark
      values={cum}
      height={height}
      color={color}
      label={`Cumulative spend, ${period ? period.label : ''}`}
      cap={days.length ? [shortDate(days[0].date), 'cumulative ' + money(run)] : null}
    />
  );
}

// ---------- x-axis tick selection ----------
const TICK_STEPS = [1, 2, 5, 7, 10, 15, 30, 60, 90];
// Indices to label: every `step` days from the first, plus the forced ones
// (today, the last day); a regular tick too close to a forced one is dropped.
function pickTicks(n, width, forced) {
  if (n <= 0) return [];
  const maxLabels = Math.max(2, Math.min(8, Math.floor(width / 62)));
  const step = TICK_STEPS.find((s) => Math.ceil(n / s) <= maxLabels) || Math.ceil(n / maxLabels);
  const keep = new Set(forced.filter((i) => i >= 0 && i < n));
  const out = [];
  for (let i = 0; i < n; i += step) {
    let near = false;
    for (const f of keep) if (f !== i && Math.abs(f - i) < step * 0.6) near = true;
    if (!near) out.push(i);
  }
  for (const f of keep) if (!out.includes(f)) out.push(f);
  return out.sort((a, b) => a - b);
}

// y scale: lib.niceScale with 5 ticks (the mockup's 0/25/50/75/100), unless 4
// or 6 ticks reach a tighter top — $1,000 should top out at $1.2k, not $1.5k.
// An empty window keeps a lone $0 baseline.
function chartScale(max) {
  if (!(max > 0)) return { max: 1, step: 1, ticks: [0] };
  let best = niceScale(max, 5);
  for (const t of [4, 6]) {
    const s = niceScale(max, t);
    if (s.max < best.max - 1e-9 && s.ticks.length <= 7) best = s;
  }
  return best;
}

// Axis tick label with exactly the precision the tick needs: $0 · $2.5 · $25 ·
// $1.25k · $12.5k. (lib.moneyAxis rounds $1,250 to "$1.3k" and $12,500 to
// "$13k" — fine for a lone label, wrong on an axis whose step is 250/2,500.)
function tickMoney(v) {
  if (!(v > 0)) return '$0';
  const [div, suf] = v >= 1e6 ? [1e6, 'M'] : v >= 1e3 ? [1e3, 'k'] : [1, ''];
  const x = v / div;
  let d = 0;
  while (d < 3 && Math.abs(Number(x.toFixed(d)) - x) > 1e-9) d++;
  return '$' + x.toFixed(d) + suf;
}

const SEG_GAP = 2; // px of surface between stacked segments
const BAR_MAX = 24; // px, bar thickness cap
const BAR_R = 3; // px, rounded data-end
const TIP_W = 196; // px, tooltip width
const TIP_MIN = 144; // px, narrowest tooltip before it may overlap its column
const LABEL_CH = 6.3; // px per character (11 px Inter) — x-label edge clamping

// ---------- the stacked daily bar chart ----------
// props:
//   period     the selected period (daily[]{date,total,tokens,bySource}, sources[], label)
//   colorMap   { get(src) → 'var(--sN)' } — source colours only
//   meta       payload.sourceMeta (custom source labels)
//   avg        daily-average reference value ($/day) or null
//   height     plot height in px (232 desktop, 180 phone)
//   estimated  payload.estimatedSources (tooltip "est" marks)
export function SpendChart({ period, colorMap, meta, avg = null, height = 232, estimated = [] }) {
  const [plotRef, W] = useMeasure();
  const wrapRef = useRef(null);
  const lastPointer = useRef('mouse');
  const [sel, setSel] = useState(null); // { i, mode: 'hover' | 'pin' | 'key' }

  const days = (period && period.daily) || [];
  const n = days.length;
  const srcs = useMemo(() => {
    const list = ((period && period.sources) || []).slice();
    // any source that shows up in the daily buckets but not in sources[] still stacks
    for (const d of days) for (const s of Object.keys(d.bySource || {})) if (!list.includes(s)) list.push(s);
    return list;
  }, [period, days]);
  const today = localDateStr();
  const todayIdx = days.findIndex((d) => d.date === today);

  const H = height;
  const yb = H - 1; // baseline (the axis hairline sits in the last pixel row)
  const maxDay = days.reduce((m, d) => Math.max(m, d.total || 0), 0);
  const scale = useMemo(() => chartScale(Math.max(maxDay, avg || 0)), [maxDay, avg]);
  const y = (v) => yb - (Math.max(0, v) / scale.max) * yb;

  const slot = n ? W / n : 0;
  const colGap = slot >= 12 ? 3 : slot >= 6 ? 2 : slot >= 3 ? 1 : 0;
  const bwRaw = Math.min(BAR_MAX, Math.max(1, slot - colGap));
  const snap = bwRaw >= 3;
  const bw = snap ? Math.round(bwRaw) : bwRaw;
  const barX = (i) => {
    const x = i * slot + (slot - bw) / 2;
    return snap ? Math.round(x) : x;
  };

  // Bar geometry (memoised: hover re-renders reuse the same element tree).
  const barsEl = useMemo(() => {
    if (!W || !n) return null;
    const out = [];
    days.forEach((d, i) => {
      const x = barX(i);
      const segs = [];
      let cum = 0;
      for (const s of srcs) {
        const v = (d.bySource && d.bySource[s]) || 0;
        if (v <= 0) continue;
        const y0 = y(cum);
        cum += v;
        segs.push({ s, y0, y1: y(cum) });
      }
      // drop sub-pixel slivers; the top visible segment absorbs them so the
      // stack still ends exactly at the total
      const vis = segs.filter((g) => g.y0 - g.y1 >= 0.5);
      if (!vis.length && segs.length) vis.push(segs[segs.length - 1]);
      const top = segs.length ? segs[segs.length - 1].y1 : yb;
      vis.forEach((g, k) => {
        const isTop = k === vis.length - 1;
        const y1 = isTop ? top : g.y1;
        let h = g.y0 - y1;
        let yy = y1;
        if (!isTop) {
          const cut = h > SEG_GAP + 1 ? SEG_GAP : Math.max(0, h - 1);
          yy += cut; h -= cut;
        }
        if (h <= 0) return;
        out.push(
          <path
            key={i + ':' + g.s}
            d={isTop ? topRoundedRect(x, yy, bw, Math.max(h, 0.75), bw >= 4 ? BAR_R : 0) : `M${x},${yy}h${bw}v${h}h${-bw}Z`}
            style={{ fill: colorMap.get(g.s) }}
          />,
        );
      });
    });
    return <g className="sc-bars">{out}</g>;
  }, [days, srcs, W, H, scale.max, colorMap, bw, slot]); // y/barX derive from these

  // x labels: thinned by width, clamped inside the plot at the edges, and any
  // that would still touch a higher-priority neighbour (today > last > first
  // > the rest) are dropped — never overlapped, never clipped.
  const xLabels = useMemo(() => {
    if (!W || !n) return [];
    const cand = pickTicks(n, W, [n - 1, todayIdx]).map((i) => {
      const text = i === todayIdx ? 'Today' : shortDate(days[i].date);
      const cx = i * (W / n) + W / n / 2;
      const w = text.length * LABEL_CH;
      let l = cx - w / 2;
      let align = 'c';
      if (l < 0) { l = 0; align = 'l'; } else if (l + w > W) { l = W - w; align = 'r'; }
      const pri = i === todayIdx ? 0 : i === n - 1 ? 1 : i === 0 ? 2 : 3;
      return { i, text, cx, l, r: l + w, align, pri };
    });
    const kept = [];
    for (const c of cand.slice().sort((a, b) => a.pri - b.pri || a.i - b.i)) {
      if (kept.every((k) => c.r + 6 <= k.l || c.l >= k.r + 6)) kept.push(c);
    }
    return kept.sort((a, b) => a.i - b.i);
  }, [n, W, todayIdx, days]);

  // dismiss a pinned tooltip on a tap/click anywhere else; Esc anywhere
  useEffect(() => {
    if (!sel || sel.mode !== 'pin') return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setSel(null); };
    const onKey = (e) => { if (e.key === 'Escape') setSel(null); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [sel]);
  // a period switch that shrinks the window must not leave a stale index
  useEffect(() => { setSel((s) => (s && s.i >= n ? null : s)); }, [n]);

  const idxAt = (clientX) => {
    const el = plotRef.current;
    if (!el || !n) return -1;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(n - 1, Math.floor(((clientX - r.left) / r.width) * n)));
  };
  const onPointerMove = (e) => {
    if (e.pointerType !== 'mouse') return;
    if (sel && sel.mode === 'pin') return;
    const i = idxAt(e.clientX);
    if (i >= 0 && (!sel || sel.i !== i || sel.mode !== 'hover')) setSel({ i, mode: 'hover' });
  };
  const onPointerLeave = (e) => {
    if (e.pointerType === 'mouse' && sel && sel.mode === 'hover') setSel(null);
  };
  const onPointerDown = (e) => { lastPointer.current = e.pointerType || 'mouse'; };
  const onClick = (e) => {
    if (lastPointer.current === 'mouse') return; // mouse reads by hover
    const i = idxAt(e.clientX);
    if (i < 0) return;
    setSel((s) => (s && s.mode === 'pin' && s.i === i ? null : { i, mode: 'pin' }));
  };
  const onFocus = (e) => {
    let kb = true;
    try { kb = e.target.matches(':focus-visible'); } catch (_) {}
    if (kb && !sel) setSel({ i: todayIdx >= 0 ? todayIdx : n - 1, mode: 'key' });
  };
  const onBlur = () => { if (sel && sel.mode === 'key') setSel(null); };
  const onKeyDown = (e) => {
    if (!n) return;
    const cur = sel ? sel.i : (todayIdx >= 0 ? todayIdx : n - 1);
    let next = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(0, cur - 1);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(n - 1, cur + 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'PageUp') next = Math.max(0, cur - 7);
    else if (e.key === 'PageDown') next = Math.min(n - 1, cur + 7);
    else if (e.key === 'Escape') { if (sel) { e.preventDefault(); setSel(null); } return; }
    if (next == null) return;
    e.preventDefault();
    setSel({ i: next, mode: 'key' });
  };

  const active = sel && sel.i < n ? sel.i : -1;
  const d = active >= 0 ? days[active] : null;

  // Tooltip placement (plot coordinates): right of the column, flipped to the
  // left near the right edge. It may spill into the y-axis gutter on the left.
  // When neither side holds the full width (phones) it narrows to the roomier
  // side rather than cover the column it describes; only below TIP_MIN does it
  // fall back to overlapping, clamped inside the chart.
  let tipLeft = 0;
  let tw = TIP_W;
  if (d) {
    let gut = 40;
    try { gut = Math.max(0, plotRef.current.getBoundingClientRect().left - wrapRef.current.getBoundingClientRect().left); } catch (_) {}
    const colL = active * slot, colR = colL + slot;
    const roomR = W - colR - 8;
    const roomL = colL - 8 + gut;
    if (roomR >= TIP_W) tipLeft = colR + 8;
    else if (roomL >= TIP_W) tipLeft = colL - 8 - TIP_W;
    else if (Math.max(roomR, roomL) >= TIP_MIN) {
      tw = Math.floor(Math.max(roomR, roomL));
      tipLeft = roomR >= roomL ? colR + 8 : colL - 8 - tw;
    } else {
      tw = Math.min(TIP_W, W + gut);
      tipLeft = Math.max(-gut, Math.min(colL + slot / 2 - tw / 2, W - tw));
    }
  }
  const tipRows = d
    ? srcs
      .map((s) => ({ s, v: (d.bySource && d.bySource[s]) || 0 }))
      .filter((r) => r.v > 0)
      .sort((a, b) => b.v - a.v)
    : [];

  const avgY = avg > 0 ? y(avg) : null;
  const label = `Daily spend by source, ${period ? period.label : ''}. ${n} days, peak ${money(maxDay)}${avg > 0 ? `, average ${money(avg)} per day` : ''}. Use the arrow keys to read each day.`;
  const live = d && sel.mode === 'key'
    ? `${longDate(d.date)}: ${money(d.total)}${tipRows.length ? ' — ' + tipRows.map((r) => `${srcLabel(r.s, meta)} ${money(r.v)}`).join(', ') : ''}`
    : '';

  return (
    <div className="sc" ref={wrapRef} style={{ '--sc-h': H + 'px' }}>
      <div className="sc-yax" aria-hidden="true">
        {scale.ticks.map((t) => {
          const ty = y(t);
          const hide = avgY != null && Math.abs(ty - avgY) < 12;
          return <span key={t} style={{ top: ty + 'px', visibility: hide ? 'hidden' : undefined }}>{tickMoney(t)}</span>;
        })}
        {avgY != null ? <span className="sc-yavg" style={{ top: avgY + 'px' }} title={'Daily average ' + money(avg)}>avg</span> : null}
      </div>
      <div
        ref={plotRef}
        className={'sc-plot' + (sel && sel.mode === 'pin' ? ' pinned' : '')}
        tabIndex={n ? 0 : -1}
        role="group"
        aria-label={label}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onPointerDown={onPointerDown}
        onClick={onClick}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      >
        {W > 0 ? (
          <svg className="sc-svg" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
            {scale.ticks.slice(1).map((t) => {
              const gy = Math.round(y(t)) + 0.5;
              return <line key={t} className="sc-gl" x1="0" x2={W} y1={gy} y2={gy} />;
            })}
            {active >= 0 ? (
              <path className="sc-hl" d={topRoundedRect(active * slot + (slot > 6 ? 1 : 0), 0, Math.max(1, slot - (slot > 6 ? 2 : 0)), yb, slot > 8 ? BAR_R : 0)} />
            ) : null}
            {barsEl}
            <line className="sc-axis" x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} />
            {avgY != null ? <line className="sc-avg" x1="0" x2={W} y1={Math.round(avgY) + 0.5} y2={Math.round(avgY) + 0.5} /> : null}
          </svg>
        ) : null}
        {n && maxDay <= 0 ? <div className="sc-empty">No spend in this window</div> : null}
        {d ? (
          <div className={'sc-tip' + (tw < 180 ? ' narrow' : '')} style={{ left: tipLeft + 'px', width: tw + 'px' }} aria-hidden="true">
            <div className="sc-tip-h">
              <span>{longDate(d.date)}</span>
              {active === todayIdx ? <span className="sc-tip-tag">Today</span> : sel.mode === 'pin' ? <span className="sc-tip-tag">pinned</span> : null}
            </div>
            {tipRows.length ? tipRows.map((r) => (
              <div className="sc-tip-r" key={r.s}>
                <i className="sw" style={{ background: colorMap.get(r.s) }} />
                <span className="sc-tip-n">{srcLabel(r.s, meta)}</span>
                {estimated.includes(r.s) ? <span className="est">est</span> : null}
                <b>{money(r.v)}</b>
              </div>
            )) : <div className="sc-tip-r sc-tip-none">No spend</div>}
            <div className="sc-tip-t"><span>Total</span><span>{money(d.total)}</span></div>
            <div className="sc-tip-r sc-tip-tok"><span className="sc-tip-n">Tokens</span><b>{tokens(d.tokens)}</b></div>
          </div>
        ) : null}
        <div className="sr" aria-live="polite">{live}</div>
      </div>
      <div className="sc-xax" aria-hidden="true">
        {xLabels.map((t) => {
          const style = t.align === 'l' ? { left: 0 } : t.align === 'r' ? { right: 0 } : { left: t.cx + 'px', transform: 'translateX(-50%)' };
          return <span key={t.i} className={t.i === active ? 'on' : undefined} style={style}>{t.text}</span>;
        })}
      </div>
    </div>
  );
}
