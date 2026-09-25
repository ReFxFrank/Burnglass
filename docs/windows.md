# Windows guide

The installer, the portable exe, starting with Windows, the tray icon and Burnglass Strip.

[← Back to the README](../README.md) · [All docs](README.md)

---

Burnglass runs on 64-bit (x64) Windows 10 and 11. Nothing on
this page needs admin rights: every option is per-user.

## Installer

`BurnglassSetup.exe` from the [latest release](https://github.com/ReFxFrank/Burnglass/releases/latest)
installs per-user to `%LOCALAPPDATA%\Programs\Burnglass`, with no UAC prompt. It adds:

- **Burnglass** and **Burnglass - Stop** in the Start Menu, and optionally on the Desktop
  (ticked by default). Starting Burnglass while it runs just opens the dashboard.
- An **Add/Remove Programs** entry.
- Two opt-in boxes, unticked by default: **Start Burnglass when I sign in** and
  **Include Burnglass Strip**. Installing the strip only puts it in place; switch it on
  in **System** when you want it.

Running a newer installer over an existing install upgrades it in place, and it stops the
running Burnglass (and any strip started from that folder) first.

**Over a Pulse install**, the installer keeps that install's folder
(`%LOCALAPPDATA%\Programs\Pulse`, including installs made with `pulse.exe --install`),
installs `burnglass.exe` there and keeps an identical `pulse.exe` beside it, because
your status line, hooks, pins and the sign-in entry may point at the old name. It replaces
the Pulse shortcuts and Add/Remove Programs entry with Burnglass ones and points the
sign-in entry at `burnglass.exe`. See [Upgrading from Pulse](upgrading-from-pulse.md).

**Uninstalling** removes the program folder, shortcuts, the Add/Remove Programs entry and
the sign-in entry (only when it points into that folder). It **keeps `~/.burnglass`**
(config, budget, plan cost, history) and `~/.pulse`.

## Portable exe

Put `burnglass.exe` in a permanent folder and double-click it. Burnglass starts in the
background (no console window) and opens `http://localhost:4747`.

- Double-clicking again while it runs just opens the dashboard.
- `burnglass.exe --stop` (or **Stop** in the dashboard) stops it.
- `burnglass.exe --install-shortcuts` adds **Burnglass** and **Burnglass - Stop**
  shortcuts to your Desktop.
- `--no-open` starts it without a browser; `--no-daemon` keeps it in the console window.
- The log is `~/.burnglass/burnglass.log`, and **System** shows its latest lines.
- The binaries are unsigned, so SmartScreen may warn the first time: click
  **More info → Run anyway**.

### Install from the portable exe

`burnglass.exe --install` does the installer's job from a terminal: it copies the exe to
`%LOCALAPPDATA%\Programs\Burnglass` (or to the folder the installer or an earlier Pulse
install already uses), adds Start Menu and Desktop shortcuts and an Add/Remove Programs
entry. `burnglass.exe --uninstall` undoes that, along with the sign-in entry.

Both only touch shortcuts, sign-in entries and Add/Remove Programs entries that point into
their own folder, and both refuse a folder the installer manages (use Add/Remove Programs
for that one). Your `~/.burnglass` folder is kept.

## Updates

**System** shows when a release is out; **Update** downloads the release's exe, checks
its sha256 digest against GitHub, swaps it in with rollback if anything fails, restarts
and reloads your page on the new version. The exe keeps its file name and path, so
shortcuts, the sign-in entry and your Claude Code status line keep working. When the
install folder also holds the `pulse.exe` twin, the twin is refreshed too. (Run from a
source checkout, **System** links to the release instead.)

Burnglass checks GitHub's latest regular release, so a release candidate you're running
is offered the final release, and only a newer version is ever installed, never an older
one. If a release has no published sha256 digest for your file, **System** links to the
release page instead of installing it. The Linux and macOS binaries update the same way.

`--no-update-check` or `{"updateCheck": false}` turns the check off.

## Start with Windows

Opt-in, from the **Start with Windows** toggle in **System**, the installer's box, or:

```bat
burnglass.exe --startup on
burnglass.exe --startup off
burnglass.exe --startup status
```

It writes one per-user value named `Pulse` under
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` that starts the server with
`--no-open`, so nothing pops up at sign-in. The value keeps its Pulse-era name on
purpose: the toggle, the installer and `--install` share this one entry, so you never get
two copies starting. Remove it from the same toggle or from Task Manager's Startup tab.

## Tray icon

<img src="../.github/assets/tray.png" alt="The four tray icon states: idle or no data, OK below the first threshold, a yellow ring at 80 percent and a red barred disc at 95 percent, with the real icons at taskbar size" width="790" />

An opt-in notification-area icon: the **Tray icon** toggle in **System**, `--tray`, or
`{"tray": true}`.

**The icon** is the Burnglass mark with a status for your Claude 5-hour window. Shape
carries the state, so it reads without colour:

| Icon | Meaning |
| --- | --- |
| Ice dot | At rest: account meters off, not logged in, a stale reading, or still loading |
| Solid green dot | Below your first alert threshold |
| Yellow ring | From your first threshold (80% by default) |
| Red disc with a white bar | From your second threshold (95% by default) |

The levels follow your `alertThresholds`, like the dashboard. The status needs
[account meters](limits-and-budgets.md#account-meters) on; without them the icon stays
at rest. Crisp icons are drawn for 16, 20, 24 and 32 px and picked for your display
scaling. The percentage is in the tooltip, never painted on the icon.

**Using it:**

- The **tooltip** shows today's spend and your 5-hour and weekly %.
- **Left-click** opens the mini view in its own app window.
- **Right-click** offers *Open dashboard*, *Open mini overview*, *Stop Burnglass* and
  *Exit tray*.
- Windows hides new tray icons behind the `^` chevron; drag Burnglass out once to pin it.
- With the tray on, account meters refresh at most every 5 minutes when the dashboard
  isn't open (15 otherwise), so the icon stays current.
- The icon closes together with Burnglass (Stop or an update), and turning the toggle off
  removes it within about 30 seconds. It only runs beside a server bound to `127.0.0.1`.

### When the icon doesn't appear

The **Tray icon** row in **System** says what's going on: *Icon running*, *Starting…*,
*Checking…*, *No check-in* or *Not running*. When the icon couldn't start, the row shows
the exit code, PowerShell's own message and a hint for the likely cause, and offers
**Retry**. Common causes:

- A **Group Policy** blocks PowerShell scripts on the PC, so the icon can't run there.
- An **antivirus** blocked `tray.ps1`; allow it, then Retry.
- PowerShell runs in **Constrained Language mode** (an AppLocker or WDAC policy).
- Another tray process holds the icon but isn't answering; end the `powershell.exe`
  running `tray.ps1` in Task Manager, then Retry.
- It couldn't reach the server on `127.0.0.1`.

The tray's own output goes to `~/.burnglass/tray-error.log`, and `burnglass.log` gets a
line saying how it ended. An unexpected error inside the tray is logged and the tray
closes quietly instead of showing an error dialog.

## Burnglass Strip

<table>
  <tr>
    <td align="center"><img src="../.github/assets/strip-open.gif" alt="Animation: the Burnglass Strip on the Windows taskbar, showing Claude and Codex percent used, is clicked and its popover rises into place" width="408" /></td>
    <td align="center"><img src="../.github/assets/strip-popover.png" alt="The Burnglass Strip popover: total spend donut by source, Claude and Codex limits as percent-used bars, spend rows and daily trend bars" width="372" /></td>
  </tr>
</table>

Your usage right on the taskbar: a slim transparent strip with each provider's **% used**,
alternating with its 30-day spend. The numbers turn amber at your first alert threshold
and red at the last (80% / 95% by default). Drag it where you like; the position is
remembered.

**The popover** (click the strip) is the dashboard in miniature: *% used* limit bars with
threshold ticks, the projection at reset (*→ N% at reset*) and reset countdowns; a total
spend donut by source in the dashboard's colours and labels (your custom-source labels
too; more than six sources show as the top five plus *Other*) for Today, 7 Days or
30 Days; and per-provider spend rows with daily trend bars, today in the accent colour.
It opens like a Windows 11 flyout, rising into place with its data already filled in,
and simply appears when Windows' *Animation effects* are off. **Open dashboard** at the
bottom opens the full page. Right-click the strip for *Open dashboard*, *Quick view*,
*Refresh*, *Reset strip position* and *Quit strip*.

The strip reads everything from your local Burnglass server, so its numbers match the
dashboard. It's a separate small program (C# and WebView2); the Burnglass server itself
still has zero runtime dependencies.

### Set it up

1. Get `burnglass-strip.exe`: tick **Include Burnglass Strip** in the installer, or
   download it from the release and put it next to `burnglass.exe` (or in
   `~/.burnglass/bin`).
2. Switch **Burnglass Strip** on in **System** (`{"strip": true}`). Burnglass starts it
   now and every time Burnglass starts.
3. To turn it off, switch it off again; the strip closes itself.

Burnglass looks for the strip next to its own exe (`burnglass-strip.exe`, then an older
`pulse-strip.exe`), then in `~/.burnglass/bin`, then in `~/.pulse/bin`. `stripPath`
points it at a copy anywhere else.

### Updates

A one-click update of Burnglass updates the strip too. On the first start after the
update, Burnglass checks the strip next to its exe and in `~/.burnglass/bin` against the
**same release**. A file that differs is replaced from one download of the release's
strip, checked for size and sha256 (no published checksum, no replacement), under its own
file name; the old file is kept as `.old` until the next start. If Burnglass started the
strip for you, it closes the old one and starts the new one once.

- A strip found only in `~/.pulse/bin` is left alone; a current copy goes into
  `~/.burnglass/bin` and is used from then on.
- A failed strip update is retried at the next start and, while Burnglass keeps running,
  after 30 minutes (doubling, at most five attempts per version). **System** shows the
  failure and when it will try again, then a link to the release.
- Nothing happens with `--no-update-check` / `{"updateCheck": false}`, or when
  `stripPath` points at your own strip.

### Good to know

- The strip's *Last 7 Days* covers 7 calendar days, while the dashboard's uses a rolling
  168 hours, so the two can differ slightly.
- The popover's spend donut lists custom sources under their own labels, but its
  per-provider cards and the taskbar's Claude price still count custom sources as Claude.
- The strip keeps its files in `~/.burnglass` (`strip.json`, cached data, the unpacked
  popover in `strip-web/` and a WebView2 profile in `webview-strip/`).

Burnglass Strip is ported from
[openusage-windows](https://github.com/CheesyPoofs346/openusage-windows) (MIT, see
[`strip/LICENSE-openusage`](../strip/LICENSE-openusage)). Credit where due: their strip
design is excellent.
