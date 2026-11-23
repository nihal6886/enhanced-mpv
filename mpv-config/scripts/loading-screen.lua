-- Interactive geometric loading screen. Every vector and text item is its own
-- ASS event; vector coordinates therefore never share an event with text.
local mp = require("mp")
local assdraw = require("mp.assdraw")
local msg = require("mp.msg")

local opts = { enabled = true, fade_ms = 120 }
require("mp.options").read_options(opts, "loading-screen")
if not opts.enabled then return end

local overlay = mp.create_osd_overlay("ass-events")
local timer, started, fade_started
local visible, width, height = false, 1920, 1080
local video_width, video_height, core_idle = 0, 0, true
local title, last_mouse, mouse_moved, stage, counter_value = "", nil, 0, 0, 0
local badges = {}
local badge_count = 7
for i = 1, badge_count do badges[i] = { x = 960, y = 540, angle = 0, scale = 100 } end

local function clamp(v, lo, hi) return math.max(lo, math.min(hi, v)) end
local function clean_text(value, fallback, limit)
    value = tostring(value or ""):gsub("[\r\n{}]", " "):gsub("%s+", " "):match("^%s*(.-)%s*$")
    if value == "" or value:match("https?://") or value:match("%.m3u8") then return fallback end
    if #value > limit then value = value:sub(1, limit - 3) .. "..." end
    return value
end

local function text_event(out, x, y, align, size, color, alpha, value, extra)
    out:new_event(); out:pos(x, y)
    out:append(string.format("{\\an%d\\fs%d\\bord0\\shad0\\1c&H%s&\\alpha&H%02X&%s}%s", align, size, color, alpha, extra or "", value))
end

local function vector_event(out, x, y, color, alpha, drawing, extra)
    out:new_event(); out:pos(x, y)
    out:append(string.format("{\\an7\\bord0\\shad0\\1c&H%s&\\alpha&H%02X&%s\\p1}", color, alpha, extra or ""))
    out:append(drawing)
    out:append("{\\p0}")
end

local function path(points, close)
    local s = "m " .. points[1][1] .. " " .. points[1][2]
    for i = 2, #points do s = s .. " l " .. points[i][1] .. " " .. points[i][2] end
    if close then s = s .. " l " .. points[1][1] .. " " .. points[1][2] end
    return s
end

local function circle(cx, cy, r)
    -- Cubic Béziers, compatible with libass vector drawing.
    local k = math.floor(r * 0.5523)
    return string.format("m %d %d b %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d c", cx+r,cy, cx+r,cy+k,cx+k,cy+r,cx,cy+r, cx-k,cy+r,cx-r,cy+k,cx-r,cy, cx-r,cy-k,cx-k,cy-r,cx,cy-r, cx+k,cy-r,cx+r,cy-k,cx+r,cy)
end

