# Stops any extraction node, and any daily yt-dlp refresher, left running from an earlier
# start of the task. Ending a scheduled task ends its cmd.exe wrapper but not what it
# started, and an orphaned node keeps node.log open, which stops the next wrapper from
# starting a node at all.
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" |
    Where-Object {
        $_.CommandLine -match 'apps[\/]extractor[\/]dist[\/]index\.js' -or
        $_.CommandLine -match 'refresh-ytdlp\.cmd"? daily'
    } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
