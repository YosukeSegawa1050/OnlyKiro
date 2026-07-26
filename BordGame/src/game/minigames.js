'use strict';

const { clampRoom } = require('../utils/clamp');
const { shuffle } = require('./cards');

function changeEvaluation(player, amount) {
  let applied = amount;
  if (amount < 0 && player.temporaryEffects?.evaluationShield > 0) {
    const blocked = Math.min(-amount, player.temporaryEffects.evaluationShield);
    applied += blocked;
    player.temporaryEffects.evaluationShield = 0;
  }
  player.evaluation += applied;
  return applied;
}

function makePairs(ids) {
  const shuffled = shuffle(ids);
  return [
    [shuffled[0], shuffled[1]],
    [shuffled[2], shuffled[3]]
  ];
}

function setupMinigame(room) {
  const ids = Object.keys(room.players);
  room.minigame = {
    type: room.day,
    status: 'ready',
    pairings: [],
    roles: {},
    hats: {},
    publicResult: null
  };
  ids.forEach((id) => {
    room.players[id].minigameInput = null;
    room.players[id].minigameSecondInput = null;
  });
  if (room.day === 1 || room.day === 4) room.minigame.pairings = makePairs(ids);
  if (room.day === 3) {
    const colors = shuffle(['red', 'white', Math.random() < 0.5 ? 'red' : 'white', Math.random() < 0.5 ? 'red' : 'white']);
    ids.forEach((id, index) => { room.minigame.hats[id] = colors[index]; });
  }
  if (room.day === 4) {
    room.minigame.pairings.forEach(([sender, receiver]) => {
      room.minigame.roles[sender] = 'sender';
      room.minigame.roles[receiver] = 'receiver';
    });
  }
  return room.minigame;
}

function resolvePrisonersDilemma(room) {
  const pairs = room.minigame.pairings.map(([aId, bId]) => {
    const a = room.players[aId];
    const b = room.players[bId];
    const aChoice = a.minigameInput;
    const bChoice = b.minigameInput;
    if (aChoice === 'cooperate' && bChoice === 'cooperate') {
      changeEvaluation(a, 8);
      changeEvaluation(b, 8);
      room.prison.order += 6;
    } else if (aChoice === 'betray' && bChoice === 'betray') {
      changeEvaluation(a, -2);
      changeEvaluation(b, -2);
      a.stress += 1;
      b.stress += 1;
      room.prison.order -= 8;
    } else {
      const betrayer = aChoice === 'betray' ? a : b;
      const cooperator = aChoice === 'cooperate' ? a : b;
      changeEvaluation(betrayer, 12);
      changeEvaluation(cooperator, -6);
      cooperator.stress += 2;
      room.prison.order -= 4;
    }
    return {
      players: [
        { id: a.id, number: a.number, name: a.name, choice: aChoice },
        { id: b.id, number: b.number, name: b.name, choice: bChoice }
      ]
    };
  });
  clampRoom(room);
  return { title: '囚人のジレンマ 結果', kind: 'pairs', pairs };
}

function resolveRation(room) {
  const entries = Object.values(room.players).map((player) => ({
    id: player.id,
    number: player.number,
    name: player.name,
    amount: player.minigameInput
  }));
  const total = entries.reduce((sum, item) => sum + item.amount, 0);
  const success = total <= 6;
  const max = Math.max(...entries.map((item) => item.amount));

  entries.forEach((entry) => {
    const player = room.players[entry.id];
    if (success) {
      if (entry.amount === 0) changeEvaluation(player, 6);
      if (entry.amount === 1) { changeEvaluation(player, 3); player.stress -= 1; }
      if (entry.amount === 2) player.stress -= 2;
      if (entry.amount === 3) { changeEvaluation(player, -2); player.stress -= 3; }
    } else {
      changeEvaluation(player, -5);
      player.stress -= entry.amount;
      if (entry.amount === max) player.suspicion += 2;
    }
  });
  room.prison.order += success ? 5 : -10;
  clampRoom(room);
  return { title: '配給食実験 結果', kind: 'ration', total, success, entries };
}

function resolveHats(room) {
  const entries = Object.values(room.players).map((player) => {
    const answer = player.minigameInput;
    const actual = room.minigame.hats[player.id];
    return {
      id: player.id,
      number: player.number,
      name: player.name,
      answer,
      actual,
      correct: answer !== 'unknown' && answer === actual
    };
  });
  const allUnknown = entries.every((entry) => entry.answer === 'unknown');
  const wrong = entries.filter((entry) => entry.answer !== 'unknown' && !entry.correct);
  const correct = entries.filter((entry) => entry.correct);
  let success = false;
  if (allUnknown) {
    entries.forEach((entry) => changeEvaluation(room.players[entry.id], -4));
    room.prison.order -= 5;
  } else {
    success = correct.length > 0 && wrong.length === 0;
    entries.forEach((entry) => {
      const player = room.players[entry.id];
      if (success) changeEvaluation(player, entry.correct ? 10 : 4);
      else if (entry.correct) changeEvaluation(player, 2);
      else if (entry.answer === 'unknown') changeEvaluation(player, -2);
      else { changeEvaluation(player, -8); player.stress += 2; }
    });
    room.prison.order += success ? 8 : -8;
  }
  clampRoom(room);
  return { title: '赤白帽子実験 結果', kind: 'hats', success, allUnknown, entries };
}

function trustDelta(finalTokens) {
  return Math.max(-12, Math.min(12, (finalTokens - 5) * 2));
}

function resolveTrust(room) {
  const pairs = room.minigame.pairings.map(([senderId, receiverId]) => {
    const sender = room.players[senderId];
    const receiver = room.players[receiverId];
    const sent = sender.minigameInput;
    const returned = receiver.minigameSecondInput;
    const senderFinal = 5 - sent + returned;
    const receiverFinal = sent * 3 - returned;
    changeEvaluation(sender, trustDelta(senderFinal));
    changeEvaluation(receiver, trustDelta(receiverFinal));
    if (returned >= sent) room.prison.order += 3;
    if (sent > 0 && returned === 0) {
      room.prison.order -= 4;
      sender.stress += 2;
    }
    return {
      sender: { id: sender.id, number: sender.number, name: sender.name },
      receiver: { id: receiver.id, number: receiver.number, name: receiver.name },
      sent, returned, senderFinal, receiverFinal
    };
  });
  clampRoom(room);
  return { title: '信頼投資実験 結果', kind: 'trust', pairs };
}

function resolveMinigame(room) {
  let result;
  if (room.day === 1) result = resolvePrisonersDilemma(room);
  if (room.day === 2) result = resolveRation(room);
  if (room.day === 3) result = resolveHats(room);
  if (room.day === 4) result = resolveTrust(room);
  room.minigame.publicResult = result;
  room.minigame.status = 'resolved';
  return result;
}

module.exports = {
  changeEvaluation,
  setupMinigame,
  resolvePrisonersDilemma,
  resolveRation,
  resolveHats,
  trustDelta,
  resolveTrust,
  resolveMinigame
};
