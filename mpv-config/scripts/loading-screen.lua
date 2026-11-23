-- Interactive geometric loading screen. Its ASS redraw timer and overlay are
-- removed as soon as mpv reports a live video output and an active core.
local mp = require("mp")
local assdraw = require("mp.assdraw")

local overlay = mp.create_osd_overlay("ass-events")
local timer, started
local visible, width, height = false, 1920, 1080
local video_width, video_height, core_idle = 0, 0, true
local last_mouse, mouse_moved = nil, 0
local frame = 0
local trajectory = {}
local badges = {}
local badge_count = 8
local TAU = math.pi * 2
for i = 1, badge_count do badges[i] = { x = 960, y = 540, vx = 0, vy = 0, angle = 0, scale = 0 } end

local function clamp(v, lo, hi) return math.max(lo, math.min(hi, v)) end
local function ass_color(css)
    local r, g, b = css:match("^#?(%x%x)(%x%x)(%x%x)$")
    return b .. g .. r
end
local function text_event(out, x, y, align, size, color, alpha, value, extra)
    out:new_event(); out:pos(x, y)
    out:append(string.format("{\\an%d\\fs%d\\bord0\\shad0\\1c&H%s&\\alpha&H%02X&%s}%s", align,
        size, ass_color(color), alpha, extra or "", value))
end
local function vector_event(out, x, y, color, alpha, drawing, extra)
    out:new_event(); out:pos(x, y)
    out:append(string.format("{\\an7\\bord0\\shad0\\1c&H%s&\\alpha&H%02X&%s\\p1}",
        ass_color(color), alpha, extra or ""))
    out:append(drawing); out:append("{\\p0}")
end
local function path(points, close)
    local s = "m " .. points[1][1] .. " " .. points[1][2]
    for i = 2, #points do s = s .. " l " .. points[i][1] .. " " .. points[i][2] end
    if close then s = s .. " l " .. points[1][1] .. " " .. points[1][2] end
    return s
end
local function circle(cx, cy, r)
    local k = math.floor(r * 0.5523)
    return string.format("m %d %d b %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d c",
        cx+r,cy, cx+r,cy+k,cx+k,cy+r,cx,cy+r, cx-k,cy+r,cx-r,cy+k,cx-r,cy,
        cx-r,cy-k,cx-k,cy-r,cx,cy-r,cx+k,cy-r,cx+r,cy-k,cx+r,cy)
