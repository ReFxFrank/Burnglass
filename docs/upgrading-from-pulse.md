# Upgrading from Pulse

Pulse 1.x becomes Burnglass 2.0 in place: what changes, what's kept, and where your settings go.

[← Back to the README](../README.md) · [All docs](README.md)

---

Click **Update now** in Pulse's Server panel, or run `BurnglassSetup.exe` over a Pulse
install, and everything carries over. There's nothing to redo.

| What | What happens |
| --- | --- |
| **Settings and history** | The first time the v2 server starts, it copies `config.json` (with your budget and plan cost), the history archive, the Meshy task cache, the effort sidecar, the Discord timer and the strip state from `~/.pulse` into `~/.burnglass`. The copy runs only once the new server owns its port (a v2 that can't start while v1 still runs copies nothing), is staged in a temporary folder and published in one step. A `migrated-from-pulse.json` marker records what was copied, and the dashboard shows a one-time notice with both paths. |
| **`~/.pulse`** | Kept as a backup. Nothing in it is moved or deleted. After the copy Burnglass writes there only to keep older companions working (it mirrors `server.json` and refreshes `tray.ps1`), and it removes your Meshy API key from the old `config.json`. History that an older Pulse copy seals there later is still read (the new folder wins a tie). If the copy fails, for example because of a locked file, Burnglass keeps using `~/.pulse`, says so on the dashboard, and retries at the next start. Folder and file permissions carry over. |
| **The executable** | A one-click update keeps the file's name and path: a self-updated `pulse.exe` is still called `pulse.exe` and now runs Burnglass. The installer keeps `%LOCALAPPDATA%\Programs\Pulse` (including installs made with `pulse.exe --install`), installs `burnglass.exe` there and keeps an identical `pulse.exe` beside it, which later updates refresh too. |
| **Claude Code status line and effort hook** | They keep working, because the path they point at stays valid. If one of them ever points at a file that no longer exists, the dashboard, the server log and `--statusline-setup` / `--effort-setup` say so. Burnglass never edits `~/.claude`; re-run the setup command and paste the new snippet. |
| **Start with Windows** | The sign-in entry keeps its value name `Pulse`, so the dashboard toggle, the installer and `--install` share one entry and never start two copies. The installer points it at `burnglass.exe`. |
| **Burnglass Strip** | On Windows, the first start after the one-click update replaces a `pulse-strip.exe` next to the exe with the new strip, under the same file name (unless the update check is off or `stripPath` is set). A strip that exists only in `~/.pulse/bin` gets a fresh copy in `~/.burnglass/bin` instead. The taskbar numbers now show **% used**, so they count up where Pulse counted down. See the [Windows guide](windows.md#burnglass-strip). |
| **Environment variables** | Every `PULSE_*` variable also answers to `BURNGLASS_*`, which wins when both are set. `BURNGLASS_HOME` (or `PULSE_HOME`) pins the home folder; a pinned folder is used as-is and never migrated. |
| **Browser, API and ports** | Port 4747, every CLI flag, the `/api` routes and response shapes, the `X-Pulse: 1` request header and your saved browser preferences are unchanged. The log file is now `burnglass.log`. |
| **Discord** | The same application and client id, renamed to Burnglass, with new art behind the same `pulse` art key. The button now says *Get Burnglass*. |

## Good to know

- **Dotfile managers:** if you sync `~/.pulse` with a dotfile manager (a symlink), set
  `BURNGLASS_HOME` to the link's target instead of relying on the copy. If `~/.pulse` and
  `~/.burnglass` are links to the same folder, Burnglass treats them as one.
- **PulseAudio:** a `~/.pulse` that Pulse never wrote (PulseAudio uses the same name) is
  not copied, written to or reported.
- **Running a Pulse 1.x exe** while Burnglass is running just opens the dashboard; there's
  no downgrade. Run on its own, Pulse 1.x keeps using `~/.pulse` and is offered the
  Burnglass update.
- **Linux and macOS:** a one-click update replaces the binary in place, with its name
  kept (`pulse-linux` / `pulse-macos` stay so named).
- **Ubuntu VPS:** re-running `install.sh` updates a server first installed as Pulse. It
  keeps its `~/pulse` checkout and its `pulse.service` name, so use
  `sudo systemctl status|restart pulse` and `journalctl -u pulse -f` there.

## Release assets

Every 2.x release carries `burnglass.exe`, `burnglass-linux`, `burnglass-macos`,
`burnglass-strip.exe` and `BurnglassSetup.exe`, plus byte-identical `pulse.exe`,
`pulse-linux`, `pulse-macos` and `pulse-strip.exe`, so Pulse 1.x installs can update in
one click. New installs should take the `burnglass-*` names. The GitHub repository moved
to `ReFxFrank/Burnglass`; old links redirect.

Everything else that changed in 2.0.0: [CHANGELOG.md](../CHANGELOG.md).
