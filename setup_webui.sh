#!/bin/bash

# Definiere Verzeichnisse
BASE_DIR="/home/webDock/docker-compose-data/bangertech-ui"
SRC_DIR="$BASE_DIR/src"

echo "=== Starting Web UI Setup ==="

# Prüfe ob Docker läuft
if ! sudo docker info >/dev/null 2>&1; then
    echo "Error: Docker is not running. Please start Docker first."
    exit 1
fi

# Erstelle webDock Verzeichnis falls nicht vorhanden
if [ ! -d "/home/webDock" ]; then
    echo "Creating webDock directory..."
    sudo mkdir -p /home/webDock
    sudo chown -R $USER:$USER /home/webDock
fi

# Lösche altes Verzeichnis falls vorhanden
if [ -d "$BASE_DIR" ]; then
    echo "Removing old installation..."
    sudo rm -rf "$BASE_DIR"
fi

echo "Creating directory structure..."
# Erstelle neue Verzeichnisstruktur
sudo mkdir -p "$SRC_DIR/static/css"
sudo mkdir -p "$SRC_DIR/static/js"
sudo mkdir -p "$SRC_DIR/static/img"
sudo mkdir -p "$SRC_DIR/templates"

echo "Copying files..."
# Kopiere Dateien
sudo cp docker-compose-files/bangertech-ui/docker-compose.yml "$BASE_DIR/" || { echo "Error copying docker-compose.yml"; exit 1; }
sudo cp docker-compose-files/bangertech-ui/Dockerfile "$BASE_DIR/" || { echo "Error copying Dockerfile"; exit 1; }
sudo cp docker-compose-files/bangertech-ui/requirements.txt "$BASE_DIR/" || { echo "Error copying requirements.txt"; exit 1; }
sudo cp docker-compose-files/bangertech-ui/src/app.py "$SRC_DIR/" || { echo "Error copying app.py"; exit 1; }
sudo cp docker-compose-files/bangertech-ui/src/templates/index.html "$SRC_DIR/templates/" || { echo "Error copying index.html"; exit 1; }
sudo cp docker-compose-files/bangertech-ui/src/static/css/style.css "$SRC_DIR/static/css/" || { echo "Error copying style.css"; exit 1; }
sudo cp docker-compose-files/bangertech-ui/src/static/js/main.js "$SRC_DIR/static/js/" || { echo "Error copying main.js"; exit 1; }

# Neue Zeile
sudo cp "docker-compose-files/bangertech-ui/src/static/img/logo.png" "$SRC_DIR/static/img/logo.png" || { echo "Error copying logo.png"; exit 1; }

# Setze Berechtigungen
sudo chown -R $USER:$USER "$BASE_DIR"
sudo chmod -R 755 "$BASE_DIR"

echo "=== Verifying setup ==="
echo "Directory structure:"
ls -R "$BASE_DIR"

echo "=== Checking critical files ==="
MISSING_FILES=0
for file in \
    "$SRC_DIR/templates/index.html" \
    "$SRC_DIR/static/css/style.css" \
    "$SRC_DIR/static/js/main.js" \
    "$SRC_DIR/app.py"
do
    if [ -f "$file" ]; then
        echo "✓ $file exists"
    else
        echo "✗ $file is missing!"
        MISSING_FILES=$((MISSING_FILES+1))
    fi
done

if [ $MISSING_FILES -gt 0 ]; then
    echo "Error: $MISSING_FILES critical files are missing!"
    exit 1
fi

echo "=== Starting container ==="
# Neustart des Containers
cd "$BASE_DIR" || { echo "Error: Could not change to $BASE_DIR"; exit 1; }
sudo docker compose down

echo "=== Starting container with live logs ==="
echo "Press Ctrl+C to stop viewing logs (container will continue running)"
sudo docker compose up --build

# Die folgenden Tests werden nur ausgeführt, wenn man das Script mit dem Parameter --test aufruft
if [ "$1" == "--test" ]; then
    echo "=== Testing server ==="
    echo "Testing /test endpoint:"
    curl -v http://localhost:8585/test

    echo -e "\nGetting debug info:"
    curl -v http://localhost:8585/debug

    echo -e "\nTrying main page:"
    curl -v http://localhost:8585/
fi

echo -e "\nSetup complete. Container is running with live logs."

# Am Anfang des Scripts nach den Verzeichnis-Definitionen
if [ -d "/home/The-BangerTECH-Utility-main" ]; then
    echo "Warning: Found existing BangerTECH Utility installation"
    echo "The Web UI will be installed in parallel and won't affect the existing installation"
fi
