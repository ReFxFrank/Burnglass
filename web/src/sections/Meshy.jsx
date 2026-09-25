// =============================================================================
// sections/Meshy.jsx — "Meshy credits": 3D-generation credits (own unit).
// OWNER: the Meshy section engineer. Styles: ./Meshy.css, scoped .sec-meshy.
//
// PROPS (SectionProps — see CONTRACT.md):
//   id          'meshy' — root <Section id={id} title="Meshy credits" meta="own unit · never mixed with $">
//   data        payload; reads meshy{enabled,hasKey,status(ok|stale|error|no-key|disabled),
//               balance,credits{today,week,month,allTime},byType{type:{credits,tasks}},
//               daily[]{date,credits,tasks},families[],fetchedAt,error}
//   (period, colorMap, srcFilter, thresholds, notify, gfx, theme, onStopped, onPeriod: unused)
//
// RENDER NOTHING (return null) unless meshy.enabled && status !== 'disabled' —
// the rail's "Meshy credits" nav item disappears with it automatically.
// CREDITS ARE NOT DOLLARS: never lib.money, never "$", never summed with spend.
//
// ENDPOINTS: POST /api/meshy/enable with JSON BODY { key } (set/replace) or
// { key: '' } (remove) via lib.postJson — the key NEVER goes in a URL, is
// wiped from state after sending, and is never displayed (payload has hasKey only).
//
// TARGET (mockup "Meshy"): c-12 panel, header: cube icon, "Meshy · 3D
// generation", <Badge tone="accent">Credits</Badge>, info, ctx "read from your
// Meshy account 2m ago · at most every 15 min", [Key] button. Body 3 columns
// (180px | 1.1fr | 1fr → 1 col < 760): big balance "1,240 credits left" + 2×2
// used stats (today / 7 days / 30 days / tracked total); credits-per-day bars
// (--q5) with first-date/Today caption; by task type table with friendly
// labels (text_to_3d_preview → "Text to 3D · preview", text-to-3d → "Text to 3D")
// + <MBar color="var(--q5)">, and the "counts only …; not counted: …" coverage
// hint from meshy.families. States: no key (invite + key form: <Input mono
// type="password"> + Save key), stale/error (warn note, keeps last good), first read.
//
// STUB: legacy MeshyCard.
// =============================================================================
import { Section } from '../ui.jsx';
import { MeshyCard } from '../panels.jsx';
import './Meshy.css';

export default function Meshy({ id, data }) {
  const m = data.meshy;
  if (!m || !m.enabled || m.status === 'disabled') return null;
  return (
    <Section id={id} title="Meshy credits" meta="own unit · never mixed with $">
      <div className="legacy"><MeshyCard meshy={m} delay={0} /></div>
    </Section>
  );
}
