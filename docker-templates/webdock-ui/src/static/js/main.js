/**
 * WebDock UI - Main JavaScript
 * Modulares Design mit IIFE-Pattern
 */
(function() {
    'use strict';
    
    // Konfigurationskonstanten
    const CONFIG = {
        API_BASE_URL: '/api',
        WS_URL: `ws://${window.location.host}/ws`,
        REFRESH_INTERVAL: 5 * 60 * 1000, // 5 Minuten
        RECONNECT_INTERVAL: 3000, // 3 Sekunden
        CACHE_TTL: 10 * 60 * 1000, // 10 Minuten
        NOTIFICATION_TIMEOUT: 5000, // 5 Sekunden
        MAX_RECONNECT_ATTEMPTS: 10,
        WS_RECONNECT_DELAY: 5000, // 5 Sekunden WebSocket-Reconnect-Verzögerung
        DEBUG: true // Debug-Modus aktivieren
    };
    
    // Module und Funktionen werden hier definiert
    // und später exportiert
    
    // Das vorhandene WebDockLogger-Objekt verbessern
    const WebDockLogger = window.WebDockLogger || {
        debug: function(...args) { console.debug('[WebDock]', ...args); },
        log: function(...args) { console.log('[WebDock]', ...args); },
        info: function(...args) { console.info('[WebDock]', ...args); },
        warn: function(...args) { console.warn('[WebDock]', ...args); },
        error: function(...args) { console.error('[WebDock]', ...args); }
    };
    
    /**
     * Einheitlicher Cache-Mechanismus
     * Verwaltet verschiedene Caches mit TTL und automatischem Invalidieren
     */
    const CacheManager = {
        // Cache-Speicher
        _stores: {
            categories: { data: null, timestamp: 0 },
            containers: { data: null, timestamp: 0 },
            descriptions: { data: null, timestamp: 0 },
            containerStatus: { data: {}, timestamp: 0 }
        },
        
        // Cache-Element setzen
        set: function(key, data, ttl = CONFIG.CACHE_TTL) {
            if (!this._stores[key]) {
                this._stores[key] = { data: null, timestamp: 0 };
            }
            
            this._stores[key].data = data;
            this._stores[key].timestamp = Date.now() + ttl;
            
            if (CONFIG.DEBUG) {
                WebDockLogger.debug(`Cache für "${key}" gesetzt, gültig bis ${new Date(this._stores[key].timestamp).toLocaleTimeString()}`);
            }
            
            return data;
        },
        
        // Cache-Element abrufen
        get: function(key) {
            const cache = this._stores[key];
            
            if (!cache || !cache.data) {
                return null;
            }
            
            // Prüfe, ob der Cache noch gültig ist
            if (Date.now() > cache.timestamp) {
                if (CONFIG.DEBUG) {
                    WebDockLogger.debug(`Cache für "${key}" ist abgelaufen`);
                }
                return null;
            }
            
            if (CONFIG.DEBUG) {
                WebDockLogger.debug(`Cache-Hit für "${key}", gültig bis ${new Date(cache.timestamp).toLocaleTimeString()}`);
            }
            
            return cache.data;
        },
        
        // Cache für einen bestimmten Key löschen
        clear: function(key) {
            if (key && this._stores[key]) {
                this._stores[key].data = null;
                this._stores[key].timestamp = 0;
                WebDockLogger.debug(`Cache für "${key}" wurde gelöscht`);
            } 
            else if (!key) {
                // Alle Caches löschen
                Object.keys(this._stores).forEach(k => {
                    this._stores[k].data = null;
                    this._stores[k].timestamp = 0;
                });
                WebDockLogger.debug('Alle Caches wurden gelöscht');
            }
        },
        
        // Prüfen, ob ein Cache-Element gültig ist
        isValid: function(key) {
            const cache = this._stores[key];
            return cache && cache.data && Date.now() <= cache.timestamp;
        }
    };
    
    /**
     * Verbessertes Benachrichtigungssystem
     * Bietet einheitliches API für verschiedene Benachrichtigungstypen
     */
    const NotificationManager = {
        // Konfiguration
        _config: {
            containerSelector: '#notification-container',
            defaultDuration: 3000,
            animations: {
                show: 'notification-show',
                hide: 'notification-hide'
            },
            types: {
                success: { icon: 'check-circle', color: 'var(--success-color, #28a745)' },
                error: { icon: 'exclamation-circle', color: 'var(--error-color, #dc3545)' },
                warning: { icon: 'exclamation-triangle', color: 'var(--warning-color, #ffc107)' },
                info: { icon: 'info-circle', color: 'var(--info-color, #17a2b8)' }
            }
        },
        
        // Container für Benachrichtigungen abrufen oder erstellen
        _getContainer: function() {
            let container = document.querySelector(this._config.containerSelector);
            
            if (!container) {
                container = document.createElement('div');
                container.id = this._config.containerSelector.replace('#', '');
                container.className = 'notification-container';
                document.body.appendChild(container);
            }
            
            return container;
        },
        
        // HTML für eine Benachrichtigung erstellen
        _createNotificationHTML: function(type, message) {
            const typeConfig = this._config.types[type] || this._config.types.info;
            
            return `
                <div class="notification ${type}">
                    <div class="notification-icon">
                        <i class="fa fa-${typeConfig.icon}"></i>
                    </div>
                    <div class="notification-content">
                        <span>${this._escapeHTML(message)}</span>
                    </div>
                    <button class="notification-close">
            <i class="fa fa-times"></i>
        </button>
                </div>
            `;
        },
        
        // HTML escapen
        _escapeHTML: function(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        },
        
        // Benachrichtigung anzeigen
        show: function(type, message, duration = this._config.defaultDuration) {
            const container = this._getContainer();
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = this._createNotificationHTML(type, message);
            
            const notification = tempDiv.firstElementChild;
            container.appendChild(notification);
            
            // Event-Listener für Close-Button
            notification.querySelector('.notification-close').addEventListener('click', () => {
                this.close(notification);
            });
            
            // Animation starten
    setTimeout(() => notification.classList.add('show'), 10);
    
            // Automatisches Schließen nach Ablauf der Dauer
    if (duration) {
                setTimeout(() => this.close(notification), duration);
            }
            
            return notification;
        },
        
        // Benachrichtigung schließen
        close: function(notification) {
            if (!notification) return;
            
            notification.classList.remove('show');
            notification.classList.add('hide');
            
            // Entferne Element nach Animation
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        },
        
        // Kurzform-Funktionen für verschiedene Typen
        success: function(message, duration) {
            return this.show('success', message, duration);
        },
        
        error: function(message, duration) {
            return this.show('error', message, duration);
        },
        
        warning: function(message, duration) {
            return this.show('warning', message, duration);
        },
        
        info: function(message, duration) {
            return this.show('info', message, duration);
        }
    };
    
    /**
     * DOM-Cache-System
     * Speichert Referenzen auf häufig verwendete DOM-Elemente
     */
    const DOMCache = {
        // Speicher für DOM-Elemente
        _elements: {},
        
        // Element abrufen oder finden und cachen
        get: function(selector, parent = document) {
            // Wenn das Element bereits gecached ist, verwende es
            if (this._elements[selector]) {
                return this._elements[selector];
            }
            
            // Element finden und cachen
            const element = parent.querySelector(selector);
            if (element) {
                this._elements[selector] = element;
            }
            
            return element;
        },
        
        // Mehrere Elemente abrufen
        getAll: function(selector, parent = document) {
            // Generiere einen Cache-Key für NodeLists
            const key = `all:${selector}`;
            
            // Wenn die Elemente bereits gecached sind, verwende sie
            if (this._elements[key]) {
                return this._elements[key];
            }
            
            // Elemente finden und cachen
            const elements = parent.querySelectorAll(selector);
            if (elements.length > 0) {
                this._elements[key] = elements;
            }
            
            return elements;
        },
        
        // Element zum Cache hinzufügen
        set: function(selector, element) {
            this._elements[selector] = element;
            return element;
        },
        
        // Cache für ein Element oder alle Elemente löschen
        clear: function(selector) {
            if (selector) {
                delete this._elements[selector];
            } else {
                this._elements = {};
            }
        },
        
        // Hilfsmethode: DOM-Element mit ID abrufen
        getId: function(id) {
            return this.get(`#${id}`);
        }
    };
    
    /**
     * WebSocket-Management-System
     * Verwaltet die WebSocket-Verbindung mit Reconnect-Logik
     */
    const WebSocketManager = {
        // Konfiguration
        _config: {
            url: '/containers',
            reconnectionAttempts: 10,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            timeout: 20000,
            transports: ['websocket', 'polling']
        },
        
        // Status und Metadaten
        _status: {
            isConnecting: false,
            isConnected: false,
            reconnectTimer: null,
            connectionTimeout: null,
            reconnectAttempts: 0
        },
        
        // Socket-Instanz
        _socket: null,
        
        // Fallback-Polling aktivieren
        _enablePolling: function() {
            WebDockLogger.warn('WebSocket nicht verfügbar, aktiviere Polling-Fallback');
            
            // Existierendes Polling-Intervall löschen
            if (window._pollingInterval) {
                clearInterval(window._pollingInterval);
            }
            
            // Neues Polling-Intervall starten
            window._pollingInterval = setInterval(() => {
                if (CONFIG.DEBUG) {
                    WebDockLogger.debug('Polling-Abruf für Container-Status');
                }
                
                fetch('/api/containers/status')
            .then(response => response.json())
                    .then(statusData => {
                        if (typeof updateContainerStatusUI === 'function') {
                            updateContainerStatusUI(statusData);
                        }
                    })
                    .catch(error => {
                        WebDockLogger.error('Fehler beim Polling-Abruf:', error);
                    });
            }, 30000); // Alle 30 Sekunden
            
            WebDockLogger.info('Container Status-Updates alle 30 Sekunden aktiviert');
        },
        
        // Verbindung herstellen
        connect: function() {
            // Verhindere mehrfache Verbindungsversuche
            if (this._status.isConnecting) {
                WebDockLogger.warn('Verbindungsaufbau bereits im Gange, warte...');
                        return false;
                    }
                    
            this._status.isConnecting = true;
            WebDockLogger.info('Initialisiere WebSocket-Verbindung für Echtzeit-Container-Updates...');
            
            // Timeout für den Verbindungsaufbau
            this._status.connectionTimeout = setTimeout(() => {
                if (this._status.isConnecting && !this._status.isConnected) {
                    WebDockLogger.warn('WebSocket-Timeout erreicht, aktiviere Polling-Fallback');
                    this._status.isConnecting = false;
                    this._enablePolling();
                }
            }, this._config.timeout);
            
            // Bestehende Verbindung aufräumen
            this.cleanup();
            
            // Neue Socket-Verbindung erstellen
            this._socket = io(this._config.url, {
                reconnection: true,
                reconnectionAttempts: this._config.reconnectionAttempts,
                reconnectionDelay: this._config.reconnectionDelay,
                reconnectionDelayMax: this._config.reconnectionDelayMax,
                timeout: this._config.timeout,
                transports: this._config.transports
            });
            
            // Event-Handler einrichten
            this._setupEventHandlers();
            
            return true;
        },
        
        // Event-Handler für Socket-Events einrichten
        _setupEventHandlers: function() {
            if (!this._socket) return;
            
            // Verbindung hergestellt
            this._socket.on('connect', () => {
                clearTimeout(this._status.connectionTimeout);
                this._status.isConnecting = false;
                this._status.isConnected = true;
                this._status.reconnectAttempts = 0;
                
                WebDockLogger.info('✅ WebSocket-Verbindung hergestellt!');
                
                // Wenn Polling aktiv ist, deaktivieren
                if (window._pollingInterval) {
                    clearInterval(window._pollingInterval);
                    window._pollingInterval = null;
                }
            });
            
            // Verbindungsfehler
            this._socket.on('connect_error', (error) => {
                WebDockLogger.error('WebSocket-Verbindungsfehler:', error);
                
                // Nach maximaler Anzahl von Versuchen zum Polling wechseln
                this._status.reconnectAttempts++;
                if (this._status.reconnectAttempts >= this._config.reconnectionAttempts) {
                    WebDockLogger.warn(`Maximale Anzahl von Reconnect-Versuchen (${this._config.reconnectionAttempts}) erreicht`);
                    this._enablePolling();
                }
            });
            
            // Verbindung getrennt
            this._socket.on('disconnect', (reason) => {
                this._status.isConnected = false;
                WebDockLogger.warn(`WebSocket-Verbindung getrennt: ${reason}`);
                
                // Bei absichtlicher Trennung nicht neu verbinden
                if (reason === 'io client disconnect') {
                    WebDockLogger.info('WebSocket-Verbindung manuell getrennt');
                    return;
                }
                
                // Automatisch neu verbinden nach Verzögerung
                if (!this._status.reconnectTimer) {
                    this._status.reconnectTimer = setTimeout(() => {
                        WebDockLogger.info('Versuche, WebSocket-Verbindung wiederherzustellen...');
                        this.connect();
                    }, this._config.reconnectionDelay);
                }
            });
            
            // Initialer Container-Status
            this._socket.on('initial_status', (statusData) => {
                WebDockLogger.info('Initialen Container-Status erhalten');
                if (typeof updateContainerStatusUI === 'function') {
                    updateContainerStatusUI(statusData);
                }
            });
            
            // Container-Status-Update
            this._socket.on('container_status_update', (containerUpdate) => {
                if (CONFIG.DEBUG) {
                    WebDockLogger.debug(`Container-Status-Update für ${containerUpdate.name}: ${containerUpdate.status}`);
                }
                
                if (typeof updateContainerStatusUI === 'function') {
                    updateContainerStatusUI([containerUpdate], true);
                }
            });
            
            // Komplettes Status-Refresh
            this._socket.on('container_status_refresh', (statusData) => {
                WebDockLogger.info('Vollständiges Container-Status-Refresh erhalten');
                if (typeof updateContainerStatusUI === 'function') {
            updateContainerStatusUI(statusData);
                }
            });
        },
        
        // Verbindung trennen und aufräumen
        cleanup: function() {
            if (this._socket) {
                // Alle Event-Listener entfernen
                ['connect', 'connect_error', 'disconnect', 
                 'initial_status', 'container_status_update', 
                 'container_status_refresh'].forEach(event => {
                    this._socket.off(event);
                });
                
                // Verbindung trennen
                this._socket.disconnect();
                this._socket = null;
            }
            
            // Timer löschen
            if (this._status.reconnectTimer) {
                clearTimeout(this._status.reconnectTimer);
                this._status.reconnectTimer = null;
            }
            
            if (this._status.connectionTimeout) {
                clearTimeout(this._status.connectionTimeout);
                this._status.connectionTimeout = null;
            }
            
            // Status zurücksetzen
            this._status.isConnected = false;
            this._status.isConnecting = false;
        },
        
        // Verbindung trennen
        disconnect: function() {
            WebDockLogger.info('Trenne WebSocket-Verbindung...');
            this.cleanup();
        },
        
        // Status der Verbindung abrufen
        isConnected: function() {
            return this._status.isConnected;
        }
    };
    
    /**
     * Container-Management-System
     * Verwaltet Installation, Aktualisierung und Steuerung von Containern
     */
    const ContainerManager = {
        // Container installieren
        install: async function(containerName) {
            try {
                // Zeige das Installations-Modal an
                window.showInstallModal(containerName);
                return { success: true };
            } catch (error) {
                WebDockLogger.error(`Fehler bei der Installation von ${containerName}:`, error);
                NotificationManager.error(`Fehler bei der Installation: ${error.message}`);
                return { error: error.message };
            }
        },
        
        // Container aktualisieren
        update: async function(containerName) {
            try {
                NotificationManager.info(`Aktualisiere Container ${containerName}...`);
                
                const response = await fetch(`/api/container/${containerName}/update`, {
                    method: 'POST'
            });
            
            if (!response.ok) {
                    throw new Error(`HTTP-Fehler ${response.status}`);
                }
                
                const result = await response.json();
                
                NotificationManager.success(`Container ${containerName} erfolgreich aktualisiert`);
                
                // Aktualisiere die UI nach kurzer Verzögerung
                setTimeout(() => {
                    this.getStatus();
                }, 1000);
                
                return result;
        } catch (error) {
                WebDockLogger.error(`Fehler bei der Aktualisierung von ${containerName}:`, error);
                NotificationManager.error(`Fehler bei der Aktualisierung: ${error.message}`);
                return { error: error.message };
            }
        },
        
        // Container starten
        start: async function(containerName) {
            return this._changeContainerState(containerName, 'start');
        },
        
        // Container stoppen
        stop: async function(containerName) {
            return this._changeContainerState(containerName, 'stop');
        },
        
        // Container neustarten
        restart: async function(containerName) {
            return this._changeContainerState(containerName, 'restart');
        },
        
        // Zustandsänderung eines Containers
        _changeContainerState: async function(containerName, action) {
            try {
                NotificationManager.info(`${action === 'start' ? 'Starte' : (action === 'stop' ? 'Stoppe' : 'Starte neu')}: ${containerName}...`);
                
                const response = await fetch(`/api/container/${containerName}/${action}`, {
                    method: 'POST'
                });
                
                if (!response.ok) {
                    throw new Error(`HTTP-Fehler ${response.status}`);
                }
                
                const result = await response.json();
                
                NotificationManager.success(`Container ${containerName} erfolgreich ${action === 'start' ? 'gestartet' : (action === 'stop' ? 'gestoppt' : 'neugestartet')}`);
                
                // Aktualisiere die UI nach kurzer Verzögerung
                setTimeout(() => {
                    this.getStatus();
                }, 1000);
                
                return result;
            } catch (error) {
                WebDockLogger.error(`Fehler beim ${action} von ${containerName}:`, error);
                NotificationManager.error(`Fehler: ${error.message}`);
                return { error: error.message };
            }
        },
        
        // Status eines Containers wechseln (toggle)
        toggle: async function(containerName) {
            try {
                // Hole den aktuellen Status des Containers
                const statusResponse = await fetch(`/api/container/${containerName}/status`);
                
                if (!statusResponse.ok) {
                    throw new Error(`HTTP-Fehler ${statusResponse.status}`);
                }
                
                const statusData = await statusResponse.json();
                const isRunning = statusData.status === 'running';
                
                // Starte oder stoppe den Container je nach aktuellem Status
                return isRunning ? this.stop(containerName) : this.start(containerName);
            } catch (error) {
                WebDockLogger.error(`Fehler beim Toggle von ${containerName}:`, error);
                NotificationManager.error(`Fehler: ${error.message}`);
                return { error: error.message };
            }
        },
        
        // Status aller Container abrufen
        getStatus: async function() {
            try {
                // Prüfe, ob aktuelle Daten im Cache vorhanden sind
                const cachedStatus = CacheManager.get('containerStatus');
                if (cachedStatus) {
                    return cachedStatus;
                }
                
                const response = await fetch('/api/containers/status');
            
            if (!response.ok) {
                    throw new Error(`HTTP-Fehler ${response.status}`);
                }
                
                const statusData = await response.json();
                
                // Speichere die Daten im Cache
                CacheManager.set('containerStatus', statusData);
                
                return statusData;
        } catch (error) {
                WebDockLogger.error('Fehler beim Abrufen des Container-Status:', error);
                return [];
            }
        },
        
        // Info zu einem Container abrufen und anzeigen
        getInfo: async function(containerName) {
            try {
                const loadingModal = document.createElement('div');
                loadingModal.className = 'modal';
                loadingModal.id = 'loadingModal';
                loadingModal.innerHTML = `
                    <div class="modal-content" style="max-width: 400px;">
                        <div class="modal-header">
                            <h2><i class="fa fa-spinner fa-spin"></i> Lade Container-Info</h2>
                </div>
                        <div class="modal-body" style="text-align: center;">
                            <p>Container-Informationen werden abgerufen...</p>
                </div>
                </div>
            `;
                document.body.appendChild(loadingModal);
                setTimeout(() => loadingModal.classList.add('show'), 10);
                
                const response = await fetch(`/api/container/${containerName}/info`);
                
                if (!response.ok) {
                    throw new Error(`HTTP-Fehler ${response.status}`);
                }
                
                const containerInfo = await response.json();
                
                // Lade-Modal entfernen
                document.body.removeChild(loadingModal);
                
                // Zeige Container-Info-Modal
                this._showContainerInfoModal(containerName, containerInfo);
                
                return containerInfo;
            } catch (error) {
                WebDockLogger.error(`Fehler beim Abrufen der Info für ${containerName}:`, error);
                NotificationManager.error(`Fehler beim Abrufen der Container-Info: ${error.message}`);
                return { error: error.message };
            }
        },
        
        // Container-Info-Modal anzeigen
        _showContainerInfoModal: function(containerName, containerInfo) {
            // Erstelle Modal
            const modal = document.createElement('div');
            modal.className = 'modal';
            modal.id = 'infoModal';
            
            // Formatiere Ports
            let portsHtml = '';
            if (containerInfo.ports && containerInfo.ports.length > 0) {
                portsHtml = `
                    <div class="info-section">
                        <h3>Ports</h3>
                        <ul>
                            ${containerInfo.ports.map(port => `<li>${port}</li>`).join('')}
                        </ul>
                    </div>
                `;
            }
            
            // Formatiere Volumes
            let volumesHtml = '';
            if (containerInfo.volumes && containerInfo.volumes.length > 0) {
                volumesHtml = `
                    <div class="info-section">
                        <h3>Volumes</h3>
                        <ul>
                            ${containerInfo.volumes.map(volume => `<li>${volume}</li>`).join('')}
                        </ul>
                    </div>
                `;
            }
            
            // Formatiere Env Vars
            let envVarsHtml = '';
            if (containerInfo.environment && Object.keys(containerInfo.environment).length > 0) {
                envVarsHtml = `
                    <div class="info-section">
                        <h3>Umgebungsvariablen</h3>
                        <ul>
                            ${Object.entries(containerInfo.environment).map(([key, value]) => `<li><strong>${key}:</strong> ${value}</li>`).join('')}
                        </ul>
                    </div>
                `;
            }
            
            // Formatiere Netzwerke
            let networksHtml = '';
            if (containerInfo.networks && containerInfo.networks.length > 0) {
                networksHtml = `
                    <div class="info-section">
                        <h3>Netzwerke</h3>
                        <ul>
                            ${containerInfo.networks.map(network => `<li>${network}</li>`).join('')}
                        </ul>
                    </div>
                `;
            }
            
            // Formatiere Status
            const statusHtml = `
                <div class="info-section">
                    <h3>Status</h3>
                    <div class="status-block ${containerInfo.status}">
                        <i class="fa fa-${containerInfo.status === 'running' ? 'play-circle' : 'stop-circle'}"></i> 
                        ${containerInfo.status === 'running' ? 'Läuft seit ' + (containerInfo.uptime || 'unbekannt') : 'Gestoppt'}
                    </div>
                </div>
            `;
            
            // Formatiere Image
            const imageHtml = containerInfo.image ? `
                <div class="info-section">
                    <h3>Image</h3>
                    <p>${containerInfo.image}</p>
                </div>
            ` : '';
            
            // Formatiere ID 
            const idHtml = containerInfo.id ? `
                <div class="info-section">
                    <h3>Container ID</h3>
                    <p>${containerInfo.id}</p>
                </div>
            ` : '';
            
            // Modal-Inhalt erstellen
        modal.innerHTML = `
                <div class="modal-content" style="max-width: 700px;">
                <div class="modal-header">
                        <h2><i class="fa fa-info-circle"></i> ${containerName} Info</h2>
                    <button class="close-modal">&times;</button>
                </div>
                <div class="modal-body">
                        <div class="container-info">
                            ${statusHtml}
                            ${imageHtml}
                            ${idHtml}
                            ${portsHtml}
                            ${volumesHtml}
                            ${envVarsHtml}
                            ${networksHtml}
                        </div>
                </div>
                <div class="modal-footer">
                        <button class="action-btn" onclick="window.WebDock.${containerInfo.status === 'running' ? 'stopContainer' : 'startContainer'}('${containerName}'); closeModal();">
                            <i class="fa fa-${containerInfo.status === 'running' ? 'stop' : 'play'}"></i> 
                            ${containerInfo.status === 'running' ? 'Stoppen' : 'Starten'}
                        </button>
                        <button class="action-btn" onclick="window.WebDock.restartContainer('${containerName}'); closeModal();">
                            <i class="fa fa-sync"></i> Neustart
                        </button>
                        <button class="cancel-btn" onclick="closeModal()">Schließen</button>
                </div>
            </div>
        `;

            document.body.appendChild(modal);
            setTimeout(() => modal.classList.add('show'), 10);
            
            // Event-Listener für Schließen-Buttons
            modal.querySelector('.close-modal').addEventListener('click', () => closeModal());
            modal.querySelector('.cancel-btn').addEventListener('click', () => closeModal());
        }
    };
    
    /**
     * Drag & Drop-System
     * Verwaltet Drag & Drop für Container und Kategorien
     */
    const DragDropManager = {
        // Aktuelle Drag-Daten
        _dragData: null,
        
        // Elemente, die als Drag-Over markiert sind
        _dragOverElements: new Set(),
        
        // Drag & Drop für Container initialisieren
        initialize: function() {
            WebDockLogger.info('Initialisiere Drag & Drop-System...');
            
            // Event-Delegation für Drag & Drop
            document.addEventListener('dragstart', this._handleDragStart.bind(this));
            document.addEventListener('dragend', this._handleDragEnd.bind(this));
            document.addEventListener('dragover', this._handleDragOver.bind(this));
            document.addEventListener('dragenter', this._handleDragEnter.bind(this));
            document.addEventListener('dragleave', this._handleDragLeave.bind(this));
            document.addEventListener('drop', this._handleDrop.bind(this));
            
            WebDockLogger.info('Drag & Drop-System initialisiert');
        },
        
        // Drag-Start-Event-Handler
        _handleDragStart: function(event) {
            const containerCard = event.target.closest('.container-card');
            if (!containerCard) return;
            
            // Container-Informationen extrahieren
            const containerName = containerCard.dataset.name || containerCard.dataset.container;
            if (!containerName) return;
            
            // Kategorie-Informationen
            const categorySection = containerCard.closest('.group-section');
            if (!categorySection) return;
            
            const categoryId = categorySection.dataset.categoryId;
            if (!categoryId) return;
            
            // Position des Containers in der Kategorie bestimmen
            let position = -1;
            if (containerCard.hasAttribute('data-position')) {
                position = parseInt(containerCard.dataset.position, 10);
        } else {
                // Fallback: Position aus dem DOM berechnen
                const containerCards = Array.from(categorySection.querySelectorAll('.container-card'));
                position = containerCards.indexOf(containerCard);
            }
            
            // Drag-Daten speichern
            this._dragData = {
                type: 'container',
                name: containerName,
                sourceCategoryId: categoryId,
                position: position
            };
            
            // Daten für den Drag & Drop-Vorgang setzen
            event.dataTransfer.setData('application/json', JSON.stringify(this._dragData));
            
            // Visuelles Feedback
            containerCard.classList.add('dragging');
            
            WebDockLogger.debug(`Drag-Start: Container "${containerName}" aus Kategorie "${categoryId}" an Position ${position}`);
        },
        
        // Drag-End-Event-Handler
        _handleDragEnd: function(event) {
            // Alle drag-over Markierungen entfernen
            document.querySelectorAll('.dragging, .drag-over').forEach(el => {
                el.classList.remove('dragging', 'drag-over');
            });
            
            this._dragOverElements.clear();
            
            // Drag-Daten zurücksetzen
            this._dragData = null;
        },
        
        // Drag-Over-Event-Handler (für Drop-Zielbereiche)
        _handleDragOver: function(event) {
            // Nur für Container oder Kategorien
            const target = event.target.closest('.container-card, .group-section');
            if (!target) return;
            
            // Standard-Event-Verhalten verhindern, um Drop zu ermöglichen
            event.preventDefault();
        },
        
        // Drag-Enter-Event-Handler
        _handleDragEnter: function(event) {
            // Nur für Container oder Kategorien
            const target = event.target.closest('.container-card, .group-section');
            if (!target) return;
            
            // Elemente als Drag-Over markieren
            target.classList.add('drag-over');
            this._dragOverElements.add(target);
            
            // Standard-Event-Verhalten verhindern
            event.preventDefault();
        },
        
        // Drag-Leave-Event-Handler
        _handleDragLeave: function(event) {
            // Nur für Container oder Kategorien
            const target = event.target.closest('.container-card, .group-section');
            if (!target) return;
            
            // Markierung nur entfernen, wenn wir das Element wirklich verlassen
            // (und nicht nur ein Kind-Element betreten)
            if (!target.contains(event.relatedTarget)) {
                target.classList.remove('drag-over');
                this._dragOverElements.delete(target);
            }
        },
        
        // Drop-Event-Handler
        _handleDrop: async function(event) {
            // Standard-Event-Verhalten verhindern
            event.preventDefault();
            
            // Drag-Daten abrufen
            let dragData;
            try {
                const jsonData = event.dataTransfer.getData('application/json');
                if (!jsonData) return;
                
                dragData = JSON.parse(jsonData);
                if (!dragData || !dragData.type) return;
            } catch (error) {
                WebDockLogger.error('Fehler beim Parsen der Drag-Daten:', error);
                return;
            }
            
            // Nur Container-Drag & Drop unterstützen
            if (dragData.type !== 'container') return;
            
            // Drop-Ziel bestimmen
            const targetElement = event.target.closest('.container-card, .group-section');
            if (!targetElement) return;
            
            // Container-Name aus Drag-Daten extrahieren
            const containerName = dragData.name;
            if (!containerName) return;
            
            // Quell-Kategorie bestimmen
            const sourceCategoryId = dragData.sourceCategoryId;
            if (!sourceCategoryId) return;
            
            // Ziel-Kategorie bestimmen
            let targetCategoryId;
            let targetPosition = -1;
            
            if (targetElement.classList.contains('container-card')) {
                // Drop auf einen anderen Container
                const groupSection = targetElement.closest('.group-section');
                if (!groupSection) return;
                
                targetCategoryId = groupSection.dataset.categoryId;
                
                // Zielposition bestimmen
                if (targetElement.hasAttribute('data-position')) {
                    targetPosition = parseInt(targetElement.dataset.position, 10);
                        } else {
                    // Fallback: Position aus dem DOM berechnen
                    const containerCards = Array.from(groupSection.querySelectorAll('.container-card'));
                    targetPosition = containerCards.indexOf(targetElement);
                        }
                    } else {
                // Drop auf eine Kategorie
                targetCategoryId = targetElement.dataset.categoryId;
                // Am Ende der Kategorie einfügen
                const containerGrid = targetElement.querySelector('.container-grid');
                if (containerGrid) {
                    targetPosition = containerGrid.children.length;
                }
            }
            
            // Drop-Operation durchführen
            if (sourceCategoryId === targetCategoryId) {
                // Neu anordnen innerhalb derselben Kategorie
                await this.reorderContainer(containerName, sourceCategoryId, dragData.position, targetPosition);
                    } else {
                // Zwischen Kategorien verschieben
                await this.moveContainer(containerName, sourceCategoryId, targetCategoryId, targetPosition);
            }
            
            // Drop abschließen
            this._handleDragEnd(event);
        },
        
        // Container innerhalb einer Kategorie neu anordnen
        reorderContainer: async function(containerName, categoryId, fromPosition, toPosition) {
            try {
                WebDockLogger.info(`Ordne Container "${containerName}" in Kategorie "${categoryId}" von Position ${fromPosition} zu ${toPosition} neu an`);
                
                // UI-Feedback anzeigen
                NotificationManager.info(`Ordne Container ${containerName} neu an...`);
                
                // Verwende die moveContainer-Funktion mit gleicher Quell- und Zielkategorie
                // Dies funktioniert besser als die separate reorderContainer-Funktion
            const response = await fetch('/api/container/move', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache'
                },
                body: JSON.stringify({
                    containerName: containerName,
                        sourceCategory: categoryId,
                        targetCategory: categoryId,
                        targetPosition: toPosition
                })
            });

            if (!response.ok) {
                    throw new Error(`HTTP-Fehler ${response.status}`);
                }
                
                // Speichere Informationen für das Scrollen nach dem Reload
                sessionStorage.setItem('lastMovedContainer', containerName);
                sessionStorage.setItem('lastMovedCategory', categoryId);
                
                // Zeige Erfolgsmeldung an
                NotificationManager.success(`Container ${containerName} wurde erfolgreich neu angeordnet`);
                
                // Lade die Seite neu, um die Änderungen zu übernehmen
                setTimeout(() => {
                    window.location.reload();
                }, 500);
                
                return await response.json();
            } catch (error) {
                WebDockLogger.error(`Fehler beim Neuordnen des Containers ${containerName}:`, error);
                NotificationManager.error(`Fehler beim Neuordnen: ${error.message}`);
                return { error: error.message };
            }
        },
        
        // Container zwischen Kategorien verschieben
        moveContainer: async function(containerName, sourceCategoryId, targetCategoryId, targetPosition) {
            try {
                WebDockLogger.info(`Verschiebe Container "${containerName}" von Kategorie "${sourceCategoryId}" zu "${targetCategoryId}" an Position ${targetPosition}`);
                
                // UI-Feedback anzeigen
                NotificationManager.info(`Verschiebe Container ${containerName} in andere Kategorie...`);
                
                const response = await fetch('/api/container/move', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Cache-Control': 'no-cache, no-store, must-revalidate',
                        'Pragma': 'no-cache'
                    },
                    body: JSON.stringify({
                        containerName: containerName,
                        sourceCategory: sourceCategoryId,
                        targetCategory: targetCategoryId,
                        targetPosition: targetPosition
                    })
                });
                
                if (!response.ok) {
                    throw new Error(`HTTP-Fehler ${response.status}`);
                }
                
                // Speichere Informationen für das Scrollen nach dem Reload
                sessionStorage.setItem('lastMovedContainer', containerName);
                sessionStorage.setItem('lastMovedCategory', targetCategoryId);
                
                // Zeige Erfolgsmeldung an
                NotificationManager.success(`Container ${containerName} wurde erfolgreich verschoben`);
                
                // Lade die Seite neu, um die Änderungen zu übernehmen
                    setTimeout(() => {
                        window.location.reload();
                }, 500);
                
                return await response.json();
            } catch (error) {
                WebDockLogger.error(`Fehler beim Verschieben des Containers ${containerName}:`, error);
                NotificationManager.error(`Fehler beim Verschieben: ${error.message}`);
                return { error: error.message };
            }
        }
    };
    
    /**
     * Container-Renderer-System
     * Zeichnet Container basierend auf YAML-Konfiguration
     */
    const ContainerRenderer = {
        // Container rendern
        render: async function() {
            WebDockLogger.info('Rendere Container...');
            
            // Loading-Overlay anzeigen
        const loadingOverlay = document.getElementById('loading-overlay');
        if (loadingOverlay) loadingOverlay.style.display = 'flex';
            
            try {
                // YAML-Kategorien laden
                await this._loadCategories();
                WebDockLogger.info('YAML-Kategorien geladen');
                
                // Container rendern
                await this._renderContainers();
                WebDockLogger.info('Container gerendert');
                
                // Drag & Drop-System initialisieren
                WebDockLogger.info('Initialisiere Drag & Drop-System...');
                DragDropManager.initialize();
                WebDockLogger.info('Drag & Drop-System initialisiert');
                
                return true;
            } catch (error) {
                WebDockLogger.error('Fehler beim Rendern der Container:', error);
                NotificationManager.error('Fehler beim Laden der Container');
                return false;
            } finally {
                // Loading-Overlay verstecken
                if (loadingOverlay) loadingOverlay.style.display = 'none';
            }
        },
        
        // YAML-Kategorien laden
        _loadCategories: async function() {
            // Prüfe, ob wir Kategorien im Cache haben
            const cachedCategories = CacheManager.get('categories');
            if (cachedCategories) {
                WebDockLogger.debug('Verwende gecachte Kategorien');
                window.yamlCategories = cachedCategories;
                // Extrahiere Container-Beschreibungen aus dem Cache
                this._extractContainerDescriptions(cachedCategories);
                return cachedCategories;
            }
            
            // Lade Kategorien vom Server
            try {
                const response = await fetch('/api/categories/full', {
                    headers: {
                        'Cache-Control': 'no-cache, no-store, must-revalidate',
                        'Pragma': 'no-cache'
                    }
                });
                
                if (!response.ok) {
                    throw new Error(`Fehler beim Laden der Kategorien: ${response.status}`);
                }
                
                const categoriesData = await response.json();
                WebDockLogger.debug('Kategorien vom Server geladen');
                
                // Speichere Kategorien im Cache
                CacheManager.set('categories', categoriesData);
                window.yamlCategories = categoriesData;
                
                // Extrahiere Container-Beschreibungen
                this._extractContainerDescriptions(categoriesData);
                
                return categoriesData;
            } catch (error) {
                WebDockLogger.error('Fehler beim Laden der Kategorien:', error);
                throw error;
            }
        },
        
        // Container-Beschreibungen aus Kategorien extrahieren
        _extractContainerDescriptions: function(categoriesData) {
            // Globale Variable für Container-Beschreibungen initialisieren
            window.yamlContainerDescriptions = {};
            
            if (categoriesData && categoriesData.categories) {
                // Unterstütze sowohl das Listen- als auch das Objekt-Format
                const categories = Array.isArray(categoriesData.categories) ? 
                    categoriesData.categories : Object.values(categoriesData.categories);
                
                // Durchlaufe alle Kategorien und sammle die Beschreibungen
                categories.forEach(category => {
                    if (category.containers && Array.isArray(category.containers)) {
                        category.containers.forEach(container => {
                            // Container kann ein String oder ein Objekt mit name/description sein
                            if (typeof container === 'string') {
                                // Keine Beschreibung verfügbar für String-Container
                            } else if (typeof container === 'object' && container.name) {
                                // Speichere die Beschreibung in der globalen Variable
                                if (container.description) {
                                    window.yamlContainerDescriptions[container.name] = container.description;
                                }
                            }
                        });
                    }
                });
                
                // Cache für Container-Beschreibungen setzen
                CacheManager.set('descriptions', window.yamlContainerDescriptions);
            }
        },
        
        // Container rendern
        _renderContainers: async function() {
            try {
                // Container-Status vom Server laden
                const response = await fetch('/api/containers', {
                    headers: {
                        'Cache-Control': 'no-cache, no-store, must-revalidate',
                        'Pragma': 'no-cache'
                    }
                });
                
                if (!response.ok) {
                    throw new Error(`Fehler beim Laden der Container: ${response.status}`);
                }
                
                const containersData = await response.json();
                
                // Container-Gruppen-Container finden
                const containerGroups = document.querySelector('.container-groups');
                if (!containerGroups) {
                    throw new Error('Container-Gruppen-Element nicht gefunden');
                }
                
                // Existierende Container-Gruppen leeren
                containerGroups.innerHTML = '';
                
                // Wenn YAML-Kategorien vorhanden sind, verwende sie zur Gruppierung der Container
                const yamlCategories = window.yamlCategories?.categories;
                if (yamlCategories) {
                    // Container nach Kategorien gruppieren
                    const groupedContainers = {};
                    const assignedContainers = new Set();
                    
                    // Kategorien aus YAML in exakter Reihenfolge initialisieren
                    const sortedCategories = Array.isArray(yamlCategories) ? 
                        yamlCategories : Object.values(yamlCategories);
                    
                    // Initialisiere alle Kategorien aus YAML
                    sortedCategories.forEach(category => {
                        groupedContainers[category.name] = {
                            name: category.name,
                            icon: category.icon || 'fa-cube',
                            containers: []
                        };
                    });
                    
                    // Füge "Imported" Kategorie hinzu
                    if (!groupedContainers['Imported']) {
                        groupedContainers['Imported'] = {
                            name: 'Imported',
                            icon: 'fa-cloud-download-alt',
                            containers: []
                        };
                    }
                    
                    // Containers aus API-Antwort gruppieren
                    Object.values(containersData).forEach(group => {
                        group.containers.forEach(container => {
                            let assigned = false;
                            
                            // Suche die passende Kategorie in YAML-Daten
                            sortedCategories.forEach(category => {
                                if (category && Array.isArray(category.containers)) {
                                    // Prüfe, ob der Container in der Kategorie ist
                                    const containerInCategory = category.containers.some(c => {
                                        if (typeof c === 'string') {
                                            return c === container.name;
                                        } else if (c && typeof c === 'object') {
                                            return c.name === container.name;
                                        }
                                        return false;
                                    });
                                    
                                    if (containerInCategory && !assignedContainers.has(container.name)) {
                                        // Füge Container zur Kategorie hinzu
                                        groupedContainers[category.name].containers.push(container);
                                        assignedContainers.add(container.name);
                                        assigned = true;
                                    }
                                }
                            });
                            
                            // Wenn keine Kategorie gefunden wurde, zu "Imported" hinzufügen
                            if (!assigned && !assignedContainers.has(container.name)) {
                                groupedContainers['Imported'].containers.push(container);
                                assignedContainers.add(container.name);
                }
            });
        });
                    
                    // Container in YAML-Reihenfolge rendern
                    sortedCategories.forEach(category => {
                        const groupData = groupedContainers[category.name];
                        
                        // Nur Kategorien mit Containern anzeigen
                        if (groupData && groupData.containers.length > 0) {
                            this._renderCategorySection(containerGroups, category.name, groupData);
                        }
                    });
                    
                    // Imported-Kategorie zum Schluss rendern, falls vorhanden
                    const importedGroup = groupedContainers['Imported'];
                    if (importedGroup && importedGroup.containers.length > 0) {
                        this._renderCategorySection(containerGroups, 'Imported', importedGroup);
                    }
                } 
                // Fallback, wenn keine YAML-Kategorien vorhanden sind
                else {
                    // Direkt die Gruppen aus den API-Daten rendern
                    Object.values(containersData).forEach(group => {
                        this._renderCategorySection(containerGroups, group.name, group);
                    });
                }
                
                // Event-Listener für Container-Karten hinzufügen
                this._addContainerEventListeners();
                
                return true;
            } catch (error) {
                WebDockLogger.error('Fehler beim Rendern der Container:', error);
                throw error;
            }
        },
        
        // Kategorie-Sektion rendern
        _renderCategorySection: function(parent, categoryId, groupData) {
            // Erstelle Kategorie-Sektion
            const groupSection = document.createElement('div');
            groupSection.className = 'group-section';
            groupSection.setAttribute('data-category-id', categoryId);
            
            // Erstelle Kategorie-Header
            const categoryHeader = document.createElement('h2');
            categoryHeader.innerHTML = `<i class="fa ${groupData.icon}"></i> ${groupData.name}`;
            groupSection.appendChild(categoryHeader);
            
            // Erstelle Container-Grid
            const containerGrid = document.createElement('div');
            containerGrid.className = 'container-grid';
            
            // Container in der exakten Reihenfolge aus YAML rendern
            if (window.yamlCategories && window.yamlCategories.categories) {
                // Finde die Kategorie in den YAML-Daten
                const yamlCategories = Array.isArray(window.yamlCategories.categories) ?
                    window.yamlCategories.categories : Object.values(window.yamlCategories.categories);
                
                const yamlCategory = yamlCategories.find(cat => 
                    cat.name === groupData.name || cat.id === categoryId
                );
                
                if (yamlCategory && yamlCategory.containers && Array.isArray(yamlCategory.containers)) {
                    // Container in der exakten YAML-Reihenfolge rendern
                    yamlCategory.containers.forEach((containerEntry, index) => {
                        // Bestimme den Container-Namen
                        const containerName = typeof containerEntry === 'string' ? 
                            containerEntry : (containerEntry.name || '');
                            
                        if (!containerName) return;
                        
                        // Finde den Container in den API-Daten
                        const containerInfo = groupData.containers.find(c => c.name === containerName);
                        
                        if (containerInfo) {
                            // Container-Karte erstellen und hinzufügen
                            const containerCard = this._createContainerCard(containerInfo, categoryId, index);
                            containerGrid.appendChild(containerCard);
                        }
                    });
                    
                    // Füge verbleibende Container hinzu, die nicht in YAML waren
                    groupData.containers.forEach((container, index) => {
                        const isInYaml = yamlCategory.containers.some(c => {
                            const yamlName = typeof c === 'string' ? c : (c.name || '');
                            return yamlName === container.name;
                        });
                        
                        if (!isInYaml) {
                            // Container-Karte erstellen und hinzufügen
                            const containerCard = this._createContainerCard(container, categoryId, 
                                yamlCategory.containers.length + index);
                            containerGrid.appendChild(containerCard);
                        }
                    });
            } else {
                    // Fallback: Alle Container der Gruppe rendern
                    groupData.containers.forEach((container, index) => {
                        const containerCard = this._createContainerCard(container, categoryId, index);
                        containerGrid.appendChild(containerCard);
                    });
                }
        } else {
                // Kein YAML vorhanden: Einfach alle Container rendern
                groupData.containers.forEach((container, index) => {
                    const containerCard = this._createContainerCard(container, categoryId, index);
                    containerGrid.appendChild(containerCard);
                });
            }
            
            // Container-Grid zur Sektion hinzufügen
            groupSection.appendChild(containerGrid);
            
            // Kategorie-Sektion zum übergeordneten Element hinzufügen
            parent.appendChild(groupSection);
        },
        
        // Container-Karte erstellen
        _createContainerCard: function(container, categoryId, position = -1) {
            // Container-Logo abrufen
            const logoUrl = this._getContainerLogo(container.name);
            
            // Container-Beschreibung abrufen
            let description = '';
            
            // Priorisiere YAML-Beschreibung
            if (window.yamlContainerDescriptions && window.yamlContainerDescriptions[container.name]) {
                description = window.yamlContainerDescriptions[container.name];
            }
            // Fallback auf container.description
            else if (container.description) {
                description = container.description;
            }
            // Letzter Fallback
            else {
                description = `Docker container for ${container.name}`;
            }
            
            // Bestimme Container-Status
    const isInstalled = container.installed || false;
    const state = container.status || 'stopped';
    
            // Bestimme das richtige Protokoll
            const protocol = container.name === 'scrypted' ? 'https' : 'http';
            
            // Drag & Drop-Attribute
    const dragAttributes = `
        draggable="true"
        ondragstart="handleContainerDragStart(event, '${container.name}', '${categoryId}')"
        ondragend="handleContainerDragEnd(event)"
        ondragover="handleContainerDragOver(event)"
        ondragenter="handleContainerDragEnter(event)"
        ondragleave="handleContainerDragLeave(event)"
        ondrop="handleContainerDrop(event)"
                data-container="${container.name}"
                data-name="${container.name}"
                data-position="${position}"
                data-category="${categoryId}"
    `;
    
            // Spezielle Port-Anzeige für WatchYourLAN
    let portDisplay = '';
    if (container.name === 'watchyourlan' || container.name === 'watchyourlanarm') {
                // Für WatchYourLAN zeigen wir den GUI-Port an
                const guiPort = container.port || '8840';
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
    
            // Container-Karte erstellen
            const containerCard = document.createElement('div');
            containerCard.className = 'container-card';
            containerCard.setAttribute('draggable', 'true');
            
            // Drag & Drop-Attribute setzen
            const attrs = dragAttributes.trim().split('\n');
            attrs.forEach(attr => {
                const parts = attr.trim().split('=');
                if (parts.length === 2) {
                    const attrName = parts[0].trim();
                    // Entferne Anführungszeichen vom Attributwert
                    const attrValue = parts[1].trim().replace(/^["'](.*)["']$/, '$1');
                    containerCard.setAttribute(attrName, attrValue);
                }
            });
            
            // Container-Karte-HTML setzen
            containerCard.innerHTML = `
            <div class="status-indicator ${container.status}" title="Status: ${container.status}"></div>
            <div class="container-logo">
                <img src="${logoUrl}" 
                     alt="${container.name} logo" 
                     title="${description}" 
                     onerror="this.src='/static/img/icons/bangertech.png'">
            </div>
            <div class="name-with-settings">
                    <h3 ${isInstalled && container.port ? `onclick="window.open('${protocol}://${window.location.hostname}:${container.port}', '_blank')" style="cursor: pointer;"` : ''}>${container.name}</h3>
                ${isInstalled ? `
                        <button class="info-btn" onclick="window.WebDock.getContainerInfo('${container.name}')" title="Container Information">
                        <i class="fa fa-info-circle"></i>
                    </button>
                ` : ''}
            </div>
            ${portDisplay}
            <div class="actions">
                ${isInstalled ? `
                    <div class="button-group">
                            <button class="status-btn ${state}" onclick="window.WebDock.toggleContainer('${container.name}')">
                            ${state === 'running' ? 'Stop' : 'Start'}
                        </button>
                            <button class="update-btn" onclick="window.WebDock.updateContainer('${container.name}')" title="Update container">
                            <i class="fa fa-refresh"></i>
                        </button>
                    </div>
                ` : `
                        <button class="install-btn" onclick="window.showInstallModal('${container.name}')">Install</button>
                `}
        </div>
    `;
            
            return containerCard;
        },
        
        // Logo für Container abrufen
        _getContainerLogo: function(containerName) {
            // Mapping von Container-Namen zu Logo-Dateien
            const logoMapping = {
                'homeassistant': 'homeassistant.png',
                'whatsupdocker': 'wud.png',
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
                'node-red': 'node-red.png',
                'dozzle': 'dozzle.png',
                'watchyourlan': 'watchyourlan.png',
                'watchyourlanarm': 'watchyourlan.png',
                'influxdb': 'influxdb.png',
                'influxdb-arm': 'influxdb.png',
                'influxdb-x86': 'influxdb.png',
                'uptime-kuma': 'uptime-kuma.png',
                'spoolman': 'spoolman.png',
                'scrypted': 'scrypted.png',
                'jellyfin': 'jellyfin.png',
                'backuppro': 'backuppro.png',
                'bambucam': 'bambucam.png'
            };
            
            // Wenn ein Mapping existiert, verwende es, ansonsten verwende den Container-Namen
            const logoFile = logoMapping[containerName] || `${containerName}.png`;
            return `/static/img/icons/${logoFile}`;
        },
        
        // Event-Listener für Container-Karten hinzufügen
        _addContainerEventListeners: function() {
            // Event-Listener für Install-Buttons
            document.querySelectorAll('.install-btn').forEach(btn => {
                btn.onclick = function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    const containerName = this.closest('.container-card').getAttribute('data-name');
                    window.showInstallModal(containerName);
                };
            });
            
            // Event-Listener für Status-Buttons
            document.querySelectorAll('.status-btn').forEach(btn => {
                btn.onclick = function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    const containerName = this.closest('.container-card').getAttribute('data-name');
                    window.WebDock.toggleContainer(containerName);
                };
            });
            
            // Event-Listener für Update-Buttons
            document.querySelectorAll('.update-btn').forEach(btn => {
                btn.onclick = function(e) {
                e.preventDefault();
                    e.stopPropagation();
                    const containerName = this.closest('.container-card').getAttribute('data-name');
                    window.WebDock.updateContainer(containerName);
                };
            });
            
            // Event-Listener für Info-Buttons
            document.querySelectorAll('.info-btn').forEach(btn => {
                btn.onclick = function(e) {
                e.preventDefault();
                    e.stopPropagation();
                    const containerName = this.closest('.container-card').getAttribute('data-name');
                    window.WebDock.getContainerInfo(containerName);
                };
            });
        }
    };
    
    // Initialisierung der Anwendung
    const App = {
        // Initialisierung
        initialize: async function() {
            WebDockLogger.info('Initialisiere WebDock UI...');
            
            try {
                // Warte auf DOMContentLoaded, falls noch nicht fertig
                if (document.readyState !== 'complete' && document.readyState !== 'interactive') {
                    await new Promise(resolve => {
                        document.addEventListener('DOMContentLoaded', resolve, { once: true });
                    });
                }
                
                // WebSocket-Verbindung initialisieren
                WebSocketManager.connect();
                
                // Container rendern
                await ContainerRenderer.render();
                
                // Scroll zu Container, falls nach Verschiebung
                this._scrollToLastMovedContainer();
                
                // Event-Listener für manuelle Aktualisierung
                document.addEventListener('keydown', (e) => {
                    if (e.key === 'F5' || (e.ctrlKey && e.key === 'r')) {
                    e.preventDefault();
                        this.refreshContainers();
                    }
                });
                
                // Periodische Updates
                this._startPeriodicUpdates();
                
                WebDockLogger.info('WebDock UI erfolgreich initialisiert');
                return true;
    } catch (error) {
                WebDockLogger.error('Fehler bei der Initialisierung:', error);
                NotificationManager.error('Fehler beim Initialisieren der Anwendung');
                return false;
            }
        },
        
        // Scroll zu Container nach Verschiebung
        _scrollToLastMovedContainer: function() {
            const containerName = sessionStorage.getItem('lastMovedContainer');
            const categoryId = sessionStorage.getItem('lastMovedCategory');
            
            if (containerName && categoryId) {
                WebDockLogger.info(`Scrolle zu zuletzt verschobenem Container: ${containerName} in Kategorie ${categoryId}`);
                
                // Warte kurz, bis die Seite vollständig geladen ist
                setTimeout(() => {
                    const categorySection = DOMCache.get(`.group-section[data-category-id="${categoryId}"]`);
                    if (!categorySection) return;
                    
                    const containerCard = categorySection.querySelector(`.container-card[data-name="${containerName}"]`);
                    if (!containerCard) return;
                    
                    // Scrolle zum Container und hebe ihn hervor
                    containerCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    containerCard.classList.add('highlight');
                    
                    // Entferne Hervorhebung nach kurzer Zeit
                    setTimeout(() => {
                        containerCard.classList.remove('highlight');
                    }, 3000);
                    
                    // Lösche die Informationen aus dem SessionStorage
                    sessionStorage.removeItem('lastMovedContainer');
                    sessionStorage.removeItem('lastMovedCategory');
                }, 1000);
            }
        },
        
        // Periodische Updates starten
        _startPeriodicUpdates: function() {
            // Nur alle 5 Minuten aktualisieren, wenn keine Modals offen sind
            setInterval(() => {
                if (!document.querySelector('.modal.show') && !document.activeElement.tagName.match(/input|select|textarea/i)) {
                    WebDockLogger.debug('Periodisches Update der Container ausgeführt');
                    ContainerManager.getStatus().then(statusData => {
                        this._updateContainerStatus(statusData);
                    });
                }
            }, CONFIG.REFRESH_INTERVAL);
        },
        
        // Container aktualisieren
        refreshContainers: async function() {
            WebDockLogger.info('Manuelles Refresh der Container ausgeführt');
            
            const loadingOverlay = DOMCache.get('#loading-overlay');
            if (loadingOverlay) loadingOverlay.style.display = 'flex';
            
            try {
                // Cache leeren
                CacheManager.clear();
                
                // Container neu rendern
                await ContainerRenderer.render();
                
                NotificationManager.success('Container erfolgreich aktualisiert');
            } catch (error) {
                WebDockLogger.error('Fehler beim Aktualisieren der Container:', error);
                NotificationManager.error('Fehler beim Aktualisieren der Container');
            } finally {
                if (loadingOverlay) loadingOverlay.style.display = 'none';
            }
        },
        
        // Status der Container aktualisieren
        _updateContainerStatus: function(statusData) {
            if (!statusData || !Array.isArray(statusData)) return;
            
            // Für jeden Container den Status aktualisieren
    statusData.forEach(container => {
                if (!container.name || !container.status) return;
                
                // Alle Karten für diesen Container finden
        const containerCards = document.querySelectorAll(`.container-card[data-name="${container.name}"]`);
        
        containerCards.forEach(card => {
                    // Status-Indikator aktualisieren
            const statusIndicator = card.querySelector('.status-indicator');
            if (statusIndicator) {
                        const oldStatus = statusIndicator.classList.contains('running') ? 'running' : 
                                         statusIndicator.classList.contains('stopped') ? 'stopped' : 'error';
                        
                        // Nur aktualisieren, wenn sich der Status geändert hat
                        if (oldStatus !== container.status) {
                            // Alle Status-Klassen entfernen
                statusIndicator.classList.remove('running', 'stopped', 'error');
                            
                            // Neuen Status hinzufügen
                statusIndicator.classList.add(container.status);
                            
                            // Tooltip aktualisieren
                statusIndicator.setAttribute('title', `Status: ${container.status}`);
                
                            // Status-Button aktualisieren
                            const statusBtn = card.querySelector('.status-btn');
                            if (statusBtn) {
                                statusBtn.classList.remove('running', 'stopped', 'error');
                                statusBtn.classList.add(container.status);
                                statusBtn.textContent = container.status === 'running' ? 'Stop' : 'Start';
                            }
                            
                            // Kurze Animation für bessere Sichtbarkeit
                    statusIndicator.classList.add('status-update-flash');
                    setTimeout(() => {
                        statusIndicator.classList.remove('status-update-flash');
                    }, 1000);
                }
            }
        });
    });
}
    };
    
    // Anwendung initialisieren, wenn das Dokument geladen ist
    document.addEventListener('DOMContentLoaded', () => {
        App.initialize();
    });
    
    // Globale Funktionen exportieren
    window.WebDock = {
        // Container-Management
        installContainer: ContainerManager.install.bind(ContainerManager),
        updateContainer: ContainerManager.update.bind(ContainerManager),
        toggleContainer: ContainerManager.toggle.bind(ContainerManager),
        startContainer: ContainerManager.start.bind(ContainerManager),
        stopContainer: ContainerManager.stop.bind(ContainerManager),
        restartContainer: ContainerManager.restart.bind(ContainerManager),
        getContainerInfo: ContainerManager.getInfo.bind(ContainerManager),
        
        // UI-Funktionen
        showNotification: NotificationManager.show.bind(NotificationManager),
        refreshContainers: App.refreshContainers.bind(App),
        
        // WebSocket-Management
        connectWebSocket: WebSocketManager.connect.bind(WebSocketManager),
        disconnectWebSocket: WebSocketManager.disconnect.bind(WebSocketManager)
    };
    
    // Globale Funktionen für direkten Zugriff aus HTML
    window.installContainer = function(containerName) {
        window.WebDock.installContainer(containerName);
    };
    
    // Installation Modal anzeigen
    window.showInstallModal = async function(containerName) {
        try {
            // Erstelle zuerst ein Lade-Modal für sofortiges Feedback
            const loadingModal = document.createElement('div');
            loadingModal.className = 'modal';
            loadingModal.id = 'loadingModal';
            loadingModal.innerHTML = `
                <div class="modal-content" style="max-width: 450px; border-radius: 12px; box-shadow: 0 5px 25px rgba(0,0,0,0.15);">
                    <div class="modal-header" style="background: var(--color-primary); color: white; border-radius: 10px 10px 0 0;">
                        <h2><i class="fa fa-spinner fa-spin"></i> Loading Configuration</h2>
                    </div>
                    <div class="modal-body" style="text-align: center; padding: 20px;">
                        <p style="font-size: 16px; margin-bottom: 15px;">Fetching container configuration...</p>
                        <div class="progress-bar" style="margin-top: 15px; height: 4px; width: 100%; background: #f0f0f0; overflow: hidden; border-radius: 2px;">
                            <div class="progress-bar-fill" style="height: 100%; width: 10%; background: var(--color-primary); animation: progress-animation 1.5s infinite ease-in-out;"></div>
                        </div>
                        <style>
                            @keyframes progress-animation {
                                0% { width: 10%; margin-left: 0%; }
                                50% { width: 50%; margin-left: 25%; }
                                100% { width: 10%; margin-left: 90%; }
                            }
                        </style>
                    </div>
                </div>
            `;
            document.body.appendChild(loadingModal);
            setTimeout(() => loadingModal.classList.add('show'), 10);

            // Normalisiere den Container-Namen für die API-Anfrage
            const apiContainerName = containerName === 'mosquitto' ? 'mosquitto-broker' : containerName;
            
            // Bereite alle Anfragen parallel vor
            const requests = [
                fetch(`/api/container/${apiContainerName}/config?template=true`).then(res => {
                    if (!res.ok) throw new Error(`Failed to load config: ${res.status}`);
                    return res.json();
                })
            ];
            
            // Bei WatchYourLAN zusätzliche Netzwerkinformationen laden
            if (containerName === 'watchyourlan' || containerName === 'watchyourlanarm') {
                requests.push(
                    fetch('/api/network-info')
                    .then(res => res.ok ? res.json() : null)
                    .then(networkData => {
                        let networkInterface = 'eth0';
                        let ipRange = '192.168.1.0/24';
                        
                        if (networkData) {
                            if (networkData.interface) {
                                networkInterface = networkData.interface;
                            }
                            
                            if (networkData.ip_range) {
                                ipRange = networkData.ip_range;
                            } else if (networkData.client_ip && networkData.client_ip !== "127.0.0.1") {
                                // Verwende die Client-IP vom Server
                                const ipParts = networkData.client_ip.split('.');
                                if (ipParts.length === 4) {
                                    ipRange = `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}.0/24`;
                                }
                            }
                        }
                        return { networkInterface, ipRange };
                    })
                );
            }
            
            // Hole alle Daten parallel
            const results = await Promise.all(requests);
            const config = results[0];
            
            // Entferne das Lade-Modal
            document.body.removeChild(loadingModal);
            
            if (!config.yaml) {
                throw new Error('No YAML configuration received');
            }

            // Parse YAML für Environment-Variablen und Ports
            const yamlConfig = config.service || {};
            
            // Extrahiere Ports und Environment-Variablen
            const ports = yamlConfig.ports || [];
            const environment = yamlConfig.environment || {};
            
            // Erstelle Modal
            const modal = document.createElement('div');
            modal.className = 'modal';
            modal.id = 'installModal';
            
            // Bestimme, ob die Port-Konfiguration angezeigt werden soll
            // Für WatchYourLAN nicht anzeigen, da wir spezifische Port-Felder haben
            const showPortConfig = !(containerName === 'watchyourlan' || containerName === 'watchyourlanarm');
            
            // Bestimme ein passendes Icon für den Container
            const containerIcon = ContainerRenderer._getContainerLogo(containerName);
            
            // Modal-Inhalt erstellen - mit modernem Styling
            modal.innerHTML = `
                <div class="modal-content" style="max-width: 600px; border-radius: 12px; box-shadow: 0 5px 25px rgba(0,0,0,0.2);">
                    <div class="modal-header" style="background: var(--color-primary); color: white; border-radius: 10px 10px 0 0; padding: 15px 20px;">
                        <h2 style="display: flex; align-items: center; gap: 10px;">
                            <img src="${containerIcon}" style="height: 24px; width: 24px; object-fit: contain;" 
                                 onerror="this.src='/static/img/icons/bangertech.png'">
                            Install ${containerName}
                        </h2>
                        <button class="close-modal" style="background: transparent; border: none; color: white; font-size: 22px;">&times;</button>
                    </div>
                    <div class="modal-body" style="padding: 20px;">
                        ${showPortConfig && ports.length > 0 ? `
                            <div class="config-section" style="margin-bottom: 20px; padding: 20px; background: var(--color-background-dark); border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.05);">
                                <h3 style="margin-bottom: 15px; color: var(--color-primary); font-size: 18px;">
                                    <i class="fa fa-exchange"></i> Port Configuration
                                </h3>
                                <div class="port-mappings">
                                    ${createPortMappings(ports)}
                                </div>
                            </div>
                        ` : ''}
                        ${Object.keys(environment).length > 0 ? `
                            <div class="config-section" style="margin-bottom: 20px; padding: 20px; background: var(--color-background-dark); border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.05);">
                                <h3 style="margin-bottom: 15px; color: var(--color-primary); font-size: 18px;">
                                    <i class="fa fa-code"></i> Environment Variables
                                </h3>
                                <div class="env-vars">
                                    ${createEnvironmentVars(environment)}
                                </div>
                            </div>
                        ` : ''}
                        ${getSpecialContainerFields(containerName)}
                    </div>
                    <div class="modal-footer" style="padding: 15px 20px; display: flex; justify-content: flex-end; gap: 10px; border-top: 1px solid #eee;">
                        <button class="cancel-btn" style="padding: 8px 16px; background: #f5f5f5; border: none; border-radius: 4px; cursor: pointer;">Cancel</button>
                        <button class="install-btn" style="padding: 8px 16px; background: var(--color-primary); color: white; border: none; border-radius: 4px; cursor: pointer;">
                            <i class="fa fa-download"></i> Install
                        </button>
                    </div>
                </div>
            `;
            
            document.body.appendChild(modal);
            setTimeout(() => modal.classList.add('show'), 10);
            
            // Event-Listener für Buttons
            const installButton = modal.querySelector('.install-btn');
            const cancelButton = modal.querySelector('.cancel-btn');
            const closeButton = modal.querySelector('.close-modal');

            // Install-Button Event-Listener
            installButton.addEventListener('click', () => executeInstall(containerName));

            // Schließen-Funktionalität
            cancelButton.addEventListener('click', () => closeModal());
            closeButton.addEventListener('click', () => closeModal());
            
            // Event-Listener für spezielle Container-Felder
            setupSpecialContainerFields(containerName, modal);
        } catch (error) {
            console.error('Error:', error);
            NotificationManager.show('error', `Error preparing installation for ${containerName}: ${error.message}`);
        }
    };
    
    // Hilfsfunktion für Port-Mappings
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
            containerPort = String(containerPort).split('/')[0];
            
            return `
                <div class="port-mapping" style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 5px; font-weight: bold;">External Port (${containerPort} internal):</label>
                    <input type="number" 
                        data-internal-port="${containerPort}"
                        value="${hostPort.split('/')[0]}"
                        min="1"
                        max="65535"
                        class="form-control" 
                        style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #ddd;">
                </div>
            `;
        }).join('');
    }

    // Hilfsfunktion für Umgebungsvariablen
    function createEnvironmentVars(environment) {
        if (!environment || Object.keys(environment).length === 0) {
            return 'No environment variables to configure';
        }
        
        return Object.entries(environment).map(([key, defaultValue]) => `
            <div class="env-var" style="margin-bottom: 15px;">
                <label style="display: block; margin-bottom: 5px; font-weight: bold;">${key}:</label>
                <input type="text" 
                    data-env-key="${key}"
                    value="${defaultValue || ''}"
                    placeholder="${getEnvPlaceholder(key)}"
                    class="form-control"
                    style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #ddd;">
                ${getEnvDescription(key)}
            </div>
        `).join('');
    }

    // Hilfsfunktion für Platzhalter
    function getEnvPlaceholder(key) {
        const placeholders = {
            'TZ': 'Europe/Berlin',
            'PUID': '1000',
            'PGID': '1000'
        };
        return placeholders[key] || '';
    }
    
    // Hilfsfunktion für Beschreibungen
    function getEnvDescription(key) {
        const descriptions = {
            'TZ': '<small class="hint">Zeitzone für den Container</small>',
            'PUID': '<small class="hint">User ID für Container-Berechtigungen</small>',
            'PGID': '<small class="hint">Group ID für Container-Berechtigungen</small>',
            'NETWORK_INTERFACE': '<small class="hint">Die zu überwachende Netzwerkschnittstelle (z.B. eth0, wlan0)</small>',
            'IP_RANGE': '<small class="hint">Der zu scannende IP-Bereich (z.B. 192.168.1.0/24)</small>',
            'SCAN_INTERVAL': '<small class="hint">Intervall in Sekunden zwischen Netzwerk-Scans (Standard: 300)</small>',
            'PASSWORD': '<small class="hint">Passwort für den Zugriff auf die Anwendung</small>'
        };
        return descriptions[key] || '';
    }
    
    // Hilfsfunktion für spezielle Container-Felder
    function getSpecialContainerFields(containerName) {
        switch (containerName) {
            case 'watchyourlan':
            case 'watchyourlanarm':
                return `
                    <div class="watchyourlan-section" style="margin-bottom: 20px; padding: 20px; background: var(--color-background-dark); border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.05);">
                        <h3 style="margin-bottom: 15px; color: var(--color-primary); font-size: 18px;">
                            <i class="fa fa-network-wired"></i> WatchYourLAN Settings
                        </h3>
                        <div class="form-group" style="margin-bottom: 15px;">
                            <label for="network-interface" style="display: block; margin-bottom: 5px; font-weight: bold;">Network Interface</label>
                            <input type="text" id="network-interface" name="network-interface" value="eth0" placeholder="Enter network interface" class="form-control" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #ddd;">
                            <small class="hint" style="display: block; margin-top: 5px; color: #666; font-size: 0.9em;">The network interface to monitor (e.g. eth0, ens18)</small>
                        </div>
                        <div class="form-group" style="margin-bottom: 15px;">
                            <label for="ip-range" style="display: block; margin-bottom: 5px; font-weight: bold;">IP Range</label>
                            <input type="text" id="ip-range" name="ip-range" value="192.168.1.0/24" placeholder="Enter IP range" class="form-control" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #ddd;">
                            <small class="hint" style="display: block; margin-top: 5px; color: #666; font-size: 0.9em;">The IP range to scan (e.g. 192.168.1.0/24)</small>
                        </div>
                        <div class="form-group" style="margin-bottom: 15px;">
                            <label for="wyl-port" style="display: block; margin-bottom: 5px; font-weight: bold;">WatchYourLAN GUI Port</label>
                            <input type="text" id="wyl-port" name="wyl-port" value="8840" placeholder="Enter port" class="form-control" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #ddd;">
                            <small class="hint" style="display: block; margin-top: 5px; color: #666; font-size: 0.9em;">The port for WatchYourLAN web interface (default: 8840)</small>
                        </div>
                        <div class="alert alert-info" style="padding: 12px 15px; background-color: rgba(0, 130, 201, 0.1); color: var(--color-primary); border-radius: 4px; margin-top: 15px; border-left: 4px solid var(--color-primary);">
                            <p style="margin-bottom: 8px;"><strong>Note:</strong> The network interface and IP range are automatically detected. Please verify they are correct for your network.</p>
                            <p><strong>Important:</strong> WatchYourLAN requires host network mode to properly scan your network. The main interface will be available at the GUI port specified above.</p>
                        </div>
                    </div>
                `;
            case 'mosquitto':
            case 'mosquitto-broker':
                return `
                    <div class="mosquitto-section" style="margin-bottom: 20px; padding: 20px; background: var(--color-background-dark); border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.05);">
                        <h3 style="margin-bottom: 15px; color: var(--color-primary); font-size: 18px;">
                            <i class="fa fa-exchange"></i> Mosquitto Settings
                        </h3>
                        <div class="form-group" style="margin-bottom: 15px; display: flex; align-items: center;">
                            <input type="checkbox" id="mqtt-auth" name="mqtt-auth" style="margin-right: 10px;">
                            <label for="mqtt-auth" style="font-weight: bold; cursor: pointer;">Enable Authentication</label>
                        </div>
                        <div class="auth-credentials" style="display: none; padding: 15px; background: rgba(0,0,0,0.03); border-radius: 4px; margin-top: 5px; border-left: 3px solid var(--color-primary);">
                            <div class="form-group" style="margin-bottom: 15px;">
                                <label for="mqtt-username" style="display: block; margin-bottom: 5px; font-weight: bold;">Username</label>
                                <input type="text" id="mqtt-username" name="mqtt-username" value="admin" class="form-control" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #ddd;">
                            </div>
                            <div class="form-group" style="margin-bottom: 10px;">
                                <label for="mqtt-password" style="display: block; margin-bottom: 5px; font-weight: bold;">Password</label>
                                <input type="password" id="mqtt-password" name="mqtt-password" value="password" class="form-control" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #ddd;">
                            </div>
                        </div>
                        <div class="alert alert-info" style="padding: 12px 15px; background-color: rgba(0, 130, 201, 0.1); color: var(--color-primary); border-radius: 4px; margin-top: 15px; border-left: 4px solid var(--color-primary);">
                            <p><strong>Note:</strong> Mosquitto MQTT broker will be available on ports 1883 (MQTT) and 9001 (WebSockets). The default configuration allows anonymous access unless authentication is enabled above.</p>
                        </div>
                    </div>
                `;
            default:
                return '';
        }
    }
    
    // Event-Listener für spezielle Container-Felder einrichten
    function setupSpecialContainerFields(containerName, modal) {
        switch (containerName) {
            case 'mosquitto':
            case 'mosquitto-broker':
                const authCheckbox = modal.querySelector('#mqtt-auth');
                const authCredentials = modal.querySelector('.auth-credentials');
                if (authCheckbox && authCredentials) {
                    authCheckbox.addEventListener('change', (e) => {
                        authCredentials.style.display = e.target.checked ? 'block' : 'none';
                    });
                }
                break;
        }
    }
    
    // Ausführung der Installation
    window.executeInstall = async function(containerName) {
        try {
            // Zeige Loading-Overlay
            const loadingOverlay = document.getElementById('loading-overlay');
            if (loadingOverlay) {
                loadingOverlay.style.display = 'flex';
            }

            // Installationsdaten sammeln
            const installData = {
                name: containerName,
                path: `/app/config/compose-files/${containerName}`,
                ports: {},
                env: {},
                volumes: []
            };

            // Port-Mappings sammeln
            const portInputs = document.querySelectorAll('.modal .port-mapping input');
            if (portInputs.length > 0) {
                portInputs.forEach(input => {
                    const containerPort = input.getAttribute('data-internal-port');
                    if (containerPort) {
                        installData.ports[containerPort] = input.value;
                    }
                });
            }

            // Umgebungsvariablen sammeln
            const envInputs = document.querySelectorAll('.modal .env-var input');
            if (envInputs.length > 0) {
                envInputs.forEach(input => {
                    const envKey = input.getAttribute('data-env-key');
                    if (envKey) {
                        installData.env[envKey] = input.value;
                    }
                });
            }

            // Spezielle Container-Konfigurationen
            if (containerName === 'mosquitto' || containerName === 'mosquitto-broker') {
                const authEnabled = document.getElementById('mqtt-auth')?.checked || false;
                const username = document.getElementById('mqtt-username')?.value || 'admin';
                const password = document.getElementById('mqtt-password')?.value || 'password';
                
                installData.mosquitto = {
                    auth_enabled: authEnabled,
                    username: username,
                    password: password
                };
                
                // Ensure proper volume mapping for mosquitto
                installData.volumes = [
                    `./config:/mosquitto/config`,
                    `./data:/mosquitto/data`,
                    `./log:/mosquitto/log`
                ];
                
                // Add user and group configuration
                installData.user = "1883:1883";
                
                // Add a config template to ensure the config file exists
                installData.config_template = `
# Default listener
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

# Authentication
allow_anonymous ${authEnabled ? 'false' : 'true'}
${authEnabled ? 'password_file /mosquitto/config/passwd' : ''}
`;
            } 
            else if (containerName === 'watchyourlan' || containerName === 'watchyourlanarm') {
                const networkInterface = document.getElementById('network-interface')?.value || 'eth0';
                const ipRange = document.getElementById('ip-range')?.value || '192.168.1.0/24';
                const guiPort = document.getElementById('wyl-port')?.value || '8840';
                
                installData.env = {
                    ...installData.env,
                    'NETWORK_INTERFACE': networkInterface,
                    'IP_RANGE': ipRange
                };
                
                installData.ports = {
                    ...installData.ports,
                    '8840': guiPort
                };
                
                installData.volumes = [
                    `./config:/config`,
                    `./data:/data`
                ];
            }
            else {
                // Default volumes for other containers
                installData.volumes = [
                    `./config:/config`,
                    `./data:/data`
                ];
            }

            console.log('Installation data:', installData);

            // Installation ausführen
            const installResponse = await fetch('/api/install', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(installData)
            });
            
            if (!installResponse.ok) {
                throw new Error(`Installation failed: ${installResponse.status}`);
            }
            
            const result = await installResponse.json();
            console.log('Installation result:', result);
            
            // Success notification
            NotificationManager.show('success', `Container ${containerName} installed successfully`);
            
            // Close modal
            closeModal();
            
            // Refresh container status
            setTimeout(() => {
                // Update container list
                App.refreshContainers();
            }, 1000);
            
            return result;
        } catch (error) {
            console.error('Installation error:', error);
            NotificationManager.show('error', `Installation error: ${error.message}`);
            
            // Hide loading overlay
            const loadingOverlay = document.getElementById('loading-overlay');
            if (loadingOverlay) {
                loadingOverlay.style.display = 'none';
            }
            
            return { error: error.message };
        }
    };
    
    // Modal schließen
    window.closeModal = function() {
        document.querySelectorAll('.modal').forEach(modal => {
            modal.classList.remove('show');
            setTimeout(() => {
                if (modal.parentNode) {
                    modal.parentNode.removeChild(modal);
                }
            }, 300);
        });
    };
    
    // Füge globale Wrapper-Funktion hinzu für getContainerLogo
    window.getContainerLogo = function(containerName) {
        return ContainerRenderer._getContainerLogo(containerName);
    };
    
    // Füge globale Wrapper-Funktion hinzu für updateContainerStatus
    window.updateContainerStatus = function(showLoading = false) {
        return App.refreshContainers();
    };
})();