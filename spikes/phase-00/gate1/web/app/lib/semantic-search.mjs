// On-device hybrid note search (Phase 09F). Pure JavaScript, no network, no model.
// Keyword: BM25 over words (diacritic-folded) and Japanese character bigrams.
// Meaning: hashed word + character-trigram features plus a small curated vi/en/ja
// concept lexicon, so "invoice" finds "hóa đơn" and "請求書". Fusion: reciprocal rank.
// This is a lightweight lexical-semantic approximation, not a neural embedding.

export const SEMANTIC_DIMS = 512;
const RRF_K = 60;
const MIN_VECTOR_SCORE = 0.12;
// Very short notes have one or two hashed features, where a single collision looks like a
// strong match. They are found by keyword only.
const MIN_VECTOR_FEATURES = 4;
// Without a shared concept, a vector-only match must be strong; weak trigram collisions are noise.
const MIN_UNSUPPORTED_VECTOR_SCORE = 0.2;

/** Curated multilingual concepts (vi / en / ja). Owner-extendable; matching is substring-based. */
export const CONCEPTS = Object.freeze({
  meeting: ['meeting', 'họp', 'cuộc họp', '会議', '打ち合わせ', 'ミーティング'],
  budget: ['budget', 'ngân sách', '予算', '家計', '家計簿', 'chi tiêu', 'expenses'],
  invoice: ['invoice', 'bill', 'hóa đơn', '請求書', '料金', 'payment', 'thanh toán', '支払い'],
  tax: ['tax', 'thuế', 'quyết toán', '税', '確定申告', '申告'],
  health: ['health', 'doctor', 'clinic', 'khám', 'bác sĩ', 'sức khỏe', 'xét nghiệm', '健康', '病院', '診断', 'physio', 'rehab'],
  travel: ['travel', 'trip', 'vacation', 'du lịch', 'chuyến đi', '旅行', '旅'],
  transport: ['flight', 'train', 'ticket', 'vé', 'vé xe', 'vé máy bay', '航空券', '新幹線', 'チケット'],
  lodging: ['hotel', 'homestay', 'khách sạn', '旅館', 'ホテル', 'accommodation'],
  study: ['study', 'learn', 'course', 'học', 'ôn', '勉強', '学習', 'chapter', 'ngữ pháp', 'grammar', '文法'],
  exam: ['exam', 'test', 'quiz', 'thi', 'đề thi', '試験', 'テスト'],
  shopping: ['shopping', 'groceries', 'buy', 'mua', 'mua sắm', '買い物', '買う'],
  dairy: ['milk', 'sữa', '牛乳', 'oat milk', 'eggs', 'trứng', '卵'],
  cleaning: ['clean', 'cleaning', 'dọn', 'lau', '掃除', 'chores', 'việc nhà'],
  kitchen: ['kitchen', 'bếp', 'nhà bếp', '台所', 'キッチン', 'refrigerator', 'fridge', '冷蔵庫'],
  garden: ['garden', 'vườn', '庭', 'roses', 'compost'],
  insurance: ['insurance', 'bảo hiểm', '保険', 'policy'],
  savings: ['savings', 'save money', 'tiết kiệm', '貯金', '貯蓄'],
  rent: ['rent', 'tiền nhà', '家賃'],
  utilities: ['electricity', 'internet', 'tiền điện', 'điện', '電気', '電気料金'],
  launch: ['launch', 'release', 'ra mắt', 'phát hành', 'リリース', '発売', 'roadmap'],
  design: ['design', 'thiết kế', 'デザイン', '設計', 'giao diện', 'interface'],
  deadline: ['deadline', 'due', 'hạn', 'trước ngày', '締め切り', '期限', 'までに'],
  reservation: ['book', 'reserve', 'reservation', 'đặt', 'đặt lịch', '予約'],
  japanese: ['japanese', 'tiếng nhật', '日本語', 'kanji', '漢字'],
  english: ['english', 'tiếng anh', '英語', 'shadowing', 'シャドーイング'],
  family: ['family', 'gia đình', '家族'],
  report: ['report', 'báo cáo', '報告', 'summary', 'tóm tắt', '要約'],
});

