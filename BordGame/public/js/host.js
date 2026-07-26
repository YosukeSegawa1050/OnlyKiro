'use strict';

const socket = io();
const {
  escapeHtml: e,
  prisoner,
  emitAck,
  toast,
  formatTime,
  confirmAction,
  alarmTone
} = window.PrisonLab;

const debug = new URLSearchParams(location.search).get('debug') === '1';
let state = null;
let lastScene = '';
let typewriterToken = 0;
const revealedResults = new Set();

const descriptions = {
  1: '2人1組で「協力」か「裏切り」を秘密裏に選択する。選択は全員の確定後に公開される。',
  2: '全体で6個の配給食を分ける。各囚人は0〜3個を秘密裏に要求する。合計7個以上で配給は破綻する。',
  3: '自分以外の帽子を観察し、自分の色を推理する。成功条件は正解者が1人以上、かつ不正解者が0人。',
  4: '送金者は5トークンから送金し、3倍になった額を受取人が自由に返却する。'
};

function saveHost(result) {
  localStorage.setItem('prisonLab.hostRoomCode', result.roomCode);
  localStorage.setItem('prisonLab.hostToken', result.hostToken);
}

async function createRoom() {
  const button = document.getElementById('create-room');
  button.disabled = true;
  button.textContent = '実験室を初期化中…';
  try {
    const result = await emitAck(socket, 'host:createRoom', { debug });
    saveHost(result);
  } catch (error) {
    toast(error.message);
    button.disabled = false;
    button.textContent = '実験室を作成';
  }
}

async function reconnectHost() {
  const roomCode = localStorage.getItem('prisonLab.hostRoomCode');
  const hostToken = localStorage.getItem('prisonLab.hostToken');
  if (!roomCode || !hostToken) return;
  try {
    await emitAck(socket, 'host:reconnect', { roomCode, hostToken, debug });
  } catch {
    localStorage.removeItem('prisonLab.hostRoomCode');
    localStorage.removeItem('prisonLab.hostToken');
    location.reload();
  }
}

function typeText(element, text) {
  const token = ++typewriterToken;
  element.textContent = '';
  let index = 0;
  const tick = () => {
    if (token !== typewriterToken || !element.isConnected) return;
    element.textContent = text.slice(0, index);
    index += 1;
    if (index <= text.length) setTimeout(tick, 27);
  };
  tick();
}

function statusColor(player) {
  if (!player.connected) return 'bg-red-500';
  if (player.connectionStatus === '再接続済み') return 'bg-amber-400';
  return 'bg-emerald-500';
}

function renderPlayers() {
  const players = state.players;
  document.getElementById('seat-count').textContent = `${players.length} / 4`;
  document.getElementById('players').innerHTML = [
    ...players.map((player) => `
      <div class="flex items-center justify-between border border-stone-800 bg-black/20 px-3 py-2">
        <div>
          <p class="text-xs font-bold text-amber-400">${prisoner(player.number)}</p>
          <p class="truncate text-sm">${e(player.name)} ${player.isCpu ? '<span class="ml-1 border border-cyan-800 px-1 text-[9px] font-bold text-cyan-300">CPU</span>' : ''}</p>
        </div>
        <div class="text-right text-xs text-stone-500">
          <span class="status-dot ${statusColor(player)} mr-1"></span>${e(player.connectionStatus)}
        </div>
      </div>`),
    ...Array.from({ length: 4 - players.length }, (_, index) => `
      <div class="border border-dashed border-stone-800 px-3 py-3 text-center text-xs text-stone-600">
        SLOT ${String(players.length + index + 1).padStart(2, '0')} — WAITING
      </div>`)
  ].join('');
}

