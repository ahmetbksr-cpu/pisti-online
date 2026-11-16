const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html'); 
});

let waitingPlayers = [];
let roomCounter = 0;
let activeRooms = {}; 
let ongoingGames = {}; 
let matchmakingTimer = null;

const TURN_TIME_LIMIT = 20000; // 20 saniye hamle süresi

// 52'lik deste oluşturma ve karıştırma
function getNewDeck() {
    let ids = [];
    for (let i = 0; i < 52; i++) ids.push('c' + i);
    for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    return ids;
}

// Kart ID'sinden Sembol/Değer bulma (Örn: c10 -> J)
function getCardDetails(id) {
    let num = parseInt(id.replace('c', ''), 10);
    let rIdx = num % 13;
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    return ranks[rIdx]; 
}

// ELO bazlı eşleştirme kontrolü (Fix 11: Zamanlayıcı sızıntısı ve sonsuz bekleme önlendi)
function tryMatchmaking() {
    clearTimeout(matchmakingTimer);
    waitingPlayers = waitingPlayers.filter(p => p.socket && p.socket.connected);
    if (waitingPlayers.length < 2) return;

    const now = Date.now();
    let matchedPair = null;

    for (let i = 0; i < waitingPlayers.length; i++) {
        for (let j = i + 1; j < waitingPlayers.length; j++) {
            const p1 = waitingPlayers[i];
            const p2 = waitingPlayers[j];
            const eloDiff = Math.abs(p1.elo - p2.elo);
            const waitTime = Math.max(now - p1.joinedAt, now - p2.joinedAt);

            // ELO farkı <= 300 ise veya oyunculardan biri 8 saniyeden fazla beklediyse eşleştir
            if (eloDiff <= 300 || waitTime >= 8000) {
                matchedPair = [i, j];
                break;
            }
        }
        if (matchedPair) break;
    }

    if (!matchedPair) {
        // Kuyrukta hala >= 2 kişi varsa 2 saniye sonra tekrar kontrol et
        matchmakingTimer = setTimeout(tryMatchmaking, 2000);
        return;
    }

    const p2 = waitingPlayers.splice(matchedPair[1], 1)[0];
    const p1 = waitingPlayers.splice(matchedPair[0], 1)[0];

    roomCounter++;
    const roomId = 'room_' + roomCounter;
    
    p1.socket.join(roomId); 
    p2.socket.join(roomId);

    activeRooms[roomId] = {
        players: [p1, p2], 
        accepted: [],
        timer: setTimeout(() => handleMatchTimeout(roomId), 15000)
    };
    io.to(roomId).emit('matchFound', { roomId: roomId });

    if (waitingPlayers.length >= 2) tryMatchmaking();
}

// Anti-Cheat (Fix 7): Yerdeki ilk 3 kapalı kart henüz kesilmediyse ID'lerini gizle
function getMaskedCenterPile(game) {
    return game.centerPile.map((cardId, idx) => {
        if (!game.firstCaptureDone && idx < 3 && game.initialHiddenIds.includes(cardId)) {
            return 'hidden_' + idx;
        }
        return cardId;
    });
}

