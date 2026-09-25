#!/bin/bash
# Web app notices + version label (v2.0.0 review fixes).
#   Part 1 (always, plain Node): web/src/notices.js — Claude Code integration
#     rows are grouped (the documented effort hook is registered under TWO hook
#     events, so a moved exe used to print word-for-word duplicate warning bars
#     and System rows), per-issue dismissal storage, and the command the help
#     copy prints: `node server.js` from source (payload.exeName null), never
#     a Windows exe name; `./burnglass-linux` for a Linux binary.
#   Part 2 (when Playwright + Chromium are available, else SKIP): the REAL
#     server from source + its committed web/dist in Chromium — one bar per
#     missing file with the source command, Dismiss persists across a reload
#     under a pulse-* localStorage key while a different issue still shows,
#     System lists each integration once, and the rail / mobile sub-line shows
#     a pre-release version (v2.0.0-rc.1) whole at 360–1920 px. Wide screens
#     (1440–3840 px, 4K at 100–150% scaling): the content column fills the
#     whole main area — no cap, no dead band — and the top bar lines up with it; the rail's source rows fit "Claude Desktop" beside
#     a four-figure amount while a long label still ellipsizes — also when the
#     rail SCROLLS with a classic scrollbar (a second Chromium without
#     --hide-scrollbars, short window). Meter rows keyed __proto__ /
#     constructor never blank the page; a stale Claude window says "waiting
#     for the next check" (Codex keeps "run a turn"); a failed post-update
#     strip refresh shows in System's strip row with how it will heal.
# Part 2 checks web/dist, so run `npm run build` (web/) after changing web/src.
# Env: WEB_TEST_SERVER=<server.js> tests another copy (e.g. a scratch build);
#      WEB_TEST_PORT (default 4923); PLAYWRIGHT_MODULE / PW_CHROMIUM overrides.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
FAIL=0

# ---- Part 1: pure helpers ---------------------------------------------------------
node -e '
const { pathToFileURL } = require("node:url");
const modPath = require("node:path").join(process.argv[1], "web", "src", "notices.js");
import(pathToFileURL(modPath).href).then((N) => {
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + "  " + m); if (!c) fail = 1; };
const GONE = "/home/u/Downloads/pulse-linux";
// What claudeIntegrations() reports for the documented --effort-setup (one
// command under SessionStart AND UserPromptSubmit) + a status line, all
// pointing at a deleted exe; plus a healthy hook elsewhere.
const rows = [
  { kind: "statusline", event: null, target: GONE, exists: false, legacyName: true },
  { kind: "effort-hook", event: "SessionStart", target: GONE, exists: false, legacyName: true },
  { kind: "effort-hook", event: "UserPromptSubmit", target: GONE, exists: false, legacyName: true },
  { kind: "effort-hook", event: "SessionStart", target: "/opt/bg/burnglass-linux", exists: true, legacyName: false },
  { kind: "statusline", event: null, target: null, exists: null, legacyName: false },
  null, "junk",
];
const issues = N.integrationIssues(rows);
ok(issues.length === 1, "one notice for one missing file (got " + issues.length + ")");
ok(issues[0] && issues[0].target === GONE && issues[0].kinds.join() === "statusline,effort-hook",
   "the notice names both integrations that run it (" + JSON.stringify(issues[0] && issues[0].kinds) + ")");
ok(issues[0] && issues[0].sig === "integration:statusline+effort-hook:" + GONE, "stable issue signature (" + (issues[0] && issues[0].sig) + ")");
const hooksOnly = N.integrationIssues(rows.slice(1, 3));
ok(hooksOnly.length === 1 && hooksOnly[0].kinds.join() === "effort-hook" && hooksOnly[0].events.join() === "SessionStart,UserPromptSubmit",
   "the two effort-hook events collapse into one notice");
ok(hooksOnly[0].sig !== issues[0].sig, "a different set of integrations is a different issue");
const two = N.integrationIssues([rows[0], { kind: "effort-hook", event: "SessionStart", target: "/old/pulse.exe", exists: false }]);
ok(two.length === 2, "two missing files → two notices");
ok(N.integrationIssues(rows.slice(3)).length === 0 && N.integrationIssues(undefined).length === 0, "nothing missing → no notice");

