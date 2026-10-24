import { handleSync } from '../../../../../sync-server/http.mjs';
import { handleAudioSync } from '../../../../../sync-server/media-http.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function handler(request, context) {
  const { action } = await context.params;
  const path = (action ?? []).join('/');
  return path.startsWith('media/') ? handleAudioSync(request, path) : handleSync(request, path);
}
export { handler as GET, handler as POST, handler as PUT };
