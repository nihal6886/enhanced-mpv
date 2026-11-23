-- Minimal dark-studio startup overlay. Drawing commands are isolated from text
-- events so ASS vector mode can never leak raw coordinates into the labels.
local mp = require("mp")
local assdraw = require("mp.assdraw")
local msg = require("mp.msg")

local opts = { enabled = true, fade_ms = 120 }
require("mp.options").read_options(opts, "loading-screen")
if not opts.enabled then return end

local overlay = mp.create_osd_overlay("ass-events")
local timer, started, fade_started
local visible = false
local width, height = 1920, 1080
local video_width, video_height, core_idle = 0, 0, true
local title = ""

local function clamp(value, low, high)
    return math.max(low, math.min(high, value))
end

local function clean_text(value, fallback, limit)
    value = tostring(value or ""):gsub("[\r\n{}]", " "):gsub("%s+", " "):match("^%s*(.-)%s*$")
    if value == "" then value = fallback end
    if #value > limit then value = value:sub(1, limit - 3) .. "..." end
    if value:match("https?://") or value:match("%.m3u8") then return fallback end
    return value
end

local function draw_rect(out, x1, y1, x2, y2, color)
    out:new_event()
    out:pos(0, 0)
    out:append(string.format("{\\an7\\bord0\\shad0\\1c&H%s&}", color))
    out:draw_start()
    out:round_rect_cw(x1, y1, x2, y2, math.floor((y2 - y1) / 2))
    out:draw_stop()
    -- Explicitly leave vector drawing mode in a separate event/layer.
    out:new_event()
    out:pos(0, 0)
    out:append("{\\an7\\p0}")
end

local function status()
    if video_width > 0 and video_height > 0 and not core_idle then return "READY" end
    if started and mp.get_time() - started > 0.15 then return "BUFFERING FIRST FRAME..." end
    return "CONNECTING STREAM..."
end

local function quality()
    local codec = (mp.get_property("video-codec") or ""):lower()
    local label = codec:find("av1", 1, true) and "AV1" or codec:find("hevc", 1, true) and "HEVC" or codec:find("h264", 1, true) and "H.264" or "VIDEO"
    if video_width > 0 and video_height > 0 then return string.format("%dx%d  |  %s", video_width, video_height, label) end
    return "STREAM  |  " .. label
end

local function render(now)
    if not visible or not started then return end
    local w, h = mp.get_osd_size()
    if w and h and w > 0 and h > 0 then width, height = w, h end
    local alpha = 0
    if fade_started then
        local progress = clamp((now - fade_started) * 1000 / math.max(1, tonumber(opts.fade_ms) or 120), 0, 1)
        alpha = math.floor(progress * 255)
        if progress >= 1 then overlay.data = ""; overlay:remove(); visible = false; if timer then timer:kill(); timer = nil end; return end
    end
    local cx, cy = math.floor(width / 2), math.floor(height / 2)
    local bar_width, bar_y = math.min(560, math.floor(width * 0.55)), cy - 125
    local progress = clamp((now - started) / 2.5, 0.08, 0.94)
    local out = assdraw.ass_new()
    out:new_event(); out:pos(0, 0)
    out:append(string.format("{\\an7\\bord0\\shad0\\1c&H17110D&\\alpha&H%02X&}", alpha))
    out:draw_start(); out:rect_cw(0, 0, width, height); out:draw_stop()
    out:new_event(); out:pos(24, 22)
    out:append(string.format("{\\an7\\fs11\\bord0\\shad0\\1c&H9E948B&\\alpha&H%02X&}ENHANCED MPV v1.1.0", alpha))
    draw_rect(out, cx - math.floor(bar_width / 2), bar_y, cx + math.floor(bar_width / 2), bar_y + 5, "221B16")
    draw_rect(out, cx - math.floor(bar_width / 2), bar_y, cx - math.floor(bar_width / 2) + math.floor(bar_width * progress), bar_y + 5, "80DE4A")
    out:new_event(); out:pos(cx, cy - 53)
    out:append(string.format("{\\an5\\fs36\\bord0\\shad0\\1c&HFCF6F0&\\alpha&H%02X&}%s", alpha, clean_text(title, "Enhanced MPV", 64)))
    out:new_event(); out:pos(cx, cy + 5)
    out:append(string.format("{\\an5\\fs19\\bord0\\shad0\\1c&H80DE4A&\\alpha&H%02X&}%s", alpha, status()))
    draw_rect(out, cx - 115, cy + 24, cx + 115, cy + 54, "221B16")
    out:new_event(); out:pos(cx, cy + 38)
    out:append(string.format("{\\an5\\fs15\\bord0\\shad0\\1c&H9E948B&\\alpha&H%02X&}%s", alpha, clean_text(quality(), "STREAM", 40)))
    overlay.res_x, overlay.res_y, overlay.data = width, height, out.text
    overlay:update()
end

local function stop()
    if timer then timer:kill(); timer = nil end
    visible, started, fade_started = false, nil, nil
    overlay.data = ""; overlay:remove()
end

local function try_fade()
    if visible and video_width > 0 and video_height > 0 and not core_idle and not fade_started then
        fade_started = mp.get_time()
    end
end

local function start()
    stop(); video_width, video_height, core_idle = 0, 0, true
    visible = true; started = mp.get_time(); title = clean_text(mp.get_property("force-media-title") or mp.get_property("media-title"), "Enhanced MPV", 64)
    timer = mp.add_periodic_timer(1 / 60, function() render(mp.get_time()); try_fade() end)
    render(started)
end

mp.register_event("start-file", start)
mp.register_event("end-file", stop)
mp.observe_property("video-out-params", "native", function(_, value)
    video_width = value and (value.w or value.width) or 0
    video_height = value and (value.h or value.height) or 0
    try_fade()
end)
mp.observe_property("core-idle", "native", function(_, value) core_idle = value ~= false; try_fade() end)
mp.register_script_message("enhanced-mpv-loading", function(value) title = clean_text(value, "Enhanced MPV", 64); start() end)
mp.register_event("shutdown", stop)
msg.info("loading-screen.lua v1.1.0 loaded")
