'use strict';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function createRoomCode(existing = new Set()) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    let code = '';
    for (let i = 0; i < 4; i += 1) {
      code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    if (!existing.has(code)) return code;
  }
  throw new Error('ルームコードを生成できませんでした');
}

module.exports = { ALPHABET, createRoomCode };
