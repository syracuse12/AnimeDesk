@echo off
setlocal
title AnimeDesk OpenCode
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Invoke-AnimeDeskOpenCode.ps1" %*
endlocal
