@echo off
rem Brings .tools\yt-dlp.exe to the version pinned on main (checksum-verified, like every
rem fetch). Called by run-node.cmd with the checkout as the working directory:
rem   refresh-ytdlp.cmd once    one refresh, now
rem   refresh-ytdlp.cmd daily   a refresh every 24 hours, forever
rem Skipped while ytdlp-updates.paused exists next to this file.
rem
rem Replacing the binary is safe with the node running: fetch-tools renames the old one
rem aside, which Windows allows for an executable in use, and the next job uses the new one.

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
rem ping as a sleep, for the same reason as in run-node.cmd: 86401 pings is 24 hours.
ping -n 86401 127.0.0.1 >nul
goto refresh
