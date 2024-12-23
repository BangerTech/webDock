from flask import Flask, jsonify, render_template, send_from_directory, abort, request
import os
import logging
import yaml
import subprocess
import json
import time
import psutil
import datetime

# Konfiguriere Logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

app = Flask(__name__, 
    static_url_path='/static',
    static_folder='static',
    template_folder='templates'
)
app.debug = True

def _extract_port(ports):
    if not ports:
        return None
    # Extrahiere den ersten Port aus der Port-Liste
    port = str(ports[0])
    if ':' in port:
        return int(port.split(':')[0])
    return int(port)

def load_categories():
    try:
        with open('/app/categories.yaml', 'r') as f:
            return yaml.safe_load(f)
    except Exception as e:
        logger.error(f"Error loading categories: {str(e)}")
        # Erstelle Standard-Kategorien wenn die Datei nicht existiert
        default_categories = {
            'categories': {
                'smart_home': {
                    'name': 'Smart Home',
                    'icon': 'fa-home',
                    'description': 'Home automation and IoT containers',
                    'containers': []
                },
                'monitoring': {
                    'name': 'Monitoring',
                    'icon': 'fa-chart-line',
                    'description': 'System and network monitoring tools',
                    'containers': []
                }
            }
        }
        # Speichere die Standard-Kategorien
        try:
            with open('/app/categories.yaml', 'w') as f:
                yaml.dump(default_categories, f)
            return default_categories
        except Exception as write_error:
            logger.error(f"Error creating default categories: {str(write_error)}")
            return {'categories': {}}

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
        
        logger.info(f"Container status in {project_name}: {containers}")
        return containers
    except Exception as e:
        logger.error(f"Error getting container status for {project_name}: {str(e)}")
        return []

