#!/usr/bin/env node
/**
 * Instagram フィード取得スクリプト（静的サイト用）
 *
 * 最新投稿を取得し、data/instagram.json と assets/instagram/<id>.jpg を生成する。
 * 画像はローカルに保存する（API の画像URLは期限切れになるため）。
 * ページ側（index.html）はトークンを持たず、この JSON を読むだけ。
 *
 * 2種類のトークンに対応（先頭の文字で自動判別）:
 *   IG…  Instagram ログインのトークン → graph.instagram.com（60日。--refresh で延長）
 *   EAA… Facebook ログインのトークン  → graph.facebook.com
 *        ※ Instagram と Facebook ページの連携が必要
 *        ※ --setup-fb で「無期限のページトークン」に変換して使う
 *
 * 環境変数:
 *   IG_ACCESS_TOKEN   アクセストークン（必須）
 *   IG_USERNAME       対象アカウント（既定: extreme_fukushima_official）
 *   IG_USER_ID        Instagram アカウントID（数字）。EAA…のシステムユーザートークン等で
 *                     ページ権限が無い場合に指定（指定すればページ経由の検索を省略）
 *   META_APP_ID       --setup-fb のときのみ必要（アプリID）
 *   META_APP_SECRET   --setup-fb のときのみ必要（app secret）
 *
 * 使い方:
 *   node scripts/fetch-instagram.mjs              # 投稿取得
 *   node scripts/fetch-instagram.mjs --refresh    # IGトークン延長（新トークンを標準出力）
 *   node scripts/fetch-instagram.mjs --setup-fb   # EAAトークン→無期限ページトークン（標準出力）
 *
 * 安全設計（社内ルール準拠）:
 *   - 直列処理（並列数1）、リクエスト間隔 1 秒、1回の実行での総リクエスト上限あり
 *   - リトライは指数バックオフで最大3回。429 は Retry-After を待つ
 *   - 401/403・その他のエラー・繰り返す失敗では即停止（既存の JSON は上書きしない）
 */
import { mkdir, writeFile, readFile, rename, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IG_API = 'https://graph.instagram.com';
const FB_API = 'https://graph.facebook.com';
const POST_LIMIT = 12;
const MAX_REQUESTS = 4 + POST_LIMIT + 4; // 確認系4 + 画像12 + 予備
const INTERVAL_MS = 1000;
const MAX_RETRY = 3;
const USERNAME = (process.env.IG_USERNAME || 'extreme_fukushima_official').replace(/^@/, '').toLowerCase();

const token = (process.env.IG_ACCESS_TOKEN || '').trim();
if (!token) { console.error('IG_ACCESS_TOKEN が未設定です'); process.exit(1); }
const MODE = token.startsWith('EAA') ? 'fb' : 'ig';
const T = encodeURIComponent(token);

let count = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
class StopError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

async function request(url, { binary = false } = {}) {
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    if (++count > MAX_REQUESTS) throw new StopError(`総リクエスト上限 ${MAX_REQUESTS} に達したため停止`);
    if (count > 1) await sleep(INTERVAL_MS);
    let res;
    try { res = await fetch(url); }
    catch (e) { if (attempt === MAX_RETRY) throw new StopError(`接続失敗が続いたため停止: ${e.message}`); await sleep(2 ** attempt * 2000); continue; }

    if (res.ok) return binary ? Buffer.from(await res.arrayBuffer()) : res.json();
    if (res.status === 401 || res.status === 403) {
      throw new StopError(`HTTP ${res.status}: トークン失効または権限不足。停止します。\n${await res.text()}`, res.status);
    }
    if (res.status === 429) {
      const wait = (Number(res.headers.get('retry-after')) || 60) * 1000;
      if (attempt === MAX_RETRY) throw new StopError('429 が続いたため停止', 429);
      console.warn(`429: ${wait / 1000}s 待機`); await sleep(wait); continue;
    }
    if (res.status >= 500 && attempt < MAX_RETRY) { await sleep(2 ** attempt * 2000); continue; }
    throw new StopError(`HTTP ${res.status} で停止: ${await res.text()}`, res.status);
  }
}

/* ---------- Facebook ログイン（EAA…）用 ---------- */

// トークンがページトークンなら、そのページに連携した Instagram アカウントを返す。ユーザートークンなら null
async function igFromPageToken(tok) {
  try {
    const p = await request(`${FB_API}/me?fields=name,instagram_business_account{id,username}&access_token=${encodeURIComponent(tok)}`);
    return { page: p, ig: p.instagram_business_account ?? null };
  } catch (e) {
    if (e.status === 400) return null; // ユーザートークンには instagram_business_account が無い
    throw e;
  }
}

// ユーザートークンで管理ページ一覧から対象アカウントを探す
async function findPageByUser(tok, withToken = false) {
  const f = `name${withToken ? ',access_token' : ''},instagram_business_account{id,username}`;
  const a = await request(`${FB_API}/me/accounts?fields=${f}&limit=100&access_token=${encodeURIComponent(tok)}`);
  const pages = a.data ?? [];
  const hit = pages.find(p => p.instagram_business_account?.username?.toLowerCase() === USERNAME);
  if (!hit) {
    const list = pages.map(p => `・${p.name} → ${p.instagram_business_account?.username ?? '（Instagram未連携）'}`).join('\n') || '（管理しているページが取得できません）';
    throw new StopError(
      `@${USERNAME} と連携した Facebook ページが見つかりません。\n` +
      `取得できたページ:\n${list}\n` +
      `→ システムユーザートークンの場合は、シークレット IG_USER_ID に Instagram アカウントID（数字）を登録してください。\n` +
      `→ それ以外は、Instagram と Facebook ページの連携、およびトークンの権限（pages_show_list / instagram_basic / pages_read_engagement）を確認してください。`);
  }
  return hit;
}

