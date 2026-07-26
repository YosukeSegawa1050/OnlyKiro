'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomManager } = require('../src/game/roomManager');
const engine = require('../src/game/gameEngine');

test('CPUは最大3人まで追加でき、ロビーで削除できる', () => {
  const manager = new RoomManager();
  const room = manager.createRoom();
  manager.addCpu(room.roomCode);
  manager.addCpu(room.roomCode);
  manager.addCpu(room.roomCode);
  assert.equal(Object.values(room.players).filter((player) => player.isCpu).length, 3);
  assert.throws(() => manager.addCpu(room.roomCode), /CPUは3人まで/);
  manager.removeCpu(room.roomCode);
  assert.equal(Object.values(room.players).filter((player) => player.isCpu).length, 2);
});

test('人間1人＋CPU3人でCPUが各入力フェーズを自動回答する', () => {
  const manager = new RoomManager();
  const room = manager.createRoom();
  const { player: human } = manager.join(room.roomCode, '人間', 'socket-human');
  manager.addCpu(room.roomCode);
  manager.addCpu(room.roomCode);
  manager.addCpu(room.roomCode);
  engine.startGame(room);

  engine.advancePhase(room); // MINIGAME_INTRO
  engine.advancePhase(room); // PREPARATION
  engine.advancePhase(room); // MINIGAME_INPUT
  const cpus = Object.values(room.players).filter((player) => player.isCpu);
  assert.equal(cpus.every((cpu) => cpu.minigameInput !== null), true);
  assert.equal(human.minigameInput, null);

  human.minigameInput = 'cooperate';
  engine.advancePhase(room); // MINIGAME_RESULT
  engine.advancePhase(room); // NIGHT_ACTION
  assert.equal(cpus.every((cpu) => cpu.nightAction !== null), true);
  assert.equal(human.nightAction, null);
});

test('CPU脱獄計画者とCPU阻止側は最終行動を自動選択する', () => {
  const manager = new RoomManager();
  const room = manager.createRoom();
  const { player: human } = manager.join(room.roomCode, '人間', 'socket-human');
  const cpu1 = manager.addCpu(room.roomCode).player;
  const cpu2 = manager.addCpu(room.roomCode).player;
  const cpu3 = manager.addCpu(room.roomCode).player;
  engine.startGame(room);

  cpu1.isEscapePlanner = true;
  room.escapePlannerId = cpu1.id;
  engine.setPhase(room, 'FINAL_JUDGMENT');
  assert.ok(['execute', 'abandon'].includes(cpu1.finalEscapeDecision));

  cpu1.finalEscapeDecision = 'execute';
  engine.setPhase(room, 'ESCAPE_ROUTE_SELECT');
  assert.ok(cpu1.finalEscapeRoute);

  human.finalDefenseChoice = null;
  cpu2.finalDefenseChoice = null;
  cpu3.finalDefenseChoice = null;
  engine.setPhase(room, 'ESCAPE_DEFENSE');
  assert.ok(cpu2.finalDefenseChoice);
  assert.ok(cpu3.finalDefenseChoice);
  assert.equal(human.finalDefenseChoice, null);
});
