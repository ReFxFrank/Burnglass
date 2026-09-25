#!/bin/sh
# Burnglass — launcher (POSIX). Forwards all args to server.js.
# Usage: ./burnglass.sh [--port N] [--summary] [--inspect-schema]
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/server.js" "$@"
