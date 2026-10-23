param([string]$ControllerDerivedRoot,[string]$ControllerExpectedFileId)
[Console]::Out.WriteLine('not-json');[Console]::Out.Flush()
[Console]::In.ReadLine() | Out-Null
[IO.File]::WriteAllText((Join-Path $ControllerDerivedRoot 'late-write.txt'),'must not happen')
