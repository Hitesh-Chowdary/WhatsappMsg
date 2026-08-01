@echo off
echo ===================================================
echo 🐋 WhatsAppSMS Local Dev Docker Launcher
echo ===================================================
echo.
echo Starting local container stack using raw Python files...
echo (No PyArmor compilation, MAC checks, or Meta API keys required)
echo.

docker compose -f docker-compose.dev.yml up --build

if %errorlevel% neq 0 (
    echo.
    echo ❌ [ERROR] Docker Compose failed to start the development container stack.
    echo Make sure Docker Desktop is open and running on your laptop.
    echo.
    pause
    exit /b %errorlevel%
)

pause
