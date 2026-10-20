const http = require('node:http');
const { spawn } = require('node:child_process');
const { createProxyServer } = require('http-proxy');

const reverseProxy = createProxyServer({ ws: true, changeOrigin: true, xfwd: true });
const targets = new Map([[3000, 'http://gate1-web:3000'], [8080, 'http://gate1-powersync:8080']]);
const servers = [...targets].map(([port, target]) => {
  const server = http.createServer((request, response) => reverseProxy.web(request, response, { target }, error => {
    response.writeHead(502, { 'content-type': 'text/plain' }); response.end(String(error));
  }));
  server.on('upgrade', (request, socket, head) => reverseProxy.ws(request, socket, head, { target }));
  return new Promise(resolve => server.listen(port, '0.0.0.0', () => resolve(server)));
});

Promise.all(servers).then(() => {
  const test = spawn('/runner/node_modules/.bin/playwright', ['test', '--reporter=line', ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
  test.on('exit', code => {
    for (const server of servers) server.close();
    process.exit(code ?? 1);
  });
});
