// Definiere globale Variablen
let loadingOverlay;

// Cache-Objekte für Kategorien und Container
let categoriesCache = null;
let containerCache = null;
let lastCategoriesFetch = 0;
let lastContainersFetch = 0;
const CACHE_TTL = 60000; // Cache-Gültigkeit in Millisekunden (1 Minute)

// WebSocket-Verbindung für Echtzeit-Container-Updates
let containerSocket = null;

// Globale Timer-Variable für Container-Status-Updates (Fallback, wenn WebSockets nicht funktionieren)
let containerStatusTimer = null;

// Behalte die Scroll-Position
let lastScrollPosition = 0;
let lastContainerStates = new Map();

// Funktion, um Beschreibungen für Container zu erhalten
function getContainerDescription(containerName) {
    const descriptions = {
        'prometheus': 'Monitoring and alerting toolkit for metrics collection and visualization.',
        'node-exporter': 'Prometheus exporter for hardware and OS metrics with pluggable metric collectors.',
        'grafana': 'Platform for monitoring and observability with powerful visualization tools.',
        'influxdb': 'Time series database designed to handle high write and query loads.',
        'mosquitto': 'Lightweight message broker implementing the MQTT protocol.',
        'mosquitto-broker': 'Lightweight message broker implementing the MQTT protocol.',
        'portainer': 'Container management platform for Docker environments.',
        'dockge': 'Modern, easy-to-use, and responsive self-hosted docker compose.yaml stack-oriented manager.',
        'filebrowser': 'Web-based file manager with a clean interface.',
        'filestash': 'Modern web client for SFTP, S3, FTP, WebDAV, Git, and more.',
        'homepage': 'A highly customizable homepage for your server with service monitoring.',
        'hoarder': 'Media server and content management system for your digital collections.',
        'wud': 'Watch your Docker containers and update them when new images are available.',
        'watchyourlan': 'Tool to monitor your local network and alert on new devices.',
        'webdock': 'Docker container management interface with a clean and simple UI.',
        // Füge hier weitere Container-Beschreibungen hinzu
    };
    
    return descriptions[containerName] || 'Docker container management.';
}

// Globale closeModal Funktion
function closeModal(containerName = null) { 
    // Suche nach allen modalen Dialogen
    const modals = document.querySelectorAll('.modal');
    
    // Finde alle Install-Buttons, die deaktiviert sind, aber nicht laden
    const pendingButtons = document.querySelectorAll('.install-btn[disabled]:not(.loading)');
    pendingButtons.forEach(button => {
        button.disabled = false;
        // Setze auf den ursprünglichen Text zurück, oder auf 'Install' als Fallback
        button.innerHTML = button.originalHTML || 'Install';
    });
    
    // Schließe alle gefundenen Modals
    modals.forEach(modal => {
        // Entferne die 'show' Klasse für die Animation
        modal.classList.remove('show');
        
        // Entferne das Modal nach der Animation
        setTimeout(() => {
            // Prüfe, ob das Modal noch im DOM ist
            if (modal.parentNode) {
                modal.parentNode.removeChild(modal);
            }
        }, 300);
    });
    
    // Wenn ein Container-Name angegeben wurde, setze dessen Install-Button zurück
    if (containerName) {
        // Versuche zuerst mit data-container
        let mainButton = document.querySelector(`[data-container="${containerName}"] .install-btn`);
        
        // Wenn nichts gefunden, versuche mit der Container-Karte über data-name
        if (!mainButton) {
            const containerCard = document.querySelector(`.container-card[data-name="${containerName}"]`);
            if (containerCard) {
                mainButton = containerCard.querySelector('.install-btn');
            }
        }
        
        if (mainButton) {
            mainButton.disabled = false;
            mainButton.classList.remove('loading');
            mainButton.innerHTML = mainButton.originalHTML || 'Install';
        }
    }
    
    // Debug-Logging
    console.log('Modal closed for container:', containerName);
}

// Globale Variablen am Anfang der Datei
let sshConnection = null;
let globalCurrentPath = '/';
let currentCommand = '';
let terminalContent = null;  // Wird später definiert
let commandHistory = [];  // Neu: Global definiert
let historyIndex = -1;   // Neu: Global definiert
let currentInput = '';   // Neu: Global definiert

// Am Anfang der Datei
const cachedData = {
    containers: null,
    categories: null,
    lastUpdate: 0
};

function getCachedData(key, ttl = 30000) {
    return cachedData[key] && (Date.now() - cachedData.lastUpdate < ttl) 
        ? cachedData[key] 
        : null;
}

function showErrorNotification(error, context) {
    console.error(`Error in ${context}:`, error);
    showNotification('error', `${context}: ${error.message || 'An error occurred'}`);
}

// Verbesserte showNotification Funktion
function showNotification(type, message, duration = 3000) {
    const notificationContainer = document.getElementById('notification-container') 
        || createNotificationContainer();
    
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.innerHTML = `
        <i class="fa fa-${type === 'success' ? 'check-circle' : 'exclamation-circle'}"></i>
        <span>${message}</span>
        <button class="close-notification">
            <i class="fa fa-times"></i>
        </button>
    `;
    
    notificationContainer.appendChild(notification);
    
    notification.querySelector('.close-notification').addEventListener('click', () => {
        notification.classList.remove('show');
        setTimeout(() => notification.remove(), 300);
    });
    
    setTimeout(() => notification.classList.add('show'), 10);
    
    if (duration) {
        setTimeout(() => {
            notification.classList.remove('show');
            setTimeout(() => notification.remove(), 300);
        }, duration);
    }
}

function createNotificationContainer() {
    const container = document.createElement('div');
    container.id = 'notification-container';
    document.body.appendChild(container);
    return container;
}

window.disconnectFromServer = function() {
    fetch('/api/disconnect', {
        method: 'POST',
        body: JSON.stringify({ connection: sshConnection }),
        headers: { 'Content-Type': 'application/json' }
    })
    .then(() => {
        sshConnection = null;
        document.querySelector('.terminal-container').style.display = 'none';
        document.querySelector('.file-explorer').style.display = 'none';
        showNotification('success', 'Disconnected from server');
    });
};

