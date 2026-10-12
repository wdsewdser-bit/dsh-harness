param(
  [int]$TimeoutSeconds = 15
)

$deadline = (Get-Date).AddSeconds([Math]::Max(1, $TimeoutSeconds))
$process = $null

do {
  $process = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
  if ($process -ne $null) { break }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)

if ($process -eq $null) {
  exit 0
}

$source = @'
using System;
using System.Runtime.InteropServices;

public static class DshDesktopFocus {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll")]
  public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int command);

  [DllImport("user32.dll")]
  public static extern bool BringWindowToTop(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@

Add-Type -TypeDefinition $source -ErrorAction SilentlyContinue

$window = [IntPtr]$process.MainWindowHandle
$foreground = [DshDesktopFocus]::GetForegroundWindow()
$foregroundProcessId = 0
$foregroundThread = [DshDesktopFocus]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId)
$targetProcessId = 0
$targetThread = [DshDesktopFocus]::GetWindowThreadProcessId($window, [ref]$targetProcessId)
$attached = [DshDesktopFocus]::AttachThreadInput($foregroundThread, $targetThread, $true)

try {
  [DshDesktopFocus]::ShowWindow($window, 9) | Out-Null
  [DshDesktopFocus]::BringWindowToTop($window) | Out-Null
  [DshDesktopFocus]::SetForegroundWindow($window) | Out-Null
} finally {
  if ($attached) {
    [DshDesktopFocus]::AttachThreadInput($foregroundThread, $targetThread, $false) | Out-Null
  }
}
