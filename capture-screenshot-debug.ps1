Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Launch enhanced-mpv with test clip
$mpvPath = "$env:LOCALAPPDATA\Programs\EnhancedMPV\enhanced-mpv.exe"
$clipPath = "C:\Users\User\port_001\docs\screenshots\test-clip.mp4"

$proc = Start-Process -FilePath $mpvPath -ArgumentList "--force-window=immediate", "$clipPath" -PassThru

Write-Host "Process ID: $($proc.Id)"

# Wait for window to appear
Start-Sleep -Seconds 4

# List all windows to debug
Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class Win32 {
        [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]
        public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
        [DllImport("user32.dll")]
        public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
        [DllImport("user32.dll")]
        public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

# Enum all windows to find mpv
$foundHwnd = [IntPtr]::Zero
$enumCallback = [Win32+EnumWindowsProc] {
    param($hWnd, $lParam)
    $pid = 0
    [Win32]::GetWindowThreadProcessId($hWnd, [ref]$pid) | Out-Null
    if ($pid -eq $proc.Id) {
        $className = New-Object System.Text.StringBuilder 256
        [Win32]::GetClassName($hWnd, $className, 256) | Out-Null
        $windowTitle = New-Object System.Text.StringBuilder 256
        [Win32]::GetWindowText($hWnd, $windowTitle, 256) | Out-Null
        Write-Host "Found window: PID=$pid, Class=$($className.ToString()), Title=$($windowTitle.ToString())"
        $script:foundHwnd = $hWnd
        return $false
    }
    return $true
}

[Win32]::EnumWindows($enumCallback, [IntPtr]::Zero) | Out-Null

$hwnd = $script:foundHwnd

if ($hwnd -ne 0 -and $hwnd -ne [IntPtr]::Zero) {
    # Get window bounds
    $rect = New-Object Win32+RECT
    [Win32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
    
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    
    Write-Host "Window bounds: $width x $height at ($($rect.Left), $($rect.Top))"
    
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