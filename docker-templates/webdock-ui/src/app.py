from flask import Flask, jsonify, render_template, send_from_directory, abort, request
import os
import logging
import yaml
import subprocess
import json
import time
from datetime import datetime, timezone  # timezone hinzugefügt
import psutil
import requests
import threading
from functools import lru_cache
import shutil
import paramiko
import croniter
import uuid
import tempfile
import socket
import stat
import re
from datetime import timedelta
from typing import Dict, Any
import docker

# Konfiguriere Logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = Flask(__name__, 
    static_url_path='/static',
    static_folder='static',
    template_folder='templates'
)
app.debug = False

GITHUB_RAW_URL = "https://raw.githubusercontent.com/BangerTech/webDock/main/docker-templates"
GITHUB_API_URL = "https://api.github.com/repos/BangerTech/webDock/contents/docker-templates"

# Cache für Container-Konfigurationen
CACHE_TIMEOUT = 300  # 5 Minuten
last_update = 0
config_cache = {}

# Konstanten und Konfiguration
# Bestimme den Basis-Pfad basierend auf dem aktuellen Verzeichnis der app.py oder dem Startverzeichnis
APP_DIR = os.path.dirname(os.path.abspath(__file__))

# Bestimme den Installationspfad
# Wenn die App in einem Container läuft, nutze den Container-Pfad
if os.path.exists('/.dockerenv'):
    WEBDOCK_BASE_PATH = '/app/webdock'
else:
    # Versuche verschiedene Methoden, um das Basis-Verzeichnis zu finden
    base_path_found = False
    
    # 1. Prüfe, ob das aktuelle Arbeitsverzeichnis oder eines seiner Eltern das Repository ist
    current_dir = os.getcwd()
    original_current_dir = current_dir
    while current_dir != '/':
        if os.path.exists(os.path.join(current_dir, 'webdock-templates')):
            WEBDOCK_BASE_PATH = current_dir
            base_path_found = True
            logger.info(f"Found webDock base path at current directory: {WEBDOCK_BASE_PATH}")
            break
        current_dir = os.path.dirname(current_dir)
    
    # 2. Wenn nicht gefunden, prüfe ob das Verzeichnis der app.py oder eines seiner Eltern das Repository ist
    if not base_path_found:
        current_dir = APP_DIR
        while current_dir != '/':
            if os.path.exists(os.path.join(current_dir, 'webdock-templates')):
                WEBDOCK_BASE_PATH = current_dir
                base_path_found = True
                logger.info(f"Found webDock base path at app directory: {WEBDOCK_BASE_PATH}")
                break
            if os.path.exists(os.path.join(os.path.dirname(current_dir), 'webdock-templates')):
                WEBDOCK_BASE_PATH = os.path.dirname(current_dir)
                base_path_found = True
                logger.info(f"Found webDock base path at parent directory: {WEBDOCK_BASE_PATH}")
                break
            current_dir = os.path.dirname(current_dir)
    
    # 3. Wenn immer noch nicht gefunden, verwende das aktuelle Arbeitsverzeichnis als Basis
    if not base_path_found:
        WEBDOCK_BASE_PATH = original_current_dir
        logger.warning(f"Could not find webdock-templates directory, using current directory as base: {WEBDOCK_BASE_PATH}")
        # Erstelle das webdock-templates Verzeichnis, falls es nicht existiert
        os.makedirs(os.path.join(WEBDOCK_BASE_PATH, 'webdock-templates'), exist_ok=True)

# Konfiguriere die Pfade relativ zum Basis-Pfad
CONFIG_DIR = os.getenv('CONFIG_DIR', os.path.join(WEBDOCK_BASE_PATH, 'config'))
TEMPLATE_DIR = os.path.join(APP_DIR, 'config')
CATEGORIES_FILE = os.path.join(CONFIG_DIR, 'categories.yaml')
COMPOSE_DIR = os.path.join(CONFIG_DIR, 'compose-files')
COMPOSE_FILES_DIR = os.getenv('COMPOSE_FILES_DIR', os.path.join(WEBDOCK_BASE_PATH, 'webdock-templates'))
COMPOSE_DATA_DIR = os.getenv('COMPOSE_DATA_DIR', os.path.join(WEBDOCK_BASE_PATH, 'webdock-data'))

# Logge die wichtigen Pfade
logger.info(f"WebDock Base Path: {WEBDOCK_BASE_PATH}")
logger.info(f"Config Directory: {CONFIG_DIR}")
logger.info(f"Template Directory: {TEMPLATE_DIR}")
logger.info(f"Compose Files Directory: {COMPOSE_FILES_DIR}")
logger.info(f"Compose Data Directory: {COMPOSE_DATA_DIR}")
HOST_CONFIG_FILE = os.path.join(CONFIG_DIR, 'host_config.json')

# SSH Verbindungen speichern
ssh_connections = {}

# Am Anfang der Datei bei den anderen globalen Variablen
host_credentials = {
    'ip': None,
    'username': None,
    'password': None
}

# Am Anfang der Datei nach den Imports
# WEBDOCK_BASE_PATH ist bereits oben definiert

# Stelle sicher, dass die Verzeichnisse existieren
os.makedirs(COMPOSE_DATA_DIR, exist_ok=True)
os.makedirs(COMPOSE_FILES_DIR, exist_ok=True)

# Funktion zum Laden der Host-Konfiguration
def load_host_config():
    try:
        if os.path.exists(HOST_CONFIG_FILE):
            with open(HOST_CONFIG_FILE, 'r') as f:
                return json.load(f)
    except Exception as e:
        app.logger.error(f"Error loading host config: {e}")
    return None

# Funktion zum Speichern der Host-Konfiguration
def save_host_config(config):
    try:
        # Stelle sicher, dass das Verzeichnis existiert
        os.makedirs(os.path.dirname(HOST_CONFIG_FILE), exist_ok=True)
        
        with open(HOST_CONFIG_FILE, 'w') as f:
            json.dump(config, f)
        return True
    except Exception as e:
        app.logger.error(f"Error saving host config: {e}")
        return False

class SSHSession:
    def __init__(self, client):
        self.client = client
        self.channel = client.invoke_shell()
        self.channel.settimeout(1)
        
        # Bessere Shell-Initialisierung
        init_commands = [
            'export TERM=xterm',
            'export PS1="\\u@\\h:\\w\\$ "',
            'stty -echo',
            'set -o vi'  # Für bessere Terminal-Unterstützung
        ]
        
        for cmd in init_commands:
            self.channel.send(f"{cmd}\n")
            time.sleep(0.1)
        self.channel.recv(4096)  # Clear buffer

def get_cached_containers():
    """Gibt gecachte Container-Konfigurationen zurück"""
    global last_update, config_cache
    
    current_time = time.time()
    if current_time - last_update > CACHE_TIMEOUT:
        # Stelle sicher, dass wir die lokalen Dateien verwenden
        if not os.path.exists(COMPOSE_FILES_DIR):
            download_compose_files()
        config_cache = load_container_configs(COMPOSE_FILES_DIR)
        last_update = current_time
    
    return config_cache

def load_container_configs(compose_dir):
    """Lädt Container-Konfigurationen aus dem Dateisystem"""
    configs = {}
    try:
        logger.info(f"Loading configs from {compose_dir}")
        for root, dirs, files in os.walk(compose_dir):
            if 'docker-compose.yml' in files:
                try:
                    with open(os.path.join(root, 'docker-compose.yml')) as f:
                        compose_data = yaml.safe_load(f)
                        if compose_data and 'services' in compose_data:
                            container_name = os.path.basename(root)
                            configs[container_name] = compose_data
                            logger.info(f"Loaded config for {container_name}")
                except Exception as e:
                    logger.error(f"Error loading config for {root}: {e}")
    except Exception as e:
        logger.error(f"Error walking directory {compose_dir}: {e}")
    return configs

def _extract_port(ports):
    if not ports:
        return None
    # Konvertiere Port-Definitionen in lesbare Form
    try:
        if isinstance(ports, list):
            for port in ports:
                if isinstance(port, str) and ':' in port:
                    # Extrahiere den Host-Port (vor dem Doppelpunkt)
                    host_port = port.split(':')[0].strip('"\'')
                    # Entferne IP-Adresse, falls vorhanden (z.B. "127.0.0.1:8080:80")
                    if '.' in host_port:
                        parts = host_port.split(':')
                        if len(parts) > 1:
                            host_port = parts[1]
                        else:
                            continue  # Ungültiges Format, versuche den nächsten Port
                    return host_port
                elif isinstance(port, (int, str)):
                    return str(port)
        elif isinstance(ports, dict):
            # Für den Fall, dass Ports als Dictionary definiert sind
            for container_port, host_port in ports.items():
                if host_port:
                    return str(host_port)
        return None
    except Exception as e:
        logger.error(f"Error extracting port: {e}")
        return None

def load_template_categories():
    """Lädt die Kategorien aus der Template-Datei"""
    template_file = os.path.join(TEMPLATE_DIR, 'categories.yaml')
    try:
        with open(template_file, 'r') as f:
            categories = yaml.safe_load(f)
            return categories if categories else {'categories': {}}
    except Exception as e:
        logger.error(f"Error loading template categories from {template_file}: {e}")
        return {'categories': {}}

def load_categories():
    """Lädt die Kategorien aus der YAML-Datei oder erstellt Standardkategorien aus dem Template"""
    try:
        if os.path.exists(CATEGORIES_FILE):
            with open(CATEGORIES_FILE, 'r') as f:
                categories = yaml.safe_load(f)
                
                # Filtere Container basierend auf der Systemarchitektur
                if categories and 'categories' in categories:
                    # Prüfe, ob die Kategorien als Liste oder als Dictionary vorliegen
                    if isinstance(categories['categories'], list):
                        # Kategorien sind als Liste strukturiert (neues Format)
                        for category in categories['categories']:
                            # Überprüfe, ob die Kategorie 'containers' hat und ob es sich um eine Liste handelt
                            if 'containers' in category and isinstance(category['containers'], list):
                                # Filtere ARM-spezifische Container
                                filtered_containers = []
                                for container in category['containers']:
                                    container_name = container if isinstance(container, str) else container.get('name')
                                    
                                    # Prüfe Architektur-spezifische Filter
                                    if SYSTEM_INFO['is_arm']:
                                        # Entferne x86-spezifische Container
                                        if container_name != 'filestash':
                                            filtered_containers.append(container)
                                    else:  # x86/AMD64
                                        # Entferne ARM-spezifische Container
                                        if container_name != 'filebrowser':
                                            filtered_containers.append(container)
                                            
                                category['containers'] = filtered_containers
                    else:
                        # Kategorien sind als Dictionary strukturiert (altes Format)
                        for category_id, category in categories['categories'].items():
                            if 'containers' in category:
                                # Filtere ARM-spezifische Container
                                if SYSTEM_INFO['is_arm']:
                                    # Entferne x86-spezifische Container
                                    if 'filestash' in category['containers']:
                                        category['containers'].remove('filestash')
                                else:  # x86/AMD64
                                    # Entferne ARM-spezifische Container
                                    if 'filebrowser' in category['containers']:
                                        category['containers'].remove('filebrowser')
                
                return categories
        
        # Wenn keine Datei existiert, lade die Kategorien aus dem Template
        default_categories = load_template_categories()
        
        # Füge plattformspezifische Container hinzu
        if SYSTEM_INFO['is_arm']:
            if 'system' in default_categories['categories']:
                default_categories['categories']['system']['containers'].append('filebrowser')
        else:
            if 'development' in default_categories['categories'] and 'filestash' not in default_categories['categories']['development']['containers']:
                default_categories['categories']['development']['containers'].append('filestash')
        
        return default_categories
        
    except Exception as e:
        logger.error(f"Error loading categories: {e}")
        return {'categories': []}

@app.route('/api/categories', methods=['POST'])
def add_category():
    try:
        data = request.json
        categories = load_categories()
        
        # Füge neue Kategorie hinzu
        category_id = data['id']
        categories['categories'][category_id] = {
            'name': data['name'],
            'icon': data['icon'],
            'description': data.get('description', ''),
            'containers': data.get('containers', [])
        }
        
        # Speichere aktualisierte Kategorien
        with open(CATEGORIES_FILE, 'w') as f:
            yaml.dump(categories, f)
        
        return jsonify({'status': 'success'})
    except Exception as e:
        logger.exception("Error adding category")
        return jsonify({'error': str(e)}), 500

@app.route('/api/categories/<category_id>', methods=['PUT'])
def update_category(category_id):
    try:
        data = request.json
        categories = load_categories()
        
        if category_id not in categories['categories']:
            return jsonify({'error': 'Category not found'}), 404
        
        # Aktualisiere die Kategorie
        categories['categories'][category_id].update({
            'name': data['name'],
            'icon': data['icon'],
            'description': data['description'],
            'containers': data['containers']
        })
        
        # Speichere aktualisierte Kategorien
        with open(CATEGORIES_FILE, 'w') as f:
            yaml.dump(categories, f)
        
        return jsonify({'status': 'success'})
    except Exception as e:
        logger.exception("Error updating category")
        return jsonify({'error': str(e)}), 500

@app.route('/api/categories', methods=['GET'])
def get_categories():
    try:
        categories = load_categories()
        logger.info(f"Returning categories: {categories}")  # Debug logging
        return jsonify(categories)
    except Exception as e:
        logger.exception("Error getting categories")
        return jsonify({'error': str(e)}), 500

def _get_container_group(dirname):
    categories = load_categories()
    for category in categories.get('categories', []):
        container_names = [c.get('name', '').lower() if isinstance(c, dict) else c.lower() for c in category.get('containers', [])]
        if dirname.lower() in container_names:
            return category.get('name', 'Other')
    return 'Other'

def _get_group_icon(group):
    categories = load_categories()
    for category in categories.get('categories', []):
        if category.get('name') == group:
            return category.get('icon', 'fa-cube')
    return 'fa-cube'

def _get_container_description(container_name):
    categories = load_categories()
    for category in categories.get('categories', []):
        for container in category.get('containers', []):
            if isinstance(container, dict) and container.get('name', '').lower() == container_name.lower():
                return container.get('description', '')
    return ''

def get_compose_status(compose_dir):
    """Hole den Status aller Docker Compose Projekte"""
    try:
        cmd = ["docker", "compose", "ls", "--format", "json"]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            return json.loads(result.stdout)
        return []
    except Exception as e:
        logger.error(f"Error getting compose status: {str(e)}")
        return []

def get_container_status(project_name):
    """Hole den Status eines spezifischen Docker Compose Projekts"""
    try:
        # Hole alle laufenden Container
        cmd = ["docker", "ps", "--format", "{{.Names}}"]
        result = subprocess.run(cmd, capture_output=True, text=True)
        running_containers = set(result.stdout.strip().split('\n')) if result.stdout.strip() else set()
        logger.info(f"Running containers: {running_containers}")
        
        # Hole alle Container (auch gestoppte)
        cmd = ["docker", "ps", "-a", "--format", "{{.Names}}"]
        result = subprocess.run(cmd, capture_output=True, text=True)
        all_containers = set(result.stdout.strip().split('\n')) if result.stdout.strip() else set()
        logger.info(f"All containers: {all_containers}")
        
        # Erstelle Status-Liste
        containers = []
        for container in all_containers:
            containers.append({
                'Name': container,
                'State': 'running' if container in running_containers else 'stopped'
            })
        
        if containers != last_container_status.get(project_name):
            logger.info(f"Container status changed in {project_name}: {containers}")
            last_container_status[project_name] = containers
        return containers
    except Exception as e:
        logger.error(f"Error getting container status: {e}", exc_info=True)
        return []

def setup_container_environment(container_name, install_path, config_data=None):
    """Setup container environment based on container type"""
    if container_name == 'mosquitto':
        return setup_mosquitto(container_name, install_path, config_data)
    elif container_name == 'grafana':
        return setup_grafana(container_name, install_path, config_data)
    elif container_name == 'influxdb':
        return setup_influxdb(container_name, install_path, config_data)
    elif container_name == 'dockge':
        return setup_dockge(container_name, install_path, config_data)
    elif container_name == 'filestash':
        return setup_filestash(container_name, install_path, config_data)
    elif container_name == 'homeassistant':
        return setup_homeassistant(container_name, install_path, config_data)
    elif container_name in ['watchyourlan', 'watchyourlanarm']:
        return setup_watchyourlan(container_name, install_path, config_data)
    elif container_name == 'prometheus':
        return setup_prometheus(container_name, install_path, config_data)
    elif container_name == 'hoarder':
        return setup_hoarder(container_name, install_path, config_data)
    elif container_name == 'codeserver':
        return setup_codeserver(container_name, install_path, config_data)
    elif container_name == 'scrypted':
        return setup_scrypted(container_name, install_path, config_data)
    elif container_name == 'node-red':
        return setup_nodered(container_name, install_path, config_data)
    else:
        # For other containers, just create the directory
        os.makedirs(install_path, exist_ok=True)
        return True

def download_compose_files():
    """Lädt alle Container-Dateien von GitHub herunter oder verwendet lokale Dateien"""
    try:
        container_compose_dir = COMPOSE_FILES_DIR
        logger.info(f"DEBUG: Checking container_compose_dir: {container_compose_dir}")
        logger.info(f"DEBUG: Directory exists: {os.path.exists(container_compose_dir)}")
        
        # Prüfe auf vorhandene docker-compose.yml Dateien
        compose_files_found = False
        compose_files_count = 0
        found_dirs = []
        
        # Direktes Auflisten der Unterverzeichnisse mit ls
        try:
            # Verwende os.listdir, um die Verzeichnisse aufzulisten
            dir_contents = os.listdir(container_compose_dir)
            subdirs = []
            
            # Filtere nur Verzeichnisse
            for item in dir_contents:
                item_path = os.path.join(container_compose_dir, item)
                if os.path.isdir(item_path) and item not in ['.', '..']:
                    subdirs.append(item_path)
            
            logger.info(f"DEBUG: Found {len(subdirs)} subdirectories using os.listdir")
            
            for subdir_path in subdirs:
                subdir = os.path.basename(subdir_path)
                compose_path = os.path.join(subdir_path, 'docker-compose.yml')
                logger.info(f"DEBUG: Checking for compose file at: {compose_path}")
                
                if os.path.isfile(compose_path):
                    logger.info(f"DEBUG: File exists: {compose_path}")
                    compose_files_found = True
                    compose_files_count += 1
                    found_dirs.append(subdir)
                    logger.info(f"Found docker-compose.yml in: {subdir}")
                    
                    # Kopiere alle Dateien aus dem Quellverzeichnis in das Zielverzeichnis
                    source_dir = subdir_path
                    target_dir = os.path.join(COMPOSE_DATA_DIR, subdir)
                    logger.info(f"Copying files from {source_dir} to {target_dir}")
                    
                    # Erstelle das Zielverzeichnis, falls es nicht existiert
                    os.makedirs(target_dir, exist_ok=True)
                    
                    # Finde alle Dateien im Quellverzeichnis
                    file_result = subprocess.run(['find', source_dir, '-type', 'f'], 
                                              capture_output=True, text=True, check=True)
                    source_files = file_result.stdout.strip().split('\n')
                    source_files = [f for f in source_files if f]  # Filtere leere Zeilen
                    
                    for source_file in source_files:
                        file_name = os.path.basename(source_file)
                        target_file = os.path.join(target_dir, file_name)
                        
                        if not os.path.exists(target_file):
                            shutil.copy2(source_file, target_file)
                            logger.info(f"Copied {file_name} from {source_dir} to {target_dir}")
        except Exception as e:
            logger.error(f"Error finding subdirectories: {str(e)}")
            
            # Wenn wir hier sind, ist etwas mit dem ersten Versuch schiefgegangen
            # Versuche es mit einer direkten Methode
            logger.info("Trying direct method to list container directories")
            
            # Direkte Liste der bekannten Container-Verzeichnisse
            known_containers = [
                'mosquitto-broker', 'grafana', 'influxdb-arm', 'influxdb-x86', 'dockge', 'filestash',
                'homeassistant', 'watchyourlan', 'watchyourlanarm', 'prometheus', 'hoarder',
                'codeserver', 'scrypted', 'node-red', 'portainer', 'dozzle', 'uptime-kuma',
                'zigbee2mqtt', 'homebridge', 'jellyfin', 'paperless-ngx', 'webdock-ui'
            ]
            
            for container in known_containers:
                container_path = os.path.join(container_compose_dir, container)
                compose_path = os.path.join(container_path, 'docker-compose.yml')
                
                logger.info(f"Checking for known container: {container} at {container_path}")
                
                if os.path.exists(container_path) and os.path.isdir(container_path):
                    logger.info(f"Found directory for {container}")
                    
                    if os.path.isfile(compose_path):
                        logger.info(f"Found docker-compose.yml for {container}")
                        compose_files_found = True
                        compose_files_count += 1
                        found_dirs.append(container)
                        
                        # Kopiere alle Dateien aus dem Quellverzeichnis in das Zielverzeichnis
                        source_dir = container_path
                        target_dir = os.path.join(COMPOSE_DATA_DIR, container)
                        os.makedirs(target_dir, exist_ok=True)
                        
                        try:
                            # Liste alle Dateien im Quellverzeichnis auf
                            for item in os.listdir(source_dir):
                                source_item = os.path.join(source_dir, item)
                                target_item = os.path.join(target_dir, item)
                                
                                if os.path.isfile(source_item) and not os.path.exists(target_item):
                                    shutil.copy2(source_item, target_item)
                                    logger.info(f"Copied {item} from {source_dir} to {target_dir}")
                        except Exception as e:
                            logger.error(f"Error copying files for {container}: {str(e)}")
        
        if compose_files_found:
            logger.info(f"Using existing docker-compose files in {container_compose_dir} (found {compose_files_count} files in {', '.join(found_dirs)})")
            return True
        else:
            logger.info(f"No docker-compose.yml files found in local directories in {container_compose_dir}")
            
        # Wenn wir hier sind, wurden keine lokalen Dateien gefunden
        # Versuche es mit einem alternativen Pfad
        alt_compose_dir = os.path.join(WEBDOCK_BASE_PATH, 'docker-templates')
        if os.path.exists(alt_compose_dir) and alt_compose_dir != container_compose_dir:
            logger.info(f"Checking alternative compose directory: {alt_compose_dir}")
            try:
                subdirs = [d for d in os.listdir(alt_compose_dir) 
                          if os.path.isdir(os.path.join(alt_compose_dir, d))]
                
                logger.info(f"Found subdirectories in alternative path: {subdirs}")
                
                for subdir in subdirs:
                    compose_path = os.path.join(alt_compose_dir, subdir, 'docker-compose.yml')
                    if os.path.isfile(compose_path):
                        # Wenn wir eine docker-compose.yml im alternativen Pfad finden, kopieren wir den gesamten Ordner
                        source_dir = os.path.join(alt_compose_dir, subdir)
                        target_dir = os.path.join(container_compose_dir, subdir)
                        
                        # Erstelle das Zielverzeichnis, falls es nicht existiert
                        os.makedirs(target_dir, exist_ok=True)
                        
                        # Kopiere alle Dateien aus dem Quellverzeichnis in das Zielverzeichnis
                        for item in os.listdir(source_dir):
                            source_item = os.path.join(source_dir, item)
                            target_item = os.path.join(target_dir, item)
                            
                            if os.path.isfile(source_item):
                                shutil.copy2(source_item, target_item)
                                logger.info(f"Copied {item} from {source_dir} to {target_dir}")
                        
                        compose_files_found = True
                        compose_files_count += 1
                        found_dirs.append(subdir)
                        logger.info(f"Copied all files from {source_dir} to {target_dir}")
            except Exception as e:
                logger.error(f"Error checking or copying from alternative path: {str(e)}")
            
            if compose_files_found:
                logger.info(f"Using existing docker-compose files in {alt_compose_dir} (found {compose_files_count} files in {', '.join(found_dirs)})")
                return True
            else:
                logger.info(f"No docker-compose.yml files found in alternative directory: {alt_compose_dir}")
        
        # Falls keine lokalen Dateien gefunden wurden, versuche von GitHub herunterzuladen oder erstelle Standard-Container-Verzeichnisse
        logger.info("No local files found in docker-templates, attempting to download from GitHub...")
        
        # Liste der Standard-Container, die wir unterstützen
        standard_containers = [
            'mosquitto-broker', 'grafana', 'influxdb-arm', 'influxdb-x86', 'dockge', 'filestash',
            'homeassistant', 'watchyourlan', 'watchyourlanarm', 'prometheus', 'hoarder',
            'codeserver', 'scrypted', 'node-red', 'portainer', 'dozzle', 'uptime-kuma',
            'zigbee2mqtt', 'homebridge', 'jellyfin', 'paperless-ngx', 'webdock-ui'
        ]
        
        # Versuche zuerst, die Container-Dateien von GitHub herunterzuladen
        github_success = False
        try:
            # Erstelle das Basis-Verzeichnis
            os.makedirs(COMPOSE_DATA_DIR, exist_ok=True)
            
            # Versuche zuerst, die Verzeichnisstruktur von GitHub zu holen
            # Verwende einen User-Agent, um 403-Fehler zu vermeiden
            headers = {
                'User-Agent': 'WebDock-Installer/1.0',
                'Accept': 'application/vnd.github.v3+json'
            }
            
            logger.info(f"Attempting to access GitHub API at {GITHUB_API_URL}")
            response = requests.get(GITHUB_API_URL, headers=headers)
            
            if response.status_code == 200:
                # Extrahiere die Verzeichnisse aus der API-Antwort
                directories = [item['name'] for item in response.json() if item['type'] == 'dir']
                directories = [d for d in directories if d in standard_containers]  # Nur bekannte Container verwenden
                
                logger.info(f"Found {len(directories)} container directories on GitHub")
                
                successful_downloads = 0
                
                for container in directories:
                    try:
                        # Hole die Verzeichnisstruktur für diesen Container
                        container_api_url = f"{GITHUB_API_URL}/{container}"
                        logger.info(f"Fetching container files from {container_api_url}")
                        
                        response = requests.get(container_api_url, headers=headers)
                        
                        if response.status_code == 200:
                            # Erstelle das Zielverzeichnis für den Container
                            target_dir = os.path.join(COMPOSE_DATA_DIR, container)
                            os.makedirs(target_dir, exist_ok=True)
                            
                            # Hole alle Dateien aus dem Verzeichnis
                            files = [item for item in response.json() if item['type'] == 'file']
                            
                            if files:
                                downloaded_files = 0
                                for file_info in files:
                                    file_name = file_info['name']
                                    file_url = file_info['download_url']
                                    
                                    try:
                                        file_response = requests.get(file_url, headers=headers)
                                        if file_response.status_code == 200:
                                            file_path = os.path.join(target_dir, file_name)
                                            with open(file_path, 'wb') as f:
                                                f.write(file_response.content)
                                            downloaded_files += 1
                                            logger.info(f"Downloaded {container}/{file_name}")
                                        else:
                                            logger.error(f"Failed to download {container}/{file_name}: {file_response.status_code}")
                                    except Exception as e:
                                        logger.error(f"Error downloading {container}/{file_name}: {str(e)}")
                                
                                if downloaded_files > 0:
                                    successful_downloads += 1
                                    logger.info(f"Successfully downloaded {downloaded_files} files for {container}")
                            else:
                                logger.warning(f"No files found for {container} on GitHub")
                        else:
                            logger.error(f"Failed to get contents for {container}: {response.status_code}")
                    except Exception as e:
                        logger.error(f"Error processing {container} from GitHub: {str(e)}")
                
                if successful_downloads > 0:
                    logger.info(f"Successfully downloaded files for {successful_downloads} of {len(directories)} containers from GitHub")
                    github_success = True
                else:
                    logger.error("Failed to download any container files from GitHub")
            else:
                logger.error(f"Failed to access GitHub API: {response.status_code}")
        except Exception as e:
            logger.error(f"Error during GitHub download: {str(e)}")
        
        # Wenn der GitHub-Download fehlschlägt, erstelle Standard-Container-Verzeichnisse
        if not github_success:
            logger.info("Creating standard container directories as fallback...")
            
            successful_creations = 0
            
            for container in standard_containers:
                try:
                    # Erstelle das Zielverzeichnis für den Container
                    target_dir = os.path.join(COMPOSE_DATA_DIR, container)
                    os.makedirs(target_dir, exist_ok=True)
                    
                    # Erstelle eine Standard-docker-compose.yml
                    compose_file = os.path.join(target_dir, 'docker-compose.yml')
                    if not os.path.exists(compose_file):
                        logger.info(f"Creating standard docker-compose.yml for {container}")
                        
                        # Spezielle Konfiguration für mosquitto-broker
                        if container == 'mosquitto-broker':
                            # Erstelle mosquitto.conf
                            mosquitto_conf = os.path.join(target_dir, 'mosquitto.conf')
                            with open(mosquitto_conf, 'w') as f:
                                f.write("""# Config file for mosquitto
                                persistence true
                                persistence_location /mosquitto/data/
                                log_dest file /mosquitto/log/mosquitto.log
                                listener 1883
                                allow_anonymous true
                                """)
                            
                            # Erstelle docker-compose.yml für mosquitto
                            with open(compose_file, 'w') as f:
                                f.write("""version: '3'
                                services:
                                  mosquitto-broker:
                                    image: eclipse-mosquitto:latest
                                    container_name: mosquitto-broker
                                    ports:
                                      - "1883:1883"
                                    volumes:
                                      - ./mosquitto.conf:/mosquitto/config/mosquitto.conf
                                      - ./data:/mosquitto/data
                                      - ./log:/mosquitto/log
                                    restart: unless-stopped
                                    networks:
                                      - webdock-network
                                
                                networks:
                                  webdock-network:
                                    external: true
                                """)
                        else:
                            # Standard-Konfiguration für andere Container
                            standard_compose = {
                                'version': '3',
                                'services': {
                                    container: {
                                        'image': f'${{{container.upper().replace("-", "_")}_IMAGE:-placeholder}}',
                                        'container_name': container,
                                        'restart': 'unless-stopped',
                                        'networks': ['webdock-network']
                                    }
                                },
                                'networks': {
                                    'webdock-network': {
                                        'external': True
                                    }
                                }
                            }
                            
                            with open(compose_file, 'w') as f:
                                yaml.dump(standard_compose, f)
                        
                        successful_creations += 1
                        logger.info(f"Created standard docker-compose.yml for {container}")
                except Exception as e:
                    logger.error(f"Error setting up {container}: {str(e)}")
                    continue
            
            logger.info(f"Successfully created {successful_creations} of {len(standard_containers)} container directories")
        return True
        
    except Exception as e:
        logger.error(f"Error downloading container files: {str(e)}")
        return False

