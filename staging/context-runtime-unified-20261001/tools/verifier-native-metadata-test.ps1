$ErrorActionPreference='Stop'
if(!$env:DSH_HOME){throw 'EXPLICIT_FIXTURE_DSH_HOME_REQUIRED'}
Add-Type -Path "$PSScriptRoot/../home/profiles/web/plugins/verifier-native-Capability.cs"
Add-Type -Path "$PSScriptRoot/verifier-native-MetadataFixture.cs"
$fixture=Join-Path $env:DSH_HOME ('metadata-fixture-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$root=[ScratchCapability]::CaptureFixtureRoot($fixture)
$cap=[ScratchCapability]::new($root);$root.Dispose();$cap.StrictScratchMetadata=$true
$checks=[ordered]@{};$details=[ordered]@{}
try {
  foreach($kind in @('objectid','ea','compression','label')) {
    $name=$kind+'.txt';$file=Join-Path $fixture $name
    $cap.Write($name,'original',$false,$null)
    [ScratchMetadataFixture]::Add($file,$kind)
    $errorText=$null
    try{$cap.Write($name,'must not publish',$true,$null)}catch{$errorText=$_.Exception.ToString()}
    $checks[$kind+'ActuallyAppliedThenRefused']=$errorText -like '*FS_UNSUPPORTED_METADATA*' -and (Get-Content -LiteralPath $file -Raw) -ceq 'original'
    $details[$kind]=$errorText
  }
  $cap.Write('cancel.txt','before',$false,$null)
  $cancel=[Threading.CancellationTokenSource]::new()
  $cap.BeforePublishForFixture=[Action]{$cancel.Cancel()}
  $cancelled=$false
  try{$cap.WriteCancelable('cancel.txt','after',$true,$null,$cancel.Token)}catch{$cancelled=$_.Exception.ToString().Contains('OperationCanceledException')}
  $cap.BeforePublishForFixture=$null
  $cancel.Dispose()
  $checks.strictPrepublicationTokenCancels=$cancelled -and (Get-Content -LiteralPath (Join-Path $fixture 'cancel.txt') -Raw) -ceq 'before'
  $checks.noPendingTemps=@(Get-ChildItem -LiteralPath $fixture | Where-Object {$_.Name -match '^[0-9a-f]{8}\.tmp$' -or $_.Name.StartsWith('.cap-')}).Count -eq 0
}finally{$cap.Dispose()}
$result=[ordered]@{scope='real-NTFS-metadata-in-disposable-fixture-no-privilege-enabled';fixture=$fixture;checks=$checks;details=$details;passed=@($checks.Values|Where-Object {!$_}).Count -eq 0}
$result|ConvertTo-Json -Depth 8|Set-Content -LiteralPath "$env:DSH_HOME/metadata-result.json"
$result|ConvertTo-Json -Depth 8
if(!$result.passed){throw 'METADATA_CHECK_FAILED'}
