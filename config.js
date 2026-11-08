// Préfixe unique pour éviter les collisions sur les serveurs publics PeerJS
const APP_PREFIX = 'vt-mdl-cvl-2026';

// Pool de serveurs PeerJS publics gratuits (essayés dans l'ordre)
// Aucun compte requis, aucun inscription nécessaire.
const PEER_CONFIG = {
    // Liste des serveurs PeerJS publics (fallback automatique)
    servers: [
        { host: '0.peerjs.com',          port: 443, path: '/', secure: true, key: 'peerjs' },
        { host: 'peerjs.92k.de',         port: 443, path: '/', secure: true, key: 'peerjs' },
        { host: 'peer.wallie.io',        port: 443, path: '/', secure: true, key: 'peerjs' },
        { host: 'peerjs-server.herokuapp.com', port: 443, path: '/', secure: true, key: 'peerjs' }
    ],
    // Options communes
    commonOptions: {
        debug: 0,
        // Désactive le stockage local (évite les warnings "Tracking Prevention")
        // PeerJS utilise localStorage pour certaines choses -> on l'empêche
        config: {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:global.stun.twilio.com:3478' }
            ],
            sdpSemantics: 'unified-plan'
        }
    }
};

// Désactive le stockage local de PeerJS pour éviter les warnings de tracking
// (PeerJS n'en a pas besoin pour fonctionner)
(function disablePeerJSStorage() {
    try {
        // Sauvegarde les vraies méthodes
        const realSetItem = Storage.prototype.setItem;
        const realGetItem = Storage.prototype.getItem;
        // Bloque uniquement les clés utilisées par PeerJS
        Storage.prototype.setItem = function(key, value) {
            if (typeof key === 'string' && (key.startsWith('peerjs') || key.startsWith('__peerjs'))) {
                return; // ignore
            }
            return realSetItem.apply(this, arguments);
        };
        Storage.prototype.getItem = function(key) {
            if (typeof key === 'string' && (key.startsWith('peerjs') || key.startsWith('__peerjs'))) {
                return null;
            }
            return realGetItem.apply(this, arguments);
        };
    } catch (e) { /* ignore */ }
})();
