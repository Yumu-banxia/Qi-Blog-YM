#!/usr/bin/env node
/* 提交前验收核对
 * 覆盖键盘操作、打印输出、HTTP 托管（域名根与项目子目录）、第三方库按需加载与已访问链接配色。
 * 需要 Node 22 以上。内核默认为 Chrome，可用环境变量 QI_BROWSER 指定 edge 或可执行文件地址。
 *
 * 用法：
 *   node tools/acceptance-check.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, browserName, shutdown, openPage, navigate, evaluate, setViewport, closePage, fileUrl, sleep, once } from './cdp.mjs';
import { startServer } from './static-server.mjs';

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

const INLINE_ONLY = ['404.html'];

const results = [];
const pageErrors = [];

function check(name, ok, detail) {
  results.push({ name, ok: ok === true });
  console.log((ok === true ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''));
}

function watchErrors(page, label) {
  page.client.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const detail = msg.params.exceptionDetails;
      pageErrors.push(label + ': ' + (detail.exception && detail.exception.description ? detail.exception.description : detail.text));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      const source = msg.params.entry.source;
      if (source !== 'network' && source !== 'deprecation') {
        pageErrors.push(label + ': ' + msg.params.entry.text);
      }
    }
  });
}

/* 记录请求地址与加载失败，用于核对托管与按需加载 */
function watchNetwork(page) {
  const urls = [];
  const failures = [];
  page.client.on((msg) => {
    if (msg.method === 'Network.requestWillBeSent') {
      urls.push(msg.params.request.url);
    }
    if (msg.method === 'Network.loadingFailed') {
      failures.push((msg.params.errorText || '未知错误') + ' / ' + msg.params.type);
    }
  });
  return { urls, failures };
}

function keyEvent(key, keyCode, text) {
  const base = { key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  if (text) {
    base.text = text;
  }
  return base;
}

async function press(client, key, keyCode, text) {
  const base = keyEvent(key, keyCode, text);
  await client.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
  await client.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
}

async function pressWithText(client, key, keyCode, text) {
  const base = keyEvent(key, keyCode, text);
  await client.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, base));
  await client.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
}

const pressTab = (client) => press(client, 'Tab', 9);
const pressEscape = (client) => press(client, 'Escape', 27);
const pressArrowDown = (client) => press(client, 'ArrowDown', 40);
const pressEnter = (client) => pressWithText(client, 'Enter', 13, '\r');

/* Shift+Tab：modifiers 取 8 表示 Shift */
async function pressShiftTab(client) {
  const base = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: 8 };
  await client.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
  await client.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
}

/* 已访问链接配色对比用的取样点：首页“全部作品”链接及其周边留白 */
const LINK_PROBE = `(() => {
  const link = Array.from(document.querySelectorAll('a')).find((item) => item.textContent.trim() === '全部作品');
  if (!link) {
    return null;
  }
  link.scrollIntoView({ block: 'center' });
  const reveals = Array.from(document.querySelectorAll('[data-reveal]'));
  for (let i = 0; i < reveals.length; i += 1) {
    reveals[i].style.transition = 'none';
    reveals[i].style.opacity = '1';
    reveals[i].style.transform = 'none';
  }
  const rect = link.getBoundingClientRect();
  const pad = 8;
  return {
    x: rect.left + window.scrollX - pad,
    y: rect.top + window.scrollY - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
    href: link.getAttribute('href')
  };
})()`;

async function clipShot(client, clip) {
  const shot = await client.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 },
    captureBeyondViewport: true
  });
  return shot.data;
}

const PRINT_PROBE = `(() => {
  const nav = document.querySelector('.site-nav');
  const toggle = document.querySelector('.theme-toggle');
  const chart = document.querySelector('.star-chart');
  const reveals = Array.from(document.querySelectorAll('[data-reveal]'));
  const doc = document.documentElement;
  return {
    nav: nav ? getComputedStyle(nav).display : 'none',
    toggle: toggle ? getComputedStyle(toggle).display : 'none',
    chart: chart ? getComputedStyle(chart).display : 'none',
    expanded: reveals.every((item) => getComputedStyle(item).opacity === '1'),
    overflow: doc.scrollWidth - doc.clientWidth,
    main: !!document.getElementById('main'),
    title: document.title
  };
})()`;

const browser = await launch();

