@echo off
setlocal
chcp 65001 >nul 2>nul
cd /d "%~dp0"

set "NODE_EXE=node"
if exist "%~dp0runtime\node\node.exe" set "NODE_EXE=%~dp0runtime\node\node.exe"

"%NODE_EXE%" -v >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 22 not found. Please use the portable package instead.
  pause
  exit /b 1
)

if not exist "%~dp0dist\index.html" (
  echo Building frontend ...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :fail
  call npm run build
  if errorlevel 1 goto :fail
)

REM Reuse an existing instance; never start a second copy of the hotkey/model service.
"%NODE_EXE%" --no-warnings runtime\check-running.mjs
if not errorlevel 1 goto :eof

REM Default: a small always-on-top panel in the top-right corner, manual mode.
REM Double-click the tray icon (or the panel) to open the full notes window.
echo Starting Screen Notes ... ^(close this window to stop^)
"%NODE_EXE%" --no-warnings runtime\server.mjs --port 17860 --shell
if errorlevel 1 (
  echo.
  echo [ERROR] Failed to start. See the message above.
  pause
)
goto :eof

:fail
echo [ERROR] Setup failed. See messages above.
pause
exit /b 1
