--[[
  enhanced-mpv.lua
  uosc menus, dual subs, night mode, bookmarks, next-episode HUD,
  drag-drop playlists, clipboard watch, speed, A-B loop, profiles.
]]

local mp = require("mp")
local msg = require("mp.msg")
local utils = require("mp.utils")
local options = require("mp.options")

local opts = {
  clipboard_watch = false,
  next_episode_seconds = 30,
  clipboard_poll = 2,
}
options.read_options(opts, "enhanced_mpv")

local bookmarks = {}
local clipboard_timer = nil
local last_clip = ""
local dual_on = false
local night_on = false
local next_shown = false
local overlay = mp.create_osd_overlay("ass-events")

local VIDEO_EXT = {
  mkv = true, mp4 = true, webm = true, avi = true, mov = true, m4v = true,
  ts = true, m2ts = true, wmv = true, flv = true, mpeg = true, mpg = true,
  ogv = true, m3u8 = true, mpd = true,
}

local function expand(p)
  return mp.command_native({ "expand-path", p })
end

local function home_dir()
  return expand("~")
end

local function cfg_dir()
  return utils.join_path(home_dir(), ".enhanced-mpv")
end

local function toast(t, s)
  mp.osd_message(t, s or 2)
end

local function platform_name()
  local p = mp.get_property_native("platform")
  if p then return p end
  if package.config:sub(1, 1) == "\\" then return "windows" end
  return "linux"
end

