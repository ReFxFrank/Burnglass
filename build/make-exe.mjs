#!/usr/bin/env node
/*
 * Build a single-file Burnglass executable using Node's Single Executable
 * Application (SEA) support.
 *
 *   node build/make-exe.mjs   → dist-exe/burnglass.exe (win) / burnglass-linux / burnglass-macos
 *
 * Legacy names: Pulse ≤ 1.34 self-updaters look for EXACTLY pulse.exe /
 * pulse-linux / pulse-macos in the latest release. The release workflow
 * publishes a byte-identical copy of each binary under that old name (and
 * cmp-checks the pair) — that copy is made in CI, not here, so this script
 * has exactly one output per platform.
 *
 * How it works:
 *   1. server.js is already a single zero-dependency CommonJS file — SEA can
 *      take it as-is, no bundler.
 *   2. The built frontend (web/dist/**) is embedded as SEA assets keyed
 *      "web/dist/<relpath>"; server.js reads them via node:sea at runtime.
 *   3. The blob is injected into a copy of THIS build machine's node binary
 *      (so run this script on the OS you're targeting — the release workflow
 *      runs it on a Windows runner for burnglass.exe).
 *   4. Windows only, BEFORE the injection: the copied node.exe is stamped with
 *      the Burnglass icon (build/brand/burnglass.ico) and a Burnglass version
 *      resource, through kernel32's UpdateResource driven from powershell.exe.
 *      Both are Windows builtins, so this adds no dependency. It is
 *      best-effort: if stamping fails, or the stamped binary then fails its own
 *      `--version` self-check, the exe is rebuilt from a clean node.exe (plain
 *      Node icon) and the build says so. BURNGLASS_EXE_ICON=0 skips it.
 *      Order matters: stamping AFTER postject would rewrite the resource
 *      section that holds the injected NODE_SEA_BLOB.
 *
 * Requires Node >= 20 (SEA assets). Uses npx postject for injection.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(root, 'build');
const outDir = path.join(root, 'dist-exe');
const webDist = path.join(root, 'web', 'dist');
const ICON_FILE = path.join(buildDir, 'brand', 'burnglass.ico');

function log(msg) { console.log('[make-exe] ' + msg); }
function warn(msg) {
  console.warn('[make-exe] WARNING: ' + msg);
  // Surface it on the Actions run summary too, not just deep in the log.
  if (process.env.GITHUB_ACTIONS) console.log('::warning title=make-exe::' + msg.replace(/\r?\n/g, ' '));
}
function die(msg) { console.error('[make-exe] ERROR: ' + msg); process.exit(1); }

// ---- output names -----------------------------------------------------------
export const OUT_NAMES = Object.freeze({ win32: 'burnglass.exe', darwin: 'burnglass-macos', linux: 'burnglass-linux' });
export function outNameFor(plat) { return OUT_NAMES[plat] || OUT_NAMES.linux; }

// ---- Windows resources (pure helpers; unit-testable anywhere) ----------------

// 2.0.0-rc.1 → [2, 0, 0, 0]. Windows version fields are four 16-bit numbers;
// a prerelease suffix only survives in the string fields.
export function numericVersion(v) {
  const core = String(v).split(/[-+]/)[0];
  const parts = core.split('.').map((x) => {
    const n = parseInt(x, 10);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, 0xffff) : 0;
  });
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4);
}

// An .ico file → the RT_ICON payloads (one per image, ids firstId..) plus the
// RT_GROUP_ICON directory that points at them. An ICONDIRENTRY is 16 bytes
// (ending in a DWORD file offset); a GRPICONDIRENTRY is 14 (ending in a WORD
// resource id). PNG-compressed images go into RT_ICON verbatim (Vista+).
export function icoToResources(buf, firstId = 1) {
  if (!Buffer.isBuffer(buf) || buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    throw new Error('not an .ico file');
  }
  const count = buf.readUInt16LE(4);
  if (!count || buf.length < 6 + 16 * count) throw new Error('truncated .ico directory');
  if (firstId < 1 || firstId + count - 1 > 0xffff) throw new Error('icon ids out of range');
  const group = Buffer.alloc(6 + 14 * count);
  group.writeUInt16LE(0, 0);      // reserved
  group.writeUInt16LE(1, 2);      // type: icon
  group.writeUInt16LE(count, 4);
  const images = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + 16 * i;
    const bytes = buf.readUInt32LE(e + 8);
    const off = buf.readUInt32LE(e + 12);
    if (!bytes || off < 6 + 16 * count || off + bytes > buf.length) throw new Error(`.ico entry ${i} is out of range`);
    const img = buf.subarray(off, off + bytes);
    const png = img.length >= 8 && img.readUInt32BE(0) === 0x89504e47;
    let planes = buf.readUInt16LE(e + 4);
    let bits = buf.readUInt16LE(e + 6);
    // Some encoders leave planes/bitcount 0; Windows uses them to pick the
    // best image, so fill them in (from the BITMAPINFOHEADER for DIB images).
    if (!planes) planes = 1;
    if (!bits) bits = png ? 32 : (img.length >= 16 && img.readUInt32LE(0) === 40 ? img.readUInt16LE(14) : 0);
    const g = 6 + 14 * i;
    buf.copy(group, g, e, e + 4);   // bWidth, bHeight, bColorCount, bReserved
    group.writeUInt16LE(planes, g + 4);
    group.writeUInt16LE(bits, g + 6);
    group.writeUInt32LE(bytes, g + 8);
    group.writeUInt16LE(firstId + i, g + 12);
    images.push({ id: firstId + i, data: Buffer.from(img) });
  }
  return { group, images };
}

// One VS_VERSIONINFO-family node: WORD wLength, WORD wValueLength, WORD wType,
// WCHAR szKey[], padding to a DWORD, Value, padding, Children. wLength never
// counts trailing padding; the parent pads between children. Text values count
// wValueLength in WCHARs including the terminator; binary ones in bytes. This
// reproduces node.exe's own resource byte-for-byte (checked when this was written).
function vsNode(key, value, { text = false, children = [] } = {}) {
  const header = Buffer.alloc(6);
  const parts = [header, Buffer.from(key + '\0', 'utf16le')];
  let len = 6 + parts[1].length;
  const align = () => {
    const p = ((len + 3) & ~3) - len;
    if (p) { parts.push(Buffer.alloc(p)); len += p; }
  };
  let valueLength = 0;
  if (value && value.length) {
    align();
    parts.push(value);
    len += value.length;
    valueLength = text ? value.length / 2 : value.length;
  }
  for (const child of children) { align(); parts.push(child); len += child.length; }
  if (len > 0xffff) throw new Error('version resource node too large: ' + key);
  header.writeUInt16LE(len, 0);
  header.writeUInt16LE(valueLength, 2);
  header.writeUInt16LE(text ? 1 : 0, 4);
  return Buffer.concat(parts);
}

// The RT_VERSION payload: VS_FIXEDFILEINFO + a 0409/1200 (en-US, Unicode)
// StringFileInfo table + the matching VarFileInfo\Translation.
export function versionResource(version, strings) {
  const [a, b, c, d] = numericVersion(version);
  const ms = ((a << 16) | b) >>> 0;
  const ls = ((c << 16) | d) >>> 0;
  const ffi = Buffer.alloc(52);
  ffi.writeUInt32LE(0xfeef04bd, 0);                         // dwSignature
  ffi.writeUInt32LE(0x00010000, 4);                         // dwStrucVersion
  ffi.writeUInt32LE(ms, 8); ffi.writeUInt32LE(ls, 12);      // file version
  ffi.writeUInt32LE(ms, 16); ffi.writeUInt32LE(ls, 20);     // product version
  ffi.writeUInt32LE(0x3f, 24);                              // dwFileFlagsMask
  ffi.writeUInt32LE(/[-+]/.test(String(version)) ? 0x2 : 0, 28); // VS_FF_PRERELEASE for -rc builds
  ffi.writeUInt32LE(0x00040004, 32);                        // VOS_NT_WINDOWS32
  ffi.writeUInt32LE(0x1, 36);                               // VFT_APP
  // subtype + file date stay 0
  const rows = Object.entries(strings).map(([k, v]) =>
    vsNode(k, Buffer.from(String(v) + '\0', 'utf16le'), { text: true }));
  const table = vsNode('040904b0', null, { text: true, children: rows });
  const sfi = vsNode('StringFileInfo', null, { text: true, children: [table] });
  const translation = Buffer.alloc(4);
  translation.writeUInt16LE(0x0409, 0);   // en-US
  translation.writeUInt16LE(0x04b0, 2);   // 1200 = Unicode
  const vfi = vsNode('VarFileInfo', null, { text: true, children: [vsNode('Translation', translation)] });
  return vsNode('VS_VERSION_INFO', ffi, { children: [sfi, vfi] });
}

export function burnglassVersionStrings(version, exeName) {
  return {
    CompanyName: 'ReFxFrank',
    FileDescription: 'Burnglass',
    FileVersion: version,
    InternalName: 'burnglass',
    LegalCopyright: 'Copyright (c) 2026 ReFxFrank. MIT license. Built on Node.js (Copyright Node.js contributors, MIT license).',
    OriginalFilename: exeName,
    ProductName: 'Burnglass',
    ProductVersion: version,
  };
}

// The resource writer. Windows PowerShell 5.1 compiles this with the .NET
// Framework C# compiler (C# 5): no string interpolation, no => members.
// It REPLACES the icon group(s) and version resource(s) already in node.exe
// under their own ids and languages (node ships RT_GROUP_ICON 1 / RT_VERSION 1,
// lang 1033), and writes the images as RT_ICON 1..N in the same language —
// overwriting node's own icon images, so no orphans are left for N >= 6.
const STAMP_PS1 = String.raw`param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Dir,
  [Parameter(Mandatory = $true)][int]$Icons
)
$ErrorActionPreference = 'Stop'
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class BurnglassStamp
{
    const int RT_ICON = 3;
    const int RT_GROUP_ICON = 14;
    const int RT_VERSION = 16;
    const uint LOAD_LIBRARY_AS_DATAFILE = 0x2;
    const uint LOAD_LIBRARY_AS_IMAGE_RESOURCE = 0x20;

    delegate bool EnumNameProc(IntPtr module, IntPtr type, IntPtr name, IntPtr param);
    delegate bool EnumLangProc(IntPtr module, IntPtr type, IntPtr name, ushort lang, IntPtr param);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumNameProc proc, IntPtr param);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, EnumLangProc proc, IntPtr param);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr BeginUpdateResource(string path, bool deleteExisting);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort lang, byte[] data, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool EndUpdateResource(IntPtr update, bool discard);

    // (id, language) of every integer-named resource of this type in the file.
    static List<KeyValuePair<ushort, ushort>> Existing(string exe, int type)
    {
        List<KeyValuePair<ushort, ushort>> found = new List<KeyValuePair<ushort, ushort>>();
        IntPtr module = LoadLibraryEx(exe, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE);
        if (module == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "LoadLibraryEx " + exe);
        try
        {
            EnumLangProc onLang = delegate(IntPtr m, IntPtr t, IntPtr n, ushort lang, IntPtr p)
            {
                found.Add(new KeyValuePair<ushort, ushort>((ushort)n.ToInt64(), lang));
                return true;
            };
            EnumNameProc onName = delegate(IntPtr m, IntPtr t, IntPtr n, IntPtr p)
            {
                if ((n.ToInt64() >> 16) == 0) EnumResourceLanguages(m, t, n, onLang, IntPtr.Zero);
                return true;
            };
            EnumResourceNames(module, new IntPtr(type), onName, IntPtr.Zero);
            GC.KeepAlive(onLang);
            GC.KeepAlive(onName);
        }
        finally
        {
            FreeLibrary(module);
        }
        return found;
    }

    static void Put(IntPtr update, int type, int name, ushort lang, byte[] data)
    {
        if (!UpdateResource(update, new IntPtr(type), new IntPtr(name), lang, data, (uint)data.Length))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "UpdateResource " + type + "/" + name + "/" + lang);
    }

    static void Write(string exe, byte[] group, List<byte[]> images, byte[] version,
        List<KeyValuePair<ushort, ushort>> groups, List<KeyValuePair<ushort, ushort>> versions)
    {
        IntPtr update = BeginUpdateResource(exe, false);
        if (update == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "BeginUpdateResource");
        bool ok = false;
        try
        {
            List<ushort> langs = new List<ushort>();
            foreach (KeyValuePair<ushort, ushort> g in groups) if (!langs.Contains(g.Value)) langs.Add(g.Value);
            foreach (ushort lang in langs)
                for (int i = 0; i < images.Count; i++) Put(update, RT_ICON, i + 1, lang, images[i]);
            foreach (KeyValuePair<ushort, ushort> g in groups) Put(update, RT_GROUP_ICON, g.Key, g.Value, group);
            foreach (KeyValuePair<ushort, ushort> v in versions) Put(update, RT_VERSION, v.Key, v.Value, version);
            ok = true;
        }
        finally
        {
            // Discard on any failure; only a failed COMMIT is reported from here.
            if (!EndUpdateResource(update, !ok) && ok)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "EndUpdateResource");
        }
    }

    public static void Apply(string exe, string dir, int icons)
    {
        byte[] group = File.ReadAllBytes(Path.Combine(dir, "group.bin"));
        byte[] version = File.ReadAllBytes(Path.Combine(dir, "version.bin"));
        List<byte[]> images = new List<byte[]>();
        for (int i = 1; i <= icons; i++) images.Add(File.ReadAllBytes(Path.Combine(dir, "icon-" + i + ".bin")));

        List<KeyValuePair<ushort, ushort>> groups = Existing(exe, RT_GROUP_ICON);
        if (groups.Count == 0) groups.Add(new KeyValuePair<ushort, ushort>(1, 1033));
        List<KeyValuePair<ushort, ushort>> versions = Existing(exe, RT_VERSION);
        if (versions.Count == 0) versions.Add(new KeyValuePair<ushort, ushort>(1, 1033));

        // A freshly copied exe is routinely held for a moment by the antivirus
        // scanner, which fails BeginUpdateResource/EndUpdateResource; retry.
        Exception last = null;
        for (int attempt = 1; attempt <= 5; attempt++)
        {
            try { Write(exe, group, images, version, groups, versions); return; }
            catch (Exception e) { last = e; Thread.Sleep(500 * attempt); }
        }
        throw last;
    }
}
'@
[BurnglassStamp]::Apply($Exe, $Dir, $Icons)
Write-Output ('[make-exe] stamped icon + version resource into ' + $Exe)
`;

function stampWindowsResources(exePath, version) {
  const { group, images } = icoToResources(fs.readFileSync(ICON_FILE), 1);
  const ver = versionResource(version, burnglassVersionStrings(version, OUT_NAMES.win32));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burnglass-res-'));
  try {
    fs.writeFileSync(path.join(dir, 'group.bin'), group);
    for (const im of images) fs.writeFileSync(path.join(dir, `icon-${im.id}.bin`), im.data);
    fs.writeFileSync(path.join(dir, 'version.bin'), ver);
    const script = path.join(dir, 'stamp.ps1');
    fs.writeFileSync(script, STAMP_PS1);
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-Exe', exePath, '-Dir', dir, '-Icons', String(images.length),
    ], { stdio: 'inherit', windowsHide: true, timeout: 180000 });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* temp dir only */ }
  }
}

