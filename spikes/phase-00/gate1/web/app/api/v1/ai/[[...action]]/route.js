import { handleAi } from '../../../../../sync-server/ai-http.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handler(request, context) {
  const { action } = await context.params;
  return handleAi(request, (action ?? []).join('/'));
}

export { handler as GET, handler as POST, handler as PUT, handler as DELETE };
