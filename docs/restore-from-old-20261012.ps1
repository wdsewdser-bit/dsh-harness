# 把 docs\old 中已移动的文件按 move-log 还原到原位置。默认演示，加 -Execute 才真正还原。
param([switch]$Execute)
$base = 'D:\dsh-test'
$oldRoot = Join-Path $base 'docs\old'
$log = Import-Csv -LiteralPath (Join-Path $oldRoot 'move-log-20261012.csv') -Encoding UTF8
foreach ($r in ($log | Where-Object { $_.result -eq '已移动' })) {
  $orig = Join-Path $base $r.src
  if (Test-Path -LiteralPath $orig) { Write-Output "跳过（原位置已有文件）：$($r.src)"; continue }
  if ($Execute) {
    New-Item -ItemType Directory -Force -Path (Split-Path $orig) | Out-Null
    Move-Item -LiteralPath $r.dst -Destination $orig
    Write-Output "已还原：$($r.src)"
  } else { Write-Output "待还原(演示)：$($r.src)" }
}