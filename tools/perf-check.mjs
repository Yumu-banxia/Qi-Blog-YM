#!/usr/bin/env node
/* 性能记录
 * 以无头 Chromium 打开本地文件，记录首屏绘制时间、累积布局偏移、帧间隔与长任务，
 * 再在 320 像素宽度下放大行高、字距与词距，检查是否出现横向重排。
 * 帧间隔与长任务随机器负载浮动，只作记录；累积布局偏移、文档级横向溢出与脚本报错才作为失败条件。
 * 需要 Node 22 以上。
 *
 * 用法：
 *   node tools/perf-check.mjs
 *   node tools/perf-check.mjs --frames 3000
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, browserName, shutdown, openPage, navigate, evaluate, setViewport, closePage, fileUrl, sleep } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

/* 首页星图与文章页渲染都在视口内发生，采样窗口覆盖首次绘制之后的一段时间 */
const args = process.argv.slice(2);
const framesAt = args.indexOf('--frames');
const WINDOW = framesAt !== -1 ? Math.max(1200, Number(args[framesAt + 1]) || 2400) : 2400;

/* 在文档开始之前挂上观察器，才能取到首次绘制与最初的布局偏移 */
const OBSERVER = `
window.__perf = { cls: 0, longtasks: [], fcp: null, times: [] };
try {
  new PerformanceObserver(function (list) {
    var entries = list.getEntries();
    for (var i = 0; i < entries.length; i += 1) {
      if (!entries[i].hadRecentInput) {
        window.__perf.cls += entries[i].value;
      }
    }
  }).observe({ type: 'layout-shift', buffered: true });
} catch (error) { /* 内核不支持时跳过 */ }
try {
  new PerformanceObserver(function (list) {
    var entries = list.getEntries();
    for (var i = 0; i < entries.length; i += 1) {
      window.__perf.longtasks.push(Math.round(entries[i].duration));
    }
  }).observe({ type: 'longtask', buffered: true });
} catch (error) { /* 内核不支持时跳过 */ }
try {
  new PerformanceObserver(function (list) {
    var entries = list.getEntries();
    for (var i = 0; i < entries.length; i += 1) {
      if (entries[i].name === 'first-contentful-paint') {
        window.__perf.fcp = Math.round(entries[i].startTime);
      }
    }
  }).observe({ type: 'paint', buffered: true });
} catch (error) { /* 内核不支持时跳过 */ }
requestAnimationFrame(function () {
  requestAnimationFrame(function step(now) {
    window.__perf.times.push(now);
    requestAnimationFrame(step);
  });
});
`;

const READ = `(() => {
  const data = window.__perf;
  const times = data.times.slice(-600);
  const deltas = [];
  for (let i = 1; i < times.length; i += 1) {
    deltas.push(times[i] - times[i - 1]);
  }
  deltas.sort((a, b) => a - b);
  const pick = (q) => (deltas.length ? deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * q))] : 0);
  const round = (value) => Math.round(value * 10) / 10;
  return {
    frames: deltas.length,
    p50: round(pick(0.5)),
    p95: round(pick(0.95)),
    max: deltas.length ? round(deltas[deltas.length - 1]) : 0,
    cls: Math.round(data.cls * 1000) / 1000,
    fcp: data.fcp,
    longtasks: data.longtasks
  };
})()`;

/* 放大文字后放宽排版条件，用于确认窄屏结构留有余量 */
const STRESS = `(() => {
  const style = document.createElement('style');
  style.textContent = 'html{line-height:1.5 !important} body *{line-height:1.5 !important; letter-spacing:0.12em !important; word-spacing:0.16em !important} p,li{margin-bottom:1em}';
  document.head.appendChild(style);
  const root = document.documentElement;
  const wide = [];
  const nodes = document.querySelectorAll('body *');
  for (let i = 0; i < nodes.length; i += 1) {
    const rect = nodes[i].getBoundingClientRect();
    if (rect.width > root.clientWidth + 1) {
      wide.push(nodes[i].tagName.toLowerCase());
    }
  }
  return {
    overflow: root.scrollWidth - root.clientWidth,
    wide: wide.length,
    samples: wide.slice(0, 4)
  };
})()`;

const results = [];
const failures = [];

function record(name, ok, detail) {
  results.push({ name, ok: ok === true });
  if (ok !== true) {
    failures.push(name + (detail ? ' :: ' + detail : ''));
  }
}

const browser = await launch();

try {
  /* 全新浏览器档案的首次导航要付出初始化代价，先走一遍最小页面再开始采样 */
  const warmup = await openPage(browser, 'about:blank');
  await navigate(warmup.client, fileUrl(ROOT + '/404.html'));
  await sleep(600);
  await closePage(warmup);

  for (const file of PAGES) {
    const page = await openPage(browser, 'about:blank');
    const errors = [];
    page.client.on((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        errors.push(msg.params.exceptionDetails.text || '脚本异常');
      }
    });

    await setViewport(page.client, 1440, 900);
    await page.client.send('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER });
    await navigate(page.client, fileUrl(ROOT + '/' + file));
    await sleep(WINDOW);
    const metrics = await evaluate(page.client, READ);

    await setViewport(page.client, 320, 640);
    await sleep(500);
    const narrow = await evaluate(page.client, STRESS);

    const longtask = metrics.longtasks.length ? metrics.longtasks.join(' ') : '无';
    record(file + ' 首屏无布局偏移', metrics.cls <= 0.1, 'CLS ' + metrics.cls);
    record(file + ' 320 宽度文字放大后无横向溢出', narrow.overflow <= 1, '溢出 ' + narrow.overflow + ' 像素');
    record(file + ' 无脚本异常', errors.length === 0, errors.join(' | '));

    console.log(
      file.padEnd(28) +
      '帧 ' + String(metrics.frames).padStart(3) +
      '  p50 ' + String(metrics.p50).padStart(5) + ' ms' +
      '  p95 ' + String(metrics.p95).padStart(5) + ' ms' +
      '  最长 ' + String(metrics.max).padStart(5) + ' ms' +
      '  CLS ' + metrics.cls +
      '  FCP ' + (metrics.fcp === null ? '未取到' : metrics.fcp + ' ms') +
      '  长任务 ' + longtask
    );
    if (narrow.wide) {
      console.log('  320 宽度下宽于视口的元素 ' + narrow.wide + ' 个，示例 ' + narrow.samples.join(' ') + '（应位于各自滚动容器内）');
    }
    await closePage(page);
  }
} catch (error) {
  record('性能记录过程异常', false, String(error && error.stack ? error.stack : error));
} finally {
  await shutdown(browser);
}

console.log('');
console.log('内核：' + browserName() + '，采样窗口 ' + WINDOW + ' 毫秒');
console.log('记录完成：共 ' + results.length + ' 项，失败 ' + failures.length + ' 项。');
for (const item of failures) {
  console.log('FAIL ' + item);
}
process.exit(failures.length ? 1 : 0);
