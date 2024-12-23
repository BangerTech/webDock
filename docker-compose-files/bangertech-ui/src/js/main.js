document.addEventListener('DOMContentLoaded', function() {
    const containers = [
        {name: 'openHAB', port: 8080, description: 'Smart Home Platform'},
        {name: 'Frontail', port: 9001, description: 'LogViewer for openHAB'},
        {name: 'MosquittoBroker', port: 1883, description: 'MQTT Broker'},
        // ... weitere Container
    ];

    const grid = document.querySelector('.container-grid');
    containers.forEach(container => {
        grid.innerHTML += `
            <div class="container-card">
                <div class="status-indicator"></div>
                <h3>${container.name}</h3>
                <p>Port: ${container.port}</p>
                <p>${container.description}</p>
                <div class="actions">
                    <button class="install-btn" onclick="installContainer('${container.name}')">Install</button>
                    <button class="status-btn" onclick="checkStatus('${container.name}')">Status</button>
                </div>
            </div>
        `;
    });
}); 