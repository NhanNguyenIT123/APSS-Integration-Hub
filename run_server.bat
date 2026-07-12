@echo off
title APSS Integration Hub Server
echo Starting APSS Integration Hub Server...
cd /d "%~dp0"
node shared/server.js
pause
