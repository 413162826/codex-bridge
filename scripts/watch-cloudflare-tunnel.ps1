<#
.SYNOPSIS
  监控 codex-bridge 的公网入口与移动端 API 可用性，并在本地 origin 健康但公网不可用时重启 cloudflared。
#>
[CmdletBinding()]
param(
  [string] $TunnelName = 'codex-bridge',
  [string] $Hostname = 'bridge.kevinsu.xyz',
  [string] $ServiceName = 'cloudflared',
  [string] $ProbeUrl = 'https://bridge.kevinsu.xyz/m/index.html',
  [string] $ApiProbeUrl = '',
  [string] $LocalProbeUrl = 'http://127.0.0.1:4555/m/index.html',
  [string] $LocalApiProbeUrl = 'http://127.0.0.1:4555/api/health',
  [string] $BridgeWorkingDirectory = '',
  [string] $BridgeEntry = 'src/server.js',
  [int] $MinConnections = 1,
  [int] $RestartCooldownSeconds = 90,
  [int] $ProbeTimeoutSeconds = 20,
  [string] $LogPath = 'C:\ProgramData\codex-bridge\cloudflared-watchdog.log',
  [string] $StatePath = 'C:\ProgramData\codex-bridge\cloudflared-watchdog-state.json'
)

$ErrorActionPreference = 'Stop'

if (-not $BridgeWorkingDirectory) {
  $BridgeWorkingDirectory = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
}
if (-not $ApiProbeUrl) {
  $ApiProbeUrl = "https://$Hostname/api/mobile/bootstrap"
}
$BridgePidPath = Join-Path $BridgeWorkingDirectory '.tmp-codex-bridge.pid'
$BridgeOutLogPath = Join-Path $BridgeWorkingDirectory '.tmp-codex-bridge.out.log'
$BridgeErrLogPath = Join-Path $BridgeWorkingDirectory '.tmp-codex-bridge.err.log'

function Ensure-ParentDirectory($Path) {
  $parent = Split-Path -Parent $Path
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
}

function Write-Log($Level, $Message) {
  Ensure-ParentDirectory $LogPath
  $line = '{0} [{1}] {2}' -f (Get-Date -Format o), $Level, $Message
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::AppendAllText($LogPath, $line + [Environment]::NewLine, $encoding)
}

function Read-State {
  if (-not (Test-Path -LiteralPath $StatePath)) {
    return [pscustomobject]@{ lastRestartAt = $null }
  }

  try {
    return Get-Content -Raw -Encoding UTF8 -LiteralPath $StatePath | ConvertFrom-Json
  } catch {
    Write-Log 'WARN' "State file read failed; recreating. error=$($_.Exception.Message)"
    return [pscustomobject]@{ lastRestartAt = $null }
  }
}

function Write-State($State) {
  Ensure-ParentDirectory $StatePath
  $json = $State | ConvertTo-Json -Depth 4
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($StatePath, $json, $encoding)
}

function Get-CloudflaredPath {
  $service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction Stop
  if ($service.PathName -match '^"([^"]+)"') {
    return $Matches[1]
  }
  if ($service.PathName -match '^([^\s]+\.exe)') {
    return $Matches[1]
  }

  $command = Get-Command cloudflared -ErrorAction Stop
  return $command.Source
}

function Get-TunnelConnectionStatus($CloudflaredPath) {
  $errorFile = Join-Path ([System.IO.Path]::GetTempPath()) ('cloudflared-watchdog-{0}.err' -f ([guid]::NewGuid().ToString('N')))
  try {
    $output = & $CloudflaredPath tunnel list --output json 2>$errorFile
    $exitCode = $LASTEXITCODE
    $stderr = ''
    if (Test-Path -LiteralPath $errorFile) {
      $stderr = Get-Content -Raw -Encoding UTF8 -LiteralPath $errorFile
    }
    if ($exitCode -ne 0) {
      throw "cloudflared tunnel list exit=$exitCode $stderr"
    }

    $rawJson = ($output | Out-String).Trim()
    $start = $rawJson.IndexOf('[')
    $end = $rawJson.LastIndexOf(']')
    if ($start -lt 0 -or $end -le $start) {
      throw "cloudflared tunnel list did not return a JSON array. output=$rawJson"
    }
    $json = $rawJson.Substring($start, $end - $start + 1)
    $tunnels = $json | ConvertFrom-Json
    $tunnel = $tunnels | Where-Object { $_.name -eq $TunnelName -or $_.id -eq $TunnelName } | Select-Object -First 1
    if (-not $tunnel) {
      return [pscustomobject]@{ known = $true; count = 0; detail = "tunnel not found: $TunnelName" }
    }

    $connections = @($tunnel.connections | Where-Object { -not $_.is_pending_reconnect })
    return [pscustomobject]@{ known = $true; count = $connections.Count; detail = "active connections=$($connections.Count)" }
  } catch {
    return [pscustomobject]@{ known = $false; count = 0; detail = $_.Exception.Message }
  } finally {
    Remove-Item -LiteralPath $errorFile -Force -ErrorAction SilentlyContinue
  }
}

