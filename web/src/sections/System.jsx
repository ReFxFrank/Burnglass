// =============================================================================
// sections/System.jsx — "System": server facts + actions, appearance,
// integrations (switches), Discord images, log tail.
// OWNER: the System section engineer. Styles: ./System.css, scoped .sec-system.
//
// PROPS (SectionProps — see CONTRACT.md):
//   id          'system' — root <Section id={id} title="System"> (the update
//               pills link to #system)
//   data        payload; reads version, serverStartTs, generatedAt, pid, memory{rss,heapUsed},
//               daemon, packaged, update{status,latest,checkedAt,installSupported,releasesUrl,error},
//               history{enabled,archivedDays}, meters.enabled/fetchedAt/status,
//               discord{enabled,status,error,images{claude,claudeWorking,claudeThinking,
//               claudeWaiting,codex,idle}}, agentState, meshy{enabled,hasKey},
//               tray/strip/openusage/startup{supported,enabled[,path]}
//   gfx         { mode: 'auto'|'rich'|'lite', lite, set(mode) } → Graphics <Seg>
//   theme       { pref: 'system'|'dark'|'light', effective, set(pref) } → Theme <Seg>
//   notify      { permission, request() } → "Desktop alerts" row ("Allow notifications")
//   onStopped   pass to <StopButton onStopped={onStopped}> (ui.jsx; two-click confirm)
//   thresholds  for the Desktop alerts copy ("when a limit passes 80 / 95%")
//   (period, colorMap, srcFilter, onPeriod: unused)
//
// ENDPOINTS (lib.postJson — X-Pulse header): /api/update/check, /api/update/install
// (then poll GET /api/health until version changes, reload), /api/meters/enable|disable,
// /api/discord/enable|disable, /api/discord/images (JSON body: ONLY changed slots),
// /api/meshy/enable|disable (+ key in BODY), /api/tray/…, /api/strip/…,
// /api/openusage/…, /api/startup/enable|disable, /api/shutdown (StopButton).
// Logs: lib.useLogs(enabled) → GET /api/logs every 10 s.
//
// TARGET (mockup "System"): c-12 panel "System" (ctx "this machine · 127.0.0.1 ·
// pid N"). Left column "Server": <dl class="kv"> facts (Version + update badge,
// Updates, Uptime lib.dur, Memory, Mode, History), actions [Get vX|Update to vX]
// [Check now] [Stop server (danger)], restart hint, "Appearance": Theme and
// Graphics <Seg>s. Right column "Integrations": 2-col grid of toggle rows —
// <Switch> + status dot + one consent line (+ extras: Meshy key buttons, Discord
// "Right now: Claude is idle", notification permission); Windows-only rows
// render ONLY when .supported. Row 2: Discord images (6 fields, collapsed
// behind "Edit images" on phone). Log collapsed to a one-line tail with
// "Show log". Action feedback line. Long strings (HKCU\…\Run) must wrap.
//
// STUB: legacy ServerPanel (+ it already includes the graphics toggle).
// =============================================================================
import { Section } from '../ui.jsx';
import { ServerPanel } from '../server-panel.jsx';
import './System.css';

export default function System({ id, data, gfx, onStopped }) {
  return (
    <Section id={id} title="System">
      <div className="legacy"><ServerPanel data={data} onStopped={onStopped} gfx={gfx} delay={0} /></div>
    </Section>
  );
}
