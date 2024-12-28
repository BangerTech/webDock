// Definiere loadingOverlay global
let loadingOverlay;

// Behalte die Scroll-Position
let lastScrollPosition = 0;
let lastContainerStates = new Map();

// Globale closeModal Funktion
function closeModal() { const modal = document.querySelector('.modal'); if (modal) { modal.classList.remove('show'); setTimeout(() => modal.remove(), 300); } }

document.addEventListener('DOMContentLoaded', function() {
    loadingOverlay = document.getElementById('loading-overlay');
    
    // Container-Status-Updates als globale Funktion
    window.updateContainerStatus = function(preserveScroll = false) {
        if (preserveScroll) {
            lastScrollPosition = window.scrollY;
        }
        
        if (loadingOverlay) {
            loadingOverlay.style.display = 'flex';
        }
        
        fetch('/api/containers')
            .then(response => response.json())
            .then(data => {
                const groups = document.querySelector('.container-groups');
                if (!groups) return;
                
                // Hole zuerst die Kategorien
                fetch('/api/categories')
                    .then(response => response.json())
                    .then(categoriesData => {
                        const categories = categoriesData.categories;
                        
                        // Gruppiere Container nach Kategorien
                        const groupedContainers = {};
                        
                        // Füge "Other" Kategorie zuerst hinzu
                        groupedContainers['Other'] = {
                            name: 'Other',
                            icon: 'fa-cube',
                            containers: []
                        };
                        
                        // Initialisiere alle Kategorien
                        Object.entries(categories || {}).forEach(([id, category]) => {
                            groupedContainers[category.name] = {
                                name: category.name,
                                icon: category.icon,
                                containers: []
                            };
                        });
                        
                        // Sortiere Container in ihre Kategorien
                        Object.values(data).forEach(group => {
                            group.containers.forEach(container => {
                                let categoryName = 'Other';
                                
                                // Finde die passende Kategorie
                                Object.entries(categories || {}).forEach(([id, category]) => {
                                    if (category.containers && category.containers.includes(container.name)) {
                                        categoryName = category.name;
                                    }
                                });
                                
                                groupedContainers[categoryName].containers.push(container);
                            });
                        });
                        
                        // Zeige nur Kategorien mit Containern
                        const sortedGroups = Object.entries(groupedContainers)
                            .filter(([name, group]) => group.containers.length > 0)
                            .sort(([nameA], [nameB]) => {
                                if (nameA === 'Other') return 1;
                                if (nameB === 'Other') return -1;
                                return nameA.localeCompare(nameB);
                            });
                        
                        groups.innerHTML = '';
                        
                        sortedGroups.forEach(([name, group]) => {
                            if (group.containers.length > 0) {
                                groups.innerHTML += `
                                    <div class="group-section">
                                        <h2><i class="fa ${group.icon}"></i> ${name}</h2>
                                        <div class="container-grid">
                                            ${group.containers.map(container => createContainerCard(container)).join('')}
                                        </div>
                                    </div>
                                `;
                            }
                        });
                        
                        // Füge Event-Listener für die Buttons hinzu
                        document.querySelectorAll('.install-btn').forEach(btn => {
                            btn.addEventListener('click', (e) => {
                                const containerName = e.target.closest('.container-card').querySelector('h3').textContent;
                                installContainer(containerName);
                            });
                        });
                        
                        document.querySelectorAll('.status-btn').forEach(btn => {
                            btn.addEventListener('click', (e) => {
                                const containerName = e.target.closest('.container-card').querySelector('h3').textContent;
                                toggleContainer(containerName);
                            });
                        });
                    });
            })
            .catch(error => {
                console.error('Error:', error);
                showNotification('error', 'Failed to load containers');
            })
            .finally(() => {
                if (loadingOverlay) {
                    loadingOverlay.style.display = 'none';
                }
                if (preserveScroll) {
                    window.scrollTo(0, lastScrollPosition);
                }
            });
    }

    // Initialer Update-Aufruf
    updateContainerStatus(false);

    // Periodische Updates
    setInterval(() => {
        if (!document.querySelector('.modal.show') && !document.activeElement.tagName.match(/input|select|textarea/i)) {
            updateContainerStatus(true);
        }
    }, 30000);

    // Event-Listener für manuelle Aktualisierung
    document.addEventListener('keydown', function(e) {
        // Manuelle Aktualisierung mit F5 oder Strg+R verhindern
        if (e.key === 'F5' || (e.ctrlKey && e.key === 'r')) {
            e.preventDefault();
            updateContainerStatus(true);
        }
    });

    // Tab Switching
    const tabs = document.querySelectorAll('[data-tab]');
    tabs.forEach(tab => {
        tab.addEventListener('click', (e) => {
            e.preventDefault();
            const targetId = tab.getAttribute('data-tab');
            
            // Deaktiviere alle Tabs
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.remove('active');
            });
            document.querySelectorAll('[data-tab]').forEach(tab => {
                tab.classList.remove('active');
            });
            
            // Aktiviere ausgewählten Tab
            document.getElementById(targetId).classList.add('active');
            tab.classList.add('active');
        });
    });

    // System Status Updates
    function updateSystemStatus() {
        fetch('/api/system/status')
            .then(response => response.json())
            .then(data => {
                document.getElementById('cpu-value').textContent = `${data.cpu}%`;
                document.getElementById('memory-value').textContent = `${data.memory}%`;
                document.getElementById('disk-value').textContent = `${data.disk}%`;
                
                // Update Gauge Charts
                updateGaugeChart('cpu-gauge', data.cpu);
                updateGaugeChart('memory-gauge', data.memory);
                updateGaugeChart('disk-gauge', data.disk);
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

    // System Logs Updates
    function updateSystemLogs() {
        fetch('/api/system/logs')
            .then(response => response.json())
            .then(data => {
                const logsElement = document.getElementById('system-logs');
                logsElement.textContent = data.logs.join('\n');
                logsElement.scrollTop = logsElement.scrollHeight;
            })
            .catch(error => console.error('Error updating system logs:', error));
    }

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
                
                // Füge zuerst die "Other" Kategorie hinzu
                const otherItem = document.createElement('div');
                otherItem.className = 'category-item';
                otherItem.dataset.id = 'other';
                otherItem.draggable = true;
                
                otherItem.innerHTML = `
                    <div class="drag-handle">
                        <i class="fa fa-bars"></i>
                    </div>
                    <div class="category-info">
                        <i class="fa fa-cube"></i>
                        <span>Other</span>
                    </div>
                    <div class="category-actions">
                        <button class="edit-category" disabled title="Default category cannot be edited">
                            <i class="fa fa-edit"></i>
                        </button>
                        <button class="delete-category" disabled title="Default category cannot be deleted">
                            <i class="fa fa-trash"></i>
                        </button>
                    </div>
                `;
                
                // Drag & Drop Event-Listener für Other
                otherItem.addEventListener('dragstart', handleDragStart);
                otherItem.addEventListener('dragend', handleDragEnd);
                otherItem.addEventListener('dragover', handleDragOver);
                otherItem.addEventListener('drop', handleDrop);
                otherItem.addEventListener('dragenter', handleDragEnter);
                otherItem.addEventListener('dragleave', handleDragLeave);
                
                categoryList.appendChild(otherItem);
                
                // Sortiere Kategorien nach ihrer Position (falls vorhanden)
                const sortedCategories = Object.entries(data.categories)
                    .sort(([, a], [, b]) => (a.position || 0) - (b.position || 0));
                
                sortedCategories.forEach(([id, category]) => {
                    const categoryItem = document.createElement('div');
                    categoryItem.className = 'category-item';
                    categoryItem.dataset.id = id;
                    categoryItem.draggable = true;
                    
                    categoryItem.innerHTML = `
                        <div class="drag-handle">
                            <i class="fa fa-bars"></i>
                        </div>
                        <div class="category-info">
                            <i class="fa ${category.icon}"></i>
                            <span>${category.name}</span>
                        </div>
                        <div class="category-actions">
                            <button class="edit-category">
                                <i class="fa fa-edit"></i>
                            </button>
                            <button class="delete-category">
                                <i class="fa fa-trash"></i>
                            </button>
                        </div>
                    `;
                    
                    // Event-Listener für Edit und Delete
                    categoryItem.querySelector('.edit-category').addEventListener('click', () => editCategory(id));
                    categoryItem.querySelector('.delete-category').addEventListener('click', () => deleteCategory(id));
                    
                    // Drag & Drop Event-Listener
                    categoryItem.addEventListener('dragstart', handleDragStart);
                    categoryItem.addEventListener('dragend', handleDragEnd);
                    categoryItem.addEventListener('dragover', handleDragOver);
                    categoryItem.addEventListener('drop', handleDrop);
                    categoryItem.addEventListener('dragenter', handleDragEnter);
                    categoryItem.addEventListener('dragleave', handleDragLeave);
                    
                    categoryList.appendChild(categoryItem);
                });
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
        fetch('/api/categories')
            .then(response => response.json())
            .then(data => {
                const category = data.categories[id];
                document.getElementById('category-modal-title').textContent = 'Edit Category';
                document.getElementById('category-name').value = category.name;
                document.getElementById('category-icon').value = category.icon;
                document.getElementById('category-description').value = category.description;
                document.getElementById('category-form').dataset.editing = id;
                
                loadAvailableContainers(category.containers);
                document.getElementById('category-modal').classList.add('show');
            });
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

    function loadAvailableContainers(selectedContainers = []) {
        fetch('/api/containers')
            .then(response => response.json())
            .then(data => {
                const containerSelector = document.querySelector('.container-selector');
                containerSelector.innerHTML = '';
                
                const allContainers = new Set();
                Object.values(data).forEach(group => {
                    group.containers.forEach(container => {
                        allContainers.add(container.name);
                    });
                });
                
                Array.from(allContainers).sort().forEach(container => {
                    containerSelector.innerHTML += `
                        <label class="container-option">
                            <input type="checkbox" value="${container}" 
                                ${selectedContainers.includes(container) ? 'checked' : ''}>
                            ${container}
                        </label>
                    `;
                });
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
        // Hole Template-Konfiguration
        const response = await fetch(`/api/container/${containerName}/config?template=true`);
        if (!response.ok) {
            throw new Error(`Failed to load config: ${response.status}`);
        }
        const config = await response.json();
        
        // Parse YAML für Environment-Variablen und Ports
        const yamlConfig = jsyaml.load(config.yaml);
        const service = yamlConfig.services[containerName];
        
        // Extrahiere Ports und Environment-Variablen
        const ports = service.ports || [];
        const environment = service.environment || {};
        
        // Erstelle Modal
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h2><i class="fa fa-download"></i> Install ${containerName}</h2>
                    <button class="close-modal">&times;</button>
                </div>
                <div class="modal-body">
                    <form id="install-form">
                        ${ports.length > 0 ? `
                            <div class="config-section">
                                <h3><i class="fa fa-globe"></i> Port Configuration</h3>
                                ${ports.map((port, index) => {
                                    const [hostPort, containerPort] = port.split(':');
                                    return `
                                        <div class="form-group">
                                            <label>Port Mapping (Container Port: ${containerPort}):</label>
                                            <input type="number" 
                                                   name="port_${index}" 
                                                   value="${hostPort}"
                                                   min="1"
                                                   max="65535"
                                                   class="port-input">
                                        </div>
                                    `;
                                }).join('')}
                            </div>
                        ` : ''}
                        
                        ${Object.keys(environment).length > 0 ? `
                            <div class="config-section">
                                <h3><i class="fa fa-cogs"></i> Environment Variables</h3>
                                ${Object.entries(environment).map(([key, defaultValue]) => `
                                    <div class="form-group">
                                        <label>${key}:</label>
                                        <input type="text" 
                                               name="env_${key}" 
                                               value="${defaultValue || ''}"
                                               placeholder="${getEnvPlaceholder(key)}"
                                               class="env-input">
                                        ${getEnvDescription(key)}
                                    </div>
                                `).join('')}
                            </div>
                        ` : ''}
                    </form>
                </div>
                <div class="modal-footer">
                    <div class="install-progress" style="display: none;">
                        <div class="docker-spinner">
                            <i class="fa fa-docker fa-spin"></i>
                        </div>
                        <span class="install-status">Installing...</span>
                    </div>
                    <button class="install-btn" onclick="executeInstall('${containerName}')">
                        <i class="fa fa-download"></i> Install
                    </button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        setTimeout(() => modal.classList.add('show'), 10);
        
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
    const form = document.getElementById('install-form');
    const modalBody = document.querySelector('.modal-body');
    const modalFooter = document.querySelector('.modal-footer');
    
    try {
        // Zeige Installations-Animation
        modalBody.innerHTML = `
            <div class="install-progress">
                <div class="install-spinner">
                    <i class="fa fa-docker fa-spin"></i>
                </div>
                <span class="install-status">Installing ${containerName}...</span>
            </div>
        `;
        modalFooter.style.display = 'none';

        // Sammle die Formulardaten
        const formData = new FormData(form);
        const ports = {};
        const envVars = {};
        
        // Sammle Ports
        formData.forEach((value, key) => {
            if (key.startsWith('port_')) {
                const index = key.replace('port_', '');
                ports[index] = value;
            } else if (key.startsWith('env_')) {
                const envKey = key.replace('env_', '');
                if (value) {
                    envVars[envKey] = value;
                }
            }
        });

        // Hole die aktuelle data-location aus den Settings
        const locationResponse = await fetch('/api/settings/data-location');
        const locationData = await locationResponse.json();
        const baseDir = locationData.location;
        
        const response = await fetch('/api/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: containerName,
                path: `${baseDir}/${containerName}`,
                ports: ports,
                env: envVars
            })
        });
        
        const data = await response.json();
        if (data.status === 'success') {
            // Zeige Erfolgs-Nachricht
            modalBody.innerHTML = `
                <div class="install-success">
                    <i class="fa fa-check-circle"></i>
                    <h3>${containerName} installed successfully!</h3>
                    <p>The container has been installed and started.</p>
                </div>
            `;
            
            // Aktualisiere Container-Status
            updateContainerStatus(true);
            
            // Schließe Modal automatisch nach 3 Sekunden
            setTimeout(() => {
                closeModal();
            }, 3000);
        } else {
            throw new Error(data.message || 'Installation failed');
        }
    } catch (error) {
        console.error('Error:', error);
        // Zeige Fehler-Nachricht
        modalBody.innerHTML = `
            <div class="install-success error">
                <i class="fa fa-times-circle"></i>
                <h3>Installation Failed</h3>
                <p>${error.message}</p>
            </div>
        `;
        modalFooter.innerHTML = `
            <button class="btn" onclick="closeModal()">Close</button>
        `;
        modalFooter.style.display = 'flex';
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

function createContainerCard(container) {
    return `
        <div class="container-card">
            <div class="status-indicator ${container.status}"></div>
            <div class="container-header">
                <div class="name-with-settings">
                    <h3>${container.name}</h3>
                    ${container.installed ? `
                        <button class="info-btn" onclick="openInfo('${container.name}')" title="Container Information">
                            <i class="fa fa-info-circle"></i>
                        </button>
                    ` : ''}
                </div>
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
                    <button class="status-btn" onclick="toggleContainer('${container.name}')">
                        ${container.status === 'running' ? 'Stop' : 'Start'}
                    </button>
                    <button class="update-btn${container.update_available ? ' update-available' : ''}" 
                            onclick="updateContainer('${container.name}')"
                            title="${container.update_available ? 'Update available!' : 'Check for updates'}">
                        Update
                    </button>
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
                                <p>${info.network ? `<span class="network-badge">${info.network}</span>` : 'N/A'}</p>
                            </div>
                            <div class="info-item">
                                <h3><i class="fa fa-hdd"></i> Volumes</h3>
                                ${info.volumes && info.volumes.length > 0 ? `
                                    <ul class="volume-list">
                                        ${info.volumes.map(v => `<li><code>${v}</code></li>`).join('')}
                                    </ul>
                                ` : '<p>No volumes</p>'}
                            </div>
                            <div class="info-item">
                                <h3><i class="fa fa-globe"></i> Ports</h3>
                                ${info.ports && info.ports.length > 0 ? `
                                    <ul class="port-list">
                                        ${info.ports.map(p => `
                                            <li>
                                                <code>${p.published}:${p.target}</code>
                                                ${p.published ? `
                                                    <a href="http://${window.location.hostname}:${p.published}" 
                                                       target="_blank" 
                                                       class="port-link">
                                                        <i class="fa fa-external-link"></i>
                                                    </a>
                                                ` : ''}
                                            </li>
                                        `).join('')}
                                    </ul>
                                ` : '<p>No ports exposed</p>'}
                            </div>
                            <div class="info-item">
                                <h3><i class="fa fa-terminal"></i> Image</h3>
                                <p><code>${info.image || 'N/A'}</code></p>
                            </div>
                            <div class="info-item">
                                <h3><i class="fa fa-clock-o"></i> Created</h3>
                                <p>${new Date(info.created).toLocaleString()}</p>
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