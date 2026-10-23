param([string]$ControllerDerivedRoot,[string]$ControllerExpectedFileId)
[Console]::Out.WriteLine('{"ready":true,"scope":"controller-derived-root-handle-identity-checked","filesystem":"NTFS"}');[Console]::Out.Flush()
[Console]::In.ReadLine() | Out-Null
[Console]::Out.WriteLine('{');[Console]::Out.Flush()
$next=[Console]::In.ReadLine()
if($null -ne $next){[IO.File]::WriteAllText((Join-Path $ControllerDerivedRoot 'late-write.txt'),'must not happen')}
