#!/bin/bash
# Display currency: costs stay USD in every payload; payload.currency says how
# to SHOW them. Rates are the ECB's daily reference rates (a mock here),
# fetched ONLY while a non-USD currency is in use and only by the server that
# owns its port; a typed rate needs no network at all. Budget / plan amounts
# are stored in the currency they were entered in. Owns ports 4941-4946.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
MOCK=4941; P1=4942; P2=4943; P3=4944; P4=4945
for p in $MOCK $P1 $P2 $P3 $P4; do
  if curl -s -o /dev/null "http://127.0.0.1:$p/" 2>/dev/null; then echo "FAIL  port $p is busy"; exit 1; fi
done
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done; rm -rf "$TMP"; }
trap cleanup EXIT
FAIL=0
ok() { if [ "$1" = 1 ]; then echo "PASS  $2"; else echo "FAIL  $2"; FAIL=1; fi; }
CL=$TMP/claude; mkdir -p "$CL/projects/p"
# One entry: 1M input on claude-sonnet-4-5 = exactly $3.00, a few minutes ago.
node -e '
const fs = require("fs"); const t = new Date(Date.now() - 5 * 60e3).toISOString();
fs.writeFileSync(process.argv[1] + "/projects/p/a.jsonl", JSON.stringify({ type: "assistant", timestamp: t, sessionId: "s1",
  requestId: "r1", cwd: "/p", message: { id: "m1", model: "claude-sonnet-4-5", usage: { input_tokens: 1000000, output_tokens: 0 } } }) + "\n");
' "$CL"

node "$ROOT/test/mocks/mock-ecb.js" $MOCK >"$TMP/ecb.log" 2>&1 & PIDS+=($!)
sleep 0.5
FX=http://127.0.0.1:$MOCK/eurofxref-daily.xml
count() { curl -s "http://127.0.0.1:$MOCK/count"; }
start() { # home port
  CLAUDE_DIR=$CL CODEX_DIR=$TMP/nocodex PULSE_HOME=$1 PULSE_FX_API=$FX PULSE_NO_TRAY_SPAWN=1 PULSE_NO_STRIP_SPAWN=1 \
    node "$ROOT/server.js" --port "$2" --no-update-check >>"$1.log" 2>&1 &
  PIDS+=($!)
  for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$2/api/health" && return; sleep 0.1; done
}
sum() { curl -s "http://127.0.0.1:$1/api/summary"; }
post() { curl -s -X POST -H 'X-Pulse: 1' "http://127.0.0.1:$1$2"; }
js() { node -e "const s=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String($1))"; }

# ---- A: a USD user never contacts the ECB ---------------------------------------
H1=$TMP/h1; mkdir -p "$H1"
start "$H1" $P1
C=$(sum $P1 | js 's.currency.code + " " + s.currency.rate + " " + s.currency.prefix + " " + s.currency.status')
ok "$([ "$C" = 'USD 1 $ ok' ] && echo 1)" "A: default display currency is USD (got $C)"
ok "$([ "$(count)" = 0 ] && echo 1)" "A: no rate request for a USD user"
ok "$([ ! -e "$H1/fx-rates.json" ] && echo 1)" "A: no fx-rates.json for a USD user"
LST=$(sum $P1 | js 's.currency.supported.length + " " + s.currency.supported[0] + " " + s.currency.supported.includes("EUR") + " " + s.currency.supported.includes("BGN")')
ok "$([ "$LST" = '30 USD true false' ] && echo 1)" "A: picker list = USD + the 29 ECB currencies, no BGN (got $LST)"

# ---- B: the route is a guarded mutation -------------------------------------------
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$P1/api/currency/set?code=EUR")
ok "$([ "$CODE" = 403 ] && echo 1)" "B: POST /api/currency/set without X-Pulse is refused (got $CODE)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$P1/api/currency/set?code=EUR")
ok "$([ "$CODE" != 200 ] && echo 1)" "B: GET on the route does not change anything (got $CODE)"
ok "$([ "$(count)" = 0 ] && echo 1)" "B: refused requests fetched nothing"

