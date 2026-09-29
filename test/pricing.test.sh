#!/bin/bash
# Pricing e2e: every current gpt-5.3–5.6 / codex-auto-review string prices at
# exact OpenAI list rates; Zhipu GLM models (via the ~/.claude path) price at
# Z.ai list rates; the full Gemini table at Google list rates, incl. the
# tier-suffix guard (an unknown -flash-lite must take the LOGGED default, never
# the parent flash rate); Claude cache multipliers at exact rates; both sides
# of Sonnet 5's introductory-price date boundary. The only unknown-model
# warning allowed in the server log is the deliberate guard case.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
CL=$TMP/claude; CX=$TMP/codex; GEM=$TMP/gemini; PH=$TMP/pulse
mkdir -p "$CL/projects/glm" "$CX/sessions/2026/07/15" "$GEM/tmp/proj/chats" "$PH"

# GLM usage as it arrives through Claude Code (Z.ai Anthropic-compatible
# endpoint): glm-* model ids in a ~/.claude transcript. 1M input + 1M output
# per model -> cost = input$ + output$.
node -e '
const fs = require("fs");
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const A = (min, id, model) => ({ type: "assistant", timestamp: iso(now - min * 60e3),
  sessionId: "glm-s", requestId: "r" + id, cwd: "/p",
  message: { id: "m" + id, model, usage: { input_tokens: 1000000, output_tokens: 1000000 } } });
const MODELS = ["glm-4.6", "glm-4.5", "glm-4.5-air", "glm-4.5-x", "glm-5", "glm-4.7-flash"];
const lines = MODELS.map((m, i) => A(30 - i, i, m));
// Claude cache multipliers at exact rates: opus-4-8 (5/25), 1M each of
// input + output + 5m cache write (x1.25) + 1h cache write (x2.0) + cache
// read (x0.10) -> 5 + 25 + 6.25 + 10 + 0.5 = 46.75.
lines.push({ type: "assistant", timestamp: iso(now - 40 * 60e3),
  sessionId: "glm-s", requestId: "rc1", cwd: "/p",
  message: { id: "mc1", model: "claude-opus-4-8",
    usage: { input_tokens: 1000000, output_tokens: 1000000, cache_read_input_tokens: 1000000,
      cache_creation: { ephemeral_5m_input_tokens: 1000000, ephemeral_1h_input_tokens: 1000000 } } } });
// Sonnet 5: the $2/$10 launch price was made PERMANENT on 2026-08-11 (the
// scheduled 2026-09-01 step-up to $3/$15 never happened), so a July entry AND
// a September entry both bill 2/10 (=12 for 1M+1M). Pinned dates -> asserted
// via their calendar-month periods, so this stays valid whenever the suite runs.
lines.push({ type: "assistant", timestamp: "2026-07-15T12:00:00.000Z",
  sessionId: "intro-s", requestId: "ri1", cwd: "/p",
  message: { id: "mi1", model: "claude-sonnet-5", usage: { input_tokens: 1000000, output_tokens: 1000000 } } });
lines.push({ type: "assistant", timestamp: "2026-09-15T12:00:00.000Z",
  sessionId: "intro-s", requestId: "ri2", cwd: "/p",
  message: { id: "mi2", model: "claude-sonnet-5", usage: { input_tokens: 1000000, output_tokens: 1000000 } } });
// Fable 5.1: $10/$50 like Fable 5, but cache READS at 0.025x ($0.25/M) — 1M
// in + 1M out + 1M cache read = 10 + 50 + 0.25 = 60.25 (NOT 61 off the Fable 5
// 0.10x). Proves the per-row cacheReadMult is applied, not the global 0.10.
lines.push({ type: "assistant", timestamp: "2026-09-16T12:00:00.000Z",
  sessionId: "f51-s", requestId: "rf51", cwd: "/p",
  message: { id: "mf51", model: "claude-fable-5-1", usage: { input_tokens: 1000000, output_tokens: 1000000, cache_read_input_tokens: 1000000 } } });
// Mythos 5 (Glasswing twin of Fable 5): $10/$50 -> 1M+1M = 60, and it must
// price SILENTLY (no unknown-model warning) instead of the $3/$15 default.
lines.push({ type: "assistant", timestamp: "2026-09-16T13:00:00.000Z",
  sessionId: "my5-s", requestId: "rmy5", cwd: "/p",
  message: { id: "mmy5", model: "claude-mythos-5", usage: { input_tokens: 1000000, output_tokens: 1000000 } } });
// Mythos Preview: official Glasswing price $25/$125 -> 1M+1M = 150 (an exact
// row; the family prefix must NOT quietly apply the Fable tier).
lines.push({ type: "assistant", timestamp: "2026-09-17T12:00:00.000Z",
  sessionId: "myp-s", requestId: "rmyp", cwd: "/p",
  message: { id: "mmyp", model: "claude-mythos-preview", usage: { input_tokens: 1000000, output_tokens: 1000000 } } });
