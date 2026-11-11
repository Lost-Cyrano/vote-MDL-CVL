let peer = null, connections = [], sessionId = null, displayCode = null;
let currentVote = null, voters = new Map(), hasVoted = new Set(), history = [];
let sessionStartTime = new Date(), voteActive = false, waitingForVotes = false;
let draftTimeout = null, sessionClosed = false;
let currentServerIndex = 0, reconnectTimer = null, reconnectAttempts = 0;
let startNumero = 1;
let siegesIdentites = [];
let siegesMap = new Map();
const MAX_RECONNECT_ATTEMPTS = 30;

const HEMICYCLE_BASE = "https://vote.honore-romane.fr/scrutins/hemicycle.html";
const SIEGES_URL = "sieges.json";
const ACCOUNT_FALLBACK = "https://account.honore-romane.fr/tools/vote/";

const PDF_COLORS = {
    an: [27, 85, 138],
    anLight: [232, 240, 248],
    pour: [32, 107, 167],
    contre: [227, 64, 81],
    abstention: [159, 168, 173],
    success: [16, 185, 129],
    danger: [239, 68, 68],
    text: [30, 41, 59],
    textLight: [100, 116, 139],
    border: [226, 232, 240],
    white: [255, 255, 255]
};

// =====================================================================
// ==================== VÉRIFICATION D'ACCÈS ADMIN =====================
// =====================================================================
function showVerifyError(msg) {
    const screen = document.getElementById('verify-screen');
    screen.classList.add('error');
    document.getElementById('verify-status').textContent = 'Accès refusé';
    document.getElementById('verify-error').textContent = msg;
    console.error(msg);
}

function redirectToAccount(reason) {
    console.warn('Redirection vers account:', reason);
    window.location.replace(ACCOUNT_FALLBACK);
}

async function bootstrap() {
    // 1) Attendre que le module Firebase soit chargé
    const waitForFirebase = () => new Promise(resolve => {
        if (window.__firebaseReady) { resolve(); return; }
        const check = setInterval(() => {
            if (window.__firebaseReady) { clearInterval(check); resolve(); }
        }, 50);
        setTimeout(() => { clearInterval(check); resolve(); }, 5000);
    });
    await waitForFirebase();

    if (!window.__verifyToken) {
        redirectToAccount('Firebase non chargé');
        return;
    }

    // 2) Lire le token dans l'URL
    const params = new URLSearchParams(window.location.search);
    const token = params.get('t');
    if (!token) {
        redirectToAccount('Token absent');
        return;
    }

    // 3) Vérifier la signature du JWT
    const payload = await window.__verifyToken(token);
    if (!payload) {
        redirectToAccount('Token invalide ou expiré');
        return;
    }

    // 4) Vérifier le claim admin dans le JWT
    if (payload.admin !== true) {
        redirectToAccount('Claim admin absent du token');
        return;
    }

    // 5) Le JWT signé suffit : le claim admin a déjà été certifié par account
if (!payload.sub) {
    redirectToAccount('sub absent du token');
    return;
}

    // 6) Nettoyage de l'URL (retirer ?t=)
    const cleanUrl = new URL(window.location);
    cleanUrl.searchParams.delete('t');
    window.history.replaceState({}, '', cleanUrl);

    // 7) Afficher l'interface et lancer l'init normale
    document.getElementById('verify-screen').style.display = 'none';
    document.getElementById('main-container').style.display = 'flex';

    await loadSiegesIdentites();
    init();
    toggleVoteMode();
    addOption();
    addOption();
}