local function read_file(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  local d = f:read("*a")
  f:close()
  return d
end

local function write_file(path, data)
  local f = io.open(path, "wb")
  if not f then return false end
  f:write(data)
  f:close()
  return true
end

local function load_json(path)
  local raw = read_file(path)
  if not raw or raw == "" then return nil end
  return utils.parse_json(raw)
end

local function save_json(path, obj)
  local encoded = utils.format_json(obj)
  return write_file(path, encoded or "{}")
end

local function user_config()
  return load_json(utils.join_path(cfg_dir(), "config.json")) or {}
end

-- Warm standby: when keepWarm=true in config, 'q' should stop playback
-- and return to idle (force-window=no) instead of quitting mpv.
local function warm_standby_quit()
  local cfg = user_config()
  if cfg.keepWarm then
    -- "stop" unloads the file, so save-position-on-quit never fires; save first.
    mp.commandv("write-watch-later-config")
    mp.commandv("stop")
    mp.set_property("force-window", "no")
    mp.set_property("window-minimized", "yes")
    return
  end
  mp.commandv("quit")
end

local function run_async(args, timeout, cb)
  mp.command_native_async({
    name = "subprocess",
    args = args,
    playback_only = false,
    capture_stdout = true,
    capture_stderr = true,
    timeout = timeout or 30,
  }, function(success, result, err)
    cb(success, result, err)
  end)
end

local function open_uosc_menu(menu)
  local json = utils.format_json(menu)
  if json then
    mp.commandv("script-message-to", "uosc", "open-menu", json)
  end
end

local function natural_key(name)
  local parts = {}
  local i = 1
  local s = string.lower(name)
  while i <= #s do
    local a, b = s:find("%d+", i)
    if a == i then
      parts[#parts + 1] = tonumber(s:sub(a, b))
      i = b + 1
    elseif a then
      parts[#parts + 1] = s:sub(i, a - 1)
      i = a
    else
      parts[#parts + 1] = s:sub(i)
      break
    end
  end
  return parts
end

local function natural_less(a, b)
  local ka, kb = natural_key(a), natural_key(b)
  local n = math.min(#ka, #kb)
  for i = 1, n do
    local x, y = ka[i], kb[i]
    local nx, ny = type(x) == "number", type(y) == "number"
    if nx and ny then
      if x ~= y then return x < y end
    elseif nx ~= ny then
      return nx
    else
      if x ~= y then return x < y end
    end
  end
  return #ka < #kb
end

local function collect_videos(dir, acc)
  acc = acc or {}
  local names = utils.readdir(dir, "files") or {}
  for _, name in ipairs(names) do
    local ext = name:match("%.([%w]+)$")
    if ext and VIDEO_EXT[string.lower(ext)] then
      acc[#acc + 1] = utils.join_path(dir, name)
    end
  end
  local subs = utils.readdir(dir, "dirs") or {}
  for _, name in ipairs(subs) do
    if name ~= "." and name ~= ".." then
      collect_videos(utils.join_path(dir, name), acc)
    end
  end
  return acc
end

local function load_folder_playlist(dir)
  local files = collect_videos(dir, {})
  table.sort(files, natural_less)
  if #files == 0 then
    toast("No video files in folder", 2)
    return
  end
  mp.commandv("loadfile", files[1], "replace")
  for i = 2, #files do
    mp.commandv("loadfile", files[i], "append")
  end
  toast(string.format("Playlist: %d episodes", #files), 2)
end

mp.add_hook("on_load", 20, function()
  local path = mp.get_property("stream-open-filename") or mp.get_property("path")
  if not path then return end
  local info = utils.file_info(path)
  if info and info.is_dir then
    mp.set_property("stream-open-filename", "null://")
    mp.add_timeout(0.05, function()
      load_folder_playlist(path)
    end)
  end
end)

local function pick_media()
  local plat = platform_name()
  local args
  if plat == "windows" then
    args = {
      "powershell", "-NoProfile", "-STA", "-Command",
      [=[
        [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
        Add-Type -AssemblyName System.Windows.Forms
        $d = New-Object System.Windows.Forms.OpenFileDialog
        $d.Filter = "Media (*.mkv;*.mp4;*.webm;*.avi;*.mov;*.m3u8;*.mpd)|*.mkv;*.mp4;*.webm;*.avi;*.mov;*.m3u8;*.mpd;*.m4v;*.ts|All files (*.*)|*.*"
        $d.Title = "Open Media File"
        if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }
      ]=],
    }
  elseif plat == "darwin" then
    args = { "osascript", "-e", 'POSIX path of (choose file with prompt "Open Media File")' }
  else
    args = { "zenity", "--file-selection", "--title=Open Media File" }
  end
  run_async(args, 120, function(success, result)
    local path = success and result and result.stdout or ""
    path = path:gsub("%s+$", "")
    if path == "" and plat == "linux" then
      run_async({ "kdialog", "--getopenfilename", "." }, 120, function(ok, res)
        local p = ok and res and res.stdout or ""
        p = p:gsub("%s+$", "")
        if p ~= "" then mp.commandv("loadfile", p, "replace") end
      end)
      return
    end
    if path ~= "" then mp.commandv("loadfile", path, "replace") end
  end)
end

local function open_url_prompt()
  local plat = platform_name()
  local args
  if plat == "windows" then
    args = {
      "powershell", "-NoProfile", "-Command",
      [[
        [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
        Add-Type -AssemblyName Microsoft.VisualBasic
        $clip = ''
        try { $clip = Get-Clipboard -Raw } catch {}
        $u = [Microsoft.VisualBasic.Interaction]::InputBox('Paste a streaming URL','Open URL', $clip)
        [Console]::Out.Write($u)
      ]],
    }
  elseif plat == "darwin" then
    args = {
      "osascript", "-e",
      'text returned of (display dialog "Paste a streaming URL" default answer "" with title "Open URL")',
    }
  else
    args = { "zenity", "--entry", "--title=Open URL", "--text=Paste a streaming URL" }
  end
  run_async(args, 120, function(success, result)
    local url = success and result and result.stdout or ""
    url = url:gsub("%s+$", ""):gsub("^%s+", "")
    if url == "" and plat == "linux" then
      run_async({ "kdialog", "--inputbox", "Paste a streaming URL" }, 120, function(ok, res)
        local u = ok and res and res.stdout or ""
        u = u:gsub("%s+$", "")
        if u ~= "" then mp.commandv("loadfile", u, "replace") end
      end)
      return
    end
    if url ~= "" then mp.commandv("loadfile", url, "replace") end
  end)
end

local function bookmarks_path()
  return utils.join_path(cfg_dir(), "bookmarks.json")
end

local function load_bookmarks()
  bookmarks = load_json(bookmarks_path()) or {}
  if type(bookmarks) ~= "table" then bookmarks = {} end
end

local function save_bookmark()
  load_bookmarks()
  local path = mp.get_property("path") or ""
  local title = mp.get_property("media-title") or path
  local pos = mp.get_property_number("time-pos") or 0
  bookmarks[#bookmarks + 1] = {
    path = path,
    title = title,
    time = pos,
    note = string.format("%s @ %.1fs", title, pos),
    created = os.date("!%Y-%m-%dT%H:%M:%SZ"),
  }
  save_json(bookmarks_path(), bookmarks)
  toast("Bookmark saved", 1.5)
end

local function show_bookmarks()
  load_bookmarks()
  local items = {}
  for i, b in ipairs(bookmarks) do
    items[#items + 1] = {
      title = b.note or b.title or "Bookmark",
      hint = tostring(math.floor(b.time or 0)) .. "s",
      value = { "script-message-to", "enhanced_mpv", "jump-bookmark", tostring(i) },
    }
  end
  if #items == 0 then
    items[1] = { title = "No bookmarks yet", italic = true, muted = true, value = "ignore" }
  end
  open_uosc_menu({ type = "enhanced-bookmarks", title = "Bookmarks", items = items, search_style = "on_demand" })
end

local function jump_bookmark(index)
  load_bookmarks()
  local b = bookmarks[tonumber(index)]
  if not b then return end
  local path = mp.get_property("path")
  if b.path and path ~= b.path then
    mp.commandv("loadfile", b.path, "replace")
    mp.add_timeout(0.8, function()
      mp.set_property_number("time-pos", b.time or 0)
    end)
  else
    mp.set_property_number("time-pos", b.time or 0)
  end
end

local function set_speed(v)
  mp.set_property_number("speed", v)
  toast(string.format("Speed %.2fx", v), 1)
end

local function toggle_night()
  night_on = not night_on
  if night_on then
    mp.commandv("apply-profile", "night-mode")
    toast("Night Mode on", 1.5)
  else
    mp.set_property("af", "")
    toast("Night Mode off", 1.5)
  end
end

local function toggle_hwdec()
  local cur = mp.get_property("hwdec")
  if cur == "no" or cur == "false" then
    mp.set_property("hwdec", "auto-safe")
    toast("Hardware decoding on", 1.5)
  else
    mp.commandv("apply-profile", "software-fallback")
    toast("Software decoding (subtitle-safe)", 1.5)
  end
end

local function toggle_dual()
  local tracks = mp.get_property_native("track-list") or {}
  local subs = {}
  local primary
  for _, t in ipairs(tracks) do
    if t.type == "sub" then
      subs[#subs + 1] = t
      if t.selected then primary = t.id end
    end
  end
  if dual_on then
    mp.set_property("secondary-sid", "no")
    dual_on = false
    toast("Dual subtitles off", 1.5)
    return
  end
  if #subs < 2 then
    toast("Need two subtitle tracks", 2)
    return
  end
  local second
  for _, t in ipairs(subs) do
    if t.id ~= primary then
      second = t.id
      break
    end
  end
  if not second then
    toast("Need two subtitle tracks", 2)
    return
  end
  mp.set_property("secondary-sid", tostring(second))
  mp.set_property_number("secondary-sub-pos", 8)
  dual_on = true
  toast("Dual subtitles on", 1.5)
end

local function reload_stream()
  local path = mp.get_property("path")
  local pos = mp.get_property_number("time-pos") or 0
  if not path then return end
  -- The loadfile options argument moved (mpv 0.38 added an index), so seek
  -- after the reload instead of passing start= positionally.
  local function seek_back()
    mp.unregister_event(seek_back)
    if pos > 0 then mp.commandv("seek", tostring(pos), "absolute+exact") end
  end
  mp.register_event("file-loaded", seek_back)
  mp.commandv("loadfile", path, "replace")
  toast("Reloading stream...", 1.5)
end

local function apply_profile(name)
  mp.commandv("apply-profile", name)
  toast("Profile: " .. name, 1.5)
end

local function profile_menu()
  local cfg = user_config()
  local items = {
    { title = "Balanced", value = { "script-message-to", "enhanced_mpv", "apply-profile", "enhanced-default" } },
    { title = "Anime Upscale", value = { "script-message-to", "enhanced_mpv", "apply-profile", "anime-upscale" } },
    { title = "Battery Saver", value = { "script-message-to", "enhanced_mpv", "apply-profile", "battery-saver" } },
    { title = "Cinema HDR", value = { "script-message-to", "enhanced_mpv", "apply-profile", "cinema-hdr" } },
    { title = "Software Fallback", value = { "script-message-to", "enhanced_mpv", "apply-profile", "software-fallback" } },
  }
  if cfg.profiles then
    for _, p in ipairs(cfg.profiles) do
      if p.name and p.mpvProfile then
        items[#items + 1] = {
          title = p.name,
          value = { "script-message-to", "enhanced_mpv", "apply-profile", p.mpvProfile },
        }
      end
    end
  end
  open_uosc_menu({ type = "enhanced-profiles", title = "mpv profiles", items = items })
end

local function delay_menu()
  open_uosc_menu({
    type = "enhanced-sub-delay",
    title = "Subtitle delay",
    items = {
      { title = "-0.1s", hint = "z", value = { "add", "sub-delay", "-0.1" } },
      { title = "+0.1s", hint = "x", value = { "add", "sub-delay", "0.1" } },
      { title = "Reset delay", hint = "Ctrl+Z", value = { "set", "sub-delay", "0" } },
      { title = "-1.0s", value = { "add", "sub-delay", "-1" } },
      { title = "+1.0s", value = { "add", "sub-delay", "1" } },
    },
  })
end

local function parse_srt(data)
  local cues = {}
  local t0, t1, text
  local function flush()
    if t0 and text and text ~= "" then
      cues[#cues + 1] = { start = t0, ["end"] = t1, text = text:gsub("\n", " "):gsub("<.->", "") }
    end
    t0, t1, text = nil, nil, nil
  end
  for line in (data .. "\n"):gmatch("(.-)\n") do
    line = line:gsub("\r", "")
    local a1, b1, a2, b2, c1, d1, c2, d2 =
      line:match("(%d%d):(%d%d):(%d%d),(%d%d%d)%s*%-%-%>%s*(%d%d):(%d%d):(%d%d),(%d%d%d)")
    if not a1 then
      a1, b1, a2, b2, c1, d1, c2, d2 =
        line:match("(%d%d):(%d%d):(%d%d)%.(%d%d%d)%s*%-%-%>%s*(%d%d):(%d%d):(%d%d)%.(%d%d%d)")
    end
    if a1 then
      flush()
      t0 = tonumber(a1) * 3600 + tonumber(b1) * 60 + tonumber(a2) + tonumber(b2) / 1000
      t1 = tonumber(c1) * 3600 + tonumber(d1) * 60 + tonumber(c2) + tonumber(d2) / 1000
      text = ""
    elseif line == "" then
      flush()
    elseif t0 and not line:match("^%d+$") then -- skip bare cue indices
      text = (text == "" or not text) and line or (text .. " " .. line)
    end
  end
  flush()
  return cues
end

local function parse_ass(data)
  local cues = {}
  for line in data:gmatch("[^\n]+") do
    local start, _, text = line:match("^Dialogue:[^,]*,([^,]+),([^,]+),.-,,.-,,.-,,.-,,(.*)$")
    if start and text then
      local h, m, s, cs = start:match("(%d+):(%d+):(%d+)%.?(%d*)")
      if h then
        local t0 = tonumber(h) * 3600 + tonumber(m) * 60 + tonumber(s) + (tonumber(cs) or 0) / 100
        text = text:gsub("{[^}]*}", ""):gsub("\\N", " ")
        cues[#cues + 1] = { start = t0, text = text }
      end
    end
  end
  return cues
end

local function current_external_sub()
  local tracks = mp.get_property_native("track-list") or {}
  for _, t in ipairs(tracks) do
    if t.type == "sub" and t.selected and t.external and t["external-filename"] then
      return t["external-filename"]
    end
  end
  return nil
end

local function search_dialogue()
  local path = current_external_sub()
  if not path then
    toast("No external subtitle loaded", 2)
    return
  end
  local data = read_file(path)
  if not data then
    toast("Could not read subtitle file", 2)
    return
  end
  local cues
  if path:match("%.ass$") or path:match("%.ssa$") then
    cues = parse_ass(data)
  else
    cues = parse_srt(data)
  end
  local items = {}
  for _, c in ipairs(cues) do
    items[#items + 1] = {
      title = c.text,
      hint = string.format("%02d:%02d:%02d", math.floor(c.start / 3600), math.floor(c.start / 60) % 60, math.floor(c.start) % 60),
      value = { "script-message-to", "enhanced_mpv", "jump-time", string.format("%.3f", c.start) },
    }
  end
  open_uosc_menu({
    type = "enhanced-sub-search",
    title = "Search dialogue",
    items = items,
    search_style = "palette",
  })
end

local function hide_next_hud()
  overlay.data = ""
  overlay:update()
  next_shown = false
end

local function show_next_hud(seconds)
  local n = math.max(0, math.floor(seconds + 0.5))
  overlay.data = string.format(
    "{\\an9\\fs28\\b1\\bord2\\shad1\\1c&HFFFFFF&\\3c&H000000&}Next Episode  %ds   [E]",
    n
  )
  overlay:update()
  next_shown = true
end

mp.observe_property("time-remaining", "number", function(_, rem)
  local count = mp.get_property_number("playlist-count") or 0
  local pos = mp.get_property_number("playlist-pos") or 0
  if not rem or count <= pos + 1 then
    if next_shown then hide_next_hud() end
    return
  end
  if rem <= opts.next_episode_seconds and rem > 0 then
    show_next_hud(rem)
  elseif next_shown then
    hide_next_hud()
  end
end)

local function next_episode_now()
  hide_next_hud()
  mp.commandv("playlist-next", "weak")
end

local function looks_like_media_url(s)
  if not s or #s < 8 or #s > 4000 then return false end
  s = s:gsub("^%s+", ""):gsub("%s+$", "")
  if s:find("\n") then return false end
  if s:match("^https?://") then
    return s:match("%.m3u8") or s:match("%.mpd") or s:match("%.mp4") or s:match("%.mkv")
      or s:match("%.webm") or s:match("youtu%.be") or s:match("youtube%.com")
      or s:match("vimeo%.com") or s:match("twitch%.tv")
      or s:match("/video") or s:match("stream")
  end
  return false
end

local function clipboard_command()
  local plat = platform_name()
  if plat == "windows" then
    return { "powershell", "-NoProfile", "-Command", "try { Get-Clipboard -Raw } catch { }" }
  elseif plat == "darwin" then
    return { "pbpaste" }
  end
  return { "xclip", "-selection", "clipboard", "-o" }
end

local function poll_clipboard()
  run_async(clipboard_command(), 3, function(success, result)
    if not success or not result or not result.stdout then return end
    local clip = result.stdout:gsub("%s+$", "")
    if clip == last_clip then return end
    last_clip = clip
    if looks_like_media_url(clip) then
      toast("Clipboard URL — press Ctrl+L to open", 3)
      mp.commandv("script-message-to", "uosc", "flash-ui")
    end
  end)
end

local function start_clipboard_watch()
  if clipboard_timer then return end
  clipboard_timer = mp.add_periodic_timer(opts.clipboard_poll, poll_clipboard)
  toast("Clipboard Watch on", 1.5)
end

local function stop_clipboard_watch()
  if clipboard_timer then
    clipboard_timer:stop()
    clipboard_timer = nil
  end
  toast("Clipboard Watch off", 1.5)
end

local function toggle_clipboard()
  if clipboard_timer then stop_clipboard_watch() else start_clipboard_watch() end
end

local function toggle_ab()
  local a = mp.get_property("ab-loop-a")
  local b = mp.get_property("ab-loop-b")
  if a == "no" then
    mp.set_property("ab-loop-a", mp.get_property("time-pos"))
    toast("A-B: point A", 1)
  elseif b == "no" then
    mp.set_property("ab-loop-b", mp.get_property("time-pos"))
    toast("A-B: looping", 1)
  else
    mp.set_property("ab-loop-a", "no")
    mp.set_property("ab-loop-b", "no")
    toast("A-B cleared", 1)
  end
end

local function screenshot_subs()
  local dir = expand("~/Pictures/mpv-shots")
  mp.set_property("screenshot-directory", dir)
  mp.commandv("screenshot", "subtitles")
  toast("Screenshot saved", 1.5)
end

local function main_menu()
  open_uosc_menu({
    type = "enhanced-main",
    title = "Enhanced MPV",
    search_style = "on_demand",
    items = {
      { title = "Open Media File", hint = "Ctrl+O", icon = "folder_open", value = { "script-binding", "enhanced_mpv/open_media" } },
      { title = "Open URL", hint = "Ctrl+L", icon = "link", value = { "script-binding", "enhanced_mpv/open_url" } },
      { title = "Open Subtitle File", icon = "subtitles", value = { "script-message-to", "smart_sub_manager", "open-subtitle-file" } },
      { title = "Search Subtitles", hint = "Alt+S", icon = "manage_search", value = { "script-message-to", "smart_sub_manager", "search-subtitles" } },
      { title = "Auto-Sync Subtitles", hint = "Alt+Y", icon = "sync_alt", value = { "script-message-to", "smart_sub_manager", "autosync" } },
      { title = "Search dialogue", hint = "/", icon = "search", value = { "script-binding", "enhanced_mpv/search_subtitles_text" } },
      { title = "Subtitle delay", items = {
          { title = "-0.1s", hint = "z", value = { "add", "sub-delay", "-0.1" } },
          { title = "+0.1s", hint = "x", value = { "add", "sub-delay", "0.1" } },
          { title = "Reset Delay", value = { "set", "sub-delay", "0" } },
        }
      },
      { title = "Dual subtitles", hint = "Alt+D", value = { "script-binding", "enhanced_mpv/toggle_dual_subs" } },
      { title = "Night Mode", hint = "Alt+N", icon = "bedtime", value = { "script-binding", "enhanced_mpv/toggle_night_mode" } },
      { title = "Hardware decode toggle", hint = "Alt+H", value = { "script-binding", "enhanced_mpv/toggle_hwdec" } },
      { title = "Reload Current Stream", hint = "Alt+R", icon = "replay", value = { "script-binding", "enhanced_mpv/reload_stream" } },
      { title = "A-B Loop", hint = "L", value = { "script-binding", "enhanced_mpv/ab_loop" } },
      { title = "Speed", items = {
          { title = "0.5x", hint = "1", value = { "script-binding", "enhanced_mpv/speed_05" } },
          { title = "1.0x", hint = "2", value = { "script-binding", "enhanced_mpv/speed_10" } },
          { title = "1.25x", hint = "3", value = { "script-binding", "enhanced_mpv/speed_125" } },
          { title = "1.5x", hint = "4", value = { "script-binding", "enhanced_mpv/speed_15" } },
          { title = "2.0x", hint = "5", value = { "script-binding", "enhanced_mpv/speed_20" } },
        }
      },
      { title = "Profiles", icon = "tune", value = { "script-binding", "enhanced_mpv/profile_menu" } },
      { title = "Bookmarks", hint = "Ctrl+B", icon = "bookmark", value = { "script-binding", "enhanced_mpv/show_bookmarks" } },
      { title = "Save bookmark", value = { "script-binding", "enhanced_mpv/save_bookmark" } },
      { title = "Screenshot with Subtitles", hint = "Ctrl+S", value = { "script-binding", "enhanced_mpv/screenshot_subs" } },
      { title = "Clipboard Watch Mode", value = { "script-binding", "enhanced_mpv/toggle_clipboard" } },
      { title = "Next Episode", hint = "E", value = { "script-binding", "enhanced_mpv/next_episode_now" } },
    },
  })
end

mp.add_key_binding("ctrl+o", "open_media", pick_media)
mp.add_key_binding("ctrl+l", "open_url", open_url_prompt)
mp.add_key_binding(nil, "open_subtitle", function()
  mp.commandv("script-message-to", "smart_sub_manager", "open-subtitle-file")
end)
mp.add_key_binding("ctrl+b", "save_bookmark", save_bookmark)
mp.add_key_binding("ctrl+shift+b", "show_bookmarks", show_bookmarks)
mp.add_key_binding("alt+d", "toggle_dual_subs", toggle_dual)
mp.add_key_binding("alt+n", "toggle_night_mode", toggle_night)
mp.add_key_binding("alt+h", "toggle_hwdec", toggle_hwdec)
mp.add_key_binding("alt+r", "reload_stream", reload_stream)
mp.add_key_binding("e", "next_episode_now", next_episode_now)
mp.add_key_binding("/", "search_subtitles_text", search_dialogue)
mp.add_key_binding("ctrl+s", "screenshot_subs", screenshot_subs)
mp.add_key_binding(nil, "speed_05", function() set_speed(0.5) end)
mp.add_key_binding(nil, "speed_10", function() set_speed(1.0) end)
mp.add_key_binding(nil, "speed_125", function() set_speed(1.25) end)
mp.add_key_binding(nil, "speed_15", function() set_speed(1.5) end)
mp.add_key_binding(nil, "speed_20", function() set_speed(2.0) end)
mp.add_key_binding(nil, "profile_menu", profile_menu)
mp.add_key_binding(nil, "show_bookmarks", show_bookmarks)
mp.add_key_binding(nil, "toggle_clipboard", toggle_clipboard)
mp.add_key_binding(nil, "ab_loop", toggle_ab)
mp.add_key_binding(nil, "main_menu", main_menu)
mp.add_key_binding(nil, "delay_menu", delay_menu)
mp.add_key_binding(nil, "warm_standby_quit", warm_standby_quit)

mp.register_script_message("jump-bookmark", jump_bookmark)
mp.register_script_message("jump-time", function(t)
  mp.set_property_number("time-pos", tonumber(t) or 0)
end)
mp.register_script_message("apply-profile", apply_profile)
mp.register_script_message("open-media", pick_media)
mp.register_script_message("open-url", open_url_prompt)

mp.register_event("file-loaded", function()
  hide_next_hud()
  dual_on = false
  local cfg = user_config()
  if cfg.clipboardWatch or opts.clipboard_watch then
    start_clipboard_watch()
  end
end)

mp.register_event("end-file", hide_next_hud)

msg.info("enhanced-mpv controls loaded")
