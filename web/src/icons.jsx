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
//
// Brand (bottom of this file): <BrandMark> is the Burnglass "Glass" mark and
// <Wordmark> the outlined Inter 620 wordmark — "Burn" in --text, "glass" in
// --accent. <Icon name="brand"> is the one-colour silhouette for tight spots.
// =============================================================================
import { BRAND } from './lib.js';
import markMaster from './brand/app-icon.svg';
import mark24 from './brand/mark-small-24.svg';

const F = { fill: 'currentColor', stroke: 'none' }; // for the few solid glyphs

const PATHS = {
  // brand + navigation. `brand` = the one-colour mark (brand/mark-mono-16):
  // lens · beam · focal dot. `pulse` is the pre-2.0 name, kept as an alias so a
  // stray <Icon name="pulse"> draws the Burnglass mark, not the old heartbeat.
  brand: <g {...F}><path d="M3.5.5L6 5.5v5l-2.5 5L1 10.5v-5z" /><path d="M5.5 6L10 7v2l-4.5 1z" /><circle cx="12" cy="8" r="3" /></g>,
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

PATHS.pulse = PATHS.brand;

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

// =============================================================================
// Brand — the Burnglass "Glass" identity (brand/final/BRAND.md).
// =============================================================================

// The mark on its dark tile, so it reads on both themes. It ships as an image
// asset (Vite inlines it — no fetch): the brand is never recoloured, so its
// fixed paints (ice lens, ember focal dot) live in the drawing, never in a UI
// token. Size rule: 28 px and up use the master drawing; below that the
// pixel-snapped 24 px drawing — a small size is never a scaled-down master.
export function BrandMark({ size = 30, className }) {
  return (
    <img
      className={'bmark' + (className ? ' ' + className : '')}
      src={size >= 28 ? markMaster : mark24}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable="false"
    />
  );
}

// Outlined Inter 620 wordmark (−0.018 em tracking baked in), font units, 2048 upm.
// "Burn" is ink (.wm-i → --text), "glass" is the accent (.wm-g → --accent), so
// it follows the theme. `cap` is the cap height in px; the lockup sets it to
// 26/64 of the mark (30 px mark → 12.19 px). The box runs from the cap line to
// the g's descender; `centered` adds equal room above so the cap band sits on
// the box's vertical centre (a one-line lockup, e.g. #mini).
const WM_BURN = 'M147 0V-1490H721Q883-1490 990-1439Q1097-1389 1151-1302Q1204-1215 1204-1104Q1204-1014 1169-949Q1134-884 1075-844Q1016-804 943-786V-771Q1023-768 1096-723Q1169-679 1216-599Q1262-519 1262-407Q1262-291 1206-199Q1150-107 1037-53Q924 0 754 0ZM421-229H708Q853-229 918-285Q983-341 983-429Q983-495 950-547Q918-600 858-630Q799-661 717-661H421ZM421-857H685Q755-857 810-882Q865-908 897-955Q929-1002 929-1067Q929-1152 869-1207Q809-1263 691-1263H421ZM1833 14Q1718 14 1632-35Q1545-85 1498-179Q1450-274 1450-407V-1118H1718V-450Q1718-339 1776-276Q1833-213 1934-213Q2002-213 2055-243Q2107-272 2138-329Q2168-385 2168-465V-1118H2436V0H2182L2179-277H2198Q2152-132 2060-59Q1969 14 1833 14ZM2671 0V-1118H2931V-929H2943Q2973-1028 3048-1081Q3122-1133 3218-1133Q3240-1133 3267-1131Q3294-1129 3313-1125V-880Q3296-886 3260-890Q3223-894 3189-894Q3117-894 3060-864Q3003-833 2971-779Q2939-725 2939-653V0ZM3738-653V0H3470V-1118H3724L3728-841H3708Q3754-985 3845-1058Q3936-1132 4073-1132Q4189-1132 4275-1083Q4361-1033 4408-939Q4456-845 4456-711V0H4188V-668Q4188-779 4131-842Q4073-905 3973-905Q3905-905 3852-875Q3799-846 3768-790Q3738-734 3738-653Z';
const WM_GLASS = 'M5176 442Q5041 442 4941 408Q4841 373 4777 314Q4713 255 4686 180L4914 103Q4930 134 4961 166Q4992 198 5044 219Q5096 240 5176 240Q5295 240 5367 185Q5438 129 5438 11V-200H5416Q5396-158 5359-116Q5322-74 5260-45Q5198-16 5102-16Q4974-16 4870-77Q4766-137 4704-258Q4643-379 4643-562Q4643-747 4705-874Q4767-1001 4871-1066Q4976-1132 5104-1132Q5202-1132 5266-1099Q5330-1067 5368-1020Q5407-973 5427-932H5440V-1118H5703V1Q5703 150 5635 248Q5567 346 5448 394Q5329 442 5176 442ZM5179-226Q5263-226 5321-266Q5379-307 5409-382Q5439-458 5439-564Q5439-669 5409-747Q5379-825 5321-869Q5263-913 5179-913Q5093-913 5035-867Q4977-822 4947-743Q4917-665 4917-564Q4917-462 4947-386Q4977-310 5035-268Q5094-226 5179-226ZM6206-1490V0H5939V-1490ZM6754 23Q6648 23 6563-15Q6478-54 6429-129Q6380-204 6380-314Q6380-408 6415-470Q6450-532 6511-570Q6571-607 6648-626Q6724-645 6805-654Q6903-664 6963-673Q7024-681 7052-699Q7081-717 7081-754V-759Q7081-813 7059-850Q7037-888 6994-907Q6952-927 6889-927Q6826-927 6779-908Q6733-888 6703-857Q6673-826 6660-789L6412-837Q6444-936 6513-1001Q6582-1067 6678-1099Q6775-1132 6889-1132Q6970-1132 7051-1113Q7132-1094 7200-1050Q7267-1006 7308-932Q7349-858 7349-748V0H7093V-154H7082Q7057-106 7013-66Q6969-25 6905-1Q6841 23 6754 23ZM6824-174Q6903-174 6961-205Q7018-236 7050-288Q7082-340 7082-401V-531Q7069-521 7040-512Q7010-503 6973-496Q6937-490 6901-485Q6866-480 6841-476Q6783-469 6737-450Q6691-432 6665-400Q6639-368 6639-318Q6639-271 6663-239Q6687-207 6729-190Q6771-174 6824-174ZM8011 22Q7881 22 7781-15Q7681-52 7617-123Q7553-195 7534-296L7784-342Q7807-261 7865-221Q7923-181 8017-181Q8111-181 8166-218Q8221-255 8221-311Q8221-358 8184-389Q8147-420 8071-436L7880-477Q7721-511 7643-589Q7565-667 7565-791Q7565-895 7622-972Q7679-1048 7782-1090Q7884-1132 8019-1132Q8147-1132 8240-1096Q8332-1060 8389-995Q8447-930 8469-842L8230-796Q8211-854 8161-894Q8111-933 8023-933Q7942-933 7887-898Q7833-863 7833-807Q7833-760 7869-728Q7904-697 7988-679L8181-639Q8340-605 8418-530Q8495-455 8495-337Q8495-230 8434-149Q8372-68 8263-23Q8153 22 8011 22ZM9104 22Q8974 22 8874-15Q8774-52 8710-123Q8647-195 8627-296L8878-342Q8900-261 8958-221Q9016-181 9110-181Q9204-181 9259-218Q9314-255 9314-311Q9314-358 9277-389Q9241-420 9164-436L8974-477Q8814-511 8736-589Q8658-667 8658-791Q8658-895 8715-972Q8772-1048 8875-1090Q8977-1132 9112-1132Q9240-1132 9333-1096Q9425-1060 9483-995Q9540-930 9562-842L9323-796Q9304-854 9254-894Q9205-933 9116-933Q9035-933 8980-898Q8926-863 8926-807Q8926-760 8962-728Q8997-697 9082-679L9274-639Q9433-605 9511-530Q9589-455 9589-337Q9589-230 9527-149Q9465-68 9356-23Q9247 22 9104 22Z';
const WM_W = 9672, WM_CAP = 1490, WM_DESC = 442;

export function Wordmark({ cap = 12.1875, centered = false, label = BRAND, className }) {
  const top = centered ? -(WM_CAP + WM_DESC) : -WM_CAP;
  const vh = WM_DESC - top;
  const k = cap / WM_CAP;
  return (
    <svg
      className={'wm' + (className ? ' ' + className : '')}
      viewBox={`0 ${top} ${WM_W} ${vh}`}
      width={+(WM_W * k).toFixed(2)}
      height={+(vh * k).toFixed(2)}
      role="img"
      aria-label={label}
    >
      <path className="wm-i" d={WM_BURN} />
      <path className="wm-g" d={WM_GLASS} />
    </svg>
  );
}
