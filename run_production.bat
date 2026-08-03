@echo off
TITLE WhatsApp Automation - Production Server Launcher
color 0A
echo ======================================================================
echo             🚀 WHATSAPP AUTOMATION - PRODUCTION LAUNCHER
echo ======================================================================
echo.

:: Step 1: Check or create .env file
if not exist .env (
    if exist .env.example (
        echo [INFO] Creating new .env configuration file from template...
        copy .env.example .env > nul
        echo.
        echo ======================================================================
        echo 📝 ACTION REQUIRED:
        echo Notepad has opened your '.env' configuration file.
        echo Please enter your Meta Credentials (WHATSAPP_TOKEN, PHONE_NUMBER_ID)
        echo and Database connection URL.
        echo.
        echo Instructions:
        echo 1. Edit your values in Notepad.
        echo 2. Save (Ctrl+S) and Close Notepad.
        echo 3. Return to this command window and press ANY KEY to continue.
        echo ======================================================================
        echo.
        start notepad .env
        pause
    ) else (
        echo ❌ [ERROR] .env.example template not found.
        pause
        exit /b 1
    )
) else (
    echo [INFO] Existing .env configuration file detected.
)

echo.
echo [INFO] 1. Checking Frontend Production Build...
if not exist frontend\dist\index.html (
    echo [INFO] Building Vite frontend bundle for production...
    cd frontend
    call npm run build
    if %errorlevel% neq 0 (
        echo ❌ [ERROR] Frontend build failed! Please check Node.js installation.
        cd ..
        pause
        exit /b %errorlevel%
    )
    cd ..
) else (
    echo [INFO] Production frontend build found (frontend\dist).
)

echo.
echo [INFO] 2. Installing / Updating Python dependencies...
pip install -r requirements.txt > nul 2>&1

echo.
echo [INFO] 3. Configuring Windows Firewall for Port 8000 LAN Access...
netsh advfirewall firewall add rule name="WhatsApp Automation Port 8000" dir=in action=allow protocol=TCP localport=8000 >nul 2>&1

echo.
echo ======================================================================
echo 🟢 STARTING PRODUCTION SERVER ON PORT 8000...
echo.
echo 📍 Access locally on this machine:   http://localhost:8000
echo 📍 Access from LAN / College Wi-Fi:  http://0.0.0.0:8000
echo ======================================================================
echo.

python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 --workers 4

pause
