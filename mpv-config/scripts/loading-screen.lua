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
local DARK_BG = "#0E1014"
local TEXT_WHITE = "#FFFFFF"
local TEXT_MUTED = "#888888"

-- Pulse animation for buffering step
local pulse_timer = nil
local pulse_state = 0

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

local function build_ass()
  local title = media_title ~= "" and media_title or "Connecting stream..."
  local resume_text = ""
  if start_time > 0 then
    resume_text = string.format("  {\\1c&H%s&}▸ Resume at %s", NEON_GREEN:sub(2), format_time(start_time))
  end

  -- Step 1: Stream & headers verified
  local step1_icon = steps_state.verified and "{\\1c&H" .. NEON_GREEN:sub(2) .. "}\\uE8FB" or "{\\1c&H" .. TEXT_MUTED .. "}\\uE8FB"
  local step1_color = steps_state.verified and NEON_GREEN or TEXT_MUTED
  local step1_text = steps_state.verified and "Stream & headers verified" or "Verifying stream & headers..."

  -- Step 2: Subtitles & audio linked
  local step2_icon = steps_state.subtitles and "{\\1c&H" .. NEON_GREEN:sub(2) .. "}\\uE8FB" or "{\\1c&H" .. TEXT_MUTED .. "}\\uE8FB"
  local step2_color = steps_state.subtitles and NEON_GREEN or TEXT_MUTED
  local step2_text = steps_state.subtitles and "Subtitles & audio linked" or "Linking subtitles & audio..."

  -- Step 3: Buffering first frame (pulsing)
  local pulse_dots = string.rep(".", pulse_state)
  local step3_icon = "{\\1c&H" .. NEON_GREEN:sub(2) .. "}\\uE8FA"
  local step3_text = "Buffering first frame" .. pulse_dots

  local ass = string.format([[
{\an7\fs36\b1\bord0\shad0\1c&H%s&}%s%s
{\an7\fs18\b0\bord0\shad0\1c&H%s&}%s

{\an7\fs20\b0\bord0\shad0\1c&H%s&}%s  {\\1c&H%s&}%s
{\an7\fs20\b0\bord0\shad0\1c&H%s&}%s  {\\1c&H%s&}%s
{\an7\fs20\b0\bord0\shad0\1c&H%s&}%s  {\\1c&H%s&}%s
]], TEXT_WHITE, title, resume_text, TEXT_MUTED, "Enhanced MPV",
  step1_color, step1_icon, step1_text,
  step2_color, step2_icon, step2_text,
  step3_color, step3_icon, step3_text)

  return ass
end

local function show_loading()
  if loading_active then return end
  loading_active = true
  steps_state = { verified = false, subtitles = false, buffering = true }
  media_title = mp.get_property("media-title") or ""
  start_time = mp.get_property_number("start-time") or 0
  if start_time <= 0 then
    start_time = mp.get_property_number("time-pos") or 0
  end

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

  local ass = string.format([[
{\an5\fs36\b1\bord0\shad0\1c&H%s&}Stream failed to load
{\an5\fs20\b0\bord0\shad0\1c&H%s&}%s
{\an5\fs18\b0\bord0\shad0\1c&H%s&}Press Fallback in the extension or try again
]], NEON_GREEN, TEXT_MUTED, message, TEXT_MUTED)

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

mp.register_event("end-file", function(event)
  if event and event.reason and event.reason ~= "eof" and event.reason ~= "quit" then
    local reason = event.reason or "unknown error"
    show_error(reason)
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