def setup_container_environment(container_name, root_dir):
    """Bereitet die Umgebung für einen Container vor"""
    try:
        base_dir = '/home/The-BangerTECH-Utility-main/docker-compose-data'
        logger.info(f"Setting up environment for {container_name} in {base_dir}")
        
        # Container-spezifische Setups
        if container_name == 'mosquitto':
            # Setup für Mosquitto Broker
            mosquitto_dir = f"{base_dir}/mosquitto"
            config_dir = f"{mosquitto_dir}/config"
            data_dir = f"{mosquitto_dir}/data"
            log_dir = f"{mosquitto_dir}/log"
            
            # Erstelle alle benötigten Verzeichnisse
            for dir_path in [config_dir, data_dir, log_dir]:
                os.makedirs(dir_path, exist_ok=True, mode=0o755)
            
            # Kopiere die Konfigurationsdatei
            src_config = '/app/docker-compose-files/mosquitto-broker/mosquitto.conf'
            dst_config = os.path.join(config_dir, 'mosquitto.conf')
            
            with open(src_config, 'rb') as src, open(dst_config, 'wb') as dst:
                dst.write(src.read())
            
            # Setze Berechtigungen für die Konfigurationsdatei
            os.chmod(dst_config, 0o644)
            
        elif container_name == 'filestash':
            # Setup für Filestash
            os.makedirs(f"{base_dir}/filestash/data", exist_ok=True, mode=0o755)
            
        elif container_name == 'grafana':
            # Setup für Grafana
            grafana_dir = f"{base_dir}/grafana"
            data_dir = f"{grafana_dir}/data"
            
            # Erstelle Verzeichnisse
            os.makedirs(data_dir, exist_ok=True, mode=0o755)
            
            # Kopiere env.grafana
            src_env = os.path.join(root_dir, 'env.grafana')
            dst_env = os.path.join(data_dir, 'env.grafana')
            try:
                with open(src_env, 'rb') as src, open(dst_env, 'wb') as dst:
                    dst.write(src.read())
                os.chmod(dst_env, 0o644)
            except Exception as e:
                logger.error(f"Failed to copy env.grafana: {str(e)}")
                return False
        
        elif container_name == 'influxdb':
            # Setup für InfluxDB
            os.makedirs(f"{base_dir}/influxdb", exist_ok=True, mode=0o755)
            
        elif container_name == 'prometheus':
            # Setup für Prometheus
            os.makedirs(f"{base_dir}/prometheus/prometheus", exist_ok=True, mode=0o755)
            for file in ['prometheus.yml', 'alert.yml']:
                src_file = os.path.join(root_dir, file)
                dst_file = f"{base_dir}/prometheus/prometheus/{file}"
                with open(src_file, 'rb') as src, open(dst_file, 'wb') as dst:
                    dst.write(src.read())
        
        elif container_name == 'whatsupdocker':
            # Setup für WUD
            os.makedirs(f"{base_dir}/whatsupdocker", exist_ok=True, mode=0o755)
        
        elif container_name == 'homeassistant':
            # Setup für Home Assistant
            os.makedirs(f"{base_dir}/homeassistant", exist_ok=True, mode=0o755)
        
        elif container_name == 'openhab':
            # Setup für openHAB
            os.makedirs(f"{base_dir}/openhab", exist_ok=True, mode=0o755)
        
        elif container_name == 'frontail':
            # Setup für Frontail
            os.makedirs(f"{base_dir}/frontail", exist_ok=True, mode=0o755)
        
        elif container_name == 'heimdall':
            # Setup für Heimdall
            os.makedirs(f"{base_dir}/heimdall", exist_ok=True, mode=0o755)
        
        elif container_name == 'portainer':
            # Setup für Portainer
            os.makedirs(f"{base_dir}/portainer", exist_ok=True, mode=0o755)
        
        elif container_name == 'raspberrymatic':
            # Setup für RaspberryMatic
            os.makedirs(f"{base_dir}/raspberrymatic", exist_ok=True, mode=0o755)
        
        elif container_name == 'codeserver':
            # Setup für Code Server
            os.makedirs(f"{base_dir}/codeserver", exist_ok=True, mode=0o755)
        
        elif container_name == 'node_exporter':
            # Setup für Node Exporter
            os.makedirs(f"{base_dir}/node_exporter", exist_ok=True, mode=0o755)
        
        elif container_name == 'watchyourlan':
            # Setup für WatchYourLAN
            os.makedirs(f"{base_dir}/watchyourlan", exist_ok=True, mode=0o755)
        
        # Setze Berechtigungen
        for root, dirs, files in os.walk(base_dir):
            for d in dirs:
                os.chmod(os.path.join(root, d), 0o755)
            for f in files:
                os.chmod(os.path.join(root, f), 0o644)
        
        logger.info(f"Successfully set up environment for {container_name}")
        return True
    except Exception as e:
        logger.exception(f"Error setting up environment for {container_name}")
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
        # Hole alle Container (auch gestoppte)
        result = subprocess.run(
            ['docker', 'ps', '-a', '--format', '{{.Names}}'],
            capture_output=True,
            text=True
        )
        if result.returncode == 0:
            return set(result.stdout.strip().split('\n')) if result.stdout.strip() else set()
        return set()
    except Exception as e:
        logger.error(f"Error getting installed containers: {str(e)}")
        return set()

def get_running_containers():
    """Überprüft welche Container laufen"""
    try:
        result = subprocess.run(
            ['docker', 'ps', '--format', '{{.Names}}'],
            capture_output=True,
            text=True
        )
        if result.returncode == 0:
            return set(result.stdout.strip().split('\n')) if result.stdout.strip() else set()
        return set()
    except Exception as e:
        logger.error(f"Error getting running containers: {str(e)}")
        return set()

