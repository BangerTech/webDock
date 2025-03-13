#!/bin/bash

# Einfaches Setup-Script für WebDock
# Dieses Script automatisch erkennt, wo es ausgeführt wird und installiert WebDock entsprechend

# Ermittle den aktuellen Ausführungspfad
CURRENT_DIR="$(pwd)"

# Definiere Basisverzeichnis - Füge "webDock" an den aktuellen Pfad an
INSTALL_DIR="$CURRENT_DIR/webDock"

# Definiere Verzeichnisse basierend auf INSTALL_DIR
BASE_DIR="$INSTALL_DIR/docker-compose-data/webdock-ui"
SRC_DIR="$BASE_DIR/src"
CONFIG_DIR="$INSTALL_DIR/docker-compose-data/config"
COMPOSE_FILES_DIR="$INSTALL_DIR/docker-templates"
COMPOSE_DATA_DIR="$INSTALL_DIR/docker-compose-data"

echo "=== Installing WebDock in $INSTALL_DIR ==="
echo "    Container data will be stored in: $COMPOSE_DATA_DIR"

echo "=== Starting Web UI Setup ==="

# Prüfe ob Docker läuft
if ! sudo docker info >/dev/null 2>&1; then
    echo "Error: Docker is not running. Please start Docker first."
    exit 1
fi

# Erstelle Installations-Verzeichnis falls nicht vorhanden
if [ ! -d "$INSTALL_DIR" ]; then
    echo "Creating installation directory $INSTALL_DIR..."
    sudo mkdir -p "$INSTALL_DIR"
    sudo chown -R $USER:$USER "$INSTALL_DIR"
fi

# Erstelle Scripts-Verzeichnis und Netzwerk-Erkennungsskript
echo "=== Setting up network detection script ==="
sudo mkdir -p "$INSTALL_DIR/scripts"

# Modifiziere das Skript, um den dynamischen Pfad zu verwenden
cat << 'EOF' | sudo tee "$INSTALL_DIR/scripts/detect_network.sh" > /dev/null
#!/bin/bash

# Skript zur Erkennung des Netzwerk-Interfaces und der IP-Adresse
# Dieses Skript wird außerhalb des Containers ausgeführt

# Ausgabedatei mit dynamischem Pfad
OUTPUT_FILE="${INSTALL_DIR}/docker-compose-data/config/network_info.json"

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
sudo chmod +x "$INSTALL_DIR/scripts/detect_network.sh"

# Führe das Skript aus, um die Netzwerkinformationen zu ermitteln
echo "=== Detecting network information ==="
sudo "$INSTALL_DIR/scripts/detect_network.sh"

# Füge einen Cron-Job hinzu, um die Netzwerkinformationen regelmäßig zu aktualisieren
echo "=== Setting up cron job for network detection ==="
(crontab -l 2>/dev/null | grep -v "detect_network.sh"; echo "*/5 * * * * $INSTALL_DIR/scripts/detect_network.sh > /dev/null 2>&1") | crontab -

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

# Definiere GitHub URLs
GITHUB_BRANCH="main"
GITHUB_RAW_URL="https://raw.githubusercontent.com/BangerTech/webDock/$GITHUB_BRANCH"

