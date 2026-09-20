/**
 * 問い合わせの緊急度判定（TypeSafe / Jev）
 *
 * 設計方針:
 *  - Jev には「生の判断」だけを聞く。優先度の決定はこのファイルの policy 関数が持つ。
 *    しきい値を変えても再推論は不要で、判断結果は再利用できる。
 *  - 氏名とメールアドレスは判定に不要なので state に含めない（PII を外部に出さない）。
 */

export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const MODEL = 'jev-latest';

/**
 * Jev に投げる質問。すべて同じ state に対する独立した判断なので 1 リクエストで並列に走る。
 * instructions は英語のまま（モデル向け）、criteria で日本語の問い合わせ文脈を説明する。
 */
export const QUESTIONS = {
  urgency: {
    type: 'noul',
    instructions:
      'Is the sender blocked right now, or will they suffer concrete harm if this is not handled today?',
    criteria: {
      true:
        'Any of these independently: the sender cannot use the app at all (it will not launch, crashes on open, or their data is gone); they were charged money incorrectly; or they state a hard deadline. A total loss of function counts even when the sender writes calmly and names no deadline. Japanese cues: 使えない / 開かない / 落ちる / 消えた / 二重請求 / 今すぐ / 至急.',
      false:
        'A question, a request, or a report that can wait a few business days without the sender losing anything. Polite phrasing alone is not urgency.',
    },
  },

  category: {
    type: 'choice',
    instructions: 'Which team should handle this inquiry about the Buddy AI iOS app?',
    criteria: {
      billing: {
        what: 'Subscription, payment, refunds, App Store charges, cancellation.',
        not_for: 'Asking what the price is before purchasing — that is how_to.',
        examples: ['二重に課金されている', '解約したのに請求が続く', '返金してほしい'],
      },
      bug: {
        what: 'The app crashes, fails to launch, loses data, or behaves incorrectly.',
        not_for: 'The user simply does not know where a feature is — that is how_to.',
        examples: ['アプリが落ちる', '会話が消えた', '音声が認識されない'],
      },
      how_to: {
        what: 'Usage questions, where a feature lives, what the app can do, pricing questions.',
        examples: ['記憶を消す方法が知りたい', 'Android版はありますか'],
      },
      account_data: {
        what: 'Personal data deletion or export requests, privacy policy questions, data handling.',
        examples: ['データを全部削除してほしい', '保存された内容を開示してほしい'],
      },
      feature_request: {
        what: 'Suggestions, wishes, and feedback about what the app should do.',
        examples: ['こういう機能がほしい', 'キャラクターを増やしてほしい'],
      },
      other: {
        what: 'Business inquiries, press, or anything that fits none of the above.',
      },
    },
  },

  frustration: {
    type: 'score',
    instructions: 'How upset is the sender with the product or the company?',
    criteria: [
      'Neutral or friendly. Asking, reporting, or suggesting without complaint.',
      'Clearly annoyed. Complains, repeats an unresolved problem, or expresses disappointment.',
      'Angry. Demands escalation, threatens to leave a bad review, cancel, or take legal or regulatory action.',
    ],
  },

  privacy_or_safety: {
    type: 'noul',
    instructions:
      'Does this require a legally or ethically time-bound response regardless of how politely it is written?',
    criteria: {
      true:
        'The sender asks the operator to act on their data — delete it, disclose it, or stop using it — or reports a security hole or leak, accuses the operator of breaking the law, or writes something suggesting they may be in danger or in crisis. 例: データを削除してください / 保存内容を開示してください.',
      false:
        'An ordinary product inquiry, including asking how to delete or manage data themselves inside the app. Wanting to know where the delete button is is a usage question, not a request directed at the operator. 例: 記憶の消し方を教えてください / 設定はどこですか.',
    },
  },

  spam: {
    type: 'noul',
    instructions: 'Is this automated spam, an advertisement, or a test submission with no real content?',
    criteria: {
      true: 'Sales pitches, SEO or marketing solicitation, unrelated link dumps, gibberish, or "test" only.',
      false: 'A genuine message from someone using or considering the app, even if very short.',
    },
  },
};

