'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolvePrisonersDilemma,
  resolveRation,
  resolveHats,
  resolveTrust,
  trustDelta
} = require('../src/game/minigames');
const { makeRoom } = require('./helpers');

function dilemma(a, b) {
  const room = makeRoom(2);
  room.minigame.pairings = [['p1', 'p2']];
  room.players.p1.minigameInput = a;
  room.players.p2.minigameInput = b;
  resolvePrisonersDilemma(room);
  return room;
}

test('囚人のジレンマ：協力・協力', () => {
  const room = dilemma('cooperate', 'cooperate');
  assert.equal(room.players.p1.evaluation, 58);
  assert.equal(room.players.p2.evaluation, 58);
  assert.equal(room.prison.order, 76);
});

test('囚人のジレンマ：協力・裏切り', () => {
  const room = dilemma('cooperate', 'betray');
  assert.equal(room.players.p1.evaluation, 44);
  assert.equal(room.players.p1.stress, 4);
  assert.equal(room.players.p2.evaluation, 62);
  assert.equal(room.prison.order, 66);
});

test('囚人のジレンマ：裏切り・裏切り', () => {
  const room = dilemma('betray', 'betray');
  assert.equal(room.players.p1.evaluation, 48);
  assert.equal(room.players.p1.stress, 3);
  assert.equal(room.prison.order, 62);
});

test('配給食：合計6以下で成功する', () => {
  const room = makeRoom();
  [0, 1, 2, 3].forEach((amount, index) => { room.players[`p${index + 1}`].minigameInput = amount; });
  const result = resolveRation(room);
  assert.equal(result.success, true);
  assert.equal(result.total, 6);
  assert.equal(room.players.p1.evaluation, 56);
  assert.equal(room.prison.order, 75);
});

test('配給食：合計7以上で失敗し最多取得者全員の疑惑が増える', () => {
  const room = makeRoom();
  [2, 2, 2, 1].forEach((amount, index) => { room.players[`p${index + 1}`].minigameInput = amount; });
  const result = resolveRation(room);
  assert.equal(result.success, false);
  assert.equal(room.players.p1.evaluation, 45);
  assert.equal(room.players.p1.suspicion, 2);
  assert.equal(room.players.p2.suspicion, 2);
  assert.equal(room.players.p3.suspicion, 2);
  assert.equal(room.players.p4.suspicion, 0);
  assert.equal(room.prison.order, 60);
});

function hats(answers, colors) {
  const room = makeRoom();
  room.day = 3;
  room.minigame.hats = {};
  answers.forEach((answer, index) => {
    room.players[`p${index + 1}`].minigameInput = answer;
    room.minigame.hats[`p${index + 1}`] = colors[index];
  });
  return { room, result: resolveHats(room) };
}

test('帽子：正解者あり、不正解者なしで成功', () => {
  const { room, result } = hats(['red', 'unknown', 'unknown', 'unknown'], ['red', 'white', 'red', 'white']);
  assert.equal(result.success, true);
  assert.equal(room.players.p1.evaluation, 60);
  assert.equal(room.players.p2.evaluation, 54);
  assert.equal(room.prison.order, 78);
});

test('帽子：不正解者がいると失敗', () => {
  const { room, result } = hats(['white', 'red', 'unknown', 'unknown'], ['red', 'red', 'white', 'white']);
  assert.equal(result.success, false);
  assert.equal(room.players.p1.evaluation, 42);
  assert.equal(room.players.p1.stress, 4);
  assert.equal(room.players.p2.evaluation, 52);
  assert.equal(room.prison.order, 62);
});

test('帽子：全員パス', () => {
  const { room, result } = hats(['unknown', 'unknown', 'unknown', 'unknown'], ['red', 'white', 'red', 'white']);
  assert.equal(result.allUnknown, true);
  assert.equal(room.players.p1.evaluation, 46);
  assert.equal(room.prison.order, 65);
});

function trust(sent, returned) {
  const room = makeRoom(2);
  room.day = 4;
  room.minigame.pairings = [['p1', 'p2']];
  room.players.p1.minigameInput = sent;
  room.players.p2.minigameSecondInput = returned;
  return { room, result: resolveTrust(room) };
}

test('信頼投資：送金0', () => {
  const { room } = trust(0, 0);
  assert.equal(room.players.p1.evaluation, 50);
  assert.equal(room.players.p2.evaluation, 40);
});

test('信頼投資：全額送金・全額返却', () => {
  const { room, result } = trust(5, 15);
  assert.equal(result.pairs[0].senderFinal, 15);
  assert.equal(result.pairs[0].receiverFinal, 0);
  assert.equal(room.players.p1.evaluation, 62);
  assert.equal(room.players.p2.evaluation, 40);
  assert.equal(room.prison.order, 73);
});

test('信頼投資：返却0で秩序と送金者ストレスが悪化', () => {
  const { room } = trust(5, 0);
  assert.equal(room.players.p1.evaluation, 40);
  assert.equal(room.players.p2.evaluation, 62);
  assert.equal(room.players.p1.stress, 4);
  assert.equal(room.prison.order, 66);
});

test('信頼投資：評価変化は上下限に収まる', () => {
  assert.equal(trustDelta(99), 12);
  assert.equal(trustDelta(-10), -12);
});