@app.route('/')
def index():
    try:
        logger.info("=== Debug Information ===")
        logger.info(f"Current working directory: {os.getcwd()}")
        logger.info(f"Directory contents: {os.listdir('.')}")
        logger.info(f"Static folder: {app.static_folder}")
        logger.info(f"Template folder: {app.template_folder}")
        
        if not os.path.exists('templates'):
            logger.error("Templates directory does not exist!")
            return "Templates directory missing!", 500
            
        if not os.path.exists('templates/index.html'):
            logger.error("index.html not found!")
            return "index.html missing!", 500
            
        return render_template('index.html')
    except Exception as e:
        logger.exception("Error in index route")
        return str(e), 500

@app.route('/test')
def test():
    return "Flask server is running!"

@app.route('/debug')
def debug():
    try:
        template_path = os.path.join(app.template_folder, 'index.html')
        debug_info = {
            'cwd': os.getcwd(),
            'contents': os.listdir('.'),
            'static_exists': os.path.exists('static'),
            'templates_exists': os.path.exists('templates'),
            'static_contents': os.listdir('static') if os.path.exists('static') else [],
            'templates_contents': os.listdir('templates') if os.path.exists('templates') else [],
            'template_folder': app.template_folder,
            'static_folder': app.static_folder,
            'index_exists': os.path.exists(template_path),
            'absolute_template_path': os.path.abspath(template_path),
            'python_path': os.environ.get('PYTHONPATH', 'Not set')
        }
        logger.info(f"Debug info: {debug_info}")
        return jsonify(debug_info)
    except Exception as e:
        logger.exception("Error in debug route")
        return {'error': str(e)}, 500

# Cache für installierte Container
_installed_containers_cache = None
_last_cache_update = 0
_cache_ttl = 60  # Cache-Gültigkeit in Sekunden

def get_installed_containers():
    """Überprüft welche Container installiert sind mit Cache-Unterstützung"""
    global _installed_containers_cache, _last_cache_update
    
    current_time = time.time()
    
    # Verwende Cache, wenn er noch gültig ist
    if _installed_containers_cache is not None and (current_time - _last_cache_update) < _cache_ttl:
        return _installed_containers_cache
    
    try:
        installed = set()
        
        # Hole laufende Container direkt von Docker
        try:
            result = subprocess.run(['docker', 'ps', '--format', '{{.Names}}'], 
                                 capture_output=True, text=True)
            if result.returncode == 0:
                running_containers = result.stdout.strip().split('\n')
                # Spezielle Behandlung für webdock-ui/bangertech-ui
                for container in running_containers:
                    if not container:  # Überspringe leere Einträge
                        continue
                    # Normalisiere Container-Namen
                    normalized_name = container
                    
                    # Spezielle Behandlung für bekannte Container
                    if container in ['webdock-ui', 'bangertech-ui']:
                        normalized_name = 'webdock-ui'
                    elif container == 'code-server':
                        normalized_name = 'codeserver'
                    elif container == 'node_exporter':
                        normalized_name = 'nodeexporter'
                    elif container == 'paperless':
                        normalized_name = 'paperless-ngx'
                    elif container == 'whatsupdocker':
                        normalized_name = 'wud'
                    
                    installed.add(normalized_name)
                    logger.debug(f"Found running container: {normalized_name}")
        except Exception as e:
            logger.error(f"Error getting running containers: {str(e)}")
        
        # Durchsuche nur die docker-compose-data Verzeichnisse für installierte Container
        # NICHT die Template-Verzeichnisse!
        data_dirs = [
            COMPOSE_DATA_DIR,
            # Verwende nur webdock-data, nicht docker-compose-data
            os.path.join(WEBDOCK_BASE_PATH, 'webdock-data')
        ]
        
        # Log the directories we're checking
        logger.debug(f"Searching for installed containers in these directories: {data_dirs}")
        
        for data_dir in data_dirs:
            if not os.path.exists(data_dir):
                logger.debug(f"Directory does not exist: {data_dir}")
                continue
            
            logger.debug(f"Checking directory: {data_dir}")
            
            # Prüfe Unterverzeichnisse - das ist der Hauptindikator für installierte Container
            try:
                for subdir in os.listdir(data_dir):
                    subdir_path = os.path.join(data_dir, subdir)
                    if os.path.isdir(subdir_path):
                        compose_file = os.path.join(subdir_path, 'docker-compose.yml')
                        if os.path.exists(compose_file):
                            # Füge den Verzeichnisnamen als installierten Container hinzu
                            installed.add(subdir)
                            
                            # Spezielle Behandlung für bekannte Container
                            if subdir == 'code-server':
                                installed.add('codeserver')
                            elif subdir == 'node_exporter':
                                installed.add('nodeexporter')
            except Exception as e:
                logger.error(f"Error scanning subdirectories in {data_dir}: {str(e)}")
        
        # Aktualisiere den Cache
        _installed_containers_cache = installed
        _last_cache_update = current_time
        
        logger.info(f"Updated installed containers cache: {installed}")
        return installed
    except Exception as e:
        logger.error(f"Error getting installed containers: {str(e)}")
        return set()

def get_running_containers():
    """Überprüft welche Container laufen"""
    try:
        # Hole alle laufenden Container
        result = subprocess.run(
            ['docker', 'ps', '--format', '{{.Names}}'],
            capture_output=True,
            text=True
        )
        
        if result.returncode != 0:
            logger.error(f"Error running docker ps: {result.stderr}")
            return set()
            
        # Alle Container-Namen
        all_containers = set(name for name in result.stdout.strip().split('\n') if name)
        
        # Normalisierte Container-Namen (ohne Präfixe)
        normalized_containers = set()
        
        # Container-Name-Mapping für spezielle Fälle
        container_mapping = {
            "code-server": "codeserver",
            "node_exporter": "nodeexporter",
            "mosquitto-broker": "mosquitto-broker",
            "zigbee2mqtt": "zigbee2mqtt"
        }
        
        # Durchlaufe alle Container-Namen
        for container_name in all_containers:
            # Füge den vollständigen Namen hinzu
            normalized_containers.add(container_name)
            
            # Prüfe auf direkte Übereinstimmungen in der Mapping-Tabelle
            if container_name in container_mapping:
                normalized_containers.add(container_mapping[container_name])
                continue
            
            # Behandle Compose-Stack-Namen (z.B. "spoolman-spoolman-1")
            if '-' in container_name:
                parts = container_name.split('-')
                # Füge den ersten Teil hinzu (z.B. "spoolman" aus "spoolman-spoolman-1")
                if len(parts) > 0:
                    normalized_containers.add(parts[0])
                # Füge auch den zweiten Teil hinzu, falls vorhanden (z.B. "spoolman" aus "spoolman-spoolman-1")
                if len(parts) > 1:
                    normalized_containers.add(parts[1])
                
            # Entferne Präfixe (z.B. "directory_container_1" -> "container")
            parts = container_name.split('_')
            if len(parts) > 1:
                # Versuche den Basis-Namen zu extrahieren
                base_name = parts[-2] if len(parts) > 2 else parts[-1]
                normalized_containers.add(base_name)
                
                # Spezialfall für bekannte Container
                if base_name == "broker" and "mosquitto" in container_name:
                    normalized_containers.add("mosquitto-broker")
                elif base_name == "zigbee" and "mqtt" in container_name:
                    normalized_containers.add("zigbee2mqtt")
        
        logger.debug(f"Found running containers: {normalized_containers}")
        return normalized_containers
        
    except Exception as e:
        logger.exception(f"Error getting running containers: {str(e)}")
        return set()

def check_for_updates(container_name):
    """Prüft ob Updates für einen Container verfügbar sind"""
    try:
        # Hole aktuelles Image und Tag
        result = subprocess.run(
            ['docker', 'inspect', '--format', '{{.Config.Image}}', container_name],
            capture_output=True,
            text=True
        )
        if result.returncode != 0:
            return False
             
        current_image = result.stdout.strip()
         
        # Hole neuestes Image von Docker Hub
        subprocess.run(['docker', 'pull', current_image], capture_output=True)
         
        # Vergleiche Image IDs
        current = subprocess.run(
            ['docker', 'inspect', '--format', '{{.Id}}', container_name],
            capture_output=True,
            text=True
        ).stdout.strip()
         
        latest = subprocess.run(
            ['docker', 'inspect', '--format', '{{.Id}}', current_image],
            capture_output=True,
            text=True
        ).stdout.strip()
         
        return current != latest
    except Exception as e:
        logger.error(f"Error checking updates for {container_name}: {str(e)}")
        return False

