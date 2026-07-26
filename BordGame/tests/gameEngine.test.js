'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clampRoom } = require('../src/utils/clamp');
const { makeRoom } = require('./helpers');
const engine = require('../src/game/gameEngine');
const { createDeck } = require('../src/game/cards');

test('評価・ストレス・疑惑度・秩序を許可範囲へ制限する', () => {
  const room = makeRoom();
  room.players.p1.evaluation = 130;
  room.players.p2.evaluation = -20;
  room.players.p1.stress = 15;
  room.players.p1.suspicion = 99;
  room.prison.order = -8;
  clampRoom(room);
  assert.equal(room.players.p1.evaluation, 100);
  assert.equal(room.players.p2.evaluation, 0);
  assert.equal(room.players.p1.stress, 10);
  assert.equal(room.players.p1.suspicion, 10);
  assert.equal(room.prison.order, 0);
  room.prison.order = 180;
  clampRoom(room);
  assert.equal(room.prison.order, 100);
});

test('ロビーから4日目の通常釈放まで全フェーズを進行できる', () => {
  const room = makeRoom();
  room.phase = 'LOBBY';
  room.day = 0;
  room.cardDeck = createDeck(3);
  engine.startGame(room);

  for (let day = 1; day <= 4; day += 1) {
    assert.equal(room.day, day);
    assert.equal(room.phase, 'DAY_BRIEFING');
    engine.advancePhase(room); // MINIGAME_INTRO
    engine.advancePhase(room); // PREPARATION
    engine.advancePhase(room); // MINIGAME_INPUT
    engine.fillDefaults(room);
    engine.advancePhase(room);
    if (day === 4) {
      assert.equal(room.phase, 'MINIGAME_SECOND_INPUT');
      engine.fillDefaults(room);
      engine.advancePhase(room);
    }
    assert.equal(room.phase, 'MINIGAME_RESULT');
    engine.advancePhase(room); // NIGHT_ACTION
    engine.fillDefaults(room);
    engine.advancePhase(room); // NIGHT_RESULT
    engine.advancePhase(room); // EVALUATION

    if (day === 2 || day === 3) {
      engine.advancePhase(room); // ESCAPE_OFFER（初回／再提示）
      assert.equal(room.phase, 'ESCAPE_OFFER');
      engine.fillDefaults(room);
      engine.advancePhase(room); // 次の日
    } else {
      engine.advancePhase(room);
    }
  }

  assert.equal(room.phase, 'FINAL_JUDGMENT');
  engine.advancePhase(room);
  assert.equal(room.phase, 'GAME_RESULT');
  assert.equal(room.finalResult.type, 'release');
  assert.equal(room.finalResult.winners.length, 2);
});
