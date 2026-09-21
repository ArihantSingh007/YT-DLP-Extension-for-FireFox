@echo off
rem Double-click to register the helper with Firefox.
rem This only writes the Native Messaging registration Firefox needs.
rem It does not install Python, yt-dlp or FFmpeg - install those yourself first.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1"
echo.
pause
