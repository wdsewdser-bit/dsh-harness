param([string]$ControllerDerivedRoot,[string]$ControllerExpectedFileId,[string]$Workspace,[string]$WorkspaceExpectedFileId,[string]$SessionId,[string]$SessionRootExpectedFileId)
$ErrorActionPreference='Stop'
$references=@(Get-ChildItem -LiteralPath (Join-Path $PSHOME 'ref') -Filter '*.dll' | Select-Object -ExpandProperty FullName)
Add-Type -Path @("$PSScriptRoot/verifier-native-Capability.cs","$PSScriptRoot/verifier-native-BridgeRuntime.cs") -ReferencedAssemblies $references
if($Workspace){[ScratchBridgeRuntime]::RunBootstrap($Workspace,$WorkspaceExpectedFileId,$SessionId,$(if($SessionRootExpectedFileId){$SessionRootExpectedFileId}else{$null}))}
else{[ScratchBridgeRuntime]::Run($ControllerDerivedRoot,$ControllerExpectedFileId)}
