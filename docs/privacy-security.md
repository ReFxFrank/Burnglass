# Privacy & security

What Burnglass reads, what it writes, every network call it can make, and how its local server is protected.

[← Back to the README](../README.md) · [All docs](README.md)

---

**In short:** Burnglass runs on your machine, binds to `127.0.0.1`, only reads your
agents' logs, and never sends your usage anywhere. With the update check off and nothing
opted in, it makes no network calls at all.

## What it reads (read-only)

- `~/.claude` (or `CLAUDE_CONFIG_DIR`): Claude Code's transcripts, its live-session
  files, `settings.json` (to check that your status line and effort hook point at a file
  that exists, and for the optional effort hook, the saved effort level) and, with account
  meters on, the login token.
- `~/.codex` (or `CODEX_HOME`): Codex's rollouts and, with account meters on, the login token.
- Claude Desktop's session titles (its `claude-code-sessions` folder in the app's data
  folder), to name Desktop sessions in **Recent sessions**.
- The other agents' logs (Gemini CLI, Continue, Cline, Roo Code) and your custom-source files.

Burnglass never writes, moves or deletes anything in those places. The status-line and
effort-hook setup commands only **print** a snippet for you to paste.

## What it writes

**Only `~/.burnglass`** (or the folder `BURNGLASS_HOME` names): config, logs, the history
archive and caches. See [Configuration](configuration.md#files-in-burnglass) for the list.

The exceptions are things you explicitly ask for, all per-user and reversible:

- **Start with Windows:** one value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
- **The installer or `--install`:** the program folder, Start Menu and Desktop shortcuts,
  and an Add/Remove Programs entry. `--install-shortcuts` adds Desktop shortcuts.
- **Updates:** a one-click update replaces Burnglass's own executable (and its `pulse.exe`
  twin, when the installer kept one), and on Windows the first start after it refreshes a
  Burnglass Strip executable next to it or in `~/.burnglass/bin`.

Uninstalling never deletes `~/.burnglass` or `~/.pulse`.

### The old `~/.pulse` folder

Read once to copy your settings to `~/.burnglass`, then kept as a backup. Nothing in it is
ever moved or deleted. Afterwards Burnglass writes there only to keep companions from
Pulse 1.x working (a mirrored `server.json`, a refreshed `tray.ps1`) and to remove your
Meshy API key from the old `config.json`, so the key doesn't linger in a backup you think
is inert. A `~/.pulse` that Pulse never wrote (PulseAudio uses the same name) is left
completely alone.

## Network calls, exhaustively

1. **GitHub (on by default):** the version check and the community download and star
   counters. They read **public** data (the latest version, release download totals, the
   star count) and send **nothing about you**. Clicking **Update** downloads the
   sha256-verified release asset, and the first start after that update downloads the
   same release's strip when a Burnglass Strip is installed (Windows). `--no-update-check`,
   `BURNGLASS_NO_UPDATE_CHECK=1` or `{"updateCheck": false}` turns all of this off.
2. **Account meters (opt-in):** `api.anthropic.com` and `chatgpt.com`, with each
   provider's own login token (below).
3. **Meshy credits (opt-in):** `api.meshy.ai`, with the API key you paste.

**Discord presence** (opt-in) talks to the Discord desktop app over its **local** socket,
not the network. If you use `https://` image links, Discord's image proxy fetches them,
not Burnglass.

**No usage data ever leaves your machine.** There's no CDN, no external fonts, no
analytics, no telemetry and no phone-home.

## Login tokens (account meters)

- Burnglass reads Claude Code's token from `~/.claude/.credentials.json` or, on macOS,
  the login Keychain, and Codex's from `~/.codex/auth.json`. Both are read **read-only**.
- A token is never logged, never shown, never written, never included in a payload or an
  export, and sent **only** to its own provider's endpoint.
- Burnglass never mints or refreshes a token; it uses the login those tools already saved.
- The saved meter reading (`~/.burnglass/meters-cache.json`) holds percentages and reset
  times only, never a token. Turning meters off deletes it.

## Meshy API key

Meshy is the only service Burnglass authenticates to with a key **you** supply.

- It's stored in `~/.burnglass/config.json` (`meshyApiKey`). The dashboard sends it in a
  request body, never a URL.
- It's sent only to `api.meshy.ai`, in a request header.
- It's never logged, never put in a URL, and never included in the dashboard payload or
  exports; the payload only says whether a key is set.
- A new `config.json` that holds the key is created readable by you only (on Linux and macOS).

## The local server

- It binds to `127.0.0.1` by default, so it isn't reachable from the network. `--host 0.0.0.0`
  exposes it and prints a warning; for a remote machine, use an SSH tunnel instead (the
  [VPS installer](../README.md#ubuntu-vps-one-command) sets it up that way).
- **Endpoints with side effects** (stop, update, every toggle) are POST-only,
  loopback-only, check the `Host` header, and require a custom `X-Pulse: 1` header, so web
  pages you visit can't trigger them.
- **Data reads** check the `Host` header too on a loopback bind, which blocks
  DNS-rebinding attacks.
- The dashboard is served from the same process, with no third-party scripts.

## Visible to others by design

- **Discord Rich Presence** shows your usage (and, unless you turn it off, your model,
  effort and session count) to anyone who can see your Discord profile. It's off by default.
- An `https://` image link in a Discord slot is visible to anyone who can see your presence.
