#!/bin/bash
# Live agent state (working / thinking / waiting / idle) + the Discord state art.
# Part 1 asserts payload.agentState against fixture transcripts, rollouts and a
# fixture Claude Code live-session registry (CLAUDE_DIR/sessions/<pid>.json —
# the live pid is this shell's own $$, a dead one is a pid that can't exist).
# Part 2 drives the Discord activity through the mock IPC socket: per-state
# images, the working<->thinking hold, waiting beating the 15-min idle window,
# discordShowState:false.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
CL=$TMP/claude; CX=$TMP/codex; PH=$TMP/pulse
mkdir -p "$CL/projects/demo/s1/subagents" "$CL/sessions" "$CX/sessions/2026/09/25" "$PH"
PORT=4919
FX=$TMP/fx.js
cat > "$FX" <<'EOF'
// node fx.js <scenario> — rewrites the fixture files for one scenario.
const fs = require('fs'), path = require('path');
const [CL, CX, scen, livePid] = process.argv.slice(2);
const now = Date.now();
const iso = (secAgo) => new Date(now - secAgo * 1000).toISOString();
const w = (f, lines) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n'); };
const rm = (f) => { try { fs.unlinkSync(f); } catch (_) {} };
const reg = (pid, sid, status) => fs.writeFileSync(path.join(CL, 'sessions', pid + '.json'), JSON.stringify({ pid: Number(pid), sessionId: sid, status, statusUpdatedAt: now }));
const usage = { input_tokens: 100, output_tokens: 50 };
const prompt = (s, sid = 's1') => ({ type: 'user', timestamp: iso(s), sessionId: sid, cwd: '/p', message: { role: 'user', content: 'do the thing' } });
const toolUse = (s, id, name, sid = 's1') => ({ type: 'assistant', timestamp: iso(s), sessionId: sid, cwd: '/p', requestId: 'r' + id,
  message: { id: 'm' + id, model: 'claude-opus-5-5', stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id, name, input: {} }] } });
const toolResult = (s, id, sid = 's1') => ({ type: 'user', timestamp: iso(s), sessionId: sid, cwd: '/p', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const reply = (s, id, sid = 's1') => ({ type: 'assistant', timestamp: iso(s), sessionId: sid, cwd: '/p', requestId: 'r' + id,
  message: { id: 'm' + id, model: 'claude-opus-5-5', stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'done' }] } });
const side = (s) => ({ type: 'assistant', timestamp: iso(s), sessionId: 's1', cwd: '/p', isSidechain: true, requestId: 'rs' + s,
  message: { id: 'ms' + s, model: 'claude-haiku-4-5', usage, content: [{ type: 'text', text: 'exploring' }] } });
const main = path.join(CL, 'projects/demo/s1.jsonl');
const sub = path.join(CL, 'projects/demo/s1/subagents/agent-a1.jsonl');
const crashed = path.join(CL, 'projects/demo/s9.jsonl');
const rollout = (name, meta, events) => w(path.join(CX, 'sessions/2026/09/25/rollout-' + name + '.jsonl'),
  [{ timestamp: iso(600), type: 'session_meta', payload: Object.assign({ cwd: '/p' }, meta) }].concat(events));
const ev = (s, type, payload) => ({ timestamp: iso(s), type, payload });
const clearReg = () => { for (const f of fs.readdirSync(path.join(CL, 'sessions'))) rm(path.join(CL, 'sessions', f)); };
const clearCodex = () => { const d = path.join(CX, 'sessions/2026/09/25'); for (const f of fs.readdirSync(d)) rm(path.join(d, f)); };
switch (scen) {
  case 'busy-tool': clearReg(); clearCodex(); rm(sub); rm(crashed);
    reg(livePid, 's1', 'busy'); w(main, [prompt(30), toolUse(20, 't1', 'Bash')]); break;
  case 'busy-result': reg(livePid, 's1', 'busy'); w(main, [prompt(30), toolUse(20, 't1', 'Bash'), toolResult(10, 't1')]); break;
  case 'waiting': reg(livePid, 's1', 'waiting'); break;
  case 'idle-subagent': reg(livePid, 's1', 'idle'); w(main, [prompt(60), reply(50, 'x')]); w(sub, [side(5)]); break;
  case 'idle-subagent-old': w(sub, [side(120)]); break;
  case 'crashed-other': // s9 ends mid-tool but has no registry entry: exited
    w(crashed, [prompt(30, 's9'), toolUse(20, 't9', 'Bash', 's9')]); break;
  case 'no-registry-prompt': clearReg(); rm(sub); rm(crashed); reg(2147480000, 's1', 'waiting'); // dead pid: ignored
    w(main, [prompt(10)]); break;
  case 'no-registry-ask': w(main, [prompt(30), toolUse(10, 'q1', 'AskUserQuestion')]); break;
  case 'no-registry-stale': w(main, [prompt(1300), toolUse(1250, 't2', 'Bash')]); break;
  case 'codex-working': clearReg(); rm(sub); w(main, [prompt(60), reply(50, 'y')]); reg(livePid, 's1', 'idle');
    rollout('parent', { session_id: 'root-1', id: 'root-1', source: 'cli' }, [
      ev(40, 'event_msg', { type: 'task_started' }),
      ev(30, 'response_item', { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'c1' })]); break;
  case 'codex-done':
    rollout('parent', { session_id: 'root-1', id: 'root-1', source: 'cli' }, [
      ev(40, 'event_msg', { type: 'task_started' }),
      ev(30, 'response_item', { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'c1' }),
      ev(20, 'response_item', { type: 'function_call_output', call_id: 'c1', output: 'ok' }),
      ev(10, 'event_msg', { type: 'task_complete' })]); break;
  case 'codex-child':
    rollout('child', { session_id: 'root-1', id: 'child-1', parent_thread_id: 'root-1',
      source: { subagent: { thread_spawn: { parent_thread_id: 'root-1', depth: 1 } } } }, [
      ev(5, 'response_item', { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'k1' })]); break;
  // Discord part
  case 'd-quiet-waiting': clearCodex(); reg(livePid, 's1', 'waiting');
    w(main, [prompt(1300), toolUse(1250, 't3', 'Bash')]); rm(sub); break; // last write 21 min ago
  case 'd-recent': reg(livePid, 's1', 'idle'); w(main, [prompt(60), reply(50, 'z')]); break;
  default: throw new Error('unknown scenario ' + scen);
}
EOF
fx() { node "$FX" "$CL" "$CX" "$1" "$$"; sleep 0.05; }
q() { curl -s "http://127.0.0.1:$PORT/api/summary" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).agentState;console.log(a?a.provider+":"+a.state:"null")})'; }
RES=$TMP/results.txt; : > "$RES"
chk() { echo "$1 $2" >> "$RES"; }

