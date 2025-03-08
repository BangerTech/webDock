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
app.debug = True

GITHUB_RAW_URL = "https://raw.githubusercontent.com/BangerTech/webDock/main/docker-compose-files"
GITHUB_API_URL = "https://api.github.com/repos/BangerTech/webDock/contents/docker-compose-files"

# Cache für Container-Konfigurationen
CACHE_TIMEOUT = 300  # 5 Minuten
last_update = 0
config_cache = {}

# Konstanten und Konfiguration
CONFIG_DIR = os.getenv('CONFIG_DIR', '/home/webDock/webdock-data')
CATEGORIES_FILE = os.path.join(CONFIG_DIR, 'categories.yaml')
COMPOSE_DIR = os.path.join(CONFIG_DIR, 'compose-files')
COMPOSE_FILES_DIR = os.getenv('COMPOSE_FILES_DIR', '/home/webDock/docker-compose-files')
COMPOSE_DATA_DIR = os.getenv('COMPOSE_DATA_DIR', '/home/webDock/webdock-data/compose-files')
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
WEBDOCK_BASE_PATH = os.environ.get('WEBDOCK_BASE_PATH', '/home/webDock')

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
        compose_dir = '/app/docker-compose-files'  # Geändert von /home/webDock/docker-compose-files
        if not os.path.exists(compose_dir):
            download_compose_files()
        config_cache = load_container_configs(compose_dir)
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
                    return port.split(':')[0]  # Nimm den Host-Port
                elif isinstance(port, (int, str)):
                    return str(port)
        return None
    except Exception as e:
        logger.error(f"Error extracting port: {e}")
        return None

def load_categories():
    """Lädt die Kategorien aus der YAML-Datei oder erstellt Standardkategorien"""
    try:
        if os.path.exists(CATEGORIES_FILE):
            with open(CATEGORIES_FILE, 'r') as f:
                categories = yaml.safe_load(f)
                
                # Filtere Container basierend auf der Systemarchitektur
                if categories and 'categories' in categories:
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
        
        # Wenn keine Datei existiert, erstelle Standardkategorien
        default_categories = {
            'categories': {
                'smarthome': {
                    'name': 'Smart Home',
                    'icon': 'fa-home',
                    'description': 'Home automation systems',
                    'containers': ['openhab', 'homeassistant', 'raspberrymatic', 'bambucam', 'scrypted']
                },
                'bridge': {
                    'name': 'Bridge',
                    'icon': 'fa-exchange',
                    'description': 'IoT bridges and communication',
                    'containers': ['homebridge', 'mosquitto-broker', 'zigbee2mqtt']
                },
                'dashboard': {
                    'name': 'Dashboard',
                    'icon': 'fa-th-large',
                    'description': 'Visualization and monitoring dashboards',
                    'containers': ['heimdall', 'grafana']
                },
                'service': {
                    'name': 'Service',
                    'icon': 'fa-cogs',
                    'description': 'System services and tools',
                    'containers': ['codeserver', 'frontail', 'nodeexporter', 'portainer', 'dockge', 'prometheus']
                },
                'other': {
                    'name': 'Other',
                    'icon': 'fa-ellipsis-h',
                    'description': 'Additional containers and tools',
                    'containers': ['whatsupdocker', 'watchyourlan', 'webdock-ui', 'spoolman']
                }
            }
        }
        
        # Füge plattformspezifische Container hinzu
        if SYSTEM_INFO['is_arm']:
            default_categories['categories']['service']['containers'].append('filebrowser')
        else:
            default_categories['categories']['other']['containers'].append('filestash')
        
        return default_categories
        
    except Exception as e:
        logger.error(f"Error loading categories: {e}")
        return {'categories': {}}

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
    for category_id, category in categories.get('categories', {}).items():
        if dirname.lower() in category.get('containers', []):
            return category['name']
    return 'Other'