// Retired Opus 4 dated id: no bare prefix key covers it — explicit row -> 90.
lines.push({ type: "assistant", timestamp: "2026-09-17T13:00:00.000Z",
  sessionId: "op4-s", requestId: "rop4", cwd: "/p",
  message: { id: "mop4", model: "claude-opus-4-20250514", usage: { input_tokens: 1000000, output_tokens: 1000000 } } });
// Partner-cloud ids (Claude Code on Bedrock / Vertex) price via the canonical
// id, silently: sonnet-4-5 1M+1M = 18 for both forms.
lines.push({ type: "assistant", timestamp: "2026-09-17T14:00:00.000Z",
  sessionId: "br-s", requestId: "rbr", cwd: "/p",
  message: { id: "mbr", model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", usage: { input_tokens: 1000000, output_tokens: 1000000 } } });
lines.push({ type: "assistant", timestamp: "2026-09-17T15:00:00.000Z",
  sessionId: "vx-s", requestId: "rvx", cwd: "/p",
  message: { id: "mvx", model: "claude-sonnet-4-5@20250929", usage: { input_tokens: 1000000, output_tokens: 1000000 } } });
// GovCloud ("us-gov.") and other hyphenated region prefixes must reduce too —
// haiku-4-5 $1/$5 -> 1M+1M = 6, NOT the $3/$15 default (a 3x over-bill).
lines.push({ type: "assistant", timestamp: "2026-09-17T16:00:00.000Z",
  sessionId: "gov-s", requestId: "rgov", cwd: "/p",
  message: { id: "mgov", model: "us-gov.anthropic.claude-haiku-4-5-20251001-v1:0", usage: { input_tokens: 1000000, output_tokens: 1000000 } } });
// Opus 5.5 (2026-09-22): $4/$20, cache reads 0.05x ($0.20/M), fast $8/$40.
// Standard entry: 1M in + 1M out + 1M cache read = 4 + 20 + 0.20 = 24.20.
// Fast entry: 1M + 1M at 8/40 = 48 (its fast premium over standard = 24).
// Before the row existed it silently took the Opus 5 row (5/25 +0.50 read) = 30.50.
lines.push({ type: "assistant", timestamp: "2026-09-23T10:00:00.000Z",
  sessionId: "o55-s", requestId: "ro55", cwd: "/p",
  message: { id: "mo55", model: "claude-opus-5-5", usage: { input_tokens: 1000000, output_tokens: 1000000, cache_read_input_tokens: 1000000 } } });
lines.push({ type: "assistant", timestamp: "2026-09-23T11:00:00.000Z",
  sessionId: "o55f-s", requestId: "ro55f", cwd: "/p",
  message: { id: "mo55f", model: "claude-opus-5-5", usage: { input_tokens: 1000000, output_tokens: 1000000, speed: "fast" } } });
// Sonnet 5.5 (2026-09-28) has its own row now: 2/10 (1M+1M = 12), SILENTLY.
lines.push({ type: "assistant", timestamp: "2026-09-23T12:00:00.000Z",
  sessionId: "s55-s", requestId: "rs55", cwd: "/p",
  message: { id: "ms55", model: "claude-sonnet-5-5", usage: { input_tokens: 1000000, output_tokens: 1000000 } } });
// A point release Burnglass has NO row for (hypothetical claude-sonnet-5-6):
// it borrows the Sonnet 5 row (2/10) (1M+1M = 12) as the closest estimate, but must
// be LOGGED — silently, this is how Opus 5.5 hid on the Opus 5 rate.
lines.push({ type: "assistant", timestamp: "2026-09-23T12:30:00.000Z",
  sessionId: "s56-s", requestId: "rs56", cwd: "/p",
  message: { id: "ms56", model: "claude-sonnet-5-6", usage: { input_tokens: 1000000, output_tokens: 1000000 } } });
// Version-stamped Vertex id: claude-3-5-sonnet-v2@20241022 -> the 3.5 Sonnet
// row (3/15 -> 1M+1M = 18) SILENTLY (a -v2 stamp is not a point release).
lines.push({ type: "assistant", timestamp: "2026-09-23T13:00:00.000Z",
  sessionId: "v2-s", requestId: "rv2", cwd: "/p",
  message: { id: "mv2", model: "claude-3-5-sonnet-v2@20241022", usage: { input_tokens: 1000000, output_tokens: 1000000 } } });
// inference_geo "us": every token category at 1.1x — opus-4-6 1M+1M = 30 -> 33.
lines.push({ type: "assistant", timestamp: "2026-09-16T14:00:00.000Z",
  sessionId: "geo-s", requestId: "rgeo", cwd: "/p",
  message: { id: "mgeo", model: "claude-opus-4-6", usage: { input_tokens: 1000000, output_tokens: 1000000, inference_geo: "us" } } });
// Opus 5 standard vs fast mode, split across months so each is asserted on its
// own: standard bills 5/25 (=30 for 1M+1M), fast (usage.speed "fast", the
// `/fast` toggle) bills the 10/50 premium (=60). Same fixture shape proves the
// premium comes from the speed field, not the model row.
lines.push({ type: "assistant", timestamp: "2026-05-15T12:00:00.000Z",
  sessionId: "o5-s", requestId: "ro1", cwd: "/p",
  message: { id: "mo1", model: "claude-opus-5", usage: { input_tokens: 1000000, output_tokens: 1000000 } } });
lines.push({ type: "assistant", timestamp: "2026-06-15T12:00:00.000Z",
  sessionId: "o5-s", requestId: "ro2", cwd: "/p",
  message: { id: "mo2", model: "claude-opus-5", usage: { input_tokens: 1000000, output_tokens: 1000000, speed: "fast" } } });
fs.writeFileSync(process.argv[1] + "/projects/glm/s.jsonl",
  lines.map(JSON.stringify).join("\n") + "\n");
' "$CL"

# Gemini CLI fixture: 1M input (0 cached) + 1M output per model -> cost =
# input$ + output$ at Google list rates. The last three rows exercise the
# prefix matcher: a dated -preview variant must fall back to its base row,
# while a tier variant (no gemini-3.5-flash-lite row exists) and a modality
# variant hidden behind -preview (-preview-tts) must NOT price at the parent
# flash rate — each takes __default__ (1.25+10) and warns.
node -e '
const fs = require("fs");
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const MODELS = ["gemini-3-pro", "gemini-3.1-pro", "gemini-3.5-flash", "gemini-3-flash",
                "gemini-3.1-flash-lite", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite",
                "gemini-3-pro-preview-11-2025", "gemini-3.5-flash-lite", "gemini-2.5-flash-preview-tts"];
fs.writeFileSync(process.argv[1] + "/tmp/proj/chats/session-p.jsonl",
  MODELS.map((m, i) => ({ id: "gp" + i, sessionId: "gp-s", timestamp: iso(now - (25 - i) * 60e3), model: m,
    tokens: { input: 1000000, output: 1000000, cached: 0, thoughts: 0, tool: 0, total: 2000000 } }))
    .map(JSON.stringify).join("\n") + "\n");
' "$GEM"

node -e '
const fs = require("fs");
const dir = process.argv[1];
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
// Per model: [id, uncached input, output, cached input]. Prompts stay UNDER
// the 272K long-context threshold (100K + cached) so each row asserts its
// plain rate: cost = 0.1*input$ + output$ (+ 0.1*cached$ where cached).
// Entries are stamped "now" -> current (post-cut) prices; a second rollout
// below is pinned to 2026-07-15 to assert the pre-cut history steps.
const MODELS = [
  ["gpt-5.6-sol", 100000, 1000000, 0], ["gpt-5.6-terra", 100000, 1000000, 0], ["gpt-5.6-luna", 100000, 1000000, 0],
  ["gpt-5.5", 100000, 1000000, 0], ["gpt-5.4", 100000, 1000000, 0], ["gpt-5.4-mini", 100000, 1000000, 0],
  ["gpt-5.3-codex", 100000, 1000000, 0], ["codex-auto-review", 100000, 1000000, 0],
  // GPT-6 Astra: 100K in + 1M out + 100K cached (200K prompt, short context)
  ["gpt-6-astra", 100000, 1000000, 100000],
  ["gpt-6-astra-wm", 100000, 1000000, 0],          // Codex daybreak variant -> Astra rate
  ["gpt-5.6", 100000, 1000000, 0],                 // official alias of Sol
  ["gpt-5.6-cyber", 100000, 1000000, 0],
  ["us.openai.gpt-5.6-terra", 100000, 1000000, 0], // Bedrock-routed id -> canonical lookup
  // long-context: 300K prompt on a dated gpt-5.4 snapshot -> 2x in / 1.5x out
  ["gpt-5.4-2026-03-05", 300000, 100000, 0],
];
const rollout = (sid, base, models) => {
  const lines = [{ timestamp: iso(base - 60e3), type: "session_meta", payload: { session_id: sid, cwd: "/p" } }];
  let cum = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  models.forEach(([m, inp, out, cached], i) => {
    const t = base + (i + 1) * 60e3;
    lines.push({ timestamp: iso(t), type: "turn_context",
      payload: { turn_id: sid + "-t" + i, model: m,
                 collaboration_mode: { mode: "default", settings: { model: m, reasoning_effort: "medium" } } } });
    const u = { input_tokens: inp + cached, cached_input_tokens: cached, output_tokens: out, total_tokens: inp + cached + out };
    cum = { input_tokens: cum.input_tokens + u.input_tokens, cached_input_tokens: cum.cached_input_tokens + cached,
            output_tokens: cum.output_tokens + u.output_tokens, total_tokens: cum.total_tokens + u.total_tokens };
    lines.push({ timestamp: iso(t + 30e3), type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: u, total_token_usage: { ...cum } } } });
  });
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
};
fs.writeFileSync(dir + "/sessions/2026/07/15/rollout-price.jsonl", rollout("price-1", now - 3600e3, MODELS));
// v1.31 rows, pinned to 2026-09-23 (after the GPT-6 Sol/Luna launch). Each
// turn: [model, uncached in, out, cached, cache-written, service tier]. The
// tier arrives as a thread_settings_applied snapshot (latest wins), exactly
// as Codex persists the EFFECTIVE tier — incl. the Sol and Luna model default.
const v131 = (sid, base, turns) => {
  const out = [{ timestamp: iso(base - 60e3), type: "session_meta", payload: { session_id: sid, cwd: "/p" } }];
  turns.forEach(([m, inp, o, cached, written, tier], i) => {
    const t = base + (i + 1) * 60e3;
    out.push({ timestamp: iso(t - 10e3), type: "event_msg", payload: { type: "thread_settings_applied",
      thread_settings: Object.assign({ model: m, model_provider_id: "openai" }, tier ? { service_tier: tier } : {}) } });
    out.push({ timestamp: iso(t), type: "turn_context", payload: { turn_id: sid + "-t" + i, model: m } });
    const u = { input_tokens: inp + cached + written, cached_input_tokens: cached, cache_write_input_tokens: written,
                output_tokens: o, total_tokens: inp + cached + written + o };
    out.push({ timestamp: iso(t + 30e3), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: u } } });
  });
  return out.map((l) => JSON.stringify(l)).join("\n") + "\n";
};
fs.writeFileSync(dir + "/sessions/2026/07/15/rollout-v131.jsonl", v131("price-v131", Date.parse("2026-09-23T08:00:00.000Z"), [
  ["gpt-6-sol", 100000, 1000000, 0, 0, "priority"],   // FAST 2x: 2 x (0.2 + 10) = 20.4
  ["gpt-6-luna", 100000, 1000000, 0, 0, null],        // tier cleared -> standard: 0.01 + 0.5 = 0.51
  // 100K uncached + 100K cache-WRITTEN at 1.25x + 100K out, alias -> cyber:
  // 1.25 + 1.5625 + 7.5 = 10.3125 (written tokens billed as plain input: 10.00)
  ["gpt-daybreak-red-latest", 100000, 100000, 0, 100000, null],
  ["gpt-daybreak-blue-latest", 100000, 1000000, 0, 0, null], // -> 5.6 Sol now: 0.4 + 20 = 20.4
  ["gpt-5.2", 100000, 1000000, 0, 0, null],            // 0.175 + 14 = 14.175
  ["gpt-5.2-codex", 100000, 1000000, 0, 0, null],      // 14.175
  ["gpt-5.2-pro", 100000, 1000000, 0, 0, null],        // 2.1 + 168 = 170.1
  // Bedrock-routed id (distinct display row) -> the gpt-5.5 row, FAST 2.5x (not 2x): 2.5 x (0.5 + 3) = 8.75
  ["us.openai.gpt-5.5", 100000, 100000, 0, 0, "priority"],
]));
// Pre-cut history: the 5.6 family billed at its July rates for July entries.
fs.writeFileSync(dir + "/sessions/2026/07/15/rollout-history.jsonl",
  rollout("price-jul", Date.parse("2026-07-15T12:00:00.000Z"),
    [["gpt-5.6-sol", 100000, 1000000, 0], ["gpt-5.6-terra", 100000, 1000000, 0], ["gpt-5.6-luna", 100000, 1000000, 0]]));
