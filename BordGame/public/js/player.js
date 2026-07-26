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

const credentials = {
  roomCode: localStorage.getItem('prisonLab.roomCode'),
  playerId: localStorage.getItem('prisonLab.playerId'),
  sessionToken: localStorage.getItem('prisonLab.sessionToken')
};
let state = null;
let lastPhase = '';

if (!credentials.roomCode || !credentials.playerId || !credentials.sessionToken) location.replace('/');

function optionButtons(options, eventName, field = 'value') {
  return `<div class="choice-grid mt-5">${options.map((option) => `
    <button class="btn min-h-[56px]" data-submit="${eventName}" data-field="${field}" data-value="${e(option.value)}" data-label="${e(option.label)}">${e(option.label)}</button>
  `).join('')}</div>`;
}

function lockedAnswer(text) {
  return `<div class="mt-5 border border-emerald-800 bg-emerald-950/20 p-4 text-center">
    <p class="lab-label text-emerald-500">Response locked</p><p class="mt-2 font-bold text-emerald-300">${e(text)}</p>
    <p class="mt-2 text-xs text-stone-500">ほかの囚人の回答を待っています。</p>
  </div>`;
}

function renderPrivate() {
  const self = state.self;
  const messages = [];
  if (self.preview) messages.push(`先行情報：次の心理実験は「${self.preview}」`);
  messages.push(...self.privateMessages.slice(-4));
  if (self.isEscapePlanner) {
    const progress = self.escapeProgress;
    messages.push(`脱獄準備　経路：${progress.route ? '達成' : '未達成'} / 突破手段：${progress.tool ? '達成' : '未達成'} / タイミング：${progress.timing ? '達成' : '未達成'} / 補強：${progress.reinforcement}/1`);
  }
  const panel = document.getElementById('private-panel');
  panel.classList.toggle('hidden', messages.length === 0);
  panel.innerHTML = messages.length ? `
    <p class="lab-label text-amber-400">🔒 Private / 機密情報</p>
    <div class="mt-2 grid gap-2">${messages.map((message) => `<p class="text-sm leading-6">${e(message)}</p>`).join('')}</div>` : '';
}

function renderDiscard() {
  const warning = document.getElementById('discard-warning');
  if (!state.self.mustDiscard) {
    warning.classList.add('hidden');
    return;
  }
  warning.classList.remove('hidden');
  warning.innerHTML = `<p class="font-black text-red-300">手札上限を超過：${state.self.mustDiscard}枚捨ててください</p>
    <div class="mt-3 grid gap-2">${state.self.cards.map((card) => `
      <button class="btn btn-danger text-left" data-discard="${card.id}">${e(card.name)}を捨てる</button>
    `).join('')}</div>`;
}

function renderCards() {
  const canUse = ['PREPARATION', 'NIGHT_ACTION'].includes(state.phase) && !state.self.cardUsedToday;
  document.getElementById('card-count').textContent = `${state.self.cards.length} / 5`;
  document.getElementById('cards').innerHTML = state.self.cards.length ? state.self.cards.map((card) => `
    <article class="item-card">
      <p class="lab-label">Contraband</p>
      <h3 class="mt-2 font-black text-amber-300">${e(card.name)}</h3>
      <p class="mt-3 text-xs leading-5 text-stone-400">${e(card.normal)}</p>
      ${card.escapeLabel ? `<p class="mt-3 border-t border-stone-700 pt-2 text-xs text-red-300">脱獄用途：${e(card.escapeLabel)}</p>` : ''}
      <button class="btn btn-ghost mt-4 w-full text-xs" data-use-card="${card.id}" ${canUse ? '' : 'disabled'}>通常効果で使用</button>
    </article>`).join('') : '<p class="w-full py-6 text-center text-sm text-stone-600">手札はありません</p>';
}

