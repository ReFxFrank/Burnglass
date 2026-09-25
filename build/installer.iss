; Burnglass (formerly Pulse) - Inno Setup 6 script for BurnglassSetup.exe
;
; Wraps the same binaries the release already ships: dist-exe\burnglass.exe
; (required) and, when it was built, dist-strip\burnglass-strip.exe (the
; taskbar companion). Installs PER USER, no admin:
;   - an upgrade of a PulseSetup install stays in its folder (Inno's own
;     UsePreviousAppDir, keyed on the unchanged AppId);
;   - a folder made by `pulse.exe --install` (%LOCALAPPDATA%\Programs\Pulse,
;     which Inno has no record of) is reused too - see DefaultInstallDir;
;   - only a machine with neither gets %LOCALAPPDATA%\Programs\Burnglass.
; Upgrading a Pulse folder also refreshes a pulse.exe twin (identical bytes)
; next to burnglass.exe: Claude Code's status line / effort hook, pinned
; taskbar items and old Run values hold that absolute path, and Burnglass may
; never edit ~/.claude to re-point them.
;
; Build (from anywhere, after `node build/make-exe.mjs`):
;   iscc /DMyAppVersion=2.0.0 build\installer.iss
;   -> dist-installer\BurnglassSetup.exe
; CI also passes /DMyAppVersionNum (numeric) and /DMyAppURL (the repo URL).
;
; NOTE: the binaries are UNSIGNED. SmartScreen will warn on this installer
; (More info -> Run anyway). Nothing here claims otherwise.
;
; ASCII only, deliberately: Inno reads a .iss without a UTF-8 BOM in the system
; ANSI codepage, so non-ASCII text would render differently per machine.

#ifndef MyAppVersion
; Fallback so a bare `iscc build\installer.iss` (no define) still compiles,
; which is how you syntax-check this locally. CI always passes the real tag.
#define MyAppVersion "0.0.0"
#endif
; VersionInfoVersion must be numeric (a.b.c.d). A prerelease such as
; 2.0.0-rc.1 keeps its full string in AppVersion only.
#ifndef MyAppVersionNum
#if Pos("-", MyAppVersion) > 0
#define MyAppVersionNum Copy(MyAppVersion, 1, Pos("-", MyAppVersion) - 1)
#else
#define MyAppVersionNum MyAppVersion
#endif
#endif

#define MyAppName "Burnglass"
#define MyAppPublisher "ReFxFrank"
#ifndef MyAppURL
#define MyAppURL "https://github.com/ReFxFrank/Burnglass"
#endif
#define MyAppExe "burnglass.exe"
; The Pulse-era name of the same binary. Kept as a twin in upgraded folders.
#define LegacyExe "pulse.exe"
; The HKCU Run entry Burnglass also manages itself (Server panel toggle /
; `burnglass.exe --startup on|off`). Same key, same value name, same data
; shape, so the two paths stay interchangeable and overwrite each other.
; The value NAME is FROZEN as "Pulse" (it is invisible in Settings > Startup,
; which shows the exe): renaming it would leave two sign-in entries for anyone
; with an older copy, and a v1 uninstaller could not remove the new one.
#define RunKey "Software\Microsoft\Windows\CurrentVersion\Run"
#define RunValue "Pulse"
; Add/Remove Programs keys written by `--install` (v1: Pulse, v2: Burnglass).
; When this installer takes over that folder, its own {AppId}_is1 entry
; replaces them, so the app is listed once.
#define InstallKeyV1 "Software\Microsoft\Windows\CurrentVersion\Uninstall\Pulse"
#define InstallKeyV2 "Software\Microsoft\Windows\CurrentVersion\Uninstall\Burnglass"
; Anchor every source path to the script's own location rather than to the
; compiler's working directory, so `iscc build\installer.iss` works from any cwd.
#define RepoRoot SourcePath + "\.."

