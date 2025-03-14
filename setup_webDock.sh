#!/bin/bash

# Einfaches Setup-Script für WebDock
# Dieses Script automatisch erkennt, wo es ausgeführt wird und installiert WebDock entsprechend

# Ermittle den aktuellen Ausführungspfad
CURRENT_DIR="$(pwd)"

# Prüfe, ob wir uns bereits in einem webDock-Verzeichnis befinden
if [[ "$(basename "$CURRENT_DIR")" == "webDock" ]]; then
    # Wenn ja, verwende das aktuelle Verzeichnis
    INSTALL_DIR="$CURRENT_DIR"
    echo "Already in a webDock directory, using current directory..."
else
    # Sonst füge webDock an den aktuellen Pfad an
    INSTALL_DIR="$CURRENT_DIR/webDock"
fi

# Definiere Verzeichnisse basierend auf INSTALL_DIR
BASE_DIR="$INSTALL_DIR/webdock-data/webdock-ui"
SRC_DIR="$BASE_DIR/src"
CONFIG_DIR="$INSTALL_DIR/webdock-data/config"
COMPOSE_FILES_DIR="$INSTALL_DIR/webdock-templates"
COMPOSE_DATA_DIR="$INSTALL_DIR/webdock-data"

echo "=== Installing WebDock in $INSTALL_DIR ==="
echo "    Container data will be stored in: $COMPOSE_DATA_DIR"

# Entferne alte docker-compose-data Verzeichnisse, wenn vorhanden
if [ -e "$INSTALL_DIR/docker-compose-data" ]; then
    echo "Removing any existing docker-compose-data directory to avoid duplicates..."
    sudo rm -rf "$INSTALL_DIR/docker-compose-data"
fi

# Stelle sicher, dass webdock-data existiert
sudo mkdir -p "$COMPOSE_DATA_DIR"

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

# Erstelle ein temporäres Script mit Platzhalter
TMP_SCRIPT="$INSTALL_DIR/scripts/detect_network.sh"

# Erstelle das Script mit PLACEHOLDER für Pfad
sudo tee "$TMP_SCRIPT" > /dev/null << 'EOF'
#!/bin/bash

# Skript zur Erkennung des Netzwerk-Interfaces und der IP-Adresse
# Dieses Skript wird außerhalb des Containers ausgeführt

# Ausgabedatei mit absolutem Pfad
OUTPUT_FILE="__INSTALL_DIR__/webdock-data/config/network_info.json"

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

# Ersetze den Platzhalter mit dem tatsächlichen Pfad
sudo sed -i "s|__INSTALL_DIR__|$INSTALL_DIR|g" "$TMP_SCRIPT"

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
# Erstelle webdock-templates Verzeichnis
sudo mkdir -p "$COMPOSE_FILES_DIR"

# Finale Überprüfung um sicherzustellen, dass kein docker-compose-data Verzeichnis existiert
if [ -e "$INSTALL_DIR/docker-compose-data" ]; then
    echo "Final check: Removing any docker-compose-data directory..."
    sudo rm -rf "$INSTALL_DIR/docker-compose-data"
fi

# Definiere GitHub URLs
GITHUB_BRANCH="development"
GITHUB_RAW_URL="https://raw.githubusercontent.com/BangerTech/webDock/$GITHUB_BRANCH"