function minigameAction() {
  const view = state.minigameView;
  const self = state.self;
  if (state.phase === 'MINIGAME_INTRO') {
    const extra = state.day === 3 && view.visibleHats ? `<div class="mt-5 grid grid-cols-3 gap-2">${view.visibleHats.map((hat) => `
      <div class="border border-stone-700 p-3 text-center">
        <div class="mx-auto mb-2 h-8 w-12 rounded-t-full border-2 ${hat.color === 'red' ? 'border-red-500 bg-red-600' : 'border-stone-300 bg-stone-100'}"></div>
        <p class="text-xs">${prisoner(hat.number)}<br>${e(hat.name)}</p>
      </div>`).join('')}</div>` : '';
    return `<p class="lab-label">Experiment briefing</p><h2 class="mt-2 text-2xl font-black">${e(view.title)}</h2>
      <p class="mt-4 text-sm leading-6 text-stone-400">中央監視画面の説明を確認し、口頭で相談してください。</p>${extra}`;
  }
  if (state.phase === 'PREPARATION') {
    return `<p class="lab-label">Preparation</p><h2 class="mt-2 text-2xl font-black">準備時間</h2>
      <p class="mt-3 text-sm leading-6 text-stone-400">必要なら手札から通常効果を1枚使用できます。相談は口頭で行ってください。</p>`;
  }
  if (state.phase === 'MINIGAME_INPUT') {
    if (state.day === 4 && view.role !== 'sender') {
      return `<p class="lab-label">Trust experiment</p><h2 class="mt-2 text-2xl font-black">あなたは受取人</h2>
        <p class="mt-4 text-stone-400">送金者 ${e(view.partner?.name)} の選択確定を待っています。</p>`;
    }
    if (self.minigameInput !== null) {
      const label = view.options.find((item) => String(item.value) === String(self.minigameInput))?.label || self.minigameInput;
      return `<h2 class="text-2xl font-black">${e(view.title)}</h2>${lockedAnswer(label)}`;
    }
    const context = view.partner ? `<p class="mt-2 text-sm text-stone-400">相手：${prisoner(view.partner.number)} ${e(view.partner.name)}</p>` : '';
    const hats = state.day === 3 ? `<div class="mt-4 grid grid-cols-3 gap-2">${view.visibleHats.map((hat) => `
      <div class="border border-stone-700 p-2 text-center"><div class="mx-auto h-8 w-11 rounded-t-full ${hat.color === 'red' ? 'bg-red-600' : 'bg-stone-100'}"></div>
      <p class="mt-2 text-[11px]">${prisoner(hat.number)}<br>${e(hat.name)}</p></div>`).join('')}</div>` : '';
    return `<p class="lab-label">Secret input</p><h2 class="mt-2 text-2xl font-black">${e(view.title)}</h2>${context}${hats}
      ${optionButtons(view.options, 'player:submitMinigame')}`;
  }
  if (state.phase === 'MINIGAME_SECOND_INPUT') {
    if (view.role !== 'receiver') return `<h2 class="text-2xl font-black">送金済み</h2>${lockedAnswer(`${self.minigameInput}トークンを送金`)}`;
    if (self.minigameSecondInput !== null) return `<h2 class="text-2xl font-black">返却数を確定済み</h2>${lockedAnswer(`${self.minigameSecondInput}トークン返却`)}`;
    return `<p class="lab-label">Return decision</p><h2 class="mt-2 text-2xl font-black">受取人の選択</h2>
      <p class="mt-4 text-sm">送金額：<b class="text-amber-300">${view.sent}</b>　3倍後：<b class="text-amber-300">${view.received}</b></p>
      ${optionButtons(view.secondOptions, 'player:submitSecondMinigame')}`;
  }
  return '';
}

