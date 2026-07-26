'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: createClient } = require('socket.io-client');
const { server, io } = require('../server');

function once(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

function ack(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.emit(event, payload, (response) => {
      if (response?.ok) resolve(response);
      else reject(new Error(response?.error || `${event} failed`));
    });
  });
}

test('Socket.IOで人間1人＋CPU3人を開始し、人間が切断後に再接続できる', async (t) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  const sockets = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await new Promise((resolve) => io.close(resolve));
  });

  const host = createClient(url, { transports: ['websocket'] });
  sockets.push(host);
  await once(host, 'connect');
  const created = await ack(host, 'host:createRoom', { debug: false });
  assert.match(created.roomCode, /^[A-HJ-NP-Z2-9]{4}$/);

  await ack(host, 'host:addCpu');
  await ack(host, 'host:addCpu');
  await ack(host, 'host:addCpu');

  const player = createClient(url, { transports: ['websocket'] });
  sockets.push(player);
  await once(player, 'connect');
  const credentials = await ack(player, 'player:joinRoom', {
    roomCode: created.roomCode,
    playerName: '参加者1'
  });

  const hostStatePromise = once(host, 'host:state');
  await ack(host, 'host:startGame');
  const hostState = await hostStatePromise;
  assert.equal(hostState.day, 1);
  assert.equal(hostState.phase, 'DAY_BRIEFING');
  assert.equal(hostState.players.length, 4);
  assert.equal(hostState.players.filter((item) => item.isCpu).length, 3);
  assert.equal(JSON.stringify(hostState).includes('sessionToken'), false);

  const disconnected = sockets[1];
  disconnected.disconnect();
  const replacement = createClient(url, { transports: ['websocket'] });
  sockets.push(replacement);
  await once(replacement, 'connect');
  const playerStatePromise = once(replacement, 'player:state');
  await ack(replacement, 'player:reconnect', credentials);
  const playerState = await playerStatePromise;
  assert.equal(playerState.self.name, '参加者1');
  assert.equal(playerState.self.connected, true);
  assert.equal(playerState.others.length, 3);
  assert.equal(JSON.stringify(playerState.others).includes('evaluation'), false);
});
