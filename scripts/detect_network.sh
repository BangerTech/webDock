#!/bin/bash

# Skript zur Erkennung des Netzwerk-Interfaces und der IP-Adresse
# Dieses Skript wird außerhalb des Containers ausgeführt

# Ausgabedatei mit absolutem Pfad
OUTPUT_FILE="/home/webDock/webdock-data/config/network_info.json"

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
