@echo off
REM One-click launcher for the DEM Viewer on Windows.
REM Tries Python 3 first, then Python launcher, then Node.
cd /d "%~dp0"
echo Starting local web server on port 8765...
echo The viewer will open in your browser. Keep this window open.
echo Press Ctrl+C to stop.
echo.

REM Open browser after a short delay
start "" timeout /t 2 /nobreak >nul && start "" http://localhost:8765

where python >nul 2>nul
if %errorlevel%==0 (
  python -m http.server 8765
  goto :end
)

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 -m http.server 8765
  goto :end
)

where node >nul 2>nul
if %errorlevel%==0 (
  npx --yes http-server -p 8765 -c-1 .
  goto :end
)

echo.
echo ERROR: Neither Python nor Node.js was found on your system.
echo Please install Python 3 from https://www.python.org/downloads/
echo (Make sure to check "Add Python to PATH" during install)
pause

:end
