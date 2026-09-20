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
import { verifyTurnstile } from './turnstile.js';

const DEFAULT_ORIGINS = ['https://codebluetokyo-commits.github.io'];

const LIMITS = { name: 100, email: 254, message: 4000, messageMin: 5 };

/**
 * レート制限のキー。
 * IPv6 は 1 契約に /64 が割り当てられるため、アドレス全体をキーにすると
 * 同じ回線からいくらでも別カウンタを作れてしまう。前半 4 グループに丸める。
 * IPv4 はそのまま使う。
 */
export function rateLimitKey(ip) {
  if (!ip) return 'unknown';
  if (!ip.includes(':')) return ip;

  // "::" を展開してから先頭 4 グループ（/64）を取る
  const [head, tail = ''] = ip.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const fill = ip.includes('::') ? Array(8 - headParts.length - tailParts.length).fill('0') : [];
  const groups = [...headParts, ...fill, ...tailParts].slice(0, 4);
  return groups.map((g) => (g || '0').toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

/**
 * レート制限。バインディングが無い環境（未設定や古い wrangler）では素通りさせる。
 * カウンタは Cloudflare のロケーションごとに独立しているため、厳密な総量規制ではなく
 * 「連投と通知の氾濫を止める」ことを目的にしている。
 * @returns {Promise<null | {scope:string, key:string}>} 制限に掛かった場合だけ理由を返す
 */
async function checkRateLimit(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = rateLimitKey(ip);

  if (env.RATE_LIMIT_IP) {
    const { success } = await env.RATE_LIMIT_IP.limit({ key });
    if (!success) return { scope: 'ip', key };
  }
  if (env.RATE_LIMIT_GLOBAL) {
    const { success } = await env.RATE_LIMIT_GLOBAL.limit({ key: 'contact' });
    if (!success) return { scope: 'global', key };
  }
  return null;
}

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

  const turnstileToken = String(body?.turnstileToken ?? '').trim();

  if (honeypot) return { error: null, spamTrap: true };
  if (!message) return { error: 'お問い合わせ内容を入力してください。' };
  if (message.length < LIMITS.messageMin) return { error: 'お問い合わせ内容が短すぎます。' };
  if (message.length > LIMITS.message) return { error: `お問い合わせ内容は${LIMITS.message}文字以内で入力してください。` };
  if (!email) return { error: 'メールアドレスを入力してください。' };
  if (email.length > LIMITS.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: 'メールアドレスの形式が正しくありません。' };
  }
  if (name.length > LIMITS.name) return { error: `お名前は${LIMITS.name}文字以内で入力してください。` };

  return { error: null, data: { name: name || '(未記入)', email, message }, turnstileToken };
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

    // Jev を呼ぶ前に弾く。本文のパースより前なので、連投のコストはほぼゼロで済む
    const limited = await checkRateLimit(request, env);
    if (limited) {
      console.warn(`[contact] レート制限 (${limited.scope}) key=${limited.key}`);
      return json(
        { ok: false, error: '送信が集中しています。しばらく時間をおいてからお試しください。' },
        429,
        { ...cors, 'Retry-After': '60' }
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: '送信データを読み取れませんでした。' }, 400, cors);
    }

    const { error, data, spamTrap, turnstileToken } = validate(body);
    if (error) return json({ ok: false, error }, 400, cors);
    // ボットには成功を返して静かに捨てる
    if (spamTrap) return json({ ok: true }, 200, cors);

    // bot をここで止める。Jev を呼ぶ前なので、弾いたリクエストのコストは発生しない。
    if (env.TURNSTILE_SECRET) {
      const ip = request.headers.get('CF-Connecting-IP') || undefined;
      const v = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET, ip);
      if (!v.ok) {
        if (v.unreachable) {
          // Turnstile に到達できないのは Cloudflare 側の問題。
          // ここで弾くと正規の問い合わせまで失うので、通したうえで通知に印を付ける。
          console.error('[contact] Turnstile に到達できず、検証を省略しました');
        } else {
          console.warn(`[contact] Turnstile 検証に失敗: ${v.codes.join(',')}`);
          return json({ ok: false, error: v.error }, 403, cors);
        }
      }
    } else {
      console.warn('[contact] TURNSTILE_SECRET が未設定のため bot 検証を行っていません');
    }

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
