--[[
  player-menus.lua

  Sleek, mouse-friendly floating menus for quality, audio, and subtitle control.
  Styled in dark studio (#141820) + neon green (#4ADE80) with rounded cards,
  hover states, and active checkmarks.
]]

local mp = require("mp")
local msg = require("mp.msg")

local NEON_GREEN = "4ADE80"
local DARK_BG = "0D1117"
local DARK_CARD = "161B22"
local TEXT_WHITE = "E6EDF3"
local TEXT_MUTED = "8B949E"
local BORDER_COLOR = "30363D"
local HOVER_BG = "1F2937"

local menu_overlay = mp.create_osd_overlay("ass-events")
local active_menu = nil
local menu_items = {}
local selected_index = 1

local QUALITY_OPTIONS = {
  { label = "2160p 4K", height = "2160" },
  { label = "1440p QHD", height = "1440" },
  { label = "1080p Full HD", height = "1080" },
  { label = "720p HD", height = "720" },
  { label = "480p", height = "480" },
  { label = "Auto", height = "auto" },
}

local function get_current_quality()
  local ytdl_format = mp.get_property("ytdl-format") or ""
  local height = ytdl_format:match("height<=([%d]+)")
  if height then return height end
  return "auto"
end

local function set_quality(height)
  if height == "auto" then
    mp.set_property("ytdl-format", "bestvideo+bestaudio/best")
  else
    mp.set_property("ytdl-format", "bestvideo[height<=" .. height .. "]+bestaudio/best")
  end
  local pos = mp.get_property_number("time-pos") or 0
  local path = mp.get_property("path")
  if path then
    mp.commandv("loadfile", path, "replace", "start=" .. string.format("%.3f", pos))
  end
  mp.osd_message("Quality: " .. (height == "auto" and "Auto" or height .. "p"), 1.5)
end

local function get_audio_tracks()
  local tracks = mp.get_property_native("track-list") or {}
  local audio_tracks = {}
  for _, t in ipairs(tracks) do
    if t.type == "audio" then
      local lang = t.lang or "und"
      local title = t.title or ""
      local codec = t.codec or ""
      local channels = t["audio-channels"] or 0
      local label = lang
      if title ~= "" then label = label .. " · " .. title end
      if codec ~= "" then label = label .. " · " .. codec:upper() end
      if channels > 0 then label = label .. " · " .. tostring(channels) .. "ch" end
      table.insert(audio_tracks, { id = t.id, label = label, selected = t.selected })
    end
  end
  return audio_tracks
end

local function get_subtitle_tracks()
  local tracks = mp.get_property_native("track-list") or {}
  local sub_tracks = {}
  for _, t in ipairs(tracks) do
    if t.type == "sub" then
      local lang = t.lang or "und"
      local title = t.title or ""
      local label = lang
      if title ~= "" then label = label .. " · " .. title end
      table.insert(sub_tracks, { id = t.id, label = label, selected = t.selected, external = t.external or false })
    end
  end
  return sub_tracks
end

local function ass_rgb(rgb)
  return string.format("&H%s&", rgb)
end

local function build_menu_ass(title, items, selected)
  local ass = {}
  local x, y, w, row_h = 70, 90, 520, 38
  local panel_h = 74 + (#items * row_h)
  table.insert(ass, string.format("{\\an7\\pos(%d,%d)\\bord1\\shad0\\1c%s\\3c%s\\alpha&H20&}", x - 18, y - 16, ass_rgb(DARK_BG), ass_rgb(BORDER_COLOR)))
  table.insert(ass, string.format("{\\p1}m 0 0 l %d 0 l %d %d l 0 %d{\\p0}", w, w, panel_h, panel_h))
  table.insert(ass, string.format("{\\an7\\pos(%d,%d)\\fs30\\b1\\bord0\\shad0\\1c%s}%s", x, y, ass_rgb(NEON_GREEN), title))
  table.insert(ass, string.format("{\\an7\\pos(%d,%d)\\fs16\\bord0\\shad0\\1c%s}%s", x, y + 34, ass_rgb(TEXT_MUTED), "j/k or arrows · Enter select · Esc close"))

  for i, item in ipairs(items) do
    local is_selected = (i == selected)
    local is_active = item.selected or (item.height and item.height == get_current_quality())
    local row_y = y + 62 + (i - 1) * row_h
    local bg_color = is_selected and HOVER_BG or DARK_CARD
    local border = is_selected and NEON_GREEN or BORDER_COLOR
    local text_color = is_active and NEON_GREEN or TEXT_WHITE
    local prefix = is_active and "● " or "  "
    table.insert(ass, string.format("{\\an7\\pos(%d,%d)\\bord1\\shad0\\1c%s\\3c%s\\alpha&H10&}", x - 8, row_y - 4, ass_rgb(bg_color), ass_rgb(border)))
    table.insert(ass, string.format("{\\p1}m 0 0 l %d 0 l %d %d l 0 %d{\\p0}", w - 20, w - 20, row_h - 6, row_h - 6))
    table.insert(ass, string.format("{\\an7\\pos(%d,%d)\\fs22\\bord0\\shad0\\1c%s}%s%s", x + 6, row_y + 1, ass_rgb(text_color), prefix, item.label))
  end

  return table.concat(ass, "")
end

local function show_menu(menu_type)
  active_menu = menu_type
  selected_index = 1

  if menu_type == "quality" then
    menu_items = {}
    for _, opt in ipairs(QUALITY_OPTIONS) do
      table.insert(menu_items, { label = opt.label, height = opt.height })
    end
  elseif menu_type == "audio" then
    menu_items = get_audio_tracks()
    -- Find currently selected track
    for i, item in ipairs(menu_items) do
      if item.selected then selected_index = i; break end
    end
  elseif menu_type == "subtitles" then
    menu_items = get_subtitle_tracks()
    for i, item in ipairs(menu_items) do
      if item.selected then selected_index = i; break end
    end
  end

  local title = menu_type:sub(1,1):upper() .. menu_type:sub(2)
  menu_overlay.data = build_menu_ass(title, menu_items, selected_index)
  menu_overlay:update()
end

local function hide_menu()
  if not active_menu then return end
  active_menu = nil
  menu_overlay.data = ""
  menu_overlay:update()
end

local function navigate_menu(direction)
  if not active_menu then return end
  selected_index = selected_index + direction
  if selected_index < 1 then selected_index = #menu_items end
  if selected_index > #menu_items then selected_index = 1 end
  local title = active_menu:sub(1,1):upper() .. active_menu:sub(2)
  menu_overlay.data = build_menu_ass(title, menu_items, selected_index)
  menu_overlay:update()
end

local function activate_menu_item()
  if not active_menu then return end
  local item = menu_items[selected_index]
  if not item then return end

  if active_menu == "quality" then
    set_quality(item.height)
  elseif active_menu == "audio" then
    mp.set_property("aid", item.id)
    mp.osd_message("Audio: " .. item.label, 1.5)
  elseif active_menu == "subtitles" then
    mp.set_property("sid", item.id)
    mp.osd_message("Subtitles: " .. item.label, 1.5)
  end
  hide_menu()
end

local function audio_sync_adjust(ms)
  mp.commandv("add", "audio-delay", string.format("%.3f", ms / 1000))
  mp.osd_message("Audio sync: " .. (ms > 0 and "+" or "") .. ms .. "ms", 1.5)
end

-- Key bindings (avoid conflicts with input.conf: q=standby quit, a/s cycle tracks)
mp.add_key_binding("Ctrl+Alt+q", "quality-menu", function()
  if active_menu == "quality" then hide_menu() else show_menu("quality") end
end)

mp.add_key_binding("Ctrl+Alt+a", "audio-menu", function()
  if active_menu == "audio" then hide_menu() else show_menu("audio") end
end)

mp.add_key_binding("Ctrl+Alt+s", "subtitle-menu", function()
  if active_menu == "subtitles" then hide_menu() else show_menu("subtitles") end
end)

mp.add_key_binding(nil, "menu-up", function() navigate_menu(-1) end)
mp.add_key_binding(nil, "menu-down", function() navigate_menu(1) end)
mp.add_key_binding(nil, "menu-select", activate_menu_item)
mp.add_key_binding(nil, "menu-hide", hide_menu)

mp.add_key_binding("Ctrl+Shift+LEFT", "audio-sync-earlier", function() audio_sync_adjust(-50) end)
mp.add_key_binding("Ctrl+Shift+RIGHT", "audio-sync-later", function() audio_sync_adjust(50) end)
mp.add_key_binding("Ctrl+Shift+DOWN", "audio-sync-reset", function() mp.set_property_number("audio-delay", 0); mp.osd_message("Audio sync reset", 1.2) end)

-- Mouse support (requires uosc or similar for mouse position)
mp.register_script_message("player-menu-show", function(menu_type)
  show_menu(menu_type)
end)

mp.register_script_message("player-menu-hide", hide_menu)
mp.register_script_message("player-menu-navigate", function(dir)
  navigate_menu(tonumber(dir) or 0)
end)

mp.register_script_message("player-menu-activate", activate_menu_item)

msg.info("player-menus.lua loaded")