' "$CX"

PORT=4882
CLAUDE_DIR=$CL CODEX_DIR=$CX GEMINI_DIR=$GEM PULSE_HOME=$PH \
node "$ROOT/server.js" --port $PORT --no-update-check >"$TMP/srv.log" 2>&1 &
SRV=$!
sleep 2.5
curl -s "http://127.0.0.1:$PORT/api/summary" > "$TMP/out.json"
kill $SRV 2>/dev/null

node -e '
const s = require(process.argv[1] + "/out.json");
const log = require("fs").readFileSync(process.argv[1] + "/srv.log", "utf8");
let fail = 0;
const ok = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + "  " + msg); if (!cond) fail = 1; };
// 0.1*input$ + output$ (+0.1*cached$) at the CURRENT (post-cut) rates:
const WANT = { "gpt-5.6-sol": 20.4, "gpt-5.6-terra": 12.2, "gpt-5.6-luna": 1.22, "gpt-5.5": 30.5,
               "gpt-5.4": 15.25, "gpt-5.4-mini": 4.575, "gpt-5.3-codex": 14.175, "codex-auto-review": 15.25,
               "gpt-6-astra": 51.1, "gpt-6-astra-wm": 51, "gpt-5.6": 20.4, "gpt-5.6-cyber": 76.25,
               "us.openai.gpt-5.6-terra": 12.2,
               // 300K prompt > 272K: 300K x $5 + 100K x $22.50 = 1.5 + 2.25
               "gpt-5.4-2026-03-05": 3.75 };
