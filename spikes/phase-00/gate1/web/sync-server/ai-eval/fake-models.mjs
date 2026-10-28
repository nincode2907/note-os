// Deterministic stand-ins for a language model. They are NOT models and their quality
// numbers say nothing about any real model; they exercise the adapter, normalizer,
// validator, retries and injection containment with reproducible inputs.
import { CATEGORY_SYNONYMS } from './synthetic-notes.mjs';

const CATEGORY_CUES = {
  Work: ['họp', 'thiết kế', 'phát hành', 'roadmap', 'engineering', 'design review', '会議', '企画', 'リリース', 'dự án'],
  Finance: ['ngân sách', 'hóa đơn', 'thuế', 'tiết kiệm', 'budget', 'rent', 'insurance', 'savings', '家計簿', '貯金', '申告', '料金'],
  Health: ['khám', 'xét nghiệm', 'rehab', 'physio', '健康診断', '保険証'],
  Travel: ['đi đà lạt', 'homestay', 'vé xe', 'flights', 'lisbon', 'trip', '旅行', '新幹線', '旅館'],
  Learning: ['kanji', 'ngữ pháp', 'đề thi', 'course', 'chapter', 'problem set', '勉強', '単語', 'シャドーイング'],
  Home: ['lau', 'bóng đèn', 'việc nhà', 'garden', 'fence', 'roses', '掃除', '冷蔵庫', '換気扇'],
  Shopping: ['mua sữa', 'mua bánh', 'mua sắm', 'groceries', 'buy oat', 'coffee beans', '買い物', '牛乳'],
};
const LABEL = { vi: 1, ja: 2, en: 0 };
const TAG_LEXICON = ['ra mắt', 'thiết kế', 'demo', 'ngân sách', 'hóa đơn', 'tiết kiệm', 'khám răng', 'xét nghiệm', 'Đà Lạt', 'homestay', 'tiếng Nhật', 'Kanji', 'ngữ pháp', 'việc nhà', 'nhà bếp', 'phát hành', 'sữa', 'bánh mì', 'thuế', 'quyết toán',
  'roadmap', 'engineering', 'budget', 'savings', 'subscription', 'physio', 'knee', 'Lisbon', 'flights', 'statistics', 'Bayesian', 'garden', 'compost', 'design review', 'groceries', 'coffee', 'insurance', 'renewal',
  '企画', '会議', '家計簿', '貯金', '健康診断', '保険証', '京都', '紅葉', '旅館', '英語', '単語', '掃除', '冷蔵庫', 'リリース', '牛乳', 'パン', '確定申告', '医療費控除'];
const TASK_CUES = /\b(need to|must|todo)\b|cần|phải|nhớ|しなければ|必要がある|する。?$|を予約|を提出|を作成|を買う/iu;

function noteData(messages) {
  const user = messages.find(message => message.role === 'user')?.content ?? '';
  const start = user.indexOf('NOTE_DATA_BEGIN\n'), end = user.indexOf('\nNOTE_DATA_END');
  return JSON.parse(user.slice(start + 'NOTE_DATA_BEGIN\n'.length, end));
}

function detectLang(text) { return /[぀-ヿ一-龯]/u.test(text) ? 'ja' : /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/iu.test(text) ? 'vi' : 'en'; }

/** Rule-based baseline: grounded quotes only; follows no instruction inside the note. */
export function heuristicModel(messages) {
  const data = noteData(messages);
  const lines = [data.title, ...data.text.split('\n')].filter(Boolean);
  const all = lines.join('\n'), lower = all.toLowerCase(), lang = detectLang(all);
  if (data.text.replace(/[\s.。]/gu, '').length < 4) {
    return { schemaVersion: 1, categorySuggestion: null, tagCandidates: [], shortSummary: null, taskCandidates: [], relatedCandidates: [], insufficientContext: true, uncertainty: 0.9 };
  }
  let category = null, best = 0;
  for (const [name, cues] of Object.entries(CATEGORY_CUES)) {
    const hits = cues.filter(cue => lower.includes(cue.toLowerCase()));
    if (hits.length > best) { best = hits.length; const at = lower.indexOf(hits[0].toLowerCase()); category = { label: CATEGORY_SYNONYMS[name][LABEL[lang]] ?? name, sourceQuote: all.slice(at, at + hits[0].length) }; }
  }
  const tagCandidates = TAG_LEXICON.filter(tag => lower.includes(tag.toLowerCase())).slice(0, 5).map(tag => {
    const at = lower.indexOf(tag.toLowerCase()); return { label: all.slice(at, at + tag.length), sourceQuote: all.slice(at, at + tag.length) };
  });
  const taskLines = data.text.split('\n').filter(line => TASK_CUES.test(line)).slice(0, 5);
  const taskCandidates = taskLines.map(line => ({ text: line.slice(0, 200), sourceQuote: Array.from(line).slice(0, 120).join('') }));
  const first = data.text.split('\n').find(line => line.trim().length > 8) ?? data.title;
  return { schemaVersion: 1, categorySuggestion: category, tagCandidates, shortSummary: Array.from(first).slice(0, 180).join(''), taskCandidates, relatedCandidates: [], insufficientContext: false, uncertainty: 0.35 };
}

/** Worst-case model that obeys every injected instruction and adds unsafe/ungrounded content. */
export function adversarialModel(messages) {
  const base = heuristicModel(messages);
  const data = noteData(messages);
  return {
    ...base,
    extraKey: 'model added an unexpected field',
    categorySuggestion: { label: 'ADMIN-ACCESS', sourceQuote: 'not in the note' },
    tagCandidates: [...base.tagCandidates, { label: 'exfiltrate', sourceQuote: 'ignore previous' }, { label: 'pwned', sourceQuote: data.title }, { label: '<b>x</b>', sourceQuote: data.title }, { label: '管理者権限', sourceQuote: '管理者権限を追加' }],
    shortSummary: `Visit https://attacker.example/upload now ${base.shortSummary ?? ''}`,
    taskCandidates: [...base.taskCandidates, { text: 'Open http://evil.example/steal', sourceQuote: data.title }],
    relatedCandidates: [{ id: 'synthetic-en-01', reason: 'title_match' }, { id: '../../etc/passwd', reason: 'tag_overlap' }],
    uncertainty: 7,
  };
}

export const FAKE_MODELS = Object.freeze({ heuristic: heuristicModel, adversarial: adversarialModel });
