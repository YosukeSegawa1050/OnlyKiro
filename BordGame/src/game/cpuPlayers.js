'use strict';

const { CARD_TYPES, discardById, randomDiscard } = require('./cards');
const { ROUTES, DEFENSES } = require('./escape');

function pick(values) {
  return values[Math.floor(Math.random() * values.length)];
}

function cpuPlayers(room) {
  return Object.values(room.players).filter((player) => player.isCpu);
}

function otherPlayers(room, player) {
  return Object.values(room.players).filter((target) => target.id !== player.id);
}

function chooseMinigame(room, player) {
  if (player.minigameInput !== null) return;
  if (room.day === 1) player.minigameInput = pick(['cooperate', 'cooperate', 'cooperate', 'betray']);
  if (room.day === 2) player.minigameInput = pick([0, 1, 1, 2, 2, 3]);
  if (room.day === 3) player.minigameInput = pick(['unknown', 'unknown', 'unknown', 'red', 'white']);
  if (room.day === 4 && room.minigame.roles[player.id] === 'sender') {
    player.minigameInput = pick([0, 1, 2, 3, 4, 5]);
  }
}

function chooseSecondMinigame(room, player) {
  if (player.minigameSecondInput !== null || room.minigame.roles[player.id] !== 'receiver') return;
  const pair = room.minigame.pairings.find((ids) => ids.includes(player.id));
  const senderId = pair?.find((id) => id !== player.id);
  const received = senderId ? room.players[senderId].minigameInput * 3 : 0;
  player.minigameSecondInput = Math.floor(Math.random() * (received + 1));
}

function escapePrepCard(player) {
  const unmet = ['route', 'tool', 'timing'].filter((key) => !player.escapeProgress[key]);
  return player.cards.find((card) => unmet.includes(CARD_TYPES[card.type].escapeCategory))
    || player.cards[0]
    || null;
}

function chooseNightAction(room, player) {
  if (player.nightAction !== null) return;
  const others = otherPlayers(room, player);
  if (player.stress >= 7) {
    player.nightAction = { type: 'rest' };
    return;
  }
  if (player.isEscapePlanner && player.cards.length && Math.random() < 0.65) {
    const card = escapePrepCard(player);
    player.nightAction = { type: 'escapePrep', cardId: card.id };
    return;
  }

  const choices = ['rest', 'search', 'inform', 'observe'];
  if (player.cards.length) choices.push('transfer');
  let type = pick(choices);
  if (player.cards.length >= 5 && type === 'search') type = 'rest';
  if (type === 'rest' || type === 'search') {
    player.nightAction = { type };
    return;
  }
  const target = pick(others);
  if (!target) {
    player.nightAction = { type: 'rest' };
    return;
  }
  player.nightAction = {
    type,
    targetId: target.id,
    ...(type === 'transfer' ? { cardId: pick(player.cards).id } : {})
  };
}

function chooseEscapeOffer(room, player) {
  if (!room.escapeOfferCandidates.includes(player.id) || player.escapeChoice !== null) return;
  const desperate = player.evaluation <= 42 || player.stress >= 7;
  player.escapeChoice = Math.random() < (desperate ? 0.75 : 0.45) ? 'escape' : 'regular';
}

function chooseFinalJudgment(room, player) {
  if (room.escapePlannerId !== player.id || player.finalEscapeDecision !== null) return;
  const progress = ['route', 'tool', 'timing'].filter((key) => player.escapeProgress[key]).length;
  player.finalEscapeDecision = progress >= 2 || Math.random() < 0.45 ? 'execute' : 'abandon';
}

function chooseEscapeRoute(room, player) {
  if (room.escapePlannerId !== player.id || player.finalEscapeRoute !== null) return;
  const routeEntries = Object.entries(ROUTES);
  const prepared = routeEntries.filter(([, route]) => player.escapeProgress[route.category]);
  const [routeId, route] = pick(prepared.length ? prepared : routeEntries);
  const finalCard = player.cards.find((card) => CARD_TYPES[card.type].escapeCategory === route.category);
  if (finalCard && Math.random() < 0.7) {
    discardById(room, player, finalCard.id);
    player.finalEscapeCardUsed = true;
  }
  player.finalEscapeRoute = routeId;
}

function chooseDefense(room, player) {
  if (room.escapePlannerId === player.id || player.finalDefenseChoice !== null) return;
  player.finalDefenseChoice = pick(Object.keys(DEFENSES));
}

function runCpuTurns(room) {
  cpuPlayers(room).forEach((player) => {
    while (player.cards.length > 5) randomDiscard(room, player);
    if (room.phase === 'MINIGAME_INPUT') chooseMinigame(room, player);
    if (room.phase === 'MINIGAME_SECOND_INPUT') chooseSecondMinigame(room, player);
    if (room.phase === 'NIGHT_ACTION') chooseNightAction(room, player);
    if (room.phase === 'ESCAPE_OFFER') chooseEscapeOffer(room, player);
    if (room.phase === 'FINAL_JUDGMENT') chooseFinalJudgment(room, player);
    if (room.phase === 'ESCAPE_ROUTE_SELECT') chooseEscapeRoute(room, player);
    if (room.phase === 'ESCAPE_DEFENSE') chooseDefense(room, player);
  });
}

module.exports = { runCpuTurns };
