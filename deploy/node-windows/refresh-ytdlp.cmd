@echo off

set "HERE=%~dp0"
set "UPDATELOG=%HERE%ytdlp-update.log"

if /i "%~1"=="daily" goto daily

:refresh
if exist "%HERE%ytdlp-updates.paused" (
  echo [%date% %time%] yt-dlp updates are paused>> "%UPDATELOG%"
) else (
  echo [%date% %time%] refreshing yt-dlp>> "%UPDATELOG%"
  "%NODE%" scripts\fetch-tools.mjs --only=ytdlp --pin-from=main >> "%UPDATELOG%" 2>&1
)
if /i "%~1"=="daily" goto daily
goto :eof

:daily
ping -n 86401 127.0.0.1 >nul
goto refresh
