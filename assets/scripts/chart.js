/* 站点星图的流动交互
 * 一、自主漂浮：每个节点以基准位置为锚，受低频扰动、回中弹力与阻尼作用，相位与振幅各不相同，
 *     位移因此互不关联，观感像各自漂浮的天体。
 * 二、指针响应：指针在画布内移动时形成力场，近旁节点被推开，并带一点沿指针移动方向的推力，
 *     指针移开后节点在弹力作用下缓慢回到基准位置。
 * 三、连线用三次贝塞尔连接，随节点位置连续变化。
 * 指针不做跟随装饰，不牵引连线形状；节点可拖动、画布可缩放平移。只在允许动效的档位启用。
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

  /* 漂浮：回中弹力、扰动幅度、阻尼与偏移上限，单位为画布百分比 */
  var SPRING = 3.6;
  var FORCE = 22;
  var DAMPING = 0.88;
  var OFFSET_LIMIT_PX = 34;

  /* 指针力场：半径按像素计，近旁节点被轻微吸引，并带一点沿指针运动方向的拖尾 */
  var POINTER_RADIUS = 180;
  var POINTER_ACCEL = 420;
  var VELOCITY_WEIGHT = 0.2;
  var VELOCITY_LIMIT = 700;

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
  var frameId = 0;
  var lastTime = 0;
  var lastApply = 0;
  var frameInterval = 1000 / 40;
  var drawThreshold = 0.25;
  var lastDrawn = null;

  var controller = typeof window.AbortController === 'function' ? new window.AbortController() : null;

  /* 统一注册监听器，停止时一次解绑 */
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

  var pointerPos = { x: 0, y: 0 };
  var pointerVel = { x: 0, y: 0 };
  var pointerStrength = 0;
  var pointerInside = false;
  var pointerOnNode = false;

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


  /* 每个节点的切线取前后两个邻点的连线方向，也就是曲线穿过该节点时的走向。
     相邻两条边在同一节点处的进出方向因此完全一致，四段边连成一条平滑的闭合曲线，
     节点移动时切线连续变化，形状不会翻转，也不会出现折角。前后邻点重合时退化为直线。 */
  function buildTangents() {
    var count = items.length;
    for (var i = 0; i < count; i += 1) {
      var self = items[i];
      var prev = items[(i + count - 1) % count];
      var next = items[(i + 1) % count];

      var tx = nodeX(next) - nodeX(prev);
      var ty = nodeY(next) - nodeY(prev);
      var length = Math.sqrt(tx * tx + ty * ty);

      if (length < 0.0001) {
        tx = nodeX(next) - nodeX(self);
        ty = nodeY(next) - nodeY(self);
        length = Math.sqrt(tx * tx + ty * ty);
      }

      if (length < 0.0001) {
        self.tx = 0;
        self.ty = 0;
      } else {
        self.tx = tx / length;
        self.ty = ty / length;
      }
    }
  }

  /* 连线用三次贝塞尔，控制点沿两端节点的切线方向偏移，曲率随节点位置连续变化 */
  function draw() {
    buildTangents();

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
      var offset = length * 0.3;

      var offA = a.tx !== 0 || a.ty !== 0 ? offset : 0;
      var offB = b.tx !== 0 || b.ty !== 0 ? offset : 0;
      var c1x = ax + a.tx * offA;
      var c1y = ay + a.ty * offA;
      var c2x = bx - b.tx * offB;
      var c2y = by - b.ty * offB;

      path.setAttribute('d',
        'M' + ax.toFixed(2) + ' ' + ay.toFixed(2) +
        ' C' + c1x.toFixed(2) + ' ' + c1y.toFixed(2) +
        ' ' + c2x.toFixed(2) + ' ' + c2y.toFixed(2) +
        ' ' + bx.toFixed(2) + ' ' + by.toFixed(2));
    }

    rememberDrawn();
  }

  /* 节点位移累计超过阈值才重绘连线，位移平缓时省去大量路径写入 */
  function needDraw() {
    if (!lastDrawn || lastDrawn.length !== items.length) {
      return true;
    }
    for (var i = 0; i < items.length; i += 1) {
      if (Math.abs(nodeX(items[i]) - lastDrawn[i][0]) > drawThreshold ||
          Math.abs(nodeY(items[i]) - lastDrawn[i][1]) > drawThreshold) {
        return true;
      }
    }
    return false;
  }

  function rememberDrawn() {
    lastDrawn = [];
    for (var i = 0; i < items.length; i += 1) {
      lastDrawn.push([nodeX(items[i]), nodeY(items[i])]);
    }
  }

  /* 每帧只写一次 transform，省去自定义属性解析带来的额外样式重算 */
  function applyOffset(item) {
    var x = ((item.ox / 100) * width).toFixed(2);
    var y = ((item.oy / 100) * height).toFixed(2);
    item.el.style.transform = 'translate(-50%, -50%) translate3d(' + x + 'px, ' + y + 'px, 0)';
  }

  function resetOffset(item) {
    item.ox = 0;
    item.oy = 0;
    item.vx = 0;
    item.vy = 0;
    applyOffset(item);
  }

  /* 指针力场：在像素空间计算距离与方向，再换算回百分比加速度 */
  function pointerForce(item, fx, fy) {
    if (pointerStrength < 0.01) {
      return;
    }

    var nodePx = ((item.baseX + item.ox) / 100) * width;
    var nodePy = ((item.baseY + item.oy) / 100) * height;
    var dx = pointerPos.x - nodePx;
    var dy = pointerPos.y - nodePy;
    var distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > POINTER_RADIUS) {
      return;
    }

    var falloff = 1 - distance / POINTER_RADIUS;
    var pull = falloff * falloff * POINTER_ACCEL * pointerStrength;

    if (distance > 0.5) {
      fx.v += ((dx / distance) * pull * 100) / width;
      fy.v += ((dy / distance) * pull * 100) / height;
    }

    var vx = clamp(pointerVel.x, -VELOCITY_LIMIT, VELOCITY_LIMIT);
    var vy = clamp(pointerVel.y, -VELOCITY_LIMIT, VELOCITY_LIMIT);
    fx.v += ((vx * VELOCITY_WEIGHT * falloff) * 100) / width;
    fy.v += ((vy * VELOCITY_WEIGHT * falloff) * 100) / height;
  }

  function tick(now) {
    frameId = 0;
    if (!enabled) {
      return;
    }

    /* 节点运动缓慢，按 40 帧上限更新，减少样式重算 */
    if (lastApply && now - lastApply < frameInterval) {
      schedule();
      return;
    }

    var dt = lastApply ? Math.min((now - lastApply) / 1000, 0.05) : 0.016;
    lastApply = now;
    lastTime = now;

    if (!paused) {
      var damp = Math.pow(DAMPING, dt * 60);
      var seconds = now / 1000;
      var target = pointerInside && !pointerOnNode && !pan ? 1 : 0;
      pointerStrength += (target - pointerStrength) * Math.min(1, dt * 8);

      for (var i = 0; i < items.length; i += 1) {
        var item = items[i];

        if (!(drag && drag.index === i)) {
          var amp = FORCE * item.amp;
          var force = { v: Math.sin(seconds / 4.5 + item.phase) * Math.cos(seconds / 9 + item.phase2) * amp };
          var forceY = { v: Math.cos(seconds / 5.5 + item.phase2) * Math.sin(seconds / 8.5 + item.phase) * amp };
          force.v -= item.ox * SPRING;
          forceY.v -= item.oy * SPRING;

          pointerForce(item, force, forceY);

          item.vx = (item.vx + force.v * dt) * damp;
          item.vy = (item.vy + forceY.v * dt) * damp;
          item.ox += item.vx * dt;
          item.oy += item.vy * dt;

          var limitX = (OFFSET_LIMIT_PX * 100) / width;
          var limitY = (OFFSET_LIMIT_PX * 100) / height;
          item.ox = clamp(item.ox, -limitX, limitX);
          item.oy = clamp(item.oy, -limitY, limitY);
          item.ox = clamp(item.ox, 3 - item.baseX, 97 - item.baseX);
          item.oy = clamp(item.oy, 3 - item.baseY, 97 - item.baseY);
        }

        applyOffset(item);
      }

      /* 指针速度按帧衰减，指针停止后推力随之消失 */
      pointerVel.x *= 0.9;
      pointerVel.y *= 0.9;

      if (needDraw()) {
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

  /* 基准位置：拖动与键盘微调共用，写入后清零漂浮偏移并重绘连线 */
  function setBasePosition(index, x, y) {
    var item = items[index];
    item.baseX = clamp(x, POSITION_MIN, POSITION_MAX);
    item.baseY = clamp(y, POSITION_MIN, POSITION_MAX);
    item.el.style.setProperty('--x', item.baseX.toFixed(2) + '%');
    item.el.style.setProperty('--y', item.baseY.toFixed(2) + '%');
    item.ox = 0;
    item.oy = 0;
    item.vx = 0;
    item.vy = 0;
    applyOffset(item);
    draw();
  }

  /* 复位：按 Home 键让当前节点回到初始位置，空白处双击或 Esc 复位全部节点 */
  function resetNodePosition(index) {
    var item = items[index];
    setBasePosition(index, item.homeX, item.homeY);
  }

  function resetAllNodes() {
    for (var i = 0; i < items.length; i += 1) {
      resetNodePosition(i);
    }
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
      items[drag.index].el.classList.add('is-dragging');
      canvas.setAttribute('data-dragging', 'true');
      setBasePosition(drag.index, drag.originX + (dx * 100) / width, drag.originY + (dy * 100) / height);
    }

    /* 拖动时浏览器不应把链接当作可拖拽元素，也不参与文本选择 */
    link.setAttribute('draggable', 'false');
    listen(link, 'dragstart', function (event) {
      event.preventDefault();
    });


    /* 键盘微调：方向键移动节点，按住 Shift 加快 */
    listen(link, 'keydown', function (event) {
      var step = event.shiftKey ? 4 : 1.5;
      var dx = 0;
      var dy = 0;
      var key = event.key;

      if (key === 'ArrowLeft' || event.keyCode === 37) {
        dx = -step;
      } else if (key === 'ArrowRight' || event.keyCode === 39) {
        dx = step;
      } else if (key === 'ArrowUp' || event.keyCode === 38) {
        dy = -step;
      } else if (key === 'ArrowDown' || event.keyCode === 40) {
        dy = step;
      } else if (key === 'Home' || event.keyCode === 36) {
        event.preventDefault();
        resetNodePosition(index);
        return;
      } else {
        return;
      }

      event.preventDefault();
      setBasePosition(index, items[index].baseX + dx, items[index].baseY + dy);
    });

    listen(link, 'pointerdown', onDown);
    listen(link, 'pointermove', onMove);
    listen(link, 'pointerup', finishDrag);
    listen(link, 'pointercancel', finishDrag);
    listen(link, 'click', function (event) {
      if (suppressClick) {
        event.preventDefault();
      }
    });

    listen(link, 'pointerenter', function () {
      // 指针停在节点上时不施加推力，保证节点稳定可点
      pointerOnNode = true;
      setFocus(index);
    });
    listen(link, 'pointerleave', function () {
      pointerOnNode = false;
      if (!drag) {
        setFocus(-1);
      }
    });
    listen(link, 'focus', function () {
      pointerOnNode = true;
      setFocus(index);
    });
    listen(link, 'blur', function () {
      pointerOnNode = false;
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
    /* 触摸在初始比例下不平移，避免与页面纵向滚动互相干扰 */
    if (event.pointerType === 'touch' && view.scale <= 1.001) {
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

  /* 指针位置换算到画布坐标系，并记录移动速度供力场使用 */
  function onCanvasMove(event) {
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

    var centerX = box.width / 2;
    var centerY = box.height / 2;
    var localX = (event.clientX - box.left - centerX - view.x) / view.scale + centerX;
    var localY = (event.clientY - box.top - centerY - view.y) / view.scale + centerY;

    if (pointerInside) {
      pointerVel.x += (localX - pointerPos.x) * 12;
      pointerVel.y += (localY - pointerPos.y) * 12;
    }

    pointerPos.x = localX;
    pointerPos.y = localY;
    pointerInside = true;
  }

  function onCanvasLeave() {
    pointerInside = false;
    pointerVel.x = 0;
    pointerVel.y = 0;
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
      lastApply = 0;
      lastTime = 0;
      schedule();
    }
  }

  /* 减少动态效果开启时终止漂浮与交互，节点回到基准位置 */
  function stop() {
    enabled = false;
    setFocus(-1);
    if (controller) {
      controller.abort();
    }
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
        homeX: readNumber(el, '--x', 50),
        homeY: readNumber(el, '--y', 50),
        ox: 0,
        oy: 0,
        vx: 0,
        vy: 0,
        tx: 0,
        ty: 0,
        phase: (i * 1.7) % 6.28,
        phase2: (i * 2.9 + 1.1) % 6.28,
        amp: 0.8 + (i % 4) * 0.13
      });
      if (link) {
        bindNode(link, i);
      }
    }
    measure();
    applyView();
    draw();
  }

  listen(canvas, 'pointerdown', onCanvasDown);
  listen(canvas, 'pointermove', onCanvasMove, { passive: true });
  listen(canvas, 'pointerleave', onCanvasLeave);
  listen(canvas, 'wheel', onWheel, { passive: false });
  listen(window, 'pointerup', finishPan, true);
  listen(window, 'pointercancel', finishPan, true);
  listen(window, 'pointerup', finishDrag, true);
  listen(window, 'pointercancel', finishDrag, true);

  listen(chart, 'keydown', function (event) {
    if (event.key === 'Escape' || event.keyCode === 27) {
      resetAllNodes();
      resetView();
    }
  });

  listen(canvas, 'dblclick', function (event) {
    event.preventDefault();
    resetAllNodes();
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
    listen(window, 'resize', function () {
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

  listen(document, 'visibilitychange', function () {
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
      listen(motionQuery, 'change', onMotionChange);
    } else if (typeof motionQuery.addListener === 'function') {
      motionQuery.addListener(onMotionChange);
    }
  }

  build();
  schedule();
})();