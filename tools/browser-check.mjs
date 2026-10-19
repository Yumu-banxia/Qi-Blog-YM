#!/usr/bin/env node
/* 浏览器核对
 * 以无头 Chromium 打开本地文件，核对布局、结构、交互与访问端分档。
 * 需要在 Node 22 以上运行；浏览器缺失时脚本直接报错退出，不做静默跳过。
 *
 * 用法：
 *   node tools/browser-check.mjs            全部核对
 *   node tools/browser-check.mjs --layout   只做布局与结构核对
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, shutdown, openPage, navigate, evaluate, setViewport, setReducedMotion, setUserAgent, closePage, fileUrl, sleep } from './cdp.mjs';
import { startServer } from './static-server.mjs';

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
      await setViewport(page.client, 1440, 900);
      await page.client.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `(() => {
          const nativeMatchMedia = window.matchMedia.bind(window);
          const queries = new Map();
          window.matchMedia = (query) => {
            const key = String(query);
            if (!queries.has(key)) {
              queries.set(key, nativeMatchMedia(key));
            }
            return queries.get(key);
          };
        })();`
      });
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
      const resumedMotion = await evaluate(page.client, `({
        reduced: window.Capability.reducedMotion,
        attribute: document.documentElement.getAttribute('data-motion')
      })`);
      check('偏好恢复后节点继续漂浮且状态同步', first !== second && resumedMotion.reduced === false && resumedMotion.attribute === null,
        JSON.stringify({ first, second, resumedMotion }));

      await evaluate(page.client, `(() => {
        document.documentElement.style.scrollBehavior = 'auto';
        window.scrollTo(0, document.body.scrollHeight);
      })()`);
      await sleep(350);
      const offscreenStart = await evaluate(page.client, `document.querySelector('.chart-node').style.transform`);
      await evaluate(page.client, `(() => {
        window.__hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
        Object.defineProperty(document, 'hidden', {
          configurable: true,
          get: () => Boolean(window.__testDocumentHidden)
        });
        window.__testDocumentHidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        window.__testDocumentHidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
      })()`);
      await sleep(350);
      const offscreenAfterVisibility = await evaluate(page.client, `document.querySelector('.chart-node').style.transform`);

      await evaluate(page.client, `(() => {
        window.__testDocumentHidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        window.scrollTo(0, 0);
      })()`);
      await sleep(350);
      const hiddenOnscreen = await evaluate(page.client, `document.querySelector('.chart-node').style.transform`);
      await evaluate(page.client, `(() => {
        window.__testDocumentHidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
      })()`);
      await sleep(350);
      const visibleOnscreen = await evaluate(page.client, `(() => {
        const descriptor = window.__hiddenDescriptor;
        if (descriptor) {
          Object.defineProperty(document, 'hidden', descriptor);
        } else {
          delete document.hidden;
        }
        delete window.__hiddenDescriptor;
        delete window.__testDocumentHidden;
        return document.querySelector('.chart-node').style.transform;
      })()`);
      const pauseStates = {
        offscreenStayedPaused: offscreenStart === offscreenAfterVisibility,
        hiddenStayedPaused: offscreenAfterVisibility === hiddenOnscreen,
        visibleResumed: hiddenOnscreen !== visibleOnscreen
      };
      check('星图同时遵守页面可见与视口可见状态', pauseStates.offscreenStayedPaused && pauseStates.hiddenStayedPaused && pauseStates.visibleResumed, JSON.stringify(pauseStates));

      await setReducedMotion(page.client, 'reduce');
      await sleep(400);
      const stopped = await evaluate(page.client, `(() => {
        const paths = Array.from(document.querySelectorAll('.chart-lines path'));
        return {
          withD: paths.filter((p) => (p.getAttribute('d') || '').length > 0).length,
          node: document.querySelector('.chart-node').style.transform,
          reduced: window.Capability.reducedMotion,
          attribute: document.documentElement.getAttribute('data-motion')
        };
      })()`);
      check('切到减少动态效果后状态同步且位移归零', stopped.withD === 4 &&
        stopped.node.indexOf('translate3d(0px, 0px, 0px)') !== -1 && stopped.reduced === true &&
        stopped.attribute === 'reduced', JSON.stringify(stopped));
      await closePage(page);
    }

    /* 三、作品灯箱 */
    {
      const page = await openPage(browser, 'about:blank');
      watch(page, 'works.html(灯箱)');
      await setViewport(page.client, 360, 800);
      await navigate(page.client, fileUrl(ROOT + '/pages/works.html'));
      await sleep(400);
      const opened = await evaluate(page.client, `(() => {
        document.querySelector('.shot-open').click();
        return {
          hidden: document.getElementById('lightbox').hidden,
          overflow: document.body.style.overflow,
          headerInert: document.querySelector('.site-header').inert === true,
          closeFocused: /lightbox-close/.test(document.activeElement.className),
          imageLoaded: document.querySelector('.lightbox-image').naturalWidth > 0
        };
      })()`);
      check('灯箱打开后锁定滚动并限制背景访问', opened.hidden === false && opened.overflow === 'hidden' && opened.headerInert === true && opened.closeFocused === true && opened.imageLoaded === true, JSON.stringify(opened));

      const mobileLayout = await evaluate(page.client, `(() => {
        const box = document.getElementById('lightbox');
        const toolbar = box.querySelector('.lightbox-toolbar').getBoundingClientRect();
        const stage = box.querySelector('.lightbox-stage').getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          toolbarInside: toolbar.left >= 0 && toolbar.right <= document.documentElement.clientWidth,
          stageVisible: stage.width > 0 && stage.height > 0
        };
      })()`);
      check('窄屏图片浏览工具栏完整显示', mobileLayout.overflow === 0 && mobileLayout.toolbarInside === true && mobileLayout.stageVisible === true, JSON.stringify(mobileLayout));

      const zoom = await evaluate(page.client, `(() => {
        const frame = document.querySelector('.lightbox-frame');
        const fitWidth = parseFloat(frame.style.width);
        document.getElementById('lightbox-zoom-in').click();
        const enlargedWidth = parseFloat(frame.style.width);
        document.getElementById('lightbox-actual').click();
        const actualWidth = parseFloat(frame.style.width);
        document.getElementById('lightbox-fit').click();
        return {
          fitWidth,
          enlargedWidth,
          actualWidth,
          naturalWidth: document.querySelector('.lightbox-image').naturalWidth,
          fitLabel: document.getElementById('lightbox-zoom-level').textContent
        };
      })()`);
      check('图片缩放、原始大小与适合窗口正常', zoom.enlargedWidth > zoom.fitWidth && zoom.actualWidth === zoom.naturalWidth && zoom.fitLabel === '适合窗口', JSON.stringify(zoom));

      const wheelZoom = await evaluate(page.client, `(() => {
        const stage = document.getElementById('lightbox-stage');
        const frame = document.querySelector('.lightbox-frame');
        const before = parseFloat(frame.style.width);
        const rect = stage.getBoundingClientRect();
        const event = new WheelEvent('wheel', {
          deltaY: -120,
          clientX: rect.left + rect.width * 0.35,
          clientY: rect.top + rect.height * 0.4,
          bubbles: true,
          cancelable: true
        });
        stage.dispatchEvent(event);
        return {
          before,
          after: parseFloat(frame.style.width),
          prevented: event.defaultPrevented,
          zoomLabel: document.getElementById('lightbox-zoom-level').textContent,
          panable: stage.getAttribute('data-panable')
        };
      })()`);
      check('滚轮以指针位置缩放图片', wheelZoom.after > wheelZoom.before && wheelZoom.prevented && wheelZoom.zoomLabel !== '适合窗口', JSON.stringify(wheelZoom));

      const drag = await evaluate(page.client, `(() => {
        document.getElementById('lightbox-actual').click();
        const stage = document.getElementById('lightbox-stage');
        const rect = stage.getBoundingClientRect();
        const before = { x: stage.scrollLeft, y: stage.scrollTop };
        const down = new PointerEvent('pointerdown', {
          pointerId: 71, pointerType: 'mouse', isPrimary: true, button: 0,
          clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
          bubbles: true, cancelable: true
        });
        stage.dispatchEvent(down);
        window.dispatchEvent(new PointerEvent('pointermove', {
          pointerId: 71, pointerType: 'mouse', isPrimary: true, button: -1,
          clientX: rect.left + rect.width / 2 - 32, clientY: rect.top + rect.height / 2 - 32,
          bubbles: true, cancelable: true
        }));
        const after = { x: stage.scrollLeft, y: stage.scrollTop };
        window.dispatchEvent(new PointerEvent('pointerup', {
          pointerId: 71, pointerType: 'mouse', isPrimary: true, button: 0,
          bubbles: true, cancelable: true
        }));
        return {
          panable: stage.getAttribute('data-panable'),
          moved: after.x > before.x || after.y > before.y,
          startPrevented: down.defaultPrevented,
          draggingCleared: !stage.hasAttribute('data-dragging')
        };
      })()`);
      check('按住鼠标拖动平移放大的图片', drag.panable === 'true' && drag.moved && drag.startPrevented && drag.draggingCleared, JSON.stringify(drag));

      const navigation = await evaluate(page.client, `(() => {
        document.getElementById('lightbox-next').click();
        const second = document.getElementById('lightbox-count').textContent;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        const third = document.getElementById('lightbox-count').textContent;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        const fourth = document.getElementById('lightbox-count').textContent;
        const nextDisabled = document.getElementById('lightbox-next').disabled;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
        return { second, third, fourth, nextDisabled, backToThird: document.getElementById('lightbox-count').textContent };
      })()`);
      check('图片按钮与方向键切换顺序正常', navigation.second === '2 / 4' && navigation.third === '3 / 4' && navigation.fourth === '4 / 4' && navigation.nextDisabled === true && navigation.backToThird === '3 / 4', JSON.stringify(navigation));

      await evaluate(page.client, `(() => {
        Object.defineProperty(window, 'ClipboardItem', {
          configurable: true,
          value: function (items) { this.items = items; }
        });
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { write: (items) => { window.__copiedImage = items; return Promise.resolve(); } }
        });
        document.getElementById('lightbox-copy').click();
      })()`);
      await sleep(150);
      const copied = await evaluate(page.client, `(() => ({
        status: document.getElementById('lightbox-status').textContent,
        type: window.__copiedImage && window.__copiedImage[0] && Object.keys(window.__copiedImage[0].items)[0],
        download: document.getElementById('lightbox-download').download
      }))()`);
      check('复制图片并保留原图下载', copied.status === '图片已复制到剪贴板。' && copied.type === 'image/png' && copied.download.length > 0, JSON.stringify(copied));

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

    /* 四、代码复制与框内滚动 */
    {
      const page = await openPage(browser, 'about:blank');
      watch(page, 'post-reader.html(代码块)');
      await setViewport(page.client, 1440, 900);
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

      await navigate(page.client, fileUrl(ROOT + '/pages/post-capability.html'));
      await sleep(900);

      const codeWindow = await evaluate(page.client, `(() => {
        const toggle = document.querySelector('.code-block[data-folded] .code-action[aria-expanded]');
        if (!toggle) {
          return { found: false };
        }
        const wrapper = toggle.closest('.code-block');
        const pre = wrapper.querySelector('pre');
        toggle.click();
        document.documentElement.style.scrollBehavior = 'auto';
        pre.scrollIntoView({ block: 'center' });
        pre.scrollTop = 0;
        const style = getComputedStyle(pre);
        return {
          found: true,
          expanded: toggle.getAttribute('aria-expanded'),
          folded: wrapper.getAttribute('data-folded'),
          clientHeight: pre.clientHeight,
          scrollHeight: pre.scrollHeight,
          overflowY: style.overflowY
        };
      })()`);
      check('长代码块展开后形成独立纵向滚动窗口',
        codeWindow.found === true && codeWindow.expanded === 'true' && codeWindow.folded === 'false' &&
          codeWindow.overflowY === 'auto' && codeWindow.scrollHeight > codeWindow.clientHeight,
        JSON.stringify(codeWindow));

      await sleep(150);
      const beforeWheel = await evaluate(page.client, `(() => {
        const pre = document.querySelector('.code-block[data-folded="false"] pre');
        const rect = pre.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          pageY: window.scrollY,
          scrollTop: pre.scrollTop,
          maxScroll: pre.scrollHeight - pre.clientHeight
        };
      })()`);
      await page.client.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: beforeWheel.x, y: beforeWheel.y, deltaX: 0, deltaY: 320
      });
      await sleep(250);
      const afterWheel = await evaluate(page.client, `(() => {
        const pre = document.querySelector('.code-block[data-folded="false"] pre');
        return { pageY: window.scrollY, scrollTop: pre.scrollTop };
      })()`);
      check('代码框内滚轮只滚动代码',
        beforeWheel.maxScroll > 1 && afterWheel.scrollTop > beforeWheel.scrollTop &&
          Math.abs(afterWheel.pageY - beforeWheel.pageY) < 1,
        JSON.stringify({ before: beforeWheel, after: afterWheel }));

      const endWheel = await evaluate(page.client, `(() => {
        const pre = document.querySelector('.code-block[data-folded="false"] pre');
        pre.scrollTop = pre.scrollHeight;
        const rect = pre.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          pageY: window.scrollY,
          maxScroll: pre.scrollHeight - pre.clientHeight
        };
      })()`);
      await page.client.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: endWheel.x, y: endWheel.y, deltaX: 0, deltaY: 480
      });
      await sleep(250);
      const endState = await evaluate(page.client, `(() => {
        const pre = document.querySelector('.code-block[data-folded="false"] pre');
        return { pageY: window.scrollY, scrollTop: pre.scrollTop, maxScroll: pre.scrollHeight - pre.clientHeight };
      })()`);
      check('代码滚到末尾后页面位置保持不变',
        endState.maxScroll > 1 && endState.scrollTop >= endState.maxScroll - 1 &&
          Math.abs(endState.pageY - endWheel.pageY) < 1,
        JSON.stringify({ before: endWheel, after: endState }));
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
      await setViewport(page.client, 1440, 900);
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
        const project = await startServer(ROOT, '/Qi-Blog-YM/');
        const root = await startServer(ROOT, '');
      try {
        const page = await openPage(browser, 'about:blank');
        watch(page, '404.html(前缀)');
        await navigate(page.client, 'http://127.0.0.1:' + project.port + '/Qi-Blog-YM/pages/missing');
        await sleep(900);
        const hrefs = await evaluate(page.client, `Array.from(document.querySelectorAll('a[data-site-link]')).map((a) => a.getAttribute('href'))`);
        check('项目子目录下的未知地址链接指向站点根', hrefs.length > 0 && hrefs.every((h) => h.indexOf('/Qi-Blog-YM/') === 0), hrefs[0] || '');

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
    /* 八、星图动效复核：指针吸引的方向与幅度、回位、独立漂浮、复位缓动与连线平滑 */
    {
      const page = await openPage(browser, 'about:blank');
      watch(page, 'index.html(星图)');
      await setViewport(page.client, 1440, 900);
      await navigate(page.client, fileUrl(ROOT + '/index.html'));
      await sleep(1200);

      const STATE = `(() => {
        const canvas = document.querySelector('.chart-canvas');
        const box = canvas.getBoundingClientRect();
        const raw = getComputedStyle(canvas).transform;
        const view = new DOMMatrix(raw === 'none' ? '' : raw);
        return {
          box: { left: box.left, top: box.top, width: box.width, height: box.height },
          view: { x: view.m41, y: view.m42, scale: view.m11 },
          paths: Array.from(document.querySelectorAll('.chart-lines path')).map((p) => p.getAttribute('d') || ''),
          nodes: Array.from(canvas.querySelectorAll('.chart-node')).map((el) => {
            const rect = el.getBoundingClientRect();
            const matrix = getComputedStyle(el).transform;
            const shape = new DOMMatrix(matrix === 'none' ? '' : matrix);
            /* 自身变换为 translate(-50%, -50%) translate3d(x, y)，矩阵平移量含元素半宽偏移，需还原为实际漂浮位移 */
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, ox: shape.m41 + rect.width / 2, oy: shape.m42 + rect.height / 2 };
          })
        };
      })()`;

      const move = (x, y) => page.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
      const press = (x, y, count) => page.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: count });
      const release = (x, y, count) => page.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: count });
      const dblclick = async (x, y) => {
        await press(x, y, 1);
        await release(x, y, 1);
        await press(x, y, 2);
        await release(x, y, 2);
      };
      const sample = async (times, gap) => {
        const list = [];
        for (let i = 0; i < times; i += 1) {
          await sleep(gap);
          list.push(await evaluate(page.client, STATE));
        }
        return list;
      };
      const round = (value) => Number(value.toFixed(2));
      const sizeOf = (node) => Math.hypot(node.ox, node.oy);
      const spread = (list, index) => Math.max.apply(null, list.map((item) => sizeOf(item.nodes[index])));
      const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      /* 逐段累计路径长度与单步最大值，用于判断位移是连续推进还是瞬间落位 */
      const progress = (points, threshold) => {
        let total = 0;
        let step = 0;
        let moved = 0;
        for (let i = 1; i < points.length; i += 1) {
          const gap = distance(points[i], points[i - 1]);
          total += gap;
          step = Math.max(step, gap);
          if (gap > (threshold || 0.5)) {
            moved += 1;
          }
        }
        return { total, step, moved };
      };
      const edgeOf = (d) => {
        const nums = d.replace('M', ' ').replace('C', ' ').trim().split(' ').filter((item) => item.length > 0).map(Number);
        return { a: [nums[0], nums[1]], c1: [nums[2], nums[3]], c2: [nums[4], nums[5]], b: [nums[6], nums[7]] };
      };
      const unit = (x, y) => {
        const length = Math.hypot(x, y) || 1;
        return [x / length, y / length];
      };
      /* 每个节点处，出边起点方向与入边到达方向应当一致，余弦越接近 1 曲线越平滑 */
      const tangents = (paths) => {
        const edges = paths.map(edgeOf);
        const cosines = [];
        for (let i = 0; i < edges.length; i += 1) {
          const out = edges[i];
          const incoming = edges[(i + edges.length - 1) % edges.length];
          const forward = unit(out.c1[0] - out.a[0], out.c1[1] - out.a[1]);
          const backward = unit(incoming.b[0] - incoming.c2[0], incoming.b[1] - incoming.c2[1]);
          cosines.push(forward[0] * backward[0] + forward[1] * backward[1]);
        }
        return cosines;
      };

      /* 指针远离画布，先取一段静置样本作为漂浮幅度基准 */
      await move(4, 4);
      const drifting = await sample(16, 250);
      const idle = drifting[drifting.length - 1];
      const baseline = [0, 1, 2, 3].map((i) => spread(drifting, i));
      const box = idle.box;
      const anchor = idle.nodes[1];
      let apart = 0;
      for (let i = 0; i < 4; i += 1) {
        for (let j = i + 1; j < 4; j += 1) {
          apart = Math.max(apart, Math.max.apply(null, drifting.map((item) => Math.abs(item.nodes[i].ox - item.nodes[j].ox) + Math.abs(item.nodes[i].oy - item.nodes[j].oy))));
        }
      }
      check('四个节点各自独立漂浮', baseline.every((value) => value >= 0.5) && apart > 0.4,
        '静置位移 ' + baseline.map(round).join('、') + ' 像素，节点间最大差值 ' + round(apart));

      const pointer = {
        x: Math.max(box.left + 24, anchor.x - 110),
        y: Math.min(box.top + box.height - 24, Math.max(box.top + 24, anchor.y + 30))
      };
      await move(pointer.x, pointer.y);
      const pulled = await sample(14, 170);
      const offsets = pulled.map((item) => item.nodes[1]);
      const near = offsets.filter((node) => sizeOf(node) >= 3);
      const toward = near.filter((node) => {
        const dx = pointer.x - node.x;
        const dy = pointer.y - node.y;
        return (node.ox * dx + node.oy * dy) / (sizeOf(node) * Math.hypot(dx, dy)) > 0;
      });
      const peak = Math.max.apply(null, offsets.map(sizeOf));
      check('指针靠近时节点朝指针方向偏移', near.length >= 4 && toward.length >= Math.ceil(near.length * 0.75),
        '有效样本 ' + near.length + ' 个，朝向指针 ' + toward.length + ' 个');
      check('指针吸引幅度保持轻微', peak >= baseline[1] + 4 && peak <= 40,
        '最大偏移 ' + round(peak) + ' 像素，静置基准 ' + round(baseline[1]) + ' 像素');

      /* 指针移开后不再保留指针方向的偏移：先等弹力把牵引造成的位移衰减掉，再取长窗口的平均偏移向量。
         节点自主漂浮属于往复运动，其长时间均值接近零；若节点被指针偏移锁定，沿指针方向的均值会保持数十像素。 */
      await move(4, 4);
      await sleep(3000);
      const released = await sample(100, 250);
      const dir = unit(pointer.x - anchor.x, pointer.y - anchor.y);
      const average = (list) => {
        const sum = list.reduce((acc, node) => ({ ox: acc.ox + node.ox, oy: acc.oy + node.oy }), { ox: 0, oy: 0 });
        return { ox: sum.ox / list.length, oy: sum.oy / list.length };
      };
      const heldMean = average(pulled.map((item) => item.nodes[1]).slice(-6));
      const freeMean = average(released.map((item) => item.nodes[1]));
      const residual = freeMean.ox * dir[0] + freeMean.oy * dir[1];
      const heldSize = sizeOf(heldMean);
      check('指针移开后节点不再保持指针方向的偏移',
        Math.abs(residual) <= Math.max(4, heldSize * 0.3) && sizeOf(freeMean) <= Math.max(8, heldSize * 0.5),
        '指针方向残余 ' + round(residual) + ' 像素，平均偏移 ' + round(sizeOf(freeMean)) + ' 像素，停留时偏移 ' + round(heldSize) + ' 像素');

      /* 拖动节点：不选中文字、不触发拖拽事件、不误触链接 */
      await evaluate(page.client, `window.__qiDragstart = 0; document.addEventListener('dragstart', () => { window.__qiDragstart += 1; });`);
      const moving = (await evaluate(page.client, STATE)).nodes[2];
      await move(moving.x, moving.y);
      await press(moving.x, moving.y, 1);
      for (let i = 1; i <= 6; i += 1) {
        await move(moving.x + i * 15, moving.y + i * 7);
        await sleep(60);
      }
      await release(moving.x + 90, moving.y + 42, 1);
      await sleep(400);
      const dragged = await evaluate(page.client, `({ selection: String(window.getSelection()), dragstart: window.__qiDragstart, page: location.pathname.split('/').pop() })`);
      check('拖动节点不选中文字且不误触链接', dragged.selection.length === 0 && dragged.dragstart === 0 && dragged.page === 'index.html',
        JSON.stringify(dragged));

      const spot = { x: box.left + box.width * 0.5, y: box.top + box.height * 0.58 };
      await dblclick(spot.x, spot.y);
      const trail = (await sample(20, 70)).map((item) => item.nodes[2]);
      const nodeMotion = progress(trail);
      const last = trail[trail.length - 1];
      check('双击复位过程中位移逐步收敛', nodeMotion.total > 20 && nodeMotion.step <= nodeMotion.total * 0.6 && nodeMotion.moved >= 4,
        '累计位移 ' + round(nodeMotion.total) + ' 像素，单步最大 ' + round(nodeMotion.step) + ' 像素，有效步数 ' + nodeMotion.moved);
      check('双击复位后节点回到拖动前位置', distance(last, moving) <= 40, '相距 ' + round(distance(last, moving)) + ' 像素');

      await page.client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: spot.x, y: spot.y, deltaX: 0, deltaY: -240 });
      await sleep(200);
      const zoomed = await evaluate(page.client, STATE);
      await dblclick(spot.x, spot.y);
      const viewTrail = (await sample(16, 70)).map((item) => item.view);
      const viewMotion = progress(viewTrail.map((item) => ({ x: item.scale, y: 0 })), 0.002);
      const endpoint = viewTrail[viewTrail.length - 1];
      check('双击复位视图过程中缩放逐步还原', zoomed.view.scale > 1.05 && viewMotion.moved >= 3 && viewMotion.step <= viewMotion.total * 0.6,
        '起始比例 ' + round(zoomed.view.scale) + '，单步最大 ' + round(viewMotion.step) + '，有效步数 ' + viewMotion.moved);
      check('双击复位后视图回到初始变换', Math.abs(endpoint.scale - 1) < 0.01 && Math.abs(endpoint.x) < 1 && Math.abs(endpoint.y) < 1,
        JSON.stringify({ scale: round(endpoint.scale), x: round(endpoint.x), y: round(endpoint.y) }));

      const straight = tangents((await evaluate(page.client, STATE)).paths);
      check('节点未移动时连线在节点处切线连续', straight.every((cos) => cos > 0.99),
        '余弦 ' + straight.map((cos) => cos.toFixed(4)).join(' '));

      /* 把作品节点拖到关于节点近旁形成交叉布局，切线仍应连续 */
      const cross = (await evaluate(page.client, STATE)).nodes[3];
      await move(moving.x, moving.y);
      await press(moving.x, moving.y, 1);
      for (let i = 1; i <= 5; i += 1) {
        await move(moving.x + (cross.x - moving.x) * i / 5, moving.y + (cross.y - moving.y) * i / 5);
        await sleep(60);
      }
      await release(cross.x, cross.y, 1);
      await sleep(500);
      const crossed = await evaluate(page.client, STATE);
      const crossedCos = tangents(crossed.paths);
      check('交叉布局下连线切线保持连续', crossedCos.every((cos) => cos > 0.99) && crossed.paths.every((d) => d.indexOf('NaN') === -1),
        '余弦 ' + crossedCos.map((cos) => cos.toFixed(4)).join(' '));

      await move(4, 4);
      await dblclick(spot.x, spot.y);
      await sleep(600);
      await closePage(page);
    }

    /* 九、跳转衔接与页面预取 */
    {
      const local = await openPage(browser, 'about:blank');
      watch(local, 'index.html(本地文件)');
      await navigate(local.client, fileUrl(ROOT + '/index.html'));
      await sleep(800);
      const localRules = await evaluate(local.client, `document.querySelectorAll('script[type="speculationrules"]').length`);
      check('本地文件打开时不注册页面预取', localRules === 0, '规则节点 ' + localRules);
      await closePage(local);

      const hosted = await startServer(ROOT, '');
      try {
        const page = await openPage(browser, 'about:blank');
        watch(page, 'index.html(静态托管)');
        await navigate(page.client, 'http://127.0.0.1:' + hosted.port + '/index.html');
        await sleep(800);

        const prefetch = await evaluate(page.client, `(() => {
          const node = document.querySelector('script[type="speculationrules"]');
          let parsed = null;
          try {
            parsed = JSON.parse(node ? node.textContent : '');
          } catch (error) {
            parsed = null;
          }
          const rule = parsed && Array.isArray(parsed.prefetch) ? parsed.prefetch[0] : null;
          const where = rule && rule.where && Array.isArray(rule.where.and) ? rule.where.and : [];
          return {
            present: Boolean(node),
            source: rule ? rule.source : '',
            eagerness: rule ? rule.eagerness : '',
            include: where.length ? where[0].href_matches || '' : '',
            excludeAsset: where.length > 1 && Boolean(where[1].not && where[1].not.href_matches),
            tier: window.Capability.tier
          };
        })()`);
        check('静态托管下注册页面预取规则',
          prefetch.present && prefetch.source === 'document' && prefetch.eagerness === 'moderate' && prefetch.include === '/*' && prefetch.excludeAsset,
          JSON.stringify(prefetch));

        const naming = await evaluate(page.client, `(() => {
          const name = (selector) => getComputedStyle(document.querySelector(selector)).getPropertyValue('view-transition-name').trim();
          let declared = false;
          for (const sheet of document.styleSheets) {
            let rules = [];
            try {
              rules = Array.from(sheet.cssRules);
            } catch (error) {
              continue;
            }
            if (rules.some((item) => (item.cssText || '').indexOf('@view-transition') !== -1)) {
              declared = true;
            }
          }
          return { header: name('.site-header'), footer: name('.site-footer'), declared };
        })()`);
        check('页头页脚声明同名过渡组', naming.declared === true && naming.header === 'site-header' && naming.footer === 'site-footer', JSON.stringify(naming));

        await setReducedMotion(page.client, 'reduce');
        await sleep(250);
        const reduced = await evaluate(page.client, `(() => {
          const name = (selector) => getComputedStyle(document.querySelector(selector)).getPropertyValue('view-transition-name').trim();
          return { header: name('.site-header'), footer: name('.site-footer') };
        })()`);
        check('减少动态效果时撤下过渡组命名', (reduced.header === 'none' || reduced.header === '') && (reduced.footer === 'none' || reduced.footer === ''), JSON.stringify(reduced));
        await setReducedMotion(page.client, 'no-preference');
        await closePage(page);

        const leaving = await openPage(browser, 'about:blank');
        watch(leaving, 'index.html(省流模式)');
        await leaving.client.send('Page.addScriptToEvaluateOnNewDocument', {
          source: 'Object.defineProperty(navigator, "connection", { configurable: true, get: function () { return { saveData: true, effectiveType: "4g" }; } });'
        });
        await navigate(leaving.client, 'http://127.0.0.1:' + hosted.port + '/index.html');
        await sleep(800);
        const saving = await evaluate(leaving.client, `({
          tier: window.Capability.tier,
          reason: window.Capability.reason,
          saveData: window.Capability.saveData,
          rules: document.querySelectorAll('script[type="speculationrules"]').length
        })`);
        check('省流模式下降档且不注册页面预取', saving.saveData === true && saving.tier === 'low' && saving.reason === 'network' && saving.rules === 0, JSON.stringify(saving));
        await closePage(leaving);

        const legacy = await openPage(browser, 'about:blank');
        watch(legacy, 'index.html(功能机静态托管)');
        await setUserAgent(legacy.client, 'Nokia2700c/09.80 Profile/MIDP-2.1 Configuration/CLDC-1.1');
        await navigate(legacy.client, 'http://127.0.0.1:' + hosted.port + '/index.html');
        await sleep(800);
        const lowest = await evaluate(legacy.client, `({
          tier: window.Capability.tier,
          rules: document.querySelectorAll('script[type="speculationrules"]').length
        })`);
        check('最低档位不注册页面预取', lowest.tier === 'minimal' && lowest.rules === 0, JSON.stringify(lowest));
        await closePage(legacy);
      } finally {
        hosted.server.close();
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