local function badge_shape(i, t)
    if i == 1 then
        local pts = {}; for n=0,15 do local a=n*math.pi/8; local r=(n%2==0) and 32 or 17; pts[#pts+1]={math.floor(math.cos(a)*r),math.floor(math.sin(a)*r)} end
        return path(pts,true), "80DE4A"
    elseif i == 2 then return circle(0,0,30) .. " " .. circle(0,0,20) .. " " .. circle(0,0,8), "F7F0E8"
    elseif i == 3 then return circle(0,0,29) .. " " .. circle(0,0,20), "506AFF"
    elseif i == 4 then
        local s=""; for n=0,3 do local a=n*math.pi/2+math.pi/4; s=s .. circle(math.floor(math.cos(a)*13),math.floor(math.sin(a)*13),13) .. " " end
        return s, "B77AFF"
    elseif i == 5 then return circle(-10,-5,5) .. " " .. circle(10,-5,5) .. " " .. path({{-13,8},{-8,17},{0,21},{8,17},{13,8}},false), "80DE4A"
    elseif i == 6 then return path({{-27,-15},{-15,-27},{15,-27},{27,-15},{27,15},{15,27},{-15,27},{-27,15}},true) .. " " .. path({{-15,-8},{0,-20},{15,-8},{15,8},{0,20},{-15,8}},true), "FF9D52"
    else return path({{-24,-17},{11,-17},{24,-5},{24,17},{-24,17}},true) .. " " .. path({{-10,-17},{-10,17}},false) .. " " .. circle(10,0,4), "80DE4A" end
end

local function status()
    if video_width > 0 and video_height > 0 and not core_idle then return "DECODING FIRST FRAME" end
    if stage >= 2 then return "BUFFERING INITIAL KEYFRAME" end
    if stage >= 1 then return "PROBING STREAM HEADERS" end
    return "CONNECTING TO STREAM"
end

local function milestone(now)
    local elapsed = now - started
    if video_width > 0 and video_height > 0 and not core_idle then stage = 4
    elseif mp.get_property("file-loaded") == "yes" or elapsed > 1.8 then stage = math.max(stage, 3)
    elseif mp.get_property("demuxer-cache-state") ~= nil or elapsed > 0.65 then stage = math.max(stage, 2)
    elseif elapsed > 0.12 then stage = math.max(stage, 1) end
    local values = {12, 38, 68, 94, 100}
    local target = values[stage + 1] or 100
    local p = clamp((elapsed - ({0,0.12,0.65,1.8,0})[stage + 1]) / 0.7, 0, 1)
    return target, p
end

local function add_stickers(out, now, alpha, px, py, hover, mouse, vx)
    local idle = not hover or not mouse or now - mouse_moved > 0.8
    local t = now - started
    local wave_x = 960 + math.sin(t * 1.25) * 205
    local wave_y = 515 + math.sin(t * 2.5) * 105
    local leader = badges[1]
    local target_x, target_y = idle and wave_x or px, idle and wave_y or py
    local blend = idle and 0.035 or 1
    leader.x = leader.x + (target_x - leader.x) * blend
    leader.y = leader.y + (target_y - leader.y) * blend
    vx = vx or 0
    local tilt = clamp(vx * 0.16, -24, 24)
    for i=2,badge_count do
        local b, prev = badges[i], badges[i-1]
        b.x = b.x + (prev.x - b.x) * 0.24
        b.y = b.y + (prev.y - b.y) * 0.24
    end
    for i=1,badge_count do
        local b = badges[i]
        local fast = math.min(18, math.abs(vx) * 0.035)
        b.scale = 100 + fast * math.sin(t * 11 - i * 0.7)
        b.angle = b.angle + (tilt - b.angle) * 0.16
        local drawing, color = badge_shape(i, t)
        local size = math.floor((i == 1 and 1.12 or 1) * b.scale)
        vector_event(out, math.floor(b.x-34), math.floor(b.y-34), color, alpha, drawing,
            string.format("\\frz%.1f\\fscx%d\\fscy%d", b.angle * (i % 2 == 0 and -0.5 or 0.5), size, size))
    end
end

local function render(now)
    if not visible or not started then return end
    local ow, oh = mp.get_osd_size()
    if ow and oh and ow > 0 and oh > 0 then width, height = ow, oh end
    local fade = 0
    if fade_started then
        local p = clamp((now-fade_started)*1000/math.max(1,tonumber(opts.fade_ms) or 120),0,1)
        fade = math.floor(p*255)
        if p >= 1 then overlay.data=""; overlay:remove(); visible=false; if timer then timer:kill(); timer=nil end; return end
    end
    local mouse = mp.get_property_native("mouse-pos")
    local hover = mouse and mouse.hover == true
    local px, py
    if mouse and mouse.x and mouse.y then px, py = mouse.x * 1920 / width, mouse.y * 1080 / height end
    local vx = px and last_mouse and (px-last_mouse.x) or 0
    if hover and px and last_mouse and (math.abs(vx)+math.abs(py-last_mouse.y)>0.7) then mouse_moved=now end
    if px and py then last_mouse={x=px,y=py} end
    local out = assdraw.ass_new()
    vector_event(out,0,0,"17110D",fade,"m 0 0 l 1920 0 l 1920 1080 l 0 1080 l 0 0")
    add_stickers(out,now,fade,px,py,hover,last_mouse,vx)
    local target = milestone(now)
    if stage >= 4 then counter_value = 100
    else counter_value = counter_value + (target-counter_value)*0.08 end
    local counter = math.floor(counter_value)
    local bottom = 1032
    text_event(out,1872,bottom,3,110,"F7F0E8",fade,string.format("%02d",counter),"\\b1\\fsp-5")
    text_event(out,48,950,1,13,"80DE4A",fade,"ENHANCED MPV v1.1.0","\\b1\\fsp2")
    text_event(out,48,985,1,25,"F7F0E8",fade,clean_text(title,"Enhanced MPV",56),"\\b1")
    text_event(out,48,1021,1,14,"9E948B",fade,status(),"\\fsp1")
    overlay.res_x,overlay.res_y,overlay.data=1920,1080,out.text
    overlay:update()
end

local function stop()
    if timer then timer:kill(); timer=nil end
    visible,started,fade_started=false,nil,nil
    overlay.data=""; overlay:remove()
end
local function try_fade()
    if visible and video_width>0 and video_height>0 and not core_idle and not fade_started then fade_started=mp.get_time() end
end
local function start()
    stop(); video_width,video_height,core_idle=0,0,true; stage=0; last_mouse=nil; mouse_moved=0
    for i=1,badge_count do badges[i]={x=960,y=540,angle=0,scale=100} end
    visible=true; started=mp.get_time(); counter_value=0
    title=clean_text(mp.get_property("force-media-title") or mp.get_property("media-title"),"Enhanced MPV",56)
    timer=mp.add_periodic_timer(0.016,function() local now=mp.get_time(); render(now); try_fade() end)
    render(started)
end

mp.register_event("start-file",start)
mp.register_event("end-file",stop)
mp.observe_property("video-out-params","native",function(_,v) video_width=v and (v.w or v.width) or 0; video_height=v and (v.h or v.height) or 0; try_fade() end)
mp.observe_property("core-idle","native",function(_,v) core_idle=v~=false; try_fade() end)
mp.register_script_message("enhanced-mpv-loading",function(value) title=clean_text(value,"Enhanced MPV",56); start() end)
mp.register_script_message("loading-screen-status",function(value)
    local s = value and value:lower() or ""
    if s:find("probe",1,true) then stage=math.max(stage,1)
    elseif s:find("prewarm",1,true) or s:find("buffer",1,true) then stage=math.max(stage,2)
    elseif s:find("shadow ready",1,true) or s:find("launch",1,true) then stage=math.max(stage,3)
    elseif s:find("playing",1,true) or s == "ready" then stage=4 end
end)
mp.register_event("shutdown",stop)
msg.info("loading-screen.lua v1.1.0 loaded")
