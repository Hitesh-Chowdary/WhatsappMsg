#!/bin/sh
# entrypoint.sh - Wait for database and launch application

echo "Starting deployment checks..."

# Run a socket connect check to verify PostgreSQL is accepting TCP connections
python -c "
import socket, time, os

db_url = os.getenv('DATABASE_URL', '')
print('Database URL configured:', db_url)

# Default host and port
host = 'db'
port = 5432

if db_url:
    try:
        url_part = db_url.split('@')[-1]
        host_port = url_part.split('/')[0]
        if ':' in host_port:
            host, port = host_port.split(':')
            port = int(port)
        else:
            host = host_port
    except Exception as e:
        print('Error parsing database host/port, falling back to defaults:', e)

print(f'Waiting for PostgreSQL database at {host}:{port}...')

attempts = 0
max_attempts = 60
while attempts < max_attempts:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(2)
        s.connect((host, port))
        s.close()
        print('Database port is active and accepting connections!')
        break
    except socket.error:
        attempts += 1
        time.sleep(1)
else:
    print('Error: Database connection timed out.')
"

echo "Launching FastAPI application..."
exec uvicorn backend.main:app --host 0.0.0.0 --port 8000