@app.route('/api/containers')
def get_containers():
    try:
        compose_dir = '/app/docker-compose-files'
        containers = []
        processed_services = set()
        
        # Hole aktuelle Container-Status
        installed_containers = get_installed_containers()
        running_containers = get_running_containers()
        
        for root, dirs, files in os.walk(compose_dir):
            if 'docker-compose.yml' in files:
                try:
                    with open(os.path.join(root, 'docker-compose.yml')) as f:
                        compose_data = yaml.safe_load(f)
                        if not compose_data or 'services' not in compose_data:
                            continue
                            
                        group_name = os.path.basename(root)
                        
                        for service_name, service_data in compose_data['services'].items():
                            if service_name in processed_services:
                                continue
                                
                            processed_services.add(service_name)
                            
                            # Prüfe verschiedene mögliche Container-Namen
                            container_names = [
                                service_name,
                                f"{os.path.basename(root)}-{service_name}-1",
                                f"{os.path.basename(root)}_{service_name}_1",
                                f"{service_name}-1",
                                f"{service_name}_1"
                            ]
                            
                            # Container-Status ermitteln
                            is_installed = any(name in installed_containers for name in container_names)
                            is_running = any(name in running_containers for name in container_names)
                            
                            status = 'running' if is_running else 'stopped' if is_installed else 'not_installed'
                            
                            container = {
                                'name': service_name,
                                'status': status,
                                'installed': is_installed,
                                'port': _extract_port(service_data.get('ports', [])),
                                'description': service_data.get('labels', {}).get('description', ''),
                                'group': _get_container_group(group_name),
                                'icon': _get_group_icon(group_name)
                            }
                            
                            containers.append(container)
                except Exception as e:
                    logger.error(f"Error reading {os.path.join(root, 'docker-compose.yml')}: {str(e)}")
        
        logger.info(f"\n=== Summary ===")
        logger.info(f"Total containers found: {len(containers)}")
        logger.info(f"Unique services: {len(processed_services)}")
        logger.info(f"Services: {sorted(list(processed_services))}")
        
        if not containers:
            logger.warning("No containers found in docker-compose-files directory")
        
        # Gruppiere Container
        grouped_containers = {}
        for container in containers:
            group = container['group']
            if group not in grouped_containers:
                grouped_containers[group] = {
                    'name': group,
                    'icon': container['icon'],
                    'containers': []
                }
            grouped_containers[group]['containers'].append(container)
        
        return jsonify(grouped_containers)
    except Exception as e:
        logger.exception("Error in get_containers")
        return {'error': str(e)}, 500

@app.route('/api/install', methods=['POST'])
def install_container():
    try:
        data = request.json
        container_name = data['name']
        install_path = data['path']
        port = data.get('port')
        env_vars = data.get('env', {})
        
        # Erstelle Installationsverzeichnis
        os.makedirs(install_path, exist_ok=True)
        
        # Kopiere docker-compose.yml
        compose_template = f'/app/docker-compose-files/{container_name}/docker-compose.yml'
        target_compose = os.path.join(install_path, 'docker-compose.yml')
        
        with open(compose_template, 'r') as src:
            compose_content = src.read()
            
        # Ersetze Pfade und Ports
        compose_content = compose_content.replace(
            '/home/The-BangerTECH-Utility-main/docker-compose-data',
            os.path.dirname(install_path)
        )
        
        if port:
            # Aktualisiere Port-Mapping
            compose_content = update_port_mapping(compose_content, port)
        
        # Aktualisiere Environment-Variablen
        if env_vars:
            compose_data = yaml.safe_load(compose_content)
            service_name = list(compose_data['services'].keys())[0]
            
            if 'environment' not in compose_data['services'][service_name]:
                compose_data['services'][service_name]['environment'] = {}
            
            # Füge neue Umgebungsvariablen hinzu oder aktualisiere bestehende
            if isinstance(compose_data['services'][service_name]['environment'], list):
                # Konvertiere Liste zu Dictionary
                env_dict = {}
                for env in compose_data['services'][service_name]['environment']:
                    if '=' in env:
                        key, value = env.split('=', 1)
                        env_dict[key] = value
                compose_data['services'][service_name]['environment'] = env_dict
            
            compose_data['services'][service_name]['environment'].update(env_vars)
            compose_content = yaml.dump(compose_data, default_flow_style=False)
        
        # Schreibe aktualisierte docker-compose.yml
        with open(target_compose, 'w') as dst:
            dst.write(compose_content)
        
        # Führe Container-spezifisches Setup aus
        setup_container_environment(container_name, install_path)
        
        # Starte Container
        subprocess.run(['docker', 'compose', 'up', '-d'], 
                     cwd=install_path, 
                     check=True)
        
        return jsonify({
            'status': 'success',
            'message': f'Container {container_name} installed successfully'
        })
        
    except Exception as e:
        logger.exception(f"Error installing container {container_name}")
        return jsonify({
            'status': 'error',
            'message': str(e)
        }), 500

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
        
        if is_running:
            # Stoppe Container
            subprocess.run(['docker', 'compose', '-f', f'/home/The-BangerTECH-Utility-main/docker-compose-data/{container_name}/docker-compose.yml', 'down'])
            message = f"Container {container_name} stopped"
        else:
            # Starte Container
            subprocess.run(['docker', 'compose', '-f', f'/home/The-BangerTECH-Utility-main/docker-compose-data/{container_name}/docker-compose.yml', 'up', '-d'])
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
        compose_file = f'/home/The-BangerTECH-Utility-main/docker-compose-data/{container_name}/docker-compose.yml'
        
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
        img_path = os.path.join(app.static_folder, 'img')
        logger.info(f"Serving image {filename} from {img_path}")
        logger.info(f"Directory contents: {os.listdir(img_path)}")
        logger.info(f"File exists: {os.path.exists(os.path.join(img_path, filename))}")
        
        return send_from_directory(os.path.join(app.static_folder, 'img'), filename)
    except Exception as e:
        logger.exception(f"Error serving image {filename}")
        return str(e), 404

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
    try:
        containers = []
        cmd = ["docker", "stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}\t{{.PIDs}}"]
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        if result.returncode == 0:
            for line in result.stdout.strip().split('\n'):
                if line:
                    name, cpu, mem, net, block, pids = line.split('\t')
                    
                    # Hole Container-Uptime
                    cmd_inspect = ["docker", "inspect", "--format", "{{.State.StartedAt}}", name]
                    inspect_result = subprocess.run(cmd_inspect, capture_output=True, text=True)
                    # Bereinige das Zeitformat
                    timestamp = inspect_result.stdout.strip()
                    timestamp = timestamp.split('.')[0]  # Entferne Nanosekunden
                    started_at = datetime.datetime.strptime(timestamp, '%Y-%m-%dT%H:%M:%S').replace(tzinfo=datetime.timezone.utc)
                    uptime = datetime.datetime.now(datetime.timezone.utc) - started_at
                    
                    containers.append({
                        'name': name,
                        'status': 'healthy',  # TODO: Implementiere Gesundheitsprüfung
                        'cpu': cpu,
                        'memory': mem,
                        'uptime': str(uptime).split('.')[0]  # Formatiere Uptime
                    })
        
        return jsonify(containers)
    except Exception as e:
        logger.exception("Error getting container health")
        return {'error': str(e)}, 500

