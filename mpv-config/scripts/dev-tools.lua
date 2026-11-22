--[[
  dev-tools.lua

  Live Stream & Sniffer Inspector HUD for Enhanced MPV.
  Bound to Ctrl+Shift+D. Renders a sleek #0D1117 + #4ADE80 overlay showing:
  - WebSocket Bridge status (REAL-TIME WS / DISCONNECTED)
  - Live candidate stream count from sniffer
  - Active candidate (idx/total), stream type (HLS/DASH/DIRECT/YTDLP)
  - Resolved URL vs local relay URL
  - Forwarded headers (Referer, Origin, Cookie, User-Agent, Authorization status)
  - Video/audio codec & resolution
  - Demuxer cache seconds
  - Recent IPC/demuxer errors
  - Live player telemetry (time-pos, pause, resolution, buffering)
]]

local mp = require("mp")
local utils = require("mp.utils")
local msg = require("mp.msg")

local NEON_GREEN = "4ADE80"
local DARK_BG = "0D1117"
local DARK_CARD = "161B22"
local TEXT_WHITE = "E6EDF3"
local TEXT_MUTED = "8B949E"
local BORDER_COLOR = "30363D"
local GREEN_DIM = "2D5A43"
local RED = "FF453A"
local ORANGE = "FFA500"

local overlay = mp.create_osd_overlay("ass-events")
local visible = false
local candidate_idx = 1
local candidates = {}
local stream_info = {}
local last_errors = {}
local bridge_status = { connected = false, candidate_count = 0, last_update = 0 }
local player_telemetry = { time_pos = 0, pause = false, width = 0, height = 0, demuxer_cache = 0, media_title = "" }

local function safe_ass(text)
  return tostring(text or ""):gsub("[\r\n]+", " "):gsub("{", "("):gsub("}", ")")
end

local function ass_rgb(rgb)
  return string.format("&H%s&", rgb)
end

local function ass_alpha(alpha)
  return string.format("&H%02X&", alpha)
end

local function get_stream_type(url)
  if not url or url == "" then return "UNKNOWN" end
  local u = url:lower()
  if u:match("ytdlp") or u:match("youtube%.com") or u:match("youtu%.be") or u:match("googlevideo%.com") then
    return "YTDLP"
  elseif u:match("%.m3u8") or u:match("%.m3u") then
    return "HLS"
  elseif u:match("%.mpd") then
    return "DASH"
  elseif u:match("%.mp4") or u:match("%.mkv") or u:match("%.webm") then
    return "DIRECT"
  elseif u:match("127%.0%.0%.1") or u:match("localhost") then
    return "RELAY"
  end
  return "OTHER"
end

local function parse_sources_json()
  local p = mp.command_native({ "expand-path", "~/.enhanced-mpv/sources.json" })
  if not p or p == "" then return nil end
  local f = io.open(p, "r")
  if not f then return nil end
  local content = f:read("*a")
  f:close()
  local ok, parsed = pcall(utils.parse_json, content)
  if not ok or type(parsed) ~= "table" then return nil end
  return parsed
end

local function update_candidates()
  local src = parse_sources_json()
  if src and src.candidates and #src.candidates > 0 then
    candidates = src.candidates
    if candidate_idx > #candidates then candidate_idx = 1 end
  else
    candidates = {}
    candidate_idx = 1
  end
end

local function get_stream_info()
  local info = {}
  info.path = mp.get_property("path") or ""
  info.stream_type = get_stream_type(info.path)
  info.video_codec = mp.get_property("video-codec") or "N/A"
  info.audio_codec = mp.get_property("audio-codec") or "N/A"
  info.width = mp.get_property_number("width") or 0
  info.height = mp.get_property_number("height") or 0
  info.fps = mp.get_property_number("container-fps") or 0
  info.demuxer_cache = mp.get_property_number("demuxer-cache-duration") or 0
  info.cache_buffering = mp.get_property_number("cache-buffering-state") or 0
  info.idle_active = mp.get_property_bool("idle-active")
  info.pause = mp.get_property_bool("pause")
  info.time_pos = mp.get_property_number("time-pos") or 0
  info.duration = mp.get_property_number("duration") or 0
  info.http_headers = mp.get_property("http-header-fields") or ""
  return info