# ---- C: EUR on the ECB rates ------------------------------------------------------
R=$(post $P1 '/api/currency/set?code=eur')
C=$(echo "$R" | js 's.ok + " " + s.currency.code + " " + s.currency.rate + " " + s.currency.prefix + " " + s.currency.source + " " + s.currency.asOf + " " + s.currency.digits')
ok "$([ "$C" = 'true EUR 0.8 € ecb 2026-09-29 2' ] && echo 1)" "C: EUR switches in one step on the ECB rate 1.25 USD/EUR -> 0.8 (got $C)"
ok "$([ "$(count)" = 1 ] && echo 1)" "C: exactly one rate request (got $(count))"
ok "$(node -e 'const j=require(process.argv[1]); process.stdout.write(j.v===1&&j.date==="2026-09-29"&&j.rates.USD===1.25&&j.rates.EUR===1?"1":"0")' "$H1/fx-rates.json")" "C: last-good table saved to fx-rates.json"
S=$(sum $P1)
ok "$(echo "$S" | js 'Math.abs(s.periods.find(p=>p.key==="last30").cost-3)<1e-9?1:0')" "C: payload costs stay USD (last30 = 3)"
ok "$(echo "$S" | js 's.currency.status==="ok"&&s.currency.requested==="EUR"?1:0')" "C: status ok, requested EUR"
SL=$(curl -s "http://127.0.0.1:$P1/api/statusline" | js 'JSON.stringify(s.currency)')
ok "$([ "$SL" = '{"code":"EUR","rate":0.8,"prefix":"€","digits":2}' ] && echo 1)" "C: the status line / tray feed carries the slim currency (got $SL)"
sum $P1 >/dev/null; sum $P1 >/dev/null
ok "$([ "$(count)" = 1 ] && echo 1)" "C: fresh rates are not refetched on every payload"

# ---- D: CLI output in the display currency -----------------------------------------
LINE=$(echo '{"model":{"display_name":"Sonnet"}}' | CLAUDE_DIR=$CL PULSE_HOME=$H1 NO_COLOR=1 node "$ROOT/server.js" --statusline)
ok "$(echo "$LINE" | grep -q '5h €2.40' && echo 1)" "D: --statusline shows euros (got: $LINE)"
SUMOUT=$(CLAUDE_DIR=$CL PULSE_HOME=$H1 NO_COLOR=1 node "$ROOT/server.js" --summary)
ok "$(echo "$SUMOUT" | grep -q '30 days *€2.40' && echo 1)" "D: --summary shows euros"
ok "$(echo "$SUMOUT" | grep -q '\$' && echo 0 || echo 1)" "D: --summary prints no dollar sign in EUR mode"

# ---- E: budget and plan entered in euros -------------------------------------------
R=$(post $P1 '/api/budget/set?amount=100&period=month&currency=EUR')
ok "$(echo "$R" | js 's.ok&&s.budget.target===125&&s.budget.currency==="EUR"&&s.budget.amount===100?1:0')" "E: a EUR 100 budget is USD 125 at 0.8 (reply $R)"
CFG=$(node -e 'const c=require(process.argv[1]); process.stdout.write([c.budget,c.budgetCurrency,c.budgetAmount].join(" "))' "$H1/config.json")
ok "$([ "$CFG" = '125 EUR 100' ] && echo 1)" "E: config keeps the USD snapshot + the amount as entered (got $CFG)"
B=$(sum $P1 | js 's.budget.target+" "+s.budget.currency+" "+s.budget.amount+" "+s.budget.spent')
ok "$([ "$B" = '125 EUR 100 3' ] && echo 1)" "E: payload.budget = USD target + entered amount, spent USD (got $B)"
R=$(post $P1 '/api/plan/set?amount=200&label=Max&currency=EUR')
P=$(echo "$R" | js 's.planValue.cost+" "+s.planValue.currency+" "+s.planValue.amount+" "+s.planValue.multiplier')
ok "$([ "$P" = '250 EUR 200 0.012' ] && echo 1)" "E: a EUR 200 plan = USD 250; multiplier is currency-free (got $P)"
SUMOUT=$(CLAUDE_DIR=$CL PULSE_HOME=$H1 NO_COLOR=1 node "$ROOT/server.js" --summary)
ok "$(echo "$SUMOUT" | grep -q 'Max · €200/mo' && echo 1)" "E: --summary shows the plan in euros as entered"
R=$(post $P1 '/api/budget/set?amount=50&period=week')
ok "$(node -e 'const c=require(process.argv[1]); process.stdout.write(c.budget===50&&c.budgetCurrency==null&&c.budgetAmount==null?"1":"0")' "$H1/config.json")" "E: a budget sent without currency is USD, as before (old dashboards)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'X-Pulse: 1' "http://127.0.0.1:$P1/api/budget/set?amount=10&currency=US")
ok "$([ "$CODE" = 400 ] && echo 1)" "E: a malformed budget currency is rejected (got $CODE)"

