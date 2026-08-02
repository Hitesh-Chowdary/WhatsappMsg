@echo off
TITLE WhatsApp Automation Production Server
echo ========================================================
echo Starting WhatsApp Automation System in Production Mode
echo ========================================================

echo 1. Building Vite Frontend Production Bundle...
cd frontend
call npm run build
if %errorlevel% neq 0 (
    echo [ERROR] Frontend build failed!
    pause
    exit /b %errorlevel%
)
cd ..

echo.
echo 2. Launching FastAPI Backend Server on port 8000...
echo Access locally at: http://localhost:8000
echo Access on LAN at:  http://0.0.0.0:8000
echo.

python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 --workers 4

pause