try {
  /* 一、已访问链接与未访问链接的渲染结果一致 */
  {
    const page = await openPage(browser, 'about:blank');
    watchErrors(page, 'index.html(已访问链接)');
    await setViewport(page.client, 1440, 900);
    await navigate(page.client, fileUrl(ROOT + '/index.html'));
    await sleep(700);

    const firstClip = await evaluate(page.client, LINK_PROBE);
    if (!firstClip) {
      check('首页存在用于比对的站内链接', false, '未找到“全部作品”链接');
    } else {
      await sleep(200);
      const before = await clipShot(page.client, firstClip);
      const loaded = once(page.client, 'Page.loadEventFired', 10000);
      await evaluate(page.client, `document.querySelector('a[href$="works.html"]').click()`);
      await loaded;
      await sleep(500);
      const landed = await evaluate(page.client, 'location.pathname');
      const back = once(page.client, 'Page.loadEventFired', 10000);
      const history = await page.client.send('Page.getNavigationHistory');
      const entry = history.entries.filter((item) => /index\.html$/.test(item.url)).pop();
      await page.client.send('Page.navigateToHistoryEntry', { entryId: entry.id });
      await back;
      await sleep(900);
      const secondClip = await evaluate(page.client, LINK_PROBE);
      const after = await clipShot(page.client, secondClip);
      check('链接点击前后配色一致', before === after, landed + ' -> ' + (before === after ? '像素一致' : '像素不同 ' + before.length + '/' + after.length));
    }
    await closePage(page);
  }

  /* 二、跳过链接与主题按钮的键盘操作 */
  {
    const page = await openPage(browser, 'about:blank');
    watchErrors(page, 'index.html(键盘)');
    await setViewport(page.client, 1440, 900);
    await navigate(page.client, fileUrl(ROOT + '/index.html'));
    await sleep(500);

    await pressTab(page.client);
    const first = await evaluate(page.client, `(() => {
      const el = document.activeElement;
      return { tag: el.tagName, cls: el.className, href: el.getAttribute ? el.getAttribute('href') : null };
    })()`);
    check('首个 Tab 停在跳过链接', first.tag === 'A' && /skip-link/.test(first.cls || '') && first.href === '#main', JSON.stringify(first));

    await pressEnter(page.client);
    await sleep(250);
    const jumped = await evaluate(page.client, `({ hash: location.hash, focus: document.activeElement.className || document.activeElement.id || document.activeElement.tagName })`);
    check('回车后跳转到主内容', jumped.hash === '#main', JSON.stringify(jumped));

    const before = await evaluate(page.client, `document.documentElement.getAttribute('data-theme')`);
    await evaluate(page.client, `document.querySelector('.theme-toggle').focus()`);
    await pressEnter(page.client);
    await sleep(250);
    const themed = await evaluate(page.client, `({ theme: document.documentElement.getAttribute('data-theme'), pressed: document.querySelector('.theme-toggle').getAttribute('aria-pressed') })`);
    check('主题按钮响应键盘并同步状态', themed.theme !== before && themed.pressed === String(themed.theme === 'dark'), before + ' -> ' + JSON.stringify(themed));
    await closePage(page);
  }

  /* 三、搜索面板的键盘流程 */
  {
    const page = await openPage(browser, 'about:blank');
    watchErrors(page, 'index.html(搜索键盘)');
    await setViewport(page.client, 1440, 900);
    await navigate(page.client, fileUrl(ROOT + '/index.html'));
    await sleep(400);

    const baseline = await evaluate(page.client, `(() => {
      const host = document.querySelector('.skip-link').closest('body > *');
      return {
        overflow: document.body.style.overflow,
        paddingRight: document.body.style.paddingRight,
        aria: host.getAttribute('aria-hidden'),
        inertSupported: 'inert' in HTMLElement.prototype
      };
    })()`);

    await evaluate(page.client, `document.querySelector('.search-toggle').focus()`);
    await pressEnter(page.client);
    await sleep(800);
    const opened = await evaluate(page.client, `(() => {
      const panel = document.getElementById('search-panel');
      return { hidden: panel.hidden, focus: document.activeElement.className, expanded: document.querySelector('.search-toggle').getAttribute('aria-expanded') };
    })()`);
    check('搜索入口响应键盘并聚焦输入框', opened.hidden === false && /search-input/.test(opened.focus || '') && opened.expanded === 'true', JSON.stringify(opened));

    const modal = await evaluate(page.client, `(() => {
      const panel = document.getElementById('search-panel');
      const host = document.querySelector('.skip-link').closest('body > *');
      const outside = document.querySelector('.skip-link');
      const gap = window.innerWidth - document.documentElement.clientWidth;
      outside.focus();
      const state = {
        overflow: document.body.style.overflow,
        paddingRight: document.body.style.paddingRight,
        gap: gap,
        hostInert: host.inert === true,
        hostHidden: host.getAttribute('aria-hidden'),
        panelInert: panel.inert === true,
        outsideReachable: document.activeElement === outside
      };
      document.querySelector('.search-input').focus();
      return state;
    })()`);
    check('搜索面板打开时暂停页面滚动', modal.overflow === 'hidden' && modal.paddingRight === (modal.gap > 0 ? modal.gap + 'px' : ''), JSON.stringify(modal));
    const shielded = baseline.inertSupported
      ? modal.hostInert === true && modal.outsideReachable === false
      : modal.hostHidden === 'true';
    check('搜索面板打开时背景退出键盘访问', modal.panelInert === false && shielded, JSON.stringify(modal));

    await page.client.send('Input.insertText', { text: '构建' });
    await sleep(500);
    const typed = await evaluate(page.client, `({ value: document.querySelector('.search-input').value, results: document.querySelectorAll('.search-result').length })`);
    check('输入关键词后给出结果', typed.results > 0, JSON.stringify(typed));

    await pressArrowDown(page.client);
    await sleep(250);
    const current = await evaluate(page.client, `(() => {
      const item = document.querySelector('.search-result[aria-current="true"]');
      return item ? item.textContent.trim().slice(0, 24) : '';
    })()`);
    check('方向键移动选中项', current.length > 0, current);

    const trap = await evaluate(page.client, `(() => {
      const items = Array.from(document.querySelectorAll('#search-panel a[href], #search-panel button, #search-panel input'));
      window.__trapFirst = items[0];
      window.__trapLast = items[items.length - 1];
      window.__trapLast.focus();
      return { count: items.length, first: window.__trapFirst.className, last: window.__trapLast.className };
    })()`);
    await pressTab(page.client);
    await sleep(150);
    const wrapped = await evaluate(page.client, `(() => {
      const panel = document.getElementById('search-panel');
      return { isFirst: document.activeElement === window.__trapFirst, inside: panel.contains(document.activeElement), focus: document.activeElement.className };
    })()`);
    check('Tab 在面板内循环回到首个控件', trap.count > 1 && wrapped.isFirst === true && wrapped.inside === true, JSON.stringify(Object.assign({}, trap, wrapped)));

    await pressShiftTab(page.client);
    await sleep(150);
    const reversed = await evaluate(page.client, `({ isLast: document.activeElement === window.__trapLast, focus: document.activeElement.className })`);
    check('Shift+Tab 在面板内循环到末个控件', reversed.isLast === true, JSON.stringify(reversed));

    await pressEscape(page.client);
    await sleep(250);
    const closed = await evaluate(page.client, `(() => {
      const panel = document.getElementById('search-panel');
      const host = document.querySelector('.skip-link').closest('body > *');
      return {
        hidden: panel.hidden,
        focus: document.activeElement.className,
        expanded: document.querySelector('.search-toggle').getAttribute('aria-expanded'),
        overflow: document.body.style.overflow,
        paddingRight: document.body.style.paddingRight,
        inert: host.inert === true,
        aria: host.getAttribute('aria-hidden')
      };
    })()`);
    check('Esc 关闭搜索并归还焦点', closed.hidden === true && /search-toggle/.test(closed.focus || '') && closed.expanded === 'false', JSON.stringify(closed));
    check('关闭搜索后解除滚动锁定与背景屏蔽', closed.overflow === baseline.overflow && closed.paddingRight === baseline.paddingRight && closed.inert === false && closed.aria === baseline.aria, JSON.stringify(closed));

    const released = await evaluate(page.client, `(() => {
      const link = document.getElementById('site-nav').querySelector('a');
      link.focus();
      const reachable = document.activeElement === link;
      document.querySelector('.search-toggle').focus();
      return reachable;
    })()`);
    check('关闭搜索后背景恢复键盘访问', released === true, String(released));

    await pressEnter(page.client);
    await sleep(800);
    await page.client.send('Input.insertText', { text: '构建' });
    await sleep(500);
    await pressArrowDown(page.client);
    await sleep(250);
    const loaded = once(page.client, 'Page.loadEventFired', 10000);
    await pressEnter(page.client);
    await loaded;
    await sleep(400);
    const landed = await evaluate(page.client, 'location.pathname');
    check('回车打开选中的文章', /pages\/post-[^/]*\.html$/.test(landed), landed);
    await closePage(page);
  }

  /* 四、打印输出 */
  {
    for (const file of ['index.html', 'pages/post-reader.html', 'pages/works.html']) {
      const page = await openPage(browser, 'about:blank');
      watchErrors(page, file + '(打印)');
      await setViewport(page.client, 1440, 900);
      await navigate(page.client, fileUrl(ROOT + '/' + file));
      await sleep(600);
      await page.client.send('Emulation.setEmulatedMedia', { media: 'print' });
      await sleep(300);
      const data = await evaluate(page.client, PRINT_PROBE);
      await page.client.send('Emulation.setEmulatedMedia', { media: '' });
      const ok = data.nav === 'none' && data.toggle === 'none' && data.expanded === true && data.overflow === 0 && data.main === true;
      check(file + ' 打印样式隐藏屏幕控件并展开内容', ok, JSON.stringify(data));
      await closePage(page);
    }
  }

  /* 五、第三方库按需加载 */
  {
    const site = await startServer(ROOT, '');
    try {
      const article = await openPage(browser, 'about:blank');
      await article.client.send('Network.enable');
      const articleNet = watchNetwork(article);
      watchErrors(article, 'post-reader.html(按需)');
      await navigate(article.client, site.origin + '/pages/post-reader.html');
      await sleep(1500);
      const vendor = articleNet.urls.filter((url) => url.indexOf('/assets/vendor/') !== -1);
      const short = vendor.map((url) => url.slice(url.indexOf('/assets/vendor/') + 15));
      const mathReady = await evaluate(article.client, `document.documentElement.getAttribute('data-math')`);
      check('文章页请求代码高亮与公式库', short.some((item) => /highlight\.min\.js$/.test(item)) && short.some((item) => /katex\.min\.js$/.test(item)), short.join(' '));
      check('公式渲染完成后标记状态', mathReady === 'rendered', String(mathReady));
      await closePage(article);

      const list = await openPage(browser, 'about:blank');
      await list.client.send('Network.enable');
      const listNet = watchNetwork(list);
      watchErrors(list, 'posts.html(按需)');
      await navigate(list.client, site.origin + '/pages/posts.html');
      await sleep(1000);
      const vendorList = listNet.urls.filter((url) => url.indexOf('/assets/vendor/') !== -1);
      check('列表页不请求第三方渲染库', vendorList.length === 0, vendorList.join(' '));
      await closePage(list);
    } finally {
      site.server.close();
    }
  }

  /* 六、HTTP 托管：域名根与项目子目录 */
  for (const prefix of ['', '/Qi-blog-ds/']) {
    const site = await startServer(ROOT, prefix);
    const title = prefix ? '项目子目录' : '域名根';
    const failures = [];
    const outside = [];
    const sheets = [];
    const init = [];
    try {
      for (const file of PAGES) {
        const page = await openPage(browser, 'about:blank');
        await page.client.send('Network.enable');
        const net = watchNetwork(page);
        watchErrors(page, prefix + file);
        await navigate(page.client, site.origin + '/' + file);
        await sleep(320);
        const info = await evaluate(page.client, `(() => {
          const origin = ${JSON.stringify(site.origin)};
          const refs = Array.from(document.querySelectorAll('script[src], link[href], img[src]'))
            .map((el) => el.src || el.href)
            .filter((url) => url.indexOf('data:') !== 0 && url.indexOf('blob:') !== 0);
          return {
            cap: document.documentElement.getAttribute('data-cap'),
            title: document.title,
            sheets: Array.from(document.styleSheets).map((sheet) => {
              try {
                return sheet.cssRules.length;
              } catch (error) {
                return -1;
              }
            }),
            outside: refs.filter((url) => url.indexOf(origin) !== 0)
          };
        })()`);
        if (net.failures.length) {
          failures.push(file + ' ' + net.failures.join(' '));
        }
        if (info.outside.length) {
          outside.push(file + ' ' + info.outside.join(' '));
        }
        if (info.sheets.some((count) => count < 0)) {
          sheets.push(file + ' 样式表不可读');
        } else if (!INLINE_ONLY.includes(file) && info.sheets.length < 2) {
          sheets.push(file + ' 样式表数量为 ' + info.sheets.length);
        }
        if (!INLINE_ONLY.includes(file) && (info.cap === null || !info.title)) {
          init.push(file + ' cap=' + info.cap + ' title=' + info.title);
        }
        await closePage(page);
      }
    } finally {
      site.server.close();
    }
    check(title + '：九个页面无资源加载失败', failures.length === 0, failures.join(' | ').slice(0, 300));
    check(title + '：页面引用全部落在站点前缀内', outside.length === 0, outside.join(' | ').slice(0, 300));
    check(title + '：样式表加载可读', sheets.length === 0, sheets.join(' | ').slice(0, 300));
    check(title + '：页面脚本完成初始化', init.length === 0, init.join(' | ').slice(0, 300));
  }

  check('页面脚本错误为空', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 400));
} catch (error) {
  check('核对过程异常', false, String(error && error.stack ? error.stack : error));
} finally {
  await shutdown(browser);
}

const failed = results.filter((item) => !item.ok);
console.log('');
console.log('内核：' + browserName());
console.log('核对完成：共 ' + results.length + ' 项，失败 ' + failed.length + ' 项。');
process.exit(failed.length ? 1 : 0);
