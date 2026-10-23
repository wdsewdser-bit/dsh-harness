param([string]$ControllerDerivedRoot,[string]$ControllerExpectedFileId,[string]$ReleaseFile)
$ErrorActionPreference='Stop'
if(!$env:DSH_HOME){throw 'EXPLICIT_FIXTURE_DSH_HOME_REQUIRED'}
$references=@(Get-ChildItem -LiteralPath (Join-Path $PSHOME 'ref') -Filter '*.dll' | Select-Object -ExpandProperty FullName)
Add-Type -Path @("$PSScriptRoot/../home/profiles/web/plugins/verifier-native-Capability.cs","$PSScriptRoot/../home/profiles/web/plugins/verifier-native-BridgeRuntime.cs","$PSScriptRoot/verifier-native-InputFaultFixture.cs") -ReferencedAssemblies $references
[InputFaultFixture]::Run($ControllerDerivedRoot,$ControllerExpectedFileId,$ReleaseFile)