const rows = (s.periods && s.periods[0] && s.periods[0].byModel) || {};
for (const [m, want] of Object.entries(WANT)) {
  const r = rows[m];
  ok(r && Math.abs(r.cost - want) < 0.005, m + " costs $" + want + " (got " + (r ? r.cost.toFixed(2) : "missing") + ")");
}
// Pre-cut history steps: July entries keep the July prices (5/30, 2.5/15, 1/6).
const jul26 = ((s.periods || []).find((p) => p.key === "2026-07") || {}).byModel || {};
for (const [m, want] of Object.entries({ "gpt-5.6-sol": 30.5, "gpt-5.6-terra": 15.25, "gpt-5.6-luna": 6.1 })) {
  const r = jul26[m];
  ok(r && Math.abs(r.cost - want) < 0.005, m + " July 2026 entry at the PRE-cut rate $" + want + " (got " + (r ? r.cost.toFixed(2) : "missing") + ")");
}
// GLM via ~/.claude — Z.ai list prices (input$ + output$ for 1M+1M):
const GLM = { "glm-4.6": 2.8, "glm-4.5": 2.8, "glm-4.5-air": 1.3, "glm-4.5-x": 11.1, "glm-5": 4.2, "glm-4.7-flash": 0 };
for (const [m, want] of Object.entries(GLM)) {
  const r = rows[m];
  ok(r && Math.abs(r.cost - want) < 0.005, "GLM " + m + " costs $" + want + " (got " + (r ? r.cost.toFixed(2) : "missing") + ")");
}
// Gemini via ~/.gemini — Google list prices (input$ + output$ for 1M+1M),
// including the dated -preview fallback to its base row:
const GOOG = { "gemini-3-pro": 14, "gemini-3.1-pro": 14, "gemini-3.5-flash": 10.5, "gemini-3-flash": 3.5,
               "gemini-3.1-flash-lite": 1.75, "gemini-2.5-pro": 11.25, "gemini-2.5-flash": 2.8,
               "gemini-2.5-flash-lite": 0.5, "gemini-3-pro-preview-11-2025": 14 };