# ---------------- Part 1: payload.agentState ----------------
echo '{}' > "$PH/config.json"
CLAUDE_DIR=$CL CODEX_DIR=$CX PULSE_HOME=$PH PULSE_SUMMARY_MEMO_MS=0 PULSE_LIVE_STATE_MEMO_MS=0 \
  node "$ROOT/server.js" --port $PORT --no-update-check >"$TMP/srv1.log" 2>&1 &
SRV=$!
fx busy-tool; sleep 2
chk busy-tool "$(q)"
fx busy-result;        chk busy-result "$(q)"
fx waiting;            chk waiting "$(q)"
fx idle-subagent;      chk idle-subagent "$(q)"
fx idle-subagent-old;  chk idle-subagent-old "$(q)"
fx crashed-other;      chk crashed-other "$(q)"
fx no-registry-prompt; chk no-registry-prompt "$(q)"
fx no-registry-ask;    chk no-registry-ask "$(q)"
fx no-registry-stale;  chk no-registry-stale "$(q)"
fx codex-working;      chk codex-working "$(q)"
fx codex-done;         chk codex-done "$(q)"
fx codex-child;        chk codex-child "$(q)"
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null

# ---------------- Part 2: Discord state art ----------------
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) IPC='\\.\pipe\pulse-astate-'$$ ;;
  *) IPC=$TMP/dipc/discord-ipc-0 ;;
esac
DLOG=$TMP/frames.log
node "$ROOT/test/mocks/mock-discord.js" "$IPC" "$DLOG" > /dev/null & MOCK=$!
sleep 0.5
cat > "$PH/config.json" <<'EOF'
{"discordPresence": true, "discordClientId": "123456789012345678",
 "discordClaudeImage": "https://x.test/claude.gif", "discordClaudeWorkingImage": "https://x.test/working.gif",
 "discordClaudeThinkingImage": "https://x.test/thinking.gif", "discordClaudeWaitingImage": "https://x.test/waiting.gif"}
EOF
fx busy-tool
CLAUDE_DIR=$CL CODEX_DIR=$CX PULSE_HOME=$PH PULSE_SUMMARY_MEMO_MS=0 PULSE_LIVE_STATE_MEMO_MS=0 \
  PULSE_DISCORD_IPC="$IPC" PULSE_DISCORD_TICK_MS=300 PULSE_DISCORD_ROTATE_MS=600000 PULSE_DISCORD_STATE_HOLD_MS=5000 \
  node "$ROOT/server.js" --port $PORT --no-update-check >"$TMP/srv2.log" 2>&1 &
SRV=$!
mark() { echo "MARK $1 $(wc -l < "$DLOG")" >> "$RES"; }
sleep 2.5; mark working            # busy + open Bash
fx busy-result; sleep 1; mark held     # thinking, but inside the 5 s hold (counted from when working appeared)
sleep 4.5; mark thinking           # hold elapsed
fx waiting; sleep 1; mark waiting  # waiting switches at once
fx d-quiet-waiting; sleep 1; mark quiet-waiting
fx d-recent; sleep 1; mark recent-idle
node -e 'const f=process.argv[1],c=JSON.parse(require("fs").readFileSync(f,"utf8"));c.discordShowState=false;require("fs").writeFileSync(f,JSON.stringify(c))' "$PH/config.json"
fx busy-tool; sleep 1; mark showstate-off
IMG=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H 'X-Pulse: 1' -H 'Content-Type: application/json' \
  --data '{"claudeWaiting":"https://x.test/waiting2.gif"}' "http://127.0.0.1:$PORT/api/discord/images")
