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
// HEATMAP: one tooltip for the whole grid (not 168 Tip instances). Mouse =
// hover, touch/pen = tap to pin (tap again or outside to close), keyboard =
// the grid is ONE tab stop (role="grid" + aria-activedescendant): focus lands
// on the busiest hour, arrows move, Home/End jump to 12a/11p, Esc closes.
// SESSIONS: the server title is "project · first prompt… · 8-hex id" (a Claude
// Desktop session carries its own free-text title instead) — split back into a
// project tag, the prompt and the short id; the raw title stays in `title`.
// =============================================================================
import { useEffect, useLayoutEffect, useRef, useState, useId } from 'react';
import { createPortal } from 'react-dom';
import { Section, Panel, Btn, Seg, Swatch, Est, EffortLabel, FastChip, Tip, Empty, useClamp, placeFloating, cx } from '../ui.jsx';
import { ModelLogo } from '../logos.jsx';
import {
  money, moneyAxis, tokens, num, ago, srcLabel, prettyModel, exportHref, effortLabel,
  EFFORT_LEVELS, WEEKDAYS, useMedia, BP,
} from '../lib.js';
import './Activity.css';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hourLab = (h) => (h === 0 ? '12a' : h < 12 ? h + 'a' : h === 12 ? '12p' : (h - 12) + 'p');
const hourRange = (h) => hourLab(h) + '–' + hourLab((h + 1) % 24);
// 7-step sequential ramp: sqrt keeps the long tail of small hours visible.
const binOf = (v, max) => (v > 0 && max > 0 ? 1 + Math.min(6, Math.floor(Math.sqrt(v / max) * 7)) : 0);
const METRICS = [
  { value: 'cost', label: 'Spend' },
  { value: 'messages', label: 'Messages' },
];