for (const [m, want] of Object.entries(GOOG)) {
  const r = rows[m];
  ok(r && Math.abs(r.cost - want) < 0.005, "Gemini " + m + " costs $" + want + " (got " + (r ? r.cost.toFixed(2) : "missing") + ")");
}
// Tier-suffix guard: no gemini-3.5-flash-lite row exists, so it must take
// __default__ (1.25+10 = 11.25), NOT the parent gemini-3.5-flash rate (10.5).
const lite = rows["gemini-3.5-flash-lite"];
ok(lite && Math.abs(lite.cost - 11.25) < 0.005,
   "guarded gemini-3.5-flash-lite priced at __default__ 11.25, not flash 10.5 (got " + (lite ? lite.cost.toFixed(2) : "missing") + ")");
// Modality guard: a modality hidden behind a snapshot word (-preview-tts) is
// NOT a snapshot of gemini-2.5-flash — it must also take __default__ + warn.
const tts = rows["gemini-2.5-flash-preview-tts"];
ok(tts && Math.abs(tts.cost - 11.25) < 0.005,
   "guarded gemini-2.5-flash-preview-tts priced at __default__ 11.25, not flash 2.8 (got " + (tts ? tts.cost.toFixed(2) : "missing") + ")");
// Claude cache multipliers at exact rates (opus-4-8: 5+25+6.25+10+0.5):
const cm = rows["claude-opus-4-8"];
ok(cm && Math.abs(cm.cost - 46.75) < 0.005,
   "cache multipliers exact: opus-4-8 1M each in/out/5m/1h/read costs 46.75 (got " + (cm ? cm.cost.toFixed(2) : "missing") + ")");
