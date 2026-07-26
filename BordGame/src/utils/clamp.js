'use strict';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function clampPlayer(player) {
  player.evaluation = clamp(player.evaluation, 0, 100);
  player.stress = clamp(player.stress, 0, 10);
  player.suspicion = clamp(player.suspicion, 0, 10);
  return player;
}

function clampRoom(room) {
  room.prison.order = clamp(room.prison.order, 0, 100);
  Object.values(room.players).forEach(clampPlayer);
  return room;
}

module.exports = { clamp, clampPlayer, clampRoom };