function nightAction() {
  if (state.self.nightAction) {
    const labels = { rest: '休息', search: '物資を探す', inform: '密告', observe: '観察', transfer: 'カードを渡す', escapePrep: '脱獄準備' };
    return `<p class="lab-label">Lights out</p><h2 class="mt-2 text-2xl font-black">夜間行動</h2>${lockedAnswer(labels[state.self.nightAction.type])}`;
  }
  const targetOptions = state.others.map((other) => `<option value="${other.id}">${prisoner(other.number)} ${e(other.name)}${other.isCpu ? '［CPU］' : ''}</option>`).join('');
  const cardOptions = state.self.cards.map((card) => `<option value="${card.id}">${e(card.name)}</option>`).join('');
  return `<p class="lab-label">Secret night action</p><h2 class="mt-2 text-2xl font-black">夜間行動を選択</h2>
    <div class="mt-5 grid gap-3">
      <button class="btn text-left" data-night="rest" data-label="休息">休息 <span class="block text-xs font-normal text-stone-400">ストレス −2</span></button>
      <button class="btn text-left" data-night="search" data-label="物資を探す">物資を探す <span class="block text-xs font-normal text-stone-400">カード＋1、疑惑度＋1</span></button>
      <div class="border border-stone-700 p-3"><b>密告</b><select id="inform-target" class="input my-2">${targetOptions}</select><button class="btn w-full" data-night="inform" data-target-select="inform-target" data-label="密告">この囚人を密告</button></div>
      <div class="border border-stone-700 p-3"><b>観察</b><select id="observe-target" class="input my-2">${targetOptions}</select><button class="btn w-full" data-night="observe" data-target-select="observe-target" data-label="観察">この囚人を観察</button></div>
      <div class="border border-stone-700 p-3"><b>カードを渡す</b>
        <select id="transfer-target" class="input my-2">${targetOptions}</select>
        <select id="transfer-card" class="input mb-2">${cardOptions || '<option value="">手札なし</option>'}</select>
        <button class="btn w-full" data-night="transfer" data-target-select="transfer-target" data-card-select="transfer-card" data-label="カードを渡す" ${state.self.cards.length ? '' : 'disabled'}>秘密裏に渡す</button>
      </div>
      ${state.self.isEscapePlanner ? `<div class="border border-red-800 bg-red-950/10 p-3"><b class="text-red-300">🔒 脱獄準備</b>
        <select id="escape-card" class="input my-2">${cardOptions || '<option value="">手札なし</option>'}</select>
        <button class="btn btn-danger w-full" data-night="escapePrep" data-card-select="escape-card" data-label="脱獄準備" ${state.self.cards.length ? '' : 'disabled'}>カードを計画へ使用</button>
      </div>` : ''}
    </div>`;
}