document.addEventListener('DOMContentLoaded', function() {
    loadingOverlay = document.getElementById('loading-overlay');
    
    // Lade Docker-Informationen
    fetchDockerInfo();
    
    // Container-Status-Updates als globale Funktion
    window.updateContainerStatus = function(showLoading = false) {
        if (showLoading && loadingOverlay) {
            loadingOverlay.style.display = 'flex';
        }
        
        // Hole zuerst die Kategorien, dann die Container
        fetch('/api/categories')
            .then(response => response.json())
            .then(categoriesData => {
                const categories = categoriesData.categories;
                
                // Jetzt hole die Container
                return fetch('/api/containers')
                    .then(response => response.json())
                    .then(data => {
                        const groups = document.querySelector('.container-groups');
                        if (!groups) return;
                        
                        // Gruppiere Container nach Kategorien
                        const groupedContainers = {};
                        const assignedContainers = new Set(); // Merke dir zugewiesene Container
                        
                        // Initialisiere alle Kategorien
                        Object.entries(categories || {}).forEach(([id, category]) => {
                            groupedContainers[category.name] = {
                                name: category.name,
                                icon: category.icon,
                                containers: []
                            };
                        });
                        
                        // Füge "Imported" Kategorie hinzu
                        groupedContainers['Imported'] = {
                            name: 'Imported',
                            icon: 'fa-cloud-download-alt',
                            containers: []
                        };
                        
                        // Sortiere Container in ihre Kategorien
                        Object.values(data).forEach(group => {
                            group.containers.forEach(container => {
                                let assigned = false;
                                
                                // Suche die passende Kategorie
                                Object.entries(categories || {}).forEach(([id, category]) => {
                                    if (category.containers) {
                                        // Check if container.name is in the category's containers list
                                        const containerInCategory = category.containers.some(c => 
                                            (typeof c === 'string' && c === container.name) || 
                                            (c && c.name === container.name)
                                        );
                                        
                                        if (containerInCategory && !assignedContainers.has(container.name)) {
                                            groupedContainers[category.name].containers.push(container);
                                            assignedContainers.add(container.name); // Markiere Container als zugewiesen
                                            assigned = true;
                                            console.debug(`Assigned ${container.name} to category ${category.name}`);
                                        }
                                    }
                                });
                                
                                // Wenn keine Kategorie gefunden wurde, füge zu "Other" hinzu
                                if (!assigned && !assignedContainers.has(container.name)) {
                                    groupedContainers['Other'].containers.push(container);
                                    assignedContainers.add(container.name);
                                }
                            });
                        });
                        
                        // Aktualisiere die Anzeige
                        groups.innerHTML = '';
                        Object.entries(groupedContainers)
                            .filter(([name, group]) => group.containers.length > 0)
                            .forEach(([name, group]) => {
                                groups.innerHTML += `
                                    <div class="group-section">
                                        <h2><i class="fa ${group.icon}"></i> ${name}</h2>
                                        <div class="container-grid">
                                            ${group.containers.map(container => createContainerCard(container)).join('')}
                                        </div>
                                    </div>
                                `;
                            });
                            
                        // Event-Listener wieder hinzufügen
                        addContainerEventListeners();
                    });
            })
            .catch(error => {
                console.error('Error:', error);
                if (showLoading) {
                    showNotification('error', 'Failed to load containers');
                }
            })
            .finally(() => {
                if (showLoading && loadingOverlay) {
                    loadingOverlay.style.display = 'none';
                }
            });
    };

    // Initialer Update-Aufruf mit Loading-Anzeige
    updateContainerStatus(true);

    // Periodische Updates ohne Loading-Anzeige
    setInterval(() => {
        if (!document.querySelector('.modal.show') && !document.activeElement.tagName.match(/input|select|textarea/i)) {
            updateContainerStatus(false);
        }
    }, 300000); // Alle 5 Minuten

    // Event-Listener für manuelle Aktualisierung mit Loading-Anzeige
    document.addEventListener('keydown', function(e) {
        if (e.key === 'F5' || (e.ctrlKey && e.key === 'r')) {
            e.preventDefault();
            updateContainerStatus(true);
        }
    });

    // Tab Switching
    document.querySelectorAll('[data-tab]').forEach(tab => {
        tab.addEventListener('click', function(e) {
            e.preventDefault();
            const targetId = this.getAttribute('data-tab');
            
            // Deaktiviere alle Tabs
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.remove('active');
            });
            document.querySelectorAll('[data-tab]').forEach(t => {
                t.classList.remove('active');
            });
            
            // Aktiviere ausgewählten Tab
            document.getElementById(targetId).classList.add('active');
            this.classList.add('active');
        });
    });

    // System Status Updates
    function updateSystemStatus() {
        fetch('/api/system/status')
            .then(response => response.json())
            .then(data => {
                // CPU Usage
                const cpuGauge = document.querySelector('#cpu-gauge');
                cpuGauge.style.setProperty('--percentage', `${data.cpu}%`);
                document.querySelector('#cpu-value').textContent = `${data.cpu}%`;

                // Memory Usage
                const memGauge = document.querySelector('#memory-gauge');
                memGauge.style.setProperty('--percentage', `${data.memory}%`);
                document.querySelector('#memory-value').textContent = `${data.memory}%`;

                // Disk Usage
                const diskGauge = document.querySelector('#disk-gauge');
                diskGauge.style.setProperty('--percentage', `${data.disk}%`);
                document.querySelector('#disk-value').textContent = `${data.disk}%`;
            })
            .catch(error => console.error('Error updating system status:', error));
    }

    // Container Health Updates
    function updateContainerHealth() {
        fetch('/api/containers/health')
            .then(response => response.json())
            .then(data => {
                const healthGrid = document.getElementById('container-health');
                healthGrid.innerHTML = '';
                
                data.forEach(container => {
                    healthGrid.innerHTML += `
                        <div class="health-card">
                            <h3>${container.name}</h3>
                            <div class="health-status ${container.status}">
                                <i class="fa fa-${container.status === 'healthy' ? 'check' : 'warning'}"></i>
                                ${container.status}
                            </div>
                            <div class="health-details">
                                <p>Uptime: ${container.uptime}</p>
                                <p>Memory: ${container.memory}</p>
                                <p>CPU: ${container.cpu}</p>
                            </div>
                        </div>
                    `;
                });
            })
            .catch(error => console.error('Error updating container health:', error));
    }

    function formatLogDate(timestamp) {
        if (!timestamp) return 'N/A';
        
        try {
            // Prüfe ob der Timestamp ein Unix-Timestamp (Zahl) ist
            if (typeof timestamp === 'number') {
                return new Date(timestamp * 1000).toLocaleString();
            }
            
            // Versuche das Datum zu parsen
            const date = new Date(timestamp);
            if (isNaN(date.getTime())) {
                return 'Invalid Date';
            }
            
            // Formatiere das Datum
            return date.toLocaleString('de-DE', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
        } catch (e) {
            console.error('Error formatting date:', e);
            return 'Invalid Date';
        }
    }

    // Aktualisiere die Log-Anzeige Funktion
    function updateSystemLogs(filterLevel = null, filterSource = null, searchTerm = null) {
        fetch('/api/system/logs')
            .then(response => response.json())
            .then(data => {
                const logsContainer = document.getElementById('system-logs');
                if (!logsContainer) return;
                
                // Erstelle Filter-Kontrollen, wenn sie noch nicht existieren
                const logsSection = logsContainer.closest('.section-content');
                if (!document.getElementById('log-filter-controls') && logsSection) {
                    const filterControls = document.createElement('div');
                    filterControls.id = 'log-filter-controls';
                    filterControls.className = 'log-filter-controls';
                    filterControls.innerHTML = `
                        <div class="filter-row">
                            <div class="filter-group">
                                <span>Level:</span>
                                <button class="log-filter-btn active" data-filter="level" data-value="all">All</button>
                                <button class="log-filter-btn" data-filter="level" data-value="info">Info</button>
                                <button class="log-filter-btn" data-filter="level" data-value="warning">Warning</button>
                                <button class="log-filter-btn" data-filter="level" data-value="error">Error</button>
                            </div>
                            <div class="filter-group">
                                <span>Source:</span>
                                <button class="log-filter-btn active" data-filter="source" data-value="all">All</button>
                                <button class="log-filter-btn" data-filter="source" data-value="webdock-ui">WebDock</button>
                                <button class="log-filter-btn" data-filter="source" data-value="docker">Docker</button>
                                <button class="log-filter-btn" data-filter="source" data-value="system">System</button>
                            </div>
                        </div>
                        <div class="filter-row">
                            <div class="search-group">
                                <input type="text" id="log-search" placeholder="Search logs..." class="form-control">
                                <button id="log-search-btn"><i class="fa fa-search"></i></button>
                            </div>
                            <div class="actions-group">
                                <button id="log-refresh-btn" title="Refresh logs"><i class="fa fa-refresh"></i></button>
                                <button id="log-clear-filters-btn" title="Clear all filters"><i class="fa fa-times"></i></button>
                                <button id="log-export-btn" title="Export logs"><i class="fa fa-download"></i></button>
                            </div>
                        </div>
                    `;
                    
                    // Füge vor dem Logs-Container ein
                    logsSection.insertBefore(filterControls, logsContainer);
                    
                    // Event-Listener für Filter-Buttons
                    document.querySelectorAll('.log-filter-btn').forEach(btn => {
                        btn.addEventListener('click', () => {
                            // Deaktiviere andere Buttons in derselben Gruppe
                            const filterType = btn.dataset.filter;
                            document.querySelectorAll(`.log-filter-btn[data-filter="${filterType}"]`).forEach(b => {
                                b.classList.remove('active');
                            });
                            btn.classList.add('active');
                            
                            // Hole aktuelle Filter
                            const currentLevelFilter = document.querySelector('.log-filter-btn[data-filter="level"].active').dataset.value;
                            const currentSourceFilter = document.querySelector('.log-filter-btn[data-filter="source"].active').dataset.value;
                            const currentSearchTerm = document.getElementById('log-search').value;
                            
                            // Aktualisiere Logs mit neuen Filtern
                            updateSystemLogs(
                                currentLevelFilter !== 'all' ? currentLevelFilter : null,
                                currentSourceFilter !== 'all' ? currentSourceFilter : null,
                                currentSearchTerm || null
                            );
                        });
                    });
                    
                    // Event-Listener für Suche
                    document.getElementById('log-search-btn').addEventListener('click', () => {
                        const searchTerm = document.getElementById('log-search').value;
                        const currentLevelFilter = document.querySelector('.log-filter-btn[data-filter="level"].active').dataset.value;
                        const currentSourceFilter = document.querySelector('.log-filter-btn[data-filter="source"].active').dataset.value;
                        
                        updateSystemLogs(
                            currentLevelFilter !== 'all' ? currentLevelFilter : null,
                            currentSourceFilter !== 'all' ? currentSourceFilter : null,
                            searchTerm || null
                        );
                    });
                    
                    // Event-Listener für Enter-Taste im Suchfeld
                    document.getElementById('log-search').addEventListener('keyup', (e) => {
                        if (e.key === 'Enter') {
                            document.getElementById('log-search-btn').click();
                        }
                    });
                    
                    // Event-Listener für Refresh-Button
                    document.getElementById('log-refresh-btn').addEventListener('click', () => {
                        const currentLevelFilter = document.querySelector('.log-filter-btn[data-filter="level"].active').dataset.value;
                        const currentSourceFilter = document.querySelector('.log-filter-btn[data-filter="source"].active').dataset.value;
                        const currentSearchTerm = document.getElementById('log-search').value;
                        
                        updateSystemLogs(
                            currentLevelFilter !== 'all' ? currentLevelFilter : null,
                            currentSourceFilter !== 'all' ? currentSourceFilter : null,
                            currentSearchTerm || null
                        );
                    });
                    
                    // Event-Listener für Clear-Filters-Button
                    document.getElementById('log-clear-filters-btn').addEventListener('click', () => {
                        // Setze alle Filter zurück
                        document.querySelectorAll('.log-filter-btn[data-value="all"]').forEach(btn => {
                            const filterType = btn.dataset.filter;
                            document.querySelectorAll(`.log-filter-btn[data-filter="${filterType}"]`).forEach(b => {
                                b.classList.remove('active');
                            });
                            btn.classList.add('active');
                        });
                        document.getElementById('log-search').value = '';
                        
                        // Aktualisiere Logs ohne Filter
                        updateSystemLogs();
                    });
                    
                    // Event-Listener für Export-Button
                    document.getElementById('log-export-btn').addEventListener('click', () => {
                        // Erstelle CSV aus aktuellen Logs
                        const csvContent = 'data:text/csv;charset=utf-8,'
                            + 'Timestamp,Level,Source,Message\n'
                            + logs.map(log => {
                                return `"${log.timestamp}","${log.level}","${log.source}","${log.message.replace(/"/g, '""')}"`;
                            }).join('\n');
                        
                        const encodedUri = encodeURI(csvContent);
                        const link = document.createElement('a');
                        link.setAttribute('href', encodedUri);
                        link.setAttribute('download', `webdock-logs-${new Date().toISOString().split('T')[0]}.csv`);
                        document.body.appendChild(link);
                        link.click();
                        document.body.removeChild(link);
                    });
                    
                    // Füge CSS für die neuen Elemente hinzu
                    if (!document.getElementById('log-styles')) {
                        const style = document.createElement('style');
                        style.id = 'log-styles';
                        style.textContent = `
                            .log-filter-controls {
                                margin-bottom: 15px;
                                padding: 15px;
                                background: var(--color-background-dark);
                                border-radius: 8px;
                                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                            }
                            .filter-row {
                                display: flex;
                                justify-content: space-between;
                                margin-bottom: 10px;
                            }
                            .filter-row:last-child {
                                margin-bottom: 0;
                            }
                            .filter-group, .search-group, .actions-group {
                                display: flex;
                                align-items: center;
                                gap: 10px;
                            }
                            .log-filter-btn {
                                padding: 6px 12px;
                                border: none;
                                border-radius: 4px;
                                background: var(--color-background);
                                color: var(--color-text);
                                cursor: pointer;
                                transition: all 0.2s;
                            }
                            .log-filter-btn:hover {
                                background: var(--color-background-light);
                            }
                            .log-filter-btn.active {
                                background: var(--color-primary);
                                color: white;
                            }
                            #log-search {
                                width: 250px;
                                border-radius: 4px;
                                border: 1px solid var(--color-border);
                                padding: 6px 12px;
                            }
                            #log-search-btn, #log-refresh-btn, #log-clear-filters-btn, #log-export-btn {
                                padding: 6px 12px;
                                border: none;
                                border-radius: 4px;
                                background: var(--color-primary);
                                color: white;
                                cursor: pointer;
                                transition: all 0.2s;
                            }
                            #log-search-btn:hover, #log-refresh-btn:hover, #log-clear-filters-btn:hover, #log-export-btn:hover {
                                background: var(--color-primary-dark);
                            }
                            #system-logs {
                                max-height: 600px;
                                overflow-y: auto;
                                border-radius: 8px;
                                border: 1px solid var(--color-border);
                                background: var(--color-background);
                                padding: 10px;
                                font-family: monospace;
                            }
                            .log-entry {
                                display: grid;
                                grid-template-columns: 100px 80px 80px 1fr;
                                gap: 10px;
                                padding: 8px;
                                border-bottom: 1px solid var(--color-border);
                                align-items: center;
                            }
                            .log-time {
                                color: var(--color-text-muted);
                                font-size: 0.9em;
                                white-space: nowrap;
                            }
                            .log-source {
                                color: var(--color-text);
                                font-size: 0.9em;
                                white-space: nowrap;
                            }
                            .log-level {
                                display: inline-flex;
                                align-items: center;
                                gap: 5px;
                                font-size: 0.9em;
                                white-space: nowrap;
                            }
                            .log-message {
                                color: var(--color-text);
                                line-height: 1.4;
                                word-break: break-word;
                            }
                            .log-entry.info .log-level { color: #17a2b8; }
                            .log-entry.warning .log-level { color: #ffc107; }
                            .log-entry.error .log-level { color: #dc3545; }
                            .log-entry.error .log-message {
                                color: #dc3545;
                            }
                            .log-entry i {
                                font-size: 12px;
                                width: 14px;
                                text-align: center;
                            }
                        `;
                        document.head.appendChild(style);
                    }
                }
                
                // Hole die Logs aus der Response
                const allLogs = data.logs || [];
                
                // Filtere Logs basierend auf den Filtern
                const filteredLogs = allLogs.filter(log => {
                    // Filter nach Level
                    if (filterLevel && log.level.toLowerCase() !== filterLevel.toLowerCase()) {
                        return false;
                    }
                    
                    // Filter nach Source
                    if (filterSource && log.source.toLowerCase() !== filterSource.toLowerCase()) {
                        return false;
                    }
                    
                    // Filter nach Suchbegriff
                    if (searchTerm && !log.message.toLowerCase().includes(searchTerm.toLowerCase())) {
                        return false;
                    }
                    
                    return true;
                });
                
                // Aktualisiere die Anzeige der gefilterten Logs
                logsContainer.innerHTML = filteredLogs.map(log => {
                    const levelClass = log.level.toLowerCase();
                    const sourceIcon = {
                        'webdock-ui': 'fa-desktop',
                        'docker': 'fa-docker',
                        'system': 'fa-cog'
                    }[log.source] || 'fa-info-circle';
                    
                    return `
                        <div class="log-entry ${levelClass}">
                            <span class="log-time">${log.timestamp}</span>
                            <span class="log-source">${log.source || 'system'}</span>
                            <span class="log-level">${log.level}</span>
                            <span class="log-message">${log.message}</span>
                        </div>
                    `;
                }).join('');
                
                // Zeige eine Meldung, wenn keine Logs gefunden wurden
                if (filteredLogs.length === 0) {
                    logsContainer.innerHTML = `
                        <div class="no-logs-message">
                            <i class="fa fa-info-circle"></i>
                            <p>Keine Logs gefunden, die den aktuellen Filtern entsprechen.</p>
                        </div>
                    `;
                }
                
                // Scrolle zum neuesten Log
                logsContainer.scrollTop = logsContainer.scrollHeight;
            })
            .catch(error => console.error('Error loading logs:', error));
    }

    // Aktualisiere die Logs alle 10 Sekunden
    setInterval(updateSystemLogs, 10000);

    // Settings Management
    const themeSelect = document.getElementById('theme-select');
    themeSelect.value = localStorage.getItem('theme') || 'system';
    themeSelect.addEventListener('change', (e) => {
        const theme = e.target.value;
        localStorage.setItem('theme', theme);
        updateTheme(theme);
        showNotification('success', `Theme changed to ${theme}`);
    });

    const autoUpdate = document.getElementById('auto-update');
    autoUpdate.checked = localStorage.getItem('autoUpdate') !== 'false';
    autoUpdate.addEventListener('change', (e) => {
        localStorage.setItem('autoUpdate', e.target.checked);
        setupRefreshInterval();
        showNotification('success', `Auto-update ${e.target.checked ? 'enabled' : 'disabled'}`);
    });

    const refreshInterval = document.getElementById('refresh-interval');
    refreshInterval.value = localStorage.getItem('refreshInterval') || '30';
    refreshInterval.addEventListener('change', (e) => {
        const interval = e.target.value;
        localStorage.setItem('refreshInterval', interval);
        setupRefreshInterval();
        showNotification('success', `Refresh interval set to ${interval} seconds`);
    });

    // Lade gespeicherte Einstellungen
    window.addEventListener('DOMContentLoaded', () => {
        document.getElementById('theme-select').value = localStorage.getItem('theme') || 'system';
        document.getElementById('auto-update').checked = localStorage.getItem('autoUpdate') !== 'false';
        document.getElementById('refresh-interval').value = localStorage.getItem('refreshInterval') || '30';
        
        // Initialisiere WebSocket-Verbindung für Echtzeit-Updates
        initializeContainerSocket();
    });
    
// Initialisierung der WebSocket-Verbindung für Container-Status-Updates
// Globale Variable um zu verfolgen, ob wir aktiv versuchen, eine Verbindung herzustellen
let isConnecting = false;

function initializeContainerSocket() {
    // Verhindere mehrere gleichzeitige Verbindungsversuche
    if (isConnecting) {
        console.log('Verbindungsaufbau bereits im Gange, warte...');
        return true;
    }
    
    try {
        isConnecting = true;
        console.log('Initialisiere WebSocket-Verbindung für Echtzeit-Container-Updates...');
        
        // Setze einen Timeout für den Verbindungsaufbau
        const connectionTimeout = setTimeout(() => {
            if (isConnecting) {
                console.warn('WebSocket-Verbindung konnte nicht innerhalb des Timeouts hergestellt werden');
                isConnecting = false;
                setupStatusPollingFallback();
            }
        }, 10000); // 10 Sekunden Timeout
        
        // Wenn bereits eine Verbindung existiert, zuerst trennen
        if (containerSocket) {
            // Entferne alle vorhandenen Listeners um Memory-Leaks zu vermeiden
            containerSocket.off('connect');
            containerSocket.off('connect_error');
            containerSocket.off('disconnect');
            containerSocket.off('initial_status');
            containerSocket.off('container_status_update');
            containerSocket.off('container_status_refresh');
            
            // Trenne bestehende Verbindung
            containerSocket.disconnect();
        }
        
        // Verbindung zum Socket.IO-Namespace für Container-Updates herstellen
        containerSocket = io('/containers', {
            reconnection: true,             // Automatische Wiederverbindung aktivieren
            reconnectionAttempts: 10,        // Mehr Versuche erlauben für stabilere Verbindung
            reconnectionDelay: 1000,        // Anfängliche Verzögerung in ms
            reconnectionDelayMax: 5000,     // Geringere maximale Verzögerung für schnellere Reconnects
            timeout: 20000,                 // Verbindungs-Timeout in ms
            forceNew: false,                // Bestehende Verbindungen wiederverwenden
            transports: ['websocket', 'polling'] // Erst WebSocket, dann Polling als Fallback
        });
        
        // Event-Handler für Verbindungsereignisse
        containerSocket.on('connect', () => {
            console.log('✅ WebSocket-Verbindung hergestellt!');
            clearTimeout(connectionTimeout);
            isConnecting = false;
            
            // Fallback-Timer entfernen, wenn WebSocket funktioniert
            if (containerStatusTimer) {
                clearInterval(containerStatusTimer);
                containerStatusTimer = null;
            }
            
            // Anfrage für initialen Status senden
            containerSocket.emit('get_initial_status');
            
            // Update UI to show connected state
            const statusIndicator = document.getElementById('websocket-status');
            if (statusIndicator) {
                statusIndicator.className = 'connected';
                statusIndicator.title = 'WebSocket verbunden';
            }
        });
        
        containerSocket.on('connect_error', (error) => {
            console.error('❌ WebSocket-Verbindungsfehler:', error);
            clearTimeout(connectionTimeout);
            isConnecting = false;
            setupStatusPollingFallback(); // Fallback zu regelmäßigem Polling
            
            // Update UI to show disconnected state
            const statusIndicator = document.getElementById('websocket-status');
            if (statusIndicator) {
                statusIndicator.className = 'disconnected';
                statusIndicator.title = 'WebSocket getrennt: ' + error.message;
            }
            
            // Automatisch nach einer Verzögerung erneut versuchen zu verbinden
            setTimeout(() => {
                if (!containerSocket || !containerSocket.connected) {
                    console.log('Versuche WebSocket-Verbindung wiederherzustellen...');
                    initializeContainerSocket();
                }
            }, 5000); // Nach 5 Sekunden erneut versuchen
        });
        
        containerSocket.on('disconnect', (reason) => {
            console.log('⚠️ WebSocket-Verbindung getrennt:', reason);
            clearTimeout(connectionTimeout);
            isConnecting = false;
            
            // Update UI to show disconnected state
            const statusIndicator = document.getElementById('websocket-status');
            if (statusIndicator) {
                statusIndicator.className = 'disconnected';
                statusIndicator.title = 'WebSocket getrennt: ' + reason;
            }
            
            // Fallback zu Polling einrichten
            setupStatusPollingFallback();
            
            // Bei bestimmten Fehlern versuche automatisch neu zu verbinden
            if (reason === 'io server disconnect' || reason === 'transport close' || reason === 'ping timeout') {
                setTimeout(() => {
                    if (!containerSocket || !containerSocket.connected) {
                        console.log('Versuche WebSocket-Verbindung nach Trennung wiederherzustellen...');
                        initializeContainerSocket();
                    }
                }, 3000); // Nach 3 Sekunden erneut versuchen
            }
        });
        
        // Event-Handler für Container-Status-Updates
        containerSocket.on('initial_status', (statusData) => {
            console.log('Initialen Container-Status erhalten');
            updateContainerStatusUI(statusData);
        });
        
        containerSocket.on('container_status_update', (containerData) => {
            // Verarbeite nur, wenn die Daten gültig sind
            if (containerData && containerData.name) {
                // Reduzierte Logging-Nachricht
                const container = {
                    name: containerData.name,
                    status: containerData.status
                };
                
                // Update des UI nur für den einen Container
                updateContainerStatusUI([container], true);
            }
        });
        
        containerSocket.on('container_status_refresh', (statusData) => {
            if (Array.isArray(statusData)) {
                updateContainerStatusUI(statusData);
            } else {
                console.warn('Ungültiges Format für Container-Status-Refresh:', statusData);
            }
        });
        
        // Erfolgreiche Initialisierung
        return true;
    } catch (error) {
        console.error('Fehler bei der Initialisierung der WebSocket-Verbindung:', error);
        isConnecting = false;
        setupStatusPollingFallback(); // Fallback zu regelmäßigem Polling
        
        // Update UI to show error state
        const statusIndicator = document.getElementById('websocket-status');
        if (statusIndicator) {
            statusIndicator.className = 'error';
            statusIndicator.title = 'WebSocket-Fehler: ' + error.message;
        }
        
        return false;
    }
}

// Fallback-Funktion, die reguläres Polling einrichtet, falls WebSockets nicht funktionieren
function setupStatusPollingFallback() {
    // Verhindere mehrere Timer
    if (containerStatusTimer) {
        clearInterval(containerStatusTimer);
        containerStatusTimer = null;
    }
    
    // Prüfe, ob autoUpdate aktiviert ist
    if (localStorage.getItem('autoUpdate') === 'false') {
        return; // Wenn auto-Update deaktiviert ist, richte auch keinen Fallback ein
    }
    
    console.log('Richte Fallback-Polling für Container-Status ein');
    const interval = Math.max(30, parseInt(localStorage.getItem('refreshInterval') || '30')) * 1000;
    
    containerStatusTimer = setInterval(function() {
        // Nur polling ausführen wenn keine WebSocket-Verbindung besteht
        if (!containerSocket || !containerSocket.connected) {
            console.log('Polling Container-Status (Fallback-Methode)...');
            updateContainerStatus(false);
        }
    }, interval);
}

// Funktion zum Abrufen der Docker-Versionsinformationen
function fetchDockerInfo() {
    fetch('/api/docker/info')
        .then(function(response) { return response.json(); })
        .then(function(data) {
            document.getElementById('docker-version').value = data.version;
            document.getElementById('docker-network').value = data.network;
        })
        .catch(function(error) { console.error('Error getting Docker info:', error); });
}

// Setup Refresh Interval - Nur für Systemstatus, Container-Status verwendet WebSockets
function setupRefreshInterval() {
    const interval = parseInt(refreshInterval.value) * 1000;
    if (window.statusInterval) clearInterval(window.statusInterval);
    if (autoUpdate.checked) {
        window.statusInterval = setInterval(function() {
            updateSystemStatus();
            updateContainerHealth();
            updateSystemLogs();
        }, interval);
        }
        
        // Aktualisiere auch die WebSocket-Verbindung, wenn die Einstellungen geändert wurden
        // oder stelle sicher, dass der Fallback aktiviert ist, wenn WebSockets nicht verfügbar sind
        if (containerSocket && containerSocket.connected) {
            console.log('WebSocket-Verbindung aktiv, keine Änderung notwendig');
        } else {
            console.log('WebSocket-Verbindung nicht aktiv, versuche erneut zu verbinden');
            if (!containerSocket) {
                initializeContainerSocket();
            } else {
                setupStatusPollingFallback();
            }
        }
    }

    // Initial Updates
    updateSystemStatus();
    updateContainerHealth();
    updateSystemLogs();
    setupRefreshInterval();

    // Gauge Chart Drawing
    function updateGaugeChart(elementId, value) {
        const canvas = document.getElementById(elementId);
        if (!canvas.getContext) return;

        const ctx = canvas.getContext('2d');
        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;
        const radius = Math.min(centerX, centerY) - 10;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Draw background arc
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, Math.PI, 2 * Math.PI);
        ctx.strokeStyle = '#ddd';
        ctx.lineWidth = 20;
        ctx.stroke();

        // Draw value arc
        const angle = Math.PI + (value / 100) * Math.PI;
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, Math.PI, angle);
        ctx.strokeStyle = getColorForValue(value);
        ctx.lineWidth = 20;
        ctx.stroke();
    }

    function getColorForValue(value) {
        if (value < 60) return '#46ba61';  // Green
        if (value < 80) return '#f0ad4e';  // Yellow
        return '#e9322d';  // Red
    }

    // Theme Management
    function updateTheme(theme) {
        const root = document.documentElement;
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        
        // Entferne vorherige Theme-Klassen
        root.removeAttribute('data-theme');
        
        // Setze das neue Theme
        switch (theme) {
            case 'dark':
                root.setAttribute('data-theme', 'dark');
                break;
            case 'light':
                root.setAttribute('data-theme', 'light');
                break;
            case 'system':
                if (prefersDark) {
                    root.setAttribute('data-theme', 'dark');
                } else {
                    root.setAttribute('data-theme', 'light');
                }
                break;
        }
    }

    // Überwache System-Theme-Änderungen
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        if (localStorage.getItem('theme') === 'system') {
            updateTheme('system');
        }
    });

    // Data Location Management
    const dataLocation = document.getElementById('data-location');
    const saveLocationBtn = document.getElementById('save-location');
    
    // Lade aktuelle Einstellung
    fetch('/api/settings/data-location')
        .then(response => response.json())
        .then(data => {
            dataLocation.value = data.location;
        })
        .catch(error => console.error('Error loading data location:', error));
    
    saveLocationBtn.addEventListener('click', () => {
        const newLocation = dataLocation.value;
        
        fetch('/api/settings/data-location', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ location: newLocation })
        })
        .then(response => response.json())
        .then(data => {
            if (data.status === 'success') {
                showNotification('success', 'Data location updated');
            } else {
                showNotification('error', data.message);
            }
        })
        .catch(error => {
            console.error('Error:', error);
            showNotification('error', 'Failed to update data location');
        });
    });

    // Directory Browser
    const directoryModal = document.getElementById('directory-modal');
    const browseLocationBtn = document.getElementById('browse-location');
    const directoryList = document.querySelector('.directory-list');
    let currentPath = '/';
    
    browseLocationBtn.addEventListener('click', () => {
        directoryModal.classList.add('show');
        loadDirectories(currentPath);
    });
    
    document.querySelectorAll('.close-modal').forEach(btn => {
        btn.addEventListener('click', () => {
            directoryModal.classList.remove('show');
        });
    });
    
    document.getElementById('parent-dir').addEventListener('click', () => {
        // Hole den übergeordneten Pfad
        const parentPath = currentPath === '/' ? '/' : currentPath.split('/').slice(0, -1).join('/') || '/';
        loadDirectories(parentPath);
    });
    
    document.getElementById('select-directory').addEventListener('click', () => {
        document.getElementById('data-location').value = currentPath;
        directoryModal.classList.remove('show');
    });
    
    function loadDirectories(path, goToParent = false) {
        fetch(`/api/browse-directories?path=${encodeURIComponent(path)}`)
            .then(response => response.json())
            .then(data => {
                if (data.status === 'error') {
                    showNotification('error', data.message);
                    return;
                }
                
                currentPath = data.current_path;
                document.getElementById('current-path').textContent = currentPath;
                
                // Deaktiviere Parent-Button wenn wir im Root-Verzeichnis sind
                const parentBtn = document.getElementById('parent-dir');
                parentBtn.disabled = currentPath === '/';
                
                directoryList.innerHTML = '';
                data.directories.forEach(dir => {
                    const item = document.createElement('div');
                    item.className = 'directory-item';
                    item.innerHTML = `
                        <i class="fa fa-folder"></i>
                        ${dir.name}
                    `;
                    item.addEventListener('click', () => loadDirectories(dir.path));
                    directoryList.appendChild(item);
                });
            })
            .catch(error => {
                console.error('Error:', error);
                showNotification('error', 'Failed to load directories');
            });
    }

    // Container Filter
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            // Update active button
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            const filter = btn.getAttribute('data-filter');
            const containers = document.querySelectorAll('.container-card');
            
            containers.forEach(container => {
                const status = container.querySelector('.status-indicator').classList.contains('running') ? 'running' : 'stopped';
                if (filter === 'all' || filter === status) {
                    container.style.display = '';
                } else {
                    container.style.display = 'none';
                }
            });
        });
    });

    // Category Management

    async function loadCategories(forceRefresh = false) {
        const now = Date.now();
        const useCachedData = categoriesCache && !forceRefresh && (now - lastCategoriesFetch < CACHE_TTL);
        
        if (useCachedData) {
            console.log('Verwende zwischengespeicherte Kategoriedaten');
            renderCategories(categoriesCache);
            return;
        }

        console.log('Lade neue Kategoriedaten vom Server');
        try {
            const response = await fetch('/api/categories');
            const data = await response.json();
            
            // Aktualisiere den Cache und Zeitstempel
            categoriesCache = data;
            lastCategoriesFetch = now;
            
            // Rendere die UI mit den neuen Daten
            renderCategories(data);
        } catch (error) {
            console.error('Error loading categories:', error);
            showNotification('error', 'Error loading categories');
        }
    }

    function renderCategories(data) {
        const categoryList = document.querySelector('.category-list');
        categoryList.innerHTML = '';
        
        // Sortiere die Kategorien alphabetisch, aber stelle sicher dass "Other" am Ende ist
        const sortedCategories = Object.entries(data.categories || {}).sort((a, b) => {
            if (a[1].name === 'Other') return 1;
            if (b[1].name === 'Other') return -1;
            return a[1].name.localeCompare(b[1].name);
        });

        sortedCategories.forEach(([id, category]) => {
            const categoryItem = document.createElement('div');
            categoryItem.className = 'category-item';
            categoryItem.dataset.id = id;
            categoryItem.draggable = true;
            
            const isImported = category.name === 'Imported';
            
            categoryItem.innerHTML = `
                <div class="drag-handle">
                    <i class="fa fa-bars"></i>
                </div>
                <div class="category-info">
                    <i class="fa ${category.icon}"></i>
                    <span>${category.name}</span>
                </div>
                <div class="category-actions">
                    <button class="edit-category" ${isImported ? 'disabled title="Default category cannot be edited"' : ''}>
                        <i class="fa fa-edit"></i>
                    </button>
                    <button class="delete-category" ${isImported ? 'disabled title="Default category cannot be deleted"' : ''}>
                        <i class="fa fa-trash"></i>
                    </button>
                </div>
            `;
            
            // Event-Listener nur hinzufügen, wenn es nicht die "Imported" Kategorie ist
            if (!isImported) {
                categoryItem.querySelector('.edit-category').addEventListener('click', () => editCategory(id));
                categoryItem.querySelector('.delete-category').addEventListener('click', () => deleteCategory(id));
            }
            
            // Drag & Drop Event-Listener
            categoryItem.addEventListener('dragstart', handleDragStart);
            categoryItem.addEventListener('dragend', handleDragEnd);
            
            categoryList.appendChild(categoryItem);
        });
        
        // Lade Container für jede Kategorie
        loadContainers();
    }

    document.getElementById('add-category').addEventListener('click', () => {
        document.getElementById('category-modal-title').textContent = 'Add Category';
        document.getElementById('category-form').reset();
        document.getElementById('category-form').removeAttribute('data-editing');
        document.getElementById('category-modal').classList.add('show');
        loadAvailableContainers();
    });

    document.getElementById('category-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const formData = {
            name: document.getElementById('category-name').value,
            icon: document.getElementById('category-icon').value,
            description: document.getElementById('category-description').value,
            containers: Array.from(document.querySelectorAll('.container-option input:checked'))
                .map(input => input.value)
        };
        
        const method = document.getElementById('category-form').dataset.editing ? 'PUT' : 'POST';
        const url = '/api/categories' + (method === 'PUT' ? `?id=${document.getElementById('category-form').dataset.editing}` : '');
        
        fetch(url, {
            method: method,
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(formData)
        })
        .then(response => response.json())
        .then(data => {
            if (data.status === 'success') {
                showNotification('success', data.message);
                document.getElementById('category-modal').classList.remove('show');
                loadCategories();
            } else {
                showNotification('error', data.message);
            }
        });
    });

    function editCategory(id) {
        // Statt direkt die Kategorie zu laden, nutzen wir die showCategoryModal Funktion
        showCategoryModal('edit', id);
    }

    function deleteCategory(id) {
        if (confirm('Are you sure you want to delete this category?')) {
            fetch(`/api/categories?id=${id}`, {
                method: 'DELETE'
            })
            .then(response => response.json())
            .then(data => {
                if (data.status === 'success') {
                    showNotification('success', data.message);
                    loadCategories();
                } else {
                    showNotification('error', data.message);
                }
            });
        }
    }

    function showCategoryModal(mode, categoryId = null) {
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h2>${mode === 'edit' ? 'Edit' : 'Add'} Category</h2>
                    <button class="close-modal">&times;</button>
                </div>
                <div class="modal-body">
                    <form id="category-form">
                        <div class="form-group">
                            <label>Name</label>
                            <input type="text" id="category-name" required>
                        </div>
                        <div class="form-group">
                            <label>Icon</label>
                            <select id="category-icon">
                                <option value="fa-folder">📁 Folder</option>
                                <option value="fa-home">🏠 Home</option>
                                <option value="fa-chart-line">📈 Chart</option>
                                <option value="fa-network-wired">🌐 Network</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label>Description</label>
                            <input type="text" id="category-description">
                        </div>
                        <div class="form-group">
                            <label>Containers</label>
                            <input type="text" id="container-search" placeholder="Search containers...">
                            <div class="container-selection">
                                <div class="selection-header">
                                    <button type="button" class="select-all-btn">Select All</button>
                                    <button type="button" class="deselect-all-btn">Deselect All</button>
                                </div>
                                <div class="container-list" id="container-list">
                                    <!-- Container-Checkboxen werden hier dynamisch eingefügt -->
                                </div>
                            </div>
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button class="save-btn">Save</button>
                    <button class="cancel-btn">Cancel</button>
                </div>
            </div>
        `;

        // Füge CSS-Styles für die verbesserte Container-Auswahl hinzu
        const style = document.createElement('style');
        style.textContent = `
            #container-search {
                width: 100%;
                padding: 8px;
                margin-bottom: 8px;
                border: 1px solid var(--border-color);
                border-radius: 4px;
            }
            
            .container-selection {
                border: 1px solid var(--border-color);
                border-radius: 4px;
                max-height: 300px;
                overflow-y: auto;
            }
            
            .selection-header {
                padding: 8px;
                border-bottom: 1px solid var(--border-color);
                display: flex;
                gap: 8px;
                position: sticky;
                top: 0;
                background: var(--background-color);
                z-index: 1;
            }
            
            .selection-header button {
                padding: 4px 8px;
                font-size: 12px;
                border-radius: 3px;
                border: 1px solid var(--border-color);
                background: var(--background-color);
                cursor: pointer;
            }
            
            .selection-header button:hover {
                background: var(--hover-color);
            }
            
            .container-list {
                padding: 8px;
            }
            
            .container-item {
                padding: 6px 8px;
                margin: 2px 0;
                border-radius: 4px;
                transition: background-color 0.2s;
            }
            
            .container-item:hover {
                background-color: var(--hover-color);
            }
            
            .container-item label {
                display: flex;
                align-items: center;
                gap: 8px;
                cursor: pointer;
            }
            
            .container-item input[type="checkbox"] {
                margin: 0;
                cursor: pointer;
            }
        `;
        document.head.appendChild(style);
        document.body.appendChild(modal);

        // Event-Listener für die Suche
        const searchInput = modal.querySelector('#container-search');
        searchInput.addEventListener('input', (e) => {
            const searchTerm = e.target.value.toLowerCase();
            modal.querySelectorAll('.container-item').forEach(item => {
                const containerName = item.querySelector('label').textContent.toLowerCase();
                item.style.display = containerName.includes(searchTerm) ? '' : 'none';
            });
        });

        // Event-Listener für Select/Deselect All
        modal.querySelector('.select-all-btn').addEventListener('click', () => {
            modal.querySelectorAll('.container-item input[type="checkbox"]').forEach(cb => cb.checked = true);
        });

        modal.querySelector('.deselect-all-btn').addEventListener('click', () => {
            modal.querySelectorAll('.container-item input[type="checkbox"]').forEach(cb => cb.checked = false);
        });

        // Event-Listener für Save-Button
        modal.querySelector('.save-btn').addEventListener('click', () => {
            saveCategory(categoryId);
        });

        // Event-Listener für Cancel-Button und Close-Button
        modal.querySelector('.cancel-btn').addEventListener('click', closeModal);
        modal.querySelector('.close-modal').addEventListener('click', closeModal);

        if (mode === 'edit' && categoryId) {
            fetch('/api/categories')
                .then(response => response.json())
                .then(data => {
                    const category = data.categories[categoryId];
                    if (!category) {
                        showErrorNotification('Category not found', 'Loading category');
                        closeModal();
                        return;
                    }
                    document.getElementById('category-name').value = category.name;
                    document.getElementById('category-icon').value = category.icon;
                    document.getElementById('category-description').value = category.description || '';
                    loadAvailableContainers(category.containers || []);
                })
                .catch(error => showErrorNotification(error, 'Loading category'));
        } else {
            loadAvailableContainers([]);
        }

        setTimeout(() => modal.classList.add('show'), 10);
    }

    function loadAvailableContainers(selectedContainers = []) {
        const containerList = document.getElementById('container-list');
        if (!containerList) {
            console.error('Container list element not found');
            return;
        }
        
        fetch('/api/containers')
            .then(response => response.json())
            .then(data => {
                containerList.innerHTML = '';
                
                const allContainers = new Set();
                Object.values(data).forEach(group => {
                    group.containers.forEach(container => {
                        allContainers.add(container.name);
                    });
                });
                
                Array.from(allContainers).sort().forEach(container => {
                    const item = document.createElement('div');
                    item.className = 'container-item';
                    item.innerHTML = `
                        <label>
                            <input type="checkbox" 
                                   name="containers" 
                                   value="${container}"
                                   ${selectedContainers.includes(container) ? 'checked' : ''}>
                            ${container}
                        </label>
                    `;
                    containerList.appendChild(item);
                });
            })
            .catch(error => {
                console.error('Error loading containers:', error);
                showNotification('error', 'Failed to load containers');
            });
    }

    function saveCategory(categoryId) {
        const formData = {
            name: document.getElementById('category-name').value,
            icon: document.getElementById('category-icon').value,
            description: document.getElementById('category-description').value,
            containers: Array.from(document.querySelectorAll('.container-item input[type="checkbox"]:checked'))
                .map(cb => cb.value)
        };
        
        const method = categoryId ? 'PUT' : 'POST';
        const url = '/api/categories' + (categoryId ? `/${categoryId}` : '');
        
        fetch(url, {
            method: method,
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(formData)
        })
        .then(response => response.json())
        .then(data => {
            if (data.status === 'success') {
                showNotification('success', `Category ${categoryId ? 'updated' : 'added'} successfully`);
                closeModal();
                // Aktualisiere Container-Status mit Loading-Anzeige
                updateContainerStatus(true);
                // Aktualisiere die Kategorien-Liste
                loadCategories();
                // Erzwinge eine sofortige Aktualisierung des Caches
                fetch('/api/categories/refresh', { method: 'POST' })
                    .catch(error => console.error('Error refreshing categories:', error));
            } else {
                throw new Error(data.message || 'Failed to save category');
            }
        })
        .catch(error => {
            console.error('Error:', error);
            showNotification('error', error.message);
        });
    }

    // Initial load
    loadCategories();

    // Event-Listener für alle Modal-Schließen-Buttons
    document.querySelectorAll('.close-modal').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const modal = e.target.closest('.modal');
            closeModal(modal.id);
        });
    });

    // Drag & Drop Funktionen
    function handleDragStart(e) {
        e.target.classList.add('dragging');
        e.dataTransfer.setData('application/json', JSON.stringify({
            type: 'category',
            id: e.target.dataset.id
        }));
    }

    function handleDragEnd(e) {
        e.target.classList.remove('dragging');
        document.querySelectorAll('.category-item, .category').forEach(item => {
            item.classList.remove('drag-over');
        });
    }

    function handleDragOver(e) {
        e.preventDefault();
    }

    function handleDragEnter(e) {
        e.preventDefault();
        const target = e.target.closest('.category-item') || e.target.closest('.category');
        target?.classList.add('drag-over');
    }

    function handleDragLeave(e) {
        const target = e.target.closest('.category-item') || e.target.closest('.category');
        target?.classList.remove('drag-over');
    }

    // Mache die Drag & Drop-Funktionen global verfügbar
    window.handleContainerDragStart = function(e, containerName, categoryId) {
        // Finde die Container-Karte und das Container-Grid
        const containerCard = e.target.closest('.container-card');
        const containerGrid = containerCard.closest('.container-grid');
        
        // Füge die DOM-Position des Elements hinzu, um Sortierung innerhalb einer Kategorie zu ermöglichen
        const containerCards = Array.from(containerGrid.querySelectorAll('.container-card'));
        const position = containerCards.indexOf(containerCard);
        
        // Speichere die Kategorie-ID und den Gruppen-Namen
        const groupSection = containerGrid.closest('.group-section');
        const groupName = groupSection ? groupSection.querySelector('h2').textContent.trim() : '';
        
        console.log('Drag Start:', {
            container: containerName,
            position: position,
            group: groupName
        });
        
        e.dataTransfer.setData('application/json', JSON.stringify({
            type: 'container',
            name: containerName,
            sourceCategoryId: categoryId || groupName,
            position: position,
            groupName: groupName
        }));
        
        containerCard.classList.add('dragging');
    };

    window.handleContainerDragEnd = function(e) {
        e.target.classList.remove('dragging');
        document.querySelectorAll('.category').forEach(category => {
            category.classList.remove('drag-over');
        });
        // Entferne auch die drag-over-Klasse von allen Container-Karten
        document.querySelectorAll('.container-card').forEach(card => {
            card.classList.remove('drag-over');
        });
    };
    
    // Neue globale Handler für Container-Karten
    window.handleContainerDragOver = function(e) {
        e.preventDefault();
        e.stopPropagation();
    };
    
    window.handleContainerDragEnter = function(e) {
        e.preventDefault();
        e.stopPropagation();
        const containerCard = e.target.closest('.container-card');
        if (containerCard) {
            containerCard.classList.add('drag-over');
        }
    };
    
    window.handleContainerDragLeave = function(e) {
        const containerCard = e.target.closest('.container-card');
        if (containerCard && !containerCard.contains(e.relatedTarget)) {
            containerCard.classList.remove('drag-over');
        }
    };
    
    window.handleContainerDrop = function(e) {
        e.preventDefault();
        e.stopPropagation();
        
        try {
            const jsonData = e.dataTransfer.getData('application/json');
            if (!jsonData) {
                console.warn('Keine drag & drop Daten erhalten');
                return;
            }
            
            const data = JSON.parse(jsonData);
            if (!data || data.type !== 'container') {
                console.warn('Nur Container können auf Gruppen gezogen werden');
                return;
            }
            
            // Finde das Drop-Ziel und die Gruppe
            const dropTarget = e.target.closest('.container-card');
            const groupSection = e.target.closest('.group-section');
            
            if (!groupSection) {
                console.error('Keine Gruppe gefunden für Drop-Target:', e.target);
                showNotification('error', 'Konnte keine Zielgruppe finden');
                return;
            }
            
            // Hole den Gruppen-Namen und die Kategorie-ID aus der Gruppe
            const groupNameElement = groupSection.querySelector('h2');
            if (!groupNameElement) {
                console.error('Konnte keinen h2-Header in der Gruppe finden');
                return;
            }
            
            const groupName = groupNameElement.textContent.trim();
            if (!groupName) {
                console.error('Gruppenelement hat keinen Text');
                return;
            }
            
            // Hole die Kategorie-ID aus dem data-category-id Attribut oder verwende den Gruppennamen als Fallback
            const categoryId = groupSection.getAttribute('data-category-id') || groupName;
            console.log('Gefundene Gruppe:', groupName, 'Kategorie-ID:', categoryId);
            
            // Stelle sicher, dass wir eine valide sourceCategoryId haben
            const sourceCategoryId = data.sourceCategoryId || data.groupName || 'Imported';
            
            // Finde das Container-Grid
            const containerGrid = groupSection.querySelector('.container-grid');
            if (!containerGrid) {
                console.error('Kein Container-Grid in der Gruppe gefunden');
                return;
            }
            
            // Zeige visuelles Feedback an, dass eine Aktion im Gange ist
            const loadingOverlay = document.getElementById('loading-overlay');
            if (loadingOverlay) loadingOverlay.style.display = 'flex';
            
            if (dropTarget) {
                // Drop auf eine Container-Karte
                const allCards = Array.from(containerGrid.querySelectorAll('.container-card'));
                const targetPosition = allCards.indexOf(dropTarget);
                
                // Stelle sicher, dass eine gültige Position verwendet wird
                const fromPosition = typeof data.position === 'number' && data.position >= 0 ? data.position : -1;
                
                console.log('Drop auf Container-Karte:', {
                    container: data.name,
                    fromGroup: data.groupName,
                    fromCategory: sourceCategoryId,
                    toGroup: groupName,
                    toCategory: categoryId,
                    fromPosition: fromPosition,
                    toPosition: targetPosition
                });
                
                try {
                    if (data.groupName !== groupName) {
                        // Container in eine andere Gruppe verschieben
                        moveContainer(data.name, sourceCategoryId, categoryId, targetPosition);
                    } else if (targetPosition !== fromPosition && targetPosition !== -1) {
                        // Finde die tatsächliche Position im DOM
                        const actualFromPosition = findActualContainerPosition(data.name, categoryId);
                        // Container innerhalb der gleichen Gruppe neu anordnen
                        reorderContainer(data.name, categoryId, actualFromPosition, targetPosition);
                    } else {
                        // Wenn keine Aktion ausgeführt wird, verstecke Loading-Anzeige
                        if (loadingOverlay) loadingOverlay.style.display = 'none';
                    }
                } catch (error) {
                    console.error('Fehler beim Drop-Handling:', error);
                    if (loadingOverlay) loadingOverlay.style.display = 'none';
                }
            } else {
                // Drop direkt auf eine Gruppe (nicht auf eine Karte)
                console.log('Drop direkt auf Gruppe:', {
                    container: data.name,
                    fromGroup: data.groupName,
                    fromCategory: sourceCategoryId,
                    toGroup: groupName,
                    toCategory: categoryId
                });
                
                try {
                    if (data.groupName !== groupName) {
                        // Container in eine andere Gruppe verschieben
                        moveContainer(data.name, sourceCategoryId, categoryId);
                    } else {
                        // Wenn keine Aktion ausgeführt wird, verstecke Loading-Anzeige
                        if (loadingOverlay) loadingOverlay.style.display = 'none';
                    }
                } catch (error) {
                    console.error('Fehler beim Drop auf Gruppe:', error);
                    if (loadingOverlay) loadingOverlay.style.display = 'none';
                }
            }
            
            // Entferne die Hervorhebung von allen Karten
            document.querySelectorAll('.container-card').forEach(card => {
                card.classList.remove('drag-over');
            });
        } catch (error) {
            console.error('Fehler beim Drop-Handling:', error);
            showNotification('error', `Fehler beim Verschieben: ${error.message}`);
            
            // Verstecke Loading-Anzeige im Fehlerfall
            const loadingOverlay = document.getElementById('loading-overlay');
            if (loadingOverlay) loadingOverlay.style.display = 'none';
        }
    };

    async function moveContainer(containerName, sourceCategoryId, targetCategoryId, targetPosition = -1) {
        try {
            // Stelle sicher, dass die sourceCategory immer definiert ist
            // Verwende 'Imported' als Fallback, wenn keine Quellkategorie angegeben wurde
            const sourceCategory = sourceCategoryId || 'Imported';
            
            console.log('API Anfrage: Container verschieben', {
                containerName,
                sourceCategory,
                targetCategory: targetCategoryId,
                targetPosition
            });
            
            const response = await fetch('/api/container/move', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    containerName: containerName,
                    sourceCategory: sourceCategory,
                    targetCategory: targetCategoryId,
                    targetPosition: targetPosition
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Fehler beim Verschieben des Containers');
            }

            // Force-Refresh aller Daten
            loadCategories(true);
            loadContainers(true);
            showNotification('success', `Container ${containerName} wurde in die Kategorie ${targetCategoryId} verschoben`);
        } catch (error) {
            console.error('Error moving container:', error);
            showNotification('error', `Fehler beim Verschieben des Containers: ${error.message}`);
        }
    }
    
    // Hilfsfunktion zum Finden der tatsächlichen Position eines Containers im DOM
    function findActualContainerPosition(containerName, categoryId) {
        // Suche nach passenden Kategoriesektionen, sowohl via data-category-id als auch nach Text
        const allCategorySections = Array.from(document.querySelectorAll('.group-section, .category-section'));
        const categorySection = allCategorySections.find(section => {
            if (section.getAttribute('data-category-id') === categoryId) return true;
            const header = section.querySelector('h2');
            return header && header.textContent.trim() === categoryId;
        });
        
        if (!categorySection) {
            console.warn(`Konnte keine Kategorie '${categoryId}' im DOM finden`);
            return -1;
        }
        
        // Suche nach Container-Grid innerhalb der Kategorie
        const containerGrid = categorySection.querySelector('.container-grid');
        if (!containerGrid) {
            console.warn(`Konnte kein Container-Grid in Kategorie '${categoryId}' finden`);
            return -1;
        }
        
        // Sammle alle Container-Karten
        const containerCards = Array.from(containerGrid.querySelectorAll('.container-card'));
        console.log(`Suche nach Position von '${containerName}' in Kategorie '${categoryId}', gefunden ${containerCards.length} Karten`);
        
        // Suche nach der Position des Containers
        for (let i = 0; i < containerCards.length; i++) {
            const cardName = containerCards[i].getAttribute('data-name');
            console.log(`  Karte ${i}: Name=${cardName}`);
            
            if (cardName === containerName) {
                console.log(`  ✓ Container '${containerName}' gefunden an Position ${i} in Kategorie '${categoryId}'`);
                return i;
            }
        }
        
        console.warn(`Container '${containerName}' nicht in Kategorie '${categoryId}' gefunden`);
        return -1;
    }

    async function reorderContainer(containerName, categoryId, fromPosition, toPosition) {
        // Zeige das Loading-Overlay an
        const loadingOverlay = document.getElementById('loading-overlay');
        if (loadingOverlay) loadingOverlay.style.display = 'flex';
        
        try {
            // Protokolliere die Anfrage mit Details für Debugging
            console.log(`reorderContainer aufgerufen: Container '${containerName}' in Kategorie '${categoryId}'`);
            console.log(`  Von Position ${fromPosition} nach Position ${toPosition}`);
            
            // Zeige UI-Feedback an, dass etwas passiert
            showNotification('info', `Container ${containerName} wird verschoben...`, 1000);
            
            // Bestimme tatsächliche Positionen
            let actualFromPosition = fromPosition;
            let actualToPosition = toPosition;
            
            // Wenn fromPosition ungültig ist, finde die tatsächliche Position im DOM
            if (actualFromPosition < 0 || isNaN(actualFromPosition)) {
                actualFromPosition = findActualContainerPosition(containerName, categoryId);
            }
            
            console.log(`Sende Container-Neuordnung zum Server: ${containerName} von ${actualFromPosition} nach ${actualToPosition}`);
            
            // Sende die Anfrage zum Server mit den korrigierten Positionen
            // Wir verlassen uns jetzt primär auf den Container-Namen anstatt auf Positionen
            const response = await fetch('/api/container/reorder', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    containerName: containerName,  // Der Name des zu verschiebenden Containers (Primärschlüssel)
                    categoryId: categoryId,       // Die Kategorie-ID
                    fromPosition: actualFromPosition, // Korrigierte tatsächliche Startposition
                    toPosition: actualToPosition   // Zielposition
                })
            });

            let result;
            try {
                result = await response.json();
            } catch (parseError) {
                console.error('Fehler beim Parsen der Serverantwort:', parseError);
                throw new Error('Ungültige Serverantwort');
            }
            
            if (!response.ok) {
                throw new Error(result.error || 'Failed to reorder container');
            }

            console.log('Container erfolgreich verschoben, lade nun UI-Daten neu');
            
            // Verzögerung hinzufügen, um sicherzustellen, dass der Server die Änderung verarbeitet hat
            await new Promise(resolve => setTimeout(resolve, 300));
            
            // Lade nur die Kategorien statt der gesamten Seite neu
            loadCategories(true); // Force-Refresh, um sicherzustellen, dass wir die neuesten Daten erhalten
            
            showNotification('success', `Container ${containerName} wurde neu angeordnet`);
        } catch (error) {
            console.error('Error reordering container:', error);
            showNotification('error', `Fehler beim Neuanordnen des Containers: ${error.message}`);
        } finally {
            // Verstecke das Loading-Overlay, unabhängig vom Ergebnis
            if (loadingOverlay) loadingOverlay.style.display = 'none';
        }
    }

    function handleDrop(e) {
        e.preventDefault();
        const data = e.dataTransfer.getData('application/json');
        if (!data) return;

        const droppedItem = JSON.parse(data);
        
        if (droppedItem.type === 'category') {
            const dropTarget = e.target.closest('.category-item');
            if (dropTarget && droppedItem.id !== dropTarget.dataset.id) {
                const categoryList = document.querySelector('.category-list');
                const items = Array.from(categoryList.children);
                const draggedItem = items.find(item => item.dataset.id === droppedItem.id);
                const dropIndex = items.indexOf(dropTarget);
                
                categoryList.removeChild(draggedItem);
                categoryList.insertBefore(draggedItem, dropTarget);
                
                // Speichere neue Reihenfolge
                updateCategoryOrder();
            }
            dropTarget?.classList.remove('drag-over');
        } else if (droppedItem.type === 'container') {
            const dropZone = e.target.closest('.category');
            if (dropZone) {
                const targetCategoryId = dropZone.getAttribute('data-id');
                
                // Bestimme die Zielposition, wenn auf eine Container-Karte gedroppt wurde
                let targetPosition = -1;
                const dropContainerCard = e.target.closest('.container-card');
                
                if (dropContainerCard) {
                    const containerGrid = dropContainerCard.closest('.container-grid');
                    const allCards = Array.from(containerGrid.querySelectorAll('.container-card'));
                    targetPosition = allCards.indexOf(dropContainerCard);
                }
                
                if (droppedItem.sourceCategoryId !== targetCategoryId) {
                    // Container in eine andere Kategorie verschieben
                    moveContainer(droppedItem.name, droppedItem.sourceCategoryId, targetCategoryId, targetPosition);
                } else if (targetPosition !== -1 && targetPosition !== droppedItem.position) {
                    // Container innerhalb der gleichen Kategorie neu anordnen
                    reorderContainer(droppedItem.name, targetCategoryId, droppedItem.position, targetPosition);
                }
                
                dropZone.classList.remove('drag-over');
            }
        }
    }

    function updateCategoryOrder() {
        const categories = {};
        document.querySelectorAll('.category-item').forEach((item, index) => {
            categories[item.dataset.id] = { position: index };
        });
        
        fetch('/api/categories/order', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(categories)
        })
        .then(response => response.json())
        .then(data => {
            if (data.status === 'success') {
                showNotification('success', 'Category order updated');
            } else {
                showNotification('error', data.message);
            }
        });
    }

    // Terminal & File Explorer Funktionen
    window.connectToServer = async function() {
        try {
            const type = document.getElementById('connection-type').value;
            const host = document.getElementById('host').value;
            const port = document.getElementById('port').value;
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;

            const response = await fetch('/api/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type, host, port, username, password })
            });

            const data = await response.json();
            if (data.status === 'success') {
                sshConnection = data.connection;
                document.querySelector('.connection-info').textContent = `Connected to ${username}@${host}`;
                
                if (type === 'ssh') {
                    document.querySelector('.terminal-container').style.display = 'block';
                    document.querySelector('.file-explorer').style.display = 'none';
                    initializeTerminal();
                } else {
                    // Füge Overlay hinzu und zeige Explorer
                    const overlay = document.createElement('div');
                    overlay.className = 'explorer-overlay';
                    overlay.onclick = closeFileExplorer;
                    document.body.appendChild(overlay);
                    
                    document.querySelector('.terminal-container').style.display = 'none';
                    document.querySelector('.file-explorer').style.display = 'block';
                    loadFileList(currentPath);
                }
                showNotification('success', 'Connected successfully');
            } else {
                throw new Error(data.message || 'Connection failed');
            }
        } catch (error) {
            console.error('Connection error:', error);
            showNotification('error', error.message || 'Connection failed');
        }
    };

    function disconnectFromServer() {
        fetch('/api/disconnect', { method: 'POST' })
            .then(() => {
                sshConnection = null;
                document.querySelector('.terminal-container').style.display = 'none';
                document.querySelector('.file-explorer').style.display = 'none';
                showNotification('success', 'Disconnected from server');
            });
    }

    // Cron Job Editor Funktionen
    function updateSchedulePreview() {
        const shutdownTime = document.getElementById('shutdown-time').value;
        const wakeupTime = document.getElementById('wakeup-time').value;
        
        if (shutdownTime && wakeupTime) {
            document.getElementById('shutdown-preview').textContent = shutdownTime;
            document.getElementById('wakeup-preview').textContent = wakeupTime;
            
            // Berechne Downtime
            const shutdown = new Date(`2000/01/01 ${shutdownTime}`);
            const wakeup = new Date(`2000/01/01 ${wakeupTime}`);
            let diff = wakeup - shutdown;
            if (diff < 0) diff += 24 * 60 * 60 * 1000; // Füge 24 Stunden hinzu wenn wakeup am nächsten Tag
            
            const hours = Math.floor(diff / (60 * 60 * 1000));
            const minutes = Math.floor((diff % (60 * 60 * 1000)) / (60 * 1000));
            document.getElementById('downtime-preview').textContent = 
                `${hours} hours ${minutes} minutes`;
        }
    }

    async function scheduleShutdown() {
        const hostIp = document.getElementById('host-ip').value;
        const hostUser = document.getElementById('host-user').value;
        const hostPassword = document.getElementById('host-password').value;
        const shutdownTime = document.getElementById('shutdown-time').value;
        const wakeupTime = document.getElementById('wakeup-time').value;

        if (!hostIp || !hostUser || !hostPassword) {
            showNotification('error', 'Please enter host credentials');
            return;
        }
        
        if (!shutdownTime || !wakeupTime) {
            showNotification('error', 'Please select both shutdown and wake-up times');
            return;
        }
        
        try {
            const response = await fetch('/api/schedule-shutdown', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    hostIp,
                    hostUser,
                    hostPassword,
                    shutdownTime, 
                    wakeupTime 
                })
            });
            
            const data = await response.json();
            if (data.status === 'success') {
                showNotification('success', 'Shutdown schedule created');
                await updateScheduleStatus();  // Warte auf die Aktualisierung
            } else {
                throw new Error(data.message);
            }
        } catch (error) {
            showNotification('error', `Failed to create schedule: ${error.message}`);
        }
    }

    window.updateScheduleStatus = async function() {
        try {
            // Hole DOM-Elemente
            const scheduleList = document.getElementById('schedule-list');
            const scheduleCount = document.getElementById('schedule-count');
            const nextShutdown = document.getElementById('next-shutdown');
            const nextWakeup = document.getElementById('next-wakeup');
            
            // Prüfe ob die Elemente existieren
            if (!scheduleList || !scheduleCount || !nextShutdown || !nextWakeup) {
                console.error('Required schedule elements not found');
                return;
            }
            
            const response = await fetch('/api/crontabs');
            const data = await response.json();
            
            if (data.error) {
                scheduleList.innerHTML = '<p class="empty-message">Please configure and test your host connection first</p>';
                scheduleCount.textContent = '0';
                nextShutdown.textContent = 'Not scheduled';
                nextWakeup.textContent = 'Not scheduled';
                return;
            }
            
            // Aktualisiere die Anzahl der aktiven Schedules
            scheduleCount.textContent = data.jobs.length;
            
            // Sortiere Jobs nach Shutdown-Zeit
            const sortedJobs = data.jobs.sort((a, b) => 
                a.shutdown_time.localeCompare(b.shutdown_time)
            );
            
            // Aktualisiere nächste Shutdown/Wakeup Zeit
            if (sortedJobs.length > 0) {
                nextShutdown.textContent = sortedJobs[0].shutdown_time;
                nextWakeup.textContent = sortedJobs[0].wakeup_time;
            } else {
                nextShutdown.textContent = 'Not scheduled';
                nextWakeup.textContent = 'Not scheduled';
            }
            
            // Aktualisiere die Liste der aktiven Schedules
            scheduleList.innerHTML = sortedJobs.map(job => `
                <div class="schedule-item">
                    <div class="schedule-info">
                        <span>
                            <i class="fa fa-power-off"></i>
                            Shutdown: ${job.shutdown_time}
                        </span>
                        <span>
                            <i class="fa fa-clock-o"></i>
                            Wake up: ${job.wakeup_time}
                        </span>
                        <span>
                            <i class="fa fa-hourglass-half"></i>
                            Duration: ${job.duration}h
                        </span>
                    </div>
                    <button class="delete-btn" onclick="deleteSchedule('${job.id}')">
                        <i class="fa fa-trash"></i>
                    </button>
                </div>
            `).join('') || '<p class="empty-message">No active schedules</p>';
            
        } catch (error) {
            console.error('Error updating schedule status:', error);
            showNotification('error', `Failed to update schedule status: ${error.message}`);
        }
    }

    // Entferne die zusätzliche Zuweisung, da die Funktion bereits global ist
    document.addEventListener('DOMContentLoaded', () => {
        updateScheduleStatus();
    });

    // Event Listener für Zeit-Inputs
    document.getElementById('shutdown-time')?.addEventListener('change', updateSchedulePreview);
    document.getElementById('wakeup-time')?.addEventListener('change', updateSchedulePreview);

    initializeCategoryEditor();

    document.getElementById('shutdown-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        await scheduleShutdown();
        updateScheduleStatus();  // Aktualisiere nach dem Scheduling
    });

    // Optional: Aktualisiere auch bei Änderungen der Credentials
    document.getElementById('host-password')?.addEventListener('change', updateScheduleStatus);

    // Event-Listener für Test Connection Button
    document.getElementById('test-connection')?.addEventListener('click', async () => {
        const hostIp = document.getElementById('host-ip').value;
        const hostUser = document.getElementById('host-user').value;
        const hostPassword = document.getElementById('host-password').value;
        
        if (!hostIp || !hostUser || !hostPassword) {
            showNotification('error', 'Please enter all credentials');
            return;
        }
        
        try {
            const response = await fetch('/api/host-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ hostIp, hostUser, hostPassword })
            });
            
            const data = await response.json();
            if (data.status === 'success') {
                showNotification('success', 'Connection successful');
                updateScheduleStatus();  // Aktualisiere die Schedule-Anzeige
            } else {
                throw new Error(data.message);
            }
        } catch (error) {
            showNotification('error', `Connection failed: ${error.message}`);
        }
    });

    // Ersetze die bestehende initializeImportTabs Funktion
    function initializeImportTabs() {
        // Warte bis die DOM-Elemente existieren
        const tabButtons = document.querySelectorAll('.import-tabs .tab-btn');
        const tabContents = document.querySelectorAll('.section-content .tab-content');
        
        if (!tabButtons.length || !tabContents.length) {
            // Wenn die Elemente noch nicht existieren, versuche es später erneut
            setTimeout(initializeImportTabs, 100);
            return;
        }
        
        tabButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation(); // Verhindert Bubble-up zum Section Toggle
                
                // Entferne active Klasse von allen Buttons und Contents
                tabButtons.forEach(btn => btn.classList.remove('active'));
                tabContents.forEach(content => content.classList.add('hidden'));
                
                // Füge active Klasse zum geklickten Button hinzu
                button.classList.add('active');
                
                // Zeige entsprechenden Content
                const tabId = button.getAttribute('data-tab');
                const content = document.getElementById(tabId + '-tab');
                if (content) {
                    content.classList.remove('hidden');
                }
            });
        });
    }

    // Bestehende toggleSection Funktion aktualisieren (nur die Implementierung ändern, nicht die Position)
    function toggleSection(header) {
        const content = header.nextElementSibling;
        const icon = header.querySelector('.fa-chevron-down');
        
        if (content.style.display === 'none') {
            content.style.display = 'block';
            icon.style.transform = 'rotate(180deg)';
            // Initialisiere Tabs wenn Section geöffnet wird
            if (content.querySelector('.import-tabs')) {
                setTimeout(initializeImportTabs, 100); // Verzögerung hinzugefügt
            }
        } else {
            content.style.display = 'none';
            icon.style.transform = 'rotate(0deg)';
        }
    }

    // Initialisierung für Import-Tabs
    function initializeOnLoad() {
        // Initialisiere Header-Tabs
        if (typeof initializeHeaderTabs === 'function') {
            initializeHeaderTabs();
        }
        
        // Initialisiere Import-Tabs nur wenn die Section bereits offen ist
        const importSection = document.querySelector('.import-tabs');
        if (importSection && importSection.offsetParent !== null && typeof initializeImportTabs === 'function') {
            initializeImportTabs();
        }
    }
    
    // Führe die Initialisierung aus
    initializeOnLoad();
});
// Container control functions
function installContainer(name) {
    const button = event.target;
    button.disabled = true;
    button.originalHTML = button.innerHTML; // Speichern des ursprünglichen Button-Textes
    button.innerHTML = '<i class="fa fa-spinner fa-spin"></i>';

    // Hole zuerst den Data Location Pfad aus den Settings
    fetch('/api/settings/data-location')
        .then(response => response.json())
        .then(settings => {
            const dataLocation = settings.location || '/home/The-BangerTECH-Utility-main/webdock-data';
            
            // Zeige Installations-Dialog mit Konfigurationsoptionen
            showInstallModal(name, dataLocation);
        })
        .catch(error => {
            console.error('Error:', error);
            showNotification('error', `Error getting data location for ${name}`);
            button.disabled = false;
            button.innerHTML = 'Install';
        });
}

async function showInstallModal(containerName) {
    try {
        // Normalisiere den Container-Namen für die API-Anfrage
        const apiContainerName = containerName === 'mosquitto' ? 'mosquitto-broker' : containerName;
        
        // Hole Netzwerkinformationen für WatchYourLAN
        let networkInterface = 'eth0';
        let ipRange = '192.168.1.0/24';
        
        if (containerName === 'watchyourlan' || containerName === 'watchyourlanarm') {
            try {
                const networkResponse = await fetch('/api/network-info');
                if (networkResponse.ok) {
                    const networkData = await networkResponse.json();
                    console.log("Network info from server:", networkData);
                    
                    if (networkData.interface) {
                        networkInterface = networkData.interface;
                    }
                    
                    if (networkData.ip_range) {
                        ipRange = networkData.ip_range;
                    } else if (networkData.client_ip && networkData.client_ip !== "127.0.0.1" && networkData.client_ip !== "::1") {
                        // Verwende die Client-IP vom Server
                        const ipParts = networkData.client_ip.split('.');
                        if (ipParts.length === 4) {
                            ipRange = `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}.0/24`;
                        }
                    }
                }
            } catch (error) {
                console.error("Error fetching network info:", error);
            }
        }
        
        // Hole Template-Konfiguration
        const response = await fetch(`/api/container/${apiContainerName}/config?template=true`);
        if (!response.ok) {
            throw new Error(`Failed to load config: ${response.status}`);
        }
        const config = await response.json();
        
        if (!config.yaml) {
            throw new Error('No YAML configuration received');
        }

        // Parse YAML für Environment-Variablen und Ports
        const yamlConfig = jsyaml.load(config.yaml);
        
        // Prüfe ob es ein gültiges Service-Objekt ist
        if (!yamlConfig || typeof yamlConfig !== 'object') {
            throw new Error('Invalid YAML configuration');
        }

        // Extrahiere das erste Service aus der Compose-Datei
        let service = config.service;
        if (!service && yamlConfig.services) {
            // Fallback: Extrahiere das erste Service aus dem geparsten YAML
            const serviceName = Object.keys(yamlConfig.services)[0];
            service = yamlConfig.services[serviceName];
        }
        
        if (!service) {
            throw new Error('No service configuration found in YAML');
        }
        
        // Extrahiere Ports und Environment-Variablen
        const ports = service.ports || [];
        const environment = service.environment || {};
        
        // Erstelle Modal
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.id = 'installModal';
        
        // Bestimme, ob die Port-Konfiguration angezeigt werden soll
        // Für WatchYourLAN nicht anzeigen, da wir spezifische Port-Felder haben
        const showPortConfig = !(containerName === 'watchyourlan' || containerName === 'watchyourlanarm');
        
        // Spezielle Felder für verschiedene Container
        let additionalFields = '';
        
        // Erstelle Modal-Inhalt
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h2><i class="fa fa-download"></i> Install ${containerName}</h2>
                    <button class="close-modal">&times;</button>
                </div>
                <div class="modal-body">
                    ${showPortConfig && ports.length > 0 ? `
                        <div class="config-section" style="margin-bottom: 20px; padding: 15px; background: var(--color-background-dark); border-radius: 8px;">
                            <h3 style="margin-bottom: 15px;">Port Configuration</h3>
                            <div class="port-mappings">
                                ${createPortMappings(ports)}
                            </div>
                        </div>
                    ` : ''}
                    ${Object.keys(environment).length > 0 ? `
                        <div class="config-section" style="margin-bottom: 20px; padding: 15px; background: var(--color-background-dark); border-radius: 8px;">
                            <h3 style="margin-bottom: 15px;">Environment Variables</h3>
                            <div class="env-vars">
                                ${createEnvironmentVars(environment)}
                            </div>
                        </div>
                    ` : ''}
                    ${containerName === 'watchyourlan' || containerName === 'watchyourlanarm' ? `
                        <div class="watchyourlan-section" style="margin-bottom: 20px; padding: 15px; background: var(--color-background-dark); border-radius: 8px;">
                            <h3 style="margin-bottom: 15px;">WatchYourLAN Settings</h3>
                            <div class="form-group">
                                <label for="network-interface">Network Interface</label>
                                <input type="text" id="network-interface" name="network-interface" value="${networkInterface}" placeholder="Enter network interface" class="form-control">
                                <small class="hint">The network interface to monitor (e.g. eth0, ens18)</small>
                            </div>
                            <div class="form-group">
                                <label for="ip-range">IP Range</label>
                                <input type="text" id="ip-range" name="ip-range" value="${ipRange}" placeholder="Enter IP range" class="form-control">
                                <small class="hint">The IP range to scan (e.g. 192.168.1.0/24)</small>
                            </div>
                            <div class="form-group">
                                <label for="wyl-port">WatchYourLAN GUI Port</label>
                                <input type="text" id="wyl-port" name="wyl-port" value="8840" placeholder="Enter port" class="form-control">
                                <small class="hint">The port for WatchYourLAN web interface (default: 8840)</small>
                            </div>
                            <div class="form-group">
                                <label for="bootstrap-port">Node-Bootstrap Port</label>
                                <input type="text" id="bootstrap-port" name="bootstrap-port" value="8850" placeholder="Enter port" class="form-control">
                                <small class="hint">The port for Node-Bootstrap service (default: 8850)</small>
                            </div>
                            <div class="alert alert-info" style="padding: 10px; background-color: #d1ecf1; color: #0c5460; border-radius: 4px; margin-top: 15px;">
                                <p><strong>Note:</strong> The network interface and IP range are automatically detected. Please verify they are correct for your network.</p>
                                <p><strong>Important:</strong> WatchYourLAN requires host network mode to properly scan your network. The main interface will be available at the GUI port specified above.</p>
                            </div>
                        </div>
                    ` : ''}
                    ${containerName === 'node-red' ? `
                        <div class="node-red-section" style="margin-bottom: 20px; padding: 15px; background: var(--color-background-dark); border-radius: 8px;">
                            <h3 style="margin-bottom: 15px;">Node-RED Information</h3>
                            <div class="alert alert-info" style="padding: 10px; background-color: #d1ecf1; color: #0c5460; border-radius: 4px; margin-top: 15px;">
                                <p><strong>Note:</strong> Node-RED is a powerful flow-based programming tool for connecting hardware devices, APIs and online services.</p>
                                <p>After installation, you can access the Node-RED editor at <strong>http://your-server-ip:[PORT]</strong>, where [PORT] is the value you specified in the Port Configuration section above.</p>
                            </div>
                        </div>
                    ` : ''}
                </div>
                <div class="modal-footer">
                    <button class="install-btn">Install</button>
                    <button class="cancel-btn">Cancel</button>
                </div>
            </div>
        `;

        // Event-Listener für Authentication Checkbox bei Mosquitto
        document.body.appendChild(modal);
        setTimeout(() => modal.classList.add('show'), 10);
        
        // Mosquitto Auth Checkbox
        const authCheckbox = modal.querySelector('#mqtt-auth');
        const authCredentials = modal.querySelector('.auth-credentials');
        if (authCheckbox) {
            authCheckbox.addEventListener('change', (e) => {
                authCredentials.style.display = e.target.checked ? 'block' : 'none';
            });
        }
        
        // InfluxDB Create DB Checkbox
        const influxdbCreateDb = modal.querySelector('#influxdb-create-db');
        const dbCredentials = modal.querySelector('.db-credentials');
        if (influxdbCreateDb) {
            influxdbCreateDb.addEventListener('change', (e) => {
                dbCredentials.style.display = e.target.checked ? 'block' : 'none';
            });
        }
        
        // Event-Listener für Buttons
        const installButton = modal.querySelector('.install-btn');
        const cancelButton = modal.querySelector('.cancel-btn');
        const closeButton = modal.querySelector('.close-modal');

        // Install-Button Event-Listener
        installButton.addEventListener('click', () => executeInstall(containerName));

        // Schließen-Funktionalität
        const handleClose = () => {
            // Finde alle Buttons, die auf diesen Container verweisen
            const containerButtons = document.querySelectorAll(`.install-btn`);
            containerButtons.forEach(btn => {
                if (btn.disabled && !btn.classList.contains('loading')) {
                    btn.disabled = false;
                    btn.innerHTML = btn.originalHTML || 'Install';
                }
            });
            closeModal(containerName);
        };
        
        cancelButton.addEventListener('click', handleClose);
        closeButton.addEventListener('click', handleClose);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) handleClose();
        });
    } catch (error) {
        console.error('Error:', error);
        showNotification('error', `Error preparing installation for ${containerName}`);
    }
}

// Hilfsfunktionen für Environment-Variablen
function getEnvPlaceholder(key) {
    const placeholders = {
        'TZ': 'Europe/Berlin',
        'PUID': '1000',
        'PGID': '1000'
    };
    return placeholders[key] || '';
}

function getEnvDescription(key) {
    const descriptions = {
        'TZ': '<small class="hint">Timezone for the container</small>',
        'PUID': '<small class="hint">User ID for container permissions</small>',
        'PGID': '<small class="hint">Group ID for container permissions</small>',
        // WatchYourLAN-spezifische Beschreibungen
        'NETWORK_INTERFACE': '<small class="hint">The network interface to monitor (e.g., eth0, wlan0). Use "ip addr" command to find your interface.</small>',
        'IP_RANGE': '<small class="hint">The IP range to scan (e.g., 192.168.1.0/24). Use your local network range.</small>',
        'SCAN_INTERVAL': '<small class="hint">Interval in seconds between network scans (default: 300)</small>',
        'NOTIFICATION_INTERVAL': '<small class="hint">Interval in seconds between notifications (default: 14400)</small>',
        'NOTIFICATION_TITLE': '<small class="hint">Title for notifications (default: "WatchYourLAN")</small>',
        'NOTIFICATION_BODY': '<small class="hint">Body text for notifications (default: "New device found on network: {NAME} ({IP})")</small>',
        // Filestash-spezifische Beschreibungen
        'APPLICATION_URL': '<small class="hint">The URL where Filestash will be accessible (e.g., http://your-server-ip:8334)</small>'
    };
    return descriptions[key] || '';
}

// Angepasste executeInstall Funktion
async function executeInstall(containerName) {
    try {
        // Zeige Loading-Overlay
        if (loadingOverlay) {
            loadingOverlay.style.display = 'flex';
        }

        // Deaktiviere den Install-Button und zeige Spinner
        const mainInstallButton = document.querySelector(`[data-container="${containerName}"] .install-btn`);
        if (mainInstallButton) {
            mainInstallButton.disabled = true;
            mainInstallButton.classList.add('loading');
            mainInstallButton.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Installing...';
        }
        
        // Schließe das Modal ohne den Button zurückzusetzen
        closeModal();

        // Sammle Formulardaten
        const installData = {
            name: containerName,
            path: `/app/config/compose-files/${containerName}`,
            ports: {},
            env: {},
            volumes: []  // Füge Volumes hinzu
        };

        // Füge Standard-Volumes basierend auf Container-Typ hinzu
        if (containerName === 'mosquitto-broker' || containerName === 'mosquitto') {
            installData.volumes = [
                `./config:/mosquitto/config`,
                `./data:/mosquitto/data`,
                `./log:/mosquitto/log`
            ];
            
            // Prüfe Authentifizierungseinstellungen für Mosquitto
            const authEnabled = document.getElementById('mqtt-auth')?.checked || false;
            const username = document.getElementById('mqtt-username')?.value || 'test';
            const password = document.getElementById('mqtt-password')?.value || 'test';
            
            // Füge Mosquitto-spezifische Konfiguration hinzu
            installData.mosquitto = {
                auth_enabled: authEnabled,
                username: username,
                password: password
            };
            
            // Debug-Logging
            console.log('=== Mosquitto Installation Config ===');
            console.log('Auth enabled:', authEnabled);
            console.log('Username:', username);
            console.log('Password:', password ? '********' : '');
            
            // Die Konfigurationsdatei wird vom Backend erstellt
            // Wir senden keine config_files mehr, um Konflikte zu vermeiden
        }
        // InfluxDB-spezifische Konfiguration
        else if (containerName === 'influxdb' || containerName === 'influxdb-arm' || containerName === 'influxdb-x86') {
            installData.volumes = [
                `./data:/var/lib/influxdb`
            ];
            
            // Prüfe Datenbankeinstellungen für InfluxDB
            const createDatabase = document.getElementById('influxdb-create-db')?.checked || false;
            const databaseName = document.getElementById('db-name')?.value || 'database1';
            const databaseUser = document.getElementById('db-user')?.value || 'user1';
            const databasePassword = document.getElementById('db-password')?.value || 'pwd12345';
            
            // Füge InfluxDB-spezifische Konfiguration hinzu
            installData.influxdb = {
                create_database: createDatabase,
                database_name: databaseName,
                database_user: databaseUser,
                database_password: databasePassword
            };
            
            // Debug-Logging
            console.log('=== InfluxDB Installation Config ===');
            console.log('Create Database:', createDatabase);
            console.log('Database Name:', databaseName);
            console.log('Database User:', databaseUser);
            console.log('Database Password:', databasePassword ? '********' : '');
        }
        // Dockge-spezifische Konfiguration
        else if (containerName === 'dockge') {
            installData.volumes = [
                `./data:/app/data`
            ];
            
            // Prüfe Stacks-Verzeichnis für Dockge
            const stacksDir = document.getElementById('stacks-dir')?.value || '/home/webDock/webdock-data';
            
            // Füge Dockge-spezifische Konfiguration hinzu
            installData.dockge = {
                stacks_dir: stacksDir
            };
            
            // Debug-Logging
            console.log('=== Dockge Installation Config ===');
            console.log('Stacks Directory:', stacksDir);
        }
        // WUD-spezifische Konfiguration
        else if (containerName === 'wud') {
            console.debug('WUD installation configuration');
            
            // Add Docker socket and data volume as strings in the correct format
            installData.volumes = [
                '/var/run/docker.sock:/var/run/docker.sock:ro',
                './data:/app/data'
            ];
            
            // Entferne die Umgebungsvariablen, da sie nicht funktionieren
            // installData.env = {
            //     'WUD_SERVER_PORT': '3000',
            //     'WUD_WATCHER_DOCKER': 'true',
            //     'WUD_WATCHER_DOCKER_WATCHALL': 'true',
            //     'WUD_WATCHER_LOCAL_WATCHALL': 'true',
            //     'WUD_REGISTRY_HUB_PUBLIC': 'true'
            // };
            
            console.debug('WUD configuration:', installData);
        }
        // Filestash-spezifische Konfiguration
        else if (containerName === 'filestash') {
            // Für Filestash werden keine speziellen Volumes oder Umgebungsvariablen benötigt,
            // da diese in der setup_filestash Funktion im Backend gesetzt werden
            
            // Debug-Logging
            console.log('=== Filestash Installation Config ===');
            console.log('Note: Filestash requires a two-step installation process');
            console.log('1. A temporary container will be started');
            console.log('2. User needs to create an admin password at http://[server-ip]:8334');
            console.log('3. User needs to run complete_setup.sh to finalize the installation');
        }
        // WatchYourLAN-spezifische Konfiguration
        else if (containerName === 'watchyourlan' || containerName === 'watchyourlanarm') {
            installData.volumes = [
                `./config:/config`,
                `./data:/data`
            ];
            
            // Hole Netzwerkschnittstelle und IP-Range
            const networkInterface = document.getElementById('network-interface')?.value || 'eth0';
            const ipRange = document.getElementById('ip-range')?.value || '192.168.1.0/24';
            const guiPort = document.getElementById('wyl-port')?.value || '8840';
            const bootstrapPort = document.getElementById('bootstrap-port')?.value || '8850';
            
            // Setze Umgebungsvariablen für WatchYourLAN
            installData.env = {
                'NETWORK_INTERFACE': networkInterface,
                'IP_RANGE': ipRange,
                'GUIPORT': guiPort  // Setze den GUI-Port auch als Umgebungsvariable
            };
            
            // Setze die Ports für WatchYourLAN
            installData.ports = {
                '8840': guiPort,
                '8850': bootstrapPort
            };
            
            // Speichere den dynamischen GUI-Port für die Anzeige auf der Karte
            installData.port = guiPort;
            
            // Debug-Logging
            console.log('=== WatchYourLAN Installation Config ===');
            console.log('Network Interface:', networkInterface);
            console.log('IP Range:', ipRange);
            console.log('GUI Port:', guiPort);
            console.log('Bootstrap Port:', bootstrapPort);
        }
        // Node-RED-spezifische Konfiguration
        else if (containerName === 'node-red') {
            installData.volumes = [
                `./data:/data`
            ];
            
            // Hole den Node-RED Port aus dem Port-Mapping-Feld
            // Suche nach dem Port-Input für den internen Port 1880
            const portInput = document.querySelector('input[data-internal-port="1880"]');
            const nodeRedPort = portInput?.value || '1880';
            
            // Setze Umgebungsvariablen für Node-RED
            installData.env = {
                'TZ': 'Europe/Berlin'
            };
            
            // Setze die Ports für Node-RED
            installData.ports = {
                '1880': nodeRedPort
            };
            
            // Speichere den dynamischen Port für die Anzeige auf der Karte
            installData.port = nodeRedPort;
            
            // Debug-Logging
            console.log('=== Node-RED Installation Config ===');
            console.log('Port:', nodeRedPort);
        }
        // Scrypted-spezifische Konfiguration
        else if (containerName === 'scrypted') {
            installData.volumes = [
                `./data:/server/volume`
            ];
            
            // Setze den Port für Scrypted (wird in der UI angezeigt, aber nicht in der docker-compose.yml verwendet)
            installData.ports = {
                '10443': '10443'
            };
            
            // Setze network_mode auf host
            installData.network_mode = 'host';
            
            // Debug-Logging
            console.log('=== Scrypted Installation Config ===');
            console.log('Volumes configured for Scrypted');
            console.log('Network mode set to host');
            console.log('Port 10443 will be used for HTTPS access');
        }
        // Prometheus-spezifische Konfiguration
        else if (containerName === 'prometheus') {
            installData.volumes = [
                `./prometheus:/etc/prometheus`,
                `./data:/prometheus`
            ];
            
            // Ermittle die Host-IP-Adresse für Prometheus
            const hostIP = window.location.hostname;
            
            // Füge die Host-IP-Adresse zur Konfiguration hinzu
            installData.prometheus = {
                host_ip: hostIP
            };
            
            // Debug-Logging
            console.log('=== Prometheus Installation Config ===');
            console.log('Host IP:', hostIP);
        }
        // Standard-Volumes für andere Container
        else {
            installData.volumes = [
                `./config:/config`,
                `./data:/data`
            ];
        }

        // Verarbeite Port-Mappings
        const portInputs = document.querySelectorAll('.modal .port-mapping input');
        if (portInputs.length > 0) {
            portInputs.forEach(input => {
                const containerPort = input.getAttribute('data-port');
                if (containerPort) {
                    installData.ports[containerPort] = input.value;
                }
            });
        }

        // Verarbeite Environment-Variablen
        const envInputs = document.querySelectorAll('.modal .env-var input');
        if (envInputs.length > 0) {
            envInputs.forEach(input => {
                const envKey = input.getAttribute('data-env-key');
                if (envKey) {
                    installData.env[envKey] = input.value;
                }
            });
        }

        // Debug-Logging
        console.log('=== Installation Data ===');
        console.log(JSON.stringify(installData, null, 2));

        // Sende Installation Request
        const response = await fetch('/api/install', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(installData)
        });

        const result = await response.json();
        console.log('=== Installation Response ===');
        console.log(JSON.stringify(result, null, 2));

        if (result.status === 'success') {
            // Spezielle Nachricht für Filestash
            if (containerName === 'filestash') {
                showNotification('success', `${containerName} temporary container started. Please go to http://${window.location.hostname}:8334 to create an admin password, then run the complete_setup.sh script to finalize the installation.`);
            } else {
                showNotification('success', `${containerName} installed successfully`);
            }
            
            // Schließe das Modal
            console.log('Closing modal after successful installation');
            closeModal();
            
            // Aktualisiere die Container-Anzeige
            updateContainerStatus(true);
        } else {
            // Zeige die Fehlermeldung vom Server an
            const errorMessage = result.message || 'Installation failed';
            showNotification('error', errorMessage);
            
            // Wenn es sich um einen Port-Konflikt handelt, zeige eine spezielle Meldung im Modal an
            if (errorMessage.includes('Port') && errorMessage.includes('already in use')) {
                const errorDiv = document.createElement('div');
                errorDiv.className = 'error-message';
                errorDiv.innerHTML = `
                    <div class="alert alert-danger" style="margin-top: 15px; padding: 10px; background-color: #f8d7da; color: #721c24; border-radius: 4px;">
                        <strong>Error:</strong> ${errorMessage}
                    </div>
                `;
                
                // Füge die Fehlermeldung zum Modal hinzu
                const modalFooter = document.querySelector('.modal .modal-footer');
                if (modalFooter) {
                    // Entferne vorherige Fehlermeldungen
                    const previousError = document.querySelector('.modal .error-message');
                    if (previousError) {
                        previousError.remove();
                    }
                    
                    modalFooter.parentNode.insertBefore(errorDiv, modalFooter);
                }
            } else {
                // Bei anderen Fehlern schließe das Modal
                closeModal();
            }
        }
    } catch (error) {
        console.error('Installation error:', error);
        showNotification('error', error.message || 'Installation failed');
        
        // Schließe das Modal bei unerwarteten Fehlern
        closeModal();
    } finally {
        // Verstecke Loading-Overlay
        if (loadingOverlay) {
            loadingOverlay.style.display = 'none';
        }

        // Reaktiviere den Install-Button
        const installButton = document.querySelector('.modal .install-btn');
        if (installButton) {
            installButton.disabled = false;
            installButton.innerHTML = 'Install';
        }
    }
}

// Modifizierte Toggle-Funktion
function toggleContainer(name) {
    if (!name) {
        showNotification('error', 'Invalid container name');
        return;
    }

    if (loadingOverlay) {
        loadingOverlay.style.display = 'flex';
    }
    
    fetch(`/api/toggle/${name}`, {
        method: 'POST'
    })
    .then(response => {
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
    })
    .then(data => {
        if (data.status === 'success') {
            updateContainerStatus(true);
            showNotification('success', data.message);
        } else {
            throw new Error(data.message || 'Toggle failed');
        }
    })
    .catch(error => {
        console.error('Error:', error);
        showNotification('error', `Failed to toggle container ${name}: ${error.message}`);
    })
    .finally(() => {
        if (loadingOverlay) {
            loadingOverlay.style.display = 'none';
        }
    });
}

function updateContainer(name) {
    const button = event.target;
    button.disabled = true;
    button.innerHTML = '<i class="fa fa-spinner fa-spin"></i>';

    fetch(`/api/update/${name}`, {
        method: 'POST'
    })
    .then(response => response.json())
    .then(data => {
        if (data.status === 'success') {
            showNotification('success', data.message);
            // Aktualisiere Container-Status
            updateContainerStatus();
        } else {
            showNotification('error', data.message);
        }
    })
    .catch(error => {
        console.error('Error:', error);
        showNotification('error', `Error updating container ${name}`);
    })
    .finally(() => {
        button.disabled = false;
        button.innerHTML = 'Update';
    });
}

function showNotification(type, message) {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.innerHTML = message;
    document.body.appendChild(notification);

    setTimeout(() => {
        notification.classList.add('show');
    }, 100);

    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => {
            notification.remove();
        }, 300);
    }, 3000);
}

// Theme Switcher
document.addEventListener('DOMContentLoaded', () => {
    const themeToggle = document.getElementById('theme-toggle');
    const prefersDarkScheme = window.matchMedia('(prefers-color-scheme: dark)');
    
    // Set initial theme based on system preference
    if (prefersDarkScheme.matches) {
        document.documentElement.setAttribute('data-theme', 'dark');
    }
    
    themeToggle.addEventListener('click', () => {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
    });
    
    // Load saved theme preference
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
        document.documentElement.setAttribute('data-theme', savedTheme);
    }
}); 

function getContainerLogo(containerName) {
    // Mapping von Container-Namen zu Logo-Dateien
    const logoMapping = {
        'homeassistant': 'homeassistant.png',
        'whatsupdocker': 'whatsupdocker.png',
        'wud': 'wud.png',
        'code-server': 'codeserver.png',
        'grafana': 'grafana.png',
        'filebrowser': 'filebrowser.png',
        'filestash': 'filebrowser.png',  // Fallback auf filebrowser icon
        'mosquitto-broker': 'mosquitto.png',
        'mosquitto': 'mosquitto.png',
        'raspberrymatic': 'raspberrymatic.png',
        'dockge': 'dockge.png',
        'portainer': 'portainer.png',
        'openhab': 'openhab.png',
        'zigbee2mqtt': 'mqtt.png',
        'heimdall': 'heimdall.png',
        'prometheus': 'prometheus.png',
        'homebridge': 'homebridge.png',
        'hoarder': 'hoarder.png',
        'homepage': 'homepage.png',
    };
    
    // Wenn ein Mapping existiert, verwende es, ansonsten verwende den Container-Namen
    const logoFile = logoMapping[containerName] || `${containerName}.png`;
    return `/static/img/icons/${logoFile}`;
}

function createContainerCard(container, categoryId) {
    const logoUrl = getContainerLogo(container.name);
    // Verwende die Beschreibung nur für den Tooltip des Logos
    const description = container.description || getContainerDescription(container.name) || '';
    const isInstalled = container.installed || false;
    const state = container.status || 'stopped';
    
    // Add drag & drop attributes for all containers
    const dragAttributes = `
        draggable="true"
        ondragstart="handleContainerDragStart(event, '${container.name}', '${categoryId}')"
        ondragend="handleContainerDragEnd(event)"
        ondragover="handleContainerDragOver(event)"
        ondragenter="handleContainerDragEnter(event)"
        ondragleave="handleContainerDragLeave(event)"
        ondrop="handleContainerDrop(event)"
    `;
    
    // Bestimme das richtige Protokoll (HTTP oder HTTPS)
    const protocol = container.name === 'scrypted' ? 'https' : 'http';
    
    // Spezielle Anzeige für WatchYourLAN
    let portDisplay = '';
    if (container.name === 'watchyourlan' || container.name === 'watchyourlanarm') {
        // Für WatchYourLAN zeigen wir den GUI-Port an (aus der Container-Konfiguration)
        const guiPort = container.port || '8840'; // Verwende container.port oder Fallback auf 8840
        portDisplay = `<p>Port: <a href="${protocol}://${window.location.hostname}:${guiPort}" 
                        target="_blank" 
                        class="port-link"
                        title="Open WatchYourLAN interface"
                    >${guiPort}</a></p>`;
    } else {
        // Standard-Port-Anzeige für andere Container
        portDisplay = `<p>Port: ${container.port ? 
            `<a href="${protocol}://${window.location.hostname}:${container.port}" 
                target="_blank" 
                class="port-link"
                title="Open container interface"
            >${container.port}</a>` 
            : 'N/A'}</p>`;
    }
    
    return `
        <div class="container-card" data-name="${container.name}"${dragAttributes}>
            <div class="status-indicator ${container.status}" title="Status: ${container.status}"></div>
            <div class="container-logo">
                <img src="${logoUrl}" 
                     alt="${container.name} logo" 
                     title="${description}" 
                     onerror="this.src='/static/img/icons/bangertech.png'">
            </div>
            <div class="name-with-settings">
                <h3 ${container.installed && container.port ? `onclick="window.open('${protocol}://${window.location.hostname}:${container.port}', '_blank')" style="cursor: pointer;"` : ''}>${container.name}</h3>
                ${isInstalled ? `
                    <button class="info-btn" onclick="openInfo('${container.name}')" title="Container Information">
                        <i class="fa fa-info-circle"></i>
                    </button>
                ` : ''}
            </div>
            ${portDisplay}
            <!-- Keine Beschreibung in den Karten, nur als Tooltip beim Logo -->

            <div class="actions">
                ${isInstalled ? `
                    <div class="button-group">
                        <button class="status-btn ${state}" onclick="toggleContainer('${container.name}')">
                            ${state === 'running' ? 'Stop' : 'Start'}
                        </button>
                        <button class="update-btn" onclick="updateContainer('${container.name}')" title="Update container">
                            <i class="fa fa-refresh"></i>
                        </button>
                    </div>
                ` : `
                    <button class="install-btn" onclick="installContainer('${container.name}')">Install</button>
                `}
            </div>
        </div>
    `;
}

async function openInfo(containerName) {
    try {
        // Hole Container-Informationen
        const response = await fetch(`/api/container/${containerName}/info`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const info = await response.json();
        
        // Hole zusätzliche Konfigurationsdateien
        let configFiles = [];
        try {
            const configResponse = await fetch(`/api/container/${containerName}/config-files`);
            if (configResponse.ok) {
                const configData = await configResponse.json();
                configFiles = configData.config_files || [];
            }
        } catch (error) {
            console.error('Error loading config files:', error);
        }
        
        // Hole das Container-Logo
        const logoUrl = getContainerLogo(containerName);
        
        // Erstelle Modal
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.id = 'infoModal';
        
        // Bestimme, ob der Advanced-Tab angezeigt werden soll
        const showAdvancedTab = configFiles.length > 0;
        
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h2>
                        <img src="${logoUrl}" alt="${containerName} logo" style="height: 24px; width: 24px; margin-right: 8px; vertical-align: middle;" onerror="this.src='/static/img/icons/bangertech.png'">
                        ${containerName}
                    </h2>
                    <button class="close-modal">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="info-tabs">
                        <button class="tab-btn active" data-tab="info">Information</button>
                        <button class="tab-btn" data-tab="config">Configuration</button>
                        ${showAdvancedTab ? `<button class="tab-btn" data-tab="advanced">Advanced</button>` : ''}
                    </div>
                    
                    <div class="tab-content active" id="info-tab">
                        <div class="info-grid">
                            <div class="info-item">
                                <h3><i class="fa fa-check-circle"></i> Status</h3>
                                <p class="${info.status}">${info.status || 'unknown'}</p>
                            </div>
                            <div class="info-item">
                                <h3><i class="fa fa-network-wired"></i> Network</h3>
                                <p>${info.info && info.info.network ? `<span class="network-badge">${info.info.network}</span>` : 'N/A'}</p>
                            </div>
                            <div class="info-item">
                                <h3><i class="fa fa-hdd"></i> Volumes</h3>
                                ${info.info && info.info.volumes && info.info.volumes.length > 0 ? `
                                    <ul class="volume-list">
                                        ${info.info.volumes.map(v => `<li><code>${v.source} → ${v.destination}</code></li>`).join('')}
                                    </ul>
                                ` : '<p>No volumes</p>'}
                            </div>
                            <div class="info-item">
                                <h3><i class="fa fa-globe"></i> Ports</h3>
                                ${info.info && info.info.ports && Object.keys(info.info.ports).length > 0 ? `
                                    <ul class="port-list">
                                        ${Object.entries(info.info.ports).map(([containerPort, hostPort]) => `
                                            <li>
                                                <code>${hostPort}:${containerPort.split('/')[0]}</code>
                                                <a href="http://${window.location.hostname}:${hostPort}" 
                                                   target="_blank" 
                                                   class="port-link">
                                                    <i class="fa fa-external-link"></i>
                                                </a>
                                            </li>
                                        `).join('')}
                                    </ul>
                                ` : '<p>No ports exposed</p>'}
                            </div>
                            <div class="info-item">
                                <h3><i class="fa fa-terminal"></i> Image</h3>
                                <p><code>${info.info && info.info.image ? info.info.image : 'N/A'}</code></p>
                            </div>
                            <div class="info-item">
                                <h3><i class="fa fa-clock-o"></i> Created</h3>
                                <p>${info.info && info.info.created ? new Date(info.info.created).toLocaleString() : 'N/A'}</p>
                            </div>
                        </div>
                    </div>
                    
                    <div class="tab-content hidden" id="config-tab">
                        <div class="config-header">
                            <h3>docker-compose.yml</h3>
                        </div>
                        <form id="settings-form">
                            <div class="form-group">
                                <textarea id="compose-config" rows="20" spellcheck="false">${info.compose || ''}</textarea>
                            </div>
                            <div class="form-actions">
                                <button type="button" onclick="saveSettings('${containerName}')" class="save-btn">
                                    <i class="fa fa-save"></i> Save & Restart
                                </button>
                            </div>
                        </form>
                    </div>
                    
                    ${showAdvancedTab ? `
                        <div class="tab-content hidden" id="advanced-tab">
                            <div class="config-files-tabs">
                                ${configFiles.map((file, index) => `
                                    <button class="config-file-tab ${index === 0 ? 'active' : ''}" 
                                            data-file-index="${index}">
                                        ${file.name}
                                    </button>
                                `).join('')}
                            </div>
                            <div class="config-files-content">
                                ${configFiles.map((file, index) => `
                                    <div class="config-file-content ${index === 0 ? 'active' : 'hidden'}" 
                                         id="config-file-${index}">
                                        <div class="form-group">
                                            <textarea class="config-file-editor" 
                                                      data-file-path="${file.path}"
                                                      rows="20" 
                                                      spellcheck="false">${file.content || ''}</textarea>
                                        </div>
                                        <div class="form-actions">
                                            <button type="button" 
                                                    onclick="saveConfigFile('${containerName}', '${file.path}')" 
                                                    class="save-btn">
                                                <i class="fa fa-save"></i> Save & Restart
                                            </button>
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        setTimeout(() => modal.classList.add('show'), 10);
        
        // Tab-Funktionalität
        modal.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                modal.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                modal.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
                btn.classList.add('active');
                const tabId = btn.dataset.tab + '-tab';
                document.getElementById(tabId).classList.remove('hidden');
            });
        });
        
        // Config-File-Tab-Funktionalität
        if (showAdvancedTab) {
            modal.querySelectorAll('.config-file-tab').forEach(btn => {
                btn.addEventListener('click', () => {
                    modal.querySelectorAll('.config-file-tab').forEach(b => b.classList.remove('active'));
                    modal.querySelectorAll('.config-file-content').forEach(c => c.classList.add('hidden'));
                    btn.classList.add('active');
                    const fileIndex = btn.dataset.fileIndex;
                    document.getElementById(`config-file-${fileIndex}`).classList.remove('hidden');
                });
            });
        }
        
        // Schließen-Funktionalität
        modal.querySelector('.close-modal').addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
    } catch (error) {
        console.error('Error:', error);
        showNotification('error', `Error loading info for ${containerName}`);
    }
}

async function saveSettings(containerName) {
    try {
        const textarea = document.getElementById('compose-config');
        if (!textarea) {
            throw new Error('Config textarea not found');
        }
        
        const content = textarea.value;
        
        // Deaktiviere den Save-Button und zeige Ladeindikator
        const saveBtn = document.querySelector('.save-btn');
        const originalBtnText = saveBtn.innerHTML;
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Restarting...';
        
        // Sende Anfrage zum Speichern der Konfiguration
        const response = await fetch(`/api/container/${containerName}/config`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                yaml: content
            })
        });
        
        const result = await response.json();
        
        if (response.ok) {
            showNotification('success', 'Configuration saved and container restarted');
            // Aktualisiere Container-Status
            updateContainerStatus();
        } else {
            throw new Error(result.error || 'Failed to save configuration');
        }
        
        // Aktiviere den Save-Button wieder und entferne Ladeindikator
        saveBtn.disabled = false;
        saveBtn.innerHTML = originalBtnText;
    } catch (error) {
        console.error('Error saving settings:', error);
        showNotification('error', `Error: ${error.message}`);
        
        // Stelle sicher, dass der Button wieder aktiviert wird
        const saveBtn = document.querySelector('.save-btn');
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="fa fa-save"></i> Save & Restart';
        }
    }
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

const debouncedScroll = debounce(() => {
    if (preserveScroll) {
        window.scrollTo(0, lastScrollPosition);
    }
}, 150); 

function initializeCategoryEditor() {
    const categoryList = document.querySelector('.category-list');
    const categories = document.querySelectorAll('.category-item');
    
    categories.forEach(category => {
        const editBtn = category.querySelector('.edit-btn');
        editBtn.addEventListener('click', () => {
            const categoryId = category.dataset.id;
            showCategoryModal('edit', categoryId);
        });
    });
} 

function initializeTerminal() {
    const terminal = document.getElementById('terminal');
    terminal.innerHTML = '<div class="terminal-content"></div>';
    terminalContent = terminal.querySelector('.terminal-content');
    
    currentCommand = '';
    
    const hiddenInput = document.createElement('textarea');
    hiddenInput.className = 'terminal-input-hidden';
    terminal.appendChild(hiddenInput);
    
    function createPrompt() {
        const { username, hostname, pwd } = window.terminalInfo || {};
        return `${username || 'user'}@${hostname || 'localhost'}:${pwd || '~'}$`;
    }
    
    function renderActiveLine() {
        const line = document.createElement('div');
        line.className = 'terminal-line active';
        
        const prompt = document.createElement('span');
        prompt.className = 'terminal-prompt';
        prompt.textContent = createPrompt();
        
        const command = document.createElement('span');
        command.className = 'terminal-command';
        command.textContent = currentCommand;
        
        const cursor = document.createElement('span');
        cursor.className = 'terminal-cursor';
        command.appendChild(cursor);
        
        line.appendChild(prompt);
        line.appendChild(command);
        return line;
    }
    
    // Definiere updateDisplay global
    updateDisplay = function() {
        if (!terminalContent) return;
        
        // Entferne alle vorherigen aktiven Zeilen
        terminalContent.querySelectorAll('.terminal-line.active').forEach(line => {
            line.classList.remove('active');
        });
        
        // Entferne alle vorherigen Cursor
        terminalContent.querySelectorAll('.terminal-cursor').forEach(cursor => {
            cursor.remove();
        });
        
        // Aktualisiere oder erstelle die aktive Zeile
        const activeLine = terminalContent.querySelector('.terminal-line:last-child');
        const newLine = renderActiveLine();
        
        if (activeLine) {
            terminalContent.replaceChild(newLine, activeLine);
        } else {
            terminalContent.appendChild(newLine);
        }
        
        document.getElementById('terminal').scrollTop = document.getElementById('terminal').scrollHeight;
    };
    
    async function executeCommand(command) {
        if (!command.trim()) return;
        
        try {
            const response = await fetch('/api/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command, connection: sshConnection })
            });
            
            const data = await response.json();
            if (data.status === 'editor') {
                showFileEditor(data.path);
            } else if (data.status === 'success') {
                // Nur die Ausgabe anzeigen
                if (data.output && data.output.trim()) {
                    const output = document.createElement('div');
                    output.className = 'terminal-output';
                    output.textContent = data.output;
                    terminalContent.appendChild(output);
                }
                
                // Aktualisiere Terminal-Info
                if (data.username && data.hostname && data.pwd) {
                    window.terminalInfo = {
                        username: data.username,
                        hostname: data.hostname,
                        pwd: data.pwd
                    };
                }
            } else {
                throw new Error(data.message);
            }
        } catch (error) {
            const errorOutput = document.createElement('div');
            errorOutput.className = 'terminal-output error';
            errorOutput.textContent = error.message;
            terminalContent.appendChild(errorOutput);
        }
        
        // Erstelle neue aktive Zeile
        currentCommand = '';
        const newLine = renderActiveLine();
        terminalContent.appendChild(newLine);
        document.getElementById('terminal').scrollTop = document.getElementById('terminal').scrollHeight;
    }
    
    terminal.addEventListener('click', () => hiddenInput.focus());
    
    hiddenInput.addEventListener('input', (e) => {
        currentCommand = e.target.value;
        updateDisplay();
    });
    
    hiddenInput.addEventListener('keydown', async (e) => {
        switch(e.key) {
            case 'Enter':
                e.preventDefault();
                if (currentCommand) {
                    // Speichere Befehl in History
                    commandHistory.push(currentCommand);
                    historyIndex = commandHistory.length;
                    
                    // Führe Befehl aus
                    await executeCommand(currentCommand);
                    hiddenInput.value = '';
                }
                break;
                
            case 'ArrowUp':
                e.preventDefault();
                showHistoryDropdown();
                break;
                
            case 'ArrowDown':
                e.preventDefault();
                if (historyIndex < commandHistory.length) {
                    historyIndex++;
                    currentCommand = historyIndex === commandHistory.length 
                        ? currentInput 
                        : commandHistory[historyIndex];
                    hiddenInput.value = currentCommand;
                    
                    // Zeige History-Navigation-Hinweis
                    if (historyIndex < commandHistory.length) {
                        const hint = document.createElement('div');
                        hint.className = 'terminal-hint';
                        hint.textContent = `(History: ${historyIndex + 1}/${commandHistory.length})`;
                        terminalContent.appendChild(hint);
                    }
                    
                    updateDisplay();
                }
                break;
                
            case 'Tab':
                e.preventDefault();
                await handleTabCompletion();
                break;
        }
    });
    
    hiddenInput.focus();
    updateDisplay();
} 

async function handleTabCompletion() {
    if (!currentCommand || !terminalContent) return;
    
    try {
        const response = await fetch('/api/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                command: currentCommand,
                connection: sshConnection 
            })
        });
        
        const data = await response.json();
        if (data.status === 'success' && data.suggestions.length > 0) {
            const partial = data.partial;
            
            if (data.suggestions.length === 1) {
                // Direkte Vervollständigung
                const parts = currentCommand.split(' ');
                parts[parts.length - 1] = data.suggestions[0];
                currentCommand = parts.join(' ');
                if (currentCommand.endsWith('/')) {
                    currentCommand += ' ';
                }
                document.querySelector('.terminal-input-hidden').value = currentCommand;
                updateDisplay();
            } else {
                // Zeige Vorschläge
                const output = document.createElement('div');
                output.className = 'terminal-output suggestions';
                output.textContent = data.suggestions.join('  ');
                terminalContent.appendChild(output);
                
                // Finde gemeinsamen Präfix
                const commonPrefix = data.suggestions.reduce((a, b) => {
                    let i = 0;
                    while (i < a.length && i < b.length && a[i] === b[i]) i++;
                    return a.substring(0, i);
                });
                
                if (commonPrefix.length > partial.length) {
                    const parts = currentCommand.split(' ');
                    parts[parts.length - 1] = commonPrefix;
                    currentCommand = parts.join(' ');
                    document.querySelector('.terminal-input-hidden').value = currentCommand;
                    updateDisplay();
                }
            }
            document.getElementById('terminal').scrollTop = document.getElementById('terminal').scrollHeight;
        }
    } catch (error) {
        console.error('Tab completion error:', error);
    }
} 

async function showFileEditor(filepath) {
    try {
        // Sende Parameter als URL-Parameter statt Body
        const params = new URLSearchParams({
            connection: sshConnection,
            path: filepath
        });
        
        const response = await fetch(`/api/file?${params}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        
        const data = await response.json();
        if (data.status === 'success') {
            const modal = document.createElement('div');
            modal.className = 'modal editor-modal show';
            modal.innerHTML = `
                <div class="modal-content">
                    <div class="modal-header">
                        <h2>Edit: ${filepath}</h2>
                        <button class="close-modal" onclick="closeModal()">&times;</button>
                    </div>
                    <div class="modal-body">
                        <textarea id="file-editor" class="file-editor">${data.content || ''}</textarea>
                    </div>
                    <div class="modal-footer">
                        <button onclick="saveFile('${filepath}')" class="save-btn">
                            <i class="fa fa-save"></i> Save
                        </button>
                        <button onclick="closeModal()" class="cancel-btn">Cancel</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            
            // Fokussiere Editor
            const editor = document.getElementById('file-editor');
            editor.focus();
            
            // Aktiviere Tab im Textarea
            editor.addEventListener('keydown', function(e) {
                if (e.key === 'Tab') {
                    e.preventDefault();
                    const start = this.selectionStart;
                    const end = this.selectionEnd;
                    this.value = this.value.substring(0, start) + '    ' + this.value.substring(end);
                    this.selectionStart = this.selectionEnd = start + 4;
                }
            });
        } else {
            throw new Error(data.message || 'Failed to load file content');
        }
    } catch (error) {
        console.error('Editor error:', error);
        showNotification('error', `Failed to load file: ${error.message}`);
    }
}

async function saveFile(filepath) {
    try {
        const content = document.getElementById('file-editor').value;
        const response = await fetch('/api/file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                connection: sshConnection,
                path: filepath,
                content: content,
                create: true  // Flag für neue Dateien
            })
        });
        
        const data = await response.json();
        if (data.status === 'success') {
            showNotification('success', 'File saved successfully');
            closeModal();
        } else {
            throw new Error(data.message);
        }
    } catch (error) {
        showNotification('error', `Failed to save file: ${error.message}`);
    }
} 

function showHistoryDropdown() {
    // Entferne existierendes Dropdown
    const existingDropdown = document.querySelector('.history-dropdown');
    if (existingDropdown) {
        existingDropdown.remove();
        return;
    }
    
    if (!commandHistory || commandHistory.length === 0) return;
    
    const dropdown = document.createElement('div');
    dropdown.className = 'history-dropdown';
    
    // Zeige die letzten 10 Befehle in umgekehrter Reihenfolge
    const recentCommands = [...new Set(commandHistory)].slice(-10).reverse();
    recentCommands.forEach((cmd) => {
        const item = document.createElement('div');
        item.className = 'history-item';
        item.textContent = cmd;
        item.addEventListener('click', () => {
            currentCommand = cmd;
            document.querySelector('.terminal-input-hidden').value = cmd;
            updateDisplay();
            dropdown.remove();
        });
        dropdown.appendChild(item);
    });
    
    // Füge Event-Listener zum Schließen hinzu
    document.addEventListener('click', function closeDropdown(e) {
        if (!dropdown.contains(e.target) && e.target !== document.querySelector('.terminal-input-hidden')) {
            dropdown.remove();
            document.removeEventListener('click', closeDropdown);
        }
    });
    
    // Füge das Dropdown zum Terminal hinzu
    terminalContent.appendChild(dropdown);
} 

async function loadFileList(path = '/') {
    try {
        const response = await fetch('/api/files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                connection: sshConnection,
                path: path 
            })
        });
        
        const data = await response.json();
        if (data.status === 'success') {
            currentPath = path;
            updateFileExplorer(data.files);
            updatePathBreadcrumbs(path);
        } else {
            throw new Error(data.message);
        }
    } catch (error) {
        showNotification('error', `Failed to load files: ${error.message}`);
    }
}

function updateFileExplorer(files) {
    const fileList = document.querySelector('.file-list');
    fileList.innerHTML = '';
    
    files.forEach(file => {
        const item = document.createElement('div');
        item.className = 'file-item';
        item.innerHTML = `
            <i class="fa fa-${file.type === 'directory' ? 'folder' : 'file'}"></i>
            <span>${file.name}</span>
            <div class="file-actions">
                ${file.type === 'file' ? `
                    <button onclick="downloadFile('${file.path}')" title="Download">
                        <i class="fa fa-download"></i>
                    </button>
                    <button onclick="deleteFile('${file.path}')" title="Delete">
                        <i class="fa fa-trash"></i>
                    </button>
                ` : ''}
            </div>
        `;
        
        if (file.type === 'directory') {
            item.addEventListener('click', () => loadFileList(file.path));
        }
        
        fileList.appendChild(item);
    });
}

function updatePathBreadcrumbs(path) {
    const pathNav = document.querySelector('.path-navigation');
    pathNav.innerHTML = '';
    
    const parts = path.split('/').filter(Boolean);
    let currentPath = '';
    
    // Root-Verzeichnis
    const root = document.createElement('span');
    root.textContent = '/';
    root.className = 'path-item';
    root.onclick = () => loadFileList('/');
    pathNav.appendChild(root);
    
    // Baue den Pfad Stück für Stück auf
    parts.forEach((part, index) => {
        currentPath += '/' + part;
        
        // Füge Separator hinzu
        if (index > 0 || parts.length > 0) {
            const separator = document.createElement('span');
            separator.textContent = '>';
            separator.className = 'path-separator';
            pathNav.appendChild(separator);
        }
        
        // Füge Pfad-Element hinzu
        const item = document.createElement('span');
        item.textContent = part;
        item.className = 'path-item';
        const pathToNavigate = currentPath;  // Wichtig: Erstelle Kopie für Closure
        item.onclick = (e) => {
            e.stopPropagation();  // Verhindere Bubble-Up
            loadFileList(pathToNavigate);
        };
        pathNav.appendChild(item);
    });
}

function navigateUp() {
    const parentPath = currentPath.split('/').slice(0, -1).join('/') || '/';
    loadFileList(parentPath);
}

async function uploadFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    
    input.onchange = async function() {
        for (const file of this.files) {
            try {
                const formData = new FormData();
                formData.append('file', file);
                formData.append('path', currentPath);
                formData.append('connection', sshConnection);
                
                const response = await fetch('/api/upload', {
                    method: 'POST',
                    body: formData
                });
                
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                
                const data = await response.json();
                if (data.status === 'success') {
                    showNotification('success', `Uploaded ${file.name}`);
                } else {
                    throw new Error(data.message);
                }
            } catch (error) {
                console.error('Upload error:', error);
                showNotification('error', `Failed to upload ${file.name}: ${error.message}`);
            }
        }
        
        // Aktualisiere die Dateiliste
        await loadFileList(currentPath);
    };
    
    input.click();
}

async function downloadFile(path) {
    try {
        const response = await fetch('/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                connection: sshConnection,
                path: path 
            })
        });
        
        if (response.ok) {
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = path.split('/').pop();
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
        } else {
            throw new Error('Download failed');
        }
    } catch (error) {
        showNotification('error', `Failed to download file: ${error.message}`);
    }
}

async function deleteFile(path) {
    if (!confirm(`Are you sure you want to delete ${path}?`)) return;
    
    try {
        const response = await fetch('/api/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                connection: sshConnection,
                path: path 
            })
        });
        
        const data = await response.json();
        if (data.status === 'success') {
            showNotification('success', 'File deleted');
            loadFileList(currentPath);
        } else {
            throw new Error(data.message);
        }
    } catch (error) {
        showNotification('error', `Failed to delete file: ${error.message}`);
    }
} 

function closeFileExplorer() {
    // Entferne Overlay
    const overlay = document.querySelector('.explorer-overlay');
    if (overlay) {
        overlay.remove();
    }
    
    // Verstecke Explorer
    document.querySelector('.file-explorer').style.display = 'none';
    
    // Optional: Trenne SFTP-Verbindung
    if (sshConnection) {
        fetch('/api/disconnect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ connection: sshConnection })
        }).then(() => {
            sshConnection = null;
            showNotification('success', 'Disconnected from server');
        });
    }
}

// Verhindere Klick-Propagation vom Explorer zum Overlay
document.querySelector('.file-explorer')?.addEventListener('click', (e) => {
    e.stopPropagation();
}); 

function toggleSection(header) {
    const content = header.nextElementSibling;
    const icon = header.querySelector('.fa-chevron-down');
    
    if (content.style.display === 'none') {
        content.style.display = 'block';
        icon.style.transform = 'rotate(180deg)';
        // Initialisiere Tabs wenn Section geöffnet wird
        if (content.querySelector('.import-tabs')) {
            initializeImportTabs();
        }
    } else {
        content.style.display = 'none';
        icon.style.transform = 'rotate(0deg)';
    }
}

// Cron Job Funktionen
async function scheduleShutdown() {
    const hostIp = document.getElementById('host-ip').value;
    const hostUser = document.getElementById('host-user').value;
    const hostPassword = document.getElementById('host-password').value;
    const shutdownTime = document.getElementById('shutdown-time').value;
    const wakeupTime = document.getElementById('wakeup-time').value;

    if (!hostIp || !hostUser || !hostPassword) {
        showNotification('error', 'Please enter host credentials');
        return;
    }
    
    if (!shutdownTime || !wakeupTime) {
        showNotification('error', 'Please select both shutdown and wake-up times');
        return;
    }
    
    try {
        const response = await fetch('/api/schedule-shutdown', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                hostIp,
                hostUser,
                hostPassword,
                shutdownTime, 
                wakeupTime 
            })
        });
        
        const data = await response.json();
        if (data.status === 'success') {
            showNotification('success', 'Shutdown schedule created');
            await updateScheduleStatus();  // Warte auf die Aktualisierung
        } else {
            throw new Error(data.message);
        }
    } catch (error) {
        showNotification('error', `Failed to create schedule: ${error.message}`);
    }
}

async function deleteSchedule(id) {
    if (!confirm('Are you sure you want to delete this schedule?')) return;
    
    try {
        // Hole die gespeicherte Host-Konfiguration
        const configResponse = await fetch('/api/host-config');
        const hostConfig = await configResponse.json();
        
        if (!hostConfig || hostConfig.error) {
            throw new Error('No host configuration found. Please test connection first.');
        }
        
        const deleteResponse = await fetch('/api/schedule/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                id,
                hostIp: hostConfig.ip,
                hostUser: hostConfig.username,
                hostPassword: hostConfig.password
            })
        });
        
        const data = await deleteResponse.json();
        if (data.status === 'success') {
            showNotification('success', 'Schedule deleted successfully');
            window.updateScheduleStatus();
        } else {
            throw new Error(data.message);
        }
    } catch (error) {
        showNotification('error', `Failed to delete schedule: ${error.message}`);
    }
}

// Reduziere die Update-Frequenz oder entferne automatische Updates
const UPDATE_INTERVAL = 300000; // 5 Minuten statt alle paar Sekunden

// Lade Container-Status
async function updateContainerStatus(forceRefresh = false) {
    try {
        const response = await fetch('/api/containers');
        const containers = await response.json();
        updateContainerList(containers);
    } catch (error) {
        console.error('Error updating container status:', error);
    }
}

// Initialisierung
// Hauptinitialisierungsfunktion
document.addEventListener('DOMContentLoaded', async () => {
    // Lade die UI beim Start
    await loadCategories(true);
    
    // Initialisiere Status-Updates basierend auf Benutzereinstellungen
    initContainerStatusUpdates();
    
    // Refresh Button einrichten
    const refreshButton = document.getElementById('refresh-button');
    if (refreshButton) {
        refreshButton.addEventListener('click', () => {
            // Bei Klick auf Refresh vollständige Aktualisierung durchführen
            updateContainerStatus(true);
            showNotification('info', 'Aktualisiere Container-Status...');
        });
    }
});

/**
 * Initialisiert und verwaltet die Container-Status-Updates basierend auf den Benutzereinstellungen
 */
function initContainerStatusUpdates() {
    // Stoppe vorhandene Timer
    if (containerStatusTimer) {
        clearInterval(containerStatusTimer);
        containerStatusTimer = null;
    }
    
    // Prüfe, ob Auto-Update aktiviert ist (aus den Benutzereinstellungen)
    const autoUpdateEnabled = localStorage.getItem('autoUpdate') !== 'false';
    if (!autoUpdateEnabled) {
        console.log('Container Auto-Update ist deaktiviert');
        return;
    }
    
    // Hole das Intervall aus den Benutzereinstellungen
    const intervalSeconds = parseInt(localStorage.getItem('refreshInterval') || '30');
    const updateInterval = intervalSeconds * 1000;
    
    console.log(`Container Status-Updates alle ${intervalSeconds} Sekunden aktiviert`);
    
    // Starte den Timer nur für Status-Updates (nie vollständige Refreshs)
    containerStatusTimer = setInterval(() => {
        updateContainerStatus(false); // Immer nur Status-Updates, nie vollständige Refreshs
    }, updateInterval);
}

// Füge diese Funktion vor der updateContainerStatus Funktion hinzu
function addContainerEventListeners() {
    // Event-Listener für Install-Buttons
    document.querySelectorAll('.install-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const containerCard = e.target.closest('.container-card');
            if (containerCard) {
                const containerNameElement = containerCard.querySelector('h3');
                if (containerNameElement) {
                    const containerName = containerNameElement.textContent;
                    installContainer(containerName);
                }
            }
        });
    });
    
    // Event-Listener für Status-Buttons
    document.querySelectorAll('.status-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const containerCard = e.target.closest('.container-card');
            if (containerCard) {
                const containerNameElement = containerCard.querySelector('h3');
                if (containerNameElement) {
                    const containerName = containerNameElement.textContent;
                    toggleContainer(containerName);
                }
            }
        });
    });
    
    // Event-Listener für Container-Karten (falls vorhanden)
    document.querySelectorAll('.container-card').forEach(card => {
        card.addEventListener('click', function(e) {
            // Verhindere, dass der Click-Event auf Buttons weitergeleitet wird
            if (e.target.tagName === 'BUTTON' || e.target.closest('button')) {
                return;
            }
            
            const containerNameElement = this.querySelector('h3');
            if (containerNameElement) {
                const containerName = containerNameElement.textContent;
                // Hier können Sie eine Aktion für den Klick auf die Karte definieren
                // z.B. openInfo(containerName);
            }
        });
    });
}

// Füge diese Funktionen zur main.js hinzu

function convertToCompose() {
    const command = document.getElementById('docker-run-command').value;
    
    fetch('/api/convert-docker-run', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ command: command })
    })
    .then(response => response.json())
    .then(data => {
        if (data.status === 'success') {
            document.getElementById('compose-content').textContent = data.compose;
            document.getElementById('compose-preview').classList.remove('hidden');
        } else {
            showNotification('error', data.message);
        }
    })
    .catch(error => {
        showNotification('error', 'Failed to convert command');
    });
}

// File Drop Zone Handler
document.getElementById('file-drop-zone').addEventListener('click', () => {
    document.getElementById('compose-file').click();
});

document.getElementById('compose-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            document.getElementById('compose-content').textContent = e.target.result;
            document.getElementById('compose-preview').classList.remove('hidden');
        };
        reader.readAsText(file);
    }
});

// Drag & Drop Handler
const dropZone = document.getElementById('file-drop-zone');

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    
    const file = e.dataTransfer.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            document.getElementById('compose-content').textContent = e.target.result;
            document.getElementById('compose-preview').classList.remove('hidden');
        };
        reader.readAsText(file);
    }
});

function saveCompose() {
    const compose = document.getElementById('compose-content').textContent;
    
    // Zeige Ladeanimation
    const saveBtn = document.querySelector('.save-btn');
    const originalContent = saveBtn.innerHTML;
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Installing...';
    
    // Zeige Loading Overlay
    if (loadingOverlay) {
        loadingOverlay.style.display = 'flex';
    }
    
    fetch('/api/import-compose', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ compose: compose })
    })
    .then(response => response.json())
    .then(data => {
        if (data.status === 'success') {
            showNotification('success', 'Container imported successfully');
            // Warte kurz bevor Update
            setTimeout(() => {
                updateContainerStatus(true);
                // Optional: Scrolle zur Imported Kategorie
                const importedSection = document.querySelector('[data-category="imported"]');
                if (importedSection) {
                    importedSection.scrollIntoView({ behavior: 'smooth' });
                }
            }, 2000);
        } else {
            showNotification('error', data.message);
        }
    })
    .catch(error => {
        showNotification('error', 'Failed to import container');
    })
    .finally(() => {
        // Entferne Ladeanimation
        saveBtn.disabled = false;
        saveBtn.innerHTML = originalContent;
        
        // Verstecke Loading Overlay
        if (loadingOverlay) {
            loadingOverlay.style.display = 'none';
        }
    });
}

// Deklaration für loadContainers, die in renderCategories() aufgerufen wird
async function loadContainers(forceRefresh = false) {
    const now = Date.now();
    const useCachedData = containerCache && !forceRefresh && (now - lastContainersFetch < CACHE_TTL);
    
    if (useCachedData) {
        console.log('Verwende zwischengespeicherte Container-Daten');
        return renderContainers(containerCache, categoriesCache);
    }

    console.log('Lade neue Container-Daten vom Server');
    try {
        const response = await fetch('/api/containers');
        const data = await response.json();
        
        // Aktualisiere den Cache und Zeitstempel
        containerCache = data;
        lastContainersFetch = now;
        
        // Rendere die UI mit den neuen Daten
        return renderContainers(data, categoriesCache);
    } catch (error) {
        console.error('Error loading containers:', error);
        showNotification('error', 'Error loading containers');
    }
}

function renderContainers(containers, categories) {
    if (!containers || !categories) {
        console.error('Missing data for rendering containers', { containers, categories });
        return;
    }

    const containerSections = document.querySelectorAll('.container-section');
    containerSections.forEach(section => {
        const categoryId = section.getAttribute('data-category-id');
        const containerGrid = section.querySelector('.container-grid') || document.createElement('div');
        containerGrid.className = 'container-grid';
        containerGrid.innerHTML = '';
        
        // Finde die Kategorie
        const category = categories.categories[categoryId];
        if (category && category.containers && category.containers.length > 0) {
            // Füge Container dieser Kategorie hinzu
            category.containers.forEach(containerId => {
                const containerName = typeof containerId === 'string' ? containerId : containerId.name;
                const containerInfo = containers.find(c => c.name === containerName);
                if (containerInfo) {
                    const containerCard = createContainerCard(containerInfo, categoryId);
                    containerGrid.appendChild(containerCard);
                }
            });
            
            section.appendChild(containerGrid);
        }
    });
}

// Aktualisiert den Container-Status via API-Anfrage
async function updateContainerStatus(forceRefresh = false) {
    try {
        if (forceRefresh) {
            // Bei vollständiger Aktualisierung die volle Funktion verwenden
            console.log('Vollständige UI-Aktualisierung angefordert...');
            await loadCategories(true);
            return;
        }
        
        // Ansonsten nur die Status-Informationen abrufen (leichtgewichtiger API-Aufruf)
        console.log('Aktualisiere nur Container-Status ohne vollständigen Reload');
        const response = await fetch('/api/containers/status');
        
        if (!response.ok) {
            throw new Error('Failed to fetch container status');
        }
        
        const statusData = await response.json();
        
        // Verwende die gemeinsame Funktion zum Aktualisieren der UI
        updateContainerStatusUI(statusData);
    } catch (error) {
        console.error('Error updating container status:', error);
    }
}

// Aktualisiert die UI basierend auf Statusdaten (wird sowohl von API als auch WebSockets verwendet)
function updateContainerStatusUI(statusData, isSingleContainerUpdate = false) {
    if (!statusData || !Array.isArray(statusData)) {
        console.error('Ungültige Statusdaten empfangen:', statusData);
        return;
    }
    
    // Speichere den aktuellen Status zur späteren Referenz und Prüfung auf Änderungen
    const previousStates = new Map(lastContainerStates);
    
    // Bei einzelnem Container-Update nicht die Map zurücksetzen
    if (!isSingleContainerUpdate) {
        lastContainerStates.clear(); // Zurücksetzen für neue Daten
    }
    
    // Aktualisiere nur die Status-Indikatoren, nicht die gesamte UI
    statusData.forEach(container => {
        // Speichere aktuellen Status
        lastContainerStates.set(container.name, container.status);
        
        // Prüfe, ob sich der Status geändert hat
        const previousStatus = previousStates.get(container.name) || '';
        const statusChanged = previousStatus !== container.status;
        
        if (statusChanged) {
            console.log(`Container ${container.name}: ${previousStatus} -> ${container.status} (geändert: ${statusChanged})`);
        }
        
        // Finde alle Karten für diesen Container
        const containerCards = document.querySelectorAll(`.container-card[data-name="${container.name}"]`);
        
        containerCards.forEach(card => {
            // Finde den Status-Indikator
            const statusIndicator = card.querySelector('.status-indicator');
            const statusBtn = card.querySelector('.status-btn');
            
            if (statusIndicator) {
                // Entferne alle bestehenden Status-Klassen
                statusIndicator.classList.remove('running', 'stopped', 'error');
                // Füge die aktuelle Statusklasse hinzu
                statusIndicator.classList.add(container.status);
                // Aktualisiere den Text
                statusIndicator.setAttribute('title', `Status: ${container.status}`);
                
                // Kurze Animation bei Statusänderung für bessere Sichtbarkeit
                if (statusChanged) {
                    // Kurze Animation hinzufügen
                    statusIndicator.classList.add('status-update-flash');
                    setTimeout(() => {
                        statusIndicator.classList.remove('status-update-flash');
                    }, 1000);
                }
            }
            
            if (statusBtn) {
                // Aktualisiere den Status-Button basierend auf dem Status
                if (container.status === 'running') {
                    statusBtn.innerHTML = '<i class="fa fa-stop"></i>';
                    statusBtn.classList.remove('start');
                    statusBtn.classList.add('stop');
                    statusBtn.setAttribute('title', 'Stop Container');
                } else {
                    statusBtn.innerHTML = '<i class="fa fa-play"></i>';
                    statusBtn.classList.remove('stop');
                    statusBtn.classList.add('start');
                    statusBtn.setAttribute('title', 'Start Container');
                }
            }
        });
    });
}

// Hilfsfunktionen für das Modal
function createPortMappings(ports) {
    if (!ports || ports.length === 0) return 'No ports to configure';
    
    return ports.map(port => {
        let containerPort, hostPort;
        
        if (typeof port === 'string') {
            [hostPort, containerPort] = port.split(':');
        } else {
            containerPort = port;
            hostPort = port;
        }
        
        // Entferne eventuelle Protokoll-Suffixe (z.B. /tcp)
        containerPort = containerPort.split('/')[0];
        
        return `
            <div class="port-mapping">
                <label>Externer Port (${containerPort} intern):</label>
                <input type="number" 
                       data-port="${containerPort}"
                       value="${hostPort.split('/')[0]}"
                       min="1"
                       max="65535"
                       class="form-control">
            </div>
        `;
    }).join('');
}

function createEnvironmentVars(environment) {
    if (!environment || Object.keys(environment).length === 0) {
        return 'No environment variables to configure';
    }
    
    return Object.entries(environment).map(([key, defaultValue]) => `
        <div class="env-var">
            <label>${key}:</label>
            <input type="text" 
                   data-env-key="${key}"
                   value="${defaultValue || ''}"
                   placeholder="${getEnvPlaceholder(key)}"
                   class="form-control">
            ${getEnvDescription(key)}
        </div>
    `).join('');
}

// CSS für die neuen Komponenten
const style = document.createElement('style');
style.textContent = `
    .container-card.dragging {
        opacity: 0.5;
        cursor: move;
    }

    .category.drag-over {
        background-color: var(--hover-bg-color);
        border: 2px dashed var(--accent-color);
    }

    .category-item.drag-over {
        background-color: var(--hover-bg-color);
        border: 2px dashed var(--accent-color);
    }

    .port-mapping, .env-var {
        margin-bottom: 15px;
    }
    
    .port-mapping label, .env-var label {
        display: block;
        margin-bottom: 5px;
        font-weight: bold;
    }
    
    .form-control {
        width: 100%;
        padding: 8px;
        border: 1px solid #ddd;
        border-radius: 4px;
        background: var(--color-background-light);
        color: var(--color-text);
    }
    
    .form-control:focus {
        border-color: var(--color-primary);
        outline: none;
    }
    
    .section {
        margin-bottom: 20px;
        padding: 15px;
        background: var(--color-background-dark);
        border-radius: 8px;
    }
    
    .section h3 {
        margin-bottom: 15px;
        color: var(--color-text);
    }
    
    .hint {
        display: block;
        margin-top: 5px;
        color: var(--color-text-muted);
        font-size: 0.9em;
    }
`;

document.head.appendChild(style);

// Function to toggle the configuration section
function toggleConfigSection(header) {
    const content = header.nextElementSibling;
    const icon = header.querySelector('i.fa');
    
    if (content.style.display === 'none' || !content.style.display) {
        content.style.display = 'block';
        icon.classList.remove('fa-chevron-down');
        icon.classList.add('fa-chevron-up');
    } else {
        content.style.display = 'none';
        icon.classList.remove('fa-chevron-up');
        icon.classList.add('fa-chevron-down');
    }
}

// Hilfsfunktion zum Generieren der Konfigurationsfelder
function generateConfigFields(containerConfig, container) {
    if (!containerConfig.config) {
        return '';
    }

    return `
        <div class="modal-content">
            <div class="modal-header">
                <h2>${container.name}</h2>
                <button class="close-modal" onclick="closeModal()">&times;</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label for="config-file">Configuration File</label>
                    <input type="file" id="config-file" name="config-file" class="form-control">
                    <small class="hint">Upload a custom configuration file (optional)</small>
                </div>
            </div>
            <div class="modal-footer">
                <button class="save-btn" onclick="saveSettings('${container.name}')">Save & Restart</button>
                <button class="cancel-btn" onclick="closeModal()">Cancel</button>
            </div>
        </div>
    `;
}

// Funktion zum Speichern einer Konfigurationsdatei
async function saveConfigFile(containerName, filePath) {
    try {
        const textarea = document.querySelector(`.config-file-editor[data-file-path="${filePath}"]`);
        if (!textarea) {
            throw new Error('Config file editor not found');
        }
        
        const content = textarea.value;
        
        // Deaktiviere den Save-Button und zeige Ladeindikator
        const saveBtn = textarea.closest('.config-file-content').querySelector('.save-btn');
        const originalBtnText = saveBtn.innerHTML;
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Restarting...';
        
        // Sende Anfrage zum Speichern der Konfigurationsdatei
        const response = await fetch(`/api/container/${containerName}/save-config`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                path: filePath,
                content: content
            })
        });
        
        const result = await response.json();
        
        if (response.ok) {
            showNotification('success', 'Configuration saved and container restarted');
            // Aktualisiere Container-Status
            updateContainerStatus();
        } else {
            throw new Error(result.error || 'Failed to save configuration');
        }
        
        // Aktiviere den Save-Button wieder und entferne Ladeindikator
        saveBtn.disabled = false;
        saveBtn.innerHTML = originalBtnText;
    } catch (error) {
        console.error('Error saving config file:', error);
        showNotification('error', `Error: ${error.message}`);
        
        // Stelle sicher, dass der Button wieder aktiviert wird
        const saveBtn = document.querySelector('.save-btn');
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="fa fa-save"></i> Save & Restart';
        }
    }
}