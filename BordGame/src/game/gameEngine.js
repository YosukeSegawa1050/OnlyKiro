'use strict';

const { PHASES } = require('./constants');
const { setupMinigame, resolveMinigame, changeEvaluation } = require('./minigames');
const { validateNightAction, resolveNight } = require('./nightActions');
const { CARD_TYPES, discardById, randomDiscard, drawCard, useNormalCard } = require('./cards');
const { rankPlayers, expectedIds, submission } = require('./serializers');
const { ROUTES, DEFENSES, resolveEscape } = require('./escape');
const { clampRoom, clamp } = require('../utils/clamp');
const { runCpuTurns } = require('./cpuPlayers');

function playerList(room) {
  return Object.values(room.players);
}

function setPhase(room, phase) {
  if (!PHASES.includes(phase)) throw new Error('無効なフェーズです');
  room.phase = phase;
  room.timer.running = false;
  room.timer.remaining = room.timer.duration;
  runCpuTurns(room);
  return phase;
}

function beginDay(room, day) {
  room.day = day;
  playerList(room).forEach((player) => {
    if (player.temporaryEffects.nextMinigamePreview) {
      player.privateMessages.push(`先行情報どおり、本日の心理実験は「${player.temporaryEffects.nextMinigamePreview}」だ。`);
      player.temporaryEffects.nextMinigamePreview = null;
    }
    player.nightAction = null;
    player.minigameInput = null;
    player.minigameSecondInput = null;
    player.cardUsedDay = 0;
    player.finalDefenseChoice = null;
  });
  setupMinigame(room);
  setPhase(room, 'DAY_BRIEFING');
}

function startGame(room) {
  if (room.phase !== 'LOBBY') throw new Error('すでにゲームが開始されています');
  if (playerList(room).length !== 4) throw new Error('4人揃ってから開始してください');
  playerList(room).forEach((player) => { player.tieBreaker = Math.random(); });
  const managerLikeDeal = require('./cards').drawCard;
  playerList(room).forEach((player) => {
    managerLikeDeal(room, player);
    managerLikeDeal(room, player);
  });
  beginDay(room, 1);
}

function allSubmitted(room) {
  return submission(room).allSubmitted;
}

function processStressBreakdowns(room) {
  playerList(room).forEach((player) => {
    if (player.stress >= 10) {
      changeEvaluation(player, -5);
      player.stress = 8;
      randomDiscard(room, player);
      player.privateMessages.push('精神的限界に達した。評価を失い、手札を1枚喪失した。');
    }
  });
  clampRoom(room);
}

function ensureAllSubmitted(room) {
  if (!allSubmitted(room)) throw new Error('未回答のプレイヤーがいます');
}

function prepareEvaluation(room) {
  room.evaluationRanking = rankPlayers(room).map((item) => item.id);
}

function prepareEscapeOffer(room, forcedDay3 = false) {
  const ranking = rankPlayers(room);
  let candidates = [];
  if (forcedDay3) {
    candidates = ranking.length ? [ranking[ranking.length - 1].id] : [];
  } else {
    const lastId = ranking.length ? ranking[ranking.length - 1].id : null;
    candidates = playerList(room)
      .filter((player) => player.id === lastId || player.evaluation <= 42 || player.stress >= 7)
      .map((player) => player.id);
  }
  room.escapeOfferCandidates = [...new Set(candidates)];
  room.escapeOfferCandidates.forEach((id) => {
    const player = room.players[id];
    player.escapeOffered = true;
    player.escapeOfferPending = true;
    player.escapeChoice = null;
  });
  return room.escapeOfferCandidates;
}

function resolveEscapeOffer(room) {
  const volunteers = room.escapeOfferCandidates
    .map((id) => room.players[id])
    .filter((player) => player.escapeChoice === 'escape')
    .sort((a, b) => a.evaluation - b.evaluation || b.stress - a.stress || Math.random() - 0.5);
  if (volunteers.length) {
    const planner = volunteers[0];
    planner.isEscapePlanner = true;
    room.escapePlannerId = planner.id;
    planner.privateMessages.push('あなたの脱獄計画が始動した。存在を悟られてはならない。');
    volunteers.slice(1).forEach((player) => {
      player.privateMessages.push('計画はすでに別の場所で動き始めている。あなたは正規の釈放を目指すしかない。');
    });
  }
  room.escapeOfferCandidates.forEach((id) => { room.players[id].escapeOfferPending = false; });
  room.escapeOfferCandidates = [];
}

function finalRanking(room, excludeIds = []) {
  return rankPlayers(room, true, excludeIds).map((item, index) => ({
    rank: index + 1,
    id: item.id,
    number: item.number,
    name: item.name,
    band: require('./constants').evaluationBand(item.evaluation),
    correction: item.correction,
    adjustedEvaluation: item.adjustedEvaluation
  }));
}

