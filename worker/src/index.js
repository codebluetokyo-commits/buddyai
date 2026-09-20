/**
 * Buddy AI 問い合わせ受付 Worker
 *
 * POST /api/contact  … フォームを受け取り、Jev で緊急度を判定して通知する
 *
 * 必須シークレット: TYPESAFE_API_KEY
 * 任意の変数:
 *   ALLOWED_ORIGINS  カンマ区切り。既定は GitHub Pages の本番URL
 *   NOTIFY_WEBHOOK   Slack / Discord の Incoming Webhook URL
 *   RESEND_API_KEY   メール通知を使う場合
 *   NOTIFY_EMAIL     通知の宛先
 *   FROM_EMAIL       Resend で認証済みの送信元
 */
import { classify, decidePriority } from './triage.js';
import { buildPlainText, buildWebhookPayload } from './notify.js';

const DEFAULT_ORIGINS = ['https://codebluetokyo-commits.github.io'];

const LIMITS = { name: 100, email: 254, message: 4000, messageMin: 5 };

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(',')).split(',').map((s) => s.trim());
  const origin = request.headers.get('Origin') || '';
  const ok = allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

/** 受信データの検証。エラー文は利用者に見せるので日本語で返す。 */
function validate(body) {
  const name = String(body?.name ?? '').trim();
  const email = String(body?.email ?? '').trim();
  const message = String(body?.message ?? '').trim();
  const honeypot = String(body?.website ?? '').trim();

  if (honeypot) return { error: null, spamTrap: true };
  if (!message) return { error: 'お問い合わせ内容を入力してください。' };
  if (message.length < LIMITS.messageMin) return { error: 'お問い合わせ内容が短すぎます。' };
  if (message.length > LIMITS.message) return { error: `お問い合わせ内容は${LIMITS.message}文字以内で入力してください。` };
  if (!email) return { error: 'メールアドレスを入力してください。' };
  if (email.length > LIMITS.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: 'メールアドレスの形式が正しくありません。' };
  }
  if (name.length > LIMITS.name) return { error: `お名前は${LIMITS.name}文字以内で入力してください。` };

  return { error: null, data: { name: name || '(未記入)', email, message } };
}

async function notify(data, verdict, receivedAt, env, ctx) {
  const jobs = [];
  const text = buildPlainText(data, verdict, receivedAt);

  if (env.NOTIFY_WEBHOOK) {
    const payload = buildWebhookPayload(env.NOTIFY_WEBHOOK, data, verdict, receivedAt);
    jobs.push(
      fetch(env.NOTIFY_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(async (r) => {
          // Slack は失敗時も 200 以外 + 本文で理由を返す。取りこぼすと通知が黙って消えるのでログに残す
          if (!r.ok) {
            console.error(`[notify] webhook ${r.status}: ${(await r.text()).slice(0, 200)}`);
            console.log('[notify] 送信できなかった内容:\n' + text);
          }
        })
        .catch((e) => {
          console.error('[notify] webhook 失敗:', e.message);
          console.log('[notify] 送信できなかった内容:\n' + text);
        })
    );
  }

  if (env.RESEND_API_KEY && env.NOTIFY_EMAIL && env.FROM_EMAIL) {
    jobs.push(
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: env.FROM_EMAIL,
          to: [env.NOTIFY_EMAIL],
          subject: text.split('\n')[0],
          text,
        }),
      })
        .then(async (r) => {
          if (!r.ok) console.error(`[notify] resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
        })
        .catch((e) => console.error('[notify] resend 失敗:', e.message))
    );
  }

  if (jobs.length === 0) {
    // 通知先が未設定でも問い合わせを失わないよう、ログには必ず残す
    console.log('[contact] 通知先が未設定です。内容をログに記録します:\n' + text);
    return;
  }
  ctx.waitUntil(Promise.all(jobs));
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (url.pathname !== '/api/contact') return json({ error: 'Not found' }, 404, cors);
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: '送信データを読み取れませんでした。' }, 400, cors);
    }

    const { error, data, spamTrap } = validate(body);
    if (error) return json({ ok: false, error }, 400, cors);
    // ボットには成功を返して静かに捨てる
    if (spamTrap) return json({ ok: true }, 200, cors);

    if (!env.TYPESAFE_API_KEY) {
      console.error('TYPESAFE_API_KEY が未設定です');
    }

    const receivedAt = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

    // 判定に失敗しても問い合わせは必ず受け付ける（取りこぼさない方を優先する）
    let verdict = {
      priority: 'unknown',
      reasons: ['判定に失敗したため未分類'],
      category: 'other',
      needsHumanRouting: true,
      signals: {},
    };
    try {
      if (env.TYPESAFE_API_KEY) {
        const result = await classify(data.message, env.TYPESAFE_API_KEY);
        verdict = decidePriority(result.answers);
        console.log(`[contact] ${verdict.priority} ${verdict.category} usage=${JSON.stringify(result.usage)}`);
      }
    } catch (e) {
      console.error('[contact] 緊急度判定に失敗:', e.message);
      verdict.reasons = [`判定に失敗 (${e.message.slice(0, 80)})`];
    }

    await notify(data, verdict, receivedAt, env, ctx);

    // 判定結果は返さない（送信者が優先度を操作できないようにする）
    return json({ ok: true }, 200, cors);
  },
};
