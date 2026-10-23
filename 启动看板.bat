@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动高潜作业学情看板...
echo.
node server.mjs
pause
