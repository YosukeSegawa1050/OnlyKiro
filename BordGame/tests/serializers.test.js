'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getPublicState, getHostState, getPlayerState } = require('../src/game/serializers');
const { makeRoom } = require('./helpers');

function secretRoom() {
  const room = makeRoom();
  room.phase = 'MINIGAME_INPUT';
  room.day = 3;
  room.minigame.type = 3;
  room.minigame.hats = { p1: 'red', p2: 'white', p3: 'red', p4: 'white' };
  room.players.p1.cards = [{ id: 'secret-card', type: 'medicine' }];
  room.players.p2.evaluation = 12;
  room.players.p2.stress = 9;
  room.players.p2.suspicion = 8;
  room.players.p3.isEscapePlanner = true;
  room.escapePlannerId = 'p3';
  return room;
}

test('公開状態に手札や正確な個人値が含まれない', () => {
  const json = JSON.stringify(getPublicState(secretRoom()));
  assert.equal(json.includes('secret-card'), false);
  assert.equal(json.includes('"evaluation":12'), false);
  assert.equal(json.includes('"stress":9'), false);
});

test('通常ホスト状態に脱獄計画者IDが含まれない', () => {
  const json = JSON.stringify(getHostState(secretRoom(), false));
  assert.equal(json.includes('escapePlannerId'), false);
  assert.equal(json.includes('p3'), true); // 公開プレイヤーIDとしては存在する
  assert.equal(json.includes('isEscapePlanner'), false);
});

test('本人状態に他人の秘密情報が含まれない', () => {
  const state = getPlayerState(secretRoom(), 'p1');
  const other = state.others.find((item) => item.id === 'p2');
  assert.deepEqual(Object.keys(other).sort(), ['connected', 'id', 'isCpu', 'name', 'number']);
  assert.equal(JSON.stringify(state).includes('"evaluation":12'), false);
});

test('帽子実験で自分の帽子は送信されない', () => {
  const state = getPlayerState(secretRoom(), 'p1');
  assert.equal(state.minigameView.visibleHats.some((hat) => hat.id === 'p1'), false);
  assert.equal(state.minigameView.visibleHats.length, 3);
  assert.equal('ownHat' in state.minigameView, false);
});
