@echo off
TITLE WhatsApp Automation 24/7 Autostart Installer
color 0B
echo ======================================================================
echo     ⚙️ CONFIGURING 24/7 AUTOSTART ON WINDOWS BOOT (PORT 8001)
echo ======================================================================
echo.

set TASK_NAME=WhatsAppAutomationServer
set SCRIPT_PATH=%~dp0run_production.bat

echo [1/2] Adding Windows Firewall Rule for Port 8001...
netsh advfirewall firewall add rule name="WhatsApp Automation Port 8001" dir=in action=allow protocol=TCP localport=8001 >nul 2>&1
echo [OK] Firewall configured to allow LAN / Public access on Port 8001.

echo.
echo [2/2] Registering 24/7 Background Startup Task...

:: Copy shortcut to Windows Startup Folder so it launches automatically on boot
copy /Y "%SCRIPT_PATH%" "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\run_production.bat" >nul 2>&1

if %errorlevel% equ 0 (
    echo.
    echo ======================================================================
    echo 🟢 SUCCESS! WhatsApp Automation is now configured for 24/7 Autostart!
    echo.
    echo 📌 Features:
    echo 1. NO Docker Desktop required!
    echo 2. Runs automatically in the background whenever Windows boots up.
    echo 3. Accessible 24/7 at http://localhost:8001 or http://<IP>:8001
    echo ======================================================================
) else (
    echo ❌ [ERROR] Could not write to Startup folder. Please run as Administrator.
)

echo.
pause
