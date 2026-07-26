'use strict';

const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { RoomManager } = require('./src/game/roomManager');
const engine = require('./src/game/gameEngine');
const { getHostState, getPlayerState, submission } = require('./src/game/serializers');
const { getLanAddress } = require('./src/utils/network');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const roomManager = new RoomManager();
const app = express();
const server = http.createServer(app);
const io = new Server(server, { serveClient: true, pingTimeout: 20000 });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/host', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/player', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));
app.get('/rules', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'rules.html')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: roomManager.rooms.size }));

async function makeQr(url) {
  try {
    return await QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: '#111827', light: '#f8fafc' } });
  } catch {
    return '';
  }
}

function emitRoom(room, phaseChanged = false) {
  io.to(`room:${room.roomCode}`).emit('room:updated', {
    roomCode: room.roomCode,
    phase: room.phase,
    day: room.day,
    order: room.prison.order
  });
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.hostRoomCode === room.roomCode) {
      socket.emit('host:state', getHostState(room, Boolean(socket.data.debug)));
    }
  }
  Object.values(room.players).forEach((player) => {
    if (player.socketId && io.sockets.sockets.has(player.socketId)) {
      io.to(player.socketId).emit('player:state', getPlayerState(room, player.id));
    }
  });
  if (phaseChanged) {
    io.to(`room:${room.roomCode}`).emit('game:phaseChanged', {
      phase: room.phase,
      day: room.day
    });
  }
  if (submission(room).allSubmitted) {
    io.to(`room:${room.roomCode}`).emit('game:allSubmitted', {
      phase: room.phase,
      message: '全員回答済み'
    });
  }
}

function stopTimer(room) {
  if (room.timer.interval) clearInterval(room.timer.interval);
  room.timer.interval = null;
  room.timer.running = false;
}

function startTimer(room) {
  if (room.timer.running) return;
  room.timer.running = true;
  room.timer.interval = setInterval(() => {
    room.timer.remaining = Math.max(0, room.timer.remaining - 1);
    io.to(`room:${room.roomCode}`).emit('game:timer', {
      remaining: room.timer.remaining,
      running: room.timer.running
    });
    if (room.timer.remaining === 0) {
      stopTimer(room);
      engine.fillDefaults(room);
      emitRoom(room);
    }
  }, 1000);
}

function resetTimer(room, seconds = 90) {
  stopTimer(room);
  const duration = Math.max(10, Math.min(600, Number(seconds) || 90));
  room.timer.duration = duration;
  room.timer.remaining = duration;
}

function boundHostRoom(socket) {
  const room = roomManager.get(socket.data.hostRoomCode);
  if (!room || room.hostToken !== socket.data.hostToken) throw new Error('ホスト認証が無効です');
  return room;
}

function boundPlayer(socket) {
  const room = roomManager.get(socket.data.roomCode);
  const player = room?.players[socket.data.playerId];
  if (!room || !player || player.sessionToken !== socket.data.sessionToken) {
    throw new Error('プレイヤー認証が無効です');
  }
  return { room, player };
}

function respond(socket, callback, work, emitAfter = true) {
  Promise.resolve()
    .then(work)
    .then((result) => {
      if (emitAfter && result?.room) emitRoom(result.room, result.phaseChanged);
      if (typeof callback === 'function') callback({ ok: true, ...result?.response });
    })
    .catch((error) => {
      socket.emit('game:error', { message: error.message });
      if (typeof callback === 'function') callback({ ok: false, error: error.message });
    });
}

