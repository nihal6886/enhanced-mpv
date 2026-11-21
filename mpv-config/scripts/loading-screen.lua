--[[
  loading-screen.lua

  Instant (< 100ms) ASS loading overlay that renders the moment the window appears.
  Shows a sleek dark studio card with neon-green accents and a live pipeline
  checklist. Auto-clears on first frame (playback-restart) or shows clean error
  message on end-file failure.
]]

local mp = require("mp")
local msg = require("mp.msg")

local overlay = mp.create_osd_overlay("ass-events")
overlay.z = 200  -- Top layer above everything
local loading_active = false
local steps_state = {
  verified = false,
  subtitles = false,
  buffering = true,
}
local media_title = ""
local start_time = 0

-- Neon green #4ADE80, dark studio #0E1014
local NEON_GREEN = "#4ADE80"
local TEXT_WHITE = "#FFFFFF"
local TEXT_MUTED = "#888888"

-- Pulse animation for buffering step
local pulse_timer = nil
local pulse_state = 0

-- ASS colours are &HBBGGRR&, not #RRGGBB.
local function ass_color(hex)
  local r, g, b = hex:match("^#(%x%x)(%x%x)(%x%x)$")
  if not r then return "&HFFFFFF&" end
  return "&H" .. b .. g .. r .. "&"
end

-- Strip ASS override braces from untrusted text (media titles, errors).
local function ass_text(s)
  return (tostring(s or ""):gsub("[{}]", ""):gsub("\n", " "))
end

local function format_time(seconds)
  if not seconds or seconds <= 0 then return "0:00" end
  local h = math.floor(seconds / 3600)
  local m = math.floor((seconds % 3600) / 60)
  local s = math.floor(seconds % 60)
  if h > 0 then
    return string.format("%d:%02d:%02d", h, m, s)
  else
    return string.format("%d:%02d", m, s)
  end
end

local function step_line(done, active_text, done_text)
  local color = done and NEON_GREEN or TEXT_MUTED
  local icon = done and "✓" or "•"
  return string.format("{\\an7\\fs20\\b0\\bord0\\shad0\\1c%s}%s  %s",
    ass_color(color), icon, done and done_text or active_text)
end

local function build_ass()
  local title = media_title ~= "" and media_title or "Connecting stream..."
  local resume_text = ""
  if start_time > 0 then
    resume_text = string.format("  {\\1c%s}▸ Resume at %s", ass_color(NEON_GREEN), format_time(start_time))
  end
  local lines = {
    string.format("{\\an7\\fs36\\b1\\bord0\\shad0\\1c%s}%s%s", ass_color(TEXT_WHITE), ass_text(title), resume_text),
    string.format("{\\an7\\fs18\\b0\\bord0\\shad0\\1c%s}Enhanced MPV", ass_color(TEXT_MUTED)),
    "",
    step_line(steps_state.verified, "Verifying stream & headers...", "Stream & headers verified"),
    step_line(steps_state.subtitles, "Linking subtitles & audio...", "Subtitles & audio linked"),
    string.format("{\\an7\\fs20\\b0\\bord0\\shad0\\1c%s}•  Buffering first frame%s",
      ass_color(NEON_GREEN), string.rep(".", pulse_state)),
  }
  return table.concat(lines, "\n")
end

-- Requested resume point (--start / loadfile start option), e.g. "+42" or "42".
local function requested_start()
  local raw = mp.get_property("start") or ""
  local n = tonumber((raw:gsub("^%+", "")))
  return n or 0
end

local function show_loading()
  if loading_active then return end
  loading_active = true
  steps_state = { verified = false, subtitles = false, buffering = true }
  media_title = mp.get_property("media-title") or ""
  start_time = requested_start()

  overlay.data = build_ass()
  overlay:update()

  -- Start pulse animation for buffering step
  pulse_state = 0
  pulse_timer = mp.add_periodic_timer(0.5, function()
    pulse_state = (pulse_state % 3) + 1
    if loading_active then
      overlay.data = build_ass()
      overlay:update()
    else
      pulse_timer:stop()
    end
  end)
end

local function update_step(step, value)
  if step == "verified" then steps_state.verified = value
  elseif step == "subtitles" then steps_state.subtitles = value
  elseif step == "buffering" then steps_state.buffering = value end
  if loading_active then
    overlay.data = build_ass()
    overlay:update()
  end
end

local function hide_loading()
  if not loading_active then return end
  loading_active = false
  if pulse_timer then pulse_timer:stop() end
  overlay.data = ""
  overlay:update()
end

local function show_error(message)
  if not loading_active then return end
  loading_active = false
  if pulse_timer then pulse_timer:stop() end

  local ass = table.concat({
    string.format("{\\an5\\fs36\\b1\\bord0\\shad0\\1c%s}Stream failed to load", ass_color(NEON_GREEN)),
    string.format("{\\an5\\fs20\\b0\\bord0\\shad0\\1c%s}%s", ass_color(TEXT_MUTED), ass_text(message)),
    string.format("{\\an5\\fs18\\b0\\bord0\\shad0\\1c%s}Press Fallback in the extension or try again", ass_color(TEXT_MUTED)),
  }, "\n")

  overlay.data = ass
  overlay:update()
end

-- Show loading card IMMEDIATELY on script initialization (~80ms)
-- Don't wait for start-file event
show_loading()

-- Event handlers
mp.register_event("start-file", function()
  show_loading()
end)

mp.register_event("file-loaded", function()
  -- Stream & headers verified immediately on file-loaded
  update_step("verified", true)
end)

mp.observe_property("track-list", "native", function(_, tracks)
  if not loading_active then return end
  if tracks and #tracks > 0 then
    local has_audio = false
    local has_sub = false
    for _, t in ipairs(tracks) do
      if t.type == "audio" and t.selected then has_audio = true end
      if t.type == "sub" and t.selected then has_sub = true end
    end
    if has_audio or has_sub then
      update_step("subtitles", true)
    end
  end
end)

mp.register_event("playback-restart", function()
  -- First frame ready - clear overlay immediately
  hide_loading()
end)

-- Clear buffering step as soon as video output parameters are available
-- (first frame decoded), which happens before playback-restart in some cases.
mp.observe_property("video-out-params", "native", function(_, params)
  if not loading_active then return end
  if params then
    update_step("buffering", false)
  end
end)

mp.register_event("end-file", function(event)
  -- Only real failures show the error card; "stop" (loadfile replace),
  -- "redirect" (yt-dlp playlists), "eof", and "quit" are normal transitions.
  if event and event.reason == "error" then
    show_error(event.file_error or "unknown error")
  else
    hide_loading()
  end
end)

mp.observe_property("idle-active", "bool", function(_, idle)
  if idle then
    hide_loading()
  end
end)

msg.info("loading-screen.lua loaded")