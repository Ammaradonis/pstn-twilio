# Sets the Cloudflare R2 secrets on the Fly app, reading values from the local
# (gitignored) .env so the credentials are never copied into chat or into git.
#
# Run from the repository root in YOUR terminal:
#   powershell -ExecutionPolicy Bypass -File scripts\set-fly-r2-secrets.ps1

$ErrorActionPreference = 'Stop'

$app      = 'pstn-twilio-api'
$envFile  = Join-Path $PSScriptRoot '..\.env'
$envFile  = (Resolve-Path $envFile).Path

if (-not (Test-Path $envFile)) { throw "No .env found at $envFile" }

function Get-EnvValue([string]$name) {
  $line = Get-Content $envFile | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -replace "^$name=", '').Trim().Trim('"').Trim("'")
}

$key    = Get-EnvValue 'R2_ACCESS_KEY_ID'
$secret = Get-EnvValue 'R2_SECRET_ACCESS_KEY'
$bucket = Get-EnvValue 'R2_RECORDINGS_BUCKET'

foreach ($pair in @(@('R2_ACCESS_KEY_ID', $key), @('R2_SECRET_ACCESS_KEY', $secret), @('R2_RECORDINGS_BUCKET', $bucket))) {
  if (-not $pair[1]) { throw "Missing $($pair[0]) in $envFile" }
}

# --- Authentication -----------------------------------------------------------
# A browser-minted token can fail with "missing third-party discharge token".
# An org API token from https://fly.io/dashboard -> Organization -> Tokens works
# reliably. If FLY_API_TOKEN is not already set, ask for one and use it for this
# script only (it is not written to disk).
if (-not $env:FLY_API_TOKEN) {
  Write-Host "FLY_API_TOKEN is not set in this shell." -ForegroundColor Yellow
  Write-Host "Create one at https://fly.io/dashboard -> Organization -> Tokens -> Create token"
  $secure = Read-Host "Paste your Fly API token (input hidden)" -AsSecureString
  $env:FLY_API_TOKEN = [System.Net.NetworkCredential]::new('', $secure).Password
  if (-not $env:FLY_API_TOKEN) { throw "No token provided." }
}

Write-Host "Checking Fly authentication..." -ForegroundColor Cyan
flyctl auth whoami | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Fly authentication still failing. The token may lack access to app '$app'."
}

Write-Host "Setting 3 secrets on app '$app' (values read from .env, not printed)..." -ForegroundColor Cyan
Write-Host "  R2_ACCESS_KEY_ID       = <len $($key.Length)>"
Write-Host "  R2_SECRET_ACCESS_KEY   = <len $($secret.Length)>"
Write-Host "  R2_RECORDINGS_BUCKET   = $bucket"

flyctl secrets set `
  "R2_ACCESS_KEY_ID=$key" `
  "R2_SECRET_ACCESS_KEY=$secret" `
  "R2_RECORDINGS_BUCKET=$bucket" `
  -a $app

if ($LASTEXITCODE -ne 0) { throw "flyctl secrets set failed with exit code $LASTEXITCODE" }

Write-Host "`nDone. Fly restarts the machines to apply them." -ForegroundColor Green
Write-Host "Verify with:  flyctl secrets list -a $app"
Write-Host "Then check the API logs for the absence of: 'R2 is not configured; recordings stay at Twilio'"
