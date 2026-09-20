/**
 * 通知の組み立て。
 * Webhook の URL から宛先サービスを判別し、それぞれに合った形で送る。
 */
import { CATEGORY_LABEL_JA, PRIORITY_TARGET_JA } from './triage.js';

export const PRIORITY_EMOJI = { P1: '🔴', P2: '🟠', P3: '🟢', spam: '⚫️', unknown: '⚪️' };

/** Slack の添付色。サイドバーの色で一覧から P1 を拾えるようにする。 */
const PRIORITY_COLOR = {
  P1: '#E01E5A',
  P2: '#ECB22E',
  P3: '#2EB67D',
  spam: '#868686',
  unknown: '#4A90C4',
};

/** Slack の mrkdwn で特別扱いされる 3 文字をエスケープする */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function categoryLabel(verdict) {
  if (verdict.priority === 'spam') return '—';
  return CATEGORY_LABEL_JA[verdict.category] ?? verdict.category;
}

function signalLine(signals) {
  const f = (v) => (typeof v === 'number' ? v.toFixed(2) : '—');
  return `緊急 ${f(signals.urgency)} ／ 不満 ${f(signals.frustration)} ／ 法令 ${f(signals.privacyOrSafety)} ／ スパム ${f(signals.spam)}`;
}

/** メールや Worker のログに出すプレーンテキスト */
export function buildPlainText(data, verdict, receivedAt) {
  const emoji = PRIORITY_EMOJI[verdict.priority] ?? '⚪️';
  return [
    `${emoji} ${verdict.priority} ${PRIORITY_TARGET_JA[verdict.priority] ?? ''}`,
    `分類: ${categoryLabel(verdict)}${verdict.needsHumanRouting ? ' ※要確認' : ''}`,
    `根拠: ${verdict.reasons.join(' / ')}`,
    `指標: ${signalLine(verdict.signals)}`,
    '',
    `差出人: ${data.name} <${data.email}>`,
    `受信: ${receivedAt}`,
    '',
    truncate(data.message, 1500),
  ].join('\n');
}

/**
 * Slack Incoming Webhook 用。
 * header は plain_text のみ・150文字まで、section text は 3000文字まで、fields は各2000文字まで。
 */
export function buildSlackPayload(data, verdict, receivedAt) {
  const emoji = PRIORITY_EMOJI[verdict.priority] ?? '⚪️';
  const target = PRIORITY_TARGET_JA[verdict.priority] ?? '';
  const cat = categoryLabel(verdict);
  const subject = truncate(data.message.replace(/\s+/g, ' '), 80);

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: truncate(`${emoji} ${verdict.priority} ${target}`, 150), emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*分類*\n${esc(cat)}${verdict.needsHumanRouting ? ' :warning: 要確認' : ''}` },
        { type: 'mrkdwn', text: `*受信*\n${esc(receivedAt)}` },
        { type: 'mrkdwn', text: `*差出人*\n${esc(truncate(data.name, 60))}` },
        { type: 'mrkdwn', text: `*根拠*\n${esc(truncate(verdict.reasons.join(' / '), 300))}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '```\n' + esc(truncate(data.message, 2800)) + '\n```' },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `<mailto:${encodeURI(data.email)}|${esc(data.email)} に返信> ・ ${esc(signalLine(verdict.signals))}`,
        },
      ],
    },
  ];

  return {
    // 通知バナーとプッシュ通知に出る要約
    text: `${emoji} ${verdict.priority} ${cat} — ${subject}`,
    attachments: [
      {
        color: PRIORITY_COLOR[verdict.priority] ?? PRIORITY_COLOR.unknown,
        blocks,
      },
    ],
  };
}

/** Discord Incoming Webhook 用 */
export function buildDiscordPayload(data, verdict, receivedAt) {
  const emoji = PRIORITY_EMOJI[verdict.priority] ?? '⚪️';
  const color = parseInt((PRIORITY_COLOR[verdict.priority] ?? PRIORITY_COLOR.unknown).slice(1), 16);
  return {
    embeds: [
      {
        title: truncate(`${emoji} ${verdict.priority} ${PRIORITY_TARGET_JA[verdict.priority] ?? ''}`, 256),
        description: truncate(data.message, 3000),
        color,
        fields: [
          { name: '分類', value: categoryLabel(verdict) + (verdict.needsHumanRouting ? ' ※要確認' : ''), inline: true },
          { name: '差出人', value: truncate(`${data.name} <${data.email}>`, 1024), inline: true },
          { name: '根拠', value: truncate(verdict.reasons.join(' / '), 1024) },
          { name: '指標', value: signalLine(verdict.signals) },
        ],
        footer: { text: receivedAt },
      },
    ],
  };
}

/** Webhook URL から宛先を判別してペイロードを選ぶ */
export function buildWebhookPayload(url, data, verdict, receivedAt) {
  if (/^https:\/\/hooks\.slack\.com\//.test(url)) return buildSlackPayload(data, verdict, receivedAt);
  if (/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(url)) {
    return buildDiscordPayload(data, verdict, receivedAt);
  }
  // 判別できない場合は text と content の両方を入れて送る
  const text = buildPlainText(data, verdict, receivedAt);
  return { text, content: text };
}
