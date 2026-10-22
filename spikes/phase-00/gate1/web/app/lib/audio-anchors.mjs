export const AUDIO_ANCHORS_VERSION = 1;
export const MAX_AUDIO_ANCHORS_PER_RECORDING = 100;
export const MAX_AUDIO_ANCHOR_LABEL_LENGTH = 120;
const validId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !/[\u0000-\u001f]/u.test(value);
const nonNegativeSafeInteger = value => Number.isSafeInteger(value) && value >= 0;

export function normalizeAudioAnchorLabel(value) {
  if (typeof value !== 'string') throw new TypeError('Bookmark label must be text.');
  const label = value.normalize('NFC').trim();
  if ([...label].length > MAX_AUDIO_ANCHOR_LABEL_LENGTH) throw new RangeError(`Bookmark labels must be ${MAX_AUDIO_ANCHOR_LABEL_LENGTH} characters or fewer.`);
  return label;
}

export function emptyAudioAnchorSet() {
  return { version: AUDIO_ANCHORS_VERSION, items: [] };
}

export function createAudioAnchor(recordingId, offsetMs, label = '', { id = globalThis.crypto.randomUUID(), createdAt = Date.now() } = {}) {
  if (!validId(recordingId)) throw new TypeError('A valid recording ID is required for a bookmark.');
  if (!nonNegativeSafeInteger(offsetMs)) throw new TypeError('Bookmark time must be a non-negative safe integer in milliseconds.');
  if (!validId(id)) throw new TypeError('Bookmark ID is invalid.');
  if (!nonNegativeSafeInteger(createdAt)) throw new TypeError('Bookmark creation time is invalid.');
  return { id, recordingId, offsetMs, label: normalizeAudioAnchorLabel(label), createdAt };
}

export function validateAudioAnchorSet(value, recordingId, { durationMs, durationKnown = false } = {}) {
  if (value === undefined) return emptyAudioAnchorSet();
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('Audio bookmark metadata must be an object.');
  if (Object.keys(value).some(key => !['version', 'items'].includes(key)) || value.version !== AUDIO_ANCHORS_VERSION || !Array.isArray(value.items) || value.items.length > MAX_AUDIO_ANCHORS_PER_RECORDING) throw new TypeError('Unsupported or excessive audio bookmark metadata.');
  if (!validId(recordingId)) throw new TypeError('A valid recording ID is required for bookmark metadata.');
  if (durationKnown && !nonNegativeSafeInteger(durationMs)) throw new TypeError('Known recording duration is invalid.');
  const ids = new Set();
  const items = value.items.map(anchor => {
    if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor) || Object.getPrototypeOf(anchor) !== Object.prototype) throw new TypeError('Audio bookmark is invalid.');
    if (Object.keys(anchor).some(key => !['id', 'recordingId', 'offsetMs', 'label', 'createdAt'].includes(key))) throw new TypeError('Audio bookmark contains unknown metadata.');
    if (!validId(anchor.id) || ids.has(anchor.id) || anchor.recordingId !== recordingId || !nonNegativeSafeInteger(anchor.offsetMs) || !nonNegativeSafeInteger(anchor.createdAt)) throw new TypeError('Audio bookmark identity or time is invalid.');
    if (durationKnown && anchor.offsetMs > durationMs) throw new RangeError('Audio bookmark time exceeds the known recording duration.');
    const label = normalizeAudioAnchorLabel(anchor.label);
    ids.add(anchor.id);
    return { id: anchor.id, recordingId, offsetMs: anchor.offsetMs, label, createdAt: anchor.createdAt };
  });
  return { version: AUDIO_ANCHORS_VERSION, items: items.sort((a, b) => a.offsetMs - b.offsetMs || a.createdAt - b.createdAt || a.id.localeCompare(b.id)) };
}

export function addAudioAnchor(set, anchor, recordingId, options) {
  const current = validateAudioAnchorSet(set, recordingId, options);
  if (current.items.some(item => item.id === anchor.id)) throw new Error('A bookmark with this ID already exists.');
  return validateAudioAnchorSet({ version: AUDIO_ANCHORS_VERSION, items: [...current.items, anchor] }, recordingId, options);
}

export function renameAudioAnchor(set, anchorId, label, recordingId, options) {
  const current = validateAudioAnchorSet(set, recordingId, options);
  if (!current.items.some(item => item.id === anchorId)) throw new Error('Bookmark no longer exists.');
  return validateAudioAnchorSet({ version: AUDIO_ANCHORS_VERSION, items: current.items.map(item => item.id === anchorId ? { ...item, label: normalizeAudioAnchorLabel(label) } : item) }, recordingId, options);
}

export function deleteAudioAnchor(set, anchorId, recordingId, options) {
  const current = validateAudioAnchorSet(set, recordingId, options);
  if (!current.items.some(item => item.id === anchorId)) return current;
  return validateAudioAnchorSet({ version: AUDIO_ANCHORS_VERSION, items: current.items.filter(item => item.id !== anchorId) }, recordingId, options);
}

export function formatAudioTimestamp(offsetMs) {
  if (!nonNegativeSafeInteger(offsetMs)) throw new TypeError('Audio time must be a non-negative safe integer.');
  const total = Math.floor(offsetMs / 1000), hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), seconds = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Accumulates active media time using a monotonic clock and excludes pauses. */
export class ActiveMediaClock {
  constructor(now = () => globalThis.performance.now()) { this.now = now; this.accumulated = 0; this.startedAt = null; }
  start() { this.accumulated = 0; this.startedAt = this.now(); return this.read(); }
  resume() { if (this.startedAt === null) this.startedAt = this.now(); return this.read(); }
  pause() { if (this.startedAt !== null) { this.accumulated += Math.max(0, this.now() - this.startedAt); this.startedAt = null; } return Math.max(0, Math.round(this.accumulated)); }
  read() { return Math.max(0, Math.round(this.accumulated + (this.startedAt === null ? 0 : Math.max(0, this.now() - this.startedAt)))); }
  stop() { return this.pause(); }
}
