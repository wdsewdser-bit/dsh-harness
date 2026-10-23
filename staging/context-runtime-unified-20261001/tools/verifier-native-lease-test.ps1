param([Parameter(Mandatory)][string]$Workspace,[Parameter(Mandatory)][string]$WorkspaceFileId)
$ErrorActionPreference='Stop'
if(!$env:DSH_HOME){throw 'EXPLICIT_FIXTURE_DSH_HOME_REQUIRED'}
Add-Type -Path "$PSScriptRoot/../home/profiles/web/plugins/verifier-native-Capability.cs"
$checks=[ordered]@{}
$product=Join-Path $Workspace 'product'
New-Item -ItemType Directory -Path $product | Out-Null
$lease=[ScratchCapability]::Bootstrap($Workspace,$WorkspaceFileId,'lease-session')
$session=Join-Path $Workspace '.dsh-verifier-scratch/lease-session'
try {
  $guard=$lease.Guard()
  try {
    $denied=$false
    try{[ScratchCapability]::SetFixtureJunction($session,$product)}catch{$denied=$true}
    $checks.guardBlocksInPlaceRootReparse=$denied
  }finally{$guard.Dispose()}
  [ScratchCapability]::SetFixtureJunction($session,$product)
  $checks.idleReparseAttackApplied=!!((Get-Item -LiteralPath $session).Attributes -band [IO.FileAttributes]::ReparsePoint)
  $denied=$false
  try{$bad=$lease.Guard();$bad.Dispose()}catch{$denied=$true}
  $checks.nextOperationFailsClosedAfterIdleReparse=$denied
  $checks.productRemainsEmpty=@(Get-ChildItem -LiteralPath $product).Count -eq 0
}finally{$lease.Dispose()}
$denied=$false
try{$bad=$lease.Guard();$bad.Dispose()}catch{$denied=$true}
$checks.disposedLeaseCannotReacquire=$denied
$lease.Dispose();$checks.disposeIdempotent=$true
Rename-Item -LiteralPath $Workspace -NewName ((Split-Path $Workspace -Leaf)+'-released')
Rename-Item -LiteralPath ($Workspace+'-released') -NewName (Split-Path $Workspace -Leaf)
$checks.allAncestorHandlesReleased=$true
$result=[ordered]@{checks=$checks;passed=@($checks.Values|Where-Object {!$_}).Count -eq 0;fixture=$Workspace}
$result|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $env:DSH_HOME 'lease-result.json')
if(!$result.passed){throw 'LEASE_CHECK_FAILED'}
$result|ConvertTo-Json -Depth 5 -Compress