# Funktion zum Kopieren lokaler Dateien
copy_local_files() {
    echo "Using local files..."
    # Kopiere Basis-Dateien
    sudo cp webdock-templates/webdock-ui/docker-compose.yml "$BASE_DIR/" || return 1
    sudo cp webdock-templates/webdock-ui/Dockerfile "$BASE_DIR/" || return 1
    sudo cp webdock-templates/webdock-ui/requirements.txt "$BASE_DIR/" || return 1
    
    # Modify app.py to use local files directly instead of copying them
    # Create the local_compose_dir variable in app.py to match the structure
    local_app_content=$(cat webdock-templates/webdock-ui/src/app.py)
    
    # Make sure app.py is configured to use local files and paths
    # Get the app.py from local directory with local file path handling
    modified_app_content="$(cat webdock-templates/webdock-ui/src/app.py | \
      sed "s|COMPOSE_FILES_DIR = .*|COMPOSE_FILES_DIR = '$COMPOSE_FILES_DIR'|g" | \
      sed "s|WEBDOCK_BASE_PATH = .*|WEBDOCK_BASE_PATH = '$INSTALL_DIR'|g" | \
      sed "s|COMPOSE_DATA_DIR = .*|COMPOSE_DATA_DIR = '$COMPOSE_DATA_DIR'|g")"
    echo "$modified_app_content" | sudo tee "$SRC_DIR/app.py" > /dev/null || return 1
    
    sudo cp webdock-templates/webdock-ui/src/templates/index.html "$SRC_DIR/templates/" || return 1
    sudo cp webdock-templates/webdock-ui/src/static/css/style.css "$SRC_DIR/static/css/" || return 1
    sudo cp webdock-templates/webdock-ui/src/static/js/main.js "$SRC_DIR/static/js/" || return 1
    
    # Kopiere Logo und Icons
    sudo cp webdock-templates/webdock-ui/src/static/img/logo1.png "$SRC_DIR/static/img/" || echo "Warning: Could not copy logo1.png"
    sudo cp webdock-templates/webdock-ui/src/static/img/icons/* "$SRC_DIR/static/img/icons/" || echo "Warning: Could not copy icons"
    
    # Kopiere Konfigurationsdateien
    sudo cp webdock-templates/webdock-ui/src/config/categories.yaml "$SRC_DIR/config/" || return 1
    
    # Don't copy Docker-Compose-Dateien, use them directly from their original location
    # Instead of creating a nested symbolic link, we ensure the app uses the correct environment variables
    
    echo "Using local docker-compose files directly from $COMPOSE_FILES_DIR"
    return 0
}

# Funktion zum Herunterladen von GitHub
download_from_github() {
    echo "Downloading files from GitHub..."
    # Liste der zu ladenden Dateien
    # Note that GitHub URLs still use docker-templates as that's the repo structure, but we save to webdock-templates locally
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

    # Überprüfe, ob curl und jq installiert sind
    if ! command -v jq &> /dev/null; then
        echo "jq ist nicht installiert. Versuche es zu installieren..."
        if command -v apt-get &> /dev/null; then
            sudo apt-get update && sudo apt-get install -y jq
        elif command -v yum &> /dev/null; then
            sudo yum install -y jq
        elif command -v dnf &> /dev/null; then
            sudo dnf install -y jq
        elif command -v pacman &> /dev/null; then
            sudo pacman -S --noconfirm jq
        else
            echo "Warnung: Konnte jq nicht automatisch installieren. Die Container müssen manuell heruntergeladen werden."
            # Standard-Container definieren als Fallback
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
                sudo mkdir -p "$COMPOSE_FILES_DIR/$container"
                
                # Versuche die docker-compose.yml herunterzuladen
                if ! sudo curl -sSL "$GITHUB_RAW_URL/docker-templates/$container/docker-compose.yml" \
                        -o "$COMPOSE_FILES_DIR/$container/docker-compose.yml"; then
                    echo "Warning: Could not download $container/docker-compose.yml"
                elif [ ! -s "$COMPOSE_FILES_DIR/$container/docker-compose.yml" ]; then
                    echo "Warning: Downloaded docker-compose.yml for $container is empty"
                    # Lösche leere Datei
                    sudo rm "$COMPOSE_FILES_DIR/$container/docker-compose.yml"
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
        fi
    fi

    # Funktion zum Herunterladen einer Datei, wenn sie nicht existiert oder eine Aktualisierung verfügbar ist
    download_if_needed() {
        local github_url="$1"
        local local_path="$2"
        local description="$3"
        local skip_etag_check="$4"  # Optional: 'true' um etag-Check zu überspringen

        # Existiert die Datei bereits?
        if [ -f "$local_path" ]; then
            # Skip-Flag gesetzt oder Etag-Prüfung
            if [ "$skip_etag_check" = "true" ]; then
                echo "$description existiert bereits, überspringe Download."
                return 0
            else
                # Prüfe, ob eine neuere Version auf GitHub verfügbar ist
                local remote_etag=$(curl -sI "$github_url" | grep -i etag | awk '{print $2}' | tr -d '\r"')
                local local_etag_file="${local_path}.etag"
                local download_needed=true

                if [ -f "$local_etag_file" ] && [ -n "$remote_etag" ]; then
                    local local_etag=$(cat "$local_etag_file")
                    if [ "$local_etag" = "$remote_etag" ]; then
                        echo "$description ist aktuell, überspringe Download."
                        download_needed=false
                    else
                        echo "Neue Version von $description verfügbar, lade herunter..."
                    fi
                else
                    echo "Keine Etag-Informationen für $description, lade herunter..."
                fi

                if [ "$download_needed" = "false" ]; then
                    return 0
                fi
            fi
        else
            echo "$description nicht gefunden, lade herunter..."
        fi

        # Datei herunterladen
        if ! sudo curl -sSL "$github_url" -o "$local_path"; then
            echo "Warning: Konnte $description nicht herunterladen"
            return 1
        elif [ ! -s "$local_path" ]; then
            echo "Warning: Heruntergeladene Datei $description ist leer"
            sudo rm "$local_path"
            return 1
        else
            echo "$description erfolgreich heruntergeladen"
            # Speichere Etag für zukünftige Vergleiche
            if [ "$skip_etag_check" != "true" ]; then
                local remote_etag=$(curl -sI "$github_url" | grep -i etag | awk '{print $2}' | tr -d '\r"')
                if [ -n "$remote_etag" ]; then
                    echo "$remote_etag" | sudo tee "${local_path}.etag" > /dev/null
                fi
            fi
            return 0
        fi
    }

        # Intelligenter Ansatz: Prüfe zuerst, welche Container existieren und welche aktualisiert werden müssen
    
    # Temporäres Verzeichnis erstellen
    TMP_DIR=$(mktemp -d)
    REPO_ZIP="$TMP_DIR/webdock.zip"
    
    # Speichere den letzten bekannten Commit-Hash
    HASH_FILE="$BASE_DIR/.last_commit_hash"
    CURRENT_REMOTE_HASH=""
    
    # Prüfe, ob wir eine neue Version herunterladen müssen
    echo "Prüfe auf Updates im Repository..."
    CURRENT_REMOTE_HASH=$(curl -sSL "https://api.github.com/repos/BangerTech/webDock/commits/$GITHUB_BRANCH" | jq -r '.sha' 2>/dev/null || echo "")
    
    if [ -z "$CURRENT_REMOTE_HASH" ]; then
        echo "Konnte den aktuellen Commit-Hash nicht ermitteln, lade komplettes Repository herunter..."
        FORCE_UPDATE=true
    else
        # Prüfe, ob eine lokale Hash-Datei existiert
        if [ -f "$HASH_FILE" ]; then
            LAST_HASH=$(cat "$HASH_FILE")
            if [ "$LAST_HASH" = "$CURRENT_REMOTE_HASH" ]; then
                echo "Repository ist bereits auf dem neuesten Stand (Hash: ${LAST_HASH:0:8})."
                UPDATES_NEEDED=false
            else
                echo "Neue Version verfügbar: ${LAST_HASH:0:8} -> ${CURRENT_REMOTE_HASH:0:8}"
                UPDATES_NEEDED=true
            fi
        else
            echo "Keine lokale Hash-Information gefunden, lade komplettes Repository herunter..."
            UPDATES_NEEDED=true
            FORCE_UPDATE=true
        fi
    fi
    
    # Stelle sicher, dass die Verzeichnisstruktur existiert
    sudo mkdir -p "$COMPOSE_FILES_DIR"
    sudo mkdir -p "$SRC_DIR/static/img/icons"
    
    # Wenn Updates benötigt werden oder ein Komplett-Update erzwungen wird
    if [ "$UPDATES_NEEDED" = "true" ] || [ "$FORCE_UPDATE" = "true" ]; then
        echo "Lade Repository als ZIP herunter..."
        # ZIP-Datei des Repositories herunterladen
        if ! curl -L "https://github.com/BangerTech/webDock/archive/refs/heads/$GITHUB_BRANCH.zip" -o "$REPO_ZIP"; then
            echo "Fehler beim Herunterladen des Repositories"
            return 1
        fi
        
        # Entpacke das ZIP-Archiv
        echo "Entpacke Repository..."
        unzip -q "$REPO_ZIP" -d "$TMP_DIR"
        
        # Finde das entpackte Verzeichnis
        UNPACKED_DIR="$TMP_DIR/webDock-$GITHUB_BRANCH"
        
        # Kopiere Icons aus dem WebDock UI-Verzeichnis
        echo "Kopiere Icons..."
        if [ -d "$UNPACKED_DIR/docker-templates/webdock-ui/src/static/img/icons" ]; then
            sudo mkdir -p "$SRC_DIR/static/img/icons"
            sudo cp -R "$UNPACKED_DIR/docker-templates/webdock-ui/src/static/img/icons/"* "$SRC_DIR/static/img/icons/" 2>/dev/null || true
        fi
        
        # Kopiere WebDock UI-Dateien
        echo "Kopiere WebDock UI-Dateien..."
        if [ -f "$UNPACKED_DIR/docker-templates/webdock-ui/docker-compose.yml" ]; then
            sudo cp "$UNPACKED_DIR/docker-templates/webdock-ui/docker-compose.yml" "$BASE_DIR/docker-compose.yml"
        fi
        if [ -f "$UNPACKED_DIR/docker-templates/webdock-ui/Dockerfile" ]; then
            sudo cp "$UNPACKED_DIR/docker-templates/webdock-ui/Dockerfile" "$BASE_DIR/Dockerfile"
        fi
        if [ -f "$UNPACKED_DIR/docker-templates/webdock-ui/requirements.txt" ]; then
            sudo cp "$UNPACKED_DIR/docker-templates/webdock-ui/requirements.txt" "$BASE_DIR/requirements.txt"
        fi
        if [ -f "$UNPACKED_DIR/docker-templates/webdock-ui/app.py" ]; then
            sudo cp "$UNPACKED_DIR/docker-templates/webdock-ui/app.py" "$BASE_DIR/app.py"
        fi
        
        # Generiere eine Liste aller verfügbaren Container
        echo "Ermittle verfügbare Container..."
        AVAILABLE_CONTAINERS=$(find "$UNPACKED_DIR/docker-templates/" -maxdepth 1 -type d -not -name "webdock-ui" -not -name "docker-templates" | xargs -n1 basename 2>/dev/null)
        
        # Kopiere nur neue oder geänderte Container-Vorlagen
        echo "Aktualisiere Container-Vorlagen..."
        for container in $AVAILABLE_CONTAINERS; do
            container_src="$UNPACKED_DIR/docker-templates/$container"
            container_dst="$COMPOSE_FILES_DIR/$container"
            
            # Prüfe, ob der Container neu ist oder aktualisiert werden muss
            if [ ! -d "$container_dst" ] || [ "$FORCE_UPDATE" = "true" ]; then
                echo "Installiere neuen Container: $container"
                sudo mkdir -p "$container_dst"
                sudo cp -R "$container_src/"* "$container_dst/" 2>/dev/null || true
            else
                # Prüfe auf Änderungen durch Vergleich der Dateien
                if [ "$UPDATES_NEEDED" = "true" ]; then
                    echo "Prüfe auf Updates für: $container"
                    # docker-compose.yml Datei ist immer wichtig, prüfe diese zuerst
                    if [ -f "$container_src/docker-compose.yml" ] && \
                       ( [ ! -f "$container_dst/docker-compose.yml" ] || \
                         ! cmp -s "$container_src/docker-compose.yml" "$container_dst/docker-compose.yml" ); then
                        echo "Update für $container gefunden"
                        sudo cp -R "$container_src/"* "$container_dst/" 2>/dev/null || true
                    fi
                fi
            fi
        done
        
        # Speichere den aktuellen Hash für zukünftige Vergleiche
        if [ -n "$CURRENT_REMOTE_HASH" ]; then
            echo "$CURRENT_REMOTE_HASH" | sudo tee "$HASH_FILE" > /dev/null
            echo "Commit-Hash gespeichert: ${CURRENT_REMOTE_HASH:0:8}"
        fi
        
        # Aufräumen
        echo "Räume temporäre Dateien auf..."
        rm -rf "$TMP_DIR"
    else
        echo "Keine Updates notwendig, überspringe Download."
    fi
    return 0
}

# Versuche zuerst lokale Dateien zu kopieren
echo "Copying files..."
if [ -d "webdock-templates/webdock-ui" ]; then
    echo "Local files found in webdock-templates/webdock-ui"
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