def _get_group_icon(group):
    categories = load_categories()
    for category in categories.get('categories', {}).values():
        if category['name'] == group:
            return category['icon']
    return 'fa-cube'

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
    """Führt container-spezifische Setups durch"""
    try:
        logger.info(f"Setting up environment for {container_name} in {install_path}")
        
        # Container-spezifische Setups
        if container_name == 'mosquitto-broker':
            return setup_mosquitto(container_name, install_path)
            
        elif container_name == 'grafana':
            return setup_grafana(container_name, install_path)
            
        elif container_name == 'influxdb-x86':
            return setup_influxdb(container_name, install_path, config_data)
            
        elif container_name == 'dockge':
            return setup_dockge(container_name, install_path, config_data)
            
        elif container_name == 'filestash':
            return setup_filestash(container_name, install_path)
            
        elif container_name == 'watchyourlan':
            return setup_watchyourlan(container_name, install_path, config_data)
            
        # Für Container ohne spezielle Setup-Anforderungen
        return True
        
    except Exception as e:
        logger.error(f"Error in setup for {container_name}: {str(e)}")
        return False

def download_compose_files():
    """Lädt die docker-compose Files von GitHub herunter"""
    try:
        # Hole die Liste der Verzeichnisse von GitHub
        response = requests.get(GITHUB_API_URL)
        if response.status_code != 200:
            raise Exception(f"Failed to get directory listing: {response.status_code}")
        
        directories = [item['name'] for item in response.json() if item['type'] == 'dir']
        logger.info(f"Found {len(directories)} directories: {directories}")
        
        successful_downloads = 0
        
        # Erstelle das Basis-Verzeichnis
        os.makedirs('/app/docker-compose-files', exist_ok=True)
        
        for directory in directories:
            try:
                # Hole die docker-compose.yml
                compose_url = f"{GITHUB_RAW_URL}/{directory}/docker-compose.yml"
                response = requests.get(compose_url)
                
                if response.status_code == 200:
                    # Erstelle Verzeichnis und speichere die Datei
                    os.makedirs(f'/app/docker-compose-files/{directory}', exist_ok=True)
                    with open(f'/app/docker-compose-files/{directory}/docker-compose.yml', 'w') as f:
                        f.write(response.text)
                    successful_downloads += 1
                
            except Exception as e:
                logger.error(f"Error downloading {directory}: {str(e)}")
                continue
        
        logger.info(f"Successfully downloaded {successful_downloads} of {len(directories)} compose files")
        return True
        
    except Exception as e:
        logger.error(f"Error downloading compose files: {str(e)}")
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