function renderRanking() {
  document.getElementById('ranking').innerHTML = state.ranking.map((row) => `
    <div class="rank-row flex items-center gap-3 px-3 py-2">
      <span class="w-7 font-mono text-lg font-black text-stone-500">${row.rank}</span>
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-bold">${prisoner(row.number)} · ${e(row.name)}</p>
        <p class="text-xs text-amber-400">${e(row.band)}</p>
      </div>
    </div>`).join('') || '<p class="py-6 text-center text-sm text-stone-600">NO DATA</p>';
}

function renderSubmissions() {
  const sub = state.submission;
  document.getElementById('submitted-count').textContent = `${sub.submitted} / ${sub.expected}`;
  document.getElementById('submissions').innerHTML = sub.players.map((row) => {
    const style = !row.required
      ? 'border-stone-800 text-stone-600'
      : row.submitted
        ? 'border-emerald-800/70 bg-emerald-950/20 text-emerald-300'
        : 'border-amber-900/70 text-amber-300';
    const label = !row.required ? '待機' : row.submitted ? '回答済' : '未回答';
    return `<div class="border ${style} p-2 text-center">
      <p class="text-xs font-black">${prisoner(row.number)}</p><p class="mt-1 text-[11px]">${label}</p>
    </div>`;
  }).join('');
}

function renderResult(result) {
  if (!result) return '<p class="text-stone-500">結果データを待っています。</p>';
  if (result.kind === 'pairs') {
    return result.pairs.map((pair, index) => `
      <div class="reveal mb-4 border border-stone-700 bg-black/25 p-5" style="animation-delay:${index * .25}s">
        <p class="lab-label mb-3">Pair ${index + 1}</p>
        ${pair.players.map((player) => `<p class="my-2 text-xl font-black">${prisoner(player.number)} ${e(player.name)}
          <span class="${player.choice === 'betray' ? 'text-red-400' : 'text-emerald-400'}">— ${player.choice === 'betray' ? '裏切り' : '協力'}</span>
        </p>`).join('')}
      </div>`).join('');
  }
  if (result.kind === 'ration') {
    return `<div class="text-center">
      <p class="text-sm text-stone-500">合計取得数</p>
      <p class="my-3 text-7xl font-black ${result.success ? 'text-emerald-400' : 'text-red-400'}">${result.total}</p>
      <p class="mb-6 text-2xl font-black">${result.success ? '配給成功' : '配給破綻'}</p>
      <div class="grid grid-cols-2 gap-3">${result.entries.map((row) => `
        <div class="reveal border border-stone-700 p-3"><b>${prisoner(row.number)} ${e(row.name)}</b><p class="mt-2 text-2xl text-amber-300">${row.amount}個</p></div>
      `).join('')}</div>
    </div>`;
  }
  if (result.kind === 'hats') {
    return `<p class="mb-5 text-center text-3xl font-black ${result.success ? 'text-emerald-400' : 'text-red-400'}">
      ${result.allUnknown ? '全員「分からない」' : result.success ? '実験成功' : '実験失敗'}
    </p><div class="grid grid-cols-2 gap-3">${result.entries.map((row) => `
      <div class="reveal border border-stone-700 p-4">
        <p class="font-bold">${prisoner(row.number)} ${e(row.name)}</p>
        <p class="mt-2">帽子：<b class="${row.actual === 'red' ? 'text-red-400' : 'text-stone-100'}">${row.actual === 'red' ? '赤' : '白'}</b></p>
        <p>回答：${row.answer === 'unknown' ? '分からない' : row.answer === 'red' ? '赤' : '白'} ${row.answer !== 'unknown' ? (row.correct ? '✓' : '✕') : ''}</p>
      </div>`).join('')}</div>`;
  }
  if (result.kind === 'trust') {
    return result.pairs.map((pair, index) => `
      <div class="reveal mb-4 border border-stone-700 p-5">
        <p class="lab-label mb-3">Investment pair ${index + 1}</p>
        <p class="text-lg"><b>${prisoner(pair.sender.number)} ${e(pair.sender.name)}</b> が
          <span class="text-amber-300">${pair.sent}</span>送金 → <b>${prisoner(pair.receiver.number)} ${e(pair.receiver.name)}</b> が
          <span class="text-amber-300">${pair.returned}</span>返却</p>
        <p class="mt-3 text-sm text-stone-400">最終保有：送金者 ${pair.senderFinal} / 受取人 ${pair.receiverFinal}</p>
      </div>`).join('');
  }
  return '';
}

