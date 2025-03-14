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
            /app/static/img \
            /app/templates \
            /app/docker-compose-files \
            /app/config

# Kopiere die Anwendung
COPY src/app.py /app/
COPY src/templates/ /app/templates/
COPY src/static/css/ /app/static/css/
COPY src/static/js/ /app/static/js/
COPY src/config/ /app/config/

# Setze Berechtigungen
RUN chmod -R 755 /app/static
RUN chown -R root:root /app/static

# Setze Umgebungsvariablen
ENV FLASK_APP=app.py
ENV FLASK_ENV=development
ENV FLASK_DEBUG=1
ENV PYTHONUNBUFFERED=1

EXPOSE 80

# Healthcheck
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl -f http://localhost/test || exit 1

# Starte die Flask-App direkt
CMD ["python3", "/app/app.py"] 