end

local function add_error(source, message)
  table.insert(last_errors, 1, string.format("[%s] %s", source, message))
  if #last_errors > 5 then table.remove(last_errors) end
end

mp.register_script_message("dev-tools-error", function(source, message)
  add_error(source, message)
  if visible then render() end
end)

--[[
  dev-tools.lua

  Live Stream & Sniffer Inspector HUD for Enhanced MPV.
  Bound to Ctrl+Shift+D. Renders a sleek #0D1117 + #4ADE80 overlay showing:
  - Unified PipelineState (SNIFFING -> PROBING -> PREWARMING -> SHADOW_READY -> LAUNCHING -> PLAYING | FAILOVER)
  - WebSocket Bridge status (REAL-TIME WS / DISCONNECTED)
  - Live candidate stream count from sniffer
  - Active candidate (idx/total), stream type (HLS/DASH/DIRECT/YTDLP)
  - Resolved URL vs local relay URL
  - Forwarded headers (Referer, Origin, Cookie, User-Agent, Authorization status)
  - Video/audio codec & resolution
  - Demuxer cache seconds
  - Recent IPC/demuxer errors
  - Live player telemetry (time-pos, pause, resolution, buffering)
  - RAM Segment Ring stats (bytes prefetched, segments cached)
  - Zero-Wait readiness indicator
]]

local mp = require("mp")
local utils = require("mp.utils")
local msg = require("mp.msg")

local NEON_GREEN = "4ADE80"
local DARK_BG = "0D1117"
local DARK_CARD = "161B22"
local TEXT_WHITE = "E6EDF3"
local TEXT_MUTED = "8B949E"
local BORDER_COLOR = "30363D"
local GREEN_DIM = "2D5A43"
local RED = "FF453A"
local ORANGE = "FFA500"
local AMBER = "FBBF24"

local overlay = mp.create_osd_overlay("ass-events")
local visible = false
local candidate_idx = 1
local candidates = {}
local stream_info = {}
local last_errors = {}
local bridge_status = { connected = false, candidate_count = 0, last_update = 0 }
local player_telemetry = { time_pos = 0, pause = false, width = 0, height = 0, demuxer_cache = 0, media_title = "" }
local pipeline_stage = "IDLE"
local pipeline_candidate = nil
local pipeline_relay_stats = {}
local pipeline_prewarm_ms = 0
local pipeline_launch_ms = 0
local zero_wait_ready = false

local function safe_ass(text)
  return tostring(text or ""):gsub("[\r\n]+", " "):gsub("{", "("):gsub("}", ")")
end

local function ass_rgb(rgb)
  return string.format("&H%s&", rgb)
end

local function ass_alpha(alpha)
  return string.format("&H%02X&", alpha)
end

local function get_stream_type(url)
  if not url or url == "" then return "UNKNOWN" end
  local u = url:lower()
  if u:match("ytdlp") or u:match("youtube%.com") or u:match("youtu%.be") or u:match("googlevideo%.com") then
    return "YTDLP"
  elseif u:match("%.m3u8") or u:match("%.m3u") then
    return "HLS"
  elseif u:match("%.mpd") then
    return "DASH"
  elseif u:match("%.mp4") or u:match("%.mkv") or u:match("%.webm") then
    return "DIRECT"
  elseif u:match("127%.0%.0%.1") or u:match("localhost") then
    return "RELAY"
  end
  return "OTHER"
end

local function parse_sources_json()
  local p = mp.command_native({ "expand-path", "~/.enhanced-mpv/sources.json" })
  if not p or p == "" then return nil end
  local f = io.open(p, "r")
  if not f then return nil end
  local content = f:read("*a")
  f:close()
  local ok, parsed = pcall(utils.parse_json, content)
  if not ok or type(parsed) ~= "table" then return nil end
  return parsed
