// X (Twitter) API v2 の Recent Search から取得するアダプタ（任意）。
// 環境変数 X_BEARER_TOKEN が設定されている場合のみ有効。
// 無料枠では recent search が使えないプランもあるため、失敗時は空配列を返す。
//
// 位置情報: ツイートに place / geo が付いていれば座標を使う。
// なければ本文の地名からテキスト推定にフォールバックする（estimate.js が処理）。

const BEARER = process.env.X_BEARER_TOKEN;
const QUERY = process.env.X_QUERY || '(ラーメン OR ramen OR つけ麺) has:images -is:retweet';

/**
 * @returns {Promise<import('../collector.js').RawPost[]>}
 */
export async function fetchTwitter({ timeoutMs = 8000 } = {}) {
  if (!BEARER) return []; // 未設定なら無効（サイレント）

  const params = new URLSearchParams({
    query: QUERY,
    max_results: '50',
    'tweet.fields': 'created_at,geo,entities,attachments',
    expansions: 'attachments.media_keys,author_id,geo.place_id',
    'media.fields': 'url,preview_image_url,type',
    'user.fields': 'name,username,profile_image_url,location',
    'place.fields': 'full_name,geo,country',
  });
  const url = `https://api.twitter.com/2/tweets/search/recent?${params}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let data;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${BEARER}` },
    });
    if (!res.ok) return [];
    data = await res.json();
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }

  const media = new Map((data.includes?.media || []).map((m) => [m.media_key, m]));
  const users = new Map((data.includes?.users || []).map((u) => [u.id, u]));
  const places = new Map((data.includes?.places || []).map((p) => [p.id, p]));

  const posts = [];
  for (const t of data.data || []) {
    const mediaKeys = t.attachments?.media_keys || [];
    const img = mediaKeys.map((k) => media.get(k)).find((m) => m && (m.type === 'photo' || m.url || m.preview_image_url));
    if (!img) continue;

    const user = users.get(t.author_id);
    // place の bbox 中心を座標として使う
    let geo = null;
    const placeId = t.geo?.place_id;
    if (placeId && places.has(placeId)) {
      const bbox = places.get(placeId).geo?.bbox; // [w, s, e, n]
      if (bbox) geo = { lat: (bbox[1] + bbox[3]) / 2, lon: (bbox[0] + bbox[2]) / 2 };
    }
    if (!geo && t.geo?.coordinates?.coordinates) {
      const [lon, lat] = t.geo.coordinates.coordinates;
      geo = { lat, lon };
    }

    posts.push({
      id: `x:${t.id}`,
      source: 'x',
      sourceLabel: 'X (Twitter)',
      url: `https://twitter.com/i/web/status/${t.id}`,
      text: t.text,
      tags: (t.entities?.hashtags || []).map((h) => h.tag),
      createdAt: t.created_at,
      author: user?.name || 'unknown',
      authorHandle: user?.username ? `@${user.username}` : undefined,
      authorAvatar: user?.profile_image_url,
      authorLocation: user?.location,
      image: img.preview_image_url || img.url,
      imageFull: img.url || img.preview_image_url,
      geo,
    });
  }
  return posts;
}
