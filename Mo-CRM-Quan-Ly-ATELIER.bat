@echo off
chcp 65001 >nul
title ATELIER // He Thong CRM Quan Ly Don Hang & Khach Hang (http://localhost:3456)
cd /d "%~dp0"
echo =====================================================================
echo   DANG KHOI DONG HE THONG LOCALHOST CRM CUA ATELIER...
echo   Dia chi: http://localhost:3456
echo =====================================================================
start "" "http://localhost:3456"
node crm-server.js
pause
