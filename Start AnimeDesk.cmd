@echo off
setlocal
cd /d "%~dp0"
rem AnimeDesk development launcher. Stays inside this folder.
where node >nul 2>nul || (echo Node.js 24+ is required. & pause & exit /b 1)
if not exist "node_modules" (
  echo Installing dependencies...
  call npm install || (echo npm install failed. & pause & exit /b 1)
)
call npm start
if errorlevel 1 pause
endlocal