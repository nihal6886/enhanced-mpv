--[[
  stream-controller.lua

  Unified Lua state machine for candidate failover, quality/source switching,
  and loading-screen state updates. Replaces split/racing failover timers
  between mpv-launcher.js and player-menus.lua.

  Responsibilities:
  - Candidate failover (1.8s timeout if width == 0 or end-file error)
  - Quality tiers (q) and All Working Links (Shift+Q) switching with exact time-pos preservation
  - Emits state updates to loading-screen.lua and dev-tools.lua
  - Single source of truth for current stream state
  - Consumes unified PipelineState from daemon (SNIFFING -> PROBING -> PREWARMING
    -> SHADOW_READY -> LAUNCHING -> PLAYING | FAILOVER)
]]

local mp = require("mp")
local msg = require("mp.msg")
local utils = require("mp.utils")

local advance_candidate, build_header_fields, get_stream_type

-- Pipeline stages from daemon
local PipelineStage = {
  IDLE = "IDLE",
  SNIFFING = "SNIFFING",
  PROBING = "PROBING",
  PREWARMING = "PREWARMING",
  SHADOW_READY = "SHADOW_READY",
  LAUNCHING = "LAUNCHING",
  PLAYING = "PLAYING",
  FAILOVER = "FAILOVER",
}

local state = {
  candidates = {},
  current_idx = 1,
  current_url = "",
  current_title = "",
  stream_type = "UNKNOWN",
  verified = false,
  failover_timer = nil,
  failover_armed = false,
  loading_state = "IDLE",
  last_time_pos = 0,
  last_duration = 0,
  video_width = 0,
  video_height = 0,
  bridge_connected = false,
  bridge_candidate_count = 0,
  sniffer_state = "IDLE", -- mirrors daemon PipelineStage
  zero_wait_ready = false,
  relay_stats = {},
  prewarm_ms = 0,
  launch_ms = 0,
}

local function send_state_update(event, data)
  data = data or {}
  data.event = event
  data.timestamp = mp.get_time()
  data.bridge_connected = state.bridge_connected
  data.bridge_candidate_count = state.bridge_candidate_count
  data.sniffer_state = state.sniffer_state
  data.zero_wait_ready = state.zero_wait_ready
  data.relay_stats = state.relay_stats
  data.prewarm_ms = state.prewarm_ms
  data.launch_ms = state.launch_ms
  local json = utils.format_json(data)
  mp.commandv("script-message", "stream-controller-state", json)
end

local function update_loading_screen(status)
  state.loading_state = status
  mp.commandv("script-message", "loading-screen-status", status)
  -- Also send sniffer state update
  send_state_update("sniffer_state_change", { state = state.sniffer_state, loading = status })
end

local function arm_failover()
  if state.failover_timer then
    state.failover_timer:kill()
    state.failover_timer = nil
  end
  state.failover_armed = true
  state.sniffer_state = PipelineStage.FAILOVER
  update_loading_screen("FAILOVER: SEARCHING NEXT STREAM...")
  state.failover_timer = mp.add_timeout(1.8, function()
    if state.failover_armed then
      msg.warn("stream-controller: failover timeout triggered (1.8s), advancing to next candidate")
      advance_candidate()
    end
  end)
end

local function disarm_failover()
  state.failover_armed = false
  if state.failover_timer then
    state.failover_timer:kill()
    state.failover_timer = nil
  end
  if state.sniffer_state == PipelineStage.FAILOVER then
    state.sniffer_state = PipelineStage.PLAYING
  end
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

