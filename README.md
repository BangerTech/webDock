# webDock

![weDock Logo](images/webdock-logo.png)

## Screenshots

<img src="images/screenshots/dashboard-light.png" width="49%" /> <img src="images/screenshots/dashboard-dark.png" width="49%" />

<img src="images/screenshots/status.png" width="49%" /> <img src="images/screenshots/special.png" width="49%" />

## Inhaltsverzeichnis
- [Was ist webDock?](#was-ist-webdock)
- [Setup & Anforderungen](#setup--anforderungen)
- [Verwendung](#verwendung)
- [Unterstützung / Feedback](#unterstützung--feedback)
- [Mitwirken](#mitwirken)
- [Sponsoring](#sponsoring)

## Was ist webDock?
webDock ist ein leistungsstarkes Tool zur Verwaltung und Installation von Software auf Debian-basierten Systemen. Es bietet eine benutzerfreundliche Oberfläche zur Verwaltung von Docker-Containern und anderen Softwarelösungen.

### Unterstützte Container
1. **openHABian** - Smart Home Automatisierung
2. **Docker + Docker-Compose** - Container-Orchestrierung
3. **openHAB-Docker** - openHAB in einem Docker-Container
4. **Frontail** - Log-Viewer für openHAB
5. **Mosquitto Broker** - MQTT Broker für IoT-Geräte
6. **Zigbee2MQTT** - Zigbee zu MQTT Bridge
7. **Grafana** - Visualisierung und Monitoring
8. **influxDB** - Zeitreihen-Datenbank
9. **Portainer** - Docker Management UI
10. **Filestash** - Web-basierter Dateimanager
11. **Heimdall** - Anwendungs-Dashboard
12. **HomeAssistant** - Open-Source Heimautomatisierung
13. **RaspberryMatic** - Homematic Zentrale
14. **CodeServer** - VS Code im Browser
15. **Prometheus** - Monitoring und Alerting
16. **node-exporter** - Systemmetriken für Prometheus
17. **Whats up Docker** - Docker Container Monitoring
18. **WatchYourLAN** - Netzwerküberwachung
19. **Backup** - Backup-Lösungen für Linux und ARM
20. **shut-wake Script** - Automatisches Herunterfahren und Aufwachen von Systemen

## Setup & Anforderungen
- **sudo** sollte installiert sein
- **$USER** muss Mitglied der Gruppe _sudo_ sein
- Fügen Sie **%sudo  ALL=(ALL) NOPASSWD:ALL** mit _visudo_ hinzu
- Docker + Docker-Compose sind **erforderlich** für alle containerbasierten Programme

## Verwendung

### Für X86-Systeme:
1. Wechseln Sie in Ihr Home-Verzeichnis:
   ```bash
   cd $HOME
   ```
2. Laden Sie das Setup-Skript herunter:
   ```bash
   sudo wget https://raw.githubusercontent.com/BangerTech/weDock/development/setup_webui.sh
   ```
3. Machen Sie das Skript ausführbar:
   ```bash
   sudo chmod +x setup_webui.sh
   ```
4. Führen Sie das Setup-Skript aus:
   ```bash
   sh setup_webui.sh
   ```
5. Wählen Sie ein Programm aus und folgen Sie den Anweisungen des Tools.

## Unterstützung / Feedback
Bei Bugs oder Feature-Anfragen können Sie mich [hier](https://github.com/bangertech) kontaktieren oder das "Issues"-Tab im GitHub-Repository nutzen!

## Mitwirken
Forken Sie das Repository und erstellen Sie Pull-Requests.

## Sponsoring

<a href="https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=FD26FHKRWS3US" target="_blank"><img src="https://pics.paypal.com/00/s/N2EwMzk4NzUtOTQ4Yy00Yjc4LWIwYmUtMTA3MWExNWIzYzMz/file.PNG" alt="SUPPORT" height="51"></a>