// ===== Chargement des identités des sièges =====
async function loadSiegesIdentites() {
    try {
        const res = await fetch(SIEGES_URL, { cache: 'no-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('Format invalide (attendu: tableau)');
        siegesIdentites = data
            .map(s => ({
                numero: parseInt(s.numero),
                nom: s.nom || '',
                prenom: s.prenom || '',
                sex: (s.sex || s.genre || 'M').toUpperCase() === 'F' ? 'F' : 'M',
                circonscription: s.circonscription || s.circo || '',
                groupe: s.groupe || ''
            }))
            .filter(s => !isNaN(s.numero))
            .sort((a, b) => a.numero - b.numero);
        siegesMap = new Map(siegesIdentites.map(s => [s.numero, s]));
        const info = document.getElementById('siege-info');
        if (info) {
            info.textContent = `${siegesIdentites.length} siège(s) chargé(s) depuis ${SIEGES_URL}`;
        }
        return true;
    } catch (e) {
        console.error('Erreur chargement sieges.json:', e);
        const info = document.getElementById('siege-info');
        if (info) {
            info.innerHTML = `<strong style="color:var(--danger)">Erreur :</strong> impossible de charger <code>${SIEGES_URL}</code>. Vérifiez que le fichier existe et est accessible.`;
        }
        return false;
    }
}

// ===== Initialisation PeerJS =====
function init() {
    if (sessionClosed) return;
    if (peer) { try { peer.destroy(); } catch(e) {} peer = null; }
    displayCode = generateShortCode();
    sessionId = APP_PREFIX + '-' + displayCode;

    const server = PEER_CONFIG.servers[currentServerIndex];
    updateServerStatus(`Serveur : ${server.host} (essai ${currentServerIndex + 1}/${PEER_CONFIG.servers.length})`);

    const peerOptions = {
        ...PEER_CONFIG.commonOptions,
        host: server.host,
        port: server.port,
        path: server.path,
        secure: server.secure,
        key: server.key,
        pingInterval: 5000
    };

    try {
        peer = new Peer(sessionId, peerOptions);
    } catch (e) {
        console.error('Erreur création Peer:', e);
        switchToNextServer();
        return;
    }

    let opened = false;

    peer.on('open', (id) => {
        opened = true;
        reconnectAttempts = 0;
        console.log('✅ Session ouverte avec ID:', id, 'sur', server.host);
        updateServerStatus(`Serveur : ${server.host} ✓`);
        const baseUrl = window.location.origin + window.location.pathname.replace('/admin', '/');
        const link = `${baseUrl}?s=${displayCode}`;
        document.getElementById('session-link').value = link;
        document.getElementById('session-code-display').textContent = displayCode;
        document.getElementById("qrcode").innerHTML = '';
        new QRCode(document.getElementById("qrcode"), { text: link, width: 360, height: 360, colorDark: "#1e293b", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M });
        document.getElementById('connection-status').textContent = 'Prêt';
        document.getElementById('connection-status').className = 'badge success';
    });

    peer.on('connection', (conn) => {
        connections.push(conn); voters.set(conn.peer, true); updateConnectedCount();
        conn.on('data', (data) => handleUserData(conn, data));
        conn.on('close', () => {
            voters.delete(conn.peer);
            connections = connections.filter(c => c.peer !== conn.peer);
            updateConnectedCount();
        });
        conn.on('error', (err) => { console.warn('Erreur connexion:', err); });
    });

    peer.on('error', (err) => {
        console.error('Erreur PeerJS:', err);
        if (err.type === 'unavailable-id') {
            showToast('Code déjà utilisé, régénération...');
            try { peer.destroy(); } catch(e) {}
            setTimeout(() => init(), 500);
            return;
        }
        if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || err.type === 'socket-closed') {
            if (!opened) {
                switchToNextServer();
            } else {
                attemptReconnect();
            }
            return;
        }
        showToast('Erreur: ' + err.type);
    });

    peer.on('disconnected', () => {
        console.warn('Peer déconnecté, tentative de reconnexion...');
        if (sessionClosed) return;
        attemptReconnect();
    });

    peer.on('close', () => {
        if (sessionClosed) return;
        attemptReconnect();
    });

    const savedHistory = localStorage.getItem('vote_history_' + sessionId);
    if (savedHistory) {
        try { history = JSON.parse(savedHistory); } catch(e) { history = []; }
    }
    const savedStart = localStorage.getItem('vote_start_numero_' + sessionId);
    if (savedStart) {
        startNumero = parseInt(savedStart) || 1;
        document.getElementById('start-numero-input').value = startNumero;
    }
    updateNextNumeroDisplay();
}

function saveStartNumero() {
    const input = document.getElementById('start-numero-input');
    let v = parseInt(input.value);
    if (isNaN(v) || v < 1) v = 1;
    startNumero = v;
    input.value = v;
    try { localStorage.setItem('vote_start_numero_' + sessionId, String(v)); } catch(e) {}
    updateNextNumeroDisplay();
}

function updateNextNumeroDisplay() {
    const next = startNumero + history.length;
    const el = document.getElementById('next-numero-display');
    if (el) el.textContent = formatNumero(next);
}

function formatNumero(n) { return String(n).padStart(4, '0'); }

function getVoteNumero(entry) {
    if (entry && entry.numero) return entry.numero;
    if (entry && entry.voteId) {
        const idx = history.findIndex(h => h.voteId === entry.voteId);
        if (idx >= 0) return formatNumero(startNumero + idx);
    }
    return formatNumero(startNumero);
}

function switchToNextServer() {
    currentServerIndex = (currentServerIndex + 1) % PEER_CONFIG.servers.length;
    console.warn('Bascule vers serveur:', PEER_CONFIG.servers[currentServerIndex].host);
    try { peer.destroy(); } catch(e) {}
    peer = null;
    setTimeout(() => init(), 800);
}

function attemptReconnect() {
    if (sessionClosed) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.warn('Trop de tentatives, bascule serveur');
        reconnectAttempts = 0;
        switchToNextServer();
        return;
    }
    reconnectAttempts++;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
        if (sessionClosed) return;
        if (peer && !peer.destroyed && peer.disconnected) {
            try { peer.reconnect(); return; } catch(e) {}
        }
        const savedCode = displayCode;
        const savedSessionId = sessionId;
        try { peer.destroy(); } catch(e) {}
        peer = null;
        setTimeout(() => {
            if (sessionClosed) return;
            displayCode = savedCode;
            sessionId = savedSessionId;
            recreatePeerWithCurrentCode();
        }, 500);
    }, Math.min(1000 * reconnectAttempts, 8000));
}

function recreatePeerWithCurrentCode() {
    if (sessionClosed) return;
    const server = PEER_CONFIG.servers[currentServerIndex];
    const peerOptions = {
        ...PEER_CONFIG.commonOptions,
        host: server.host,
        port: server.port,
        path: server.path,
        secure: server.secure,
        key: server.key,
        pingInterval: 5000
    };
    try {
        peer = new Peer(sessionId, peerOptions);
    } catch (e) {
        switchToNextServer();
        return;
    }
    peer.on('open', (id) => {
        console.log('✅ Reconnexion réussie sur', server.host);
        reconnectAttempts = 0;
        updateServerStatus(`Serveur : ${server.host} ✓`);
        document.getElementById('connection-status').textContent = 'Prêt';
        document.getElementById('connection-status').className = 'badge success';
        if (voteActive && currentVote) {
            broadcast({ type: 'new_vote', vote: { question: currentVote.question, mode: currentVote.mode, options: currentVote.options, maxChoices: currentVote.maxChoices } });
        }
    });
    peer.on('connection', (conn) => {
        connections.push(conn); voters.set(conn.peer, true); updateConnectedCount();
        conn.on('data', (data) => handleUserData(conn, data));
        conn.on('close', () => {
            voters.delete(conn.peer);
            connections = connections.filter(c => c.peer !== conn.peer);
            updateConnectedCount();
        });
    });
    peer.on('error', (err) => {
        console.error('Erreur PeerJS (reconnexion):', err);
        if (err.type === 'unavailable-id') {
            try { peer.destroy(); } catch(e) {}
            setTimeout(() => init(), 500);
        } else {
            attemptReconnect();
        }
    });
    peer.on('disconnected', () => { if (!sessionClosed) attemptReconnect(); });
    peer.on('close', () => { if (!sessionClosed) attemptReconnect(); });
}