const sys = N.integrationRows(rows);
ok(sys.length === 3, "System lists each integration + file once (got " + sys.length + ": " + sys.map((r) => r.kind + ">" + r.target).join(" | ") + ")");
const eh = sys.find((r) => r.kind === "effort-hook" && r.target === GONE);
ok(eh && eh.exists === false && eh.events.join() === "SessionStart,UserPromptSubmit", "the grouped hook row keeps both events and exists:false");
const mixed = N.integrationRows([{ kind: "effort-hook", event: "A", target: "/x", exists: true }, { kind: "effort-hook", event: "B", target: "/x", exists: false }]);
ok(mixed.length === 1 && mixed[0].exists === false, "a later missing row is never hidden by an earlier one");

// Command for the fix-it copy — derived from payload fields, never a hard-coded Windows exe.
const L = N.launchInfo;
const src = L({ packaged: false, exeName: null });
ok(src.cmd === "node server.js" && src.source === true && src.shortcuts === false && src.file === null,
   "from source (exeName null): node server.js, no double-click / shortcuts (" + JSON.stringify(src) + ")");
ok(!/\.exe/.test(src.cmd), "from source the command names no .exe");
ok(L({ packaged: true, exeName: "burnglass-linux" }).cmd === "./burnglass-linux", "packaged Linux: ./burnglass-linux");
ok(L({ packaged: true, exeName: "burnglass-macos" }).shortcuts === false, "packaged macOS: no Windows shortcuts copy");
const win = L({ packaged: true, exeName: "pulse.exe" });
ok(win.cmd === "pulse.exe" && win.file === "pulse.exe" && win.shortcuts === true, "packaged Windows keeps its own (self-updated) name");
ok(L({ packaged: true, exeName: "burnglass (1).exe" }).cmd === "\"burnglass (1).exe\"", "a name with spaces is quoted (Windows)");
ok(L({ packaged: true, exeName: "burnglass linux" }).cmd === "\x27./burnglass linux\x27", "a name with spaces is quoted (POSIX)");
ok(L(null).cmd === "burnglass.exe" && N.exeName(null) === "burnglass.exe", "before the first payload: the default exe name");

// Per-issue dismissal storage (lib.js keeps it under pulse-dismissed-notices).
ok(N.isDismissed(null, "a") === false && N.isDismissed("{not json", "a") === false && N.isDismissed("[1]", "a") === false,
   "missing / corrupt stored value → nothing dismissed");
let raw = N.addDismissed("{bad", "integration:statusline:" + GONE, 1000);
ok(N.isDismissed(raw, "integration:statusline:" + GONE) && !N.isDismissed(raw, "integration:effort-hook:" + GONE), "dismissal is per signature");
ok(N.isDismissed(N.addDismissed(null, "__proto__", 5), "__proto__") && ({}).polluted === undefined, "a __proto__ signature is stored as data");
for (let i = 0; i < 40; i++) raw = N.addDismissed(raw, "sig" + i, 2000 + i);
const kept = Object.keys(JSON.parse(raw));
ok(kept.length === N.DISMISS_MAX && kept.includes("sig39") && !kept.includes("sig0"), "stored value is capped to the newest " + N.DISMISS_MAX);
ok(N.isDismissed(N.addDismissed(raw, "tie", 2039), "tie"), "the one just dismissed survives the cap on a timestamp tie");
process.exit(fail);
}).catch((e) => { console.error("FAIL  could not import web/src/notices.js:", e.message); process.exit(1); });
' "$ROOT" || FAIL=1

# ---- Part 2: the built dashboard in Chromium ------------------------------------------
SERVER=${WEB_TEST_SERVER:-$ROOT/server.js}
PORT=${WEB_TEST_PORT:-4923}
PWMOD=${PLAYWRIGHT_MODULE:-}
if [ -z "$PWMOD" ]; then
  PWMOD=$(node -e 'try { console.log(require.resolve("playwright")) } catch (_) {}' 2>/dev/null)
