[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$nsisUrl = "https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip"
$nsisSha1 = "EF7FF767E5CBD9EDD22ADD3A32C9B8F4500BB10D"
$nsisUtilsUrl = "https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll"
$nsisUtilsSha1 = "75197FEE3C6A814FE035788D1C34EAD39349B860"
$wixUrl = "https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip"
$wixSha256 = "6AC824E1642D6F7277D0ED7EA09411A508F6116BA6FAE0AA5F2C7DAA2FF43D31"

$tauriToolsDirectory = Join-Path $env:LOCALAPPDATA "tauri"
$nsisDirectory = Join-Path $tauriToolsDirectory "NSIS"
$wixDirectory = Join-Path $tauriToolsDirectory "WixTools314"
$downloadDirectory = Join-Path $env:RUNNER_TEMP "tauri-bundler-tools"

$nsisRequiredFiles = @(
  "makensis.exe",
  "Bin/makensis.exe",
  "Stubs/lzma-x86-unicode",
  "Stubs/lzma_solid-x86-unicode",
  "Include/MUI2.nsh",
  "Include/FileFunc.nsh",
  "Include/x64.nsh",
  "Include/nsDialogs.nsh",
  "Include/WinMessages.nsh",
  "Include/Win/COM.nsh",
  "Include/Win/Propkey.nsh",
  "Include/Win/RestartManager.nsh",
  "Plugins/x86-unicode/additional/nsis_tauri_utils.dll"
)

$wixRequiredFiles = @(
  "candle.exe",
  "candle.exe.config",
  "darice.cub",
  "light.exe",
  "light.exe.config",
  "wconsole.dll",
  "winterop.dll",
  "wix.dll",
  "WixUIExtension.dll",
  "WixUtilExtension.dll"
)

function Get-FileWithRetry {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$Destination,
    [int]$Attempts = 6
  )

  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    try {
      if (Test-Path $Destination) {
        Remove-Item -Path $Destination -Force
      }
      Write-Host "Downloading $Uri (attempt $attempt/$Attempts)"
      Invoke-WebRequest -Uri $Uri -OutFile $Destination -MaximumRedirection 10 -TimeoutSec 300
      return
    } catch {
      if ($attempt -eq $Attempts) {
        throw
      }
      $delay = [Math]::Min(10 * $attempt, 45)
      Write-Warning "Download failed: $($_.Exception.Message). Retrying in $delay seconds."
      Start-Sleep -Seconds $delay
    }
  }
}

function Assert-ExpectedHash {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][ValidateSet("SHA1", "SHA256")][string]$Algorithm,
    [Parameter(Mandatory = $true)][string]$Expected
  )

  $actual = (Get-FileHash -Path $Path -Algorithm $Algorithm).Hash.ToUpperInvariant()
  if ($actual -ne $Expected.ToUpperInvariant()) {
    throw "Hash mismatch for $Path. Expected $Expected, received $actual."
  }
}

function Test-RequiredFiles {
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][string[]]$RequiredFiles
  )

  if (-not (Test-Path $Directory -PathType Container)) {
    return $false
  }
  foreach ($relativePath in $RequiredFiles) {
    if (-not (Test-Path (Join-Path $Directory $relativePath) -PathType Leaf)) {
      return $false
    }
  }
  return $true
}

function Test-NsisCache {
  param([Parameter(Mandatory = $true)][string]$Directory)

  if (-not (Test-RequiredFiles -Directory $Directory -RequiredFiles $nsisRequiredFiles)) {
    return $false
  }
  $utilsPath = Join-Path $Directory "Plugins/x86-unicode/additional/nsis_tauri_utils.dll"
  return (Get-FileHash -Path $utilsPath -Algorithm SHA1).Hash -eq $nsisUtilsSha1
}

New-Item -ItemType Directory -Path $tauriToolsDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $downloadDirectory -Force | Out-Null

if (Test-NsisCache -Directory $nsisDirectory) {
  Write-Host "Tauri NSIS cache is ready."
} else {
  $nsisArchive = Join-Path $downloadDirectory "nsis-3.11.zip"
  $nsisUtils = Join-Path $downloadDirectory "nsis_tauri_utils.dll"
  $nsisExtractDirectory = Join-Path $downloadDirectory "nsis-extracted"
  $nsisStagingDirectory = "$nsisDirectory.staging"

  Get-FileWithRetry -Uri $nsisUrl -Destination $nsisArchive
  Assert-ExpectedHash -Path $nsisArchive -Algorithm SHA1 -Expected $nsisSha1
  Get-FileWithRetry -Uri $nsisUtilsUrl -Destination $nsisUtils
  Assert-ExpectedHash -Path $nsisUtils -Algorithm SHA1 -Expected $nsisUtilsSha1

  Remove-Item -Path $nsisExtractDirectory -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -Path $nsisStagingDirectory -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -Path $nsisArchive -DestinationPath $nsisExtractDirectory -Force
  Move-Item -Path (Join-Path $nsisExtractDirectory "nsis-3.11") -Destination $nsisStagingDirectory

  $utilsDestination = Join-Path $nsisStagingDirectory "Plugins/x86-unicode/additional"
  New-Item -ItemType Directory -Path $utilsDestination -Force | Out-Null
  Copy-Item -Path $nsisUtils -Destination (Join-Path $utilsDestination "nsis_tauri_utils.dll") -Force

  if (-not (Test-NsisCache -Directory $nsisStagingDirectory)) {
    throw "The prepared NSIS toolchain is incomplete."
  }
  Remove-Item -Path $nsisDirectory -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item -Path $nsisStagingDirectory -Destination $nsisDirectory
  Write-Host "Tauri NSIS cache prepared successfully."
}

if (Test-RequiredFiles -Directory $wixDirectory -RequiredFiles $wixRequiredFiles) {
  Write-Host "Tauri WiX cache is ready."
} else {
  $wixArchive = Join-Path $downloadDirectory "wix314-binaries.zip"
  $wixStagingDirectory = "$wixDirectory.staging"

  Get-FileWithRetry -Uri $wixUrl -Destination $wixArchive
  Assert-ExpectedHash -Path $wixArchive -Algorithm SHA256 -Expected $wixSha256

  Remove-Item -Path $wixStagingDirectory -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $wixStagingDirectory -Force | Out-Null
  Expand-Archive -Path $wixArchive -DestinationPath $wixStagingDirectory -Force

  if (-not (Test-RequiredFiles -Directory $wixStagingDirectory -RequiredFiles $wixRequiredFiles)) {
    throw "The prepared WiX toolchain is incomplete."
  }
  Remove-Item -Path $wixDirectory -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item -Path $wixStagingDirectory -Destination $wixDirectory
  Write-Host "Tauri WiX cache prepared successfully."
}
