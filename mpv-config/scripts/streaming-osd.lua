-- HBO Max-inspired streaming controls for native mpv.
-- All chrome is rendered in a single ASS vector overlay; video subtitles remain
-- on mpv's independent subtitle layer.

local mp = require("mp")

local overlay = mp.create_osd_overlay("ass-events")
local visible = true
local popup = nil
local last_activity = mp.get_time()
local last_mouse_x, last_mouse_y = -1, -1
local hover_x, hover_y = -1, -1
local ui_alpha = 1
local timeline = { x = 0, y = 0, w = 0, h = 0 }
local volume_slider = { x = 0, y = 0, w = 0, h = 0 }
local popup_rows = {}

local function clamp(value, low, high)
  return math.max(low, math.min(high, value))
end

local function esc(text)
  return tostring(text or ""):gsub("\\", "\\\\"):gsub("{", "\\{"):gsub("}", "\\}"):gsub("\n", " ")
end

local function number_property(name, fallback)
  return mp.get_property_number(name, fallback or 0)
end

local function time_text(seconds)
  if not seconds or seconds ~= seconds or seconds < 0 then return "00:00" end
  seconds = math.floor(seconds)
  local hours = math.floor(seconds / 3600)
  local minutes = math.floor((seconds % 3600) / 60)
  local secs = seconds % 60
  if hours > 0 then return string.format("%d:%02d:%02d", hours, minutes, secs) end
  return string.format("%02d:%02d", minutes, secs)
end

local function media_title()
  return mp.get_property("media-title", "") or ""
end

local function add_text(parts, x, y, text, size, alpha, bold, align, color)
  local anchor = align or 7
  parts[#parts + 1] = string.format(
    "{\\an%d\\pos(%.0f,%.0f)\\fnSegoe UI\\fs%d\\b%d\\bord0\\shad0\\1c&H%s&\\1a&H%02X&}%s",
    anchor, x, y, size, bold and 1 or 0, color or "FFFFFF",
    math.floor((1 - clamp(alpha or 1, 0, 1)) * 255), esc(text))
end

local function add_rect(parts, x, y, w, h, color, alpha)
  if w <= 0 or h <= 0 then return end
  parts[#parts + 1] = string.format(
    "{\\an7\\pos(%.0f,%.0f)\\bord0\\shad0\\1c&H%s&\\1a&H%02X&\\p1}m 0 0 l %.0f 0 %.0f %.0f 0 %.0f{\\p0}",
    x, y, color or "000000", math.floor((1 - clamp(alpha or 1, 0, 1)) * 255), w, w, h, h)
end

local function add_circle(parts, x, y, radius, color, alpha)
  local points = {}
  for i = 0, 16 do
    local angle = (math.pi * 2 * i) / 16
    points[#points + 1] = string.format("%s %.1f %.1f", i == 0 and "m" or "l",
      radius + math.cos(angle) * radius, radius + math.sin(angle) * radius)
  end
  parts[#parts + 1] = string.format(
    "{\\an7\\pos(%.0f,%.0f)\\bord0\\shad0\\1c&H%s&\\1a&H%02X&\\p1}%s{\\p0}",
    x - radius, y - radius, color or "FFFFFF",
    math.floor((1 - clamp(alpha or 1, 0, 1)) * 255), table.concat(points, " "))
end

local function draw_gradient(parts, width, height, alpha)
  local top = {
    { 0, 0.74 }, { 36, 0.58 }, { 82, 0.37 }, { 132, 0.18 }, { 190, 0.07 },
  }
  for _, band in ipairs(top) do
    add_rect(parts, 0, band[1], width, 38, "000000", band[2] * alpha)
  end
  local bottom = {
    { 0, 0.05 }, { 40, 0.12 }, { 84, 0.23 }, { 128, 0.39 },
    { 172, 0.57 }, { 216, 0.72 }, { 260, 0.83 }, { 304, 0.88 },
  }
  for _, band in ipairs(bottom) do
    add_rect(parts, 0, height - 38 - band[1], width, 40, "000000", band[2] * alpha)
  end
