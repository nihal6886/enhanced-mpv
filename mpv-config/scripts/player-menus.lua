--[[
  player-menus.lua

  Sleek, mouse-friendly floating menus for quality, audio, and subtitle control.
  Styled in dark studio (#0D1117) + neon green (#4ADE80) with rounded cards,
  hover states, and active checkmarks.
]]

local mp = require("mp")
local msg = require("mp.msg")
local utils = require("mp.utils")

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

local sources_state = {
  title = "",
  currentUrl = "",
  currentPlayUrl = "",
  currentQuality = "Auto (Best)",
  candidates = {},
  qualities = {},
}

local QUALITY_OPTIONS = {
  { label = "2160p 4K", height = "2160" },
  { label = "1440p QHD", height = "1440" },
  { label = "1080p Full HD", height = "1080" },
  { label = "720p HD", height = "720" },
  { label = "480p", height = "480" },
  { label = "Auto", height = "auto" },
}

local function safe_ass_text(text)
  return tostring(text or ""):gsub("[\r\n]+", " "):gsub("{", "("):gsub("}", ")")
end

local function extract_host(url)
  local host = tostring(url or ""):match("^https?://([^/:]+)")
  return host or "stream"
end

local function escape_header_field(val)
  return tostring(val or ""):gsub("\\", "\\\\"):gsub(",", "\\,")
end

local function build_header_fields(headers)
  if type(headers) ~= "table" then return "" end
  local parts = {}
  for k, v in pairs(headers) do
    if v and tostring(v) ~= "" then
      table.insert(parts, escape_header_field(tostring(k) .. ": " .. tostring(v)))
    end
  end
  return table.concat(parts, ",")
end

local function apply_sources_json(raw)
  if type(raw) ~= "string" or raw == "" then return end
  local parsed = utils.parse_json(raw)
  if type(parsed) ~= "table" then return end
  sources_state.title = parsed.title or sources_state.title
  sources_state.currentUrl = parsed.currentUrl or sources_state.currentUrl
  sources_state.currentPlayUrl = parsed.currentPlayUrl or sources_state.currentPlayUrl
  if type(parsed.candidates) == "table" then
    sources_state.candidates = parsed.candidates
  end
  if type(parsed.qualities) == "table" then
    sources_state.qualities = parsed.qualities
  end
  sources_state.currentQuality = "Auto (Best)"
end

local function load_sources_file()
  local p = mp.command_native({ "expand-path", "~/.enhanced-mpv/sources.json" })
  if not p or p == "" then return end
  local f = io.open(p, "r")
  if not f then return end
  local content = f:read("*a")
  f:close()
  apply_sources_json(content)
end

local function switch_stream_item(item, is_source)
  if not item or not item.url or item.url == "" then return end
  local pos = mp.get_property_number("time-pos") or 0
  local options = {
    ytdl = "no",
    ["resume-playback"] = "no",
    ["demuxer-lavf-analyzeduration"] = "0.15",
    ["demuxer-lavf-probesize"] = "65536",
    ["cache"] = "yes",
    ["cache-secs"] = "15",
    ["demuxer-readahead-secs"] = "5",
    ["hls-bitrate"] = "max",
    start = pos > 1 and string.format("%.3f", pos) or "none",
  }
  local hdrs = build_header_fields(item.headers)
  if hdrs ~= "" then
    options["http-header-fields"] = hdrs
  end
  mp.commandv("change-list", "audio-files", "clr", "")
  if item.audioUrl and item.audioUrl ~= "" then
    mp.commandv("change-list", "demuxer-lavf-o", "append", "allowed_extensions=ALL")
    options["audio-files-append"] = item.audioUrl
  end
  if is_source then
    sources_state.currentUrl = item.url
    sources_state.currentPlayUrl = item.url
    sources_state.currentQuality = "Auto (Best)"
    if type(item.qualities) == "table" and #item.qualities > 0 then
      sources_state.qualities = item.qualities
    end
  else
    sources_state.currentPlayUrl = item.url
    sources_state.currentQuality = item.label or "Auto (Best)"
  end
  mp.command_native({ "loadfile", item.url, "replace", -1, options })
  mp.set_property_bool("pause", false)
  mp.osd_message((is_source and "Source: " or "Quality: ") .. (item.label or extract_host(item.url)), 1.8)
end

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
      if title ~= "" then label = label .. " \xC2\xB7 " .. title end
      if codec ~= "" then label = label .. " \xC2\xB7 " .. codec:upper() end
      if channels > 0 then label = label .. " \xC2\xB7 " .. tostring(channels) .. "ch" end
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
      if title ~= "" then label = label .. " \xC2\xB7 " .. title end
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
  local x, y, w, row_h = 70, 90, 620, 40
  local panel_h = 84 + (math.max(1, #items) * row_h)
  table.insert(ass, string.format("{\\an7\\pos(%d,%d)\\bord1\\shad0\\1c%s\\3c%s\\alpha&H18&}{\\p1}m 0 0 l %d 0 l %d %d l 0 %d{\\p0}", x - 18, y - 16, ass_rgb(DARK_BG), ass_rgb(BORDER_COLOR), w, w, panel_h, panel_h))
  table.insert(ass, string.format("{\\an7\\pos(%d,%d)\\fs30\\b1\\bord0\\shad0\\1c%s}%s", x, y, ass_rgb(NEON_GREEN), safe_ass_text(title)))
  table.insert(ass, string.format("{\\an7\\pos(%d,%d)\\fs16\\bord0\\shad0\\1c%s}%s", x, y + 36, ass_rgb(TEXT_MUTED), "Up/Down or j/k \xC2\xB7 Enter select \xC2\xB7 Esc close"))

  if #items == 0 then
    table.insert(ass, string.format("{\\an7\\pos(%d,%d)\\fs22\\bord0\\shad0\\1c%s}No options available", x + 6, y + 68, ass_rgb(TEXT_MUTED)))
  end

  for i, item in ipairs(items) do
    local is_selected = (i == selected)
    local is_active = item.selected or (item.height and item.height == get_current_quality())
    local row_y = y + 66 + (i - 1) * row_h
    local bg_color = is_selected and HOVER_BG or DARK_CARD
    local border = is_selected and NEON_GREEN or BORDER_COLOR
    local text_color = is_active and NEON_GREEN or TEXT_WHITE
    local prefix = is_active and "* " or "  "

    local display_label = item.label
    if item.qualities and type(item.qualities) == "table" and #item.qualities > 0 then
      local quality_lines = {}
      for _, q in ipairs(item.qualities) do
        local qlabel = q.label or "Auto"
        if q.bandwidth and q.bandwidth > 0 then
          qlabel = qlabel .. string.format(" (%.1f Mbps)", q.bandwidth / 1000000)
        end
        if qlabel == item.label or qlabel == sources_state.currentQuality or q.url == item.url then
          qlabel = "* " .. qlabel
        else
          qlabel = "  " .. qlabel
        end
        table.insert(quality_lines, qlabel)
      end
      display_label = item.label .. "\\N" .. table.concat(quality_lines, "\\N")
    elseif item.is_source and item.url and sources_state.candidates then
      local src = sources_state.candidates and sources_state.candidates[tonumber(item.label:match("^(%d+)"))]
      if src and src.qualities and type(src.qualities) == "table" and #src.qualities > 0 then
        local quality_lines = {}
        for _, q in ipairs(src.qualities) do
          local qlabel = q.label or "Auto"
          if q.bandwidth and q.bandwidth > 0 then
            qlabel = qlabel .. string.format(" (%.1f Mbps)", q.bandwidth / 1000000)
          end
          table.insert(quality_lines, "  " .. qlabel)
        end
        display_label = item.label .. "\\N" .. table.concat(quality_lines, "\\N")
      end
    end

    table.insert(ass, string.format("{\\an7\\pos(%d,%d)\\bord1\\shad0\\1c%s\\3c%s\\alpha&H10&}{\\p1}m 0 0 l %d 0 l %d %d l 0 %d{\\p0}", x - 8, row_y - 4, ass_rgb(bg_color), ass_rgb(border), w - 20, w - 20, row_h - 6, row_h - 6))
    table.insert(ass, string.format("{\\an7\\pos(%d,%d)\\fs22\\bord0\\shad0\\1c%s}%s%s", x + 6, row_y + 2, ass_rgb(text_color), prefix, safe_ass_text(display_label)))
  end

  return table.concat(ass, "\n")
end

local nav_bound = false
local hide_menu
local navigate_menu
local activate_menu_item

local function bind_menu_nav()
  if nav_bound then return end
  nav_bound = true
  mp.add_forced_key_binding("UP", "empv-menu-up", function() navigate_menu(-1) end, { repeatable = true })
  mp.add_forced_key_binding("DOWN", "empv-menu-down", function() navigate_menu(1) end, { repeatable = true })
  mp.add_forced_key_binding("k", "empv-menu-k", function() navigate_menu(-1) end, { repeatable = true })
  mp.add_forced_key_binding("j", "empv-menu-j", function() navigate_menu(1) end, { repeatable = true })
  mp.add_forced_key_binding("ENTER", "empv-menu-enter", function() activate_menu_item() end)
  mp.add_forced_key_binding("ESC", "empv-menu-esc", function() hide_menu() end)
end

local function unbind_menu_nav()
  if not nav_bound then return end
  nav_bound = false
  for _, name in ipairs({ "empv-menu-up", "empv-menu-down", "empv-menu-k", "empv-menu-j", "empv-menu-enter", "empv-menu-esc" }) do
    mp.remove_key_binding(name)
  end
end

local function show_menu(menu_type)
  active_menu = menu_type
  selected_index = 1

  if menu_type == "quality" then
    menu_items = {}
    if #sources_state.qualities > 0 then
      for _, q in ipairs(sources_state.qualities) do
        local label = q.label or "Auto (Best)"
        if q.bandwidth and q.bandwidth > 0 then
          label = label .. string.format(" (%.1f Mbps)", q.bandwidth / 1000000)
        end
        local is_active = (q.label == sources_state.currentQuality) or (q.url == sources_state.currentPlayUrl)
        table.insert(menu_items, {
          label = label,
          url = q.url,
          headers = q.headers,
          audioUrl = q.audioUrl,
          audioHeaders = q.audioHeaders,
          selected = is_active,
          is_stream = true,
        })
      end
    else
      for _, opt in ipairs(QUALITY_OPTIONS) do
        table.insert(menu_items, { label = opt.label, height = opt.height })
      end
    end
    if #sources_state.candidates > 0 then
      table.insert(menu_items, {
        label = string.format("Switch Scraped Source (%d)...", #sources_state.candidates),
        action = "open-sources",
      })
    end
  elseif menu_type == "sources" then
    menu_items = {}
    for idx, c in ipairs(sources_state.candidates) do
      local host = extract_host(c.url)
      local tag = (c.label and c.label ~= "") and c.label or (c.kind or "stream")
      local label = string.format("%d. %s \xC2\xB7 %s", idx, host, tag)
      if c.audioUrl and c.audioUrl ~= "" then label = label .. " + Audio" end
      local is_active = (c.url == sources_state.currentUrl)
      table.insert(menu_items, {
        label = label,
        url = c.url,
        headers = c.headers,
        audioUrl = c.audioUrl,
        audioHeaders = c.audioHeaders,
        qualities = c.qualities,
        selected = is_active,
        is_stream = true,
        is_source = true,
      })
    end
  elseif menu_type == "audio" then
    menu_items = get_audio_tracks()
    for i, item in ipairs(menu_items) do
      if item.selected then selected_index = i; break end
    end
  elseif menu_type == "subtitles" then
    menu_items = get_subtitle_tracks()
    for i, item in ipairs(menu_items) do
      if item.selected then selected_index = i; break end
    end
  end

  local title = menu_type == "sources" and "Scraped Sources" or (menu_type:sub(1,1):upper() .. menu_type:sub(2))
  menu_overlay.res_x = 1920
  menu_overlay.res_y = 1080
  menu_overlay.data = build_menu_ass(title, menu_items, selected_index)
  menu_overlay:update()
  bind_menu_nav()
end

hide_menu = function()
  unbind_menu_nav()
  if not active_menu then return end
  active_menu = nil
  menu_overlay.data = ""
  menu_overlay:remove()
end

navigate_menu = function(direction)
  if not active_menu or #menu_items == 0 then return end
  selected_index = selected_index + direction
  if selected_index < 1 then selected_index = #menu_items end
  if selected_index > #menu_items then selected_index = 1 end
  local title = active_menu == "sources" and "Scraped Sources" or (active_menu:sub(1,1):upper() .. active_menu:sub(2))
  menu_overlay.data = build_menu_ass(title, menu_items, selected_index)
  menu_overlay:update()
end

activate_menu_item = function()
  if not active_menu then return end
  local item = menu_items[selected_index]
  if not item then hide_menu(); return end

  if item.action == "open-sources" then
    show_menu("sources")
    return
  elseif item.is_stream then
    switch_stream_item(item, item.is_source == true)
  elseif active_menu == "quality" and item.height then
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

mp.add_key_binding("q", "quality-menu", function()
  if active_menu == "quality" then hide_menu() else show_menu("quality") end
end)

mp.add_key_binding("Q", "source-menu", function()
  if active_menu == "sources" then hide_menu() else show_menu("sources") end
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

mp.register_script_message("enhanced-mpv-sources", function(raw)
  apply_sources_json(raw)
end)

mp.register_event("file-loaded", load_sources_file)
load_sources_file()

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
