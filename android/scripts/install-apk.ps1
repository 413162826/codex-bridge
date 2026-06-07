param(
  [string]$Serial = '',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$env:ANDROID_SDK_ROOT = $sdk
$env:ANDROID_HOME = $sdk

$adb = Join-Path $sdk 'platform-tools\adb.exe'
if (-not (Test-Path -LiteralPath $adb)) {
  $adbCommand = Get-Command adb -ErrorAction SilentlyContinue
  if (-not $adbCommand) {
    throw "未找到 adb。请确认 Android SDK platform-tools 已安装：$adb"
  }
  $adb = $adbCommand.Source
}

Push-Location $root
try {
  if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot 'build-apk.ps1')
  }

  $apk = Join-Path $root 'codex-bridge.apk'
  if (-not (Test-Path -LiteralPath $apk)) {
    throw "APK 不存在：$apk"
  }

  $deviceLines = & $adb devices | Select-Object -Skip 1 | Where-Object { $_.Trim() -ne '' }
  $devices = @()
  foreach ($line in $deviceLines) {
    $parts = $line -split '\s+'
    if ($parts.Count -ge 2 -and $parts[1] -eq 'device') {
      $devices += $parts[0]
    }
  }

  if ($devices.Count -eq 0) {
    throw "未发现可用 Android 设备。请连接手机、打开 USB 调试，并在手机上允许此电脑调试。"
  }

  if ($Serial) {
    if ($devices -notcontains $Serial) {
      throw "指定设备 $Serial 不在可用设备列表中：$($devices -join ', ')"
    }
    $targetArgs = @('-s', $Serial)
  } elseif ($devices.Count -eq 1) {
    $targetArgs = @('-s', $devices[0])
  } else {
    throw "发现多个设备，请用 -Serial 指定其中一个：$($devices -join ', ')"
  }

  & $adb @targetArgs install -r $apk
  if ($LASTEXITCODE -ne 0) {
    throw "APK 安装失败，adb exit code: $LASTEXITCODE"
  }

  & $adb @targetArgs shell monkey -p cn.jollybaby.codexbridgequicktest -c android.intent.category.LAUNCHER 1 | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "启动 App 失败，adb exit code: $LASTEXITCODE"
  }

  Write-Host "已安装并启动 Codex Bridge Android：$apk"
}
finally {
  Pop-Location
}