io.on('connection', (socket) => {
  socket.on('host:createRoom', (payload = {}, callback) => {
    respond(socket, callback, async () => {
      const room = roomManager.createRoom();
      const base = `http://${getLanAddress()}:${PORT}`;
      room.joinUrl = `${base}/?room=${room.roomCode}`;
      room.qrDataUrl = await makeQr(room.joinUrl);
      room.hostSocketId = socket.id;
      socket.data.hostRoomCode = room.roomCode;
      socket.data.hostToken = room.hostToken;
      socket.data.debug = Boolean(payload.debug);
      socket.join(`room:${room.roomCode}`);
      socket.emit('room:created', {
        roomCode: room.roomCode,
        hostToken: room.hostToken,
        joinUrl: room.joinUrl
      });
      return {
        room,
        response: {
          roomCode: room.roomCode,
          hostToken: room.hostToken,
          joinUrl: room.joinUrl
        }
      };
    });
  });

  socket.on('host:reconnect', (payload = {}, callback) => {
    respond(socket, callback, () => {
      const room = roomManager.get(payload.roomCode);
      if (!room || room.hostToken !== payload.hostToken) throw new Error('ホスト再接続情報が無効です');
      room.hostConnected = true;
      room.hostSocketId = socket.id;
      socket.data.hostRoomCode = room.roomCode;
      socket.data.hostToken = room.hostToken;
      socket.data.debug = Boolean(payload.debug);
      socket.join(`room:${room.roomCode}`);
      return { room, response: { roomCode: room.roomCode } };
    });
  });

  socket.on('host:updateJoinUrl', (payload = {}, callback) => {
    respond(socket, callback, async () => {
      const room = boundHostRoom(socket);
      const base = String(payload.baseUrl || '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\/[^ ]+$/i.test(base)) throw new Error('有効なURLを入力してください');
      room.joinUrl = `${base}/?room=${room.roomCode}`;
      room.qrDataUrl = await makeQr(room.joinUrl);
      return { room, response: { joinUrl: room.joinUrl } };
    });
  });

  socket.on('host:startGame', (_payload, callback) => {
    respond(socket, callback, () => {
      const room = boundHostRoom(socket);
      engine.startGame(room);
      return { room, phaseChanged: true };
    });
  });

  socket.on('host:addCpu', (_payload, callback) => {
    respond(socket, callback, () => {
      const room = boundHostRoom(socket);
      const { player } = roomManager.addCpu(room.roomCode);
      return {
        room,
        response: { playerId: player.id, playerName: player.name }
      };
    });
  });

  socket.on('host:removeCpu', (payload = {}, callback) => {
    respond(socket, callback, () => {
      const room = boundHostRoom(socket);
      const { player } = roomManager.removeCpu(room.roomCode, payload.playerId);
      return {
        room,
        response: { playerId: player.id, playerName: player.name }
      };
    });
  });

  socket.on('host:advancePhase', (_payload, callback) => {
    respond(socket, callback, () => {
      const room = boundHostRoom(socket);
      stopTimer(room);
      engine.advancePhase(room);
      if (room.phase === 'ESCAPE_ROUTE_SELECT') {
        io.to(`room:${room.roomCode}`).emit('game:publicEvent', { type: 'alarm' });
      }
      return { room, phaseChanged: true };
    });
  });

  socket.on('host:startTimer', (_payload, callback) => {
    respond(socket, callback, () => {
      const room = boundHostRoom(socket);
      startTimer(room);
      return { room };
    });
  });

  socket.on('host:pauseTimer', (_payload, callback) => {
    respond(socket, callback, () => {
      const room = boundHostRoom(socket);
      stopTimer(room);
      return { room };
    });
  });

  socket.on('host:resetTimer', (payload = {}, callback) => {
    respond(socket, callback, () => {
      const room = boundHostRoom(socket);
      resetTimer(room, payload.seconds);
      return { room };
    });
  });

  socket.on('host:restartGame', (_payload, callback) => {
    respond(socket, callback, () => {
      const room = boundHostRoom(socket);
      stopTimer(room);
      roomManager.resetForGame(room);
      return { room, phaseChanged: true };
    });
  });

  socket.on('host:refreshState', (_payload, callback) => {
    respond(socket, callback, () => ({ room: boundHostRoom(socket) }));
  });

  socket.on('debug:action', (payload = {}, callback) => {
    respond(socket, callback, () => {
      const room = boundHostRoom(socket);
      if (!socket.data.debug) throw new Error('デバッグモードではありません');
      engine.applyDebug(room, payload);
      return { room, phaseChanged: true };
    });
  });

  socket.on('player:joinRoom', (payload = {}, callback) => {
    respond(socket, callback, () => {
      const { room, player } = roomManager.join(payload.roomCode, payload.playerName, socket.id);
      socket.data.roomCode = room.roomCode;
      socket.data.playerId = player.id;
      socket.data.sessionToken = player.sessionToken;
      socket.join(`room:${room.roomCode}`);
      return {
        room,
        response: {
          roomCode: room.roomCode,
          playerId: player.id,
          sessionToken: player.sessionToken,
          playerName: player.name,
          number: player.number
        }
      };
    });
  });

  socket.on('player:reconnect', (payload = {}, callback) => {
    respond(socket, callback, () => {
      const { room, player } = roomManager.reconnect(
        payload.roomCode,
        payload.playerId,
        payload.sessionToken,
        socket.id
      );
      socket.data.roomCode = room.roomCode;
      socket.data.playerId = player.id;
      socket.data.sessionToken = player.sessionToken;
      socket.join(`room:${room.roomCode}`);
      return { room, response: { playerName: player.name, number: player.number } };
    });
  });

  socket.on('player:submitMinigame', (payload = {}, callback) => {
    respond(socket, callback, () => {
      const { room, player } = boundPlayer(socket);
      engine.submitMinigame(room, player, payload.value);
      return { room };
    });
  });

  socket.on('player:submitSecondMinigame', (payload = {}, callback) => {
    respond(socket, callback, () => {
      const { room, player } = boundPlayer(socket);
      engine.submitSecondMinigame(room, player, payload.value);
      return { room };
    });
  });

  socket.on('player:submitNightAction', (payload = {}, callback) => {
    respond(socket, callback, () => {
      const { room, player } = boundPlayer(socket);
      engine.submitNightAction(room, player, payload);
      return { room };
    });
  });

  socket.on('player:useCard', (payload = {}, callback) => {
    respond(socket, callback, () => {
      const { room, player } = boundPlayer(socket);
      engine.useCard(room, player, payload.cardId, payload);
      return { room };
    });
  });

  socket.on('player:discardCard', (payload = {}, callback) => {
    respond(socket, callback, () => {
      const { room, player } = boundPlayer(socket);
      engine.discardOverflow(room, player, payload.cardId);
      return { room };
    });
  });

  socket.on('player:submitEscapeChoice', (payload = {}, callback) => {
    respond(socket, callback, () => {
      const { room, player } = boundPlayer(socket);
      engine.submitEscapeChoice(room, player, payload.choice);
      return { room };
    });
  });

  socket.on('player:submitFinalEscape', (payload = {}, callback) => {
    respond(socket, callback, () => {
      const { room, player } = boundPlayer(socket);
      engine.submitFinalEscape(room, player, payload);
      return { room };
    });
  });

  socket.on('player:submitFinalDefense', (payload = {}, callback) => {
    respond(socket, callback, () => {
      const { room, player } = boundPlayer(socket);
      engine.submitFinalDefense(room, player, payload.choice);
      return { room };
    });
  });

  socket.on('disconnect', () => {
    const result = roomManager.markDisconnected(socket.id);
    if (result?.room) emitRoom(result.room);
  });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const lan = getLanAddress();
    console.log(`PRISON LAB is running.`);
    console.log(`Host:   http://localhost:${PORT}/host`);
    console.log(`Player: http://${lan}:${PORT}/`);
  });
}

module.exports = { app, server, io, roomManager, emitRoom };