function renderFinal(result) {
  if (!result) return '<p class="text-center text-stone-500">最終判定を処理しています。</p>';
  const escapeDetails = result.route ? `
    <div class="mx-auto mt-6 max-w-3xl border border-stone-700 bg-black/25 p-5 text-left">
      <p class="reveal">1. 選択経路：<b class="text-amber-300">${e(result.route)}</b></p>
      <div class="mt-3 grid gap-2 sm:grid-cols-3">${result.defenses.map((row, index) => `
        <p class="reveal border ${row.matched ? 'border-emerald-700' : 'border-stone-800'} p-2 text-sm" style="animation-delay:${.35 + index * .2}s">${prisoner(row.number)}：${e(row.label)}</p>
      `).join('')}</div>
      <p class="reveal mt-4 text-sm text-stone-300" style="animation-delay:1s">3. 準備状況：
        経路 ${result.progress.route ? '達成' : '未達成'} / 突破手段 ${result.progress.tool ? '達成' : '未達成'} /
        タイミング ${result.progress.timing ? '達成' : '未達成'} / 補強 ${result.progress.reinforcement}/1 /
        最終カード ${result.finalCardUsed ? '使用' : 'なし'}</p>
      <p class="reveal mt-2 text-sm text-stone-300" style="animation-delay:1.25s">4. 監獄秩序による看守側ボーナス：+${result.orderBonus}</p>
      <p class="reveal mt-4 text-center text-xl" style="animation-delay:1.55s">5. 脱獄力 <b class="text-red-400">${result.escapePower}</b>
        <span class="mx-3 text-stone-600">VS</span> 阻止力 <b class="text-emerald-400">${result.defensePower}</b></p>
    </div>` : '';
  return `<div class="text-center">
    <p class="lab-label">Final verdict</p>
    <h2 class="mt-3 text-5xl font-black ${result.type === 'escapeSuccess' ? 'text-red-400' : 'text-emerald-400'}">${e(result.title)}</h2>
    <p class="mx-auto mt-5 max-w-2xl whitespace-pre-line text-lg leading-8 text-stone-300">${e(result.message)}</p>
    ${escapeDetails}
    <p class="lab-label mt-8">Released / Winner</p>
    <div class="mt-3 flex flex-wrap justify-center gap-4">${result.winners.map((winner) => `
      <div class="border border-amber-500/50 bg-amber-950/20 px-6 py-4">
        <p class="text-2xl font-black text-amber-300">${prisoner(winner.number)}</p><p>${e(winner.name)}</p>
      </div>`).join('')}</div>
    ${result.ranking ? `<div class="mx-auto mt-6 max-w-xl text-left">${result.ranking.map((row) => `
      <div class="flex justify-between border-b border-stone-800 py-2"><span>${row.rank}位 ${prisoner(row.number)} ${e(row.name)}</span>
      <span class="text-xs text-stone-400">${row.correction ? '最終審査補正 -15' : '補正なし'}</span></div>`).join('')}</div>` : ''}
  </div>`;
}

