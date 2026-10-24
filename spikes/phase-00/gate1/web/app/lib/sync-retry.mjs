export const SYNC_RETRY_LIMIT = 5;

/** Exponential equal-jitter delay; bounded so a sleeping client never enters a poll loop. */
export function syncRetryDelay(retryNumber, random = Math.random) {
  const attempt = Math.max(1, Math.min(SYNC_RETRY_LIMIT, Math.floor(retryNumber)));
  const ceiling = Math.min(30_000, 2_000 * (2 ** (attempt - 1)));
  return Math.floor(ceiling / 2 + Math.max(0, Math.min(0.999999, random())) * ceiling / 2);
}