async function resolveIgUserFb() {
  // IG_USER_ID が指定されていれば直接使う（システムユーザートークンなど、ページ権限が無い場合）
  const fixedId = (process.env.IG_USER_ID || '').trim();
  if (fixedId) {
    if (!/^\d+$/.test(fixedId)) throw new StopError('IG_USER_ID は数字のみで指定してください（例: 17841400000000000）');
    return request(`${FB_API}/${fixedId}?fields=id,username&access_token=${T}`);
  }
  const r = await igFromPageToken(token);
  if (r) {
    if (!r.ig) throw new StopError(`ページ「${r.page.name}」に Instagram アカウントが連携されていません。`);
    return r.ig;
  }
  return (await findPageByUser(token)).instagram_business_account;
}

async function setupFb() {
  if (MODE !== 'fb') throw new StopError('--setup-fb は EAA で始まるトークン専用です。');
  const appId = (process.env.META_APP_ID || '').trim();
  const secret = (process.env.META_APP_SECRET || '').trim();
  if (!appId || !secret) throw new StopError('META_APP_ID と META_APP_SECRET を設定してください。');
  const appToken = encodeURIComponent(`${appId}|${secret}`);

  let pageToken, pageName;
  const r = await igFromPageToken(token);
  if (r) {
    console.error(`すでにページトークンです（ページ: ${r.page.name}）`);
    pageToken = token; pageName = r.page.name;
  } else {
    // ① 長期ユーザートークンに交換 → ② そのトークンからページトークンを取得（無期限になる）
    const ex = await request(`${FB_API}/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(appId)}&client_secret=${encodeURIComponent(secret)}&fb_exchange_token=${T}`);
    const page = await findPageByUser(ex.access_token, true);
    pageToken = page.access_token; pageName = page.name;
  }

  const d = (await request(`${FB_API}/debug_token?input_token=${encodeURIComponent(pageToken)}&access_token=${appToken}`)).data ?? {};
  const exp = d.expires_at ? new Date(d.expires_at * 1000).toLocaleString('ja-JP') : '無期限';
  console.error(`ページ: ${pageName} / 種類: ${d.type} / 有効期限: ${exp} / 権限: ${(d.scopes || []).join(', ')}`);
  process.stdout.write(pageToken);
}

/* ---------- 共通 ---------- */

async function refresh() {
  if (MODE === 'fb') { console.error('Facebook ページトークンは延長不要のため何もしません。'); return; }
  const j = await request(`${IG_API}/refresh_access_token?grant_type=ig_refresh_token&access_token=${T}`);
  process.stdout.write(j.access_token); // シークレット更新用（ログには出さない）
  console.error(`\nトークン延長: 有効期限 ${Math.round(j.expires_in / 86400)} 日`);
}

async function fetchFeed() {
  const fields = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp';
  let list, username;
  if (MODE === 'fb') {
    const ig = await resolveIgUserFb();
    username = ig.username;
    if (username?.toLowerCase() !== USERNAME) console.warn(`注意: 取得対象は @${username} です（想定: @${USERNAME}）`);
    list = await request(`${FB_API}/${ig.id}/media?fields=${fields}&limit=${POST_LIMIT}&access_token=${T}`);
  } else {
    list = await request(`${IG_API}/me/media?fields=${fields}&limit=${POST_LIMIT}&access_token=${T}`);
    username = (await request(`${IG_API}/me?fields=username&access_token=${T}`).catch(() => ({}))).username;
  }

  const imgDir = join(ROOT, 'assets/instagram');
  await mkdir(imgDir, { recursive: true });
  const existing = new Set(await readdir(imgDir));

  const posts = [];
  let downloaded = 0;
  for (const m of (list.data ?? []).slice(0, POST_LIMIT)) {
    const src = m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url;
    let image = null;
    if (src) {
      const file = `${m.id}.jpg`;
      if (!existing.has(file)) { // 取得済みの画像は再ダウンロードしない
        await writeFile(join(imgDir, file), await request(src, { binary: true }));
        downloaded++;
      }
      image = `assets/instagram/${file}`;
    }
    posts.push({ id: m.id, caption: m.caption ?? '', media_type: m.media_type, permalink: m.permalink, timestamp: m.timestamp, image });
  }
  if (!posts.length) throw new StopError('投稿0件のため JSON を更新しません');

  // 古い画像を掃除
  const keep = new Set(posts.map(p => `${p.id}.jpg`));
  for (const f of await readdir(imgDir)) if (!keep.has(f)) await unlink(join(imgDir, f));

  // 内容に変化がなければ書き換えない（＝不要なコミット・再デプロイを起こさない）
  const out = join(ROOT, 'data/instagram.json');
  const prev = await readFile(out, 'utf8').then(JSON.parse).catch(() => null);
  if (prev && JSON.stringify(prev.posts) === JSON.stringify(posts)) {
    console.log(`変更なし（リクエスト ${count} 回）`); return;
  }

  // 原子的に書き換え（途中失敗で壊れた JSON を出さない）
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out + '.tmp', JSON.stringify({ account: username ?? null, updated_at: new Date().toISOString(), posts }, null, 2));
  await rename(out + '.tmp', out);
  console.log(`更新完了: @${username} ${posts.length} 件（新規画像 ${downloaded} 枚）/ リクエスト ${count} 回`);
}

try {
  if (process.argv.includes('--setup-fb')) await setupFb();
  else if (process.argv.includes('--refresh')) await refresh();
  else await fetchFeed();
} catch (e) {
  console.error(e.message); process.exit(1);
}
