// =============================================================================
// sections/Meshy.jsx — "Meshy credits": 3D-generation credits (own unit).
// Styles: ./Meshy.css, scoped .sec-meshy (the key form is also used inside
// the System section, so its classes are prefixed meshy-kf-… and global).
//
// PROPS (SectionProps — see CONTRACT.md): id, data (reads data.meshy:
//   {enabled,hasKey,status(ok|stale|error|no-key|idle|disabled),balance,
//   credits{today,week,month,allTime},byType{type:{credits,tasks}},
//   daily[]{date,credits,tasks},families[],fetchedAt,error}).
//
// RENDERS NOTHING unless meshy.enabled && status !== 'disabled' — the rail's
// "Meshy credits" nav item disappears with it. CREDITS ARE NOT DOLLARS: never
// money(), never "$", never summed with spend.
//
// ENDPOINT: POST /api/meshy/enable with JSON BODY { key } (set / replace) or
// { key: '' } (remove) via postJson. The key NEVER goes in a URL, is wiped
// from state the moment it is sent, and is never displayed (payload: hasKey).
// =============================================================================
import { useId, useState } from 'react';
import { Section, Panel, Btn, Badge, Input, MBar, Tip, InfoTip, cx } from '../ui.jsx';
import { Icon } from '../icons.jsx';
import { BRAND, ago, num, postJson, shortDate } from '../lib.js';
import './Meshy.css';

