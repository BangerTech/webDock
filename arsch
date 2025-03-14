FROM python:3.9-slim

WORKDIR /app

# System dependencies
RUN apt-get update && apt-get install -y \
    docker.io \
    docker-compose \
    && rm -rf /var/lib/apt/lists/*

# Python dependencies
COPY docker-compose-files/webdock-ui/src/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY docker-compose-files/webdock-ui/src /app/
COPY docker-compose-files /app/docker-compose-files

# Create necessary directories
RUN mkdir -p /app/data /app/config

EXPOSE 80

CMD ["python", "app.py"] 