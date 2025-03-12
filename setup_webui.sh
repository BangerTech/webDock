#!/bin/bash

# Definiere Verzeichnisse
BASE_DIR="/home/webDock/docker-compose-data/webdock-ui"
SRC_DIR="$BASE_DIR/src"
CONFIG_DIR="/home/webDock/docker-compose-data/config"

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

# Erstelle Scripts-Verzeichnis und Netzwerk-Erkennungsskript
echo "=== Setting up network detection script ==="
sudo mkdir -p /home/webDock/scripts
sudo tee /home/webDock/scripts/detect_network.sh > /dev/null << 'EOF'
#!/bin/bash

# Skript zur Erkennung des Netzwerk-Interfaces und der IP-Adresse
# Dieses Skript wird außerhalb des Containers ausgeführt

# Ausgabedatei
OUTPUT_FILE="/home/webDock/docker-compose-data/config/network_info.json"

# Verzeichnis erstellen, falls es nicht existiert
mkdir -p "$(dirname "$OUTPUT_FILE")"

# Ermittle das aktive Netzwerk-Interface (ohne lo, docker, veth, br-)
INTERFACES=$(ip a | grep -E "^[0-9]" | grep -v "lo:" | grep "state UP" | awk -F': ' '{print $2}' | grep -v -E '^(docker|veth|br-)')
MAIN_INTERFACE=$(echo "$INTERFACES" | head -n 1)

if [ -z "$MAIN_INTERFACE" ]; then
    # Fallback: Verwende das erste Interface, das nicht lo ist
    MAIN_INTERFACE=$(ip a | grep -E "^[0-9]" | grep -v "lo:" | awk -F': ' '{print $2}' | head -n 1)
fi

# Ermittle die IP-Adresse des Interfaces
IP_ADDRESS=$(ip addr show $MAIN_INTERFACE | grep "inet " | awk '{print $2}' | cut -d/ -f1)
SUBNET_MASK=$(ip addr show $MAIN_INTERFACE | grep "inet " | awk '{print $2}' | cut -d/ -f2)

