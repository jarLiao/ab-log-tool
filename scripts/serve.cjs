const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../dist');
const port = Number(process.env.PORT || 4178);
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
const server = http.createServer((req,res) => {
  let relative;
  try { relative = decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/+/,'') || 'index.html'; }
  catch { res.writeHead(400).end(); return; }
  const file = path.resolve(root,relative);
  if (!file.startsWith(root+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end('Not found'); return; }
  res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});
  fs.createReadStream(file).pipe(res);
});
server.listen(port,'127.0.0.1',() => console.log('AB 日志分析预览：http://127.0.0.1:'+port));