end

local function subtitle_tracks()
  local tracks = mp.get_property_native("track-list") or {}
  local out = {}
  for _, track in ipairs(tracks) do
    if track.type == "sub" then out[#out + 1] = track end
  end
  return out
end

local function subtitle_label(track, index)
  local title = track.title or track.lang or ("Subtitle " .. tostring(index))
  if track.lang and track.title then title = track.lang .. " - " .. track.title end
  if track.external then title = title .. " (external)" end
  return title
end

local function draw_button(parts, x, y, label, size, active, alpha)
  add_circle(parts, x, y, size, active and "FFFFFF" or "FFFFFF", active and 0.2 * alpha or 0.11 * alpha)
  add_text(parts, x, y - 1, label, math.floor(size * 0.92), alpha, true, 5)
end

local function draw_popup(parts, width, height, alpha)
  popup_rows = {}
  if not popup then return end
  local box_w = math.min(390, width - 36)
  local x = popup == "subs" and math.max(18, width - box_w - 48) or 28
  local y = height - 355
  local row_h = 38
  local rows = {}
  if popup == "subs" then
    rows[#rows + 1] = { title = "Subtitles", action = "header" }
    rows[#rows + 1] = { title = "Off", action = "sid", value = "no" }
    for index, track in ipairs(subtitle_tracks()) do
      rows[#rows + 1] = {
        title = subtitle_label(track, index),
        action = "sid",
        value = tostring(track.id),
        selected = track.selected,
      }
    end
    rows[#rows + 1] = { title = "Load Subtitle File...", action = "load-sub" }
    rows[#rows + 1] = { title = "Subtitle delay      -0.1s         +0.1s", action = "delay" }
  else
    rows[#rows + 1] = { title = "Playlist", action = "header" }
    local playlist = mp.get_property_native("playlist") or {}
    for index, item in ipairs(playlist) do
      rows[#rows + 1] = {
        title = item.title or item.filename or ("Item " .. tostring(index)),
        action = "playlist",
        value = index - 1,
        selected = item.current,
      }
      if #rows >= 8 then break end
    end
    if #rows == 1 then rows[#rows + 1] = { title = "No episodes in queue", action = "header" } end
  end

  local box_h = #rows * row_h + 22
  y = math.max(44, y - box_h)
  add_rect(parts, x, y, box_w, box_h, "111318", 0.96 * alpha)
  add_rect(parts, x, y, box_w, 1, "FFFFFF", 0.3 * alpha)
  for index, row in ipairs(rows) do
    local ry = y + 12 + (index - 1) * row_h
    if row.selected then add_rect(parts, x + 8, ry - 3, box_w - 16, row_h, "FFFFFF", 0.14 * alpha) end
    add_text(parts, x + 18, ry + 3, row.title, 17, alpha * (row.action == "header" and 0.72 or 1), row.action == "header")
    if row.action ~= "header" then
      popup_rows[#popup_rows + 1] = {
        x1 = x, x2 = x + box_w, y1 = ry - 3, y2 = ry + row_h - 4, row = row,
      }
    end
  end
  if popup == "subs" then
    local last = popup_rows[#popup_rows]
    if last then
      last.delay_left = { x1 = x + box_w * 0.48, x2 = x + box_w * 0.69 }
      last.delay_right = { x1 = x + box_w * 0.70, x2 = x + box_w - 8 }
    end
  end
end

local function draw()
  local width = overlay.res_x or number_property("osd-width", 1280)
  local height = overlay.res_y or number_property("osd-height", 720)
  if width <= 0 then width = 1280 end
  if height <= 0 then height = 720 end

  local paused = mp.get_property_bool("pause", false)
  local now = mp.get_time()
  local idle = mp.get_property_bool("idle-active", true)
  local fade_after = 1.8
  if not idle and (visible or paused or popup) then
    if paused or popup then
      ui_alpha = 1
    else
      ui_alpha = clamp((last_activity + fade_after + 0.28 - now) / 0.28, 0, 1)
    end
  else
    ui_alpha = 0
  end

  local mx, my = mp.get_mouse_pos()
  mx, my = mx or -1, my or -1
  hover_x, hover_y = mx, my
  if mx ~= last_mouse_x or my ~= last_mouse_y then
    last_mouse_x, last_mouse_y = mx, my
    last_activity = now
    visible = true
    ui_alpha = 1
  end

  local parts = {}
  if idle or ui_alpha <= 0 then
    overlay.data = ""
    overlay:update()
    return
  end

  draw_gradient(parts, width, height, ui_alpha)

  -- Top bar: back, media title/status, and aligned window controls.
  add_text(parts, 44, 38, "<", 31, ui_alpha, false)
  add_rect(parts, 80, 21, 1, 30, "FFFFFF", 0.35 * ui_alpha)
  local title = media_title()
  if title == "" then title = mp.get_property("filename", "Enhanced MPV") end
  add_text(parts, 100, 25, title, 19, ui_alpha, true)
  local sub_count = #subtitle_tracks()
  local status = mp.get_property("video-format", "")
  local video_params = mp.get_property_native("video-params") or {}
  if video_params.dw and video_params.dh then
    status = tostring(video_params.dw) .. "p"
  end
  local status_text = (status ~= "" and status or "STREAMING")
    .. "  |  " .. tostring(sub_count) .. " subtitle track" .. (sub_count == 1 and "" or "s")
  add_text(parts, 101, 51, status_text, 12, 0.68 * ui_alpha, false)

  local controls_y = 34
  add_text(parts, width - 143, controls_y, "-", 25, ui_alpha, false, 5)
  add_text(parts, width - 93, controls_y, "[]", 17, ui_alpha, false, 5)
  add_text(parts, width - 43, controls_y, "x", 18, ui_alpha, false, 5)

  -- Metadata row and remaining time above the scrubber.
  local duration = number_property("duration", 0)
  local position = number_property("time-pos", 0)
  local remaining = duration > 0 and math.max(0, duration - position) or 0
  local episode = mp.get_property("chapter-metadata/title", "")
  local metadata = episode ~= "" and episode or title
  add_text(parts, 44, height - 207, metadata, 20, ui_alpha, true)
  add_text(parts, width - 44, height - 206, "-" .. time_text(remaining), 15, ui_alpha, false, 9)

  -- Thin timeline with cached ranges, progress, and a thumb that grows on hover.
  timeline.x = 44
  timeline.y = height - 151
  timeline.w = width - 88
  local hover_timeline = my >= timeline.y - 16 and my <= timeline.y + 18 and mx >= timeline.x and mx <= timeline.x + timeline.w
  timeline.h = hover_timeline and 5 or 3
  local track_y = timeline.y - timeline.h / 2
  add_rect(parts, timeline.x, track_y, timeline.w, timeline.h, "FFFFFF", 0.35 * ui_alpha)
  local cache_state = mp.get_property_native("demuxer-cache-state") or {}
  local ranges = cache_state["seekable-ranges"] or {}
  if duration > 0 and type(ranges) == "table" then
    for _, range in ipairs(ranges) do
      local first = tonumber(range.start) or tonumber(range[1])
      local last = tonumber(range["end"]) or tonumber(range[2])
      if first and last and last > first then
        add_rect(parts, timeline.x + timeline.w * first / duration, track_y,
          timeline.w * (last - first) / duration, timeline.h, "FFFFFF", 0.4 * ui_alpha)
      end
    end
  end
  local progress = duration > 0 and clamp(position / duration, 0, 1) or 0
  add_rect(parts, timeline.x, track_y, timeline.w * progress, timeline.h, "FFFFFF", ui_alpha)
  local thumb_x = timeline.x + timeline.w * progress
  add_circle(parts, thumb_x, timeline.y, hover_timeline and 8 or 7, "FFFFFF", ui_alpha)
  if hover_timeline and duration > 0 then
    local hover_time = duration * clamp((mx - timeline.x) / timeline.w, 0, 1)
    add_rect(parts, mx - 34, timeline.y - 38, 68, 25, "111318", 0.92 * ui_alpha)
    add_text(parts, mx, timeline.y - 35, time_text(hover_time), 13, ui_alpha, false, 5)
  end

  -- Quick actions on the left, transport in the center, and audio/subtitle/fullscreen on the right.
  local button_y = height - 76
  add_text(parts, 68, button_y, "Subtitles  " .. tostring(sub_count), 15, ui_alpha, true)
  add_text(parts, 208, button_y, "Playlist", 15, ui_alpha, true)
  add_text(parts, 310, button_y, "Next  >", 15, ui_alpha, true)

  local center = width / 2
  draw_button(parts, center - 74, button_y + 2, "R10", 18, false, ui_alpha)
  draw_button(parts, center, button_y + 2, paused and ">" or "||", 23, true, ui_alpha)
  draw_button(parts, center + 74, button_y + 2, "F10", 18, false, ui_alpha)

  local muted = mp.get_property_bool("mute", false)
  local volume = clamp(number_property("volume", 100), 0, 150)
  add_text(parts, width - 224, button_y, muted and "MUTE" or "VOL", 13, ui_alpha, false, 5)
  volume_slider = { x = width - 196, y = button_y - 4, w = 91, h = 18 }
  add_rect(parts, volume_slider.x, button_y, volume_slider.w, 3, "FFFFFF", 0.35 * ui_alpha)
  add_rect(parts, volume_slider.x, button_y, volume_slider.w * volume / 150, 3, "FFFFFF", ui_alpha)
  add_circle(parts, volume_slider.x + volume_slider.w * volume / 150, button_y + 1, 5, "FFFFFF", ui_alpha)
  add_text(parts, width - 73, button_y, "CC", 14, ui_alpha, true, 5)
  add_text(parts, width - 28, button_y, "[]", 17, ui_alpha, false, 5)

  draw_popup(parts, width, height, ui_alpha)
  overlay.data = table.concat(parts, "\n")
  overlay:update()
end

local function click(x, y)
  if not x or not y then return end
  last_activity = mp.get_time()
  visible = true

  if popup then
    for _, hit in ipairs(popup_rows) do
      if x >= hit.x1 and x <= hit.x2 and y >= hit.y1 and y <= hit.y2 then
        local row = hit.row
        if row.action == "sid" then
          mp.set_property("sid", row.value)
          popup = nil
        elseif row.action == "load-sub" then
          popup = nil
          local powershell = [[Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Filter='Subtitle files|*.srt;*.ass;*.ssa;*.vtt;*.sup|All files|*.*'; if($d.ShowDialog() -eq 'OK'){[Console]::Write($d.FileName)}]]
          mp.command_native_async({
            name = "subprocess",
            args = { "powershell.exe", "-NoProfile", "-STA", "-Command", powershell },
            capture_stdout = true,
            playback_only = false,
          }, function(success, result)
            local file = success and result and result.stdout and result.stdout:gsub("[%s\r\n]+$", "")
            if file and file ~= "" then mp.commandv("sub-add", file, "select") end
          end)
        elseif row.action == "playlist" then
          mp.commandv("playlist-play-index", tostring(row.value))
          popup = nil
        elseif row.action == "delay" then
          if hit.delay_left and x >= hit.delay_left.x1 and x <= hit.delay_left.x2 then
            mp.commandv("add", "sub-delay", "-0.1")
          elseif hit.delay_right and x >= hit.delay_right.x1 then
            mp.commandv("add", "sub-delay", "0.1")
          end
        end
        draw()
        return
      end
    end
    popup = nil
  end

  local width = overlay.res_x or number_property("osd-width", 1280)
  local height = overlay.res_y or number_property("osd-height", 720)
  local title_y1, title_y2 = 10, 68
  if y >= title_y1 and y <= title_y2 then
    if x < 70 then
      mp.commandv("quit")
    elseif x > width - 70 then
      mp.commandv("quit")
    elseif x > width - 120 then
      local maximized = mp.get_property_bool("window-maximized", false)
      pcall(mp.set_property_native, "window-maximized", not maximized)
    elseif x > width - 170 then
      pcall(mp.set_property_native, "window-minimized", true)
    end
  elseif y >= timeline.y - 18 and y <= timeline.y + 20 and x >= timeline.x and x <= timeline.x + timeline.w then
    local duration = number_property("duration", 0)
    if duration > 0 then
      mp.commandv("seek", tostring(duration * clamp((x - timeline.x) / timeline.w, 0, 1)), "absolute+exact")
    end
  elseif y >= height - 104 and y <= height - 48 then
    local center = width / 2
    if x > center - 105 and x < center - 42 then
      mp.commandv("seek", "-10", "relative")
    elseif x >= center - 42 and x <= center + 42 then
      mp.commandv("cycle", "pause")
    elseif x > center + 42 and x < center + 105 then
      mp.commandv("seek", "10", "relative")
    elseif x >= 42 and x < 178 then
      popup = "subs"
    elseif x >= 184 and x < 300 then
      popup = "playlist"
    elseif x >= 300 and x < 380 then
      mp.commandv("playlist-next")
    elseif x >= volume_slider.x - 26 and x <= volume_slider.x + volume_slider.w + 15 then
      if x < volume_slider.x - 4 then
        mp.commandv("cycle", "mute")
      else
        mp.set_property_number("volume", 150 * clamp((x - volume_slider.x) / volume_slider.w, 0, 1))
        mp.set_property_bool("mute", false)
      end
    elseif x > width - 96 and x <= width - 48 then
      popup = "subs"
    elseif x > width - 48 then
      mp.commandv("cycle", "fullscreen")
    end
  else
    popup = nil
  end
  draw()
end

local function mouse_click()
  local x, y = mp.get_mouse_pos()
  click(x, y)
end

local function show_ui()
  visible = true
  last_activity = mp.get_time()
  draw()
end

mp.add_forced_key_binding("MBTN_LEFT", "click", mouse_click)
mp.add_forced_key_binding("MBTN_RIGHT", "toggle-ui-right", function()
  popup = popup and nil or "subs"
  show_ui()
end)
mp.add_key_binding(nil, "toggle-ui", function()
  visible = not visible
  popup = nil
  last_activity = mp.get_time()
  draw()
end)
mp.add_key_binding("SPACE", "toggle-pause", function() mp.commandv("cycle", "pause"); show_ui() end)
mp.add_key_binding("LEFT", "seek-back", function() mp.commandv("seek", "-10", "relative"); show_ui() end)
mp.add_key_binding("RIGHT", "seek-forward", function() mp.commandv("seek", "10", "relative"); show_ui() end)
mp.add_key_binding("f", "toggle-fullscreen", function() mp.commandv("cycle", "fullscreen"); show_ui() end)
mp.add_key_binding("v", "toggle-subtitles", function()
  mp.set_property_bool("sub-visibility", not mp.get_property_bool("sub-visibility", true))
  show_ui()
end)
mp.register_event("file-loaded", show_ui)
mp.observe_property("pause", "bool", show_ui)

mp.add_periodic_timer(0.1, function()
  if not mp.get_property_bool("idle-active", true) then
    draw()
  else
    overlay.data = ""
    overlay:update()
  end
end)
