# Cloudflare Workers + D1 Google Calendar Sync

2つのGoogleカレンダーを、イベント側にタグや拡張プロパティを保存せず、D1の同期台帳だけで双方向同期するWorkerです。

同期対象カレンダー:

- `tsuchida@andex.tokyo`
- `tsucchy.me@gmail.com`

`primary` は使いません。OAuthしたGoogleアカウントが、両方のカレンダーに読み書き権限を持っている必要があります。

## 実装内容

- A/B 2カレンダーの双方向同期
- 今日から `SYNC_DAYS` 日先までを初回フル同期
- 2回目以降はGoogle Calendar API v3の `syncToken` で増分同期
- `410 Gone` 時は `syncToken` を破棄してフル同期に復帰
- D1にイベントペア、syncToken、OAuthトークン、ロック、実行履歴を保存
- Cronと手動実行が重ならないようD1ロックを使用
- Google APIの `429` / `5xx` をリトライ
- 正常完了した場合だけ新しい `syncToken` を保存
- 構造化JSONログを出力
- `summary` / `description` / `location` / `start` / `end` / `status` を同期
- `attendees` / `reminders` / `conferenceData` / `attachments` は同期対象外
- 繰り返し予定は `singleEvents=true` で展開して扱う
- 削除同期は `ENABLE_DELETE_SYNC=true` で有効。片側削除を相手側にも反映します

## ファイル構成

- [src/index.ts](/Users/yuki/Desktop/codex/sync-calendar/src/index.ts): Worker本体
- [wrangler.toml](/Users/yuki/Desktop/codex/sync-calendar/wrangler.toml): Worker / Cron / D1設定
- [migrations/0001_initial.sql](/Users/yuki/Desktop/codex/sync-calendar/migrations/0001_initial.sql): D1 schema
- [.dev.vars.example](/Users/yuki/Desktop/codex/sync-calendar/.dev.vars.example): ローカル環境変数サンプル

## Google Cloud Console 設定

1. Google Cloud Consoleでプロジェクトを作成または選択します。
2. 「APIとサービス」から **Google Calendar API** を有効化します。
3. 「OAuth同意画面」を設定します。
   - User Typeは利用形態に合わせて選択
   - テスト中はOAuthするGoogleアカウントをテストユーザーに追加
4. 「認証情報」から **OAuth クライアント ID** を作成します。
   - アプリケーションの種類: ウェブ アプリケーション
   - 承認済みのリダイレクトURI:
     - ローカル: `http://localhost:8787/oauth/callback`
     - 本番: `https://<your-worker-domain>/oauth/callback`
5. Client ID / Client Secretを控えます。

OAuthスコープは `https://www.googleapis.com/auth/calendar.events` を使います。

## Cloudflare D1 設定

```bash
npm install
npx wrangler d1 create calendar_sync_db
```

作成された `database_id` を [wrangler.toml](/Users/yuki/Desktop/codex/sync-calendar/wrangler.toml) の `database_id` に設定します。

ローカルDBにmigrationを適用:

```bash
npm run db:migrations:local
```

本番DBにmigrationを適用:

```bash
npm run db:migrations:remote
```

## 環境変数

ローカルでは `.dev.vars.example` を `.dev.vars` にコピーして値を設定します。

```env
ADMIN_TOKEN=replace-with-long-random-token
GOOGLE_CLIENT_ID=replace-with-google-oauth-client-id
GOOGLE_CLIENT_SECRET=replace-with-google-oauth-client-secret
OAUTH_REDIRECT_URI=http://localhost:8787/oauth/callback

CALENDAR_A_ID=tsuchida@andex.tokyo
CALENDAR_B_ID=tsucchy.me@gmail.com
SYNC_DAYS=60
ENABLE_DELETE_SYNC=true
```

本番secret:

```bash
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put OAUTH_REDIRECT_URI
```

`CALENDAR_A_ID` / `CALENDAR_B_ID` / `SYNC_DAYS` / `ENABLE_DELETE_SYNC` は [wrangler.toml](/Users/yuki/Desktop/codex/sync-calendar/wrangler.toml) の `[vars]` に入っています。

## ローカル起動

```bash
npm run dev
```

ヘルスチェック:

```bash
curl http://localhost:8787/health
```

## 初回OAuth

ブラウザで以下を開きます。

```text
http://localhost:8787/oauth/start
```

両方のカレンダーに読み書きできるGoogleアカウントで認可してください。完了するとD1の `oauth_tokens` にトークンが保存されます。

## 初回同期

```bash
curl -X POST http://localhost:8787/sync \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

初回は `timeMin` / `timeMax` 付きのフル同期を行い、成功後に各カレンダーの `syncToken` を保存します。

## 手動同期

```bash
curl -X POST https://<your-worker-domain>/sync \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

## Cron同期

[wrangler.toml](/Users/yuki/Desktop/codex/sync-calendar/wrangler.toml) では15分ごとのCronを設定しています。

```toml
[triggers]
crons = ["*/15 * * * *"]
```

デプロイ:

```bash
npm run deploy
```

Cloudflare WorkersのCron Triggersから定期実行されます。

## ステータス確認

```bash
curl https://<your-worker-domain>/sync/status \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

`sync_state`、直近の実行履歴、ロック状態、ペア数、OAuth状態を返します。

## 安全に検証する手順

1. まず検証用カレンダーを2つ作り、`CALENDAR_A_ID` / `CALENDAR_B_ID` を検証用に差し替えます。
2. 安全確認中は `ENABLE_DELETE_SYNC=false` で開始し、問題なければ `true` にします。
3. Aだけに予定を1件作り、手動同期でBにコピーされることを確認します。
4. B側で `summary` / `description` / `location` / 時刻を変更し、手動同期でAに反映されることを確認します。
5. AとBを両方変更してから同期し、`updated` が新しい側の内容が勝つことを確認します。
6. `ENABLE_DELETE_SYNC=false` では片側削除時に相手側が削除されず、`event_pairs.status = delete_recorded` になることを確認します。
7. 問題なければ本番カレンダーIDへ戻し、初回同期前に重要予定のバックアップを取ります。

D1の中身を確認する例:

```bash
npx wrangler d1 execute calendar_sync_db --local --command "SELECT pair_id, calendar_a_event_id, calendar_b_event_id, status FROM event_pairs LIMIT 20"
```

## 注意点

- 既存の同一予定をA/B両方に手作業で作っている場合、初回同期では同一性を推測せず、それぞれを別予定として反対側へコピーします。
- 繰り返し予定は展開インスタンス単位で扱います。v1では繰り返しルール自体の完全同期は行いません。
- 参加者、通知、会議URL、添付ファイルは意図的に同期しません。
- `ENABLE_DELETE_SYNC=true` では片側削除を相手側にも反映します。重要予定の削除前は意図したカレンダーを操作しているか確認してください。
