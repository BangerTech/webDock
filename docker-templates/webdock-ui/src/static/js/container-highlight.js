/**
 * container-highlight.js
 * Enthält Hilfsfunktionen zur Hervorhebung von Containern nach Änderungen
 */

/**
 * Sucht einen Container in der angegebenen Kategorie und hebt ihn hervor
 */
function highlightMovedContainer(containerName, categoryId) {
    console.log(`Suche Container ${containerName} in Kategorie ${categoryId} für Hervorhebung...`);
    
    // Füge die Highlight-Stil-Definition hinzu, falls noch nicht vorhanden
    if (!document.getElementById('highlight-container-style')) {
        const style = document.createElement('style');
        style.id = 'highlight-container-style';
        style.textContent = `
            .highlight-container {
                box-shadow: 0 0 15px 5px #4CAF50 !important;
                transform: scale(1.02);
                transition: all 0.3s ease-in-out;
                z-index: 100;
            }
        `;
        document.head.appendChild(style);
    }
    
    // Finde den Container in der richtigen Kategorie
    const categorySection = document.querySelector(`.group-section[data-category-id="${categoryId}"]`);
    if (categorySection) {
        const containerCard = categorySection.querySelector(`.container-card[data-name="${containerName}"]`);
        if (containerCard) {
            // Scrolle zum Container und hebe ihn hervor
            containerCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
            containerCard.classList.add('highlight-container');
            // Entferne die Hervorhebung nach einigen Sekunden
            setTimeout(() => {
                containerCard.classList.remove('highlight-container');
            }, 3000);
            
            // Benachrichtigung anzeigen
            showNotification('success', `Container ${containerName} wurde erfolgreich in die Kategorie '${categoryId}' verschoben`);
            return true;
        } else {
            console.warn(`Container ${containerName} in Kategorie ${categoryId} nicht gefunden`);
        }
    } else {
        console.warn(`Kategorie ${categoryId} nicht gefunden`);
    }
    
    return false;
}

// Prüfen, ob es einen zuletzt verschobenen Container gibt und diesen hervorheben
document.addEventListener('DOMContentLoaded', function() {
    const lastMovedContainer = sessionStorage.getItem('lastMovedContainer');
    const lastMovedCategory = sessionStorage.getItem('lastMovedCategory');
    
    if (lastMovedContainer && lastMovedCategory) {
        console.log(`Seite geladen mit zuletzt verschobenem Container: ${lastMovedContainer} in Kategorie ${lastMovedCategory}`);
        
        // Entferne die Werte aus dem Session Storage
        sessionStorage.removeItem('lastMovedContainer');
        sessionStorage.removeItem('lastMovedCategory');
        
        // Warte bis Container geladen sind, dann hervorheben
        setTimeout(() => {
            highlightMovedContainer(lastMovedContainer, lastMovedCategory);
        }, 1500);
    }
});
