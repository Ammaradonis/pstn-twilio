# Schedules the weekly U.S. Conquest refresh: "refresh.cjs run" starts at log-in
# and every hour. Each call starts this week's refresh, resumes one that was cut
# off (reboot, sleep, Google pushing back), or exits at once when this week's run
# is done or another copy is running. conhost --headless keeps the console hidden.
#   Install:  powershell -ExecutionPolicy Bypass -File workers\maps-refresh\install-task.ps1
#   Remove:   Unregister-ScheduledTask -TaskName "BestSoftphone Maps Refresh" -Confirm:$false
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $here "..\..")
$node = (Get-Command node.exe -ErrorAction Stop).Source
$script = Join-Path $here "refresh.cjs"
$action = New-ScheduledTaskAction -Execute "conhost.exe" `
    -Argument "--headless `"$node`" `"$script`" run" -WorkingDirectory $repo
$atLogOn = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$hourly = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Hours 1)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName "BestSoftphone Maps Refresh" -Action $action -Trigger @($atLogOn, $hourly) `
    -Settings $settings -Description "Weekly Google Maps refresh of the U.S. Conquest sheet: phone numbers (column G) and new schools" `
    -Force | Out-Null
Write-Output "Installed: the U.S. Conquest refresh runs weekly, checked at log-in and every hour."
