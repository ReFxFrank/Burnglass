// =============================================================================
// sections/System.jsx — "System": server facts + actions, appearance,
// integrations (real switches), Discord images, log tail.
// Styles: ./System.css, scoped .sec-system.
//
// PROPS (SectionProps — built in App.jsx):
//   id          'system' — root <Section id={id} title="System"> (update pills link to #system)
//   data        reads version, serverStartTs, generatedAt, pid, memory{rss,heapUsed},
//               daemon, packaged, update{status,latest,checkedAt,installSupported,releasesUrl,error},
//               history{enabled,archivedDays}, meters{enabled,status,fetchedAt},
//               discord{enabled,status,error,images{…6 slots}}, agentState,
//               meshy{enabled,hasKey,status,fetchedAt}, tray/strip/openusage/startup{supported,enabled[,path]}
//   gfx         { mode, lite, set } → Graphics <Seg>
//   theme       { pref, effective, set } → Theme <Seg>
//   notify      { permission, request } → "Desktop alerts" row
//   thresholds  the alert thresholds (Desktop alerts copy)
//   onStopped   → <StopButton> (two-click confirm, POST /api/shutdown)
//
// ENDPOINTS (all through lib.postJson → X-Pulse: 1), unchanged from the
// pre-redesign server panel: /api/update/check, /api/update/install (then poll GET
// /api/health until the version changes → reload), /api/meters/enable|disable,
// /api/discord/enable|disable, /api/discord/images (JSON body, ONLY the edited
// slots), /api/meshy/enable|disable (+ key in the BODY via MeshyKeyForm),
// /api/tray/…, /api/strip/…, /api/openusage/…, /api/startup/enable|disable,
// /api/shutdown. Logs: lib.useLogs → GET /api/logs every 10 s.
// =============================================================================
import { useEffect, useId, useRef, useState } from 'react';
import { Section, Panel, Btn, Badge, Switch, Seg, Field, Input, InfoTip, StopButton, cx } from '../ui.jsx';
import { Icon } from '../icons.jsx';
import { BRAND, EXE_NAME, STRIP_EXE_NAME, BP, ago, clockTime, dur, hm, postJson, useLogs, useMedia } from '../lib.js';
import { MeshyKeyForm } from './Meshy.jsx';
import './System.css';

// ---- small helpers ---------------------------------------------------------------
const MB = (bytes) => Math.round((bytes || 0) / 1048576);

// A status word next to a toggle's title: tone good | warn | crit | idle | off.
function Stat({ tone = 'off', title, children }) {
  return <span className={cx('stat', tone)} title={title}>{children}</span>;
}

// Server replies land before the next 10 s poll: hold the value we just set
// until the payload agrees (or 25 s pass), so a switch never snaps back.
function useOverrides() {
  const [ov, setOv] = useState({});
  const set = (key, value) => setOv((cur) => ({ ...cur, [key]: { value, until: Date.now() + 25000 } }));
  const get = (key, actual) => {
    const o = ov[key];
    return o && Date.now() < o.until && o.value !== actual ? o.value : actual;
  };
  const settle = (key, actual) => {
    const o = ov[key];
    if (o && (o.value === actual || Date.now() >= o.until)) {
      setOv((cur) => { const n = { ...cur }; delete n[key]; return n; });
    }
  };
  return { get, set, settle, ov };
}

const agentWord = (a) => (a ? (a.provider === 'codex' ? 'Codex' : 'Claude') + ' is ' + (a.state === 'waiting' ? 'waiting on you' : a.state) : null);