// Run the finished binary once. `--version` returns before any server work,
// and must print the package version whatever the brand text around it is.
function versionSelfCheck(exePath, version) {
  try {
    const out = execFileSync(exePath, ['--version'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    return String(out).includes(version);
  } catch (_) {
    return false;
  }
}

function main() {
  // 0. sanity
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 20) die(`Node >= 20 required for SEA assets (running ${process.version})`);
  if (!fs.existsSync(path.join(webDist, 'index.html'))) {
    die('web/dist not built. Run `npm run build` first.');
  }
  // The self-updater compares the server's version constant against release
  // tags — a drift between package.json and server.js would ship a binary that
  // mis-reports itself, so fail the build loudly. The constant is
  // BURNGLASS_VERSION from 2.0.0 on (PULSE_VERSION before); accept either.
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  {
    const m = /const (?:BURNGLASS|PULSE)_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(root, 'server.js'), 'utf8'));
    if (!m) die('BURNGLASS_VERSION (or PULSE_VERSION) constant not found in server.js');
    if (m[1] !== pkgVersion) die(`version drift: package.json ${pkgVersion} != server.js ${m[1]}`);
    log(`version ${pkgVersion} (package.json == server.js)`);
  }

  // 1. collect frontend assets
  const assets = {};
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else {
        // keys use forward slashes on every platform
        const rel = path.relative(root, full).split(path.sep).join('/');
        assets[rel] = full;
      }
    }
  })(webDist);
  log(`embedding ${Object.keys(assets).length} frontend asset(s)`);

  // 2. sea-config + blob
  const seaConfig = {
    main: path.join(root, 'server.js'),
    output: path.join(buildDir, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useCodeCache: false, // keep the blob portable and deterministic
    assets,
  };
  const cfgPath = path.join(buildDir, 'sea-config.json');
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(seaConfig, null, 2));
  log('generating SEA blob…');
  execFileSync(process.execPath, ['--experimental-sea-config', cfgPath], { stdio: 'inherit' });

  // 3. copy this platform's node binary, (Windows) stamp it, inject
  const plat = process.platform;
  const outPath = path.join(outDir, outNameFor(plat));
  fs.mkdirSync(outDir, { recursive: true });

  const wantStamp = plat === 'win32' && process.env.BURNGLASS_EXE_ICON !== '0';
  if (wantStamp && !fs.existsSync(ICON_FILE)) warn('build/brand/burnglass.ico is missing; the exe keeps the Node.js icon');

  const assemble = (stamp) => {
    fs.copyFileSync(process.execPath, outPath);
    fs.chmodSync(outPath, 0o755);
    let stamped = false;
    if (stamp) {
      try {
        stampWindowsResources(outPath, pkgVersion);
        stamped = true;
      } catch (e) {
        warn('could not stamp the Burnglass icon/version into the exe (' + ((e && e.message) || e) +
          '); it keeps the Node.js icon. The installer shortcuts still use burnglass.ico.');
        fs.copyFileSync(process.execPath, outPath); // never inject into a half-written file
        fs.chmodSync(outPath, 0o755);
      }
    }
    log('injecting blob with postject…');
    const postjectArgs = [
      'postject', outPath, 'NODE_SEA_BLOB', seaConfig.output,
      '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ];
    if (plat === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
    execFileSync(plat === 'win32' ? 'npx.cmd' : 'npx', ['--yes', ...postjectArgs], {
      stdio: 'inherit',
      shell: plat === 'win32',
    });
    return stamped;
  };

  // A stamped exe gets two chances to prove itself — postject must accept it,
  // and the result must run — before we fall back to the plain Node.js icon.
  let stamped = false;
  try {
    stamped = assemble(wantStamp && fs.existsSync(ICON_FILE));
  } catch (e) {
    if (!wantStamp) throw e;
    warn('the build failed after stamping the exe (' + ((e && e.message) || e) + '); rebuilding it without the icon');
    assemble(false);
  }
  if (stamped) {
    if (versionSelfCheck(outPath, pkgVersion)) {
      log('stamped exe passed its --version self-check');
    } else {
      warn('the icon-stamped exe failed its --version self-check; rebuilding it without the icon');
      assemble(false);
      if (!versionSelfCheck(outPath, pkgVersion)) die('the rebuilt exe also fails `--version` — the SEA build itself is broken');
    }
  }

  const mb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
  log(`done → ${path.relative(root, outPath)} (${mb} MB)`);
  log('smoke test:  ' + outPath + ' --help');
}

// Importing this module (e.g. to unit-test the resource builders) must not
// start a build: set MAKE_EXE_NO_MAIN=1 for that.
if (!process.env.MAKE_EXE_NO_MAIN) main();
