@echo off
rem SERA extraction node, kept alive. Started by the "SERA extraction node" scheduled task
rem (install-task.ps1). If the node exits for any reason it is started again 15 seconds later.
rem Config lives in the repo's git-ignored .env.node.local; output goes to node.log here.
rem
rem Copy this folder somewhere outside the checkout (e.g. %USERPROFILE%\.sera-node) and set
rem REPO to the checkout the node runs from.

set "REPO=C:\path\to\sera-toolkit"
set "NODE=C:\Program Files\nodejs\node.exe"
set "HERE=%~dp0"
set "LOG=%HERE%node.log"

rem Clear out a node (and yt-dlp refresher) left behind by an earlier start, which would
rem also keep the logs locked.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%kill-orphans.ps1" >nul 2>&1

rem Keep one previous log of each; start fresh at each boot so neither can grow forever.
if exist "%LOG%" move /y "%LOG%" "%LOG%.old" >nul
if exist "%HERE%ytdlp-update.log" move /y "%HERE%ytdlp-update.log" "%HERE%ytdlp-update.log.old" >nul

cd /d "%REPO%"

rem yt-dlp at the version pinned on main, before the first job, and then once a day in the
rem background. A failure here (no network yet at boot) only means the next one tries again.
call "%HERE%refresh-ytdlp.cmd" once
start "" /b cmd /d /c ""%HERE%refresh-ytdlp.cmd" daily"

:loop
echo [%date% %time%] starting extraction node>> "%LOG%"
"%NODE%" --env-file=.env.node.local apps\extractor\dist\index.js >> "%LOG%" 2>&1
echo [%date% %time%] node exited with code %errorlevel%; restarting in 15 seconds>> "%LOG%"
rem ping as a sleep: timeout.exe refuses to run without a console, which a background task has none of.
ping -n 16 127.0.0.1 >nul
goto loop
