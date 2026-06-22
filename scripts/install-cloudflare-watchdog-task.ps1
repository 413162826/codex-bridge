<#
.SYNOPSIS
  安装 codex-bridge 的 Cloudflare Tunnel watchdog 计划任务。

.DESCRIPTION
  watchdog 不嵌入 cloudflared 服务内部，而是作为独立 Windows 计划任务运行。
  它会定时检查公网首页与移动端 API 探针；发现本地 Bridge 健康但公网不可用时重启 cloudflared 服务。
#>
[CmdletBinding()]
param(
  [string] $TaskName = 'CodexBridge-Cloudflared-Watchdog',
  [string] $TunnelName = 'codex-bridge',
  [string] $Hostname = 'bridge.kevinsu.xyz',
  [string] $ServiceName = 'cloudflared',
  [string] $ProbeUrl = 'https://bridge.kevinsu.xyz/m/index.html',
  [string] $ApiProbeUrl = '',
  [string] $LocalProbeUrl = 'http://127.0.0.1:4555/m/index.html',
  [string] $LocalApiProbeUrl = 'http://127.0.0.1:4555/api/health',
  [string] $BridgeWorkingDirectory = '',
  [int] $IntervalMinutes = 1,
  [switch] $RunAsSystem
)

$ErrorActionPreference = 'Stop'

function Fail($Message) { Write-Host "X $Message" -ForegroundColor Red; exit 1 }
function Ok($Message) { Write-Host "OK $Message" -ForegroundColor Green }
function Info($Message) { Write-Host "- $Message" -ForegroundColor Cyan }

if ($IntervalMinutes -lt 1) {
  Fail 'IntervalMinutes must be greater than or equal to 1.'
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) {
  Fail 'Administrator permission is required to install the scheduled task.'
}

$scriptPath = Join-Path $PSScriptRoot 'watch-cloudflare-tunnel.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) {
  Fail "Watchdog script not found: $scriptPath"
}

if (-not $BridgeWorkingDirectory) {
  $BridgeWorkingDirectory = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
}

$powerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$arguments = @(
  '-NoProfile',
  '-NonInteractive',
  '-WindowStyle', 'Hidden',
  '-ExecutionPolicy', 'Bypass',
  '-File', "`"$scriptPath`"",
  '-TunnelName', "`"$TunnelName`"",
  '-Hostname', "`"$Hostname`"",
  '-ServiceName', "`"$ServiceName`"",
  '-ProbeUrl', "`"$ProbeUrl`"",
  '-ApiProbeUrl', "`"$ApiProbeUrl`"",
  '-LocalProbeUrl', "`"$LocalProbeUrl`"",
  '-LocalApiProbeUrl', "`"$LocalApiProbeUrl`"",
  '-BridgeWorkingDirectory', "`"$BridgeWorkingDirectory`""
) -join ' '

$action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
if ($RunAsSystem) {
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
} else {
  $runAsUser = "$env:USERDOMAIN\$env:USERNAME"
  $principal = New-ScheduledTaskPrincipal -UserId $runAsUser -LogonType Interactive -RunLevel Highest
}
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 3) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Info "Register scheduled task: $TaskName"
Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description 'Monitor codex-bridge origin and Cloudflare Tunnel; restart the right layer when public access fails.' `
  -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Ok "Installed and triggered: $TaskName"
Write-Host "  Log: C:\ProgramData\codex-bridge\cloudflared-watchdog.log" -ForegroundColor Green
