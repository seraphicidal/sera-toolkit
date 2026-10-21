$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$name = 'SERA extraction node'
$user = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\cmd.exe" `
    -Argument "/d /c `"$dir\run-node.cmd`"" -WorkingDirectory $dir

$boot = New-ScheduledTaskTrigger -AtStartup
$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)

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
