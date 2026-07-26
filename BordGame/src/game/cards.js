'use strict';

const { randomUUID } = require('node:crypto');
const { clampPlayer } = require('../utils/clamp');

const CARD_TYPES = {
  medicine: {
    name: '医薬品',
    normal: '自分のストレスを2減らす',
    escapeCategory: 'timing',
    escapeLabel: 'タイミング'
  },
  thread: {
    name: '囚人服の糸',
    normal: '次の評価減少を最大5点軽減する（当日限り）',
    escapeCategory: 'route',
    escapeLabel: '経路'
  },
  patrol: {
    name: '看守の巡回記録',
    normal: '次の日の心理実験を先に知る',
    escapeCategory: 'timing',
    escapeLabel: 'タイミング'
  },
  keyMold: {
    name: '鍵の型',
    normal: '手札を1枚捨て、山札から1枚引く',
    escapeCategory: 'tool',
    escapeLabel: '突破手段'
  },
  wiring: {
    name: '配線',
    normal: '自分の疑惑度を1減らす',
    escapeCategory: 'tool',
    escapeLabel: '突破手段'
  },
  spoon: {
    name: '金属製スプーン',
    normal: 'カードを1枚引いた後、手札を1枚捨てる',
    escapeCategory: 'route',
    escapeLabel: '経路'
  }
};

function shuffle(values, random = Math.random) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function makeCard(type) {
  return { id: randomUUID(), type };
}

function createDeck(copies = 8) {
  const cards = [];
  Object.keys(CARD_TYPES).forEach((type) => {
    for (let i = 0; i < copies; i += 1) cards.push(makeCard(type));
  });
  return shuffle(cards);
}

function replenishDeck(room) {
  if (room.cardDeck.length === 0 && room.discardPile.length > 0) {
    room.cardDeck = shuffle(room.discardPile);
    room.discardPile = [];
  }
}

function drawCard(room, player) {
  replenishDeck(room);
  const card = room.cardDeck.pop();
  if (card) player.cards.push(card);
  return card || null;
}

function discardById(room, player, cardId) {
  const index = player.cards.findIndex((card) => card.id === cardId);
  if (index < 0) return null;
  const [card] = player.cards.splice(index, 1);
  room.discardPile.push(card);
  return card;
}

function randomDiscard(room, player) {
  if (!player.cards.length) return null;
  const card = player.cards[Math.floor(Math.random() * player.cards.length)];
  return discardById(room, player, card.id);
}

function publicCard(card, revealEscape = false) {
  const def = CARD_TYPES[card.type];
  return {
    id: card.id,
    type: card.type,
    name: def.name,
    normal: def.normal,
    ...(revealEscape ? {
      escapeCategory: def.escapeCategory,
      escapeLabel: def.escapeLabel
    } : {})
  };
}

function useNormalCard(room, player, cardId, options = {}) {
  if (!['PREPARATION', 'NIGHT_ACTION'].includes(room.phase)) {
    throw new Error('現在はカードを使用できません');
  }
  if (player.cardUsedDay === room.day) throw new Error('通常カードは1日1枚までです');
  const card = player.cards.find((item) => item.id === cardId);
  if (!card) throw new Error('指定されたカードを所持していません');
  if (card.type === 'patrol' && room.day >= 4) throw new Error('第4日には使用できません');

  if (['keyMold', 'spoon'].includes(card.type)) {
    const discardId = options.discardCardId || cardId;
    if (!player.cards.some((item) => item.id === discardId)) {
      throw new Error('捨てるカードを選択してください');
    }
    discardById(room, player, cardId);
    if (discardId !== cardId) discardById(room, player, discardId);
    drawCard(room, player);
    if (card.type === 'spoon' && discardId === cardId) {
      // 引いたカードを事前指定できないため、スプーン自身が選ばれた場合は
      // ドロー後の手札からランダムに1枚を捨てる。
      randomDiscard(room, player);
    }
  } else {
    discardById(room, player, cardId);
  }

  if (card.type === 'medicine') player.stress -= 2;
  if (card.type === 'thread') player.temporaryEffects.evaluationShield = 5;
  if (card.type === 'patrol') {
    const next = require('./constants').MINIGAMES[room.day + 1];
    player.temporaryEffects.nextMinigamePreview = next ? next.title : null;
  }
  if (card.type === 'wiring') player.suspicion -= 1;

  player.cardUsedDay = room.day;
  clampPlayer(player);
  player.privateMessages.push(`${CARD_TYPES[card.type].name}を使用した。`);
  return card;
}

module.exports = {
  CARD_TYPES,
  createDeck,
  drawCard,
  discardById,
  randomDiscard,
  publicCard,
  useNormalCard,
  shuffle
};
