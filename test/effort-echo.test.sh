#!/bin/bash
# Effort chips from bare `/effort` (interactive picker) — the level lives only
# in the <local-command-stdout> confirmation echo. Also: quoted words in a
# real prompt must never forge an event.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
CL=$TMP/claude; PH=$TMP/pulse
mkdir -p "$CL/projects/demo" "$PH"

node -e '
const fs = require("fs");
const now = Date.now();
const iso = (m) => new Date(now - m * 60e3).toISOString();
const U = (min, sid, content) => ({ type: "user", timestamp: iso(min), sessionId: sid, cwd: "/p",
  message: { role: "user", content } });
const A = (min, sid, id) => ({ type: "assistant", timestamp: iso(min), sessionId: sid, requestId: "r" + id, cwd: "/p",
  message: { id: "m" + id, model: "claude-fable-5", usage: { input_tokens: 100, output_tokens: 100 } } });
const lines = [
  // Session P: the desktop scenario — bare /effort, EMPTY args, picker echo
  U(60, "sess-P", "<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args></command-args>"),
  U(59, "sess-P", "<local-command-stdout>Set effort level to high (this session only)</local-command-stdout>"),
  U(58, "sess-P", "please fix the server rename bug"),
  A(57, "sess-P", 1),
  // …then picker again → ultracode
  U(50, "sess-P", "<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args></command-args>"),
  U(49, "sess-P", "<local-command-stdout>Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration</local-command-stdout>"),
  A(48, "sess-P", 2),
  // …then back to auto → chip cleared from here on
  U(40, "sess-P", "<local-command-stdout>Effort level set to auto</local-command-stdout>"),
  A(39, "sess-P", 3),
  // Session Q: a REAL prompt quoting the magic words must NOT forge an event
  U(30, "sess-Q", "why does it say Set effort level to max sometimes?"),
  A(29, "sess-Q", 4),
  // Session R: "Kept effort level as" echo also names the level
  U(20, "sess-R", "<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args></command-args>"),
  U(19, "sess-R", "<local-command-stdout>Kept effort level as max</local-command-stdout>"),
  A(18, "sess-R", 5),
  // Session S: Claude Code >= 2.1.212 records the level ON the assistant entry
  // (top-level `effort`) — no echo anywhere, the recorded field alone must chip
  Object.assign(A(12, "sess-S", 6), { effort: "xhigh" }),
  // Session T: an echo says high, but one entry RECORDS medium — the recorded
  // per-message level is authoritative there; the echo fills the unrecorded one
  U(10, "sess-T", "<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args></command-args>"),
  U(9, "sess-T", "<local-command-stdout>Set effort level to high (this session only)</local-command-stdout>"),
  Object.assign(A(8, "sess-T", 7), { effort: "Medium" }), // case-normalized
  A(7, "sess-T", 8),
  // Claude Code 2.1.281 also writes perTurnEffort, but only SENDS it under a
  // beta — so it is ignored. Session U: an echo sets low, then an entry with
  // ONLY perTurnEffort max -> the echo fills it (low), max never appears.
  U(7, "sess-U", "<local-command-stdout>Set effort level to low (this session only)</local-command-stdout>"),
  Object.assign(A(6, "sess-U", 9), { perTurnEffort: "max" }),
  // Session W: both present and DIFFERENT -> effort (the level actually sent)
  // wins; perTurnEffort is only sent when a beta is active.
  Object.assign(A(5, "sess-W", 10), { effort: "medium", perTurnEffort: "max" }),
  // Session V: "auto" means no explicit level -> never a chip.
  Object.assign(A(4, "sess-V", 11), { effort: "auto", perTurnEffort: "default" }),
];
fs.writeFileSync(process.argv[1] + "/projects/demo/s.jsonl",
  lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
' "$CL"

PORT=4885
CLAUDE_DIR=$CL PULSE_HOME=$PH CODEX_DIR=$TMP/no-codex \
node "$ROOT/server.js" --port $PORT --no-update-check >"$TMP/srv.log" 2>&1 &
SRV=$!
sleep 2
curl -s "http://127.0.0.1:$PORT/api/summary" > "$TMP/out.json"
kill $SRV 2>/dev/null

node -e '
const s = require(process.argv[1] + "/out.json");
let fail = 0;
const ok = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + "  " + msg); if (!cond) fail = 1; };
const sess = {};
for (const r of s.recentSessions || []) sess[r.sessionId] = r;
const P = sess["sess-P"], Q = sess["sess-Q"], R = sess["sess-R"];
ok(P && Q && R, "all three sessions present");
ok(P && (P.efforts || []).includes("high"), "P: picker echo with EMPTY args yields high chip — got " + JSON.stringify(P && P.efforts));
ok(P && P.ultracode === true, "P: ultracode picker echo flags ULTRA");
ok(Q && (Q.efforts || []).length === 0 && !Q.ultracode, "Q: quoted words in a real prompt forge NOTHING — got " + JSON.stringify(Q && Q.efforts));
ok(R && (R.efforts || []).includes("max"), "R: Kept-effort echo yields max — got " + JSON.stringify(R && R.efforts));
const S2 = sess["sess-S"], T2 = sess["sess-T"];
const U2 = sess["sess-U"], W2 = sess["sess-W"], V2 = sess["sess-V"];
ok(U2 && JSON.stringify(U2.efforts) === JSON.stringify(["low"]), "U: perTurnEffort is ignored and never blocks the echo (low, not max) - got " + JSON.stringify(U2 && U2.efforts));
ok(W2 && JSON.stringify(W2.efforts) === JSON.stringify(["medium"]), "W: effort wins over a differing perTurnEffort - got " + JSON.stringify(W2 && W2.efforts));
ok(V2 && (V2.efforts || []).length === 0, "V: auto/default never become chips - got " + JSON.stringify(V2 && V2.efforts));
ok(S2 && (S2.efforts || []).includes("xhigh"), "S: recorded per-entry effort field chips with NO echo — got " + JSON.stringify(S2 && S2.efforts));
ok(T2 && (T2.efforts || []).includes("medium") && (T2.efforts || []).includes("high"),
   "T: recorded level wins on its own entry, echo fills the unrecorded one — got " + JSON.stringify(T2 && T2.efforts));