# ---- F: typed rate + currencies the ECB does not publish ---------------------------
N=$(count)
R=$(post $P1 '/api/currency/set?code=EUR&rate=0.5')
ok "$(echo "$R" | js 's.currency.rate===0.5&&s.currency.source==="manual"&&s.currency.typedRate===0.5?1:0')" "F: a typed rate wins over the ECB rate"
ok "$([ "$(count)" = "$N" ] && echo 1)" "F: a typed rate makes no request"
B=$(sum $P1 | js 's.planValue.cost+" "+s.planValue.amount')
ok "$([ "$B" = '400 200' ] && echo 1)" "F: a EUR plan follows the typed rate too (got $B)"
CODE=$(curl -s -o "$TMP/ars.json" -w '%{http_code}' -X POST -H 'X-Pulse: 1' "http://127.0.0.1:$P1/api/currency/set?code=ARS")
ok "$([ "$CODE" = 400 ] && grep -q 'type its rate' "$TMP/ars.json" && echo 1)" "F: ARS (not an ECB currency) without a rate asks for one (got $CODE)"
R=$(post $P1 '/api/currency/set?code=ARS&rate=1400')
C=$(echo "$R" | js 's.currency.code+"|"+s.currency.prefix+"|"+s.currency.rate')
ok "$([ "$C" = 'ARS|ARS |1400' ] && echo 1)" "F: ARS with a typed rate, letter symbol gets a space (got $C)"
for q in 'code=EURO' 'code=XYZ&rate=2' 'code=EUR&rate=-1' 'code=EUR&rate=1e9' 'code=EUR&rate=abc'; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'X-Pulse: 1' "http://127.0.0.1:$P1/api/currency/set?$q")
  ok "$([ "$CODE" = 400 ] && echo 1)" "F: rejected: $q (got $CODE)"
done
R=$(post $P1 '/api/currency/set?code=JPY')
LINE=$(echo '{}' | CLAUDE_DIR=$CL PULSE_HOME=$H1 NO_COLOR=1 node "$ROOT/server.js" --statusline)
ok "$(echo "$LINE" | grep -q '5h ¥450' && echo 1)" "F: JPY has no decimals (3 USD x 150 = ¥450; got: $LINE)"
R=$(post $P1 '/api/currency/set?code=USD')
ok "$(echo "$R" | js 's.currency.code==="USD"&&!("typedRate" in s.currency)?1:0')" "F: back to USD"
ok "$(node -e 'const c=require(process.argv[1]); process.stdout.write(c.currency==null&&c.currencyRate==null?"1":"0")' "$H1/config.json")" "F: USD clears the currency keys"

# ---- G: offline restart keeps the last-good rates -----------------------------------
post $P1 '/api/currency/set?code=GBP' >/dev/null
kill "${PIDS[1]}" 2>/dev/null; sleep 0.5
curl -s "http://127.0.0.1:$MOCK/mode?m=500" >/dev/null
N=$(count)
start "$H1" $P2
C=$(sum $P2 | js 's.currency.code+" "+s.currency.rate+" "+s.currency.status')
ok "$([ "$C" = 'GBP 0.7 ok' ] && echo 1)" "G: after a restart GBP comes from fx-rates.json (0.875/1.25; got $C)"
ok "$([ "$(count)" = "$N" ] && echo 1)" "G: recent cached rates are not refetched"
B=$(sum $P2 | js 's.budget.target')
ok "$([ "$B" = 50 ] && echo 1)" "G: the USD budget is untouched by the currency"