function renderMain() {
  const content = document.getElementById('main-content');
  const minigame = state.minigame;
  let html = '';
  if (state.phase === 'LOBBY') {
    html = `<div class="flex min-h-[480px] flex-col items-center justify-center text-center">
      <p class="lab-label">Awaiting subjects</p>
      <h2 class="mt-4 text-4xl font-black">${state.players.length < 4 ? '被験者を待機中' : '全被験者の収容を確認'}</h2>
      <p class="mt-4 text-stone-500">${state.players.length} / 4 名が接続済み</p>
      <div class="mt-8 flex gap-2">${Array.from({ length: 4 }, (_, i) => `<span class="h-3 w-12 ${i < state.players.length ? 'bg-amber-500' : 'bg-stone-800'}"></span>`).join('')}</div>
    </div>`;
  } else if (state.phase === 'DAY_BRIEFING') {
    html = `<div class="flex min-h-[480px] flex-col justify-center">
      <p class="lab-label">Warden broadcast / Day ${state.day}</p>
      <h2 class="mt-4 text-4xl font-black text-amber-300">看守放送</h2>
      <p id="briefing-text" class="typewriter mt-10 border-l-4 border-amber-500 pl-6 text-3xl font-bold leading-relaxed"></p>
    </div>`;
  } else if (['MINIGAME_INTRO', 'PREPARATION', 'MINIGAME_INPUT', 'MINIGAME_SECOND_INPUT'].includes(state.phase)) {
    html = `<div>
      <p class="lab-label">Psychological experiment / Day ${state.day}</p>
      <h2 class="mt-3 text-4xl font-black">${e(minigame?.title)}</h2>
      <p class="mt-7 max-w-4xl border-l-4 border-amber-500 pl-5 text-xl leading-9 text-stone-300">${e(descriptions[state.day])}</p>
      <div class="mt-10 grid grid-cols-2 gap-4">
        <div class="border border-stone-800 p-5"><p class="lab-label">Status</p><p class="mt-2 text-2xl font-black text-amber-300">${e(state.phaseLabel)}</p></div>
        <div class="border border-stone-800 p-5"><p class="lab-label">Responses</p><p class="mt-2 text-2xl font-black">${state.submission.submitted} / ${state.submission.expected}</p></div>
      </div>
      ${state.submission.allSubmitted ? '<p class="mt-8 border border-emerald-700 bg-emerald-950/20 p-4 text-center text-xl font-black text-emerald-300">全員回答済み — 結果公開を待機</p>' : ''}
    </div>`;
  } else if (state.phase === 'MINIGAME_RESULT') {
    const revealKey = `${state.day}:${state.phase}`;
    if (!revealedResults.has(revealKey)) {
      html = `<div class="flex min-h-[480px] flex-col items-center justify-center text-center">
        <p class="lab-label">Result verification</p><h2 class="mt-4 text-3xl font-black">回答を照合中</h2>
        <p id="reveal-countdown" class="mt-8 font-mono text-7xl font-black text-amber-400">3</p>
      </div>`;
      setTimeout(() => {
        const counter = document.getElementById('reveal-countdown');
        if (counter) counter.textContent = '2';
      }, 700);
      setTimeout(() => {
        const counter = document.getElementById('reveal-countdown');
        if (counter) counter.textContent = '1';
      }, 1400);
      setTimeout(() => {
        if (state?.phase !== 'MINIGAME_RESULT' || `${state.day}:${state.phase}` !== revealKey) return;
        revealedResults.add(revealKey);
        content.innerHTML = `<p class="lab-label">Declassified result</p><h2 class="mb-7 mt-2 text-3xl font-black">${e(state.minigame?.title)}・結果</h2>${renderResult(state.minigameResult)}`;
      }, 2200);
    } else {
      html = `<p class="lab-label">Declassified result</p><h2 class="mb-7 mt-2 text-3xl font-black">${e(minigame?.title)}・結果</h2>${renderResult(state.minigameResult)}`;
    }
  } else if (state.phase === 'NIGHT_ACTION') {
    html = `<div class="flex min-h-[480px] flex-col items-center justify-center text-center">
      <p class="lab-label">Lights out</p><h2 class="mt-4 text-5xl font-black text-stone-200">消灯時間</h2>
      <p class="mt-5 text-xl text-stone-500">各囚人は秘密裏に夜間行動を選択している。</p>
      <p class="mt-10 font-mono text-5xl">${state.submission.submitted} / ${state.submission.expected}</p>
    </div>`;
  } else if (state.phase === 'NIGHT_RESULT') {
    html = `<p class="lab-label">Night incident log</p><h2 class="mt-3 text-4xl font-black">夜間事件</h2>
      <div class="mt-8 grid gap-4">${state.nightEvents.map((event, index) => `
        <div class="reveal border-l-4 border-red-800 bg-black/30 p-5 text-xl" style="animation-delay:${index * .35}s">${e(event)}</div>
      `).join('')}</div>`;
  } else if (state.phase === 'EVALUATION') {
    html = `<p class="lab-label">Daily assessment</p><h2 class="mt-3 text-4xl font-black">第${state.day}日 評価発表</h2>
      <div class="mx-auto mt-8 max-w-3xl space-y-3">${state.ranking.map((row) => `
        <div class="rank-row reveal flex items-center px-5 py-4">
          <span class="w-16 font-mono text-3xl font-black">${row.rank}</span>
          <span class="flex-1 text-xl font-bold">${prisoner(row.number)}　${e(row.name)}</span>
          <span class="text-lg text-amber-300">${e(row.band)}</span>
        </div>`).join('')}</div>`;
  } else if (state.phase === 'ESCAPE_OFFER') {
    html = `<div class="flex min-h-[480px] flex-col items-center justify-center text-center">
      <p class="lab-label">Private assessment in progress</p><h2 class="mt-4 text-4xl font-black">個別面談</h2>
      <p class="mt-5 text-xl text-stone-500">一部の囚人端末に、非公開の選択肢を送信した。</p>
    </div>`;
  } else if (state.phase === 'FINAL_JUDGMENT') {
    html = `<div class="flex min-h-[480px] flex-col items-center justify-center text-center">
      <p class="lab-label">Final judgment</p><h2 class="mt-4 text-5xl font-black">最終審査</h2>
      <p class="mt-6 text-xl text-stone-500">全記録を照合中。囚人は端末を確認せよ。</p>
    </div>`;
  } else if (['ESCAPE_ROUTE_SELECT', 'ESCAPE_DEFENSE'].includes(state.phase)) {
    html = `<div class="flex min-h-[480px] flex-col items-center justify-center text-center">
      <p class="lab-label text-red-400">Security breach / Code red</p>
      <h2 class="alarm-text mt-4 text-7xl font-black">警報</h2>
      <p class="mt-8 text-3xl font-black">監視システムに異常を検知</p>
      <p class="mt-3 text-2xl text-red-300">囚人の脱走を確認</p>
      <p class="mt-10 text-stone-400">${state.phase === 'ESCAPE_DEFENSE' ? '全囚人へ緊急阻止命令を送信' : '脱走経路を解析中'}</p>
    </div>`;
  } else if (['ESCAPE_RESULT', 'GAME_RESULT'].includes(state.phase)) {
    html = renderFinal(state.finalResult);
  }
  content.innerHTML = html;
  if (state.phase === 'DAY_BRIEFING') typeText(document.getElementById('briefing-text'), state.briefing);
}

