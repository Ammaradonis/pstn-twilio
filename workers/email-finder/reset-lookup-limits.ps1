# Safe to run while the worker is active. The reset uses one SQLite transaction.
$ErrorActionPreference = 'Stop'
$resetPython = Join-Path $PSScriptRoot '.venv/Scripts/python.exe'
$resetScript = Join-Path $PSScriptRoot 'scripts/reset_lookup_limits.py'
if (-not (Test-Path -LiteralPath $resetPython)) {
    throw "Worker Python is missing: $resetPython"
}
& $resetPython $resetScript
if ($LASTEXITCODE -ne 0) {
    throw "Lookup counter reset failed (exit code $LASTEXITCODE)."
}
