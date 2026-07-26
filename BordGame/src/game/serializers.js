'use strict';

const {
  PHASE_LABELS,
  MINIGAMES,
  BRIEFINGS,
  evaluationBand,
  stressBand,
  suspicionBand
} = require('./constants');
const { CARD_TYPES, publicCard } = require('./cards');
const { ROUTES, DEFENSES } = require('./escape');

function rankPlayers(room, adjusted = false, excludeIds = []) {
  return Object.values(room.players)
    .filter((player) => !excludeIds.includes(player.id))
    .map((player) => ({
      id: player.id,
      number: player.number,
      name: player.name,
      evaluation: player.evaluation,
      adjustedEvaluation: adjusted
        ? Math.max(0, player.evaluation - (player.suspicion >= 8 ? 15 : 0))
        : player.evaluation,
      correction: adjusted && player.suspicion >= 8 ? -15 : 0,
      suspicion: player.suspicion,
      stress: player.stress,
      tieBreaker: player.tieBreaker || 0
    }))
    .sort((a, b) => (
      b.adjustedEvaluation - a.adjustedEvaluation
      || a.suspicion - b.suspicion
      || a.stress - b.stress
      || a.tieBreaker - b.tieBreaker
    ));
}

function expectedIds(room) {
  const all = Object.keys(room.players);
  if (room.phase === 'MINIGAME_INPUT') {
    return room.day === 4
      ? all.filter((id) => room.minigame.roles[id] === 'sender')
      : all;
  }
  if (room.phase === 'MINIGAME_SECOND_INPUT') {
    return all.filter((id) => room.minigame.roles[id] === 'receiver');
  }
  if (room.phase === 'NIGHT_ACTION') return all;
  if (room.phase === 'ESCAPE_OFFER') return room.escapeOfferCandidates;
  if (['FINAL_JUDGMENT', 'ESCAPE_ROUTE_SELECT'].includes(room.phase)) {
    return room.escapePlannerId ? [room.escapePlannerId] : [];
  }
  if (room.phase === 'ESCAPE_DEFENSE') return all.filter((id) => id !== room.escapePlannerId);
  return [];
}

function isSubmitted(room, player) {
  if (room.phase === 'MINIGAME_INPUT') return player.minigameInput !== null;
  if (room.phase === 'MINIGAME_SECOND_INPUT') return player.minigameSecondInput !== null;
  if (room.phase === 'NIGHT_ACTION') return player.nightAction !== null;
  if (room.phase === 'ESCAPE_OFFER') return player.escapeChoice !== null;
  if (room.phase === 'FINAL_JUDGMENT') return player.finalEscapeDecision !== null;
  if (room.phase === 'ESCAPE_ROUTE_SELECT') return player.finalEscapeRoute !== null;
  if (room.phase === 'ESCAPE_DEFENSE') return player.finalDefenseChoice !== null;
  return false;
}

function submission(room) {
  const ids = expectedIds(room);
  const submittedIds = ids.filter((id) => isSubmitted(room, room.players[id]));
  return {
    expected: ids.length,
    submitted: submittedIds.length,
    allSubmitted: ids.length > 0 && ids.length === submittedIds.length,
    players: Object.values(room.players).map((player) => ({
      id: player.id,
      number: player.number,
      name: player.name,
      isCpu: Boolean(player.isCpu),
      required: ids.includes(player.id),
      submitted: submittedIds.includes(player.id)
    }))
  };
}

function baseState(room) {
  return {
    roomCode: room.roomCode,
    phase: room.phase,
    phaseLabel: PHASE_LABELS[room.phase],
    day: room.day,
    maxDays: 4,
    order: room.prison.order,
    minigame: MINIGAMES[room.day] || null,
    briefing: BRIEFINGS[room.day] || '',
    timer: {
      duration: room.timer.duration,
      remaining: room.timer.remaining,
      running: room.timer.running
    },
    submission: submission(room)
  };
}

function publicRanking(room) {
  const ranked = rankPlayers(room);
  return ranked.map((item, index) => ({
    rank: index + 1,
    id: item.id,
    number: item.number,
    name: item.name,
    band: evaluationBand(item.evaluation)
  }));
}

function getPublicState(room) {
  return {
    ...baseState(room),
    players: Object.values(room.players).map((player) => ({
      id: player.id,
      number: player.number,
      name: player.name,
      isCpu: Boolean(player.isCpu),
      connected: player.connected,
      connectionStatus: player.connectionStatus
    })),
    ranking: publicRanking(room),
    minigameResult: room.phase === 'MINIGAME_RESULT' ? room.minigame.publicResult : null,
    nightEvents: ['NIGHT_RESULT', 'EVALUATION'].includes(room.phase) ? room.nightEvents : [],
    finalResult: room.finalResult
  };
}

function debugSnapshot(room) {
  return {
    escapePlannerId: room.escapePlannerId,
    players: Object.values(room.players).map((player) => ({
      id: player.id,
      number: player.number,
      name: player.name,
      isCpu: Boolean(player.isCpu),
      evaluation: player.evaluation,
      stress: player.stress,
      suspicion: player.suspicion,
      cards: player.cards.map((card) => CARD_TYPES[card.type].name),
      isEscapePlanner: player.isEscapePlanner,
      escapeProgress: { ...player.escapeProgress },
      minigameInput: player.minigameInput,
      minigameSecondInput: player.minigameSecondInput,
      nightAction: player.nightAction
    })),
    hats: { ...room.minigame.hats }
  };
}

