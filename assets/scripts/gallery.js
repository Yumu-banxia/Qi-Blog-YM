/* 作品截图放大查看
 * 触发按钮内嵌缩略图，打开后把同名原图放入覆盖层；Esc、关闭按钮或点击背景退出，焦点回到触发按钮。
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

  function open(trigger) {
    var source = trigger.querySelector('img');
    if (!source || !image) {
      return;
    }
    lastFocus = trigger;
    image.src = source.getAttribute('src');
    image.alt = source.getAttribute('alt') || '';
    box.hidden = false;
    if (close) {
      close.focus();
    }
  }

  function dismiss() {
    if (box.hidden) {
      return;
    }
    box.hidden = true;
    image.removeAttribute('src');
    if (lastFocus && typeof lastFocus.focus === 'function') {
      lastFocus.focus();
    }
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

  document.addEventListener('keydown', function (event) {
    if ((event.key === 'Escape' || event.keyCode === 27) && !box.hidden) {
      event.preventDefault();
      dismiss();
    }
  });
})();