end

local function update_candidates()
  local src = parse_sources_json()
  if src and src.candidates and #src.candidates > 0 then
    candidates = src.candidates
    if candidate_idx > #candidates then candidate_idx = 1 end
  else
    candidates = {}
    candidate_idx = 1
  end
end

local function get_stream_info()
  local info = {}
  info.path = mp.get_property("path") or ""
  info.stream_type = get_stream_type(info.path)
  info.video_codec = mp.get_property("video-codec") or "N/A"
  info.audio_codec = mp.get_property("audio-codec") or "N/A"
  info.width = mp.get_property_number("width") or 0
  info.height = mp.get_property_number("height") or 0
  info.fps = mp.get_property_number("container-fps") or 0
  info.demuxer_cache = mp.get_property_number("demuxer-cache-duration") or 0
  info.cache_buffering = mp.get_property_number("cache-buffering-state") or 0
  info.idle_active = mp.get_property_bool("idle-active")
  info.pause = mp.get_property_bool("pause")
  info.time_pos = mp.get_property_number("time-pos") or 0
  info.duration = mp.get_property_number("duration") or 0
  info.http_headers = mp.get_property("http-header-fields") or ""
  return info
end

local function add_error(source, message)
  table.insert(last_errors, 1, string.format("[%s] %s", source, message))
  if #last_errors > 5 then table.remove(last_errors) end
end

mp.register_script_message("dev-tools-error", function(source, message)
  add_error(source, message)
  if visible then render() end
end)

-- Receive bridge status from stream-controller.lua
mp.register_script_message("stream-controller-state", function(json)
  local ok, data = pcall(utils.parse_json, json)
  if ok and data then
    if data.event == "bridge_status" then
      bridge_status.connected = data.connected or false
    elseif data.event == "candidates_loaded" or data.event == "candidates_hot_reloaded" then
      bridge_status.candidate_count = data.count or #candidates
      bridge_status.last_update = mp.get_time()
    end
    if visible then render() end
  end
end)

-- Consume unified PipelineState from stream-controller.lua
mp.register_script_message("pipeline_state_applied", function(json)
  local ok, data = pcall(utils.parse_json, json)
  if ok and data then
    pipeline_stage = data.stage or pipeline_stage
    pipeline_candidate = data.candidate
    pipeline_relay_stats = data.relayStats or {}
    pipeline_prewarm_ms = data.prewarmMs or 0
    pipeline_launch_ms = data.launchMs or 0
    if visible then render() end
  end
end)

mp.register_script_message("shadow_ready", function(json)
  local ok, data = pcall(utils.parse_json, json)
  if ok and data then
    zero_wait_ready = true
    pipeline_stage = "SHADOW_READY"
    pipeline_candidate = data.candidate
    pipeline_prewarm_ms = data.prewarmMs or 0
    if visible then render() end
  end
end)

mp.register_script_message("sniffer_state_change", function(json)
  local ok, data = pcall(utils.parse_json, json)
  if ok and data then
    if data.state then pipeline_stage = data.state end
    if data.zero_wait_ready ~= nil then zero_wait_ready = data.zero_wait_ready end
    if visible then render() end
  end
end)

-- Receive player telemetry from launch-daemon.js via WebSocket bridge
mp.register_script_message("player:telemetry", function(json)
  local ok, data = pcall(utils.parse_json, json)
  if ok and data and data.state then
    for k, v in pairs(data.state) do
      player_telemetry[k] = v
    end
    if visible then render() end
  end
end)

local function extract_headers(header_str)
  local headers = {}
  if not header_str or header_str == "" then return headers end
  for part in header_str:gmatch("[^,]+") do
    local k, v = part:match("^%s*(.-)%s*:%s*(.+)%s*$")
    if k and v then
      headers[k:lower()] = v
    end
  end
  return headers
end

