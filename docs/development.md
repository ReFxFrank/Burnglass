# Development

Running Burnglass from source, building the frontend and executables, running the tests, and finding your way around the repository.

[← Back to the README](../README.md) · [All docs](README.md)

---

## Run from source

Node ≥ 18, with zero runtime dependencies. The built frontend (`web/dist`) is committed,
so a clone runs as-is:

```sh
git clone https://github.com/ReFxFrank/Burnglass && cd Burnglass
node server.js          # → http://localhost:4747
```

From source, the **System** section links to new releases instead of updating in place,
and `--statusline-setup` / `--effort-setup` print a command that runs `server.js` with
your `node`.

## Build

| Command | What it does |
| --- | --- |
| `npm run build` | Installs the frontend's build tools and rebuilds `web/dist` (Node ≥ 20). |
| `npm run dev` | Runs Vite with hot reload for work on `web/`. |
| `node build/make-exe.mjs` | Packages a single-file executable for your OS (Node SEA) into `dist-exe/`. On Windows it also stamps the Burnglass icon and version into the exe. |

The server must stay dependency-free: it uses Node built-ins only. The React toolchain
under `web/` is build-time only.

## Test

```sh
bash test/run-all.sh
```

Every suite runs end to end against the real server, with fixture homes in a temporary
folder and mock provider servers on localhost (`test/mocks/`). It needs only Node and
`curl`, and never touches real logins. See [`test/README.md`](../test/README.md).

## Repository layout

| Path | What it is |
| --- | --- |
| `server.js` | The whole backend: parsers, pricing, aggregation, meters, Discord, HTTP, updates, background mode. Zero runtime dependencies. |
| `web/` | The React frontend (Vite + React, no UI kit): `src/App.jsx` is the frame, `src/sections/` holds one file per dashboard section, `src/styles.css` the design tokens. The built output in `web/dist` is committed and served. |
| `strip/` | Burnglass Strip, the C# / WebView2 taskbar companion (build-time only; ported from openusage-windows, see `strip/LICENSE-openusage`). |
| `build/make-exe.mjs` · `build/installer.iss` · `build/brand/` | Single-executable packaging (Node SEA, Burnglass icon on Windows) · the Inno Setup script for `BurnglassSetup.exe` · the `.ico`. |
| `.github/workflows/release.yml` | Builds `burnglass.exe` / `burnglass-linux` / `burnglass-macos` (a 3-OS matrix) plus `burnglass-strip.exe` and `BurnglassSetup.exe`, adds the byte-identical `pulse-*` copies for Pulse 1.x updaters, and publishes a release (a tag with `-`, like `v2.0.0-rc.1`, publishes a prerelease). |
| `.github/assets/` | README and docs images: the logo, dashboard screenshots, strip, tray and terminal images, and the Discord GIFs in `discord/`. |
| `docs/` | These guides. |
| `test/` | End-to-end suites against the real server with fixture homes and mock providers. |
| `install.sh` · `burnglass.sh` · `burnglass.cmd` | The VPS installer and launchers (`pulse.sh` / `pulse.cmd` remain as shims). |

`CLAUDE.md` holds the detailed working notes for contributors and coding agents: hard
rules, the frozen compatibility names, a feature map of `server.js`, and the release
process.
