$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$metaOutput = Join-Path $projectRoot '.cache/meta-ads'
$pythonPath = Join-Path $projectRoot 'workers/email-finder/.venv/Scripts/python.exe'
$workerScript = Join-Path $PSScriptRoot 'run.py'
if (-not (Test-Path -LiteralPath (Join-Path $metaOutput 'inventory.json'))) {
    throw 'Refresh the inventory first; see workers/meta-ads/README.md.'
}
if (Test-Path -LiteralPath (Join-Path $metaOutput 'STOP')) {
    throw 'The STOP file is present. Remove it when you want to resume.'
}
$workerProcess = Start-Process -FilePath $pythonPath -ArgumentList @('"' + $workerScript + '"', '--all-time', '--apply') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $metaOutput 'worker.log') -RedirectStandardError (Join-Path $metaOutput 'worker-error.log')
$workerProcess.PriorityClass = 'BelowNormal'
Write-Output "Meta ads workers launched as PID $($workerProcess.Id). Progress: $metaOutput/status.json"
