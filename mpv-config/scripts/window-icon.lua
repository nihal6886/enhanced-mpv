--[[
  window-icon.lua

  Gives the Enhanced MPV window, titlebar and taskbar button the custom emerald
  icon (assets/enhanced-mpv.ico, copied next to this config by the installer) and
  the clean "Enhanced MPV" title the moment playback starts.

  Native mpv owns the window directly; this script applies the custom icon and
  reinforces the Enhanced MPV title on startup and when the media title changes.
  On Windows 11, applies DWM dark titlebar (#0E1014) and thin neon-green (#4ADE80)
  window border accent via DwmSetWindowAttribute.

  Windows only. On macOS / Linux, or on any Lua build without LuaJIT FFI, the
  script returns immediately and has zero effect. Every native call is wrapped in
  pcall and all work happens on timers, so it can never block or break playback.
]]

local mp = require("mp")

-- No FFI (plain Lua / Lua 5.2+) or not Windows: do nothing at all.
local has_ffi, ffi = pcall(require, "ffi")
if not has_ffi or not ffi then return end
if not (jit and jit.os == "Windows") then return end

local WM_SETICON = 0x0080
local ICON_SMALL = 0
local ICON_BIG = 1
local IMAGE_ICON = 1
local LR_LOADFROMFILE = 0x00000010

-- Window show/restore/foreground constants
local SW_RESTORE = 9
local HWND_TOPMOST = -1
local HWND_NOTOPMOST = -2
local SWP_NOSIZE = 0x0001
local SWP_NOMOVE = 0x0002
local SWP_SHOWWINDOW = 0x0040

-- DWM Window Attributes for Windows 11 dark titlebar + neon border
-- DWMWA_USE_IMMERSIVE_DARK_MODE = 20 (for dark titlebar background)
-- DWMWA_CAPTION_COLOR = 35 (titlebar background color)
-- DWMWA_BORDER_COLOR = 34 (window border color)
local DWMWA_USE_IMMERSIVE_DARK_MODE = 20
local DWMWA_CAPTION_COLOR = 35
local DWMWA_BORDER_COLOR = 34

local declared = pcall(function()
  ffi.cdef([[
    void* LoadImageW(void* hInst, const void* name, unsigned int type,
                     int cx, int cy, unsigned int fuLoad);
    long long SendMessageW(void* hWnd, unsigned int msg,
                           unsigned long long wParam, void* lParam);
    int SetWindowTextW(void* hWnd, const void* lpString);
    void* GetForegroundWindow(void);
    void* GetActiveWindow(void);
    void* FindWindowW(const void* lpClassName, const void* lpWindowName);
    int ShowWindow(void* hWnd, int nCmdShow);
    int SetWindowPos(void* hWnd, void* hWndInsertAfter, int X, int Y,
                     int cx, int cy, unsigned int uFlags);
    int SetForegroundWindow(void* hWnd);
    unsigned int GetCurrentProcessId(void);
    unsigned long GetWindowThreadProcessId(void* hWnd, void* lpdwProcessId);
    int EnumWindows(void* lpEnumFunc, void* lParam);
    int IsWindowVisible(void* hWnd);
    // DWM API for Windows 11 window chrome theming
    long DwmSetWindowAttribute(void* hwnd, unsigned int attr,
                               const void* pvAttribute, unsigned int cbAttribute);
  ]])
end)
if not declared then return end

local loaded_user32, user32 = pcall(ffi.load, "user32")
if not loaded_user32 then return end

local loaded_kernel32, kernel32 = pcall(ffi.load, "kernel32")
if not loaded_kernel32 then return end

local loaded_dwmapi, dwmapi = pcall(ffi.load, "dwmapi")
-- dwmapi may not be available on older Windows; we fail silently if so.

local self_pid = tonumber(kernel32.GetCurrentProcessId())
local cached_icon_small = nil
local cached_icon_big = nil
local cached_icon_path = nil
local dwm_applied = false
local window_revealed = false

-- UTF-8 path -> NUL-terminated UTF-16LE buffer so non-ASCII user names are
-- handled correctly by the *W APIs (surrogate pairs included).
local function wide(str)
  local out = {}
  local i, n = 1, #str
  while i <= n do
    local c = str:byte(i)
    local cp, len
    if c < 0x80 then cp, len = c, 1
    elseif c >= 0xF0 then cp, len = c % 0x08, 4
    elseif c >= 0xE0 then cp, len = c % 0x10, 3
    elseif c >= 0xC0 then cp, len = c % 0x20, 2
    else cp, len = 0xFFFD, 1 end
    for k = 1, len - 1 do
      local cc = str:byte(i + k)
      if not cc or cc < 0x80 or cc >= 0xC0 then
        cp, len = 0xFFFD, k
        break
      end
      cp = cp * 0x40 + (cc % 0x40)
    end
    i = i + len
    if cp > 0xFFFF then
      local v = cp - 0x10000
      local hi = 0xD800 + math.floor(v / 0x400)
      local lo = 0xDC00 + (v % 0x400)
      out[#out + 1] = string.char(hi % 256, math.floor(hi / 256))
      out[#out + 1] = string.char(lo % 256, math.floor(lo / 256))
    else
      out[#out + 1] = string.char(cp % 256, math.floor(cp / 256))
    end
  end
  out[#out + 1] = "\0\0"
  return table.concat(out)
end

local function pid_of(hwnd)
  local buf = ffi.new("unsigned long[1]")
  user32.GetWindowThreadProcessId(ffi.cast("void*", hwnd), buf)
  return tonumber(buf[0])
end

-- Kept at module scope: EnumWindows holds a raw pointer to the callback, so the
-- cdata must outlive the call.
local enum_hit = 0
local enum_cb = ffi.cast("int (*)(void*, void*)", function(hwnd, _)
  if enum_hit == 0 and pid_of(hwnd) == self_pid and user32.IsWindowVisible(hwnd) ~= 0 then
    enum_hit = tonumber(ffi.cast("intptr_t", hwnd))
    return 0 -- stop enumerating
  end
  return 1
end)

-- Find the player window: ask mpv first, then FindWindowW(L"mpv", NULL), then
-- the foreground / active window of this process, then enumerate every top-level
-- window owned by this process.
local function find_window()
  -- 1. Ask mpv for its window ID (most reliable)
  local wid = mp.get_property_number("window-id")
  if wid and wid ~= 0 then return wid end

  -- 2. Use FindWindowW with the mpv window class name (fast, no enumeration)
  local hwnd = user32.FindWindowW(wide("mpv"), nil)
  if hwnd and hwnd ~= nil then
    local h = tonumber(ffi.cast("intptr_t", hwnd))
    if pid_of(h) == self_pid then return h end
  end

  -- 3. Fallback: foreground/active window of this process
  for _, getter in ipairs({ user32.GetForegroundWindow, user32.GetActiveWindow }) do
    local h = getter()
    if h ~= nil and pid_of(h) == self_pid then
      return tonumber(ffi.cast("intptr_t", h))
    end
  end

  -- 4. Last resort: enumerate all windows owned by this process
  enum_hit = 0
  pcall(function() user32.EnumWindows(enum_cb, nil) end)
  if enum_hit ~= 0 then return enum_hit end
  return 0
end

local function icon_path()
  local p = mp.command_native({ "expand-path", "~~/enhanced-mpv.ico" })
  if not p or p == "" then return nil end
  local f = io.open(p, "rb")
  if not f then return nil end
  f:close()
  return p
end

local function title_text()
  local media = mp.get_property("media-title")
  if media and media ~= "" then return media .. " - Enhanced MPV" end
  local filename = mp.get_property("filename")
  if filename and filename ~= "" then return filename .. " - Enhanced MPV" end
  return "Enhanced MPV"
end

local function apply_icon(hwnd, path)
  if path ~= cached_icon_path then
    cached_icon_small = user32.LoadImageW(nil, wide(path), IMAGE_ICON, 16, 16, LR_LOADFROMFILE)
    cached_icon_big = user32.LoadImageW(nil, wide(path), IMAGE_ICON, 32, 32, LR_LOADFROMFILE)
    cached_icon_path = path
  end
  local h = ffi.cast("void*", hwnd)
  if cached_icon_big ~= nil then
    user32.SendMessageW(h, WM_SETICON, ICON_BIG, cached_icon_big)
  end
  if cached_icon_small ~= nil then
    user32.SendMessageW(h, WM_SETICON, ICON_SMALL, cached_icon_small)
  end
end

-- Apply DWM dark titlebar (#0E1014) and neon-green border (#4ADE80) on Windows 11
local function apply_dwm_theme(hwnd)
  if dwm_applied or not loaded_dwmapi then return end
  local h = ffi.cast("void*", hwnd)
  -- Dark mode for titlebar (Windows 10 1809+ / Windows 11)
  local dark = ffi.new("int[1]", 1)
  pcall(function()
    dwmapi.DwmSetWindowAttribute(h, DWMWA_USE_IMMERSIVE_DARK_MODE, dark, 4)
  end)
  -- Titlebar background color: #0E1014 (dark studio) -> 0x14100E in ABGR
  local caption_color = ffi.new("unsigned int[1]", 0x14100E)
  pcall(function()
    dwmapi.DwmSetWindowAttribute(h, DWMWA_CAPTION_COLOR, caption_color, 4)
  end)
  -- Window border color: #4ADE80 (neon green) -> 0x80DE4A in ABGR
  local border_color = ffi.new("unsigned int[1]", 0x80DE4A)
  pcall(function()
    dwmapi.DwmSetWindowAttribute(h, DWMWA_BORDER_COLOR, border_color, 4)
  end)
  dwm_applied = true
end

-- Reveal window to foreground immediately: ShowWindow + SetWindowPos + SetForegroundWindow
local function reveal_window(hwnd)
  if window_revealed then return end
  local h = ffi.cast("void*", hwnd)
  pcall(function()
    user32.ShowWindow(h, SW_RESTORE)
    user32.SetWindowPos(h, ffi.cast("void*", HWND_TOPMOST), 0, 0, 0, 0,
      SWP_NOSIZE + SWP_NOMOVE + SWP_SHOWWINDOW)
    user32.SetWindowPos(h, ffi.cast("void*", HWND_NOTOPMOST), 0, 0, 0, 0,
      SWP_NOSIZE + SWP_NOMOVE + SWP_SHOWWINDOW)
    user32.SetForegroundWindow(h)
  end)
  window_revealed = true
end

local function do_apply()
  local hwnd = find_window()
  if not hwnd or hwnd == 0 then return end
  reveal_window(hwnd)
  local path = icon_path()
  if path then pcall(apply_icon, hwnd, path) end
  pcall(function()
    user32.SetWindowTextW(ffi.cast("void*", hwnd), wide(title_text()))
  end)
  -- Apply DWM theme (fails silently on older Windows)
  pcall(apply_dwm_theme, hwnd)
end

local function reapply()
  pcall(do_apply)
end

-- Handle script-message bring-to-front from mpv-launcher.js (a reused window
-- must surface again even after it was revealed once).
mp.register_script_message("bring-to-front", function()
  window_revealed = false
  pcall(do_apply)
end)

-- IMMEDIATE reveal at script load (top-level) for <100ms window popup
-- Run once immediately, then again on vo-configured when GPU window is ready
mp.add_timeout(0, reapply)

mp.register_event("file-loaded", reapply)
mp.register_event("video-reconfig", reapply)
mp.register_event("start-file", reapply)
mp.register_event("vo-configured", reapply)
mp.observe_property("media-title", "string", reapply)
mp.observe_property("window-id", "number", reapply)
mp.observe_property("idle-active", "bool", reapply)

-- Apply after native mpv has created its window and media title.
for _, delay in ipairs({ 0.05, 0.15, 0.5, 1.2, 2.5 }) do
  mp.add_timeout(delay, reapply)
end