fi
if [ -z "$PWMOD" ] && command -v npm >/dev/null 2>&1; then
  G=$(npm root -g 2>/dev/null)
  [ -n "$G" ] && [ -f "$G/playwright/index.js" ] && PWMOD="$G/playwright/index.js"
fi
CHROME=${PW_CHROMIUM:-}
[ -z "$CHROME" ] && [ -x /opt/pw-browsers/chromium ] && CHROME=/opt/pw-browsers/chromium

if [ -z "$PWMOD" ]; then
  echo "SKIP  UI checks: Playwright not found (set PLAYWRIGHT_MODULE)"
else
  TMP=$(mktemp -d)
  CL=$TMP/claude; PH=$TMP/home
  mkdir -p "$CL/projects/demo" "$PH"
  node -e '
const fs = require("fs"); const now = Date.now();
const A = (ms, id, out) => ({ type: "assistant", timestamp: new Date(ms).toISOString(), sessionId: "s1",
  requestId: "r" + id, cwd: "/p", message: { id: "m" + id, model: "claude-fable-5", usage: { input_tokens: 1000, output_tokens: out } } });
fs.writeFileSync(process.argv[1] + "/projects/demo/s.jsonl", [A(now - 3600e3, 1, 20000), A(now - 1800e3, 2, 30000)].map(JSON.stringify).join("\n") + "\n");
// The documented setups (status line + the effort hook under BOTH events),
// all pointing at an exe that was deleted.
const gone = "/nonexistent/Downloads/pulse-linux";
const hook = [{ hooks: [{ type: "command", command: gone + " --mode-hook" }] }];
fs.writeFileSync(process.argv[1] + "/settings.json", JSON.stringify({
  statusLine: { type: "command", command: gone + " --statusline" },
  hooks: { SessionStart: hook, UserPromptSubmit: hook },
}));
' "$CL"
  PULSE_HOME=$PH CLAUDE_DIR=$CL CODEX_DIR=$TMP/no-codex GEMINI_DIR=$TMP/no-gemini CONTINUE_DIR=$TMP/no-continue \
  CLINE_DIR=$TMP/no-cline ROO_DIR=$TMP/no-roo PULSE_NO_TRAY_SPAWN=1 PULSE_NO_STRIP_SPAWN=1 \
  node "$SERVER" --port "$PORT" --no-update-check --no-open >"$TMP/srv.log" 2>&1 &
  SRV=$!
  for _ in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$PORT/api/health" && break; sleep 0.2; done

  node --input-type=module -e '
const [pwmod, chrome, port] = process.argv.slice(1);
const { pathToFileURL } = await import("node:url");
const pw = await import(pathToFileURL(pwmod).href);
const chromium = (pw.chromium || (pw.default && pw.default.chromium));
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + "  " + m); if (!c) fail = 1; };
let browser;
try {
  browser = await chromium.launch({ ...(chrome ? { executablePath: chrome } : {}), args: ["--no-sandbox"] });
} catch (e) {
  console.log("SKIP  UI checks: Chromium did not launch (" + String(e.message).split("\n")[0] + ")");
  process.exit(0);
}
const BASE = "http://127.0.0.1:" + port + "/";
const GONE = "/nonexistent/Downloads/pulse-linux";
async function open(width, patch) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  if (patch) {
    await page.route("**/api/summary*", async (route) => {
      const r = await route.fetch();
      const j = await r.json();
      patch(j);
      await route.fulfill({ response: r, json: j });
    });
  }
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#system", { timeout: 15000 });
  return { ctx, page };
}
const barsFor = (page) => page.evaluate((gone) => [...document.querySelectorAll(".warnbar")]
  .map((b) => b.textContent.replace(/\s+/g, " ").trim()).filter((t) => t.includes(gone)), GONE);

