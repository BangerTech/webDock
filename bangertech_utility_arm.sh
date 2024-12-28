#!/bin/bash

sudo bash -c 'sudo apt install whiptail -y >/dev/null 2>&1 & disown'
sudo bash -c 'sudo wget -nc https://raw.githubusercontent.com/BangerTech/The-BangerTECH-Utility/development/scripts/logo.txt -O /home/$USER/logo.txt >/dev/null 2>&1 & disown'
sudo bash -c 'sudo apt update && sudo apt upgrade -y >/dev/null 2>&1 & disown'

sleep 2
if [ -f "/home/$USER/logo.txt" ]; then
    cat "/home/$USER/logo.txt"
fi

echo "Website:   https://bangertech.de"
echo "Donations: https://www.paypal.com/donate/?hosted_button_id=FD26FHKRWS3US"

# Neue Auswahl für Installation
INSTALL_TYPE=$(whiptail --backtitle "The BangerTECH Utility ARM VERSION" --title "SELECT INSTALLATION TYPE" --menu "Choose your installation type" 15 60 2 \
    "1" "Terminal Installation (Classic)" \
    "2" "Web UI Installation (New)" 3>&1 1>&2 2>&3)

exitstatus=$?
if [ $exitstatus != 0 ]; then
    exit 0
fi

case $INSTALL_TYPE in
    "2")
        # Starte Web UI Installation
        if [ ! -f "setup_webui.sh" ]; then
            echo "Downloading Web UI setup script..."
            sudo wget -nc https://raw.githubusercontent.com/BangerTech/webDock/main/setup_webui.sh
            sudo chmod +x setup_webui.sh
        fi
        ./setup_webui.sh
        ;;
    "1")
        sleep 5
        CHOICES=$(whiptail --backtitle "The BangerTECH Utility ARM VERSION" --title "SELECT PACKAGES TO INSTALL" --checklist "Choose options" 29 85 22 \
        "openHAB" "install openHABian on top of your running System " ON \
        "Docker+Docker-Compose" "install Docker & Docker-Compose" OFF \
        # ... Rest des originalen Codes ...
        )
        # ... Rest des originalen Codes ...
        ;;
esac
