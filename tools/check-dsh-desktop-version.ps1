param(
  [Parameter(Mandatory = $true)][string]$DshHome,
  [Parameter(Mandatory = $true)][string]$DesktopExe
)

$ErrorActionPreference = 'Stop'

$localPackage = Join-Path $DshHome '..\app\package.json' | Resolve-Path
$localManifest = Get-Content -Raw -LiteralPath $localPackage | ConvertFrom-Json
$localVersion = $localManifest.dependencies.'@deepseek-ai/dsh'

$desktopRoot = Split-Path -Parent $DesktopExe
$desktopPackage = Join-Path $desktopRoot 'resources\app.asar\package.json'
$versionReader = Join-Path $PSScriptRoot 'read-dsh-desktop-version.cjs'

$oldElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE
$oldDesktopPackage = $env:DSH_DESKTOP_PACKAGE
$oldDesktopVersionOut = $env:DSH_DESKTOP_VERSION_OUT
$versionOut = Join-Path $env:TEMP ("dsh-desktop-version-{0}.txt" -f $PID)
try {
  $env:ELECTRON_RUN_AS_NODE = '1'
  $env:DSH_DESKTOP_PACKAGE = $desktopPackage
  $env:DSH_DESKTOP_VERSION_OUT = $versionOut
  $probe = Start-Process -FilePath $DesktopExe `
    -ArgumentList @($versionReader) `
    -NoNewWindow -Wait -PassThru
  $probeExitCode = $probe.ExitCode
  if (Test-Path -LiteralPath $versionOut) {
    $desktopVersion = Get-Content -Raw -LiteralPath $versionOut
  }
} finally {
  $env:ELECTRON_RUN_AS_NODE = $oldElectronRunAsNode
  $env:DSH_DESKTOP_PACKAGE = $oldDesktopPackage
  $env:DSH_DESKTOP_VERSION_OUT = $oldDesktopVersionOut
  Remove-Item -LiteralPath $versionOut -Force -ErrorAction SilentlyContinue
}

if ($probeExitCode -ne 0) {
  [Console]::Error.WriteLine("[DSH] Failed to read desktop version from $desktopPackage")
  exit 1
}

if ([string]::IsNullOrWhiteSpace($localVersion) -or
    [string]::IsNullOrWhiteSpace($desktopVersion)) {
  [Console]::Error.WriteLine('[DSH] Could not determine local or desktop DSH version.')
  exit 1
}

if ($localVersion -ne $desktopVersion) {
  [Console]::Error.WriteLine(
    "[DSH] Version mismatch: test runtime is $localVersion, desktop is $desktopVersion."
  )
  [Console]::Error.WriteLine(
    '[DSH] Upgrade D:\dsh-test to the desktop version before sharing its home.'
  )
  exit 2
}

Write-Output "[DSH] Version gate passed: $localVersion"