function makeNormalResult(room, excludeIds = [], message = '最終評価上位2名を釈放する。') {
  const ranking = finalRanking(room, excludeIds);
  room.finalResult = {
    type: 'release',
    title: '最終釈放審査',
    message,
    winners: ranking.slice(0, 2).map((item) => ({
      id: item.id, number: item.number, name: item.name
    })),
    ranking
  };
  setPhase(room, 'GAME_RESULT');
}

function resolveFinalEscape(room) {
  const planner = room.players[room.escapePlannerId];
  const defenders = playerList(room).filter((player) => player.id !== planner.id);
  const resolution = resolveEscape({
    progress: planner.escapeProgress,
    route: planner.finalEscapeRoute,
    defenses: defenders.map((player) => player.finalDefenseChoice),
    order: room.prison.order,
    finalCardUsed: planner.finalEscapeCardUsed
  });
  const route = ROUTES[planner.finalEscapeRoute];
  const defenseRows = defenders.map((player) => ({
    id: player.id,
    number: player.number,
    name: player.name,
    choice: player.finalDefenseChoice,
    label: DEFENSES[player.finalDefenseChoice],
    matched: player.finalDefenseChoice === route.defense
  }));

  if (resolution.success) {
    room.finalResult = {
      type: 'escapeSuccess',
      title: '脱獄成功',
      message: `${planner.name}は監獄から姿を消した。監獄の管理責任が問われ、釈放審査は中止された。`,
      winners: [{ id: planner.id, number: planner.number, name: planner.name }],
      route: route.label,
      progress: { ...planner.escapeProgress },
      finalCardUsed: planner.finalEscapeCardUsed,
      orderBonus: room.prison.order >= 80 ? 2 : room.prison.order >= 60 ? 1 : 0,
      defenses: defenseRows,
      ...resolution
    };
  } else {
    planner.evaluation = 0;
    defenseRows.filter((row) => row.matched).forEach((row) => changeEvaluation(room.players[row.id], 8));
    const ranking = finalRanking(room, [planner.id]);
    room.finalResult = {
      type: 'escapeFailed',
      title: '脱獄阻止',
      message: '脱獄計画者は独房へ移送された。残る囚人を対象に最終釈放審査を再開する。',
      winners: ranking.slice(0, 2).map((item) => ({
        id: item.id, number: item.number, name: item.name
      })),
      ranking,
      route: route.label,
      progress: { ...planner.escapeProgress },
      finalCardUsed: planner.finalEscapeCardUsed,
      orderBonus: room.prison.order >= 80 ? 2 : room.prison.order >= 60 ? 1 : 0,
      defenses: defenseRows,
      ...resolution
    };
  }
  clampRoom(room);
  setPhase(room, 'ESCAPE_RESULT');
}

function advancePhase(room) {
  switch (room.phase) {
    case 'DAY_BRIEFING':
      return setPhase(room, 'MINIGAME_INTRO');
    case 'MINIGAME_INTRO':
      return setPhase(room, 'PREPARATION');
    case 'PREPARATION':
      return setPhase(room, 'MINIGAME_INPUT');
    case 'MINIGAME_INPUT':
      ensureAllSubmitted(room);
      if (room.day === 4) return setPhase(room, 'MINIGAME_SECOND_INPUT');
      resolveMinigame(room);
      processStressBreakdowns(room);
      return setPhase(room, 'MINIGAME_RESULT');
    case 'MINIGAME_SECOND_INPUT':
      ensureAllSubmitted(room);
      resolveMinigame(room);
      processStressBreakdowns(room);
      return setPhase(room, 'MINIGAME_RESULT');
    case 'MINIGAME_RESULT':
      playerList(room).forEach((player) => { player.nightAction = null; });
      return setPhase(room, 'NIGHT_ACTION');
    case 'NIGHT_ACTION':
      ensureAllSubmitted(room);
      resolveNight(room);
      return setPhase(room, 'NIGHT_RESULT');
    case 'NIGHT_RESULT':
      if (playerList(room).some((player) => player.cards.length > 5)) {
        throw new Error('手札上限を超えたプレイヤーの破棄を待っています');
      }
      prepareEvaluation(room);
      return setPhase(room, 'EVALUATION');
    case 'EVALUATION':
      if (room.day === 2 && !room.escapePlannerId) {
        prepareEscapeOffer(room, false);
        if (room.escapeOfferCandidates.length) return setPhase(room, 'ESCAPE_OFFER');
      }
      if (room.day === 3 && !room.escapePlannerId) {
        prepareEscapeOffer(room, true);
        return setPhase(room, 'ESCAPE_OFFER');
      }
      if (room.day === 4) return setPhase(room, 'FINAL_JUDGMENT');
      beginDay(room, room.day + 1);
      return room.phase;
    case 'ESCAPE_OFFER':
      ensureAllSubmitted(room);
      resolveEscapeOffer(room);
      beginDay(room, room.day + 1);
      return room.phase;
    case 'FINAL_JUDGMENT': {
      if (!room.escapePlannerId) {
        makeNormalResult(room);
        return room.phase;
      }
      ensureAllSubmitted(room);
      const planner = room.players[room.escapePlannerId];
      if (planner.finalEscapeDecision === 'execute') return setPhase(room, 'ESCAPE_ROUTE_SELECT');
      makeNormalResult(room);
      return room.phase;
    }
    case 'ESCAPE_ROUTE_SELECT':
      ensureAllSubmitted(room);
      playerList(room).forEach((player) => { player.finalDefenseChoice = null; });
      return setPhase(room, 'ESCAPE_DEFENSE');
    case 'ESCAPE_DEFENSE':
      ensureAllSubmitted(room);
      resolveFinalEscape(room);
      return room.phase;
    case 'ESCAPE_RESULT':
      return setPhase(room, 'GAME_RESULT');
    default:
      throw new Error('このフェーズからは進行できません');
  }
}

