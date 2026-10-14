/* 站点星图的漂浮交互
 * 四个节点各自独立漂浮：以基准位置为锚，受低频扰动与回中弹力作用，带阻尼地缓慢游走，
 * 相位各不相同，因此彼此的位移方向与节奏都不同。连线用三次贝塞尔连接，随节点平滑变化。
 * 指针只用于高亮（悬停或键盘聚焦）与操作（拖动节点、缩放、平移），不再牵引节点或留下跟随星点。
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
  if (!lines.length || !nodeList.length) {
    return;
  }

  var EDGES = [[0, 1], [1, 2], [2, 3], [3, 0]];
  var DRAG_THRESHOLD = 4;
  var POSITION_MIN = 6;
  var POSITION_MAX = 94;
  var MIN_SCALE = 1;
  var MAX_SCALE = 1.8;
  var ZOOM_STEP = 0.14;

  /* 漂浮参数：回中弹力、低频扰动、阻尼与偏移上限，单位均为画布百分比 */
  var SPRING = 3.2;
  var FORCE = 12.5;
  var DAMPING = 0.9;
  var OFFSET_LIMIT = 5;

  var items = [];
  var width = 1;
  var height = 1;
  var enabled = true;
  var paused = false;
  var focusIndex = -1;
  var drag = null;
  var pan = null;
  var suppressClick = false;
  var view = { scale: 1, x: 0, y: 0 };
  var frame = 0;
  var frameId = 0;
  var lastTime = 0;

  function clamp(value, min, max) {
    return value < min ? min : (value > max ? max : value);
  }

  function readNumber(el, name, fallback) {
    if (!el || !window.getComputedStyle) {
      return fallback;
    }
    var value = parseFloat(window.getComputedStyle(el).getPropertyValue(name));
    return isNaN(value) ? fallback : value;
  }

  function measure() {
    width = canvas.offsetWidth || 1;
    height = canvas.offsetHeight || 1;
  }

  function nodeX(item) {
    return item.baseX + item.ox;
  }

  function nodeY(item) {
    return item.baseY + item.oy;
  }

  /* 连线用三次贝塞尔，控制点沿同侧法线偏移，得到平滑且同向的弧线 */
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

      var ax = nodeX(a);
      var ay = nodeY(a);
      var bx = nodeX(b);
      var by = nodeY(b);
      var dx = bx - ax;
      var dy = by - ay;
      var length = Math.sqrt(dx * dx + dy * dy) || 1;
      var bend = length * 0.16;
      var nx = -dy / length;
      var ny = dx / length;

      path.setAttribute('d',
        'M' + ax.toFixed(2) + ' ' + ay.toFixed(2) +
        ' C' + (ax + dx * 0.28 + nx * bend).toFixed(2) + ' ' + (ay + dy * 0.28 + ny * bend).toFixed(2) +
        ' ' + (ax + dx * 0.72 + nx * bend).toFixed(2) + ' ' + (ay + dy * 0.72 + ny * bend).toFixed(2) +
        ' ' + bx.toFixed(2) + ' ' + by.toFixed(2));
    }
  }

  function applyOffset(item) {
    item.el.style.setProperty('--ox', ((item.ox / 100) * width).toFixed(2) + 'px');
    item.el.style.setProperty('--oy', ((item.oy / 100) * height).toFixed(2) + 'px');
  }

  function resetOffset(item) {
    item.ox = 0;
    item.oy = 0;
    item.vx = 0;
    item.vy = 0;
    applyOffset(item);
  }

  function tick(now) {
    frameId = 0;
    if (!enabled) {
      return;
    }

    var dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 0.016;
    lastTime = now;
    frame += 1;

    if (!paused) {
      var damp = Math.pow(DAMPING, dt * 60);
      var seconds = now / 1000;

      for (var i = 0; i < items.length; i += 1) {
        var item = items[i];
        if (drag && drag.index === i) {
          continue;
        }

        /* 每个节点有各自的振幅系数，位移的方向与幅度因此互不相同 */
        var amp = FORCE * item.amp;
        var fx = Math.sin(seconds / 6 + item.phase) * Math.cos(seconds / 13 + item.phase2) * amp;
        var fy = Math.cos(seconds / 7.5 + item.phase2) * Math.sin(seconds / 12 + item.phase) * amp;
        fx -= item.ox * SPRING;
        fy -= item.oy * SPRING;

        item.vx = (item.vx + fx * dt) * damp;
        item.vy = (item.vy + fy * dt) * damp;
        item.ox = clamp(item.ox + item.vx * dt, -OFFSET_LIMIT, OFFSET_LIMIT);
        item.oy = clamp(item.oy + item.vy * dt, -OFFSET_LIMIT, OFFSET_LIMIT);
        applyOffset(item);
      }

      /* 连线每两帧重算一次，位移平缓，观感一致而开销减半 */
      if (frame % 2 === 0) {
        draw();
      }
    }

    schedule();
  }

  function schedule() {
    if (frameId || !enabled || paused) {
      return;
    }
    frameId = window.requestAnimationFrame(tick);
  }

  /* 高亮：相关元素保持，其余退到背景 */
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
        originX: items[index].baseX,
        originY: items[index].baseY,
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
      var item = items[drag.index];
      item.el.classList.add('is-dragging');
      canvas.setAttribute('data-dragging', 'true');

      item.baseX = clamp(drag.originX + (dx * 100) / width, POSITION_MIN, POSITION_MAX);
      item.baseY = clamp(drag.originY + (dy * 100) / height, POSITION_MIN, POSITION_MAX);
      item.el.style.setProperty('--x', item.baseX.toFixed(2) + '%');
      item.el.style.setProperty('--y', item.baseY.toFixed(2) + '%');
      item.ox = 0;
      item.oy = 0;
      item.vx = 0;
      item.vy = 0;
      applyOffset(item);
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

  function applyView() {
    canvas.style.transform = 'translate3d(' + view.x.toFixed(2) + 'px, ' + view.y.toFixed(2) +
      'px, 0) scale(' + view.scale.toFixed(4) + ')';
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

  function onCanvasMove(event) {
    if (!enabled || paused || !pan || pan.pointerId !== event.pointerId) {
      return;
    }
    view.x = pan.originX + (event.clientX - pan.startX);
    view.y = pan.originY + (event.clientY - pan.startY);
    clampView();
    applyView();
    canvas.setAttribute('data-dragging', 'true');
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

  function setPaused(next) {
    if (paused === next) {
      return;
    }
    paused = next;
    if (!paused) {
      lastTime = 0;
      schedule();
    }
  }

  /* 减少动态效果开启时终止漂浮与交互，节点回到基准位置 */
  function stop() {
    enabled = false;
    setFocus(-1);
    if (frameId) {
      window.cancelAnimationFrame(frameId);
      frameId = 0;
    }
    for (var i = 0; i < items.length; i += 1) {
      resetOffset(items[i]);
    }
    canvas.style.removeProperty('transform');
    for (var j = 0; j < lines.length; j += 1) {
      lines[j].removeAttribute('d');
    }
  }

  function build() {
    for (var i = 0; i < nodeList.length; i += 1) {
      var el = nodeList[i];
      var link = el.querySelector('a');
      items.push({
        el: el,
        baseX: readNumber(el, '--x', 50),
        baseY: readNumber(el, '--y', 50),
        ox: 0,
        oy: 0,
        vx: 0,
        vy: 0,
        phase: (i * 1.7) % 6.28,
        phase2: (i * 2.9 + 1.1) % 6.28,
        amp: 0.75 + (i % 4) * 0.15
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
  canvas.addEventListener('pointermove', onCanvasMove, { passive: true });
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
      var i;
      for (i = 0; i < items.length; i += 1) {
        applyOffset(items[i]);
      }
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
  schedule();
})();