# ---- H: first fetch fails with nothing cached -> USD, never a guessed rate ---------
H3=$TMP/h3; mkdir -p "$H3"; echo '{"currency":"EUR"}' > "$H3/config.json"
start "$H3" $P3
sleep 0.5
C=$(sum $P3 | js 's.currency.code+" "+s.currency.rate+" "+s.currency.requested+" "+s.currency.status+" "+(s.currency.ecb&&s.currency.ecb.error)')
ok "$([ "$C" = 'USD 1 EUR unavailable HTTP 500' ] && echo 1)" "H: a failed first fetch shows USD, says why (got $C)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'X-Pulse: 1' "http://127.0.0.1:$P3/api/budget/set?amount=100&currency=EUR")
ok "$([ "$CODE" = 400 ] && echo 1)" "H: a EUR budget without any EUR rate is refused, not guessed (got $CODE)"
ok "$([ ! -e "$H3/fx-rates.json" ] && echo 1)" "H: nothing cached after a failure"
curl -s "http://127.0.0.1:$MOCK/mode?m=junk" >/dev/null
node -e '
const S = require(process.argv[1] + "/server.js");
process.stdout.write(S.parseEcbXml("<html>maintenance</html>") === null ? "1" : "0");' "$ROOT" | grep -q 1
ok "$([ $? = 0 ] && echo 1)" "H: a non-XML body is not a rate table"
curl -s "http://127.0.0.1:$MOCK/mode?m=ok" >/dev/null

# ---- I: short-lived commands never fetch; stored amounts outlive a lost rate ---------
H4=$TMP/h4; mkdir -p "$H4"
echo '{"currency":"EUR","budget":125,"budgetCurrency":"EUR","budgetAmount":100}' > "$H4/config.json"
N=$(count)
SUMOUT=$(CLAUDE_DIR=$CL PULSE_HOME=$H4 PULSE_FX_API=$FX NO_COLOR=1 node "$ROOT/server.js" --summary)
ok "$([ "$(count)" = "$N" ] && echo 1)" "I: --summary without a server makes no rate request"
ok "$(echo "$SUMOUT" | grep -q '30 days *\$3.00' && echo 1)" "I: ...and shows USD when it has no rates"
node -e '
const S = require(process.argv[1] + "/server.js");
let bad = 0; const t = (c, m) => { if (!c) { bad = 1; console.log("FAIL  I: " + m); } else console.log("PASS  I: " + m); };
t(S.fmtMoney(3, null) === "$3.00", "fmtMoney without a currency is USD");
t(S.fmtMoney(3, { rate: 0.8, prefix: "€", digits: 2 }) === "€2.40", "fmtMoney converts");
t(S.fmtMoney(250, { rate: 0.8, prefix: "€", digits: 2 }) === "€200", "fmtMoney drops cents at 100+ like before");
t(S.fmtMoney(3, { rate: -1, prefix: "€", digits: 2 }) === "$3.00", "a hostile rate falls back to USD");
t(S.fmtMoney(3, { rate: 1, prefix: "\u001b[2J€", digits: 2 }) === "[2J€3.00", "control characters never reach the terminal");
t(S.usableCurrency({ rate: 1, prefix: "", digits: 2 }) === null, "an empty prefix is unusable");
t(S.currencyInfo("CHF").prefix === "CHF " && S.currencyInfo("JPY").digits === 0 && S.currencyInfo("EUR").symbol === "€", "symbols + decimals from Intl");
const x = S.parseEcbXml("<Cube time=\x272026-01-02\x27><Cube currency=\x27USD\x27 rate=\x271.1\x27/><Cube currency=\x27__proto__\x27 rate=\x271\x27/><Cube currency=\x27GBP\x27 rate=\x27-3\x27/></Cube>");
t(x && x.date === "2026-01-02" && x.rates.USD === 1.1 && x.rates.EUR === 1 && !("GBP" in x.rates) && Object.keys(x.rates).length === 2, "parser keeps only valid three-letter codes and rates");
process.exit(bad);' "$ROOT" || FAIL=1

# ---- J: the tray tooltip formatter under PowerShell (skipped without pwsh) ---------
PW=${PWSH:-$(command -v pwsh 2>/dev/null)}
if [ -n "$PW" ] && [ -x "$PW" ]; then
  node -e '