// Sonnet 5 intro boundary, keyed on the entry OWN date (month periods, so
// the assertion holds regardless of when the suite runs):
const mon = (k) => (s.periods || []).find((p) => p.key === k) || {};
const jul = (mon("2026-07").byModel || {})["claude-sonnet-5"];
const sep = (mon("2026-09").byModel || {})["claude-sonnet-5"];
ok(jul && Math.abs(jul.cost - 12) < 0.005, "sonnet-5 July 2026 entry at intro 2/10 = 12 (got " + (jul ? jul.cost.toFixed(2) : "missing") + ")");
ok(sep && Math.abs(sep.cost - 12) < 0.005, "sonnet-5 September 2026 entry ALSO at the now-permanent 2/10 = 12 (got " + (sep ? sep.cost.toFixed(2) : "missing") + ")");
const f51 = (mon("2026-09").byModel || {})["claude-fable-5-1"];
ok(f51 && Math.abs(f51.cost - 60.25) < 0.005, "fable-5-1: per-row 0.025x cache read -> 10+50+0.25 = 60.25 (got " + (f51 ? f51.cost.toFixed(2) : "missing") + ")");
const my5 = (mon("2026-09").byModel || {})["claude-mythos-5"];
ok(my5 && Math.abs(my5.cost - 60) < 0.005, "mythos-5 priced at the Fable tier 10/50 = 60 (got " + (my5 ? my5.cost.toFixed(2) : "missing") + ")");
const geo = (mon("2026-09").byModel || {})["claude-opus-4-6"];
ok(geo && Math.abs(geo.cost - 33) < 0.005, "inference_geo us: opus-4-6 1M+1M = 30 x 1.1 = 33 (got " + (geo ? geo.cost.toFixed(2) : "missing") + ")");
const sep26 = mon("2026-09").byModel || {};
for (const [m, want] of Object.entries({ "claude-mythos-preview": 150, "claude-opus-4-20250514": 90,
                                          "us.anthropic.claude-sonnet-4-5-20250929-v1:0": 18, "claude-sonnet-4-5@20250929": 18,
                                          "us-gov.anthropic.claude-haiku-4-5-20251001-v1:0": 6 })) {
  const r = sep26[m];
  ok(r && Math.abs(r.cost - want) < 0.005, m + " = $" + want + " (got " + (r ? r.cost.toFixed(2) : "missing") + ")");
}
// v1.31: Opus 5.5 (standard 24.20 + fast 48 = 72.20 in September)
const sepM = mon("2026-09");
const o55 = (sepM.byModel || {})["claude-opus-5-5"];
ok(o55 && Math.abs(o55.cost - 72.2) < 0.005, "opus-5-5: 4/20 + 0.05x read (24.20) + fast 8/40 (48) = 72.20 (got " + (o55 ? o55.cost.toFixed(2) : "missing") + ")");
const s55 = (sepM.byModel || {})["claude-sonnet-5-5"];
ok(s55 && Math.abs(s55.cost - 12) < 0.005, "claude-sonnet-5-5 has its own row: 2/10 = 12 (got " + (s55 ? s55.cost.toFixed(2) : "missing") + ")");
const s56 = (sepM.byModel || {})["claude-sonnet-5-6"];
ok(s56 && Math.abs(s56.cost - 12) < 0.005, "claude-sonnet-5-6 (no row) borrows Sonnet 5 2/10 = 12 (got " + (s56 ? s56.cost.toFixed(2) : "missing") + ")");
for (const [m, want] of Object.entries({ "gpt-6-sol": 20.4, "gpt-6-luna": 0.51, "gpt-daybreak-red-latest": 10.3125,
    "gpt-daybreak-blue-latest": 20.4, "gpt-5.2": 14.175, "gpt-5.2-codex": 14.175, "gpt-5.2-pro": 170.1, "us.openai.gpt-5.5": 8.75, "claude-3-5-sonnet-v2@20241022": 18 })) {
  const r = (sepM.byModel || {})[m];
  ok(r && Math.abs(r.cost - want) < 0.005, "v1.31 " + m + " = $" + want + " (got " + (r ? r.cost.toFixed(4) : "missing") + ")");
}
// Fast premium now counts BOTH providers in September: Opus 5.5 (48 - 24) +
// gpt-6-sol (20.4 - 10.2) + gpt-5.5 (8.75 - 3.5) = 24 + 10.2 + 5.25 = 39.45.
const fp = sepM.speedSpend && sepM.speedSpend.fastPremium;
ok(typeof fp === "number" && Math.abs(fp - 39.45) < 0.005, "fast premium = Claude 24 + Codex 10.2 + 5.25 = 39.45 (got " + fp + ")");
// Opus 5: standard 5/25, and the fast-mode premium 10/50 applied off
// usage.speed — the same 1M+1M entry must cost exactly double when fast.
const o5std = (mon("2026-05").byModel || {})["claude-opus-5"];
const o5fast = (mon("2026-06").byModel || {})["claude-opus-5"];
ok(o5std && Math.abs(o5std.cost - 30) < 0.005, "opus-5 standard at 5/25 = 30 (got " + (o5std ? o5std.cost.toFixed(2) : "missing") + ")");
ok(o5fast && Math.abs(o5fast.cost - 60) < 0.005, "opus-5 fast mode at 10/50 = 60 (got " + (o5fast ? o5fast.cost.toFixed(2) : "missing") + ")");
// The ONLY unknown-model warnings allowed are the two deliberate guard cases
// — the guard must be VISIBLE (warn), every listed model must price silently.
const unk = log.split("\n").filter((l) => /unknown model/.test(l));
const deliberate = /gemini-3\.5-flash-lite|gemini-2\.5-flash-preview-tts|claude-sonnet-5-6/;
ok(unk.length === 3 && unk.every((l) => deliberate.test(l)),
   "exactly the three deliberate unknown-model warnings, nothing else (got " + unk.length + ": " + unk.join(" | ") + ")");
ok(!unk.some((l) => /claude-sonnet-5-5/.test(l)), "claude-sonnet-5-5 prices silently (its own row)");
ok(unk.some((l) => /claude-sonnet-5-6.*priced as "claude-sonnet-5"/.test(l)),
   "the point-release warning names the row it borrowed (not a false \"__default__\")");
process.exit(fail);
' "$TMP"
RES=$?

# ---- 2026-09-29 rows: DeepSeek (both paths, peak/off-peak, holidays, dated
# steps), GPT-6.1 Sol, GPT-6 Astra Ultrafast, server-side refusal fallback.
# Own fixture homes + server, so the September totals above stay untouched.
CL2=$TMP/claude2; CX2=$TMP/codex2; PH2=$TMP/pulse2
mkdir -p "$CL2/projects/ds" "$CX2/sessions/2026/09/29" "$PH2"
node -e '
const fs = require("fs");
const [cl, cx] = process.argv.slice(1);
const A = (iso, id, model, usage, extra) => Object.assign({ type: "assistant", timestamp: iso,
  sessionId: "ds-" + id, requestId: "r" + id, cwd: "/p",
  message: { id: "m" + id, model, usage: Object.assign({ input_tokens: 1000000, output_tokens: 1000000 }, usage || {}) } }, extra || {});
