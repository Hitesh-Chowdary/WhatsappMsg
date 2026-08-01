#!/bin/sh
# entrypoint.sh - Wait for database and launch application

echo "Starting deployment checks..."

# Run connection check script
if ! python -c "
import socket, time, os, sys

db_url = os.getenv('DATABASE_URL', '')
if db_url:
    try:
        # Mask password before logging database connection config
        if '@' in db_url:
            parts = db_url.split('@')
            prefix = parts[0]
            if '://' in prefix:
                scheme, creds = prefix.split('://', 1)
                if ':' in creds:
                    user = creds.split(':')[0]
                    masked_creds = f'{user}:********'
                else:
                    masked_creds = '********'
                prefix = f'{scheme}://{masked_creds}'
            else:
                prefix = '********'
            masked_url = f'{prefix}@{parts[-1]}'
        else:
            masked_url = db_url
        print('Database URL configured:', masked_url)
    except Exception:
        print('Database URL configured: [ERROR MASKING URL]')
else:
    print('Database URL configured: [EMPTY]')

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
max_attempts = 15
while attempts < max_attempts:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(2)
        s.connect((host, port))
        s.close()
        print('Database port is active and accepting connections!')
        sys.exit(0)
    except socket.error:
        attempts += 1
        time.sleep(1)
else:
    print('Error: Database connection timed out.')
    sys.exit(1)
"; then
    echo "CRITICAL: Database verification failed. Aborting application startup."
    exit 1
fi

echo "Launching FastAPI application..."
exec uvicorn backend.main:app --host 0.0.0.0 --port 8000
