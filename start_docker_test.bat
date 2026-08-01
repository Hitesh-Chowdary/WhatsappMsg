@echo off
echo ===================================================
echo 🐋 WhatsAppSMS Secure Docker Build ^& Test Launcher
echo ===================================================
echo.

echo [1/2] Compiling obfuscated backend code via PyArmor...
python build_protected.py --mac 44:f7:9f:db:15:c1

if %errorlevel% neq 0 (
    echo.
    echo ❌ [ERROR] Code obfuscation compilation failed.
    echo Make sure you have python installed and your PyArmor license registered if compiling large files.
    echo.
    pause
    exit /b %errorlevel%
)

echo.
echo [2/2] Launching Docker Compose container stack...
docker compose up --build

if %errorlevel% neq 0 (
    echo.
    echo ❌ [ERROR] Docker Compose failed to start the containers.
    echo.
    pause
    exit /b %errorlevel%
)

pause
