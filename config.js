// Préfixe unique pour éviter les collisions sur le serveur public PeerJS
const APP_PREFIX = 'vt-mdl-cvl-2026';

// Liste de serveurs PeerJS publics de secours (par ordre de préférence)
// Le client et l'admin DOIVENT utiliser le même serveur.
const PEER_CONFIG = {
    // Serveur PeerJS cloud officiel (avec configuration explicite)
    host: '0.peerjs.com',
    port: 443,
    path: '/',
    secure: true,
    debug: 0,
    config: {
        'iceServers': [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' }
        ]
    }
};
