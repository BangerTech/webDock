# webDock

![Docker](https://img.shields.io/badge/docker-%230db7ed.svg?style=for-the-badge&logo=docker&logoColor=white)
![Flask](https://img.shields.io/badge/flask-%23000.svg?style=for-the-badge&logo=flask&logoColor=white)
![Python](https://img.shields.io/badge/python-3670A0?style=for-the-badge&logo=python&logoColor=ffdd54)
[![License](https://img.shields.io/github/license/BangerTech/webDock?style=for-the-badge)](LICENSE)

![weDock Logo](images/webdock-logo.png)

> 🐳 A modern web interface for managing Docker containers and services on Debian-based systems

## Screenshots


<img src="images/screenshots/dashboard-light.png" width="49%" /> <img src="images/screenshots/dashboard-dark.png" width="49%" />

<img src="images/screenshots/status.png" width="49%" /> <img src="images/screenshots/special.png" width="49%" />

## Table of Contents
- [What is webDock?](#what-is-webdock)
- [Setup & Requirements](#setup--requirements)
- [Usage](#usage)
- [Support / Feedback](#support--feedback)
- [Contributing](#contributing)
- [Sponsorship](#sponsorship)

## What is webDock?
webDock is a powerful tool for managing and installing software on Debian-based systems. It provides a user-friendly interface for managing Docker containers and other software solutions.

### Features
- 🚀 One-click container deployment
- 🔄 Automatic container updates
- 📊 System monitoring and statistics
- 🌙 Dark/Light theme support
- 🔧 Easy configuration management
- 📱 Responsive design
- 🖥️ SSH Terminal access
- 📁 SFTP File Explorer
- ⏰ Cron Job Editor for automated system shutdown/wakeup
- 🔀 Drag & Drop interface for organizing containers

### Architecture Support
WebDock fully supports both ARM (Raspberry Pi) and x86/x64 architectures. The system automatically detects your architecture and installs the appropriate version of each container.

### Supported Containers
1. **openHAB** - Open Home Automation Bus
2. **Home Assistant** - Open-source home automation platform
3. **HomeBridge** - HomeKit support for non-native devices
4. **RaspberryMatic** - Homematic central control unit
5. **Zigbee2MQTT** - Zigbee devices to MQTT bridge
6. **Mosquitto Broker** - MQTT message broker for IoT
7. **Dockge** - Docker compose stack manager
8. **Portainer** - Container management UI
9. **Grafana** - Analytics and monitoring platform
10. **InfluxDB** - Time series database (ARM and x86 versions)
11. **Code Server** - VS Code in the browser
12. **File Browser** - Web-based file manager
13. **Filestash** - Modern web file manager
14. **WatchYourLAN** - Network device monitoring (ARM and x86 versions)
15. **WhatsUpDocker (WUD)** - Docker container update monitoring
16. **Frontail** - Web-based log viewer
17. **Node Exporter** - Hardware and OS metrics exporter
18. **Prometheus** - Monitoring and alerting toolkit
19. **Dozzle** - Real-time Docker log viewer
20. **Hoarder** - Media management platform
21. **Heimdall** - Application dashboard
22. **Homepage** - Modern service dashboard
23. **Jellyfin** - Media server
24. **Node-RED** - Flow-based programming for IoT
25. **Paperless-ngx** - Document management system
26. **Scrypted** - Home automation server
27. **Spoolman** - 3D printing filament manager
28. **Uptime Kuma** - Uptime monitoring tool
29. **Bambucam** - Live camera streaming

## Technologies
- Python 3.9+
- Flask web framework
- Docker & Docker Compose
- JavaScript (ES6+)
- YAML for configuration

## Setup & Requirements
- **sudo** should be installed
- **$USER** needs to be a member of the _sudo_ group
- Add **%sudo  ALL=(ALL) NOPASSWD:ALL** with _visudo_
- Docker + Docker-Compose are **required** for all container-based programs
- The setup script allows installation in any directory of your choice
- Supports both ARM (Raspberry Pi) and x86/x64 architectures

## Usage

### Simple Installation (Recommended):

1. Navigate to the directory where you want to install webDock:
   ```bash
   cd /your/preferred/directory
   ```

2. Download the setup script:
   ```bash
   wget https://raw.githubusercontent.com/BangerTech/webDock/main/setup_webDock.sh
   ```

3. Make the script executable:
   ```bash
   chmod +x setup_webDock.sh
   ```

4. Run the setup script:
   ```bash
   ./setup_webDock.sh
   ```

5. The script will automatically create a `webDock` directory in your current location and set up everything needed.

6. Once installed, launch the webDock UI and start installing containers through the interface.

## Installation

The setup script is currently the only supported installation method. It handles all the necessary setup automatically, including:

1. Creating the required directory structure
2. Setting up configuration files
3. Configuring paths correctly
4. Installing and starting the webDock UI container

We recommend following the Simple Installation instructions above for the best experience.

## Support / Feedback
Any bugs or feature requests? Contact me [here](https://github.com/bangertech) or click on the "Issues" tab in the GitHub repository!

## Contributing
Fork the repository and create pull requests.

## Sponsorship

<a href="https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=FD26FHKRWS3US" target="_blank"><img src="https://pics.paypal.com/00/s/N2EwMzk4NzUtOTQ4Yy00Yjc4LWIwYmUtMTA3MWExNWIzYzMz/file.PNG" alt="SUPPORT" height="51"></a>

## Keywords
`docker-management` `container-management` `web-ui` `docker-compose` `system-monitoring` 
`home-automation` `iot` `smart-home` `monitoring` `dashboard` `debian` `raspberry-pi` 
`docker-gui` `container-deployment` `devops` `self-hosted` `open-source`
