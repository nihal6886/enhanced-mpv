; ============================================================================
;  Enhanced MPV - Smart Web Installer (Inno Setup 6.5+)
;
;  Consumes the offline payload produced by scripts\build-release.ps1
;  (installer\staging\...) and stays well under the 20 MB budget by never
;  bundling mpv/yt-dlp: they are resolved on demand via winget, with a direct
;  GitHub release download as a fallback.
;
;  Compile:  iscc /DExtId="docojpbeobpfjdfhlfjhdijfnbekfpob" installer\setup.iss
; ============================================================================

#ifndef ExtId
  #define ExtId "oaholhjabdiapfijakeojjjoideniecl"
#endif
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

#define HostName "com.enhanced.mpv.host"
#define GeckoId "enhanced-mpv@enhanced-mpv.local"

[Setup]
ArchiveExtraction=enhanced
AppId={{7E4C1A92-6B3D-4F58-9E21-C0A4D5F6B781}
AppName=Enhanced MPV
AppVersion={#AppVersion}
AppVerName=Enhanced MPV {#AppVersion}
AppPublisher=Enhanced MPV
AppPublisherURL=https://github.com/enhanced-mpv
DefaultDirName={localappdata}\Programs\Enhanced MPV
DefaultGroupName=Enhanced MPV
DisableProgramGroupPage=yes
DisableDirPage=no
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=EnhancedMPV-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\assets\enhanced-mpv.ico
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
UninstallDisplayName=Enhanced MPV
UninstallDisplayIcon={app}\host\enhanced-mpv-host.exe
CloseApplications=no
RestartApplications=no
SetupLogging=yes
; "basic" is Inno Setup's default 7-Zip extractor; it covers the non-encrypted
; .7z archives we download for mpv. (Requires Inno Setup 6.5+ for extractarchive.)
DisableWelcomePage=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; --- offline payload (everything except mpv / yt-dlp) ----------------------
Source: "staging\host\enhanced-mpv-host.exe"; DestDir: "{app}\host"; Flags: ignoreversion
Source: "staging\extension\*"; DestDir: "{app}\extension"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "staging\onboarding\*"; DestDir: "{app}\onboarding"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "staging\manifests\*"; DestDir: "{app}\manifests"; Flags: ignoreversion
Source: "staging\extension-id.txt"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "staging\firefox\enhanced-mpv-firefox.xpi"; DestDir: "{app}\firefox"; Flags: ignoreversion skipifsourcedoesntexist
Source: "staging\mpv-config\*"; DestDir: "{app}\mpv"; Flags: ignoreversion recursesubdirs createallsubdirs

; --- on-demand dependencies (downloaded into {tmp} when winget is absent) --
Source: "{tmp}\yt-dlp.exe"; DestDir: "{app}\bin"; Flags: external ignoreversion skipifsourcedoesntexist; Check: NeedYtDlpFile
Source: "{tmp}\mpv.7z"; DestDir: "{localappdata}\Programs\mpv"; Flags: external extractarchive recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist; Check: NeedMpvFile

[Icons]
Name: "{userprograms}\Enhanced MPV\Setup Guide"; Filename: "{app}\onboarding\index.html"
Name: "{userprograms}\Enhanced MPV\Enhanced MPV"; Filename: "{code:MpvExeForIcon}"; WorkingDir: "{app}\mpv"; IconFilename: "{app}\mpv\enhanced-mpv.ico"; Comment: "Enhanced MPV player"; Check: HaveMpvForIcon

[Registry]
; --- Native Messaging host registration (per user, no admin) ---------------
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\{#HostName}"; ValueType: string; ValueName: ""; ValueData: "{app}\manifests\{#HostName}.chrome.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Chromium\NativeMessagingHosts\{#HostName}"; ValueType: string; ValueName: ""; ValueData: "{app}\manifests\{#HostName}.chrome.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Edge\NativeMessagingHosts\{#HostName}"; ValueType: string; ValueName: ""; ValueData: "{app}\manifests\{#HostName}.chrome.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\BraveSoftware\Brave\NativeMessagingHosts\{#HostName}"; ValueType: string; ValueName: ""; ValueData: "{app}\manifests\{#HostName}.chrome.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Mozilla\NativeMessagingHosts\{#HostName}"; ValueType: string; ValueName: ""; ValueData: "{app}\manifests\{#HostName}.firefox.json"; Flags: uninsdeletekey

[Run]
Filename: "{app}\onboarding\index.html"; Description: "Open the 3-step setup guide"; Flags: postinstall shellexec nowait skipifsilent
Filename: "{code:GetChromeExe}"; Parameters: "chrome://extensions"; Description: "Open Chrome extensions page (paste the folder we copied)"; Flags: postinstall nowait skipifsilent; Check: LaunchChrome
Filename: "{code:GetBraveExe}"; Parameters: "brave://extensions"; Description: "Open Brave extensions page (paste the folder we copied)"; Flags: postinstall nowait skipifsilent; Check: LaunchBrave
Filename: "{code:GetEdgeExe}"; Parameters: "edge://extensions"; Description: "Open Edge extensions page (paste the folder we copied)"; Flags: postinstall nowait skipifsilent; Check: LaunchEdge

[Code]
const
  CHostName = '{#HostName}';
  CGeckoId = '{#GeckoId}';
  CExtId = '{#ExtId}';
  CModernZLuaUrl = 'https://github.com/Samillion/ModernZ/releases/latest/download/modernz.lua';
  CModernZFontUrl = 'https://github.com/Samillion/ModernZ/releases/latest/download/modernz-icons.ttf';
  CRceditUrl = 'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe';

var
  BrowserPage: TInputOptionWizardPage;
  DownloadPage: TDownloadWizardPage;
  ProgressPage: TOutputProgressWizardPage;

  ChromeExe: String;
  BraveExe: String;
  EdgeExe: String;
  FirefoxExe: String;

  WantMpvArchive: Boolean;
  WantYtDlpArchive: Boolean;
  WantModernZLua: Boolean;
  WantModernZFont: Boolean;

  RceditExe: String;

{ ----------------------------------------------------------------- helpers -- }

function FirstExisting(const Paths: array of String): String;
var
  I: Integer;
begin
  Result := '';
  for I := 0 to High(Paths) do
    if (Paths[I] <> '') and FileExists(Paths[I]) then
    begin
      Result := Paths[I];
      Exit;
    end;
end;

function FindOnPath(const ExeName: String): String;
var
  Rest, Part, Candidate: String;
  P: Integer;
begin
  Result := '';
  Rest := GetEnv('PATH');
  while Rest <> '' do
  begin
    P := Pos(';', Rest);
    if P > 0 then
    begin
      Part := Copy(Rest, 1, P - 1);
      Rest := Copy(Rest, P + 1, Length(Rest));
    end
    else
    begin
      Part := Rest;
      Rest := '';
    end;
    Part := Trim(Part);
    if Part = '' then
      Continue;
    Candidate := AddBackslash(Part) + ExeName;
    if FileExists(Candidate) then
    begin
      Result := Candidate;
      Exit;
    end;
  end;
end;

function DetectChrome: String;
begin
  Result := FirstExisting([
    ExpandConstant('{pf}\Google\Chrome\Application\chrome.exe'),
    ExpandConstant('{pf32}\Google\Chrome\Application\chrome.exe'),
    ExpandConstant('{localappdata}\Google\Chrome\Application\chrome.exe')]);
end;

function DetectBrave: String;
begin
  Result := FirstExisting([
    ExpandConstant('{pf}\BraveSoftware\Brave-Browser\Application\brave.exe'),
    ExpandConstant('{pf32}\BraveSoftware\Brave-Browser\Application\brave.exe'),
    ExpandConstant('{localappdata}\BraveSoftware\Brave-Browser\Application\brave.exe')]);
end;

function DetectEdge: String;
begin
  Result := FirstExisting([
    ExpandConstant('{pf32}\Microsoft\Edge\Application\msedge.exe'),
    ExpandConstant('{pf}\Microsoft\Edge\Application\msedge.exe'),
    ExpandConstant('{localappdata}\Microsoft\Edge\Application\msedge.exe')]);
end;

function DetectFirefox: String;
begin
  Result := FirstExisting([
    ExpandConstant('{pf}\Mozilla Firefox\firefox.exe'),
    ExpandConstant('{pf32}\Mozilla Firefox\firefox.exe')]);
end;

{ ------------------------------------------------------------------- state -- }

function UseChrome: Boolean;
begin
  Result := BrowserPage.Values[0];
end;

function UseBrave: Boolean;
begin
  Result := BrowserPage.Values[1];
end;

function UseEdge: Boolean;
begin
  Result := BrowserPage.Values[2];
end;

function UseFirefox: Boolean;
begin
  Result := BrowserPage.Values[3];
end;

function LaunchChrome: Boolean;
begin
  Result := UseChrome and (ChromeExe <> '');
end;

function LaunchBrave: Boolean;
begin
  Result := UseBrave and (BraveExe <> '');
end;

function LaunchEdge: Boolean;
begin
  Result := UseEdge and (EdgeExe <> '');
end;

function GetChromeExe(Param: String): String;
begin
  Result := ChromeExe;
end;

function GetBraveExe(Param: String): String;
begin
  Result := BraveExe;
end;

function GetEdgeExe(Param: String): String;
begin
  Result := EdgeExe;
end;

function IsNativeMpv(const Exe: String): Boolean;
var
  P: String;
begin
  P := Lowercase(Exe);
  Result := FileExists(Exe)
    and ((ExtractFileName(P) = 'mpv.exe') or (ExtractFileName(P) = 'mpv.com'))
    and (Pos('\mpv.net\', P) = 0)
    and (Pos('\mpvnet\', P) = 0);
end;

function MpvInstalled: Boolean;
var
  Exe: String;
begin
  Exe := FindOnPath('mpv.exe');
  if not IsNativeMpv(Exe) then
    Exe := FindOnPath('mpv.com');
  Result := IsNativeMpv(Exe)
    or FileExists(ExpandConstant('{app}\bin\mpv.exe'))
    or FileExists(ExpandConstant('{localappdata}\Programs\mpv\mpv.exe'))
    or FileExists(ExpandConstant('{localappdata}\Programs\mpv\mpv.com'))
    or FileExists(ExpandConstant('{localappdata}\Microsoft\WinGet\Links\mpv.exe'))
    or FileExists(ExpandConstant('{localappdata}\Microsoft\WinGet\Links\mpv.com'));
end;

function YtDlpInstalled: Boolean;
begin
  Result := (FindOnPath('yt-dlp.exe') <> '')
    or FileExists(ExpandConstant('{app}\bin\yt-dlp.exe'));
end;

function NeedMpvFile(Param: String): Boolean;
begin
  Result := WantMpvArchive and FileExists(ExpandConstant('{tmp}\mpv.7z'));
end;

function NeedYtDlpFile(Param: String): Boolean;
begin
  Result := WantYtDlpArchive and FileExists(ExpandConstant('{tmp}\yt-dlp.exe'));
end;

{ --------------------------------------------------------------- winget io -- }

function RunWinget(const PkgId: String): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec(ExpandConstant('{cmd}'),
    '/c winget install -e --id ' + PkgId +
    ' --accept-package-agreements --accept-source-agreements --silent',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := Result and (ResultCode = 0);
end;

{ Direct GitHub fallback for mpv: resolve the latest shinchiro/mpv-winbuild-cmake
  release asset URL (mpv-x86_64-*.7z), never mpv.net. }
function ResolveMpvDirectUrl: String;
var
  Json: TStringList;
  S, U: String;
begin
  Result := '';
  try
    DownloadTemporaryFile(
      'https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest',
      'mpv-direct-release.json', '', nil);
  except
    Exit;
  end;
  if not FileExists(ExpandConstant('{tmp}\mpv-direct-release.json')) then
    Exit;
  Json := TStringList.Create;
  try
    try
      Json.LoadFromFile(ExpandConstant('{tmp}\mpv-direct-release.json'));
    except
      Exit;
    end;
    S := Json.Text;
  finally
    Json.Free;
  end;
  while True do
  begin
    U := ScanUrl(S);
    if U = '' then
      Break;
    if (Pos('.7z', U) > 0) and (Pos('x86_64', U) > 0) and (Pos('-v3', U) = 0) then
    begin
      Result := U;
      Exit;
    end;
  end;
end;

function InstallMpvDirect: Boolean;
var
  MpvUrl: String;
  ResultCode: Integer;
begin
  Result := False;
  MpvUrl := ResolveMpvDirectUrl;
  if MpvUrl = '' then
    Exit;
  try
    DownloadTemporaryFile(MpvUrl, 'mpv.7z', '', nil);
  except
    Exit;
  end;
  if not FileExists(ExpandConstant('{tmp}\mpv.7z')) then
    Exit;
  Result := True;
  Log('Direct mpv download staged at {tmp}\mpv.7z; the [Files] extractarchive entry will unpack it.');
end;

{ ------------------------------------------------------------ github fetch -- }

{ Consume one "browser_download_url":"<url>" entry from Rest, returning the url
  and mutating Rest to continue scanning. }
function ScanUrl(var Rest: String): String;
var
  P, Q: Integer;
begin
  Result := '';
  P := Pos('"browser_download_url"', Rest);
  if P = 0 then
  begin
    Rest := '';
    Exit;
  end;
  Rest := Copy(Rest, P + Length('"browser_download_url"'), Length(Rest));
  Q := Pos('"', Rest);
  if Q = 0 then
  begin
    Rest := '';
    Exit;
  end;
  Rest := Copy(Rest, Q + 1, Length(Rest));
  Q := Pos('"', Rest);
  if Q = 0 then
  begin
    Rest := '';
    Exit;
  end;
  Result := Copy(Rest, 1, Q - 1);
  Rest := Copy(Rest, Q + 1, Length(Rest));
end;

function ResolveMpvUrl: String;
var
  Json: TStringList;
  S, U: String;
begin
  Result := '';
  try
    DownloadTemporaryFile(
      'https://api.github.com/repos/zhongfly/mpv-winbuild/releases/latest',
      'mpv-release.json', '', nil);
  except
    Exit;
  end;
  if not FileExists(ExpandConstant('{tmp}\mpv-release.json')) then
    Exit;

  Json := TStringList.Create;
  try
    try
      Json.LoadFromFile(ExpandConstant('{tmp}\mpv-release.json'));
    except
      Exit;
    end;
    S := Json.Text;
  finally
    Json.Free;
  end;

  while True do
  begin
    U := ScanUrl(S);
    if U = '' then
      Break;
    if (Pos('.7z', U) > 0) and (Pos('x86_64', U) > 0) and (Pos('-v3', U) = 0) then
    begin
      Result := U;
      Exit;
    end;
  end;
end;

procedure DownloadDeps;
var
  MpvUrl: String;
begin
  DownloadPage.Clear;
  if WantYtDlpArchive then
    DownloadPage.Add('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
      'yt-dlp.exe', '');
  if WantMpvArchive then
  begin
    { If InstallMpvDirect already staged the archive, skip re-downloading it. }
    if FileExists(ExpandConstant('{tmp}\mpv.7z')) then
      Log('mpv archive already staged by direct download; skipping re-download.')
    else
    begin
      MpvUrl := ResolveMpvUrl;
      if MpvUrl <> '' then
        DownloadPage.Add(MpvUrl, 'mpv.7z', '')
      else
        Log('Could not resolve a mpv release asset; skipping mpv download.');
    end;
  end;
  if WantModernZLua then
    DownloadPage.Add(CModernZLuaUrl, 'modernz.lua', '');
  if WantModernZFont then
    DownloadPage.Add(CModernZFontUrl, 'modernz-icons.ttf', '');

  if DownloadPage.Enabled = False then
    Exit;

  DownloadPage.Show;
  try
    try
      DownloadPage.Download;
    except
      if DownloadPage.AbortedByUser then
        SuppressibleMsgBox('Dependency download was cancelled. You can install mpv and yt-dlp later and re-run setup.',
          mbInformation, MB_OK, IDOK)
      else
        SuppressibleMsgBox('Could not download dependencies: ' + GetExceptionMessage,
          mbError, MB_OK, IDOK);
    end;
  finally
    DownloadPage.Hide;
  end;

  { Tie the install-time file checks to what actually landed on disk. }
  WantYtDlpArchive := WantYtDlpArchive and FileExists(ExpandConstant('{tmp}\yt-dlp.exe'));
  WantMpvArchive := WantMpvArchive and FileExists(ExpandConstant('{tmp}\mpv.7z'));
  WantModernZLua := WantModernZLua and FileExists(ExpandConstant('{tmp}\modernz.lua'));
  WantModernZFont := WantModernZFont and FileExists(ExpandConstant('{tmp}\modernz-icons.ttf'));
end;

{ -------------------------------------------------------------- file utils -- }

procedure CopyTree(const Src, Dst: String);
var
  FS: TFindRec;
begin
  if not DirExists(Dst) then
    ForceDirectories(Dst);
  if not FindFirst(AddBackslash(Src) + '*', FS) then
    Exit;
  try
    repeat
      if (FS.Name = '.') or (FS.Name = '..') then
        Continue;
      if (FS.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then
        CopyTree(AddBackslash(Src) + FS.Name, AddBackslash(Dst) + FS.Name)
      else
        CopyFile(AddBackslash(Src) + FS.Name, AddBackslash(Dst) + FS.Name, False);
    until not FindNext(FS);
  finally
    FindClose(FS);
  end;
end;

procedure SaveAsciiLines(const FileName: String; const Lines: array of String);
var
  Arr: TArrayOfString;
  I: Integer;
begin
  SetArrayLength(Arr, GetArrayLength(Lines));
  for I := 0 to GetArrayLength(Lines) - 1 do
    Arr[I] := Lines[I];
  SaveStringsToFile(FileName, Arr, False);
end;

function EscapeJsonPath(const P: String): String;
var
  S: String;
begin
  S := P;
  StringChangeEx(S, '\', '\\', True);
  Result := S;
end;

function ReadExtId: String;
var
  Lines: TArrayOfString;
begin
  Result := CExtId;
  if LoadStringsFromFile(ExpandConstant('{app}\extension-id.txt'), Lines) and (GetArrayLength(Lines) > 0) then
    if Trim(Lines[0]) <> '' then
      Result := Trim(Lines[0]);
end;

procedure PatchIpcServer(const ConfPath: String);
var
  Lines: TArrayOfString;
  I: Integer;
  T: String;
begin
  if not FileExists(ConfPath) then
    Exit;
  if not LoadStringsFromFile(ConfPath, Lines) then
  begin
    Log('Could not read ' + ConfPath + ' to patch the IPC pipe.');
    Exit;
  end;
  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    T := Trim(Lines[I]);
    if (Length(T) >= 17) and (Copy(T, 1, 17) = 'input-ipc-server=') then
      Lines[I] := 'input-ipc-server=\\.\pipe\enhanced-mpv-socket';
  end;
  SaveStringsToFile(ConfPath, Lines, False);
  Log('Patched input-ipc-server in ' + ConfPath);
end;

function FindMpvExeInDir(const Dir: String): String;
var
  FS: TFindRec;
begin
  Result := '';
  if FileExists(AddBackslash(Dir) + 'mpv.exe') then
  begin
    Result := AddBackslash(Dir) + 'mpv.exe';
    Exit;
  end;
  if not FindFirst(AddBackslash(Dir) + '*', FS) then
    Exit;
  try
    repeat
      if (FS.Attributes and FILE_ATTRIBUTE_DIRECTORY <> 0)
        and (FS.Name <> '.') and (FS.Name <> '..') then
        if FileExists(AddBackslash(Dir) + FS.Name + '\mpv.exe') then
        begin
          Result := AddBackslash(Dir) + FS.Name + '\mpv.exe';
          Break;
        end;
    until not FindNext(FS);
  finally
    FindClose(FS);
  end;
end;

{ Resolve the player binary for the Start Menu shortcut, preferring the value
  the installer just wrote to MPV_PATH, then the standard install folders. }
function MpvExeForIcon(Param: String): String;
var
  Exe: String;
begin
  Exe := '';
  { Prioritize the stamped EnhancedMPV build with our custom icon. }
  Exe := ExpandConstant('{localappdata}\Programs\EnhancedMPV\enhanced-mpv.exe');
  if FileExists(Exe) and IsNativeMpv(Exe) then
  begin
    Result := Exe;
    Exit;
  end;
  if RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'MPV_PATH', Exe) and IsNativeMpv(Exe) then
  begin
    Result := Exe;
    Exit;
  end;
  Exe := FindMpvExeInDir(ExpandConstant('{localappdata}\Programs\mpv'));
  if Exe = '' then Exe := ExpandConstant('{localappdata}\Microsoft\WinGet\Links\mpv.exe');
  if not IsNativeMpv(Exe) then Exe := ExpandConstant('{localappdata}\Microsoft\WinGet\Links\mpv.com');
  if not IsNativeMpv(Exe) then Exe := FindOnPath('mpv.exe');
  if not IsNativeMpv(Exe) then Exe := FindOnPath('mpv.com');
  if not IsNativeMpv(Exe) then Exe := '';
  Result := Exe;
end;

function HaveMpvForIcon(Param: String): Boolean;
begin
  Result := MpvExeForIcon('') <> '';
end;

{ Flatten an archive that extracted into a single sub-folder so mpv.exe lands
  next to its DLLs at the root of the target directory. }
procedure NormalizeMpvDir(const Dir: String);
var
  FS: TFindRec;
  Sub: String;
begin
  if FileExists(AddBackslash(Dir) + 'mpv.exe') then
    Exit;
  if not FindFirst(AddBackslash(Dir) + '*', FS) then
    Exit;
  try
    repeat
      if (FS.Attributes and FILE_ATTRIBUTE_DIRECTORY <> 0)
        and (FS.Name <> '.') and (FS.Name <> '..') then
      begin
        Sub := AddBackslash(Dir) + FS.Name;
        if FileExists(AddBackslash(Sub) + 'mpv.exe') then
        begin
          CopyTree(Sub, Dir);
          Break;
        end;
      end;
    until not FindNext(FS);
  finally
    FindClose(FS);
  end;
end;

{ ------------------------------------------------------------------ deploy -- }

procedure DeployMpvConfig;
var
  AppMpv, UserMpv, BackupDir: String;
begin
  AppMpv := ExpandConstant('{app}\mpv');
  UserMpv := ExpandConstant('{userappdata}\mpv');
  ForceDirectories(UserMpv);

  if FileExists(AddBackslash(UserMpv) + 'mpv.conf') or FileExists(AddBackslash(UserMpv) + 'input.conf') then
  begin
    BackupDir := AddBackslash(UserMpv) + '.enhanced-mpv-backups\' +
      GetDateTimeString('yyyymmdd-hhnnss', '-', ':');
    ForceDirectories(BackupDir);
    CopyFile(AddBackslash(UserMpv) + 'mpv.conf', AddBackslash(BackupDir) + 'mpv.conf', False);
    CopyFile(AddBackslash(UserMpv) + 'input.conf', AddBackslash(BackupDir) + 'input.conf', False);
    Log('Backed up existing mpv config to ' + BackupDir);
  end;

  CopyTree(AppMpv, UserMpv);
  PatchIpcServer(AddBackslash(UserMpv) + 'mpv.conf');
end;

procedure DeployModernZ;
var
  ScriptsDir, FontsDir, AppLua, AppFont, TmpLua, TmpFont: String;
begin
  ScriptsDir := ExpandConstant('{userappdata}\mpv\scripts');
  FontsDir := ExpandConstant('{userappdata}\mpv\fonts');
  ForceDirectories(ScriptsDir);
  ForceDirectories(FontsDir);
  AppLua := AddBackslash(ExpandConstant('{app}\mpv')) + 'scripts\modernz.lua';
  AppFont := AddBackslash(ExpandConstant('{app}\mpv')) + 'fonts\modernz-icons.ttf';
  TmpLua := ExpandConstant('{tmp}\modernz.lua');
  TmpFont := ExpandConstant('{tmp}\modernz-icons.ttf');
  { Prefer the offline copies bundled in {app}\mpv from the staging payload;
    fall back to the {tmp} download if the offline copy is missing. }
  if WantModernZLua then
  begin
    if FileExists(AppLua) then
      CopyFile(AppLua, AddBackslash(ScriptsDir) + 'modernz.lua', False)
    else
      CopyFile(TmpLua, AddBackslash(ScriptsDir) + 'modernz.lua', False);
  end;
  if WantModernZFont then
  begin
    if FileExists(AppFont) then
      CopyFile(AppFont, AddBackslash(FontsDir) + 'modernz-icons.ttf', False)
    else
      CopyFile(TmpFont, AddBackslash(FontsDir) + 'modernz-icons.ttf', False);
  end;
end;

procedure WriteNativeManifests;
var
  ExtId, HostPath, Escaped: String;
begin
  ForceDirectories(ExpandConstant('{app}\manifests'));
  ExtId := ReadExtId;
  HostPath := ExpandConstant('{app}\host\enhanced-mpv-host.exe');
  Escaped := EscapeJsonPath(HostPath);

  SaveAsciiLines(ExpandConstant('{app}\manifests\' + CHostName + '.chrome.json'), [
    '{',
    '  "name": "' + CHostName + '",',
    '  "description": "Enhanced MPV Native Messaging Host",',
    '  "path": "' + Escaped + '",',
    '  "type": "stdio",',
    '  "allowed_origins": ["chrome-extension://' + ExtId + '/"]',
    '}']);

  SaveAsciiLines(ExpandConstant('{app}\manifests\' + CHostName + '.firefox.json'), [
    '{',
    '  "name": "' + CHostName + '",',
    '  "description": "Enhanced MPV Native Messaging Host",',
    '  "path": "' + Escaped + '",',
    '  "type": "stdio",',
    '  "allowed_extensions": ["' + CGeckoId + '"]',
    '}']);
end;

procedure SideloadFirefox;
var
  DistDir, Dest, Src: String;
begin
  Src := ExpandConstant('{app}\firefox\enhanced-mpv-firefox.xpi');
  if not FileExists(Src) then
    Exit;

  if FirefoxExe <> '' then
  begin
    DistDir := AddBackslash(ExtractFileDir(FirefoxExe)) + 'distribution\extensions';
    if DirExists(DistDir) or ForceDirectories(DistDir) then
    begin
      Dest := AddBackslash(DistDir) + CGeckoId + '.xpi';
      if CopyFile(Src, Dest, False) then
      begin
        Log('Sideloaded Firefox add-on to ' + Dest);
        Exit;
      end;
    end;
  end;

  { Per-user fallback that needs no admin rights. }
  RegWriteStringValue(HKEY_CURRENT_USER, 'Software\Mozilla\Firefox\Extensions', CGeckoId, Src);
  Log('Registered Firefox add-on via HKCU\Software\Mozilla\Firefox\Extensions');
end;

procedure PatchThumbfastConf(const MpvExe: String);
var
  ConfPath, T: String;
  Lines: TArrayOfString;
  I, N: Integer;
  HasPath, HasNetwork: Boolean;
begin
  ConfPath := ExpandConstant('{userappdata}\mpv\script-opts\thumbfast.conf');
  if not FileExists(ConfPath) then
    Exit;
  if not LoadStringsFromFile(ConfPath, Lines) then
  begin
    Log('Could not read ' + ConfPath + ' to pin thumbfast mpv_path.');
    Exit;
  end;
  HasPath := False;
  HasNetwork := False;
  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    T := Trim(Lines[I]);
    if (Length(T) >= 9) and (Copy(T, 1, 9) = 'mpv_path=') then
    begin
      Lines[I] := 'mpv_path=' + MpvExe;
      HasPath := True;
    end
    else if (Length(T) >= 8) and (Copy(T, 1, 8) = 'network=') then
    begin
      Lines[I] := 'network=no';
      HasNetwork := True;
    end;
  end;
  N := GetArrayLength(Lines);
  if not HasPath then
  begin
    SetArrayLength(Lines, N + 1);
    Lines[N] := 'mpv_path=' + MpvExe;
    N := N + 1;
  end;
  if not HasNetwork then
  begin
    SetArrayLength(Lines, N + 1);
    Lines[N] := 'network=no';
  end;
  SaveStringsToFile(ConfPath, Lines, False);
  Log('Pinned thumbfast mpv_path=' + MpvExe + ' and network=no');
end;

procedure FinalizeDeps;
var
  MpvDir, MpvExe, YtdlExe, HookDir, HookFile: String;
  EnhancedMpvDir, EnhancedMpvExe, IconPath, RceditCache, ResultCode: String;
begin
  MpvDir := ExpandConstant('{localappdata}\Programs\mpv');
  NormalizeMpvDir(MpvDir);
  MpvExe := FindMpvExeInDir(MpvDir);
  if not IsNativeMpv(MpvExe) then
    MpvExe := ExpandConstant('{localappdata}\Microsoft\WinGet\Links\mpv.exe');
  if not IsNativeMpv(MpvExe) then
    MpvExe := ExpandConstant('{localappdata}\Microsoft\WinGet\Links\mpv.com');
  if not IsNativeMpv(MpvExe) then
    MpvExe := FindOnPath('mpv.exe');
  if not IsNativeMpv(MpvExe) then
    MpvExe := FindOnPath('mpv.com');
  if IsNativeMpv(MpvExe) then
  begin
    RegWriteStringValue(HKEY_CURRENT_USER, 'Environment', 'MPV_PATH', MpvExe);
    Log('mpv resolved at ' + MpvExe);
  end
  else
    MpvExe := '';

  { Create EnhancedMPV folder and copy mpv.exe there as enhanced-mpv.exe, then stamp the icon. }
  EnhancedMpvDir := ExpandConstant('{localappdata}\Programs\EnhancedMPV');
  ForceDirectories(EnhancedMpvDir);
  EnhancedMpvExe := AddBackslash(EnhancedMpvDir) + 'enhanced-mpv.exe';
  if (MpvExe <> '') and FileExists(MpvExe) then
  begin
    if FileExists(EnhancedMpvExe) then
      DeleteFile(EnhancedMpvExe);
    if CopyFile(MpvExe, EnhancedMpvExe, False) then
    begin
      Log('Copied mpv to ' + EnhancedMpvExe);
      { Download rcedit-x64.exe from electron/rcedit releases if not cached. }
      RceditCache := AddBackslash(EnhancedMpvDir) + 'rcedit-x64.exe';
      if not FileExists(RceditCache) then
      begin
        Log('Downloading rcedit...');
        try
          DownloadTemporaryFile(CRceditUrl, 'rcedit-x64.exe', '', nil);
          if FileExists(ExpandConstant('{tmp}\rcedit-x64.exe')) then
          begin
            MoveFile(ExpandConstant('{tmp}\rcedit-x64.exe'), RceditCache);
            Log('rcedit cached at ' + RceditCache);
          end;
        except
          Log('Could not download rcedit; icon stamping skipped.');
        end;
      end;
      if FileExists(RceditCache) then
      begin
        IconPath := ExpandConstant('{app}\mpv\enhanced-mpv.ico');
        if FileExists(IconPath) then
        begin
          Log('Stamping Enhanced MPV icon into ' + EnhancedMpvExe + '...');
          ResultCode := '';
          Exec(ExpandConstant('{cmd}'), '/c "' + RceditCache + '" "' + EnhancedMpvExe + '" --set-icon "' + IconPath + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
          if ResultCode = '0' then
            Log('Icon stamped successfully.')
          else
            Log('rcedit failed (exit code ' + ResultCode + '); icon may not be applied.');
        end;
      end;
    end;
  end;

  PatchThumbfastConf(MpvExe);

  YtdlExe := '';
  if FileExists(ExpandConstant('{app}\bin\yt-dlp.exe')) then
    YtdlExe := ExpandConstant('{app}\bin\yt-dlp.exe');

  HookDir := ExpandConstant('{userappdata}\mpv\script-opts');
  HookFile := AddBackslash(HookDir) + 'ytdl_hook.conf';
  if (YtdlExe <> '') and not FileExists(HookFile) then
  begin
    ForceDirectories(HookDir);
    SaveAsciiLines(HookFile, ['ytdl_path=' + YtdlExe]);
    Log('Pointed ytdl_hook at ' + YtdlExe);
  end;
end;

procedure CopyExtensionToClipboard;
var
  ResultCode: Integer;
  P: String;
begin
  P := ExpandConstant('{app}\extension');
  Exec(ExpandConstant('{cmd}'),
    '/c powershell -NoProfile -Command "Set-Clipboard -Value ''' + P + '''"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Log('Copied extension path to clipboard: ' + P);
end;

{ -------------------------------------------------------------- wizard io -- }

function ProgIdKind(const ProgId: String): Integer;
var
  P: String;
begin
  P := Lowercase(ProgId);
  if Pos('brave', P) > 0 then
    Result := 1
  else if Pos('edge', P) > 0 then
    Result := 2
  else if Pos('firefox', P) > 0 then
    Result := 3
  else if Pos('chrome', P) > 0 then
    Result := 0
  else
    Result := -1;
end;

procedure DetectDefaultBrowser;
var
  ProgId: String;
  Kind: Integer;
begin
  ProgId := '';
  if not RegQueryStringValue(HKEY_CURRENT_USER,
    'Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice',
    'ProgId', ProgId) then
    RegQueryStringValue(HKEY_CURRENT_USER,
      'Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice',
      'ProgId', ProgId);
  Kind := ProgIdKind(ProgId);
  if (Kind >= 0) and (Kind <= 3) then
    BrowserPage.Values[Kind] := True;
  Log('Default browser ProgId: ' + ProgId);
end;

procedure InitializeWizard;
begin
  ProgressPage := CreateOutputProgressPage('Preparing dependencies',
    'Enhanced MPV is checking for mpv and yt-dlp. If they are missing they will be installed now.');

  DownloadPage := CreateDownloadPage(SetupMessage(msgWizardPreparing),
    SetupMessage(msgPreparingDesc), nil);
  DownloadPage.ShowBaseNameInsteadOfUrl := True;

  BrowserPage := CreateInputOptionPage(wpSelectTasks,
    'Browsers',
    'Which browsers should Enhanced MPV connect to?',
    'We detected your default browser and pre-selected it. Tick or untick any browser.',
    False, True);
  BrowserPage.Add('Google Chrome');
  BrowserPage.Add('Brave');
  BrowserPage.Add('Microsoft Edge');
  BrowserPage.Add('Mozilla Firefox');

  ChromeExe := DetectChrome;
  BraveExe := DetectBrave;
  EdgeExe := DetectEdge;
  FirefoxExe := DetectFirefox;

  DetectDefaultBrowser;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  MpvOk, YtdlOk, HaveWinget: Boolean;
begin
  Result := '';
  WantMpvArchive := False;
  WantYtDlpArchive := False;

  HaveWinget := FindOnPath('winget.exe') <> '';

  ProgressPage.SetProgress(0, 100);
  ProgressPage.SetText('Resolving dependencies', 'mpv and yt-dlp');
  ProgressPage.Show;
  try
    MpvOk := MpvInstalled;
    if (not MpvOk) and HaveWinget then
    begin
      ProgressPage.SetText('Installing mpv via winget', 'This can take a minute');
      { Try the canonical vanilla mpv winget ID first, then the zhongfly mirror. }
      MpvOk := RunWinget('mpv.mpv');
      if not MpvOk then
        MpvOk := RunWinget('zhongfly.mpv');
      if not MpvOk then
      begin
        { Direct GitHub fallback: fetch the latest shinchiro/mpv-winbuild-cmake
          release asset and extract it into {localappdata}\Programs\mpv. }
        MpvOk := InstallMpvDirect;
      end;
    end;
    WantMpvArchive := not MpvOk;

    YtdlOk := YtDlpInstalled;
    if (not YtdlOk) and HaveWinget then
    begin
      ProgressPage.SetText('Installing yt-dlp via winget', 'Fresh extractors included');
      YtdlOk := RunWinget('yt-dlp.yt-dlp');
    end;
    WantYtDlpArchive := not YtdlOk;

    { Mirror install.ps1: skip ModernZ only when both assets already exist
      (either already deployed to the user mpv dir, or bundled offline in
      {app}\mpv from the staging payload). }
    WantModernZLua := not ((FileExists(ExpandConstant('{userappdata}\mpv\scripts\modernz.lua')) and FileExists(ExpandConstant('{userappdata}\mpv\fonts\modernz-icons.ttf'))) or (FileExists(ExpandConstant('{app}\mpv\scripts\modernz.lua')) and FileExists(ExpandConstant('{app}\mpv\fonts\modernz-icons.ttf'))));
    WantModernZFont := WantModernZLua;

    ProgressPage.SetProgress(50, 100);
    ProgressPage.SetText('Fetching missing pieces', '');
  finally
    ProgressPage.Hide;
  end;

  if WantMpvArchive or WantYtDlpArchive or WantModernZLua or WantModernZFont then
    DownloadDeps;
end;

procedure WriteDefaultConfig;
var
  ConfigPath, ConfigJson: String;
begin
  ConfigPath := ExpandConstant('{userappdata}\.enhanced-mpv\config.json');
  if FileExists(ConfigPath) then
    Exit; { User already has a config; don't overwrite }
  ForceDirectories(ExtractFileDir(ConfigPath));
  ConfigJson :=
    '{' + #13#10 +
    '  "preferredSubtitleLanguages": ["eng", "spa"],' + #13#10 +
    '  "nativeAudioLanguages": ["eng", "en"],' + #13#10 +
    '  "opensubtitles": { "apiKey": "", "username": "", "password": "" },' + #13#10 +
    '  "videoQuality": "best",' + #13#10 +
    '  "queueMode": "replace",' + #13#10 +
    '  "autoIntercept": false,' + #13#10 +
    '  "autoInterceptDomains": [],' + #13#10 +
    '  "clipboardWatch": false,' + #13#10 +
    '  "ytdlFormat": "bestvideo*+bestaudio/best",' + #13#10 +
    '  "keepWarm": true,' + #13#10 +
    '  "profiles": [' + #13#10 +
    '    { "name": "Anime Upscale", "mpvProfile": "anime-upscale" },' + #13#10 +
    '    { "name": "Battery Saver", "mpvProfile": "battery-saver" },' + #13#10 +
    '    { "name": "Cinema HDR", "mpvProfile": "cinema-hdr" }' + #13#10 +
    '  ]' + #13#10 +
    '}';
  SaveStringsToFile(ConfigPath, [ConfigJson], False);
  Log('Wrote default config with keepWarm=true to ' + ConfigPath);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    DeployMpvConfig;
    DeployModernZ;
    WriteNativeManifests;
    FinalizeDeps;
    WriteDefaultConfig;
    if UseFirefox then
      SideloadFirefox;
    if UseChrome or UseBrave or UseEdge then
      CopyExtensionToClipboard;
  end;
end;
