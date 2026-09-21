@echo off
rem Windows launcher for the native messaging host.
rem Firefox needs an executable path; Python scripts are started through this
rem wrapper. %~dp0 is this file's folder, so the install location can move.
setlocal
set "HOST_DIR=%~dp0"
if defined YTDLP_BRIDGE_PYTHON (
  "%YTDLP_BRIDGE_PYTHON%" "%HOST_DIR%src\host.py"
  exit /b %errorlevel%
)
where pythonw.exe >nul 2>&1 && (
  pythonw.exe "%HOST_DIR%src\host.py"
  exit /b %errorlevel%
)
where python.exe >nul 2>&1 && (
  python.exe "%HOST_DIR%src\host.py"
  exit /b %errorlevel%
)
py -3 "%HOST_DIR%src\host.py"
exit /b %errorlevel%
