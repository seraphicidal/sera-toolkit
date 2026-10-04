# Stops any extraction node, and any daily yt-dlp refresher, left running from an earlier
# start of the task. Ending a scheduled task ends its cmd.exe wrapper but not what it
# started, and an orphaned node keeps node.log open, which stops the next wrapper from
# starting a node at all.
#
# `[\\/]`, not `[\/]`: in .NET's regex that is only a forward slash, and run-node.cmd starts
# the node as apps\extractor\dist\index.js — so the old pattern never matched, the orphan
# survived every restart, and its lock kept the new wrapper from starting a node.
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" |
    Where-Object {
        $_.CommandLine -match 'apps[\\/]extractor[\\/]dist[\\/]index\.js' -or
        $_.CommandLine -match 'refresh-ytdlp\.cmd"? daily'
    } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