def get_installed_containers():
    """Überprüft welche Container installiert sind"""
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
                    if container in ['webdock-ui', 'bangertech-ui']:
                        installed.add('webdock-ui')  # Normalisiere auf webdock-ui
                    else:
                        installed.add(container)
                        
                        # Spezielle Behandlung für bekannte Container
                        if container == 'code-server':
                            installed.add('codeserver')
                        elif container == 'node_exporter':
                            installed.add('nodeexporter')
        except Exception as e:
            logger.error(f"Error getting running containers: {str(e)}")
        
        # Durchsuche auch docker-compose Dateien
        data_dirs = [
            '/home/webDock/docker-compose-data',
            os.path.expanduser('~/docker-compose-data'),
            '.',
            '..'
        ]
        
        for data_dir in data_dirs:
            if not os.path.exists(data_dir):
                continue
            
            # Prüfe die Hauptdatei
            compose_file = os.path.join(data_dir, 'docker-compose.yml')
            if os.path.exists(compose_file):
                try:
                    with open(compose_file) as f:
                        compose_data = yaml.safe_load(f)
                        if compose_data and 'services' in compose_data:
                            for service_name in compose_data['services'].keys():
                                if service_name in ['webdock-ui', 'bangertech-ui']:
                                    installed.add('webdock-ui')  # Normalisiere auf webdock-ui
                                else:
                                    installed.add(service_name)
                except Exception as e:
                    logger.error(f"Error reading {compose_file}: {str(e)}")
            
            # Prüfe Unterverzeichnisse
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
        
        logger.info(f"Final installed containers: {installed}")
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
        compose_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'docker-compose-files')
        if not os.path.exists(compose_dir):
            compose_dir = '/app/docker-compose-files'
        
        logger.info(f"Loading containers from {compose_dir}")
        
        # Architektur-spezifische Container-Filterung
        arm_only_containers = ['filebrowser', 'influxdb-arm', 'watchyourlanarm']
        x86_only_containers = ['filestash', 'influxdb-x86', 'watchyourlan']
        
        # Lade installierte Container
        installed_containers = get_installed_containers()
        logger.info(f"Installed containers: {installed_containers}")
        
        # Lade laufende Container
        running_containers = get_running_containers()
        
        # Lade Kategorien
        categories = load_categories().get('categories', {})
        
        # Gruppiere Container nach Kategorien
        grouped_containers = {}
        
        for category_id, category_data in categories.items():
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
                
            # Überspringe nicht-kompatible Container basierend auf der Architektur
            if SYSTEM_INFO['is_arm'] and dirname in x86_only_containers:
                logger.info(f"Skipping x86-only container {dirname} on ARM architecture")
                continue
            if not SYSTEM_INFO['is_arm'] and dirname in arm_only_containers:
                logger.info(f"Skipping ARM-only container {dirname} on x86 architecture")
                continue
                
            compose_file = os.path.join(compose_dir, dirname, 'docker-compose.yml')
            if not os.path.exists(compose_file):
                continue
                
            # Bestimme die Kategorie des Containers
            category = _get_container_group(dirname)
            category_name = categories.get(category, {}).get('name', 'Other')
            
            # Lade den Status des Containers
            is_installed = dirname in installed_containers
            status = "stopped"
            if dirname in running_containers:
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
                    port = '3004'
                elif dirname == 'scrypted':
                    port = '10443'
                else:
                    with open(compose_file, 'r') as f:
                        compose_data = yaml.safe_load(f)
                        if compose_data and 'services' in compose_data:
                            for service_name, service_data in compose_data['services'].items():
                                if 'ports' in service_data:
                                    port = _extract_port(service_data['ports'])
                                    break
            except Exception as e:
                logger.warning(f"Could not extract port for {dirname}: {e}")
            
            # Prüfe auf Updates
            has_update = check_for_updates(dirname) if status == "running" else False
            
            # Füge Container zur Gruppe hinzu
            if category_name in grouped_containers:
                grouped_containers[category_name]['containers'].append({
                    'name': dirname,
                    'status': status,
                    'installed': is_installed,
                    'description': f'Container: {dirname}',
                    'port': port,
                    'has_update': has_update,
                    'icon': get_container_icon(dirname)  # Verwende die neue Funktion
                })
        
        return jsonify(grouped_containers)
    except Exception as e:
        logger.exception(f"Error getting containers: {e}")
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
        
        # Debug-Logging für Mosquitto
        if container_name == 'mosquitto-broker':
            logger.info("=== Mosquitto Installation Debug ===")
            logger.info(f"Full request data: {data}")
            logger.info(f"Mosquitto config: {data.get('mosquitto', {})}")
            logger.info(f"Auth enabled: {data.get('mosquitto', {}).get('auth_enabled')}")
            logger.info(f"Username: {data.get('mosquitto', {}).get('username')}")
            logger.info(f"Password: {'*' * len(data.get('mosquitto', {}).get('password', ''))}")
        
        # Verwende den korrekten Pfad für die Installation
        install_path = os.path.join(COMPOSE_DATA_DIR, container_name)
        logger.info(f"Installing container {container_name} to {install_path}")
        
        # Erstelle Basis-Verzeichnisse
        os.makedirs(install_path, exist_ok=True)
        logger.info(f"Created directory: {install_path}")
        
        # Spezielle Behandlung für verschiedene Container
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
            # Für Filestash überspringen wir das Kopieren der docker-compose.yml
            # und verwenden stattdessen die in setup_filestash erstellte Datei
            success = setup_filestash(container_name, install_path, data)
            if not success:
                raise Exception("Failed to setup Filestash")
            
            # Überspringe das Kopieren und Starten für Filestash, da es bereits in setup_filestash erledigt wird
            return jsonify({
                'status': 'success',
                'message': f'Container {container_name} installed successfully'
            })
        else:
            # Standard-Verzeichnisse für andere Container
            config_dir = os.path.join(install_path, 'config')
            data_dir = os.path.join(install_path, 'data')
            log_dir = os.path.join(install_path, 'log')
            
            for directory in [config_dir, data_dir, log_dir]:
                os.makedirs(directory, exist_ok=True)
                os.chmod(directory, 0o755)
                logger.info(f"Created and configured directory: {directory}")

        # Kopiere und aktualisiere docker-compose.yml
        template_path = os.path.join(COMPOSE_FILES_DIR, container_name, 'docker-compose.yml')
        target_compose = os.path.join(install_path, 'docker-compose.yml')
        
        # Überspringe das Kopieren für Filestash, da es ein spezielles Setup hat
        if container_name != 'filestash' or not os.path.exists(target_compose):
            logger.info(f"Copying compose file from {template_path} to {target_compose}")
            
            with open(template_path, 'r') as src:
                compose_content = src.read()
            
            # Aktualisiere Compose-Datei
            compose_content = update_compose_file(compose_content, data)
            
            with open(target_compose, 'w') as f:
                f.write(compose_content)
            
            os.chmod(target_compose, 0o644)
            logger.info(f"Created compose file: {target_compose}")

        # Starte den Container
        try:
            # Überspringe das Starten für Filestash, da es ein spezielles Setup hat
            if container_name != 'filestash':
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
                    raise Exception(f"Failed to start container: {result.stderr}")
                
                logger.info(f"Started container: {container_name}")
            else:
                logger.info(f"Skipping automatic start for Filestash - manual setup required")
        except Exception as e:
            logger.error(f"Error starting container: {str(e)}")
            raise Exception(f"Failed to start container: {str(e)}")
        
        return jsonify({
            'status': 'success',
            'message': f'Container {container_name} installed successfully'
        })
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
        
        if is_running:
            # Stoppe Container
            subprocess.run(f'{docker_compose_cmd} -f /home/webDock/docker-compose-data/{container_name}/docker-compose.yml down',
                         shell=True, check=True)
            message = f"Container {container_name} stopped"
        else:
            # Starte Container
            subprocess.run(f'{docker_compose_cmd} -f /home/webDock/docker-compose-data/{container_name}/docker-compose.yml up -d',
                         shell=True, check=True)
            message = f"Container {container_name} started"
        
        return jsonify({
            'status': 'success',
            'message': message
        })
    except Exception as e:
        logger.exception(f"Error toggling container {container_name}")
        return jsonify({
            'status': 'error',
            'message': str(e)
        }), 500

