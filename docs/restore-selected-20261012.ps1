# 按清单把已归档文件还原到原位（只移不删），并在移动日志里把结果改为“已还原”。
# 默认只演示，加 -Execute 才真正还原。
param([switch]$Execute)
$base = 'D:\dsh-test'
$oldRoot = Join-Path $base 'docs\old'
$logPath = Join-Path $oldRoot 'move-log-20261012.csv'
$log = @(Import-Csv -LiteralPath $logPath -Encoding UTF8)

$restore = @(
  'docs\agent-team-packet-meta-contract.md',
  'docs\agent-team-v14-ptc-prompt-contract.md',
  'docs\context-opt-20261001\dsh-root-notice.md',
  'docs\context-opt-20261001\README.md',
  'docs\agent-team-v12-architecture-improvement-plan.md',
  'backups\context-runtime-production-deploy-20261006\files\home\team-roles\AGENTS.md',
  'backups\context-runtime-production-deploy-20261006\files\home\team-roles\lead.md',
  'backups\context-runtime-production-deploy-20261006\files\home\team-roles\member.md',
  'backups\context-runtime-production-deploy-20261006\files\home\team-roles\root.md',
  'backups\context-runtime-production-deploy-20261006\files\home\team-roles\verifier.md',
  'backups\backup-v14-fix-20260927-012303\dsh-test\home\team-roles\member.md',
  'backups\backup-v14-fix-20260927-012303\dsh-test\home\team-roles\verifier.md',
  'patch\agent-loop-runtime-context-20260927\README.md',
  'patch\agent-loop-runtime-context-20260927\README.zh.md',
  'patch\agent-team-mailbox-scan-20260927\README.md',
  'patch\agent-team-mailbox-scan-20260927\README.zh.md',
  'patch\live-history-api-controller-20260927\README.md',
  'patch\live-history-api-controller-20260927\README.zh.md',
  'patch\session-query-live-title-20260927\README.md',
  'patch\session-query-live-title-20260927\README.zh.md',
  'patch\session-title-live-title-20260927\README.md',
  'patch\session-title-live-title-20260927\README.zh.md'
)

foreach ($rel in $restore) {
  $row = $log | Where-Object { $_.src -eq $rel -and $_.result -eq '已移动' } | Select-Object -First 1
  if (-not $row) { "未在日志中找到已移动记录：$rel"; continue }
  $orig = Join-Path $base $rel
  if (Test-Path -LiteralPath $orig) { "跳过（原位置已有文件）：$rel"; continue }
  if (-not (Test-Path -LiteralPath $row.dst)) { "跳过（归档文件不存在）：$rel"; continue }
  if ($Execute) {
    New-Item -ItemType Directory -Force -Path (Split-Path $orig) | Out-Null
    Move-Item -LiteralPath $row.dst -Destination $orig
    $row.result = '已还原'
    "已还原：$rel"
  } else {
    "待还原（演示）：$rel"
  }
}

if ($Execute) {
  $log | Export-Csv -LiteralPath $logPath -NoTypeInformation -Encoding UTF8
  "日志已更新：$logPath"
}