/**
 * 優先度の決定ルール。Jev の出力は変えずにここだけ調整できる。
 * 実データで検証してから数値を動かすこと（scripts/triage-eval.mjs）。
 */
export const THRESHOLDS = {
  spam: 0.85,
  privacyOrSafety: 0.5,
  urgentP1: 0.8,
  urgentP2: 0.5,
  frustrationP1: 1.5,
  frustrationP2: 0.9,
  categoryConfidence: 0.5,
};

/**
 * @param {object} answers Jev の answers オブジェクト
 * @returns {{priority:string, reasons:string[], category:string, needsHumanRouting:boolean, signals:object}}
 */
export function decidePriority(answers, thresholds = THRESHOLDS) {
  const urgency = answers.urgency?.noul ?? 0;
  const frustration = answers.frustration?.score ?? 0;
  const privacyOrSafety = answers.privacy_or_safety?.noul ?? 0;
  const spam = answers.spam?.noul ?? 0;
  const category = answers.category?.choice ?? 'other';
  const categoryConfidence = answers.category?.confidence ?? 0;

  const signals = { urgency, frustration, privacyOrSafety, spam, categoryConfidence };
  const reasons = [];

  if (spam >= thresholds.spam) {
    return {
      priority: 'spam',
      reasons: [`スパム判定 ${spam.toFixed(2)}`],
      category,
      needsHumanRouting: false,
      signals,
    };
  }

  let priority = 'P3';

  // 法令・安全にかかわるものは、丁寧に書かれていても単独で最優先にする
  if (privacyOrSafety >= thresholds.privacyOrSafety) {
    priority = 'P1';
    reasons.push(`法令/安全に関わる ${privacyOrSafety.toFixed(2)}`);
  }
  if (urgency >= thresholds.urgentP1) {
    priority = 'P1';
    reasons.push(`利用が止まっている ${urgency.toFixed(2)}`);
  }
  if (frustration >= thresholds.frustrationP1) {
    priority = 'P1';
    reasons.push(`強い不満 ${frustration.toFixed(2)}`);
  }

  // 単独ではP1に届かなくても、止まっていて かつ 不満がある場合は当日対応に上げる
  if (priority !== 'P1' && urgency >= thresholds.urgentP2 && frustration >= thresholds.frustrationP2) {
    priority = 'P1';
    reasons.push(`止まっていて不満もある ${urgency.toFixed(2)}/${frustration.toFixed(2)}`);
  }

  if (priority !== 'P1') {
    if (urgency >= thresholds.urgentP2) {
      priority = 'P2';
      reasons.push(`急ぎの可能性 ${urgency.toFixed(2)}`);
    }
    if (frustration >= thresholds.frustrationP2) {
      priority = 'P2';
      reasons.push(`不満あり ${frustration.toFixed(2)}`);
    }
  }

  if (reasons.length === 0) reasons.push('通常の問い合わせ');

  // 分類が割れている場合は自動振り分けせず人間に回す
  const needsHumanRouting = categoryConfidence < thresholds.categoryConfidence;
  if (needsHumanRouting) reasons.push(`分類が不確実 ${categoryConfidence.toFixed(2)}`);

  return { priority, reasons, category, needsHumanRouting, signals };
}

export const CATEGORY_LABEL_JA = {
  billing: '課金・請求',
  bug: '不具合',
  how_to: '使い方',
  account_data: 'データ・プライバシー',
  feature_request: '要望',
  other: 'その他',
};

export const PRIORITY_TARGET_JA = {
  P1: '当日中に対応',
  P2: '翌営業日までに対応',
  P3: '3営業日以内に対応',
  spam: '対応不要',
  unknown: '判定できず — 手動で確認',
};

/**
 * Jev を呼んで生の answers を返す。呼び出し側で decidePriority に渡す。
 */
export async function classify(message, apiKey, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(TYPESAFE_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // 氏名・メールは判定に不要なので送らない
        state: { app: 'Buddy AI (iOS)', inquiry: message },
        model: MODEL,
        questions: QUESTIONS,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