function getHostState(room, debug = false) {
  return {
    ...getPublicState(room),
    hostConnected: room.hostConnected,
    joinUrl: room.joinUrl,
    qrDataUrl: room.qrDataUrl,
    canStart: room.phase === 'LOBBY' && Object.keys(room.players).length === 4,
    ...(debug ? { debug: debugSnapshot(room) } : {})
  };
}

function minigamePlayerView(room, player) {
  if (!MINIGAMES[room.day]) return null;
  const view = { ...MINIGAMES[room.day] };
  if (room.day === 1) {
    const pair = room.minigame.pairings.find((ids) => ids.includes(player.id));
    const otherId = pair?.find((id) => id !== player.id);
    view.partner = otherId ? {
      id: otherId,
      number: room.players[otherId].number,
      name: room.players[otherId].name
    } : null;
    view.options = [
      { value: 'cooperate', label: '協力' },
      { value: 'betray', label: '裏切り' }
    ];
  }
  if (room.day === 2) {
    view.options = [0, 1, 2, 3].map((value) => ({ value, label: `${value}個` }));
  }
  if (room.day === 3) {
    view.visibleHats = Object.values(room.players)
      .filter((other) => other.id !== player.id)
      .map((other) => ({
        id: other.id,
        number: other.number,
        name: other.name,
        color: room.minigame.hats[other.id]
      }));
    view.options = [
      { value: 'red', label: '自分は赤' },
      { value: 'white', label: '自分は白' },
      { value: 'unknown', label: '分からない' }
    ];
  }
  if (room.day === 4) {
    const role = room.minigame.roles[player.id];
    const pair = room.minigame.pairings.find((ids) => ids.includes(player.id));
    const otherId = pair?.find((id) => id !== player.id);
    view.role = role;
    view.partner = otherId ? {
      id: otherId,
      number: room.players[otherId].number,
      name: room.players[otherId].name
    } : null;
    if (role === 'sender') {
      view.options = [0, 1, 2, 3, 4, 5].map((value) => ({ value, label: `${value}トークン送る` }));
    } else {
      const sent = otherId ? room.players[otherId].minigameInput : null;
      view.sent = sent;
      view.received = sent === null ? null : sent * 3;
      view.secondOptions = sent === null
        ? []
        : Array.from({ length: sent * 3 + 1 }, (_, value) => ({ value, label: `${value}トークン返す` }));
    }
  }
  return view;
}

function getPlayerState(room, playerId) {
  const player = room.players[playerId];
  if (!player) return null;
  const others = Object.values(room.players)
    .filter((item) => item.id !== playerId)
    .map((item) => ({
      id: item.id,
      number: item.number,
      name: item.name,
      isCpu: Boolean(item.isCpu),
      connected: item.connected
    }));
  return {
    ...baseState(room),
    self: {
      id: player.id,
      number: player.number,
      name: player.name,
      isCpu: Boolean(player.isCpu),
      connected: player.connected,
      evaluation: player.evaluation,
      evaluationBand: evaluationBand(player.evaluation),
      stress: player.stress,
      stressBand: stressBand(player.stress),
      suspicion: player.suspicion,
      suspicionBand: suspicionBand(player.suspicion),
      cards: player.cards.map((card) => publicCard(card, player.isEscapePlanner)),
      mustDiscard: Math.max(0, player.cards.length - 5),
      minigameInput: player.minigameInput,
      minigameSecondInput: player.minigameSecondInput,
      nightAction: player.nightAction,
      cardUsedToday: player.cardUsedDay === room.day,
      preview: player.temporaryEffects.nextMinigamePreview,
      privateMessages: player.privateMessages.slice(-8),
      observationResults: player.observationResults.slice(-4),
      escapeOfferPending: player.escapeOfferPending,
      escapeChoice: player.escapeChoice,
      isEscapePlanner: player.isEscapePlanner,
      escapeProgress: player.isEscapePlanner ? { ...player.escapeProgress } : null,
      finalEscapeDecision: player.finalEscapeDecision,
      finalEscapeRoute: player.finalEscapeRoute,
      finalDefenseChoice: player.finalDefenseChoice
    },
    others,
    minigameView: minigamePlayerView(room, player),
    escapeRoutes: Object.entries(ROUTES).map(([value, info]) => ({ value, label: info.label })),
    defenseOptions: Object.entries(DEFENSES).map(([value, label]) => ({ value, label })),
    minigameResult: room.phase === 'MINIGAME_RESULT' ? room.minigame.publicResult : null,
    nightEvents: ['NIGHT_RESULT', 'EVALUATION'].includes(room.phase) ? room.nightEvents : [],
    finalResult: room.finalResult
  };
}

module.exports = {
  rankPlayers,
  expectedIds,
  submission,
  getPublicState,
  getHostState,
  getPlayerState
};
