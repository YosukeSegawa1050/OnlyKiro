'use strict';

function makePlayer(id, number) {
  return {
    id,
    number,
    name: `P${number}`,
    isCpu: false,
    connected: true,
    connectionStatus: '接続中',
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
    observationResults: [],
    tieBreaker: number
  };
}

function makeRoom(count = 4) {
  const players = {};
  for (let i = 1; i <= count; i += 1) players[`p${i}`] = makePlayer(`p${i}`, i);
  return {
    roomCode: 'TEST',
    phase: 'MINIGAME_INPUT',
    day: 1,
    prison: { order: 70 },
    players,
    cardDeck: [],
    discardPile: [],
    minigame: { type: 1, status: 'ready', pairings: [], roles: {}, hats: {}, publicResult: null },
    nightEvents: [],
    publicLog: [],
    evaluationRanking: [],
    escapeOfferCandidates: [],
    escapePlannerId: null,
    finalResult: null,
    timer: { duration: 90, remaining: 90, running: false, interval: null }
  };
}

module.exports = { makePlayer, makeRoom };
