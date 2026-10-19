/* 文章页阅读增强
 * 提供阅读进度、目录、字号切换、返回顶部，以及代码块的复制、折叠与框内滚动。
 * 第三方渲染库按需加载：代码高亮用 highlight.js，公式用 KaTeX，
 * 两者都只在页面确实存在对应内容且设备档位允许时进入请求队列。
 */
(function () {
  'use strict';

  var Capability = window.Capability || null;
  var FOLD_MIN_LINES = 16;
  var READING_KEY = 'reading-size';

  if (Capability && Capability.tier === 'minimal') {
    return;
  }

  function scriptBase() {
    var current = document.currentScript;
    var scripts = document.getElementsByTagName('script');
    var source = (current && current.src) ? current.src : (scripts.length ? scripts[scripts.length - 1].src : '');
    var match = /^(.*)assets\/scripts\/reader\.js/.exec(source);
    return match ? match[1] : '';
  }

  var base = scriptBase();

  function allow(name) {
    return !Capability || Capability.allow(name);
  }

  function trim(value) {
    return String(value || '').replace(/^\s+|\s+$/g, '');
  }

  function loadStyle(href) {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
    return link;
  }

  function loadScript(src, onload) {
    var script = document.createElement('script');
    script.src = src;
    script.async = true;
    if (typeof onload === 'function') {
      script.onload = onload;
    }
    document.head.appendChild(script);
    return script;
  }

  /* 复制：优先使用异步剪贴板接口，拒绝或不可用时退回 execCommand。
     两条路径都以实际结果回调，调用方据此给出成功或失败反馈。 */
  function copyText(value, onDone, onFail) {
    function fallback() {
      var area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', 'readonly');
      area.setAttribute('aria-hidden', 'true');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      document.body.appendChild(area);
      area.select();

      var copied = false;
      try {
        copied = typeof document.execCommand === 'function' && document.execCommand('copy') === true;
      } catch (error) {
        copied = false;
      }

      document.body.removeChild(area);

      if (copied) {
        onDone();
      } else {
        onFail();
      }
    }

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(value).then(function () {
        onDone();
      }, fallback);
      return;
    }
    fallback();
  }

  /* 复制结果通过独立状态区播报，便于读屏软件获取反馈 */
  var liveRegion = null;

  function announce(message) {
    if (!liveRegion) {
      liveRegion = document.createElement('p');
      liveRegion.className = 'visually-hidden';
      liveRegion.setAttribute('role', 'status');
      liveRegion.setAttribute('aria-live', 'polite');
      document.body.appendChild(liveRegion);
    }
    liveRegion.textContent = message;
  }

  /* 代码块：语言标签、复制、超长折叠 */
  function countLines(text) {
    return String(text || '').replace(/\n$/, '').split('\n').length;
  }

  function enhanceBlock(pre) {
    var host = pre.parentNode;
    if (host && typeof host.className === 'string' && host.className.split(/\s+/).indexOf('code-block') !== -1) {
      return;
    }

    /* 代码块可独立滚动，需要能通过键盘到达 */
    if (!pre.getAttribute('tabindex')) {
      pre.setAttribute('tabindex', '0');
    }

    var code = pre.getElementsByTagName('code')[0] || null;
    var wrapper = document.createElement('div');
    wrapper.className = 'code-block';
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);

    var language = '';
    if (code) {
      var match = /(?:^|\s)language-([\w+#.-]+)/.exec(code.className || '');
      if (match) {
        language = match[1];
      }
    }

    var source = code ? code.textContent : pre.textContent;
    var lines = countLines(source);

    var bar = document.createElement('div');
    bar.className = 'code-toolbar';

    var label = document.createElement('span');
    label.className = 'code-lang';
    label.textContent = language || '代码';
    bar.appendChild(label);

    if (lines > FOLD_MIN_LINES) {
      var restLines = lines - FOLD_MIN_LINES;
      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'code-action';
      toggle.textContent = '展开剩余 ' + restLines + ' 行';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.addEventListener('click', function () {
        var folded = wrapper.getAttribute('data-folded') === 'true';
        wrapper.setAttribute('data-folded', folded ? 'false' : 'true');
        toggle.setAttribute('aria-expanded', folded ? 'true' : 'false');
        toggle.textContent = folded ? '收起' : '展开剩余 ' + restLines + ' 行';
        pre.scrollTop = 0;
      });
      wrapper.setAttribute('data-folded', 'true');
      bar.appendChild(toggle);
    }

    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'code-action';
    copy.textContent = '复制';
    copy.setAttribute('aria-label', '复制代码');
    var copyTimer = 0;

    /* 成功与失败使用同一套复位流程，连续点击时不叠加定时器 */
    function flashCopy(label, message) {
      copy.textContent = label;
      announce(message);
      if (copyTimer) {
        window.clearTimeout(copyTimer);
      }
      copyTimer = window.setTimeout(function () {
        copy.textContent = '复制';
        copyTimer = 0;
      }, 1800);
    }

    copy.addEventListener('click', function () {
      copyText(code ? code.textContent : pre.textContent, function () {
        flashCopy('已复制', '代码已复制到剪贴板');
      }, function () {
        flashCopy('复制失败', '复制失败，请手动选择代码后再复制');
      });
    });
    bar.appendChild(copy);

    wrapper.insertBefore(bar, pre);

  }

  function enhanceCodeBlocks() {
    var blocks = document.querySelectorAll('.prose pre');
    for (var i = 0; i < blocks.length; i += 1) {
      enhanceBlock(blocks[i]);
    }
    return blocks;
  }

  function loadHighlighter(blocks) {
    if (!blocks.length || !allow('optionalScripts')) {
      return;
    }
    loadScript(base + 'assets/vendor/highlight/highlight.min.js', function () {
      if (!window.hljs) {
        return;
      }
      for (var i = 0; i < blocks.length; i += 1) {
        var code = blocks[i].getElementsByTagName('code')[0];
        if (!code) {
          continue;
        }
        try {
          window.hljs.highlightElement(code);
        } catch (error) {
          /* 单个代码块高亮失败时保留原文 */
        }
      }
    });
  }

  /* 公式：按需加载 KaTeX */
  function plainText(root) {
    if (typeof document.createTreeWalker !== 'function' || typeof window.NodeFilter === 'undefined') {
      return root.textContent || '';
    }

    var walker = document.createTreeWalker(root, window.NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var parent = node.parentNode;
        while (parent && parent !== root) {
          var tag = parent.tagName;
          if (tag === 'PRE' || tag === 'CODE' || tag === 'SCRIPT' || tag === 'STYLE') {
            return window.NodeFilter.FILTER_REJECT;
          }
          parent = parent.parentNode;
        }
        return window.NodeFilter.FILTER_ACCEPT;
      }
    });

    var parts = [];
    var node = walker.nextNode();
    while (node) {
      parts.push(node.nodeValue);
      node = walker.nextNode();
    }
    return parts.join('\n');
  }

  function hasMath(text) {
    if (text.indexOf('$$') !== -1 || text.indexOf('\\(') !== -1 || text.indexOf('\\[') !== -1) {
      return true;
    }
    return /\$[^$\n]+\$/.test(text);
  }

  function loadMath(areas) {
    if (!allow('optionalScripts')) {
      return;
    }

    var pending = [];
    for (var i = 0; i < areas.length; i += 1) {
      if (hasMath(plainText(areas[i]))) {
        pending.push(areas[i]);
      }
    }
    if (!pending.length) {
      return;
    }

    loadStyle(base + 'assets/vendor/katex/katex.min.css');
    loadScript(base + 'assets/vendor/katex/katex.min.js', function () {
      loadScript(base + 'assets/vendor/katex/auto-render.min.js', function () {
        if (typeof window.renderMathInElement !== 'function') {
          return;
        }
        for (var j = 0; j < pending.length; j += 1) {
          window.renderMathInElement(pending[j], {
            delimiters: [
              { left: '$$', right: '$$', display: true },
              { left: '\\[', right: '\\]', display: true },
              { left: '\\(', right: '\\)', display: false },
              { left: '$', right: '$', display: false }
            ],
            ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option'],
            throwOnError: false
          });
        }
        document.documentElement.setAttribute('data-math', 'rendered');
      });
    });
  }

  /* 目录 */
  function buildToc(areas) {
    if (!areas.length) {
      return null;
    }

    var area = areas[0];
    var headings = area.querySelectorAll('h2, h3');
    if (headings.length < 3) {
      return null;
    }

    var nav = document.createElement('nav');
    nav.className = 'article-toc';
    nav.setAttribute('aria-labelledby', 'toc-title');

    var title = document.createElement('p');
    title.className = 'toc-title';
    title.id = 'toc-title';
    title.textContent = '本文目录';
    nav.appendChild(title);

    var list = document.createElement('ol');
    list.className = 'toc-list';
    var links = {};
    var i;

    for (i = 0; i < headings.length; i += 1) {
      var heading = headings[i];
      if (!heading.id) {
        heading.id = 'section-' + (i + 1);
      }
      var item = document.createElement('li');
      item.className = 'toc-item toc-level-' + heading.tagName.charAt(1);
      var anchor = document.createElement('a');
      anchor.href = '#' + heading.id;
      anchor.textContent = trim(heading.textContent);
      item.appendChild(anchor);
      list.appendChild(item);
      links[heading.id] = anchor;
    }

    nav.appendChild(list);
    area.parentNode.insertBefore(nav, area);

    if (typeof window.IntersectionObserver === 'function') {
      trackHeadings(headings, links);
    }
    return nav;
  }

  function trackHeadings(headings, links) {
    var state = {};
    var observer = new window.IntersectionObserver(function (entries) {
      var i;
      for (i = 0; i < entries.length; i += 1) {
        state[entries[i].target.id] = entries[i].isIntersecting;
      }
      for (i = 0; i < headings.length; i += 1) {
        var id = headings[i].id;
        if (state[id]) {
          markCurrent(links, id);
          return;
        }
      }
    }, { rootMargin: '-15% 0px -75% 0px' });

    for (var j = 0; j < headings.length; j += 1) {
      observer.observe(headings[j]);
    }
  }

  function markCurrent(links, id) {
    for (var key in links) {
      if (!Object.prototype.hasOwnProperty.call(links, key)) {
        continue;
      }
      if (key === id) {
        links[key].setAttribute('aria-current', 'true');
      } else {
        links[key].removeAttribute('aria-current');
      }
    }
  }

  /* 字号 */
  function initReadingSize(host) {
    var options = [
      { key: 'sm', label: '小' },
      { key: 'md', label: '中' },
      { key: 'lg', label: '大' }
    ];
    var root = document.documentElement;
    var stored = null;

    try {
      stored = window.localStorage.getItem(READING_KEY);
    } catch (error) {
      stored = null;
    }

    var group = document.createElement('div');
    group.className = 'reading-size';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', '正文字号');

    function apply(key) {
      var isDefault = key === 'md';
      if (isDefault) {
        root.removeAttribute('data-reading-size');
      } else {
        root.setAttribute('data-reading-size', key);
      }
      for (var i = 0; i < buttons.length; i += 1) {
        buttons[i].setAttribute('aria-pressed', buttons[i].getAttribute('data-key') === key ? 'true' : 'false');
      }
    }

    var buttons = [];
    for (var i = 0; i < options.length; i += 1) {
      var button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('data-key', options[i].key);
      button.textContent = options[i].label;
      button.addEventListener('click', function (event) {
        var key = event.currentTarget.getAttribute('data-key');
        apply(key);
        try {
          window.localStorage.setItem(READING_KEY, key);
        } catch (error) {
          /* 存储不可用时仅保留本次会话 */
        }
      });
      buttons.push(button);
      group.appendChild(button);
    }

    var initial = 'md';
    for (var j = 0; j < options.length; j += 1) {
      if (options[j].key === stored) {
        initial = stored;
      }
    }
    apply(initial);

    var tools = document.createElement('div');
    tools.className = 'article-tools';
    var label = document.createElement('span');
    label.textContent = '字号';
    tools.appendChild(label);
    tools.appendChild(group);
    host.parentNode.insertBefore(tools, host.nextSibling);
  }

  /* 阅读时长：按正文字数估算，中文按每分钟 400 字计，不足一分钟按一分钟显示 */
  function initReadingTime(head) {
    var area = document.querySelector('.prose');
    var meta = head ? head.querySelector('.meta') : null;
    if (!area || !meta) {
      return;
    }

    var count = (area.textContent || '').replace(/\s+/g, '').length;
    var minutes = Math.max(1, Math.round(count / 400));
    var slot = document.createElement('span');
    slot.textContent = '约 ' + minutes + ' 分钟';
    meta.appendChild(slot);
  }

  /* 阅读进度与回到顶部 */
  function initScrollUi() {
    var bar = document.createElement('div');
    bar.className = 'reading-progress';
    bar.setAttribute('aria-hidden', 'true');
    document.body.appendChild(bar);

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'back-to-top';
    button.title = '回到顶部';
    button.setAttribute('aria-label', '回到顶部');
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 19V5"></path><path d="M5 12l7-7 7 7"></path></svg>';
    button.addEventListener('click', function () {
      var smooth = allow('motion');
      try {
        window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
      } catch (error) {
        window.scrollTo(0, 0);
      }
    });
    document.body.appendChild(button);

    var pending = false;

    function update() {
      pending = false;
      var doc = document.documentElement;
      var offset = window.pageYOffset || doc.scrollTop || 0;
      var span = doc.scrollHeight - window.innerHeight;
      var ratio = span > 0 ? offset / span : 0;
      if (ratio < 0) {
        ratio = 0;
      }
      if (ratio > 1) {
        ratio = 1;
      }
      bar.style.transform = 'scaleX(' + ratio.toFixed(4) + ')';
      button.setAttribute('data-visible', offset > 400 ? 'true' : 'false');
    }

    function onScroll() {
      if (pending) {
        return;
      }
      pending = true;
      window.requestAnimationFrame(update);
    }

    window.addEventListener('scroll', onScroll, false);
    window.addEventListener('resize', onScroll, false);
    update();
  }

  function start() {
    var areas = document.querySelectorAll('.prose');
    var head = document.querySelector('.article-head');

    if (head) {
      initReadingSize(head);
      initReadingTime(head);
    }
    buildToc(areas);
    loadMath(areas);
    initScrollUi();

    var blocks = enhanceCodeBlocks();
    loadHighlighter(blocks);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

