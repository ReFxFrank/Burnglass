#!/bin/bash
# Claude Code transcript-format changes (2.1.281):
#  - one message written as SEVERAL lines sharing message.id (one per content
#    block); in subagent transcripts the FIRST line carries the streaming
#    PARTIAL usage (a handful of output tokens) and a later line the final
#    count. Pulse must keep the fuller copy (first-wins lost ~99% of output).
#  - advisor sub-inferences live ONLY in the final line's usage.iterations[]
#    as type "advisor_message" with their own model, billed at that model's
#    rates and excluded from the top-level usage — each becomes its own entry.
#  - identical duplicate lines in a main transcript still count once.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
CL=$TMP/claude; PH=$TMP/pulse
mkdir -p "$CL/projects/demo/sess-main/subagents" "$PH"

node -e '
const fs=require("fs"); const now=Date.now(); const iso=(m)=>new Date(now-m*60e3).toISOString();
const CL=process.argv[1];
const A=(min, sid, id, model, usage, extra)=>Object.assign({ type:"assistant", timestamp: iso(min), sessionId: sid,
  requestId:"r"+id, cwd:"/p", message:{ id:"m"+id, model, usage } }, extra||{});
// Main transcript: the same message written twice with IDENTICAL usage -> once.
// claude-opus-4-8 100K out at $25/M = 2.50.
fs.writeFileSync(CL+"/projects/demo/sess-main.jsonl", [
  A(60, "sess-main", "main1", "claude-opus-4-8", { input_tokens: 0, output_tokens: 100000 }, { apiBlockIndex: 0 }),
  A(60, "sess-main", "main1", "claude-opus-4-8", { input_tokens: 0, output_tokens: 100000 }, { apiBlockIndex: 1 }),
].map(JSON.stringify).join("\n")+"\n");
// Subagent transcript. Message sub1 (claude-sonnet-5, $2/$10), three lines:
//   line 0: PARTIAL usage (8 output tokens), no iterations
//   lines 1-2: final usage 1M in + 1M out, iterations incl. an advisor call
//     on claude-opus-5-5 (1M in + 100K out = 4 + 2 = 6.00)
// Expected: sonnet-5 = 2 + 10 = 12.00 (first-wins gave 2.00008 and no advisor).
const finalU = { input_tokens: 1000000, output_tokens: 1000000, iterations: [
  { type: "message", input_tokens: 1000000, output_tokens: 1000000 },
  { type: "advisor_message", model: "claude-opus-5-5", input_tokens: 1000000, output_tokens: 100000, cache_read_input_tokens: 0 },
] };
// Message sub2: advisor iteration WITHOUT a model -> falls back to the
// entry-level advisorModel (claude-fable-5-1, 1M out at $50/M = 50.00).
fs.writeFileSync(CL+"/projects/demo/sess-main/subagents/agent-a1.jsonl", [
  A(50, "sess-main", "sub1", "claude-sonnet-5", { input_tokens: 1000000, output_tokens: 8 }, { apiBlockIndex: 0, isSidechain: true }),
  A(50, "sess-main", "sub1", "claude-sonnet-5", finalU, { apiBlockIndex: 1, isSidechain: true, advisorModel: "claude-opus-5-5" }),
  A(50, "sess-main", "sub1", "claude-sonnet-5", finalU, { apiBlockIndex: 2, isSidechain: true, advisorModel: "claude-opus-5-5" }),
  A(40, "sess-main", "sub2", "claude-sonnet-5", { input_tokens: 0, output_tokens: 0, iterations: [
    { type: "message", input_tokens: 0, output_tokens: 0 },
    { type: "advisor_message", input_tokens: 0, output_tokens: 1000000 } ] }, { advisorModel: "claude-fable-5-1" }),
].map(JSON.stringify).join("\n")+"\n");
' "$CL"

PORT=4918
if curl -s -m 1 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "FAIL  port $PORT already in use"; echo "---- exit 1"; exit 1
fi
PULSE_HOME=$PH CLAUDE_DIR=$CL CODEX_DIR=$TMP/no-codex \
node "$ROOT/server.js" --port $PORT --no-update-check >"$TMP/srv.log" 2>&1 &
SRV=$!
sleep 2.5
curl -s "http://127.0.0.1:$PORT/api/summary" > "$TMP/out.json"
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null

node -e '
const fs=require("fs"); const T=process.argv[1];
let fail=0; const ok=(c,m)=>{console.log((c?"PASS":"FAIL")+"  "+m); if(!c) fail=1;};
const near=(a,b)=>Math.abs(a-b)<0.005;
const s=require(T+"/out.json");
const p=(s.periods||[]).find(x=>x.key==="last30")||{};
const bm=p.byModel||{};
const son=bm["claude-sonnet-5"], adv=bm["claude-opus-5-5"], fab=bm["claude-fable-5-1"], op=bm["claude-opus-4-8"];
ok(son && near(son.cost, 12), "multi-line message keeps the FULLER usage: sonnet-5 = 12.00, not the partial 2.00 (got "+(son&&son.cost)+")");
ok(son && son.messages === 2, "the three lines of one message count as ONE message (sonnet-5 msgs "+(son&&son.messages)+", want 2 = sub1 + sub2)");
ok(adv && near(adv.cost, 6) && adv.messages === 1, "advisor_message iteration becomes its own opus-5-5 entry: 4 + 2 = 6.00 (got "+JSON.stringify(adv&&{c:adv.cost,m:adv.messages})+")");
ok(fab && near(fab.cost, 50), "advisor iteration without a model falls back to advisorModel (fable-5-1 = 50) (got "+(fab&&fab.cost)+")");
ok(op && near(op.cost, 2.5) && op.messages === 1, "identical duplicate lines in a main transcript still count once (got "+JSON.stringify(op&&{c:op.cost,m:op.messages})+")");
ok(near(p.cost, 12 + 6 + 50 + 2.5), "period total = 70.50 (got "+p.cost+")");
ok(s.selfCheck && s.selfCheck.ok, "selfCheck ok (unique keys; block entries = Claude entries) — got "+JSON.stringify(s.selfCheck&&s.selfCheck.issues));
ok(!/unknown model/.test(fs.readFileSync(T+"/srv.log","utf8")), "no unknown-model warnings");
process.exit(fail);
' "$TMP"
RES=$?
echo "---- exit $RES"
exit $RES
