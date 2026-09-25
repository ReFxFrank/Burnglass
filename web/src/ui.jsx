// =============================================================================
// ui.jsx — shared React primitives for the Command Center dashboard.
// Every colour comes from CSS tokens (styles.css); nothing here
// animates on its own; floating layers (tooltips, menus, sheets) are portalled
// to <body> and positioned with plain fixed coordinates — no blur, no library.
// =============================================================================
import { Children, cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons.jsx';
import { BRAND, effortBars, effortLabel, meterTone, num, postJson } from './lib.js';

// className joiner: cx('a', cond && 'b') → "a b"
export function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

function mergeRefs(...refs) {
  return (node) => {
    for (const r of refs) {
      if (typeof r === 'function') r(node);
      else if (r && typeof r === 'object') r.current = node;
    }
  };
}

// ---- floating placement ----------------------------------------------------
// Places a position:fixed element next to an anchor rect: preferred `side`
// ('top' | 'bottom'), flips when there is not enough room, and clamps into the
// viewport so nothing ever causes horizontal scroll.
export function placeFloating(anchorRect, el, { side = 'top', align = 'center', offset = 8, margin = 8 } = {}) {
  if (!el || !anchorRect) return;
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = window.innerHeight;
  const w = el.offsetWidth, h = el.offsetHeight;
  let s = side;
  const above = anchorRect.top, below = vh - anchorRect.bottom;
  if (s === 'top' && above < h + offset + margin && below > above) s = 'bottom';
  else if (s === 'bottom' && below < h + offset + margin && above > below) s = 'top';
  let top = s === 'top' ? anchorRect.top - h - offset : anchorRect.bottom + offset;
  let left = align === 'start' ? anchorRect.left
    : align === 'end' ? anchorRect.right - w
      : anchorRect.left + anchorRect.width / 2 - w / 2;
  left = Math.max(margin, Math.min(left, vw - w - margin));
  top = Math.max(margin, Math.min(top, vh - h - margin));
  el.style.left = Math.round(left) + 'px';
  el.style.top = Math.round(top) + 'px';
  el.setAttribute('data-side', s);
}

// ---- layout ------------------------------------------------------------------
// A dashboard section: its own 12-column grid, an optional uppercase group
// label with a hairline (and right-aligned meta), and the anchor the rail nav
// scrolls to. Root gets class "sec sec-<id>" — scope section CSS under it.
export function Section({ id, title, meta, className, children }) {
  const hid = id ? id + '-h' : undefined;
  return (
    <section id={id} className={cx('sec', id && 'sec-' + id, className)} aria-labelledby={title ? hid : undefined}>
      {title && (
        <h2 className="grp" id={hid}>
          <span>{title}</span>
          {meta ? <span className="grp-meta">{meta}</span> : null}
        </h2>
      )}
      {children}
    </section>
  );
}

// Accessible name for a panel/KPI ⓘ: "About Budget · this month" (a generic
// "More info" repeated a dozen times is useless in a screen-reader list).
function aboutLabel(title) {
  return typeof title === 'string' && title ? 'About ' + title : 'More info';
}

// Panel = the one card surface. span → grid column span inside a Section
// (3|4|5|6|7|8|12). `flush` renders children edge-to-edge (no .pb padding).
export function Panel({
  title, info, ctx, actions, footer, span, flush, id, className, bodyClassName,
  headClassName, titleAs: T = 'h3', children, ...rest
}) {
  const hasHead = title || ctx || actions;
  return (
    <div id={id} className={cx('panel', span && 'c-' + span, className)} {...rest}>
      {hasHead && (
        <div className={cx('ph', headClassName)}>
          {title && <T className="pt">{title}{info ? <InfoTip text={info} label={aboutLabel(title)} /> : null}</T>}
          {ctx ? <span className="ctx">{ctx}</span> : null}
          {actions ? <><span className="sp" /><div className="pa">{actions}</div></> : null}
        </div>
      )}
      {flush ? children : <div className={cx('pb', bodyClassName)}>{children}</div>}
      {footer ? <div className="pf">{footer}</div> : null}
    </div>
  );
}

// ---- buttons -------------------------------------------------------------------
// variant: undefined (default) | 'ghost' | 'primary' | 'danger'
// size:    undefined (30 px)   | 'sm' (26 px)
// href → renders an <a> with the same look. No children + icon → square icon button.
export function Btn({ variant, size, icon, iconRight, block, href, className, children, type = 'button', ref, ...rest }) {
  const iconOnly = icon && (children == null || children === false || children === '');
  const cls = cx('btn', variant, size, block && 'block', iconOnly && 'icon', className);
  const isz = size === 'sm' ? 12 : 14;
  const inner = (
    <>
      {icon ? <Icon name={icon} size={isz} /> : null}
      {children}
      {iconRight ? <Icon name={iconRight} size={12} className="caret" /> : null}
    </>
  );
  if (href != null) return <a ref={ref} className={cls} href={href} {...rest}>{inner}</a>;
  return <button ref={ref} type={type} className={cls} {...rest}>{inner}</button>;
}

// Square icon-only button. `label` is REQUIRED (aria-label + tooltip title).
export function IconBtn({ icon, label, title, ...rest }) {
  return <Btn icon={icon} aria-label={label} title={title || label} {...rest} />;
}

// Accessible on/off switch (role="switch"). onChange(nextChecked).
export function Switch({ checked, onChange, disabled, label, busy, className, ...rest }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled}
      className={cx('switch', checked && 'on', busy && 'busy', className)}
      onClick={() => onChange && onChange(!checked)}
      {...rest}
    />
  );
}

