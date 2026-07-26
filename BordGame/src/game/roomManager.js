'use strict';

const { randomUUID } = require('node:crypto');
const { createRoomCode } = require('../utils/roomCode');
const { createDeck, drawCard } = require('./cards');

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  createRoom({ joinUrl = '', qrDataUrl = '' } = {}) {
    const roomCode = createRoomCode(new Set(this.rooms.keys()));
    const room = {
      roomCode,
      hostToken: randomUUID(),
      hostConnected: true,
      phase: 'LOBBY',
      day: 0,
      createdAt: Date.now(),
      prison: { order: 70 },
      players: {},
      cardDeck: createDeck(),
      discardPile: [],
      minigame: {
        type: null,
        status: null,
        pairings: [],
        roles: {},
        hats: {},
        publicResult: null
      },
      nightEvents: [],
      publicLog: [],
      evaluationRanking: [],
      escapeOfferCandidates: [],
      escapePlannerId: null,
      finalResult: null,
      joinUrl,
      qrDataUrl,
      timer: { duration: 90, remaining: 90, running: false, interval: null }
    };
    this.rooms.set(roomCode, room);
    return room;
  }

  get(code) {
    return this.rooms.get(String(code || '').trim().toUpperCase()) || null;
  }

  join(code, requestedName, socketId) {
    const room = this.get(code);
    if (!room) throw new Error('存在しないルームコードです');
    if (room.phase !== 'LOBBY') throw new Error('ゲーム開始後は新規参加できません');
    if (Object.keys(room.players).length >= 4) throw new Error('この実験室は満員です');

    const baseName = String(requestedName || '').trim().slice(0, 20);
    if (!baseName) throw new Error('プレイヤー名を入力してください');
    const existing = new Set(Object.values(room.players).map((player) => player.name));
    let name = baseName;
    let suffix = 2;
    while (existing.has(name)) {
      name = `${baseName}${suffix}`;
      suffix += 1;
    }

    const player = {
      id: randomUUID(),
      sessionToken: randomUUID(),
      socketId,
      isCpu: false,
      number: Object.keys(room.players).length + 1,
      name,
      connected: true,
      connectionStatus: '接続中',
      disconnectedAt: null,
      evaluation: 50,
      stress: 2,
      suspicion: 0,
      cards: [],
      temporaryEffects: { evaluationShield: 0, nextMinigamePreview: null },
      cardUsedDay: 0,
      nightAction: null,
      minigameInput: null,
      minigameSecondInput: null,
      escapeOffered: false,
      escapeOfferPending: false,
      escapeChoice: null,
      finalEscapeDecision: null,
      isEscapePlanner: false,
      escapeProgress: { route: false, tool: false, timing: false, reinforcement: 0 },
      finalEscapeRoute: null,
      finalEscapeCardUsed: false,
      finalDefenseChoice: null,
      privateMessages: [],
      observationResults: []
    };
    room.players[player.id] = player;
    return { room, player };
  }

  addCpu(code) {
    const room = this.get(code);
    if (!room) throw new Error('存在しないルームコードです');
    if (room.phase !== 'LOBBY') throw new Error('CPUはゲーム開始前のみ追加できます');
    if (Object.keys(room.players).length >= 4) throw new Error('この実験室は満員です');
    const cpuCount = Object.values(room.players).filter((player) => player.isCpu).length;
    if (cpuCount >= 3) throw new Error('CPUは3人まで追加できます');

    const player = {
      id: randomUUID(),
      sessionToken: null,
      socketId: null,
      isCpu: true,
      number: Object.keys(room.players).length + 1,
      name: `CPU-${String(cpuCount + 1).padStart(2, '0')}`,
      connected: true,
      connectionStatus: 'CPU稼働中',
      disconnectedAt: null,
      evaluation: 50,
      stress: 2,
      suspicion: 0,
      cards: [],
      temporaryEffects: { evaluationShield: 0, nextMinigamePreview: null },
      cardUsedDay: 0,
      nightAction: null,
      minigameInput: null,
      minigameSecondInput: null,
      escapeOffered: false,
      escapeOfferPending: false,
      escapeChoice: null,
      finalEscapeDecision: null,
      isEscapePlanner: false,
      escapeProgress: { route: false, tool: false, timing: false, reinforcement: 0 },
      finalEscapeRoute: null,
      finalEscapeCardUsed: false,
      finalDefenseChoice: null,
      privateMessages: [],
      observationResults: []
    };
    room.players[player.id] = player;
    return { room, player };
  }

  removeCpu(code, playerId = null) {
    const room = this.get(code);
    if (!room) throw new Error('存在しないルームコードです');
    if (room.phase !== 'LOBBY') throw new Error('CPUはゲーム開始前のみ削除できます');
    const cpus = Object.values(room.players)
      .filter((player) => player.isCpu)
      .sort((a, b) => b.number - a.number);
    const target = playerId ? cpus.find((player) => player.id === playerId) : cpus[0];
    if (!target) throw new Error('削除できるCPUがいません');
    delete room.players[target.id];
    Object.values(room.players)
      .sort((a, b) => a.number - b.number)
      .forEach((player, index) => { player.number = index + 1; });
    return { room, player: target };
  }

  reconnect(code, playerId, sessionToken, socketId) {
    const room = this.get(code);
    const player = room?.players[playerId];
    if (!room || !player || player.sessionToken !== sessionToken) {
      throw new Error('再接続情報が無効です');
    }
    player.socketId = socketId;
    player.connected = true;
    player.connectionStatus = player.disconnectedAt ? '再接続済み' : '接続中';
    player.disconnectedAt = null;
    return { room, player };
  }

  markDisconnected(socketId) {
    for (const room of this.rooms.values()) {
      if (room.hostSocketId === socketId) {
        room.hostConnected = false;
        room.hostDisconnectedAt = Date.now();
      }
      const player = Object.values(room.players).find((item) => item.socketId === socketId);
      if (player) {
        player.connected = false;
        player.connectionStatus = '一時切断';
        player.disconnectedAt = Date.now();
        return { room, player };
      }
    }
    return null;
  }

  resetForGame(room) {
    room.phase = 'LOBBY';
    room.day = 0;
    room.prison.order = 70;
    room.cardDeck = createDeck();
    room.discardPile = [];
    room.nightEvents = [];
    room.publicLog = [];
    room.evaluationRanking = [];
    room.escapeOfferCandidates = [];
    room.escapePlannerId = null;
    room.finalResult = null;
    room.minigame = { type: null, status: null, pairings: [], roles: {}, hats: {}, publicResult: null };
    Object.values(room.players).forEach((player) => {
      Object.assign(player, {
        evaluation: 50,
        stress: 2,
        suspicion: 0,
        cards: [],
        temporaryEffects: { evaluationShield: 0, nextMinigamePreview: null },
        cardUsedDay: 0,
        nightAction: null,
        minigameInput: null,
        minigameSecondInput: null,
        escapeOffered: false,
        escapeOfferPending: false,
        escapeChoice: null,
        finalEscapeDecision: null,
        isEscapePlanner: false,
        escapeProgress: { route: false, tool: false, timing: false, reinforcement: 0 },
        finalEscapeRoute: null,
        finalEscapeCardUsed: false,
        finalDefenseChoice: null,
        privateMessages: [],
        observationResults: []
      });
    });
  }

  dealInitialCards(room) {
    Object.values(room.players).forEach((player) => {
      drawCard(room, player);
      drawCard(room, player);
    });
  }
}

module.exports = { RoomManager };