const lines = [
  // deepseek-flash, 1M miss + 1M out: peak (Tue 02:00Z) 0.30 + 1.20 = 1.50
  A("2026-09-29T02:00:00.000Z", "f-peak", "deepseek-flash"),
  // off-peak (Tue 05:00Z, between the two peak windows) = 0.75
  A("2026-09-29T05:00:00.000Z", "f-off", "deepseek-flash"),
  // Mid-Autumn holiday (Fri 2026-09-25 02:00Z, inside peak HOURS) = off-peak 0.75
  A("2026-09-25T02:00:00.000Z", "f-hol", "deepseek-flash"),
  // weekend (Sun 2026-09-27 08:00Z) = 0.75
  A("2026-09-27T08:00:00.000Z", "f-wkd", "deepseek-flash"),
  // 1M cache-hit reads at peak: hit rate 0.006 (0.02 x 0.30), + 1M "write"
  // billed as plain miss input (no write premium), 0 in / 0 out = 0.306
  A("2026-09-29T03:00:00.000Z", "f-cache", "deepseek-flash",
    { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1000000, cache_creation_input_tokens: 1000000,
      server_tool_use: { web_search_requests: 1000 } }),
  // legacy v4-flash name: Thu 2026-09-10 03:59Z = the OLD peak 0.44 + 1.32 = 1.76
  A("2026-09-10T03:59:00.000Z", "v4-old", "deepseek-v4-flash"),
  // 04:00Z the same day = the new Flash price, and off-peak (04-06Z gap) = 0.75
  A("2026-09-10T04:00:00.000Z", "v4-new", "deepseek-v4-flash"),
  // v4-pro before peak pricing began (2026-08-10, flat) = 0.435 + 0.87 = 1.305
  A("2026-08-10T02:00:00.000Z", "p-aug", "deepseek-v4-pro"),
  // v4-pro now, peak = 1.32 + 3.96 = 5.28
  A("2026-09-29T09:00:00.000Z", "p-now", "deepseek-v4-pro"),
  // Refusal fallback: requested Sonnet 5.5 declined mid-stream, Opus 4.8
  // served — message.model still names the requested model, the top-level
  // usage is the served attempt, so it must bill at Opus 4.8 5/25 = 30 and be
  // attributed to it. The declined "message" item is NOT added.
  A("2026-09-29T11:00:00.000Z", "fb", "claude-sonnet-5-5", { iterations: [
    { type: "message", model: "claude-sonnet-5-5", input_tokens: 1000000, output_tokens: 5 },
    { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 1000000, output_tokens: 1000000 },
  ] }),
  // An ordinary turn repeats its usage in one "message" item: counted ONCE (12).
  A("2026-09-29T12:00:00.000Z", "plain", "claude-sonnet-5-5", { iterations: [
    { type: "message", input_tokens: 1000000, output_tokens: 1000000 } ] }),
];
fs.writeFileSync(cl + "/projects/ds/s.jsonl", lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
// Codex: [model, uncached in, out, cached, tier] per turn, via
// thread_settings_applied snapshots like the v1.31 rollout above.
const iso = (ms) => new Date(ms).toISOString();
const roll = (sid, base, turns) => {
  const out = [{ timestamp: iso(base - 60e3), type: "session_meta", payload: { session_id: sid, cwd: "/p" } }];
  turns.forEach(([m, inp, o, cached, tier], i) => {
    const t = base + (i + 1) * 60e3;
    out.push({ timestamp: iso(t - 10e3), type: "event_msg", payload: { type: "thread_settings_applied",
      thread_settings: Object.assign({ model: m, model_provider_id: "openai" }, tier ? { service_tier: tier } : {}) } });
    out.push({ timestamp: iso(t), type: "turn_context", payload: { turn_id: sid + "-t" + i, model: m } });
    const u = { input_tokens: inp + cached, cached_input_tokens: cached, output_tokens: o, total_tokens: inp + cached + o };
    out.push({ timestamp: iso(t + 30e3), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: u } } });
  });
  return out.map((l) => JSON.stringify(l)).join("\n") + "\n";
};
// Tue 2026-09-29 11:00Z onward = DeepSeek off-peak (after 10:00Z).
fs.writeFileSync(cx + "/sessions/2026/09/29/rollout-a.jsonl", roll("cx-a", Date.parse("2026-09-29T11:00:00.000Z"), [
  // GPT-6.1 Sol standard: 100K in + 1M out + 100K cached (5% rate) = 0.2 + 10 + 0.01 = 10.21
  ["gpt-6.1-sol", 100000, 1000000, 100000, null],
  // GPT-6 Astra ULTRAFAST: 6x (1 + 50) = 306 (at fast 2x it would be 102)
  ["gpt-6-astra", 100000, 1000000, 0, "ultrafast"],
  // DeepSeek via Codex, off-peak: 1M in (+1M cached) + 1M out = 0.15 + 0.003 + 0.60 = 0.753
  ["deepseek-flash", 1000000, 1000000, 1000000, null],
]));
// A second session for GPT-6.1 Sol FAST + long context (300K prompt > 272K):
// 2 x (300K x $4 + 100K x $15) = 2 x (1.2 + 1.5) = 5.4, and an Ultrafast turn
// on a row WITHOUT an ultrafast price (gpt-6-sol) prices standard: 0.2 + 10 = 10.2
fs.writeFileSync(cx + "/sessions/2026/09/29/rollout-b.jsonl", roll("cx-b", Date.parse("2026-09-29T13:00:00.000Z"), [
  ["us.openai.gpt-6.1-sol", 300000, 100000, 0, "priority"],
  ["gpt-6-sol", 100000, 1000000, 0, "ultrafast"],
]));
' "$CL2" "$CX2"

