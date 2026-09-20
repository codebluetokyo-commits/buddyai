#!/usr/bin/env node
/**
 * Slack / Discord 通知ペイロードの検証。
 * Block Kit の制約（文字数上限・ブロック数）を超えていないか、長文や特殊文字でも壊れないかを見る。
 *
 *   source ~/.zshrc && node scripts/notify-test.mjs
 */
import { classify, decidePriority } from '../worker/src/triage.js';
import { buildSlackPayload, buildDiscordPayload, buildWebhookPayload } from '../worker/src/notify.js';

const API_KEY = process.env.TYPESAFE_API_KEY;
if (!API_KEY) { console.error('TYPESAFE_API_KEY が未設定です。'); process.exit(1); }

/** Slack Block Kit の上限。超えると 400 invalid_blocks で黙って落ちる。 */
function validateSlack(p) {
  const errs = [];
  if (!p.text) errs.push('text（通知バナー用の要約）がない');
  if (p.text && p.text.length > 3000) errs.push(`text が ${p.text.length} 文字`);
  if (!Array.isArray(p.attachments) || p.attachments.length === 0) errs.push('attachments がない');

  for (const a of p.attachments ?? []) {
    if (!/^#[0-9A-Fa-f]{6}$/.test(a.color ?? '')) errs.push(`color が不正: ${a.color}`);
    const blocks = a.blocks ?? [];
    if (blocks.length > 50) errs.push(`blocks が ${blocks.length} 個`);

    for (const b of blocks) {
      if (b.type === 'header') {
        if (b.text?.type !== 'plain_text') errs.push('header は plain_text のみ');
        if ((b.text?.text ?? '').length > 150) errs.push(`header が ${b.text.text.length} 文字 (>150)`);
      }
      if (b.type === 'section') {
        if (b.text && b.text.text.length > 3000) errs.push(`section text が ${b.text.text.length} 文字 (>3000)`);
        if (b.fields) {
          if (b.fields.length > 10) errs.push(`fields が ${b.fields.length} 個 (>10)`);
          for (const f of b.fields) {
            if (f.text.length > 2000) errs.push(`field が ${f.text.length} 文字 (>2000)`);
          }
        }
        if (!b.text && !b.fields) errs.push('section に text も fields もない');
      }
      if (b.type === 'context' && (b.elements ?? []).length > 10) errs.push('context elements が 10 個超');
    }
  }
  // JSON 化できること（Slack は 1MB 上限）
  const size = new TextEncoder().encode(JSON.stringify(p)).length;
  if (size > 1_000_000) errs.push(`ペイロードが ${size} バイト`);
  return { errs, size };
}

const CASES = [
  { name: '緊急な不具合', data: { name: '山田太郎', email: 'yamada@example.com',
      message: 'アップデート後アプリが全く開きません。仕事で使っているので至急お願いします。' } },
  { name: '丁寧なデータ削除要求', data: { name: '佐藤', email: 'sato@example.com',
      message: 'お世話になっております。保存された会話をすべて削除していただけますでしょうか。' } },
  { name: '記号を含む本文', data: { name: '<script>alert(1)</script>', email: 'x&y@example.com',
      message: 'エラーが出ます: `if (a < b && c > d)` の画面で落ちます。<b>太字</b>も表示が変です。' } },
  { name: '長文4000字', data: { name: 'あ'.repeat(120), email: 'long@example.com',
      message: 'アプリが落ちます。'.repeat(400).slice(0, 4000) } },
  { name: '氏名未記入・短文', data: { name: '(未記入)', email: 'z@example.com',
      message: 'Android版は出ますか' } },
];

let fail = 0;
for (const c of CASES) {
  const res = await classify(c.data.message, API_KEY);
  const verdict = decidePriority(res.answers);
  const receivedAt = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

  const slack = buildSlackPayload(c.data, verdict, receivedAt);
  const { errs, size } = validateSlack(slack);
  const discord = buildDiscordPayload(c.data, verdict, receivedAt);

  // URL 判別が正しく効くか
  const routed = buildWebhookPayload('https://hooks.slack.com/services/T0/B0/xxx', c.data, verdict, receivedAt);
  const routedDiscord = buildWebhookPayload('https://discord.com/api/webhooks/1/x', c.data, verdict, receivedAt);
  const routedOther = buildWebhookPayload('https://example.com/hook', c.data, verdict, receivedAt);
  if (!routed.attachments) errs.push('Slack URL が Slack 形式に振り分けられていない');
  if (!routedDiscord.embeds) errs.push('Discord URL が Discord 形式に振り分けられていない');
  if (!routedOther.text || !routedOther.content) errs.push('未知の URL がフォールバックになっていない');
  if (!discord.embeds[0].title) errs.push('Discord の title がない');

  const ok = errs.length === 0;
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${c.name.padEnd(22)} ${verdict.priority.padEnd(8)} ${String(size).padStart(5)}B`);
  for (const e of errs) console.log(`    ✗ ${e}`);
}

// 1件だけ実際の JSON を目視確認用に出す
const res = await classify(CASES[0].data.message, API_KEY);
const verdict = decidePriority(res.answers);
console.log('\n--- Slack に送る JSON（緊急な不具合） ---');
console.log(JSON.stringify(buildSlackPayload(CASES[0].data, verdict, '2026/9/20 17:45:00'), null, 2));

console.log(`\n${CASES.length - fail}/${CASES.length} 件が Block Kit の制約を満たしています`);
process.exit(fail === 0 ? 0 : 1);
