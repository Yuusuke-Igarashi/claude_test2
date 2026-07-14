// 各SNSソースをまとめて呼び出し、直近1時間の画像付き投稿に絞り、
// 位置を推定して地図表示用の配列に整える。
//
// フロー: [Mastodon / X / …] → 1時間フィルタ → 位置推定 → 整形
// ライブ取得が0件（ネット制限やキー未設定）なら、デモ用サンプルに自動フォールバック。

import { fetchMastodon } from './sources/mastodon.js';
import { fetchTwitter } from './sources/twitter.js';
import { fetchSample } from './sources/sample.js';
import { estimateLocation } from './geo/estimate.js';

/**
 * @typedef {Object} RawPost
 * @property {string} id
 * @property {string} source
 * @property {string} sourceLabel
 * @property {string|null} url
 * @property {string} text
 * @property {string[]} tags
 * @property {string} createdAt            ISO8601
 * @property {string} author
 * @property {string} [authorHandle]
 * @property {string|null} [authorAvatar]
 * @property {string} [authorLocation]
 * @property {string} image                サムネイルURL
 * @property {string} [imageFull]
 * @property {{lat:number, lon:number}|null} geo
 */

const WINDOW_MS = Number(process.env.WINDOW_MINUTES || 60) * 60 * 1000;
const USE_SAMPLE_FALLBACK = process.env.USE_SAMPLE_FALLBACK !== 'false';

/** 指定時間窓（既定=直近60分）以内の投稿だけを残す。 */
function withinWindow(posts, now) {
  return posts.filter((p) => {
    const t = Date.parse(p.createdAt);
    return Number.isFinite(t) && now - t <= WINDOW_MS && t <= now + 60_000;
  });
}

/**
 * 全ソースから収集し、フィルタ・位置推定して返す。
 * @param {{ now?: number, forceSample?: boolean }} [opts]
 */
export async function collectPosts({ now = Date.now(), forceSample = false } = {}) {
  let live = [];
  let liveError = null;

  if (!forceSample) {
    try {
      const [mastodon, twitter] = await Promise.all([
        fetchMastodon().catch((e) => ((liveError = e), [])),
        fetchTwitter().catch((e) => ((liveError = e), [])),
      ]);
      live = [...mastodon, ...twitter];
    } catch (e) {
      liveError = e;
    }
  }

  let recent = withinWindow(live, now);
  let demo = false;

  // ライブが0件ならサンプルにフォールバック（設定で無効化可能）
  if (recent.length === 0 && (USE_SAMPLE_FALLBACK || forceSample)) {
    demo = true;
    recent = withinWindow(fetchSample({ now }), now);
  }

  // 位置推定して、推定できたものだけをピン化
  const located = [];
  let unlocated = 0;
  for (const p of recent) {
    const geo = estimateLocation(p);
    if (!geo) {
      unlocated++;
      continue;
    }
    located.push({
      id: p.id,
      source: p.source,
      sourceLabel: p.sourceLabel,
      url: p.url,
      text: p.text,
      tags: p.tags,
      createdAt: p.createdAt,
      author: p.author,
      authorHandle: p.authorHandle,
      authorAvatar: p.authorAvatar,
      image: p.image,
      imageFull: p.imageFull || p.image,
      lat: geo.lat,
      lon: geo.lon,
      locationLabel: geo.label,
      pref: geo.pref,
      confidence: geo.confidence,
      method: geo.method,
    });
  }

  // 新しい順
  located.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  return {
    generatedAt: new Date(now).toISOString(),
    windowMinutes: WINDOW_MS / 60000,
    demo,
    counts: {
      collected: recent.length,
      located: located.length,
      unlocated,
    },
    posts: located,
  };
}
