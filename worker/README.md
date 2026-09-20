# buddyai-contact — 問い合わせ受付 Worker

`index.html` の問い合わせフォームを受け取り、TypeSafe の System One モデル **Jev** で
緊急度・分類・不満度を判定してから通知する Cloudflare Worker。

サイトは GitHub Pages の静的ホスティングなので、`TYPESAFE_API_KEY` をブラウザに置けない。
判定は必ずこの Worker の中で行い、キーは Cloudflare の Secret に保管する。

## 判定の設計

Jev には「生の判断」だけを聞き、優先度の決定は `src/triage.js` の `decidePriority()` が持つ。
しきい値を変えても再推論は不要。

| 質問 | 型 | 返り値 |
|---|---|---|
| `urgency` | Noul | 利用が止まっている / 誤請求 / 明確な締切 かの確率 |
| `category` | Choice | `billing` `bug` `how_to` `account_data` `feature_request` `other` |
| `frustration` | Score | 0=平静 1=苛立ち 2=強い怒り（確率加重なので中間値になる） |
| `privacy_or_safety` | Noul | データ削除要求・セキュリティ・法令・安全上の懸念 |
| `spam` | Noul | 営業・広告・無意味な送信 |

5問を1リクエストで並列に投げる。1件あたり約1,200 input tokens、実測 200〜550ms。

### 優先度のルール（`THRESHOLDS`）

| 優先度 | 条件 | 目安 |
|---|---|---|
| `spam` | spam ≥ 0.85 | 対応不要 |
| `P1` | 法令/安全 ≥ 0.5 **または** 緊急 ≥ 0.8 **または** 不満 ≥ 1.5 **または**（緊急 ≥ 0.5 かつ 不満 ≥ 0.9） | 当日中 |
| `P2` | 緊急 ≥ 0.5 または 不満 ≥ 0.9 | 翌営業日 |
| `P3` | それ以外 | 3営業日以内 |

`category` の confidence が 0.5 未満なら `needsHumanRouting` が立ち、自動振り分けせず通知に「※要確認」と出る。

丁寧に書かれたデータ削除要求が `P1` になるのは意図した挙動（緊急度 0.03 でも法令要件 0.87）。

### しきい値を変えるときは

```bash
source ~/.zshrc && node scripts/triage-eval.mjs
```

代表9ケースを実データで通して期待値と突き合わせる。現状 9/9 一致。
数字を動かす前に、まず質問文（`QUESTIONS` の `criteria`）を疑うこと。
「起動できない」の緊急度は、criteria に「全く使えない状態は締切がなくても該当する」と
書き足しただけで 0.55 → 0.91 に変わった。

## デプロイ

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put TYPESAFE_API_KEY    # console.typesafe.ai/keys のキーを貼る
npx wrangler deploy
```

**Worker を作ってからでないと Secret を登録できない**ので、必ず `deploy` が先。
workers.dev サブドメインが未登録なら、ダッシュボードの Compute → Workers & Pages から
アカウントのサブドメインを登録する（アカウント全体で 1 つ、無料）。DNS 反映に数分かかる。

本番エンドポイント（登録済み）:

```js
var CONTACT_ENDPOINT = "https://buddyai-contact.kenkonworks.workers.dev/api/contact";
```

## 通知先（任意・両方使える）

未設定でも問い合わせは失われず、`wrangler tail` のログに全文が残る。
Webhook が 4xx/5xx を返した場合も、理由と本文をログに出してから握りつぶす。

### Slack

1. https://api.slack.com/apps → **Create New App** → *From scratch*
   名前は `Buddy AI 問い合わせ`、ワークスペースを選ぶ
2. 左メニュー **Incoming Webhooks** → トグルを **On**
3. **Add New Webhook to Workspace** → 通知したいチャンネルを選んで **許可する**
4. 生成された `https://hooks.slack.com/services/...` をコピー
5. Worker に登録する（貼り付けは画面に表示されない）

```bash
cd worker && npx wrangler secret put NOTIFY_WEBHOOK
```

`src/notify.js` が URL から Slack を判別し、Block Kit 形式で送る。
優先度が添付の色に出るので、チャンネルの一覧から P1 だけ拾える。

| 優先度 | 色 |
|---|---|
| P1 | 赤 `#E01E5A` |
| P2 | 黄 `#ECB22E` |
| P3 | 緑 `#2EB67D` |
| spam | 灰 `#868686` |

メッセージには差出人・受信時刻・判定根拠・4指標が並び、末尾の `mailto:` リンクから直接返信できる。

### Discord

同じ `NOTIFY_WEBHOOK` に Discord の Webhook URL を入れるだけ。
URL で判別して Embed 形式に切り替わる。それ以外の URL は `{text, content}` の汎用形式で送る。

### メール（Resend）

```bash
npx wrangler secret put RESEND_API_KEY
# wrangler.toml の [vars] に NOTIFY_EMAIL と FROM_EMAIL を足す
```

### 通知ペイロードの検証

```bash
source ~/.zshrc && node scripts/notify-test.mjs
```

