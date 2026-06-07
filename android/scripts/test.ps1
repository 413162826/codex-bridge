$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$env:ANDROID_SDK_ROOT = $sdk
$env:ANDROID_HOME = $sdk

Push-Location $root
try {
  .\gradlew.bat testDebugUnitTest
}
finally {
  Pop-Location
}
