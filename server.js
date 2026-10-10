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

function getNewDeck() {
    let ids = [];
    for (let i = 0; i < 52; i++) ids.push('c' + i);
    for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    return ids;
}

function getCardDetails(id) {
    let num = parseInt(id.replace('c', ''));
    let rIdx = num % 13;
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    return ranks[rIdx]; 
}

function sendGameUpdate(game) {
    if(!game || !game.p1 || !game.p2) return;
    io.to(game.p1.id).emit('gameUpdate', {
        myHand: game.p1Hand, opponentHandCount: game.p2Hand.length,
        centerPile: game.centerPile, turn: game.turn,
        myCaptured: game.p1Captured, opponentCaptured: game.p2Captured,
        pScore: game.p1Score, bScore: game.p2Score,
        deckCount: game.deck.length,
        myPistiPairs: game.p1Pisti, opponentPistiPairs: game.p2Pisti
    });
    io.to(game.p2.id).emit('gameUpdate', {
        myHand: game.p2Hand, opponentHandCount: game.p1Hand.length,
        centerPile: game.centerPile, turn: game.turn,
        myCaptured: game.p2Captured, opponentCaptured: game.p1Captured,
        pScore: game.p2Score, bScore: game.p1Score,
        deckCount: game.deck.length,
        myPistiPairs: game.p2Pisti, opponentPistiPairs: game.p1Pisti
    });
}

