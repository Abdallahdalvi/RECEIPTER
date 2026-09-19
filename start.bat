@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22+ is required. Install Node.js and run this file again.
  pause
  exit /b 1
)
if not exist data mkdir data
call npm start
pause
