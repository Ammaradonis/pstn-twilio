# Keeps the email finder running: starts it when you log in to Windows, and
# every 10 minutes starts it again if it has stopped (a second copy exits at
# once while one is running). pythonw has no console, so nothing flashes.
#   Install:  .\install-autostart.ps1
#   Remove:   Unregister-ScheduledTask -TaskName "BestSoftphone Email Finder" -Confirm:$false
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $here ".venv\Scripts\pythonw.exe"
$action = New-ScheduledTaskAction -Execute $python -Argument "-m email_finder.worker" -WorkingDirectory $here
$atLogOn = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName "BestSoftphone Email Finder" -Action $action -Trigger @($atLogOn, $watchdog) `
    -Settings $settings -Description "Finds emails for the selected lead sheet (bestsoftphone.site)" -Force | Out-Null
Write-Output "Installed: the email finder starts at log-in and is restarted within 10 minutes if it stops."