io.on('connection', (socket) => {
    console.log('🟢 Yeni oyuncu bağlandı:', socket.id);

    socket.on('findMatch', (data) => {
        if (waitingPlayers.find(p => p.id === socket.id)) return;
        waitingPlayers.push({ id: socket.id, elo: data.elo, username: data.username, socket: socket });

        if (waitingPlayers.length >= 2) {
            const p1 = waitingPlayers.shift();
            const p2 = waitingPlayers.shift();
            roomCounter++;
            const roomId = 'room_' + roomCounter;
            p1.socket.join(roomId); p2.socket.join(roomId);

            activeRooms[roomId] = {
                players: [p1, p2], accepted: [],
                timer: setTimeout(() => handleMatchTimeout(roomId), 15000)
            };
            io.to(roomId).emit('matchFound', { roomId: roomId });
        }
    });

    socket.on('acceptMatch', (roomId) => {
        const room = activeRooms[roomId];
        if (!room) return;
        if (!room.accepted.includes(socket.id)) room.accepted.push(socket.id);

        if (room.accepted.length === 2) {
            clearTimeout(room.timer);
            
            let deck = getNewDeck();
            let center = [deck.pop(), deck.pop(), deck.pop(), deck.pop()];
            let p1H = [deck.pop(), deck.pop(), deck.pop(), deck.pop()];
            let p2H = [deck.pop(), deck.pop(), deck.pop(), deck.pop()];

            ongoingGames[roomId] = {
                roomId: roomId,
                p1: room.players[0], p2: room.players[1],
                deck: deck, centerPile: center,
                initialHiddenIds: [center[0], center[1], center[2]], // YENİ: İlk 3 kartı sakla
                isFirstCapture: true, // YENİ: İlk alımı takip et
                p1Hand: p1H, p2Hand: p2H,
                p1Captured: [], p2Captured: [],
                p1Score: 0, p2Score: 0,
                p1Pisti: [], p2Pisti: [],
                turn: room.players[0].id,
                lastCapturer: null
            };

            room.players[0].socket.gameRoomId = roomId;
            room.players[1].socket.gameRoomId = roomId;
            delete activeRooms[roomId];

            // Rakip isimlerini göndererek maçı başlat
            room.players[0].socket.emit('matchStarted', { opponentName: room.players[1].username });
            room.players[1].socket.emit('matchStarted', { opponentName: room.players[0].username });

            setTimeout(() => sendGameUpdate(ongoingGames[roomId]), 1000);
        }
    });

    socket.on('playCard', (cardId) => {
        const roomId = socket.gameRoomId;
        const game = ongoingGames[roomId];
        if (!game || game.turn !== socket.id) return; 

        let isP1 = (socket.id === game.p1.id);
        let hand = isP1 ? game.p1Hand : game.p2Hand;
        if (!hand.includes(cardId)) return; 

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

        game.turn = isP1 ? game.p2.id : game.p1.id;
        sendGameUpdate(game);
        
        if (isPisti) io.to(roomId).emit('pistiEvent', { player: socket.id });

        if (isCapture) {
            game.lastCapturer = socket.id;

            // YENİ: Eğer ilk alım gerçekleştiyse sadece alan kişiye kartları gönder
            if (game.isFirstCapture) {
                game.isFirstCapture = false;
                io.to(socket.id).emit('revealFirstCards', game.initialHiddenIds);
            }

            setTimeout(() => {
                let capPile = isP1 ? game.p1Captured : game.p2Captured;
                game.centerPile.forEach(id => capPile.push(id));
                game.centerPile = [];

                if (isPisti) {
                    let pts = (rank === 'J') ? 20 : 10;
                    if (isP1) { game.p1Score += pts; game.p1Pisti.push({ bottom: topCardId, top: cardId }); } 
                    else { game.p2Score += pts; game.p2Pisti.push({ bottom: topCardId, top: cardId }); }
                }
                checkDealHands(game, roomId);
            }, 1200); 
        } else {
            setTimeout(() => { checkDealHands(game, roomId); }, 500);
        }
    });

    function checkDealHands(game, roomId) {
        if(!game) return;
        if (game.p1Hand.length === 0 && game.p2Hand.length === 0) {
            if (game.deck.length > 0) {
                for(let i=0; i<4; i++) game.p1Hand.push(game.deck.pop());
                for(let i=0; i<4; i++) game.p2Hand.push(game.deck.pop());
                sendGameUpdate(game);
            } else {
                if (game.centerPile.length > 0 && game.lastCapturer) {
                    let capPile = (game.lastCapturer === game.p1.id) ? game.p1Captured : game.p2Captured;
                    game.centerPile.forEach(id => capPile.push(id));
                    game.centerPile = [];
                }
                sendGameUpdate(game);
                setTimeout(() => {
                    io.to(roomId).emit('gameOver');
                    delete ongoingGames[roomId];
                }, 1000);
            }
        } else {
            sendGameUpdate(game);
        }
    }

    socket.on('declineMatch', (roomId) => { handleMatchTimeout(roomId, socket.id); });
    socket.on('cancelMatch', () => { waitingPlayers = waitingPlayers.filter(p => p.id !== socket.id); });

    socket.on('disconnect', () => {
        waitingPlayers = waitingPlayers.filter(p => p.id !== socket.id);
        for (const roomId in activeRooms) {
            if (activeRooms[roomId].players.find(p => p.id === socket.id)) handleMatchTimeout(roomId, socket.id);
        }
        if (socket.gameRoomId && ongoingGames[socket.gameRoomId]) {
            socket.to(socket.gameRoomId).emit('opponentDisconnected');
            delete ongoingGames[socket.gameRoomId];
        }
    });

    function handleMatchTimeout(roomId, declinedPlayerId = null) {
        const room = activeRooms[roomId];
        if (!room) return;
        clearTimeout(room.timer);

        const p1 = room.players[0]; const p2 = room.players[1];
        let p1Accepted = room.accepted.includes(p1.id); let p2Accepted = room.accepted.includes(p2.id);

        if (declinedPlayerId === p1.id) p1Accepted = false;
        if (declinedPlayerId === p2.id) p2Accepted = false;

        if (p1Accepted && !p2Accepted) { p2.socket.emit('matchFailed', { reason: 'timeout' }); p1.socket.emit('matchFailed', { reason: 'opponent_timeout' }); waitingPlayers.unshift(p1); } 
        else if (!p1Accepted && p2Accepted) { p1.socket.emit('matchFailed', { reason: 'timeout' }); p2.socket.emit('matchFailed', { reason: 'opponent_timeout' }); waitingPlayers.unshift(p2); } 
        else { p1.socket.emit('matchFailed', { reason: 'timeout' }); p2.socket.emit('matchFailed', { reason: 'timeout' }); }

        p1.socket.leave(roomId); p2.socket.leave(roomId); delete activeRooms[roomId];
    }
});

http.listen(3000, () => {
    console.log('🔥 PRO SUNUCU YAYINDA! Tarayıcıda http://localhost:3000 adresini açın.');
});