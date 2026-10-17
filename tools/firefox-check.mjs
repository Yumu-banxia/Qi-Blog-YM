#!/usr/bin/env node
/* Firefox 引擎核对
 * Firefox 自 141 起不再提供 DevTools 协议接口，因此本脚本走 WebDriver 的 Marionette 通道。
 * 覆盖九个页面的结构、样式与资源，按需加载的公式与代码高亮，代码块折叠与复制，
 * 站内搜索、作品灯箱、减少动态效果，以及 HTTP 域名根与项目子目录两种托管方式。
 *
 * 用法：
 *   node tools/firefox-check.mjs            全部核对
 *   node tools/firefox-check.mjs --basic    只做页面基础核对
 *
 * 需要本机可用的 Firefox；浏览器缺失或无法建立通道时脚本直接报错退出。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchFirefox, shutdownFirefox, navigate, evaluate, sleep } from './marionette.mjs';
import { startServer } from './static-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ONLY_BASIC = process.argv.includes('--basic');

/* standalone 表示页面把样式内联在文档中，不引用站点样式表与脚本 */
const PAGES = [
  { file: 'index.html' },
  { file: 'pages/posts.html' },
  { file: 'pages/post-reader.html' },
  { file: 'pages/post-capability.html' },
  { file: 'pages/post-no-build.html' },
  { file: 'pages/works.html' },
  { file: 'pages/archive.html' },
  { file: 'pages/about.html' },
  { file: '404.html', standalone: true }
];

const results = [];

function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''));
}

function fileUrl(rel) {
  return 'file:///' + path.join(ROOT, rel).replace(/\\/g, '/');
}

/* 页面内的条件需要等待：按需加载的第三方库与索引都在载入后完成 */
async function waitFor(browser, source, timeout) {
  const deadline = Date.now() + (timeout || 12000);
  let value = null;
  while (Date.now() < deadline) {
    value = await evaluate(browser, source);
    if (value) {
      return value;
    }
    await sleep(250);
  }
  return value;
}

/* 延迟加载的图片只有进入视口后才开始请求，因此单独统计，不并入即时资源核对 */
const BASE_PROBE = `
const doc = document.documentElement;
const images = Array.prototype.slice.call(document.images);
function failed(img) { return !img.complete || img.naturalWidth === 0; }
function lazy(img) { return img.loading === 'lazy'; }
return {
  title: document.title,
  main: document.querySelectorAll('main').length,
  h1: document.querySelectorAll('h1').length,
  cap: doc.getAttribute('data-cap'),
  token: getComputedStyle(doc).getPropertyValue('--space-4').trim().length > 0,
  inlineToken: getComputedStyle(doc).getPropertyValue('--bg').trim().length > 0,
  broken: images.filter(function (img) { return failed(img) && !lazy(img); })
    .map(function (img) { return img.getAttribute('src'); }),
  lazy: images.filter(lazy).length,
  images: images.length,
  overflow: doc.scrollWidth - doc.clientWidth
};`;

const LAZY_PROBE = `
return Array.prototype.filter.call(document.images, function (img) {
  return img.loading === 'lazy' && (!img.complete || img.naturalWidth === 0);
}).map(function (img) { return img.getAttribute('src'); });`;

const CHART_PROBE = `
return {
  nodes: document.querySelectorAll('.star-chart .chart-node').length,
  paths: document.querySelectorAll('.chart-lines path').length,
  motion: document.documentElement.getAttribute('data-motion')
};`;

async function readBasic(browser, url) {
  await navigate(browser, url);
  await sleep(200);
  return evaluate(browser, BASE_PROBE);
}

function basicIssues(data, page) {
  const issues = [];
  if (!data.title) {
    issues.push('缺少标题');
  }
  if (data.main !== 1) {
    issues.push('main 数量为 ' + data.main);
  }
  if (data.h1 !== 1) {
    issues.push('h1 数量为 ' + data.h1);
  }
  if (!page.standalone && !data.cap) {
    issues.push('未标记设备档位');
  }
  return issues;
}

