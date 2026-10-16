/* 供本地核对使用的静态服务
 * 以仓库目录为根，可指定站点前缀，行为与静态托管一致：命中文件则返回该文件，否则返回 404 页面。
 * 仅由维护脚本使用，不参与页面运行。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

export function startServer(root, prefix) {
  const base = prefix || '';
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (base && url.indexOf(base) !== 0) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>404</title></head><body><h1>地址不在站点前缀内</h1></body></html>');
      return;
    }
    const rel = url.slice(base.length);
    const file = path.join(root, rel);
    if (rel && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store'
      });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(root, '404.html')).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, origin: 'http://127.0.0.1:' + port + base });
    });
  });
}