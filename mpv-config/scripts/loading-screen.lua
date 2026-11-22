-- Enhanced MPV - Dark Studio opening sequence
-- 60 fps ASS overlay: neon ring, waveform, title, quality/codec pill, cache bar.

local mp = require("mp")
local assdraw = require("mp.assdraw")

local opts = {
    enabled = true,
    duration_ms = 1200,
    fade_ms = 260,
}
require("mp.options").read_options(opts, "loading-screen")
if not opts.enabled then return end

local BG = "0D1117"
local GREEN = "4ADE80"
local GREEN_DIM = "2D5A43"
local TEXT = "E6EDF3"
local MUTED = "8B949E"
local PANEL = "161B22"

local overlay = mp.create_osd_overlay("ass-events")
local timer = nil
local start_us = nil
local visible = false
local last_text = ""
local base_w, base_h = 1920, 1080

local function clamp(v, lo, hi)
    if v < lo then return lo end
    if v > hi then return hi end
    return v
end

local function ease_out(t)
    t = clamp(t, 0, 1)
    return 1 - (1 - t) * (1 - t)
end

local function ass_color(rgb, alpha)
    alpha = clamp(alpha or 0, 0, 255)
    return string.format("{\\1c&H%s&\\3c&H%s&\\alpha&H%02X&}", rgb, rgb, alpha)
end

local function ass_border(rgb, border, alpha)
    alpha = clamp(alpha or 0, 0, 255)
    return string.format("{\\bord%.2f\\1c&H%s&\\3c&H%s&\\alpha&H%02X&\\3a&H%02X&}", border, rgb, rgb, alpha, alpha)
end

local function update_base()
    local w, h = mp.get_osd_size()
    if w and h and w > 0 and h > 0 then
        base_w, base_h = w, h
    end
end

local function ass_pos(x, y)
    local px = math.floor(x * base_w / 1920 + 0.5)
    local py = math.floor(y * base_h / 1080 + 0.5)
    return string.format("{\\pos(%d,%d)}", px, py)
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

