--[[
  smart-sub-manager.lua
  Async subtitle discovery, OpenSubtitles lookup, encoding repair, autosync.
  Modeled on davidde/mpv-autosub + joaquintorres/autosubsync-mpv, without blocking I/O.
]]

local mp = require("mp")
local msg = require("mp.msg")
local utils = require("mp.utils")
local options = require("mp.options")

local opts = {
  preferred_langs = "eng,en,spa,es",
  native_audio_langs = "eng,en,english",
  opensubtitles_api_key = "",
  opensubtitles_user = "",
  opensubtitles_password = "",
  timeout_seconds = 10,
  autosync_tool = "auto",
  enable_cloud_search = true,
  cleanup_days = 7,
}
options.read_options(opts, "smart_sub_manager")

local USER_AGENT = "EnhancedMPV v1.0.0"
local OS_API = "https://api.opensubtitles.com/api/v1"
local last_candidates = {}
local os_token = nil
local prefetching = false

local RELEASE_TAGS = {
  "1080p", "720p", "480p", "2160p", "4k", "8k", "4320p",
  "x264", "x265", "h264", "h265", "hevc", "av1", "xvid", "divx",
  "web%-dl", "webdl", "webrip", "bluray", "blu%-ray", "bdrip", "brrip",
  "dvdrip", "hdtv", "hdcam", "hdrip", "remux", "hybrid",
  "amzn", "nf", "dsnp", "atvp", "hmax", "hulu", "crav",
  "ddp5%.1", "ddp2%.0", "dd5%.1", "aac2%.0", "atmos", "truehd", "dts", "opus",
  "hdr10", "hdr", "dv", "dovi", "sdr", "10bit", "8bit", "hi10p",
  "proper", "repack", "internal", "limited", "extended", "unrated",
  "multi", "subs", "dubbed", "ima", "rarbg", "yify", "yts", "evo", "ntb",
  "web", "pdtv", "sdtv", "cam", "ts", "tc", "scr", "dvdscr",
}

