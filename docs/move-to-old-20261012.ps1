# 把归档候选从 D:\dsh-test 移入 D:\dsh-test\docs\old，保留相对路径。默认只演示，加 -Execute 才真正移动。
# 只移动，不删除。遇到目标已存在则跳过。移动日志写到 docs\old\move-log-20261012.csv。
param([switch]$Execute)
$base = 'D:\dsh-test'
$oldRoot = Join-Path $base 'docs\old'
$manifest = Join-Path $base 'docs\archive-move-manifest-20261012.csv'
$log = New-Object System.Collections.Generic.List[object]
$rows = Import-Csv -LiteralPath $manifest -Encoding UTF8
foreach ($r in $rows) {
  $src = Join-Path $base $r.相对路径
  $dst = Join-Path $oldRoot $r.相对路径
  if (-not (Test-Path -LiteralPath $src)) { $log.Add([pscustomobject]@{src=$r.相对路径;dst=$dst;result='源不存在'}); continue }
  if (Test-Path -LiteralPath $dst) { $log.Add([pscustomobject]@{src=$r.相对路径;dst=$dst;result='目标已存在，跳过'}); continue }
  if ($Execute) {
    New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
    Move-Item -LiteralPath $src -Destination $dst
    $log.Add([pscustomobject]@{src=$r.相对路径;dst=$dst;result='已移动'})
  } else {
    $log.Add([pscustomobject]@{src=$r.相对路径;dst=$dst;result='待移动(演示)'})
  }
}
$logPath = Join-Path $oldRoot 'move-log-20261012.csv'
New-Item -ItemType Directory -Force -Path $oldRoot | Out-Null
$log | Export-Csv -LiteralPath $logPath -NoTypeInformation -Encoding UTF8
"完成：$($log.Count) 条，日志 $logPath"
$log | Group-Object result | ForEach-Object { "$($_.Name)=$($_.Count)" }