# Stage 1: Build React Frontend
FROM node:22-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# Stage 2: Secure Python Runtime
FROM python:3.10-slim
WORKDIR /app

# Install PostgreSQL client dependencies and build-essential
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# CRITICAL FOR SECURITY: Copy obfuscated Python app code from PyArmor build output
COPY dist/backend/ ./backend

# Copy built frontend assets
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist
COPY frontend/static ./frontend/static
COPY frontend/templates ./frontend/templates

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV PORT=8000

# Copy and setup entrypoint script
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 8000

# Set secure execution entrypoint
ENTRYPOINT ["/app/entrypoint.sh"]