// #7 + #8 — from source, the payload has exeName null.
{
  const { ctx, page } = await open(1280);
  const sum = await page.evaluate(() => fetch("/api/summary").then((r) => r.json()));
  ok(sum.packaged === false && sum.exeName === null && (sum.integrations || []).filter((i) => i.exists === false).length === 3,
     "fixture: source run (exeName null) with 3 integration rows pointing at a deleted exe");
  let bars = await barsFor(page);
  ok(bars.length === 1, "one warning bar for the one missing exe (got " + bars.length + ")");
  ok(new Set(bars).size === bars.length, "no word-for-word duplicate bars");
  const t = bars[0] || "";
  ok(/node server\.js --statusline-setup/.test(t) && /node server\.js --effort-setup/.test(t),
     "the fix-it command is the source invocation (node server.js --statusline-setup / --effort-setup)");
  ok(!/burnglass\.exe|pulse\.exe/.test(t), "no Windows exe name in the source-run bar: " + JSON.stringify(t.slice(0, 160)));
  const hooks = await page.$$eval(".sys-hook", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  ok(hooks.length === 2 && new Set(hooks).size === 2, "System lists the status line and the effort hook once each (" + JSON.stringify(hooks) + ")");
  const restart = await page.$eval(".sys-restart", (e) => e.textContent.replace(/\s+/g, " "));
  ok(/node server\.js/.test(restart) && !/burnglass\.exe|install-shortcuts/.test(restart), "System start-again copy is source-aware: " + JSON.stringify(restart.trim()));
  // Dismiss: gone now, still gone after a reload, stored under a pulse-* key.
  const btn = page.locator(".warnbar", { hasText: GONE }).getByRole("button", { name: /Dismiss/ });
  ok(await btn.count() === 1, "the integration bar has a Dismiss button");
  if (await btn.count()) await btn.first().click();
  ok((await barsFor(page)).length === 0, "Dismiss hides the bar");
  const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("pulse-") && /integration:/.test(localStorage.getItem(k) || "")));
  ok(stored.length === 1, "the dismissal is stored under a pulse-* localStorage key (" + stored.join() + ")");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#system");
  ok((await barsFor(page)).length === 0, "a dismissed issue stays hidden after a reload");
  ok((await page.$$(".sys-hook.sys-err")).length === 2, "System still lists the missing integrations after the dismissal");
  await ctx.close();
}
// A different issue (another missing file) still shows after one was dismissed.
{
  const { ctx, page } = await open(1280);
  const b0 = page.locator(".warnbar", { hasText: GONE }).getByRole("button", { name: /Dismiss/ });
  if (await b0.count()) await b0.first().click();
  await page.route("**/api/summary*", async (route) => {
    const r = await route.fetch(); const j = await r.json();
    j.integrations = (j.integrations || []).concat([{ kind: "statusline", event: null, target: "/elsewhere/pulse.exe", exists: false, legacyName: true }]);
    await route.fulfill({ response: r, json: j });
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#system");
  const all = await page.$$eval(".warnbar", (els) => els.map((e) => e.textContent));
  ok(all.some((t) => t.includes("/elsewhere/pulse.exe")) && !all.some((t) => t.includes(GONE)),
     "a different missing file still gets its bar; the dismissed one stays hidden");
  await ctx.close();
}
// A packaged Linux binary: ./burnglass-linux, not a Windows name.
{
  const { ctx, page } = await open(1280, (j) => { j.packaged = true; j.exeName = "burnglass-linux"; });
  const t = (await barsFor(page))[0] || "";
  ok(/\.\/burnglass-linux --statusline-setup/.test(t) && !/\.exe/.test(t), "packaged Linux: ./burnglass-linux --statusline-setup");
  await ctx.close();
}
// #11 — a pre-release version is shown whole in the rail (≥1024) and the mobile header.
const VER = "2.0.0-rc.1";
async function versionCheck(width, where, extra) {
  const { ctx, page } = await open(width, (j) => { j.version = VER; if (extra) extra(j); });
  const r = await page.evaluate(([sel, ver]) => {
    const sub = document.querySelector(sel);
    if (!sub) return { missing: true };
    // Laid-out text boxes (an ellipsis is paint-only, so a clipped part still
    // measures its full width and reaches past the clipping box).
    const box = sub.getBoundingClientRect();
    const inside = (node) => {
      const rg = document.createRange(); rg.selectNodeContents(node);
      const rc = rg.getBoundingClientRect();
      return rc.width > 0 && rc.left >= box.left - 0.5 && rc.right <= box.right + 0.5;
    };
    const walker = document.createTreeWalker(sub, NodeFilter.SHOW_TEXT);
    let n; let allInside = true; const nodes = []; let all = "";
    while ((n = walker.nextNode())) {
      if (n.textContent.trim() && !inside(n)) allInside = false;
      if (n.textContent.length) { nodes.push([n, all.length]); all += n.textContent; }
    }
    // A Range over exactly the version characters ("v" + version may span two text nodes).
    let verInside = false;
    const at = all.indexOf(ver);
    if (at >= 0) {
      const pos = (i) => { let k = nodes.length - 1; while (k > 0 && nodes[k][1] > i) k--; return [nodes[k][0], i - nodes[k][1]]; };
      const rg = document.createRange();
      rg.setStart(...pos(at)); rg.setEnd(...pos(at + ver.length - 1)); rg.setEnd(rg.endContainer, rg.endOffset + 1);
      const rc = rg.getBoundingClientRect();
      verInside = rc.width > 0 && rc.left >= box.left - 0.5 && rc.right <= box.right + 0.5;
    }
    return { verInside, allInside, text: sub.textContent,
             hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  }, [where, "v" + VER]);
  ok(!r.missing && r.verInside, width + "px " + where + ": v" + VER + " fully visible (" + JSON.stringify(r.text) + ")");
  ok(!r.missing && r.allInside, width + "px " + where + ": no part of the sub-line is cut off");
  ok(!r.hscroll, width + "px: no horizontal page scroll");
  await ctx.close();
}
for (const w of [1025, 1280, 1920]) await versionCheck(w, ".rail .brand-sub");
await versionCheck(360, ".mhead .brand-sub", (j) => { j.update = Object.assign({}, j.update, { status: "available", latest: "2.0.0-rc.2" }); });

// Wide screens: the content column FILLS the main area at every width (a 1600 px
// cap used to hug the left and leave a dark band on the right of a 4K screen —
// the user runs 4K, i.e. 2560–3840 CSS px), and the top bar keeps its contents
// on the content edges.
for (const w of [1440, 1920, 2560, 3072, 3200, 3840]) {
  const { ctx, page } = await open(w);
  const r = await page.evaluate(() => {
    const main = document.querySelector(".main").getBoundingClientRect();
    const c = document.querySelector(".content"), cs = getComputedStyle(c), cr = c.getBoundingClientRect();
    const inner = { l: cr.left + parseFloat(cs.paddingLeft), r: cr.right - parseFloat(cs.paddingRight) };
    const kids = [...document.querySelector(".topbar").children].filter((k) => k.getBoundingClientRect().width > 0);
    const tb = { l: kids[0].getBoundingClientRect().left, r: kids[kids.length - 1].getBoundingClientRect().right };
    return { main: { l: main.left, r: main.right, w: main.width }, box: { l: cr.left, r: cr.right, w: cr.width }, inner, tb,
             hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  });
  const near = (a, b) => Math.abs(a - b) <= 1;
  ok(near(r.tb.l, r.inner.l) && near(r.tb.r, r.inner.r), w + "px: top bar contents line up with the content edges (" + JSON.stringify({ tb: r.tb, content: r.inner }) + ")");
  ok(near(r.box.l, r.main.l) && near(r.box.r, r.main.r), w + "px: the column fills the main area edge to edge (" + JSON.stringify(r.box) + " in " + JSON.stringify(r.main) + ")");
  ok(!r.hscroll, w + "px: no horizontal page scroll");
  await ctx.close();
}

// Rail source rows (240 px rail): "Claude Desktop" beside a four-figure amount
// is shown whole (it was cut to "Claude Desk…"); a long custom label still
// ellipsizes, and the amount beside it is never clipped.
{
  const { ctx, page } = await open(1440, (j) => {
    j.allSources = ["claude-desktop", "cli", "foreman"];
    j.sourceMeta = Object.assign({}, j.sourceMeta, { foreman: { label: "Foreman nightly builds" } });
    for (const p of j.periods || []) {
      p.bySource = { "claude-desktop": { cost: 2178.09, tokens: 1, messages: 1 }, cli: { cost: 3.45, tokens: 1, messages: 1 }, foreman: { cost: 1234.5, tokens: 1, messages: 1 } };
    }
  });
  const rows = await page.$$eval(".rail .srcrow .opt", (els) => els.map((o) => {
    const l = o.querySelector(".lbl"), a = o.querySelector(".amt");
    const or = o.getBoundingClientRect(), ar = a.getBoundingClientRect();
    return { label: l.textContent, amt: a.textContent, cut: l.scrollWidth > l.clientWidth, ellipsis: getComputedStyle(l).textOverflow,
             amtInside: ar.left >= or.left && ar.right <= or.right - 4, amtWhole: a.scrollWidth <= a.clientWidth };
  }));
  const desk = rows.find((x) => x.label === "Claude Desktop");
  const long = rows.find((x) => x.label === "Foreman nightly builds");
  ok(desk && desk.amt === "$2,178.09" && !desk.cut, "rail: \"Claude Desktop\" fits beside $2,178.09 (" + JSON.stringify(desk) + ")");
  ok(long && long.cut && long.ellipsis === "ellipsis", "rail: a long source label still ellipsizes (" + JSON.stringify(long) + ")");
  ok(rows.length === 3 && rows.every((x) => x.amtInside && x.amtWhole), "rail: every amount is shown whole inside its row");
  await ctx.close();
}
const RAIL_PATCH = (j) => {
  j.allSources = ["claude-desktop", "cli", "foreman"];
  for (const p of j.periods || []) {
    p.bySource = { "claude-desktop": { cost: 2178.09, tokens: 1, messages: 1 }, cli: { cost: 3.45, tokens: 1, messages: 1 }, foreman: { cost: 1234.5, tokens: 1, messages: 1 } };
  }
};
// ...and while the rail SCROLLS with a classic scrollbar: Playwright hides
// scrollbars by default (--hide-scrollbars), so a second Chromium keeps them
// and a short window makes the rail overflow (a long month list does the
// same on a tall one). The label used to lose ~1.5 px to the scrollbar.
{
  let b2 = null;
  try {
    b2 = await chromium.launch({ ...(chrome ? { executablePath: chrome } : {}), args: ["--no-sandbox"], ignoreDefaultArgs: ["--hide-scrollbars"] });
  } catch (e) { console.log("SKIP  rail with a classic scrollbar: Chromium did not launch (" + String(e.message).split("\n")[0] + ")"); }
  if (b2) {
    for (const [w, h] of [[1440, 520], [1920, 600]]) {
      const ctx = await b2.newContext({ viewport: { width: w, height: h }, colorScheme: "dark" });
      const page = await ctx.newPage();
      await page.route("**/api/summary*", async (route) => {
        const r = await route.fetch(); const j = await r.json(); RAIL_PATCH(j);
        await route.fulfill({ response: r, json: j });
      });
      await page.goto(BASE, { waitUntil: "networkidle" });
      await page.waitForSelector(".rail .srcrow .opt", { timeout: 15000 });
      const r = await page.evaluate(() => {
        const ri = document.querySelector(".rail-in");
        const rows = [...document.querySelectorAll(".rail .srcrow .opt")].map((o) => {
          const l = o.querySelector(".lbl"), a = o.querySelector(".amt");
          return { label: l.textContent, amt: a.textContent, cut: l.scrollWidth > l.clientWidth };
        });
        return { scrolls: ri.scrollHeight > ri.clientHeight, scrollbarW: ri.offsetWidth - ri.clientWidth, rows };
      });
      const desk = r.rows.find((x) => x.label === "Claude Desktop");
      if (!r.scrolls || r.scrollbarW <= 0) {
        console.log("SKIP  " + w + "x" + h + " rail: no classic scrollbar here (" + JSON.stringify({ scrolls: r.scrolls, scrollbarW: r.scrollbarW }) + ")");
      } else {
        ok(desk && desk.amt === "$2,178.09" && !desk.cut,
           w + "x" + h + " rail scrolling with a " + r.scrollbarW + " px scrollbar: \"Claude Desktop\" still whole beside $2,178.09 (" + JSON.stringify(desk) + ")");
      }
      await ctx.close();
    }
    await b2.close();
  }
}

// Meter rows keyed like Object.prototype members never blank the page
// (METER_NAMES["__proto__"] used to hand React an object: error #31).
{
  const errors = [];
  const soon = Date.now() + 3600e3;
  // Not open(): a blanked page never shows #system, and that must be a FAIL
  // here, not a timeout that ends the whole run.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 120)));
  await page.route("**/api/summary*", async (route) => {
    const r = await route.fetch(); const j = await r.json();
    j.meters = { enabled: true, status: "ok", fetchedAt: Date.now(), lastGoodAt: Date.now(), error: null, buckets: [
      { key: "__proto__", label: "Claude · proto", pct: 40, resetsAt: soon, stale: false, projLeftAtReset: null },
      { key: "constructor", label: "Claude · ctor", pct: 20, resetsAt: soon, stale: false, projLeftAtReset: null },
      { key: "five_hour", label: "Claude · 5-hour session", pct: 30, resetsAt: soon, stale: false, projLeftAtReset: null } ] };
    j.alerts = [];
    await route.fulfill({ response: r, json: j });
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#system", { timeout: 8000 }).catch(() => {});
  const r = await page.evaluate(() => ({
    root: (document.getElementById("root") || { childElementCount: 0 }).childElementCount,
    cells: [...document.querySelectorAll(".mc .nm")].map((e) => e.textContent),
  }));
  ok(r.root > 0 && errors.length === 0 && r.cells.includes("Proto") && r.cells.includes("Ctor") && r.cells.includes("5-hour session"),
     "meter rows keyed __proto__ / constructor render as plain cells, the page stays up (" + JSON.stringify({ cells: r.cells, errors }) + ")");
  await ctx.close();
}

// A stale (rolled-over) window: the Claude server re-checks on its own, Codex
// needs a turn — the cell and the mini view say which.
{
  const past = Date.now() - 60e3, soon = Date.now() + 3600e3;
  const patch = (j) => {
    j.meters = { enabled: true, status: "rate-limited", fetchedAt: Date.now(), lastGoodAt: Date.now() - 600e3, error: "rate-limited", buckets: [
      { key: "five_hour", label: "Claude · 5-hour session", pct: 97, resetsAt: past, stale: true, projLeftAtReset: null },
      { key: "seven_day", label: "Claude · weekly (all models)", pct: 50, resetsAt: soon, stale: false, projLeftAtReset: null } ] };
    j.codexMeters = { asOf: Date.now() - 600e3, buckets: [
      { key: "codex_primary", label: "Codex · session (5h)", pct: 60, resetsAt: past, stale: true } ] };
    j.alerts = [];
  };
  const { ctx, page } = await open(1280, patch);
  const cells = await page.$$eval(".mc", (els) => els.map((e) => ({ nm: e.querySelector(".nm").textContent, stale: e.classList.contains("stale"), foot: e.querySelector(".mc-foot").textContent })));
  const fh = cells.find((c) => c.nm === "5-hour session"), cxp = cells.find((c) => /Codex/.test(c.nm));
  ok(fh && fh.stale && /waiting for the next check/.test(fh.foot) && !/run a/.test(fh.foot), "a stale Claude window: dimmed, \"waiting for the next check\" (" + JSON.stringify(fh) + ")");
  ok(cxp && cxp.stale && /run a Codex turn/.test(cxp.foot), "a stale Codex window still says to run a turn (" + JSON.stringify(cxp) + ")");
  await page.goto(BASE + "#mini", { waitUntil: "networkidle" });
  await page.waitForSelector(".mini-row", { timeout: 15000 }).catch(() => {});
  const mini = await page.$$eval(".mini-row", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  ok(mini.some((t) => /5-hour session/.test(t) && /stale · waiting for the next check/.test(t)) && mini.some((t) => /stale · run a turn/.test(t)),
     "#mini: the same per-provider stale copy (" + JSON.stringify(mini) + ")");
  await ctx.close();
}

// A failed post-update strip refresh shows in the System strip row, with how it
// heals (retry timer / next start / by hand from the release page).
{
  const base = { status: "failed", version: "2.0.0-rc.2", error: "release lookup failed: HTTP 500", at: Date.now(), attempts: 1, checking: false };
  const stripRow = async (refresh) => {
    const { ctx, page } = await open(1280, (j) => {
      j.strip = { supported: true, enabled: true, path: "C:\\burnglass\\burnglass-strip.exe", refresh };
      j.update = Object.assign({}, j.update, { releasesUrl: "https://github.com/ReFxFrank/Burnglass/releases" });
    });
    const t = await page.evaluate(() => {
      const row = [...document.querySelectorAll(".tg")].find((r) => /Strip/.test((r.querySelector(".tg-n") || {}).textContent || ""));
      if (!row) return null;
      const a = row.querySelector(".sys-strip-refresh a");
      return { text: row.textContent.replace(/\s+/g, " ").trim(), href: a ? a.getAttribute("href") : null };
    });
    await ctx.close();
    return t;
  };
  let t = await stripRow(Object.assign({}, base, { retriesLeft: 4, retryAt: Date.now() + 30 * 60e3 }));
  ok(t && /Update failed/.test(t.text) && /Couldn’t update the strip to v2\.0\.0-rc\.2: release lookup failed: HTTP 500\./.test(t.text) && /Retrying in ~30 min\./.test(t.text),
     "System strip row: a failed refresh with its retry countdown (" + JSON.stringify(t && t.text.slice(0, 200)) + ")");
  t = await stripRow(Object.assign({}, base, { retriesLeft: 3, retryAt: null }));
  ok(t && /Retrying at the next start/.test(t.text), "System strip row: retried at the next start when no timer runs");
  t = await stripRow(Object.assign({}, base, { attempts: 5, retriesLeft: 0, retryAt: null }));
  ok(t && /release page/.test(t.text) && t.href === "https://github.com/ReFxFrank/Burnglass/releases", "System strip row: after the last attempt, the release page link (" + JSON.stringify(t) + ")");
  t = await stripRow({ status: "updated", version: "2.0.0-rc.2", at: Date.now(), attempts: 1, files: [] });
  ok(t && !/Couldn’t update/.test(t.text) && !/Update failed/.test(t.text), "System strip row: a successful refresh adds nothing");
}

// The OpenUsage launch is retired (Burnglass Strip replaced it): the System
// integrations keep their Windows rows (startup / tray / strip) and never show
// an OpenUsage row — not even for a payload that still carries the old key.
{
  const { ctx, page } = await open(1280, (j) => {
    j.startup = { supported: true, enabled: false };
    j.tray = { supported: true, enabled: false };
    j.strip = { supported: true, enabled: false, path: null, refresh: null };
    j.openusage = { supported: true, enabled: true, path: null };
  });
  const r = await page.evaluate(() => ({
    names: [...document.querySelectorAll(".sec-system .tg .tg-n")].map((e) => e.textContent.trim()),
    ou: /openusage/i.test(document.body.textContent),
  }));
  ok(r.names.includes("Start with Windows") && r.names.includes("Tray icon") && r.names.some((n) => /Strip$/.test(n))
     && !r.names.some((n) => /openusage/i.test(n)) && !r.ou,
     "System integrations: the Windows rows render, no OpenUsage row (" + JSON.stringify(r) + ")");
  await ctx.close();
}
await browser.close();
process.exit(fail);
' "$PWMOD" "$CHROME" "$PORT" || FAIL=1
  kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
  if [ $FAIL -ne 0 ]; then
    echo "hint: part 2 drives $(dirname "$SERVER")/web/dist — after changing web/src, run npm run build in web/"
    echo "---- server log:"; tail -5 "$TMP/srv.log"
  fi
  rm -rf "$TMP"
fi

echo "---- exit $FAIL"
exit $FAIL
