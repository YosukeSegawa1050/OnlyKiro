'use strict';

const socket = io();
const { emitAck, toast } = window.PrisonLab;
const form = document.getElementById('join-form');
const roomInput = document.getElementById('room-code');
const nameInput = document.getElementById('player-name');
const joinButton = document.getElementById('join-button');
const queryRoom = new URLSearchParams(location.search).get('room');

if (queryRoom) roomInput.value = queryRoom.toUpperCase();
const savedName = localStorage.getItem('prisonLab.playerName');
if (savedName) nameInput.value = savedName;

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  joinButton.disabled = true;
  joinButton.textContent = '照合中…';
  try {
    const result = await emitAck(socket, 'player:joinRoom', {
      roomCode: roomInput.value.trim().toUpperCase(),
      playerName: nameInput.value.trim()
    });
    localStorage.setItem('prisonLab.roomCode', result.roomCode);
    localStorage.setItem('prisonLab.playerId', result.playerId);
    localStorage.setItem('prisonLab.sessionToken', result.sessionToken);
    localStorage.setItem('prisonLab.playerName', result.playerName);
    location.href = '/player';
  } catch (error) {
    toast(error.message);
    joinButton.disabled = false;
    joinButton.textContent = '収容手続きを開始';
  }
});

socket.on('game:error', ({ message }) => toast(message));
