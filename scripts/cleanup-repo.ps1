# One-shot cleanup:
#   - delete the wrongly committed src/static.ts.bak
#   - regenerate src/static.ts locally (it is git-ignored and built on deploy)
#   - make sure .gitignore covers the generated file
#
#   powershell -ExecutionPolicy Bypass -File scripts\cleanup-repo.ps1
#
# ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less files as GBK,
# and non-ASCII characters would break parsing.

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "Working dir: $root" -ForegroundColor Cyan

# 1. remove the backup file that was committed by accident
$bak = Join-Path $root 'src\static.ts.bak'
if (Test-Path $bak) {
    Remove-Item $bak -Force
    Write-Host "removed src/static.ts.bak" -ForegroundColor Yellow
} else {
    Write-Host "src/static.ts.bak not present, skip"
}

# 2. regenerate src/static.ts for local development
$deno = Join-Path $root '.tools\bin\deno.exe'
if (Test-Path $deno) {
    Write-Host "regenerating src/static.ts ..." -ForegroundColor Cyan
    & $deno task sync
} else {
    Write-Host "deno not found at $deno, skip regeneration" -ForegroundColor Yellow
}

# 3. make sure .gitignore covers the generated file
$ignoreFile = Join-Path $root '.gitignore'
$ignoreText = Get-Content $ignoreFile -Raw
if ($ignoreText -notmatch 'src/static\.ts') {
    Add-Content $ignoreFile "`nsrc/static.ts`n"
    Write-Host "added src/static.ts to .gitignore" -ForegroundColor Yellow
} else {
    Write-Host ".gitignore already ignores src/static.ts"
}

# 4. tell git to stop tracking the generated / backup files
& git rm --cached 'src/static.ts.bak' 2>&1 | Out-Null
& git rm --cached 'src/static.ts' 2>&1 | Out-Null

Write-Host ""
Write-Host "git status:" -ForegroundColor Cyan
& git status --short

Write-Host ""
Write-Host "Done. Next:" -ForegroundColor Green
Write-Host "  git add -A"
Write-Host "  git commit -m \"cleanup: drop generated + backup files\""
Write-Host "  git push origin main"
