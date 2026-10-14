// Local UI preview only. Does not contact BOSS or any AI provider.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
http.createServer((req, res) => {
  const files = { '/': ['demo/index.html', 'text/html; charset=utf-8'], '/userscript.js': ['dist/boss-ai.user.js', 'text/javascript; charset=utf-8'] };
  const file = files[req.url];
  if (!file) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' });
  fs.createReadStream(path.join(root, file[0])).pipe(res);
}).listen(4173, '127.0.0.1', () => console.log('UI demo: http://127.0.0.1:4173 (local only; Ctrl+C to stop)'));
