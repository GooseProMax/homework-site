# Retry git push until GitHub answers (no VPN needed).
#
#   powershell -ExecutionPolicy Bypass -File scripts\push-retry.ps1
#
# GitHub is reachable from mainland China most of the time, but the connection
# to one of its IPs often gets reset. Retrying usually succeeds within a few
# attempts. The script also prints the resolved GitHub IPs for reference.
# ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less files as GBK,
# and non-ASCII characters would break parsing.

param(
    [int]$MaxAttempts = 15,
    [string]$Remote = 'origin',
    [string]$Branch = 'main'
)

$ErrorActionPreference = 'Continue'

# Guard against trailing spaces or backslashes passed on the command line
# (otherwise git fails with: invalid refspec 'main\')
$Remote = "$Remote".Trim().TrimEnd('\', '/')
$Branch = "$Branch".Trim().TrimEnd('\', '/')
if (-not $Remote) { $Remote = 'origin' }
if (-not $Branch) { $Branch = 'main' }

Push-Location (Split-Path -Parent $PSScriptRoot)

Write-Host "Resolving github.com ..." -ForegroundColor Cyan
try {
    Resolve-DnsName github.com -Type A -ErrorAction Stop |
        Where-Object { $_.IPAddress } |
        ForEach-Object { Write-Host "  -> $($_.IPAddress)" }
} catch {
    Write-Host "  DNS lookup failed: $($_.Exception.Message)" -ForegroundColor Yellow
}

for ($i = 1; $i -le $MaxAttempts; $i++) {
    Write-Host ""
    Write-Host "Attempt $i / $MaxAttempts ..." -ForegroundColor Cyan

    $output = & git push $Remote $Branch 2>&1
    $code = $LASTEXITCODE
    $output | ForEach-Object { Write-Host "  $_" }

    if ($code -eq 0) {
        Write-Host ""
        Write-Host "PUSH OK" -ForegroundColor Green
        Pop-Location
        exit 0
    }

    $text = ($output | Out-String)
    if ($text -match 'up-to-date') {
        Write-Host "Nothing to push: everything is already on GitHub." -ForegroundColor Green
        Pop-Location
        exit 0
    }
    if ($text -match 'rejected|non-fast-forward') {
        Write-Host ""
        Write-Host "Rejected by remote. Run this first, then push again:" -ForegroundColor Yellow
        Write-Host "  git pull --rebase $Remote $Branch"
        Pop-Location
        exit 2
    }
    if ($text -match 'Authentication failed|could not read Username|403') {
        Write-Host ""
        Write-Host "Authentication problem. Clear the cached credential and retry:" -ForegroundColor Yellow
        Write-Host "  git config --global --unset credential.helper"
        Write-Host "  git config --global credential.helper manager"
        Pop-Location
        exit 3
    }

    $wait = [Math]::Min(3 + $i * 2, 20)
    Write-Host "  network hiccup, waiting $wait s before retrying ..." -ForegroundColor Yellow
    Start-Sleep -Seconds $wait
}

Write-Host ""
Write-Host "Gave up after $MaxAttempts attempts." -ForegroundColor Red
Write-Host "Options: 1) rerun later  2) turn on VPN and rerun  3) upload the changed files via the GitHub web UI" -ForegroundColor Yellow
Pop-Location
exit 1