function renderDebug() {
  const panel = document.getElementById('debug-panel');
  if (!debug || !state.debug) return panel.classList.add('hidden');
  panel.classList.remove('hidden');
  const phases = ['LOBBY','DAY_BRIEFING','MINIGAME_INTRO','PREPARATION','MINIGAME_INPUT','MINIGAME_SECOND_INPUT','MINIGAME_RESULT','NIGHT_ACTION','NIGHT_RESULT','EVALUATION','ESCAPE_OFFER','FINAL_JUDGMENT','ESCAPE_ROUTE_SELECT','ESCAPE_DEFENSE','ESCAPE_RESULT','GAME_RESULT'];
  const cards = ['medicine','thread','patrol','keyMold','wiring','spoon'];
  document.getElementById('debug-content').innerHTML = `
    <div class="grid gap-3 xl:grid-cols-2">${state.debug.players.map((player) => `
      <div class="border border-stone-800 p-3 text-xs">
        <p class="mb-2 font-bold text-amber-300">${prisoner(player.number)} ${e(player.name)} ${player.isEscapePlanner ? '⚠ 計画者' : ''}</p>
        <p class="mb-2 text-stone-500">評価 ${player.evaluation} / ストレス ${player.stress} / 疑惑 ${player.suspicion} / 手札 ${e(player.cards.join('・') || 'なし')}</p>
        <div class="grid grid-cols-3 gap-2">
          ${['evaluation','stress','suspicion'].map((key) => `<div><input id="debug-${key}-${player.id}" class="input min-h-0 py-1" type="number" value="${player[key]}">
          <button class="btn btn-ghost mt-1 min-h-0 w-full py-1" data-debug="${key}" data-player="${player.id}">${key === 'evaluation' ? '評価' : key === 'stress' ? 'ストレス' : '疑惑'}変更</button></div>`).join('')}
        </div>
        <div class="mt-2 flex gap-2"><select id="debug-card-${player.id}" class="input min-h-0 py-1">${cards.map((card) => `<option value="${card}">${card}</option>`).join('')}</select>
        <button class="btn btn-ghost min-h-0 py-1" data-debug="giveCard" data-player="${player.id}">付与</button>
        <button class="btn btn-ghost min-h-0 py-1" data-debug="offerEscape" data-player="${player.id}">提案</button>
        <button class="btn btn-danger min-h-0 py-1" data-debug="makePlanner" data-player="${player.id}">計画者</button></div>
      </div>`).join('')}</div>
    <div class="mt-3 flex flex-wrap gap-2">
      <input id="debug-order" class="input w-24" type="number" value="${state.order}">
      <button class="btn btn-ghost" data-debug="order">秩序変更</button>
      <select id="debug-day" class="input w-28">${[1,2,3,4].map((day) => `<option ${day === state.day ? 'selected' : ''}>${day}</option>`).join('')}</select>
      <button class="btn btn-ghost" data-debug="day">日数変更</button>
      <select id="debug-phase" class="input w-56">${phases.map((phase) => `<option ${phase === state.phase ? 'selected' : ''}>${phase}</option>`).join('')}</select>
      <button class="btn btn-ghost" data-debug="phase">フェーズ変更</button>
      <button class="btn btn-ghost" data-debug="autoSubmit">全回答を自動入力</button>
      <button class="btn btn-danger" data-debug="skipFinalEscape">最終脱獄へスキップ</button>
    </div>`;
}

