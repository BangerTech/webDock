FROM python:3.9-slim
WORKDIR /app

# System-Abhängigkeiten
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Python-Abhängigkeiten
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Erstelle Verzeichnisse
RUN mkdir -p /app/static/css \
            /app/static/js \
            /app/static/img/icons \
            /app/templates \
            /app/docker-compose-files

# Kopiere die Anwendung
COPY src/app.py /app/
COPY src/templates/ /app/templates/
COPY src/static/css/ /app/static/css/
COPY src/static/js/ /app/static/js/

# Kopiere die Icons
COPY src/static/img/icons/*.png /app/static/img/icons/

# Debug: Zeige Verzeichnisinhalt
RUN echo "=== Checking icons directory ===" && \
    ls -la /app/static/img/icons/

# Setze Berechtigungen
RUN chmod -R 755 /app/static
RUN chown -R root:root /app/static

# Debug-Ausgabe
RUN echo "=== Directory Structure ===" && \
    ls -la /app && \
    echo "\n=== Static Files ===" && \
    ls -la /app/static && \
    echo "\n=== Static Image Files ===" && \
    ls -la /app/static/img && \
    echo "\n=== Image Files Contents ===" && \
    find /app/static/img -type f -exec file {} \; && \
    echo "\n=== Templates ===" && \
    ls -la /app/templates

# Setze Umgebungsvariablen
ENV FLASK_APP=app.py
ENV FLASK_ENV=development
ENV FLASK_DEBUG=1
ENV PYTHONUNBUFFERED=1

EXPOSE 80

# Healthcheck
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl -f http://localhost/test || exit 1

# Starte mit Shell-Wrapper für besseres Debugging
CMD ["sh", "-c", "ls -la /app && echo 'Starting Flask...' && python -u app.py"] 