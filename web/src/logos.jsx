// Provider marks for the model families recognized in ./model-families.js.
// Marks are simple original glyphs (evocative, not exact trademarked logos)
// painted with the --fam-* tokens, so light mode can darken them.
// SHARED FILE (see CONTRACT.md).
//
//   <ModelLogo model="claude-opus-5-5" size={14} />   mark for a model id
//   <FamilyMark family="openai" size={14} />          mark for a provider family
import { modelFamily, FAMILY_META } from './model-families.js';
export { modelFamily, FAMILY_META };

// A monogram badge — the consistent fallback for families without a glyph.
function Monogram({ label, color, size }) {
  return (
    <span
      className="fam-mono"
      aria-hidden="true"
      style={{
        width: size, height: size, borderRadius: Math.round(size * 0.28),
        background: color, fontSize: Math.round(size * 0.62),
      }}
    >{label[0]}</span>
  );
}

export function FamilyMark({ family = 'other', size = 16, title }) {
  const fam = FAMILY_META[family] ? family : 'other';
  const { label, css: color } = FAMILY_META[fam];
  const common = { width: size, height: size, viewBox: '0 0 24 24', className: 'pmark', 'aria-hidden': true, focusable: 'false' };
  // title: undefined → the family label; '' → purely decorative (hidden from AT).
  const decorative = title === '';
  const tt = decorative ? undefined : (title || label);
  const a11y = { title: tt, role: decorative ? undefined : 'img', 'aria-label': tt, 'aria-hidden': decorative || undefined };
  const svg = (children) => (
    <span className="fam-wrap" {...a11y}>
      <svg {...common} style={{ width: size, height: size }}>{children}</svg>
    </span>
  );
  switch (fam) {
    case 'claude': // sunburst
      return svg(
        <g stroke={color} strokeWidth="2.4" strokeLinecap="round">
          {Array.from({ length: 8 }).map((_, i) => {
            const a = (i * Math.PI) / 4;
            const x = 12 + Math.cos(a) * 9, y = 12 + Math.sin(a) * 9;
            const x0 = 12 + Math.cos(a) * 3, y0 = 12 + Math.sin(a) * 3;
            return <line key={i} x1={x0} y1={y0} x2={x} y2={y} />;
          })}
        </g>
      );
    case 'openai': // six-petal rosette (approximate knot)
      return svg(
        <g fill="none" stroke={color} strokeWidth="2">
          {Array.from({ length: 6 }).map((_, i) => {
            const a = (i * Math.PI) / 3;
            const cx = 12 + Math.cos(a) * 4, cy = 12 + Math.sin(a) * 4;
            return <circle key={i} cx={cx} cy={cy} r="4.4" />;
          })}
        </g>
      );
    case 'google': // four-point sparkle (Gemini-style)
      return svg(
        <path d="M12 2 C13 8 16 11 22 12 C16 13 13 16 12 22 C11 16 8 13 2 12 C8 11 11 8 12 2 Z" fill={color} />
      );
    case 'meta': // infinity loop
      return svg(
        <path d="M7 8 C3 8 3 16 7 16 C11 16 13 8 17 8 C21 8 21 16 17 16 C13 16 11 8 7 8 Z"
          fill="none" stroke={color} strokeWidth="2" />
      );
    case 'xai': // bold X
      return svg(
        <g stroke={color} strokeWidth="2.4" strokeLinecap="round">
          <line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" />
        </g>
      );
    case 'deepseek': // ring with an offset eye
      return svg(
        <g fill="none" stroke={color} strokeWidth="2">
          <circle cx="12" cy="12" r="8" /><circle cx="14.5" cy="10" r="1.6" fill={color} stroke="none" />
        </g>
      );
    case 'glm': // hexagon (Zhipu / Z.ai)
      return svg(
        <path d="M12 3 L20 7.5 L20 16.5 L12 21 L4 16.5 L4 7.5 Z"
          fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
      );
    case 'mistral': // stacked bands
      return svg(
        <g>
          {[1, 2, 3, 4].map((n, i) => (
            <rect key={n} x="4" y={4 + i * 4} width="16" height="3.2" rx="1" fill={`var(--fam-mistral-${n})`} />
          ))}
        </g>
      );
    default:
      return (
        <span className="fam-wrap" {...a11y}>
          <Monogram label={label} color={color} size={size} />
        </span>
      );
  }
}

// Mark for a model id (family recognised from the name).
export function ModelLogo({ model, size = 16, title }) {
  return <FamilyMark family={modelFamily(model)} size={size} title={title} />;
}