[Setup]
; AppId is the upgrade identity - NEVER change it, or existing installs stop
; being recognised as the same product and users end up with two copies.
; (It predates the rename; PulseSetup installs upgrade in place.)
AppId={{76C28179-9CBE-42EA-B9E6-7BE166115AD3}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases/latest
VersionInfoVersion={#MyAppVersionNum}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription=Burnglass Setup - local usage dashboard for AI coding agents
VersionInfoProductName={#MyAppName}

; Per-user install: no admin prompt anywhere, nothing written outside the
; user's own profile (plus the opt-in HKCU Run value below).
PrivilegesRequired=lowest
; Only consulted when Inno has no previous install of this AppId; see
; DefaultInstallDir in [Code].
DefaultDirName={code:DefaultInstallDir}
UsePreviousAppDir=yes
; Reusing an existing Pulse folder is the point, so don't warn about it.
DirExistsWarning=no
; No Start Menu group page - the shortcuts go straight into Programs, on the
; same paths `burnglass.exe --install` writes.
DisableProgramGroupPage=yes
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\burnglass.ico
#ifndef NoSetupIcon
SetupIconFile={#RepoRoot}\build\brand\burnglass.ico
#endif
LicenseFile={#RepoRoot}\LICENSE

; The shipped binaries are x64; x64compatible also covers arm64 Windows, which
; runs them under emulation. (x64compatible needs Inno 6.3+.)
ArchitecturesAllowed=x64compatible
MinVersion=10.0

SourceDir={#RepoRoot}
OutputDir=dist-installer
OutputBaseFilename=BurnglassSetup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

; The server holds its own exe open while it runs, so an upgrade would hit a
; locked file. We stop it ourselves in PrepareToInstall (which also runs in
; silent mode) instead of letting Restart Manager put a close-programs page in
; the way.
CloseApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

; Task NAMES are unchanged from PulseSetup so UsePreviousTasks carries each
; user's earlier ticks forward. Only the descriptions changed.
[Tasks]
Name: "desktopicon"; Description: "Create &desktop shortcuts (Burnglass and Burnglass - Stop)"; GroupDescription: "Shortcuts:"
; Startup is deliberately UNCHECKED: the Run key is the one thing Burnglass
; writes outside its own ~/.burnglass folder, so it only ever happens when the
; user asks for it here (or in the Server panel / `burnglass.exe --startup on`).
Name: "startup"; Description: "Start Burnglass when I sign in to Windows (server only, no browser popup)"; GroupDescription: "Options:"; Flags: unchecked
; Installing the strip binary only makes it available; it stays off until the
; user enables "Burnglass Strip" in the dashboard's Server panel.
Name: "strip"; Description: "Include Burnglass Strip, the taskbar strip companion (enable it later in the Server panel)"; GroupDescription: "Options:"; Flags: unchecked

[InstallDelete]
; The Pulse-era strip is superseded by burnglass-strip.exe (the server prefers
; the new name). Only when the new one is being installed; a running copy was
; stopped in PrepareToInstall, and a failed delete is harmless.
Type: files; Name: "{app}\pulse-strip.exe"; Tasks: strip

[Files]
Source: "dist-exe\burnglass.exe"; DestDir: "{app}"; Flags: ignoreversion
; The compat twin: the same binary under its Pulse name, only in a folder that
; already had pulse.exe (an upgrade). Inno stores the source once.
Source: "dist-exe\burnglass.exe"; DestDir: "{app}"; DestName: "{#LegacyExe}"; Flags: ignoreversion; Check: WantPulseTwin
; skipifsourcedoesntexist: a build machine without the .NET toolchain has no
; strip, and that must not break the installer build.
Source: "dist-strip\burnglass-strip.exe"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist; Tasks: strip
; Shortcut + Add/Remove Programs icon. A separate file on purpose: it shows the
; brand even if the exe itself was built without the stamped icon.
Source: "build\brand\burnglass.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "LICENSE"; DestDir: "{app}"; DestName: "LICENSE.txt"; Flags: ignoreversion
; Burnglass Strip is a port of openusage-windows (MIT); MIT requires the notice
; to travel with the binary, so it ships whenever the strip does.
Source: "strip\LICENSE-openusage"; DestDir: "{app}"; DestName: "LICENSE-openusage.txt"; Flags: ignoreversion skipifsourcedoesntexist; Tasks: strip

[Icons]
; Flat entries (no group folder) so they land on exactly the paths
; `burnglass.exe --install` / `--install-shortcuts` use: running either
; afterwards overwrites these instead of duplicating them. The old "Pulse" /
; "Pulse - Stop" shortcuts that pointed into this folder are removed in
; CurStepChanged.
; Launching burnglass.exe when a server is already up just opens the dashboard,
; so the "Burnglass" entry doubles as "open the dashboard"; a separate localhost
; shortcut would only be a duplicate that dead-ends whenever it is stopped.
Name: "{autoprograms}\Burnglass"; Filename: "{app}\{#MyAppExe}"; WorkingDir: "{app}"; IconFilename: "{app}\burnglass.ico"; Comment: "Start Burnglass (opens the dashboard if it is already running)"
Name: "{autoprograms}\Burnglass - Stop"; Filename: "{app}\{#MyAppExe}"; Parameters: "--stop"; WorkingDir: "{app}"; IconFilename: "{app}\burnglass.ico"; Comment: "Stop the running Burnglass server"
Name: "{autodesktop}\Burnglass"; Filename: "{app}\{#MyAppExe}"; WorkingDir: "{app}"; IconFilename: "{app}\burnglass.ico"; Comment: "Start Burnglass (opens the dashboard if it is already running)"; Tasks: desktopicon
Name: "{autodesktop}\Burnglass - Stop"; Filename: "{app}\{#MyAppExe}"; Parameters: "--stop"; WorkingDir: "{app}"; IconFilename: "{app}\burnglass.ico"; Comment: "Stop the running Burnglass server"; Tasks: desktopicon

[Registry]
; The startup entry, identical to what the server writes for itself: quoted exe
; path plus --no-open, which starts the server at sign-in without a browser.
; uninsdeletevalue removes it again when Burnglass is uninstalled.
; There is deliberately NO "delete when the task is unchecked" counterpart: a
; user who turned startup on in the Server panel should not have it silently
; turned off by running an upgrade installer. Turning it off is the Server panel
; toggle, `burnglass.exe --startup off`, or uninstalling.
Root: HKCU; Subkey: "{#RunKey}"; ValueType: string; ValueName: "{#RunValue}"; ValueData: """{app}\{#MyAppExe}"" --no-open"; Flags: uninsdeletevalue; Tasks: startup

[Run]
Filename: "{app}\{#MyAppExe}"; Description: "Start Burnglass now (opens the dashboard)"; Flags: postinstall nowait skipifsilent

[UninstallRun]
; Stop the server before its files are deleted, otherwise the running exe is
; locked and the uninstall leaves it behind. The RunOnceId predates the rename;
; keep it. CurUninstallStepChanged also stops it (trying pulse.exe too).
Filename: "{app}\{#MyAppExe}"; Parameters: "--stop"; RunOnceId: "StopPulse"; Flags: runhidden skipifdoesntexist

[UninstallDelete]
; Intentionally empty. Settings, logs and sealed history live in
; %USERPROFILE%\.burnglass (and, from Pulse, %USERPROFILE%\.pulse) and are the
; USER'S DATA - uninstalling the program must never delete them. Anything ever
; added here must stay inside {app}.

[Messages]
; Say plainly that the data folders survived, rather than leaving people guessing.
UninstalledAll=%1 was successfully removed from your computer.%n%nYour Burnglass settings and usage history in the .burnglass folder of your user profile (and the older .pulse folder, if you have one) were left untouched.

[Code]
var
  // True when {app} already held pulse.exe before this install: an upgrade of
  // a Pulse folder, so the pulse.exe twin must be refreshed alongside
  // burnglass.exe. Set in PrepareToInstall - a Check must not expand {app}
  // itself, because Inno may evaluate it before the folder is known.
  PulseTwin: Boolean;

function PulseProgramsDir: String;
begin
  Result := ExpandConstant('{localappdata}\Programs\Pulse');
end;

function DirHoldsApp(const Dir: String): Boolean;
begin
  Result := False;
  if Dir <> '' then
    Result := FileExists(AddBackslash(Dir) + '{#LegacyExe}') or FileExists(AddBackslash(Dir) + '{#MyAppExe}');
end;

// DefaultDirName. Inno uses it only when it has no previous install of this
// AppId, so a PulseSetup upgrade never gets here. `pulse.exe --install`
// installed into %LOCALAPPDATA%\Programs\Pulse without Inno's _is1 key; picking
// Programs\Burnglass then would split the machine into two installs (two
// Add/Remove entries, a stale copy still started at sign-in). So reuse any
// folder that already holds the app, and use Programs\Burnglass only for a
// genuinely fresh machine. The server's --install uses the same rule.
function DefaultInstallDir(Param: String): String;
var
  Loc: String;
begin
  if DirHoldsApp(PulseProgramsDir) then
  begin
    Result := PulseProgramsDir;
    Exit;
  end;
  if RegQueryStringValue(HKCU, '{#InstallKeyV1}', 'InstallLocation', Loc) then
  begin
    Loc := RemoveBackslashUnlessRoot(Loc);
    if DirHoldsApp(Loc) then
    begin
      Result := Loc;
      Exit;
    end;
  end;
  Result := ExpandConstant('{localappdata}\Programs\Burnglass');
end;

function WantPulseTwin: Boolean;
begin
  Result := PulseTwin;
end;

function SamePath(const A, B: String): Boolean;
begin
  Result := CompareText(RemoveBackslashUnlessRoot(A), RemoveBackslashUnlessRoot(B)) = 0;
end;

// True when Path lies inside Dir (case-insensitive, whole folder names).
function InsideDir(const Path, Dir: String): Boolean;
begin
  Result := Pos(Lowercase(AddBackslash(Dir)), Lowercase(Path)) > 0;
end;

// `--stop` is port-based, so ANY copy of the exe stops whichever server is
// running. Returns True once one of them could be started.
function TryStop(const Exe: String): Boolean;
var
  ResultCode: Integer;
begin
  Result := False;
  if FileExists(Exe) then
    Result := Exec(Exe, '--stop', ExtractFileDir(Exe), SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

// Ask a running server to shut down so its exe can be replaced or removed.
// On the first upgrade from Pulse only pulse.exe exists - and it is the one
// that is running - so it is tried after burnglass.exe, then the Pulse folder.
procedure StopRunning(const AppDir: String; AlsoPulseDir: Boolean);
var
  Stopped: Boolean;
begin
  Stopped := TryStop(AddBackslash(AppDir) + '{#MyAppExe}');
  if not Stopped then
    Stopped := TryStop(AddBackslash(AppDir) + '{#LegacyExe}');
  if (not Stopped) and AlsoPulseDir and not SamePath(AppDir, PulseProgramsDir) then
  begin
    Stopped := TryStop(AddBackslash(PulseProgramsDir) + '{#MyAppExe}');
    if not Stopped then
      Stopped := TryStop(AddBackslash(PulseProgramsDir) + '{#LegacyExe}');
  end;
  // The server acknowledges the stop and then exits; give it a moment to
  // release the file handle before we copy over it.
  if Stopped then
    Sleep(1500);
end;

// The strip holds its own exe open and has no stop switch of its own. End the
// copies that run FROM THIS FOLDER only (a strip started from anywhere else is
// left alone). powershell.exe and CIM are Windows builtins; CIM reports the
// full image path even from this 32-bit Setup process.
procedure StopStrips(const AppDir: String);
var
  Dir, Cmd: String;
  ResultCode: Integer;
begin
  Dir := AddBackslash(AppDir);
  StringChangeEx(Dir, '''', '''''', True);
  Cmd := '-NoProfile -NonInteractive -Command "$d = ''' + Dir + '''; ' +
    'Get-CimInstance Win32_Process -Filter \"Name=''burnglass-strip.exe'' OR Name=''pulse-strip.exe''\" | ' +
    'Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($d, [System.StringComparison]::OrdinalIgnoreCase) } | ' +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; ' +
    'Wait-Process -Id $_.ProcessId -Timeout 5 -ErrorAction SilentlyContinue }"';
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Cmd, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  PulseTwin := FileExists(ExpandConstant('{app}\{#LegacyExe}'));
  StopRunning(ExpandConstant('{app}'), True);
  StopStrips(ExpandConstant('{app}'));
  Result := '';
end;

// ---- post-install: finish the Pulse -> Burnglass switch for THIS folder ----

// A Run value that launches this folder's pulse.exe now launches burnglass.exe
// (same bytes, and the name the shortcuts use). The value name stays "Pulse";
// any other arguments are kept. An entry pointing anywhere else (a portable
// copy) is not ours and is left alone.
procedure RepointRunValue;
var
  Data, Old: String;
  P: Integer;
begin
  if not RegQueryStringValue(HKCU, '{#RunKey}', '{#RunValue}', Data) then
    Exit;
  Old := AddBackslash(ExpandConstant('{app}')) + '{#LegacyExe}';
  P := Pos(Lowercase(Old), Lowercase(Data));
  if P = 0 then
    Exit;
  Data := Copy(Data, 1, P - 1) + AddBackslash(ExpandConstant('{app}')) + '{#MyAppExe}' +
    Copy(Data, P + Length(Old), Length(Data));
  RegWriteStringValue(HKCU, '{#RunKey}', '{#RunValue}', Data);
end;

// The target of a .lnk, or '' when it cannot be read.
function ShortcutTarget(const Lnk: String): String;
var
  Shell, Link: Variant;
begin
  Result := '';
  try
    Shell := CreateOleObject('WScript.Shell');
    Link := Shell.CreateShortcut(Lnk);
    Result := Link.TargetPath;
  except
    Result := '';
  end;
end;

// Remove a Pulse-era shortcut, but only one that launches something in this
// folder: a "Pulse" shortcut to a portable pulse.exe elsewhere is the user's.
// If the target cannot be read at all, it is only assumed ours when this
// install IS an upgrade of a Pulse folder.
procedure RemoveOldShortcut(const Lnk: String);
var
  Target: String;
begin
  if not FileExists(Lnk) then
    Exit;
  Target := ShortcutTarget(Lnk);
  if Target = '' then
  begin
    if PulseTwin then
      DeleteFile(Lnk);
  end
  else if InsideDir(Target, ExpandConstant('{app}')) then
    DeleteFile(Lnk);
end;

procedure RemoveOldShortcutsIn(const Dir: String);
begin
  if Dir = '' then
    Exit;
  RemoveOldShortcut(AddBackslash(Dir) + 'Pulse.lnk');
  RemoveOldShortcut(AddBackslash(Dir) + 'Pulse - Stop.lnk');
end;

procedure RemoveOldShortcuts;
begin
  RemoveOldShortcutsIn(ExpandConstant('{autoprograms}'));
  RemoveOldShortcutsIn(ExpandConstant('{autodesktop}'));
  // The spots `pulse.exe --install` also wrote to when the Desktop is
  // redirected (OneDrive); duplicates of the above are simply not found.
  RemoveOldShortcutsIn(ExpandConstant('{%USERPROFILE}\Desktop'));
  if GetEnv('OneDrive') <> '' then
    RemoveOldShortcutsIn(AddBackslash(GetEnv('OneDrive')) + 'Desktop');
end;

// Add/Remove Programs: an `--install` entry for THIS folder is superseded by
// Inno's own entry, so the app is listed once.
procedure RemoveInstallKeyIfHere(const Key: String);
var
  Loc: String;
begin
  if RegQueryStringValue(HKCU, Key, 'InstallLocation', Loc) then
    if SamePath(Loc, ExpandConstant('{app}')) then
      RegDeleteKeyIncludingSubkeys(HKCU, Key);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    RepointRunValue;
    RemoveOldShortcuts;
    RemoveInstallKeyIfHere('{#InstallKeyV1}');
    RemoveInstallKeyIfHere('{#InstallKeyV2}');
  end;
end;

// ---- uninstall ----

// The Run value may have been created by the server itself (Server panel /
// `--startup on`), in which case [Registry] never recorded it for
// uninsdeletevalue. Remove it when it points at the copy being uninstalled, so
// uninstalling never leaves a sign-in entry aimed at a deleted exe. One
// pointing anywhere else (a portable copy) is left alone.
procedure DeleteRunValueIfHere(const Name: String);
var
  Data: String;
begin
  if RegQueryStringValue(HKCU, '{#RunKey}', Name, Data) then
    if InsideDir(Data, ExpandConstant('{app}')) then
      RegDeleteValue(HKCU, '{#RunKey}', Name);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    StopRunning(ExpandConstant('{app}'), False);
    StopStrips(ExpandConstant('{app}'));
  end;
  if CurUninstallStep = usPostUninstall then
  begin
    DeleteRunValueIfHere('{#RunValue}');
    // Never written by this installer or by a server that follows the frozen
    // name, but cheap insurance against a stray one aimed at a deleted exe.
    DeleteRunValueIfHere('Burnglass');
  end;
end;
