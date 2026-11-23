# Keeps the Instagram DM outreach running: starts `ig_dm.py run --loop` when you
# log in to Windows, and every 10 minutes starts it again if it has stopped (a
# second copy exits at once while one is running). The loop itself waits for the
# Texas daytime window, the day's 50 and any pause on the phone.
#   Install:  .\install-ig-dm-autostart.ps1
#   Stop:     Disable-ScheduledTask -TaskName "BestSoftphone IG DMs"
#   Remove:   Unregister-ScheduledTask -TaskName "BestSoftphone IG DMs" -Confirm:$false
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $here ".venv\Scripts\pythonw.exe"
$script = Join-Path $here "scripts\ig_dm.py"
$action = New-ScheduledTaskAction -Execute $python -Argument "`"$script`" run --loop" -WorkingDirectory $here
$atLogOn = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName "BestSoftphone IG DMs" -Action $action -Trigger @($atLogOn, $watchdog) `
    -Settings $settings -Description "Instagram DM outreach from @matboss_online, 50 a day (bestsoftphone.site)" -Force | Out-Null
Write-Output "Installed: the DM outreach starts at log-in and is restarted within 10 minutes if it stops."
