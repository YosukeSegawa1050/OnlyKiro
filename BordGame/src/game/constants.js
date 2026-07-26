'use strict';

const PHASES = [
  'LOBBY',
  'DAY_BRIEFING',
  'MINIGAME_INTRO',
  'PREPARATION',
  'MINIGAME_INPUT',
  'MINIGAME_SECOND_INPUT',
  'MINIGAME_RESULT',
  'NIGHT_ACTION',
  'NIGHT_RESULT',
  'EVALUATION',
  'ESCAPE_OFFER',
  'FINAL_JUDGMENT',
  'ESCAPE_ROUTE_SELECT',
  'ESCAPE_DEFENSE',
  'ESCAPE_RESULT',
  'GAME_RESULT'
];

const PHASE_LABELS = {
  LOBBY: '入室待機',
  DAY_BRIEFING: '朝の看守放送',
  MINIGAME_INTRO: '心理実験説明',
  PREPARATION: '準備・カード使用',
  MINIGAME_INPUT: '心理実験・入力',
  MINIGAME_SECOND_INPUT: '心理実験・第2入力',
  MINIGAME_RESULT: '心理実験結果',
  NIGHT_ACTION: '夜間行動',
  NIGHT_RESULT: '夜間事件',
  EVALUATION: '評価発表',
  ESCAPE_OFFER: '秘密提案',
  FINAL_JUDGMENT: '最終審査',
  ESCAPE_ROUTE_SELECT: '警報・脱出経路',
  ESCAPE_DEFENSE: '脱獄阻止',
  ESCAPE_RESULT: '脱獄判定',
  GAME_RESULT: '最終結果'
};

const MINIGAMES = {
  1: { id: 'prisoners_dilemma', title: '囚人のジレンマ' },
  2: { id: 'ration', title: '配給食実験' },
  3: { id: 'hats', title: '赤白帽子実験' },
  4: { id: 'trust', title: '信頼投資実験' }
};

const BRIEFINGS = {
  1: '第1日。協力は美徳だ。だが、看守は結果だけを評価する。',
  2: '第2日。物資は有限だ。節度ある選択が監獄の秩序を守る。',
  3: '第3日。他者を観察し、自分自身を推理せよ。',
  4: '最終日。信頼には値段がつく。その価値を証明せよ。'
};

function evaluationBand(value) {
  if (value >= 75) return '模範囚';
  if (value >= 60) return '釈放候補';
  if (value >= 45) return '要観察';
  if (value >= 30) return '危険囚';
  return '処罰対象';
}

function stressBand(value) {
  if (value >= 10) return '崩壊寸前';
  if (value >= 7) return '限界';
  if (value >= 4) return '不安定';
  return '冷静';
}

function suspicionBand(value) {
  if (value >= 8) return '厳重監視';
  if (value >= 5) return '強い疑い';
  if (value >= 2) return '要注意';
  return '低い';
}

module.exports = {
  PHASES,
  PHASE_LABELS,
  MINIGAMES,
  BRIEFINGS,
  evaluationBand,
  stressBand,
  suspicionBand
};
