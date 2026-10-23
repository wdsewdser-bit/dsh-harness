$ErrorActionPreference='Stop'
if(!$env:DSH_HOME){throw 'EXPLICIT_FIXTURE_DSH_HOME_REQUIRED'}
Add-Type -Path "$PSScriptRoot/../home/profiles/web/plugins/verifier-native-Capability.cs"
$fixture=Join-Path $env:DSH_HOME ('fixture-'+[guid]::NewGuid().ToString('N'))
if(Test-Path -LiteralPath $fixture){throw 'FRESH_FIXTURE_REQUIRED'}
$scratch=Join-Path $fixture 'scratch'
$product=Join-Path $fixture 'fake-product'
New-Item -ItemType Directory -Path "$scratch\slot",$product | Out-Null
$checks=[ordered]@{}
$authorized=[ScratchCapability]::CaptureFixtureRoot($scratch)
$cap=[ScratchCapability]::new($authorized)
$authorized.Dispose()
try {
  $checks.actualNtfsDetected=$cap.FileSystemName -ceq 'NTFS'
  $unsupported=$false
  try{[ScratchCapability]::ValidatePlatform('Unix',64,'NTFS',0x88,'X64')}catch{$unsupported=$true}
  $checks.unsupportedPlatformRefused=$unsupported
  $unsupported=$false
  try{[ScratchCapability]::ValidatePlatform('Win32NT',64,'ReFS',0x88,'X64')}catch{$unsupported=$true}
  $checks.unsupportedFilesystemRefused=$unsupported
  $unsupported=$false
  try{[ScratchCapability]::ValidatePlatform('Win32NT',64,'NTFS',0,'X64')}catch{$unsupported=$true}
  $checks.missingCapabilitiesRefused=$unsupported
  $unsupported=$false
  try{[ScratchCapability]::ValidatePlatform('Win32NT',64,'NTFS',0x88,'Arm64')}catch{$unsupported=$true}
  $checks.arm64RejectedDespite64BitPointers=$unsupported
  $none=[Threading.CancellationToken]::None
  $cap.EnsureDirectory('created/deep/leaf',$none)
  $cap.EnsureDirectory('created/deep/leaf',$none)
  $checks.handleMkdirIdempotent=Test-Path -LiteralPath "$scratch\created\deep\leaf" -PathType Container
  $invalid=$false
  try{$cap.EnsureDirectory('invalid-prefix/../escape',$none)}catch{$invalid=$true}
  $checks.invalidMkdirNoPartialMutation=$invalid -and !(Test-Path -LiteralPath "$scratch\invalid-prefix")
  $cancel=[Threading.CancellationTokenSource]::new()
  $cancel.Cancel()
  $preWrite=$false;$preMkdir=$false
  try{$cap.WriteCancelable('cancelled.txt','bad',$false,$null,$cancel.Token)}catch{$preWrite=$_.Exception.ToString().Contains('OperationCanceledException')}
  try{$cap.EnsureDirectory('cancelled-directory',$cancel.Token)}catch{$preMkdir=$_.Exception.ToString().Contains('OperationCanceledException')}
  $checks.preCancelledNoWrite=$preWrite -and !(Test-Path -LiteralPath "$scratch\cancelled.txt")
  $checks.preCancelledNoMkdir=$preMkdir -and !(Test-Path -LiteralPath "$scratch\cancelled-directory")
  $cancel.Dispose()
  $cap.Write('slot/probe.txt','one',$false,$null)
  $checks.create=(Get-Content -LiteralPath "$scratch\slot\probe.txt" -Raw) -ceq 'one'
  $collision=$false
  try{$cap.Write('slot/probe.txt','bad',$false,$null)}catch{$collision=$true}
  $checks.createCollision=$collision -and (Get-Content -LiteralPath "$scratch\slot\probe.txt" -Raw) -ceq 'one'
  $cap.Write('slot/probe.txt','two',$true,$null)
  $checks.atomicReplace=(Get-Content -LiteralPath "$scratch\slot\probe.txt" -Raw) -ceq 'two'
  $accessSection=[Security.AccessControl.AccessControlSections]::Access
  $cap.Write('slot/inherited-acl.txt','before',$false,$null)
  $inherited=Get-Acl -LiteralPath "$scratch\slot\inherited-acl.txt"
  $inheritedBefore=$inherited.GetSecurityDescriptorSddlForm($accessSection)
  $cap.Write('slot/inherited-acl.txt','after',$true,$null)
  $inheritedAfter=Get-Acl -LiteralPath "$scratch\slot\inherited-acl.txt"
  $checks.inheritedDaclPreserved=$inheritedAfter.GetSecurityDescriptorSddlForm($accessSection) -ceq $inheritedBefore -and $inheritedAfter.AreAccessRulesProtected -eq $inherited.AreAccessRulesProtected
  $cap.Write('slot/protected-acl.txt','before',$false,$null)
  $acl=[Security.AccessControl.FileSecurity]::new()
  $acl.SetAccessRuleProtection($true,$false)
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl.SetOwner($sid)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))
  Set-Acl -LiteralPath "$scratch\slot\protected-acl.txt" -AclObject $acl
  $protectedBefore=(Get-Acl -LiteralPath "$scratch\slot\protected-acl.txt").GetSecurityDescriptorSddlForm($accessSection)
  $cap.Write('slot/protected-acl.txt','after',$true,$null)
  $protectedAfter=Get-Acl -LiteralPath "$scratch\slot\protected-acl.txt"
  $checks.protectedDaclPreserved=$protectedAfter.AreAccessRulesProtected -and $protectedAfter.GetSecurityDescriptorSddlForm($accessSection) -ceq $protectedBefore
  $identitySection=[Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
  $identityBefore=$protectedAfter.GetSecurityDescriptorSddlForm($identitySection)
  $cap.Write('slot/protected-acl.txt','identity-update',$true,$null)
  $checks.ownerAndGroupPreserved=(Get-Acl -LiteralPath "$scratch\slot\protected-acl.txt").GetSecurityDescriptorSddlForm($identitySection) -ceq $identityBefore
  $checks.daclSurvivesIdentityUpdate=(Get-Acl -LiteralPath "$scratch\slot\protected-acl.txt").GetSecurityDescriptorSddlForm($accessSection) -ceq $protectedBefore
  [ScratchCapability]::SetFixtureGroup("$scratch\slot\protected-acl.txt",'S-1-1-0')
  $groupBefore=(Get-Acl -LiteralPath "$scratch\slot\protected-acl.txt").GetSecurityDescriptorSddlForm($identitySection)
  $cap.Write('slot/protected-acl.txt','after',$true,$null)
  $checks.nondefaultGroupPreserved=(Get-Acl -LiteralPath "$scratch\slot\protected-acl.txt").GetSecurityDescriptorSddlForm($identitySection) -ceq $groupBefore
  $cap.BeforeAclApplyForFixture=[Action]{throw 'injected-acl-apply-failure'}
  $aclFailure=$false
  try{$cap.Write('slot/protected-acl.txt','bad',$true,$null)}catch{$aclFailure=$_.Exception.ToString().Contains('injected-acl-apply-failure')}
  $cap.BeforeAclApplyForFixture=$null
  $checks.aclFailurePreservesOld=$aclFailure -and (Get-Content -LiteralPath "$scratch\slot\protected-acl.txt" -Raw) -ceq 'after' -and (Get-Acl -LiteralPath "$scratch\slot\protected-acl.txt").GetSecurityDescriptorSddlForm($accessSection) -ceq $protectedBefore
  $checks.aclFailureCleansTemp=@(Get-ChildItem -LiteralPath "$scratch\slot" -Filter '.cap-*').Count -eq 0
  $cancel=[Threading.CancellationTokenSource]::new()
  $cap.BeforePublishForFixture=[Action]{$cancel.Cancel()}
  $aborted=$false
  try{$cap.WriteCancelable('slot/probe.txt','bad',$true,$null,$cancel.Token)}catch{$aborted=$_.Exception.ToString().Contains('OperationCanceledException')}
  $cap.BeforePublishForFixture=$null
  $checks.cancelBeforePublishPreservesOld=$aborted -and (Get-Content -LiteralPath "$scratch\slot\probe.txt" -Raw) -ceq 'two'
  $checks.cancelRemovesTemp=@(Get-ChildItem -LiteralPath "$scratch\slot" -Filter '.cap-*').Count -eq 0
  $cancel.Dispose()
  $cap.Write('slot/x','short-leaf',$false,$null)
  $checks.shortLeafRename=(Get-Content -LiteralPath "$scratch\slot\x" -Raw) -ceq 'short-leaf'
  $observed=$cap.ReadVersioned('slot/probe.txt')
  $checks.handleReadAndToken=$observed.Content -ceq 'two' -and $observed.Version.StartsWith('cap-sha256:')
  $edited=$cap.EditObserved('slot/probe.txt',$observed.Version,'two','three')
  $checks.observedEdit=$edited.Content -ceq 'three' -and $edited.Version -cne $observed.Version
  $stale=$false
  try{$cap.EditObserved('slot/probe.txt',$observed.Version,'three','bad') | Out-Null}catch{$stale=$_.Exception.ToString().Contains('FS_STALE_VERSION')}
  $checks.staleEditRefused=$stale -and $cap.ReadVersioned('slot/probe.txt').Content -ceq 'three'
  $unobserved=$false
  try{$cap.EditObserved('slot/probe.txt','', 'three','bad') | Out-Null}catch{$unobserved=$_.Exception.ToString().Contains('FS_NOT_OBSERVED')}
  $checks.unobservedEditRefused=$unobserved -and $cap.ReadVersioned('slot/probe.txt').Content -ceq 'three'
  $cancel=[Threading.CancellationTokenSource]::new()
  $cap.BeforeReadChunkForFixture=[Action]{$cancel.Cancel()}
  $readCancelled=$false
  try{$cap.ReadCancelable('slot/probe.txt',$cancel.Token) | Out-Null}catch{$readCancelled=$_.Exception.ToString().Contains('OperationCanceledException')}
  $cap.BeforeReadChunkForFixture=$null
  $checks.readCancellationReleasesHandles=$readCancelled -and $cap.ReadVersioned('slot/probe.txt').Content -ceq 'three'
  $editCancelled=$false
  try{$cap.EditCancelable('slot/probe.txt',$edited.Version,'three','bad',$cancel.Token) | Out-Null}catch{$editCancelled=$_.Exception.ToString().Contains('OperationCanceledException')}
  $checks.preCancelledEditPreservesOld=$editCancelled -and $cap.ReadVersioned('slot/probe.txt').Content -ceq 'three'
  $cancel.Dispose()
  $text=([char]0x4E2D).ToString()+"`r`nsecond`r`n"
  $cap.Write('slot/utf8.txt',$text,$false,$null)
  $checks.utf8AndCrLfPreserved=$cap.ReadVersioned('slot/utf8.txt').Content -ceq $text
  Set-Content -LiteralPath "$product\private.txt" -Value 'fixture-private' -NoNewline
  New-Item -ItemType HardLink -Path "$scratch\slot\read-alias.txt" -Value "$product\private.txt" | Out-Null
  $aliasRefused=$false
  try{$cap.ReadVersioned('slot/read-alias.txt') | Out-Null}catch{$aliasRefused=$_.Exception.ToString().Contains('reparse/type/hardlink refused')}
  $checks.hardlinkedReadRefused=$aliasRefused
  $disposeRejected=$false
  try{$cap.Write('slot/dispose.txt','bad',$false,[Action]{$cap.Dispose()})}catch{$disposeRejected=$_.Exception.ToString().Contains('Dispose during Write refused')}
  $cap.Write('slot/after-dispose.txt','alive',$false,$null)
  $checks.reentrantDisposeSafe=$disposeRejected -and (Get-Content -LiteralPath "$scratch\slot\after-dispose.txt" -Raw) -ceq 'alive'
  $cap.BeforeCreatedCheckForFixture=[Action]{throw 'injected-post-create-check-failure'}
  $injected=$false
  try{$cap.Write('slot/injected.txt','bad',$false,$null)}catch{$injected=$_.Exception.ToString().Contains('injected-post-create-check-failure')}
  $cap.BeforeCreatedCheckForFixture=$null
  $checks.postCreateFailureCleanup=$injected -and @(Get-ChildItem -LiteralPath "$scratch\slot" -Filter '.cap-*').Count -eq 0
  $script:hardlinkRejected=$false
  $script:hardlinkError=$null
  $cap.BeforeCreatedCheckForFixture=[Action]{
    $temp=Get-ChildItem -LiteralPath "$scratch\slot" -Filter '.cap-*' | Select-Object -First 1
    try{New-Item -ItemType HardLink -Path "$product\temp-alias.txt" -Value $temp.FullName -ErrorAction Stop | Out-Null}catch{$script:hardlinkRejected=$true;$script:hardlinkError=$_.Exception.Message}
  }
  $cap.Write('slot/hardlink-check.txt','protected',$false,$null)
  $cap.BeforeCreatedCheckForFixture=$null
  $checks.pendingTempHardlinkRefused=$script:hardlinkRejected -and !(Test-Path -LiteralPath "$product\temp-alias.txt")
  New-Item -ItemType Directory -Path "$scratch\publish-slot" | Out-Null
  $script:publishMutation=$false
  $script:publishMutationError=$null
  $cap.BeforePublishForFixture=[Action]{try{[ScratchCapability]::SetFixtureJunction("$scratch\publish-slot",$product);$script:publishMutation=$true}catch{$script:publishMutationError=$_.Exception.ToString()}}
  $publishError=$null
  try{$cap.Write('publish-slot/final.txt','publication',$false,$null)}catch{$publishError=$_.Exception.ToString()}
  $cap.BeforePublishForFixture=$null
  $checks.publishMutationBlockedByNonemptyDirectory=(!$script:publishMutation) -and $script:publishMutationError.Contains('fixture reparse set failed 145')
  $checks.publishNoProductWrite=!(Test-Path -LiteralPath "$product\final.txt")
  $checks.publishStayedInOwnedObject= (Get-Content -LiteralPath "$scratch\publish-slot\final.txt" -Raw -ErrorAction SilentlyContinue) -ceq 'publication'
  Move-Item -LiteralPath "$scratch\slot" -Destination "$scratch\old-slot"
  New-Item -ItemType Junction -Path "$scratch\slot" -Value $product | Out-Null
  $rejected=$false
  try{$cap.Write('slot/escape.txt','bad',$false,$null)}catch{$rejected=$true}
  $checks.ancestorReplacementRejected=$rejected -and !(Test-Path -LiteralPath "$product\escape.txt")
  $mkdirRefused=$false
  try{$cap.EnsureDirectory('slot/escape-dir',$none)}catch{$mkdirRefused=$true}
  $checks.reparseMkdirRefused=$mkdirRefused -and !(Test-Path -LiteralPath "$product\escape-dir")
  $readRefused=$false
  try{$cap.ReadVersioned('slot/private.txt') | Out-Null}catch{$readRefused=$true}
  $checks.ancestorReparseReadRefused=$readRefused
  $checks.tempCleanup=@(Get-ChildItem -LiteralPath "$scratch\old-slot" -Filter '.cap-*').Count -eq 0
  New-Item -ItemType Directory -Path "$scratch\empty-slot" | Out-Null
  $script:reparseApplied=$false
  $failed=$false
  try {
    $cap.Write('empty-slot/race.txt','must-not-escape',$false,[Action]{
      [ScratchCapability]::SetFixtureJunction("$scratch\empty-slot",$product)
      $script:reparseApplied=$true
    })
  }catch{$failed=$true;$_ | Out-String | Set-Content -LiteralPath "$env:DSH_HOME/inplace-error.txt"}
  $checks.inPlaceReparseApplied=$script:reparseApplied
  $checks.inPlaceNoProductWrite=!(Test-Path -LiteralPath "$product\race.txt")
  $checks.inPlaceFailedClosed=$failed
}finally{$cap.Dispose()}
$result=[ordered]@{scope='isolated-native-handle-prototype-not-integrated';fixture=$fixture;publishMutationApplied=$script:publishMutation;publishMutationError=$script:publishMutationError;hardlinkError=$script:hardlinkError;checks=$checks;passed=(@($checks.Values | Where-Object {!$_}).Count -eq 0)}
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath "$env:DSH_HOME/result.json"
$result | ConvertTo-Json -Depth 6
if(!$result.passed){throw 'PROTOTYPE_CHECK_FAILED'}