process.exit(fail);
' "$TMP"
RES=$?

# ---- Claude Code >= 2.1.284: Ultracode is its own toggle ------------------
# `/effort ultracode [on|off]` flips it without touching the level, and a level
# change leaves it alone. Old-era transcripts (no version / < 2.1.284) keep the
# old meaning: ultracode was a level and any other level ended it.
mkdir -p "$TMP/t2/projects/demo"
node -e '
const fs = require("fs");
const path = require("path");
const S = require(process.argv[1] + "/server.js");
let fail = 0;
const ok = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + "  " + msg); if (!cond) fail = 1; };
const J = JSON.stringify;

// parseEffortArgs
ok(J(S.parseEffortArgs("ultracode off", true)) === J({ ultracode: false, toggle: true }), "args: ultracode off turns it OFF (toggle era)");
ok(J(S.parseEffortArgs("ultracode on", true)) === J({ ultracode: true, toggle: true }), "args: ultracode on");
ok(J(S.parseEffortArgs("ultracode", true)) === J({ ultracode: true, toggle: true }), "args: bare ultracode = on");
ok(S.parseEffortArgs("ultracode off now", true) === null, "args: extra words are rejected like Claude Code does");
ok(S.parseEffortArgs("ultracode maybe", true) === null, "args: unknown toggle value is rejected");
ok(J(S.parseEffortArgs("High", true)) === J({ effort: "high", toggle: true }), "args: a level leaves ultracode unchanged (toggle era)");
ok(J(S.parseEffortArgs("auto", true)) === J({ effort: null, toggle: true }), "args: auto clears the level only");
ok(J(S.parseEffortArgs("ultracode off", false)) === J({ effort: null, ultracode: true }), "args: old era keeps the old meaning");
ok(J(S.parseEffortArgs("max", false)) === J({ effort: "max", ultracode: false }), "args: old era level ends ultracode");
ok(S.parseEffortArgs("banana", true) === null, "args: unknown level ignored");

// parseEffortStdout
const on = "Ultracode on (this session only): dynamic workflow orchestration. Effort stays high.";
ok(J(S.parseEffortStdout(on, true)) === J({ ultracode: true, toggle: true }), "echo: Ultracode on (effort unchanged)");
ok(J(S.parseEffortStdout("Ultracode off. Effort stays xhigh.", true)) === J({ ultracode: false, toggle: true }), "echo: Ultracode off");
ok(J(S.parseEffortStdout("Set effort level to high (this session only): Deeper reasoning · Ultracode on", true)) === J({ effort: "high", toggle: true, ultracode: true }), "echo: picker level + trailing Ultracode on");
ok(J(S.parseEffortStdout("Set effort level to low (this session only): Fast · Ultracode off", true)) === J({ effort: "low", toggle: true, ultracode: false }), "echo: picker level + trailing Ultracode off");
ok(J(S.parseEffortStdout("Effort level set to auto · Ultracode off", true)) === J({ effort: null, toggle: true, ultracode: false }), "echo: auto + Ultracode off");
ok(J(S.parseEffortStdout("Set effort level to medium (this session only)", true)) === J({ effort: "medium", toggle: true }), "echo: a plain level leaves ultracode unchanged (toggle era)");
ok(S.parseEffortStdout("Ultracode on (this session only)", false) === null, "echo: the toggle echo is not parsed in an old-era record");
ok(J(S.parseEffortStdout("Set effort level to high (this session only)", false)) === J({ effort: "high", ultracode: false }), "echo: old era unchanged");
ok(S.parseEffortStdout("why is Ultracode on", true) === null, "echo: not anchored at the start -> nothing");

