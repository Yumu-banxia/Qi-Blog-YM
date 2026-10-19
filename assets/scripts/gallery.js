/* 作品图片浏览：缩放、切换、复制与下载，并保留焦点管理和页面滚动锁定。 */
(function () {
  'use strict';

  var box = document.getElementById('lightbox');
  var triggers = Array.prototype.slice.call(document.querySelectorAll('.shot-open'));
  if (!box || !triggers.length) {
    return;
  }

  var image = box.querySelector('.lightbox-image');
  var frame = box.querySelector('.lightbox-frame');
  var stage = box.querySelector('.lightbox-stage');
  var close = box.querySelector('.lightbox-close');
  var previous = box.querySelector('#lightbox-previous');
  var next = box.querySelector('#lightbox-next');
  var zoomOut = box.querySelector('#lightbox-zoom-out');
  var zoomIn = box.querySelector('#lightbox-zoom-in');
  var fit = box.querySelector('#lightbox-fit');
  var actual = box.querySelector('#lightbox-actual');
  var copy = box.querySelector('#lightbox-copy');
  var download = box.querySelector('#lightbox-download');
  var count = box.querySelector('#lightbox-count');
  var zoomLevel = box.querySelector('#lightbox-zoom-level');
  var caption = box.querySelector('#lightbox-caption');
  var status = box.querySelector('#lightbox-status');
  var lastFocus = null;
  var scrollLock = null;
  var currentIndex = -1;
  var fitScale = 1;
  var displayScale = 1;
  var fitActive = true;
  var imageReady = false;
  var copying = false;
  var loadVersion = 0;
  var minScale = 0.05;
  var maxScale = 4;
  var supportsInert = typeof HTMLElement !== 'undefined' && 'inert' in HTMLElement.prototype;
  var supportsPointerEvents = typeof window.PointerEvent === 'function';
  var dragState = null;

  image.draggable = false;

  /* 背景内容在对话框打开期间退出键盘访问。 */
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
      if (!nodes[i].disabled && !nodes[i].hidden) {
        list.push(nodes[i]);
      }
    }
    return list;
  }

  function currentScale() {
    return fitActive ? fitScale : displayScale;
  }

  function minimumScale() {
    return Math.min(minScale, fitScale);
  }

  function canPan() {
    return imageReady && (stage.scrollWidth > stage.clientWidth + 1 || stage.scrollHeight > stage.clientHeight + 1);
  }

  function updatePanState() {
    stage.setAttribute('data-panable', canPan() ? 'true' : 'false');
  }

  function updateControls() {
    var scale = currentScale();
    var ready = imageReady;
    if (previous) {
      previous.disabled = currentIndex <= 0;
    }
    if (next) {
      next.disabled = currentIndex >= triggers.length - 1;
    }
    if (zoomOut) {
      zoomOut.disabled = !ready || scale <= minimumScale() + 0.00001;
    }
    if (zoomIn) {
      zoomIn.disabled = !ready || scale >= maxScale;
    }
    if (fit) {
      fit.disabled = !ready;
    }
    if (actual) {
      actual.disabled = !ready;
    }
    if (copy) {
      copy.disabled = !ready || copying;
    }
    if (zoomLevel) {
      zoomLevel.textContent = fitActive ? '适合窗口' : Math.round(scale * 100) + '%';
    }
  }

  function centerImage() {
    stage.scrollLeft = Math.max(0, (stage.scrollWidth - stage.clientWidth) / 2);
    stage.scrollTop = Math.max(0, (stage.scrollHeight - stage.clientHeight) / 2);
  }

  function updateImageSize(center) {
    if (!imageReady || !image.naturalWidth || !image.naturalHeight) {
      return;
    }

    if (fitActive) {
      var widthScale = stage.clientWidth / image.naturalWidth;
      var heightScale = stage.clientHeight / image.naturalHeight;
      fitScale = Math.max(0.0001, Math.min(1, widthScale, heightScale));
    }

    var scale = currentScale();
    frame.style.width = Math.max(1, Math.round(image.naturalWidth * scale)) + 'px';
    frame.style.height = Math.max(1, Math.round(image.naturalHeight * scale)) + 'px';
    image.style.visibility = 'visible';
    updateControls();

    if (center) {
      centerImage();
    }
    updatePanState();
  }

  function imageLoaded(version) {
    if (version !== loadVersion || !image.naturalWidth) {
      return;
    }
    image.onload = null;
    image.onerror = null;
    imageReady = true;
    updateImageSize(true);
  }

  function filenameFromUrl(url) {
    var cleanUrl = url.split(/[?#]/)[0];
    var filename = cleanUrl.slice(cleanUrl.lastIndexOf('/') + 1);
    try {
      filename = decodeURIComponent(filename);
    } catch (error) {
      /* 保留浏览器给出的原始文件名。 */
    }
    return filename || 'image';
  }

  function loadImage(index) {
    if (index < 0 || index >= triggers.length) {
      return;
    }

    var source = triggers[index].querySelector('img');
    if (!source) {
      return;
    }

    stopDragging(true);
    currentIndex = index;
    fitActive = true;
    displayScale = 1;
    imageReady = false;
    loadVersion += 1;
    var version = loadVersion;
    var sourceUrl = source.currentSrc || source.src || source.getAttribute('src');

    image.onload = function () {
      imageLoaded(version);
    };
    image.onerror = function () {
      if (version === loadVersion) {
        imageReady = false;
        status.textContent = '图片载入失败，请关闭后重试。';
        updateControls();
        updatePanState();
      }
    };
    image.style.visibility = 'hidden';
    frame.style.width = '0';
    frame.style.height = '0';
    stage.scrollLeft = 0;
    stage.scrollTop = 0;
    image.alt = source.getAttribute('alt') || '';
    image.src = sourceUrl;
    caption.textContent = image.alt || '作品截图';
    download.href = sourceUrl;
    download.setAttribute('download', filenameFromUrl(sourceUrl));
    count.textContent = (index + 1) + ' / ' + triggers.length;
    status.textContent = '';

    if (image.complete && image.naturalWidth) {
      imageLoaded(version);
    } else {
      updateControls();
      updatePanState();
    }
  }

  function open(trigger) {
    var index = triggers.indexOf(trigger);
    if (index < 0) {
      return;
    }
    lastFocus = trigger;
    box.hidden = false;
    setBackgroundHidden(true);
    lockScroll();
    loadImage(index);
    if (close) {
      close.focus();
    }
  }

  function dismiss() {
    if (box.hidden) {
      return;
    }
    stopDragging(true);
    box.hidden = true;
    setBackgroundHidden(false);
    unlockScroll();
    loadVersion += 1;
    image.onload = null;
    image.onerror = null;
    image.src = box.getAttribute('data-placeholder') || image.src;
    image.alt = '';
    imageReady = false;
    image.style.removeProperty('visibility');
    frame.style.removeProperty('width');
    frame.style.removeProperty('height');
    updatePanState();
    caption.textContent = '';
    status.textContent = '';
    currentIndex = -1;
    if (lastFocus && typeof lastFocus.focus === 'function') {
      lastFocus.focus();
    }
    lastFocus = null;
  }

  function zoomTo(nextScale, clientX, clientY) {
    if (!imageReady) {
      return;
    }

    var oldScale = currentScale();
    var boundedScale = Math.min(maxScale, Math.max(minimumScale(), nextScale));
    if (!oldScale || Math.abs(boundedScale - oldScale) < 0.00001) {
      updateControls();
      return;
    }

    var frameBefore = frame.getBoundingClientRect();
    var stageRect = stage.getBoundingClientRect();
    var anchorX = typeof clientX === 'number' ? clientX : stageRect.left + stage.clientLeft + stage.clientWidth / 2;
    var anchorY = typeof clientY === 'number' ? clientY : stageRect.top + stage.clientTop + stage.clientHeight / 2;
    var imageOffsetX = Math.max(0, Math.min(frameBefore.width, anchorX - frameBefore.left));
    var imageOffsetY = Math.max(0, Math.min(frameBefore.height, anchorY - frameBefore.top));

    fitActive = false;
    displayScale = boundedScale;
    updateImageSize(false);

    var frameAfter = frame.getBoundingClientRect();
    var ratio = boundedScale / oldScale;
    var targetLeft = anchorX - imageOffsetX * ratio;
    var targetTop = anchorY - imageOffsetY * ratio;
    stage.scrollLeft += frameAfter.left - targetLeft;
    stage.scrollTop += frameAfter.top - targetTop;
    updatePanState();
  }

  function zoomBy(multiplier, clientX, clientY) {
    zoomTo(currentScale() * multiplier, clientX, clientY);
  }

  function handleWheel(event) {
    if (!imageReady || !isFinite(event.deltaY) || event.deltaY === 0) {
      return;
    }

    event.preventDefault();
    var delta = event.deltaY;
    if (event.deltaMode === 1) {
      delta *= 16;
    } else if (event.deltaMode === 2) {
      delta *= stage.clientHeight;
    }
    zoomBy(Math.pow(1.2, -delta / 120), event.clientX, event.clientY);
  }

  function startDragging(event, type) {
    if (!imageReady || !canPan() || dragState || event.button !== 0 || event.isPrimary === false) {
      return;
    }

    event.preventDefault();
    dragState = {
      type: type,
      pointerId: type === 'pointer' ? event.pointerId : null,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: stage.scrollLeft,
      scrollTop: stage.scrollTop
    };
    stage.setAttribute('data-dragging', 'true');

    if (type === 'pointer' && typeof stage.setPointerCapture === 'function') {
      try {
        stage.setPointerCapture(event.pointerId);
      } catch (error) {
        /* 全局指针监听继续处理拖动，捕获失败时仍可完成手势。 */
      }
    }
  }

  function moveDragging(event, type) {
    if (!dragState || dragState.type !== type || (type === 'pointer' && event.pointerId !== dragState.pointerId)) {
      return;
    }

    event.preventDefault();
    stage.scrollLeft = dragState.scrollLeft - (event.clientX - dragState.x);
    stage.scrollTop = dragState.scrollTop - (event.clientY - dragState.y);
  }

  function stopDragging(releaseCapture) {
    if (!dragState) {
      return;
    }

    var previousDrag = dragState;
    dragState = null;
    stage.removeAttribute('data-dragging');

    if (releaseCapture && previousDrag.type === 'pointer' && typeof stage.hasPointerCapture === 'function') {
      try {
        if (stage.hasPointerCapture(previousDrag.pointerId)) {
          stage.releasePointerCapture(previousDrag.pointerId);
        }
      } catch (error) {
        /* 指针已由浏览器释放时无需额外处理。 */
      }
    }
    updatePanState();
  }

  function fitToWindow() {
    fitActive = true;
    updateImageSize(false);
    stage.scrollLeft = 0;
    stage.scrollTop = 0;
  }

  function showActualSize() {
    fitActive = false;
    displayScale = 1;
    updateImageSize(true);
  }

  function copyImage() {
    if (!imageReady) {
      status.textContent = '图片载入后即可复制。';
      return;
    }

    if (!navigator.clipboard || typeof navigator.clipboard.write !== 'function' || typeof window.ClipboardItem !== 'function') {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(image.currentSrc || image.src).then(function () {
          status.textContent = '当前浏览器无法复制图片内容，图片地址已复制。';
        }).catch(function () {
          status.textContent = '当前浏览器不支持复制图片，可下载原图。';
        });
      } else {
        status.textContent = '当前浏览器不支持复制图片，可下载原图。';
      }
      return;
    }

    copying = true;
    updateControls();
    status.textContent = '正在准备图片…';

    function finishCopy(message) {
      copying = false;
      status.textContent = message;
      updateControls();
    }

    try {
      var canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      var context = canvas.getContext('2d');
      if (!context || typeof canvas.toBlob !== 'function') {
        throw new Error('PNG conversion is unavailable');
      }
      context.drawImage(image, 0, 0);
      canvas.toBlob(function (blob) {
        if (!blob) {
          finishCopy('图片转换失败，可下载原图。');
          return;
        }

        try {
          var clipboardItem = new window.ClipboardItem({ 'image/png': blob });
          navigator.clipboard.write([clipboardItem]).then(function () {
            finishCopy('图片已复制到剪贴板。');
          }).catch(function () {
            finishCopy('复制失败，请检查剪贴板权限或下载原图。');
          });
        } catch (error) {
          finishCopy('复制失败，请检查剪贴板权限或下载原图。');
        }
      }, 'image/png');
    } catch (error) {
      finishCopy('复制失败，请检查剪贴板权限或下载原图。');
    }
  }

  for (var i = 0; i < triggers.length; i += 1) {
    triggers[i].addEventListener('click', function (event) {
      event.preventDefault();
      open(event.currentTarget);
    });
  }

  if (previous) {
    previous.addEventListener('click', function () {
      loadImage(currentIndex - 1);
    });
  }
  if (next) {
    next.addEventListener('click', function () {
      loadImage(currentIndex + 1);
    });
  }
  if (zoomOut) {
    zoomOut.addEventListener('click', function () {
      zoomBy(1 / 1.25);
    });
  }
  if (zoomIn) {
    zoomIn.addEventListener('click', function () {
      zoomBy(1.25);
    });
  }
  if (fit) {
    fit.addEventListener('click', fitToWindow);
  }
  if (actual) {
    actual.addEventListener('click', showActualSize);
  }
  if (copy) {
    copy.addEventListener('click', copyImage);
  }
  if (close) {
    close.addEventListener('click', dismiss);
  }

  stage.addEventListener('wheel', handleWheel, { passive: false });

  if (supportsPointerEvents) {
    stage.addEventListener('pointerdown', function (event) {
      startDragging(event, 'pointer');
    });
    window.addEventListener('pointermove', function (event) {
      moveDragging(event, 'pointer');
    });
    window.addEventListener('pointerup', function (event) {
      if (dragState && dragState.type === 'pointer' && event.pointerId === dragState.pointerId) {
        stopDragging(true);
      }
    });
    window.addEventListener('pointercancel', function (event) {
      if (dragState && dragState.type === 'pointer' && event.pointerId === dragState.pointerId) {
        stopDragging(true);
      }
    });
    stage.addEventListener('lostpointercapture', function (event) {
      if (dragState && dragState.type === 'pointer' && event.pointerId === dragState.pointerId) {
        stopDragging(false);
      }
    });
  } else {
    stage.addEventListener('mousedown', function (event) {
      startDragging(event, 'mouse');
    });
    document.addEventListener('mousemove', function (event) {
      moveDragging(event, 'mouse');
    });
    document.addEventListener('mouseup', function () {
      if (dragState && dragState.type === 'mouse') {
        stopDragging(false);
      }
    });
  }

  window.addEventListener('blur', function () {
    stopDragging(true);
  });

  box.addEventListener('click', function (event) {
    if (event.target === box) {
      dismiss();
    }
  });

  window.addEventListener('resize', function () {
    if (!box.hidden && fitActive) {
      updateImageSize(false);
    }
  });

  /* Esc 关闭；方向键切图；加减键缩放；Tab 与 Shift+Tab 在对话框内循环。 */
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

    if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      if (key === 'ArrowLeft') {
        event.preventDefault();
        loadImage(currentIndex - 1);
        return;
      }
      if (key === 'ArrowRight') {
        event.preventDefault();
        loadImage(currentIndex + 1);
        return;
      }
      if (key === '+' || key === '=') {
        event.preventDefault();
        zoomBy(1.25);
        return;
      }
      if (key === '-') {
        event.preventDefault();
        zoomBy(1 / 1.25);
        return;
      }
      if (key === '0') {
        event.preventDefault();
        fitToWindow();
        return;
      }
      if (key === '1') {
        event.preventDefault();
        showActualSize();
        return;
      }
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