// ---- heatmap ------------------------------------------------------------------
function Heatmap({ hm, metric }) {
  const uid = useId().replace(/:/g, '');
  const grid = (hm.grid || []).slice(0, 7);
  const isMsgs = metric === 'messages';
  const val = (c) => (c ? (isMsgs ? c.messages || 0 : c.cost || 0) : 0);
  const fmtFull = isMsgs ? (v) => num(v) + ' msgs' : money;
  const fmtShort = isMsgs ? num : moneyAxis;

  let max = isMsgs ? hm.maxMessages : hm.maxCost;
  let busiest = null;
  const colTot = new Array(24).fill(0);
  const rowTot = new Array(7).fill(0);
  grid.forEach((row, d) => (row || []).forEach((c, h) => {
    const v = val(c);
    colTot[h] += v; rowTot[d] += v;
    if (v > 0 && (!busiest || v > val(grid[busiest.d][busiest.h]))) busiest = { d, h };
  }));
  if (!(max > 0)) max = busiest ? val(grid[busiest.d][busiest.h]) : 0;
  const colMax = Math.max(...colTot, 0);

  const [active, setActive] = useState(null); // { d, h, mode: 'hover' | 'pin' | 'key' }
  const gridRef = useRef(null);
  const tipRef = useRef(null);
  const cells = useRef([]);
  const pointer = useRef({ type: 'mouse', at: 0 });

  // place the tooltip next to the active cell; keep it there on scroll/resize
  useLayoutEffect(() => {
    if (!active || !tipRef.current) return;
    const el = cells.current[active.d * 24 + active.h];
    if (el) placeFloating(el.getBoundingClientRect(), tipRef.current, { side: 'top', offset: 8 });
  });
  useEffect(() => {
    if (!active) return undefined;
    const place = () => {
      const el = cells.current[active.d * 24 + active.h];
      if (el && tipRef.current) placeFloating(el.getBoundingClientRect(), tipRef.current, { side: 'top', offset: 8 });
    };
    const onDown = (e) => {
      if (active.mode === 'pin' && gridRef.current && !gridRef.current.contains(e.target)) setActive(null);
    };
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [active]);

  const cellAt = (d, h) => (grid[d] && grid[d][h]) || { cost: 0, tokens: 0, messages: 0 };
  const cellText = (d, h) => {
    const c = cellAt(d, h);
    return `${DAY_NAMES[d]} ${hourRange(h)}: ${money(c.cost)}, ${tokens(c.tokens)} tokens, ${num(c.messages)} msgs`;
  };

  function onKeyDown(e) {
    const cur = active || busiest || { d: 0, h: 0 };
    let { d, h } = cur;
    switch (e.key) {
      case 'ArrowRight': h = Math.min(23, h + 1); break;
      case 'ArrowLeft': h = Math.max(0, h - 1); break;
      case 'ArrowDown': d = Math.min(6, d + 1); break;
      case 'ArrowUp': d = Math.max(0, d - 1); break;
      case 'Home': h = 0; break;
      case 'End': h = 23; break;
      case 'Escape':
        if (active) { e.preventDefault(); e.stopPropagation(); setActive(null); }
        return;
      default: return;
    }
    e.preventDefault();
    setActive({ d, h, mode: 'key' });
  }

  const act = active ? cellAt(active.d, active.h) : null;
  const activeId = active ? `${uid}-c${active.d}-${active.h}` : undefined;
  const bc = busiest ? cellAt(busiest.d, busiest.h) : null;

  return (
    <>
      <div
        ref={gridRef}
        className="hm"
        role="grid"
        tabIndex={0}
        aria-label={`${isMsgs ? 'Messages' : 'Spend'} by weekday and hour, local time. Use the arrow keys to read each hour.`}
        aria-activedescendant={activeId}
        onKeyDown={onKeyDown}
        onPointerDownCapture={(e) => { pointer.current = { type: e.pointerType || 'mouse', at: Date.now() }; }}
        onFocus={() => {
          // a tap/click also focuses the grid — let the pointer decide, not focus
          if (Date.now() - pointer.current.at < 600) return;
          if (!active && busiest) setActive({ ...busiest, mode: 'key' });
        }}
        onBlur={(e) => {
          if (active && active.mode === 'key' && !(gridRef.current && gridRef.current.contains(e.relatedTarget))) setActive(null);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === 'mouse' && active && active.mode === 'hover') setActive(null);
        }}
      >
        <span aria-hidden="true" />
        <div className="hm-top" aria-hidden="true">
          {colTot.map((v, h) => (
            <i
              key={h}
              className={active && active.h === h ? 'on' : undefined}
              style={{ height: v > 0 ? Math.max(4, (v / (colMax || 1)) * 100).toFixed(1) + '%' : 0 }}
            />
          ))}
        </div>
        <span className="hm-t hm-tot" aria-hidden="true">total</span>

        {grid.map((row, d) => (
          <HmRow
            key={d}
            d={d}
            row={row}
            uid={uid}
            max={max}
            val={val}
            busiest={busiest}
            active={active}
            total={fmtShort(rowTot[d])}
            cells={cells}
            cellText={cellText}
            onHover={(h) => { if (!active || active.mode !== 'pin') setActive({ d, h, mode: 'hover' }); }}
            onTap={(h) => {
              if (pointer.current.type === 'mouse') { setActive({ d, h, mode: 'hover' }); return; }
              setActive((a) => (a && a.mode === 'pin' && a.d === d && a.h === h ? null : { d, h, mode: 'pin' }));
            }}
          />
        ))}

        <span aria-hidden="true" />
        <div className="hm-x" aria-hidden="true">
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} className={cx(h % 6 === 3 && 'alt', active && active.h === h && 'on')}>{h % 3 === 0 ? hourLab(h) : ''}</span>
          ))}
        </div>
        <span aria-hidden="true" />
      </div>

      <div className="hm-foot">
        <div className="hm-legend" aria-hidden="true">
          Less
          {[1, 2, 3, 4, 5, 6, 7].map((i) => <i key={i} style={{ background: `var(--q${i})` }} />)}
          More · peak {fmtFull(max)}/h
        </div>
        {bc ? (
          <div className="hint">
            Busiest: <b>{WEEKDAYS[busiest.d]} {hourRange(busiest.h)}</b>
            {' · '}{isMsgs ? `${num(bc.messages)} msgs · ${money(bc.cost)}` : `${money(bc.cost)} · ${num(bc.messages)} msgs`}
          </div>
        ) : null}
      </div>

      {active && act ? createPortal(
        <div ref={tipRef} role="presentation" aria-hidden="true" className="rtip floating act-hmtip">
          <div className="act-hmtip-h">{WEEKDAYS[active.d]} {hourRange(active.h)}</div>
          <dl>
            <div><dt>Spend</dt><dd>{money(act.cost)}</dd></div>
            <div><dt>Tokens</dt><dd>{tokens(act.tokens)}</dd></div>
            <div><dt>Messages</dt><dd>{num(act.messages)}</dd></div>
          </dl>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

function HmRow({ d, row, uid, max, val, busiest, active, total, cells, cellText, onHover, onTap }) {
  return (
    <>
      <span className={cx('hm-d', active && active.d === d && 'on')} aria-hidden="true">{WEEKDAYS[d]}</span>
      <div className="hm-row" role="row" aria-label={DAY_NAMES[d]}>
        {Array.from({ length: 24 }, (_, h) => {
          const c = row && row[h];
          const b = binOf(val(c), max);
          const isActive = active && active.d === d && active.h === h;
          return (
            <i
              key={h}
              id={`${uid}-c${d}-${h}`}
              ref={(el) => { cells.current[d * 24 + h] = el; }}
              role="gridcell"
              aria-label={cellText(d, h)}
              aria-selected={isActive || undefined}
              className={cx(busiest && busiest.d === d && busiest.h === h && 'hl', isActive && 'on')}
              style={b ? { background: `var(--q${b})` } : undefined}
              onPointerEnter={(e) => { if (e.pointerType === 'mouse') onHover(h); }}
              onClick={() => onTap(h)}
            />
          );
        })}
      </div>
      <span className="hm-t" aria-hidden="true">{total}</span>
    </>
  );
}

// ---- sessions ------------------------------------------------------------------
// "pulse · Fix the parser… · 295a1512" → { proj: 'pulse', text: 'Fix the parser…', id: '295a1512' }.
// The server builds [project, prompt, shortId].join(' · '), where shortId is the
// sessionId's first 8 chars; a Claude Desktop session sends its own title.
function splitTitle(s) {
  const title = String(s.title || '');
  const sid = String(s.sessionId || '');
  const short = sid.slice(0, 8);
  const id = /^[0-9a-f]{8}$/i.test(short) ? short : '';
  let rest = null;
  if (short && title === short) rest = '';
  else if (short && title.endsWith(' · ' + short)) rest = title.slice(0, -(short.length + 3));
  if (rest == null) return { proj: '', text: title || sid, id }; // free-text (Claude Desktop) title
  let proj = '', text = rest;
  const i = rest.indexOf(' · ');
  if (i >= 0) { proj = rest.slice(0, i); text = rest.slice(i + 3); }
  else if (rest && !/\s/.test(rest)) { proj = rest; text = ''; } // lone folder name
  if (!proj && !text && !id) text = title || sid;
  return { proj, text, id };
}

const effortRank = (lv) => EFFORT_LEVELS.indexOf(lv);
function sessionEffort(s) {
  const levels = (s.efforts || []).slice().sort((a, b) => effortRank(b) - effortRank(a));
  const top = s.ultracode ? 'ultracode' : levels[0] || null;
  const others = s.ultracode ? levels : levels.slice(1);
  const fast = (s.speeds || []).includes('fast');
  return { top, others, levels, fast };
}

function SrcMark({ source, colorMap }) {
  if (source === 'mixed') return <i className="sw act-mixed" aria-hidden="true" />;
  return <Swatch color={colorMap.get(source)} />;
}

function ModelsCell({ models }) {
  const list = models || [];
  if (!list.length) return <span className="muted">—</span>;
  const m0 = list[0];
  const inner = (
    <>
      <ModelLogo model={m0} size={14} title="" />
      <span className="mname">{prettyModel(m0) || m0}</span>
      {list.length > 1 ? <span className="more-m">+{list.length - 1}</span> : null}
    </>
  );
  if (list.length < 2) return <span className="models" title={m0}>{inner}</span>;
  return (
    <Tip
      content={(
        <div className="act-tip-list">
          {list.map((m) => (
            <div key={m}><ModelLogo model={m} size={12} title="" /><span>{prettyModel(m) || m}</span><code>{m}</code></div>
          ))}
        </div>
      )}
    >
      <span className="models" tabIndex={0} aria-label={'Models: ' + list.map((m) => prettyModel(m) || m).join(', ')}>{inner}</span>
    </Tip>
  );
}

function EffortCell({ s, compact }) {
  const { top, others, levels, fast } = sessionEffort(s);
  if (!top && !fast) return compact ? null : <span className="muted" aria-label="No effort recorded">—</span>;
  const body = (
    <span className="act-eff" tabIndex={!compact && others.length ? 0 : undefined}>
      {top ? <EffortLabel level={top} /> : null}
      {fast ? <FastChip title="Fast mode" /> : null}
      {others.length ? <span className="more-m" title={others.map(effortLabel).join(', ')}>+{others.length}</span> : null}
    </span>
  );
  if (compact || !others.length) return body;
  return (
    <Tip
      content={(
        <div>
          <b>Effort levels in this session</b>
          <div>{[s.ultracode ? 'Ultracode' : null, ...levels.map(effortLabel)].filter(Boolean).join(' · ')}</div>
          {fast ? <div className="muted">Some messages ran in fast mode</div> : null}
        </div>
      )}
    >
      {body}
    </Tip>
  );
}

function SessionsTable({ sessions, meta, estimated, colorMap }) {
  const phone = useMedia(BP.sm);
  const [shown, toggle] = useClamp(sessions, phone ? 6 : 12, 'sessions');
  const est = new Set(estimated || []);
  const label = (src) => (src === 'mixed' ? 'Mixed' : srcLabel(src, meta));
  return (
    <>
      <div className="act-cq">
        <div className="tbl tbl-sess" role="table" aria-label="Recent sessions">
          <div className="tr th" role="row">
            <span role="columnheader">Session</span>
            <span role="columnheader">Source</span>
            <span role="columnheader">Model</span>
            <span role="columnheader">Effort</span>
            <span role="columnheader" className="r">Cost</span>
            <span role="columnheader" className="r c-tok">Tokens</span>
            <span role="columnheader" className="r c-msg">Msgs</span>
            <span role="columnheader" className="r">Last</span>
          </div>
          {shown.map((s) => {
            const { proj, text, id } = splitTitle(s);
            const src = label(s.source);
            const last = s.lastTs ? new Date(s.lastTs).toLocaleString() : '';
            return (
              <div className="tr" role="row" key={s.sessionId}>
                <span className="sess-t c-t" role="cell" title={`${s.title}\n${s.sessionId}`}>
                  {proj ? <span className="proj">{proj}</span> : null}
                  {text ? <span className="t">{text}</span> : null}
                  {id ? <span className="id">{id}</span> : null}
                </span>
                <span className="srcl c-src" role="cell" title={s.source === 'mixed' ? 'More than one source wrote to this session' : s.source}>
                  <SrcMark source={s.source} colorMap={colorMap} />
                  <span className="ellip">{src}</span>
                  {est.has(s.source) ? <Est /> : null}
                </span>
                <span className="c-mod" role="cell"><ModelsCell models={s.models} /></span>
                <span className="c-eff" role="cell"><EffortCell s={s} /></span>
                <span className="r c-c" role="cell">{money(s.cost)}</span>
                <span className="r muted c-tok" role="cell">{tokens(s.tokens)}</span>
                <span className="r muted c-msg" role="cell">{num(s.messages)}</span>
                <span className="r ago c-ago" role="cell" title={last}>{s.lastTs ? ago(s.lastTs) : '—'}</span>
                {/* phone card (≤760): one meta line under the title; hidden on desktop */}
                <span className="sess-meta" role="cell">
                  <span className="srcl"><SrcMark source={s.source} colorMap={colorMap} />{src}{est.has(s.source) ? <Est /> : null}</span>
                  {s.models && s.models.length ? (
                    <span className="models">{prettyModel(s.models[0]) || s.models[0]}{s.models.length > 1 ? ` +${s.models.length - 1}` : ''}</span>
                  ) : null}
                  <EffortCell s={s} compact />
                  <span className="ago">{s.lastTs ? ago(s.lastTs) : ''}</span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {toggle}
    </>
  );
}

export default function Activity({ id, data, period, srcFilter, colorMap }) {
  const [metric, setMetric] = useState('cost');
  const hm = data.heatmap;
  const sessions = data.recentSessions || [];
  const showHm = hm && Array.isArray(hm.grid) && hm.maxCost > 0;
  let hmTotal = 0, hmMsgs = 0;
  if (showHm) hm.grid.forEach((r) => (r || []).forEach((c) => { hmTotal += (c && c.cost) || 0; hmMsgs += (c && c.messages) || 0; }));
  return (
    <Section id={id} title="Activity">
      {showHm && (
        <Panel
          span={12}
          className="act-hm"
          title="When you work"
          ctx={`live logs · local time · ${metric === 'messages' ? num(hmMsgs) + ' msgs' : money(hmTotal)}`}
          info="Spend (or messages) by local weekday and hour, across the sessions still in your logs — archived days keep no hourly detail. Darker = more in that hour; bars on top and the right column are the hour and weekday totals. Hover or tap a cell for the details."
          actions={<Seg options={METRICS} value={metric} onChange={setMetric} label="Heatmap metric" />}
        >
          <Heatmap hm={hm} metric={metric} />
        </Panel>
      )}
      <Panel
        span={12}
        className="act-sess"
        title="Recent sessions"
        ctx={`latest ${sessions.length} across all periods · title = project · first prompt · session id`}
        actions={(
          <Btn size="sm" icon="download" href={exportHref({ format: 'csv', data: 'sessions' }, period && period.key, srcFilter)} download="" title="Download the recent sessions as CSV">
            CSV
          </Btn>
        )}
      >
        {sessions.length
          ? <SessionsTable sessions={sessions} meta={data.sourceMeta} estimated={data.estimatedSources} colorMap={colorMap} />
          : <Empty icon="list" title="No sessions yet">Sessions appear here as soon as a Claude Code or Codex session writes to its log.</Empty>}
      </Panel>
    </Section>
  );
}
