import { handleSync } from '../../../../../sync-server/http.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function handler(request, context) {
  const { action } = await context.params;
  return handleSync(request, (action ?? []).join('/'));
}
export { handler as GET, handler as POST };
