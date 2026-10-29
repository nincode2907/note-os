// Loopback stand-in for the Local AI Gateway (codex-server OpenAI-compatible subset).
// It implements GET /v1/models?provider=… and POST /v1/chat/completions with optional
// latency and fault injection. It never forwards anything to a real model or network.
import { createServer } from 'node:http';
import { FAKE_MODELS } from './fake-models.mjs';

/**
 * @param {{ models?: Array<{id:string, provider:string, state?:string|null}>, brain?: string, port?: number,
 *   latencyMs?: number|((index:number)=>number), fault?: (index:number, body:any)=>string|null }} options
 */
export async function startFakeGateway({ models = [{ id: 'synthetic-local-8b', provider: 'ollama', state: 'available' }, { id: 'gpt-cloud', provider: 'codex', state: 'remote' }], brain = 'heuristic', latencyMs = 0, fault = () => null, port = 0 } = {}) {
  const requests = [];
  let index = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const url = new URL(req.url, 'http://fake');
      const record = { method: req.method, path: url.pathname, query: url.search, headers: { host: req.headers.host, authorization: req.headers.authorization ? 'present' : null }, body: null };
      requests.push(record);
      const send = (status, value, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...extra }); res.end(typeof value === 'string' ? value : JSON.stringify(value)); };
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const provider = url.searchParams.get('provider');
        const data = models.filter(model => !provider || model.provider === provider);
        if (provider && !data.length) return send(400, { error: { code: 'provider_disabled', message: 'Provider is not configured.' } });
        return send(200, { object: 'list', data: data.map(model => ({ object: 'model', created: 0, owned_by: 'fake', state: null, ...model })) });
      }
      if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') return send(404, { error: { code: 'not_found' } });
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { error: { code: 'invalid_json' } }); }
      record.body = { provider: body.provider, model: body.model, keys: Object.keys(body).sort(), messageCount: body.messages?.length ?? 0, userChars: body.messages?.find(m => m.role === 'user')?.content.length ?? 0 };
      const current = index++;
      const mode = fault(current, body);
      const delay = typeof latencyMs === 'function' ? latencyMs(current) : latencyMs;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (mode === 'hang') return; // never answers; the client timeout must fire
      if (mode === 'error500') return send(500, { error: { code: 'upstream_error' } });
      if (mode === 'rate429') return send(429, { error: { code: 'rate_limited' } });
      if (mode === 'bad400') return send(400, { error: { code: 'invalid_request_error' } });
      if (mode === 'redirect') return send(302, {}, { location: 'http://203.0.113.1/v1/chat/completions' });
      if (mode === 'invalidBody') return send(200, '{not json');
      if (mode === 'huge') return send(200, { choices: [{ message: { content: 'x'.repeat(200000) } }] });
      const model = models.find(entry => entry.id === body.model && entry.provider === body.provider);
      if (!model) return send(400, { error: { code: 'model_not_found' } });
      let content;
      if (mode === 'prose') content = 'Sure! Here is my analysis of the note, but not as JSON.';
      else content = `\`\`\`json\n${JSON.stringify(FAKE_MODELS[brain](body.messages))}\n\`\`\``;
      const promptChars = body.messages.reduce((sum, message) => sum + message.content.length, 0);
      send(200, { id: `fake-${current}`, object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: Math.ceil(promptChars / 4), completion_tokens: Math.ceil(content.length / 4) } });
    });
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve));
  const bound = server.address().port;
  return {
    origin: `http://127.0.0.1:${bound}`, port: bound, requests,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
