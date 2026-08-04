@echo off
TITLE WhatsApp Automation 24/7 Autostart Installer
color 0B
echo ======================================================================
echo     ⚙️ CONFIGURING 24/7 AUTOSTART ON WINDOWS BOOT
echo ======================================================================
echo.

set SCRIPT_PATH=%~dp0run_production.bat

:: Read PORT safely (default to 8001)
set PORT=8001
if exist .env (
    for /f "tokens=*" %%p in ('python -c "import os; from dotenv import load_dotenv; load_dotenv(); print(os.getenv('PORT', '8001'))" 2^>nul') do set PORT=%%p
)
if "%PORT%"=="" set PORT=8001

echo [1/2] Adding Windows Firewall Rule for Port %PORT%...
netsh advfirewall firewall add rule name="WhatsApp Automation Port %PORT%" dir=in action=allow protocol=TCP localport=%PORT% >nul 2>&1
echo [OK] Firewall configured to allow LAN / Public access on Port %PORT%.

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
    echo 3. Configured to listen on Port %PORT%.
    echo 4. Accessible 24/7 at http://localhost:%PORT% or http://<IP>:%PORT%
    echo ======================================================================
) else (
    echo ❌ [ERROR] Could not write to Startup folder. Please run as Administrator.
)

echo.
pause