// =============================================================================
// Server column: facts, actions, restart hint, appearance
// =============================================================================
function ServerColumn({ data, gfx, theme, onStopped }) {
  const [busy, setBusy] = useState(null); // 'check' | 'install'
  const [note, setNote] = useState(null); // { text, tone }
  const upd = data.update || {};
  const available = upd.status === 'available' && upd.latest;

  const updText =
    upd.status === 'checking' ? 'checking…'
      : upd.status === 'available' ? (upd.checkedAt ? `checked ${hm(upd.checkedAt)} · GitHub releases` : 'GitHub releases')
        : upd.status === 'uptodate' ? `up to date${upd.checkedAt ? ' · checked ' + hm(upd.checkedAt) : ''}`
          : upd.status === 'downloading' ? 'downloading…'
            : upd.status === 'installing' ? 'installing…'
              : upd.status === 'error' ? 'check failed'
                : upd.checkedAt ? 'checked ' + hm(upd.checkedAt) : 'not checked yet';

  async function onCheck() {
    setBusy('check'); setNote(null);
    try {
      const st = await postJson('/api/update/check');
      setNote(st.status === 'available' ? { text: `v${st.latest} is available.`, tone: 'good' }
        : st.status === 'uptodate' ? { text: 'You are on the latest version.', tone: 'good' }
          : { text: st.error || st.status || 'Check finished.', tone: st.status === 'error' ? 'crit' : '' });
    } catch (e) { setNote({ text: 'Check failed: ' + e.message, tone: 'crit' }); }
    setBusy(null);
  }

  async function onInstall() {
    setBusy('install');
    setNote({ text: 'Downloading the update, this can take a minute…', tone: '' });
    const oldV = data.version;
    const waitFor = (ok, failText) => {
      const t0 = Date.now();
      const poll = async () => {
        if (Date.now() - t0 > 120000) { setNote({ text: failText, tone: 'crit' }); setBusy(null); return; }
        try {
          const h = await fetch('/api/health', { cache: 'no-store' }).then((x) => x.json());
          if (ok(h)) { window.location.reload(); return; }
        } catch (_) { /* old server gone, new one not up yet */ }
        setTimeout(poll, 1500);
      };
      setTimeout(poll, 2000);
    };
    try {
      const r = await postJson('/api/update/install');
      if (!r || r.ok === false) {
        setNote({ text: (r && r.error) || 'Install failed. Download it from the releases page instead.', tone: 'crit' });
        setBusy(null);
        return;
      }
      setNote({ text: `Installed. ${BRAND} is restarting itself, hold on…`, tone: '' });
      waitFor((h) => h && h.ok && h.version && h.version !== oldV,
        `The new version did not come back up. Start it manually (it replaced the old ${EXE_NAME}).`);
    } catch (e) {
      // A real HTTP response (403/500) is a failure; only a DROPPED connection
      // means the server is swapping itself out under the request.
      if (e.status) { setNote({ text: 'Install failed: ' + e.message, tone: 'crit' }); setBusy(null); return; }
      setNote({ text: `${BRAND} is restarting…`, tone: '' });
      waitFor((h) => h && h.ok, 'Install may have failed: ' + e.message);
    }
  }

  const uptime = data.generatedAt && data.serverStartTs ? dur(data.generatedAt - data.serverStartTs) : '—';
  const hist = data.history || {};
  const gfxOptions = [
    { value: 'auto', label: `Auto · ${gfx && gfx.lite ? 'lite' : 'rich'}`, title: 'Picks Lite when the browser renders in software' },
    { value: 'rich', label: 'Rich' },
    { value: 'lite', label: 'Lite', title: 'No transitions at all' },
  ];

  return (
    <section className="sys-col sys-server" aria-labelledby="sys-server-h">
      <h3 id="sys-server-h">Server</h3>
      <dl className="kv">
        <dt>Version</dt>
        <dd>
          <span className="mono">v{data.version || '?'}</span>
          {available ? <Badge tone="accent" className="sys-upd">v{upd.latest} available</Badge> : null}
        </dd>
        <dt>Updates</dt>
        <dd className={cx('muted', upd.status === 'error' && 'sys-err')} title={upd.status === 'error' && upd.error ? upd.error : undefined}>{updText}</dd>
        <dt>Uptime</dt>
        <dd>{uptime}</dd>
        {data.memory && data.memory.rss > 0 ? (
          <>
            <dt>Memory</dt>
            <dd title="Server process memory: resident set (JS heap in parentheses)">
              {MB(data.memory.rss)} MB <span className="muted">({MB(data.memory.heapUsed)} MB heap)</span>
            </dd>
          </>
        ) : null}
        <dt>Mode</dt>
        <dd>{data.daemon ? 'background' : 'console'} · {data.packaged ? 'exe' : 'source'}</dd>
        <dt>History</dt>
        <dd className="sys-hist">
          {hist.enabled
            ? `${hist.archivedDays || 0} archived ${hist.archivedDays === 1 ? 'day' : 'days'}`
            : 'off'}
          <InfoTip
            label="About history"
            text={`${BRAND} seals each past day’s totals to ~/.pulse/history so the 90- and 180-day views survive Claude Code’s ~30-day transcript pruning.`}
          />
        </dd>
      </dl>

      <div className="acts">
        {available ? (upd.installSupported ? (
          <Btn variant="primary" size="sm" icon="download" onClick={() => { if (!busy) onInstall(); }} aria-disabled={!!busy || undefined}>
            {busy === 'install' ? 'Updating…' : `Update to v${upd.latest}`}
          </Btn>
        ) : (
          <Btn variant="primary" size="sm" icon="ext" href={upd.releasesUrl} target="_blank" rel="noreferrer">
            Get v{upd.latest}
          </Btn>
        )) : null}
        <Btn size="sm" icon="refresh" onClick={() => { if (!busy) onCheck(); }} aria-disabled={!!busy || undefined}>
          {busy === 'check' ? 'Checking…' : 'Check now'}
        </Btn>
        <StopButton onStopped={onStopped} disabled={busy === 'install'} />
      </div>
      <p className={cx('sys-note', note && note.tone)} role="status" aria-live="polite">{note ? note.text : ''}</p>
      <p className="hint sys-restart">
        To start again, run <code className="nowrap">{EXE_NAME}</code>. Its <code className="nowrap">--install-shortcuts</code> flag
        adds Desktop “{BRAND}” and “{BRAND} — Stop” buttons.
      </p>

      <div className="appearance">
        <h3>Appearance</h3>
        {theme ? (
          <div className="setting">
            <span className="setting-l">Theme</span>
            <Seg
              label="Theme"
              value={theme.pref}
              onChange={theme.set}
              options={[{ value: 'system', label: 'System' }, { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]}
            />
          </div>
        ) : null}
        {gfx ? (
          <div className="setting">
            <span className="setting-l">Graphics</span>
            <Seg label="Graphics" value={gfx.mode} onChange={gfx.set} options={gfxOptions} />
            <span className="hint">Auto picks Lite on software-rendered browsers. Lite drops hover transitions; nothing here depends on blur or looping motion.</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

// =============================================================================
// Integrations: one ToggleRow per opt-in
// =============================================================================
function ToggleRow({ title, on, status, busy, disabled, onToggle, children, extra, note, className }) {
  return (
    <div className={cx('tg', !on && 'off', className)}>
      <div className="tg-t">
        <span className="tg-n">{title}</span>
        {status}
      </div>
      {/* Not disabled while busy: disabling the focused switch would drop keyboard focus. */}
      <Switch checked={on} busy={busy} disabled={disabled} onChange={(next) => { if (!busy) onToggle(next); }} label={title} />
      <div className="tg-d">{children}</div>
      {extra ? <div className="tg-x">{extra}</div> : null}
      <p className={cx('tg-note', note && note.tone)} role="status" aria-live="polite">{note ? note.text : ''}</p>
    </div>
  );
}

function Integrations({ data, notify, thresholds, ovr }) {
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null); // { at, text, tone }
  const [keyForm, setKeyForm] = useState(false);

  const meters = data.meters || {};
  const discord = data.discord || {};
  const meshy = data.meshy;
  const startup = data.startup || {};
  const tray = data.tray || {};
  const strip = data.strip || {};
  const openusage = data.openusage || {};

  const actual = {
    meters: !!meters.enabled,
    discord: !!discord.enabled,
    meshy: !!(meshy && meshy.enabled),
    startup: !!startup.enabled,
    tray: !!tray.enabled,
    strip: !!strip.enabled,
    openusage: !!openusage.enabled,
  };
  // Drop an override once a poll agrees (or it expires).
  const sig = Object.keys(actual).map((k) => k + actual[k]).join(',') + data.generatedAt;
  useEffect(() => { for (const k of Object.keys(actual)) ovr.settle(k, actual[k]); }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const on = (k) => ovr.get(k, actual[k]);

  async function toggle(key, next, message, failPrefix) {
    if (busy) return;
    setBusy(key);
    setNote(null);
    try {
      const r = await postJson(`/api/${key}/${next ? 'enable' : 'disable'}`);
      ovr.set(key, next);
      const m = message(next, r || {});
      setNote({ at: key, ...(typeof m === 'string' ? { text: m, tone: '' } : m) });
    } catch (e) {
      setNote({ at: key, text: failPrefix + e.message, tone: 'crit' });
    }
    setBusy(null);
  }
  const noteFor = (k) => (note && note.at === k ? note : null);

  async function removeMeshyKey() {
    setBusy('meshy-key'); setNote(null);
    try {
      await postJson('/api/meshy/enable', { key: '' }); // body, never a URL
      setNote({ at: 'meshy', text: 'Key removed. Meshy stays paused until you add a new one.', tone: '' });
    } catch (e) { setNote({ at: 'meshy', text: 'Couldn’t remove the key: ' + e.message, tone: 'crit' }); }
    setBusy(null);
  }

  // ---- status words ----
  const metersStat = !on('meters') ? <Stat>Off</Stat>
    : meters.status === 'ok' ? <Stat tone="good">Live{meters.fetchedAt ? ' · ' + ago(meters.fetchedAt) : ''}</Stat>
      : meters.status === 'no-login' ? <Stat tone="warn">No login found</Stat>
        : meters.status === 'expired' ? <Stat tone="warn">Login expired</Stat>
          : meters.status === 'rate-limited' ? <Stat tone="warn" title={meters.error || undefined}>Rate-limited</Stat>
            : meters.status === 'error' ? <Stat tone="crit" title={meters.error || undefined}>Error</Stat>
              : <Stat tone="idle">Connecting…</Stat>;
  const discordStat = !on('discord') ? <Stat>Off</Stat>
    : discord.status === 'ok' ? <Stat tone="good">Connected</Stat>
      : discord.status === 'discord-not-found' ? <Stat tone="warn">Waiting for Discord</Stat>
        : discord.status === 'no-client-id' ? <Stat tone="warn" title={discord.error || undefined}>Needs a client id</Stat>
          : discord.status === 'error' ? <Stat tone="crit" title={discord.error || undefined}>Error</Stat>
            : <Stat tone="idle">Connecting…</Stat>;
  const meshyStat = !meshy ? null : !on('meshy') ? <Stat>Off</Stat>
    : (!meshy.hasKey || meshy.status === 'no-key') ? <Stat tone="warn">No key yet</Stat>
      : meshy.status === 'error' ? <Stat tone="crit" title={meshy.error || undefined}>Error</Stat>
        : meshy.status === 'stale' && meshy.fetchedAt ? <Stat tone="warn" title={meshy.error || undefined}>Stale</Stat>
          : meshy.status === 'ok' ? <Stat tone="good">Key set</Stat>
            : <Stat tone="idle">Reading…</Stat>;
  const onOff = (k) => (on(k) ? <Stat tone="good">On</Stat> : <Stat>Off</Stat>);

  const perm = notify ? notify.permission : 'unsupported';
  const alertStat = perm === 'granted' ? <Stat tone="good">Allowed</Stat>
    : perm === 'denied' ? <Stat tone="warn">Blocked in this browser</Stat>
      : perm === 'unsupported' ? <Stat>Not supported here</Stat>
        : <Stat>Not allowed yet</Stat>;
  const th = (thresholds && thresholds.length ? thresholds : [80, 95]).join(' / ');
  const agent = agentWord(data.agentState);

  return (
    <section className="sys-col sys-int" aria-labelledby="sys-int-h">
      <h3 id="sys-int-h" className="h3-wrap">
        Integrations <span className="h3-note">all opt-in · credentials only ever go to their own provider</span>
      </h3>
      <div className="toggles">
        <ToggleRow
          title="Account meters"
          on={on('meters')}
          status={metersStat}
          busy={busy === 'meters'}
          note={noteFor('meters')}
          onToggle={(next) => toggle('meters', next, (n) => (n
            ? 'Account meters on. The limit gauges appear on the next refresh (~10 s).'
            : 'Account meters off.'), 'Meters toggle failed: ')}
        >
          Official 5-hour and weekly limits from api.anthropic.com, plus Codex account tokens from chatgpt.com. Uses the
          logins those tools already saved, read-only.
        </ToggleRow>

        <ToggleRow
          title="Discord presence"
          on={on('discord')}
          status={discordStat}
          busy={busy === 'discord'}
          note={noteFor('discord')}
          onToggle={(next) => toggle('discord', next, (n, r) => {
            const st = r.discord ? r.discord.status : null;
            if (!n) return 'Discord presence off.';
            if (st === 'ok') return { text: 'Discord presence live. Check your profile.', tone: 'good' };
            if (st === 'no-client-id') return { text: (r.discord && r.discord.error) || 'Set discordClientId in ~/.pulse/config.json first.', tone: 'warn' };
            if (st === 'discord-not-found') return { text: 'On. Waiting for the Discord desktop app (is it running?).', tone: 'warn' };
            return 'Discord presence on. Connecting…';
          }, 'Discord toggle failed: ')}
          extra={on('discord') && agent ? <span className="hint">Right now: <b>{agent}</b></span> : null}
        >
          Shows today, 7-day and all-time usage with model, effort and session count on your Discord profile through the
          desktop app’s local socket. Anyone who can see your profile sees it.
        </ToggleRow>

        {meshy ? (
          <ToggleRow
            title="Meshy credits"
            on={on('meshy')}
            status={meshyStat}
            busy={busy === 'meshy'}
            note={noteFor('meshy')}
            onToggle={(next) => {
              if (!next) setKeyForm(false);
              toggle('meshy', next, (n) => (n
                ? (meshy.hasKey
                  ? 'Meshy on. The credits panel appears on the next refresh (~10 s).'
                  : 'Meshy on. Add your API key and ' + BRAND + ' starts reading your credit balance.')
                : 'Meshy off. ' + BRAND + ' stops calling api.meshy.ai; your key stays in ~/.pulse/config.json until you remove it.'),
              'Meshy toggle failed: ');
            }}
            extra={on('meshy') ? (keyForm ? (
              <MeshyKeyForm
                className="sys-kf"
                hasKey={!!meshy.hasKey}
                allowRemove={false}
                autoFocus
                onDone={() => { setKeyForm(false); setNote({ at: 'meshy', text: 'Key saved. The credits panel updates on the next refresh.', tone: 'good' }); }}
                onCancel={() => setKeyForm(false)}
              />
            ) : meshy.hasKey ? (
              <>
                <Btn size="sm" icon="key" onClick={() => setKeyForm(true)} disabled={busy === 'meshy-key'}>Replace key</Btn>
                <Btn size="sm" variant="ghost" onClick={removeMeshyKey} disabled={busy === 'meshy-key'}>
                  {busy === 'meshy-key' ? 'Removing…' : 'Remove key'}
                </Btn>
              </>
            ) : (
              <Btn size="sm" variant="primary" icon="key" onClick={() => setKeyForm(true)}>Add key</Btn>
            )) : null}
          >
            Balance and per-task credits from api.meshy.ai with a key you paste. Kept in ~/.pulse/config.json and never
            logged or shown back.
          </ToggleRow>
        ) : null}

        {startup.supported ? (
          <ToggleRow
            title="Start with Windows"
            on={on('startup')}
            status={onOff('startup')}
            busy={busy === 'startup'}
            note={noteFor('startup')}
            onToggle={(next) => toggle('startup', next, (n) => (n
              ? `${BRAND} will start with Windows, server only, no browser window. Turn it off here or in Task Manager → Startup.`
              : `Startup entry removed. ${BRAND} no longer starts with Windows.`), 'Could not change the startup setting: ')}
          >
            Adds a per-user <code className="nowrap" title="HKCU\Software\Microsoft\Windows\CurrentVersion\Run">HKCU\…\Run</code> entry
            that launches <code className="nowrap">{EXE_NAME} --no-open</code> at login. No admin rights needed; remove it here or in Task Manager.
          </ToggleRow>
        ) : null}

        {tray.supported ? (
          <ToggleRow
            title="Tray icon"
            on={on('tray')}
            status={onOff('tray')}
            busy={busy === 'tray'}
            note={noteFor('tray')}
            onToggle={(next) => toggle('tray', next, (n) => (n
              ? `Tray icon starting. Windows hides new icons behind the ^ chevron; drag ${BRAND} onto the taskbar once to pin it.`
              : 'Tray off. It exits within ~30 seconds.'), 'Could not toggle the tray: ')}
          >
            Live 5-hour badge in the notification area. Click it to open the mini view.
          </ToggleRow>
        ) : null}

        {strip.supported ? (
          <ToggleRow
            title={`${BRAND} Strip`}
            on={on('strip')}
            status={on('strip') && !strip.path ? <Stat tone="warn">Exe not found</Stat> : onOff('strip')}
            busy={busy === 'strip'}
            note={noteFor('strip')}
            onToggle={(next) => toggle('strip', next, (n, r) => {
              if (!n) return 'Strip off. It exits within a minute.';
              return r.strip && r.strip.path
                ? `${BRAND} Strip starting on your taskbar. Drag it anywhere; click it for the popover.`
                : { text: `On, but ${STRIP_EXE_NAME} was not found. Put it next to ${EXE_NAME} (or set "stripPath" in ~/.pulse/config.json).`, tone: 'warn' };
            }, 'Strip toggle failed: ')}
          >
            Taskbar strip companion with a popover dashboard.
          </ToggleRow>
        ) : null}

        {openusage.supported ? (
          <ToggleRow
            title="OpenUsage launch"
            on={on('openusage')}
            status={on('openusage') && !openusage.path ? <Stat tone="warn">App not found</Stat> : onOff('openusage')}
            busy={busy === 'openusage'}
            note={noteFor('openusage')}
            onToggle={(next) => toggle('openusage', next, (n, r) => {
              if (!n) return 'OpenUsage auto-launch off. The app keeps running if open; quit it from its own menu.';
              return r.openusage && r.openusage.path
                ? `OpenUsage will start with ${BRAND}. Launching it now.`
                : { text: 'On, but OpenUsageTray.exe was not found. Unzip OpenUsage anywhere and set "openusagePath" in ~/.pulse/config.json.', tone: 'warn' };
            }, 'OpenUsage toggle failed: ')}
          >
            Starts OpenUsageTray.exe alongside {BRAND}. {BRAND} never installs, updates or closes it.
          </ToggleRow>
        ) : null}

        <ToggleRow
          title="Desktop alerts"
          on={perm === 'granted'}
          status={alertStat}
          disabled={perm !== 'default'}
          onToggle={(next) => { if (next && notify) notify.request(); }}
          extra={perm === 'default' ? <Btn size="sm" onClick={() => notify && notify.request()}>Allow notifications</Btn>
            : perm === 'granted' ? <span className="hint">To turn them off, change this site’s notification setting in your browser.</span>
              : perm === 'denied' ? <span className="hint">Allow notifications for this page in your browser’s site settings, then reload.</span>
                : null}
        >
          Browser notifications when any limit passes {th}%, or on unusual spend. Needs a one-time permission from this browser.
        </ToggleRow>
      </div>
    </section>
  );
}

// =============================================================================
// Discord images: 6 slots, only the edited ones are POSTed
// =============================================================================
// Discord large-image slots: an https link (the only way Discord animates a
// GIF) or an uploaded Art Asset key; empty = the built-in art. No preview on
// purpose — rendering the link here would make the dashboard fetch it.
const DISCORD_IMAGE_ROWS = [
  ['claude', 'Claude Code', 'claude (uploaded art)'],
  ['claudeWorking', 'Claude — working', 'same as Claude Code'],
  ['claudeThinking', 'Claude — thinking', 'same as Claude Code'],
  ['claudeWaiting', 'Claude — waiting on you', 'same as Claude Code'],
  ['codex', 'Codex', 'codex (uploaded art)'],
  ['idle', 'Idle', 'pulse (uploaded art)'],
];
const rowValues = (src) => Object.fromEntries(DISCORD_IMAGE_ROWS.map(([k]) => [k, (src && src[k]) || '']));

export function DiscordImagesForm({ images, idPrefix }) {
  const fromServer = rowValues(images);
  const sig = DISCORD_IMAGE_ROWS.map(([k]) => fromServer[k]).join('\n');
  // The dashboard polls every ~10 s, so right after a save the props are
  // stale. The save's own reply is the baseline until a NEWER poll arrives
  // (whatever it says — incl. a hand edit of config.json — then wins).
  const [saved, setSaved] = useState(null); // { images, sig } | null
  const base = saved && saved.sig === sig ? saved.images : fromServer;
  const [edits, setEdits] = useState({}); // only the fields the user touched
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  useEffect(() => { if (saved && saved.sig !== sig) setSaved(null); }, [sig, saved]);
  const shown = {};
  for (const [k] of DISCORD_IMAGE_ROWS) shown[k] = k in edits ? edits[k] : base[k];
  const dirty = DISCORD_IMAGE_ROWS.filter(([k]) => k in edits && edits[k].trim() !== base[k]).map(([k]) => k);
  const edit = (k, v) => { setEdits((cur) => ({ ...cur, [k]: v })); setMsg(null); };

  async function save() {
    // ONLY the changed slots: a stale or hand-edited value in another field can
    // never be overwritten, or block the save by failing validation.
    const body = {};
    for (const k of dirty) body[k] = edits[k].trim();
    if (!Object.keys(body).length) return;
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/api/discord/images', body);
      const got = (r.discord && r.discord.images) || {};
      setSaved({ images: rowValues(got), sig });
      setEdits({});
      setMsg({ bad: false, text: 'Saved. Discord shows it on the next update (a new link can take a few seconds the first time).' });
    } catch (e) { setMsg({ bad: true, text: 'Couldn’t save: ' + e.message }); }
    setBusy(false);
  }

  return (
    <div className="disc-form">
      <div className="imgs">
        {DISCORD_IMAGE_ROWS.map(([k, label, def]) => (
          <Field key={k} label={label} htmlFor={idPrefix + k}>
            <Input
              id={idPrefix + k}
              mono
              type="text"
              spellCheck={false}
              autoComplete="off"
              placeholder={def}
              value={shown[k]}
              disabled={busy}
              onChange={(e) => edit(k, e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && dirty.length && !busy) save(); }}
            />
          </Field>
        ))}
      </div>
      <div className="formacts">
        <Btn variant="primary" size="sm" disabled={busy || !dirty.length} onClick={save}>{busy ? 'Saving…' : 'Save images'}</Btn>
        {dirty.length > 0 && !busy ? <Btn variant="ghost" size="sm" onClick={() => { setEdits({}); setMsg(null); }}>Cancel</Btn> : null}
        <span className={cx('hint', 'disc-msg', msg && (msg.bad ? 'bad' : 'ok'))} role="status" aria-live="polite">
          {msg ? msg.text : dirty.length ? `${dirty.length} unsaved ${dirty.length === 1 ? 'change' : 'changes'}` : 'Saved to ~/.pulse/config.json'}
        </span>
      </div>
    </div>
  );
}

function DiscordImages({ discord }) {
  const phone = useMedia(BP.sm);
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const st = discord.status;
  const tone = st === 'ok' ? '' : st === 'error' || st === 'no-client-id' ? 'warn' : 'idle';
  const stText = st === 'ok' ? 'Presence connected · art follows what Claude Code is doing'
    : st === 'discord-not-found' ? 'Waiting for the Discord desktop app'
      : st === 'no-client-id' ? 'No Discord client id configured'
        : st === 'error' ? 'Presence error' + (discord.error ? ': ' + discord.error : '')
          : 'Connecting to Discord…';
  const showBody = !phone || open;
  return (
    <section className="sys-imgs" aria-labelledby="sys-imgs-h">
      <div className="disc-head">
        <h3 id="sys-imgs-h">Discord images</h3>
        <span className="disc-state"><span className={cx('dot', tone)} aria-hidden="true" /><span>{stText}</span></span>
        <span className="sp" />
        {phone ? (
          <Btn size="sm" iconRight={open ? 'up' : 'down'} aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide images' : 'Edit images'}
          </Btn>
        ) : null}
      </div>
      {showBody ? (
        <div className="disc-body" id={bodyId}>
          <p className="hint">
            Paste an <code>https://</code> link to a GIF or animated WebP, an art-asset key, or leave a slot empty for the
            built-in art. Discord fetches the link, not {BRAND}, and anyone who can see your presence can see where it’s
            hosted. Avoid Discord attachment links, which expire.
          </p>
          <DiscordImagesForm images={discord.images} idPrefix={bodyId + '-'} />
        </div>
      ) : null}
    </section>
  );
}

// =============================================================================
// Log: one-line tail, expandable
// =============================================================================
function LogTail() {
  const lines = useLogs(true);
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  const stick = useRef(true); // auto-follow unless the user scrolled up
  const boxId = useId();
  useEffect(() => {
    const el = boxRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines, open]);
  const last = lines.length ? lines[lines.length - 1] : null;
  return (
    <>
      <div className="logs">
        <Icon name="terminal" size={14} />
        <span className="nowrap logs-l">Server log</span>
        <span className={cx('last', last && last.level)} title={last ? last.text : undefined}>
          {last ? <><span className="lt">{clockTime(last.ts)}</span> {last.text}</> : 'no log lines yet'}
        </span>
        <Btn size="sm" iconRight={open ? 'up' : 'down'} aria-expanded={open} aria-controls={boxId} onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide log' : 'Show log'}
        </Btn>
      </div>
      {open ? (
        <div
          id={boxId}
          className="logbox"
          ref={boxRef}
          role="log"
          aria-label="Server log"
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {lines.length === 0
            ? <div className="ll">no log lines yet…</div>
            : lines.map((l, i) => (
              <div key={i} className={cx('ll', l.level || 'info')}>
                <span className="lt">{clockTime(l.ts)}</span>{l.text}
              </div>
            ))}
        </div>
      ) : null}
    </>
  );
}

// =============================================================================
// The panel + section
// =============================================================================
export function SystemPanel({ data, gfx, theme, notify, thresholds, onStopped }) {
  let host = '127.0.0.1';
  try { if (window.location.hostname) host = window.location.hostname; } catch (_) {}
  const discord = data.discord || {};
  const ovr = useOverrides();
  const discordOn = ovr.get('discord', !!discord.enabled);
  return (
    <Panel
      span={12}
      flush
      className="sys-panel"
      title={<><Icon name="server" size={14} />System</>}
      ctx={`this machine · ${host}${data.pid ? ' · pid ' + data.pid : ''}`}
    >
      <div className="sys">
        <ServerColumn data={data} gfx={gfx} theme={theme} onStopped={onStopped} />
        <Integrations data={data} notify={notify} thresholds={thresholds} ovr={ovr} />
      </div>
      {discordOn ? <div className="sys-row2"><DiscordImages discord={discord} /></div> : null}
      <LogTail />
    </Panel>
  );
}

export default function System({ id, data, gfx, theme, notify, thresholds, onStopped }) {
  return (
    <Section id={id} title="System">
      <SystemPanel data={data} gfx={gfx} theme={theme} notify={notify} thresholds={thresholds} onStopped={onStopped} />
    </Section>
  );
}
