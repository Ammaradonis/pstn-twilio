# Starts the email finder worker. Run by the "BestSoftphone Email Finder" task at
# logon (see install-autostart.ps1), or by hand:  .\start-email-finder.ps1
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $here ".venv\Scripts\pythonw.exe"
if (-not (Test-Path $python)) {
    Write-Error "Missing $python. Set up first: python -m venv .venv; .venv\Scripts\pip install -r requirements.txt; .venv\Scripts\python -m spacy download en_core_web_sm"
    exit 1
}
# Only one worker at a time.
$running = Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" |
    Where-Object { $_.CommandLine -match 'email_finder\.worker' }
if ($running) { Write-Output "Email finder already running (PID $($running.ProcessId))."; exit 0 }
Start-Process -FilePath $python -ArgumentList "-m", "email_finder.worker" -WorkingDirectory $here -WindowStyle Hidden
Write-Output "Email finder started. Log: $here\.cache\worker.log"
