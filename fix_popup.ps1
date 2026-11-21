$content = Get-Content 'C:\Users\User\port_001\browser-extension\popup.js' -Raw
$content = $content -replace '&', '&'
$content = $content -replace '<', '<'
$content = $content -replace '>', '>'
$content = $content -replace '"', '"'
Set-Content -Path 'C:\Users\User\port_001\browser-extension\popup.js' -Value $content -Encoding UTF8