local function get_pipeline_stage_color(stage)
  if stage == "SHADOW_READY" then return NEON_GREEN
  elseif stage == "LAUNCHING" then return NEON_GREEN
  elseif stage == "PLAYING" then return NEON_GREEN
  elseif stage == "PREWARMING" then return AMBER
  elseif stage == "PROBING" then return AMBER
  elseif stage == "SNIFFING" then return AMBER
  elseif stage == "FAILOVER" then return RED
  else return TEXT_MUTED end
end

local function get_pipeline_stage_label(stage)
  local labels = {
    IDLE = "IDLE",
    SNIFFING = "SNIFFING",
    PROBING = "PROBING",
    PREWARMING = "PREWARMING",
    SHADOW_READY = "⚡ SHADOW READY",
    LAUNCHING = "LAUNCHING",
    PLAYING = "PLAYING",
    FAILOVER = "FAILOVER",
  }
  return labels[stage] or stage
end

local function render()
  if not visible then return end
  update_candidates()
  stream_info = get_stream_info()

  local w, h = mp.get_osd_size()
  if not w or w == 0 then w = 1920 end
  if not h or h == 0 then h = 1080 end

  local cx, cy = math.floor(w / 2), math.floor(h / 2)
  local panel_w = math.min(1020, w - 80)
  local panel_h = 580
  local x = cx - math.floor(panel_w / 2)
  local y = cy - math.floor(panel_h / 2)

  local a = {}

  -- Background panel
  table.insert(a, string.format("{\\an7\\pos(%d,%d)\\bord1\\shad0\\1c%s\\3c%s\\alpha&H18&}{\\p1}m 0 0 l %d 0 l %d %d l 0 %d{\\p0}",
    x - 10, y - 10, ass_rgb(DARK_BG), ass_rgb(BORDER_COLOR), panel_w + 20, panel_w + 20, panel_h + 20, panel_h + 20))

  -- Title bar with PipelineState + WebSocket bridge status
  local pipeline_color = get_pipeline_stage_color(pipeline_stage)
  local pipeline_label = get_pipeline_stage_label(pipeline_stage)
  local bridge_status_text = bridge_status.connected and "BRIDGE: REAL-TIME WS" or "BRIDGE: DISCONNECTED"
  local bridge_status_color = bridge_status.connected and NEON_GREEN or RED
  local bridge_candidates = bridge_status.candidate_count > 0 and ("  |  CANDIDATES: " .. bridge_status.candidate_count) or ""
  
  table.insert(a, string.format("{\\an7\\pos(%d,%d)\\fs28\\b1\\bord0\\shad0\\1c%s}STREAM & SNIFFER INSPECTOR  %s%s%s",
    x + 6, y + 6, ass_rgb(NEON_GREEN),
    string.format("{\\fs16\\1c%s}%s%s  %s", ass_rgb(bridge_status_color), bridge_status_text, bridge_candidates, 
      string.format("{\\fs14\\1c%s}Ctrl+Shift+D to close", ass_rgb(TEXT_MUTED)))))

  -- PipelineState indicator row
  local row_h = 26
  local row_y = y + 48
  local label_w = 180

  local function add_row(label, value, value_color, is_active)
    local clr = value_color or TEXT_WHITE
    local prefix = is_active and "* " or "  "
    table.insert(a, string.format("{\\an7\\pos(%d,%d)\\fs17\\bord0\\shad0\\1c%s}%s%s",
      x + 16, row_y, ass_rgb(TEXT_MUTED), prefix, safe_ass(label)))
    table.insert(a, string.format("{\\an7\\pos(%d,%d)\\fs17\\bord0\\shad0\\1c%s}%s",
      x + 16 + label_w, row_y, ass_rgb(clr), safe_ass(value)))
    row_y = row_y + row_h
  end

  -- PipelineState row
  local prewarm_str = pipeline_prewarm_ms > 0 and string.format("  (prewarm: %.0fms)", pipeline_prewarm_ms) or ""
  local launch_str = pipeline_launch_ms > 0 and string.format("  (launch: %.0fms)", pipeline_launch_ms) or ""
  local zw_str = zero_wait_ready and "  ⚡ ZERO-WAIT" or ""
  add_row("Pipeline:", string.format("%s%s%s%s", pipeline_label, prewarm_str, launch_str, zw_str), pipeline_color, true)

  -- RAM Segment Ring stats
  if pipeline_relay_stats and pipeline_relay_stats.bytesPrefetched then
    local mb = (pipeline_relay_stats.bytesPrefetched / 1024 / 1024)
    local segs = pipeline_relay_stats.segmentsCached or 0
    if mb > 0.1 then
      add_row("RAM Ring:", string.format("%.2f MiB / %d segs  (max: 32 MiB)", mb, segs), TEXT_WHITE)
    end
  end

  -- Candidate info
  local cand = candidates[candidate_idx]
  local total = #candidates
  if total > 0 and cand then
    add_row("Candidate:", string.format("%d / %d  (%s)", candidate_idx, total, cand.kind or "stream"), NEON_GREEN, true)
    add_row("Title:", cand.title or "N/A", TEXT_WHITE)
    add_row("Stream Type:", get_stream_type(cand.url), TEXT_WHITE)
    
    -- URLs
    local url_display = cand.url
    if #url_display > 95 then url_display = url_display:sub(1, 92) .. "..." end
    add_row("Resolved URL:", url_display, TEXT_MUTED)
    
    if cand.audioUrl and cand.audioUrl ~= "" then
      local aurl = cand.audioUrl
      if #aurl > 95 then aurl = aurl:sub(1, 92) .. "..." end
      add_row("Audio URL:", aurl, TEXT_MUTED)
    end
    
    -- Headers status
    local hdrs = extract_headers(cand.headers or "")
    local referer_ok = hdrs.referer and "OK" or "MISSING"
    local origin_ok = hdrs.origin and "OK" or "MISSING"
    local cookie_ok = hdrs.cookie and "OK" or "MISSING"
    local ua_ok = hdrs["user-agent"] and "OK" or "MISSING"
    local auth_ok = hdrs.authorization and "OK" or "MISSING"
    add_row("Headers:", string.format("Referer:%s  Origin:%s  Cookie:%s  UA:%s  Auth:%s",
      referer_ok, origin_ok, cookie_ok, ua_ok, auth_ok), TEXT_WHITE)
    
    -- Qualities
    if cand.qualities and #cand.qualities > 0 then
      local qlabels = {}
      for _, q in ipairs(cand.qualities) do
        table.insert(qlabels, q.label or (q.height and (q.height .. "p")) or "Auto")
      end
      add_row("Qualities:", table.concat(qlabels, "  |  "), TEXT_MUTED)
    end
    
    add_row("Score:", tostring(cand.score or 0), TEXT_WHITE)
    add_row("Verified:", cand.verified and "YES" or "NO", cand.verified and NEON_GREEN or RED)
  else
    add_row("Candidate:", "No candidates available", TEXT_MUTED)
  end

  -- Live Player Telemetry
  row_y = row_y + 8
  table.insert(a, string.format("{\\an7\\pos(%d,%d)\\fs17\\b1\\bord0\\shad0\\1c%s}--- LIVE PLAYER TELEMETRY ---",
    x + 16, row_y, ass_rgb(NEON_GREEN)))
  row_y = row_y + row_h

  -- Use live telemetry from WebSocket bridge if available, fall back to local properties
  local live_time_pos = player_telemetry.time_pos or stream_info.time_pos
  local live_pause = player_telemetry.pause ~= nil and player_telemetry.pause or stream_info.pause
  local live_width = player_telemetry.width or stream_info.width
  local live_height = player_telemetry.height or stream_info.height
  local live_demuxer_cache = player_telemetry.demuxer_cache or stream_info.demuxer_cache
  local live_media_title = player_telemetry.media_title or mp.get_property("media-title") or ""
  
  add_row("Media Title:", safe_ass(live_media_title, "N/A"), TEXT_WHITE)
  add_row("Resolution:", string.format("%dx%d", live_width, live_height), live_width > 0 and NEON_GREEN or TEXT_MUTED)
  add_row("Time Pos:", string.format("%.1fs / %.1fs", live_time_pos, stream_info.duration), TEXT_WHITE)
  add_row("State:", (stream_info.idle_active and "IDLE" or (live_pause and "PAUSED" or "PLAYING")), live_pause and ORANGE or NEON_GREEN)
  add_row("Demuxer Cache:", string.format("%.1fs  (buffering: %d%%)", live_demuxer_cache, stream_info.cache_buffering), TEXT_WHITE)
  add_row("Video Codec:", stream_info.video_codec, TEXT_WHITE)
  add_row("Audio Codec:", stream_info.audio_codec, TEXT_WHITE)

  -- Stream info (local properties for comparison)
  row_y = row_y + 8
  table.insert(a, string.format("{\\an7\\pos(%d,%d)\\fs17\\b1\\bord0\\shad0\\1c%s}--- LOCAL MPV STATE ---",
    x + 16, row_y, ass_rgb(NEON_GREEN)))
  row_y = row_y + row_h

  add_row("Path:", stream_info.path ~= "" and stream_info.path or "N/A", TEXT_WHITE)
  add_row("Type:", stream_info.stream_type, NEON_GREEN)
  add_row("Video:", string.format("%s  %dx%d  %.0ffps", stream_info.video_codec, stream_info.width, stream_info.height, stream_info.fps), TEXT_WHITE)
  add_row("Audio:", stream_info.audio_codec, TEXT_WHITE)
  add_row("Demuxer Cache:", string.format("%.1fs  (buffering: %d%%)", stream_info.demuxer_cache, stream_info.cache_buffering), TEXT_WHITE)
  add_row("Position:", string.format("%.1fs / %.1fs", stream_info.time_pos, stream_info.duration), TEXT_WHITE)
  add_row("State:", (stream_info.idle_active and "IDLE" or (stream_info.pause and "PAUSED" or "PLAYING")), stream_info.pause and ORANGE or NEON_GREEN)

  -- Recent errors
  if #last_errors > 0 then
    row_y = row_y + 8
    table.insert(a, string.format("{\\an7\\pos(%d,%d)\\fs17\\b1\\bord0\\shad0\\1c%s}--- RECENT ERRORS ---",
      x + 16, row_y, ass_rgb(RED)))
    row_y = row_y + row_h
    for i, err in ipairs(last_errors) do
      if row_y > y + panel_h - 30 then break end
      local short_err = err
      if #short_err > 110 then short_err = short_err:sub(1, 107) .. "..." end
      table.insert(a, string.format("{\\an7\\pos(%d,%d)\\fs15\\bord0\\shad0\\1c%s}%s",
        x + 16, row_y, ass_rgb("FF6B6B"), safe_ass(short_err)))
      row_y = row_y + 22
    end
  end

  overlay.res_x = w
  overlay.res_y = h
  overlay.data = table.concat(a, "\n")
  overlay:update()
end

local function toggle()
  visible = not visible
  if visible then
    update_candidates()
    render()
  else
    overlay.data = ""
    overlay:remove()
  end
end

local function nav(dir)
  if not visible or #candidates == 0 then return end
  candidate_idx = candidate_idx + dir
  if candidate_idx < 1 then candidate_idx = #candidates end
  if candidate_idx > #candidates then candidate_idx = 1 end
  render()
end

mp.add_key_binding("Ctrl+Shift+D", "dev-tools/toggle", toggle)
mp.add_key_binding("RIGHT", "dev-tools/next", function() nav(1) end)
mp.add_key_binding("LEFT", "dev-tools/prev", function() nav(-1) end)

-- Auto-hide on file end
mp.register_event("end-file", function()
  if visible then toggle() end
end)

-- Observe demuxer errors
mp.observe_property("demuxer-error", "native", function(_, val)
  if val and val ~= "" then add_error("DEMUXER", val) end
end)

msg.info("dev-tools.lua loaded (Ctrl+Shift+D to toggle) - WebSocket Bridge Status Enabled")