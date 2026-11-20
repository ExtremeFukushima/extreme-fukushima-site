#!/usr/bin/env node
/**
 * Instagram フィード取得スクリプト（静的サイト用）
 *
 * - Instagram Graph API（Instagram API with Instagram Login）から最新投稿を取得し、
 *   data/instagram.json と assets/instagram/<id>.jpg を生成する。
 * - 画像はローカルに保存する（API の media_url は署名付きで期限切れになるため）。
 * - ページ側（index.html）はトークンを持たず、この JSON を読むだけ。
 *
 * 必要な環境変数:
 *   IG_ACCESS_TOKEN   長期アクセストークン（60日有効。--refresh で延長）
 *
 * 使い方:
 *   node scripts/fetch-instagram.mjs            # 投稿取得
 *   node scripts/fetch-instagram.mjs --refresh  # トークン延長（新トークンを標準出力）
 *
 * 安全設計（社内ルール準拠）:
 *   - 直列処理（並列数1）、リクエスト間隔 1 秒
 *   - 1回の実行での総リクエスト上限 MAX_REQUESTS
 *   - リトライは指数バックオフで最大3回。429 は Retry-After を待つ
 *   - 401/403、繰り返す失敗では即停止（既存の JSON は上書きしない）
 *   - 実行頻度は 1 時間に 1 回程度を想定（GitHub Actions / cron）
 */
import { mkdir, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://graph.instagram.com';
const POST_LIMIT = 12;
const MAX_REQUESTS = 1 + POST_LIMIT + 2; // 一覧1 + 画像12 + 予備
const INTERVAL_MS = 1000;
const MAX_RETRY = 3;

const token = process.env.IG_ACCESS_TOKEN;
if (!token) { console.error('IG_ACCESS_TOKEN が未設定です'); process.exit(1); }

let count = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
class StopError extends Error {}

async function request(url, { binary = false } = {}) {
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    if (++count > MAX_REQUESTS) throw new StopError(`総リクエスト上限 ${MAX_REQUESTS} に達したため停止`);
    if (count > 1) await sleep(INTERVAL_MS);
    let res;
    try { res = await fetch(url); }
    catch (e) { if (attempt === MAX_RETRY) throw new StopError(`接続失敗が続いたため停止: ${e.message}`); await sleep(2 ** attempt * 2000); continue; }

    if (res.ok) return binary ? Buffer.from(await res.arrayBuffer()) : res.json();
    if (res.status === 401 || res.status === 403) {
      throw new StopError(`HTTP ${res.status}: トークン失効または権限不足。停止します。\n${await res.text()}`);
    }
    if (res.status === 429) {
      const wait = (Number(res.headers.get('retry-after')) || 60) * 1000;
      if (attempt === MAX_RETRY) throw new StopError('429 が続いたため停止');
      console.warn(`429: ${wait / 1000}s 待機`); await sleep(wait); continue;
    }
    if (res.status >= 500 && attempt < MAX_RETRY) { await sleep(2 ** attempt * 2000); continue; }
    throw new StopError(`HTTP ${res.status} で停止: ${await res.text()}`);
  }
}

async function refresh() {
  const u = `${API}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`;
  const j = await request(u);
  // 新トークンはシークレット更新用に標準出力へ（ログに残さない運用にすること）
  process.stdout.write(j.access_token);
  console.error(`\nトークン延長: 有効期限 ${Math.round(j.expires_in / 86400)} 日`);
}

async function fetchFeed() {
  const fields = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp';
  const list = await request(`${API}/me/media?fields=${fields}&limit=${POST_LIMIT}&access_token=${encodeURIComponent(token)}`);
  const me = await request(`${API}/me?fields=username&access_token=${encodeURIComponent(token)}`).catch(() => ({}));

  const imgDir = join(ROOT, 'assets/instagram');
  await mkdir(imgDir, { recursive: true });

  const posts = [];
  for (const m of list.data ?? []) {
    const src = m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url;
    let image = null;
    if (src) {
      const buf = await request(src, { binary: true });
      const file = `${m.id}.jpg`;
      await writeFile(join(imgDir, file), buf);
      image = `assets/instagram/${file}`;
    }
    posts.push({ id: m.id, caption: m.caption ?? '', media_type: m.media_type, permalink: m.permalink, timestamp: m.timestamp, image });
  }
  if (!posts.length) throw new StopError('投稿0件のため JSON を更新しません');

  // 古い画像を掃除
  const keep = new Set(posts.map(p => `${p.id}.jpg`));
  for (const f of await readdir(imgDir)) if (!keep.has(f)) await unlink(join(imgDir, f));

  // 原子的に書き換え（途中失敗で壊れた JSON を出さない）
  const out = join(ROOT, 'data/instagram.json');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out + '.tmp', JSON.stringify({ account: me.username ?? null, updated_at: new Date().toISOString(), posts }, null, 2));
  await rename(out + '.tmp', out);
  console.log(`更新完了: ${posts.length} 件 / リクエスト ${count} 回`);
}

try {
  if (process.argv.includes('--refresh')) await refresh(); else await fetchFeed();
} catch (e) {
  console.error(e.message); process.exit(1);
}
