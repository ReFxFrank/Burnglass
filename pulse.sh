#!/bin/sh
# Pulse was renamed Burnglass in v2.0.0. This shim keeps old scripts and
# shortcuts working — it runs the same server as ./burnglass.sh.
exec "$(cd "$(dirname "$0")" && pwd)/burnglass.sh" "$@"
