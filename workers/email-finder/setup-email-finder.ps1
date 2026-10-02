$ErrorActionPreference = 'Stop'
$workerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot   = (Get-Item $workerRoot).Parent.Parent.FullName
$python     = Join-Path $workerRoot '.venv\Scripts\python.exe'

# ── 1. Virtual environment ────────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $python)) {
    Write-Output 'Creating Python virtual environment...'
    python -m venv (Join-Path $workerRoot '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python environment.' }
}

# ── 2. Dependencies (includes google-cloud-discoveryengine + google-auth) ─────
Write-Output 'Installing dependencies...'
& $python -m pip install --upgrade pip
& $python -m pip install -r (Join-Path $workerRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }

# ── 3. spaCy English model ────────────────────────────────────────────────────
Write-Output 'Downloading spaCy model...'
& $python -m spacy download en_core_web_sm
if ($LASTEXITCODE -ne 0) { throw 'spaCy model installation failed.' }

# ── 4. Playwright Chromium browser ───────────────────────────────────────────
Write-Output 'Installing Playwright Chromium...'
& $python -m playwright install chromium
if ($LASTEXITCODE -ne 0) { throw 'Browser installation failed.' }

# ── 5. Google Application Credentials ────────────────────────────────────────
# Point GCP libraries at the service account JSON in the repo root.
# This is loaded automatically by config.py at runtime, but setting it here
# also makes the gcloud CLI and any ad-hoc scripts work in this shell.
$gcpCreds = Join-Path $repoRoot 'gcp-creds.json'
if (Test-Path -LiteralPath $gcpCreds) {
    [System.Environment]::SetEnvironmentVariable(
        'GOOGLE_APPLICATION_CREDENTIALS', $gcpCreds, 'User')
    Write-Output "GCP credentials registered: $gcpCreds"
} else {
    Write-Warning "gcp-creds.json not found at $gcpCreds — Vertex AI Search will be skipped."
}

Write-Output ''
Write-Output 'Setup complete.'
Write-Output 'Run install-autostart.ps1 to start the worker on login, then start-email-finder.ps1.'
