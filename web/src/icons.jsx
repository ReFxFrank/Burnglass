// =============================================================================
// icons.jsx — the ONE icon set. 16×16 grid, 1.5 px line, round caps/joins,
// drawn in currentColor so an icon always takes its text colour. Inline SVG,
// no dependency, no sprite fetch.
//
//   <Icon name="download" />            16 px (class "ic")
//   <Icon name="info" size={14} />      14 px (class "ic-sm")
//   <Icon name="bolt" size={12} />      12 px (class "ic-xs")
//   <Icon name="check" title="Official" />  → role="img" + <title> instead of aria-hidden
//
// Replaces the old Unicode glyphs: ◧ → mini · ⏻ → power · ⇩ → download ·
// ▾ → down · ⚠ → alert · ★ → star · ↓ → arrowdown · ⓘ → info · ▲▼ → caretup/caretdown.
// =============================================================================

const F = { fill: 'currentColor', stroke: 'none' }; // for the few solid glyphs

const PATHS = {
  // brand + navigation
  pulse: <path d="M1.5 8.5h3l1.6-4 3 8 1.9-5.2.9 1.2h2.6" strokeWidth="1.7" />,
  overview: <><rect x="2" y="2" width="5" height="5" rx="1.2" /><rect x="9" y="2" width="5" height="5" rx="1.2" /><rect x="2" y="9" width="5" height="5" rx="1.2" /><rect x="9" y="9" width="5" height="5" rx="1.2" /></>,
  gauge: <><path d="M2.3 12.2a6 6 0 1 1 11.4 0" /><path d="M8 10.5l2.8-3.3" /></>,
  chart: <><path d="M2 13.5h12" /><path d="M4 11V7.5M7 11V4M10 11V8M13 11V5.5" /></>,
  layers: <><path d="M8 2l6 3.2-6 3.2-6-3.2z" /><path d="M2 8.4l6 3.2 6-3.2" /><path d="M2 11.4l6 3.2 6-3.2" opacity=".6" /></>,
  clock: <><circle cx="8" cy="8" r="6" /><path d="M8 4.6V8l2.4 1.5" /></>,
  list: <path d="M5.5 4h8.5M5.5 8h8.5M5.5 12h8.5M2.2 4h.3M2.2 8h.3M2.2 12h.3" />,
  cube: <><path d="M8 1.8l5.5 3.1v6.2L8 14.2l-5.5-3.1V4.9z" /><path d="M2.5 4.9L8 8l5.5-3.1M8 8v6.2" /></>,
  server: <><rect x="2" y="2.5" width="12" height="4.5" rx="1.2" /><rect x="2" y="9" width="12" height="4.5" rx="1.2" /><circle cx="4.8" cy="4.75" r=".9" {...F} /><circle cx="4.8" cy="11.25" r=".9" {...F} /></>,
  menu: <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,

  // actions
  download: <path d="M8 2v8M4.6 6.8L8 10.2l3.4-3.4M2.5 13.5h11" />,
  mini: <><rect x="2" y="2.5" width="12" height="11" rx="1.6" /><path d="M9.5 2.5v11" /></>,
  power: <><path d="M8 2v5.5" /><path d="M4.7 4.3a5 5 0 1 0 6.6 0" /></>,
  ext: <><path d="M6.5 3H3v10h10V9.5" /><path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5" /></>,
  key: <><circle cx="5.5" cy="10.5" r="3" /><path d="M7.6 8.4l5.9-5.9M11.2 4.8l1.8 1.8" /></>,
  edit: <path d="M10.8 2.7l2.5 2.5-7.8 7.8H3v-2.5z" />,
  refresh: <><path d="M13.3 8a5.3 5.3 0 1 1-1.6-3.8" /><path d="M13.3 2.6v3h-3" /></>,
  terminal: <><rect x="1.8" y="2.5" width="12.4" height="11" rx="1.6" /><path d="M4.5 6.5L6.5 8.3 4.5 10M8 10.5h3.5" /></>,

  // status + meaning
  info: <><circle cx="8" cy="8" r="6" strokeWidth="1.4" /><path d="M8 7.3v3.9" strokeWidth="1.4" /><circle cx="8" cy="5" r=".9" {...F} /></>,
  alert: <><path d="M8 2.2l6.3 11.1H1.7z" /><path d="M8 6.6v3.1" /><circle cx="8" cy="11.5" r=".9" {...F} /></>,
  check: <path d="M3.5 8.5l2.8 2.8 6.2-6.4" strokeWidth="2" />,
  bolt: <path d="M9.2 1.5L3.6 9h4l-.9 5.5L12.4 7h-4z" {...F} />,
  spark: <path d="M8 1.5c.5 3.2 2 4.9 5.5 5.5-3.5.6-5 2.3-5.5 5.5-.5-3.2-2-4.9-5.5-5.5C6 6.4 7.5 4.7 8 1.5z" {...F} />,
  star: <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" {...F} />,

  // theme
  moon: <path d="M13.3 9.6A5.6 5.6 0 0 1 6.4 2.7a5.6 5.6 0 1 0 6.9 6.9z" />,
  sun: <><circle cx="8" cy="8" r="2.8" /><path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" /></>,
  monitor: <><rect x="1.8" y="2.5" width="12.4" height="8.5" rx="1.4" /><path d="M5.5 14h5M8 11v3" /></>,

  // direction
  down: <path d="M4 6l4 4 4-4" strokeWidth="1.6" />,
  up: <path d="M4 10l4-4 4 4" strokeWidth="1.6" />,
  right: <path d="M6 4l4 4-4 4" strokeWidth="1.6" />,
  arrowdown: <path d="M8 2.5v10M4 9l4 4 4-4" strokeWidth="1.6" />,
  arrowup: <path d="M8 13.5v-10M4 7l4-4 4 4" strokeWidth="1.6" />,
  caretup: <path d="M8 4.5l4.2 6.5H3.8z" {...F} />,
  caretdown: <path d="M8 11.5l4.2-6.5H3.8z" {...F} />,
};

const SIZE_CLASS = { 16: 'ic', 14: 'ic-sm', 12: 'ic-xs' };

export function Icon({ name, size = 16, className, title, ...rest }) {
  const body = PATHS[name];
  if (!body) return null;
  const cls = (SIZE_CLASS[size] || 'ic') + (className ? ' ' + className : '');
  const a11y = title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true, focusable: 'false' };
  return (
    <svg
      className={cls}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...a11y}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {body}
    </svg>
  );
}

export default Icon;
