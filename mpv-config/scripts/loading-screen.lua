-- Interactive geometric loading screen. Every vector and text item is its own
-- ASS event; vector coordinates therefore never share an event with text.
local mp = require("mp")
local assdraw = require("mp.assdraw")
local minimum_visible = 0.22
local fade_duration = 0.12

local overlay = mp.create_osd_overlay("ass-events")
local timer, started, fade_started
local visible, width, height = false, 1920, 1080
local video_width, video_height, core_idle = 0, 0, true
local last_mouse, mouse_moved, counter_value = nil, 0, 0
local badges = {}
local badge_count = 7
for i = 1, badge_count do badges[i] = { x = 960, y = 540, angle = 0 } end

local function clamp(v, lo, hi) return math.max(lo, math.min(hi, v)) end
local function text_event(out, x, y, align, size, color, alpha, value, extra)
    out:new_event(); out:pos(x, y)
    out:append(string.format("{\\an%d\\fs%d\\bord0\\shad0\\1c&H%s&\\alpha&H%02X&%s}%s", align,
       size, color, alpha, extra or "", value))
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
    return string.format("m %d %d b %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d c",
       cx+r,cy, cx+r,cy+k,cx+k,cy+r,cx,cy+r, cx-k,cy+r,cx-r,cy+k,cx-r,cy, cx-r,cy-k,cx-k,cy-r,
      cx,cy-r, cx+k,cy-r,cx+r,cy-k,cx+r,cy)
end