function render(next) {
  state = next;
  document.getElementById('create-screen').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
  document.getElementById('room-code').textContent = state.roomCode;
  document.getElementById('day').textContent = state.day ? `${state.day} / 4` : '待機';
  document.getElementById('phase').textContent = state.phaseLabel;
  document.getElementById('timer').textContent = formatTime(state.timer.remaining);
  document.getElementById('join-url').textContent = state.joinUrl;
  document.getElementById('qr-code').src = state.qrDataUrl || '';
  document.getElementById('qr-code').alt = state.qrDataUrl ? '参加用QRコード' : 'QRコードを生成できませんでした';
  document.getElementById('order-value').textContent = state.order;
  document.getElementById('order-fill').style.width = `${state.order}%`;
  const alarm = ['ESCAPE_ROUTE_SELECT', 'ESCAPE_DEFENSE', 'ESCAPE_RESULT'].includes(state.phase);
  document.body.classList.toggle('alarm-mode', alarm);
  document.getElementById('main-panel').classList.toggle('alarm-panel', alarm);
  renderPlayers();
  renderRanking();
  renderSubmissions();
  renderMain();
  renderDebug();
  document.getElementById('start-game').disabled = !state.canStart;
  document.getElementById('advance-phase').disabled = ['LOBBY', 'GAME_RESULT'].includes(state.phase);
  const cpuCount = state.players.filter((player) => player.isCpu).length;
  document.getElementById('cpu-controls').classList.toggle('hidden', state.phase !== 'LOBBY');
  document.getElementById('add-cpu').disabled = state.phase !== 'LOBBY' || cpuCount >= 3 || state.players.length >= 4;
  document.getElementById('remove-cpu').disabled = state.phase !== 'LOBBY' || cpuCount === 0;
  if (state.phase !== lastScene && state.phase === 'ESCAPE_ROUTE_SELECT') alarmTone();
  lastScene = state.phase;
}