function Test-IsCloudflareTunnel1033($Body, $StatusCode) {
  if ($StatusCode -eq 530) {
    return $true
  }

  $text = [string]$Body
  if ([string]::IsNullOrWhiteSpace($text)) {
    return $false
  }

  $lower = $text.ToLowerInvariant()
  return ($lower.Contains('cloudflare tunnel error')) `
    -or ($lower.Contains('error code') -and $lower.Contains('1033')) `
    -or ($lower.Contains('error_code') -and $lower.Contains('1033'))
}

function Test-HttpProbe {
  param(
    [string] $Url,
    [int[]] $ExpectedStatusCodes = @()
  )

  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  } catch {
  }

  try {

    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $ProbeTimeoutSeconds -MaximumRedirection 5
    $statusCode = [int]$response.StatusCode
    $body = [string]$response.Content

    $is1033 = Test-IsCloudflareTunnel1033 $body $statusCode
    if ($ExpectedStatusCodes.Count -gt 0) {
      $ok = ($ExpectedStatusCodes -contains $statusCode) -and -not $is1033
    } else {
      $ok = $statusCode -ge 200 -and $statusCode -lt 500 -and -not $is1033
    }
    return [pscustomobject]@{ ok = $ok; statusCode = $statusCode; is1033 = $is1033; detail = "status=$statusCode" }
  } catch {
    $statusCode = 0
    $body = ''
    if ($_.Exception.Response) {
      try {
        $statusCode = [int]$_.Exception.Response.StatusCode
        $stream = $_.Exception.Response.GetResponseStream()
        if ($stream) {
          $reader = New-Object System.IO.StreamReader($stream)
          try {
            $body = $reader.ReadToEnd()
          } finally {
            $reader.Dispose()
          }
        }
      } catch {
        $body = ''
      }
    }

    $is1033 = Test-IsCloudflareTunnel1033 $body $statusCode
    if ($ExpectedStatusCodes.Count -gt 0) {
      $ok = ($ExpectedStatusCodes -contains $statusCode) -and -not $is1033
    } else {
      $ok = $statusCode -ge 200 -and $statusCode -lt 500 -and -not $is1033
    }
    $detail = "status=$statusCode"
    if (-not $ok) {
      $detail = "status=$statusCode error=$($_.Exception.Message)"
    }
    return [pscustomobject]@{ ok = $ok; statusCode = $statusCode; is1033 = $is1033; detail = $detail }
  }
}

function Format-ProbeResults($ProbeResults) {
  $parts = @()
  foreach ($probe in $ProbeResults) {
    $status = 'failed'
    if ($probe.result.ok) {
      $status = 'ok'
    }
    $parts += ('{0}={1}({2})' -f $probe.name, $status, $probe.result.detail)
  }
  return ($parts -join '; ')
}

function Test-PublicAvailability {
  $results = @(
    [pscustomobject]@{ name = 'page'; result = (Test-HttpProbe -Url $ProbeUrl -ExpectedStatusCodes @(200)) },
    [pscustomobject]@{ name = 'mobile-api'; result = (Test-HttpProbe -Url $ApiProbeUrl -ExpectedStatusCodes @(200, 401, 403)) }
  )
  $failed = @($results | Where-Object { -not $_.result.ok })
  $has1033 = [bool]($results | Where-Object { $_.result.is1033 } | Select-Object -First 1)
  return [pscustomobject]@{
    ok = $failed.Count -eq 0
    failed = $failed
    has1033 = $has1033
    results = $results
    detail = Format-ProbeResults $results
  }
}

function Test-LocalOriginAvailability {
  $results = @(
    [pscustomobject]@{ name = 'local-page'; result = (Test-HttpProbe -Url $LocalProbeUrl -ExpectedStatusCodes @(200)) },
    [pscustomobject]@{ name = 'local-api'; result = (Test-HttpProbe -Url $LocalApiProbeUrl -ExpectedStatusCodes @(200)) }
  )
  $failed = @($results | Where-Object { -not $_.result.ok })
  return [pscustomobject]@{
    ok = $failed.Count -eq 0
    failed = $failed
    results = $results
    detail = Format-ProbeResults $results
  }
}

