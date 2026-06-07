<#
.SYNOPSIS
  为 codex-bridge 配置 Cloudflare 命名隧道（named tunnel），把公网域名转发到本机 127.0.0.1:<port>。

.DESCRIPTION
  前置条件：
    1) 域名已加入 Cloudflare，且在域名注册商处把 NS 改成 Cloudflare 分配的两条、已激活。
    2) 已执行 `cloudflared tunnel login` 完成浏览器授权（会在 ~/.cloudflared 生成 cert.pem）。
  脚本动作：建或复用命名隧道 -> 写 config.yml -> 绑定 DNS 路由。
  加 -InstallService 时再把它装成开机自启的 Windows 服务（需管理员）。

.EXAMPLE
  .\scripts\setup-cloudflare-tunnel.ps1 -Hostname bridge.kevinsu.xyz
  # 测通后，管理员 PowerShell：
  .\scripts\setup-cloudflare-tunnel.ps1 -Hostname bridge.kevinsu.xyz -InstallService
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $Hostname,
  [string] $TunnelName = 'codex-bridge',
  [int] $LocalPort = 4555,
  [switch] $InstallService
)

$ErrorActionPreference = 'Stop'
$cfDir = Join-Path $env:USERPROFILE '.cloudflared'
$certPath = Join-Path $cfDir 'cert.pem'
$configPath = Join-Path $cfDir 'config.yml'

function Fail($msg) { Write-Host "X $msg" -ForegroundColor Red; exit 1 }
function Info($msg) { Write-Host "- $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "OK $msg" -ForegroundColor Green }

if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  Fail "未找到 cloudflared，请先安装：winget install --id Cloudflare.cloudflared --source winget"
}

if (-not (Test-Path $certPath)) {
  Fail "缺少 $certPath。请先完成浏览器授权： cloudflared tunnel login （登录时选择 $Hostname 所属的域名）"
}
Ok "已检测到 Cloudflare 授权凭证 cert.pem"

# 建或复用命名隧道
$existing = (cloudflared tunnel list --output json | ConvertFrom-Json) | Where-Object { $_.name -eq $TunnelName }
if ($existing) {
  $tunnelId = $existing.id
  Ok "复用已存在隧道 '$TunnelName' (UUID $tunnelId)"
} else {
  Info "创建命名隧道 '$TunnelName' ..."
  cloudflared tunnel create $TunnelName | Out-Host
  $created = (cloudflared tunnel list --output json | ConvertFrom-Json) | Where-Object { $_.name -eq $TunnelName }
  if (-not $created) { Fail "创建后仍找不到隧道 '$TunnelName'" }
  $tunnelId = $created.id
  Ok "已创建隧道 '$TunnelName' (UUID $tunnelId)"
}

$credPath = Join-Path $cfDir "$tunnelId.json"
if (-not (Test-Path $credPath)) { Fail "找不到隧道凭证文件 $credPath" }

# 写 config.yml
$config = @"
tunnel: $tunnelId
credentials-file: $credPath
ingress:
  - hostname: $Hostname
    service: http://localhost:$LocalPort
    originRequest:
      connectTimeout: 30s
  - service: http_status:404
"@
Set-Content -Path $configPath -Value $config -Encoding UTF8
Ok "已写入 $configPath  ($Hostname -> http://localhost:$LocalPort)"

# 绑定 DNS 路由（需要 zone 已激活）
Info "绑定 DNS：$Hostname -> $tunnelId.cfargotunnel.com ..."
try {
  cloudflared tunnel route dns $TunnelName $Hostname | Out-Host
  Ok "DNS 路由已绑定"
} catch {
  Write-Host "! DNS 路由失败：$($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host "  多半是域名 NS 还没迁到 Cloudflare 或 zone 未激活。等激活后重跑本脚本即可。" -ForegroundColor Yellow
}

# 可选：装成开机服务
if ($InstallService) {
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
  if (-not $isAdmin) { Fail "-InstallService 需要管理员权限，请在“以管理员身份运行”的 PowerShell 里重跑。" }
  $sysDir = Join-Path $env:WINDIR 'System32\config\systemprofile\.cloudflared'
  New-Item -ItemType Directory -Force -Path $sysDir | Out-Null
  Copy-Item $certPath, $credPath, $configPath -Destination $sysDir -Force
  cloudflared service install | Out-Host
  Start-Service cloudflared -ErrorAction SilentlyContinue
  Ok "已安装并启动 cloudflared 服务（开机自启）。配置副本：$sysDir"
}

Write-Host ""
Ok "完成。前台测试： cloudflared tunnel run $TunnelName"
Write-Host "  然后访问： https://$Hostname/api/health" -ForegroundColor Green
