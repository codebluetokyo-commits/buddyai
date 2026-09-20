#!/usr/bin/env node
/**
 * 緊急度判定の検証ハーネス。
 * 代表的な日本語の問い合わせを Jev に通し、期待する優先度と一致するか確認する。
 * しきい値（worker/src/triage.js の THRESHOLDS）を動かす前後で必ず実行すること。
 *
 *   source ~/.zshrc && node scripts/triage-eval.mjs
 */
import { classify, decidePriority, CATEGORY_LABEL_JA } from '../worker/src/triage.js';

const API_KEY = process.env.TYPESAFE_API_KEY;
if (!API_KEY) {
  console.error('TYPESAFE_API_KEY が未設定です。 source ~/.zshrc してから実行してください。');
  process.exit(1);
}

/** 期待値は「こう振り分いてほしい」という運用上の意図。モデルの出力を写したものではない。 */
const CASES = [
  {
    name: '起動できない',
    message: 'アップデートしてからアプリが開けません。タップしても一瞬で落ちます。仕事で毎日使っているので困っています。',
    expect: { priority: 'P1', category: 'bug' },
  },
  {
    name: '二重課金・怒り',
    message: '先月解約したはずなのに今月も引き落とされています。問い合わせるのは二度目です。すぐ返金してください。消費者センターに相談します。',
    expect: { priority: 'P1', category: 'billing' },
  },
  {
    name: 'データ削除要求（丁寧）',
    message: 'お世話になっております。これまで保存された会話の記録を、すべて削除していただくことは可能でしょうか。お手すきの際にご確認ください。',
    expect: { priority: 'P1', category: 'account_data' },
  },
  {
    name: '使い方の質問',
    message: '記憶してほしくない内容を個別に消す方法を教えてください。設定画面のどこにありますか。',
    expect: { priority: 'P3', category: 'how_to' },
  },
  {
    name: '機能要望',
    message: 'いつも楽しく使っています。キャラクターの声を変えられると嬉しいです。ご検討ください。',
    expect: { priority: 'P3', category: 'feature_request' },
  },
  {
    name: '軽い不満',
    message: '音声認識の精度がいまひとつです。方言が混じると全然違う言葉になります。改善されないのでしょうか。',
    expect: { priority: 'P2', category: 'bug' },
  },
  {
    // 自分で消す方法を聞いているだけ。運営へのデータ削除要求（P1）と区別できるか
    name: '削除方法の質問',
    message: '記憶の消し方を教えてください。',
    expect: { priority: 'P3', category: 'how_to' },
  },
  {
    name: 'スパム',
    message: 'SEO対策のご提案です。貴社サイトを検索上位に表示させませんか。初期費用無料。詳しくは以下のリンクから https://example.com/seo',
    expect: { priority: 'spam' },
  },
  {
    name: 'Android可否',
    message: 'Android版の予定はありますか。',
    expect: { priority: 'P3', category: 'how_to' },
  },
];

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - [...String(s)].length));

let pass = 0;
let totalMs = 0;
const rows = [];

for (const c of CASES) {
  const t0 = Date.now();
  const res = await classify(c.message, API_KEY);
  const ms = Date.now() - t0;
  totalMs += ms;

  const d = decidePriority(res.answers);
  const priorityOk = d.priority === c.expect.priority;
  const categoryOk = c.expect.category === undefined || d.category === c.expect.category;
  const ok = priorityOk && categoryOk;
  if (ok) pass++;

  rows.push({ c, d, ms, ok, priorityOk, categoryOk, usage: res.usage });
}

console.log('\n' + pad('ケース', 22) + pad('優先度', 10) + pad('分類', 22) + pad('緊急', 7) + pad('不満', 7) + pad('法令', 7) + pad('ms', 6));
console.log('-'.repeat(82));
for (const r of rows) {
  const mark = r.ok ? '  ' : '✗ ';
  const prio = r.priorityOk ? r.d.priority : `${r.d.priority}(≠${r.c.expect.priority})`;
  const cat = r.d.priority === 'spam' ? '—' : (r.categoryOk ? CATEGORY_LABEL_JA[r.d.category] : `${CATEGORY_LABEL_JA[r.d.category]}(≠${CATEGORY_LABEL_JA[r.c.expect.category]})`);
  console.log(
    mark + pad(r.c.name, 20) + pad(prio, 10) + pad(cat, 22) +
    pad(r.d.signals.urgency.toFixed(2), 7) +
    pad(r.d.signals.frustration.toFixed(2), 7) +
    pad(r.d.signals.privacyOrSafety.toFixed(2), 7) +
    pad(r.ms, 6)
  );
}
console.log('-'.repeat(82));
console.log(`${pass}/${CASES.length} 一致   平均 ${Math.round(totalMs / CASES.length)}ms`);

for (const r of rows.filter((r) => !r.ok)) {
  console.log(`\n✗ ${r.c.name}: ${r.d.reasons.join(' / ')}`);
}
process.exit(pass === CASES.length ? 0 : 1);
