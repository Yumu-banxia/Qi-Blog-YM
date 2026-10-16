#!/usr/bin/env node
/* 浏览器核对
 * 以无头 Chromium 打开本地文件，核对布局、结构、交互与访问端分档。
 * 需要在 Node 22 以上运行；浏览器缺失时脚本直接报错退出，不做静默跳过。
 *
 * 用法：
 *   node tools/browser-check.mjs            全部核对
 *   node tools/browser-check.mjs --layout   只做布局与结构核对
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, shutdown, openPage, navigate, evaluate, setViewport, setReducedMotion, setUserAgent, closePage, fileUrl, sleep } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ONLY_LAYOUT = process.argv.includes('--layout');

const PAGES = [
  'index.html',
  'pages/posts.html',
  'pages/post-reader.html',
  'pages/post-capability.html',
  'pages/post-no-build.html',
  'pages/works.html',
  'pages/archive.html',
  'pages/about.html',
  '404.html'
];

const WIDTHS = [360, 768, 1440];

const results = [];
const measurements = [];
const pageErrors = [];

function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''));
}

function watch(page, label) {
  page.client.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const detail = msg.params.exceptionDetails;
      pageErrors.push(label + ': ' + (detail.exception && detail.exception.description ? detail.exception.description : detail.text));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      const source = msg.params.entry.source;
      /* 未知地址页面会主动探测若干不存在的候选地址，网络类错误不计入本次核对 */
      if (source === 'javascript' || source === 'security' || source === 'violation') {
        pageErrors.push(label + ': ' + msg.params.entry.text);
      }
    }
  });
}

const LAYOUT_PROBE = `(() => {
  const doc = document.documentElement;
  const width = doc.clientWidth;
  function insideScroller(el) {
    let node = el.parentElement;
    while (node && node !== doc) {
      const style = getComputedStyle(node);
      if (style.overflowX !== 'visible') {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }
  const wide = [];
  const all = document.querySelectorAll('body *');
  for (let i = 0; i < all.length; i += 1) {
    const el = all[i];
    const rect = el.getBoundingClientRect();
    if (rect.width < 1) {
      continue;
    }
    if ((rect.right > width + 1 || rect.left < -1) && !insideScroller(el)) {
      wide.push(el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.split(/\\s+/)[0] : ''));
    }
  }
  return {
    nodes: document.querySelectorAll('*').length,
    overflow: doc.scrollWidth - width,
    wide: wide.slice(0, 4),
    wideCount: wide.length
  };
})()`;

const STRUCTURE_PROBE = `(() => {
  const issues = [];
  const html = document.documentElement;
  if (!html.getAttribute('lang')) {
    issues.push('缺少 lang');
  }
  if (!document.title) {
    issues.push('缺少 title');
  }
  const description = document.querySelector('meta[name="description"]');
  if (!description || !description.getAttribute('content')) {
    issues.push('缺少描述');
  }
  const h1 = document.querySelectorAll('h1');
  if (h1.length !== 1) {
    issues.push('h1 数量为 ' + h1.length);
  }
  const ids = new Set();
  const dup = [];
  document.querySelectorAll('[id]').forEach((el) => {
    if (ids.has(el.id)) {
      dup.push(el.id);
    }
    ids.add(el.id);
  });
  if (dup.length) {
    issues.push('id 重复：' + dup.join(' '));
  }
  document.querySelectorAll('img').forEach((img) => {
    if (!img.hasAttribute('alt')) {
      issues.push('图片缺少替代文字：' + img.getAttribute('src'));
    }
  });
  document.querySelectorAll('button').forEach((button) => {
    const name = (button.getAttribute('aria-label') || button.textContent || button.getAttribute('title') || '').trim();
    if (!name) {
      issues.push('按钮缺少可访问名称');
    }
  });
  document.querySelectorAll('a[href]').forEach((a) => {
    const name = (a.getAttribute('aria-label') || a.textContent || '').trim();
    if (!name) {
      issues.push('链接缺少文字：' + a.getAttribute('href'));
    }
  });
  document.querySelectorAll('input').forEach((input) => {
    const labelled = input.getAttribute('aria-label') || input.getAttribute('placeholder') || document.querySelector('label[for="' + input.id + '"]');
    if (!labelled) {
      issues.push('输入框缺少标签');
    }
  });
  const skip = document.querySelector('.skip-link');
  const targets = document.querySelectorAll('a[href^="#"]');
  if (skip && targets.length) {
    const id = skip.getAttribute('href').slice(1);
    if (!document.getElementById(id)) {
      issues.push('跳转链接指向的锚点不存在');
    }
  }
  return issues;
})()`;

