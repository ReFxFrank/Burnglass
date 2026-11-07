#!/bin/bash
# Run every e2e suite. Needs Node >= 18 and curl; no real logins, no network
# beyond localhost mocks. Suites run sequentially (each owns a port).
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
# Keep the other agents' real folders out of every suite: a suite that doesn't
# set one of these would otherwise read this machine's own Gemini CLI,
# Antigravity, Continue, Cline or Roo usage. Suites that test an agent set
# their own fixture folder, which overrides these.
NOAGENT="${TMPDIR:-/tmp}/burnglass-no-agents-$$"
export GEMINI_DIR="${GEMINI_DIR:-$NOAGENT/gemini}" ANTIGRAVITY_DIR="${ANTIGRAVITY_DIR:-$NOAGENT/antigravity}"
export CONTINUE_DIR="${CONTINUE_DIR:-$NOAGENT/continue}" CLINE_DIR="${CLINE_DIR:-$NOAGENT/cline}" ROO_DIR="${ROO_DIR:-$NOAGENT/roo}"
FAILED=0
for t in meters meters-observe pricing currency codex-usage discord discord-presence effort-echo history statusline analytics model-families meters-polling alerts heatmap reach agents antigravity budget comparison export projection tray meters-recheck meters-cache plan-value cache-savings speed-spend summary-cli startup meshy custom-sources reprice transcript-format agent-state migration web-notices packaging strip-heal; do
  echo "=== $t ==="
  if ! bash "$DIR/$t.test.sh"; then
    FAILED=1
    echo "*** $t FAILED"
  fi
done
[ $FAILED -eq 0 ] && echo "ALL SUITES PASSED" || echo "SOME SUITES FAILED"
exit $FAILED
