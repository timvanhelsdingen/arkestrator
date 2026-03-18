param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$UnityProjectPath,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceBridgeDir = Join-Path $repoRoot "bridges\unity\ArkestratorBridge"

if (-not (Test-Path -LiteralPath $sourceBridgeDir -PathType Container)) {
    throw "Unity bridge source not found: $sourceBridgeDir"
}

$projectRoot = (Resolve-Path -LiteralPath $UnityProjectPath).Path
$assetsDir = Join-Path $projectRoot "Assets"

if (-not (Test-Path -LiteralPath $assetsDir -PathType Container)) {
    throw "Unity project is missing Assets folder: $assetsDir"
}

$targetBridgeDir = Join-Path $assetsDir "ArkestratorBridge"

if (Test-Path -LiteralPath $targetBridgeDir) {
    if (-not $Force) {
        throw "Target already exists: $targetBridgeDir`nRe-run with -Force to replace it."
    }

    Remove-Item -LiteralPath $targetBridgeDir -Recurse -Force
}

New-Item -ItemType Directory -Path $targetBridgeDir -Force | Out-Null
Copy-Item -LiteralPath "$sourceBridgeDir\*" -Destination $targetBridgeDir -Recurse -Force

Write-Host "Unity bridge installed to: $targetBridgeDir"
Write-Host "Next steps:"
Write-Host "1. Open the Unity project and let scripts compile."
Write-Host "2. Ensure ~/.arkestrator/config.json exists (log in via Arkestrator client once)."
Write-Host "3. In Unity, use Arkestrator > Connect (or wait for auto-connect)."
