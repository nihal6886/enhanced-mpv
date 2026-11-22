-- Enhanced MPV - Studio-Grade Dark Studio Loading Sequence
-- 60 fps ASS overlay: dual-arc neon ring, 15-bar waveform, centered title, dynamic status
-- Center-anchored (\an5) all elements using dynamic osd-dimensions (cx = w/2, cy = h/2)
-- Dynamic status from stream-controller.lua: PROBING STREAM 1/3... -> BUFFERING... -> SWITCHING TO STREAM 2/3...
-- Cross-fades \alpha out over 160ms once video-out-params confirms real frame (width > 0, height > 0)

local mp = require("mp")
local assdraw = require("mp.assdraw")

local opts = {
    enabled = true,
    duration_ms = 1200,
    fade_ms = 160,
}
require("mp.options").read_options(opts, "loading-screen")
if not opts.enabled then return end

local BG = "0D1117"
local GREEN = "4ADE80"
local GREEN_DIM = "2D5A43"
local TEXT = "F0F6FC"
local MUTED = "8B949E"
local PANEL = "161B22"

local overlay = mp.create_osd_overlay("ass-events")
local timer = nil
local start_us = nil
local fade_us = nil
local visible = false
local last_text = ""
local base_w, base_h = 1920, 1080

-- Dynamic status from stream-controller.lua
local dynamic_status = "INITIALIZING..."
local sniffer_state = "IDLE"
local zero_wait_ready = false

local function clamp(v, lo, hi)
    if v < lo then return lo end
    if v > hi then return hi end
    return v
end

local function ease_out(t)
    t = clamp(t, 0, 1)
    return 1 - (1 - t) * (1 - t)
end

local function ass_rgb(rgb)
    return string.format("&H%s&", rgb)
end

local function ass_alpha(alpha)
    alpha = clamp(alpha or 0, 0, 255)
    return string.format("&H%02X&", alpha)
end

local function update_base()
    local w, h = mp.get_osd_size()
    if w and h and w > 0 and h > 0 then
        base_w, base_h = w, h
    end
end

local function cx()
    return math.floor(base_w / 2)
end

local function cy()
    return math.floor(base_h / 2)
end

local function safe_text(value, fallback)
    value = tostring(value or ""):gsub("[\r\n]+", " "):gsub("{", ""):gsub("}", "")
    value = value:gsub("^%s+", ""):gsub("%s+$", "")
    if value == "" then return fallback end
    if #value > 72 then value = value:sub(1, 69) .. "..." end
    return value
end

local function media_title()
    local forced = mp.get_property("force-media-title")
    if forced and forced ~= "" and not forced:match("^https?://") then return forced end
    local title = mp.get_property("media-title")
    if title and title ~= "" and not title:match("^https?://") then return title end
    local filename = mp.get_property("filename/no-ext")
    if filename and filename ~= "" then return filename end
    return "Enhanced MPV"
end

