// デモ／オフライン用のサンプル投稿ソース。
// ライブのSNS取得ができない環境（ネットワーク制限・APIキー未設定）でも
// アプリの動作を確認できるよう、リアルなラーメン投稿を模したデータを返す。
//
// createdAt はリクエストのたびに「現在時刻 - 数分前」で生成するため、
// 常に『直近1時間以内』フィルタを通過する。画像はローカル生成のSVG。
//
// 一部の投稿には geo（ジオタグ相当）を持たせ、残りはテキストの地名から
// 位置推定させる（estimate.js の両経路をデモできる）。

const SAMPLES = [
  { text: '深夜の一杯🍜 濃厚味噌ラーメン、コーンバター最高。#札幌 #ラーメン #味噌ラーメン', place: '札幌', author: 'susukino_gohan', geo: { lat: 43.055, lon: 141.353 }, img: 1 },
  { text: '旭川ラーメン食べてきた。ダブルスープの醤油が沁みる〜 #旭川 #ラーメン', place: '旭川', author: 'asahikawa_noodle', img: 2 },
  { text: '喜多方ラーメンの朝ラー最高。平打ち縮れ麺うまい #喜多方 #らーめん', place: '喜多方', author: 'kitakata_asa', img: 4 },
  { text: '佐野ラーメン、青竹打ちのちぢれ麺！ #佐野 #栃木 #ラーメン', place: '佐野', author: 'tochigi_men', img: 7 },
  { text: '新宿で味玉つけ麺。並んだ甲斐あった #新宿 #つけ麺', place: '新宿', author: 'tokyo_ramen_bot', img: 6 },
  { text: '横浜家系、ライス必須です🍚 #横浜 #家系ラーメン', place: '横浜', author: 'iekei_lover', geo: { lat: 35.444, lon: 139.638 }, img: 5 },
  { text: '八王子ラーメン、刻み玉ねぎが効いてる #八王子 #東京', place: '八王子', author: 'hachioji_gurume', img: 3 },
  { text: '名古屋の台湾ラーメン、辛旨！ #名古屋 #ラーメン', place: '名古屋', author: 'nagoya_meshi', img: 10 },
  { text: '高山ラーメン、あっさり醤油が優しい #高山 #岐阜', place: '高山', author: 'hida_tabi', img: 2 },
  { text: '京都 一乗寺の背脂醤油！こってり #京都 #ラーメン', place: '一乗寺', author: 'kyoto_men', img: 5 },
  { text: '大阪 難波でこってり豚骨醤油🍜 #なんば #大阪 #ラーメン', place: 'なんば', author: 'osaka_noodle', geo: { lat: 34.665, lon: 135.501 }, img: 3 },
  { text: '和歌山ラーメン、早すしと一緒に #和歌山 #ラーメン', place: '和歌山市', author: 'wakayama_gohan', img: 8 },
  { text: '尾道ラーメン、背脂と小魚だしが効いてる #尾道 #広島', place: '尾道', author: 'onomichi_tabi', img: 9 },
  { text: '徳島ラーメン、生卵トッピングでご飯が進む #徳島 #ラーメン', place: '徳島市', author: 'tokushima_men', img: 10 },
  { text: '博多長浜、替え玉2回いきました #博多 #豚骨ラーメン', place: '博多', author: 'hakata_barikata', geo: { lat: 33.59, lon: 130.401 }, img: 3 },
  { text: '久留米ラーメン、元祖豚骨のスープ濃厚 #久留米 #福岡', place: '久留米', author: 'kurume_tonkotsu', img: 3 },
  { text: '熊本ラーメン、マー油と焦がしにんにく🧄 #熊本 #ラーメン', place: '熊本市', author: 'kumamoto_men', img: 10 },
  { text: '那覇で沖縄そば、三枚肉たっぷり #那覇 #沖縄そば', place: '那覇', author: 'naha_soba', geo: { lat: 26.212, lon: 127.681 }, img: 7 },
  { text: '仙台で辛味噌ラーメンあたたまる〜 #仙台 #宮城 #ラーメン', place: '仙台', author: 'sendai_gurume', img: 1 },
  { text: '池袋で二郎系、野菜マシマシ💪 #池袋 #ラーメン', place: '池袋', author: 'jiro_daisuki', img: 6 },
];

/**
 * サンプル投稿を返す。deterministic な分をずらしつつ、直近55分以内に散らす。
 * @param {{ now?: number }} [opts]  now は「現在時刻(ms)」。テスト用に注入可能。
 * @returns {import('../collector.js').RawPost[]}
 */
export function fetchSample({ now = Date.now() } = {}) {
  return SAMPLES.map((s, i) => {
    // 0〜55分前に分散（決定論的: index ベース）
    const minutesAgo = (i * 7 + 3) % 56;
    const createdAt = new Date(now - minutesAgo * 60 * 1000).toISOString();
    const img = String(s.img).padStart(2, '0');
    return {
      id: `sample:${i}`,
      source: 'sample',
      sourceLabel: 'サンプル (デモ)',
      url: null,
      text: s.text,
      tags: (s.text.match(/#[^\s#]+/g) || []).map((t) => t.slice(1)),
      createdAt,
      author: s.author,
      authorHandle: `@${s.author}`,
      authorAvatar: null,
      authorLocation: s.place,
      image: `/images/ramen-${img}.svg`,
      imageFull: `/images/ramen-${img}.svg`,
      geo: s.geo || null,
    };
  });
}
