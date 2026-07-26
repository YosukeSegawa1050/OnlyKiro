'use strict';

window.PrisonLab = (() => {
  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function prisoner(number) {
    return `囚人${String(number).padStart(2, '0')}`;
  }

  function toast(message, type = 'error') {
    const item = document.createElement('div');
    item.className = `toast ${type === 'ok' ? 'toast-ok' : 'toast-error'}`;
    item.textContent = message;
    document.getElementById('toasts')?.appendChild(item);
    setTimeout(() => item.remove(), 4200);
  }

  function emitAck(socket, event, payload = {}) {
    return new Promise((resolve, reject) => {
      socket.emit(event, payload, (response) => {
        if (response?.ok) resolve(response);
        else reject(new Error(response?.error || '通信に失敗しました'));
      });
    });
  }

  function formatTime(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  }

  function confirmAction(title, body, confirmLabel = 'この内容で確定') {
    return new Promise((resolve) => {
      const dialog = document.getElementById('confirm-dialog');
      if (!dialog) return resolve(window.confirm(`${title}\n\n${body}`));
      dialog.querySelector('[data-title]').textContent = title;
      dialog.querySelector('[data-body]').textContent = body;
      dialog.querySelector('[data-confirm]').textContent = confirmLabel;
      dialog.showModal();
      const finish = (answer) => {
        dialog.close();
        dialog.querySelector('[data-confirm]').onclick = null;
        dialog.querySelector('[data-cancel]').onclick = null;
        resolve(answer);
      };
      dialog.querySelector('[data-confirm]').onclick = () => finish(true);
      dialog.querySelector('[data-cancel]').onclick = () => finish(false);
    });
  }

  function alarmTone() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const context = new AudioContext();
      const now = context.currentTime;
      [0, 0.38, 0.76].forEach((offset) => {
        const osc = context.createOscillator();
        const gain = context.createGain();
        osc.type = 'square';
        osc.frequency.value = 620;
        gain.gain.setValueAtTime(0.0001, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.12, now + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.28);
        osc.connect(gain).connect(context.destination);
        osc.start(now + offset);
        osc.stop(now + offset + 0.3);
      });
    } catch {
      // 音声不可でもゲーム進行は継続する。
    }
  }

  return { escapeHtml, prisoner, toast, emitAck, formatTime, confirmAction, alarmTone };
})();
