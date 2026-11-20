# EXTREME FUKUSHIMA 静的サイト（TOPページ試作）

## 構成
```
index.html                      TOPページ（HTML/CSS/JS 1ファイル）
data/instagram.json             Instagram投稿データ（スクリプトが生成）
assets/instagram/*.jpg          投稿画像（スクリプトが生成）
scripts/fetch-instagram.mjs     Instagram Graph API から取得するスクリプト
.github/workflows/instagram.yml GitHub Actions での自動更新例
```

## 確認方法
- `index.html` をブラウザで直接開くと、Instagram欄はサンプル表示になります。
- 実データで確認する場合は、ローカルサーバーで開いてください：`npx serve .` または `python3 -m http.server`

## Instagram を実データにする手順
1. `@extreme_fukushima_official` を**プロアカウント**（ビジネス／クリエイター）にする
2. Meta for Developers でアプリを作り、「Instagram API with Instagram Login」を追加
3. `instagram_business_basic` 権限で長期アクセストークンを発行
4. `IG_ACCESS_TOKEN=xxxx node scripts/fetch-instagram.mjs` を実行すると data/ と assets/ が生成される
5. 定期実行を設定する（GitHub Actions、またはサーバーの cron で1時間に1回）。トークンは60日で失効するので、`--refresh` を週1回実行する

## 本番移行時の残作業
- 画像（ロゴ・KV・キャッチ画像）を現行サーバーから取得して `assets/` に配置し、パスを差し替える（現在は現行サイトの画像を直接参照）
- MOVIE：`#movieThumbs button` の `data-id` に YouTube の動画IDを入れる
- ACTIVITY MAP：現行の Google マイマップ iframe を貼る
- NEWS：日付・リンク先を入れる（更新頻度が高ければ JSON 化を検討）
- EN ページ、下層ページ（news / activity / 各カテゴリ）
