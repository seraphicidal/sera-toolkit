Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" |
    Where-Object {
        $_.CommandLine -match 'apps[\\/]extractor[\\/]dist[\\/]index\.js' -or
        $_.CommandLine -match 'refresh-ytdlp\.cmd"? daily'
    } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