end
local function burst(ro, ri, count, phase)
    local pts = {}
    for n = 0, count * 2 - 1 do
        local a, r = n * math.pi / count + phase, n % 2 == 0 and ro or ri
        pts[#pts+1] = { math.floor(math.cos(a)*r), math.floor(math.sin(a)*r) }
    end
    return path(pts, true)
end

local OUTLINE = "#111318"
local function sticker_shape(i)
    if i == 1 then -- lime twin eyes with bright sclera
        return {
            {"#A3E635", circle(0,0,38)}, {"#FFFFFF", circle(-13,-3,11)}, {"#FFFFFF", circle(13,-3,11)},
            {"#111318", circle(-13,-3,4)}, {"#111318", circle(13,-3,4)},
            {"#111318", path({{-17,15},{-12,19},{-5,22},{0,23},{5,22},{12,19},{17,15},
                {16,20},{10,24},{0,26},{-10,24},{-16,20}},true)},
        }
    elseif i == 2 then -- six-petal flower
        local p = {}
        for n=0,5 do
            local a=n*TAU/6
            p[#p+1]={"#A855F7",circle(math.floor(math.cos(a)*21),math.floor(math.sin(a)*21),13)}
        end
        p[#p+1]={"#FEF08A",circle(0,0,9)}
        return p
    elseif i == 3 then -- electric pink smiley
        return {{"#F472B6",circle(0,0,37)}, {"#FFFFFF",circle(-12,-8,5)}, {"#FFFFFF",circle(12,-8,5)},
            {"#111318",path({{-18,7},{-12,15},{-6,19},{0,20},{6,19},{12,15},{18,7},
                {16,15},{10,21},{0,24},{-10,21},{-16,15}},true)}}
    elseif i == 4 then -- coral concentric stamp
        return {{"#EF4444",circle(0,0,38)}, {"#FDE047",circle(0,0,28)}, {"#EF4444",circle(0,0,18)},
            {"#FDE047",circle(0,0,8)}}
    elseif i == 5 then -- golden sunburst crest
        return {{"#FB923C",burst(39,28,16,0)}, {"#FEF08A",burst(28,19,16,0)},
            {"#FB923C",circle(0,0,12)}}
    elseif i == 6 then -- cobalt cube
        return {{"#3B82F6",path({{0,-35},{31,-18},{31,18},{0,36},{-31,18},{-31,-18}},true)},
            {"#60A5FA",path({{0,-35},{0,0},{-31,-18}},true)}, {"#3B82F6",path({{0,-35},{31,-18},{0,0}},true)},
            {"#2563EB",path({{-31,-18},{0,0},{0,36},{-31,18}},true)}}
    elseif i == 7 then -- cyan tilted PIXEL tag
        return {{"#67E8F9",path({{-34,-20},{24,-28},{34,18},{-24,27}},true)},
            {"#BEF264",circle(-22,-8,4)}}
    end -- spare pop-art sticker, a white-cored lime rosette
    return {{"#A3E635",burst(37,25,12,0)}, {"#FFFFFF",circle(0,0,12)}, {"#F472B6",circle(0,0,5)}}
end

local function push_trajectory(x, y)
    trajectory[#trajectory+1] = { x=x, y=y, frame=frame }
    if #trajectory > 240 then table.remove(trajectory, 1) end
end
local function by_delay(delay)
    local target = frame - delay
    for i=#trajectory,1,-1 do
        if trajectory[i].frame <= target then return trajectory[i] end
    end
    return trajectory[1], trajectory[1]
end
local function add_stickers(out, now, alpha, px, py, hover)
    local idle = not hover or not px or now - mouse_moved > 0.8
    local t = now - started
    local target_x, target_y
    if idle then
        -- A precessing figure eight that closes into a rosette as it slows.
        local a = t * 0.58
        local precession = math.sin(t * 0.13) * 0.23
        target_x = 960 + 340 * math.sin(a) * math.cos(precession) + 42 * math.sin(a * 0.5)
        target_y = 540 + 210 * math.sin(a * 2) + 28 * math.cos(a * 0.5)
    else
        target_x, target_y = px, py
    end

    local head = badges[1]
    local ax, ay = (target_x-head.x)*0.16, (target_y-head.y)*0.16
    head.vx, head.vy = (head.vx+ax)*0.72, (head.vy+ay)*0.72
    head.x, head.y = head.x+head.vx, head.y+head.vy
    frame = frame + 1
    push_trajectory(head.x, head.y)

    for i=2,badge_count do
        local delay = (i-1)*4
        local point = by_delay(delay)
        local speed = math.sqrt(head.vx*head.vx+head.vy*head.vy)
        if speed > 8 then
            local desired = clamp(speed*4,34,54)
            local idx = #trajectory - delay
            while idx > 1 do
                local p = trajectory[idx]
                local b = badges[i-1]
                if math.sqrt((p.x-b.x)^2+(p.y-b.y)^2) >= desired then
                    point=p
                    break
                end
                idx=idx-1
            end
        end
        local b = badges[i]
        b.vx, b.vy = (b.vx+(point.x-b.x)*0.34)*0.58, (b.vy+(point.y-b.y)*0.34)*0.58
        b.x, b.y = b.x+b.vx, b.y+b.vy
    end

    -- Draw oldest first so the newest sticker sits on top of the ribbon.
    for i=badge_count,1,-1 do
        local b = badges[i]
        local older = by_delay((i-1)*4+1)
        local dx, dy = b.x-(older and older.x or b.x), b.y-(older and older.y or b.y)
        local tangent = math.deg(math.atan2(dy,dx))
        b.angle = b.angle + (tangent + math.sin(t*5-i)*2 - b.angle)*0.22
        local scale = 220
        local transform=string.format("\\frz%.1f\\fscx%d\\fscy%d",b.angle,scale,scale)
        local x,y=math.floor(b.x),math.floor(b.y)
        local drawing=circle(0,0,40)
        vector_event(out,x,y,"#F2F2EE",alpha,drawing,transform.."\\bord3\\3c&H181311&")
        for _,shape in ipairs(sticker_shape(i)) do
            local fill, form=shape[1],shape[2]
            vector_event(out,x,y,fill,alpha,form,transform.."\\bord2\\3c&H181311&")
        end
        -- One continuous crisp outline keeps overlapping fills from reading as black shapes.
        vector_event(out,x,y,OUTLINE,alpha,drawing,transform.."\\bord2\\3c&H181311&\\1a&HFF&")
        if i == 7 then
            text_event(out,x,y-8,5,10,"#111318",alpha,"PIXEL",transform.."\\b1")
        end
    end
end

local function remove_overlay()
    if timer then timer:kill(); timer=nil end
    overlay.data=""; overlay:remove(); visible=false
end
local function video_ready()
    return video_width>0 and video_height>0 and not core_idle
end
local function remove_overlay_when_ready()
    if visible and video_ready() then
        remove_overlay()
        return true
    end
    return false
end
local function render(now)
    if not visible or not started then return end
    if remove_overlay_when_ready() then return end
    local ow,oh=mp.get_osd_size()
    if ow and oh and ow>0 and oh>0 then width,height=ow,oh end
    local mouse=mp.get_property_native("mouse-pos")
    local hover=mouse and mouse.hover==true
    local px,py
    if mouse and mouse.x and mouse.y then px=mouse.x*1920/width; py=mouse.y*1080/height end
    if hover and px and last_mouse and math.abs(px-last_mouse.x)+math.abs(py-last_mouse.y)>0.7 then mouse_moved=now end
    if px and py then last_mouse={x=px,y=py} end
    local out=assdraw.ass_new()
    vector_event(out,0,0,"#F2F2EE",0,"m 0 0 l 1920 0 l 1920 1080 l 0 1080 l 0 0")
    add_stickers(out,now,0,px,py,hover)
    local counter=math.min(99,math.floor((now-started)*18))
    text_event(out,1856,1024,3,96,"#A8A8A2",0,string.format("%02d",counter),"\\b1\\fsp-2")
    overlay.res_x,overlay.res_y,overlay.data=1920,1080,out.text
    overlay:update()
end
local function stop()
    remove_overlay()
    started=nil
    last_mouse=nil; frame=0; trajectory={}
end
local function start(prewarmed)
    stop(); video_width,video_height,core_idle=0,0,true; last_mouse=nil; mouse_moved=0
    if prewarmed then
        local params=mp.get_property_native("video-out-params") or {}
        video_width,video_height=params.w or params.width or 0,params.h or params.height or 0
        core_idle=mp.get_property_native("core-idle")~=false
    end
    for i=1,badge_count do badges[i]={x=960,y=540,vx=0,vy=0,angle=0,scale=0} end
    trajectory={{x=960,y=540,frame=0}}
    visible=true; started=mp.get_time()
    timer=mp.add_periodic_timer(0.016,function()
        render(mp.get_time())
    end)
    render(started)
end

mp.register_event("start-file",function() start(false) end)
mp.register_event("end-file",stop)
mp.observe_property("video-out-params","native",function(_,v)
    video_width=v and (v.w or v.width) or 0
    video_height=v and (v.h or v.height) or 0
    remove_overlay_when_ready()
end)
mp.observe_property("core-idle","native",function(_,v)
    core_idle=v~=false
    remove_overlay_when_ready()
end)
mp.register_script_message("enhanced-mpv-loading",function() start(false) end)
mp.register_script_message("enhanced-mpv-focus",function() if not visible then start(true) end end)
mp.register_event("shutdown",stop)