@app.route('/api/update/<container_name>', methods=['POST'])
def update_container(container_name):
    try:
        # Führe Pull und Neustart durch
        compose_file = f'/home/webDock/docker-compose-data/{container_name}/docker-compose.yml'
        
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
        
        for line in result.stdout.splitlines():
            try:
                container_id, name, status = line.split('\t')
                
                # Basis-Container-Informationen
                container_info = {
                    'id': container_id[:12],
                    'name': name,
                    'status': status.lower(),
                    'health': 'unknown'
                }
                
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
        
        # 1. Hole Docker Container Logs
        cmd = ["docker", "logs", "--tail", "50", "webdock-ui"]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                try:
                    # Versuche das Standard-Log-Format zu parsen
                    if " - " in line:
                        parts = line.split(" - ", 3)
                        if len(parts) >= 3:
                            timestamp_str = parts[0].strip()
                            try:
                                timestamp = datetime.strptime(timestamp_str, '%Y-%m-%d %H:%M:%S,%f')
                                timestamp_iso = timestamp.isoformat()
                            except ValueError:
                                timestamp_iso = None
                            
                            logs.append({
                                'timestamp': timestamp_iso,
                                'level': parts[2].strip(),
                                'message': parts[3].strip() if len(parts) > 3 else parts[-1].strip(),
                                'source': 'webdock-ui'
                            })
                    else:
                        # Fallback für nicht-standardisierte Log-Zeilen
                        logs.append({
                            'timestamp': datetime.now().isoformat(),
                            'level': 'INFO',
                            'message': line.strip(),
                            'source': 'webdock-ui'
                        })
                except Exception as e:
                    logger.error(f"Error parsing log line: {e}")
                    continue

        # 2. Hole Docker Events (Container-Status-Änderungen)
        cmd = ["docker", "events", "--since", "30m", "--until", "now", "--format", 
               "{{.Time}} - {{.Type}} - {{.Action}} - {{.Actor.Attributes.name}}"]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                try:
                    parts = line.split(" - ")
                    if len(parts) >= 4:
                        timestamp = int(parts[0])
                        event_type = parts[1]
                        action = parts[2]
                        container = parts[3]
                        
                        logs.append({
                            'timestamp': datetime.fromtimestamp(timestamp).isoformat(),
                            'level': 'EVENT',
                            'message': f"{event_type}: {action} - Container: {container}",
                            'source': 'docker'
                        })
                except Exception as e:
                    logger.error(f"Error parsing event: {e}")
                    continue

        # 3. Hole aktuelle Container-Status
        cmd = ["docker", "ps", "-a", "--format", "{{.Names}}\t{{.Status}}\t{{.State}}"]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                try:
                    name, status, state = line.split('\t')
                    logs.append({
                        'timestamp': datetime.now().isoformat(),
                        'level': 'STATUS',
                        'message': f"Container {name}: {status} ({state})",
                        'source': 'docker'
                    })
                except Exception as e:
                    logger.error(f"Error parsing status: {e}")
                    continue

        # Sortiere alle Logs nach Timestamp
        logs.sort(key=lambda x: x['timestamp'] if x['timestamp'] else '', reverse=True)
        return jsonify(logs[:100])  # Limitiere auf die letzten 100 Einträge
        
    except Exception as e:
        logger.error(f"Error reading logs: {str(e)}")
        return jsonify([{
            'timestamp': datetime.now().isoformat(),
            'level': 'ERROR',
            'message': f"Error reading logs: {str(e)}",
            'source': 'system'
        }])

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
    config_file = '/app/config.json'
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
                        'location': config.get('data_location', '/home/webDock/docker-compose-data')
                    })
            except FileNotFoundError:
                return jsonify({
                    'location': '/home/webDock/docker-compose-data'
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
        
        # Lade die docker-compose Files beim Start
        logger.info("Downloading compose files on startup...")
        download_compose_files()
        
        # Lade oder erstelle Kategorien
        categories = load_categories()
        logger.info(f"Loaded categories: {categories}")
        
        return True
    except Exception as e:
        logger.error(f"Error initializing app: {e}")
        return False

def get_container_config(container_name):
    """Liest die Konfiguration eines Containers aus seiner docker-compose.yml"""
    try:
        compose_path = f'/app/docker-compose-files/{container_name}/docker-compose.yml'
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
        
        # Bestimme den Pfad zur docker-compose.yml
        if template:
            # Verwende die Template-Datei aus dem docker-compose-files Verzeichnis
            compose_file = os.path.join(COMPOSE_FILES_DIR, container_name, 'docker-compose.yml')
        else:
            # Verwende die installierte Datei aus dem docker-compose-data Verzeichnis
            compose_file = os.path.join(COMPOSE_DATA_DIR, container_name, 'docker-compose.yml')
        
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

@app.route('/api/container/<container_name>/restart', methods=['POST'])
def restart_container(container_name):
    try:
        compose_file = f'/home/webDock/docker-compose-data/{container_name}/docker-compose.yml'
        
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
        # Prüfe, ob der Container installiert ist
        install_path = os.path.join(COMPOSE_DATA_DIR, container_name)
        if not os.path.exists(install_path):
            return jsonify({'error': 'Container not installed'}), 404
        
        # Hole Container-Status
        status = "stopped"
        running_containers = get_running_containers()
        if container_name in running_containers:
            status = "running"
        
        # Hole Container-Informationen mit Docker
        container_info = {}
        compose_data = None
        
        # Hole Compose-Datei
        compose_file = os.path.join(install_path, 'docker-compose.yml')
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
        if compose_data and 'services' in compose_data:
            service_name = list(compose_data['services'].keys())[0]
            service = compose_data['services'][service_name]
            if 'ports' in service:
                for port_mapping in service['ports']:
                    if isinstance(port_mapping, str) and ':' in port_mapping:
                        host_port, container_port = port_mapping.split(':')
                        ports[container_port] = host_port
        
        if status == "running":
            try:
                # Suche nach möglichen Container-Namen
                possible_names = [
                    container_name,
                    f"{container_name}-1",
                    f"{container_name}_1",
                    f"{os.path.basename(install_path)}_{container_name}_1"
                ]
                
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
                    if any(possible_name in name for possible_name in possible_names):
                        container_id = id
                        break
                
                if not container_id:
                    # Versuche es mit einem allgemeineren Filter
                    result = subprocess.run(
                        ['docker', 'ps', '--filter', f"name={container_name}", '--format', '{{.ID}}'],
                        capture_output=True, text=True, check=True
                    )
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
                            port_mappings = {f"{port}/tcp": host_port for port, host_port in ports.items()}
                        
                        # Extrahiere Volumes
                        volumes = []
                        for mount in container_data.get('Mounts', []):
                            volumes.append({
                                'source': mount.get('Source', ''),
                                'destination': mount.get('Destination', ''),
                                'type': mount.get('Type', '')
                            })
                        
                        container_info = {
                            'id': container_data.get('Id', '')[:12],
                            'name': container_data.get('Name', '').lstrip('/'),
                            'image': container_data.get('Config', {}).get('Image', ''),
                            'created': container_data.get('Created', ''),
                            'status': container_data.get('State', {}).get('Status', ''),
                            'ports': port_mappings,
                            'volumes': volumes,
                            'network': list(container_data.get('NetworkSettings', {}).get('Networks', {}).keys())[0] if container_data.get('NetworkSettings', {}).get('Networks', {}) else None
                        }
            except Exception as e:
                logger.error(f"Error getting container details: {str(e)}")
                # Fallback: Verwende Informationen aus der Compose-Datei
                if compose_data and 'services' in compose_data:
                    service_name = list(compose_data['services'].keys())[0]
                    service = compose_data['services'][service_name]
                    
                    container_info = {
                        'name': container_name,
                        'image': service.get('image', ''),
                        'ports': ports,
                        'volumes': [{'source': v.split(':')[0], 'destination': v.split(':')[1]} for v in service.get('volumes', []) if ':' in v],
                        'status': status
                    }
        
        # Wenn der Container nicht läuft, verwende Informationen aus der Compose-Datei
        if not container_info and compose_data and 'services' in compose_data:
            service_name = list(compose_data['services'].keys())[0]
            service = compose_data['services'][service_name]
            
            container_info = {
                'name': container_name,
                'image': service.get('image', ''),
                'ports': ports,
                'volumes': [{'source': v.split(':')[0], 'destination': v.split(':')[1]} for v in service.get('volumes', []) if ':' in v],
                'status': status
            }
        
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
    compose_dir = '/home/webDock/docker-compose-files'
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
        cmd = ["docker", "ps", "-a", "--format", "{{.Names}}\t{{.State}}"]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        
        status_dict = {}
        for line in result.stdout.strip().split('\n'):
            if line:
                name, state = line.split('\t')
                status_dict[name] = state
        
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
        with open(config_path, "w") as f:
            f.write("""
# Default listener
listener 1883

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
        
        return True
    except Exception as e:
        logger.error(f"Mosquitto setup failed: {str(e)}")
        return False

def setup_grafana(container_name, install_path, config_data=None):
    """Setup für Grafana"""
    try:
        # Erstelle Verzeichnisse
        data_dir = os.path.join(install_path, 'data')
        os.makedirs(data_dir, exist_ok=True, mode=0o755)
        
        # Erstelle env.grafana Datei
        env_file = os.path.join(data_dir, 'env.grafana')
        with open(env_file, 'w') as f:
            f.write("""GF_SECURITY_ADMIN_USER=admin
GF_SECURITY_ADMIN_PASSWORD=admin
GF_USERS_ALLOW_SIGN_UP=false
GF_INSTALL_PLUGINS=grafana-clock-panel,grafana-simple-json-datasource,grafana-worldmap-panel,grafana-piechart-panel
""")
        
        # Setze Berechtigungen
        os.chmod(env_file, 0o644)
        
        logger.info(f"Created Grafana environment file: {env_file}")
        
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
        
        # Erstelle Skript zur Datenbankerstellung, wenn gewünscht
        if create_database:
            script_path = os.path.join(install_path, 'create_database.sh')
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
        
        # Standardwerte
        stacks_dir = "/home/webDock/docker-compose-data"
        
        # Prüfe, ob ein benutzerdefiniertes Stacks-Verzeichnis angegeben wurde
        if config_data and 'dockge' in config_data:
            dockge_config = config_data.get('dockge', {})
            stacks_dir = dockge_config.get('stacks_dir', stacks_dir)
        
        # Aktualisiere die docker-compose.yml mit dem Stacks-Verzeichnis
        compose_file = os.path.join(install_path, 'docker-compose.yml')
        if os.path.exists(compose_file):
            with open(compose_file, 'r') as f:
                compose_content = f.read()
            
            # Parse YAML
            compose_data = yaml.safe_load(compose_content)
            if not compose_data:
                logger.error("Empty or invalid docker-compose.yml")
                return False
                
            # Hole den ersten Service-Namen
            if 'services' not in compose_data:
                logger.error("No services found in docker-compose.yml")
                return False
                
            service_name = list(compose_data['services'].keys())[0]
            service = compose_data['services'][service_name]
            
            # Füge Volumes hinzu
            volumes = service.get('volumes', [])
            if not volumes:
                volumes = []
                
            # Füge das Stacks-Verzeichnis als Volume hinzu
            stack_volume = f"{stacks_dir}:{stacks_dir}"
            if stack_volume not in volumes:
                volumes.append(stack_volume)
            
            # Füge docker.sock als Volume hinzu
            docker_sock_volume = "/var/run/docker.sock:/var/run/docker.sock"
            if docker_sock_volume not in volumes:
                volumes.append(docker_sock_volume)
            
            service['volumes'] = volumes
            
            # Füge Umgebungsvariablen hinzu
            env = service.get('environment', {})
            if env is None:
                env = {}
                
            # Stelle sicher, dass environment ein Dictionary ist
            if isinstance(env, list):
                env_dict = {}
                for item in env:
                    if '=' in item:
                        key, value = item.split('=', 1)
                        env_dict[key] = value
                env = env_dict
                
            # Füge die Stacks-Verzeichnis-Variable hinzu
            env['DOCKGE_STACKS_DIR'] = stacks_dir
            
            service['environment'] = env
            
            # Schreibe die aktualisierte docker-compose.yml zurück
            with open(compose_file, 'w') as f:
                yaml.dump(compose_data, f, default_flow_style=False)
            
            logger.info(f"Updated Dockge docker-compose.yml with stacks directory: {stacks_dir}")
        
        return True
    except Exception as e:
        logger.error(f"Dockge setup failed: {str(e)}")
        return False

def setup_filestash(container_name, install_path, config_data=None):
    """Setup für Filestash"""
    try:
        # Erstelle Verzeichnisse
        data_dir = os.path.join(install_path, 'data')
        os.makedirs(data_dir, exist_ok=True, mode=0o755)
        
        # Erstelle die docker-compose.yml
        compose_file = os.path.join(install_path, 'docker-compose.yml')
        with open(compose_file, 'w') as f:
            f.write("""version: '3'
services:
  app:
    container_name: filestash
    image: machines/filestash
    restart: always
    environment:
      - APPLICATION_URL=
    ports:
      - "8334:8334"
    volumes:
      - ./data:/app/data/state
""")
        
        # Starte den Container
        docker_compose_cmd = get_docker_compose_cmd()
        result = subprocess.run(
            f'{docker_compose_cmd} up -d',
            shell=True,
            capture_output=True,
            text=True,
            cwd=install_path
        )
        
        if result.returncode != 0:
            logger.error(f"Error starting Filestash container: {result.stderr}")
            raise Exception(f"Failed to start Filestash container: {result.stderr}")
        
        logger.info(f"Started Filestash container")
        
        return True
    except Exception as e:
        logger.error(f"Filestash setup failed: {str(e)}")
        return False

def setup_watchyourlan(container_name, install_path, config_data):
    """Setup für WatchYourLAN"""
    try:
        # Hole Netzwerkschnittstelle und IP-Adresse aus den Konfigurationsdaten
        if not config_data or 'watchyourlan' not in config_data:
            logger.error("WatchYourLAN configuration data missing")
            return False
            
        watchyourlan_config = config_data.get('watchyourlan', {})
        interface = watchyourlan_config.get('interface')
        ip_address = watchyourlan_config.get('ip_address')
        
        if not interface or not ip_address:
            logger.error(f"Network interface or IP address not specified: interface={interface}, ip_address={ip_address}")
            # Versuche Standardwerte zu verwenden
            interface = interface or 'eth0'
            ip_address = ip_address or socket.gethostbyname(socket.gethostname())
            logger.info(f"Using default values: interface={interface}, ip_address={ip_address}")
        
        # Aktualisiere docker-compose.yml
        compose_file = os.path.join(install_path, 'docker-compose.yml')
        if not os.path.exists(compose_file):
            logger.error(f"Compose file not found: {compose_file}")
            return False
            
        with open(compose_file, 'r') as f:
            compose_content = f.read()
            
        # Parse YAML
        compose_data = yaml.safe_load(compose_content)
        if not compose_data:
            logger.error("Empty or invalid docker-compose.yml")
            return False
            
        # Hole den ersten Service-Namen
        if 'services' not in compose_data:
            logger.error("No services found in docker-compose.yml")
            return False
            
        # Für WatchYourLAN ist der Service-Name normalerweise 'app'
        service_name = 'app'
        if service_name not in compose_data['services']:
            service_name = list(compose_data['services'].keys())[0]
            
        service = compose_data['services'][service_name]
        
        # Füge Command hinzu
        service['command'] = f'-n http://{ip_address}:8850'
        
        # Füge Umgebungsvariablen hinzu
        environment = service.get('environment', {})
        if environment is None:
            environment = {}
            
        # Konvertiere zu Dictionary, wenn es eine Liste ist
        if isinstance(environment, list):
            env_dict = {}
            for env in environment:
                if isinstance(env, str) and '=' in env:
                    key, value = env.split('=', 1)
                    env_dict[key] = value
            environment = env_dict
            
        # Setze die Umgebungsvariablen
        environment['IFACE'] = interface
        environment['GUIIP'] = ip_address
        
        # Aktualisiere die Umgebungsvariablen im Service
        service['environment'] = environment
        
        # Speichere aktualisierte Konfiguration
        with open(compose_file, 'w') as f:
            yaml.dump(compose_data, f, default_flow_style=False)
            
        logger.info(f"Updated WatchYourLAN configuration: interface={interface}, ip_address={ip_address}")
        
        return True
    except Exception as e:
        logger.exception(f"WatchYourLAN setup failed: {str(e)}")
        return False

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
        'backuppro': 'backuppro'
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
        install_path = os.path.join(CONFIG_DIR, 'compose-files', service_name)
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
        
        # Erstelle prometheus.yml
        prometheus_yml = os.path.join(prometheus_dir, 'prometheus.yml')
        with open(prometheus_yml, 'w') as f:
            f.write("""# my global config
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
      - targets: ["node_exporter:9100"]
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
        
        return True
    except Exception as e:
        logger.error(f"Prometheus setup failed: {str(e)}")
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