// Oyun durumunu anlık olarak her iki oyuncuya aktarma
function sendGameUpdate(game, opts = {}) {
    if (!game || !game.p1 || !game.p2) return;
    const maskedCenter = getMaskedCenterPile(game);

    io.to(game.p1.id).emit('gameUpdate', {
        myHand: game.p1Hand, 
        opponentHandCount: game.p2Hand.length,
        opponentName: game.p2.username || 'Rakip',
        centerPile: maskedCenter, 
        turn: game.turn,
        turnDeadline: game.turnDeadline,
        myCaptured: game.p1Captured, 
        opponentCaptured: game.p2Captured,
        pScore: game.p1Score, 
        bScore: game.p2Score,
        deckCount: game.deck.length,
        myPistiPairs: game.p1Pisti, 
        opponentPistiPairs: game.p2Pisti,
        lastPlayedCardId: opts.lastPlayedCardId || null,
        playedByOpponent: opts.playedBySocketId === game.p2.id,
        isNewDeal: !!opts.isNewDeal
    });

    io.to(game.p2.id).emit('gameUpdate', {
        myHand: game.p2Hand, 
        opponentHandCount: game.p1Hand.length,
        opponentName: game.p1.username || 'Rakip',
        centerPile: maskedCenter, 
        turn: game.turn,
        turnDeadline: game.turnDeadline,
        myCaptured: game.p2Captured, 
        opponentCaptured: game.p1Captured,
        pScore: game.p2Score, 
        bScore: game.p1Score,
        deckCount: game.deck.length,
        myPistiPairs: game.p2Pisti, 
        opponentPistiPairs: game.p1Pisti,
        lastPlayedCardId: opts.lastPlayedCardId || null,
        playedByOpponent: opts.playedBySocketId === game.p1.id,
        isNewDeal: !!opts.isNewDeal
    });
}

// AFK / Hamle süresi sayacı başlatma (Fix 10)
function startTurnTimer(game, extraDelayMs = 0) {
    if (!game) return;
    clearTimeout(game.turnTimer);
    if (game.turn === 'none' || !ongoingGames[game.roomId]) {
        game.turnDeadline = null;
        return;
    }

    const totalWait = TURN_TIME_LIMIT + extraDelayMs;
    game.turnDeadline = Date.now() + totalWait;
    game.turnTimer = setTimeout(() => {
        if (!ongoingGames[game.roomId] || game.isProcessing || game.turn === 'none') return;
        let isP1 = (game.turn === game.p1.id);
        let hand = isP1 ? game.p1Hand : game.p2Hand;
        if (hand.length > 0) {
            let randomCard = hand[Math.floor(Math.random() * hand.length)];
            io.to(game.turn).emit('autoPlayedTimeout');
            executeCardPlay(game, game.turn, randomCard);
        }
    }, totalWait);
}

// Kart oynama ana fonksiyonu (Fix 3 & 9)
function executeCardPlay(game, playerSocketId, cardId) {
    if (!game || game.isProcessing || game.turn !== playerSocketId) return;

    let isP1 = (playerSocketId === game.p1.id);
    let hand = isP1 ? game.p1Hand : game.p2Hand;
    if (!hand.includes(cardId)) return;

    clearTimeout(game.turnTimer);
    game.isProcessing = true;
    game.turn = 'none';
    game.turnDeadline = null;

    hand.splice(hand.indexOf(cardId), 1);
    let topCardId = game.centerPile.length > 0 ? game.centerPile[game.centerPile.length - 1] : null;
    game.centerPile.push(cardId);

    let rank = getCardDetails(cardId);
    let topRank = topCardId ? getCardDetails(topCardId) : null;
    let isCapture = false;
    let isPisti = false;

    if (topRank && (rank === topRank || rank === 'J')) {
        isCapture = true;
        if (game.centerPile.length === 2 && rank === topRank) isPisti = true;
    }

    let nextTurn = isP1 ? game.p2.id : game.p1.id;
    const roomId = game.roomId;

    // Önce kartın ortaya düştüğünü göster
    sendGameUpdate(game, { lastPlayedCardId: cardId, playedBySocketId: playerSocketId });
    
    if (isPisti) {
        let pts = (rank === 'J') ? 20 : 10;
        io.to(roomId).emit('pistiEvent', { player: playerSocketId, pts: pts });
    }

    if (isCapture) {
        game.lastCapturer = playerSocketId;
        const wasFirstCapture = !game.firstCaptureDone;
        game.firstCaptureDone = true;

        setTimeout(() => {
            if (!ongoingGames[roomId]) return;
            let capPile = isP1 ? game.p1Captured : game.p2Captured;
            game.centerPile.forEach(id => capPile.push(id));
            game.centerPile = [];

            if (isPisti) {
                let pts = (rank === 'J') ? 20 : 10;
                if (isP1) { game.p1Score += pts; game.p1Pisti.push({ bottom: topCardId, top: cardId }); } 
                else { game.p2Score += pts; game.p2Pisti.push({ bottom: topCardId, top: cardId }); }
            }

            // İlk kesmeyi yapan oyuncuya yerdeki 3 kapalı kartı özel olarak gönder (Fix 6)
            if (wasFirstCapture) {
                io.to(playerSocketId).emit('revealInitialCards', game.initialHiddenIds);
            }

            game.turn = nextTurn;
            game.isProcessing = false;
            checkDealHands(game, roomId);
        }, 1200); 
    } else {
        setTimeout(() => { 
            if (!ongoingGames[roomId]) return;
            game.turn = nextTurn;
            game.isProcessing = false;
            checkDealHands(game, roomId); 
        }, 500);
    }
}