function updateServerStatus(text) {
    const el = document.getElementById('server-status');
    if (el) el.textContent = text;
}

function generateShortCode() { const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'; let code = ''; for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length)); return code; }
function openAdmin() { saveStartNumero(); document.getElementById('home-section').classList.add('hidden'); document.getElementById('admin-section').classList.remove('hidden'); updateNextNumeroDisplay(); }
function switchTab(tab) { document.getElementById('tab-create').classList.toggle('active', tab === 'create'); document.getElementById('tab-history').classList.toggle('active', tab === 'history'); document.getElementById('create-tab-content').classList.toggle('hidden', tab !== 'create'); document.getElementById('history-tab-content').classList.toggle('hidden', tab !== 'history'); if (tab === 'history') renderHistory(); }

function sendDraft() { if (draftTimeout) clearTimeout(draftTimeout); draftTimeout = setTimeout(() => { const draft = getCurrentDraft(); if (!draft) { broadcast({ type: 'draft_cancelled' }); return; } broadcast({ type: 'draft', draft }); }, 400); }
function getCurrentDraft() { const question = document.getElementById('question-input').value.trim(); const mode = document.getElementById('vote-mode').value; const maxChoices = parseInt(document.getElementById('max-choices').value) || 1; let options = []; if (mode === 'multiple') document.querySelectorAll('.option-input').forEach(inp => { if (inp.value.trim()) options.push(inp.value.trim()); }); if (!question && options.length === 0) return null; return { question, mode, maxChoices, options }; }

function handleUserData(conn, data) {
    if (data.type === 'hello') {
        if (voteActive && currentVote) conn.send({ type: 'state', state: 'voting', vote: currentVote, hasVoted: hasVoted.has(conn.peer) });
        else if (!voteActive && currentVote) conn.send({ type: 'state', state: 'results' });
        else { conn.send({ type: 'state', state: 'waiting' }); const draft = getCurrentDraft(); if (draft) conn.send({ type: 'draft', draft }); }
        return;
    }
    if (data.type === 'vote') {
        if (!voteActive || hasVoted.has(conn.peer)) return;
        hasVoted.add(conn.peer);
        const siegeNum = (data.siege !== undefined && data.siege !== null) ? parseInt(data.siege) : null;
        currentVote.votes.push({ connId: conn.peer, siege: siegeNum, answers: data.answers });
        updateVoteProgress();
        if (hasVoted.size >= voters.size && voters.size > 0) finishVote();
    }
}
function updateConnectedCount() { document.getElementById('connected-count').textContent = voters.size; if (voteActive && waitingForVotes) document.getElementById('remaining-voters').textContent = Math.max(0, voters.size - hasVoted.size); }
function toggleVoteMode() { const mode = document.getElementById('vote-mode').value; document.getElementById('simple-options').classList.toggle('hidden', mode !== 'simple'); document.getElementById('multiple-options').classList.toggle('hidden', mode !== 'multiple'); }
function addOption() { const list = document.getElementById('options-list'); const div = document.createElement('div'); div.className = 'vote-option'; div.innerHTML = `<input type="text" placeholder="Nom de l'option" class="option-input" oninput="sendDraft()"><button onclick="this.parentElement.remove(); sendDraft();">×</button>`; list.appendChild(div); }

function startVote() {
    const question = document.getElementById('question-input').value.trim(); if (!question) { showToast('Veuillez entrer une question.'); return; }
    const mode = document.getElementById('vote-mode').value; let options = []; let maxChoices = 1;
    if (mode === 'simple') options = ['Pour', 'Abstention', 'Contre'];
    else { maxChoices = parseInt(document.getElementById('max-choices').value) || 1; document.querySelectorAll('.option-input').forEach(inp => { if (inp.value.trim()) options.push(inp.value.trim()); }); if (options.length < 2) { showToast('Ajoutez au moins 2 options.'); return; } }
    const numero = formatNumero(startNumero + history.length);
    currentVote = { id: Date.now(), numero, question, mode, options, maxChoices, votes: [], timestamp: new Date().toISOString(), expectedVoters: voters.size };
    hasVoted.clear(); voteActive = true; waitingForVotes = true;
    broadcast({ type: 'new_vote', vote: { question, mode, options, maxChoices } });
    document.getElementById('create-section').classList.add('hidden'); document.getElementById('vote-section').classList.remove('hidden'); document.getElementById('results-section').classList.add('hidden');
    document.getElementById('current-question-display').textContent = question; document.getElementById('votes-received').textContent = '0'; document.getElementById('remaining-voters').textContent = voters.size;
    document.getElementById('vote-numero-badge').textContent = `n°${numero}`;
    showToast(`Vote n°${numero} lancé !`);
}
function broadcast(message) { connections.forEach(conn => { if (conn.open) { try { conn.send(message); } catch(e) { console.warn('Broadcast error:', e); } } }); }
function updateVoteProgress() { document.getElementById('votes-received').textContent = hasVoted.size; document.getElementById('remaining-voters').textContent = Math.max(0, voters.size - hasVoted.size); }
function skipWaiting() { if (!voteActive) return; waitingForVotes = false; finishVote(); }
function showResults() { if (!voteActive) return; waitingForVotes = false; finishVote(); }

function calculateResults() {
    const options = currentVote.options;
    const mode = currentVote.mode;
    const counts = {}; options.forEach(opt => counts[opt] = 0);
    let totalExpressed = 0;
    let totalVoters = hasVoted.size;
    currentVote.votes.forEach(vote => {
        if (mode === 'simple') {
            const idx = vote.answers[0];
            if (idx !== undefined && options[idx]) {
                counts[options[idx]]++;
                if (options[idx] === 'Pour' || options[idx] === 'Contre') totalExpressed++;
            }
        } else {
            if (vote.answers.length === 0) { }
            else vote.answers.forEach(idx => { if (options[idx]) { counts[options[idx]]++; totalExpressed++; } });
        }
    });
    const absoluteMajority = Math.floor(totalExpressed / 2) + 1;
    const sorted = Object.entries(counts).map(([name, count]) => ({ name, count, percentage: totalExpressed > 0 ? (count / totalExpressed) * 100 : 0 })).sort((a, b) => b.count - a.count);
    let winners = [];
    if (mode === 'multiple') {
        winners = sorted.slice(0, currentVote.maxChoices).filter(w => w.count > 0);
    } else {
        const pour = counts['Pour'] || 0;
        const contre = counts['Contre'] || 0;
        if (pour > contre) winners = [{ name: 'Pour', count: pour, percentage: 0 }];
        else winners = [{ name: 'Contre', count: contre, percentage: 0 }];
    }
    return { counts, sorted, totalExpressed, totalVoters, absoluteMajority, winners, mode, options };
}

function buildHemicycleData() {
    const counts = { pour: 0, contre: 0, abstention: 0 };
    const sieges = [];

    const votesBySeat = new Map();
    currentVote.votes.forEach(v => {
        if (v.siege !== undefined && v.siege !== null && !isNaN(v.siege)) {
            votesBySeat.set(parseInt(v.siege), v);
        }
    });

    siegesIdentites.forEach(identite => {
        const vote = votesBySeat.get(identite.numero);
        let voteType = 'absent';
        if (vote) {
            const idx = vote.answers[0];
            if (idx !== undefined && currentVote.options[idx]) {
                const opt = currentVote.options[idx];
                if (opt === 'Pour') voteType = 'pour';
                else if (opt === 'Contre') voteType = 'contre';
                else if (opt === 'Abstention') voteType = 'abstention';
            }
        }
        if (voteType === 'pour') counts.pour++;
        else if (voteType === 'contre') counts.contre++;
        else if (voteType === 'abstention') counts.abstention++;

        sieges.push({
            nom: identite.nom,
            prenom: identite.prenom,
            genre: identite.sex,
            circo: identite.circonscription,
            groupe: identite.groupe,
            vote: voteType,
            numero: identite.numero
        });
    });

    return {
        numero: currentVote.numero,
        date: new Date().toISOString().slice(0, 10),
        titre: currentVote.question,
        pour: counts.pour,
        contre: counts.contre,
        abstention: counts.abstention,
        sieges
    };
}

function finishVote() {
    if (!voteActive) return;
    voteActive = false; waitingForVotes = false;
    const results = calculateResults();
    const entry = {
        voteId: currentVote.id,
        numero: currentVote.numero,
        question: currentVote.question,
        mode: currentVote.mode,
        timestamp: currentVote.timestamp,
        endedAt: new Date().toISOString()
    };
    if (currentVote.mode === 'simple') {
        entry.hemicycleData = buildHemicycleData();
    } else {
        entry.results = results;
    }
    history.push(entry);
    try { localStorage.setItem('vote_history_' + sessionId, JSON.stringify(history)); } catch(e) {}
    displayResults(entry);
    broadcast({ type: 'results', results });
    updateNextNumeroDisplay();
}

// =====================================================================
// ============ CHARGEMENT DE L'IFRAME HÉMICYCLE (postMessage) =========
// =====================================================================
function loadHemicycleFrame(iframe, hemicycleData) {
    return new Promise((resolve) => {
        let ready = false;

        const onMessage = (event) => {
            const msg = event.data;
            if (!msg || msg.type !== 'hemicycle_ready') return;
            window.removeEventListener('message', onMessage);
            ready = true;
            try {
                iframe.contentWindow.postMessage({ type: 'hemicycle_data', data: hemicycleData }, '*');
            } catch (e) {
                console.warn('postMessage échoué:', e);
            }
            setTimeout(() => resolve(true), 1800);
        };
        window.addEventListener('message', onMessage);

        iframe.src = HEMICYCLE_BASE;

        setTimeout(() => {
            if (!ready) {
                window.removeEventListener('message', onMessage);
                try {
                    iframe.contentWindow.postMessage({ type: 'hemicycle_data', data: hemicycleData }, '*');
                } catch (e) {}
                setTimeout(() => resolve(false), 1500);
            }
        }, 6000);
    });
}

async function displayResults(entry) {
    document.getElementById('vote-section').classList.add('hidden');
    document.getElementById('results-section').classList.remove('hidden');
    document.getElementById('result-question').textContent = entry.question;
    document.getElementById('result-numero-badge').textContent = `n°${entry.numero || getVoteNumero(entry)}`;

    const hemiWrap = document.getElementById('hemicycle-wrap');
    const elecWrap = document.getElementById('election-results');
    const frame = document.getElementById('hemicycle-frame');

    if (entry.mode === 'simple' && entry.hemicycleData) {
        hemiWrap.classList.remove('hidden');
        elecWrap.classList.add('hidden');
        await loadHemicycleFrame(frame, entry.hemicycleData);
    } else {
        hemiWrap.classList.add('hidden');
        elecWrap.classList.remove('hidden');
        renderElectionResults(entry.results);
    }
}

function renderElectionResults(results) {
    document.getElementById('total-votes').textContent = results.totalExpressed;
    document.getElementById('absolute-majority').textContent = results.absoluteMajority;
    document.getElementById('total-voters').textContent = results.totalVoters;
    const list = document.getElementById('results-list'); list.innerHTML = '';
    results.sorted.forEach(item => {
        const isWinner = results.winners.some(w => w.name === item.name);
        const div = document.createElement('div');
        div.className = 'result-item' + (isWinner ? ' winner' : '');
        div.innerHTML = `<div style="flex: 1;"><div class="flex-between"><span style="font-weight: ${isWinner ? '700' : '400'};">${escapeHtml(item.name)}</span><span>${item.count} voix (${item.percentage.toFixed(1)}%)</span></div><div class="result-bar"><div class="result-bar-fill" style="width: ${item.percentage}%; ${isWinner ? 'background: var(--success);' : ''}"></div></div></div>${isWinner ? '<span class="badge success" style="margin-left: 0.5rem;">Élu</span>' : ''}`;
        list.appendChild(div);
    });
}

function newVote() {
    document.getElementById('results-section').classList.add('hidden');
    document.getElementById('vote-section').classList.add('hidden');
    document.getElementById('create-section').classList.remove('hidden');
    document.getElementById('question-input').value = '';
    document.getElementById('options-list').innerHTML = '';
    document.getElementById('max-choices').value = '1';
    document.getElementById('vote-mode').value = 'simple';
    toggleVoteMode();
    currentVote = null; hasVoted.clear();
    broadcast({ type: 'reset' }); broadcast({ type: 'draft_cancelled' });
    updateNextNumeroDisplay();
}

function renderHistory() {
    const list = document.getElementById('history-list'); list.innerHTML = '';
    if (history.length === 0) {
        list.innerHTML = '<p style="text-align: center; color: var(--text-light); padding: 1rem;">Aucun vote dans l\'historique.</p>';
        return;
    }
    history.forEach((entry) => {
        const div = document.createElement('div');
        div.className = 'history-item';
        const numero = entry.numero || getVoteNumero(entry);
        let resume = '';
        if (entry.mode === 'simple' && entry.hemicycleData) {
            const hd = entry.hemicycleData;
            const res = hd.pour > hd.contre ? 'Adopté' : 'Rejeté';
            resume = `Pour : ${hd.pour} · Contre : ${hd.contre} · Abstention : ${hd.abstention} — <strong>${res}</strong>`;
        } else if (entry.results) {
            const r = entry.results;
            const elus = r.winners.map(w => escapeHtml(w.name)).join(', ') || 'Aucun';
            resume = `${r.totalExpressed} suffrages exprimés — <strong>Élu(s) : ${elus}</strong>`;
        }
        div.innerHTML = `<div class="flex-between"><strong>n°${numero} — ${escapeHtml(entry.question)}</strong><span class="badge info">${new Date(entry.timestamp).toLocaleString()}</span></div><div style="font-size: 0.8rem; color: var(--text-light); margin-top: 0.25rem;">${resume}</div>`;
        div.onclick = () => toggleHistoryDetail(div, entry);
        list.appendChild(div);
    });
}

async function toggleHistoryDetail(element, entry) {
    const existing = element.querySelector('.history-detail');
    if (existing) { existing.remove(); return; }
    const detail = document.createElement('div');
    detail.className = 'history-detail';

    if (entry.mode === 'simple' && entry.hemicycleData) {
        detail.innerHTML = `<div class="hemicycle-wrap history-mode"><iframe class="hemicycle-frame" frameborder="0"></iframe></div>`;
        element.appendChild(detail);
        const iframe = detail.querySelector('iframe');
        await loadHemicycleFrame(iframe, entry.hemicycleData);
    } else if (entry.results) {
        const r = entry.results;
        let html = `<div class="grid-3" style="margin-bottom: 1rem;">
            <div class="stat"><div class="stat-value">${r.totalExpressed}</div><div class="stat-label">Suffrages exprimés</div></div>
            <div class="stat"><div class="stat-value">${r.absoluteMajority}</div><div class="stat-label">Majorité absolue</div></div>
            <div class="stat"><div class="stat-value">${r.totalVoters}</div><div class="stat-label">Votants</div></div>
        </div><div>`;
        r.sorted.forEach(item => {
            const isWinner = r.winners.some(w => w.name === item.name);
            html += `<div class="result-item${isWinner ? ' winner' : ''}"><div style="flex: 1;"><div class="flex-between"><span style="font-weight: ${isWinner ? '700' : '400'};">${escapeHtml(item.name)}</span><span>${item.count} voix (${item.percentage.toFixed(1)}%)</span></div><div class="result-bar"><div class="result-bar-fill" style="width: ${item.percentage}%; ${isWinner ? 'background: var(--success);' : ''}"></div></div></div>${isWinner ? '<span class="badge success" style="margin-left: 0.5rem;">Élu</span>' : ''}</div>`;
        });
        html += '</div>';
        detail.innerHTML = html;
        element.appendChild(detail);
    } else {
        detail.innerHTML = '<p>Données indisponibles pour ce vote.</p>';
        element.appendChild(detail);
    }
}

async function closeSessionAndExport() {
    if (!confirm('Clore la session ? Le PDF sera téléchargé et tous les participants seront déconnectés.')) return;
    sessionClosed = true;
    // IMPORTANT : attendre la fin de l'export AVANT de vider history
    if (history.length > 0) {
        try {
            await exportPDF();
        } catch (e) {
            console.error('Erreur export PDF:', e);
            showToast('Erreur lors de la génération du PDF.');
        }
    }
    broadcast({ type: 'close' });
    try {
        localStorage.removeItem('vote_history_' + sessionId);
        localStorage.removeItem('vote_start_numero_' + sessionId);
    } catch(e) {}
    history = [];
    connections.forEach(conn => { if (conn.open) conn.close(); });
    connections = []; voters.clear();
    if (peer) { try { peer.destroy(); } catch(e) {} }
    document.getElementById('home-section').classList.add('hidden');
    document.getElementById('admin-section').classList.add('hidden');
    document.getElementById('closed-section').classList.remove('hidden');
}

// =====================================================================
// ============ HELPERS PDF ============================================
// =====================================================================
function pdfSetFill(doc, color) { doc.setFillColor(color[0], color[1], color[2]); }
function pdfSetText(doc, color) { doc.setTextColor(color[0], color[1], color[2]); }
function pdfSetDraw(doc, color) { doc.setDrawColor(color[0], color[1], color[2]); }

function pdfTricolore(doc, x, y, w, h) {
    const third = w / 3;
    pdfSetFill(doc, [0, 0, 255]); doc.rect(x, y, third, h, 'F');
    pdfSetFill(doc, [255, 255, 255]); doc.rect(x + third, y, third, h, 'F');
    pdfSetFill(doc, [255, 0, 0]); doc.rect(x + 2 * third, y, third, h, 'F');
    pdfSetDraw(doc, [200, 200, 200]); doc.rect(x, y, w, h, 'S');
}

function pdfBadge(doc, text, x, y, w, h, bg, fg) {
    pdfSetFill(doc, bg);
    doc.roundedRect(x, y, w, h, 1.5, 1.5, 'F');
    pdfSetText(doc, fg);
    doc.setFontSize(8);
    doc.setFont(undefined, 'bold');
    doc.text(text, x + w / 2, y + h / 2 + 1.2, { align: 'center' });
}

function pdfBar(doc, x, y, w, h, pct, bg, fg) {
    pdfSetFill(doc, bg);
    doc.roundedRect(x, y, w, h, h / 2, h / 2, 'F');
    const fillW = Math.max(0, Math.min(1, pct / 100)) * w;
    if (fillW > 0.2) {
        pdfSetFill(doc, fg);
        doc.roundedRect(x, y, fillW, h, h / 2, h / 2, 'F');
    }
}

function pdfHeader(doc, pageW) {
    pdfSetFill(doc, PDF_COLORS.an);
    doc.rect(0, 0, pageW, 12, 'F');
    pdfTricolore(doc, pageW - 24, 3, 18, 6);
    pdfSetText(doc, PDF_COLORS.white);
    doc.setFontSize(10);
    doc.setFont(undefined, 'bold');
    doc.text('RAPPORT DE SCRUTINS', 10, 8);
    pdfSetText(doc, PDF_COLORS.text);
}

function pdfFooter(doc, pageW, pageH, pageNum) {
    pdfSetDraw(doc, PDF_COLORS.border);
    doc.setLineWidth(0.2);
    doc.line(10, pageH - 12, pageW - 10, pageH - 12);
    pdfSetText(doc, PDF_COLORS.textLight);
    doc.setFontSize(8);
    doc.setFont(undefined, 'normal');
    doc.text(`Session ${displayCode} — Rapport généré le ${new Date().toLocaleString()}`, 10, pageH - 7);
    doc.text(`Page ${pageNum}`, pageW - 10, pageH - 7, { align: 'right' });
    pdfSetText(doc, PDF_COLORS.text);
}

// =====================================================================
// ========================== EXPORT PDF ===============================
// =====================================================================
async function exportPDF() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF('p', 'mm', 'a4');
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    let pageNum = 1;

    // SNAPSHOT — protège contre toute mutation de `history` pendant l'export async
    const historySnapshot = history.slice();

    pdfHeader(doc, pageW);

    doc.setFontSize(24);
    doc.setFont(undefined, 'bold');
    pdfSetText(doc, PDF_COLORS.an);
    doc.text('Rapport de session', pageW / 2, 32, { align: 'center' });

    pdfSetDraw(doc, PDF_COLORS.an);
    doc.setLineWidth(0.6);
    doc.line(pageW / 2 - 30, 36, pageW / 2 + 30, 36);

    const infoY = 46;
    pdfSetFill(doc, PDF_COLORS.anLight);
    doc.roundedRect(14, infoY, pageW - 28, 34, 3, 3, 'F');

    doc.setFontSize(11);
    doc.setFont(undefined, 'bold');
    pdfSetText(doc, PDF_COLORS.an);
    doc.text('Informations générales', 20, infoY + 8);

    doc.setFontSize(10);
    doc.setFont(undefined, 'normal');
    pdfSetText(doc, PDF_COLORS.text);
    doc.text(`Code de session : ${displayCode}`, 20, infoY + 16);
    doc.text(`Date de la session : ${sessionStartTime.toLocaleString()}`, 20, infoY + 23);
    doc.text(`Nombre de scrutins : ${historySnapshot.length}`, 20, infoY + 30);

    let y = infoY + 46;
    doc.setFontSize(14);
    doc.setFont(undefined, 'bold');
    pdfSetText(doc, PDF_COLORS.an);
    doc.text('Sommaire des scrutins', 14, y);
    y += 3;
    pdfSetDraw(doc, PDF_COLORS.border);
    doc.setLineWidth(0.3);
    doc.line(14, y, pageW - 14, y);
    y += 7;

    pdfSetFill(doc, PDF_COLORS.an);
    doc.rect(14, y - 5, pageW - 28, 7, 'F');
    pdfSetText(doc, PDF_COLORS.white);
    doc.setFontSize(9);
    doc.setFont(undefined, 'bold');
    doc.text('N°', 18, y);
    doc.text('Question', 30, y);
    doc.text('Résultat', pageW - 20, y, { align: 'right' });
    y += 8;

    doc.setFontSize(9);
    doc.setFont(undefined, 'normal');
    pdfSetText(doc, PDF_COLORS.text);

    historySnapshot.forEach((entry, index) => {
        if (y > pageH - 30) {
            pdfFooter(doc, pageW, pageH, pageNum); pageNum++;
            doc.addPage();
            pdfHeader(doc, pageW);
            y = 22;
            pdfSetFill(doc, PDF_COLORS.an);
            doc.rect(14, y - 5, pageW - 28, 7, 'F');
            pdfSetText(doc, PDF_COLORS.white);
            doc.setFontSize(9);
            doc.setFont(undefined, 'bold');
            doc.text('N°', 18, y);
            doc.text('Question', 30, y);
            doc.text('Résultat', pageW - 20, y, { align: 'right' });
            y += 8;
            doc.setFontSize(9);
            doc.setFont(undefined, 'normal');
            pdfSetText(doc, PDF_COLORS.text);
        }

        const numero = entry.numero || getVoteNumero(entry);
        const rowH = 11;
        if (index % 2 === 0) {
            pdfSetFill(doc, [248, 250, 252]);
            doc.rect(14, y - 4.5, pageW - 28, rowH, 'F');
        }

        doc.setFont(undefined, 'bold');
        pdfSetText(doc, PDF_COLORS.an);
        doc.text(numero, 18, y);

        pdfSetText(doc, PDF_COLORS.text);
        doc.setFont(undefined, 'normal');
        const qLines = doc.splitTextToSize(entry.question, pageW - 28 - 30 - 40);
        const qShow = qLines.slice(0, 2);
        doc.text(qShow, 30, y);
        if (qLines.length > 2) doc.text('…', 30, y + 10);

        let badgeText = '', badgeBg = PDF_COLORS.textLight, badgeFg = PDF_COLORS.white;
        if (entry.mode === 'simple' && entry.hemicycleData) {
            const hd = entry.hemicycleData;
            if (hd.pour > hd.contre) { badgeText = 'ADOPTÉ'; badgeBg = PDF_COLORS.success; }
            else { badgeText = 'REJETÉ'; badgeBg = PDF_COLORS.danger; }
        } else if (entry.results) {
            const elus = entry.results.winners.length;
            badgeText = elus > 0 ? `ÉLU${elus > 1 ? 'S' : ''} (${elus})` : 'AUCUN ÉLU';
            badgeBg = elus > 0 ? PDF_COLORS.success : PDF_COLORS.textLight;
        }
        pdfBadge(doc, badgeText, pageW - 20 - 24, y - 3.5, 24, 6, badgeBg, badgeFg);

        y += rowH + 2;
    });

    pdfFooter(doc, pageW, pageH, pageNum);
    pageNum++;

    // ===== Une page par scrutin =====
    for (let i = 0; i < historySnapshot.length; i++) {
        const entry = historySnapshot[i];
        const numero = entry.numero || getVoteNumero(entry);

        doc.addPage();

        try {
            if (entry.mode === 'simple' && entry.hemicycleData) {
                const captured = await captureHemicyclePage(entry.hemicycleData);
                if (captured) {
                    const imgW = pageW - 16;
                    const availableH = pageH - 16;
                    const ratio = Math.min(imgW / captured.width, availableH / captured.height);
                    const w = captured.width * ratio;
                    const h = captured.height * ratio;
                    const x = (pageW - w) / 2;
                    const yImg = (pageH - h) / 2;
                    doc.addImage(captured.dataUrl, 'JPEG', x, yImg, w, h);
                } else {
                    const hd = entry.hemicycleData;
                    pdfHeader(doc, pageW);
                    doc.setFontSize(14);
                    doc.setFont(undefined, 'bold');
                    pdfSetText(doc, PDF_COLORS.an);
                    doc.text(`Scrutin n°${numero}`, 20, 25);
                    doc.setFontSize(12);
                    doc.setFont(undefined, 'normal');
                    pdfSetText(doc, PDF_COLORS.text);
                    const qLines = doc.splitTextToSize(entry.question, pageW - 40);
                    doc.text(qLines, 20, 35);
                    let yy = 35 + qLines.length * 6 + 8;
                    doc.text(`Pour : ${hd.pour}`, 20, yy); yy += 7;
                    doc.text(`Contre : ${hd.contre}`, 20, yy); yy += 7;
                    doc.text(`Abstention : ${hd.abstention}`, 20, yy); yy += 7;
                    doc.setFont(undefined, 'bold');
                    doc.text(`Résultat : ${hd.pour > hd.contre ? 'ADOPTÉ' : 'REJETÉ'}`, 20, yy);
                }
                pdfFooter(doc, pageW, pageH, pageNum);
                pageNum++;
            } else if (entry.results) {
                pdfHeader(doc, pageW);
                const r = entry.results;

                doc.setFontSize(16);
                doc.setFont(undefined, 'bold');
                pdfSetText(doc, PDF_COLORS.an);
                doc.text(`Scrutin n°${numero}`, 14, 22);

                doc.setFontSize(11);
                doc.setFont(undefined, 'normal');
                pdfSetText(doc, PDF_COLORS.text);
                const qLines = doc.splitTextToSize(entry.question, pageW - 28);
                doc.text(qLines, 14, 30);
                let y2 = 30 + qLines.length * 5 + 6;

                pdfSetFill(doc, PDF_COLORS.anLight);
                doc.roundedRect(14, y2, pageW - 28, 18, 2, 2, 'F');
                doc.setFontSize(9);
                doc.setFont(undefined, 'bold');
                pdfSetText(doc, PDF_COLORS.an);
                doc.text('Suffrages exprimés', 20, y2 + 7);
                doc.text('Majorité absolue', pageW / 2 - 10, y2 + 7);
                doc.text('Votants', pageW - 50, y2 + 7);
                doc.setFontSize(13);
                pdfSetText(doc, PDF_COLORS.text);
                doc.text(String(r.totalExpressed), 20, y2 + 14);
                doc.text(String(r.absoluteMajority), pageW / 2 - 10, y2 + 14);
                doc.text(String(r.totalVoters), pageW - 50, y2 + 14);

                y2 += 26;

                doc.setFontSize(12);
                doc.setFont(undefined, 'bold');
                pdfSetText(doc, PDF_COLORS.an);
                doc.text('Résultats par proposition', 14, y2);
                y2 += 3;
                pdfSetDraw(doc, PDF_COLORS.border);
                doc.setLineWidth(0.3);
                doc.line(14, y2, pageW - 14, y2);
                y2 += 7;

                r.sorted.forEach(item => {
                    if (y2 > pageH - 30) {
                        pdfFooter(doc, pageW, pageH, pageNum); pageNum++;
                        doc.addPage();
                        pdfHeader(doc, pageW);
                        y2 = 22;
                    }
                    const isWinner = r.winners.some(w => w.name === item.name);

                    doc.setFontSize(10);
                    doc.setFont(undefined, isWinner ? 'bold' : 'normal');
                    pdfSetText(doc, isWinner ? PDF_COLORS.an : PDF_COLORS.text);
                    doc.text(escapeHtml(item.name), 16, y2);

                    doc.setFont(undefined, 'normal');
                    pdfSetText(doc, PDF_COLORS.textLight);
                    doc.setFontSize(9);
                    doc.text(`${item.count} voix — ${item.percentage.toFixed(1)}%`, pageW - 16, y2, { align: 'right' });

                    if (isWinner) {
                        pdfBadge(doc, 'ÉLU', pageW - 40, y2 + 2, 12, 5, PDF_COLORS.success, PDF_COLORS.white);
                    }

                    y2 += 3;
                    pdfBar(doc, 16, y2, pageW - 32, 4, item.percentage,
                        PDF_COLORS.border,
                        isWinner ? PDF_COLORS.success : PDF_COLORS.pour);
                    y2 += 10;
                });

                pdfFooter(doc, pageW, pageH, pageNum);
                pageNum++;
            } else {
                // Aucune donnée exploitable : page de secours pour ne pas laisser une page blanche
                pdfHeader(doc, pageW);
                doc.setFontSize(14);
                doc.setFont(undefined, 'bold');
                pdfSetText(doc, PDF_COLORS.an);
                doc.text(`Scrutin n°${numero}`, 14, 22);
                pdfSetText(doc, PDF_COLORS.text);
                doc.setFontSize(10);
                doc.setFont(undefined, 'normal');
                doc.text('Données indisponibles pour ce scrutin.', 14, 32);
                pdfFooter(doc, pageW, pageH, pageNum);
                pageNum++;
            }
        } catch (e) {
            console.error(`Erreur export scrutin n°${numero}:`, e);
            // Ne jamais laisser une page blanche : on dessine au moins le titre
            pdfHeader(doc, pageW);
            doc.setFontSize(14);
            doc.setFont(undefined, 'bold');
            pdfSetText(doc, PDF_COLORS.an);
            doc.text(`Scrutin n°${numero}`, 14, 22);
            pdfSetText(doc, PDF_COLORS.text);
            doc.setFontSize(10);
            doc.setFont(undefined, 'normal');
            doc.text('Erreur lors de la génération de cette page.', 14, 32);
            pdfFooter(doc, pageW, pageH, pageNum);
            pageNum++;
        }
    }

    doc.save(`rapport_session_${displayCode}_${sessionStartTime.toISOString().slice(0, 10)}.pdf`);
}