const CJK = /[぀-ヿ㐀-鿿豈-﫿]/u;
export const foldText = value => String(value ?? '').normalize('NFC').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').normalize('NFC');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Precompiled once. Diacritics are kept for single-syllable Vietnamese terms: folding makes
// "đơn" (bill) collide with "dọn" (clean) and "ôn" with English "on". Folded matching is
// added only for multi-word terms, so queries typed without accents still find concepts.
const lowerText = value => String(value ?? '').normalize('NFC').toLowerCase();
const conceptMatchers = Object.entries(CONCEPTS).flatMap(([id, terms]) => terms.map(term => {
  const lower = lowerText(term), folded = foldText(term);
  if (CJK.test(lower)) return [id, text => text.lower.includes(lower)];
  if (lower.includes(' ')) return [id, text => text.lower.includes(lower) || (folded !== lower && text.folded.includes(folded))];
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escape(lower)}([^\\p{L}\\p{N}]|$)`, 'u');
  return [id, text => pattern.test(text.lower)];
}));

function collect(node, out) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'text' && typeof node.text === 'string') out.push(node.text);
  for (const child of Array.isArray(node.content) ? node.content : []) collect(child, out);
}

export function noteSearchSource(note) {
  const parts = [note?.title ?? '', ...(Array.isArray(note?.tags) ? note.tags : [])];
  collect(note?.document, parts);
  return parts.join('\n');
}

/** Keyword tokens: folded words for alphabetic scripts, character bigrams for Japanese/CJK runs. */
export function keywordTokens(text) {
  const folded = foldText(text), tokens = [];
  for (const run of folded.split(/[^\p{L}\p{N}]+/u)) {
    if (!run) continue;
    if (CJK.test(run)) {
      const chars = Array.from(run);
      if (chars.length === 1) tokens.push(run);
      for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i] + chars[i + 1]);
    } else if (run.length > 1 || /\d/.test(run)) tokens.push(run);
  }
  return tokens;
}

export function conceptsOf(text) {
  const forms = { lower: lowerText(text), folded: foldText(text) }, found = new Set();
  for (const [id, matches] of conceptMatchers) if (!found.has(id) && matches(forms)) found.add(id);
  return found;
}

function hash32(value) {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Deterministic, L2-normalized feature vector. Also used as the server's local embedding fallback. */
export function embedText(text, dims = SEMANTIC_DIMS) {
  const vector = new Float32Array(dims), folded = foldText(text);
  const add = (feature, weight) => { const h = hash32(feature); vector[h % dims] += (h & 0x80000000 ? -1 : 1) * weight; };
  for (const token of keywordTokens(text)) add(`w:${token}`, 1);
  const compact = folded.replace(/[^\p{L}\p{N}]+/gu, ' ');
  for (const word of compact.split(' ')) {
    if (word.length < 4 || CJK.test(word)) continue;
    for (let i = 0; i + 3 <= word.length; i++) add(`t:${word.slice(i, i + 3)}`, 0.35);
  }
  for (const concept of conceptsOf(text)) add(`c:${concept}`, 2.5);
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) vector[i] /= norm;
  return vector;
}

const dot = (a, b) => { let sum = 0; for (let i = 0; i < a.length; i++) sum += a[i] * b[i]; return sum; };

/** Incremental index. Entries carry a version key so unchanged notes are not re-embedded. */
export function createSearchIndex() {
  const docs = new Map(), df = new Map();
  let totalLength = 0;
  const removeStats = doc => { for (const token of doc.tf.keys()) { const n = df.get(token) - 1; if (n) df.set(token, n); else df.delete(token); } totalLength -= doc.length; };
  function upsert(note) {
    const key = `${note.revision ?? 0}:${note.updatedAt ?? 0}:${note.lifecycle}:${note.privacy ?? ''}`;
    const prior = docs.get(note.id);
    if (prior?.key === key) return false;
    if (prior) removeStats(prior);
    const text = noteSearchSource(note), tokens = keywordTokens(text), tf = new Map();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
    totalLength += tokens.length;
    const vector = embedText(text); let features = 0;
    for (const value of vector) if (value !== 0) features++;
    docs.set(note.id, { id: note.id, key, tf, length: tokens.length, vector: features >= MIN_VECTOR_FEATURES ? vector : null, concepts: conceptsOf(text), lifecycle: note.lifecycle, privacy: note.privacy ?? null });
    return true;
  }
  function remove(id) { const doc = docs.get(id); if (!doc) return false; removeStats(doc); docs.delete(id); return true; }
  /** Bring the index in line with the current note list: upsert changed, remove deleted. */
  function sync(notes) {
    const seen = new Set(); let changed = 0;
    for (const note of notes) { seen.add(note.id); if (upsert(note)) changed++; }
    for (const id of [...docs.keys()]) if (!seen.has(id) && remove(id)) changed++;
    return changed;
  }
  /**
   * @param {string} query
   * @param {{ limit?: number, lifecycle?: string, allowPrivacy?: (privacy: string | null) => boolean, mode?: 'hybrid' | 'keyword' }} [options]
   */
  function search(query, { limit = 50, lifecycle = 'active', allowPrivacy = () => true, mode = 'hybrid' } = {}) {
    const tokens = [...new Set(keywordTokens(query))];
    if (!tokens.length && !conceptsOf(query).size) return [];
    const candidates = [...docs.values()].filter(doc => doc.lifecycle === lifecycle && allowPrivacy(doc.privacy));
    const n = Math.max(1, docs.size), avg = totalLength / n || 1;
    const bm25 = [];
    for (const doc of candidates) {
      let score = 0;
      for (const token of tokens) {
        const f = doc.tf.get(token); if (!f) continue;
        const idf = Math.log(1 + (n - (df.get(token) ?? 0) + 0.5) / ((df.get(token) ?? 0) + 0.5));
        score += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * doc.length / avg));
      }
      if (score > 0) bm25.push({ id: doc.id, score });
    }
    bm25.sort((a, b) => b.score - a.score);
    if (mode === 'keyword') return bm25.slice(0, limit).map(row => ({ id: row.id, score: row.score, keyword: row.score, semantic: null }));
    const q = embedText(query), queryConcepts = conceptsOf(query), semantic = [];
    for (const doc of candidates) {
      if (!doc.vector) continue;
      const score = dot(q, doc.vector), supported = [...queryConcepts].some(concept => doc.concepts.has(concept));
      if (score >= (supported ? MIN_VECTOR_SCORE : MIN_UNSUPPORTED_VECTOR_SCORE)) semantic.push({ id: doc.id, score });
    }
    semantic.sort((a, b) => b.score - a.score);
    const fused = new Map();
    bm25.forEach((row, rank) => fused.set(row.id, { id: row.id, score: 1 / (RRF_K + rank + 1), keyword: row.score, semantic: null }));
    semantic.forEach((row, rank) => { const entry = fused.get(row.id) ?? { id: row.id, score: 0, keyword: null, semantic: null }; entry.score += 1 / (RRF_K + rank + 1); entry.semantic = row.score; fused.set(row.id, entry); });
    return [...fused.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
  }
  return { upsert, remove, sync, search, get size() { return docs.size; } };
}