local function quality_pill()
    local h = mp.get_property_number("height", 0)
    local fps = mp.get_property_number("container-fps", 0)
    local vcodec = mp.get_property("video-codec") or ""
    local codec = "VIDEO"
    if vcodec:match("av01") or vcodec:lower():match("av1") then codec = "AV1"
    elseif vcodec:match("hev") or vcodec:match("265") then codec = "HEVC"
    elseif vcodec:match("avc") or vcodec:match("264") then codec = "H264"
    elseif vcodec:match("vp9") then codec = "VP9"
    elseif vcodec:match("vp8") then codec = "VP8"
    end
    local parts = {}
    if h > 0 then parts[#parts + 1] = tostring(math.floor(h + 0.5)) .. "p" end
    if fps > 0 then parts[#parts + 1] = string.format("%.0ffps", fps) end
    parts[#parts + 1] = codec
    return table.concat(parts, "  ")
end

local function cache_fraction()
    local demux = mp.get_property_number("demuxer-cache-duration", 0) or 0
    local cache = mp.get_property_number("cache-buffering-state", 0) or 0
    if cache > 0 then return clamp(cache / 100, 0, 1) end
    return clamp(demux / 8, 0, 1)
end

-- Enhanced MPV - Studio-Grade Dark Studio Loading Sequence
-- 60 fps ASS overlay: dual-arc neon ring, 15-bar waveform, centered title, dynamic status
-- Center-anchored (\an5) all elements using dynamic osd-dimensions (cx = w/2, cy = h/2)
-- Dynamic status from PipelineState: SNIFFING -> PROBING -> PREWARMING -> SHADOW_READY -> LAUNCHING -> PLAYING | FAILOVER
-- Cross-fades \alpha out over 160ms once video-out-params confirms real frame (width > 0, height > 0)

local mp = require("mp")
local assdraw = require("mp.assdraw")
local utils = require("mp.utils")

local opts = {
    enabled = true,
    duration_ms = 1200,
    fade_ms = 160,
}
require("mp.options").read_options(opts, "loading-screen")
if not opts.enabled then return end

local BG = "0D1117"
local GREEN = "4ADE80"
local GREEN_DIM = "2D5A43"
local TEXT = "F0F6FC"
local MUTED = "8B949E"
local PANEL = "161B22"
local AMBER = "FBBF24"
local RED = "FF453A"

local overlay = mp.create_osd_overlay("ass-events")
local timer = nil
local start_us = nil
local fade_us = nil
local visible = false
local last_text = ""
local base_w, base_h = 1920, 1080

-- PipelineState from stream-controller.lua
local pipeline_stage = "IDLE"
local pipeline_candidate = nil
local pipeline_relay_stats = {}
local pipeline_prewarm_ms = 0
local pipeline_launch_ms = 0
local zero_wait_ready = false

local function clamp(v, lo, hi)
    if v < lo then return lo end
    if v > hi then return hi end
    return v
end

local function ease_out(t)
    t = clamp(t, 0, 1)
    return 1 - (1 - t) * (1 - t)
end

local function ass_rgb(rgb)
    return string.format("&H%s&", rgb)
end

local function ass_alpha(alpha)
    alpha = clamp(alpha or 0, 0, 255)
    return string.format("&H%02X&", alpha)
end

local function update_base()
    local w, h = mp.get_osd_size()
    if w and h and w > 0 and h > 0 then
        base_w, base_h = w, h
    end
end

local function cx()
    return math.floor(base_w / 2)
end

local function cy()
    return math.floor(base_h / 2)
end

local function safe_text(value, fallback)
    value = tostring(value or ""):gsub("[\r\n]+", " "):gsub("{", ""):gsub("}", "")
    value = value:gsub("^%s+", ""):gsub("%s+$", "")
    if value == "" then return fallback end
    if #value > 72 then value = value:sub(1, 69) .. "..." end
    return value
end

local function media_title()
    local forced = mp.get_property("force-media-title")
    if forced and forced ~= "" and not forced:match("^https?://") then return forced end
    local title = mp.get_property("media-title")
    if title and title ~= "" and not title:match("^https?://") then return title end
    local filename = mp.get_property("filename/no-ext")
    if filename and filename ~= "" then return filename end
    return "Enhanced MPV"
end

local function quality_pill()
    local h = mp.get_property_number("height", 0)
    local fps = mp.get_property_number("container-fps", 0)
    local vcodec = mp.get_property("video-codec") or ""
    local codec = "VIDEO"
    if vcodec:match("av01") or vcodec:lower():match("av1") then codec = "AV1"
    elseif vcodec:match("hev") or vcodec:match("265") then codec = "HEVC"
    elseif vcodec:match("avc") or vcodec:match("264") then codec = "H264"
    elseif vcodec:match("vp9") then codec = "VP9"
    elseif vcodec:match("vp8") then codec = "VP8"
    end
    local parts = {}
    if h > 0 then parts[#parts + 1] = tostring(math.floor(h + 0.5)) .. "p" end
    if fps > 0 then parts[#parts + 1] = string.format("%.0ffps", fps) end
    parts[#parts + 1] = codec
    return table.concat(parts, "  ")
end

local function cache_fraction()
    local demux = mp.get_property_number("demuxer-cache-duration", 0) or 0
    local cache = mp.get_property_number("cache-buffering-state", 0) or 0
    if cache > 0 then return clamp(cache / 100, 0, 1) end
    return clamp(demux / 8, 0, 1)
end

-- Receive PipelineState from stream-controller.lua
mp.register_script_message("pipeline_state_applied", function(json)
    local ok, data = pcall(utils.parse_json, json)
    if ok and data then
        pipeline_stage = data.stage or pipeline_stage
        pipeline_candidate = data.candidate
        pipeline_relay_stats = data.relayStats or {}
        pipeline_prewarm_ms = data.prewarmMs or 0
        pipeline_launch_ms = data.launchMs or 0
    end
end)

mp.register_script_message("shadow_ready", function(json)
    local ok, data = pcall(utils.parse_json, json)
    if ok and data then
        zero_wait_ready = true
        pipeline_stage = "SHADOW_READY"
        pipeline_candidate = data.candidate
        pipeline_prewarm_ms = data.prewarmMs or 0
    end
end)

mp.register_script_message("sniffer_state_change", function(json)
    local ok, data = pcall(utils.parse_json, json)
    if ok and data then
        if data.state then pipeline_stage = data.state end
        if data.zero_wait_ready ~= nil then zero_wait_ready = data.zero_wait_ready end
    end
end)

mp.register_script_message("loading-screen-status", function(status)
    -- Legacy support
    if status and status ~= "" and not pipeline_stage:match("SHADOW_READY") then
        -- Only use legacy status if not in advanced pipeline stage
    end
end)

local function get_dynamic_status()
    if pipeline_stage == "SHADOW_READY" then
        return string.format("⚡ SHADOW READY - %.0fms prewarm - INSTANT LAUNCH", pipeline_prewarm_ms)
    elseif pipeline_stage == "PREWARMING" then
        local title = pipeline_candidate and pipeline_candidate.title or "stream"
        return string.format("PREWARMING: %s...", safe_text(title, "stream"))
    elseif pipeline_stage == "PROBING" then
        return "PROBING STREAM..."
    elseif pipeline_stage == "SNIFFING" then
        return "SNIFFING STREAMS..."
    elseif pipeline_stage == "LAUNCHING" then
        return string.format("LAUNCHING... (%.0fms)", pipeline_launch_ms)
    elseif pipeline_stage == "PLAYING" then
        if zero_wait_ready then
            return "ZERO-WAIT HOT PATH: LIVE FRAME 1"
        end
        return "PLAYING"
    elseif pipeline_stage == "FAILOVER" then
        return "FAILOVER: SEARCHING NEXT STREAM..."
    elseif pipeline_stage == "IDLE" then
        return "IDLE"
    end
    return "INITIALIZING..."
end

local function get_relay_status_line()
    if not pipeline_relay_stats or not pipeline_relay_stats.bytesPrefetched then return "" end
    local mb = (pipeline_relay_stats.bytesPrefetched / 1024 / 1024)
    local segs = pipeline_relay_stats.segmentsCached or 0
    if mb < 0.1 then return "" end
    return string.format("RAM Ring: %.1f MiB / %d segs", mb, segs)
end

local function render(now_us)
    if not visible or not start_us then return end
    update_base()

    local elapsed_ms = (now_us - start_us) / 1000
    local fade_ms = clamp(tonumber(opts.fade_ms) or 160, 60, 2000)
    local alpha = 0
    if fade_us then
        local faded_ms = (now_us - fade_us) / 1000
        if faded_ms >= fade_ms then
            overlay.data = ""
            overlay:remove()
            visible = false
            fade_us = nil
            last_text = ""
            if timer then timer:kill(); timer = nil end
            return
        end
        alpha = math.floor(255 * clamp(faded_ms / fade_ms, 0, 1))
    end

    local t = elapsed_ms / 1000
    local intro = ease_out(elapsed_ms / 350)
    local pulse = 0.5 + 0.5 * math.sin(t * 4.8)
    local spin = t * 220
    local cache = cache_fraction()

    local cx_pos = cx()
    local cy_pos = cy()

    local a = assdraw.ass_new()
    -- Dark studio backdrop (full screen)
    a:new_event()
    a:pos(0, 0)
    a:append(string.format("{\\an7\\bord0\\shad0\\1c&H%s&\\alpha&H%02X&}", BG, alpha))
    a:draw_start()
    a:rect_cw(0, 0, base_w, base_h)
    a:draw_stop()

    -- Center ring glow (centered at cx, cy-92)
    local ring_cx, ring_cy, r = cx_pos, cy_pos - 92, 78
    a:new_event()
    a:pos(0, 0)
    a:append(string.format("{\\an7\\bord10\\shad0\\1a&HFF&\\3c&H%s&\\3a&H%02X&}", GREEN, clamp(alpha + 170 - math.floor(pulse * 30), 0, 255)))
    a:draw_start()
    a:round_rect_cw(ring_cx - r, ring_cy - r, ring_cx + r, ring_cx + r, r)
    a:draw_stop()

    -- Ring track
    a:new_event()
    a:pos(0, 0)
    a:append(string.format("{\\an7\\bord4\\shad0\\1a&HFF&\\3c&H%s&\\3a&H%02X&}", GREEN_DIM, clamp(alpha + 90, 0, 255)))
    a:draw_start()
    a:round_rect_cw(ring_cx - r, ring_cy - r, ring_cx + r, ring_cx + r, r)
    a:draw_stop()

    -- Spinning arc segments (3 arcs, 120deg apart)
    for i = 0, 2 do
        local ang = math.rad(spin + i * 120)
        local x1 = ring_cx + math.cos(ang) * r
        local y1 = ring_cy + math.sin(ang) * r
        local x2 = ring_cx + math.cos(ang + 0.85) * r
        local y2 = ring_cy + math.sin(ang + 0.85) * r
        a:new_event()
        a:pos(0, 0)
        a:append(string.format("{\\an7\\bord0\\shad0\\1c&H%s&\\alpha&H%02X&}", GREEN, clamp(alpha + 20, 0, 255)))
        a:draw_start()
        a:move_to(math.floor(x1), math.floor(y1))
        a:line_to(math.floor(x2), math.floor(y2))
        a:line_to(math.floor(x2 + math.cos(ang + 0.42) * 5), math.floor(y2 + math.sin(ang + 0.42) * 5))
        a:line_to(math.floor(x1 + math.cos(ang + 0.42) * 5), math.floor(y1 + math.sin(ang + 0.42) * 5))
        a:draw_stop()
    end

    -- Symmetrical 15-bar waveform (centered below ring at cy+8)
    local bars, bw, gap = 15, 12, 8
    local baseY = cy_pos + 8
    local startX = cx_pos - ((bars * bw + (bars - 1) * gap) / 2)
    for i = 0, bars - 1 do
        local phase = t * 7 + i * 0.45
        local h = 12 + (math.sin(phase) * 0.5 + 0.5) * 38 * intro
        local x = startX + i * (bw + gap)
        local barAlpha = clamp(alpha + math.floor((1 - math.abs(i - bars / 2) / (bars / 2)) * 30), 0, 255)
        a:new_event()
        a:pos(0, 0)
        a:append(string.format("{\\an7\\bord0\\shad0\\1c&H%s&\\alpha&H%02X&}", (i % 4 == 0) and GREEN or GREEN_DIM, barAlpha))
        a:draw_start()
        a:round_rect_cw(math.floor(x), math.floor(baseY - h), math.floor(x + bw), math.floor(baseY + h), 3)
        a:draw_stop()
    end

    -- Top badge: ENHANCED MPV + quality/codec pill (cy - 105)
    local badge_y = cy_pos - 105
    local pill = safe_text(quality_pill(), "VIDEO")
    local pillW = clamp(200 + #pill * 7, 220, 480)
    local pillX = cx_pos - math.floor(pillW / 2)
    
    a:new_event()
    a:pos(0, 0)
    a:append(string.format("{\\an5\\fs20\\b1\\bord0\\shad0\\1c&H%s&\\alpha&H%02X&}", GREEN, alpha))
    a:move_to(cx_pos - 100, badge_y)
    a:line_to(cx_pos + 100, badge_y)
    a:draw_stop()
    
    a:new_event()
    a:pos(0, 0)
    a:append(string.format("{\\an5\\fs16\\bord0\\shad0\\1c&H%s&\\alpha&H%02X&}", TEXT, alpha))
    a:move_to(cx_pos, badge_y)
    a:append("ENHANCED MPV")

    -- Quality/codec pill
    a:new_event()
    a:pos(0, 0)
    a:append(string.format("{\\an7\\bord1\\shad0\\1c&H%s&\\3c&H%s&\\alpha&H%02X&\\3a&H%02X&}", PANEL, GREEN_DIM, clamp(alpha + 20, 0, 255), clamp(alpha + 40, 0, 255)))
    a:draw_start()
    a:round_rect_cw(pillX, badge_y + 18, pillX + pillW, badge_y + 18 + 32, 16)
    a:draw_stop()
    a:new_event()
    a:append(string.format("{\\an5\\fs18\\bord0\\shad0\\fnmpv-osd-symbols\\1c&H%s&\\alpha&H%02X&}", GREEN, alpha))
    a:move_to(cx_pos, badge_y + 34)
    a:append(pill)

    -- Title: single-line centered #F0F6FC at cy - 58 (ellipsized at 58 chars)
    local title = safe_text(media_title(), "Enhanced MPV")
    a:new_event()
    a:append(string.format("{\\an5\\fs42\\bord0\\shad0\\fnmpv-osd-symbols\\1c&H%s&\\alpha&H%02X&}", TEXT, alpha))
    a:move_to(cx_pos, cy_pos - 58)
    a:append(title)

    -- Dynamic PipelineState status at cy + 78
    local dynamic_status = get_dynamic_status()
    local status_color = GREEN
    if pipeline_stage == "FAILOVER" then status_color = RED
    elseif pipeline_stage == "PREWARMING" then status_color = AMBER
    elseif pipeline_stage == "SHADOW_READY" then status_color = GREEN
    end
    a:new_event()
    a:append(string.format("{\\an5\\fs22\\bord0\\shad0\\fnmpv-osd-symbols\\1c&H%s&\\alpha&H%02X&}", status_color, alpha))
    a:move_to(cx_pos, cy_pos + 78)
    a:append(dynamic_status)

    -- Relay stats line (RAM Segment Ring)
    local relay_line = get_relay_status_line()
    if relay_line ~= "" then
        a:new_event()
        a:append(string.format("{\\an5\\fs16\\bord0\\shad0\\1c&H%s&\\alpha&H%02X&}", MUTED, alpha))
        a:move_to(cx_pos, cy_pos + 104)
        a:append(relay_line)
    end

    -- Progress bar at cy + 126 (sharing exact cx center)
    local barW, barH = 420, 6
    local barX = cx_pos - math.floor(barW / 2)
    local barY = cy_pos + 126
    
    a:new_event()
    a:pos(0, 0)
    a:append(string.format("{\\an7\\bord0\\shad0\\1c&H%s&\\alpha&H%02X&}", "243041", clamp(alpha + 30, 0, 255)))
    a:draw_start()
    a:round_rect_cw(barX, barY, barX + barW, barY + barH, 3)
    a:draw_stop()
    
    a:new_event()
    a:pos(0, 0)
    a:append(string.format("{\\an7\\bord0\\shad0\\1c&H%s&\\alpha&H%02X&}", GREEN, alpha))
    a:draw_start()
    a:round_rect_cw(barX, barY, barX + math.floor(barW * clamp(cache, 0.06, 1)), barY + barH, 3)
    a:draw_stop()

    local text = a.text
    if text ~= last_text then
        overlay.res_x = base_w
        overlay.res_y = base_h
        overlay.data = text
        overlay:update()
        last_text = text
    end
end

local function stop_overlay()
    if timer then timer:kill(); timer = nil end
    visible = false
    start_us = nil
    fade_us = nil
    last_text = ""
    overlay.data = ""
    overlay:remove()
end

local function start_overlay()
    stop_overlay()
    visible = true
    start_us = mp.get_time() * 1000000
    render(start_us)
    timer = mp.add_periodic_timer(1 / 60, function()
        render(mp.get_time() * 1000000)
    end)
end

local function crossfade_out()
    if visible and not fade_us then
        fade_us = mp.get_time() * 1000000
    end
end

mp.register_event("start-file", start_overlay)

mp.register_script_message("enhanced-mpv-loading", function()
    start_overlay()
end)

mp.observe_property("video-out-params", "native", function(_, value)
    if value and value.w and value.h and value.w > 0 and value.h > 0 then
        crossfade_out()
    end
end)

mp.register_event("end-file", stop_overlay)
mp.register_event("shutdown", stop_overlay)

msg.info("loading-screen.lua loaded (studio-grade 60fps centered)")