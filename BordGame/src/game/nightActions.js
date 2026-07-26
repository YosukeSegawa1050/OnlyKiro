'use strict';

const { evaluationBand, stressBand, suspicionBand } = require('./constants');
const { CARD_TYPES, drawCard, discardById, randomDiscard } = require('./cards');
const { changeEvaluation } = require('./minigames');
const { clampRoom } = require('../utils/clamp');

const ESCAPE_EVENTS = [
  '東棟の監視カメラが一時的に停止した。',
  '医務室から薬品が紛失した。',
  '作業場で工具の不足が確認された。'
];

function observe(target) {
  const choices = [
    () => `評価区分は「${evaluationBand(target.evaluation)}」だ。`,
    () => `精神状態は「${stressBand(target.stress)}」だ。`,
    () => `疑惑の水準は「${suspicionBand(target.suspicion)}」だ。`,
    () => `手札は${target.cards.length}枚だ。`,
    () => target.escapeOffered
      ? '正規の釈放に不安を感じている可能性がある。'
      : '別の出口を探す兆候はまだ確認できない。'
  ];
  return choices[Math.floor(Math.random() * choices.length)]();
}

function validateNightAction(room, player, action) {
  const allowed = ['rest', 'search', 'inform', 'observe', 'transfer'];
  if (player.isEscapePlanner) allowed.push('escapePrep');
  if (!allowed.includes(action?.type)) throw new Error('無効な夜間行動です');
  if (['inform', 'observe', 'transfer'].includes(action.type)) {
    const target = room.players[action.targetId];
    if (!target || target.id === player.id) throw new Error('対象プレイヤーが無効です');
  }
  if (['transfer', 'escapePrep'].includes(action.type)) {
    if (!player.cards.some((card) => card.id === action.cardId)) {
      throw new Error('指定されたカードを所持していません');
    }
  }
}

function resolveNight(room) {
  const players = Object.values(room.players);
  const events = [];

  // 1. カード譲渡
  players.filter((p) => p.nightAction.type === 'transfer').forEach((player) => {
    const action = player.nightAction;
    const target = room.players[action.targetId];
    const card = discardById({ discardPile: [] }, player, action.cardId);
    if (card) {
      target.cards.push(card);
      target.privateMessages.push(`${player.name}から「${CARD_TYPES[card.type].name}」を受け取った。`);
      player.privateMessages.push(`${target.name}へカードを渡した。`);
    }
  });

  // 2. 通常カード効果は player:useCard 時にサーバーで適用済み
  // 3. 休息
  players.filter((p) => p.nightAction.type === 'rest').forEach((player) => { player.stress -= 2; });
  // 4. 物資探索
  players.filter((p) => p.nightAction.type === 'search').forEach((player) => {
    drawCard(room, player);
    player.suspicion += 1;
  });
  // 5. 密告
  players.filter((p) => p.nightAction.type === 'inform').forEach((player) => {
    changeEvaluation(player, 4);
    room.players[player.nightAction.targetId].suspicion += 2;
    events.push('囚人の一人が、看守へ情報を提供した。');
  });
  // 6. 観察
  players.filter((p) => p.nightAction.type === 'observe').forEach((player) => {
    const target = room.players[player.nightAction.targetId];
    const result = `${target.name}：${observe(target)}`;
    player.observationResults.push(result);
    player.privateMessages.push(`観察結果：${result}`);
  });
  // 7. 脱獄準備
  players.filter((p) => p.nightAction.type === 'escapePrep' && p.isEscapePlanner).forEach((player) => {
    const card = discardById(room, player, player.nightAction.cardId);
    if (!card) return;
    const category = CARD_TYPES[card.type].escapeCategory;
    if (player.escapeProgress[category]) player.escapeProgress.reinforcement = 1;
    else player.escapeProgress[category] = true;
    player.suspicion += 2;
    player.privateMessages.push(`脱獄準備：「${CARD_TYPES[card.type].escapeLabel}」を進めた。`);
    events.push(ESCAPE_EVENTS[Math.floor(Math.random() * ESCAPE_EVENTS.length)]);
  });

  // 8. 手札上限は本人の選択を待つ（状態に mustDiscard を付与）
  // 9. 身体検査
  players.filter((p) => p.suspicion >= 8).forEach((player) => {
    randomDiscard(room, player);
    changeEvaluation(player, -3);
    events.push('囚人の一人が身体検査を受けた。');
  });
  // 10. 監獄秩序ペナルティ
  if (room.prison.order < 50) players.forEach((player) => { player.stress += 1; });
  if (room.prison.order < 30) players.forEach((player) => changeEvaluation(player, -5));
  if (room.prison.order < 15) players.forEach((player) => randomDiscard(room, player));
  // 11. ストレス10処理
  players.forEach((player) => {
    if (player.stress >= 10) {
      changeEvaluation(player, -5);
      player.stress = 8;
      randomDiscard(room, player);
      player.privateMessages.push('精神的限界に達した。評価を失い、手札を1枚喪失した。');
    }
    player.temporaryEffects.evaluationShield = 0;
  });

  clampRoom(room);
  room.nightEvents = events.length ? events : ['夜は静かに過ぎていった。'];
  return room.nightEvents;
}

module.exports = { validateNightAction, resolveNight, observe };
