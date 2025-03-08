async function installContainer(containerName) {
    try {
        if (!containerName) {
            throw new Error('Kein Container-Name angegeben');
        }
        console.log('DEBUG - installContainer called with:', containerName);
        console.log('DEBUG - containerName type:', typeof containerName);
        await showInstallModal(containerName);
    } catch (error) {
        console.error('Fehler beim Installieren des Containers:', error);
        alert(`Fehler beim Installieren des Containers ${containerName}: ${error.message}`);
    }
}

async function showInstallModal(container) {
    try {
        // Warten auf die Container-Konfiguration vom Server
        const response = await fetch(`/api/container/${container}/config?template=true`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const containerConfig = await response.json();
        
        if (!containerConfig) {
            console.error(`Keine Konfiguration gefunden für Container: ${container}`);
            return;
        }

        // Modal mit den Container-Einstellungen anzeigen
        const modal = document.getElementById('installModal');
        const modalContent = document.getElementById('installModalContent');
        
        // Konfigurationsfelder basierend auf containerConfig erstellen
        modalContent.innerHTML = `
            <h2>Installation: ${containerConfig.name || container}</h2>
            <div class="modal-content">
                ${container === 'mosquitto-broker' ? `
                    <div class="form-group">
                        <label for="auth_enabled">Authentifizierung aktivieren</label>
                        <input 
                            type="checkbox" 
                            id="auth_enabled" 
                            name="auth_enabled"
                            onchange="toggleAuthFields(this)"
                        >
                    </div>
                    <div class="auth-fields" style="display: none;">
                        <div class="form-group">
                            <label for="username">MQTT Benutzername</label>
                            <input 
                                type="text" 
                                id="username" 
                                name="username"
                                value="admin"
                            >
                        </div>
                        <div class="form-group">
                            <label for="password">MQTT Passwort</label>
                            <input 
                                type="password" 
                                id="password" 
                                name="password"
                                value="admin"
                            >
                        </div>
                    </div>
                ` : Object.entries(containerConfig.config)
                    .map(([key, field]) => `
                        <div class="form-group">
                            <label for="${key}">${field.label || key}</label>
                            <input 
                                type="${field.type}" 
                                id="${key}" 
                                name="${key}" 
                                value="${field.default || ''}"
                            >
                        </div>
                    `).join('')}
                <div class="modal-buttons">
                    <button onclick="executeInstall('${container}')">Installieren</button>
                    <button onclick="closeModal()">Abbrechen</button>
                </div>
            </div>
        `;
        
        modal.style.display = 'block';
    } catch (error) {
        console.error('Fehler beim Laden der Container-Konfiguration:', error);
        alert('Fehler beim Laden der Container-Konfiguration. Bitte versuchen Sie es später erneut.');
    }
}

// Hilfsfunktion zum Generieren der Konfigurationsfelder
function generateConfigFields(containerConfig, container) {
    if (!containerConfig.config) {
        return '';
    }

    return `
        <div class="modal-content">
            ${container === 'mosquitto-broker' ? `
                <div class="form-group">
                    <label for="auth_enabled">Authentifizierung aktivieren</label>
                    <input 
                        type="checkbox" 
                        id="auth_enabled" 
                        name="auth_enabled"
                    >
                </div>
                <div class="auth-fields">
                    <div class="form-group">
                        <label for="username">MQTT Benutzername</label>
                        <input 
                            type="text" 
                            id="username" 
                            name="username"
                            value="admin"
                        >
                    </div>
                    <div class="form-group">
                        <label for="password">MQTT Passwort</label>
                        <input 
                            type="password" 
                            id="password" 
                            name="password"
                            value="admin"
                        >
                    </div>
                </div>
            ` : Object.entries(containerConfig.config)
                .map(([key, field]) => `
                    <div class="form-group">
                        <label for="${key}">${field.label || key}</label>
                        <input 
                            type="${field.type}" 
                            id="${key}" 
                            name="${key}" 
                            value="${field.default || ''}"
                        >
                    </div>
                `).join('')}
            <div class="modal-buttons">
                <button onclick="executeInstall('${container}')">Installieren</button>
                <button onclick="closeModal()">Abbrechen</button>
            </div>
        </div>
        ${container === 'mosquitto-broker' ? `
            <script>
                document.getElementById('auth_enabled').addEventListener('change', function() {
                    document.querySelector('.auth-fields').style.display = 
                        this.checked ? 'block' : 'none';
                });
                // Initial verstecken
                document.querySelector('.auth-fields').style.display = 'none';
            </script>
        ` : ''}
    `;
}

async function executeInstall(container) {
    console.log('executeInstall called with container:', container);
    try {
        const modal = document.getElementById('installModal');
        
        // Basis-Konfiguration
        let config = {
            name: container,
            ports: {},
            env: {},
            volumes: []
        };

        // Container-spezifische Konfiguration
        if (container === 'mosquitto-broker') {
            config.path = '/app/config/compose-files/mosquitto-broker';
            config.ports = {'1883': '1883', '9001': '9001'};
            config.volumes = ['./config:/mosquitto/config', './data:/mosquitto/data', './log:/mosquitto/log'];
            config.mosquitto = {
                auth_enabled: modal.querySelector('#auth_enabled')?.checked || false,
                username: modal.querySelector('#username')?.value || '',
                password: modal.querySelector('#password')?.value || ''
            };
            
            // Debug-Logging für Mosquitto
            console.log('=== Mosquitto Installation Config ===');
            console.log('Auth enabled:', config.mosquitto.auth_enabled);
            console.log('Username:', config.mosquitto.username);
            console.log('Password:', config.mosquitto.password);
        } 
        else if (container === 'dockge') {
            config.path = '/app/config/compose-files/dockge';
            config.ports = {'5001': '5001'};
            config.volumes = ['./data:/app/data'];
            config.dockge = {
                stacks_dir: '/home/webDock/docker-compose-data'
            };
            
            // Debug-Logging für Dockge
            console.log('=== Dockge Installation Config ===');
            console.log('Stacks Directory:', config.dockge.stacks_dir);
        }
        else {
            // Generische Konfiguration für andere Container
            config.path = `/app/config/compose-files/${container}`;
        }

        // Debug-Logging
        console.log('=== Installation Data ===');
        console.log(JSON.stringify(config, null, 2));

        const response = await fetch('/api/install', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(config)
        });

        const responseData = await response.json();
        console.log('=== Installation Response ===');
        console.log(JSON.stringify(responseData, null, 2));

        if (!response.ok) {
            throw new Error(responseData.error || 'Installation failed');
        }

        closeModal();
        showNotification('success', 'Installation erfolgreich gestartet!');
    } catch (error) {
        console.error('Installation error:', error);
        showNotification('error', `Fehler bei der Installation: ${error.message}`);
    }
}

// Funktion zum Umschalten der Auth-Felder
function toggleAuthFields(checkbox) {
    const authFields = document.querySelector('.auth-fields');
    authFields.style.display = checkbox.checked ? 'block' : 'none';
} 