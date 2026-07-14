// 投稿から位置情報を推定する。
// 推定の優先順位（信頼度の高い順）:
//   1. 投稿に付与された緯度経度（ジオタグ / EXIF由来） … confidence 'exact'
//   2. 投稿テキスト・ハッシュタグ・アカウントの所在地に含まれる地名 … 'text'
//   3. 推定不能                                                     … null（地図には出さない）
//
// 同じ地点に複数のピンが重ならないよう、確定していない地名一致には
// 小さな決定論的ジッター（投稿IDから算出）を加えて散らす。

import { PLACES, KIND_PRIORITY } from './gazetteer.js';

/**
 * @typedef {Object} GeoEstimate
 * @property {number} lat
 * @property {number} lon
 * @property {string} label            推定された地名（表示用）
 * @property {'high'|'medium'|'low'} confidence
 * @property {'geotag'|'text'} method  推定手段
 * @property {string} [pref]
 */

/** 文字列内から最も具体的な地名を1件選ぶ。見つからなければ null。 */
function matchPlaceInText(text) {
  if (!text) return null;
  let best = null;
  for (const place of PLACES) {
    for (const name of place.names) {
      if (text.includes(name)) {
        const score = KIND_PRIORITY[place.kind] * 100 + name.length; // 種別優先 → 一致語が長いほど具体的
        if (!best || score > best.score) best = { place, name, score };
        break;
      }
    }
  }
  return best ? best.place : null;
}

/** 投稿IDから決定論的な小さなジッター（±約0.05度）を生成。 */
function jitter(seed, salt) {
  let h = 2166136261;
  const s = String(seed) + salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // 0..1 に正規化して ±0.05 に写像
  const r = ((h >>> 0) % 10000) / 10000;
  return (r - 0.5) * 0.1;
}

/**
 * 1件の投稿から位置を推定する。
 * @param {Object} post
 * @param {{lat:number, lon:number}} [post.geo]  明示的な座標があれば最優先
 * @param {string} [post.text]
 * @param {string} [post.authorLocation]  アカウントプロフィールの所在地
 * @param {string[]} [post.tags]
 * @param {string} post.id
 * @returns {GeoEstimate|null}
 */
export function estimateLocation(post) {
  // 1. ジオタグ（最も確実）
  if (post.geo && Number.isFinite(post.geo.lat) && Number.isFinite(post.geo.lon)) {
    const near = nearestPlaceLabel(post.geo.lat, post.geo.lon);
    return {
      lat: post.geo.lat,
      lon: post.geo.lon,
      label: near ? `${near.label} 付近` : '位置情報あり',
      pref: near?.pref,
      confidence: 'high',
      method: 'geotag',
    };
  }

  // 2. テキスト / タグ / プロフィール所在地からの地名一致
  const haystack = [post.text, (post.tags || []).join(' '), post.authorLocation]
    .filter(Boolean)
    .join(' ');
  const place = matchPlaceInText(haystack);
  if (place) {
    return {
      lat: place.lat + jitter(post.id, 'lat'),
      lon: place.lon + jitter(post.id, 'lon'),
      label: place.label,
      pref: place.pref,
      confidence: place.kind === 'landmark' ? 'medium' : 'low',
      method: 'text',
    };
  }

  // 3. 推定不能
  return null;
}

/** 座標に最も近い辞書上の地点ラベルを返す（表示補助用）。
 *  ほぼ同距離なら、より具体的な地点（landmark > city > pref）を優先する。 */
function nearestPlaceLabel(lat, lon) {
  const cands = PLACES
    .map((p) => ({ ...p, d: (p.lat - lat) ** 2 + (p.lon - lon) ** 2 }))
    .filter((p) => p.d < 0.5) // 約0.7度=~70km以内のみ
    .sort((a, b) => {
      // 近接（0.02度差=~2km以内）は具体度で優先、それ以外は距離順
      if (Math.abs(a.d - b.d) < 0.0004) return KIND_PRIORITY[b.kind] - KIND_PRIORITY[a.kind];
      return a.d - b.d;
    });
  return cands[0] || null;
}
