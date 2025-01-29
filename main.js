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
            <div class="modal-form">
                ${generateConfigFields(containerConfig)}
            </div>
            <div class="modal-buttons">
                <button onclick="confirmInstall('${container}')">Installieren</button>
                <button onclick="closeModal()">Abbrechen</button>
            </div>
        `;
        
        modal.style.display = 'block';
    } catch (error) {
        console.error('Fehler beim Laden der Container-Konfiguration:', error);
        alert('Fehler beim Laden der Container-Konfiguration. Bitte versuchen Sie es später erneut.');
    }
}

// Hilfsfunktion zum Generieren der Konfigurationsfelder
function generateConfigFields(containerConfig) {
    if (!containerConfig.config) {
        return '';
    }

    return Object.entries(containerConfig.config)
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
        `).join('');
} 