# Berechne den IP-Bereich
IP_PARTS=(${IP_ADDRESS//./ })
IP_RANGE="${IP_PARTS[0]}.${IP_PARTS[1]}.${IP_PARTS[2]}.0/24"

# Schreibe die Informationen in die Ausgabedatei
echo "{
  \"interface\": \"$MAIN_INTERFACE\",
  \"ip_address\": \"$IP_ADDRESS\",
  \"subnet_mask\": \"$SUBNET_MASK\",
  \"ip_range\": \"$IP_RANGE\"
}" > "$OUTPUT_FILE"

echo "Netzwerkinformationen wurden in $OUTPUT_FILE gespeichert:"
cat "$OUTPUT_FILE"

# Setze die Berechtigungen, damit der Container die Datei lesen kann
chmod 644 "$OUTPUT_FILE"
EOF

# Mache das Skript ausführbar
sudo chmod +x /home/webDock/scripts/detect_network.sh

# Führe das Skript aus, um die Netzwerkinformationen zu ermitteln
echo "=== Detecting network information ==="
sudo /home/webDock/scripts/detect_network.sh

# Füge einen Cron-Job hinzu, um die Netzwerkinformationen regelmäßig zu aktualisieren
echo "=== Setting up cron job for network detection ==="
(crontab -l 2>/dev/null | grep -v "detect_network.sh"; echo "*/5 * * * * /home/webDock/scripts/detect_network.sh > /dev/null 2>&1") | crontab -

# Lösche altes Verzeichnis falls vorhanden
if [ -d "$BASE_DIR" ]; then
    echo "Removing old installation..."
    sudo rm -rf "$BASE_DIR"
fi

echo "Creating directory structure..."
# Erstelle Verzeichnisstruktur
sudo mkdir -p "$SRC_DIR/static/css"
sudo mkdir -p "$SRC_DIR/static/js"
sudo mkdir -p "$SRC_DIR/static/img"
sudo mkdir -p "$SRC_DIR/static/img/icons"  # Erstelle icons Verzeichnis
sudo mkdir -p "$SRC_DIR/templates"
sudo mkdir -p "$SRC_DIR/config"
sudo mkdir -p "$CONFIG_DIR"

echo "Copying files..."
# Lade Dateien von GitHub herunter
GITHUB_RAW_URL="https://raw.githubusercontent.com/BangerTech/webDock/main"

echo "Downloading files from GitHub..."

# Liste der zu ladenden Dateien
FILES=(
    "docker-compose-files/webdock-ui/docker-compose.yml:$BASE_DIR/docker-compose.yml"
    "docker-compose-files/webdock-ui/Dockerfile:$BASE_DIR/Dockerfile"
    "docker-compose-files/webdock-ui/requirements.txt:$BASE_DIR/requirements.txt"
    "docker-compose-files/webdock-ui/src/app.py:$SRC_DIR/app.py"
    "docker-compose-files/webdock-ui/src/templates/index.html:$SRC_DIR/templates/index.html"
    "docker-compose-files/webdock-ui/src/static/css/style.css:$SRC_DIR/static/css/style.css"
    "docker-compose-files/webdock-ui/src/static/js/main.js:$SRC_DIR/static/js/main.js"
)

# Lade jede Datei herunter
for file in "${FILES[@]}"; do
    src="${file%%:*}"
    dst="${file#*:}"
    echo "Downloading $src to $dst"
    sudo curl -sSL "$GITHUB_RAW_URL/$src" -o "$dst" || { echo "Error downloading $src"; exit 1; }
done

# Lade Logo und Icons herunter
echo "Downloading logo and icons..."
sudo curl -sSL "$GITHUB_RAW_URL/docker-compose-files/webdock-ui/src/static/img/logo1.png" -o "$SRC_DIR/static/img/logo1.png" || { echo "Warning: Could not download logo1.png"; }

# Lade Container-Icons herunter
echo "Downloading container icons..."
ICONS_DIR="$SRC_DIR/static/img/icons"
sudo mkdir -p "$ICONS_DIR"

# Hole die Liste der Icons von GitHub
echo "Fetching icons list..."
ICONS_LIST=$(curl -sSL "https://api.github.com/repos/BangerTech/webDock/contents/docker-compose-files/webdock-ui/src/static/img/icons" | grep download_url | cut -d'"' -f4)

# Lade jedes Icon herunter
for icon_url in $ICONS_LIST; do
    icon_name=$(basename "$icon_url")
    echo "Downloading $icon_name..."
    sudo curl -sSL "$icon_url" -o "$ICONS_DIR/$icon_name" || { echo "Warning: Could not download $icon_name"; }
done

# Lade Konfigurationsdateien herunter
echo "Downloading config files..."
sudo curl -sSL "$GITHUB_RAW_URL/docker-compose-files/webdock-ui/src/config/categories.yaml" -o "$SRC_DIR/config/categories.yaml" || { echo "Error downloading categories.yaml"; exit 1; }

# Lade Docker-Compose-Dateien herunter
echo "Downloading docker-compose files..."
sudo mkdir -p "$SRC_DIR/docker-compose-files"

# Hole die Liste der Container-Verzeichnisse von GitHub
echo "Fetching container list..."
CONTAINERS=$(curl -sSL "https://api.github.com/repos/BangerTech/webDock/contents/docker-compose-files" | grep '"name":' | grep -v 'webdock-ui' | cut -d'"' -f4)

# Lade die docker-compose.yml für jeden Container herunter
for container in $CONTAINERS; do
    echo "Downloading $container..."
    container_dir="$SRC_DIR/docker-compose-files/$container"
    sudo mkdir -p "$container_dir"
    sudo curl -sSL "$GITHUB_RAW_URL/docker-compose-files/$container/docker-compose.yml" -o "$container_dir/docker-compose.yml" || { echo "Warning: Could not download $container/docker-compose.yml"; }
done

# Setze Berechtigungen
sudo chown -R $USER:$USER "$BASE_DIR"
sudo chmod -R 755 "$BASE_DIR"

# Erstelle eine Kopie der Docker-Compose-Datei im Hauptverzeichnis
echo "Creating docker-compose.yml in main directory..."
sudo cp "$BASE_DIR/docker-compose.yml" "/home/webDock/docker-compose.yml"
sudo chown $USER:$USER "/home/webDock/docker-compose.yml"
sudo chmod 644 "/home/webDock/docker-compose.yml"

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

# Erstelle Docker-Netzwerk für WebDock
echo "=== Creating Docker network ==="
if ! sudo docker network inspect webdock-network >/dev/null 2>&1; then
    echo "Creating webdock-network..."
    sudo docker network create webdock-network
else
    echo "webdock-network already exists"
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
