@echo off

set "REPO=C:\path\to\sera-toolkit"
set "NODE=C:\Program Files\nodejs\node.exe"
set "HERE=%~dp0"
set "LOG=%HERE%node.log"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%kill-orphans.ps1" >nul 2>&1

if exist "%LOG%" move /y "%LOG%" "%LOG%.old" >nul
if exist "%HERE%ytdlp-update.log" move /y "%HERE%ytdlp-update.log" "%HERE%ytdlp-update.log.old" >nul

cd /d "%REPO%"

call "%HERE%refresh-ytdlp.cmd" once
start "" /b cmd /d /c ""%HERE%refresh-ytdlp.cmd" daily"

:loop
echo [%date% %time%] starting extraction node>> "%LOG%"
"%NODE%" --env-file=.env.node.local apps\extractor\dist\index.js >> "%LOG%" 2>&1
echo [%date% %time%] node exited with code %errorlevel%; restarting in 15 seconds>> "%LOG%"
ping -n 16 127.0.0.1 >nul
goto loop
