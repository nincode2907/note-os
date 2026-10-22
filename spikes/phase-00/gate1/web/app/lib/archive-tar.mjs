// Deliberately restricted POSIX ustar: regular files only; no compression, links,
// directories, extensions, extraction to disk, or paths supplied by note IDs.
export const ARCHIVE_LIMITS = Object.freeze({ maxArchiveBytes: 1024 ** 3, maxEntryBytes: 512 * 1024 ** 2, maxJsonBytes: 16 * 1024 ** 2, maxEntries: 10004, maxNotes: 50000, maxRecordings: 10000, maxChunks: 100000 });
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const zeros = (bytes) => bytes.every((byte) => byte === 0);
export function safeArchivePath(path) {
  if (typeof path !== 'string' || path.length > 99 || !/^[a-z0-9][a-z0-9._/-]*$/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Unsafe archive entry path.');
  return path;
}
function octal(value, width) { return value.toString(8).padStart(width - 1, '0') + '\0'; }
export function createTar(entries, limits = ARCHIVE_LIMITS) {
  if (entries.length > limits.maxEntries) throw new Error('Archive has too many files.');
  const parts = [], paths = new Set(); let total = 1024;
  for (const { path, blob } of entries) {
    safeArchivePath(path);
    if (paths.has(path)) throw new Error('Duplicate archive entry.');
    paths.add(path);
    if (!(blob instanceof Blob) || blob.size > limits.maxEntryBytes) throw new Error('Archive entry exceeds the size limit.');
    const header = new Uint8Array(512);
    const put = (offset, text) => header.set(encoder.encode(text), offset);
    put(0, path); put(100, octal(0o644, 8)); put(108, octal(0, 8)); put(116, octal(0, 8));
    put(124, octal(blob.size, 12)); put(136, octal(0, 12)); put(148, '        ');
    put(156, '0'); put(257, 'ustar\0'); put(263, '00');
    put(148, header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ');
    const padding = (512 - blob.size % 512) % 512;
    parts.push(header, blob, new Uint8Array(padding)); total += 512 + blob.size + padding;
    if (total > limits.maxArchiveBytes) throw new Error('Archive exceeds the 1 GiB archive limit.');
  }
  parts.push(new Uint8Array(1024));
  return new Blob(parts, { type: 'application/x-tar' });
}
export async function readTar(blob, limits = ARCHIVE_LIMITS) {
  if (!(blob instanceof Blob) || blob.size > limits.maxArchiveBytes || blob.size < 1536 || blob.size % 512) throw new Error('Truncated or excessive archive size.');
  const files = new Map(); let offset = 0;
  while (offset + 512 <= blob.size) {
    const header = new Uint8Array(await blob.slice(offset, offset + 512).arrayBuffer());
    if (zeros(header)) {
      const tail = blob.size - offset;
      if (tail < 1024 || tail > 10240 || !zeros(new Uint8Array(await blob.slice(offset).arrayBuffer()))) throw new Error('Invalid archive end marker.');
      return files;
    }
    if (files.size >= limits.maxEntries) throw new Error('Archive has too many files.');
    const string = (start, end) => {
      const bytes = header.slice(start, end), zero = bytes.indexOf(0);
      if (zero >= 0 && !zeros(bytes.slice(zero))) throw new Error('Invalid archive header field.');
      return decoder.decode(zero < 0 ? bytes : bytes.slice(0, zero));
    };
    const number = (start, end) => {
      const text = decoder.decode(header.slice(start, end)).replace(/[\0 ]+$/g, '');
      if (!/^[0-7]+$/.test(text)) throw new Error('Invalid archive numeric field.');
      const value = parseInt(text, 8);
      if (!Number.isSafeInteger(value)) throw new Error('Unsafe archive size.');
      return value;
    };
    const checksum = number(148, 156);
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== actual || string(257, 263) !== 'ustar' || decoder.decode(header.slice(263, 265)) !== '00' || ![0, 48].includes(header[156]) || string(157, 257) || !zeros(header.slice(345))) throw new Error('Unsupported or corrupt TAR header.');
    const path = safeArchivePath(string(0, 100)), size = number(124, 136);
    if (files.has(path)) throw new Error('Duplicate archive entry path.');
    if (size > limits.maxEntryBytes) throw new Error('Archive entry exceeds the size limit.');
    const start = offset + 512, end = start + size, paddedEnd = end + (512 - size % 512) % 512;
    if (paddedEnd + 1024 > blob.size) throw new Error('Truncated archive entry.');
    if (!zeros(new Uint8Array(await blob.slice(end, paddedEnd).arrayBuffer()))) throw new Error('Invalid archive padding.');
    files.set(path, blob.slice(start, end)); offset = paddedEnd;
  }
  throw new Error('Missing archive end marker.');
}
