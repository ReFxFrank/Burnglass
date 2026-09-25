#!/usr/bin/env bash
#
# Burnglass (formerly Pulse) — one-command installer for an Ubuntu (systemd) VPS.
#
#   curl -fsSL https://raw.githubusercontent.com/ReFxFrank/Burnglass/main/install.sh | bash
#
# or, from a checkout:   ./install.sh
#
# What it does:
#   1. Fetches Burnglass (git clone, or uses the current checkout).
#   2. Ensures Node.js >= 18 (installs Node 20 LTS via NodeSource if needed).
#   3. Installs a systemd service that runs Burnglass, restarts on failure, and
#      starts on boot — as the user whose ~/.claude holds your usage.
#   4. Binds to 127.0.0.1 by default and prints the SSH-tunnel command to reach
#      it securely. (Set BURNGLASS_HOST=0.0.0.0 to expose it — you'll be warned.)
#
# Overridable via env: BURNGLASS_REPO BURNGLASS_BRANCH BURNGLASS_DIR
# BURNGLASS_PORT BURNGLASS_HOST — each also answers to its old PULSE_* name.
#
# Upgrading a Pulse install: an existing ~/pulse checkout and an existing
# pulse.service are REUSED under their old names (renaming a running unit or a
# checkout other tools point at buys nothing); only new installs get
# ~/burnglass and burnglass.service.
set -euo pipefail

BG_REPO="${BURNGLASS_REPO:-${PULSE_REPO:-https://github.com/ReFxFrank/Burnglass.git}}"
BG_BRANCH="${BURNGLASS_BRANCH:-${PULSE_BRANCH:-main}}"
BG_PORT="${BURNGLASS_PORT:-${PULSE_PORT:-4747}}"
BG_HOST="${BURNGLASS_HOST:-${PULSE_HOST:-127.0.0.1}}"

c_mag=$'\033[36m'; c_red=$'\033[31m'; c_yel=$'\033[33m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
log(){ printf '%s[burnglass]%s %s\n' "$c_mag" "$c_off" "$*"; }
warn(){ printf '%s[burnglass] %s%s\n' "$c_yel" "$*" "$c_off"; }
die(){ printf '%s[burnglass] %s%s\n' "$c_red" "$*" "$c_off" >&2; exit 1; }

# --- who owns the ~/.claude we should read, and can we get root? -------------
if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
  TARGET_USER="$SUDO_USER"
else
  TARGET_USER="$(id -un)"
fi
TARGET_HOME="$(getent passwd "$TARGET_USER" 2>/dev/null | cut -d: -f6)"
[ -z "$TARGET_HOME" ] && TARGET_HOME="${HOME:-/home/$TARGET_USER}"

if [ "$(id -u)" -eq 0 ]; then SUDO=""; HAVE_ROOT=1
elif command -v sudo >/dev/null 2>&1; then SUDO="sudo"; HAVE_ROOT=1
else SUDO=""; HAVE_ROOT=0; fi

# Install dir: explicit env > an existing Pulse checkout (~/pulse) > ~/burnglass.
if [ -n "${BURNGLASS_DIR:-${PULSE_DIR:-}}" ]; then
  BG_DIR="${BURNGLASS_DIR:-$PULSE_DIR}"
elif [ -d "$TARGET_HOME/pulse/.git" ] && [ ! -d "$TARGET_HOME/burnglass/.git" ]; then
  BG_DIR="$TARGET_HOME/pulse"
else
  BG_DIR="$TARGET_HOME/burnglass"
fi

# Service name: keep a Pulse-era unit's name when one exists (system or user).
SVC=burnglass
if [ -f /etc/systemd/system/pulse.service ] || [ -f "$HOME/.config/systemd/user/pulse.service" ]; then
  if [ ! -f /etc/systemd/system/burnglass.service ] && [ ! -f "$HOME/.config/systemd/user/burnglass.service" ]; then
    SVC=pulse
  fi
fi

run_as_target(){ # run a command as TARGET_USER (dropping root if needed)
  if [ "$(id -un)" = "$TARGET_USER" ]; then bash -lc "$*";
  else $SUDO -u "$TARGET_USER" bash -lc "$*"; fi
}

# --- 1. fetch the code -------------------------------------------------------
SELF_SRC="${BASH_SOURCE[0]:-}"
SELF_DIR=""
[ -n "$SELF_SRC" ] && SELF_DIR="$(cd -- "$(dirname -- "$SELF_SRC")" 2>/dev/null && pwd || true)"

if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/server.js" ]; then
  BG_DIR="$SELF_DIR"
  log "using existing checkout at $BG_DIR"
else
  command -v git >/dev/null 2>&1 || { log "installing git…"; $SUDO apt-get update -y && $SUDO apt-get install -y git; }
  if [ -d "$BG_DIR/.git" ]; then
    log "updating existing install at $BG_DIR"
    run_as_target "git -C '$BG_DIR' fetch --depth 1 origin '$BG_BRANCH' && git -C '$BG_DIR' checkout '$BG_BRANCH' && git -C '$BG_DIR' reset --hard 'origin/$BG_BRANCH'"
  else
    log "cloning $BG_REPO ($BG_BRANCH) -> $BG_DIR"
    run_as_target "git clone --depth 1 --branch '$BG_BRANCH' '$BG_REPO' '$BG_DIR'"
  fi
fi
[ -f "$BG_DIR/server.js" ] || die "server.js not found in $BG_DIR"

