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
    useradd -r -u 999 -g docker webdock && \
    mkdir -p /home/webdock && \
    chown -R webdock:docker /home/webdock

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
            /app/data && \
    chown -R webdock:docker /app && \
    chmod -R 755 /app && \
    chmod -R 777 /app/config /app/data

# Kopiere die Anwendungsdateien
COPY --chown=webdock:docker src/app.py /app/
COPY --chown=webdock:docker src/templates/ /app/templates/
COPY --chown=webdock:docker src/static/ /app/static/
COPY --chown=webdock:docker src/config/ /app/config/
COPY --chown=webdock:docker docker-compose-files/ /app/docker-compose-files/

# Kopiere Icons aus docker-compose-files
COPY --chown=webdock:docker docker-compose-files/webdock-ui/src/static/img/icons/* /app/static/img/icons/

# Kopiere die Standard-Kategorien-Datei
COPY --chown=webdock:docker src/config/categories.yaml /app/config/categories.yaml

# Setze Umgebungsvariablen
ENV FLASK_APP=app.py
ENV FLASK_ENV=development
ENV FLASK_DEBUG=1
ENV PYTHONUNBUFFERED=1
ENV CONFIG_DIR=/app/config
ENV HOME=/app

EXPOSE 80

# Wechsle zum webdock Benutzer
USER webdock

# Healthcheck
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl -f http://localhost/test || exit 1

# Starte die Flask-App
CMD ["python3", "/app/app.py"] 