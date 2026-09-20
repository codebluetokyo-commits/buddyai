/**
 * Cloudflare Turnstile のサーバー側検証。
 * https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 *
 * トークンは発行から 300 秒で失効し、一度しか使えない（二度目は timeout-or-duplicate）。
 */
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** 利用者に見せるメッセージ。内部のエラーコードはそのまま出さない。 */
const MESSAGE = {
  'missing-input-response': '認証が完了していません。チェックが終わってから送信してください。',
  'invalid-input-response': '認証の有効期限が切れました。お手数ですが、もう一度送信してください。',
  'timeout-or-duplicate': '認証の有効期限が切れました。お手数ですが、もう一度送信してください。',
};
const FALLBACK = '認証に失敗しました。ページを再読み込みしてお試しください。';

/**
 * @returns {Promise<{ok:true} | {ok:false, error:string, codes:string[]}>}
 */
export async function verifyTurnstile(token, secret, ip, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  if (!token) {
    return { ok: false, error: MESSAGE['missing-input-response'], codes: ['missing-input-response'] };
  }

  const form = new URLSearchParams();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(SITEVERIFY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: FALLBACK, codes: [`http-${res.status}`] };
    }
    const data = await res.json();
    if (data.success) return { ok: true };

    const codes = data['error-codes'] ?? [];
    const error = codes.map((c) => MESSAGE[c]).find(Boolean) ?? FALLBACK;
    return { ok: false, error, codes };
  } catch (e) {
    // Turnstile 自体に到達できない場合。問い合わせを失わせたくないので、
    // 呼び出し側でどう扱うかを決められるよう専用のコードを返す。
    return { ok: false, error: FALLBACK, codes: ['unreachable'], unreachable: true };
  } finally {
    clearTimeout(timer);
  }
}
