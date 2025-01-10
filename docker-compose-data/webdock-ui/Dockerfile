FROM python:3.9-slim

WORKDIR /app

# Installiere requirements
COPY requirements.txt .
RUN pip install -r requirements.txt

# Kopiere die Anwendungsdateien
COPY src/app.py .
COPY src/templates ./templates
COPY src/static ./static

# Erstelle Icons-Verzeichnis und lade Icons von GitHub
RUN apt-get update && apt-get install -y curl \
    && mkdir -p /app/static/img/icons \
    && cd /app/static/img/icons \
    && curl -L https://raw.githubusercontent.com/BangerTech/webDock/main/docker-compose-files/webdock-ui/src/static/img/icons/bangertech.png -o bangertech.png \
    && curl -L https://raw.githubusercontent.com/BangerTech/webDock/main/docker-compose-files/webdock-ui/src/static/img/icons/default.png -o default.png \
    && curl -L https://raw.githubusercontent.com/BangerTech/webDock/main/docker-compose-files/webdock-ui/src/static/img/icons/mosquitto.png -o mosquitto-broker.png \
    && curl -L https://raw.githubusercontent.com/BangerTech/webDock/main/docker-compose-files/webdock-ui/src/static/img/icons/grafana.png -o grafana.png \
    && curl -L https://raw.githubusercontent.com/BangerTech/webDock/main/docker-compose-files/webdock-ui/src/static/img/icons/heimdall.png -o heimdall.png \
    && curl -L https://raw.githubusercontent.com/BangerTech/webDock/main/docker-compose-files/webdock-ui/src/static/img/icons/homebridge.png -o homebridge.png \
    && curl -L https://raw.githubusercontent.com/BangerTech/webDock/main/docker-compose-files/webdock-ui/src/static/img/icons/prometheus.png -o prometheus.png \
    && curl -L https://raw.githubusercontent.com/BangerTech/webDock/main/docker-compose-files/webdock-ui/src/static/img/icons/portainer.png -o portainer.png \
    && curl -L https://raw.githubusercontent.com/BangerTech/webDock/main/docker-compose-files/webdock-ui/src/static/img/icons/filebrowser.png -o filebrowser.png \
    && curl -L https://raw.githubusercontent.com/BangerTech/webDock/main/docker-compose-files/webdock-ui/src/static/img/icons/openhab.png -o openhab.png \
    && curl -L https://raw.githubusercontent.com/BangerTech/webDock/main/docker-compose-files/webdock-ui/src/static/img/icons/raspberrymatic.png -o raspberrymatic.png \
    && curl -L https://raw.githubusercontent.com/BangerTech/webDock/main/docker-compose-files/webdock-ui/src/static/img/icons/homeassistant.png -o homeassistant.png \
    && curl -L https://raw.githubusercontent.com/BangerTech/webDock/main/docker-compose-files/webdock-ui/src/static/img/icons/dockge.png -o dockge.png \
    && curl -L https://raw.githubusercontent.com/BangerTech/webDock/main/docker-compose-files/webdock-ui/src/static/img/icons/codeserver.png -o code-server.png \
    && curl -L https://raw.githubusercontent.com/BangerTech/webDock/main/docker-compose-files/webdock-ui/src/static/img/icons/whatsupdocker.png -o whatsupdocker.png \
    && curl -L https://raw.githubusercontent.com/BangerTech/webDock/main/docker-compose-files/webdock-ui/src/static/img/icons/zigbee2mqtt.png -o zigbee2mqtt.png \
    && curl -L https://raw.githubusercontent.com/BangerTech/webDock/main/docker-compose-files/webdock-ui/src/static/img/icons/webdock.png -o webdock-ui.png \
    && curl -L https://raw.githubusercontent.com/BangerTech/webDock/main/docker-compose-files/webdock-ui/src/static/img/icons/frontail.png -o frontail.png \
    && curl -L https://raw.githubusercontent.com/BangerTech/webDock/main/docker-compose-files/webdock-ui/src/static/img/icons/nodeexporter.png -o node_exporter.png \
    && apt-get remove -y curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Setze Berechtigungen
RUN chmod -R 755 /app

# Starte die Anwendung
CMD ["python", "app.py"]