local function render(now_us)
    if not visible or not start_us then return end
    update_base()

    local elapsed_ms = (now_us - start_us) / 1000
    local total_ms = math.max(400, tonumber(opts.duration_ms) or 1200)
    local fade_ms = clamp(tonumber(opts.fade_ms) or 260, 60, total_ms)
    local fade_start = total_ms - fade_ms
    local alpha = 0
    if elapsed_ms >= total_ms then
        overlay.data = ""
        overlay:remove()
        visible = false
        last_text = ""
        if timer then timer:kill(); timer = nil end
        return
    elseif elapsed_ms > fade_start then
        alpha = math.floor(255 * clamp((elapsed_ms - fade_start) / fade_ms, 0, 1))
    end

    local t = elapsed_ms / 1000
    local intro = ease_out(elapsed_ms / 350)
    local pulse = 0.5 + 0.5 * math.sin(t * 4.8)
    local spin = t * 220
    local cache = cache_fraction()

    local a = assdraw.ass_new()
    -- Dark studio backdrop
    a:new_event()
    a:pos(0, 0)
    a:append(string.format("{\\an7\\bord0\\shad0\\1c&H%s&\\alpha&H%02X&}", BG, alpha))
    a:draw_start()
    a:rect_cw(0, 0, 1920, 1080)
    a:draw_stop()

    -- Center ring glow
    local cx, cy, r = 960, 470, 78
    a:new_event()
    a:pos(0, 0)
    a:append(string.format("{\\an7\\bord10\\shad0\\1a&HFF&\\3c&H%s&\\3a&H%02X&}", GREEN, clamp(alpha + 170 - math.floor(pulse * 30), 0, 255)))
    a:draw_start()
    a:round_rect_cw(cx - r, cy - r, cx + r, cy + r, r)
    a:draw_stop()

    -- Ring track
    a:new_event()
    a:pos(0, 0)
    a:append(string.format("{\\an7\\bord4\\shad0\\1a&HFF&\\3c&H%s&\\3a&H%02X&}", GREEN_DIM, clamp(alpha + 90, 0, 255)))
    a:draw_start()
    a:round_rect_cw(cx - r, cy - r, cx + r, cy + r, r)
    a:draw_stop()

    -- Spinning arc segments
    for i = 0, 2 do
        local ang = math.rad(spin + i * 120)
        local x1 = cx + math.cos(ang) * r
        local y1 = cy + math.sin(ang) * r
        local x2 = cx + math.cos(ang + 0.85) * r
        local y2 = cy + math.sin(ang + 0.85) * r
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

    -- Waveform bars
    local bars, bw, gap, baseY = 21, 10, 6, 565
    local startX = cx - ((bars * bw + (bars - 1) * gap) / 2)
    for i = 0, bars - 1 do
        local phase = t * 7 + i * 0.45
        local h = 10 + (math.sin(phase) * 0.5 + 0.5) * 34 * intro
        local x = startX + i * (bw + gap)
        local barAlpha = clamp(alpha + math.floor((1 - math.abs(i - bars / 2) / (bars / 2)) * 30), 0, 255)
        a:new_event()
        a:pos(0, 0)
        a:append(string.format("{\\an7\\bord0\\shad0\\1c&H%s&\\alpha&H%02X&}", (i % 4 == 0) and GREEN or GREEN_DIM, barAlpha))
        a:draw_start()
        a:round_rect_cw(math.floor(x), math.floor(baseY - h), math.floor(x + bw), math.floor(baseY + h), 3)
        a:draw_stop()
    end

    -- Title
    a:new_event()
    a:append(ass_pos(960, 650))
    a:append(string.format("{\\an5\\fs44\\bord0\\shad0\\fnmpv-osd-symbols\\1c&H%s&\\alpha&H%02X&}", TEXT, alpha))
    a:append(safe_text(media_title(), "Enhanced MPV"))

    -- Quality/codec pill
    local pill = safe_text(quality_pill(), "VIDEO")
    local pillW = clamp(220 + #pill * 8, 260, 560)
    local pillX, pillY = 960 - pillW / 2, 690
    a:new_event()
    a:pos(0, 0)
    a:append(string.format("{\\an7\\bord1\\shad0\\1c&H%s&\\3c&H%s&\\alpha&H%02X&\\3a&H%02X&}", PANEL, GREEN_DIM, clamp(alpha + 20, 0, 255), clamp(alpha + 40, 0, 255)))
    a:draw_start()
    a:round_rect_cw(math.floor(pillX), pillY, math.floor(pillX + pillW), pillY + 40, 20)
    a:draw_stop()
    a:new_event()
    a:append(ass_pos(960, 710))
    a:append(string.format("{\\an5\\fs24\\bord0\\shad0\\fnmpv-osd-symbols\\1c&H%s&\\alpha&H%02X&}", GREEN, alpha))
    a:append(pill)

    -- Cache bar
    local barW, barH = 420, 6
    local barX, barY = 960 - barW / 2, 760
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
    a:new_event()
    a:append(ass_pos(960, 782))
    a:append(string.format("{\\an5\\fs18\\bord0\\shad0\\fnmpv-osd-symbols\\1c&H%s&\\alpha&H%02X&}", MUTED, clamp(alpha + 20, 0, 255)))
    a:append("LOADING STREAM")

    local text = a.text
    if text ~= last_text then
        overlay.res_x = 1920
        overlay.res_y = 1080
        overlay.data = text
        overlay:update()
        last_text = text
    end
end

local function stop_overlay()
    if timer then timer:kill(); timer = nil end
    visible = false
    start_us = nil
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

mp.register_event("file-loaded", function()
    start_overlay()
end)

mp.observe_property("video-out-params", "native", function(_, value)
    if visible and value then
        stop_overlay()
    end
end)

mp.register_event("end-file", stop_overlay)
mp.register_event("shutdown", stop_overlay)
