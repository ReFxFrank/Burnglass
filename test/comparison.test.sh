#!/bin/bash
# Period-over-period comparison: each period carries a `prev` total for the
# immediately-preceding equal-length window, so the UI can show a delta.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
CL=$TMP/claude; PH=$TMP/pulse
mkdir -p "$CL/projects/demo" "$PH"
# $10 in the current 30d window (5 days ago), $5 in the PREVIOUS 30d window
# (45 days ago). fable-5 $10/$50: 200k out = $10, 100k out = $5. Plus $2 three
# days ago and $3 ten days ago for the 7- and 14-day windows.
node -e '
const fs=require("fs"); const now=Date.now(); const d=(days)=>new Date(now-days*86400e3).toISOString();
const A=(iso,i,out)=>({type:"assistant",timestamp:iso,sessionId:"s"+i,requestId:"r"+i,cwd:"/p",message:{id:"m"+i,model:"claude-fable-5",usage:{input_tokens:0,output_tokens:out}}});
fs.writeFileSync(process.argv[1]+"/projects/demo/s.jsonl",[
  A(d(5),1,200000),   // current 30d -> $10
  A(d(45),2,100000),  // previous 30d -> $5
  A(d(3),3,40000),    // last 7 days -> $2
  A(d(10),4,60000),   // last 14 days, the 7 days before last7 -> $3
].map(JSON.stringify).join("\n")+"\n");
' "$CL"

PORT=4897
PULSE_HOME=$PH CLAUDE_DIR=$CL CODEX_DIR=$TMP/nc node "$ROOT/server.js" --port $PORT --no-update-check >"$TMP/srv.log" 2>&1 &
SRV=$!; sleep 2.2
curl -s "http://127.0.0.1:$PORT/api/summary" > "$TMP/out.json"
curl -s "http://127.0.0.1:$PORT/api/export?format=csv&data=daily" > "$TMP/daily.csv"
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null

node -e '
const s=require(process.argv[1]+"/out.json");
let fail=0; const ok=(c,m)=>{console.log((c?"PASS":"FAIL")+"  "+m); if(!c) fail=1;};
const near=(a,b)=>typeof a==="number"&&Math.abs(a-b)<0.02;
const P=(k)=>(s.periods||[]).find(p=>p.key===k);
const l30=P("last30");
ok(l30 && near(l30.cost,15), "last30 cost = $15 (current window; got "+(l30&&l30.cost)+")");
ok(l30 && l30.prev && near(l30.prev.cost,5), "last30.prev.cost = $5 (previous 30d window; got "+(l30&&l30.prev&&l30.prev.cost)+")");
ok(l30 && l30.prev.messages===1, "prev window message count = 1");
// nothing 181-360 days back -> prev is zero, so the UI hides the delta
const l180=P("last180");
ok(l180 && l180.prev && l180.prev.cost===0, "last180.prev.cost = 0 (no data that far back; got "+(l180&&l180.prev&&l180.prev.cost)+")");
// 7- and 14-day windows (2.2): shortest first, calendar days ending today.
const rolling=(s.periods||[]).filter(p=>/^last/.test(p.key)).map(p=>p.key+":"+p.daily.length+":"+p.label);
ok(rolling.join(",")==="last7:7:Last 7 days,last14:14:Last 14 days,last30:30:Last 30 days,last90:90:Last 90 days,last180:180:Last 180 days",
   "rolling periods in order with their day counts (got "+rolling.join(",")+")");
const l7=P("last7"), l14=P("last14");
ok(l7 && near(l7.cost,12), "last7 = $12 ($10 five days ago + $2 three days ago; got "+(l7&&l7.cost)+")");
ok(l7 && l7.prev && near(l7.prev.cost,3), "last7.prev = the 7 days before = $3 (got "+(l7&&l7.prev&&l7.prev.cost)+")");
ok(l14 && near(l14.cost,15) && l14.prev && l14.prev.cost===0, "last14 = $15, prev 0 (got "+(l14&&l14.cost)+" / "+(l14&&l14.prev&&l14.prev.cost)+")");
ok(l7 && l7.daily[l7.daily.length-1].date===l30.daily[l30.daily.length-1].date, "every rolling window ends today");
const csv=require("fs").readFileSync(process.argv[1]+"/daily.csv","utf8").trim().split(/\r?\n/);
ok(csv.length===31, "an export without a period is still Last 30 days (got "+(csv.length-1)+" day rows)");
process.exit(fail);
' "$TMP"
RES=$?
echo "---- exit $RES"
exit $RES
