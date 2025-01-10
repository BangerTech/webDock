FROM python:3.9-slim
WORKDIR /app

# System-Abhängigkeiten inkl. Docker
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    gnupg \
    lsb-release && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
    $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null && \
    apt-get update && \
    apt-get install -y docker-ce-cli && \
    rm -rf /var/lib/apt/lists/*

# Erstelle Docker-Gruppe und füge Benutzer hinzu
RUN groupadd -g 999 docker && \
    useradd -r -u 999 -g docker webdock

# Python-Abhängigkeiten
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Erstelle Verzeichnisstruktur und setze Berechtigungen
RUN mkdir -p /app/static/css \
            /app/static/js \
            /app/static/img/icons \
            /app/templates \
            /app/docker-compose-files \
            /app/config \
            /app/data

# Kopiere die Anwendungsdateien
COPY src/app.py /app/
COPY src/templates/ /app/templates/
COPY src/static/ /app/static/
COPY src/config/ /app/config/
COPY docker-compose-files/ /app/docker-compose-files/

# Kopiere Icons aus docker-compose-files
COPY docker-compose-files/webdock-ui/src/static/img/icons/* /app/static/img/icons/

# Erstelle ein Startup-Script
COPY <<'EOF' /app/entrypoint.sh
#!/bin/sh
# Setze Berechtigungen für gemountete Verzeichnisse
mkdir -p /app/config /app/data
chown -R webdock:docker /app/config /app/data
chmod -R 777 /app/config /app/data

# Kopiere Standard-Kategorien, wenn sie nicht existieren
if [ ! -f /app/config/categories.yaml ]; then
    cp /app/src/config/categories.yaml /app/config/
fi

# Starte die Anwendung
exec python3 /app/app.py
EOF

RUN chmod +x /app/entrypoint.sh

# Setze Berechtigungen
RUN chown -R webdock:docker /app && \
    chmod -R 755 /app

# Setze Umgebungsvariablen
ENV FLASK_APP=app.py
ENV FLASK_ENV=development
ENV FLASK_DEBUG=1
ENV PYTHONUNBUFFERED=1
ENV CONFIG_DIR=/app/config

EXPOSE 80

# Healthcheck
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl -f http://localhost/test || exit 1

# Starte die Flask-App über das Entrypoint-Script
CMD ["/app/entrypoint.sh"] 