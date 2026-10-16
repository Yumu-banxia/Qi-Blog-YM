/* 作品截图放大查看
 * 触发按钮内嵌缩略图，打开后把同名原图放入覆盖层；Esc、关闭按钮或点击背景退出，焦点回到触发按钮。
 * 打开期间焦点限制在对话框内，背景内容退出键盘访问范围，页面滚动暂停。
 */
(function () {
  'use strict';

  var box = document.getElementById('lightbox');
  var triggers = document.querySelectorAll('.shot-open');
  if (!box || !triggers.length) {
    return;
  }

  var image = box.querySelector('.lightbox-image');
  var close = box.querySelector('.lightbox-close');
  var lastFocus = null;
  var scrollLock = null;
  var supportsInert = typeof HTMLElement !== 'undefined' && 'inert' in HTMLElement.prototype;

  /* 背景内容在对话框打开期间退出键盘访问：优先使用 inert，缺少支持时退回 aria-hidden */
  function setBackgroundHidden(hidden) {
    var nodes = document.body.children;
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (node === box) {
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

  function focusables() {
    var nodes = box.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])');
    var list = [];
    for (var i = 0; i < nodes.length; i += 1) {
      if (!nodes[i].disabled) {
        list.push(nodes[i]);
      }
    }
    return list;
  }

  function open(trigger) {
    var source = trigger.querySelector('img');
    if (!source) {
      return;
    }
    if (image) {
      image.src = source.getAttribute('src');
      image.alt = source.getAttribute('alt') || '';
    }
    lastFocus = trigger;
    box.hidden = false;
    setBackgroundHidden(true);
    lockScroll();
    if (close) {
      close.focus();
    }
  }

  function dismiss() {
    if (box.hidden) {
      return;
    }
    box.hidden = true;
    setBackgroundHidden(false);
    unlockScroll();
    if (image) {
      image.src = box.getAttribute('data-placeholder') || image.src;
      image.alt = '';
    }
    if (lastFocus && typeof lastFocus.focus === 'function') {
      lastFocus.focus();
    }
    lastFocus = null;
  }

  for (var i = 0; i < triggers.length; i += 1) {
    triggers[i].addEventListener('click', function (event) {
      event.preventDefault();
      open(event.currentTarget);
    });
  }

  if (close) {
    close.addEventListener('click', dismiss);
  }

  box.addEventListener('click', function (event) {
    if (event.target === box) {
      dismiss();
    }
  });

  /* Esc 关闭；Tab 与 Shift+Tab 在对话框内部循环 */
  document.addEventListener('keydown', function (event) {
    if (box.hidden) {
      return;
    }

    var key = event.key || '';

    if (key === 'Escape' || event.keyCode === 27) {
      event.preventDefault();
      dismiss();
      return;
    }

    if (key !== 'Tab' && event.keyCode !== 9) {
      return;
    }

    var items = focusables();
    if (!items.length) {
      event.preventDefault();
      return;
    }

    var first = items[0];
    var last = items[items.length - 1];
    var active = document.activeElement;

    if (event.shiftKey) {
      if (active === first || !box.contains(active)) {
        event.preventDefault();
        last.focus();
      }
      return;
    }

    if (active === last || !box.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  });
})();
