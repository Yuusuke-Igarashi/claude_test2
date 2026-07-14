// Mastodon の公開タイムライン（ハッシュタグ）から投稿を取得するアダプタ。
// 認証不要の公開APIを使う: GET https://{instance}/api/v1/timelines/tag/{tag}
// 画像付き・直近の投稿だけを正規化して返す。

const DEFAULT_INSTANCES = (process.env.MASTODON_INSTANCES ||
  'pawoo.net,mstdn.jp,fedibird.com,mastodon.social')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ラーメン関連のハッシュタグ（Mastodon のタグは大文字小文字を区別しない）
const TAGS = (process.env.RAMEN_TAGS || 'ramen,ラーメン,らーめん,つけ麺,家系')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** HTMLの本文をプレーンテキストに変換する簡易サニタイザ。 */
function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** 1つのインスタンス×1タグを取得。失敗しても例外を投げず空配列を返す。 */
async function fetchTag(instance, tag, signal) {
  const url = `https://${instance}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=40&only_media=true`;
  try {
    const res = await fetch(url, {
      signal,
      headers: { Accept: 'application/json', 'User-Agent': 'ramen-radar/1.0' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return []; // ネットワーク不通・タイムアウト等は黙って諦める（他ソースに委ねる）
  }
}

/**
 * Mastodon から画像付きラーメン投稿を取得して正規化する。
 * @returns {Promise<import('../collector.js').RawPost[]>}
 */
export async function fetchMastodon({ timeoutMs = 8000 } = {}) {
  if (DEFAULT_INSTANCES.length === 0) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const jobs = [];
  for (const instance of DEFAULT_INSTANCES) {
    for (const tag of TAGS) {
      jobs.push(fetchTag(instance, tag, controller.signal).then((rows) => ({ instance, rows })));
    }
  }

  let results;
  try {
    results = await Promise.all(jobs);
  } finally {
    clearTimeout(timer);
  }

  const seen = new Set();
  const posts = [];
  for (const { instance, rows } of results) {
    for (const s of rows) {
      const images = (s.media_attachments || []).filter(
        (m) => m.type === 'image' || m.type === 'gifv',
      );
      if (images.length === 0) continue;
      const key = s.url || `${instance}:${s.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      posts.push({
        id: `mastodon:${instance}:${s.id}`,
        source: 'mastodon',
        sourceLabel: `Mastodon (${instance})`,
        url: s.url,
        text: htmlToText(s.content),
        tags: (s.tags || []).map((t) => t.name),
        createdAt: s.created_at, // ISO8601
        author: s.account?.display_name || s.account?.username || 'unknown',
        authorHandle: s.account?.acct ? `@${s.account.acct}` : undefined,
        authorAvatar: s.account?.avatar,
        authorLocation: undefined,
        image: images[0].preview_url || images[0].url,
        imageFull: images[0].url,
        geo: null, // Mastodon はジオタグを持たないのが一般的
      });
    }
  }
  return posts;
}
