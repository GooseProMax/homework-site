# Download Deno into the project's .tools folder (no admin rights, no .NET class loading).
#
#   powershell -ExecutionPolicy Bypass -File scripts\get-deno.ps1
#
# Uses curl.exe (bundled with Windows 10/11) with retries and resume support,
# falls back to Invoke-WebRequest, and verifies the zip is complete before extracting.
# This file is intentionally ASCII-only: Windows PowerShell 5.1 reads BOM-less files
# as GBK, which corrupts non-ASCII text and breaks parsing.

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$root   = Split-Path -Parent $PSScriptRoot
$tools  = Join-Path $root '.tools'
$zip    = Join-Path $tools 'deno.zip'
$binDir = Join-Path $tools 'bin'
$exe    = Join-Path $binDir 'deno.exe'

New-Item -ItemType Directory -Force -Path $tools, $binDir | Out-Null

if (Test-Path $exe) {
    Write-Host "Deno is already installed:" -ForegroundColor Green
    & $exe --version
    exit 0
}

function Get-ZipStatus {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $false }
    $len = (Get-Item $Path).Length
    if ($len -lt 100000) { return $false }
    $fs = [System.IO.File]::OpenRead($Path)
    try {
        $tailLen = [Math]::Min(65536, $fs.Length)
        $fs.Seek($fs.Length - $tailLen, [System.IO.SeekOrigin]::Begin) | Out-Null
        $buffer = New-Object byte[] $tailLen
        [void]$fs.Read($buffer, 0, $tailLen)
        for ($i = $tailLen - 4; $i -ge 0; $i--) {
            if ($buffer[$i] -eq 0x50 -and $buffer[$i+1] -eq 0x4B -and $buffer[$i+2] -eq 0x05 -and $buffer[$i+3] -eq 0x06) {
                return $true
            }
        }
        return $false
    } finally {
        $fs.Close()
    }
}

function Get-RemoteVersion {
    try {
        $list = Invoke-RestMethod 'https://registry.npmmirror.com/-/binary/deno/' -TimeoutSec 30
        $versions = @()
        foreach ($item in $list) {
            $name = ([string]$item.name) -replace '^v', '' -replace '/$', ''
            if ($name -match '^\d+\.\d+\.\d+$') { $versions += $name }
        }
        if ($versions.Count -gt 0) {
            $sorted = $versions | Sort-Object { [version]$_ } -Descending
            return $sorted[0]
        }
    } catch {
        Write-Host "npmmirror lookup failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
    try {
        $rel = Invoke-RestMethod 'https://api.github.com/repos/denoland/deno/releases/latest' -Headers @{ 'User-Agent' = 'homework-site' } -TimeoutSec 30
        return ($rel.tag_name -replace '^v', '')
    } catch {
        Write-Host "GitHub lookup failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
    return '2.9.7'
}

function Invoke-Curl {
    param([string]$Url, [string]$Out)
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (-not (Test-Path $curl)) { $curl = 'curl.exe' }
    & $curl -L --fail --retry 4 --retry-all-errors --retry-delay 2 -C - `
        --connect-timeout 20 --max-time 900 `
        -o $Out -s -S $Url 2>&1 | Write-Host
    return ($LASTEXITCODE -eq 0)
}

function Invoke-Web {
    param([string]$Url, [string]$Out)
    try {
        Invoke-WebRequest -Uri $Url -OutFile $Out -TimeoutSec 900 -UseBasicParsing
        return $true
    } catch {
        Write-Host "  Invoke-WebRequest failed: $($_.Exception.Message)" -ForegroundColor Yellow
        return $false
    }
}

$version = Get-RemoteVersion
Write-Host "Installing Deno $version" -ForegroundColor Cyan

$sources = @(
    "https://registry.npmmirror.com/-/binary/deno/v$version/deno-x86_64-pc-windows-msvc.zip",
    "https://github.com/denoland/deno/releases/download/v$version/deno-x86_64-pc-windows-msvc.zip",
    "https://dl.deno.land/release/v$version/deno-x86_64-pc-windows-msvc.zip"
)

$ok = $false
foreach ($url in $sources) {
    Write-Host "Source: $url" -ForegroundColor Cyan
    for ($attempt = 1; $attempt -le 8; $attempt++) {
        if (Get-ZipStatus -Path $zip) { $ok = $true; break }

        $have = 0
        if (Test-Path $zip) { $have = (Get-Item $zip).Length }
        Write-Host ("  attempt {0}: already have {1:N1} MB, fetching ..." -f $attempt, ($have / 1MB))

        $done = Invoke-Curl -Url $url -Out $zip
        if (-not $done) { $done = Invoke-Web -Url $url -Out $zip }

        if (Get-ZipStatus -Path $zip) { $ok = $true; break }
        Write-Host "  still incomplete, retrying ..." -ForegroundColor Yellow
        Start-Sleep -Seconds 2
    }
    if ($ok) { break }
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Write-Host "  switching to next source ..." -ForegroundColor Yellow
}

if (-not $ok) {
    Write-Host "FAILED: could not download a complete Deno zip." -ForegroundColor Red
    Write-Host "Try turning on your VPN and running this script again." -ForegroundColor Red
    exit 1
}

Write-Host ("Zip OK: {0:N1} MB" -f ((Get-Item $zip).Length / 1MB)) -ForegroundColor Green

Write-Host "Extracting ..." -ForegroundColor Cyan
try {
    Expand-Archive -Path $zip -DestinationPath $binDir -Force
} catch {
    Write-Host "Extract failed: $($_.Exception.Message)" -ForegroundColor Red
    Remove-Item $zip -Force
    exit 1
}

if (-not (Test-Path $exe)) {
    Write-Host "FAILED: deno.exe not found after extraction." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "OK, Deno installed:" -ForegroundColor Green
& $exe --version
Write-Host ""
Write-Host "Path for later use:" -ForegroundColor Cyan
Write-Host "  $exe"
