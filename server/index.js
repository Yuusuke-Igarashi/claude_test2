// ラーメンレーダー サーバ（依存ゼロ / Node標準の http のみ）。
//   GET /api/posts        直近1時間の位置推定済みラーメン投稿(JSON)
//   GET /api/posts?sample=1  デモ用サンプルを強制
//   GET /*                public/ 配下の静的ファイル
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectPosts } from './collector.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function serveStatic(req, res, urlPath) {
  // ディレクトリトラバーサル対策
  const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(PUBLIC_DIR, safe === '/' ? 'index.html' : safe);
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) filePath = join(filePath, 'index.html');
    const data = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/posts') {
    try {
      const forceSample = url.searchParams.get('sample') === '1';
      const result = await collectPosts({ forceSample });
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, 500, { error: String(e?.message || e) });
    }
    return;
  }

  if (url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  await serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`🍜 ラーメンレーダー: http://localhost:${PORT}`);
});