local function badge_shape(i)
    local function starburst(ro, ri, count, phase)
        local pts = {}
        for n=0,count*2-1 do
            local a = n*math.pi/count + phase
            local r = n%2==0 and ro or ri
            pts[#pts+1] = {math.floor(math.cos(a)*r),math.floor(math.sin(a)*r)}
        end
        return path(pts,true)
    end
    if i == 1 then
        local studs = ""
        for _,p in ipairs({{-15,-20},{0,-24},{15,-20},{0,-12}}) do studs=studs .. circle(p[1],p[2],3) .. " " end
        return circle(0,0,38), circle(0,0,34), "F6823B", studs .. path({{-18,-10},{0,-20},{18,
          -10},{18,12},{0,23},{-18,12}},true) .. " " .. path({{-18,-10},{0,1},{18,-10},{0,-20}},
          true) .. " " .. path({{0,1},{0,23}},false) .. " " .. path({{-18,-10},{0,1},{0,23}},
          false)
    elseif i == 2 then
        local petals=""; for n=0,11 do local a=n*math.pi/6; petals=petals .. circle(math.floor(math.cos(a)*25),
          math.floor(math.sin(a)*25),11) .. " " end
        return petals, circle(0,0,27), "D966FF", circle(0,0,22) .. " " .. circle(-9,-5,3) .. " " .. path({{7,
          -5},{12,-5}},false) .. " " .. path({{-10,8},{-5,13},{2,15},{9,11}},false) .. " " .. starburst(7,
          3,4,0) .. " " .. circle(-15,16,1) .. " " .. circle(17,-14,1)
    elseif i == 3 then
        return path({{-28,-23},{25,-20},{29,25},{-24,28}},true), path({{-22,-17},{19,-15},{23,
          19},{-19,21}},true), "FFD200", path({{-17,-12},{17,-10},{19,14},{-15,16}},true) .. " " .. path({{-11,
          -3},{10,-3}},false) .. " " .. path({{-11,4},{7,4}},false) .. " " .. path({{-11,10},
          {2,10}},false)
    elseif i == 4 then
        return starburst(38,27,16,0), starburst(32,24,16,0), "008AFF", circle(0,0,23), circle(0,
          0,18) .. " " .. circle(0,0,12) .. " " .. circle(0,0,7)
    elseif i == 5 then
        return path({{-31,-24},{23,-32},{32,25},{-23,31}},true), circle(0,0,31), "84E522", circle(-12,
          -5,9) .. " " .. circle(12,-5,9) .. " " .. circle(-12,-5,4) .. " " .. circle(12,-5,
          4) .. " " .. path({{-7,14},{0,18},{7,14}},false) .. " " .. circle(-12,-5,1) .. " " .. circle(12,
          -5,1)
    elseif i == 6 then
        return circle(0,0,37), circle(0,0,32), "0AD6FF", starburst(27,24,16,0) .. " " .. path({{-20,
          2},{-17,-9},{-8,-17},{0,-19},{8,-17},{17,-9},{20,2},{17,11},{8,17},{0,19},{-8,17},
          {-17,11}},true) .. " " .. path({{-16,3},{-11,-4},{-4,-7},{4,-7},{11,-4},{16,3}},false) .. " " .. path({{-17,
          13},{-11,15},{-5,13},{1,15},{7,13},{13,15},{17,13}},false)
    else
        return circle(0,0,37), circle(0,0,32), "5C3BFF", circle(0,0,25) .. " " .. circle(0,0,
          19) .. " " .. circle(0,0,12) .. " " .. circle(0,0,7)
    end
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
        b.x = b.x + (prev.x - 145 - b.x) * 0.24
        b.y = b.y + (prev.y + 8 - b.y) * 0.24
    end
    for i=1,badge_count do
        local b = badges[i]
        local fast = math.min(18, math.abs(vx) * 0.035)
        b.angle = b.angle + (tilt - b.angle) * 0.16
        local backing, base, color, detail = badge_shape(i)
        local size = math.floor(220 + fast * math.sin(t * 11 - i * 0.7))
        local x, y = math.floor(b.x), math.floor(b.y)
        local transform = string.format("\\frz%.1f\\fscx%d\\fscy%d", b.angle * (i % 2 == 0 and -0.5 or 0.5), size, size)
        vector_event(out,x,y,"181311",alpha,backing,transform .. "\\bord3\\3c&H181311&")
        vector_event(out,x,y,"FFFFFF",alpha,backing,transform .. "\\bord2\\3c&H181311&")
        vector_event(out,x,y,color,alpha,base,transform .. "\\bord1\\3c&H181311&")
        vector_event(out,x,y,"181311",alpha,detail,transform .. "\\bord1\\3c&H181311&")
        if i == 3 then
            text_event(out,math.floor(b.x),math.floor(b.y),5,12,"181311",alpha,"PIXEL",transform .. "\\b1")
        end
    end
end

local function render(now)
    if not visible or not started then return end
    local ow, oh = mp.get_osd_size()
    if ow and oh and ow > 0 and oh > 0 then width, height = ow, oh end
    local fade = 0
    if fade_started then
        local p = clamp((now-fade_started)/fade_duration,0,1)
        fade = math.floor(p*255)
        if p >= 1 then
            overlay.data=""; overlay:remove(); visible=false
            if timer then timer:kill(); timer=nil end
            return
        end
    end
    local mouse = mp.get_property_native("mouse-pos")
    local hover = mouse and mouse.hover == true
    local px, py
    if mouse and mouse.x and mouse.y then px, py = mouse.x * 1920 / width, mouse.y * 1080 / height end
    local vx = px and last_mouse and (px-last_mouse.x) or 0
    if hover and px and last_mouse and (math.abs(vx)+math.abs(py-last_mouse.y)>0.7) then mouse_moved=now end
    if px and py then last_mouse={x=px,y=py} end
    local out = assdraw.ass_new()
    vector_event(out,0,0,"EEF2F2",fade,"m 0 0 l 1920 0 l 1920 1080 l 0 1080 l 0 0")
    add_stickers(out,now,fade,px,py,hover,last_mouse,vx)
    if video_width > 0 and video_height > 0 and not core_idle then counter_value = 100
    else counter_value = math.min(99, math.floor((now-started)*18)) end
    local counter = math.floor(counter_value)
    text_event(out,1872,1032,3,210,"989E9E",fade,string.format("%02d",counter),"\\b1\\fsp-5")
    overlay.res_x,overlay.res_y,overlay.data=1920,1080,out.text
    overlay:update()
end

local function stop()
    if timer then timer:kill(); timer=nil end
    visible,started,fade_started=false,nil,nil
    overlay.data=""; overlay:remove()
end
local function try_fade()
    local now = mp.get_time()
    if visible and now-started>=minimum_visible and video_width>0 and video_height>0
        and not core_idle and not fade_started then
        fade_started=now
    end
end
local function start(prewarmed)
    stop(); video_width,video_height,core_idle=0,0,true; last_mouse=nil; mouse_moved=0
    if prewarmed then
        local params = mp.get_property_native("video-out-params") or {}
        video_width, video_height = params.w or params.width or 0, params.h or params.height or 0
        core_idle = mp.get_property_native("core-idle") ~= false
    end
    for i=1,badge_count do badges[i]={x=960,y=540,angle=0} end
    visible=true; started=mp.get_time(); counter_value=0
    timer=mp.add_periodic_timer(0.016,function() local now=mp.get_time(); render(now); try_fade() end)
    render(started)
end

mp.register_event("start-file",function() start(false) end)
mp.register_event("end-file",stop)
mp.observe_property("video-out-params","native",function(_,v)
    video_width=v and (v.w or v.width) or 0
    video_height=v and (v.h or v.height) or 0
    try_fade()
end)
mp.observe_property("core-idle","native",function(_,v) core_idle=v~=false; try_fade() end)
mp.register_script_message("enhanced-mpv-loading",function() start(true) end)
mp.register_script_message("enhanced-mpv-focus",function() start(true) end)
mp.register_event("shutdown",stop)