function checkDealHands(game, roomId) {
    if (!game || !ongoingGames[roomId]) return;
    if (game.p1Hand.length === 0 && game.p2Hand.length === 0) {
        if (game.deck.length > 0) {
            for (let i = 0; i < 4; i++) if (game.deck.length > 0) game.p1Hand.push(game.deck.pop());
            for (let i = 0; i < 4; i++) if (game.deck.length > 0) game.p2Hand.push(game.deck.pop());
            // Yeni el dağıtım animasyonu için 800ms ekstra süre tanı
            startTurnTimer(game, 800);
            sendGameUpdate(game, { isNewDeal: true });
        } else {
            clearTimeout(game.turnTimer);
            game.turn = 'none';
            game.turnDeadline = null;
            if (game.centerPile.length > 0 && game.lastCapturer) {
                let capPile = (game.lastCapturer === game.p1.id) ? game.p1Captured : game.p2Captured;
                game.centerPile.forEach(id => capPile.push(id));
                game.centerPile = [];
            }
            sendGameUpdate(game);
            setTimeout(() => {
                if (ongoingGames[roomId]) {
                    if (game.p1 && game.p1.socket) game.p1.socket.gameRoomId = null;
                    if (game.p2 && game.p2.socket) game.p2.socket.gameRoomId = null;
                    io.to(roomId).emit('gameOver');
                    delete ongoingGames[roomId];
                }
            }, 1000);
        }
    } else {
        startTurnTimer(game);
        sendGameUpdate(game);
    }
}

function handleMatchTimeout(roomId, declinedPlayerId = null) {
    const room = activeRooms[roomId];
    if (!room) return;
    clearTimeout(room.timer);

    const p1 = room.players[0]; 
    const p2 = room.players[1];
    let p1Accepted = room.accepted.includes(p1.id); 
    let p2Accepted = room.accepted.includes(p2.id);

    if (declinedPlayerId === p1.id) p1Accepted = false;
    if (declinedPlayerId === p2.id) p2Accepted = false;

    p1.socket.leave(roomId); 
    p2.socket.leave(roomId); 
    delete activeRooms[roomId];

    if (p1Accepted && !p2Accepted) { 
        p2.socket.emit('matchFailed', { reason: 'timeout' }); 
        p1.socket.emit('matchFailed', { reason: 'opponent_timeout' }); 
        if (p1.socket.connected) { p1.joinedAt = Date.now(); waitingPlayers.unshift(p1); }
    } 
    else if (!p1Accepted && p2Accepted) { 
        p1.socket.emit('matchFailed', { reason: 'timeout' }); 
        p2.socket.emit('matchFailed', { reason: 'opponent_timeout' }); 
        if (p2.socket.connected) { p2.joinedAt = Date.now(); waitingPlayers.unshift(p2); }
    } 
    else { 
        p1.socket.emit('matchFailed', { reason: 'timeout' }); 
        p2.socket.emit('matchFailed', { reason: 'timeout' }); 
    }

    tryMatchmaking();
}

