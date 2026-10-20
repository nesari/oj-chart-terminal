@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo First run: installing Electron, please wait...
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
  echo Verifying downloaded Electron against the OFFICIAL GitHub release checksum...
  call node scripts\verify-electron.js
  if errorlevel 1 (
    echo.
    echo SECURITY: Electron checksum verification failed. The downloaded binary
    echo does not match the official release and will NOT be launched.
    echo Delete node_modules and %LOCALAPPDATA%\electron\Cache and try again.
    pause
    exit /b 1
  )
)
start "" "node_modules\electron\dist\electron.exe" . --mode=mt5
