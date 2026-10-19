/* 供本地核对使用的静态服务
 * 以仓库目录为根，可指定站点前缀：目录请求读取 index.html，未知地址返回 404.html 并保留 404 状态码。
 * 请求路径限制在仓库目录内，不跟随指向目录外的符号链接。
 * 仅由维护脚本使用，不参与页面运行。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function startServer(root, prefix, options = {}) {
  const base = prefix ? (prefix.endsWith('/') ? prefix : prefix + '/') : '';
  const rootPath = fs.realpathSync(root);
  const host = options.host || '127.0.0.1';
  const requestedPort = Number.isInteger(options.port) ? options.port : 0;

  function notFound(res) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(rootPath, '404.html')).pipe(res);
  }

  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://' + host).pathname);
    } catch (error) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('请求地址编码无效。');
      return;
    }

    if (base && !pathname.startsWith(base)) {
      notFound(res);
      return;
    }

    let relativePath = pathname.slice(base.length).replace(/^[/\\]+/, '');
    if (!relativePath || relativePath.endsWith('/') || relativePath.endsWith('\\')) {
      relativePath = path.join(relativePath, 'index.html');
    }

    let file = path.resolve(rootPath, relativePath);
    const rootPrefix = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep;
    if (file !== rootPath && !file.startsWith(rootPrefix)) {
      notFound(res);
      return;
    }

    try {
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
        file = path.join(file, 'index.html');
      }
      if (fs.existsSync(file)) {
        file = fs.realpathSync(file);
      }
    } catch (error) {
      notFound(res);
      return;
    }

    if (file.startsWith(rootPrefix) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store'
      });
      fs.createReadStream(file).pipe(res);
      return;
    }
    notFound(res);
  });
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(requestedPort, host, () => {
      server.removeListener('error', onError);
      const port = server.address().port;
      resolve({ server, port, origin: 'http://' + host + ':' + port + base });
    });
  });
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) {
  const portFlag = process.argv.indexOf('--port');
  const port = portFlag === -1 ? 8000 : Number(process.argv[portFlag + 1]);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('端口号须为 1 至 65535 的整数。用法：node tools/static-server.mjs [--port 8000]');
    process.exitCode = 2;
  } else {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    startServer(root, '', { host: '127.0.0.1', port })
      .then(({ server, origin }) => {
        console.log('本地预览地址：' + origin);
        console.log('访问不存在的地址可查看自定义 404 页面；按 Ctrl+C 停止服务。');
        const stop = () => server.close(() => process.exit(0));
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      })
      .catch((error) => {
        console.error('本地预览服务启动失败：' + error.message);
        process.exitCode = 1;
      });
  }
}