const S = require(process.argv[1] + "/server.js"); const t = S.trayScript(4747).split(/\r?\n/);
const i = t.findIndex((l) => /^function Format-BgMoney/.test(l)); const out = [];
for (let k = i; k < t.length; k++) { out.push(t[k]); if (t[k] === "}") break; }
require("fs").writeFileSync(process.argv[2], out.join("\n") + "\n" +
  "Format-BgMoney 12.5 $null\n" +
  "Format-BgMoney 1234.5 ([pscustomobject]@{prefix=\"EUR \"; rate=0.8; digits=2})\n" +
  "Format-BgMoney 12.5 ([pscustomobject]@{prefix=\"Y\"; rate=150; digits=0})\n" +
  "Format-BgMoney 12.5 ([pscustomobject]@{prefix=\"x\"; rate=-1; digits=2})\n");' "$ROOT" "$TMP/fmt.ps1"
  OUT=$("$PW" -NoProfile -File "$TMP/fmt.ps1" | tr '\n' '|')
  ok "$([ "$OUT" = '$12.50|EUR 987.60|Y1,875|$12.50|' ] && echo 1)" "J: tray tooltip money under pwsh (got $OUT)"
else
  echo "SKIP  J: tray tooltip formatter (no pwsh; set PWSH=/path/to/pwsh)"
fi

# ---- K: the dashboard switches currency (skipped without Playwright) ---------------
PWMOD=${PLAYWRIGHT_MODULE:-}
[ -z "$PWMOD" ] && PWMOD=$(node -e 'try { console.log(require.resolve("playwright")) } catch (_) {}' 2>/dev/null)
if [ -z "$PWMOD" ] && command -v npm >/dev/null 2>&1; then
  G=$(npm root -g 2>/dev/null); [ -n "$G" ] && [ -f "$G/playwright/index.js" ] && PWMOD="$G/playwright/index.js"
fi
CHROME=${PW_CHROMIUM:-}; [ -z "$CHROME" ] && [ -x /opt/pw-browsers/chromium ] && CHROME=/opt/pw-browsers/chromium
if [ -z "$PWMOD" ] || [ -z "$CHROME" ]; then
  echo "SKIP  K: dashboard currency picker (Playwright / Chromium not found)"
else
  H5=$TMP/h5; mkdir -p "$H5"
  start "$H5" $P4
  node -e '
const { chromium } = require(process.argv[1]);
(async () => {
  let bad = 0; const t = (c, m) => { console.log((c ? "PASS" : "FAIL") + "  K: " + m); if (!c) bad = 1; };
  const b = await chromium.launch({ executablePath: process.argv[2], args: ["--no-sandbox"] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto("http://127.0.0.1:" + process.argv[3] + "/", { waitUntil: "networkidle" });
  const hero = () => p.locator(".sec-kpis").first().innerText();
  t((await hero()).includes("$3.00"), "USD first");
  await p.locator("select.cur-sel").selectOption("EUR");
  await p.waitForFunction(() => document.querySelector(".sec-kpis").innerText.includes("€2.40"), null, { timeout: 5000 }).catch(() => {});
  t((await hero()).includes("€2.40"), "picking EUR converts the page at once");
  t((await p.locator(".cur-set").innerText()).includes("1 USD = 0.8000 EUR"), "the rate and its source are shown");
  t((await p.locator(".lim-budget .ig-x").first().innerText()) === "€", "the budget input takes euros");
  await p.locator(".cur-fixed input").check();
  await p.locator(".cur-num").fill("0.5");
  await p.locator(".cur-rate button").click();
  await p.waitForFunction(() => document.querySelector(".sec-kpis").innerText.includes("€1.50"), null, { timeout: 5000 }).catch(() => {});
  t((await hero()).includes("€1.50"), "a typed rate applies");
  await p.locator("select.cur-sel").selectOption("USD");
  await p.waitForFunction(() => document.querySelector(".sec-kpis").innerText.includes("$3.00"), null, { timeout: 5000 }).catch(() => {});
  t((await hero()).includes("$3.00"), "back to USD");
  t(errs.length === 0, "no page errors (" + errs.join("; ") + ")");
  await b.close(); process.exit(bad);
})().catch((e) => { console.log("FAIL  K: " + e.message); process.exit(1); });' "$PWMOD" "$CHROME" $P4 || FAIL=1
fi

echo "---- exit $FAIL"
exit $FAIL
