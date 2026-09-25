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
#     (1440–3440 px): the content column is centred past its cap and the top
#     bar lines up with it; the rail's source rows fit "Claude Desktop" beside
#     a four-figure amount while a long label still ellipsizes.
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
  CLINE_DIR=$TMP/no-cline ROO_DIR=$TMP/no-roo PULSE_NO_TRAY_SPAWN=1 PULSE_NO_STRIP_SPAWN=1 PULSE_NO_OPENUSAGE_SPAWN=1 \
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

// Wide screens: past the --content-max cap the content column is CENTRED in the
// main area (it used to hug the left, leaving a dark band on the right), and the
// top bar keeps its contents on the content edges at every width.
const CAP = 2000;
for (const w of [1440, 1920, 2560, 3440]) {
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
  if (r.main.w > CAP) {
    ok(near(r.box.w, CAP) && near(r.box.l - r.main.l, r.main.r - r.box.r), w + "px: the capped column is centred in the main area (" + JSON.stringify(r.box) + " in " + JSON.stringify(r.main) + ")");
  } else {
    ok(near(r.box.w, r.main.w), w + "px: below the cap the column fills the main area");
  }
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
