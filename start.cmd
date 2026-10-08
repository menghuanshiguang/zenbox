@echo off
rem zenbox one-click start (Windows cmd): run from anywhere, lands in repo root.
cd /d "%~dp0"
node start.js start %*
exit /b %ERRORLEVEL%
