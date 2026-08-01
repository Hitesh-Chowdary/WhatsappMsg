@echo off
echo ===================================================
echo 🐋 WhatsAppSMS - Installation ^& Launcher
echo ===================================================
echo.

if not exist .env (
    if exist .env.example (
        echo [INFO] Creating new .env configuration file...
        copy .env.example .env > nul
        echo [INFO] Opening .env file in Notepad...
        echo.
        echo ---------------------------------------------------
        echo ACTION REQUIRED:
        echo Notepad has opened the '.env' configuration file.
        echo Please enter your Meta credentials and database settings.
        echo.
        echo Once you are done:
        echo 1. Save and Close Notepad.
        echo 2. Return here and press ANY key to start the container.
        echo ---------------------------------------------------
        echo.
        
        :: Launch notepad in the background and wait for user keypress
        start notepad .env
        pause
    ) else (
        echo ❌ [ERROR] .env.example template not found.
        pause
        exit /b 1
    )
) else (
    echo [INFO] Existing .env configuration file found.
)

echo.
echo Building and starting the containers in the background...
docker compose up --build -d

if %errorlevel% neq 0 (
    echo.
    echo ❌ [ERROR] Failed to start containers. 
    echo Please ensure Docker Desktop is running.
    echo.
    pause
    exit /b %errorlevel%
)

echo.
echo ===================================================
echo 🎉 Service started successfully in the background!
echo Portal is accessible at: http://localhost:8001
echo ===================================================
echo.
pause