# --- 2. ensure Node >= 18 ----------------------------------------------------
node_ok=0
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "${major:-0}" -ge 18 ] && { node_ok=1; log "found Node $(node -v)"; }
fi
if [ "$node_ok" -ne 1 ]; then
  [ "$HAVE_ROOT" -eq 1 ] || die "Node >= 18 not found and no root/sudo to install it. Install Node 18+ and re-run."
  log "installing Node.js 20 LTS via NodeSource (needs root)…"
  command -v curl >/dev/null 2>&1 || { $SUDO apt-get update -y && $SUDO apt-get install -y curl; }
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
  log "installed Node $(node -v)"
fi
NODE_BIN="$(command -v node)"

# make sure the target user owns the checkout (so its own service + future pulls work)
if [ "$HAVE_ROOT" -eq 1 ] && [ "$(id -un)" != "$TARGET_USER" ] && [ -d "$BG_DIR" ]; then
  $SUDO chown -R "$TARGET_USER":"$TARGET_USER" "$BG_DIR" 2>/dev/null || true
fi

CLAUDE_DIR_VAL="${CLAUDE_DIR:-$TARGET_HOME/.claude}"

# --- 3. install a service ----------------------------------------------------
INSTALLED=""
sysd_ok(){ command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; }

# System service — most robust; survives reboot; runs as TARGET_USER.
if [ -z "$INSTALLED" ] && [ "$HAVE_ROOT" -eq 1 ] && sysd_ok; then
  log "installing systemd service (runs as '$TARGET_USER')…"
  UNIT=/etc/systemd/system/$SVC.service
  $SUDO tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=Burnglass — usage dashboard for Claude Code, Codex and more
After=network.target

[Service]
Type=simple
User=$TARGET_USER
WorkingDirectory=$BG_DIR
Environment=CLAUDE_DIR=$CLAUDE_DIR_VAL
ExecStart=$NODE_BIN $BG_DIR/server.js --port $BG_PORT --host $BG_HOST
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  if $SUDO systemctl daemon-reload && $SUDO systemctl enable --now "$SVC.service"; then
    INSTALLED="system"
  else
    warn "system service didn't start — falling back."
    $SUDO rm -f "$UNIT" 2>/dev/null || true
  fi
fi

# User service — no root needed; lingers across logout/reboot.
if [ -z "$INSTALLED" ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  log "installing systemd --user service…"
  UDIR="$HOME/.config/systemd/user"; mkdir -p "$UDIR"
  cat > "$UDIR/$SVC.service" <<EOF
[Unit]
Description=Burnglass — usage dashboard for Claude Code, Codex and more
After=network.target

[Service]
Type=simple
WorkingDirectory=$BG_DIR
Environment=CLAUDE_DIR=$CLAUDE_DIR_VAL
ExecStart=$NODE_BIN $BG_DIR/server.js --port $BG_PORT --host $BG_HOST
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
  loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
  if systemctl --user daemon-reload && systemctl --user enable --now "$SVC.service"; then
    INSTALLED="user"
  else
    warn "user service didn't start — falling back."
  fi
fi

# Fallback: nohup (does not survive reboot).
if [ -z "$INSTALLED" ]; then
  warn "systemd unavailable — starting with nohup (will NOT restart on reboot)."
  run_as_target "cd '$BG_DIR' && CLAUDE_DIR='$CLAUDE_DIR_VAL' nohup '$NODE_BIN' server.js --port '$BG_PORT' --host '$BG_HOST' > '$BG_DIR/burnglass.log' 2>&1 &"
  INSTALLED="nohup"
fi

# --- 4. verify + print how to reach it --------------------------------------
sleep 2
health=""
if command -v curl >/dev/null 2>&1; then
  health="$(curl -fsS "http://127.0.0.1:$BG_PORT/api/health" 2>/dev/null || true)"
fi

echo
if printf '%s' "$health" | grep -q '"ok":true'; then
  log "Burnglass is running ✓  (health: $health)"
else
  warn "couldn't confirm health yet — it may still be starting. Check the logs (below)."
fi

echo
log "Installed at:  $BG_DIR"
log "Reading:       $CLAUDE_DIR_VAL  (read-only)"
case "$INSTALLED" in
  system) log "Manage:        sudo systemctl {status|restart|stop} $SVC   ·   logs: journalctl -u $SVC -f";;
  user)   log "Manage:        systemctl --user {status|restart|stop} $SVC   ·   logs: journalctl --user -u $SVC -f";;
  nohup)  log "Manage:        kill it via 'pkill -f server.js'   ·   logs: tail -f $BG_DIR/burnglass.log";;
esac

echo
if [ "$BG_HOST" = "127.0.0.1" ] || [ "$BG_HOST" = "::1" ] || [ "$BG_HOST" = "localhost" ]; then
  log "Burnglass is bound to localhost on the VPS (safe default)."
  log "Reach it from your own machine over an SSH tunnel:"
  printf '\n    %sssh -N -L %s:localhost:%s %s@<your-vps-ip>%s\n' "$c_dim" "$BG_PORT" "$BG_PORT" "$TARGET_USER" "$c_off"
  printf '    %sthen open  http://localhost:%s  in your browser%s\n\n' "$c_dim" "$BG_PORT" "$c_off"
  log "To expose it directly instead (NOT recommended), re-run with BURNGLASS_HOST=0.0.0.0"
else
  warn "Burnglass is bound to $BG_HOST — reachable from the network."
  warn "Lock it down: a firewall allowing only your IP, or an authenticating reverse proxy."
  log  "Open:  http://<your-vps-ip>:$BG_PORT"
fi
echo