echo "POSTSLOT $IMG" >> "$RES"
cp "$PH/config.json" "$TMP/cfg-after.json"
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
kill $MOCK 2>/dev/null

node -e '
const fs = require("fs");
const T = process.argv[1];
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + "  " + m); if (!c) fail = 1; };
const res = fs.readFileSync(T + "/results.txt", "utf8").trim().split("\n").map((l) => l.split(" "));
const got = Object.fromEntries(res.filter((r) => r[0] !== "MARK" && r[0] !== "POSTSLOT"));
const want = {
  "busy-tool": "claude:working", "busy-result": "claude:thinking", "waiting": "claude:waiting",
  "idle-subagent": "claude:working", "idle-subagent-old": "claude:idle", "crashed-other": "claude:idle",
  "no-registry-prompt": "claude:thinking", "no-registry-ask": "claude:waiting", "no-registry-stale": "null",
  "codex-working": "codex:working", "codex-done": "claude:idle", "codex-child": "codex:working",
};
const why = {
  "busy-tool": "status busy + an unresolved tool call", "busy-result": "status busy, tool resolved -> model thinking",
  "waiting": "status waiting (pending permission prompt)", "idle-subagent": "status idle but a subagent wrote 5 s ago",
  "idle-subagent-old": "subagent quiet for 2 min", "crashed-other": "a transcript ending mid-tool WITHOUT a live registry entry is ignored",
  "no-registry-prompt": "dead-pid registry file ignored -> transcript fallback: prompt", "no-registry-ask": "fallback: open AskUserQuestion",
  "no-registry-stale": "fallback: 20-min-old open tool is not live", "codex-working": "Codex turn with an unanswered call outranks Claude idle",
  "codex-done": "Codex task_complete -> idle, Claude idle", "codex-child": "a busy Codex subagent rollout makes its parent session working",
};
for (const k of Object.keys(want)) ok(got[k] === want[k], k + ": " + why[k] + " (" + got[k] + ")");

const frames = fs.readFileSync(T + "/frames.log", "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const marks = Object.fromEntries(res.filter((r) => r[0] === "MARK").map((r) => [r[1], Number(r[2])]));
const lastAct = (n) => { for (let i = n - 1; i >= 0; i--) { const f = frames[i]; if (f.op === 1 && f.payload.cmd === "SET_ACTIVITY" && f.payload.args.activity) return f.payload.args.activity; } return null; };
const img = (m) => { const a = lastAct(marks[m]); return a ? a.assets.large_image + " | " + a.assets.large_text : "none"; };
ok(img("working") === "https://x.test/working.gif | Claude Code · working", "D: working art + text (" + img("working") + ")");
ok(img("held") === "https://x.test/working.gif | Claude Code · working", "D: thinking inside the hold keeps the working art (" + img("held") + ")");
ok(img("thinking") === "https://x.test/thinking.gif | Claude Code · thinking", "D: after the hold -> thinking art (" + img("thinking") + ")");
ok(img("waiting") === "https://x.test/waiting.gif | Claude Code · waiting for you", "D: waiting switches immediately (" + img("waiting") + ")");
ok(img("quiet-waiting") === "https://x.test/waiting.gif | Claude Code · waiting for you",
   "D: a prompt pending for 20 quiet minutes still shows waiting, not Pulse idle (" + img("quiet-waiting") + ")");
ok(img("recent-idle") === "https://x.test/claude.gif | Using Claude Code", "D: between turns -> the Claude Code image (" + img("recent-idle") + ")");
ok(img("showstate-off") === "https://x.test/claude.gif | Using Claude Code", "D: discordShowState:false ignores live state (" + img("showstate-off") + ")");
const sets = frames.filter((f) => f.op === 1 && f.payload.cmd === "SET_ACTIVITY");
ok(sets.length <= 14, "D: only real changes are sent (" + sets.length + " SET_ACTIVITY frames over ~10 s of 300 ms ticks)");
const post = res.find((r) => r[0] === "POSTSLOT");
const cfg = JSON.parse(fs.readFileSync(T + "/cfg-after.json", "utf8"));
ok(post && post[1] === "200" && cfg.discordClaudeWaitingImage === "https://x.test/waiting2.gif", "D: /api/discord/images sets a state slot");
const logs = fs.readFileSync(T + "/srv1.log", "utf8") + fs.readFileSync(T + "/srv2.log", "utf8");
ok(!/TypeError|ReferenceError|at .*server\.js/.test(logs), "no server errors in logs");
process.exit(fail);
' "$TMP"
RES_CODE=$?
echo "---- exit $RES_CODE"
exit $RES_CODE