function resourceIssues(data, page) {
  const issues = [];
  const styled = page.standalone ? data.inlineToken : data.token;
  if (!styled) {
    issues.push('页面样式未解析');
  }
  if (data.broken.length) {
    issues.push('图片未加载：' + data.broken.join(' '));
  }
  if (data.overflow > 1) {
    issues.push('横向溢出 ' + data.overflow + ' 像素');
  }
  return issues;
}

const browser = await launchFirefox();
let reduced = null;
let servers = [];

try {
  console.log('引擎：' + (await evaluate(browser, 'return navigator.userAgent;')));

  /* 一、九个页面的结构、样式与资源 */
  for (const page of PAGES) {
    const data = await readBasic(browser, fileUrl(page.file));
    const structure = basicIssues(data, page);
    check(page.file + ' 结构检查', structure.length === 0, structure.join('；'));
    const resources = resourceIssues(data, page);
    check(page.file + ' 样式与资源检查', resources.length === 0, resources.join('；'));

    if (data.lazy > 0) {
      await evaluate(browser, 'window.scrollTo(0, document.body.scrollHeight); return true;');
      await sleep(1000);
      const rest = await evaluate(browser, LAZY_PROBE);
      check(page.file + ' 延迟加载图片在滚动后完成', rest.length === 0, rest.join(' ') || String(data.lazy) + ' 张');
    }
  }

  if (!ONLY_BASIC) {
    /* 二、首页星图、主题与搜索 */
    await navigate(browser, fileUrl('index.html'));
    const chart = await evaluate(browser, CHART_PROBE);
    check('首页星图渲染四个节点与四条连线', chart.nodes === 4 && chart.paths === 4, JSON.stringify(chart));

    const theme = await evaluate(browser, `
      const before = document.documentElement.getAttribute('data-theme');
      document.querySelector('.theme-toggle').click();
      return { before: before, after: document.documentElement.getAttribute('data-theme') };
    `);
    check('主题按钮切换明暗主题', theme.before !== theme.after && !!theme.after, JSON.stringify(theme));

    await evaluate(browser, "document.querySelector('.search-toggle').click(); return true;");
    const opened = await waitFor(browser, "return document.getElementById('search-panel').hidden === false;", 8000);
    await evaluate(browser, `
      const input = document.querySelector('.search-input');
      input.value = '构建';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `);
    const hits = await waitFor(browser, "return document.querySelectorAll('.search-result').length;", 12000);
    check('站内搜索打开面板并给出结果', opened === true && hits > 0, JSON.stringify({ opened: opened, hits: hits }));

    const searchModal = await evaluate(browser, `
      const host = document.querySelector('.skip-link').closest('body > *');
      const panel = document.getElementById('search-panel');
      const link = document.querySelector('.skip-link');
      link.focus();
      return {
        overflow: document.body.style.overflow,
        hostInert: host.inert === true,
        panelInert: panel.inert === true,
        outside: document.activeElement === link
      };
    `);
    check('搜索面板打开时锁定滚动并屏蔽背景键盘访问',
      searchModal.overflow === 'hidden' && searchModal.hostInert === true && searchModal.panelInert === false && searchModal.outside === false,
      JSON.stringify(searchModal));

    const searchClosed = await evaluate(browser, `
      document.querySelector('.search-dismiss').click();
      const host = document.querySelector('.skip-link').closest('body > *');
      return {
        hidden: document.getElementById('search-panel').hidden,
        overflow: document.body.style.overflow,
        hostInert: host.inert === true,
        focus: (document.activeElement && document.activeElement.className) || ''
      };
    `);
    check('搜索面板关闭后还原滚动与背景键盘访问',
      searchClosed.hidden === true && searchClosed.overflow === '' && searchClosed.hostInert === false && /search-toggle/.test(searchClosed.focus),
      JSON.stringify(searchClosed));

    /* 三、作品页灯箱 */
    await navigate(browser, fileUrl('pages/works.html'));
    const lightbox = await evaluate(browser, `
      document.querySelector('.shot-open').click();
      const box = document.getElementById('lightbox');
      return {
        hidden: box.hidden,
        overflow: document.body.style.overflow,
        focus: (document.activeElement && document.activeElement.className) || ''
      };
    `);
    check('灯箱打开时锁定滚动并把焦点移入对话框',
      lightbox.hidden === false && lightbox.overflow === 'hidden' && /lightbox-close/.test(lightbox.focus),
      JSON.stringify(lightbox));
    const closed = await evaluate(browser, `
      document.querySelector('.lightbox-close').click();
      const box = document.getElementById('lightbox');
      return {
        hidden: box.hidden,
        overflow: document.body.style.overflow,
        focus: (document.activeElement && document.activeElement.className) || ''
      };
    `);
    check('灯箱关闭后还原滚动并归还焦点',
      closed.hidden === true && closed.overflow === '' && /shot-open/.test(closed.focus),
      JSON.stringify(closed));

    /* 四、文章页的公式、代码高亮、折叠与复制 */
    await navigate(browser, fileUrl('pages/post-reader.html'));
    const math = await waitFor(browser, `
      return document.querySelectorAll('.katex').length > 0 &&
        document.documentElement.getAttribute('data-math') === 'rendered';
    `, 15000);
    check('公式在 Firefox 下按需渲染', math === true, String(math));

    const highlight = await waitFor(browser, `
      const code = document.querySelector('.prose pre code');
      return !!code && (code.classList.contains('hljs') || code.querySelectorAll('[class^="hljs-"]').length > 0);
    `, 15000);
    check('代码高亮在 Firefox 下按需生效', highlight === true, String(highlight));

    const fold = await evaluate(browser, `
      const toggle = document.querySelector('.code-block[data-folded] .code-action[aria-expanded]');
      if (!toggle) { return { found: false }; }
      const wrapper = toggle.closest('.code-block');
      const before = { expanded: toggle.getAttribute('aria-expanded'), folded: wrapper.getAttribute('data-folded') };
      toggle.click();
      return {
        found: true,
        before: before,
        after: { expanded: toggle.getAttribute('aria-expanded'), folded: wrapper.getAttribute('data-folded') }
      };
    `);
    check('代码块折叠按钮切换展开状态',
      fold.found === true && fold.before.expanded === 'false' && fold.after.expanded === 'true' &&
        fold.before.folded === 'true' && fold.after.folded === 'false',
      JSON.stringify(fold));

    const codeWindow = await evaluate(browser, `
      const pre = document.querySelector('.code-block[data-folded="false"] pre');
      if (!pre) { return { found: false }; }
      return {
        found: true,
        clientHeight: pre.clientHeight,
        scrollHeight: pre.scrollHeight,
        overflowY: getComputedStyle(pre).overflowY,
        scrollTop: pre.scrollTop
      };
    `);
    check('展开后的代码块在 Firefox 下形成独立纵向滚动窗口',
      codeWindow.found === true && codeWindow.overflowY === 'auto' &&
        codeWindow.scrollHeight > codeWindow.clientHeight && codeWindow.scrollTop === 0,
      JSON.stringify(codeWindow));

    const clicked = await evaluate(browser, `
      const button = document.querySelector('.code-action[aria-label="复制代码"]');
      if (!button) { return false; }
      button.click();
      return true;
    `);
    /* 剪贴板写入是异步过程，先等提示出现，再等提示复位 */
    const label = clicked ? await waitFor(browser, `
      const button = document.querySelector('.code-action[aria-label="复制代码"]');
      const text = button ? button.textContent : '';
      return text === '复制' ? null : text;
    `, 6000) : null;
    await sleep(2200);
    const restored = await evaluate(browser, `
      const button = document.querySelector('.code-action[aria-label="复制代码"]');
      return button ? button.textContent : '';
    `);
    check('复制按钮给出成功或失败提示并自动复位',
      /已复制|复制失败/.test(String(label)) && restored === '复制',
      JSON.stringify({ label: label, restored: restored }));

    /* 五、减少动态效果下的星图 */
    reduced = await launchFirefox({ prefs: { 'ui.prefersReducedMotion': 1 } });
    await navigate(reduced, fileUrl('index.html'));
    await sleep(800);
    const still = await evaluate(reduced, `
      const nodes = document.querySelectorAll('.star-chart .chart-node');
      let moving = 0;
      for (let i = 0; i < nodes.length; i += 1) {
        const transform = nodes[i].style.transform || '';
        const open = transform.indexOf('translate3d(');
        if (open === -1) {
          if (transform.indexOf('translate') !== -1) { moving += 1; }
          continue;
        }
        /* 通过字符串切分取值，避免模板字符串对正则转义的二次处理 */
        const parts = transform.slice(open + 12).split(')')[0].split(',');
        if (Math.abs(parseFloat(parts[0]) || 0) > 0.5 || Math.abs(parseFloat(parts[1]) || 0) > 0.5) {
          moving += 1;
        }
      }
      return {
        query: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        motion: document.documentElement.getAttribute('data-motion'),
        paths: document.querySelectorAll('.chart-lines path').length,
        moved: moving
      };
    `);
    check('减少动态效果下系统偏好被识别并标记',
      still.query === true && still.motion === 'reduced',
      JSON.stringify(still));
    check('减少动态效果下连线保留且节点不再漂浮',
      still.paths === 4 && still.moved === 0,
      JSON.stringify({ paths: still.paths, moved: still.moved }));
    await shutdownFirefox(reduced);
    reduced = null;

    /* 六、HTTP 托管：域名根与项目子目录 */
    const rootServer = await startServer(ROOT, '');
    const subServer = await startServer(ROOT, '/Qi-blog-ds/');
    servers = [rootServer, subServer];
    const targets = [
      { title: '域名根', origin: rootServer.origin },
      { title: '项目子目录', origin: subServer.origin }
    ];
    for (const target of targets) {
      const home = await readBasic(browser, target.origin + '/index.html');
      const homeChart = await evaluate(browser, CHART_PROBE);
      const homeIssues = basicIssues(home, {}).concat(resourceIssues(home, {}));
      check(target.title + '：首页结构、样式与星图正常',
        homeIssues.length === 0 && homeChart.nodes === 4 && homeChart.paths === 4,
        homeIssues.join('；') || JSON.stringify(homeChart));

      const article = await readBasic(browser, target.origin + '/pages/post-reader.html');
      const articleMath = await waitFor(browser, "return document.querySelectorAll('.katex').length > 0;", 15000);
      const articleCode = await waitFor(browser, `
        const code = document.querySelector('.prose pre code');
        return !!code && code.classList.contains('hljs');
      `, 15000);
      const articleIssues = basicIssues(article, {}).concat(resourceIssues(article, {}));
      check(target.title + '：文章页样式、图片、公式与高亮正常',
        articleIssues.length === 0 && articleMath === true && articleCode === true,
        articleIssues.join('；') || JSON.stringify({ math: articleMath, code: articleCode, images: article.images }));
    }
  }
} catch (error) {
  check('核对过程异常', false, String(error && error.stack ? error.stack : error));
} finally {
  for (const item of servers) {
    try { item.server.close(); } catch (error) { /* 忽略 */ }
  }
  if (reduced) {
    await shutdownFirefox(reduced);
  }
  await shutdownFirefox(browser);
}

const failed = results.filter((item) => !item.ok).length;
console.log('\nFirefox 核对完成：共 ' + results.length + ' 项，失败 ' + failed + ' 项。');
process.exitCode = failed === 0 ? 0 : 1;
