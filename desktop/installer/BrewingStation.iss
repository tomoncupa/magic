; Brewing Station for friends (Tom, 2026-11-16). Built by build.py; do not compile this by hand.
; Installs for the one Windows user, no admin prompt. Uninstalling leaves the decks in %LOCALAPPDATA%\Brewing Station.

#define AppVer GetEnv("BREW_VERSION")

[Setup]
AppId={{6F7C2B1E-9B5A-4C1D-8E3F-B12A7D4C9E01}
AppName=Brewing Station
AppVersion={#AppVer}
AppPublisher=Tom Moncupa
DefaultDirName={localappdata}\Programs\Brewing Station
DefaultGroupName=Brewing Station
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
OutputDir=output
OutputBaseFilename=Brewing Station Setup
SetupIconFile=..\brewing.ico
UninstallDisplayIcon={app}\Brewing Station.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern dark
CloseApplications=force

[Tasks]
Name: "desktopicon"; Description: "Put Brewing Station on the desktop"; GroupDescription: "Shortcuts:"

[Files]
Source: "dist\Brewing Station\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Brewing Station"; Filename: "{app}\Brewing Station.exe"
Name: "{autodesktop}\Brewing Station"; Filename: "{app}\Brewing Station.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Brewing Station.exe"; Description: "Open Brewing Station now"; Flags: nowait postinstall skipifsilent
; A self-update runs this setup silently: open the new copy straight after.
Filename: "{app}\Brewing Station.exe"; Flags: nowait; Check: WizardSilent

[UninstallRun]
Filename: "{cmd}"; Parameters: "/c taskkill /f /im ""Brewing Station.exe"""; Flags: runhidden; RunOnceId: "StopBrew"