local function split_csv(s)
  local t = {}
  if not s or s == "" then return t end
  for part in string.gmatch(s, "[^,%s]+") do
    t[#t + 1] = string.lower(part)
  end
  return t
end

local function expand(p)
  return mp.command_native({ "expand-path", p })
end

local function home_dir()
  return expand("~")
end

local function config_dir()
  return utils.join_path(home_dir(), ".enhanced-mpv")
end

local function temp_sub_dir()
  local base = os.getenv("TEMP") or os.getenv("TMPDIR") or "/tmp"
  return utils.join_path(base, "enhanced-mpv-subs")
end

local function read_file(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  local data = f:read("*a")
  f:close()
  return data
end

local function write_file(path, data)
  local dir = utils.split_path(path)
  if dir and dir ~= "" then
    local info = utils.file_info(dir)
    if not info then
      os.execute(string.format('mkdir "%s" 2>nul || mkdir -p "%s"', dir, dir))
    end
  end
  local f = io.open(path, "wb")
  if not f then return false end
  f:write(data)
  f:close()
  return true
end

local function load_user_config()
  local raw = read_file(utils.join_path(config_dir(), "config.json"))
  if not raw then return {} end
  local parsed = utils.parse_json(raw)
  return parsed or {}
end

local function preferred_langs()
  local cfg = load_user_config()
  if cfg.preferredSubtitleLanguages and #cfg.preferredSubtitleLanguages > 0 then
    local t = {}
    for _, l in ipairs(cfg.preferredSubtitleLanguages) do
      t[#t + 1] = string.lower(l)
    end
    return t
  end
  return split_csv(opts.preferred_langs)
end

local function native_audio_langs()
  local cfg = load_user_config()
  if cfg.nativeAudioLanguages and #cfg.nativeAudioLanguages > 0 then
    local t = {}
    for _, l in ipairs(cfg.nativeAudioLanguages) do
      t[#t + 1] = string.lower(l)
    end
    return t
  end
  return split_csv(opts.native_audio_langs)
end

local function api_key()
  local cfg = load_user_config()
  if cfg.opensubtitles and cfg.opensubtitles.apiKey and cfg.opensubtitles.apiKey ~= "" then
    return cfg.opensubtitles.apiKey
  end
  return opts.opensubtitles_api_key
end

local function toast(text, seconds)
  mp.osd_message(text, seconds or 2)
end

local function platform_name()
  local p = mp.get_property_native("platform")
  if p then return p end
  if package.config:sub(1, 1) == "\\" then return "windows" end
  local uname = io.popen("uname -s 2>/dev/null")
  if uname then
    local s = uname:read("*l")
    uname:close()
    if s == "Darwin" then return "darwin" end
  end
  return "linux"
end

local function run_async(args, timeout, cb)
  mp.command_native_async({
    name = "subprocess",
    args = args,
    playback_only = false,
    capture_stdout = true,
    capture_stderr = true,
    timeout = timeout or opts.timeout_seconds,
  }, function(success, result, err)
    cb(success, result, err)
  end)
end

local function curl_get(url, headers, timeout, cb)
  local args = { "curl", "-sS", "-L", "-m", tostring(timeout or opts.timeout_seconds), "-A", USER_AGENT }
  for k, v in pairs(headers or {}) do
    args[#args + 1] = "-H"
    args[#args + 1] = k .. ": " .. v
  end
  args[#args + 1] = url
  run_async(args, (timeout or opts.timeout_seconds) + 1, cb)
end

local function curl_post(url, headers, body, timeout, cb)
  local args = { "curl", "-sS", "-L", "-m", tostring(timeout or opts.timeout_seconds), "-A", USER_AGENT, "-X", "POST" }
  for k, v in pairs(headers or {}) do
    args[#args + 1] = "-H"
    args[#args + 1] = k .. ": " .. v
  end
  args[#args + 1] = "-d"
  args[#args + 1] = body or ""
  args[#args + 1] = url
  run_async(args, (timeout or opts.timeout_seconds) + 1, cb)
end

local function curl_download(url, dest, timeout, cb)
  local args = {
    "curl", "-sS", "-L", "-m", tostring(timeout or opts.timeout_seconds),
    "-A", USER_AGENT, "-o", dest, url,
  }
  run_async(args, (timeout or opts.timeout_seconds) + 1, cb)
end

local function with_backoff(attempt_fn, on_fail)
  local delays = { 0, 0.5, 1.0, 2.0 }
  local i = 1
  local function try()
    attempt_fn(function(ok)
      if ok then return end
      i = i + 1
      if i > #delays then
        if on_fail then on_fail() end
        return
      end
      mp.add_timeout(delays[i], try)
    end)
  end
  try()
end

local function add64(lo, hi, vlo, vhi)
  local nlo = lo + vlo
  local carry = 0
  if nlo >= 4294967296 then
    nlo = nlo - 4294967296
    carry = 1
  end
  local nhi = hi + vhi + carry
  nhi = nhi % 4294967296
  return nlo, nhi
end

local function read_u64_le(bytes, offset)
  local a, b, c, d, e, f, g, h = bytes:byte(offset, offset + 7)
  if not h then return 0, 0 end
  local lo = a + b * 256 + c * 65536 + d * 16777216
  local hi = e + f * 256 + g * 65536 + h * 16777216
  return lo, hi
end

local function hex64(lo, hi)
  return string.format("%08x%08x", hi, lo)
end

local function movie_hash(path)
  local info = utils.file_info(path)
  if not info or not info.is_file then return nil, 0 end
  local size = info.size
  local f = io.open(path, "rb")
  if not f then return nil, size end
  local lo, hi = size % 4294967296, math.floor(size / 4294967296) % 4294967296
  local function absorb(chunk)
    if not chunk then return end
    local i = 1
    while i + 7 <= #chunk do
      local vlo, vhi = read_u64_le(chunk, i)
      lo, hi = add64(lo, hi, vlo, vhi)
      i = i + 8
    end
  end
  absorb(f:read(65536))
  if size > 65536 then
    f:seek("end", -math.min(65536, size))
    absorb(f:read(65536))
  end
  f:close()
  return hex64(lo, hi), size
end

local function strip_tags(name)
  local s = string.lower(name or "")
  s = s:gsub("%.%w+$", "")
  s = s:gsub("[._%[%]%(%)]", " ")
  for _, tag in ipairs(RELEASE_TAGS) do
    s = s:gsub(tag, " ")
  end
  local year = s:match("(19%d%d)") or s:match("(20%d%d)")
  s = s:gsub("s%d%d%s*e%d%d.*", " ")
  s = s:gsub("19%d%d", " ")
  s = s:gsub("20%d%d", " ")
  s = s:gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
  return s, year
end

local function parse_media_title()
  local forced = mp.get_property("force-media-title")
  local path = mp.get_property("path") or ""
  local filename = mp.get_property("filename") or ""
  local base = filename ~= "" and filename or path
  local title, year = strip_tags(base)
  if forced and forced ~= "" and not forced:match("^https?://") then
    local t2, y2 = strip_tags(forced)
    if t2 ~= "" then
      title, year = t2, y2 or year
    end
  end
  return title, year, base
end

local function is_network_path(path)
  if not path then return true end
  return path:match("^https?://") or path:match("^ytdl://") or path:match("^edl://")
    or path:match("^file://") == nil and path:match("://")
end

local function valid_utf8(s)
  local i = 1
  local n = #s
  while i <= n do
    local c = s:byte(i)
    local len
    if c < 128 then
      len = 1
    elseif c >= 194 and c <= 223 then
      len = 2
    elseif c >= 224 and c <= 239 then
      len = 3
    elseif c >= 240 and c <= 244 then
      len = 4
    else
      return false
    end
    if i + len - 1 > n then return false end
    for j = 1, len - 1 do
      local cc = s:byte(i + j)
      if not cc or cc < 128 or cc > 191 then return false end
    end
    i = i + len
  end
  return true
end

local function has_nul(s)
  return s:find("\0", 1, true) ~= nil
end

local function detect_bom(data)
  if data:sub(1, 3) == "\239\187\191" then return "utf-8-bom", data:sub(4) end
  if data:sub(1, 2) == "\255\254" then return "utf-16le", data end
  if data:sub(1, 2) == "\254\255" then return "utf-16be", data end
  return nil, data
end

local function iconv_convert(src_path, from_enc, dest_path, cb)
  run_async({
    "iconv", "-f", from_enc, "-t", "UTF-8", "-o", dest_path, src_path,
  }, 10, function(success, result)
    if success and result and result.status == 0 then
      cb(true, dest_path)
    else
      cb(false)
    end
  end)
end

local function ensure_utf8_file(path, cb)
  local data = read_file(path)
  if not data then
    cb(path)
    return
  end
  local bom, rest = detect_bom(data)
  if bom == "utf-8-bom" then
    write_file(path, rest)
    cb(path)
    return
  end
  if bom == "utf-16le" or bom == "utf-16be" then
    local dest = path .. ".utf8.srt"
    iconv_convert(path, bom == "utf-16le" and "UTF-16LE" or "UTF-16BE", dest, function(ok)
      cb(ok and dest or path)
    end)
    return
  end
  if valid_utf8(data) and not has_nul(data) then
    cb(path)
    return
  end
  local encodings = { "WINDOWS-1252", "ISO-8859-1", "ISO-8859-15", "GBK", "SHIFT_JIS" }
  local idx = 1
  local dest = path .. ".utf8.srt"
  local function try_next()
    if idx > #encodings then
      cb(path)
      return
    end
    local enc = encodings[idx]
    idx = idx + 1
    iconv_convert(path, enc, dest, function(ok)
      if ok then
        local out = read_file(dest)
        if out and valid_utf8(out) then
          cb(dest)
          return
        end
      end
      try_next()
    end)
  end
  try_next()
end

local function lang_matches(track_lang, wanted)
  if not track_lang then return false end
  local tl = string.lower(track_lang)
  for _, w in ipairs(wanted) do
    local wl = string.lower(w)
    if tl == wl or tl:sub(1, 2) == wl:sub(1, 2) then
      return true
    end
  end
  return false
end

local function list_has(list, lang)
  return lang_matches(lang, list)
end

local function current_audio_lang()
  local tracks = mp.get_property_native("track-list") or {}
  for _, t in ipairs(tracks) do
    if t.type == "audio" and t.selected then
      return t.lang
    end
  end
  return nil
end

local function has_usable_subtitle()
  local wanted = preferred_langs()
  local audio = current_audio_lang()
  local native = list_has(native_audio_langs(), audio)
  local tracks = mp.get_property_native("track-list") or {}
  for _, t in ipairs(tracks) do
    if t.type == "sub" then
      if native then
        local title = string.lower(t.title or "")
        if title:find("force", 1, true) or title:find("sign", 1, true) or t.forced then
          return true
        end
      elseif lang_matches(t.lang, wanted) then
        return true
      elseif not t.lang and t.external and lang_matches("eng", wanted) then
        return true
      end
    end
  end
  if native then
    for _, t in ipairs(tracks) do
      if t.type == "sub" and t.forced then return true end
    end
  end
  return false
end

local function sidecar_path(video_path, lang, ext)
  if is_network_path(video_path) then
    local dir = temp_sub_dir()
    local title = (mp.get_property("filename") or "stream"):gsub("[^%w%.%-]+", "_")
    return utils.join_path(dir, title .. "." .. lang .. "." .. ext)
  end
  local dir, file = utils.split_path(video_path)
  local base = file:gsub("%.[^%.]+$", "")
  return utils.join_path(dir, base .. "." .. lang .. "." .. ext)
end

local function sub_track_count()
  local n = 0
  for _, t in ipairs(mp.get_property_native("track-list") or {}) do
    if t.type == "sub" then n = n + 1 end
  end
  return n
end

-- External subtitles handed over by the browser extension land in the shared
-- temp folder. When they are present the stream already has web subtitles, so
-- the automatic cloud OpenSubtitles lookup is skipped as redundant.
local function has_web_subtitles()
  local dir = temp_sub_dir()
  for _, t in ipairs(mp.get_property_native("track-list") or {}) do
    if t.type == "sub" and t.external then
      local f = t["external-filename"] or ""
      if f ~= "" and f:sub(1, #dir) == dir then
        return true
      end
    end
  end
  return false
end

local function load_sub(path, lang)
  ensure_utf8_file(path, function(utf_path)
    mp.commandv("sub-add", utf_path, "select", lang or "und", lang or "External")
    mp.set_property_number("sid", 1)
    toast("Loaded " .. (lang or "external") .. " subtitle", 2)
  end)
end

local function open_uosc_menu(menu)
  local json = utils.format_json(menu)
  if not json then return end
  mp.commandv("script-message-to", "uosc", "open-menu", json)
end

local function show_candidates(candidates)
  last_candidates = candidates
  local items = {}
  for i, c in ipairs(candidates) do
    if i > 10 then break end
    items[#items + 1] = {
      title = c.filename or ("Candidate " .. i),
      hint = string.format("%s  ★%s  ↓%s", c.language or "?", tostring(c.rating or "-"), tostring(c.downloads or "-")),
      value = { "script-message-to", "smart_sub_manager", "download-id", tostring(c.file_id) },
    }
  end
  if #items == 0 then
    toast("No match found", 3)
    return
  end
  open_uosc_menu({
    type = "enhanced-sub-candidates",
    title = "Subtitle candidates",
    items = items,
    search_style = "on_demand",
  })
end

local function parse_os_results(body)
  local parsed = utils.parse_json(body)
  if not parsed or not parsed.data then return {} end
  local out = {}
  for _, row in ipairs(parsed.data) do
    local attr = row.attributes or {}
    local files = attr.files or {}
    local file = files[1] or {}
    out[#out + 1] = {
      file_id = file.file_id or file.fileid,
      filename = file.file_name or attr.release or "subtitle.srt",
      language = attr.language,
      rating = attr.ratings or attr.rating or 0,
      downloads = attr.download_count or 0,
      hash_match = attr.moviehash_match and 1 or 0,
    }
  end
  table.sort(out, function(a, b)
    if a.hash_match ~= b.hash_match then return a.hash_match > b.hash_match end
    local ar = tonumber(a.rating) or 0
    local br = tonumber(b.rating) or 0
    if ar ~= br then return ar > br end
    return (tonumber(a.downloads) or 0) > (tonumber(b.downloads) or 0)
  end)
  return out
end

local function os_headers(extra)
  local h = {
    ["Api-Key"] = api_key(),
    ["Content-Type"] = "application/json",
    Accept = "application/json",
  }
  if os_token then
    h.Authorization = "Bearer " .. os_token
  end
  if extra then
    for k, v in pairs(extra) do h[k] = v end
  end
  return h
end

local function login_os(cb)
  local cfg = load_user_config()
  local user = (cfg.opensubtitles and cfg.opensubtitles.username) or opts.opensubtitles_user
  local pass = (cfg.opensubtitles and cfg.opensubtitles.password) or opts.opensubtitles_password
  if not user or user == "" or not pass or pass == "" then
    cb(true)
    return
  end
  local body = utils.format_json({ username = user, password = pass })
  curl_post(OS_API .. "/login", os_headers(), body, 10, function(success, result)
    if not success or not result or result.status ~= 0 then
      cb(false)
      return
    end
    local parsed = utils.parse_json(result.stdout or "")
    if parsed and parsed.token then
      os_token = parsed.token
    end
    cb(true)
  end)
end

local function search_opensubtitles(query, year, hash, size, cb)
  local langs = table.concat(preferred_langs(), ",")
  local url = OS_API .. "/subtitles?languages=" .. langs .. "&order_by=download_count&order_direction=desc"
  if hash then
    url = url .. "&moviehash=" .. hash
    if size and size > 0 then
      url = url .. "&moviebytesize=" .. tostring(size)
    end
  end
  if query and query ~= "" then
    url = url .. "&query=" .. query:gsub(" ", "%%20")
    if year then
      url = url .. "&year=" .. year
    end
  end
  with_backoff(function(done)
    curl_get(url, os_headers(), 10, function(success, result)
      if not success or not result or result.status ~= 0 or not result.stdout or result.stdout == "" then
        done(false)
        return
      end
      local candidates = parse_os_results(result.stdout)
      if #candidates == 0 then
        done(false)
        return
      end
      cb(candidates)
      done(true)
    end)
  end, function()
    cb(nil)
  end)
end

local function download_os_file(file_id, cb)
  local body = utils.format_json({ file_id = tonumber(file_id) or file_id })
  curl_post(OS_API .. "/download", os_headers(), body, 10, function(success, result)
    if not success or not result or result.status ~= 0 then
      cb(nil)
      return
    end
    local parsed = utils.parse_json(result.stdout or "")
    if not parsed or not parsed.link then
      cb(nil)
      return
    end
    cb(parsed.link)
  end)
end

local function apply_downloaded(url, lang, interactive)
  local path = mp.get_property("path")
  local dest = sidecar_path(path, lang or "eng", "srt")
  local dir = utils.split_path(dest)
  local function fetch()
    curl_download(url, dest, 10, function(ok, result)
      if ok and result and result.status == 0 then
        load_sub(dest, lang or "eng")
      else
        if interactive then
          toast("No match found", 3)
        end
      end
    end)
  end
  if platform_name() == "windows" then
    -- "mkdir -p" is Unix-only; on Windows it would create a stray "-p" folder.
    local cmd = string.format(
      'New-Item -ItemType Directory -Force -LiteralPath "%s" | Out-Null',
      dir:gsub('"', '""')
    )
    run_async({ "powershell", "-NoProfile", "-Command", cmd }, 5, function()
      fetch()
    end)
  else
    run_async({ "mkdir", "-p", dir }, 5, function()
      fetch()
    end)
  end
end

local function search_flow(interactive)
  if not opts.enable_cloud_search then
    toast("Cloud subtitle search disabled", 2)
    return
  end
  local key = api_key()
  if not key or key == "" then
    if interactive then
      toast("No match found", 2)
    end
    msg.info("OpenSubtitles API key not set; skipping cloud lookup")
    return
  end
  toast("Searching subtitles...", 2)
  local path = mp.get_property("path") or ""
  local title, year = parse_media_title()
  local hash, size = nil, 0
  if path ~= "" and not is_network_path(path) then
    hash, size = movie_hash(path)
  end
  login_os(function()
    local function after_hash(candidates)
      if candidates and #candidates > 0 then
        if interactive then
          show_candidates(candidates)
        else
          local best = candidates[1]
          download_os_file(best.file_id, function(link)
            if link then
              apply_downloaded(link, best.language or "eng", interactive)
            end
          end)
        end
        return
      end
      if hash then
        search_opensubtitles(title, year, nil, nil, function(c2)
          if c2 and #c2 > 0 then
            if interactive then
              show_candidates(c2)
            else
              local best = c2[1]
              download_os_file(best.file_id, function(link)
                if link then
                  apply_downloaded(link, best.language or "eng", interactive)
                end
              end)
            end
          else
            if interactive then
              toast("No match found", 3)
            end
          end
        end)
      else
        if interactive then
          toast("No match found", 3)
        end
      end
    end
    search_opensubtitles(title, year, hash, size, after_hash)
  end)
end

local function on_file_loaded()
  mp.add_timeout(0.8, function()
    local path = mp.get_property("path") or ""
    if is_network_path(path) and path:match("^https?://") then
      -- Browser stream: surface where it came from and how much is attached.
      local n = sub_track_count()
      if n > 0 then
        toast("Stream loaded · " .. n .. (n == 1 and " subtitle track attached" or " subtitle tracks attached"), 3)
      else
        toast("Stream loaded", 2)
      end
    end
    -- Web subtitles were handed over by the browser extension; the cloud hash
    -- lookup would be redundant, so skip the automatic search entirely.
    if has_web_subtitles() or has_usable_subtitle() then
      return
    end
    search_flow(false)
  end)
end

local function pick_subtitle_file()
  local plat = platform_name()
  local args
  if plat == "windows" then
    args = {
      "powershell", "-NoProfile", "-STA", "-Command",
      [=[
        [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
        Add-Type -AssemblyName System.Windows.Forms
        $d = New-Object System.Windows.Forms.OpenFileDialog
        $d.Filter = "Subtitles (*.srt;*.ass;*.ssa;*.vtt)|*.srt;*.ass;*.ssa;*.vtt|All files (*.*)|*.*"
        $d.Title = "Open Subtitle File"
        $d.Multiselect = $false
        if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
          [Console]::Out.Write($d.FileName)
        }
      ]=],
    }
  elseif plat == "darwin" then
    args = {
      "osascript", "-e",
      'POSIX path of (choose file with prompt "Open Subtitle File" of type {"public.plain-text","srt","ass","ssa","vtt"})',
    }
  else
    args = { "zenity", "--file-selection", "--title=Open Subtitle File", "--file-filter=Subtitles | *.srt *.ass *.ssa *.vtt" }
  end
  run_async(args, 120, function(success, result)
    local path = success and result and result.stdout or ""
    path = path:gsub("%s+$", ""):gsub("^%s+", "")
    if (not success or path == "") and plat == "linux" then
      run_async({ "kdialog", "--getopenfilename", ".", "*.srt *.ass *.ssa *.vtt" }, 120, function(ok2, res2)
        local p2 = ok2 and res2 and res2.stdout or ""
        p2 = p2:gsub("%s+$", "")
        if p2 ~= "" then
          mp.commandv("sub-add", p2)
          toast("Loaded subtitle file", 2)
        end
      end)
      return
    end
    if path ~= "" then
      mp.commandv("sub-add", path)
      toast("Loaded subtitle file", 2)
    end
  end)
end

local function current_sub_file()
  local tracks = mp.get_property_native("track-list") or {}
  for _, t in ipairs(tracks) do
    if t.type == "sub" and t.selected and t.external and t["external-filename"] then
      return t["external-filename"]
    end
  end
  return nil
end

local function find_sync_tool(cb)
  local want = opts.autosync_tool
  local order = { "ffsubsync", "alass" }
  if want == "alass" then
    order = { "alass", "ffsubsync" }
  elseif want == "ffsubsync" then
    order = { "ffsubsync" }
  end
  local i = 1
  local function probe()
    if i > #order then
      cb(nil)
      return
    end
    local tool = order[i]
    i = i + 1
    run_async({ tool, "--help" }, 5, function(success, result)
      if success and result and (result.status == 0 or result.status == 1 or result.status == 2) then
        cb(tool)
      else
        probe()
      end
    end)
  end
  probe()
end

local function autosync()
  local video = mp.get_property("path")
  local sub = current_sub_file()
  if not video or is_network_path(video) then
    toast("Auto-sync needs a local video file", 3)
    return
  end
  if not sub then
    toast("Load an external subtitle first", 3)
    return
  end
  toast("Syncing subtitles...", 2)
  find_sync_tool(function(tool)
    if not tool then
      toast("ffsubsync/alass not installed", 4)
      return
    end
    local out = sub:gsub("%.%w+$", "") .. ".synced.srt"
    local args
    if tool == "alass" then
      args = { "alass", video, sub, out }
    else
      args = { "ffsubsync", video, "-i", sub, "-o", out }
    end
    mp.command_native_async({
      name = "subprocess",
      args = args,
      playback_only = false,
      capture_stdout = true,
      capture_stderr = true,
      timeout = 10,
    }, function(success, result)
      if not success or not result or result.status ~= 0 then
        toast("Subtitle sync failed", 3)
        msg.error(result and result.stderr or "autosync failed")
        return
      end
      local sid = mp.get_property_number("sid")
      mp.commandv("sub-add", out, "select")
      if sid then
        mp.commandv("sub-remove", tostring(sid))
      end
      mp.set_property("sub-delay", "0")
      toast("Subtitles re-timed", 2)
    end)
  end)
end

-- One-click subtitle control menu. uosc's bottom-bar `subtitles` button is
-- rerouted here (see the overwrite-binding wiring at the bottom of this file).
local function subtitle_menu()
  local visible = mp.get_property_native("sub-visibility") == true
  local items = {
    {
      title = "Subtitles: " .. (visible and "On" or "Off"),
      icon = "subtitles",
      active = visible,
      keep_open = true,
      value = { "cycle", "sub-visibility" },
    },
  }

  -- Switch active subtitle track, showing language and title.
  local track_items = {
    { title = "Off", active = mp.get_property("sid") == "no", value = { "set", "sid", "no" } },
  }
  local tracks = mp.get_property_native("track-list") or {}
  for _, t in ipairs(tracks) do
    if t.type == "sub" then
      local lang = t.lang and string.upper(t.lang) or "UND"
      local label = t.title or t["external-filename"] or "Subtitle"
      if t.forced then label = label .. " [forced]" end
      track_items[#track_items + 1] = {
        title = lang .. " - " .. label,
        active = t.selected == true,
        value = { "set", "sid", tostring(t.id) },
      }
    end
  end
  if #track_items == 1 then
    track_items[#track_items + 1] = { title = "No subtitle tracks", italic = true, muted = true, value = "ignore" }
  end
  items[#items + 1] = { title = "Switch Subtitle Track", items = track_items }

  items[#items + 1] = {
    title = "Browse Local Subtitle File...",
    icon = "folder_open",
    value = { "script-message-to", "smart_sub_manager", "open-subtitle-file" },
  }
  items[#items + 1] = {
    title = "Search Online Subtitles",
    icon = "manage_search",
    value = { "script-message-to", "smart_sub_manager", "search-subtitles" },
  }
  items[#items + 1] = {
    title = "Subtitle Timing",
    items = {
      { title = "Earlier (-0.1s)", hint = "z", value = { "add", "sub-delay", "-0.1" } },
      { title = "Later (+0.1s)", hint = "x", value = { "add", "sub-delay", "0.1" } },
      { title = "Reset Sync", value = { "set", "sub-delay", "0" } },
      {
        title = "Auto-Sync to Audio",
        hint = "Alt+Y",
        icon = "sync_alt",
        value = { "script-message-to", "smart_sub_manager", "autosync" },
      },
    },
  }
  items[#items + 1] = {
    title = "Subtitle Font Size",
    items = {
      { title = "Smaller", value = { "add", "sub-scale", "-0.1" } },
      { title = "Larger", value = { "add", "sub-scale", "0.1" } },
      { title = "Reset Size", value = { "set", "sub-scale", "1" } },
    },
  }

  open_uosc_menu({ type = "enhanced-subtitles", title = "Subtitles", items = items, search_style = "on_demand" })
end

local function clean_temp_subs()
  local dir = temp_sub_dir()
  local cutoff = os.time() - (opts.cleanup_days * 24 * 60 * 60)
  local names = utils.readdir(dir, "files") or {}
  for _, name in ipairs(names) do
    local p = utils.join_path(dir, name)
    local info = utils.file_info(p)
    if info and info.mtime and info.mtime < cutoff then
      os.remove(p)
    end
  end
end

local function prefetch_next()
  if prefetching then return end
  local count = mp.get_property_number("playlist-count") or 0
  local pos = mp.get_property_number("playlist-pos") or 0
  if pos + 1 >= count then return end
  local next_entry = mp.get_property_native("playlist/" .. tostring(pos + 1) .. "/filename")
  if not next_entry or is_network_path(next_entry) then return end
  prefetching = true
  local title, year = strip_tags(next_entry)
  local hash, size = movie_hash(next_entry)
  local key = api_key()
  if not key or key == "" then
    prefetching = false
    return
  end
  search_opensubtitles(title, year, hash, size, function(candidates)
    prefetching = false
    if not candidates or #candidates == 0 then return end
    local best = candidates[1]
    download_os_file(best.file_id, function(link)
      if not link then return end
      local dest = sidecar_path(next_entry, best.language or "eng", "srt")
      curl_download(link, dest, 10, function() end)
    end)
  end)
end

mp.register_event("file-loaded", on_file_loaded)
mp.register_event("shutdown", clean_temp_subs)

mp.add_key_binding("alt+s", "search_subtitles", function()
  search_flow(true)
end)
mp.add_key_binding("alt+y", "autosync", autosync)
mp.add_key_binding(nil, "subtitle_menu", subtitle_menu)

-- Reroute uosc's bottom-bar subtitles button to our one-click subtitle menu.
-- Sent once uosc reports it has loaded, with a timer as a fallback.
local function install_subtitle_button()
  mp.commandv("script-message-to", "uosc", "overwrite-binding", "subtitles",
    "script-binding smart_sub_manager/subtitle_menu")
end
mp.register_script_message("uosc-version", install_subtitle_button)
mp.add_timeout(1.5, install_subtitle_button)

mp.register_script_message("download-id", function(file_id)
  toast("Downloading subtitle...", 2)
  download_os_file(file_id, function(link)
    local lang = "eng"
    for _, c in ipairs(last_candidates) do
      if tostring(c.file_id) == tostring(file_id) then
        lang = c.language or "eng"
        break
      end
    end
    if link then apply_downloaded(link, lang, true) else toast("No match found", 3) end
  end)
end)

mp.register_script_message("open-subtitle-file", pick_subtitle_file)
mp.register_script_message("prefetch-next", prefetch_next)
mp.register_script_message("search-subtitles", function() search_flow(true) end)
mp.register_script_message("autosync", autosync)

mp.observe_property("time-remaining", "number", function(_, rem)
  if rem and rem > 0 and rem < 45 then
    prefetch_next()
  end
end)
