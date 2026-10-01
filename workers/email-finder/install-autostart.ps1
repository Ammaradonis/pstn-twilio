# Starts the email finder whenever you log in to Windows.
#   Install:  .\install-autostart.ps1
#   Remove:   Unregister-ScheduledTask -TaskName "BestSoftphone Email Finder" -Confirm:$false
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here "start-email-finder.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "BestSoftphone Email Finder" -Action $action -Trigger $trigger `
    -Settings $settings -Description "Finds emails for the selected lead sheet (bestsoftphone.site)" -Force | Out-Null
Write-Output "Installed: the email finder starts when you log in."