function actionContent() {
  const self = state.self;
  if (state.phase === 'LOBBY') return `<p class="lab-label">Containment status</p><h2 class="mt-2 text-2xl font-black">収容手続き完了</h2><p class="mt-3 text-sm text-stone-400">4名が揃い、ホストが実験を開始するまで待機してください。</p>`;
  if (state.phase === 'DAY_BRIEFING') return `<p class="lab-label">Warden broadcast</p><h2 class="mt-2 text-2xl font-black">第${state.day}日 看守放送</h2><p class="mt-4 border-l-2 border-amber-500 pl-4 text-sm leading-7">${e(state.briefing)}</p>`;
  if (['MINIGAME_INTRO','PREPARATION','MINIGAME_INPUT','MINIGAME_SECOND_INPUT'].includes(state.phase)) return minigameAction();
  if (state.phase === 'MINIGAME_RESULT') return `<p class="lab-label">Result published</p><h2 class="mt-2 text-2xl font-black">${e(state.minigameView.title)} 結果</h2><p class="mt-3 text-sm text-stone-400">選択内容と結果は中央監視画面で公開されています。</p>`;
  if (state.phase === 'NIGHT_ACTION') return nightAction();
  if (state.phase === 'NIGHT_RESULT') return `<p class="lab-label">Night report</p><h2 class="mt-2 text-2xl font-black">夜間事件</h2><div class="mt-4 grid gap-2">${state.nightEvents.map((message) => `<p class="border-l-2 border-red-700 pl-3 text-sm">${e(message)}</p>`).join('')}</div>`;
  if (state.phase === 'EVALUATION') return `<p class="lab-label">Daily assessment</p><h2 class="mt-2 text-2xl font-black">評価発表</h2><p class="mt-4 text-sm text-stone-400">あなたの正確な評価は <b class="text-amber-300">${self.evaluation}</b>。全体順位は中央監視画面に表示されています。</p>`;
  if (state.phase === 'ESCAPE_OFFER') {
    if (!self.escapeOfferPending) return `<h2 class="text-2xl font-black">個別面談中</h2><p class="mt-3 text-stone-500">あなたへの通達はありません。</p>`;
    if (self.escapeChoice) return `<h2 class="text-2xl font-black">秘密の選択</h2>${lockedAnswer(self.escapeChoice === 'escape' ? '別の出口を探す' : '正規の釈放を目指す')}`;
    return `<p class="lab-label text-red-400">🔒 Private proposal</p><h2 class="mt-2 text-2xl font-black">正規の方法で釈放される可能性は低い。</h2>
      <p class="mt-4 text-sm leading-6 text-stone-400">看守の評価を取り戻しますか。それとも、別の出口を探しますか。</p>
      ${optionButtons([{ value: 'regular', label: '正規の釈放を目指す' }, { value: 'escape', label: '別の出口を探す' }], 'player:submitEscapeChoice', 'choice')}`;
  }
  if (state.phase === 'FINAL_JUDGMENT') {
    if (!self.isEscapePlanner) return `<p class="lab-label">Final judgment</p><h2 class="mt-2 text-2xl font-black">最終審査</h2><p class="mt-3 text-stone-500">判定を待っています。</p>`;
    if (self.finalEscapeDecision) return `<h2 class="text-2xl font-black">最終決断</h2>${lockedAnswer(self.finalEscapeDecision === 'execute' ? '脱獄を実行する' : '計画を放棄する')}`;
    return `<p class="lab-label text-red-400">🔒 Point of no return</p><h2 class="mt-2 text-2xl font-black">最終審査が始まる。</h2>
      <p class="mt-4 text-sm leading-6 text-stone-400">ここで脱獄を実行すれば、正規の釈放資格は失われる。計画を実行しますか。</p>
      ${optionButtons([{ value: 'execute', label: '脱獄を実行する' }, { value: 'abandon', label: '計画を放棄する' }], 'player:submitEscapeChoice', 'choice')}`;
  }
  if (state.phase === 'ESCAPE_ROUTE_SELECT') {
    if (!self.isEscapePlanner) return `<h2 class="alarm-text text-3xl font-black">警報発令</h2><p class="mt-3 text-stone-400">脱獄者が経路を選択している。</p>`;
    if (self.finalEscapeRoute) return `<h2 class="text-2xl font-black">脱出経路</h2>${lockedAnswer('経路を確定済み')}`;
    return `<p class="lab-label text-red-400">🔒 Escape route</p><h2 class="alarm-text mt-2 text-3xl font-black">脱出経路を選択</h2>
      <div class="mt-5 grid gap-3">${state.escapeRoutes.map((route) => {
        const category = { underground: 'route', delivery: 'tool', medical: 'timing' }[route.value];
        const compatible = self.cards.filter((card) => card.escapeCategory === category);
        return `<div class="border border-red-900/60 p-3"><b>${e(route.label)}</b>
          <select id="route-card-${route.value}" class="input my-2"><option value="">追加カードを使わない</option>${compatible.map((card) => `<option value="${card.id}">${e(card.name)}を追加使用</option>`).join('')}</select>
          <button class="btn btn-danger w-full" data-route="${route.value}" data-label="${e(route.label)}">この経路を選択</button></div>`;
      }).join('')}</div>`;
  }
  if (state.phase === 'ESCAPE_DEFENSE') {
    if (self.isEscapePlanner) return `<h2 class="alarm-text text-3xl font-black">脱走実行中</h2><p class="mt-3 text-stone-400">阻止側の行動確定を待っています。</p>`;
    if (self.finalDefenseChoice) return `<h2 class="text-2xl font-black">阻止行動</h2>${lockedAnswer('行動を確定済み')}`;
    return `<p class="lab-label text-red-400">Emergency order</p><h2 class="alarm-text mt-2 text-3xl font-black">脱獄を阻止せよ</h2>
      <p class="mt-3 text-sm text-stone-400">ほかの囚人と口頭で相談し、行動を1つ選択してください。</p>
      ${optionButtons(state.defenseOptions, 'player:submitFinalDefense', 'choice')}`;
  }
  if (['ESCAPE_RESULT','GAME_RESULT'].includes(state.phase)) {
    const result = state.finalResult;
    const won = result?.winners.some((winner) => winner.id === self.id);
    return `<p class="lab-label">Final verdict</p><h2 class="mt-2 text-4xl font-black ${won ? 'text-emerald-400' : 'text-red-400'}">${won ? '勝利' : '敗北'}</h2>
      <p class="mt-3 text-xl font-bold">${e(result?.title || '判定中')}</p><p class="mt-4 text-sm leading-6 text-stone-400">${e(result?.message || '')}</p>`;
  }
  return `<p class="text-stone-500">進行を待っています。</p>`;
}

