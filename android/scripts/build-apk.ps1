$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$env:ANDROID_SDK_ROOT = $sdk
$env:ANDROID_HOME = $sdk

Push-Location $root
try {
  .\gradlew.bat assembleDebug
  $source = Join-Path $root 'app\build\outputs\apk\debug\app-debug.apk'
  $target = Join-Path $root 'codex-bridge.apk'
  Copy-Item -LiteralPath $source -Destination $target -Force
  Copy-Item -LiteralPath $source -Destination (Join-Path $root 'codex-bridge-test.apk') -Force
  $publicRoot = Join-Path (Split-Path -Parent $root) 'public'
  if (Test-Path -LiteralPath $publicRoot) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $publicRoot 'codex-bridge.apk') -Force
    Copy-Item -LiteralPath $source -Destination (Join-Path $publicRoot 'codex-bridge-test.apk') -Force
  }
  Write-Host "APK: $target"
}
finally {
  Pop-Location
}
