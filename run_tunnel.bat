@echo off
title APSS System - Dual Ngrok Tunnels (Port 3000 & Port 5000)
echo ===================================================
echo   Starting Dual Ngrok Tunnels:
echo   - Port 3000 (APSS Integration Hub)
echo   - Port 5000 (Sourcing Engine)
echo ===================================================
echo.

"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe\ngrok.exe" start --config "d:\GITHUB\ngrok_both.yml" --all

pause
