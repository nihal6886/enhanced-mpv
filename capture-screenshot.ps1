Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Launch enhanced-mpv with test clip
$mpvPath = "$env:LOCALAPPDATA\Programs\EnhancedMPV\enhanced-mpv.exe"
$clipPath = "C:\Users\User\port_001\docs\screenshots\test-clip.mp4"

$proc = Start-Process -FilePath $mpvPath -ArgumentList "--force-window=immediate", "$clipPath" -PassThru

# Wait for window to appear
Start-Sleep -Seconds 3

# Find the mpv window using FindWindow
Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class Win32 {
        [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]
        public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

$hwnd = [Win32]::FindWindow("mpv", $null)

if ($hwnd -ne 0 -and $hwnd -ne [IntPtr]::Zero) {
    # Get window bounds
    $rect = New-Object Win32+RECT
    [Win32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
    
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    
    # Capture screenshot
    $bmp = New-Object System.Drawing.Bitmap $width, $height
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    $gfx.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
    $bmp.Save("C:\Users\User\port_001\docs\screenshots\player-ui.png", [System.Drawing.Imaging.ImageFormat]::Png)
    $gfx.Dispose()
    $bmp.Dispose()
    Write-Host "Player screenshot saved"
} else {
    Write-Host "Could not find mpv window"
}

# Close mpv
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue