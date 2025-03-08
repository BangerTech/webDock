// Definiere loadingOverlay global
let loadingOverlay;

// Behalte die Scroll-Position
let lastScrollPosition = 0;
let lastContainerStates = new Map();

// Globale closeModal Funktion
function closeModal() { 
    // Suche nach allen modalen Dialogen
    const modals = document.querySelectorAll('.modal');
    
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
    
    // Debug-Logging
    console.log('Modal closed');
}

// Globale Variablen am Anfang der Datei
let sshConnection = null;
let currentPath = '/';
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
                        
                        // Füge "Other" Kategorie hinzu
                        groupedContainers['Other'] = {
                            name: 'Other',
                            icon: 'fa-cube',
                            containers: []
                        };
                        
                        // Sortiere Container in ihre Kategorien
                        Object.values(data).forEach(group => {
                            group.containers.forEach(container => {
                                let assigned = false;
                                
                                // Suche die passende Kategorie
                                Object.entries(categories || {}).forEach(([id, category]) => {
                                    if (category.containers && 
                                        category.containers.includes(container.name) && 
                                        !assignedContainers.has(container.name)) { // Prüfe ob Container bereits zugewiesen
                                        groupedContainers[category.name].containers.push(container);
                                        assignedContainers.add(container.name); // Markiere Container als zugewiesen
                                        assigned = true;
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
    function updateSystemLogs() {
        fetch('/api/system/logs')
            .then(response => response.json())
            .then(logs => {
                const logsContainer = document.getElementById('system-logs');
                if (!logsContainer) return;
                
                logsContainer.innerHTML = logs.map(log => {
                    const levelClass = log.level.toLowerCase();
                    const sourceIcon = {
                        'webdock-ui': 'fa-desktop',
                        'docker': 'fa-docker',
                        'system': 'fa-cog'
                    }[log.source] || 'fa-info-circle';
                    
                    return `
                        <div class="log-entry ${levelClass}">
                            <span class="log-time">${formatLogDate(log.timestamp)}</span>
                            <span class="log-level">
                                <i class="fa ${sourceIcon}"></i> ${log.level}
                            </span>
                            <span class="log-message">${log.message}</span>
                        </div>
                    `;
                }).join('');
                
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
    });

    // Docker Version Info
    fetch('/api/docker/info')
        .then(response => response.json())
        .then(data => {
            document.getElementById('docker-version').value = data.version;
            document.getElementById('docker-network').value = data.network;
        })
        .catch(error => console.error('Error getting Docker info:', error));

    // Setup Refresh Interval
    function setupRefreshInterval() {
        const interval = parseInt(refreshInterval.value) * 1000;
        if (window.statusInterval) clearInterval(window.statusInterval);
        if (autoUpdate.checked) {
            window.statusInterval = setInterval(() => {
                updateSystemStatus();
                updateContainerHealth();
                updateSystemLogs();
            }, interval);
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
    function loadCategories() {
        fetch('/api/categories')
            .then(response => response.json())
            .then(data => {
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
                    
                    const isOther = category.name === 'Other';
                    
                    categoryItem.innerHTML = `
                        <div class="drag-handle">
                            <i class="fa fa-bars"></i>
                        </div>
                        <div class="category-info">
                            <i class="fa ${category.icon}"></i>
                            <span>${category.name}</span>
                        </div>
                        <div class="category-actions">
                            <button class="edit-category" ${isOther ? 'disabled title="Default category cannot be edited"' : ''}>
                                <i class="fa fa-edit"></i>
                            </button>
                            <button class="delete-category" ${isOther ? 'disabled title="Default category cannot be deleted"' : ''}>
                                <i class="fa fa-trash"></i>
                            </button>
                        </div>
                    `;
                    
                    // Event-Listener nur hinzufügen, wenn es nicht die "Other" Kategorie ist
                    if (!isOther) {
                        categoryItem.querySelector('.edit-category').addEventListener('click', () => editCategory(id));
                        categoryItem.querySelector('.delete-category').addEventListener('click', () => deleteCategory(id));
                    }
                    
                    // Drag & Drop Event-Listener
                    categoryItem.addEventListener('dragstart', handleDragStart);
                    categoryItem.addEventListener('dragend', handleDragEnd);
                    
                    categoryList.appendChild(categoryItem);
                });
            })
            .catch(error => {
                console.error('Error loading categories:', error);
                showNotification('Error loading categories', 'error');
            });
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
        e.dataTransfer.setData('text/plain', e.target.dataset.id);
    }

    function handleDragEnd(e) {
        e.target.classList.remove('dragging');
        document.querySelectorAll('.category-item').forEach(item => {
            item.classList.remove('drag-over');
        });
    }

    function handleDragOver(e) {
        e.preventDefault();
    }

    function handleDragEnter(e) {
        e.preventDefault();
        e.target.closest('.category-item')?.classList.add('drag-over');
    }

    function handleDragLeave(e) {
        e.target.closest('.category-item')?.classList.remove('drag-over');
    }

    function handleDrop(e) {
        e.preventDefault();
        const draggedId = e.dataTransfer.getData('text/plain');
        const dropTarget = e.target.closest('.category-item');
        
        if (dropTarget && draggedId !== dropTarget.dataset.id) {
            const categoryList = document.querySelector('.category-list');
            const items = Array.from(categoryList.children);
            const draggedItem = items.find(item => item.dataset.id === draggedId);
            const dropIndex = items.indexOf(dropTarget);
            
            categoryList.removeChild(draggedItem);
            categoryList.insertBefore(draggedItem, dropTarget);
            
            // Speichere neue Reihenfolge
            updateCategoryOrder();
        }
        
        dropTarget?.classList.remove('drag-over');
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

    // Initialisierung beim Laden der Seite
    document.addEventListener('DOMContentLoaded', function() {
        // Initialisiere Header-Tabs
        initializeHeaderTabs();
        
        // Initialisiere Import-Tabs nur wenn die Section bereits offen ist
        const importSection = document.querySelector('.import-tabs');
        if (importSection && importSection.offsetParent !== null) {
            initializeImportTabs();
        }
    });
});

// Container control functions
function installContainer(name) {
    const button = event.target;
    button.disabled = true;
    button.innerHTML = '<i class="fa fa-spinner fa-spin"></i>';

    // Hole zuerst den Data Location Pfad aus den Settings
    fetch('/api/settings/data-location')
        .then(response => response.json())
        .then(settings => {
            const dataLocation = settings.location || '/home/The-BangerTECH-Utility-main/docker-compose-data';
            
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
        
        // Spezielle Felder für verschiedene Container
        let additionalFields = '';
        
        // Mosquitto-Broker
        if (containerName === 'mosquitto-broker' || containerName === 'mosquitto') {
            additionalFields = `
                <div class="auth-section" style="margin-bottom: 20px; padding: 15px; background: var(--color-background-dark); border-radius: 8px;">
                    <h3 style="margin-bottom: 15px;">Authentication Settings</h3>
                    <div class="form-group">
                        <label class="checkbox-label" style="display: flex; align-items: center; cursor: pointer;">
                            <input type="checkbox" id="mqtt-auth" name="mqtt-auth" style="margin-right: 10px;">
                            <span>Enable Authentication</span>
                        </label>
                    </div>
                    <div class="auth-credentials" style="display: none; margin-top: 15px;">
                        <div class="form-group">
                            <label for="mqtt-username">MQTT Username</label>
                            <input type="text" id="mqtt-username" name="mqtt-username" placeholder="Enter username" class="form-control">
                        </div>
                        <div class="form-group">
                            <label for="mqtt-password">MQTT Password</label>
                            <input type="password" id="mqtt-password" name="mqtt-password" placeholder="Enter password" class="form-control">
                        </div>
                    </div>
                </div>
            `;
        }
        // InfluxDB
        else if (containerName === 'influxdb' || containerName === 'influxdb-arm' || containerName === 'influxdb-x86') {
            additionalFields = `
                <div class="influxdb-section" style="margin-bottom: 20px; padding: 15px; background: var(--color-background-dark); border-radius: 8px;">
                    <h3 style="margin-bottom: 15px;">Database Settings</h3>
                    <div class="form-group">
                        <label class="checkbox-label" style="display: flex; align-items: center; cursor: pointer;">
                            <input type="checkbox" id="influxdb-create-db" name="influxdb-create-db" style="margin-right: 10px;">
                            <span>Create Default Database</span>
                        </label>
                    </div>
                    <div class="db-credentials" style="display: none; margin-top: 15px;">
                        <div class="form-group">
                            <label for="db-name">Database Name</label>
                            <input type="text" id="db-name" name="db-name" value="database1" placeholder="Enter database name" class="form-control">
                        </div>
                        <div class="form-group">
                            <label for="db-user">Database User</label>
                            <input type="text" id="db-user" name="db-user" value="user1" placeholder="Enter username" class="form-control">
                        </div>
                        <div class="form-group">
                            <label for="db-password">Database Password</label>
                            <input type="password" id="db-password" name="db-password" value="pwd12345" placeholder="Enter password" class="form-control">
                        </div>
                    </div>
                </div>
            `;
        }
        // Dockge
        else if (containerName === 'dockge') {
            additionalFields = `
                <div class="dockge-section" style="margin-bottom: 20px; padding: 15px; background: var(--color-background-dark); border-radius: 8px;">
                    <h3 style="margin-bottom: 15px;">Dockge Settings</h3>
                    <div class="form-group">
                        <label for="stacks-dir">Stacks Directory</label>
                        <input type="text" id="stacks-dir" name="stacks-dir" value="/home/webDock/docker-compose-data" placeholder="Enter stacks directory path" class="form-control">
                        <small class="hint">Directory where your docker-compose stacks are stored</small>
                    </div>
                </div>
            `;
        }
        // Filestash
        else if (containerName === 'filestash') {
            additionalFields = `
                <div class="filestash-section" style="margin-bottom: 20px; padding: 15px; background: var(--color-background-dark); border-radius: 8px;">
                    <h3 style="margin-bottom: 15px;">Filestash Setup</h3>
                    <div class="alert alert-info" style="padding: 10px; background-color: #d1ecf1; color: #0c5460; border-radius: 4px; margin-bottom: 15px;">
                        <p><strong>Note:</strong> Filestash requires a two-step installation process:</p>
                        <ol style="margin-left: 20px; margin-top: 10px;">
                            <li>After installation, go to http://[your-ip]:8334 to create an admin password</li>
                            <li>Then run the <code>complete_setup.sh</code> script in the installation directory</li>
                        </ol>
                    </div>
                </div>
            `;
        }
        // WatchYourLAN
        else if (containerName === 'watchyourlan' || containerName === 'watchyourlanarm') {
            additionalFields = `
                <div class="watchyourlan-section" style="margin-bottom: 20px; padding: 15px; background: var(--color-background-dark); border-radius: 8px;">
                    <h3 style="margin-bottom: 15px;">WatchYourLAN Settings</h3>
                    <div class="form-group">
                        <label for="network-interface">Network Interface</label>
                        <input type="text" id="network-interface" name="network-interface" placeholder="Enter network interface" class="form-control">
                    </div>
                    <div class="form-group">
                        <label for="ip-address">IP Address</label>
                        <input type="text" id="ip-address" name="ip-address" placeholder="Enter IP address" class="form-control">
                    </div>
                </div>
            `;
        }
        // Prometheus
        else if (containerName === 'prometheus') {
            additionalFields = `
                <div class="prometheus-section" style="margin-bottom: 20px; padding: 10px; background: var(--color-background-dark); border-radius: 8px;">
                    <h3 style="margin-bottom: 15px;">Prometheus Setup</h3>
                    <div class="alert alert-info" style="padding: 10px; background-color: #d1ecf1; color: #0c5460; border-radius: 4px; margin-bottom: 15px;">
                        <p><strong>Note:</strong> Prometheus configuration files will be created automatically:</p>
                        <ul style="margin-left: 20px; margin-top: 10px;">
                            <li><code>prometheus.yml</code> - Main configuration file</li>
                            <li><code>alert.yml</code> - Alert rules configuration</li>
                        </ul>
                        <p style="margin-top: 10px;">After installation, Prometheus will be available at <code>http://[your-ip]:9090</code></p>
                    </div>
                </div>
            `;
        }
        // Standard-Volumes für andere Container
        else {
            additionalFields = `
                <div class="config-section" style="margin-bottom: 20px; padding: 15px; background: var(--color-background-dark); border-radius: 8px;">
                    <div class="section-header" onclick="toggleConfigSection(this)" style="cursor: pointer; display: flex; justify-content: space-between; align-items: center;">
                        <h3 style="margin-bottom: 0;">Advanced Configuration</h3>
                        <i class="fa fa-chevron-down"></i>
                    </div>
                    <div class="config-content" style="display: none; margin-top: 15px;">
                        <div class="form-group">
                            <label for="config-file">Configuration File</label>
                            <input type="file" id="config-file" name="config-file" class="form-control">
                            <small class="hint">Upload a custom configuration file (optional)</small>
                        </div>
                    </div>
                </div>
            `;
        }

        // Erstelle Modal
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.id = 'installModal';  // Add ID for easier reference
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h2>
                        <img src="${getContainerLogo(containerName)}" 
                             alt="${containerName} logo" 
                             style="width: 24px; height: 24px; margin-right: 8px;">
                        Install ${containerName}
                    </h2>
                    <button class="close-modal" onclick="closeModal()">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="section">
                        <h3>Port Configuration</h3>
                        <div class="port-mappings">
                            ${createPortMappings(ports)}
                        </div>
                    </div>
                    ${environment && Object.keys(environment).length > 0 ? `
                        <div class="section">
                            <h3>Environment Variables</h3>
                            <div class="environment-vars">
                                ${createEnvironmentVars(environment)}
                            </div>
                        </div>
                    ` : ''}
                    ${additionalFields}
                </div>
                <div class="modal-footer">
                    <button class="install-btn" onclick="executeInstall('${containerName}')">Install</button>
                    <button class="cancel-btn" onclick="closeModal()">Cancel</button>
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
        
        // Schließen-Funktionalität
        modal.querySelector('.close-modal').addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
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
        'PGID': '<small class="hint">Group ID for container permissions</small>'
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
        const installButton = document.querySelector('.modal .install-btn');
        if (installButton) {
            installButton.disabled = true;
            installButton.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Installing...';
        }

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
            
            // Erstelle eine einfache Konfiguration ohne Authentifizierungseinstellungen
            // Die eigentliche Authentifizierung wird vom Backend konfiguriert
            const configContent = `
listener 1883
persistence true
persistence_location /mosquitto/data/
log_dest file /mosquitto/log/mosquitto.log
`;
            
            // Sende Config-Erstellung mit
            installData.config_files = {
                'config/mosquitto.conf': configContent
            };
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
            const stacksDir = document.getElementById('stacks-dir')?.value || '/home/webDock/docker-compose-data';
            
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
            
            // Set environment variables
            installData.env = {
                'WUD_SERVER_PORT': '3000',
                'WUD_WATCHER_DOCKER': 'true',
                'WUD_WATCHER_DOCKER_WATCHALL': 'true',
                'WUD_WATCHER_LOCAL_WATCHALL': 'true',
                'WUD_REGISTRY_HUB_PUBLIC': 'true'
            };
            
            console.debug('WUD configuration:', installData);
        }
        // Filestash-spezifische Konfiguration
        else if (containerName === 'filestash') {
            installData.volumes = [
                `./data:/app/data`
            ];
            
            // Debug-Logging
            console.log('=== Filestash Installation Config ===');
            console.log('Note: Filestash requires manual setup after installation');
        }
        // WatchYourLAN-spezifische Konfiguration
        else if (containerName === 'watchyourlan' || containerName === 'watchyourlanarm') {
            installData.volumes = [
                `./data:/data`
            ];
            
            // Hole Netzwerkschnittstelle und IP-Adresse
            const networkInterface = document.getElementById('network-interface')?.value || 'eth0';
            
            // Hole die IP-Adresse des Hosts
            let ipAddress = document.getElementById('ip-address')?.value || '';
            if (!ipAddress) {
                // Versuche die IP-Adresse automatisch zu ermitteln
                try {
                    const response = await fetch('/api/system/info');
                    const systemInfo = await response.json();
                    ipAddress = systemInfo.ip_address || window.location.hostname;
                } catch (error) {
                    console.error('Error getting IP address:', error);
                    ipAddress = window.location.hostname;
                }
            }
            
            // Füge WatchYourLAN-spezifische Konfiguration hinzu
            installData.watchyourlan = {
                interface: networkInterface,
                ip_address: ipAddress
            };
            
            // Debug-Logging
            console.log('=== WatchYourLAN Installation Config ===');
            console.log('Network Interface:', networkInterface);
            console.log('IP Address:', ipAddress);
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
            
            // Debug-Logging
            console.log('=== Prometheus Installation Config ===');
            console.log('Note: Prometheus configuration files will be created automatically');
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

        if (result.status === 'success') {
            // Spezielle Nachricht für Filestash
            if (containerName === 'filestash') {
                showNotification('success', `${containerName} installed. Please complete the setup by running the complete_setup.sh script in the installation directory.`);
            } else {
                showNotification('success', `${containerName} installed successfully`);
            }
            
            // Schließe das Modal
            console.log('Closing modal after successful installation');
            closeModal();
            
            // Aktualisiere die Container-Anzeige
            updateContainerStatus(true);
        } else {
            throw new Error(result.message || 'Installation failed');
        }

    } catch (error) {
        console.error('Installation error:', error);
        showNotification('error', error.message || 'Installation failed');
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
        'influxdb': 'influxdb.png',
        'influxdb-arm': 'influxdb.png',
        'influxdb-x86': 'influxdb.png',
        'nodeexporter': 'nodeexporter.png',
        'webdock-ui': 'webdock.png',
        'bangertech-ui': 'bangertech.png',
        'frontail': 'bangertech.png',
        'bambucam': 'bambucam.png',
        'scrypted': 'scrypted.png',
        'spoolman': 'spoolman.png',
        'backuppro': 'backuppro.png',
        'watchyourlan': 'watchyourlan.png',
        'watchyourlanarm': 'watchyourlan.png'
    };
    
    // Bestimme den Dateinamen des Logos
    const logoFile = logoMapping[containerName] || 'bangertech.png';
    
    // Debug-Logging
    console.debug(`Container logo for ${containerName}: ${logoFile}`);
    
    return `/static/img/icons/${logoFile}`;
}

function createContainerCard(container) {
    const logoUrl = getContainerLogo(container.name);
    return `
        <div class="container-card">
            <div class="status-indicator ${container.status}"></div>
            <div class="container-logo">
                <img src="${logoUrl}" 
                     alt="${container.name} logo" 
                     onerror="this.src='/static/img/icons/bangertech.png'">
            </div>
            <div class="name-with-settings">
                <h3>${container.name}</h3>
                ${container.installed ? `
                    <button class="info-btn" onclick="openInfo('${container.name}')" title="Container Information">
                        <i class="fa fa-info-circle"></i>
                    </button>
                ` : ''}
            </div>
            <p>Port: ${container.port ? 
                `<a href="http://${window.location.hostname}:${container.port}" 
                    target="_blank" 
                    class="port-link"
                    title="Open container interface"
                >${container.port}</a>` 
                : 'N/A'}</p>
            <p>${container.description || ''}</p>
            <div class="actions">
                ${container.installed ? `
                    <div class="button-group">
                        <button class="status-btn ${container.status}" onclick="toggleContainer('${container.name}')">
                            ${container.status === 'running' ? 'Stop' : 'Start'}
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
        const info = await response.json();
        
        // Debug-Ausgabe
        console.log('Container Info:', info);
        
        // Hole aktuelle docker-compose.yml
        const configResponse = await fetch(`/api/container/${containerName}/config`);
        console.log('Config Response:', configResponse);
        if (!configResponse.ok) {
            throw new Error(`Failed to load config: ${configResponse.status} ${configResponse.statusText}`);
        }
        const config = await configResponse.json();
        console.log('Config Data:', JSON.stringify(config, null, 2));
        
        // Überprüfe ob die YAML-Daten vorhanden sind
        if (!config || !config.yaml) {
            console.error('Missing YAML data in config:', config);
            throw new Error('No YAML configuration found');
        }
        
        // Erstelle Modal
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h2><i class="fa fa-info-circle"></i> ${containerName}</h2>
                    <button class="close-modal">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="info-tabs">
                        <button class="tab-btn active" data-tab="info">Information</button>
                        <button class="tab-btn" data-tab="config">Configuration</button>
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
                                <textarea id="compose-config" rows="20" spellcheck="false">${config.yaml}</textarea>
                            </div>
                            <div class="form-actions">
                                <button type="button" onclick="saveSettings('${containerName}')" class="save-btn">
                                    <i class="fa fa-save"></i> Save & Restart
                                </button>
                            </div>
                        </form>
                    </div>
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
    const config = document.getElementById('compose-config').value;
    const saveBtn = document.querySelector('.save-btn');
    
    try {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Saving...';
        
        const response = await fetch(`/api/container/${containerName}/config`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ yaml: config })
        });
        
        const data = await response.json();
        if (data.status === 'success') {
            showNotification('success', 'Settings saved successfully');
            
            // Starte Container neu
            const restartResponse = await fetch(`/api/container/${containerName}/restart`, {
                method: 'POST'
            });
            
            if (restartResponse.ok) {
                showNotification('success', 'Container restarted successfully');
            }
            
            closeModal();
            updateContainerStatus();
        } else {
            throw new Error(data.message || 'Failed to save settings');
        }
    } catch (error) {
        console.error('Error:', error);
        showNotification('error', `Error saving settings: ${error.message}`);
    } finally {
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
document.addEventListener('DOMContentLoaded', async () => {
    // Erste Ladung
    await updateContainerStatus();
    
    // Periodische Updates (optional)
    setInterval(updateContainerStatus, UPDATE_INTERVAL);
});

// Nur manuelles Update über Button
document.addEventListener('DOMContentLoaded', async () => {
    // Erste Ladung
    await updateContainerStatus();
    
    // Refresh Button (falls gewünscht)
    const refreshButton = document.getElementById('refresh-button');
    if (refreshButton) {
        refreshButton.addEventListener('click', updateContainerStatus);
    }
});

// Füge diese Funktion vor der updateContainerStatus Funktion hinzu
function addContainerEventListeners() {
    // Event-Listener für Install-Buttons
    document.querySelectorAll('.install-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const containerName = e.target.closest('.container-card').querySelector('h3').textContent;
            installContainer(containerName);
        });
    });
    
    // Event-Listener für Status-Buttons
    document.querySelectorAll('.status-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const containerName = e.target.closest('.container-card').querySelector('h3').textContent;
            toggleContainer(containerName);
        });
    });
    
    // Event-Listener für Container-Karten (falls vorhanden)
    document.querySelectorAll('.container-card').forEach(card => {
        card.addEventListener('click', function(e) {
            // Nur reagieren wenn nicht auf einen Button geklickt wurde
            if (!e.target.closest('button')) {
                const containerName = this.querySelector('h3').textContent;
                showContainerDetails(containerName);
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

function updateContainerStatus(forceRefresh = false) {
    fetch('/api/containers')
        .then(response => response.json())
        .then(containers => {
            console.log('Containers:', containers); // Debug log
            // Hole Kategorien
            return fetch('/api/categories')
                .then(response => response.json())
                .then(categories => {
                    console.log('Categories:', categories); // Debug log
                    return { containers, categories };
                });
        })
        .then(({ containers, categories }) => {
            const containerList = document.getElementById('container-list');
            containerList.innerHTML = ''; // Clear existing containers
            
            // Iteriere über alle Kategorien
            Object.entries(categories.categories).forEach(([categoryId, category]) => {
                if (category.containers && category.containers.length > 0) {
                    // Erstelle Kategorie-Header
                    const categorySection = document.createElement('div');
                    categorySection.className = 'category-section';
                    categorySection.setAttribute('data-category', categoryId);
                    
                    const categoryHeader = document.createElement('h2');
                    categoryHeader.innerHTML = `<i class="fa ${category.icon}"></i> ${category.name}`;
                    categorySection.appendChild(categoryHeader);
                    
                    // Container-Grid für diese Kategorie
                    const containerGrid = document.createElement('div');
                    containerGrid.className = 'container-grid';
                    
                    // Füge Container dieser Kategorie hinzu
                    category.containers.forEach(containerId => {
                        const containerInfo = containers.find(c => c.name === containerId);
                        if (containerInfo) {
                            const containerCard = createContainerCard(containerInfo);
                            containerGrid.appendChild(containerCard);
                        }
                    });
                    
                    if (containerGrid.children.length > 0) {
                        categorySection.appendChild(containerGrid);
                        containerList.appendChild(categorySection);
                    }
                }
            });
        })
        .catch(error => console.error('Error:', error));
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