@app.route('/api/containers')
def get_containers():
    """Gibt eine Liste aller verfügbaren Container zurück"""
    try:
        # Lade alle verfügbaren Container aus den Docker-Compose-Dateien
        compose_dir = COMPOSE_FILES_DIR
        if not os.path.exists(compose_dir):
            # Fallback to relative path
            compose_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'docker-templates')
        
        logger.info(f"Loading containers from {compose_dir}")
        
        # Architektur-spezifische Container-Filterung und Aliase
        arm_only_containers = ['filebrowser', 'influxdb-arm', 'watchyourlanarm']
        x86_only_containers = ['filestash', 'influxdb-x86', 'watchyourlan']
        
        # Gemeinsame Container (26 Container)
        common_containers = [
            'bambucam', 'codeserver', 'dockge', 'dozzle', 'frontail',
            'grafana', 'heimdall', 'hoarder', 'homeassistant', 'homebridge',
            'homepage', 'jellyfin', 'mosquitto-broker', 'node-red', 'nodeexporter',
            'openhab', 'paperless-ngx', 'portainer', 'prometheus', 'raspberrymatic',
            'scrypted', 'spoolman', 'uptime-kuma', 'webdock-ui', 'wud', 'zigbee2mqtt'
        ]
        
        # Container-Name-Normalisierungen
        container_aliases = {
            'whatsupdocker': 'wud',
            'code-server': 'codeserver',
            'node_exporter': 'nodeexporter',
            'paperless': 'paperless-ngx',
            'bangertech-ui': 'webdock-ui'
        }
        
        # Lade installierte Container - nur Container in docker-compose-data gelten als installiert
        installed_containers = get_installed_containers()
        logger.info(f"Installed containers: {installed_containers}")
        
        # Lade laufende Container
        running_containers = get_running_containers()
        logger.info(f"Running containers: {running_containers}")
        
        # Lade Kategorien
        categories = load_categories().get('categories', [])
        
        # Gruppiere Container nach Kategorien
        grouped_containers = {}
        
        for category_data in categories:
            category_id = category_data.get('id', '')
            category_name = category_data.get('name', category_id)
            category_icon = category_data.get('icon', 'fa-cube')
            
            if category_name not in grouped_containers:
                grouped_containers[category_name] = {
                    'name': category_name,
                    'icon': category_icon,
                    'containers': []
                }
        
        # Lade Container-Konfigurationen
        for dirname in os.listdir(compose_dir):
            # Überspringe versteckte Verzeichnisse und Dateien
            if dirname.startswith('.'):
                continue
                
            # Normalisiere Container-Namen
            container_name = container_aliases.get(dirname, dirname)
                
            # Überprüfe, ob der Container für die aktuelle Architektur verfügbar ist
            if container_name not in common_containers:
                if SYSTEM_INFO['is_arm'] and container_name in x86_only_containers:
                    logger.info(f"Skipping x86-only container {container_name} on ARM architecture")
                    continue
                if not SYSTEM_INFO['is_arm'] and container_name in arm_only_containers:
                    logger.info(f"Skipping ARM-only container {container_name} on x86 architecture")
                    continue
                
                # Wenn der Container weder in common_containers noch in den architekturspezifischen Listen ist,
                # überprüfe ob er in der anderen Architektur-Liste ist
                if SYSTEM_INFO['is_arm'] and container_name not in arm_only_containers:
                    logger.warning(f"Container {container_name} not found in common or ARM-specific containers")
                elif not SYSTEM_INFO['is_arm'] and container_name not in x86_only_containers:
                    logger.warning(f"Container {container_name} not found in common or x86-specific containers")
                
            compose_file = os.path.join(compose_dir, dirname, 'docker-compose.yml')
            if not os.path.exists(compose_file):
                continue
                
            # Bestimme die Kategorie des Containers
            category_name = _get_container_group(dirname)
            
            # Lade den Status des Containers
            # Ein Container gilt nur als installiert, wenn er in installed_containers ist
            # (d.h. in docker-compose-data gefunden wurde, nicht in docker-templates)
            is_installed = container_name in installed_containers
            # Reduziere die Protokollierung auf Debug-Level, um die Ladezeit zu verbessern
            logger.debug(f"Container {container_name} installed status: {is_installed}")
            
            status = "stopped"
            if container_name in running_containers:
                status = "running"
            
            # Spezielle Behandlung für WUD (ehemals WhatsUpDocker)
            if dirname == 'whatsupdocker':
                dirname = 'wud'
                
            # Extrahiere Port aus der Compose-Datei
            port = None
            try:
                # Spezifische Ports für bestimmte Container
                if dirname == 'homebridge':
                    port = '8581'
                elif dirname == 'nodeexporter':
                    port = '9100'
                elif dirname == 'wud':
                    port = '3004'  # Standardwert
                elif dirname == 'scrypted':
                    port = '10443'
                elif dirname == 'homeassistant':
                    port = '8123'
                elif dirname == 'openhab':
                    port = '8080'
                elif dirname == 'bambucam':
                    port = '80'
                elif dirname == 'watchyourlan' or dirname == 'watchyourlanarm':
                    # Lese den GUI-Port dynamisch aus der docker-compose.yml
                    try:
                        with open(compose_file, 'r') as f:
                            compose_data = yaml.safe_load(f)
                            if compose_data and 'services' in compose_data:
                                # Suche nach dem WatchYourLAN-Service
                                for service_name, service in compose_data['services'].items():
                                    if service_name == 'watchyourlan':
                                        # Prüfe, ob GUIPORT in den Umgebungsvariablen gesetzt ist
                                        if 'environment' in service and 'GUIPORT' in service['environment']:
                                            port = service['environment']['GUIPORT']
                                            break
                        # Fallback auf Standardwert, wenn kein Port gefunden wurde
                        if not port:
                            port = '8840'
                    except Exception as e:
                        logger.error(f"Error reading WatchYourLAN port: {str(e)}")
                        port = '8840'  # Fallback auf Standardwert
                else:
                    with open(compose_file, 'r') as f:
                        compose_data = yaml.safe_load(f)
                        if compose_data and 'services' in compose_data:
                            service_name = list(compose_data['services'].keys())[0]
                            service = compose_data['services'][service_name]
                            if 'ports' in service:
                                port = _extract_port(service['ports'])
            except Exception as e:
                logger.error(f"Error extracting port for {dirname}: {str(e)}")
            
            # Hole das Icon für den Container
            icon = get_container_icon(dirname)
            
            # Hole die Container-Beschreibung aus den Kategorien
            description = _get_container_description(dirname)
            
            # Füge den Container zur entsprechenden Kategorie hinzu
            container_info = {
                'name': dirname,
                'status': status,
                'installed': is_installed,
                'port': port,
                'icon': icon,
                'description': description
            }
            
            if category_name in grouped_containers:
                grouped_containers[category_name]['containers'].append(container_info)
            else:
                # Fallback für unbekannte Kategorien in die Imported Kategorie
                if 'Imported' not in grouped_containers:
                    grouped_containers['Imported'] = {
                        'name': 'Imported',
                        'icon': 'fa-cloud-download-alt',
                        'containers': []
                    }
                grouped_containers['Imported']['containers'].append(container_info)
        
        # Konvertiere das Dictionary in eine Liste für die Antwort
        result = []
        for category_name, category_data in grouped_containers.items():
            if category_data['containers']:  # Nur Kategorien mit Containern hinzufügen
                result.append(category_data)
        
        return jsonify(result)
    except Exception as e:
        logger.exception(f"Error getting containers: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/install', methods=['POST'])
def install_container():
    try:
        data = request.json
        logger.info(f"Received installation request with data: {data}")
        
        container_name = data.get('name')
        if not container_name:
            raise Exception("Container name is required")
        
        # Prüfe Kompatibilität mit der Systemarchitektur
        arm_only_containers = ['filebrowser', 'influxdb-arm', 'watchyourlanarm']
        x86_only_containers = ['filestash', 'influxdb-x86', 'watchyourlan']
        
        if SYSTEM_INFO['is_arm'] and container_name in x86_only_containers:
            error_msg = f"Container {container_name} ist nicht kompatibel mit ARM-Architekturen"
            logger.error(error_msg)
            return jsonify({'error': error_msg}), 400
            
        if not SYSTEM_INFO['is_arm'] and container_name in arm_only_containers:
            error_msg = f"Container {container_name} ist nur für ARM-Architekturen verfügbar"
            logger.error(error_msg)
            return jsonify({'error': error_msg}), 400
        
        # Debug-Logging für spezielle Container
        if container_name == 'mosquitto-broker':
            logger.info("=== Mosquitto Installation Debug ===")
            logger.info(f"Full request data: {data}")
            logger.info(f"Mosquitto config: {data.get('mosquitto', {})}")
            logger.info(f"Auth enabled: {data.get('mosquitto', {}).get('auth_enabled')}")
            logger.info(f"Username: {data.get('mosquitto', {}).get('username')}")
            logger.info(f"Password: {'*' * len(data.get('mosquitto', {}).get('password', ''))}")
        elif container_name == 'dockge':
            logger.info("=== Dockge Installation Debug ===")
            logger.info(f"Full request data: {data}")
            logger.info(f"Dockge config: {data.get('dockge', {})}")
            logger.info(f"Stacks directory: {data.get('dockge', {}).get('stacks_dir')}")
        
        # Verwende den korrekten Pfad für die Installation
        install_path = os.path.join(COMPOSE_DATA_DIR, container_name)
        logger.info(f"Installing container {container_name} to {install_path}")
        
        # Erstelle Basis-Verzeichnisse
        os.makedirs(install_path, exist_ok=True)
        logger.info(f"Created directory: {install_path}")
        
        # Spezielle Behandlung für verschiedene Container
        try:
            if container_name in ['mosquitto-broker', 'mosquitto']:
                success = setup_mosquitto(container_name, install_path, data)
                if not success:
                    raise Exception("Failed to setup Mosquitto")
            elif container_name in ['grafana']:
                success = setup_grafana(container_name, install_path, data)
                if not success:
                    raise Exception("Failed to setup Grafana")
            elif container_name in ['influxdb-arm', 'influxdb-x86', 'influxdb']:
                success = setup_influxdb(container_name, install_path, data)
                if not success:
                    raise Exception("Failed to setup InfluxDB")
            elif container_name in ['dockge']:
                success = setup_dockge(container_name, install_path, data)
                if not success:
                    raise Exception("Failed to setup Dockge")
            elif container_name in ['prometheus']:
                success = setup_prometheus(container_name, install_path, data)
                if not success:
                    raise Exception("Failed to setup Prometheus")
            elif container_name in ['filestash']:
                success = setup_filestash(container_name, install_path, data)
                if not success:
                    raise Exception("Failed to setup Filestash")
            elif container_name in ['hoarder']:
                success = setup_hoarder(container_name, install_path, data)
                if not success:
                    raise Exception("Failed to setup Hoarder")
            elif container_name in ['codeserver', 'code-server']:
                success = setup_codeserver(container_name, install_path, data)
                if not success:
                    raise Exception("Failed to setup Code-Server")
            elif container_name in ['watchyourlan', 'watchyourlanarm']:
                success = setup_watchyourlan(container_name, install_path, data)
                if not success:
                    raise Exception("Failed to setup WatchYourLAN")
            else:
                # Standard-Verzeichnisse für andere Container
                config_dir = os.path.join(install_path, 'config')
                data_dir = os.path.join(install_path, 'data')
                log_dir = os.path.join(install_path, 'log')
                
                # Erstelle Verzeichnisse mit korrekten Berechtigungen
                os.makedirs(config_dir, exist_ok=True)
                os.makedirs(data_dir, exist_ok=True)
                os.makedirs(log_dir, exist_ok=True)
                
                logger.info(f"Created and configured directory: {config_dir}")
                logger.info(f"Created and configured directory: {data_dir}")
                logger.info(f"Created and configured directory: {log_dir}")
                
                # Kopiere die docker-compose.yml
                compose_src = os.path.join(COMPOSE_FILES_DIR, container_name, 'docker-compose.yml')
                compose_dest = os.path.join(install_path, 'docker-compose.yml')
                
                if os.path.exists(compose_src):
                    shutil.copy2(compose_src, compose_dest)
                    logger.info(f"Copying compose file from {compose_src} to {compose_dest}")
                else:
                    logger.error(f"Compose file not found: {compose_src}")
                    raise Exception(f"Compose file not found: {compose_src}")
                
                # Aktualisiere die docker-compose.yml mit den Konfigurationsdaten
                with open(compose_dest, 'r') as f:
                    compose_content = f.read()
                
                updated_content = update_compose_file(compose_content, data)
                
                with open(compose_dest, 'w') as f:
                    f.write(updated_content)
                
                logger.info(f"Created compose file: {compose_dest}")
        except Exception as e:
            logger.error(f"Error setting up container: {str(e)}")
            return jsonify({'error': f"Error setting up container: {str(e)}"}), 500
        
        # Starte den Container
        try:
            docker_compose_cmd = get_docker_compose_cmd()
            result = subprocess.run(
                f'{docker_compose_cmd} up -d',
                shell=True,
                capture_output=True,
                text=True,
                cwd=install_path
            )
            
            if result.returncode != 0:
                logger.error(f"Error starting container: {result.stderr}")
                
                # Prüfe auf spezifische Fehler und gib benutzerfreundliche Meldungen zurück
                if "port is already allocated" in result.stderr:
                    # Extrahiere den Port aus der Fehlermeldung
                    port_match = re.search(r'Bind for 0.0.0.0:(\d+) failed: port is already allocated', result.stderr)
                    if port_match:
                        port = port_match.group(1)
                        error_msg = f"Port {port} is already in use. Please try again with a different port."
                    else:
                        error_msg = "One or more ports are already in use. Please try again with different port settings."
                    
                    logger.error(error_msg)
                    return jsonify({
                        'status': 'error',
                        'message': error_msg
                    }), 400
                else:
                    raise Exception(f"Failed to start container: {result.stderr}")
            
            logger.info(f"Started container: {container_name}")
            
            return jsonify({
                'status': 'success',
                'message': f'Container {container_name} installed successfully'
            })
            
        except Exception as e:
            logger.error(f"Error starting container: {str(e)}")
            return jsonify({
                'status': 'error',
                'message': f"Error starting container: {str(e)}"
            }), 500
            
    except Exception as e:
        logger.exception(f"Error installing container: {str(e)}")
        return jsonify({
            'status': 'error',
            'message': str(e)
        }), 500

def get_docker_compose_cmd():
    """Gibt den korrekten docker-compose Befehl zurück"""
    docker_compose_cmd = '/usr/libexec/docker/cli-plugins/docker-compose'
    if not os.path.exists(docker_compose_cmd):
        docker_compose_cmd = 'docker compose'  # Fallback auf neuen Docker Compose Befehl
    return docker_compose_cmd

@app.route('/api/toggle/<container_name>', methods=['POST'])
def toggle_container(container_name):
    try:
        # Prüfe, ob die Docker-Compose-Datei existiert
        # Verwende COMPOSE_DATA_DIR statt hartcodiertem Pfad, um Benutzereinstellungen zu respektieren
        compose_file_path = os.path.join(COMPOSE_DATA_DIR, container_name, 'docker-compose.yml')
        logger.info(f"Checking for docker-compose file at: {compose_file_path}")
        if not os.path.isfile(compose_file_path):
            logger.error(f"Docker Compose file not found for container {container_name}: {compose_file_path}")
            return jsonify({
                'status': 'error',
                'message': f"Docker Compose file not found for {container_name}. The container might not be properly installed."
            }), 404
            
        # Prüfe ob Container läuft
        result = subprocess.run(
            ['docker', 'ps', '--format', '{{.Names}}'],
            capture_output=True,
            text=True
        )
        running_containers = set(result.stdout.strip().split('\n')) if result.stdout.strip() else set()
        
        # Mögliche Container-Namen
        container_names = [
            container_name,
            f"{container_name}-1",
            f"{container_name}_1"
        ]
        
        is_running = any(name in running_containers for name in container_names)
        docker_compose_cmd = get_docker_compose_cmd()
        
        try:
            if is_running:
                # Stoppe Container
                subprocess.run(f'{docker_compose_cmd} -f {compose_file_path} down',
                             shell=True, check=True)
                message = f"Container {container_name} stopped"
            else:
                # Starte Container
                subprocess.run(f'{docker_compose_cmd} -f {compose_file_path} up -d',
                             shell=True, check=True)
                message = f"Container {container_name} started"
                
            return jsonify({
                'status': 'success',
                'message': message
            })
        except subprocess.CalledProcessError as e:
            logger.exception(f"Docker command failed for container {container_name}: {e}")
            return jsonify({
                'status': 'error',
                'message': f"Failed to {('stop' if is_running else 'start')} container {container_name}. Error: {str(e)}"
            }), 500
    except Exception as e:
        logger.exception(f"Error toggling container {container_name}")
        return jsonify({
            'status': 'error',
            'message': f"Unexpected error while toggling container {container_name}: {str(e)}"
        }), 500

@app.route('/api/update/<container_name>', methods=['POST'])
def update_container(container_name):
    try:
        # Führe Pull und Neustart durch
        compose_file = f'/home/webDock/webdock-data/{container_name}/docker-compose.yml'
        
        # Stoppe Container
        subprocess.run(['docker', 'compose', '-f', compose_file, 'down'])
        
        # Hole neuestes Image
        subprocess.run(['docker', 'compose', '-f', compose_file, 'pull'])
        
        # Starte Container neu
        subprocess.run(['docker', 'compose', '-f', compose_file, 'up', '-d'])
        
        return jsonify({
            'status': 'success',
            'message': f'Container {container_name} updated successfully'
        })
    except Exception as e:
        logger.exception(f"Error updating container {container_name}")
        return jsonify({
            'status': 'error',
            'message': str(e)
        }), 500

@app.route('/static/img/<path:filename>')
def serve_image(filename):
    try:
        return send_from_directory(app.static_folder + '/img', filename)
    except:
        return send_from_directory(app.static_folder + '/img/icons', 'webdock.png')

@app.route('/api/system/status')
def get_system_status():
    try:
        # CPU-Auslastung
        cpu_percent = psutil.cpu_percent(interval=1)
        
        # Speicher-Auslastung
        memory = psutil.virtual_memory()
        memory_percent = memory.percent
        
        # Festplatten-Auslastung
        disk = psutil.disk_usage('/')
        disk_percent = disk.percent
        
        return jsonify({
            'cpu': round(cpu_percent, 1),
            'memory': round(memory_percent, 1),
            'disk': round(disk_percent, 1)
        })
    except Exception as e:
        logger.exception("Error getting system status")
        return {'error': str(e)}, 500

@app.route('/api/containers/health')
def get_containers_health():
    """Holt den Gesundheitszustand aller Container"""
    try:
        health_data = []
        
        # Hole Liste aller Container
        result = subprocess.run(
            ['docker', 'ps', '-a', '--format', '{{.ID}}\t{{.Names}}\t{{.Status}}'],
            capture_output=True,
            text=True,
            check=True
        )
        
        # Hole Ressourcennutzung für alle laufenden Container
        stats_result = subprocess.run(
            ['docker', 'stats', '--no-stream', '--format', '{{.ID}}\t{{.Name}}\t{{.CPUPerc}}\t{{.MemPerc}}'],
            capture_output=True,
            text=True
        )
        
        # Parse die Statistikdaten
        stats_data = {}
        if stats_result.returncode == 0:
            for line in stats_result.stdout.splitlines():
                parts = line.split('\t')
                if len(parts) >= 4:
                    container_id = parts[0]
                    stats_data[container_id] = {
                        'cpu': parts[2],
                        'memory': parts[3]
                    }
        
        for line in result.stdout.splitlines():
            try:
                container_id, name, status = line.split('\t')
                
                # Basis-Container-Informationen
                container_info = {
                    'id': container_id[:12],
                    'name': name,
                    'status': status.lower(),
                    'health': 'unknown',
                    'cpu': 'N/A',
                    'memory': 'N/A'
                }
                
                # Füge Ressourcennutzung hinzu, wenn verfügbar
                if container_id in stats_data:
                    container_info['cpu'] = stats_data[container_id]['cpu']
                    container_info['memory'] = stats_data[container_id]['memory']
                
                # Prüfe Container-Zustand
                if 'up' in status.lower():
                    # Hole detaillierte Container-Informationen
                    inspect_result = subprocess.run(
                        ['docker', 'inspect', container_id],
                        capture_output=True,
                        text=True,
                        check=True
                    )
                    
                    inspect_data = json.loads(inspect_result.stdout)[0]
                    state = inspect_data.get('State', {})
                    
                    # Hole Zeitstempel
                    timestamp = state.get('StartedAt', '')
                    
                    # Prüfe ob Zeitstempel vorhanden und gültig ist
                    if timestamp and len(timestamp) >= 19:
                        try:
                            timestamp = timestamp[:19]  # YYYY-MM-DDTHH:MM:SS
                            started_at = datetime.strptime(timestamp, '%Y-%m-%dT%H:%M:%S').replace(tzinfo=timezone.utc)
                            uptime = datetime.now(timezone.utc) - started_at
                            container_info['uptime'] = str(uptime).split('.')[0]  # Ohne Millisekunden
                        except ValueError as e:
                            logger.warning(f"Invalid timestamp format for container {name}: {timestamp}")
                            container_info['uptime'] = 'unknown'
                    else:
                        container_info['uptime'] = 'unknown'

                    # Prüfe Health Check falls vorhanden
                    health = state.get('Health', {}).get('Status', 'none')
                    container_info['health'] = health if health != 'none' else 'running'
                
                health_data.append(container_info)

            except Exception as e:
                logger.error(f"Error processing container {line}: {str(e)}")
                continue

        return jsonify(health_data)

    except subprocess.CalledProcessError as e:
        logger.error(f"Error getting container health: {e.stderr}")
        return jsonify([]), 500
    except Exception as e:
        logger.error(f"Error getting container health: {str(e)}")
        return jsonify([]), 500

@app.route('/api/system/logs')
def get_system_logs():
    """Gibt die System-Logs zurück"""
    try:
        logs = []
        current_time = datetime.now()
        
        def format_timestamp(dt):
            """Formatiert einen Zeitstempel im einheitlichen Format"""
            return dt.strftime('%d.%m.%Y, %H:%M:%S')
        
        def add_log(message, level='INFO', source='system', timestamp=None):
            """Fügt einen Log-Eintrag mit einheitlichem Format hinzu"""
            if timestamp is None:
                timestamp = current_time
            
            # Standardisiere Level
            level = level.upper()
            if level not in ['INFO', 'WARNING', 'ERROR', 'STATUS']:
                level = 'INFO'
            
            logs.append({
                'timestamp': format_timestamp(timestamp),
                'level': level,
                'source': source,
                'message': message.strip()
            })
        
        # 1. Hole Docker Container Logs mit verbessertem Format
        cmd = ["docker", "logs", "--tail", "50", "--timestamps", "webdock-ui"]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                try:
                    # Trenne Zeitstempel vom Rest der Nachricht
                    if len(line) > 30:  # Mindestlänge für Zeitstempel + Nachricht
                        timestamp_str = line[:30].strip()
                        message = line[30:].strip()
                        
                        try:
                            timestamp = datetime.strptime(timestamp_str, '%Y-%m-%dT%H:%M:%S.%fZ')
                        except ValueError:
                            timestamp = current_time
                        
                        # Bestimme Log-Level basierend auf Schlüsselwörtern
                        level = 'INFO'
                        if any(word in message.lower() for word in ['error', 'exception', 'fail', 'critical']):
                            level = 'ERROR'
                        elif any(word in message.lower() for word in ['warn', 'warning']):
                            level = 'WARNING'
                        
                        add_log(message, level, 'webdock-ui', timestamp)
                except Exception as e:
                    logger.error(f"Error parsing log line: {e}")
                    continue
        
        # 2. Hole Docker Container Status mit verbessertem Format
        cmd = ["docker", "ps", "-a", "--format", "{{.Names}}\t{{.Status}}\t{{.State}}"]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                try:
                    name, status, state = line.split('\t')
                    # Formatiere Status-Nachricht
                    message = f"Container {name}"
                    if 'running' in state.lower():
                        if 'unhealthy' in status.lower():
                            message += " ist nicht gesund"
                            level = 'WARNING'
                        else:
                            message += f" läuft {status.lower()}"
                            level = 'INFO'
                    elif 'exited' in state.lower():
                        message += " ist gestoppt"
                        level = 'WARNING'
                    else:
                        message += f" Status: {state}"
                        level = 'INFO'
                    
                    add_log(message, level, 'docker')
                except Exception as e:
                    logger.error(f"Error parsing status: {e}")
                    continue
        
        # 3. Hole System-Informationen
        try:
            # CPU-Auslastung
            cpu_percent = psutil.cpu_percent(interval=1)
            add_log(f"CPU-Auslastung: {cpu_percent}%", 'INFO', 'system')
            
            # RAM-Auslastung
            memory = psutil.virtual_memory()
            memory_percent = memory.percent
            add_log(f"RAM-Auslastung: {memory_percent}%", 
                   'WARNING' if memory_percent > 80 else 'INFO', 
                   'system')
            
            # Festplattennutzung
            disk = psutil.disk_usage('/')
            disk_percent = disk.percent
            add_log(f"Festplattennutzung: {disk_percent}%",
                   'WARNING' if disk_percent > 80 else 'INFO',
                   'system')
            
        except Exception as e:
            add_log(f"Fehler beim Abrufen der Systeminfos: {str(e)}", 'ERROR', 'system')
        
        # Sortiere Logs nach Zeitstempel (neueste zuerst)
        logs.sort(key=lambda x: datetime.strptime(x['timestamp'], '%d.%m.%Y, %H:%M:%S'), reverse=True)
        
        return jsonify({
            'logs': logs[:100],  # Limitiere auf die letzten 100 Einträge
            'summary': {
                'total': len(logs),
                'error_count': sum(1 for log in logs if log['level'] == 'ERROR'),
                'warning_count': sum(1 for log in logs if log['level'] == 'WARNING'),
                'info_count': sum(1 for log in logs if log['level'] == 'INFO')
            }
        })
        
    except Exception as e:
        logger.error(f"Error reading logs: {str(e)}")
        return jsonify({
            'logs': [{
                'timestamp': format_timestamp(current_time),
                'level': 'ERROR',
                'message': f"Fehler beim Lesen der Logs: {str(e)}",
                'source': 'system'
            }],
            'summary': {
                'total': 1,
                'error_count': 1,
                'warning_count': 0,
                'info_count': 0
            }
        })

@app.route('/api/docker/info')
def get_docker_info():
    try:
        # Hole Docker-Version
        version_cmd = ["docker", "version", "--format", "{{.Server.Version}}"]
        version_result = subprocess.run(version_cmd, capture_output=True, text=True)
        version = version_result.stdout.strip() if version_result.returncode == 0 else "Unknown"
        
        # Hole Standard-Netzwerk
        network_cmd = ["docker", "network", "ls", "--filter", "name=bridge", "--format", "{{.Name}}"]
        network_result = subprocess.run(network_cmd, capture_output=True, text=True)
        network = network_result.stdout.strip() if network_result.returncode == 0 else "bridge"
        
        return jsonify({
            'version': version,
            'network': network
        })
    except Exception as e:
        logger.exception("Error getting Docker info")
        return {'error': str(e)}, 500

@app.route('/api/settings/data-location', methods=['GET', 'POST'])
def handle_data_location():
    # Verwende eine Konfigurationsdatei im WebDock-Konfigurationsverzeichnis
    config_file = os.path.join(CONFIG_DIR, 'data_location.json')
    try:
        if request.method == 'POST':
            new_location = request.json.get('location')
            if not new_location:
                return jsonify({
                    'status': 'error',
                    'message': 'No location provided'
                }), 400
 
            # Validiere und erstelle das Verzeichnis
            try:
                os.makedirs(new_location, exist_ok=True)
                # Teste Schreibrechte
                test_file = os.path.join(new_location, '.test')
                with open(test_file, 'w') as f:
                    f.write('test')
                os.remove(test_file)
            except Exception as e:
                return jsonify({
                    'status': 'error',
                    'message': f'Cannot write to directory: {str(e)}'
                }), 400
 
            # Speichere die Einstellung
            config = {'data_location': new_location}
            with open(config_file, 'w') as f:
                json.dump(config, f)
 
            return jsonify({
                'status': 'success',
                'message': 'Data location updated',
                'location': new_location
            })
        else:
            # Lade die aktuelle Einstellung
            try:
                with open(config_file, 'r') as f:
                    config = json.load(f)
                    return jsonify({
                        'location': config.get('data_location', COMPOSE_DATA_DIR)
                    })
            except FileNotFoundError:
                return jsonify({
                    'location': COMPOSE_DATA_DIR
                })
 
    except Exception as e:
        logger.exception("Error handling data location")
        return {'error': str(e)}, 500

@app.route('/api/browse-directories', methods=['GET'])
def browse_directories():
    try:
        current_path = request.args.get('path', '/')
        
        # Sichere den Pfad ab
        current_path = os.path.abspath(current_path)
        if not os.path.exists(current_path):
            current_path = '/'
        
        # Hole Verzeichnisse
        directories = []
        try:
            for entry in os.scandir(current_path):
                if entry.is_dir() and not entry.name.startswith('.'):
                    directories.append({
                        'name': entry.name,
                        'path': os.path.join(current_path, entry.name)
                    })
        except PermissionError:
            return jsonify({
                'status': 'error',
                'message': 'Permission denied'
            }), 403
        
        return jsonify({
            'current_path': current_path,
            'parent_path': os.path.dirname(current_path) if current_path != '/' else None,
            'directories': sorted(directories, key=lambda x: x['name'])
        })
    except Exception as e:
        logger.exception("Error browsing directories")
        return {'error': str(e)}, 500

@app.route('/api/categories', methods=['GET', 'POST', 'PUT', 'DELETE'])
def manage_categories():
    categories_file = '/app/categories.yaml'
    try:
        if request.method == 'GET':
            categories = load_categories()
            return jsonify(categories)
             
        elif request.method == 'POST':
            # Neue Kategorie hinzufügen
            data = request.json
            categories = load_categories()
            if 'categories' not in categories:
                categories['categories'] = {}
             
            category_id = data['name'].lower().replace(' ', '_')
            categories['categories'][category_id] = {
                'name': data['name'],
                'icon': data['icon'],
                'description': data['description'],
                'containers': data['containers']
            }
             
            with open(categories_file, 'w') as f:
                yaml.dump(categories, f)
             
            return jsonify({'status': 'success', 'message': 'Category added'})
             
        elif request.method == 'PUT':
            # Kategorie aktualisieren
            data = request.json
            categories = load_categories()
            
            category_id = request.args.get('id')  # ID aus der URL holen
            if category_id in categories['categories']:
                categories['categories'][category_id] = {
                    'name': data['name'],
                    'icon': data['icon'],
                    'description': data['description'],
                    'containers': data['containers']
                }
                 
                with open(categories_file, 'w') as f:
                    yaml.dump(categories, f)
                 
                return jsonify({'status': 'success', 'message': 'Category updated'})
             
            return jsonify({'status': 'error', 'message': 'Category not found'}), 404
             
        elif request.method == 'DELETE':
            # Kategorie löschen
            category_id = request.args.get('id')
            categories = load_categories()
             
            if category_id in categories['categories']:
                del categories['categories'][category_id]
                 
                with open(categories_file, 'w') as f:
                    yaml.dump(categories, f)
                 
                return jsonify({'status': 'success', 'message': 'Category deleted'})
             
            return jsonify({'status': 'error', 'message': 'Category not found'}), 404
             
    except Exception as e:
        logger.exception("Error managing categories")
        return {'error': str(e)}, 500

@app.route('/api/container/move', methods=['POST'])
def move_container():
    data = request.get_json()
    container_name = data.get('containerName')
    source_category = data.get('sourceCategory')
    target_category = data.get('targetCategory')
    target_position = data.get('targetPosition', -1)  # -1 bedeutet ans Ende anhängen
    
    if not all([container_name, source_category, target_category]):
        return jsonify({'error': 'Missing required fields'}), 400
        
    logger.info(f"Moving container {container_name} from {source_category} to {target_category} at position {target_position}")
        
    try:
        # Ensure CONFIG_DIR exists
        os.makedirs(CONFIG_DIR, exist_ok=True)
        
        # Load categories
        categories_file = os.path.join(CONFIG_DIR, 'categories.yaml')
        
        # Check if file exists, if not create it with default structure
        if not os.path.exists(categories_file):
            logger.info(f"Categories file not found, creating new one at {categories_file}")
            default_categories = {
                'categories': [
                    {
                        'id': 'System',
                        'name': 'System',
                        'icon': 'fa-server',
                        'containers': []
                    },
                    {
                        'id': 'Media',
                        'name': 'Media',
                        'icon': 'fa-photo-video',
                        'containers': []
                    }
                ]
            }
            with open(categories_file, 'w') as f:
                yaml.safe_dump(default_categories, f, default_flow_style=False)
            data = default_categories
        else:
            # Load existing categories file
            try:
                with open(categories_file, 'r') as f:
                    data = yaml.safe_load(f)
            except Exception as e:
                logger.error(f"Error loading categories file: {e}")
                # Create default structure if file can't be loaded
                data = {'categories': []}
            
        if not data or 'categories' not in data:
            data = {'categories': []}
            
        categories = data['categories']
        source_category_data = None
        target_category_data = None
        container_data = None
        
        # Find source and target categories by ID or name
        for category in categories:
            # Check for ID match
            if category.get('id') == source_category:
                source_category_data = category
            if category.get('id') == target_category:
                target_category_data = category
                
            # Also check for name match as fallback
            if not source_category_data and category.get('name') == source_category:
                source_category_data = category
            if not target_category_data and category.get('name') == target_category:
                target_category_data = category
                
        # If categories not found, create them
        if not source_category_data:
            logger.info(f"Creating source category: {source_category}")
            source_category_data = {
                'id': source_category,
                'name': source_category,
                'icon': 'fa-cube',
                'containers': []
            }
            categories.append(source_category_data)
            
        if not target_category_data:
            logger.info(f"Creating target category: {target_category}")
            target_category_data = {
                'id': target_category,
                'name': target_category,
                'icon': 'fa-cube',
                'containers': []
            }
            categories.append(target_category_data)
            
        # Ensure containers lists exist
        if 'containers' not in source_category_data:
            source_category_data['containers'] = []
            
        if 'containers' not in target_category_data:
            target_category_data['containers'] = []
            
        # Find and remove container from source category
        source_containers = source_category_data.get('containers', [])
        container_found = False
        
        for i, container in enumerate(source_containers):
            if isinstance(container, dict) and container.get('name') == container_name:
                container_data = source_category_data['containers'].pop(i)
                container_found = True
                break
            elif isinstance(container, str) and container == container_name:
                container_data = {'name': container_name}
                source_category_data['containers'].pop(i)
                container_found = True
                break
        
        # Wenn der Container nicht in der Quellkategorie gefunden wurde,
        # erstelle einen neuen Eintrag (für nicht-installierte Container)
        if not container_found:
            logger.info(f"Container {container_name} wurde nicht in der Quellkategorie gefunden, erstelle neuen Eintrag")
            container_data = {'name': container_name}
            # Wir löschen nichts aus der Quellkategorie, da der Container dort nicht existiert
            
        # Add container to target category with position handling
        if target_position >= 0 and target_position < len(target_category_data['containers']):
            # Füge an spezifischer Position ein
            target_category_data['containers'].insert(target_position, container_data)
            logger.info(f"Container {container_name} an Position {target_position} eingefügt")
        else:
            # Füge am Ende ein
            target_category_data['containers'].append(container_data)
            logger.info(f"Container {container_name} am Ende eingefügt")
        
        # Save updated categories
        try:
            with open(categories_file, 'w') as f:
                yaml.safe_dump(data, f, default_flow_style=False)
        except Exception as e:
            logger.error(f"Error saving categories file: {e}")
            return jsonify({'error': f'Could not save categories file: {str(e)}'}), 500
            
        return jsonify({'success': True})
        
    except Exception as e:
        logger.exception(f"Error moving container: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/container/reorder', methods=['POST'])
def reorder_container():
    """Ordnet einen Container innerhalb einer Kategorie neu an"""
    try:
        data = request.get_json()
        container_name = data.get('container') or data.get('containerName')
        category_id = data.get('toGroup') or data.get('categoryId')
        from_position = data.get('fromPosition', -1)
        to_position = data.get('toPosition', -1)
        
        # Log für Debugging
        logger.info(f"Received reorder request: {data}")
        
        # Wenn keine Kategorie-ID angegeben ist, verwende 'default'
        if not category_id or category_id == 'undefined':
            category_id = 'default'
            
        if not container_name or from_position < 0 or to_position < 0:
            logger.error(f"Missing or invalid fields: container={container_name}, from={from_position}, to={to_position}")
            return jsonify({'error': 'Missing or invalid required fields'}), 400
            
        logger.info(f"Reordering container {container_name} in category {category_id} from position {from_position} to {to_position}")
        
        # Kategorien laden - verwende die load_categories Funktion, die bereits Fehlerbehandlung enthält
        categories_data = load_categories()
        
        if not categories_data or 'categories' not in categories_data:
            # Wenn keine Kategorien gefunden wurden, erstelle eine leere Kategorie-Struktur
            categories_data = {'categories': []}
            
        # Stelle sicher, dass categories eine Liste ist (für die Kompatibilität mit älteren Versionen)
        if isinstance(categories_data['categories'], dict):
            # Konvertiere das Dictionary in eine Liste von Kategorien
            categories_list = []
            for cat_id, cat_data in categories_data['categories'].items():
                cat_data['id'] = cat_id
                categories_list.append(cat_data)
            categories_data['categories'] = categories_list
            
        # Logge die Kategorien-Struktur für Debugging
        logger.debug(f"Categories structure: {categories_data}")
        
        # Finde die Kategorie
        category_found = False
        category = None  # Definiere die Variable category außerhalb der Schleife
        
        for cat in categories_data['categories']:
            # Prüfe, ob die Kategorie-ID oder der Name mit der gesuchten ID übereinstimmt
            if cat.get('id') == category_id or cat.get('name') == category_id:
                category = cat  # Setze die gefundene Kategorie
                category_found = True
                if 'containers' not in category:
                    category['containers'] = []
                
                # Stelle sicher, dass containers eine Liste ist
                if not isinstance(category['containers'], list):
                    category['containers'] = []
                    logger.warning(f"Containers was not a list in category {category_id}, reset to empty list")
                
                # Normalisiere die Container-Liste, falls sie verschiedene Formate enthält
                normalized_containers = []
                for container_item in category['containers']:
                    if isinstance(container_item, str):
                        normalized_containers.append({'name': container_item})
                    else:
                        normalized_containers.append(container_item)
                category['containers'] = normalized_containers
                
                # Wenn wir hier sind, haben wir die richtige Kategorie gefunden
                # Prüfe, ob die Position gültig ist
                if len(category['containers']) <= from_position:
                    # Wenn der Container nicht an der angegebenen Position existiert,
                    # füge ihn einfach zur Kategorie hinzu
                    logger.warning(f"Container position {from_position} not found in category {category_id} with {len(category['containers'])} containers")
                    logger.info(f"Adding container {container_name} to category {category_id}")
                    category['containers'].append({'name': container_name})
                    break
                    
                # Hole den Container an der from_position
                container = category['containers'].pop(from_position)
                logger.info(f"Removed container at position {from_position}: {container}")
                
                # Wir verwenden den Container, der tatsächlich an der Position gefunden wurde
                # anstatt zu prüfen, ob der Name übereinstimmt
                container_name_in_list = container
                if isinstance(container, dict):
                    container_name_in_list = container.get('name')
                    # Aktualisiere den Container-Namen für den Fall, dass wir ihn später einfügen
                    container = container  # Behalte das Dictionary bei
                else:
                    # Wenn es ein String ist, konvertiere es in ein Dictionary
                    container = {'name': container}
                
                # Anpassen der Zielposition, wenn sie größer als die Quellposition ist
                # (da wir bereits ein Element entfernt haben)
                adjusted_to_position = to_position
                if from_position < to_position:
                    # Wenn wir nach unten verschieben, müssen wir die Position anpassen,
                    # da wir bereits ein Element entfernt haben
                    adjusted_to_position = max(0, min(len(category['containers']), to_position))
                
                # Füge den Container an der to_position ein
                if adjusted_to_position >= len(category['containers']):
                    logger.info(f"Appending container to end of list (position {len(category['containers'])})")
                    category['containers'].append(container)
                else:
                    logger.info(f"Inserting container at position {adjusted_to_position}")
                    category['containers'].insert(adjusted_to_position, container)
                break
                
        if not category_found:
            # Erstelle die Kategorie, wenn sie nicht existiert
            logger.info(f"Kategorie {category_id} nicht gefunden, erstelle sie")
            new_category = {
                'id': category_id,
                'name': category_id,
                'icon': 'fa-cube',
                'containers': [{'name': container_name}]  # Füge den Container direkt hinzu
            }
            categories_data['categories'].append(new_category)
            
            # Setze die Kategorie für die weitere Verarbeitung
            category = new_category
            category_found = True
            
        # Speichere die aktualisierten Kategorien
        categories_file = os.path.join(CONFIG_DIR, 'categories.yaml')
        
        # Stelle sicher, dass das Verzeichnis existiert
        os.makedirs(os.path.dirname(categories_file), exist_ok=True)
        
        with open(categories_file, 'w') as f:
            yaml.safe_dump(categories_data, f, default_flow_style=False)
            
        return jsonify({'success': True})
        
    except Exception as e:
        logger.exception(f"Error reordering container: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/categories/order', methods=['POST'])
def update_category_order():
    try:
        data = request.json
        categories = load_categories()
        
        # Aktualisiere die Positionen
        for category_id, update in data.items():
            if category_id in categories['categories']:
                categories['categories'][category_id]['position'] = update['position']
        
        # Speichere die aktualisierten Kategorien
        with open('/app/categories.yaml', 'w') as f:
            yaml.dump(categories, f)
        
        return jsonify({'status': 'success', 'message': 'Category order updated'})
    except Exception as e:
        logger.exception("Error updating category order")
        return {'error': str(e)}, 500

def init_app():
    """Initialisiert die Anwendung"""
    try:
        # Erstelle notwendige Verzeichnisse
        os.makedirs('/app/config', exist_ok=True)
        os.makedirs('/app/data', exist_ok=True)
        
        # Überprüfe, ob wir lokale Dateien verwenden
        # Wir prüfen einfach, ob das Verzeichnis existiert und Dateien enthält
        if os.path.exists(COMPOSE_FILES_DIR) and os.listdir(COMPOSE_FILES_DIR):
            # Wenn wir lokale Dateien verwenden, nicht herunterladen
            logger.info("Found 0 directories: []")
            logger.info(f"Using local compose files from {COMPOSE_FILES_DIR}")
        else:
            # Ansonsten lade die docker-compose Files beim Start
            logger.info("Downloading compose files on startup...")
            download_compose_files()
        
        # Lade oder erstelle Kategorien
        categories = load_categories()
        logger.info(f"Loaded categories: {categories}")
        
        return True
    except Exception as e:
        logger.error(f"Error initializing app: {e}")
        return False

def get_container_config_internal(container_name):
    """Liest die Konfiguration eines Containers aus seiner docker-compose.yml (interne Funktion)"""
    try:
        compose_path = os.path.join(COMPOSE_FILES_DIR, container_name, 'docker-compose.yml')
        if not os.path.exists(compose_path):
            return None
             
        with open(compose_path, 'r') as f:
            compose_data = yaml.safe_load(f)
             
        if not compose_data or 'services' not in compose_data:
            return None
             
        service_data = compose_data['services'].get(container_name, {})
         
        # Extrahiere relevante Konfiguration
        config = {
            'ports': [],
            'env': {}
        }
         
        # Extrahiere Ports
        if 'ports' in service_data:
            for port in service_data['ports']:
                if isinstance(port, str) and ':' in port:
                    host_port = port.split(':')[0]
                    config['ports'].append(int(host_port))
         
        # Extrahiere Umgebungsvariablen
        if 'environment' in service_data:
            env_vars = service_data['environment']
            if isinstance(env_vars, list):
                for env in env_vars:
                    if '=' in env:
                        key, value = env.split('=', 1)
                        config['env'][key] = value
            elif isinstance(env_vars, dict):
                config['env'] = env_vars
         
        return config
    except Exception as e:
        logger.error(f"Error reading config for {container_name}: {str(e)}")
        return None

@app.route('/api/container/<container_name>/config')
def get_container_config(container_name):
    """Gibt die Konfiguration eines Containers zurück"""
    try:
        # Prüfe, ob Template-Konfiguration angefordert wurde
        template = request.args.get('template', 'false').lower() == 'true'
        
        # Debug-Ausgabe hinzufügen
        logger.info(f"COMPOSE_FILES_DIR: {COMPOSE_FILES_DIR}")
        logger.info(f"COMPOSE_DATA_DIR: {COMPOSE_DATA_DIR}")

        # Bestimme den Pfad zur docker-compose.yml
        if template:
            # Verwende die Template-Datei aus dem docker-templates Verzeichnis
            # Stelle sicher, dass wir den Container-Pfad verwenden
            compose_file = os.path.join(COMPOSE_FILES_DIR, container_name, 'docker-compose.yml')
            logger.info(f"Suche Template-Datei unter: {compose_file}")
        else:
            # Verwende die installierte Datei aus dem docker-compose-data Verzeichnis
            compose_file = os.path.join(COMPOSE_DATA_DIR, container_name, 'docker-compose.yml')
            logger.info(f"Suche installierte Datei unter: {compose_file}")
        
        # Prüfe, ob die Datei existiert
        if not os.path.exists(compose_file):
            logger.error(f"Compose file not found: {compose_file}")
            return jsonify({'error': 'Compose file not found'}), 404
        
        # Lese die docker-compose.yml
        with open(compose_file, 'r') as f:
            yaml_content = f.read()
        
        # Parse YAML für die Antwort
        try:
            yaml_data = yaml.safe_load(yaml_content)
            
            # Extrahiere das erste Service aus der Compose-Datei
            service_data = None
            if yaml_data and 'services' in yaml_data:
                service_name = list(yaml_data['services'].keys())[0]
                service_data = yaml_data['services'][service_name]
            
            return jsonify({
                'yaml': yaml_content,
                'parsed': yaml_data,
                'service': service_data
            })
        except Exception as e:
            logger.error(f"Error parsing YAML: {str(e)}")
            return jsonify({
                'yaml': yaml_content,
                'error': f"Error parsing YAML: {str(e)}"
            })
        
    except Exception as e:
        logger.exception(f"Error getting container config: {str(e)}")
        return jsonify({'error': str(e)}), 500
        return jsonify({'error': str(e)}), 500

@app.route('/api/container/<container_name>/restart', methods=['POST'])
def restart_container(container_name):
    try:
        compose_file = f'/home/webDock/webdock-data/{container_name}/docker-compose.yml'
        
        # Neustart des Containers
        subprocess.run(['docker', 'compose', '-f', compose_file, 'down'])
        subprocess.run(['docker', 'compose', '-f', compose_file, 'up', '-d'])
        
        return jsonify({
            'status': 'success',
            'message': f'Container {container_name} restarted successfully'
        })
    except Exception as e:
        logger.exception(f"Error restarting {container_name}")
        return jsonify({
            'status': 'error',
            'message': str(e)
        }), 500

def update_port_mapping(compose_content, new_port):
    """Aktualisiert Port-Mappings in der docker-compose.yml"""
    try:
        compose_data = yaml.safe_load(compose_content)
        
        # Finde den Service-Namen (normalerweise der erste Service)
        service_name = list(compose_data['services'].keys())[0]
        service = compose_data['services'][service_name]
        
        if 'ports' in service:
            # Hole den Container-Port (der Teil nach dem :)
            original_mapping = str(service['ports'][0])
            if ':' in original_mapping:
                container_port = original_mapping.split(':')[1]
            else:
                container_port = original_mapping
            
            # Erstelle neues Port-Mapping
            service['ports'][0] = f"{new_port}:{container_port}"
        
        # Konvertiere zurück zu YAML
        return yaml.dump(compose_data, default_flow_style=False)
    except Exception as e:
        logger.error(f"Error updating port mapping: {str(e)}")
        raise

@app.route('/api/container/<container_name>/info')
def container_info(container_name):
    """Gibt Informationen über einen Container zurück"""
    try:
        # Spezialfall für webdock-ui, da dieser Container die Anwendung selbst ist
        if container_name == 'webdock-ui':
            # Verwende den Pfad des aktuellen Containers
            container_path = os.path.dirname(os.path.abspath(__file__))
            # Überprüfe, ob die docker-compose.yml im Elternverzeichnis existiert
            parent_dir = os.path.dirname(container_path)
            if os.path.exists(os.path.join(parent_dir, 'docker-compose.yml')):
                container_path = parent_dir
            else:
                # Fallback: Suche in den Standard-Verzeichnissen
                container_path = WEBDOCK_BASE_PATH
        else:
            # Standard-Pfadprüfung für andere Container
            install_path = os.path.join(COMPOSE_DATA_DIR, container_name)
            compose_files_path = os.path.join(WEBDOCK_BASE_PATH, 'docker-templates', container_name)
            
            # Prüfe beide mögliche Pfade
            if os.path.exists(install_path):
                container_path = install_path
            elif os.path.exists(compose_files_path):
                container_path = compose_files_path
            else:
                return jsonify({'error': 'Container not installed'}), 404
        
        # Hole Container-Status
        status = "stopped"
        running_containers = get_running_containers()
        if container_name in running_containers:
            status = "running"
        
        # Hole Container-Informationen mit Docker
        container_info = None
        compose_data = None
        
        # Hole Compose-Datei
        compose_file = os.path.join(container_path, 'docker-compose.yml')
        compose_content = None
        if os.path.exists(compose_file):
            with open(compose_file, 'r') as f:
                compose_content = f.read()
                try:
                    compose_data = yaml.safe_load(compose_content)
                except Exception as e:
                    logger.error(f"Error parsing compose file: {str(e)}")
        
        # Extrahiere Port-Informationen aus der Compose-Datei
        ports = {}
        volumes = []
        network_mode = 'default'
        
        if compose_data and 'services' in compose_data:
            service_name = list(compose_data['services'].keys())[0]
            service = compose_data['services'][service_name]
            
            # Extract ports
            if 'ports' in service:
                for port_mapping in service['ports']:
                    if isinstance(port_mapping, str) and ':' in port_mapping:
                        host_port, container_port = port_mapping.split(':')
                        ports[container_port] = host_port
            
            # Extract volumes
            if 'volumes' in service:
                for volume in service['volumes']:
                    if isinstance(volume, str) and ':' in volume:
                        parts = volume.split(':')
                        if len(parts) >= 2:
                            volumes.append({
                                'source': parts[0],
                                'destination': parts[1],
                                'type': 'bind'
                            })
            
            # Extract network mode
            if 'network_mode' in service:
                network_mode = service['network_mode']
        
        # Spezielle Behandlung für bestimmte Container
        if container_name == 'scrypted' and not ports:
            # Scrypted verwendet Port 10443, auch wenn er nicht in der Compose-Datei definiert ist
            ports['10443/tcp'] = '10443'
            logger.info("Added default port 10443 for Scrypted")
        
        if container_name == 'node-exporter' and network_mode == 'host':
            # Node Exporter verwendet Port 9100 im Host-Netzwerk-Modus
            ports['9100/tcp'] = '9100'
            logger.info("Added default port 9100 for Node Exporter in host network mode")
        
        # Default container info from compose file
        default_container_info = {
            'name': container_name,
            'image': compose_data['services'][service_name].get('image', 'unknown') if compose_data and 'services' in compose_data else 'unknown',
            'status': status,
            'ports': ports,
            'volumes': volumes,
            'network': network_mode
        }
        
        # Try to get more detailed info if container is running
        if status == "running":
            try:
                # Suche nach möglichen Container-Namen
                possible_names = [
                    container_name,
                    f"{container_name}-1",
                    f"{container_name}_1"
                ]
                
                if 'install_path' in locals():
                    possible_names.append(f"{os.path.basename(install_path)}_{container_name}_1")
                
                # Hole alle laufenden Container
                result = subprocess.run(
                    ['docker', 'ps', '--format', '{{.ID}}\t{{.Names}}'],
                    capture_output=True, text=True, check=True
                )
                
                container_id = None
                for line in result.stdout.strip().split('\n'):
                    if not line:
                        continue
                    parts = line.split('\t')
                    if len(parts) < 2:
                        continue
                    
                    id, name = parts
                    # Prüfe, ob der Name mit einem der möglichen Namen übereinstimmt
                    if any(possible_name in name for possible_name in possible_names if possible_name):
                        container_id = id
                        break
                
                if not container_id:
                    # Versuche es mit einem allgemeineren Filter
                    result = subprocess.run(
                        ['docker', 'ps', '--filter', f"name={container_name}", '--format', '{{.ID}}'],
                        capture_output=True, text=True, check=True
                    )
                    if result.stdout.strip():
                        container_id = result.stdout.strip().split('\n')[0]
                
                if container_id:
                    # Hole Container-Details
                    result = subprocess.run(
                        ['docker', 'inspect', container_id],
                        capture_output=True, text=True, check=True
                    )
                    inspect_data = json.loads(result.stdout)
                    
                    if inspect_data and len(inspect_data) > 0:
                        container_data = inspect_data[0]
                        
                        # Extrahiere Port-Mappings
                        port_mappings = {}
                        docker_ports = container_data.get('NetworkSettings', {}).get('Ports', {})
                        for container_port, bindings in docker_ports.items():
                            if bindings:
                                port_mappings[container_port] = bindings[0]['HostPort']
                        
                        # Wenn keine Ports aus Docker gefunden wurden, verwende die aus der Compose-Datei
                        if not port_mappings and ports:
                            port_mappings = {f"{port}/tcp": host_port for port, host_port in ports.items() if not port.endswith('/tcp')}
                        
                        # Spezielle Behandlung für bestimmte Container
                        if container_name == 'scrypted' and not port_mappings:
                            # Scrypted verwendet Port 10443, auch wenn er nicht in den Port-Mappings gefunden wurde
                            port_mappings['10443/tcp'] = '10443'
                            logger.info("Added default port 10443 for Scrypted")
                        
                        # Extrahiere Volumes
                        docker_volumes = []
                        for mount in container_data.get('Mounts', []):
                            docker_volumes.append({
                                'source': mount.get('Source', ''),
                                'destination': mount.get('Destination', ''),
                                'type': mount.get('Type', '')
                            })
                        
                        # Extrahiere Netzwerkinformationen
                        network_mode = container_data.get('HostConfig', {}).get('NetworkMode', '')
                        network_name = None
                        
                        if network_mode == 'host':
                            network_name = 'host'
                        else:
                            networks = container_data.get('NetworkSettings', {}).get('Networks', {})
                            if networks:
                                network_name = list(networks.keys())[0]
                        
                        container_info = {
                            'id': container_data.get('Id', '')[:12],
                            'name': container_data.get('Name', '').lstrip('/'),
                            'image': container_data.get('Config', {}).get('Image', ''),
                            'created': container_data.get('Created', ''),
                            'status': container_data.get('State', {}).get('Status', ''),
                            'ports': port_mappings if port_mappings else ports,
                            'volumes': docker_volumes if docker_volumes else volumes,
                            'network': network_name if network_name else network_mode
                        }
            except Exception as e:
                logger.error(f"Error getting container details: {str(e)}")
                # Use default info if we couldn't get detailed info
                container_info = default_container_info
        
        # If container_info is still None, use the default info
        if container_info is None:
            container_info = default_container_info
        
        return jsonify({
            'name': container_name,
            'status': status,
            'info': container_info,
            'compose': compose_content
        })
        
    except Exception as e:
        logger.exception(f"Error getting container info: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/debug/compose-files')
def debug_compose_files():
    """Debug-Endpunkt zum Überprüfen der heruntergeladenen Dateien"""
    compose_dir = os.path.join(WEBDOCK_BASE_PATH, 'docker-templates')
    result = {
        'directory_exists': os.path.exists(compose_dir),
        'directory_contents': {},
        'github_test': None
    }
    
    if result['directory_exists']:
        for root, dirs, files in os.walk(compose_dir):
            rel_path = os.path.relpath(root, compose_dir)
            result['directory_contents'][rel_path] = {
                'directories': dirs,
                'files': files
            }
    
    # Teste GitHub-API
    try:
        response = requests.get(GITHUB_API_URL)
        result['github_test'] = {
            'status_code': response.status_code,
            'response': response.json() if response.status_code == 200 else None
        }
    except Exception as e:
        result['github_test'] = {'error': str(e)}
    
    return jsonify(result)

@app.route('/api/containers/status')
def get_containers_status():
    try:
        # Get running status
        cmd = ["docker", "ps", "-a", "--format", "{{.Names}}\t{{.State}}"]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        
        # Get installed containers
        installed_containers = get_installed_containers()
        
        status_dict = {}
        for line in result.stdout.strip().split('\n'):
            if line:
                name, state = line.split('\t')
                status_dict[name] = {
                    'state': state,
                    'installed': name in installed_containers
                }
        
        return jsonify(status_dict)
    except subprocess.CalledProcessError as e:
        logger.error(f"Docker command failed: {e.stderr}")
        return jsonify({'error': 'Docker command failed'}), 500
    except Exception as e:
        logger.exception("Error getting container status")
        return jsonify({'error': str(e)}), 500

@app.route('/debug/icons')
def debug_icons():
    img_dir = os.path.join(app.static_folder, 'img', 'icons')
    return jsonify({
        'img_dir': img_dir,
        'exists': os.path.exists(img_dir),
        'files': os.listdir(img_dir) if os.path.exists(img_dir) else [],
        'static_folder': app.static_folder,
        'full_path': os.path.abspath(img_dir)
    })

def setup_mosquitto(container_name, install_path, config_data=None):
    """Setup für Mosquitto Broker"""
    try:
        # Debug-Logging
        logger.info("=== Setup Mosquitto Debug ===")
        logger.info(f"Config data: {config_data}")
        logger.info(f"COMPOSE_FILES_DIR: {COMPOSE_FILES_DIR}")
        logger.info(f"Container name: {container_name}")
        logger.info(f"Install path: {install_path}")
        
        # Erstelle Verzeichnisse
        config_dir = os.path.join(install_path, "config")
        data_dir = os.path.join(install_path, "data")
        log_dir = os.path.join(install_path, "log")
        
        for dir_path in [config_dir, data_dir, log_dir]:
            os.makedirs(dir_path, exist_ok=True, mode=0o755)

        # Default Werte
        auth_enabled = False
        username = 'test'
        password = 'test'
        
        # Prüfe ob Authentifizierung aktiviert ist
        if config_data and 'mosquitto' in config_data:
            mosquitto_config = config_data['mosquitto']
            auth_enabled = mosquitto_config.get('auth_enabled', False)
            username = mosquitto_config.get('username', username)
            password = mosquitto_config.get('password', password)
            
            logger.info("=== Mosquitto Auth Config ===")
            logger.info(f"Auth enabled: {auth_enabled}")
            logger.info(f"Username: {username}")
            logger.info(f"Password: {'*' * len(password)}")
        
        # Erstelle Konfigurationsdatei
        config_path = os.path.join(config_dir, "mosquitto.conf")
        
        # Prüfe, ob eine Template-Konfigurationsdatei existiert
        template_config_path = os.path.join(COMPOSE_FILES_DIR, container_name, "mosquitto.conf")
        
        logger.info(f"Checking for template mosquitto.conf at: {template_config_path}")
        if os.path.exists(template_config_path):
            # Kopiere die Template-Konfigurationsdatei
            logger.info(f"Using template mosquitto.conf from {template_config_path}")
            shutil.copy2(template_config_path, config_path)
            
            # Wenn Authentifizierung aktiviert ist, passe die Konfigurationsdatei an
            if auth_enabled:
                with open(config_path, "r") as f:
                    config_content = f.read()
                
                # Ersetze allow_anonymous true mit allow_anonymous false
                config_content = config_content.replace("allow_anonymous true", "allow_anonymous false")
                
                # Füge password_file hinzu, wenn nicht vorhanden
                if "password_file" not in config_content:
                    config_content += "\npassword_file /mosquitto/config/passwd\n"
                
                with open(config_path, "w") as f:
                    f.write(config_content)
        else:
            # Versuche, die Konfigurationsdatei aus dem docker-templates Verzeichnis zu kopieren
            template_dir = "/home/webDock/docker-templates"
            alt_template_path = os.path.join(template_dir, container_name, "mosquitto.conf")
            
            logger.info(f"Template not found at {template_config_path}, checking alternative path: {alt_template_path}")
            
            if os.path.exists(alt_template_path):
                logger.info(f"Using alternative template mosquitto.conf from {alt_template_path}")
                shutil.copy2(alt_template_path, config_path)
                
                # Wenn Authentifizierung aktiviert ist, passe die Konfigurationsdatei an
                if auth_enabled:
                    with open(config_path, "r") as f:
                        config_content = f.read()
                    
                    # Ersetze allow_anonymous true mit allow_anonymous false
                    config_content = config_content.replace("allow_anonymous true", "allow_anonymous false")
                    
                    # Füge password_file hinzu, wenn nicht vorhanden
                    if "password_file" not in config_content:
                        config_content += "\npassword_file /mosquitto/config/passwd\n"
                    
                    with open(config_path, "w") as f:
                        f.write(config_content)
            else:
                # Erstelle eine neue Konfigurationsdatei
                logger.info("No template found, creating new mosquitto.conf file")
                with open(config_path, "w") as f:
                    f.write("""# Default listener
listener 1883

# WebSockets listener
listener 9001
protocol websockets

# Persistence
persistence true
persistence_location /mosquitto/data/

# Logging
log_dest file /mosquitto/log/mosquitto.log
log_dest stdout
""")
                    
                    # Füge Authentifizierungskonfiguration hinzu, wenn aktiviert
                    if auth_enabled:
                        f.write("""
# Authentication
allow_anonymous false
password_file /mosquitto/config/passwd
""")
                    else:
                        f.write("""
# Authentication
allow_anonymous true
""")
        
        # Erstelle Passwort-Datei nur wenn Authentifizierung aktiviert ist
        if auth_enabled:
            passwd_file = os.path.join(config_dir, "passwd")
            
            try:
                # Erstelle leere Passwort-Datei
                with open(passwd_file, 'w') as f:
                    pass
                os.chmod(passwd_file, 0o644)
                
                # Erstelle die Passwort-Datei im Container
                result = subprocess.run([
                    'docker', 'run', '--rm',
                    '-v', f'{config_dir}:/mosquitto/config',
                    'eclipse-mosquitto:latest',
                    'mosquitto_passwd', '-b', '/mosquitto/config/passwd', username, password
                ], capture_output=True, text=True, check=True)
                
                logger.info(f"Created password file for user {username}")
                logger.info(f"Command output: {result.stdout}")
                
                # Setze Berechtigungen
                os.chmod(passwd_file, 0o644)
                
            except subprocess.CalledProcessError as e:
                logger.error(f"Error creating password file: {e.stderr}")
                raise
        
        # Setze Berechtigungen für die Konfigurationsdatei
        os.chmod(config_path, 0o644)
        
        # Prüfe, ob eine Template docker-compose.yml existiert
        template_compose_path = os.path.join(COMPOSE_FILES_DIR, container_name, "docker-compose.yml")
        compose_file = os.path.join(install_path, 'docker-compose.yml')
        
        logger.info(f"Checking for template docker-compose.yml at: {template_compose_path}")
        
        if os.path.exists(template_compose_path):
            # Kopiere die Template docker-compose.yml
            logger.info(f"Using template docker-compose.yml from {template_compose_path}")
            shutil.copy2(template_compose_path, compose_file)
            
            # Aktualisiere die Ports in der docker-compose.yml
            with open(compose_file, 'r') as f:
                compose_content = f.read()
            
            # Hole die Port-Konfiguration
            mqtt_port = "1883"  # Standardwert
            websocket_port = "9001"  # Standardwert
            
            if config_data and 'ports' in config_data:
                ports = config_data.get('ports', {})
                if '1883' in ports:
                    mqtt_port = ports['1883']
                if '9001' in ports:
                    websocket_port = ports['9001']
            
            # Ersetze die Ports in der docker-compose.yml
            import re
            compose_content = re.sub(r'"\d+:1883"', f'"{mqtt_port}:1883"', compose_content)
            compose_content = re.sub(r'"\d+:9001"', f'"{websocket_port}:9001"', compose_content)
            
            with open(compose_file, 'w') as f:
                f.write(compose_content)
        else:
            # Versuche, die docker-compose.yml aus dem docker-templates Verzeichnis zu kopieren
            alt_template_compose_path = os.path.join(template_dir, container_name, "docker-compose.yml")
            
            logger.info(f"Template not found at {template_compose_path}, checking alternative path: {alt_template_compose_path}")
            
            if os.path.exists(alt_template_compose_path):
                logger.info(f"Using alternative template docker-compose.yml from {alt_template_compose_path}")
                shutil.copy2(alt_template_compose_path, compose_file)
                
                # Aktualisiere die Ports in der docker-compose.yml
                with open(compose_file, 'r') as f:
                    compose_content = f.read()
                
                # Hole die Port-Konfiguration
                mqtt_port = "1883"  # Standardwert
                websocket_port = "9001"  # Standardwert
                
                if config_data and 'ports' in config_data:
                    ports = config_data.get('ports', {})
                    if '1883' in ports:
                        mqtt_port = ports['1883']
                    if '9001' in ports:
                        websocket_port = ports['9001']
                
                # Ersetze die Ports in der docker-compose.yml
                import re
                compose_content = re.sub(r'"\d+:1883"', f'"{mqtt_port}:1883"', compose_content)
                compose_content = re.sub(r'"\d+:9001"', f'"{websocket_port}:9001"', compose_content)
                
                with open(compose_file, 'w') as f:
                    f.write(compose_content)
            else:
                # Erstelle eine neue docker-compose.yml
                logger.info("No template found, creating new docker-compose.yml file")
                
                # Hole die Port-Konfiguration
                mqtt_port = "1883"  # Standardwert
                websocket_port = "9001"  # Standardwert
                
                if config_data and 'ports' in config_data:
                    ports = config_data.get('ports', {})
                    if '1883' in ports:
                        mqtt_port = ports['1883']
                    if '9001' in ports:
                        websocket_port = ports['9001']
                
                # Schreibe die docker-compose.yml
                with open(compose_file, 'w') as f:
                    f.write(f"""version: '3'
services:
  mosquitto:
    container_name: mosquitto-broker
    image: eclipse-mosquitto:latest
    networks:
      - webdock-network
    restart: unless-stopped
    ports:
      - "{mqtt_port}:1883"
      - "{websocket_port}:9001"
    volumes:
      - ./config:/mosquitto/config
      - ./data:/mosquitto/data
      - ./log:/mosquitto/log

networks:
  webdock-network:
    external: true
""")
        
        logger.info(f"Created Mosquitto docker-compose.yml with ports {mqtt_port}:1883 and {websocket_port}:9001")
        logger.info(f"Created Mosquitto configuration file at {config_path}")
        
        return True
    except Exception as e:
        logger.error(f"Mosquitto setup failed: {str(e)}")
        return False

def setup_grafana(container_name, install_path, config_data=None):
    """Setup für Grafana"""
    try:
        # Erstelle Verzeichnisse
        data_dir = os.path.join(install_path, 'data')
        os.makedirs(data_dir, exist_ok=True, mode=0o777)  # Setze Berechtigungen auf 777, damit Grafana schreiben kann
        
        # Erstelle env.grafana Datei
        env_file = os.path.join(data_dir, 'env.grafana')
        
        # Prüfe, ob eine Template-Konfigurationsdatei existiert
        template_env_path = os.path.join(COMPOSE_FILES_DIR, container_name, "env.grafana")
        
        if os.path.exists(template_env_path):
            # Kopiere die Template-Konfigurationsdatei
            logger.info(f"Using template env.grafana from {template_env_path}")
            shutil.copy2(template_env_path, env_file)
        else:
            # Erstelle eine neue Konfigurationsdatei
            logger.info("Creating new env.grafana file")
            with open(env_file, 'w') as f:
                f.write("""GF_SECURITY_ADMIN_USER=admin
GF_SECURITY_ADMIN_PASSWORD=admin
GF_USERS_ALLOW_SIGN_UP=false
GF_INSTALL_PLUGINS=grafana-clock-panel,grafana-simple-json-datasource,grafana-worldmap-panel,grafana-piechart-panel
""")
        
        # Setze Berechtigungen
        os.chmod(env_file, 0o644)
        
        logger.info(f"Created Grafana environment file: {env_file}")
        
        # Hole die Port-Konfiguration
        port = "3000"  # Standardwert
        if config_data and 'ports' in config_data:
            ports = config_data.get('ports', {})
            if ports and '3000' in ports:
                port = ports['3000']
        
        # Erstelle die docker-compose.yml
        compose_file = os.path.join(install_path, 'docker-compose.yml')
        with open(compose_file, 'w') as f:
            f.write(f"""version: '3'
services:
  grafana:
    container_name: grafana
    image: grafana/grafana:latest
    networks:
      - webdock-network
    restart: unless-stopped
    user: "0:0"  # Führe als root aus, um Berechtigungsprobleme zu vermeiden
    ports:
      - "{port}:3000"
    volumes:
      - ./data:/var/lib/grafana
    env_file:
      - ./data/env.grafana
    environment:
      - GF_PATHS_PROVISIONING=/var/lib/grafana/provisioning
      - GF_PATHS_PLUGINS=/var/lib/grafana/plugins
      - GF_PATHS_LOGS=/var/lib/grafana/logs
      - GF_PATHS_DATA=/var/lib/grafana

networks:
  webdock-network:
    external: true
""")
        
        logger.info(f"Created Grafana docker-compose.yml with port {port}")
        
        # Erstelle Verzeichnisse für Grafana
        provisioning_dir = os.path.join(data_dir, 'provisioning')
        plugins_dir = os.path.join(data_dir, 'plugins')
        logs_dir = os.path.join(data_dir, 'logs')
        
        for dir_path in [provisioning_dir, plugins_dir, logs_dir]:
            os.makedirs(dir_path, exist_ok=True, mode=0o777)  # Setze Berechtigungen auf 777
            logger.info(f"Created directory with full permissions: {dir_path}")
        
        return True
    except Exception as e:
        logger.error(f"Grafana setup failed: {str(e)}")
        return False

def setup_influxdb(container_name, install_path, config_data=None):
    """Setup für InfluxDB"""
    try:
        # Erstelle Verzeichnisse
        data_dir = os.path.join(install_path, 'data')
        config_dir = os.path.join(install_path, 'config')
        
        for dir_path in [data_dir, config_dir]:
            os.makedirs(dir_path, exist_ok=True, mode=0o755)
        
        # Prüfe, ob eine Datenbank erstellt werden soll
        create_database = False
        database_name = "database1"
        database_user = "user1"
        database_password = "pwd12345"
        
        if config_data and 'influxdb' in config_data:
            influxdb_config = config_data.get('influxdb', {})
            create_database = influxdb_config.get('create_database', False)
            database_name = influxdb_config.get('database_name', database_name)
            database_user = influxdb_config.get('database_user', database_user)
            database_password = influxdb_config.get('database_password', database_password)
        
        # Hole die Port-Konfiguration
        port = "8086"  # Standardwert
        if config_data and 'ports' in config_data:
            ports = config_data.get('ports', {})
            if ports and '8086' in ports:
                port = ports['8086']
        
        # Bestimme das richtige Image basierend auf dem Container-Namen
        image = "influxdb:latest"
        if container_name == 'influxdb-arm':
            image = "influxdb:1.8-alpine"  # Leichteres Image für ARM
        elif container_name == 'influxdb-x86':
            image = "influxdb:latest"
        
        # Check for template docker-compose.yml file
        template_compose_path = os.path.join(CONFIG_DIR, 'templates', 'influxdb', 'docker-compose.yml')
        compose_file = os.path.join(install_path, 'docker-compose.yml')
        
        if os.path.exists(template_compose_path):
            # Copy the template docker-compose.yml file
            shutil.copy2(template_compose_path, compose_file)
            logger.info(f"Copied template docker-compose.yml for InfluxDB from {template_compose_path}")
            
            # Update the port and image in the docker-compose.yml file
            with open(compose_file, 'r') as f:
                compose_content = f.read()
            
            # Replace the port in the compose file
            compose_content = re.sub(r'"\d+:8086"', f'"{port}:8086"', compose_content)
            
            # Replace the image and container name if needed
            compose_content = re.sub(r'image:\s*influxdb:\S+', f'image: {image}', compose_content)
            compose_content = re.sub(r'container_name:\s*\S+', f'container_name: {container_name}', compose_content)
            
            with open(compose_file, 'w') as f:
                f.write(compose_content)
        else:
            # Erstelle die docker-compose.yml
            with open(compose_file, 'w') as f:
                f.write(f"""version: '3'
services:
  influxdb:
    container_name: {container_name}
    image: {image}
    networks:
      - webdock-network
    restart: unless-stopped
    ports:
      - "{port}:8086"
    volumes:
      - ./data:/var/lib/influxdb

networks:
  webdock-network:
    external: true
""")
        
        # Erstelle Skript zur Datenbankerstellung, wenn gewünscht
        if create_database:
            # Check for template script file
            template_script_path = os.path.join(CONFIG_DIR, 'templates', 'influxdb', 'create_database.sh')
            script_path = os.path.join(install_path, 'create_database.sh')
            
            if os.path.exists(template_script_path):
                # Copy the template script file
                shutil.copy2(template_script_path, script_path)
                logger.info(f"Copied template create_database.sh for InfluxDB from {template_script_path}")
                
                # Update the script with the correct database information
                with open(script_path, 'r') as f:
                    script_content = f.read()
                
                # Replace the database information in the script
                script_content = script_content.replace('{{container_name}}', container_name)
                script_content = script_content.replace('{{database_name}}', database_name)
                script_content = script_content.replace('{{database_user}}', database_user)
                script_content = script_content.replace('{{database_password}}', database_password)
                
                with open(script_path, 'w') as f:
                    f.write(script_content)
            else:
                # Create the script file
                with open(script_path, 'w') as f:
                    f.write(f"""#!/bin/bash
# Warte bis InfluxDB gestartet ist
sleep 10

# Erstelle Datenbank und Benutzer
docker exec -it {container_name} influx -execute "CREATE DATABASE {database_name}"
docker exec -it {container_name} influx -execute "CREATE USER {database_user} WITH PASSWORD '{database_password}'"
docker exec -it {container_name} influx -execute "GRANT ALL ON {database_name} TO {database_user}"

echo "Datenbank {database_name} mit Benutzer {database_user} erstellt."
""")
            
            os.chmod(script_path, 0o755)
            
            # Führe das Skript im Hintergrund aus
            subprocess.Popen(['bash', script_path], 
                             stdout=subprocess.PIPE, 
                             stderr=subprocess.PIPE)
            
            logger.info(f"Created and executed database creation script for InfluxDB")
        
        logger.info(f"Created InfluxDB docker-compose.yml with port {port} and image {image}")
        
        return True
    except Exception as e:
        logger.error(f"InfluxDB setup failed: {str(e)}")
        return False

def setup_dockge(container_name, install_path, config_data=None):
    """Setup für Dockge"""
    try:
        # Erstelle Verzeichnisse
        data_dir = os.path.join(install_path, 'data')
        os.makedirs(data_dir, exist_ok=True, mode=0o755)
        
        # Hole die Port-Konfiguration
        port = "5001"  # Standardwert
        if config_data and 'ports' in config_data:
            ports = config_data.get('ports', {})
            if ports and '5001' in ports:
                port = ports['5001']
        
        # Hole die Umgebungsvariablen aus den Konfigurationsdaten
        env_vars = config_data.get('env', {}) if config_data else {}
        
        # Setze Standardwert für DOCKGE_STACKS_DIR, wenn nicht angegeben
        if 'DOCKGE_STACKS_DIR' not in env_vars or not env_vars['DOCKGE_STACKS_DIR']:
            env_vars['DOCKGE_STACKS_DIR'] = './data/stacks'
            logger.info("Using default DOCKGE_STACKS_DIR for Dockge")
        
        # Check for template docker-compose.yml file
        template_compose_path = os.path.join(CONFIG_DIR, 'templates', 'dockge', 'docker-compose.yml')
        compose_file = os.path.join(install_path, 'docker-compose.yml')
        
        if os.path.exists(template_compose_path):
            # Copy the template docker-compose.yml file
            shutil.copy2(template_compose_path, compose_file)
            logger.info(f"Copied template docker-compose.yml for Dockge from {template_compose_path}")
            
            # Update the port and environment variables in the docker-compose.yml file
            with open(compose_file, 'r') as f:
                compose_content = f.read()
            
            # Replace the port in the compose file
            compose_content = re.sub(r'"\d+:5001"', f'"{port}:5001"', compose_content)
            
            # Replace environment variables
            for key, value in env_vars.items():
                pattern = rf'{key}=\S+'
                replacement = f'{key}={value}'
                compose_content = re.sub(pattern, replacement, compose_content)
            
            with open(compose_file, 'w') as f:
                f.write(compose_content)
        else:
            # Erstelle die docker-compose.yml
            with open(compose_file, 'w') as f:
                f.write(f"""version: '3'
services:
  dockge:
    image: louislam/dockge:latest
    container_name: dockge
    restart: unless-stopped
    networks:
      - webdock-network
    ports:
      - "{port}:5001"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/app/data
    environment:
      - DOCKGE_STACKS_DIR={env_vars.get('DOCKGE_STACKS_DIR', './data/stacks')}

networks:
  webdock-network:
    external: true
""")
        
        logger.info(f"Created Dockge docker-compose.yml with port: {port} and added to webdock-network")
        
        return True
    except Exception as e:
        logger.error(f"Dockge setup failed: {str(e)}")
        return False

def setup_filestash(container_name, install_path, config_data=None):
    """Setup for Filestash"""
    try:
        # Create directories
        data_dir = os.path.join(install_path, 'data')
        os.makedirs(data_dir, exist_ok=True, mode=0o755)
        
        # Get port configuration
        port = "8334"  # Default value
        if config_data and 'ports' in config_data:
            ports = config_data.get('ports', {})
            if ports and '8334' in ports:
                port = ports['8334']
        
        # Create docker-compose.yml
        compose_file = os.path.join(install_path, 'docker-compose.yml')
        with open(compose_file, 'w') as f:
            f.write(f"""version: '3'
services:
  app:
    container_name: filestash
    image: machines/filestash
    networks:
      - webdock-network
    restart: always
    environment:
      - APPLICATION_URL=
      - GDRIVE_CLIENT_ID=<gdrive_client>
      - GDRIVE_CLIENT_SECRET=<gdrive_secret>
      - DROPBOX_CLIENT_ID=<dropbox_key>
      - ONLYOFFICE_URL=http://onlyoffice
    ports:
      - "{port}:8334"
    volumes:
      - ./data:/app/data/state
  onlyoffice:
    container_name: filestash_oods
    image: onlyoffice/documentserver
    networks:
      - webdock-network
    restart: always
    security_opt:
      - seccomp:unconfined

networks:
  webdock-network:
    external: true
""")
        
        logger.info(f"Created Filestash docker-compose.yml with port: {port}")
        
        return True
    except Exception as e:
        logger.error(f"Filestash setup failed: {str(e)}")
        return False

def setup_homeassistant(container_name, install_path, config_data=None):
    """Setup for Home Assistant"""
    try:
        # Create directories
        config_dir = os.path.join(install_path, 'config')
        data_dir = os.path.join(install_path, 'data')
        
        for dir_path in [config_dir, data_dir]:
            os.makedirs(dir_path, exist_ok=True, mode=0o755)
        
        # Home Assistant needs host network mode for proper functionality
        # Create docker-compose.yml with host network
        compose_file = os.path.join(install_path, 'docker-compose.yml')
        with open(compose_file, 'w') as f:
            f.write(f"""version: '3'
services:
  homeassistant:
    container_name: homeassistant
    image: "ghcr.io/home-assistant/home-assistant:stable"
    volumes:
      - ./config:/config
      - ./data:/data
      - /etc/localtime:/etc/localtime:ro
    restart: unless-stopped
    privileged: true
    network_mode: host
""")
        
        logger.info(f"Created Home Assistant docker-compose.yml with host network mode")
        
        return True
    except Exception as e:
        logger.error(f"Home Assistant setup failed: {str(e)}")
        return False

def setup_watchyourlan(container_name, install_path, config_data):
    """Setup for WatchYourLAN"""
    try:
        # Create directories
        config_dir = os.path.join(install_path, 'config')
        data_dir = os.path.join(install_path, 'data')
        wyl_config_dir = os.path.join(data_dir, 'WatchYourLAN')
        
        for dir_path in [config_dir, data_dir, wyl_config_dir]:
            os.makedirs(dir_path, exist_ok=True, mode=0o755)
        
        # Get environment variables from config data
        env_vars = config_data.get('env', {})
        
        # Set default values if not provided
        if 'NETWORK_INTERFACE' not in env_vars or not env_vars['NETWORK_INTERFACE']:
            env_vars['NETWORK_INTERFACE'] = get_default_network_interface()
            logger.info(f"Using default network interface: {env_vars['NETWORK_INTERFACE']}")
        
        if 'IP_RANGE' not in env_vars or not env_vars['IP_RANGE']:
            # Try to determine IP range from the network interface
            ip_range = "192.168.1.0/24"  # Default value
            try:
                # Get IP address of the interface
                result = subprocess.run(
                    ['ip', 'addr', 'show', env_vars['NETWORK_INTERFACE']],
                    capture_output=True,
                    text=True
                )
                
                if result.returncode == 0:
                    # Search for IPv4 addresses
                    match = re.search(r'inet\s+(\d+\.\d+\.\d+\.\d+)/(\d+)', result.stdout)
                    if match:
                        ip_addr = match.group(1)
                        # Extract the first three octets
                        ip_parts = ip_addr.split('.')
                        ip_range = f"{ip_parts[0]}.{ip_parts[1]}.{ip_parts[2]}.0/24"
                        logger.info(f"Detected IP range: {ip_range}")
            except Exception as e:
                logger.error(f"Error detecting IP range: {str(e)}")
            
            env_vars['IP_RANGE'] = ip_range
            logger.info(f"Using IP range: {ip_range}")
        
        # Get port configuration
        bootstrap_port = "8850"  # Default value for node-bootstrap
        gui_port = "8840"  # Default value for WatchYourLAN GUI
        
        if config_data and 'ports' in config_data:
            ports = config_data.get('ports', {})
            if ports and '8840' in ports:
                gui_port = ports['8840']
            if ports and '8850' in ports:
                bootstrap_port = ports['8850']
        
        # Determine the correct image based on architecture
        image = "aceberg/watchyourlan:latest"
        if container_name == 'watchyourlanarm':
            image = "aceberg/watchyourlan:latest-arm"
        
        # Create the docker-compose.yml
        compose_file = os.path.join(install_path, 'docker-compose.yml')
        with open(compose_file, 'w') as f:
            f.write(f"""version: '3'
services:
  node-bootstrap:
    image: aceberg/node-bootstrap:latest
    container_name: watchyourlan-bootstrap
    restart: unless-stopped
    network_mode: "host"
    ports:
      - "{bootstrap_port}:8850"
  watchyourlan:
    image: {image}
    container_name: watchyourlan
    restart: unless-stopped
    network_mode: "host"
    depends_on:
      - node-bootstrap
    volumes:
      - ./data:/data
      - ./config:/config
    environment:
      TZ: Europe/Berlin
      DBPATH: "/data/db.sqlite"
      GUIPORT: "{gui_port}"
      TIMEOUT: "120"
      SHOUTRRR_URL: ""
      THEME: "darkly"
      IGNOREIP: "no"
      NETWORK_INTERFACE: "{env_vars['NETWORK_INTERFACE']}"
      IP_RANGE: "{env_vars['IP_RANGE']}"

networks:
  webdock-network:
    external: true
""")
        
        # Create the WatchYourLAN config_v2.yaml file
        config_file = os.path.join(wyl_config_dir, 'config_v2.yaml')
        with open(config_file, 'w') as f:
            f.write(f"""arp_args: ""
arp_strs: []
arp_strs_joined: ""
color: light
hist_in_db: false
host: 0.0.0.0
ifaces: "{env_vars['NETWORK_INTERFACE']}"
influx_addr: ""
influx_bucket: ""
influx_enable: false
influx_org: ""
influx_skip_tls: false
influx_token: ""
log_level: info
nodepath: ""
pg_connect: ""
port: "{gui_port}"
shoutrrr_url: ""
theme: darkly
timeout: 120
trim_hist: 48
use_db: sqlite
""")
        
        logger.info(f"Created docker-compose.yml for WatchYourLAN with network interface {env_vars['NETWORK_INTERFACE']} and IP range {env_vars['IP_RANGE']}")
        logger.info(f"Created config_v2.yaml with network interface {env_vars['NETWORK_INTERFACE']}")
        logger.info(f"WatchYourLAN will use network_mode: host for proper network scanning")
        logger.info(f"Node-bootstrap will be available at port {bootstrap_port}, WatchYourLAN GUI at port {gui_port}")
        
        return True
    except Exception as e:
        logger.error(f"WatchYourLAN setup failed: {str(e)}")
        return False

def get_default_network_interface():
    """Ermittelt das Standard-Netzwerkinterface"""
    try:
        # Prüfe, ob der 'ip' Befehl verfügbar ist
        try:
            # Versuche, das Standard-Interface über die Route zu ermitteln
            result = subprocess.run(
                ['ip', 'route', 'show', 'default'],
                capture_output=True,
                text=True
            )
            
            if result.returncode == 0 and result.stdout:
                # Parse die Ausgabe, um das Interface zu extrahieren
                # Format: default via 192.168.1.1 dev eth0 ...
                match = re.search(r'dev\s+(\S+)', result.stdout)
                if match:
                    logger.info(f"Found default interface via ip route: {match.group(1)}")
                    return match.group(1)
            
            # Fallback: Liste alle Interfaces auf und wähle das erste nicht-lo Interface
            result = subprocess.run(
                ['ip', 'link', 'show'],
                capture_output=True,
                text=True
            )
            
            if result.returncode == 0:
                # Parse die Ausgabe, um alle Interfaces zu extrahieren
                interfaces = re.findall(r'\d+:\s+(\S+):', result.stdout)
                # Filtere lo (loopback) und docker-Interfaces aus
                non_lo_interfaces = [iface for iface in interfaces if iface != 'lo' and not iface.startswith('docker') and not iface.startswith('veth') and not iface.startswith('br-')]
                if non_lo_interfaces:
                    logger.info(f"Found interfaces: {non_lo_interfaces}, using {non_lo_interfaces[0]}")
                    return non_lo_interfaces[0]
        except FileNotFoundError:
            # 'ip' Befehl nicht verfügbar, versuche alternative Methoden
            logger.warning("'ip' command not found, trying alternative methods")
            
            # Versuche, das Interface über /proc/net/route zu ermitteln
            try:
                with open('/proc/net/route', 'r') as f:
                    for line in f.readlines()[1:]:  # Überspringe die Kopfzeile
                        parts = line.strip().split()
                        if parts[1] == '00000000':  # Default-Route
                            logger.info(f"Found default interface via /proc/net/route: {parts[0]}")
                            return parts[0]  # Interface-Name
            except Exception as e:
                logger.error(f"Error reading /proc/net/route: {str(e)}")
            
            # Versuche, das Interface über ifconfig zu ermitteln
            try:
                result = subprocess.run(
                    ['ifconfig'],
                    capture_output=True,
                    text=True
                )
                
                if result.returncode == 0:
                    # Parse die Ausgabe, um alle Interfaces zu extrahieren
                    interfaces = re.findall(r'^(\S+):', result.stdout, re.MULTILINE)
                    # Filtere lo (loopback) und docker-Interfaces aus
                    non_lo_interfaces = [iface for iface in interfaces if iface != 'lo' and not iface.startswith('docker') and not iface.startswith('veth') and not iface.startswith('br-')]
                    if non_lo_interfaces:
                        logger.info(f"Found interfaces via ifconfig: {non_lo_interfaces}, using {non_lo_interfaces[0]}")
                        return non_lo_interfaces[0]
            except FileNotFoundError:
                logger.warning("'ifconfig' command not found")
        
        # Wenn alles fehlschlägt, versuche spezifische Interfaces zu prüfen
        common_interfaces = ["ens18", "ens160", "eth0", "enp0s3", "wlan0"]
        for iface in common_interfaces:
            try:
                result = subprocess.run(
                    ['ip', 'addr', 'show', iface],
                    capture_output=True,
                    text=True
                )
                if result.returncode == 0 and "state UP" in result.stdout:
                    logger.info(f"Found active interface by checking common names: {iface}")
                    return iface
            except:
                pass
                
        # Wenn alles fehlschlägt, verwende den Standardwert
        logger.warning("Could not detect network interface, using fallback value eth0")
        return "eth0"  # Fallback-Wert
    except Exception as e:
        logger.error(f"Error detecting default network interface: {str(e)}")
        return "eth0"  # Fallback-Wert

def get_container_directory_name(container_name):
    """Mappt Container-Namen zu ihren Verzeichnisnamen"""
    container_mapping = {
        'mosquitto': 'mosquitto-broker',
        'mosquitto-broker': 'mosquitto-broker',
        'influxdb': 'influxdb-x86',
        'node-exporter': 'nodeexporter',
        'zigbee2mqtt': 'zigbee2mqtt',
        'code-server': 'codeserver',
        'whats-up-docker': 'whatsupdocker'
    }
    
    # Logging für bessere Fehlersuche
    logger.debug(f"Mapping container name: {container_name} -> {container_mapping.get(container_name, container_name)}")
    
    return container_mapping.get(container_name, container_name)

def update_compose_file(compose_content, install_data):
    """Aktualisiert die docker-compose.yml mit benutzerdefinierten Einstellungen"""
    try:
        compose_data = yaml.safe_load(compose_content)
        
        # Hole den ersten Service-Namen
        service_name = list(compose_data['services'].keys())[0]
        service = compose_data['services'][service_name]
        
        # Aktualisiere Ports
        if 'ports' in install_data:
            new_ports = []
            for port_mapping in service.get('ports', []):
                if isinstance(port_mapping, str) and ':' in port_mapping:
                    container_port = port_mapping.split(':')[1]
                    host_port = install_data['ports'].get(container_port, container_port.split('/')[0])
                    new_ports.append(f"{host_port}:{container_port}")
                else:
                    new_ports.append(port_mapping)
            service['ports'] = new_ports
        
        # Aktualisiere Umgebungsvariablen
        if 'env' in install_data:
            env_vars = service.get('environment', {})
            
            # Wenn env_vars None ist, initialisiere es als leeres Dictionary oder Liste
            if env_vars is None:
                if isinstance(service.get('environment', []), list):
                    env_vars = []
                else:
                    env_vars = {}
            
            if isinstance(env_vars, list):
                # Konvertiere Liste zu Dictionary
                env_dict = {}
                for env in env_vars:
                    if isinstance(env, str) and '=' in env:
                        key, value = env.split('=', 1)
                        env_dict[key] = value
                env_vars = env_dict
            
            # Aktualisiere mit neuen Werten
            env_vars.update(install_data['env'])
            
            # Konvertiere zurück zu Liste wenn nötig
            if isinstance(service.get('environment', []), list):
                service['environment'] = [f"{k}={v}" for k, v in env_vars.items()]
            else:
                service['environment'] = env_vars
        
        # Aktualisiere Volumes
        if 'volumes' in install_data:
            service['volumes'] = install_data['volumes']
        
        # Füge Netzwerk hinzu, wenn nicht network_mode: host
        if 'network_mode' in install_data:
            service['network_mode'] = install_data['network_mode']
        elif 'network_mode' not in service or service.get('network_mode') != 'host':
            # Füge webdock-network hinzu, wenn nicht host-Netzwerk
            service['networks'] = ['webdock-network']
            
            # Füge Netzwerk-Definition hinzu, wenn nicht bereits vorhanden
            if 'networks' not in compose_data:
                compose_data['networks'] = {
                    'webdock-network': {
                        'external': True
                    }
                }
        
        # Konvertiere zurück zu YAML
        return yaml.dump(compose_data, default_flow_style=False)
        
    except Exception as e:
        logger.error(f"Error updating compose file: {str(e)}")
        raise ValueError(f"Failed to update compose file: {str(e)}")

@app.route('/api/connect', methods=['POST'])
def connect_to_server():
    try:
        data = request.json
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        
        client.connect(
            data['host'],
            port=int(data['port']),
            username=data['username'],
            password=data['password']
        )
        
        # Erstelle eine persistente Session
        session = SSHSession(client)
        
        # Generiere eine eindeutige Session-ID
        session_id = str(uuid.uuid4())
        ssh_connections[session_id] = session
        
        return jsonify({
            'status': 'success',
            'connection': session_id
        })
    except Exception as e:
        return jsonify({
            'status': 'error',
            'message': str(e)
        }), 500

@app.route('/api/disconnect', methods=['POST'])
def disconnect_from_server():
    try:
        session_id = request.json.get('connection')
        if session_id in ssh_connections:
            ssh_connections[session_id].close()
            del ssh_connections[session_id]
        return jsonify({'status': 'success'})
    except Exception as e:
        return jsonify({
            'status': 'error',
            'message': str(e)
        }), 500

@app.route('/api/schedule-shutdown', methods=['POST'])
def schedule_shutdown():
    try:
        data = request.json
        # Speichere Host-Konfiguration
        save_host_config({
            'ip': data['hostIp'],
            'username': data['hostUser'],
            'password': data['hostPassword']
        })

        shutdown_time = datetime.strptime(data['shutdownTime'], '%H:%M').time()
        wakeup_time = datetime.strptime(data['wakeupTime'], '%H:%M').time()
        
        # Berechne die Sekunden bis zum Aufwachen
        shutdown_seconds = shutdown_time.hour * 3600 + shutdown_time.minute * 60
        wakeup_seconds = wakeup_time.hour * 3600 + wakeup_time.minute * 60
        
        # Wenn die Aufwachzeit am nächsten Tag ist
        if wakeup_seconds <= shutdown_seconds:
            wakeup_seconds += 24 * 3600  # Füge 24 Stunden hinzu
        
        sleep_duration = wakeup_seconds - shutdown_seconds
        
        # Erstelle SSH-Verbindung
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(
            data['hostIp'],
            username=data['hostUser'],
            password=data['hostPassword']
        )

        # Erstelle Skript auf dem Host
        script_content = f"""#!/bin/bash
# Shutdown schedule created by BangerTech UI
# Shutdown at: {data['shutdownTime']}
# Wake up at: {data['wakeupTime']}
rtcwake -m no -s {sleep_duration}
shutdown -h now"""

        # Hole aktuelle Crontab
        stdin, stdout, stderr = ssh.exec_command('crontab -l')
        current_crontab = stdout.read().decode()
        
        # Entferne alte Einträge für die gleiche Zeit
        new_crontab = '\n'.join(
            line for line in current_crontab.splitlines()
            if not (f"{shutdown_time.minute} {shutdown_time.hour}" in line and 'shutwake.sh' in line)
        )
        
        # Füge neuen Job hinzu
        new_job = f"{shutdown_time.minute} {shutdown_time.hour} * * * /usr/local/bin/shutwake.sh"
        if new_crontab:
            new_crontab += '\n' + new_job
        else:
            new_crontab = new_job

        # Sende Befehle zum Host
        commands = [
            f'echo "{script_content}" > /usr/local/bin/shutwake.sh',
            'chmod +x /usr/local/bin/shutwake.sh',
            f'echo "{new_crontab}" | crontab -'
        ]

        for cmd in commands:
            stdin, stdout, stderr = ssh.exec_command(cmd)
            error = stderr.read().decode()
            if error:
                raise Exception(f"Command failed: {error}")

        ssh.close()

        return jsonify({
            'status': 'success',
            'message': 'Shutdown schedule created successfully',
            'details': {
                'shutdown': data['shutdownTime'],
                'wakeup': data['wakeupTime'],
                'sleep_duration': sleep_duration
            }
        })
        
    except Exception as e:
        app.logger.error(f"Shutdown scheduling error: {str(e)}")
        return jsonify({
            'status': 'error',
            'message': f'Failed to schedule shutdown: {str(e)}'
        }), 500

@app.route('/api/schedules', methods=['GET'])
def get_schedules():
    try:
        app.logger.info("Checking host configuration...")
        config = load_host_config()
        app.logger.info(f"Loaded config: {config}")
        
        if not config:
            app.logger.error("No host configuration found")
            return jsonify({
                'status': 'error',
                'message': 'No host configuration found'
            }), 400

        app.logger.info("Attempting SSH connection...")
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(
            config['ip'],
            username=config['username'],
            password=config['password']
        )
        
        app.logger.info("Reading crontab...")
        stdin, stdout, stderr = ssh.exec_command('crontab -l')
        crontab = stdout.read().decode()
        app.logger.info(f"Current crontab:\n{crontab}")
        
        schedules = []
        for line in crontab.splitlines():
            if '/usr/local/bin/shutwake.sh' in line:
                try:
                    minute, hour, *_ = line.split()
                    # Extrahiere Wake-up Zeit aus dem Skript
                    _, stdout, _ = ssh.exec_command('cat /usr/local/bin/shutwake.sh')
                    script_content = stdout.read().decode()
                    
                    # Parse die rtcwake Sekunden
                    if match := re.search(r'-s (\d+)', script_content):
                        seconds = int(match.group(1))
                        shutdown_time = f"{hour.zfill(2)}:{minute.zfill(2)}"
                        shutdown_dt = datetime.strptime(shutdown_time, '%H:%M')
                        wakeup_dt = shutdown_dt + timedelta(seconds=seconds)
                        wakeup_time = wakeup_dt.strftime('%H:%M')
                        
                        # Erstelle eine eindeutige ID basierend auf der Zeit
                        schedule_id = f"{hour}:{minute}"
                        
                        schedules.append({
                            'id': schedule_id,
                            'shutdown': shutdown_time,
                            'wakeup': wakeup_time
                        })
                        app.logger.info(f"Found schedule: {schedule_id} (Shutdown: {shutdown_time}, Wake: {wakeup_time})")
                except Exception as e:
                    app.logger.error(f"Error parsing schedule: {e}")
                    continue
        
        ssh.close()
        return jsonify({'schedules': schedules})
        
    except Exception as e:
        app.logger.error(f"Error getting schedules: {e}")
        return jsonify({
            'status': 'error',
            'message': str(e)
        }), 500

@app.route('/api/execute', methods=['POST'])
def execute_command():
    try:
        data = request.json
        command = data.get('command')
        session_id = data.get('connection')
        
        if not command or not session_id:
            return jsonify({
                'status': 'error',
                'message': 'Missing command or connection'
            }), 400
            
        if session_id not in ssh_connections:
            return jsonify({
                'status': 'error',
                'message': 'Not connected'
            }), 400
        
        # Prüfe auf Editor-Befehle
        if command.startswith(('nano ', 'vi ', 'vim ')):
            filepath = command.split(' ', 1)[1].strip()
            return jsonify({
                'status': 'editor',
                'path': filepath
            })
            
        session = ssh_connections[session_id]
        channel = session.channel
        
        # Prüfe auf interaktive Befehle
        interactive_commands = ['nano', 'vim', 'vi', 'less', 'more']
        if any(command.startswith(cmd) for cmd in interactive_commands):
            return jsonify({
                'status': 'error',
                'message': 'Interactive commands are not supported in web terminal'
            })
        
        # Sende Befehl
        channel.send(f"{command}\n")
        time.sleep(0.1)
        
        # Lese Ausgabe
        output = ""
        while True:
            try:
                if channel.recv_ready():
                    chunk = channel.recv(4096).decode()
                    output += chunk
                else:
                    time.sleep(0.1)
                    if not channel.recv_ready():
                        break
            except socket.timeout:
                break
        
        # Bereinige die Ausgabe
        lines = output.split('\n')
        cleaned_lines = []
        for line in lines:
            if not any(x in line for x in ['[?2004', '$', '#', command]) and line.strip():
                cleaned_lines.append(line.strip())
        
        cleaned_output = '\n'.join(cleaned_lines)
        
        # Hole aktuelles Verzeichnis und Prompt-Info
        channel.send('echo -n "$(whoami)@$(hostname):$(pwd)"\n')
        time.sleep(0.1)
        info_output = channel.recv(1024).decode()
        
        try:
            username, rest = info_output.split('@')
            hostname, pwd = rest.split(':')
        except ValueError:
            username = 'root'  # Fallback wenn Split fehlschlägt
            hostname = 'debian-test'
            pwd = '~'
        
        return jsonify({
            'status': 'success',
            'output': cleaned_output,
            'pwd': pwd,
            'username': username.strip(),
            'hostname': hostname.strip()
        })
        
    except Exception as e:
        return jsonify({
            'status': 'error',
            'message': str(e)
        }), 500

@app.route('/api/terminal/info', methods=['POST'])
def get_terminal_info():
    try:
        data = request.json
        session_id = data.get('connection')
        
        if session_id not in ssh_connections:
            return jsonify({
                'status': 'error',
                'message': 'Not connected'
            }), 400
            
        ssh = ssh_connections[session_id]
        
        # Erstelle eine neue Shell-Session für die Info-Abfrage
        channel = ssh.invoke_shell()
        channel.settimeout(1)
        
        # Deaktiviere Terminal-Formatierung
        channel.send('export TERM=dumb\n')
        channel.send('stty -echo\n')
        time.sleep(0.1)
        channel.recv(1024)  # Clear buffer
        
        # Hole Benutzer
        channel.send('echo $USER\n')
        time.sleep(0.1)
        username = channel.recv(1024).decode().strip().split('\n')[-1]
        
        # Hole Hostname
        channel.send('hostname\n')
        time.sleep(0.1)
        hostname = channel.recv(1024).decode().strip().split('\n')[-1]
        
        # Hole PWD
        channel.send('pwd\n')
        time.sleep(0.1)
        pwd = channel.recv(1024).decode().strip().split('\n')[-1]
        
        channel.close()
        
        return jsonify({
            'username': username,
            'hostname': hostname,
            'pwd': pwd
        })
            
    except Exception as e:
        return jsonify({
            'status': 'error',
            'message': str(e)
        }), 500

@app.route('/api/terminal/pwd', methods=['POST'])
def get_current_pwd():
    try:
        data = request.json
        session_id = data.get('connection')
        
        if session_id not in ssh_connections:
            return jsonify({
                'status': 'error',
                'message': 'Not connected'
            }), 400
            
        ssh = ssh_connections[session_id]
        
        # Hole aktuelles Verzeichnis
        _, stdout, _ = ssh.exec_command('pwd')
        pwd = stdout.read().decode().strip()
        
        return jsonify({
            'pwd': pwd
        })
            
    except Exception as e:
        return jsonify({
            'status': 'error',
            'message': str(e)
        }), 500

@app.route('/api/complete', methods=['POST'])
def complete_command():
    try:
        data = request.json
        partial_command = data.get('command', '')
        session_id = data.get('connection')
        
        if not session_id in ssh_connections:
            return jsonify({
                'status': 'error',
                'message': 'Not connected'
            }), 400
            
        session = ssh_connections[session_id]
        channel = session.channel
        
        # Hole aktuelle Verzeichnisstruktur für Datei-Completion
        if ' ' in partial_command:  # Wenn Befehl bereits eingegeben wurde
            cmd_parts = partial_command.split()
            base_cmd = cmd_parts[0]
            partial_path = cmd_parts[-1] if len(cmd_parts) > 1 else ''
            
            # Führe ls im aktuellen oder angegebenen Verzeichnis aus
            completion_cmd = f"compgen -f -- '{partial_path}' 2>/dev/null"
        else:  # Befehl-Completion
            completion_cmd = f"compgen -c -- '{partial_command}' 2>/dev/null"
        
        channel.send(f"{completion_cmd}\n")
        time.sleep(0.1)
        
        # Lese Ausgabe
        output = ""
        while channel.recv_ready():
            output += channel.recv(1024).decode()
        
        # Parse Ausgabe
        suggestions = [
            line.strip() 
            for line in output.split('\n') 
            if line.strip() and line.strip().startswith(partial_command.split()[-1])
        ]
        
        # Sortiere Vorschläge
        suggestions.sort()
        
        return jsonify({
            'status': 'success',
            'suggestions': suggestions,
            'partial': partial_command.split()[-1]  # Der zu vervollständigende Teil
        })
        
    except Exception as e:
        return jsonify({
            'status': 'error',
            'message': str(e)
        }), 500

@app.route('/api/file', methods=['GET', 'POST'])
def handle_file():
    try:
        if request.method == 'GET':
            # Hole Parameter aus URL
            session_id = request.args.get('connection')
            filepath = request.args.get('path')
        else:
            # POST-Methode verwendet weiterhin JSON-Body
            data = request.json
            session_id = data.get('connection')
            filepath = data.get('path')
        
        if not session_id in ssh_connections:
            return jsonify({
                'status': 'error',
                'message': 'Not connected'
            }), 400
            
        session = ssh_connections[session_id]
        
        if request.method == 'GET':
            # Lese Datei
            _, stdout, _ = session.client.exec_command(f'cat "{filepath}"')
            content = stdout.read().decode()
            return jsonify({
                'status': 'success',
                'content': content
            })
        else:
            # Schreibe Datei
            content = data.get('content', '')
            stdin, stdout, stderr = session.client.exec_command(f'cat > "{filepath}"')
            stdin.write(content)
            stdin.close()
            
            error = stderr.read().decode()
            if error:
                return jsonify({
                    'status': 'error',
                    'message': error
                })
                
            return jsonify({
                'status': 'success',
                'message': 'File saved successfully'
            })
            
    except Exception as e:
        return jsonify({
            'status': 'error',
            'message': str(e)
        }), 500

@app.route('/api/file', methods=['POST'])
def save_file():
    try:
        data = request.json
        session_id = data.get('connection')
        filepath = data.get('path')
        content = data.get('content', '')
        create = data.get('create', False)
        
        if not session_id in ssh_connections:
            return jsonify({
                'status': 'error',
                'message': 'Not connected'
            }), 400
            
        session = ssh_connections[session_id]
        
        # Prüfe ob Datei existiert
        if create:
            # Erstelle Verzeichnis falls nötig
            session.client.exec_command(f'mkdir -p "$(dirname "{filepath}")"')
        
        # Schreibe Datei
        stdin, stdout, stderr = session.client.exec_command(f'cat > "{filepath}"')
        stdin.write(content)
        stdin.close()
        
        error = stderr.read().decode()
        if error:
            return jsonify({
                'status': 'error',
                'message': error
            })
            
        return jsonify({
            'status': 'success',
            'message': 'File saved successfully'
        })
            
    except Exception as e:
        return jsonify({
            'status': 'error',
            'message': str(e)
        }), 500

@app.route('/api/files', methods=['POST'])
def list_files():
    try:
        data = request.json
        session_id = data.get('connection')
        path = data.get('path', '/')
        
        if not session_id in ssh_connections:
            return jsonify({
                'status': 'error',
                'message': 'Not connected'
            }), 400
            
        session = ssh_connections[session_id]
        sftp = session.client.open_sftp()
        
        files = []
        for entry in sftp.listdir_attr(path):
            file_path = os.path.join(path, entry.filename)
            files.append({
                'name': entry.filename,
                'type': 'directory' if stat.S_ISDIR(entry.st_mode) else 'file',
                'size': entry.st_size,
                'modified': entry.st_mtime,
                'path': file_path
            })
            
        sftp.close()
        return jsonify({
            'status': 'success',
            'files': sorted(files, key=lambda x: (x['type'] == 'file', x['name']))
        })
        
    except Exception as e:
        return jsonify({
            'status': 'error',
            'message': str(e)
        }), 500

@app.route('/api/upload', methods=['POST'])
def upload_file():
    try:
        session_id = request.form.get('connection')
        path = request.form.get('path')
        file = request.files.get('file')
        
        if not all([session_id, path, file]):
            return jsonify({
                'status': 'error',
                'message': 'Missing required parameters'
            }), 400
            
        if session_id not in ssh_connections:
            return jsonify({
                'status': 'error',
                'message': 'Not connected'
            }), 400
            
        session = ssh_connections[session_id]
        sftp = session.client.open_sftp()
        
        # Erstelle temporäre Datei
        with tempfile.NamedTemporaryFile(delete=False) as tmp:
            file.save(tmp.name)
            # Upload via SFTP
            remote_path = os.path.join(path, file.filename)
            sftp.put(tmp.name, remote_path)
            os.unlink(tmp.name)
        
        sftp.close()
        return jsonify({
            'status': 'success',
            'message': f'File {file.filename} uploaded successfully'
        })
        
    except Exception as e:
        return jsonify({
            'status': 'error',
            'message': str(e)
        }), 500

@app.route('/api/delete', methods=['POST'])
def delete_file():
    try:
        data = request.json
        session_id = data.get('connection')
        filepath = data.get('path')
        
        if not all([session_id, filepath]):
            return jsonify({
                'status': 'error',
                'message': 'Missing required parameters'
            }), 400
            
        if session_id not in ssh_connections:
            return jsonify({
                'status': 'error',
                'message': 'Not connected'
            }), 400
            
        session = ssh_connections[session_id]
        sftp = session.client.open_sftp()
        
        try:
            # Prüfe ob es ein Verzeichnis ist
            try:
                sftp.stat(filepath)
                is_dir = stat.S_ISDIR(sftp.stat(filepath).st_mode)
            except:
                is_dir = False
            
            if is_dir:
                # Lösche Verzeichnis rekursiv
                def rm_recursive(path):
                    try:
                        files = sftp.listdir_attr(path)
                        for f in files:
                            filepath = os.path.join(path, f.filename)
                            if stat.S_ISDIR(f.st_mode):
                                rm_recursive(filepath)
                            else:
                                sftp.remove(filepath)
                        sftp.rmdir(path)
                    except:
                        pass
                
                rm_recursive(filepath)
            else:
                # Lösche einzelne Datei
                sftp.remove(filepath)
            
            sftp.close()
            return jsonify({
                'status': 'success',
                'message': f'{"Directory" if is_dir else "File"} deleted successfully'
            })
            
        except Exception as e:
            sftp.close()
            raise e
            
    except Exception as e:
        return jsonify({
            'status': 'error',
            'message': str(e)
        }), 500

@app.route('/api/schedule/delete', methods=['POST'])
def delete_schedule():
    try:
        data = request.json
        schedule_id = data.get('id')
        host_ip = data.get('hostIp')
        host_user = data.get('hostUser')
        host_password = data.get('hostPassword')
        
        if not schedule_id or not all([host_ip, host_user, host_password]):
            return jsonify({
                'status': 'error',
                'message': 'Missing schedule ID or host credentials'
            }), 400
            
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(
            host_ip,
            username=host_user,
            password=host_password
        )
        
        # Hole aktuelle Crontab
        stdin, stdout, stderr = ssh.exec_command('crontab -l')
        current_crontab = stdout.read().decode()
        logger.info(f"Current crontab before deletion:\n{current_crontab}")
        
        # Extrahiere die Zeit aus der Schedule-ID (Format: HHMM_shutwake)
        time_str = schedule_id.split('_')[0]
        hour = time_str[:2]
        minute = str(int(time_str[2:]))  # Konvertiere zu int und zurück zu str um führende Nullen zu entfernen
        
        logger.info(f"Trying to delete schedule with hour={hour}, minute={minute}")
        
        # Filtere den zu löschenden Job
        new_crontab_lines = []
        for line in current_crontab.splitlines():
            # Prüfe ob die Zeile ein shutwake.sh Eintrag mit der gesuchten Zeit ist
            if 'shutwake.sh' in line:
                parts = line.split()
                logger.info(f"Found shutwake.sh line: {line}")
                logger.info(f"Parts: {parts}")
                if len(parts) >= 2:
                    cron_minute = str(int(parts[0]))  # Entferne führende Nullen
                    cron_hour = str(int(parts[1]))    # Entferne führende Nullen
                    logger.info(f"Comparing cron_minute={cron_minute}, cron_hour={cron_hour} with minute={minute}, hour={hour}")
                    if cron_minute == minute and cron_hour == hour:
                        logger.info("Match found, skipping line")
                        continue
            new_crontab_lines.append(line)
        
        # Stelle sicher, dass die Crontab mit einer Leerzeile endet
        new_crontab = '\n'.join(new_crontab_lines) + '\n'
        logger.info(f"New crontab content:\n{new_crontab}")
        
        # Schreibe neue Crontab direkt
        stdin, stdout, stderr = ssh.exec_command('crontab -')
        stdin.write(new_crontab)
        stdin.channel.shutdown_write()
        
        # Warte auf Beendigung des Befehls
        exit_status = stdout.channel.recv_exit_status()
        if exit_status != 0:
            error_msg = stderr.read().decode()
            logger.error(f"Error updating crontab: {error_msg}")
            raise Exception(f"Failed to update crontab: {error_msg}")
        
        # Überprüfe die Crontab nach dem Update
        stdin, stdout, stderr = ssh.exec_command('crontab -l')
        updated_crontab = stdout.read().decode()
        logger.info(f"Updated crontab after deletion:\n{updated_crontab}")
        
        ssh.close()
        
        return jsonify({
            'status': 'success',
            'message': 'Schedule deleted successfully'
        })
        
    except Exception as e:
        logger.exception("Error deleting schedule")
        return jsonify({
            'status': 'error',
            'message': str(e)
        }), 500

def get_container_icon(container_name):
    """Gibt den Dateinamen des Icons für einen Container zurück"""
    # Spezielle Icon-Mappings
    icon_mappings = {
        'influxdb-arm': 'influxdb',
        'influxdb-x86': 'influxdb',
        'watchyourlanarm': 'watchyourlan',
        'mosquitto-broker': 'mosquitto',
        'mosquitto': 'mosquitto',
        'code-server': 'codeserver',
        'zigbee2mqtt': 'mqtt',
        'webdock-ui': 'webdock',
        'bangertech-ui': 'bangertech',
        'filestash': 'filebrowser',  # Fallback auf filebrowser icon
        'frontail': 'bangertech',    # Fallback auf bangertech icon
        'nodeexporter': 'nodeexporter',
        'bambucam': 'bambucam',
        'scrypted': 'scrypted',
        'spoolman': 'spoolman',
        'backuppro': 'backuppro',
        'dozzle': 'dozzle',
        'jellyfin': 'jellyfin',
        'paperless': 'paperless',
        'uptime-kuma': 'uptime-kuma'
    }
    
    # Verwende das Mapping, wenn vorhanden, sonst den Container-Namen
    icon_name = icon_mappings.get(container_name, container_name)
    
    # Prüfe, ob das Icon existiert
    icon_path = os.path.join(app.static_folder, 'img', 'icons', f'{icon_name}.png')
    if os.path.exists(icon_path):
        logger.debug(f"Found icon for {container_name}: {icon_name}.png")
        return f'{icon_name}.png'
    
    # Fallback auf Standard-Icon
    logger.debug(f"No icon found for {container_name}, using default.png")
    return 'bangertech.png'

@app.route('/api/crontabs', methods=['GET'])
def get_crontabs():
    try:
        # Lade die Host-Konfiguration
        host_config = load_host_config()
        if not host_config:
            return jsonify({'error': 'No host configuration found'}), 404
        
        # Erstelle SSH-Verbindung
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(
            host_config['ip'],
            username=host_config['username'],
            password=host_config['password']
        )
        
        # Hole aktuelle Crontab
        stdin, stdout, stderr = ssh.exec_command('crontab -l')
        crontab_content = stdout.read().decode()
        
        # Parse die Crontab-Einträge
        active_jobs = []
        for line in crontab_content.splitlines():
            if 'shutwake.sh' in line:
                # Extrahiere Zeit aus Crontab-Eintrag (Format: Minute Stunde * * *)
                parts = line.split()
                if len(parts) >= 2:
                    minute, hour = parts[0], parts[1]
                    time_str = f"{hour.zfill(2)}:{minute.zfill(2)}"
                    
                    # Lese die entsprechende shutwake.sh Datei
                    stdin, stdout, stderr = ssh.exec_command(f'cat /usr/local/bin/shutwake.sh')
                    script_content = stdout.read().decode()
                    
                    # Extrahiere Wake-up Zeit aus dem Skript
                    sleep_duration = None
                    for script_line in script_content.splitlines():
                        if 'rtcwake -m no -s' in script_line:
                            sleep_duration = int(script_line.split('-s')[1].strip().split()[0])
                            break
                    
                    if sleep_duration:
                        # Berechne Wake-up Zeit
                        shutdown_time = datetime.strptime(time_str, '%H:%M')
                        wakeup_time = (shutdown_time + timedelta(seconds=sleep_duration))
                        
                        active_jobs.append({
                            'id': f"{time_str.replace(':', '')}_shutwake",
                            'shutdown_time': time_str,
                            'wakeup_time': wakeup_time.strftime('%H:%M'),
                            'duration': sleep_duration // 3600  # Konvertiere zu Stunden
                        })
        
        ssh.close()
        return jsonify({'jobs': active_jobs})
        
    except Exception as e:
        logger.exception("Error getting crontabs")
        return jsonify({'error': str(e)}), 500

@app.route('/api/host-config', methods=['POST'])
def save_host_config_endpoint():
    try:
        data = request.json
        config = {
            'ip': data.get('hostIp'),
            'username': data.get('hostUser'),
            'password': data.get('hostPassword')
        }
        
        if not all(config.values()):
            return jsonify({
                'status': 'error',
                'message': 'Missing required credentials'
            }), 400
        
        # Teste die Verbindung
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            ssh.connect(
                config['ip'],
                username=config['username'],
                password=config['password']
            )
            ssh.close()
        except Exception as e:
            return jsonify({
                'status': 'error',
                'message': f'Connection failed: {str(e)}'
            }), 400
        
        # Speichere die Konfiguration
        if not save_host_config(config):
            return jsonify({
                'status': 'error',
                'message': 'Failed to save configuration'
            }), 500
        
        return jsonify({
            'status': 'success',
            'message': 'Host configuration saved'
        })
        
    except Exception as e:
        logger.exception("Error saving host config")
        return jsonify({
            'status': 'error',
            'message': str(e)
        }), 500

@app.route('/api/host-config', methods=['GET'])
def get_host_config():
    try:
        config = load_host_config()
        if not config:
            return jsonify({'error': 'No host configuration found'}), 404
        return jsonify(config)
    except Exception as e:
        logger.exception("Error getting host config")
        return jsonify({'error': str(e)}), 500

@app.route('/api/categories/refresh', methods=['POST'])
def refresh_categories():
    """Aktualisiert den Kategorien-Cache"""
    try:
        global categories_cache, last_categories_update
        categories_cache = None
        last_categories_update = 0
        return jsonify({'status': 'success'})
    except Exception as e:
        logger.error(f"Error refreshing categories: {str(e)}")
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/convert-docker-run', methods=['POST'])
def convert_docker_run():
    try:
        command = request.json.get('command', '')
        if not command.startswith('docker run'):
            return jsonify({
                'status': 'error',
                'message': 'Invalid docker run command'
            }), 400
            
        # Parse docker run command
        compose = docker_run_to_compose(command)
        
        # Erstelle ein neues Dictionary für den Service mit dem korrekten Namen
        if 'container_name' in compose['services']['app']:
            service_name = compose['services']['app']['container_name']
            compose['services'][service_name] = compose['services']['app']
            del compose['services']['app']
        
        # Konvertiere zu YAML mit korrekter Formatierung
        yaml_str = yaml.dump(compose, default_flow_style=False, sort_keys=False)
        
        return jsonify({
            'status': 'success',
            'compose': yaml_str
        })
        
    except Exception as e:
        logger.error(f"Error converting docker run command: {str(e)}")
        return jsonify({
            'status': 'error',
            'message': str(e)
        }), 500

def docker_run_to_compose(command: str) -> Dict[str, Any]:
    """Konvertiert docker run Befehl zu docker-compose Format"""
    parts = command.split()
    
    compose = {
        'services': {
            'app': {  # Starte immer mit 'app' als Service-Name
                'image': '',
            }
        }
    }
    
    i = 0
    while i < len(parts):
        try:
            if parts[i] == 'docker' and parts[i+1] == 'run':
                i += 2
                continue
                
            if parts[i] == '-d':
                i += 1
                continue
                
            if parts[i] == '--name':
                compose['services']['app']['container_name'] = parts[i+1]
                i += 2
                continue
                
            if parts[i].startswith('-p'):
                port = parts[i+1] if parts[i] == '-p' else parts[i][2:]
                if 'ports' not in compose['services']['app']:
                    compose['services']['app']['ports'] = []
                compose['services']['app']['ports'].append(port)
                i += 2 if parts[i] == '-p' else 1
                continue
                
            if parts[i].startswith('-v'):
                volume = parts[i+1] if parts[i] == '-v' else parts[i][2:]
                if 'volumes' not in compose['services']['app']:
                    compose['services']['app']['volumes'] = []
                compose['services']['app']['volumes'].append(volume)
                i += 2 if parts[i] == '-v' else 1
                continue
                
            if parts[i].startswith('-e'):
                env = parts[i+1] if parts[i] == '-e' else parts[i][2:]
                if 'environment' not in compose['services']['app']:
                    compose['services']['app']['environment'] = []
                compose['services']['app']['environment'].append(env)
                i += 2 if parts[i] == '-e' else 1
                continue
                
            if parts[i] == '--restart':
                compose['services']['app']['restart'] = parts[i+1]
                i += 2
                continue
                
            # Wenn kein Flag, dann ist es das Image
            if not parts[i].startswith('-'):
                compose['services']['app']['image'] = parts[i]
                i += 1
                continue
                
            i += 1
            
        except IndexError:
            raise ValueError(f"Invalid command format at parameter: {parts[i]}")
    
    if not compose['services']['app']['image']:
        raise ValueError("No image specified in docker run command")
    
    return compose

@app.route('/api/import-compose', methods=['POST'])
def import_compose():
    try:
        compose_content = request.json.get('compose', '')
        
        # Validiere YAML
        compose_data = yaml.safe_load(compose_content)
        if not compose_data or 'services' not in compose_data:
            raise ValueError('Invalid compose file format')
            
        # Hole den ersten Service-Namen
        service_name = list(compose_data['services'].keys())[0]
        
        # Erstelle Verzeichnis im standardisierten Format
        # Verwende COMPOSE_DATA_DIR statt CONFIG_DIR, um sicherzustellen, dass Container im richtigen Verzeichnis erstellt werden
        install_path = os.path.join(COMPOSE_DATA_DIR, service_name)
        os.makedirs(install_path, exist_ok=True)
        
        # Speichere compose file
        compose_file_path = os.path.join(install_path, 'docker-compose.yml')
        with open(compose_file_path, 'w') as f:
            f.write(compose_content)
            
        # Starte Container
        result = subprocess.run(
            ['docker', 'compose', '-f', compose_file_path, 'up', '-d'],
            capture_output=True,
            text=True
        )
        
        if result.returncode != 0:
            raise ValueError(f"Failed to start container: {result.stderr}")
        
        # Lade und aktualisiere Kategorien
        categories = load_categories()
        
        # Debug logging
        logger.info(f"Importing container: {service_name}")
        logger.info(f"Categories before update: {categories}")
        
        # Stelle sicher, dass die Imported-Kategorie existiert
        if 'imported' not in categories['categories']:
            logger.info("Creating imported category")
            categories['categories']['imported'] = {
                'name': 'Imported',
                'icon': 'fa-download',
                'description': 'Manually imported containers',
                'containers': []
            }
        
        # Füge Container zur Imported-Kategorie hinzu
        if service_name not in categories['categories']['imported']['containers']:
            logger.info(f"Adding {service_name} to imported category")
            categories['categories']['imported']['containers'].append(service_name)
        
        # Debug logging
        logger.info(f"Categories after update: {categories}")
        
        # Speichere die aktualisierten Kategorien
        save_categories(categories)
        
        # Erstelle compose.info Datei
        info = {
            'name': service_name,
            'description': f'Imported container: {service_name}',
            'category': 'imported',
            'import_date': datetime.now().isoformat()
        }
        
        with open(os.path.join(install_path, 'compose.info'), 'w') as f:
            yaml.dump(info, f, default_flow_style=False)
        
        return jsonify({
            'status': 'success',
            'message': f'Container {service_name} imported successfully'
        })
        
    except Exception as e:
        logger.error(f"Error importing compose file: {str(e)}")
        return jsonify({
            'status': 'error',
            'message': str(e)
        }), 500

def save_categories(categories):
    """Speichert die Kategorien in die categories.yaml Datei"""
    try:
        with open(CATEGORIES_FILE, 'w') as f:
            yaml.dump(categories, f, default_flow_style=False, sort_keys=False)
        # Setze Berechtigungen
        os.chmod(CATEGORIES_FILE, 0o644)
    except Exception as e:
        logger.error(f"Error saving categories: {str(e)}")
        raise

def detect_system_architecture():
    """Erkennt die Systemarchitektur (ARM/Raspberry Pi oder x86/AMD64)"""
    try:
        # Führe den Befehl 'uname -m' aus, um die Architektur zu erhalten
        result = subprocess.run(['uname', '-m'], capture_output=True, text=True, check=True)
        architecture = result.stdout.strip().lower()
        
        # Prüfe, ob es sich um eine ARM-Architektur handelt
        is_arm = any(arm_type in architecture for arm_type in ['arm', 'aarch64'])
        
        logger.info(f"Detected system architecture: {architecture}, is ARM: {is_arm}")
        
        return {
            'architecture': architecture,
            'is_arm': is_arm,
            'is_raspberry_pi': is_arm,  # Vereinfachte Annahme: ARM = Raspberry Pi
            'is_x86': not is_arm
        }
    except Exception as e:
        logger.error(f"Error detecting system architecture: {e}")
        # Standardmäßig x86 annehmen, wenn die Erkennung fehlschlägt
        return {
            'architecture': 'unknown',
            'is_arm': False,
            'is_raspberry_pi': False,
            'is_x86': True
        }

# Systemarchitektur beim Start erkennen
SYSTEM_INFO = detect_system_architecture()

@app.route('/api/system/info')
def get_system_info():
    """Gibt Informationen über das System zurück (nur für interne Verwendung)"""
    try:
        # Hole die IP-Adresse des Systems
        ip_address = None
        try:
            # Versuche die IP-Adresse zu ermitteln
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip_address = s.getsockname()[0]
            s.close()
        except Exception as e:
            logger.error(f"Error getting IP address: {e}")
            # Fallback: Hostname auflösen
            try:
                ip_address = socket.gethostbyname(socket.gethostname())
            except Exception as e:
                logger.error(f"Error resolving hostname: {e}")
                ip_address = "127.0.0.1"
        
        # Erweitere die Systeminformationen
        system_info = SYSTEM_INFO.copy()
        system_info['ip_address'] = ip_address
        
        # Hole Netzwerkschnittstellen
        network_interfaces = []
        try:
            # Hole alle Netzwerkschnittstellen
            interfaces = os.listdir('/sys/class/net/')
            for interface in interfaces:
                if interface != 'lo':  # Ignoriere Loopback-Interface
                    network_interfaces.append(interface)
        except Exception as e:
            logger.error(f"Error getting network interfaces: {e}")
        
        system_info['network_interfaces'] = network_interfaces
        
        return jsonify(system_info)
    except Exception as e:
        logger.exception(f"Error getting system info: {e}")
        return jsonify({
            'error': str(e),
            'architecture': 'unknown',
            'is_arm': False,
            'is_raspberry_pi': False,
            'is_x86': True,
            'ip_address': '127.0.0.1',
            'network_interfaces': []
        })

def setup_prometheus(container_name, install_path, config_data=None):
    """Setup für Prometheus"""
    try:
        # Erstelle Verzeichnisse
        prometheus_dir = os.path.join(install_path, 'prometheus')
        data_dir = os.path.join(install_path, 'data')
        
        # Erstelle Verzeichnisse mit korrekten Berechtigungen
        os.makedirs(prometheus_dir, exist_ok=True)
        os.makedirs(data_dir, exist_ok=True)
        
        # Setze Berechtigungen (wichtig für Prometheus)
        os.chmod(prometheus_dir, 0o755)
        os.chmod(data_dir, 0o777)  # Prometheus benötigt Schreibrechte
        
        logger.info(f"Created Prometheus configuration files in {prometheus_dir}")
        
        # Verwende die vom Frontend übermittelte Host-IP-Adresse oder localhost als Standard
        host_ip = "localhost"  # Standardwert
        
        # Prüfe, ob Konfigurationsdaten vorhanden sind
        if config_data and isinstance(config_data, dict) and 'prometheus' in config_data:
            prometheus_config = config_data.get('prometheus', {})
            if 'host_ip' in prometheus_config and prometheus_config['host_ip']:
                host_ip = prometheus_config['host_ip']
                logger.info(f"Using host IP address from frontend: {host_ip}")
        
        logger.info(f"Using host IP address for Prometheus: {host_ip}")
        
        # Erstelle prometheus.yml mit der ermittelten IP-Adresse
        prometheus_yml = os.path.join(prometheus_dir, 'prometheus.yml')
        
        # Prüfe, ob eine Template-Konfigurationsdatei existiert
        template_prometheus_yml = os.path.join(COMPOSE_FILES_DIR, container_name, "prometheus.yml")
        
        if os.path.exists(template_prometheus_yml):
            # Kopiere die Template-Konfigurationsdatei
            logger.info(f"Using template prometheus.yml from {template_prometheus_yml}")
            
            # Lese den Inhalt der Template-Datei
            with open(template_prometheus_yml, 'r') as template_file:
                template_content = template_file.read()
            
            # Ersetze Platzhalter mit der Host-IP
            template_content = template_content.replace("{{host_ip}}", host_ip)
            
            # Schreibe den angepassten Inhalt in die Zieldatei
            with open(prometheus_yml, 'w') as target_file:
                target_file.write(template_content)
        else:
            # Erstelle eine neue Konfigurationsdatei
            logger.info("Creating new prometheus.yml file")
            with open(prometheus_yml, 'w') as f:
                f.write(f"""# my global config
global:
  scrape_interval: 15s # Set the scrape interval to every 15 seconds. Default is every 1 minute.
  evaluation_interval: 15s # Evaluate rules every 15 seconds. The default is every 1 minute.
  # scrape_timeout is set to the global default (10s).

# Alertmanager configuration
alerting:
  alertmanagers:
    - static_configs:
        - targets:
          # - alertmanager:9093

# Load rules once and periodically evaluate them according to the global 'evaluation_interval'.
rule_files:
  - "alert.yml"
  # - "second_rules.yml"

# A scrape configuration containing exactly one endpoint to scrape:
# Here it's Prometheus itself.
scrape_configs:
  # The job name is added as a label `job=<job_name>` to any timeseries scraped from this config.
  - job_name: "prometheus"

    # metrics_path defaults to '/metrics'
    # scheme defaults to 'http'.

    static_configs:
      - targets: ["localhost:9090"]

  - job_name: "node"
    static_configs:
      - targets: ["{host_ip}:9100"]
""")
        
        # Erstelle alert.yml
        alert_yml = os.path.join(prometheus_dir, 'alert.yml')
        with open(alert_yml, 'w') as f:
            f.write("""groups:
- name: example
  rules:
  - alert: HighLoad
    expr: node_load1 > 0.5
    for: 2m
    labels:
      severity: page
    annotations:
      summary: "Instance {{ $labels.instance }} under high load"
      description: "{{ $labels.instance }} of job {{ $labels.job }} is under high load."
""")

        # Setze Berechtigungen für die Konfigurationsdateien
        os.chmod(prometheus_yml, 0o644)
        os.chmod(alert_yml, 0o644)
        
        # Hole die Port-Konfiguration
        port = "9090"  # Standardwert
        if config_data and 'ports' in config_data:
            ports = config_data.get('ports', {})
            if ports and '9090' in ports:
                port = ports['9090']
        
        # Erstelle die docker-compose.yml
        compose_file = os.path.join(install_path, 'docker-compose.yml')
        with open(compose_file, 'w') as f:
            f.write(f"""version: '3'
services:
  prometheus:
    container_name: prometheus
    image: prom/prometheus:latest
    networks:
      - webdock-network
    restart: unless-stopped
    ports:
      - "{port}:9090"
    volumes:
      - ./prometheus:/etc/prometheus
      - ./data:/prometheus

networks:
  webdock-network:
    external: true
""")
        
        logger.info(f"Created Prometheus docker-compose.yml with port {port}")
        
        return True
    except Exception as e:
        logger.error(f"Prometheus setup failed: {str(e)}")
        return False

@app.route('/api/container/<container_name>/config-files', methods=['GET'])
def get_container_config_files(container_name):
    """Gibt zusätzliche Konfigurationsdateien für einen Container zurück"""
    try:
        # Debug-Ausgaben hinzufügen
        logger.info(f"COMPOSE_DATA_DIR: {COMPOSE_DATA_DIR}")
        logger.info(f"Container name: {container_name}")
        
        # Prüfe, ob der Container installiert ist
        # Verwende den Container-Pfad direkt
        install_path = os.path.join('/app/webdock/webdock-data', container_name)
        logger.info(f"Suche nach Konfigurationsdateien in: {install_path}")
        
        if not os.path.exists(install_path):
            logger.warning(f"Pfad existiert nicht: {install_path}")
            return jsonify({'error': 'Container not installed'}), 404
        
        config_files = []
        
        # Spezielle Behandlung für bekannte Container
        if container_name == 'prometheus':
            # Prometheus hat zusätzliche Konfigurationsdateien im prometheus-Verzeichnis
            prometheus_dir = os.path.join(install_path, 'prometheus')
            if os.path.exists(prometheus_dir):
                for filename in ['prometheus.yml', 'alert.yml']:
                    file_path = os.path.join(prometheus_dir, filename)
                    if os.path.exists(file_path):
                        with open(file_path, 'r') as f:
                            content = f.read()
                        config_files.append({
                            'name': filename,
                            'path': file_path,
                            'content': content
                        })
        elif container_name == 'mosquitto-broker':
            # Mosquitto hat Konfigurationsdateien im config-Verzeichnis
            config_dir = os.path.join(install_path, 'config')
            if os.path.exists(config_dir):
                for filename in ['mosquitto.conf']:
                    file_path = os.path.join(config_dir, filename)
                    if os.path.exists(file_path):
                        with open(file_path, 'r') as f:
                            content = f.read()
                        config_files.append({
                            'name': filename,
                            'path': file_path,
                            'content': content
                        })
        
        # Allgemeine Suche nach Konfigurationsdateien in typischen Verzeichnissen
        for config_dir in ['config', 'conf', 'etc']:
            dir_path = os.path.join(install_path, config_dir)
            if os.path.exists(dir_path) and os.path.isdir(dir_path):
                for filename in os.listdir(dir_path):
                    if filename.endswith(('.yml', '.yaml', '.conf', '.config', '.json', '.ini')):
                        file_path = os.path.join(dir_path, filename)
                        if os.path.isfile(file_path):
                            try:
                                with open(file_path, 'r') as f:
                                    content = f.read()
                                config_files.append({
                                    'name': filename,
                                    'path': file_path,
                                    'content': content
                                })
                            except Exception as e:
                                logger.error(f"Error reading config file {file_path}: {str(e)}")
        
        return jsonify({
            'config_files': config_files
        })
        
    except Exception as e:
        logger.exception(f"Error getting config files for container {container_name}: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/container/<container_name>/save-config', methods=['POST'])
def save_container_config(container_name):
    """Speichert eine Konfigurationsdatei für einen Container und startet ihn neu"""
    try:
        data = request.json
        if not data or 'path' not in data or 'content' not in data:
            return jsonify({'error': 'Invalid request data'}), 400
        
        file_path = data['path']
        content = data['content']
        
        # Sicherheitscheck: Stelle sicher, dass die Datei im richtigen Verzeichnis liegt
        install_path = os.path.join(COMPOSE_DATA_DIR, container_name)
        if not file_path.startswith(install_path):
            return jsonify({'error': 'Invalid file path'}), 400
        
        # Speichere die Datei
        with open(file_path, 'w') as f:
            f.write(content)
        
        logger.info(f"Saved config file {file_path} for container {container_name}")
        
        # Starte den Container neu, wenn er läuft
        running_containers = get_running_containers()
        if container_name in running_containers:
            # Verwende die bestehende Funktion zum Neustarten des Containers
            return restart_container(container_name)
        
        return jsonify({
            'status': 'success',
            'message': 'Configuration saved successfully'
        })
        
    except Exception as e:
        logger.exception(f"Error saving config for container {container_name}: {str(e)}")
        return jsonify({'error': str(e)}), 500

def setup_hoarder(container_name, install_path, config_data=None):
    """Setup für Hoarder"""
    try:
        # Erstelle Verzeichnisse
        config_dir = os.path.join(install_path, 'config')
        data_dir = os.path.join(install_path, 'data')
        log_dir = os.path.join(install_path, 'log')
        
        # Erstelle Verzeichnisse mit korrekten Berechtigungen
        os.makedirs(config_dir, exist_ok=True)
        os.makedirs(data_dir, exist_ok=True)
        os.makedirs(log_dir, exist_ok=True)
        
        logger.info(f"Created and configured directory: {config_dir}")
        logger.info(f"Created and configured directory: {data_dir}")
        logger.info(f"Created and configured directory: {log_dir}")
        
        # Erstelle .env-Datei mit allen erforderlichen Umgebungsvariablen
        env_file = os.path.join(install_path, '.env')
        with open(env_file, 'w') as f:
            f.write("""# Hoarder Environment Variables
MEILI_MASTER_KEY=masterKey
HOARDER_VERSION=release
NEXTAUTH_SECRET=supersecretkey123456789
NEXTAUTH_URL=http://localhost:3004
""")
        
        logger.info(f"Created .env file: {env_file}")
        
        # Erstelle eine angepasste docker-compose.yml, die das Netzwerk-Problem behebt
        compose_file = os.path.join(install_path, 'docker-compose.yml')
        with open(compose_file, 'w') as f:
            f.write("""version: "3.8"
services:
  web:
    image: ghcr.io/hoarder-app/hoarder:release
    restart: unless-stopped
    networks:
      - webdock-network
    volumes:
      - ./data:/data
    ports:
      - 3004:3000
    env_file:
      - .env
    environment:
      MEILI_ADDR: http://meilisearch:7700
      BROWSER_WEB_URL: http://chrome:9222
      DATA_DIR: /data
      NEXTAUTH_SECRET: supersecretkey123456789
      NEXTAUTH_URL: http://localhost:3004
    depends_on:
      - chrome
      - meilisearch
  chrome:
    image: gcr.io/zenika-hub/alpine-chrome:123
    restart: unless-stopped
    networks:
      - webdock-network
    command:
      - --no-sandbox
      - --disable-gpu
      - --disable-dev-shm-usage
      - --remote-debugging-address=0.0.0.0
      - --remote-debugging-port=9222
      - --hide-scrollbars
  meilisearch:
    image: getmeili/meilisearch:v1.11.1
    restart: unless-stopped
    networks:
      - webdock-network
    env_file:
      - .env
    environment:
      MEILI_NO_ANALYTICS: "true"
    volumes:
      - ./meilisearch:/meili_data

volumes:
  meilisearch:

networks:
  webdock-network:
    external: true
""")
        
        logger.info(f"Created custom docker-compose.yml for Hoarder")
        logger.info(f"Added webdock-network configuration for all services")
        
        return True
    except Exception as e:
        logger.error(f"Hoarder setup failed: {str(e)}")
        return False

def setup_codeserver(container_name, install_path, config_data=None):
    """Setup für Code-Server"""
    try:
        # Erstelle Verzeichnisse
        config_dir = os.path.join(install_path, 'config')
        os.makedirs(config_dir, exist_ok=True, mode=0o755)
        
        # Hole die Port-Konfiguration
        port = "8440"  # Standardwert
        if config_data and 'ports' in config_data:
            ports = config_data.get('ports', {})
            if ports and '8443' in ports:
                port = ports['8443']
        
        # Hole die Umgebungsvariablen aus den Konfigurationsdaten
        env_vars = config_data.get('env', {}) if config_data else {}
        
        # Setze Standardwerte für Passwörter, wenn nicht angegeben
        if 'PASSWORD' not in env_vars or not env_vars['PASSWORD']:
            env_vars['PASSWORD'] = 'admin'
            logger.info("Using default PASSWORD for Code-Server")
            
        if 'SUDO_PASSWORD' not in env_vars or not env_vars['SUDO_PASSWORD']:
            env_vars['SUDO_PASSWORD'] = 'admin'
            logger.info("Using default SUDO_PASSWORD for Code-Server")
        
        # Setze Standardwerte für PUID und PGID, wenn nicht angegeben
        if 'PUID' not in env_vars or not env_vars['PUID']:
            env_vars['PUID'] = '1000'
            logger.info("Using default PUID for Code-Server")
            
        if 'PGID' not in env_vars or not env_vars['PGID']:
            env_vars['PGID'] = '1000'
            logger.info("Using default PGID for Code-Server")
        
        # Setze Standardwert für TZ, wenn nicht angegeben
        if 'TZ' not in env_vars or not env_vars['TZ']:
            env_vars['TZ'] = 'Europe/Berlin'
            logger.info("Using default TZ for Code-Server")
        
        # Aktualisiere die Konfigurationsdaten
        if config_data:
            config_data['env'] = env_vars
        
        # Check for template docker-compose.yml file
        template_compose_path = os.path.join(CONFIG_DIR, 'templates', 'codeserver', 'docker-compose.yml')
        compose_file = os.path.join(install_path, 'docker-compose.yml')
        
        if os.path.exists(template_compose_path):
            # Copy the template docker-compose.yml file
            shutil.copy2(template_compose_path, compose_file)
            logger.info(f"Copied template docker-compose.yml for Code-Server from {template_compose_path}")
            
            # Update the port and environment variables in the docker-compose.yml file
            with open(compose_file, 'r') as f:
                compose_content = f.read()
            
            # Replace the port in the compose file
            compose_content = re.sub(r'\d+:8443', f'{port}:8443', compose_content)
            
            # Replace environment variables
            for key, value in env_vars.items():
                pattern = rf'{key}=\S+'
                replacement = f'{key}={value}'
                compose_content = re.sub(pattern, replacement, compose_content)
            
            with open(compose_file, 'w') as f:
                f.write(compose_content)
        else:
            # Erstelle die docker-compose.yml
            with open(compose_file, 'w') as f:
                f.write(f"""version: '3'
services:
  code-server:
    image: lscr.io/linuxserver/code-server:latest
    container_name: code-server
    networks:
      - webdock-network
    environment:
      - PUID={env_vars.get('PUID', '1000')}
      - PGID={env_vars.get('PGID', '1000')}
      - TZ={env_vars.get('TZ', 'Europe/Berlin')}
      - PASSWORD={env_vars.get('PASSWORD', 'admin')}
      - SUDO_PASSWORD={env_vars.get('SUDO_PASSWORD', 'admin')}
    volumes:
      - ./config:/config
    ports:
      - {port}:8443
    restart: unless-stopped

networks:
  webdock-network:
    external: true
""")
        
        logger.info(f"Created Code-Server docker-compose.yml with port: {port} and added to webdock-network")
        
        return True
    except Exception as e:
        logger.error(f"Code-Server setup failed: {str(e)}")
        return False

def setup_scrypted(container_name, install_path, config_data=None):
    """Setup für Scrypted"""
    try:
        # Erstelle Verzeichnisse
        data_dir = os.path.join(install_path, 'data')
        os.makedirs(data_dir, exist_ok=True, mode=0o755)
        
        # Hole die Port-Konfiguration
        port = "10443"  # Standardwert
        if config_data and 'ports' in config_data:
            ports = config_data.get('ports', {})
            if ports and '10443' in ports:
                port = ports['10443']
        
        # Scrypted benötigt Zugriff auf das Host-Netzwerk für bestimmte Funktionen
        # Wir erstellen zwei Versionen der docker-compose.yml:
        # 1. Mit network_mode: host (Standard)
        # 2. Mit webdock-network (als Alternative)
        
        # Erstelle die docker-compose.yml mit host-Netzwerk
        compose_file = os.path.join(install_path, 'docker-compose.yml')
        with open(compose_file, 'w') as f:
            f.write(f"""version: '3'
services:
  scrypted:
    image: ghcr.io/koush/scrypted:latest
    container_name: scrypted
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./data:/server/volume
    # logging is noisy and will unnecessarily wear on flash storage.
    # scrypted has per device in memory logging that is preferred.
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "10"
""")
        
        # Erstelle eine alternative docker-compose.yml mit webdock-network
        alt_compose_file = os.path.join(install_path, 'docker-compose-network.yml')
        with open(alt_compose_file, 'w') as f:
            f.write(f"""version: '3'
services:
  scrypted:
    image: ghcr.io/koush/scrypted:latest
    container_name: scrypted
    restart: unless-stopped
    networks:
      - webdock-network
    ports:
      - "{port}:10443"
    volumes:
      - ./data:/server/volume
    # logging is noisy and will unnecessarily wear on flash storage.
    # scrypted has per device in memory logging that is preferred.
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "10"

networks:
  webdock-network:
    external: true
""")
        
        # Erstelle ein Skript zum Umschalten zwischen den Netzwerkmodi
        switch_script = os.path.join(install_path, 'switch-network-mode.sh')
        with open(switch_script, 'w') as f:
            f.write(f"""#!/bin/bash
echo "Switching Scrypted network mode..."
echo "Current mode: $(grep -A 1 'network_mode' docker-compose.yml || echo 'Using webdock-network')"
echo ""

if grep -q 'network_mode: host' docker-compose.yml; then
    echo "Switching to webdock-network mode..."
    docker-compose down
    cp docker-compose-network.yml docker-compose.yml
    docker-compose up -d
    echo "Scrypted is now using webdock-network. Some features might not work properly."
else
    echo "Switching to host network mode..."
    docker-compose down
    cat > docker-compose.yml << EOF
version: '3'
services:
  scrypted:
    image: ghcr.io/koush/scrypted:latest
    container_name: scrypted
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./data:/server/volume
    # logging is noisy and will unnecessarily wear on flash storage.
    # scrypted has per device in memory logging that is preferred.
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "10"
EOF
    docker-compose up -d
    echo "Scrypted is now using host network mode."
fi
""")
        
        # Setze Ausführungsrechte für das Skript
        os.chmod(switch_script, 0o755)
        
        logger.info(f"Created Scrypted docker-compose.yml with host network mode")
        logger.info(f"Created alternative docker-compose-network.yml with webdock-network")
        logger.info(f"Created switch-network-mode.sh script to switch between network modes")
        
        return True
    except Exception as e:
        logger.error(f"Scrypted setup failed: {str(e)}")
        return False

@app.route('/api/network-info')
def get_network_info():
    """Gibt Informationen über das Netzwerk zurück"""
    try:
        # Versuche zuerst, die Netzwerkinformationen aus der JSON-Datei zu lesen
        network_info_file = os.path.join(app.config.get('CONFIG_DIR', '/app/config'), 'network_info.json')
        logger.info(f"Looking for network info file at: {network_info_file}")
        
        if os.path.exists(network_info_file):
            try:
                with open(network_info_file, 'r') as f:
                    network_info = json.load(f)
                    logger.info(f"Loaded network info from file: {network_info}")
                    
                    # Extrahiere die Informationen
                    default_interface = network_info.get('interface', 'eth0')
                    ip_addr = network_info.get('ip_address')
                    ip_range = network_info.get('ip_range', '192.168.1.0/24')
                    
                    logger.info(f"Using interface from file: {default_interface}")
                    logger.info(f"Using IP range from file: {ip_range}")
                    
                    # Versuche, die Client-IP-Adresse zu erhalten
                    client_ip = request.remote_addr
                    logger.info(f"Client IP address: {client_ip}")
                    
                    return jsonify({
                        'interface': default_interface,
                        'ip_address': ip_addr,
                        'ip_range': ip_range,
                        'client_ip': client_ip
                    })
            except Exception as e:
                logger.error(f"Error reading network info file: {str(e)}")
                logger.exception(e)  # Log the full exception with traceback
        else:
            logger.warning(f"Network info file not found at: {network_info_file}")
        
        # Fallback: Verwende die alte Methode
        logger.info("Network info file not found or error reading it, using fallback method")
        
        # Rest der Funktion bleibt unverändert...
        
        # Ermittle das Standard-Netzwerkinterface
        default_interface = get_default_network_interface()
        logger.info(f"Detected default network interface: {default_interface}")
        
        # Versuche, alle Netzwerkinterfaces mit dem Befehl 'ip a' zu ermitteln
        try:
            # Verwende den Befehl 'ip a | grep -E "^[0-9]" | grep -v "lo:" | cat'
            result = subprocess.run(
                "ip a | grep -E '^[0-9]' | grep -v 'lo:' | cat",
                shell=True,
                capture_output=True,
                text=True
            )
            
            if result.returncode == 0 and result.stdout:
                # Suche nach aktiven Interfaces (UP)
                interfaces = []
                for line in result.stdout.splitlines():
                    match = re.search(r'^\d+:\s+(\S+):', line)
                    if match and 'state UP' in line:
                        iface = match.group(1)
                        # Ignoriere Docker- und virtuelle Interfaces
                        if not iface.startswith('docker') and not iface.startswith('veth') and not iface.startswith('br-'):
                            interfaces.append(iface)
                            logger.info(f"Found active interface: {iface}")
                
                # Wenn aktive Interfaces gefunden wurden, verwende das erste
                if interfaces:
                    default_interface = interfaces[0]
                    logger.info(f"Using active interface: {default_interface}")
        except Exception as e:
            logger.error(f"Error detecting interfaces with 'ip a': {str(e)}")
        
        # Ermittle die IP-Adresse und den Netzwerkbereich
        ip_addr = None
        ip_range = "192.168.1.0/24"  # Standardwert
        try:
            # Hole die IP-Adresse des Interfaces
            result = subprocess.run(
                f"ip addr show {default_interface} | grep 'inet ' | awk '{{print $2}}'",
                shell=True,
                capture_output=True,
                text=True
            )
            
            if result.returncode == 0 and result.stdout:
                # Extrahiere die IP-Adresse und das Subnetz
                ip_cidr = result.stdout.strip()
                if '/' in ip_cidr:
                    ip_addr, subnet = ip_cidr.split('/')
                    # Berechne den Netzwerkbereich
                    ip_parts = ip_addr.split('.')
                    ip_range = f"{ip_parts[0]}.{ip_parts[1]}.{ip_parts[2]}.0/{subnet}"
                    logger.info(f"Detected IP address: {ip_addr}")
                    logger.info(f"Detected IP range: {ip_range}")
        except Exception as e:
            logger.error(f"Error detecting IP address: {str(e)}")
        
        # Versuche, die Client-IP-Adresse zu erhalten
        client_ip = request.remote_addr
        logger.info(f"Client IP address: {client_ip}")
        
        # Wenn die Client-IP im selben Netzwerk ist, können wir sie verwenden, um den Netzwerkbereich zu bestimmen
        if client_ip and not client_ip.startswith('127.') and not client_ip.startswith('172.') and not client_ip == '::1':
            try:
                # Extrahiere die ersten drei Oktette der IP-Adresse
                client_ip_parts = client_ip.split('.')
                if len(client_ip_parts) == 4:
                    # Wenn wir keinen IP-Bereich haben, verwenden wir die Client-IP
                    if not ip_range or ip_range == "192.168.1.0/24":
                        ip_range = f"{client_ip_parts[0]}.{client_ip_parts[1]}.{client_ip_parts[2]}.0/24"
                        logger.info(f"Using client IP to determine network range: {ip_range}")
            except Exception as e:
                logger.error(f"Error processing client IP: {str(e)}")
        
        # Wenn das Interface immer noch eth0 ist (Fallback), aber wir haben ens18 in der Umgebung,
        # dann verwenden wir ens18
        if default_interface == "eth0":
            try:
                # Prüfe, ob ens18 existiert
                result = subprocess.run(
                    "ls /sys/class/net | grep ens18",
                    shell=True,
                    capture_output=True,
                    text=True
                )
                if result.returncode == 0 and "ens18" in result.stdout:
                    default_interface = "ens18"
                    logger.info(f"Overriding interface to ens18 based on system check")
            except Exception as e:
                logger.error(f"Error checking for ens18 interface: {str(e)}")
        
        return jsonify({
            'interface': default_interface,
            'ip_address': ip_addr,
            'ip_range': ip_range,
            'client_ip': client_ip
        })
        
    except Exception as e:
        logger.exception(f"Error getting network info: {str(e)}")
        return jsonify({'error': str(e)}), 500

def setup_nodered(container_name, install_path, config_data=None):
    """Setup for Node-RED"""
    try:
        # Create directories
        data_dir = os.path.join(install_path, 'data')
        os.makedirs(data_dir, exist_ok=True, mode=0o777)  # Set permissions to 777 to avoid permission issues
        
        # Get port configuration
        port = "1880"  # Default port for Node-RED
        
        if config_data and 'ports' in config_data:
            ports = config_data.get('ports', {})
            if ports and '1880' in ports:
                port = ports['1880']
        
        # Check for template docker-compose.yml file
        template_compose_path = os.path.join(CONFIG_DIR, 'templates', 'node-red', 'docker-compose.yml')
        compose_file = os.path.join(install_path, 'docker-compose.yml')
        
        if os.path.exists(template_compose_path):
            # Copy the template docker-compose.yml file
            shutil.copy2(template_compose_path, compose_file)
            logger.info(f"Copied template docker-compose.yml for Node-RED from {template_compose_path}")
            
            # Update the port in the docker-compose.yml file
            with open(compose_file, 'r') as f:
                compose_content = f.read()
            
            # Replace the port in the compose file
            compose_content = re.sub(r'"\d+:1880"', f'"{port}:1880"', compose_content)
            
            with open(compose_file, 'w') as f:
                f.write(compose_content)
        else:
            # Create the docker-compose.yml
            with open(compose_file, 'w') as f:
                f.write(f"""services:
  node-red:
    image: nodered/node-red:latest
    container_name: node-red
    environment:
      - TZ=Europe/Berlin
    ports:
      - "{port}:1880"
    volumes:
      - ./data:/data
    restart: unless-stopped
    networks:
      - webdock-network

networks:
  webdock-network:
    external: true
""")
        
        logger.info(f"Created docker-compose.yml for Node-RED with port {port}")
        logger.info(f"Set permissions for Node-RED data directory to 777")
        return True
    except Exception as e:
        logger.error(f"Node-RED setup failed: {str(e)}")
        return False

if __name__ == '__main__':
    # Initialisiere die Anwendung
    init_app()
    
    # Print initial debug info
    logger.info("=== Initial Configuration ===")
    logger.info(f"Working Directory: {os.getcwd()}")
    logger.info(f"Directory Contents: {os.listdir('.')}")
    logger.info(f"Static Folder: {app.static_folder}")
    logger.info(f"Template Folder: {app.template_folder}")
    
    app.run(host='0.0.0.0', port=80) 