function captureHemicyclePage(hemicycleData) {
    return new Promise((resolve) => {
        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1200px;height:1800px;border:0;visibility:hidden;';
        document.body.appendChild(iframe);

        let resolved = false;
        const finish = (result) => {
            if (resolved) return;
            resolved = true;
            try { iframe.remove(); } catch(e) {}
            resolve(result);
        };

        const timeout = setTimeout(() => {
            console.warn('Timeout capture hémicycle');
            finish(null);
        }, 12000);

        const onMessage = async (event) => {
            const msg = event.data;
            if (!msg || msg.type !== 'hemicycle_ready') return;
            window.removeEventListener('message', onMessage);

            try {
                iframe.contentWindow.postMessage({ type: 'hemicycle_data', data: hemicycleData }, '*');
            } catch (e) {
                clearTimeout(timeout);
                return finish(null);
            }

            await new Promise(r => setTimeout(r, 2500));

            try {
                const idoc = iframe.contentDocument || iframe.contentWindow.document;
                const pageContent = idoc.getElementById('pageContent');
                if (!pageContent) { clearTimeout(timeout); return finish(null); }

                let tries = 0;
                while (typeof iframe.contentWindow.html2canvas === 'undefined' && tries < 30) {
                    await new Promise(r => setTimeout(r, 200));
                    tries++;
                }
                if (typeof iframe.contentWindow.html2canvas === 'undefined') {
                    clearTimeout(timeout);
                    return finish(null);
                }

                const canvas = await iframe.contentWindow.html2canvas(pageContent, {
                    scale: 2,
                    useCORS: true,
                    backgroundColor: "#ffffff",
                    scrollY: 0,
                    scrollX: 0
                });

                clearTimeout(timeout);
                finish({
                    dataUrl: canvas.toDataURL('image/jpeg', 1.0),
                    width: canvas.width,
                    height: canvas.height
                });
            } catch (e) {
                console.warn('html2canvas iframe échec:', e);
                clearTimeout(timeout);
                finish(null);
            }
        };

        window.addEventListener('message', onMessage);
        iframe.src = HEMICYCLE_BASE;
    });
}

function copyLink() { const input = document.getElementById('session-link'); input.select(); document.execCommand('copy'); showToast('Lien copié !'); }
function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }
function showToast(message) { const toast = document.getElementById('toast'); toast.textContent = message; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 3000); }

window.onload = bootstrap;
window.onbeforeunload = () => { if (peer) try { peer.destroy(); } catch(e) {} };