async function hostAction(event, payload = {}) {
  try {
    await emitAck(socket, event, payload);
  } catch (error) {
    toast(error.message);
  }
}

document.getElementById('create-room').addEventListener('click', createRoom);
document.getElementById('start-game').addEventListener('click', () => hostAction('host:startGame'));
document.getElementById('add-cpu').addEventListener('click', () => hostAction('host:addCpu'));
document.getElementById('remove-cpu').addEventListener('click', () => hostAction('host:removeCpu'));
document.getElementById('advance-phase').addEventListener('click', () => hostAction('host:advancePhase'));
document.getElementById('start-timer').addEventListener('click', () => hostAction('host:startTimer'));
document.getElementById('pause-timer').addEventListener('click', () => hostAction('host:pauseTimer'));
document.getElementById('reset-timer').addEventListener('click', () => hostAction('host:resetTimer', { seconds: 90 }));
document.getElementById('refresh-phase').addEventListener('click', () => {
  renderMain();
  toast('現在フェーズを再表示しました', 'ok');
});
document.getElementById('show-missing').addEventListener('click', () => {
  if (!state) return;
  const missing = state.submission.players.filter((item) => item.required && !item.submitted);
  toast(missing.length ? `未回答：${missing.map((item) => prisoner(item.number)).join('、')}` : '未回答者はいません', missing.length ? 'error' : 'ok');
});
document.getElementById('restart-game').addEventListener('click', async () => {
  if (await confirmAction('実験を初期化', '全進行状況とゲーム内データを消去し、同じ4名でロビーへ戻します。', '最初からやり直す')) {
    hostAction('host:restartGame');
  }
});
document.getElementById('edit-url').addEventListener('click', async () => {
  const currentBase = state.joinUrl.split('/?room=')[0];
  const baseUrl = window.prompt('参加URLのベースを入力してください', currentBase);
  if (baseUrl) hostAction('host:updateJoinUrl', { baseUrl });
});

document.getElementById('debug-panel').addEventListener('click', (event) => {
  const button = event.target.closest('[data-debug]');
  if (!button) return;
  const action = button.dataset.debug;
  const playerId = button.dataset.player;
  const payload = { action, ...(playerId ? { playerId } : {}) };
  if (['evaluation','stress','suspicion'].includes(action)) payload.value = Number(document.getElementById(`debug-${action}-${playerId}`).value);
  if (action === 'giveCard') payload.cardType = document.getElementById(`debug-card-${playerId}`).value;
  if (action === 'order') payload.value = Number(document.getElementById('debug-order').value);
  if (action === 'day') payload.value = Number(document.getElementById('debug-day').value);
  if (action === 'phase') payload.value = document.getElementById('debug-phase').value;
  hostAction('debug:action', payload);
});

socket.on('host:state', render);
socket.on('game:timer', (timer) => {
  if (!state) return;
  state.timer = { ...state.timer, ...timer };
  document.getElementById('timer').textContent = formatTime(timer.remaining);
});
socket.on('game:error', ({ message }) => toast(message));
socket.on('connect', reconnectHost);