local function load_candidates()
  local src = parse_sources_json()
  if src and src.candidates and #src.candidates > 0 then
    state.candidates = src.candidates
    state.current_idx = 1
    state.current_title = src.title or ""
    msg.info("stream-controller: loaded " .. #state.candidates .. " candidates")
    send_state_update("candidates_loaded", { count = #state.candidates, title = state.current_title })
    return true
  end
  state.candidates = {}
  state.current_idx = 1
  return false
end



local function find_verified_candidate()
  for i, c in ipairs(state.candidates) do
    if c.verified and c.url and c.url ~= "" then
      return i, c
    end
  end
  return nil, nil
end

local function switch_to_candidate(idx, preserve_time)
  if idx < 1 or idx > #state.candidates then return false end

  local cand = state.candidates[idx]
  if not cand or not cand.url or cand.url == "" then return false end

  local pos = preserve_time and (state.last_time_pos or 0) or 0
  local opts = {
    ytdl = "no",
    ["resume-playback"] = "no",
    ["demuxer-lavf-analyzeduration"] = "0.25",
    ["demuxer-lavf-probesize"] = "131072",
    ["cache"] = "yes",
    ["cache-secs"] = "15",
    ["demuxer-readahead-secs"] = "8",
    ["cache-pause-initial"] = "no",
    ["cache-pause-wait"] = "0.1",
    ["vd-lavc-threads"] = "0",
    ["hls-bitrate"] = "max",
    start = (pos > 1) and string.format("%.3f", pos) or "none",
  }

  local hdrs = build_header_fields(cand.headers or {})
  if hdrs ~= "" then
    opts["http-header-fields"] = hdrs
  end

  mp.commandv("change-list", "audio-files", "clr", "")
  if cand.audioUrl and cand.audioUrl ~= "" then
    mp.commandv("change-list", "demuxer-lavf-o", "append", "allowed_extensions=ALL")
    opts["audio-files-append"] = cand.audioUrl
  end

  state.current_idx = idx
  state.current_url = cand.url
  state.verified = cand.verified or false
  state.stream_type = get_stream_type(cand.url)
  state.sniffer_state = PipelineStage.PROBING
  state.zero_wait_ready = false

  update_loading_screen("PROBING STREAM " .. idx .. "/" .. #state.candidates .. "...")
  send_state_update("switching", { index = idx, total = #state.candidates, url = cand.url })

  mp.command_native({ "loadfile", cand.url, "replace", -1, opts })
  mp.set_property_bool("pause", false)

  -- Arm failover for new stream
  arm_failover()

  return true
end

advance_candidate = function()
  if #state.candidates <= 1 then
    msg.warn("stream-controller: no fallback candidates available")
    update_loading_screen("NO FALLBACK STREAMS")
    send_state_update("failover_exhausted", {})
    return false
  end

  local next_idx = state.current_idx + 1
  if next_idx > #state.candidates then next_idx = 1 end

  msg.info("stream-controller: failover to candidate " .. next_idx .. "/" .. #state.candidates)
  return switch_to_candidate(next_idx, true)
end

get_stream_type = function(url)
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

build_header_fields = function(headers)
  if type(headers) ~= "table" then return "" end
  local parts = {}
  for k, v in pairs(headers) do
    if v and tostring(v) ~= "" then
      local escaped = tostring(v):gsub("\\", "\\\\"):gsub(",", "\\,")
      table.insert(parts, tostring(k) .. ": " .. escaped)
    end
  end
  return table.concat(parts, ",")
end

-- Apply PipelineState from daemon
local function apply_pipeline_state(ps)
  if not ps or not ps.stage then return end

  local prevStage = state.sniffer_state
  state.sniffer_state = ps.stage
  state.relay_stats = ps.relayStats or {}
  state.prewarm_ms = ps.prewarmMs or 0
  state.launch_ms = ps.launchMs or 0

  -- Update candidates if provided
  if ps.candidates and #ps.candidates > 0 then
    state.candidates = ps.candidates
    state.bridge_candidate_count = #ps.candidates
    if state.current_idx > #state.candidates then
      state.current_idx = 1
    end
  end
  if ps.candidate then
    state.current_title = ps.candidate.title or state.current_title
  end

  -- React to stage transitions
  if ps.stage == PipelineStage.SHADOW_READY then
    state.zero_wait_ready = true
    update_loading_screen("SHADOW READY - INSTANT LAUNCH")
    send_state_update("shadow_ready", { candidate = ps.candidate, prewarmMs = ps.prewarmMs })
  elseif ps.stage == PipelineStage.LAUNCHING then
    update_loading_screen("LAUNCHING...")
  elseif ps.stage == PipelineStage.PLAYING then
    state.zero_wait_ready = true
    disarm_failover()
    update_loading_screen("PLAYING")
  elseif ps.stage == PipelineStage.FAILOVER then
    state.zero_wait_ready = false
    -- Failover handled by arm_failover/disarm_failover
  elseif ps.stage == PipelineStage.PREWARMING then
    update_loading_screen("PREWARMING: " .. (ps.candidate and ps.candidate.title or "stream").. "...")
  elseif ps.stage == PipelineStage.PROBING then
    update_loading_screen("PROBING...")
  elseif ps.stage == PipelineStage.SNIFFING then
    update_loading_screen("SNIFFING...")
  elseif ps.stage == PipelineStage.IDLE then
    state.zero_wait_ready = false
    update_loading_screen("IDLE")
  end

  send_state_update("pipeline_state_applied", {
    stage = ps.stage,
    prevStage = prevStage,
    candidate = ps.candidate,
    relayStats = state.relay_stats,
    prewarmMs = state.prewarm_ms,
    launchMs = state.launch_ms,
  })
end

-- Initialize on file load
mp.register_event("file-loaded", function()
  state.last_time_pos = 0
  state.last_duration = mp.get_property_number("duration") or 0
  state.video_width = mp.get_property_number("width") or 0
  state.video_height = mp.get_property_number("height") or 0

  local path = mp.get_property("path") or ""
  if path ~= state.current_url and #state.candidates > 0 then
    -- New file loaded via external means (e.g., mpv-launcher.js)
    -- Find matching candidate
    for i, c in ipairs(state.candidates) do
      if c.url == path or (c.playUrl and c.playUrl == path) then
        state.current_idx = i
        state.current_url = path
        state.verified = c.verified or false
        state.stream_type = get_stream_type(path)
        break
      end
    end
  end

  disarm_failover()
  arm_failover()
  update_loading_screen("BUFFERING...")
  send_state_update("file_loaded", { url = path, index = state.current_idx, total = #state.candidates })
end)

-- Track video-out-params to disarm failover when real frame arrives
mp.observe_property("video-out-params", "native", function(_, value)
  if value and value.w and value.h and value.w > 0 and value.h > 0 then
    state.video_width = value.w
    state.video_height = value.h
    if state.failover_armed then
      disarm_failover()
      update_loading_screen("READY")
      send_state_update("stream_ready", { width = value.w, height = value.h })
    end
    state.sniffer_state = PipelineStage.PLAYING
    state.zero_wait_ready = true
    send_state_update("sniffer_state_change", { state = PipelineStage.PLAYING, zero_wait_ready = true })
  end
end)

-- Track playback position for seamless switching
mp.observe_property("time-pos", "number", function(_, val)
  if val and val > 0 then
    state.last_time_pos = val
  end
end)

-- Handle end-file for failover
mp.register_event("end-file", function(reason)
  if reason and reason.error and state.failover_armed then
    msg.warn("stream-controller: end-file error during failover window: " .. (reason.error or "unknown"))
    mp.add_timeout(0.1, function()
      if state.failover_armed then
        advance_candidate()
      end
    end)
  else
    disarm_failover()
  end
end)

-- Handle IPC messages from mpv-launcher.js / player-menus.lua / WebSocket bridge
mp.register_script_message("stream-controller-load", function(json)
  local ok, data = pcall(utils.parse_json, json)
  if ok and data and data.candidates then
    local had_candidates = #state.candidates > 0
    state.candidates = data.candidates
    state.current_idx = data.current_index or 1
    state.current_title = data.title or ""
    state.current_url = data.current_url or ""
    state.verified = data.verified or false
    state.bridge_candidate_count = #data.candidates
    msg.info("stream-controller: loaded " .. #state.candidates .. " candidates via IPC")
    send_state_update("candidates_loaded", { count = #state.candidates })

    -- If we were probing/failover and now have verified candidates, switch immediately
    if state.failover_armed or state.loading_state == "PROBING" or state.loading_state == "FAILOVER" then
      local verified_idx = find_verified_candidate()
      if verified_idx and verified_idx ~= state.current_idx then
        msg.info("stream-controller: verified candidate discovered during failover, switching to " .. verified_idx)
        switch_to_candidate(verified_idx, true)
      end
    end

    if not had_candidates then
      arm_failover()
    end
  end
end)

-- Handle real-time candidate updates from WebSocket bridge (sniffer -> player)
mp.register_script_message("enhanced-mpv-sources", function(json)
  local ok, data = pcall(utils.parse_json, json)
  if ok and data and data.candidates then
    local old_count = #state.candidates
    local had_candidates = old_count > 0

    state.candidates = data.candidates
    state.bridge_candidate_count = #data.candidates

    -- Update current index if it was valid
    if state.current_idx > #state.candidates then
      state.current_idx = 1
    end

    if #state.candidates > 0 then
      state.current_title = data.title or state.current_title
      state.current_url = data.current_url or state.current_url
      state.verified = data.verified or false
    end

    msg.info("stream-controller: hot-reloaded " .. #state.candidates .. " candidates from WebSocket bridge")
    send_state_update("candidates_hot_reloaded", {
      count = #state.candidates,
      old_count = old_count,
      title = state.current_title
    })

    -- Hot-reload quality/source menus by notifying player-menus.lua
    mp.commandv("script-message", "player-menus-refresh", utils.format_json({
      candidates = state.candidates,
      current_index = state.current_idx
    }))

    -- If we were probing/failover and now have verified candidates, switch immediately
    if state.failover_armed or state.loading_state == "PROBING" or state.loading_state == "FAILOVER" then
      local verified_idx = find_verified_candidate()
      if verified_idx and verified_idx ~= state.current_idx then
        msg.info("stream-controller: verified candidate discovered during failover, switching to " .. verified_idx)
        switch_to_candidate(verified_idx, true)
      elseif #state.candidates > 0 and state.current_idx == 1 and not had_candidates then
        -- First candidates ever loaded while probing - start playing the first one
        msg.info("stream-controller: first candidates loaded during probing, starting stream 1")
        switch_to_candidate(1, false)
      end
    end

    if not had_candidates and #state.candidates > 0 then
      arm_failover()
    end
  end
end)

-- Consume unified PipelineState from daemon (single source of truth)
mp.register_script_message("pipeline:state", function(json)
  local ok, data = pcall(utils.parse_json, json)
  if ok and data and data.payload then
    apply_pipeline_state(data.payload)
  end
end)

mp.register_script_message("stream-controller-switch", function(idx_str)
  local idx = tonumber(idx_str)
  if idx then
    local preserve = (idx ~= state.current_idx)
    switch_to_candidate(idx, preserve)
  end
end)

mp.register_script_message("stream-controller-advance", function()
  advance_candidate()
end)

mp.register_script_message("stream-controller-get-state", function()
  send_state_update("state_response", {
    candidates = state.candidates,
    current_index = state.current_idx,
    current_url = state.current_url,
    title = state.current_title,
    verified = state.verified,
    stream_type = state.stream_type,
    loading_state = state.loading_state,
    video_width = state.video_width,
    video_height = state.video_height,
    bridge_connected = state.bridge_connected,
    bridge_candidate_count = state.bridge_candidate_count,
    sniffer_state = state.sniffer_state,
    zero_wait_ready = state.zero_wait_ready,
    relay_stats = state.relay_stats,
    prewarm_ms = state.prewarm_ms,
    launch_ms = state.launch_ms,
  })
end)

-- WebSocket bridge status updates from launch-daemon.js
mp.register_script_message("bridge-status", function(json)
  local ok, data = pcall(utils.parse_json, json)
  if ok and data then
    state.bridge_connected = data.connected or false
    msg.info("stream-controller: WebSocket bridge " .. (state.bridge_connected and "connected" or "disconnected"))
    send_state_update("bridge_status", { connected = state.bridge_connected })
  end
end)

-- Load candidates from sources.json on startup
load_candidates()

-- Initial state broadcast
send_state_update("initialized", {
  candidates = state.candidates,
  current_index = state.current_idx,
  bridge_connected = state.bridge_connected,
  bridge_candidate_count = state.bridge_candidate_count
})

msg.info("stream-controller.lua loaded")