// End to end through parseFile + mergeModes + annotateModes.
const now = Date.parse("2026-09-29T12:00:00Z");
const iso = (m) => new Date(now - m * 60e3).toISOString();
const U = (min, sid, content, version) => Object.assign({ type: "user", timestamp: iso(min), sessionId: sid, cwd: "/p",
  message: { role: "user", content } }, version ? { version } : {});
const A = (min, sid, id, effort, version) => Object.assign({ type: "assistant", timestamp: iso(min), sessionId: sid, requestId: "r" + id, cwd: "/p",
  message: { id: "m" + id, model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 10 } } }, effort ? { effort } : {}, version ? { version } : {});
const CMD = (a) => "<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>" + a + "</command-args>";
const OUT = (t) => "<local-command-stdout>" + t + "</local-command-stdout>";
const V = "2.1.285", OLD = "2.1.283";
const lines = [
  // NEW: on -> level change keeps it -> off
  U(60, "new", CMD("ultracode on"), V), U(59, "new", OUT(on), V),
  A(58, "new", 1, "high", V),
  U(50, "new", CMD("max"), V), U(49, "new", OUT("Set effort level to max (this session only)"), V),
  A(48, "new", 2, "max", V),
  U(40, "new", CMD("ultracode off"), V), U(39, "new", OUT("Ultracode off. Effort stays max."), V),
  A(38, "new", 3, "max", V),
  // picker turns it on alongside a level
  U(30, "new", CMD(""), V), U(29, "new", OUT("Set effort level to low (this session only): Fast · Ultracode on"), V),
  A(28, "new", 4, "low", V),
  // OLD era (2.1.283): ultracode then a level ends it; "ultracode off" args = ON (old grammar had no off)
  U(60, "old", CMD("ultracode"), OLD), A(58, "old", 5, "xhigh", OLD),
  U(50, "old", CMD("max"), OLD), A(48, "old", 6, "max", OLD),
  // No version field at all = old era
  U(60, "nov", CMD("ultracode"), null), A(58, "nov", 7, null, null),
  U(50, "nov", OUT("Set effort level to high (this session only)"), null), A(48, "nov", 8, null, null),
];
const f = path.join(process.argv[2], "projects/demo/t.jsonl");
fs.writeFileSync(f, lines.map((l) => J(l)).join("\n") + "\n");
const r = S.parseFile(f);
const ev = r.effortEvents;
ok(ev.filter((e) => e.sessionId === "new").every((e) => e.toggle === true), "parseFile: toggle-era events are marked");
ok(ev.filter((e) => e.sessionId !== "new").every((e) => !e.toggle), "parseFile: old-era events are not");
// A hook sidecar record (ultracode false = absence) after the toggle must not end it.
const side = { new: [{ ts: now - 53 * 60e3, effort: "max", ultracode: false }] };
const modes = S.mergeModes(side, ev);
const entries = r.entries.slice().sort((a, b) => a.ts - b.ts);
S.annotateModes(entries, modes, new Set(r.ultracodeSessions || []));
const at = (id) => { const e = entries.find((x) => x.key === "m:m" + id); return e ? [e.effort, e.ultracode] : null; };
ok(J(at(1)) === J(["high", true]), "new: ultracode on keeps the recorded level (high + ULTRA) - got " + J(at(1)));
ok(J(at(2)) === J(["max", true]), "new: a level change leaves ultracode ON (max + ULTRA) - got " + J(at(2)));
ok(J(at(3)) === J(["max", false]), "new: /effort ultracode off turns it OFF - got " + J(at(3)));
ok(J(at(4)) === J(["low", true]), "new: picker level + Ultracode on - got " + J(at(4)));
ok(J(at(5)) === J(["xhigh", true]), "old: ultracode level flags ULTRA - got " + J(at(5)));
ok(J(at(6)) === J(["max", false]), "old: a later level ends ultracode (old meaning kept) - got " + J(at(6)));
ok(J(at(7)) === J([null, true]), "no version: old era, ultracode on - got " + J(at(7)));
ok(J(at(8)) === J(["high", false]), "no version: level echo ends ultracode - got " + J(at(8)));
// Without the toggle-era marker a sidecar false still acts as a full snapshot (old behaviour).
const oldModes = S.mergeModes({ old: [{ ts: now - 55 * 60e3, effort: null, ultracode: false }] }, ev.filter((e) => e.sessionId === "old"));
ok(oldModes.old.some((m) => m.ultracode === false && m.effort === null), "old: sidecar snapshot semantics unchanged");
process.exit(fail);
' "$ROOT" "$TMP/t2"
RES2=$?
[ $RES -eq 0 ] && RES=$RES2
echo "---- exit $RES"
exit $RES
