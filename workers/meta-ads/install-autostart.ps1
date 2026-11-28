# Keeps the Meta Ad Library pass alive: runs start.ps1 when you log in to
# Windows and every hour after. start.ps1 does nothing while a pass is running,
# and a pass opens no browser when no search is due, so most runs end at once.
#   Install:  .\install-autostart.ps1
#   Stop:     Disable-ScheduledTask -TaskName "BestSoftphone Meta Ads"
#   Remove:   Unregister-ScheduledTask -TaskName "BestSoftphone Meta Ads" -Confirm:$false
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$start = Join-Path $here 'start.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$start`"" `
    -WorkingDirectory $here
$atLogOn = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours 1)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName 'BestSoftphone Meta Ads' -Action $action -Trigger @($atLogOn, $watchdog) `
    -Settings $settings -Description 'Meta Ad Library pass for the Dial page Meta ad filter and the Meta-ad email sequence (bestsoftphone.site)' -Force | Out-Null
Write-Output 'Installed: the Meta ads pass is checked at log-in and every hour.'
