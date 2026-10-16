/* 站内搜索
 * 索引由 assets/data/search-index.js 提供，首次打开面板时按需加载。
 * 匹配标题、标签、摘要与正文，命中片段以高亮呈现；结果可用方向键选择、回车进入。
 * 打开方式：导航栏按钮、斜杠键或 Ctrl+K；关闭方式：Esc、关闭按钮或点击遮罩。
 */
(function () {
  'use strict';

  var panel = document.getElementById('search-panel');
  var toggle = document.querySelector('.search-toggle');
  if (!panel || !toggle) {
    return;
  }

  var input = panel.querySelector('.search-input');
  var list = panel.querySelector('.search-results');
  var status = panel.querySelector('.search-status');
  var dismiss = panel.querySelector('.search-dismiss');
  if (!input || !list || !status) {
    return;
  }

  var controller = typeof window.AbortController === 'function' ? new window.AbortController() : null;

  function listen(target, type, handler, options) {
    var settings = options;
    if (controller) {
      if (typeof settings === 'boolean') {
        settings = { capture: settings, signal: controller.signal };
      } else {
        settings = settings || {};
        settings.signal = controller.signal;
      }
    }
    target.addEventListener(type, handler, settings);
  }

  function resolveBase() {
    var current = document.currentScript;
    var scripts = document.getElementsByTagName('script');
    var source = (current && current.src) ? current.src : (scripts.length ? scripts[scripts.length - 1].src : '');
    var match = /^(.*)assets\/scripts\/search\.js/.exec(source);
    if (match) {
      return match[1];
    }
    var doc = document.baseURI || '';
    return doc.indexOf('/pages/') !== -1 ? doc.replace(/pages\/[^/]*$/, '') : doc.replace(/[^/]*$/, '');
  }

  var base = resolveBase();
  var inPages = (document.baseURI || '').indexOf('/pages/') !== -1;
  var entries = null;
  var indexState = 'idle'; /* idle | loading | ready | failed */
  var pendingReady = null;
  var active = -1;
  var currentResults = [];
  var lastFocus = null;

  function settlePending() {
    var ready = pendingReady;
    pendingReady = null;
    if (typeof ready === 'function') {
      ready();
    }
  }

  function loadIndex(onReady) {
    if (indexState === 'ready') {
      if (typeof onReady === 'function') {
        onReady();
      }
      return;
    }
    if (indexState === 'loading') {
      pendingReady = onReady;
      return;
    }

    indexState = 'loading';
    pendingReady = onReady;

    var script = document.createElement('script');
    script.src = base + 'assets/data/search-index.js';
    script.async = true;
    script.onload = function () {
      var raw = window.SearchIndex || [];
      entries = raw.map(function (item) {
        return {
          title: item.title || '',
          url: inPages ? item.file : 'pages/' + item.file,
          date: item.date || '',
          tags: item.tags || [],
          summary: item.summary || '',
          body: item.body || ''
        };
      });
      indexState = 'ready';
      settlePending();
    };
    script.onerror = function () {
      /* 请求失败：回到可重试状态，重新打开面板或再次输入时重新请求 */
      indexState = 'failed';
      pendingReady = null;
      if (script.parentNode) {
        script.parentNode.removeChild(script);
      }
      status.textContent = '索引加载失败，重新打开搜索可再试一次';
    };
    document.head.appendChild(script);
  }

  function search(query) {
    var text = String(query || '').replace(/^\s+|\s+$/g, '').toLowerCase();
    if (!text) {
      return [];
    }

    var terms = text.split(/\s+/);
    var hits = [];

    for (var i = 0; i < entries.length; i += 1) {
      var item = entries[i];
      var score = 0;
      var snippet = '';
      var matched = true;
      var termIndex;

      for (termIndex = 0; termIndex < terms.length; termIndex += 1) {
        var term = terms[termIndex];
        var found = false;

        if (item.title.toLowerCase().indexOf(term) !== -1) {
          score += 6;
          found = true;
        }
        if (item.tags.join(' ').toLowerCase().indexOf(term) !== -1) {
          score += 4;
          found = true;
        }
        if (item.summary.toLowerCase().indexOf(term) !== -1) {
          score += 2;
          found = true;
        }

        var position = item.body.toLowerCase().indexOf(term);
        if (position !== -1) {
          score += 1;
          found = true;
          if (!snippet) {
            var start = Math.max(0, position - 16);
            var end = Math.min(item.body.length, position + term.length + 26);
            snippet = (start > 0 ? '…' : '') + item.body.slice(start, end) + (end < item.body.length ? '…' : '');
          }
        }

        if (!found) {
          matched = false;
          break;
        }
      }

      if (matched && score > 0) {
        hits.push({ item: item, score: score, snippet: snippet || item.summary, terms: terms });
      }
    }

    hits.sort(function (a, b) {
      return b.score - a.score;
    });
    return hits.slice(0, 8);
  }

  /* 命中词以 mark 标注，文本本身按节点写入，不拼接 HTML */
  function appendHighlighted(host, text, terms) {
    var lower = text.toLowerCase();
    var cursor = 0;
    var found = false;

    while (cursor < text.length) {
      var bestIndex = -1;
      var bestTerm = '';

      for (var i = 0; i < terms.length; i += 1) {
        var index = lower.indexOf(terms[i], cursor);
        if (index !== -1 && (bestIndex === -1 || index < bestIndex)) {
          bestIndex = index;
          bestTerm = terms[i];
        }
      }

      if (bestIndex === -1) {
        break;
      }

      if (bestIndex > cursor) {
        host.appendChild(document.createTextNode(text.slice(cursor, bestIndex)));
      }
      var mark = document.createElement('mark');
      mark.textContent = text.slice(bestIndex, bestIndex + bestTerm.length);
      host.appendChild(mark);
      cursor = bestIndex + bestTerm.length;
      found = true;
    }

    if (!found) {
      host.textContent = text;
      return;
    }
    if (cursor < text.length) {
      host.appendChild(document.createTextNode(text.slice(cursor)));
    }
  }

  function setActive(index) {
    var links = list.querySelectorAll('.search-result');
    if (!links.length) {
      active = -1;
      return;
    }
    if (index < 0) {
      index = links.length - 1;
    }
    if (index >= links.length) {
      index = 0;
    }
    for (var i = 0; i < links.length; i += 1) {
      if (i === index) {
        links[i].setAttribute('aria-current', 'true');
      } else {
        links[i].removeAttribute('aria-current');
      }
    }
    active = index;
    if (links[index].scrollIntoView) {
      links[index].scrollIntoView({ block: 'nearest' });
    }
  }

  function render(results, query) {
    list.textContent = '';
    currentResults = results;
    active = -1;

    if (!String(query || '').replace(/^\s+|\s+$/g, '')) {
      status.textContent = '输入关键词，检索站内文章';
      return;
    }

    if (!results.length) {
      status.textContent = '没有匹配的文章';
      return;
    }

    status.textContent = '找到 ' + results.length + ' 篇';

    for (var i = 0; i < results.length; i += 1) {
      var result = results[i];
      var item = document.createElement('li');
      var link = document.createElement('a');
      link.className = 'search-result';
      link.href = result.item.url;

      var title = document.createElement('span');
      title.className = 'search-result-title';
      appendHighlighted(title, result.item.title, result.terms);

      var meta = document.createElement('span');
      meta.className = 'search-result-meta';
      meta.textContent = result.item.date + '　' + result.item.tags.join(' ');

      var text = document.createElement('span');
      text.className = 'search-result-text';
      appendHighlighted(text, result.snippet, result.terms);

      link.appendChild(title);
      link.appendChild(meta);
      link.appendChild(text);
      item.appendChild(link);
      list.appendChild(item);
    }

    setActive(0);
  }

  function update() {
    render(search(input.value), input.value);
  }

  function focusables() {
    return panel.querySelectorAll('a[href], button, input');
  }

  var supportsInert = typeof HTMLElement !== 'undefined' && 'inert' in HTMLElement.prototype;
  var scrollLock = null;

  /* 面板打开期间背景内容退出键盘访问，处理方式与作品灯箱一致：
     优先使用 inert，缺少支持时退回 aria-hidden */
  function setBackgroundHidden(hidden) {
    var nodes = document.body.children;
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (node === panel) {
        continue;
      }
      if (supportsInert) {
        node.inert = hidden;
      } else if (hidden) {
        node.setAttribute('aria-hidden', 'true');
      } else {
        node.removeAttribute('aria-hidden');
      }
    }
  }

  function lockScroll() {
    var body = document.body;
    var gap = window.innerWidth - document.documentElement.clientWidth;
    scrollLock = {
      overflow: body.style.overflow,
      paddingRight: body.style.paddingRight
    };
    body.style.overflow = 'hidden';
    if (gap > 0) {
      body.style.paddingRight = gap + 'px';
    }
  }

  function unlockScroll() {
    if (!scrollLock) {
      return;
    }
    document.body.style.overflow = scrollLock.overflow;
    document.body.style.paddingRight = scrollLock.paddingRight;
    scrollLock = null;
  }

  function open() {
    if (!panel.hidden) {
      return;
    }
    lastFocus = document.activeElement;
    panel.hidden = false;
    setBackgroundHidden(true);
    lockScroll();
    toggle.setAttribute('aria-expanded', 'true');
    input.value = '';
    list.textContent = '';
    currentResults = [];
    active = -1;
    input.focus();

    if (indexState === 'ready') {
      render([], '');
      return;
    }

    if (indexState === 'failed') {
      /* 上次请求未成功，重新打开时重试 */
      indexState = 'idle';
    }

    status.textContent = '正在载入索引';
    loadIndex(function () {
      render([], '');
    });
  }

  function close() {
    if (panel.hidden) {
      return;
    }
    panel.hidden = true;
    setBackgroundHidden(false);
    unlockScroll();
    toggle.setAttribute('aria-expanded', 'false');
    var target = lastFocus && lastFocus !== document.body ? lastFocus : toggle;
    if (target && typeof target.focus === 'function') {
      target.focus();
    }
  }

  if (dismiss) {
    listen(dismiss, 'click', close);
  }

  listen(panel, 'click', function (event) {
    if (event.target === panel) {
      close();
    }
  });

  listen(input, 'input', function () {
    if (indexState === 'ready') {
      update();
      return;
    }

    if (indexState === 'failed') {
      indexState = 'idle';
      status.textContent = '正在载入索引';
      loadIndex(update);
      return;
    }

    if (indexState === 'loading') {
      /* 索引到达后按当前输入补一次检索 */
      pendingReady = update;
    }
  });

  listen(panel, 'keydown', function (event) {
    var key = event.key || '';

    if (key === 'Escape' || event.keyCode === 27) {
      event.preventDefault();
      close();
      return;
    }

    if (key === 'ArrowDown' || event.keyCode === 40) {
      event.preventDefault();
      setActive(active + 1);
      return;
    }

    if (key === 'ArrowUp' || event.keyCode === 38) {
      event.preventDefault();
      setActive(active - 1);
      return;
    }

    if (key === 'Enter' || event.keyCode === 13) {
      var links = list.querySelectorAll('.search-result');
      if (active >= 0 && links[active]) {
        event.preventDefault();
        links[active].click();
      }
      return;
    }

    if (key === 'Tab') {
      var items = focusables();
      if (!items.length) {
        return;
      }
      var first = items[0];
      var last = items[items.length - 1];
      /* 变量名避开外层记录选中项下标的 active */
      var focused = document.activeElement;
      if (event.shiftKey) {
        if (focused === first || !panel.contains(focused)) {
          event.preventDefault();
          last.focus();
        }
      } else if (focused === last || !panel.contains(focused)) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  /* 入口与快捷键由 main.js 引导，这里只暴露开关供其调用 */
  window.SiteSearch = {
    open: open,
    close: close,
    toggle: function () {
      if (panel.hidden) {
        open();
      } else {
        close();
      }
    }
  };
})();