function Get-BridgePid {
  if (-not (Test-Path -LiteralPath $BridgePidPath)) {
    return $null
  }

  $raw = (Get-Content -Raw -Encoding UTF8 -LiteralPath $BridgePidPath).Trim()
  if ($raw -match '^\d+$') {
    return [int]$raw
  }

  return $null
}

function Test-ProcessAlive($ProcessId) {
  if (-not $ProcessId) {
    return $false
  }
  return [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Start-BridgeOrigin($Reason) {
  $currentPid = Get-BridgePid
  if (Test-ProcessAlive $currentPid) {
    Write-Log 'WARN' "Bridge process already exists but local probe failed. pid=$currentPid reason=$Reason"
    return
  }

  Write-Log 'WARN' "Starting bridge origin. reason=$Reason cwd=$BridgeWorkingDirectory entry=$BridgeEntry"
  $process = Start-Process `
    -FilePath 'node' `
    -ArgumentList $BridgeEntry `
    -WorkingDirectory $BridgeWorkingDirectory `
    -RedirectStandardOutput $BridgeOutLogPath `
    -RedirectStandardError $BridgeErrLogPath `
    -WindowStyle Hidden `
    -PassThru

  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($BridgePidPath, [string]$process.Id, $encoding)
  Start-Sleep -Seconds 4
  Write-Log 'INFO' "Bridge origin start attempted. pid=$($process.Id)"
}

function Ensure-BridgeOrigin($Reason) {
  $localProbe = Test-LocalOriginAvailability
  if ($localProbe.ok) {
    return [pscustomobject]@{ ok = $true; detail = "local probes $($localProbe.detail)" }
  }

  Start-BridgeOrigin "local probes failed: $($localProbe.detail); $Reason"
  $retry = Test-LocalOriginAvailability
  return [pscustomobject]@{ ok = $retry.ok; detail = "local retry $($retry.detail)" }
}

function Restart-Cloudflared($Reason) {
  $state = Read-State
  if ($state.lastRestartAt) {
    $lastRestart = [datetime]$state.lastRestartAt
    $secondsSinceRestart = ((Get-Date) - $lastRestart).TotalSeconds
    if ($secondsSinceRestart -lt $RestartCooldownSeconds) {
      Write-Log 'WARN' "Restart skipped due to cooldown: $([int]$secondsSinceRestart)s / $RestartCooldownSeconds s. reason=$Reason"
      return
    }
  }

  Write-Log 'WARN' "Restarting service $ServiceName. reason=$Reason"
  Restart-Service -Name $ServiceName -Force -ErrorAction Stop
  Start-Sleep -Seconds 8
  $state.lastRestartAt = (Get-Date).ToUniversalTime().ToString('o')
  Write-State $state
  $service = Get-Service -Name $ServiceName -ErrorAction Stop
  Write-Log 'INFO' "Service restart finished: $ServiceName status=$($service.Status)"
}

try {
  Write-Log 'INFO' "watchdog start tunnel=$TunnelName hostname=$Hostname probe=$ProbeUrl apiProbe=$ApiProbeUrl"

  $service = Get-Service -Name $ServiceName -ErrorAction Stop
  if ($service.Status -ne 'Running') {
    Write-Log 'WARN' "Service is not running; starting $ServiceName status=$($service.Status)"
    Start-Service -Name $ServiceName -ErrorAction Stop
    Start-Sleep -Seconds 8
  }

  $public = Test-PublicAvailability

  if ($public.ok) {
    Write-Log 'INFO' "Healthy: public probes $($public.detail)"
    exit 0
  }

  $origin = Ensure-BridgeOrigin "public availability failed: $($public.detail)"
  if (-not $origin.ok) {
    Write-Log 'ERROR' "Bridge origin still unhealthy after start attempt. public=$($public.detail); $($origin.detail)"
    exit 0
  }

  $retryPublic = Test-PublicAvailability
  if ($retryPublic.ok) {
    Write-Log 'INFO' "Recovered after origin check. public retry $($retryPublic.detail); $($origin.detail)"
    exit 0
  }

  Restart-Cloudflared "public availability failed while bridge origin is healthy. public=$($retryPublic.detail); $($origin.detail)"
  exit 0
} catch {
  Write-Log 'ERROR' $_.Exception.Message
  throw
}