io.on('connection', (socket) => {
    console.log('🟢 Yeni oyuncu bağlandı:', socket.id);

    socket.on('findMatch', (data) => {
        if (waitingPlayers.find(p => p.id === socket.id)) return;
        waitingPlayers.push({ 
            id: socket.id, 
            elo: (data && typeof data.elo === 'number') ? data.elo : 0, 
            username: (data && data.username) ? String(data.username).slice(0, 16) : 'Oyuncu',
            joinedAt: Date.now(),
            socket: socket 
        });
        tryMatchmaking();
    });

    socket.on('acceptMatch', (roomId) => {
        const room = activeRooms[roomId];
        if (!room) return;
        if (!room.accepted.includes(socket.id)) room.accepted.push(socket.id);

        if (room.accepted.length === 2) {
            clearTimeout(room.timer);
            
            let deck = getNewDeck();
            let c1 = deck.pop(), c2 = deck.pop(), c3 = deck.pop(), c4 = deck.pop();
            
            // Kural Fix 5: Yere açılan 4. kart (en üstteki açık kart) Vale (J) olamaz!
            while (getCardDetails(c4) === 'J') {
                deck.unshift(c4);
                c4 = deck.pop();
            }

            let center = [c1, c2, c3, c4];
            let p1H = [deck.pop(), deck.pop(), deck.pop(), deck.pop()];
            let p2H = [deck.pop(), deck.pop(), deck.pop(), deck.pop()];

            ongoingGames[roomId] = {
                roomId: roomId,
                p1: room.players[0], p2: room.players[1],
                deck: deck, centerPile: center,
                initialHiddenIds: [c1, c2, c3],
                firstCaptureDone: false,
                p1Hand: p1H, p2Hand: p2H,
                p1Captured: [], p2Captured: [],
                p1Score: 0, p2Score: 0,
                p1Pisti: [], p2Pisti: [],
                turn: room.players[0].id,
                turnTimer: null,
                turnDeadline: null,
                lastCapturer: null,
                isProcessing: false
            };

            room.players[0].socket.gameRoomId = roomId;
            room.players[1].socket.gameRoomId = roomId;
            delete activeRooms[roomId];

            io.to(roomId).emit('matchStarted', {
                p1Name: room.players[0].username,
                p2Name: room.players[1].username
            });

            setTimeout(() => {
                const game = ongoingGames[roomId];
                if (game) {
                    startTurnTimer(game, 800);
                    sendGameUpdate(game, { isNewDeal: true });
                }
            }, 600);
        }
    });

    socket.on('playCard', (cardId) => {
        const roomId = socket.gameRoomId;
        const game = ongoingGames[roomId];
        if (!game) return;
        executeCardPlay(game, socket.id, cardId);
    });

    socket.on('declineMatch', (roomId) => { handleMatchTimeout(roomId, socket.id); });
    socket.on('cancelMatch', () => { waitingPlayers = waitingPlayers.filter(p => p.id !== socket.id); });

    socket.on('disconnect', () => {
        waitingPlayers = waitingPlayers.filter(p => p.id !== socket.id);
        for (const roomId of Object.keys(activeRooms)) {
            if (activeRooms[roomId] && activeRooms[roomId].players.find(p => p.id === socket.id)) {
                handleMatchTimeout(roomId, socket.id);
            }
        }
        if (socket.gameRoomId && ongoingGames[socket.gameRoomId]) {
            const game = ongoingGames[socket.gameRoomId];
            clearTimeout(game.turnTimer);
            socket.to(socket.gameRoomId).emit('opponentDisconnected');
            if (game.p1 && game.p1.socket) game.p1.socket.gameRoomId = null;
            if (game.p2 && game.p2.socket) game.p2.socket.gameRoomId = null;
            delete ongoingGames[socket.gameRoomId];
        }
    });
});

http.listen(3000, () => {
    console.log('🔥 PRO SUNUCU YAYINDA! Tarayıcıda http://localhost:3000 adresini açın.');
});