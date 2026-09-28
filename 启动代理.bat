@echo off
chcp 65001 >nul
title Intiface 信号转换代理
cd /d "%~dp0"
echo ================================================================
echo   Intiface 信号转换代理 - 本地独立窗口版
echo   请确保 Intiface Central 端口已设为 12347 并已启动
echo ================================================================
echo.
echo   正在启动本地桌面窗口...
echo.
node proxy.js
pause