function render(next) {
  state = next;
  const self = state.self;
  document.getElementById('identity').textContent = prisoner(self.number);
  document.getElementById('player-name').textContent = self.name;
  document.getElementById('day').textContent = state.day ? `DAY ${state.day} / 4` : 'LOBBY';
  document.getElementById('phase').textContent = state.phaseLabel;
  document.getElementById('evaluation').textContent = self.evaluation;
  document.getElementById('evaluation-band').textContent = self.evaluationBand;
  document.getElementById('stress').textContent = self.stress;
  document.getElementById('stress-band').textContent = self.stressBand;
  document.getElementById('suspicion').textContent = self.suspicion;
  document.getElementById('suspicion-band').textContent = self.suspicionBand;
  document.getElementById('order').textContent = state.order;
  document.getElementById('order-fill').style.width = `${state.order}%`;
  const alarm = ['ESCAPE_ROUTE_SELECT','ESCAPE_DEFENSE','ESCAPE_RESULT'].includes(state.phase);
  document.body.classList.toggle('alarm-mode', alarm);
  document.getElementById('action-panel').classList.toggle('alarm-panel', alarm);
  document.getElementById('action-panel').innerHTML = actionContent();
  renderPrivate();
  renderDiscard();
  renderCards();
  if (state.phase === 'ESCAPE_ROUTE_SELECT' && lastPhase !== state.phase) alarmTone();
  lastPhase = state.phase;
}

async function submit(event, payload, label) {
  if (!await confirmAction('選択内容の確認', label, 'この内容で確定')) return;
  try {
    await emitAck(socket, event, payload);
    toast('選択を確定しました', 'ok');
  } catch (error) {
    toast(error.message);
  }
}

document.getElementById('action-panel').addEventListener('click', (event) => {
  const basic = event.target.closest('[data-submit]');
  if (basic) {
    const valueText = basic.dataset.value;
    const value = /^-?\d+$/.test(valueText) ? Number(valueText) : valueText;
    submit(basic.dataset.submit, { [basic.dataset.field]: value }, basic.dataset.label);
    return;
  }
  const night = event.target.closest('[data-night]');
  if (night) {
    const payload = { type: night.dataset.night };
    if (night.dataset.targetSelect) payload.targetId = document.getElementById(night.dataset.targetSelect).value;
    if (night.dataset.cardSelect) payload.cardId = document.getElementById(night.dataset.cardSelect).value;
    submit('player:submitNightAction', payload, night.dataset.label);
    return;
  }
  const route = event.target.closest('[data-route]');
  if (route) {
    const cardId = document.getElementById(`route-card-${route.dataset.route}`).value;
    submit('player:submitFinalEscape', { route: route.dataset.route, ...(cardId ? { cardId } : {}) }, `${route.dataset.label}${cardId ? '（追加カード使用）' : ''}`);
  }
});

document.getElementById('cards').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-use-card]');
  if (!button || !state) return;
  const card = state.self.cards.find((item) => item.id === button.dataset.useCard);
  if (!card) return;
  let discardCardId;
  if (['keyMold','spoon'].includes(card.type)) {
    const choices = state.self.cards.map((item, index) => `${index + 1}: ${item.name}`).join('\n');
    const answer = window.prompt(`捨てるカードの番号を入力してください。\n${choices}`, '1');
    if (!answer) return;
    const selected = state.self.cards[Number(answer) - 1];
    if (!selected) return toast('カード番号が無効です');
    discardCardId = selected.id;
  }
  if (!await confirmAction(`${card.name}を使用`, card.normal, 'カードを使用')) return;
  try {
    await emitAck(socket, 'player:useCard', { cardId: card.id, ...(discardCardId ? { discardCardId } : {}) });
    toast('カード効果を適用しました', 'ok');
  } catch (error) {
    toast(error.message);
  }
});

document.getElementById('discard-warning').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-discard]');
  if (!button) return;
  if (!await confirmAction('手札を破棄', '選択したカードは失われます。', '捨てる')) return;
  try {
    await emitAck(socket, 'player:discardCard', { cardId: button.dataset.discard });
  } catch (error) {
    toast(error.message);
  }
});

socket.on('connect', async () => {
  document.getElementById('connection').innerHTML = '<span class="status-dot bg-amber-400"></span><span>認証中</span>';
  try {
    await emitAck(socket, 'player:reconnect', credentials);
    document.getElementById('connection').innerHTML = '<span class="status-dot bg-emerald-500"></span><span>接続中</span>';
  } catch (error) {
    toast(error.message);
    setTimeout(() => location.replace(`/?room=${encodeURIComponent(credentials.roomCode || '')}`), 1800);
  }
});
socket.on('disconnect', () => {
  document.getElementById('connection').innerHTML = '<span class="status-dot bg-red-500"></span><span>再接続中</span>';
});
socket.on('player:state', render);
socket.on('game:error', ({ message }) => toast(message));
