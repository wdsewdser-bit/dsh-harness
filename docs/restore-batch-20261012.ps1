# 按 restore-list-20261012.csv 把被判为未完成、仍需保留、计划中或被引用的归档文件还原到原位（只移不删）。
# 默认只演示，加 -Execute 才真正还原。还原后在移动日志里把结果改为“已还原”。
param([switch]$Execute)
$base = 'D:\dsh-test'
$oldRoot = Join-Path $base 'docs\old'
$logPath = Join-Path $oldRoot 'move-log-20261012.csv'
$listPath = Join-Path $base 'docs\restore-list-20261012.csv'
$log = @(Import-Csv -LiteralPath $logPath -Encoding UTF8)
$list = @(Import-Csv -LiteralPath $listPath -Encoding UTF8)

$done = 0; $skip = 0
foreach ($item in $list) {
  $rel = $item.相对路径
  $row = $log | Where-Object { $_.src -eq $rel -and $_.result -eq '已移动' } | Select-Object -First 1
  if (-not $row) { "未在日志中找到已移动记录：$rel"; $skip++; continue }
  $orig = Join-Path $base $rel
  if (Test-Path -LiteralPath $orig) { "跳过（原位置已有文件）：$rel"; $skip++; continue }
  if (-not (Test-Path -LiteralPath $row.dst)) { "跳过（归档文件不存在）：$rel"; $skip++; continue }
  if ($Execute) {
    New-Item -ItemType Directory -Force -Path (Split-Path $orig) | Out-Null
    Move-Item -LiteralPath $row.dst -Destination $orig
    $row.result = '已还原'
    $done++
  } else {
    "待还原（演示）：$rel"
  }
}

if ($Execute) {
  $log | Export-Csv -LiteralPath $logPath -NoTypeInformation -Encoding UTF8
  "已还原 $done 个，跳过 $skip 个。日志已更新：$logPath"
} else {
  "演示完成：待还原 $($list.Count - $skip) 个，跳过 $skip 个"
}
