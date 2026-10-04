# Registers the "SERA extraction node" scheduled task, which runs run-node.cmd from this
# folder at boot, at logon, and every five minutes as a watchdog. Run once, elevated:
#   powershell -ExecutionPolicy Bypass -File install-task.ps1
# Set REPO in run-node.cmd first.

$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$name = 'SERA extraction node'
$user = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\cmd.exe" `
    -Argument "/d /c `"$dir\run-node.cmd`"" -WorkingDirectory $dir

# At boot (before anyone logs in), at logon as a backup, and every 5 minutes as a watchdog
# in case the wrapper itself was killed. MultipleInstances=IgnoreNew means a trigger never
# starts a second copy while one is running.
$boot = New-ScheduledTaskTrigger -AtStartup
$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)

# S4U: runs as this user whether or not they are logged on, with no stored password and no window.
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable -DontStopOnIdleEnd

Register-ScheduledTask -TaskName $name -Action $action -Principal $principal `
    -Trigger @($boot, $logon, $watchdog) -Settings $settings `
    -Description "Keeps this machine connected as a SERA extraction node. Wrapper and logs: $dir" `
    -Force | Out-Null
Start-ScheduledTask -TaskName $name
"Registered and started '$name'. Logs: $dir\node.log, $dir\ytdlp-update.log"