function submitMinigame(room, player, value) {
  if (room.phase !== 'MINIGAME_INPUT') throw new Error('現在は心理実験へ回答できません');
  if (room.day === 4 && room.minigame.roles[player.id] !== 'sender') throw new Error('送金者の回答を待ってください');
  if (player.minigameInput !== null) throw new Error('回答はすでに確定しています');
  const allowed = {
    1: ['cooperate', 'betray'],
    2: [0, 1, 2, 3],
    3: ['red', 'white', 'unknown'],
    4: [0, 1, 2, 3, 4, 5]
  }[room.day];
  if (!allowed.includes(value)) throw new Error('無効な回答です');
  player.minigameInput = value;
}

function submitSecondMinigame(room, player, value) {
  if (room.phase !== 'MINIGAME_SECOND_INPUT' || room.day !== 4) throw new Error('現在は第2入力を受け付けていません');
  if (room.minigame.roles[player.id] !== 'receiver') throw new Error('受取人のみ回答できます');
  if (player.minigameSecondInput !== null) throw new Error('回答はすでに確定しています');
  const pair = room.minigame.pairings.find((ids) => ids.includes(player.id));
  const senderId = pair.find((id) => id !== player.id);
  const max = room.players[senderId].minigameInput * 3;
  if (!Number.isInteger(value) || value < 0 || value > max) throw new Error('返却数が無効です');
  player.minigameSecondInput = value;
}

function submitNightAction(room, player, action) {
  if (room.phase !== 'NIGHT_ACTION') throw new Error('現在は夜間行動を選択できません');
  if (player.nightAction !== null) throw new Error('夜間行動はすでに確定しています');
  validateNightAction(room, player, action);
  player.nightAction = {
    type: action.type,
    ...(action.targetId ? { targetId: action.targetId } : {}),
    ...(action.cardId ? { cardId: action.cardId } : {})
  };
}

function submitEscapeChoice(room, player, choice) {
  if (room.phase === 'ESCAPE_OFFER') {
    if (!room.escapeOfferCandidates.includes(player.id)) throw new Error('あなたへの提案はありません');
    if (player.escapeChoice !== null) throw new Error('選択は確定済みです');
    if (!['regular', 'escape'].includes(choice)) throw new Error('無効な選択です');
    player.escapeChoice = choice;
    return;
  }
  if (room.phase === 'FINAL_JUDGMENT') {
    if (room.escapePlannerId !== player.id) throw new Error('あなたはこの選択を行えません');
    if (player.finalEscapeDecision !== null) throw new Error('選択は確定済みです');
    if (!['execute', 'abandon'].includes(choice)) throw new Error('無効な選択です');
    player.finalEscapeDecision = choice;
    return;
  }
  throw new Error('現在は脱獄に関する選択を行えません');
}

function submitFinalEscape(room, player, payload) {
  if (room.phase !== 'ESCAPE_ROUTE_SELECT' || room.escapePlannerId !== player.id) {
    throw new Error('現在は脱出経路を選べません');
  }
  if (player.finalEscapeRoute !== null) throw new Error('脱出経路は確定済みです');
  if (!ROUTES[payload.route]) throw new Error('無効な脱出経路です');
  if (payload.cardId) {
    const card = player.cards.find((item) => item.id === payload.cardId);
    if (!card || CARD_TYPES[card.type].escapeCategory !== ROUTES[payload.route].category) {
      throw new Error('選択経路に対応するカードではありません');
    }
    discardById(room, player, card.id);
    player.finalEscapeCardUsed = true;
  }
  player.finalEscapeRoute = payload.route;
}

