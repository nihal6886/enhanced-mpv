std = "luajit"
max_line_length = 140
unused_args = false
allow_defined_top = true

globals = {
  "mp",
  "msg",
  "utils",
  "options",
  "input",
}

read_globals = {
  "bit",
  "jit",
}

files["mpv-config/scripts/*.lua"] = {
  ignore = { "212", "631" },
}
