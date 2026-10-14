/* 站点星图的图谱式交互
 * 画布可放大与平移：滚轮以指针为中心缩放，放大后拖动空白处平移，双击或 Esc 回到初始视图。
 * 节点可以拖动，位置写回 --x 与 --y，连线端点随之更新；
 * 指针悬停或键盘聚焦某个节点时，该节点与相连连线保持，其余退到背景；
 * 指针在画布内移动时，节点按各自深度做小幅视差。
 * 只在允许动效的档位启用；页面隐藏或星图离开视口时暂停；系统偏好减少动态效果时终止。
 */
(function () {
  'use strict';

  var chart = document.querySelector('.star-chart');
  var canvas = chart ? chart.querySelector('.chart-canvas') : null;
  if (!chart || !canvas) {
    return;
  }

  var Capability = window.Capability || null;
  if (!Capability || typeof Capability.allow !== 'function' || !Capability.allow('motion')) {
    return;
  }

  var svg = canvas.querySelector('.chart-lines');
  var lines = svg ? svg.querySelectorAll('path') : [];
  var nodeList = canvas.querySelectorAll('.chart-node');
  var pointer = canvas.querySelector('.chart-pointer');
  if (!lines.length || !nodeList.length) {
    return;
  }

  var EDGES = [[0, 1], [1, 2], [2, 3], [3, 0]];
  var EASE = 0.16;
  var SETTLE = 0.002;
  var DRAG_THRESHOLD = 4;
  var POSITION_MIN = 6;
  var POSITION_MAX = 94;
  var MIN_SCALE = 1;
  var MAX_SCALE = 1.8;
  var ZOOM_STEP = 0.14;

  var items = [];
  var width = 1;
  var height = 1;
  var enabled = true;
  var paused = false;
  var running = false;
  var focusIndex = -1;
  var drag = null;
  var pan = null;
  var suppressClick = false;
  var parallaxTarget = { x: 0, y: 0 };
  var parallax = { x: 0, y: 0 };
  var view = { scale: 1, x: 0, y: 0 };

  function readNumber(el, name, fallback) {
    if (!el || !window.getComputedStyle) {
      return fallback;
    }
    var value = parseFloat(window.getComputedStyle(el).getPropertyValue(name));
    return isNaN(value) ? fallback : value;
  }

  function clamp(value, min, max) {
    return value < min ? min : (value > max ? max : value);
  }

  function measure() {
    width = canvas.offsetWidth || 1;
    height = canvas.offsetHeight || 1;
  }

  function shiftX(item) {
    return (parallax.x * item.depth * 100) / width;
  }

  function shiftY(item) {
    return (parallax.y * item.depth * 100) / height;
  }

  function draw() {
    for (var i = 0; i < EDGES.length; i += 1) {
      var path = lines[i];
      if (!path) {
        continue;
      }
      var a = items[EDGES[i][0]];
      var b = items[EDGES[i][1]];
      if (!a || !b) {
        continue;
      }
      path.setAttribute('d',
        'M' + (a.x + shiftX(a)).toFixed(2) + ' ' + (a.y + shiftY(a)).toFixed(2) +
        ' L' + (b.x + shiftX(b)).toFixed(2) + ' ' + (b.y + shiftY(b)).toFixed(2));
    }
  }

  /* 视图变换：缩放围绕指针，平移限制在放大后的范围内 */
  function applyView() {
    canvas.style.transform = 'translate3d(' + view.x.toFixed(2) + 'px, ' + view.y.toFixed(2) +
      'px, 0) scale(' + view.scale.toFixed(4) + ')';
    chart.style.setProperty('--inverse', (1 / view.scale).toFixed(4));
  }

  function clampView() {
    var maxX = (width * view.scale - width) / 2;
    var maxY = (height * view.scale - height) / 2;
    view.x = clamp(view.x, -maxX, maxX);
    view.y = clamp(view.y, -maxY, maxY);
  }

  function zoomTo(next, clientX, clientY) {
    var scale = clamp(next, MIN_SCALE, MAX_SCALE);
    if (Math.abs(scale - view.scale) < 0.001) {
      return;
    }
    var box = chart.getBoundingClientRect();
    var px = clientX - box.left - box.width / 2;
    var py = clientY - box.top - box.height / 2;
    var ratio = scale / view.scale;
    view.x = px - (px - view.x) * ratio;
    view.y = py - (py - view.y) * ratio;
    view.scale = scale;
    clampView();
    applyView();
  }

  function resetView() {
    view.scale = 1;
    view.x = 0;
    view.y = 0;
    applyView();
  }

  function applyParallax() {
    chart.style.setProperty('--nx', parallax.x.toFixed(4));
    chart.style.setProperty('--ny', parallax.y.toFixed(4));
    draw();
  }

  function schedule() {
    if (running || !enabled || paused) {
      return;
    }
    running = true;
    window.requestAnimationFrame(step);
  }

  function step() {
    running = false;
    if (!enabled || paused) {
      return;
    }

    var settled = true;
    var keys = ['x', 'y'];
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      var goal = parallaxTarget[key];
      var next = parallax[key] + (goal - parallax[key]) * EASE;
      if (Math.abs(goal - next) < SETTLE) {
        next = goal;
      } else {
        settled = false;
      }
      parallax[key] = next;
    }

    applyParallax();

    if (!settled) {
      schedule();
    }
  }

  /* 聚焦：相关元素保持，其余退到背景 */
  function setFocus(index) {
    if (focusIndex === index) {
      return;
    }
    focusIndex = index;

    for (var i = 0; i < items.length; i += 1) {
      var related = i === index;
      items[i].el.classList.toggle('is-focus', related);
      items[i].el.classList.toggle('is-dim', index >= 0 && !related);
    }

    for (var j = 0; j < EDGES.length; j += 1) {
      var path = lines[j];
      if (!path) {
        continue;
      }
      var linked = index >= 0 && (EDGES[j][0] === index || EDGES[j][1] === index);
      path.classList.toggle('is-focus', linked);
      path.classList.toggle('is-dim', index >= 0 && !linked);
    }
  }

  /* 结束拖动：指针抬起、指针取消都回到静止状态 */
  function finishDrag(event) {
    if (!drag) {
      return;
    }
    if (event && typeof event.pointerId === 'number' && event.pointerId !== drag.pointerId) {
      return;
    }
    var item = items[drag.index];
    if (item && item.el) {
      item.el.classList.remove('is-dragging');
    }
    canvas.removeAttribute('data-dragging');
    if (drag.moved) {
      suppressClick = true;
      window.setTimeout(function () {
        suppressClick = false;
      }, 0);
    }
    drag = null;
  }

  /* 节点拖动：位移超过阈值即视为拖动，并抑制随后的点击跳转 */
  function bindNode(link, index) {
    function onDown(event) {
      if (!enabled || paused) {
        return;
      }
      if (event.pointerType === 'mouse' && event.button !== 0) {
        return;
      }
      // 节点上的拖动由本模块处理，阻止事件到达画布上的平移处理
      event.stopPropagation();
      drag = {
        index: index,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: items[index].x,
        originY: items[index].y,
        moved: false
      };
      if (typeof link.setPointerCapture === 'function') {
        link.setPointerCapture(event.pointerId);
      }
    }

    function onMove(event) {
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }

      var dx = (event.clientX - drag.startX) / view.scale;
      var dy = (event.clientY - drag.startY) / view.scale;

      if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) {
        return;
      }

      drag.moved = true;
      items[drag.index].el.classList.add('is-dragging');
      canvas.setAttribute('data-dragging', 'true');

      var item = items[drag.index];
      item.x = clamp(drag.originX + (dx * 100) / width, POSITION_MIN, POSITION_MAX);
      item.y = clamp(drag.originY + (dy * 100) / height, POSITION_MIN, POSITION_MAX);
      item.el.style.setProperty('--x', item.x.toFixed(2) + '%');
      item.el.style.setProperty('--y', item.y.toFixed(2) + '%');
      draw();
    }

    link.addEventListener('pointerdown', onDown);
    link.addEventListener('pointermove', onMove);
    link.addEventListener('pointerup', finishDrag);
    link.addEventListener('pointercancel', finishDrag);
    link.addEventListener('click', function (event) {
      if (suppressClick) {
        event.preventDefault();
      }
    });

    link.addEventListener('pointerenter', function () {
      setFocus(index);
    });
    link.addEventListener('pointerleave', function () {
      if (!drag) {
        setFocus(-1);
      }
    });
    link.addEventListener('focus', function () {
      setFocus(index);
    });
    link.addEventListener('blur', function () {
      setFocus(-1);
    });
  }

  /* 空白处拖动：放大后用于平移视图 */
  function finishPan(event) {
    if (!pan) {
      return;
    }
    if (event && typeof event.pointerId === 'number' && event.pointerId !== pan.pointerId) {
      return;
    }
    canvas.removeAttribute('data-dragging');
    pan = null;
  }

  function onCanvasDown(event) {
    if (!enabled || paused || drag) {
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    if (event.target && event.target.closest && event.target.closest('.chart-node')) {
      return;
    }
    pan = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y
    };
    if (typeof canvas.setPointerCapture === 'function') {
      canvas.setPointerCapture(event.pointerId);
    }
  }

  function onCanvasDragMove(event) {
    if (!enabled || paused) {
      return;
    }

    if (pan && pan.pointerId === event.pointerId) {
      view.x = pan.originX + (event.clientX - pan.startX);
      view.y = pan.originY + (event.clientY - pan.startY);
      clampView();
      applyView();
      canvas.setAttribute('data-dragging', 'true');
      return;
    }

    if (drag) {
      return;
    }

    var box = chart.getBoundingClientRect();
    if (!box.width || !box.height) {
      return;
    }
    parallaxTarget.x = clamp(((event.clientX - box.left) / box.width) * 2 - 1, -1, 1);
    parallaxTarget.y = clamp(((event.clientY - box.top) / box.height) * 2 - 1, -1, 1);

    if (pointer) {
      chart.style.setProperty('--px', (event.clientX - box.left - box.width / 2).toFixed(2) + 'px');
      chart.style.setProperty('--py', (event.clientY - box.top - box.height / 2).toFixed(2) + 'px');
      chart.setAttribute('data-pointer', 'on');
    }

    schedule();
  }

  function onCanvasLeave() {
    if (!enabled || paused) {
      return;
    }
    parallaxTarget.x = 0;
    parallaxTarget.y = 0;
    chart.removeAttribute('data-pointer');
    schedule();
  }

  function onWheel(event) {
    if (!enabled || paused) {
      return;
    }
    if (event.cancelable) {
      event.preventDefault();
    }
    var step = event.deltaY < 0 ? 1 + ZOOM_STEP : 1 - ZOOM_STEP;
    zoomTo(view.scale * step, event.clientX, event.clientY);
  }

  /* 页面隐藏或星图离开视口时暂停，恢复后继续 */
  function setPaused(next) {
    if (paused === next) {
      return;
    }
    paused = next;
    if (!paused) {
      schedule();
    }
  }

  /* 减少动态效果开启时终止交互，回到静态形态 */
  function stop() {
    enabled = false;
    setFocus(-1);
    chart.removeAttribute('data-pointer');
    chart.style.removeProperty('--nx');
    chart.style.removeProperty('--ny');
    chart.style.removeProperty('--px');
    chart.style.removeProperty('--py');
    canvas.style.removeProperty('transform');
    chart.style.removeProperty('--inverse');
    for (var i = 0; i < lines.length; i += 1) {
      lines[i].removeAttribute('d');
    }
  }

  function build() {
    for (var i = 0; i < nodeList.length; i += 1) {
      var el = nodeList[i];
      var link = el.querySelector('a');
      items.push({
        el: el,
        x: readNumber(el, '--x', 50),
        y: readNumber(el, '--y', 50),
        depth: readNumber(el, '--depth', 0)
      });
      if (link) {
        bindNode(link, i);
      }
    }
    measure();
    applyView();
    draw();
  }

  canvas.addEventListener('pointerdown', onCanvasDown);
  canvas.addEventListener('pointermove', onCanvasDragMove, { passive: true });
  canvas.addEventListener('pointerleave', onCanvasLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('pointerup', finishPan, true);
  window.addEventListener('pointercancel', finishPan, true);
  window.addEventListener('pointerup', finishDrag, true);
  window.addEventListener('pointercancel', finishDrag, true);

  chart.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' || event.keyCode === 27) {
      resetView();
    }
  });

  canvas.addEventListener('dblclick', function (event) {
    event.preventDefault();
    resetView();
  });

  if (typeof window.ResizeObserver === 'function') {
    var observer = new window.ResizeObserver(function () {
      measure();
      clampView();
      applyView();
      draw();
    });
    observer.observe(canvas);
  } else {
    window.addEventListener('resize', function () {
      measure();
      clampView();
      applyView();
      draw();
    }, { passive: true });
  }

  if (typeof window.IntersectionObserver === 'function') {
    var visibleObserver = new window.IntersectionObserver(function (entries) {
      setPaused(!entries[0].isIntersecting);
    }, { threshold: 0.05 });
    visibleObserver.observe(chart);
  }

  document.addEventListener('visibilitychange', function () {
    setPaused(document.hidden);
  });

  if (window.matchMedia) {
    var motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    var onMotionChange = function () {
      if (motionQuery.matches) {
        stop();
      }
    };
    if (typeof motionQuery.addEventListener === 'function') {
      motionQuery.addEventListener('change', onMotionChange);
    } else if (typeof motionQuery.addListener === 'function') {
      motionQuery.addListener(onMotionChange);
    }
  }

  build();
})();