# Starts one Meta ads pass in the background, at below-normal priority.
#
# Run by the "BestSoftphone Meta Ads" scheduled task every hour (see
# install-autostart.ps1), or by hand. It does nothing while a pass is running,
# refreshes the school inventory when it is a week old, and the pass itself
# exits without opening a browser when no search is due (each one is due again
# 21 days after it last ran, so "still advertising now" stays current).
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$metaOutput = Join-Path $projectRoot '.cache/meta-ads'
$pythonPath = Join-Path $projectRoot 'workers/email-finder/.venv/Scripts/python.exe'
$workerScript = Join-Path $PSScriptRoot 'run.py'
$inventory = Join-Path $metaOutput 'inventory.json'
New-Item -ItemType Directory -Force -Path $metaOutput | Out-Null

if (Test-Path -LiteralPath (Join-Path $metaOutput 'STOP')) {
    Write-Output 'The STOP file is present. Remove it when you want to resume.'
    exit 0
}

# One pass at a time: a second copy would also fail to open the worker's log files.
$pidFile = Join-Path $metaOutput 'worker.pid'
if (Test-Path -LiteralPath $pidFile) {
    $running = Get-CimInstance Win32_Process -Filter "ProcessId=$([int](Get-Content -LiteralPath $pidFile -Raw))" -ErrorAction SilentlyContinue
    if ($running -and $running.CommandLine -like '*meta-ads*run.py*') {
        Write-Output "A Meta ads pass is already running as PID $($running.ProcessId)."
        exit 0
    }
}

# New rows and tabs only reach the matcher through the inventory.
$stale = -not (Test-Path -LiteralPath $inventory) -or ((Get-Item -LiteralPath $inventory).LastWriteTime -lt (Get-Date).AddDays(-7))
if ($stale) {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    $tsx = Join-Path $projectRoot 'node_modules/tsx/dist/cli.mjs'
    if ($node -and (Test-Path -LiteralPath $tsx)) {
        Push-Location (Join-Path $projectRoot 'apps/api')
        try {
            & $node $tsx --env-file=../../.env scripts/meta-ads-sheets.ts *>> (Join-Path $metaOutput 'inventory.log')
            if ($LASTEXITCODE -ne 0) { Write-Output 'Inventory refresh failed; see inventory.log. Using the previous inventory.' }
        } finally {
            Pop-Location
        }
    }
}
if (-not (Test-Path -LiteralPath $inventory)) {
    throw 'No inventory yet; see workers/meta-ads/README.md.'
}

$workerProcess = Start-Process -FilePath $pythonPath -ArgumentList @('"' + $workerScript + '"', '--all-time', '--apply') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $metaOutput 'worker.log') -RedirectStandardError (Join-Path $metaOutput 'worker-error.log')
$workerProcess.PriorityClass = 'BelowNormal'
Write-Output "Meta ads workers launched as PID $($workerProcess.Id). Progress: $metaOutput/status.json"