@app.route('/api/system/logs')
def get_system_logs():
    try:
        # Hole die letzten Container-Logs
        cmd = ["docker", "compose", "logs", "--tail=50"]
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        logs = []
        if result.returncode == 0:
            # Verarbeite die Logs
            raw_logs = result.stdout.strip().split('\n')
            logs = [line for line in raw_logs if line.strip()]
            if not logs[0]:  # Wenn keine Logs vorhanden
                logs = ["No recent Docker events"]
        else:
            # Versuche alternative Log-Quelle
            cmd_alt = ["docker", "ps", "--format", "{{.Names}}\t{{.Status}}"]
            alt_result = subprocess.run(cmd_alt, capture_output=True, text=True)
            if alt_result.returncode == 0:
                status_logs = alt_result.stdout.strip().split('\n')
                logs = [f"Container Status: {line}" for line in status_logs if line.strip()]
        
        return jsonify({'logs': logs})
    except Exception as e:
        logger.exception("Error getting system logs")
        return {'error': str(e)}, 500

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
                        'location': config.get('data_location', '/home/The-BangerTECH-Utility-main/docker-compose-data')
                    })
            except FileNotFoundError:
                return jsonify({
                    'location': '/home/The-BangerTECH-Utility-main/docker-compose-data'
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
    """Initialisiere die Anwendung"""
    try:
        # Stelle sicher, dass die categories.yaml existiert
        if not os.path.exists('/app/categories.yaml'):
            load_categories()  # Dies erstellt die Standard-Kategorien
        
        logger.info("Application initialized successfully")
    except Exception as e:
        logger.error(f"Error initializing application: {str(e)}")

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

@app.route('/api/container/<container_name>/config', methods=['GET'])
def get_container_configuration(container_name):
    """API Endpoint für Container-Konfiguration"""
    try:
        config = get_container_config(container_name)
        if config is None:
            return jsonify({
                'status': 'error',
                'message': f'Configuration for {container_name} not found'
            }), 404
             
        return jsonify(config)
    except Exception as e:
        logger.exception(f"Error getting configuration for {container_name}")
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