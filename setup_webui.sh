#!/bin/bash

# Definiere Verzeichnisse
BASE_DIR="$HOME/docker-compose-data/bangertech-ui"
SRC_DIR="$BASE_DIR/src"

echo "=== Starting Web UI Setup ==="

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
sudo cp docker-compose-files/bangertech-ui/docker-compose.yml "$BASE_DIR/"
sudo cp docker-compose-files/bangertech-ui/Dockerfile "$BASE_DIR/"
sudo cp docker-compose-files/bangertech-ui/requirements.txt "$BASE_DIR/"
sudo cp docker-compose-files/bangertech-ui/src/app.py "$SRC_DIR/"
sudo cp docker-compose-files/bangertech-ui/src/templates/index.html "$SRC_DIR/templates/"
sudo cp docker-compose-files/bangertech-ui/src/static/css/style.css "$SRC_DIR/static/css/"
sudo cp docker-compose-files/bangertech-ui/src/static/js/main.js "$SRC_DIR/static/js/"
sudo cp "$HOME/logo.txt" "$SRC_DIR/static/img/logo.png"

# Setze Berechtigungen
sudo chown -R $USER:$USER "$BASE_DIR"
sudo chmod -R 755 "$BASE_DIR"

echo "=== Verifying setup ==="
echo "Directory structure:"
ls -R "$BASE_DIR"

echo "=== Checking critical files ==="
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
    fi
done

echo "=== Starting container ==="
# Neustart des Containers
cd "$BASE_DIR"
sudo docker compose down
sudo docker compose up --build -d

echo "=== Testing server ==="
sleep 5

echo "Testing /test endpoint:"
curl -v http://localhost:8585/test

echo -e "\nGetting debug info:"
curl -v http://localhost:8585/debug

echo -e "\nTrying main page:"
curl -v http://localhost:8585/

echo -e "\nSetup complete. Check the logs above for any errors."