// Segmented control = single-choice radiogroup with roving focus (arrows,
// Home/End). options: ['a','b'] or [{ value, label, icon?, title? }].
export function Seg({ options, value, onChange, label, size, className }) {
  const opts = (options || []).map((o) => (typeof o === 'object' ? o : { value: o, label: o }));
  const refs = useRef([]);
  const cur = opts.findIndex((o) => o.value === value);
  function onKey(e, i) {
    const n = opts.length;
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % n;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next == null) return;
    e.preventDefault();
    onChange && onChange(opts[next].value);
    if (refs.current[next]) refs.current[next].focus();
  }
  return (
    <div role="radiogroup" aria-label={label} className={cx('seg', size, className)}>
      {opts.map((o, i) => (
        <button
          key={String(o.value)}
          ref={(el) => { refs.current[i] = el; }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value || (cur < 0 && i === 0) ? 0 : -1}
          className={o.value === value ? 'on' : undefined}
          title={o.title}
          onClick={() => onChange && onChange(o.value)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {o.icon ? <Icon name={o.icon} size={12} /> : null}
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---- form fields ---------------------------------------------------------------
export function Input({ mono, className, ref, ...rest }) {
  return <input ref={ref} className={cx('input', mono && 'mono', className)} {...rest} />;
}
// Input with a fixed prefix/suffix ("$ [____] /mo"). Remaining props go to <input>.
export function InputGroup({ prefix, suffix, className, mono, ref, ...inputProps }) {
  return (
    <div className={cx('inputgrp', mono && 'mono', className)}>
      {prefix != null ? <span className="ig-x">{prefix}</span> : null}
      <input ref={ref} {...inputProps} />
      {suffix != null ? <span className="ig-x">{suffix}</span> : null}
    </div>
  );
}
// Label above a control, optional hint below.
export function Field({ label, htmlFor, hint, className, children }) {
  return (
    <div className={cx('field', className)}>
      {label ? <label htmlFor={htmlFor}>{label}</label> : null}
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

// ---- small marks -------------------------------------------------------------------
// tone: undefined | 'good' | 'warn' | 'crit' | 'accent'
export function Badge({ tone, icon, className, children, ...rest }) {
  return (
    <span className={cx('badge', tone, className)} {...rest}>
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}
// Rounded pill (top-bar chips). href → link. tone: undefined | 'accent'.
export function Pill({ tone, icon, href, className, children, ...rest }) {
  const cls = cx('pill', tone, className);
  const inner = <>{icon ? <Icon name={icon} size={12} /> : null}{children}</>;
  if (href != null) return <a className={cls} href={href} {...rest}>{inner}</a>;
  return <span className={cls} {...rest}>{inner}</span>;
}
// Colour swatch for a SOURCE (color = colorMap.get(src), a var(--sN) string).
export function Swatch({ color, className }) {
  return <i className={cx('sw', className)} style={{ background: color }} aria-hidden="true" />;
}
// "est" marker for locally-estimated sources (payload.estimatedSources).
export function Est({ title = 'Local estimate, not provider billing' }) {
  return <span className="est" title={title}>est</span>;
}
// Change chip: ▲ 49.7% (amber) / ▼ 12.0% (green) / ±0% (flat).
// By default an INCREASE reads as a warning (more spend); invert for metrics
// where up is good.
export function Delta({ pct, digits = 1, invert = false, title, className }) {
  if (pct == null || !isFinite(pct)) return null;
  const flat = Math.abs(pct) < 0.5;
  const up = pct > 0;
  const tone = flat ? 'flat' : (up !== invert ? 'warn' : 'good');
  return (
    <span className={cx('delta', tone, className)} title={title}>
      {flat ? null : <Icon name={up ? 'caretup' : 'caretdown'} size={12} />}
      {flat ? '±0%' : Math.abs(pct).toFixed(digits) + '%'}
    </span>
  );
}
// 5-bar effort "signal" glyph (never colour-only).
export function Signal({ level }) {
  const n = effortBars(level);
  return (
    <span className="sig" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((i) => <i key={i} className={i <= n ? 'on' : undefined} />)}
    </span>
  );
}
// Effort level as signal + text ("▮▮▯▯▯ Medium"); ultracode adds a spark.
export function EffortLabel({ level, className }) {
  const lv = level || 'default';
  const ultra = lv === 'ultracode' || lv === 'ultra';
  return (
    <span className={cx('efflab', ultra && 'ultra', className)}>
      <Signal level={ultra ? 'ultracode' : lv} />
      {effortLabel(ultra ? 'ultracode' : lv)}
      {ultra ? <Icon name="spark" size={12} className="ustar" /> : null}
    </span>
  );
}
// Fast-mode chip: bolt + optional message count.
export function FastChip({ count, title = 'Fast mode' }) {
  return (
    <span className="fastchip" title={count != null ? `${num(count)} fast-mode msgs` : title}>
      <Icon name="bolt" size={12} />
      {count != null ? num(count) : null}
    </span>
  );
}

// ---- data marks --------------------------------------------------------------------
// KPI tile shell. facts = [[label, value], …] rendered as a key/value list.
// hero → the wide period tile (grid areas l/v/s/d/f: put a <Spark className="spark">,
// a <div className="kpi-s kpi-d"> and a <div className="kpi-s kpi-facts"> in children).
export function Kpi({ label, info, badge, value, unit, sub, facts, hero, className, children, ...rest }) {
  return (
    <div className={cx('kpi', hero && 'kpi-hero', className)} {...rest}>
      <div className="kpi-l">
        <span className="kpi-lt">{label}</span>
        {info ? <InfoTip text={info} label={aboutLabel(label)} /> : null}
        {badge || null}
      </div>
      {value != null ? <div className="kpi-v">{value}{unit ? <small>{unit}</small> : null}</div> : null}
      {sub ? <div className="kpi-s">{sub}</div> : null}
      {facts && facts.length ? (
        <dl className="kfacts">
          {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
      ) : null}
      {children}
    </div>
  );
}

// Line sparkline (10% area + end dot). values = numbers, oldest first.
// cap = [leftText, rightText] caption under it.
export function Spark({ values, height = 40, color = 'var(--accent)', area = true, dot = true, label, cap, className }) {
  const vals = (values || []).map((v) => (isFinite(v) ? Number(v) : 0));
  const W = 300, H = Math.max(8, height);
  if (vals.length < 2) return <div className={cx('spark', className)} style={{ height: H }} aria-hidden="true" />;
  const max = Math.max(...vals, 0) * 1.08 || 1;
  const pts = vals.map((v, i) => [(i / (vals.length - 1)) * W, H - (Math.max(0, v) / max) * H]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const fill = line + ` L${W} ${H} L0 ${H} Z`;
  const last = pts[pts.length - 1];
  return (
    <div className={cx('spark', className)}>
      <div className="spark-wrap">
        <svg
          className="spark-svg"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          style={{ height: H }}
          role={label ? 'img' : undefined}
          aria-label={label}
          aria-hidden={label ? undefined : true}
        >
          {area ? <path d={fill} fill={color} opacity=".10" /> : null}
          <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
        {dot ? <span className="spark-dot" style={{ top: ((last[1] / H) * 100).toFixed(1) + '%', background: color }} /> : null}
      </div>
      {cap ? <div className="spark-cap"><span>{cap[0]}</span><span>{cap[1]}</span></div> : null}
    </div>
  );
}

// Magnitude bar (value / max) on a track — model / project / effort rows.
// color defaults to var(--bar) (neutral violet). hatch → ultracode style.
export function MBar({ value, max, color, hatch, label, className }) {
  const f = max > 0 ? Math.max(0, Math.min(1, (value || 0) / max)) : 0;
  const w = value > 0 ? Math.max(0.6, f * 100) : 0;
  return (
    <span className={cx('mag-track', className)} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <span className={cx('mag', hatch && 'hatch')} style={{ width: w.toFixed(2) + '%', ...(color ? { backgroundColor: color } : null) }} />
    </span>
  );
}

// Meter bar for a usage limit (% used): fill, hatched projection to `proj`
// (% used expected at reset = 100 - projLeftAtReset), and tick marks at the
// alert thresholds. tone defaults from the thresholds ('' | 'warn' | 'crit').
export function MeterBar({ pct, proj, thresholds = [80, 95], tone, label, stale, className }) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const t = tone != null ? tone : meterTone(pct, thresholds);
  const pr = proj != null && isFinite(proj) && proj > p ? Math.min(100, proj) : null;
  return (
    <div
      className={cx('meter', t, stale && 'stale', className)}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(p)}
      aria-label={label}
    >
      <i className="f" style={{ width: p.toFixed(1) + '%' }} />
      {pr != null ? <i className="p" style={{ left: p.toFixed(1) + '%', width: (pr - p).toFixed(1) + '%' }} /> : null}
      {thresholds.map((th) => <i key={th} className="t" style={{ left: th + '%' }} />)}
    </div>
  );
}

// ---- tooltips ------------------------------------------------------------------------
// Generic tooltip around ONE element child (DOM element or a component that
// forwards ref + DOM props). Mouse: hover. Keyboard: focus. Touch: tap to
// open/close, tap elsewhere to close. Esc and scrolling close it.
export function Tip({ content, children, side = 'top', align = 'center', delay = 150, className }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef(null);
  const tip = useRef(null);
  const timer = useRef(0);
  const pinned = useRef(false);
  const lastPointer = useRef('mouse');
  const id = useId();

  const show = (d) => {
    clearTimeout(timer.current);
    if (d > 0) timer.current = setTimeout(() => setOpen(true), d);
    else setOpen(true);
  };
  const hide = () => { clearTimeout(timer.current); pinned.current = false; setOpen(false); };

  useLayoutEffect(() => {
    if (open && anchor.current && tip.current) {
      placeFloating(anchor.current.getBoundingClientRect(), tip.current, { side, align, offset: 8 });
    }
  });
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if ((anchor.current && anchor.current.contains(e.target)) || (tip.current && tip.current.contains(e.target))) return;
      hide();
    };
    const onKey = (e) => { if (e.key === 'Escape') hide(); };
    // Follow the anchor on scroll/resize (Tab focusing an off-screen trigger
    // scrolls the page AFTER the focus event, so hiding here would close a
    // keyboard-opened tip instantly); close only once the anchor has left view.
    const onScroll = () => {
      const a = anchor.current;
      if (!a || !tip.current) return;
      const r = a.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight || (!r.width && !r.height)) { hide(); return; }
      placeFloating(r, tip.current, { side, align, offset: 8 });
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);
  useEffect(() => () => clearTimeout(timer.current), []);

  if (content == null || content === '' || !isValidElement(children)) return children || null;
  const child = Children.only(children);
  const p = child.props || {};
  const call = (fn, e) => { if (typeof fn === 'function') fn(e); };
  const trigger = cloneElement(child, {
    ref: mergeRefs(p.ref, anchor),
    'aria-describedby': open ? id : p['aria-describedby'],
    onPointerEnter: (e) => { call(p.onPointerEnter, e); if (e.pointerType === 'mouse') show(delay); },
    onPointerLeave: (e) => { call(p.onPointerLeave, e); if (e.pointerType === 'mouse' && !pinned.current) hide(); },
    onPointerDown: (e) => { call(p.onPointerDown, e); lastPointer.current = e.pointerType || 'mouse'; },
    onFocus: (e) => { call(p.onFocus, e); show(0); },
    onBlur: (e) => { call(p.onBlur, e); if (!pinned.current) hide(); },
    onClick: (e) => {
      call(p.onClick, e);
      const keyboard = e.detail === 0;
      if (keyboard || lastPointer.current !== 'mouse') {
        if (open && pinned.current) hide();
        else { pinned.current = true; show(0); }
      }
    },
  });
  return (
    <>
      {trigger}
      {open ? createPortal(
        <div ref={tip} id={id} role="tooltip" className={cx('rtip', 'floating', className)}>{content}</div>,
        document.body,
      ) : null}
    </>
  );
}

// ⓘ info button with a tooltip (hover, focus, or tap on touch).
// Legacy form <InfoTip text="…"><el/></InfoTip> wraps any element instead.
export function InfoTip({ text, children, label = 'More info', side = 'top', size = 14 }) {
  if (children) return <Tip content={text} side={side}>{children}</Tip>;
  return (
    <Tip content={text} side={side}>
      <button type="button" className="infoi" aria-label={label}>
        <Icon name="info" size={size} />
      </button>
    </Tip>
  );
}

// ---- menu ------------------------------------------------------------------------------
// Keyboard-navigable dropdown (menu button pattern): Enter/Space/↓ opens on the
// first item, ↑ on the last; ↑/↓/Home/End move; Esc closes and refocuses the
// trigger; Tab closes. items: [
//   { label, hint?, href?, download?, onSelect?, disabled? }   ← actionable
//   { header: 'CSV · Last 30 days' } | { separator: true }      ← decoration
// ]
export function Menu({ label, icon, items, align = 'end', header, variant, size = 'sm', iconRight = 'down', className, menuClassName, title }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const menu = useRef(null);
  const itemEls = useRef({});
  const focusIdx = useRef(-1);
  const menuId = useId();
  const btnId = useId();
  const list = items || [];
  const actionable = list.map((it, i) => (it && !it.separator && !it.header && !it.disabled ? i : -1)).filter((i) => i >= 0);

  const openAt = (which) => {
    focusIdx.current = which === 'last' ? actionable[actionable.length - 1] : actionable[0];
    setOpen(true);
  };
  const close = (refocus) => {
    setOpen(false);
    if (refocus && btn.current) btn.current.focus();
  };

  useLayoutEffect(() => {
    if (!open || !btn.current || !menu.current) return;
    placeFloating(btn.current.getBoundingClientRect(), menu.current, { side: 'bottom', align, offset: 6 });
    const el = itemEls.current[focusIdx.current];
    if (el) el.focus();
  }, [open, align]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if ((btn.current && btn.current.contains(e.target)) || (menu.current && menu.current.contains(e.target))) return;
      setOpen(false);
    };
    const onMove = () => {
      if (btn.current && menu.current) placeFloating(btn.current.getBoundingClientRect(), menu.current, { side: 'bottom', align, offset: 6 });
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, align]);

  function move(dir) {
    if (!actionable.length) return;
    const cur = Number(document.activeElement && document.activeElement.getAttribute('data-idx'));
    const pos = actionable.indexOf(cur);
    const next = dir === 'first' ? actionable[0]
      : dir === 'last' ? actionable[actionable.length - 1]
        : actionable[((pos < 0 ? 0 : pos) + dir + actionable.length) % actionable.length];
    const el = itemEls.current[next];
    if (el) el.focus();
  }
  function onMenuKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); move('first'); }
    else if (e.key === 'End') { e.preventDefault(); move('last'); }
    else if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'Tab') { setOpen(false); }
  }
  function onBtnKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAt('first'); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); openAt('last'); }
  }
  function pick(it) {
    if (it.onSelect) it.onSelect();
    // defer the close so a download link's default action runs first
    setTimeout(() => close(true), 0);
  }

  return (
    <>
      <Btn
        ref={btn}
        id={btnId}
        variant={variant}
        size={size}
        icon={icon}
        iconRight={iconRight}
        className={className}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? setOpen(false) : openAt('first'))}
        onKeyDown={onBtnKey}
      >
        {label}
      </Btn>
      {open ? createPortal(
        <div ref={menu} id={menuId} role="menu" aria-labelledby={btnId} className={cx('menu', 'floating', menuClassName)} onKeyDown={onMenuKey}>
          {header ? <div className="menu-h" role="presentation">{header}</div> : null}
          {list.map((it, i) => {
            if (!it) return null;
            if (it.separator) return <div key={'s' + i} className="menu-sep" role="separator" />;
            if (it.header) return <div key={'h' + i} className="menu-h" role="presentation">{it.header}</div>;
            const inner = <><span className="menu-l">{it.label}</span>{it.hint ? <span className="k">{it.hint}</span> : null}</>;
            const common = {
              ref: (el) => { itemEls.current[i] = el; },
              role: 'menuitem',
              tabIndex: -1,
              'data-idx': i,
              className: 'menu-i',
              'aria-disabled': it.disabled || undefined,
            };
            if (it.href && !it.disabled) {
              return <a key={i} {...common} href={it.href} download={it.download} onClick={() => pick(it)}>{inner}</a>;
            }
            return <button key={i} {...common} type="button" disabled={it.disabled} onClick={() => pick(it)}>{inner}</button>;
          })}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

// ---- bottom sheet (phones) ------------------------------------------------------------
// Modal dialog anchored to the bottom: backdrop click / Esc / close button
// dismiss; Tab is trapped inside; focus returns to the opener; page scroll is
// locked while open.
export function Sheet({ open, onClose, title, children, footer, className }) {
  const panel = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const prevFocus = document.activeElement;
    const root = document.documentElement;
    const prevOverflow = root.style.overflow;
    root.style.overflow = 'hidden';
    const focusables = () => Array.from(panel.current ? panel.current.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) : []).filter((el) => el.tabIndex >= 0 && (el.offsetParent !== null || el === document.activeElement));
    const first = focusables().find((el) => el.getAttribute('aria-checked') === 'true') || focusables()[1] || focusables()[0];
    if (first) first.focus(); else if (panel.current) panel.current.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCloseRef.current && onCloseRef.current(); return; }
      if (e.key !== 'Tab') return;
      const els = focusables();
      if (!els.length) { e.preventDefault(); return; }
      const i = els.indexOf(document.activeElement);
      if (e.shiftKey && (i <= 0)) { e.preventDefault(); els[els.length - 1].focus(); }
      else if (!e.shiftKey && (i === els.length - 1 || i < 0)) { e.preventDefault(); els[0].focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      root.style.overflow = prevOverflow;
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="sheet-root">
      <div className="sheet-backdrop" onClick={() => onCloseRef.current && onCloseRef.current()} aria-hidden="true" />
      <div ref={panel} className={cx('sheet', className)} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-h">
          <h2 id={titleId}>{title}</h2>
          <IconBtn icon="close" label="Close" variant="ghost" onClick={() => onCloseRef.current && onCloseRef.current()} />
        </div>
        <div className="sheet-b">{children}</div>
        {footer ? <div className="sheet-f">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

// ---- states ---------------------------------------------------------------------------
// Amber (or red, tone="crit") status strip for page-level warnings.
// tone: undefined (warn) | 'crit' | 'info' (neutral accent — a notice, not a
// problem; amber/red stay reserved for status).
export function WarnBar({ tone, children, action, className, icon }) {
  return (
    <div className={cx('warnbar', tone === 'crit' && 'critbar', tone === 'info' && 'infobar', className)} role="status">
      <Icon name={icon || (tone === 'info' ? 'info' : 'alert')} />
      <div className="wb-body">{children}</div>
      {action || null}
    </div>
  );
}
// Centered empty / whole-page state inside a panel.
export function Empty({ icon = 'chart', title, children, action, className }) {
  return (
    <div className={cx('empty', className)}>
      {icon ? <Icon name={icon} /> : null}
      {title ? <h4>{title}</h4> : null}
      {children ? <div className="hint">{children}</div> : null}
      {action ? <div className="empty-act">{action}</div> : null}
    </div>
  );
}

// "Show all N" clamp for long lists: const [shown, toggle] = useClamp(rows, 8, 'models')
export function useClamp(rows, limit = 8, noun) {
  const [open, setOpen] = useState(false);
  const list = rows || [];
  const more = list.length - limit;
  const shown = open || more <= 0 ? list : list.slice(0, limit);
  const toggle = more > 0 ? (
    <div className="more">
      <Btn size="sm" variant="ghost" iconRight={open ? 'up' : 'down'} aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Show less' : `Show all ${list.length}${noun ? ' ' + noun : ''}`}
      </Btn>
    </div>
  ) : null;
  return [shown, toggle, open];
}

// ---- server stop -------------------------------------------------------------------------
// Two-click confirm, then POST /api/shutdown. variant 'full' ("Stop server")
// or 'icon' (power icon; expands to "Stop?" while confirming).
export function StopButton({ onStopped, variant = 'full', size = 'sm', label = 'Stop server', disabled, className }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function click() {
    if (!confirm) {
      setConfirm(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setConfirm(false), 4000);
      return;
    }
    clearTimeout(timer.current);
    setBusy(true); setErr(null);
    try {
      await postJson('/api/shutdown');
      if (onStopped) onStopped();
    } catch (e) { setErr(e.message); }
    setBusy(false); setConfirm(false);
  }
  const iconOnly = variant === 'icon' && !confirm && !busy;
  const text = busy ? 'Stopping…' : confirm ? (variant === 'icon' ? 'Stop?' : 'Click again to stop') : label;
  const tip = err ? 'Stop failed: ' + err : `Stop the ${BRAND} server (asks to confirm)`;
  return (
    <Btn
      variant="danger"
      size={size}
      icon="power"
      className={className}
      disabled={disabled || busy}
      onClick={click}
      title={tip}
      aria-label={iconOnly ? tip : undefined}
    >
      {iconOnly ? null : text}
    </Btn>
  );
}