# Funktion zum Kopieren lokaler Dateien
copy_local_files() {
    echo "Using local files..."
    # Kopiere Basis-Dateien
    sudo cp docker-templates/webdock-ui/docker-compose.yml "$BASE_DIR/" || return 1
    sudo cp docker-templates/webdock-ui/Dockerfile "$BASE_DIR/" || return 1
    sudo cp docker-templates/webdock-ui/requirements.txt "$BASE_DIR/" || return 1
    
    # Modify app.py to use local files directly instead of copying them
    # Create the local_compose_dir variable in app.py to match the structure
    local_app_content=$(cat docker-templates/webdock-ui/src/app.py)
    
    # Make sure app.py is configured to use local files and paths
    # Get the app.py from local directory with local file path handling
    modified_app_content="$(cat docker-templates/webdock-ui/src/app.py | \
      sed "s|COMPOSE_FILES_DIR = .*|COMPOSE_FILES_DIR = '$COMPOSE_FILES_DIR'|g" | \
      sed "s|WEBDOCK_BASE_PATH = .*|WEBDOCK_BASE_PATH = '$INSTALL_DIR'|g" | \
      sed "s|COMPOSE_DATA_DIR = .*|COMPOSE_DATA_DIR = '$COMPOSE_DATA_DIR'|g")"
    echo "$modified_app_content" | sudo tee "$SRC_DIR/app.py" > /dev/null || return 1
    
    sudo cp docker-templates/webdock-ui/src/templates/index.html "$SRC_DIR/templates/" || return 1
    sudo cp docker-templates/webdock-ui/src/static/css/style.css "$SRC_DIR/static/css/" || return 1
    sudo cp docker-templates/webdock-ui/src/static/js/main.js "$SRC_DIR/static/js/" || return 1
    
    # Kopiere Logo und Icons
    sudo cp docker-templates/webdock-ui/src/static/img/logo1.png "$SRC_DIR/static/img/" || echo "Warning: Could not copy logo1.png"
    sudo cp docker-templates/webdock-ui/src/static/img/icons/* "$SRC_DIR/static/img/icons/" || echo "Warning: Could not copy icons"
    
    # Kopiere Konfigurationsdateien
    sudo cp docker-templates/webdock-ui/src/config/categories.yaml "$SRC_DIR/config/" || return 1
    
    # Don't copy Docker-Compose-Dateien, use them directly from their original location
    # Instead of creating a nested symbolic link, we ensure the app uses the correct environment variables
    
    echo "Using local docker-compose files directly from $COMPOSE_FILES_DIR"
    return 0
}

# Funktion zum Herunterladen von GitHub
download_from_github() {
    echo "Downloading files from GitHub..."
    # Liste der zu ladenden Dateien
    FILES=(
        "docker-templates/webdock-ui/docker-compose.yml:$BASE_DIR/docker-compose.yml"
        "docker-templates/webdock-ui/Dockerfile:$BASE_DIR/Dockerfile"
        "docker-templates/webdock-ui/requirements.txt:$BASE_DIR/requirements.txt"
        "docker-templates/webdock-ui/src/app.py:$SRC_DIR/app.py"
        "docker-templates/webdock-ui/src/templates/index.html:$SRC_DIR/templates/index.html"
        "docker-templates/webdock-ui/src/static/css/style.css:$SRC_DIR/static/css/style.css"
        "docker-templates/webdock-ui/src/static/js/main.js:$SRC_DIR/static/js/main.js"
        "docker-templates/webdock-ui/src/static/img/logo1.png:$SRC_DIR/static/img/logo1.png"
        "docker-templates/webdock-ui/src/config/categories.yaml:$SRC_DIR/config/categories.yaml"
    )

    # Lade jede Datei herunter
    for file in "${FILES[@]}"; do
        src="${file%%:*}"
        dst="${file#*:}"
        echo "Downloading $src..."
        if ! sudo curl -sSL "$GITHUB_RAW_URL/$src" -o "$dst"; then
            echo "Error: Failed to download $src from $GITHUB_RAW_URL/$src"
            echo "Please check if the repository is public and the file exists."
            return 1
        fi
        # Prüfe, ob die Datei tatsächlich Inhalt hat
        if [ ! -s "$dst" ]; then
            echo "Error: Downloaded file $dst is empty."
            echo "Please check if the repository is public and the file exists."
            return 1
        fi
    done

    # Standard-Container definieren
    DEFAULT_CONTAINERS=(
        "pihole"
        "portainer"
        "nextcloud"
        "jellyfin"
        "homeassistant"
        "grafana"
    )

    # Lade die docker-compose.yml für jeden Standard-Container
    for container in "${DEFAULT_CONTAINERS[@]}"; do
        echo "Downloading $container docker-compose.yml..."
        sudo mkdir -p "$SRC_DIR/docker-templates/$container"
        
        # Versuche die docker-compose.yml herunterzuladen
        if ! sudo curl -sSL "$GITHUB_RAW_URL/docker-templates/$container/docker-compose.yml" \
                -o "$SRC_DIR/docker-templates/$container/docker-compose.yml"; then
            echo "Warning: Could not download $container/docker-compose.yml"
        elif [ ! -s "$SRC_DIR/docker-templates/$container/docker-compose.yml" ]; then
            echo "Warning: Downloaded docker-compose.yml for $container is empty"
            # Lösche leere Datei
            sudo rm "$SRC_DIR/docker-templates/$container/docker-compose.yml"
        else
            echo "Successfully downloaded docker-compose.yml for $container"
        fi

        # Lade auch das Icon herunter
        echo "Downloading icon for $container..."
        if ! sudo curl -sSL "$GITHUB_RAW_URL/docker-templates/webdock-ui/src/static/img/icons/$container.png" \
                -o "$SRC_DIR/static/img/icons/$container.png"; then
            echo "Warning: Could not download icon for $container"
        elif [ ! -s "$SRC_DIR/static/img/icons/$container.png" ]; then
            echo "Warning: Downloaded icon for $container is empty"
            # Lösche leere Datei
            sudo rm "$SRC_DIR/static/img/icons/$container.png"
        else
            echo "Successfully downloaded icon for $container"
        fi
    done
    return 0
}

# Versuche zuerst lokale Dateien zu kopieren
echo "Copying files..."
if [ -d "docker-templates/webdock-ui" ]; then
    echo "Local files found in docker-templates/webdock-ui"
    copy_local_files || {
        echo "Error copying local files, falling back to GitHub..."
        download_from_github || { echo "Error downloading files from GitHub"; exit 1; }
    }
else
    echo "No local files found, downloading from GitHub..."
    download_from_github || { echo "Error downloading files from GitHub"; exit 1; }
fi

# Setze Berechtigungen
sudo chown -R $USER:$USER "$BASE_DIR"
sudo chmod -R 755 "$BASE_DIR"

# Wir erstellen keinen symbolischen Link zur docker-compose.yml im Hauptverzeichnis
# So vermeiden wir Verwirrung durch doppelte docker-compose.yml Dateien
echo "WebDock docker-compose.yml is located at: $BASE_DIR/docker-compose.yml"

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

# Set environment variables for Docker Compose
export WEBDOCK_INSTALL_DIR="$INSTALL_DIR"
echo "Setting WEBDOCK_INSTALL_DIR=$WEBDOCK_INSTALL_DIR"

echo "=== Starting container with live logs ==="
echo "Press Ctrl+C to stop viewing logs (container will continue running)"
sudo -E docker compose up --build

# Die folgenden Tests werden nur ausgeführt, wenn man das Script mit dem Parameter --test aufruft
# Zeige Informationshinweis nach der Installation
echo "=== Installation Information ==="
echo "WebDock wurde in $INSTALL_DIR installiert."
echo "Container-Daten werden in $COMPOSE_DATA_DIR gespeichert."
echo "Sie können diesen Pfad später in den Einstellungen der WebDock-UI ändern."
echo ""

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