Block Kit の上限（header 150字・section 3000字・field 2000字・blocks 50個）を超えていないか、
長文や `<` `&` を含む本文でも壊れないかを確認する。現状 5/5。

## ローカル開発

```bash
cd worker
cp /dev/null .dev.vars
echo "TYPESAFE_API_KEY=<キー>" >> .dev.vars
echo "ALLOWED_ORIGINS=https://codebluetokyo-commits.github.io,http://localhost:8080" >> .dev.vars
npx wrangler dev --port 8788 --local
```

`.dev.vars` は `.gitignore` 済み。**`.dev.vars` を編集したら dev サーバーを再起動すること**（起動中の変更は反映されない）。

## ファイル

| ファイル | 役割 |
|---|---|
| `src/index.js` | 受付・検証・CORS・通知の送出 |
| `src/triage.js` | Jev への質問定義と優先度ルール |
| `src/notify.js` | Slack / Discord / プレーンテキストのペイロード組み立て |
| `src/turnstile.js` | Turnstile のサーバー側検証 |

## 設計上の判断

- **氏名とメールアドレスは TypeSafe に送らない。** 判定に不要な個人情報を外部に出さないため、
  `state` に入れるのは問い合わせ本文だけ。
- **判定に失敗しても問い合わせは受け付ける。** Jev がエラーや timeout を返した場合は
  優先度 `unknown` として通知し、取りこぼさない方を優先する。
- **判定結果はブラウザに返さない。** 送信者が自分の優先度を見て文面を調整できてしまうため、
  レスポンスは `{"ok":true}` のみ。
- **ハニーポット。** `website` フィールドに入力があるボットには 200 を返して静かに捨てる
  （Jev も呼ばない）。

## レート制限

`*.workers.dev` は自分のゾーンではないため、ダッシュボードの WAF / Rate Limiting Rules は
使えない。Worker の Rate Limiting バインディング（wrangler 4.36.0 以降）で制限している。

| バインディング | キー | 上限 |
|---|---|---|
| `RATE_LIMIT_IP` | 送信元 IP（IPv6 は /64 に丸める） | 3 件 / 60 秒 |
| `RATE_LIMIT_GLOBAL` | 固定値 `contact` | 60 件 / 60 秒 |

判定は本文のパースより前に行うので、弾いたリクエストで Jev は呼ばれずコストも発生しない。

IPv6 を /64 に丸めているのは、1 契約に /64 が割り当てられるため。アドレス全体をキーに
すると、同じ回線からいくらでも別カウンタを作れてしまう。

### 効き方の限界（実測）

**カウンタはエッジサーバー単位で独立している。** 同一 TCP 接続で連投した場合は設計どおり
4 件目から 429 を返すが、毎回新しい接続を張ると別サーバーに振り分けられ、それぞれが
別カウンタを持つ。実測では、接続を使い回した 8 連投は `400 400 400 429 429 …` と正しく
制限され、毎回接続し直した 8 連投は全件通過した。

つまり実効は「1 接続あたり 3 件 / 分」であって「1 IP あたり 3 件 / 分」ではない。
ブラウザのフォーム送信は接続を使い回すので通常の連投には効くが、接続を張り直す
スクリプトには緩い。

正確に制限するなら Durable Objects（Workers 有料プランが必要）を足すこと。
bot 対策としては後述の Turnstile を併用している。

## Turnstile（bot 対策）

レート制限がエッジサーバー単位でしか効かないため、bot 自体を止める層として併用する。
接続を張り直しても回避できない。

- サイトキー … 公開値。`index.html` の `TURNSTILE_SITEKEY` に直接書く
- シークレットキー … `wrangler secret put TURNSTILE_SECRET`

ウィジェットは https://dash.cloudflare.com/?to=/:account/turnstile で作成する。
**ホスト名に `codebluetokyo-commits.github.io` を登録すること。** 未登録だと
トークンが hostname 検証で弾かれる。

検証は入力検証の後、Jev 呼び出しの前に行う。弾いたリクエストで Jev は呼ばれない。

| 状況 | 挙動 |
|---|---|
| トークンなし | 403「認証が完了していません」 |
| 不正・期限切れ・使用済み | 403「認証の有効期限が切れました」 |
| Turnstile に到達できない | **通す**（ログに記録） |
| `TURNSTILE_SECRET` 未設定 | 検証をスキップ（警告ログ） |

Turnstile 到達不能時に通すのは、Cloudflare 側の障害で正規の問い合わせを失う方が
損害が大きいため。

トークンは発行から 300 秒で失効し、一度しか使えない。送信のたびに
`turnstile.reset()` でウィジェットを作り直している。

### テストキー

実キーなしで全経路を検証できる（`docs: turnstile/troubleshooting/testing`）。

| キー | 挙動 |
|---|---|
| サイト `1x00000000000000000000AA` | 常に合格 |
| サイト `2x00000000000000000000AB` | 常に不合格 |
| シークレット `1x0000000000000000000000000000000AA` | 常に合格 |
| シークレット `2x0000000000000000000000000000000AA` | 常に不合格 |
| シークレット `3x0000000000000000000000000000000AA` | 使用済みトークン扱い |
