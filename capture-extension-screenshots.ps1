$chromePath = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path $chromePath)) {
    Write-Host 'Chrome not found'
    exit 1
}

# Capture popup.html
$popupPath = 'file:///C:/Users/User/port_001/browser-extension/popup.html'
$outputPopup = 'C:\Users\User\port_001\docs\screenshots\extension-popup.png'
& $chromePath --headless --screenshot=$outputPopup --window-size=400,600 --hide-scrollbars --force-device-scale-factor=1 $popupPath
Write-Host 'Popup screenshot done'

# Capture onboarding/index.html
$onboardingPath = 'file:///C:/Users/User/port_001/installer/onboarding/index.html'
$outputOnboarding = 'C:\Users\User\port_001\docs\screenshots\setup-screen.png'
& $chromePath --headless --screenshot=$outputOnboarding --window-size=800,600 --hide-scrollbars --force-device-scale-factor=1 $onboardingPath
Write-Host 'Onboarding screenshot done'