/* 供未知地址页面核对使用的简易静态服务，行为与静态托管一致 */
function startServer(prefix) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8'
  };
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (prefix && url.indexOf(prefix) !== 0) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>outside</h1>');
      return;
    }
    const rel = url.slice(prefix.length);
    const file = path.join(ROOT, rel);
    if (rel && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(ROOT, '404.html')).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const browser = await launch();

try {
  /* 一、布局与结构 */
  for (const file of PAGES) {
    const page = await openPage(browser, 'about:blank');
    watch(page, file);
    await setViewport(page.client, 1440, 900);
    await navigate(page.client, fileUrl(ROOT + '/' + file));
    await sleep(400);

    const structure = await evaluate(page.client, STRUCTURE_PROBE);
    check(file + ' 结构检查', structure.length === 0, structure.join('；'));

    for (const width of WIDTHS) {
      await setViewport(page.client, width, 900);
      await sleep(250);
      const layout = await evaluate(page.client, LAYOUT_PROBE);
      measurements.push({ 页面: file, 宽度: width, 节点: layout.nodes, 溢出: layout.overflow, 越界元素: layout.wideCount });
      const ok = layout.overflow === 0 && layout.wideCount === 0;
      check(file + ' ' + width + ' 宽度无横向溢出', ok, ok ? '' : JSON.stringify({ overflow: layout.overflow, wide: layout.wide }));
    }
    await closePage(page);
  }

  if (!ONLY_LAYOUT) {
    /* 二、星图与减少动态效果 */
    {
      const page = await openPage(browser, 'about:blank');
      watch(page, 'index.html(动效)');
      await setReducedMotion(page.client, 'reduce');
      await navigate(page.client, fileUrl(ROOT + '/index.html'));
      await sleep(700);
      const data = await evaluate(page.client, `(() => {
        const paths = Array.from(document.querySelectorAll('.chart-lines path'));
        return {
          motion: document.documentElement.getAttribute('data-motion'),
          withD: paths.filter((p) => (p.getAttribute('d') || '').length > 0).length,
          canvasTransform: document.querySelector('.chart-canvas').style.transform
        };
      })()`);
      check('载入即减少动态效果时连线保留', data.withD === 4 && data.motion === 'reduced' && data.canvasTransform === '', JSON.stringify(data));

      await setReducedMotion(page.client, 'no-preference');
      await sleep(900);
      const first = await evaluate(page.client, `document.querySelector('.chart-node').style.transform`);
      await sleep(400);
      const second = await evaluate(page.client, `document.querySelector('.chart-node').style.transform`);
      check('偏好恢复后节点继续漂浮', first !== second, first + ' -> ' + second);

      await setReducedMotion(page.client, 'reduce');
      await sleep(400);
      const stopped = await evaluate(page.client, `(() => {
        const paths = Array.from(document.querySelectorAll('.chart-lines path'));
        return {
          withD: paths.filter((p) => (p.getAttribute('d') || '').length > 0).length,
          node: document.querySelector('.chart-node').style.transform
        };
      })()`);
      check('切到减少动态效果后连线保留且位移归零', stopped.withD === 4 && stopped.node.indexOf('translate3d(0px, 0px, 0px)') !== -1, JSON.stringify(stopped));
      await closePage(page);
    }

    /* 三、作品灯箱 */
    {
      const page = await openPage(browser, 'about:blank');
      watch(page, 'works.html(灯箱)');
      await navigate(page.client, fileUrl(ROOT + '/pages/works.html'));
      await sleep(400);
      const opened = await evaluate(page.client, `(() => {
        document.querySelector('.shot-open').click();
        return {
          hidden: document.getElementById('lightbox').hidden,
          overflow: document.body.style.overflow,
          headerInert: document.querySelector('.site-header').inert === true,
          closeFocused: /lightbox-close/.test(document.activeElement.className)
        };
      })()`);
      check('灯箱打开后锁定滚动并限制背景访问', opened.hidden === false && opened.overflow === 'hidden' && opened.headerInert === true && opened.closeFocused === true, JSON.stringify(opened));

      const trap = await evaluate(page.client, `(() => {
        const box = document.getElementById('lightbox');
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        const forward = box.contains(document.activeElement);
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
        return { forward, backward: box.contains(document.activeElement) };
      })()`);
      check('灯箱内 Tab 焦点循环', trap.forward === true && trap.backward === true, JSON.stringify(trap));

      const closed = await evaluate(page.client, `(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        return {
          hidden: document.getElementById('lightbox').hidden,
          overflow: document.body.style.overflow,
          headerInert: document.querySelector('.site-header').inert === true,
          focusBack: document.activeElement.classList.contains('shot-open')
        };
      })()`);
      check('灯箱关闭后还原滚动并归还焦点', closed.hidden === true && closed.overflow === '' && closed.headerInert === false && closed.focusBack === true, JSON.stringify(closed));
      await closePage(page);
    }

    /* 四、代码复制 */
    {
      const page = await openPage(browser, 'about:blank');
      watch(page, 'post-reader.html(复制)');
      await navigate(page.client, fileUrl(ROOT + '/pages/post-reader.html'));
      await sleep(900);
      const failed = await evaluate(page.client, `(async () => {
        if (!navigator.clipboard) {
          Object.defineProperty(navigator, 'clipboard', { value: {}, configurable: true });
        }
        navigator.clipboard.writeText = () => Promise.reject(new Error('denied'));
        document.execCommand = () => false;
        const button = Array.from(document.querySelectorAll('.code-action')).find((b) => b.textContent === '复制');
        button.click();
        await new Promise((r) => setTimeout(r, 150));
        const live = document.querySelector('[role="status"].visually-hidden');
        return { label: button.textContent, announced: live ? live.textContent : '' };
      })()`);
      check('复制失败时提示失败', failed.label === '复制失败' && /失败/.test(failed.announced), JSON.stringify(failed));

      const succeeded = await evaluate(page.client, `(async () => {
        navigator.clipboard.writeText = () => Promise.resolve();
        const button = Array.from(document.querySelectorAll('.code-action')).find((b) => /复制/.test(b.textContent));
        button.click();
        await new Promise((r) => setTimeout(r, 150));
        return { label: button.textContent };
      })()`);
      check('复制成功时提示成功', succeeded.label === '已复制', JSON.stringify(succeeded));

      const restored = await evaluate(page.client, `(async () => {
        await new Promise((r) => setTimeout(r, 2000));
        const button = Array.from(document.querySelectorAll('.code-action')).find((b) => /复制/.test(b.textContent));
        return button.textContent;
      })()`);
      check('复制按钮文案自动复位', restored === '复制', restored);
      await closePage(page);
    }

    /* 五、站内搜索 */
    {
      const page = await openPage(browser, 'about:blank');
      watch(page, 'index.html(搜索)');
      await navigate(page.client, fileUrl(ROOT + '/index.html'));
      await sleep(300);
      const rapid = await evaluate(page.client, `(() => {
        const real = Node.prototype.appendChild;
        window.__restore = () => { Node.prototype.appendChild = real; };
        Node.prototype.appendChild = function (node) {
          if (node && node.tagName === 'SCRIPT' && /search-index\\.js/.test(node.src || '')) {
            setTimeout(() => { if (typeof node.onerror === 'function') { node.onerror(); } }, 0);
            return node;
          }
          return real.call(this, node);
        };
        const toggle = document.querySelector('.search-toggle');
        toggle.click();
        toggle.click();
        toggle.click();
        return { scripts: document.querySelectorAll('script[src*="search.js"]').length };
      })()`);
      check('连续触发只注入一份搜索脚本', rapid.scripts === 1, JSON.stringify(rapid));

      await sleep(600);
      const loading = await evaluate(page.client, `(() => {
        const panel = document.getElementById('search-panel');
        return { hidden: panel.hidden, status: panel.querySelector('.search-status').textContent };
      })()`);
      check('索引失败时给出可重试提示', loading.hidden === false && /失败/.test(loading.status), JSON.stringify(loading));

      const retry = await evaluate(page.client, `(async () => {
        window.__restore();
        const toggle = document.querySelector('.search-toggle');
        toggle.click();
        await new Promise((r) => setTimeout(r, 50));
        toggle.click();
        await new Promise((r) => setTimeout(r, 800));
        const input = document.querySelector('.search-input');
        input.value = '构建';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 200));
        return {
          status: document.querySelector('.search-status').textContent,
          results: document.querySelectorAll('.search-result').length,
          index: Array.isArray(window.SearchIndex) ? window.SearchIndex.length : 0
        };
      })()`);
      check('重新打开后索引载入并返回结果', retry.index === 3 && retry.results > 0, JSON.stringify(retry));
      await closePage(page);
    }

    /* 六、访问端分档 */
    {
      const page = await openPage(browser, 'about:blank');
      watch(page, 'index.html(功能机)');
      await setUserAgent(page.client, 'Nokia2700c/09.80 Profile/MIDP-2.1 Configuration/CLDC-1.1');
      await navigate(page.client, fileUrl(ROOT + '/index.html'));
      await sleep(900);
      const data = await evaluate(page.client, `(() => {
        const skip = document.querySelector('.skip-link');
        const rect = skip.getBoundingClientRect();
        return {
          cap: document.documentElement.getAttribute('data-cap'),
          reason: document.documentElement.getAttribute('data-cap-reason'),
          lite: document.querySelectorAll('link[href*="lite.css"]').length,
          skipVisible: getComputedStyle(skip).display !== 'none' && rect.height > 0,
          themeHidden: getComputedStyle(document.querySelector('.theme-toggle')).display === 'none',
          navVisible: getComputedStyle(document.getElementById('site-nav')).display !== 'none'
        };
      })()`);
      check('功能机判为最低档并挂兜底样式', data.cap === 'minimal' && data.reason === 'legacy-ua' && data.lite === 1, JSON.stringify(data));
      check('最低档位保留跳转链接与导航', data.skipVisible === true && data.themeHidden === true && data.navVisible === true, JSON.stringify(data));
      await closePage(page);
    }

    {
      const page = await openPage(browser, 'about:blank');
      watch(page, 'index.html(受限 UA)');
      await setUserAgent(page.client, 'Mozilla/5.0 (Linux; U; Android 4.4.2; zh-cn; MI 2 Build/KOT49H) AppleWebKit/537.36 UCBrowser/11.0');
      await navigate(page.client, fileUrl(ROOT + '/index.html'));
      await sleep(500);
      const data = await evaluate(page.client, `({ cap: document.documentElement.getAttribute('data-cap'), reason: document.documentElement.getAttribute('data-cap-reason') })`);
      check('受限 UA 记为 constrained-ua', data.cap === 'low' && data.reason === 'constrained-ua', JSON.stringify(data));
      await closePage(page);
    }

    {
      const page = await openPage(browser, 'about:blank');
      watch(page, 'index.html(无指针事件)');
      await page.client.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.PointerEvent = undefined;' });
      await navigate(page.client, fileUrl(ROOT + '/index.html'));
      await sleep(900);
      const first = await evaluate(page.client, `document.querySelector('.chart-node').style.transform`);
      await sleep(400);
      const second = await evaluate(page.client, `document.querySelector('.chart-node').style.transform`);
      const data = await evaluate(page.client, `(() => {
        const link = document.querySelector('.chart-node a');
        const before = getComputedStyle(document.querySelector('.chart-node')).getPropertyValue('--x').trim();
        link.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        const after = getComputedStyle(document.querySelector('.chart-node')).getPropertyValue('--x').trim();
        return {
          cap: window.Capability.tier,
          pointer: window.Capability.env.pointerEvents,
          before,
          after,
          paths: Array.from(document.querySelectorAll('.chart-lines path')).filter((p) => (p.getAttribute('d') || '').length > 0).length
        };
      })()`);
      check('缺少指针事件时不降档且保留漂浮', data.pointer === false && (data.cap === 'medium' || data.cap === 'high') && first !== second, JSON.stringify(data));
      check('缺少指针事件时键盘微调可用', data.before !== data.after && data.paths === 4, JSON.stringify(data));
      await closePage(page);
    }

    /* 七、未知地址页面 */
    {
      const project = await startServer('/Qi-blog-ds/');
      const root = await startServer('');
      try {
        const page = await openPage(browser, 'about:blank');
        watch(page, '404.html(前缀)');
        await navigate(page.client, 'http://127.0.0.1:' + project.port + '/Qi-blog-ds/pages/missing');
        await sleep(900);
        const hrefs = await evaluate(page.client, `Array.from(document.querySelectorAll('a[data-site-link]')).map((a) => a.getAttribute('href'))`);
        check('项目子目录下的未知地址链接指向站点根', hrefs.length > 0 && hrefs.every((h) => h.indexOf('/Qi-blog-ds/') === 0), hrefs[0] || '');

        const rootHrefs = await (async () => {
          const inner = await openPage(browser, 'about:blank');
          await navigate(inner.client, 'http://127.0.0.1:' + root.port + '/pages/missing');
          await sleep(900);
          const list = await evaluate(inner.client, `Array.from(document.querySelectorAll('a[data-site-link]')).map((a) => a.getAttribute('href'))`);
          await closePage(inner);
          return list;
        })();
        check('域名根下的未知地址链接指向根', rootHrefs.indexOf('/pages/posts.html') !== -1, rootHrefs[0] || '');
        await closePage(page);
      } finally {
        project.server.close();
        root.server.close();
      }
    }
  }

  check('页面脚本错误为空', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 400));
} catch (error) {
  check('核对过程异常', false, String(error && error.stack ? error.stack : error));
} finally {
  await shutdown(browser);
}

console.log('');
console.log('节点与溢出一览');
console.table(measurements.filter((row) => row.宽度 === 1440));

const failed = results.filter((item) => !item.ok);
console.log('核对完成：共 ' + results.length + ' 项，失败 ' + failed.length + ' 项。');
process.exit(failed.length ? 1 : 0);
