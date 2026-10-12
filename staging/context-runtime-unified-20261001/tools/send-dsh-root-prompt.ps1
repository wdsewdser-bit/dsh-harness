param(
  [Parameter(Mandatory = $true)]
  [string]$MessagePath,
  [string]$Authority = '127.0.0.1:40123',
  [string]$SessionId = 'session-028e6f5b-1716-4c23-a232-af16d853d191',
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'

function ConvertTo-Base64Url {
  param([byte[]]$Bytes)
  [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

$credentialsPath = 'D:\dsh-test\home\.credentials.yaml'
$credentials = Get-Content -Raw -LiteralPath $credentialsPath
$secretMatch = [regex]::Match(
  $credentials,
  '(?ms)^\s*client-connection/browser-session:\s*\r?\n\s+kind:\s+grant\s*\r?\n\s+payload:\s*\r?\n\s+version:\s+1\s*\r?\n\s+secret:\s*([A-Za-z0-9_-]+)'
)
if (-not $secretMatch.Success) {
  throw 'client-connection/browser-session secret was not found'
}

$secret = $secretMatch.Groups[1].Value.Replace('-', '+').Replace('_', '/')
while ($secret.Length % 4) {
  $secret += '='
}
$secretBytes = [Convert]::FromBase64String($secret)

$sha = [Security.Cryptography.SHA256]::Create()
$cookieName = 'dsh-auth-' + (ConvertTo-Base64Url ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Authority))))
$issuedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$payload = [ordered]@{
  version = 1
  authority = $Authority
  issuedAt = $issuedAt
  expiresAt = $issuedAt + 3600000
} | ConvertTo-Json -Compress
$body = ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($payload))

$hmac = [Security.Cryptography.HMACSHA256]::new($secretBytes)
$signature = ConvertTo-Base64Url ($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($body)))
$cookie = "$cookieName=v1.$body.$signature"

$rpcId = [guid]::NewGuid().ToString()
$requestId = [guid]::NewGuid().ToString()
$text = Get-Content -Raw -LiteralPath $MessagePath
$message = [ordered]@{
  type = 'client-request'
  rpcId = $rpcId
  method = 'session/prompt'
  payload = [ordered]@{
    args = [ordered]@{
      request = [ordered]@{
        requestId = $requestId
        sessionId = $SessionId
        mode = 'queue'
        content = @(
          [ordered]@{
            type = 'text'
            text = $text
          }
        )
        clientTimeZone = 'Asia/Shanghai'
      }
    }
  }
} | ConvertTo-Json -Depth 20 -Compress

$bodyPath = Join-Path ([IO.Path]::GetTempPath()) ('dsh-root-prompt-' + [guid]::NewGuid().ToString('N') + '.json')
$responsePath = Join-Path ([IO.Path]::GetTempPath()) ('dsh-root-prompt-response-' + [guid]::NewGuid().ToString('N') + '.json')
try {
  [IO.File]::WriteAllText($bodyPath, $message, [Text.UTF8Encoding]::new($false))
  Write-Host '[send-dsh-root-prompt] request-body-ready'
  $httpCode = & curl.exe --silent --show-error --max-time $TimeoutSeconds --max-filesize 1048576 --output $responsePath --write-out '%{http_code}' `
    -H "Cookie: $cookie" -H 'Content-Type: application/json' --data-binary "@$bodyPath" `
    "http://$Authority/api/session/prompt"
  $curlExit = $LASTEXITCODE
  Write-Host "[send-dsh-root-prompt] curl-finished exit=$curlExit code=$httpCode"
  $responseLength = if (Test-Path -LiteralPath $responsePath) { (Get-Item -LiteralPath $responsePath).Length } else { 0 }
  $response = if ($responseLength -gt 0 -and $responseLength -le 1048576) {
    Get-Content -Raw -LiteralPath $responsePath | ConvertFrom-Json
  } else {
    $null
  }
  [pscustomobject]@{
    CurlExit = $curlExit
    HttpCode = $httpCode
    ResponseBytes = $responseLength
    RpcIdMatch = $response -ne $null -and $response.rpcId -eq $rpcId
    Ok = $response.result.ok
    Accepted = $response.result.value.accepted
    ErrorCode = $response.result.error.code
    ErrorMessage = $response.result.error.message
  } | Format-List
} finally {
  Remove-Item -LiteralPath $bodyPath,$responsePath -Force -ErrorAction SilentlyContinue
  $hmac.Dispose()
  $sha.Dispose()
}