// Every task family Meshy documents (mirrors the server's MESHY_FAMILIES probe
// list). Only some have a list endpoint Pulse can confirm; the payload says
// which answered, and anything missing is named rather than rounded away.
const MESHY_FAMILIES = [
  'text-to-3d', 'image-to-3d', 'multi-image-to-3d', 'text-to-texture',
  'retexture', 'remesh', 'rigging', 'animation',
];
const MESHY_FAMILY_LABEL = {
  'text-to-3d': 'Text to 3D',
  'image-to-3d': 'Image to 3D',
  'multi-image-to-3d': 'Multi-image to 3D',
  'text-to-texture': 'Text to texture',
  retexture: 'Retexture',
  remesh: 'Remesh',
  rigging: 'Rigging',
  animation: 'Animation',
};
// Friendly label for a task-type key. The server reports both the family
// ("text-to-3d") and finer stage keys ("text_to_3d_preview"), with either
// separator: normalise, match the longest family prefix, and show the rest as
// a " · stage" suffix → "Text to 3D · preview". Unknown keys are humanised.
export const MESHY_TYPE = {
  text_to_3d_preview: 'Text to 3D · preview',
  text_to_3d_refine: 'Text to 3D · refine',
};
export function meshyTypeLabel(key) {
  const raw = String(key || '');
  if (MESHY_TYPE[raw]) return MESHY_TYPE[raw];
  const k = raw.toLowerCase().replace(/_/g, '-');
  if (MESHY_FAMILY_LABEL[k]) return MESHY_FAMILY_LABEL[k];
  const fam = Object.keys(MESHY_FAMILY_LABEL)
    .sort((a, b) => b.length - a.length)
    .find((f) => k.startsWith(f + '-'));
  if (fam) return MESHY_FAMILY_LABEL[fam] + ' · ' + k.slice(fam.length + 1).replace(/-/g, ' ');
  const words = k.replace(/-/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : raw;
}
// A family list for prose: "Image to 3D, remesh and rigging".
function familyList(fams) {
  const names = fams.map((f, i) => {
    const l = MESHY_FAMILY_LABEL[f] || f;
    return i === 0 ? l : l.replace(/^([A-Z])(?![A-Z0-9])/, (m) => m.toLowerCase());
  });
  if (names.length <= 1) return names.join('');
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

// Credits are whole-number-ish; never formatted like money.
export function credits(v) {
  if (v == null) return '—';
  const n = Number(v);
  if (!isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString('en-US');
  return (Math.round(n * 10) / 10).toLocaleString('en-US');
}
const plural = (n, one, many) => (n === 1 ? one : (many || one + 's'));

// Set / replace / remove the Meshy API key. The key is a SECRET: it travels in
// the POST body only, is wiped from component state the moment it is sent,
// and the server never echoes it back — the UI only ever learns hasKey.
//   hasKey     → "Replace key" wording (+ Remove when allowRemove)
//   onDone     → after a successful save/remove
//   onCancel   → shows a Cancel button
export function MeshyKeyForm({ hasKey, onDone, onCancel, allowRemove = true, autoFocus = false, className }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(null); // 'save' | 'remove' | null
  const [err, setErr] = useState(null);
  const id = useId();

  async function send(value, kind) {
    setBusy(kind); setErr(null);
    try {
      await postJson('/api/meshy/enable', { key: value });
      setKey(''); // never keep the secret around longer than the request
      setBusy(null);
      if (onDone) onDone(kind);
      return;
    } catch (e) {
      setKey(''); // a failed save still drops the secret; the user re-pastes
      setErr(e.message);
    }
    setBusy(null);
  }
  const save = () => { const k = key.trim(); if (k && !busy) send(k, 'save'); };

  return (
    <div className={cx('meshy-kf', className)}>
      <label className="sr" htmlFor={id}>{hasKey ? 'New Meshy API key' : 'Meshy API key'}</label>
      <div className="meshy-kf-row">
        <Input
          id={id}
          mono
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          placeholder={hasKey ? 'paste a new key · msy_…' : 'paste your key · msy_…'}
          value={key}
          disabled={!!busy}
          onChange={(e) => { setKey(e.target.value); setErr(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape' && onCancel) onCancel();
          }}
        />
        <Btn variant="primary" size="sm" icon="key" disabled={!!busy || !key.trim()} onClick={save}>
          {busy === 'save' ? 'Saving…' : hasKey ? 'Replace key' : 'Save key'}
        </Btn>
        {hasKey && allowRemove ? (
          <Btn variant="ghost" size="sm" disabled={!!busy} onClick={() => send('', 'remove')}>
            {busy === 'remove' ? 'Removing…' : 'Remove key'}
          </Btn>
        ) : null}
        {onCancel ? <Btn variant="ghost" size="sm" disabled={!!busy} onClick={onCancel}>Cancel</Btn> : null}
      </div>
      {err ? <div className="meshy-kf-err" role="alert"><Icon name="alert" size={12} />Couldn’t save the key: {err}</div> : null}
    </div>
  );
}

const INFO = 'Meshy bills in credits with no published credit-to-dollar rate, so they never enter spend, budget or plan value. '
  + `Read with an opt-in Meshy API key that ${BRAND} sends only to api.meshy.ai.`;

function Title() {
  return (
    <>
      <Icon name="cube" size={14} />
      <span className="meshy-tt">Meshy · 3D generation</span>
      <Badge tone="accent">Credits</Badge>
    </>
  );
}

export default function Meshy({ id, data }) {
  const m = data.meshy;
  const [editing, setEditing] = useState(false);
  if (!m || !m.enabled || m.status === 'disabled') return null;

  // ---- no key yet: an invitation, not an error --------------------------------
  if (!m.hasKey || m.status === 'no-key') {
    return (
      <Section id={id} title="Meshy credits" meta="own unit · never mixed with $">
        <Panel span={12} title={<Title />} info={INFO} ctx="not connected yet" className="meshy-panel">
          <div className="meshy-invite">
            <p className="hint">
              Paste a Meshy API key to track 3D-generation credits: the balance left and what each generation used,
              kept in its own unit. Sent only to <b>api.meshy.ai</b>.
            </p>
            <MeshyKeyForm hasKey={false} />
            <p className="hint">
              Create a key in your Meshy account settings. {BRAND} stores it in <code>~/.pulse/config.json</code> on
              this machine and never logs it or puts it in a page, a URL or an export.
            </p>
          </div>
        </Panel>
      </Section>
    );
  }

  const c = m.credits || {};
  const daily = Array.isArray(m.daily) ? m.daily : [];
  const types = Object.entries(m.byType || {})
    .filter(([, v]) => v && ((v.credits || 0) > 0 || (v.tasks || 0) > 0))
    .sort((a, b) => (b[1].credits || 0) - (a[1].credits || 0));
  const maxDaily = daily.reduce((mx, d) => Math.max(mx, d.credits || 0), 0);
  const maxType = types.reduce((mx, t) => Math.max(mx, t[1].credits || 0), 0) || 1;
  const totalTasks = types.reduce((n, t) => n + (t[1].tasks || 0), 0);
  const hasHistory = maxDaily > 0 || types.length > 0;
  const families = Array.isArray(m.families) ? m.families : [];
  const missing = MESHY_FAMILIES.filter((f) => !families.includes(f));

  // A failed or throttled refresh keeps the last good numbers and says how old
  // they are. 'stale' before the very first fetch is not a failure.
  const bad = m.status === 'error';
  const degraded = m.status === 'stale' || bad;
  const firstRead = !m.fetchedAt && !m.error && (m.status === 'stale' || m.status === 'idle');
  const ctx = m.fetchedAt
    ? `read from your Meshy account ${ago(m.fetchedAt)} · at most every 15 min`
    : 'reading your Meshy account…';

  let footer = null;
  if (firstRead) {
    footer = <span className="meshy-note"><Icon name="clock" size={14} />Reading your Meshy account now. The numbers come from {BRAND}’s local cache until it lands.</span>;
  } else if (degraded) {
    footer = (
      <span className={cx('meshy-note', bad ? 'crit' : 'warn')} role="status">
        <Icon name="alert" size={14} />
        <span>
          {m.fetchedAt ? <>Showing the last good numbers from {ago(m.fetchedAt)}. </> : null}
          {m.error || (bad ? 'The last Meshy refresh failed.' : `Meshy is not responding; ${BRAND} backs off and retries.`)}
          {bad ? ' If the key was revoked, replace it with Manage key.' : ''}
        </span>
      </span>
    );
  }

  return (
    <Section id={id} title="Meshy credits" meta="own unit · never mixed with $">
      <Panel
        span={12}
        title={<Title />}
        info={INFO}
        ctx={ctx}
        className={cx('meshy-panel', degraded && !firstRead && (bad ? 'is-crit' : 'is-warn'))}
        actions={(
          <Btn size="sm" icon="key" aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
            {editing ? 'Close' : 'Manage key'}
          </Btn>
        )}
        footer={footer}
      >
        {editing ? (
          <div className="meshy-edit">
            <MeshyKeyForm hasKey autoFocus onDone={() => setEditing(false)} onCancel={() => setEditing(false)} />
            <p className="hint">An API key is set on this machine. A new key takes effect on the next refresh; removing it pauses Meshy until you add one.</p>
          </div>
        ) : null}
        <div className="meshy">
          <div className="meshy-bal">
            <div className="bigunit tn">{credits(m.balance)}<small>credits left</small></div>
            <dl className="minidl">
              <div><dt>Today</dt><dd>{credits(c.today)}</dd></div>
              <div><dt>7 days</dt><dd>{credits(c.week)}</dd></div>
              <div><dt>30 days</dt><dd>{credits(c.month)}</dd></div>
              <div>
                <dt>
                  <Tip content={`Every task ${BRAND} has recorded, including pruned history. The first read pages back about 30 days, so older generations are not counted.`}>
                    <span className="meshy-dt-tip" tabIndex={0}>Tracked total</span>
                  </Tip>
                </dt>
                <dd>{credits(c.allTime)}</dd>
              </div>
            </dl>
          </div>

          {hasHistory ? (
            <>
              <div className="meshy-daily">
                <div className="sublab">Credits per day<span>last {daily.length || 30} days</span></div>
                <div
                  className="mbars"
                  role="img"
                  aria-label={`Credits per day, last ${daily.length} days: ${credits(daily.reduce((s, d) => s + (d.credits || 0), 0))} credits in total, peak ${credits(maxDaily)} in one day.`}
                >
                  {daily.map((d) => {
                    const v = d.credits || 0;
                    return (
                      <Tip
                        key={d.date}
                        content={<><b>{shortDate(d.date)}</b> · {credits(v)} {plural(v, 'credit')} · {num(d.tasks || 0)} {plural(d.tasks || 0, 'task')}</>}
                      >
                        <span className="mb-col">
                          <i className={v > 0 ? undefined : 'zero'} style={{ height: maxDaily > 0 && v > 0 ? Math.max(3, (v / maxDaily) * 100).toFixed(1) + '%' : undefined }} />
                        </span>
                      </Tip>
                    );
                  })}
                </div>
                <div className="cx-cap"><span>{daily.length ? shortDate(daily[0].date) : ''}</span><span>Today</span></div>
              </div>

              <div className="meshy-types">
                <div className="sublab">By task type<span>{num(totalTasks)} {plural(totalTasks, 'task')} tracked</span></div>
                {types.length ? (
                  <div className="tbl meshy-tbl" role="table" aria-label="Credits by task type">
                    {types.map(([t, v]) => (
                      <div className="tr" role="row" key={t}>
                        <span className="t" role="cell" title={t}>{meshyTypeLabel(t)}</span>
                        <span className="barcell" role="cell">
                          <MBar value={v.credits || 0} max={maxType} color="var(--q5)" />
                          <span className="v">{credits(v.credits)}</span>
                        </span>
                        <span className="r muted" role="cell">{num(v.tasks || 0)} {plural(v.tasks || 0, 'task')}</span>
                      </div>
                    ))}
                  </div>
                ) : <p className="hint">No per-type breakdown yet.</p>}
                {missing.length > 0 && (families.length > 0 || !!m.fetchedAt) ? (
                  <p className="hint meshy-cov">
                    Counts {families.length ? <b>{families.join(', ')}</b> : <b>no task family yet</b>} only.{' '}
                    {familyList(missing)} {missing.length === 1 ? 'has' : 'have'} no list endpoint {BRAND} can confirm, so the
                    balance can fall faster than shown.
                  </p>
                ) : null}
              </div>
            </>
          ) : (
            <div className="meshy-none">
              <p className="hint">
                {m.fetchedAt
                  ? 'No generations in the last 30 days. The balance is read straight from your Meshy account.'
                  : 'Nothing read from your Meshy account yet.'}
              </p>
            </div>
          )}
        </div>
      </Panel>
    </Section>
  );
}