PORT2=4921
CLAUDE_DIR=$CL2 CODEX_DIR=$CX2 GEMINI_DIR=$TMP/no-gemini PULSE_HOME=$PH2 \
node "$ROOT/server.js" --port $PORT2 --no-update-check >"$TMP/srv2.log" 2>&1 &
SRV2=$!
sleep 2.5
curl -s "http://127.0.0.1:$PORT2/api/summary" > "$TMP/out2.json"
kill $SRV2 2>/dev/null

node -e '
const s = require(process.argv[1] + "/out2.json");
const log = require("fs").readFileSync(process.argv[1] + "/srv2.log", "utf8");
let fail = 0;
const ok = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + "  " + msg); if (!cond) fail = 1; };
const S = require(process.argv[2] + "/server.js");
const near = (a, b) => typeof a === "number" && Math.abs(a - b) < 0.0005;
// Per-entry costs straight from the price model (the sessions are 1 entry each).
const sess = {};
for (const r of s.recentSessions || []) sess[r.sessionId] = r;
const cost = (sid) => sess[sid] ? sess[sid].cost : undefined;
const WANT = { "ds-f-peak": 1.5, "ds-f-off": 0.75, "ds-f-hol": 0.75, "ds-f-wkd": 0.75, "ds-f-cache": 0.306,
               "ds-v4-old": 1.76, "ds-v4-new": 0.75, "ds-p-aug": 1.305, "ds-p-now": 5.28,
               "ds-fb": 30, "ds-plain": 12 };
for (const [sid, want] of Object.entries(WANT)) ok(near(cost(sid), want), sid + " = $" + want + " (got " + cost(sid) + ")");
const sep = ((s.periods || []).find((p) => p.key === "2026-09") || {}).byModel || {};
ok(sep["claude-opus-4-8"] && near(sep["claude-opus-4-8"].cost, 30), "refusal fallback is attributed to the SERVING model (claude-opus-4-8 = 30)");
ok(sep["claude-sonnet-5-5"] && near(sep["claude-sonnet-5-5"].cost, 12), "the requested model keeps only its own ordinary turn (12)");
const cx = { "gpt-6.1-sol": 10.21, "gpt-6-astra": 306, "deepseek-flash": 0.753 + 1.5 + 0.75 * 3 + 0.306,
             "us.openai.gpt-6.1-sol": 5.4, "gpt-6-sol": 10.2 };
for (const [m, want] of Object.entries(cx)) ok(sep[m] && near(sep[m].cost, want), "Sep " + m + " = $" + want.toFixed(4) + " (got " + (sep[m] ? sep[m].cost.toFixed(4) : "missing") + ")");
// Ultrafast is fast-mode spend: premium = Astra (306 - 51) + 6.1 Sol fast (5.4 - 2.7) = 257.7
const fp = ((s.periods || []).find((p) => p.key === "2026-09") || {}).speedSpend;
ok(fp && near(fp.fastPremium, 257.7), "fast premium includes the Ultrafast premium: 255 + 2.7 = 257.7 (got " + (fp && fp.fastPremium) + ")");
// Cache economics on DeepSeek (Claude path): 1M reads at peak saved 0.30 - 0.006 = 0.294,
// and a write premium of 0 (no write surcharge).
const e = { provider: "anthropic", model: "deepseek-flash", ts: Date.parse("2026-09-29T03:00:00Z"), inputTokens: 0, outputTokens: 0,
  cacheWrite5m: 1e6, cacheWrite1h: 1e6, cacheRead: 1e6, webSearches: 0, speed: "standard" };
ok(near(S.costForEntry(e), 0.3 + 0.3 + 0.006), "DeepSeek 5m and 1h writes both bill as plain input: 0.606 (got " + S.costForEntry(e) + ")");
// The list-price view never shows an off-peak rate.
const view = s.pricing || {};
ok(view["deepseek-v4-pro"] && view["deepseek-v4-pro"].input === 1.32, "pricing view shows the PEAK list price (got " + JSON.stringify(view["deepseek-v4-pro"]) + ")");
const unk = log.split("\n").filter((l) => /unknown model/.test(l));
ok(unk.length === 0, "every 2026-09-29 row prices silently (got " + unk.length + ": " + unk.join(" | ") + ")");
process.exit(fail);
' "$TMP" "$ROOT"
RES2=$?
[ $RES -eq 0 ] && RES=$RES2
echo "---- exit $RES"
exit $RES
