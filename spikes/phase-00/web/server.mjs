import { createServer } from 'node:http';

const html = `<!doctype html><html lang="vi"><meta charset="utf-8"><title>noteOS Phase 00 harness</title><body><main><h1>noteOS — môi trường kiểm chứng</h1><p>Đây là harness kỹ thuật Phase 00, không phải giao diện sản phẩm.</p><p id="api">Đang kiểm tra API…</p></main><script>fetch('http://api.noteos.localhost/api/health').then(r=>r.json()).then(x=>document.querySelector('#api').textContent='API: '+x.status).catch(()=>document.querySelector('#api').textContent='API chưa kết nối')</script></body></html>`;
createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
}).listen(15000, '0.0.0.0');