function submitFinalDefense(room, player, choice) {
  if (room.phase !== 'ESCAPE_DEFENSE' || room.escapePlannerId === player.id) {
    throw new Error('現在は阻止行動を選べません');
  }
  if (player.finalDefenseChoice !== null) throw new Error('阻止行動は確定済みです');
  if (!DEFENSES[choice]) throw new Error('無効な阻止行動です');
  player.finalDefenseChoice = choice;
}

function fillDefaults(room) {
  expectedIds(room).forEach((id) => {
    const player = room.players[id];
    if (room.phase === 'MINIGAME_INPUT' && player.minigameInput === null) {
      player.minigameInput = ({ 1: 'cooperate', 2: 0, 3: 'unknown', 4: 0 })[room.day];
    }
    if (room.phase === 'MINIGAME_SECOND_INPUT' && player.minigameSecondInput === null) player.minigameSecondInput = 0;
    if (room.phase === 'NIGHT_ACTION' && player.nightAction === null) player.nightAction = { type: 'rest' };
    if (room.phase === 'ESCAPE_OFFER' && player.escapeChoice === null) player.escapeChoice = 'regular';
    if (room.phase === 'FINAL_JUDGMENT' && player.finalEscapeDecision === null) player.finalEscapeDecision = 'abandon';
    if (room.phase === 'ESCAPE_DEFENSE' && player.finalDefenseChoice === null) player.finalDefenseChoice = 'wait';
  });
}

function useCard(room, player, cardId, options) {
  return useNormalCard(room, player, cardId, options);
}

function discardOverflow(room, player, cardId) {
  if (player.cards.length <= 5) throw new Error('手札を捨てる必要はありません');
  if (!discardById(room, player, cardId)) throw new Error('指定されたカードを所持していません');
}

function applyDebug(room, payload) {
  const action = payload?.action;
  const player = payload?.playerId ? room.players[payload.playerId] : null;
  if (['evaluation', 'stress', 'suspicion'].includes(action) && !player) throw new Error('対象プレイヤーが無効です');
  if (action === 'evaluation') player.evaluation = clamp(payload.value, 0, 100);
  else if (action === 'stress') player.stress = clamp(payload.value, 0, 10);
  else if (action === 'suspicion') player.suspicion = clamp(payload.value, 0, 10);
  else if (action === 'order') room.prison.order = clamp(payload.value, 0, 100);
  else if (action === 'giveCard') {
    if (!player || !CARD_TYPES[payload.cardType]) throw new Error('カード指定が無効です');
    const card = { id: require('node:crypto').randomUUID(), type: payload.cardType };
    player.cards.push(card);
  } else if (action === 'offerEscape') {
    if (!player) throw new Error('対象プレイヤーが無効です');
    player.escapeOffered = true;
    player.escapeOfferPending = true;
    room.escapeOfferCandidates = [player.id];
    setPhase(room, 'ESCAPE_OFFER');
  } else if (action === 'makePlanner') {
    if (!player) throw new Error('対象プレイヤーが無効です');
    playerList(room).forEach((item) => { item.isEscapePlanner = false; });
    player.isEscapePlanner = true;
    room.escapePlannerId = player.id;
  } else if (action === 'day') {
    beginDay(room, clamp(payload.value, 1, 4));
  } else if (action === 'phase') {
    setPhase(room, payload.value);
  } else if (action === 'autoSubmit') {
    fillDefaults(room);
  } else if (action === 'skipFinalEscape') {
    if (!room.escapePlannerId) {
      const target = player || playerList(room)[0];
      target.isEscapePlanner = true;
      room.escapePlannerId = target.id;
    }
    const planner = room.players[room.escapePlannerId];
    planner.escapeProgress = { route: true, tool: true, timing: true, reinforcement: 1 };
    planner.finalEscapeDecision = 'execute';
    planner.finalEscapeRoute = 'underground';
    playerList(room).filter((item) => item.id !== planner.id).forEach((item) => {
      item.finalDefenseChoice = null;
    });
    setPhase(room, 'ESCAPE_DEFENSE');
  } else {
    throw new Error('無効なデバッグ操作です');
  }
  clampRoom(room);
}

module.exports = {
  startGame,
  advancePhase,
  submitMinigame,
  submitSecondMinigame,
  submitNightAction,
  submitEscapeChoice,
  submitFinalEscape,
  submitFinalDefense,
  fillDefaults,
  useCard,
  discardOverflow,
  applyDebug,
  setPhase,
  beginDay,
  finalRanking,
  makeNormalResult
};
