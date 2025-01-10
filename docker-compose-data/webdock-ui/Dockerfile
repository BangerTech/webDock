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

# Python-Abhängigkeiten
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Erstelle Verzeichnisstruktur
RUN mkdir -p /app/static/css \
            /app/static/js \
            /app/static/img/icons \
            /app/templates \
            /app/docker-compose-files \
            /app/config

# Kopiere die Anwendungsdateien
COPY src/app.py /app/
COPY src/templates/ /app/templates/
COPY src/static/ /app/static/
COPY src/config/ /app/config/
COPY docker-compose-files/ /app/docker-compose-files/

# Kopiere Icons aus docker-compose-files in das static/img/icons Verzeichnis
RUN cp -r /app/docker-compose-files/webdock-ui/src/static/img/icons/* /app/static/img/icons/ || true

# Setze Berechtigungen
RUN chmod -R 755 /app
RUN chown -R root:root /app

# Setze Umgebungsvariablen
ENV FLASK_APP=app.py
ENV FLASK_ENV=development
ENV FLASK_DEBUG=1
ENV PYTHONUNBUFFERED=1

EXPOSE 80

# Healthcheck
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl -f http://localhost/test || exit 1

# Starte die Flask-App
CMD ["python3", "/app/app.py"] 