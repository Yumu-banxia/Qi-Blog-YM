/* 站点星图：节点独立漂浮，指针靠近时轻微吸引，连线随位置平滑变化。 */
(function () {
  'use strict';

  var chart = document.querySelector('.star-chart');
  var canvas = chart ? chart.querySelector('.chart-canvas') : null;
  if (!chart || !canvas) {
    return;
  }

  var Capability = window.Capability || null;
  if (!Capability || typeof Capability.allow !== 'function') {
    return;
  }
  /* 低端与功能机档位保持 HTML 静态星图；减少动态效果在运行中停用与恢复。 */
  if (Capability.tier !== 'high' && Capability.tier !== 'medium') {
    return;
  }

  /* 缺少指针事件接口时只保留漂浮与键盘操作 */
  var pointerInput = !Capability.env || Capability.env.pointerEvents === true;

  var lines = canvas.querySelectorAll('.chart-lines path');
  var nodeList = canvas.querySelectorAll('.chart-node');
  if (!lines.length || !nodeList.length) {
    return;
  }

  var EDGES = [[0, 1], [1, 2], [2, 3], [3, 0]];
  var DRAG_THRESHOLD = 4, POSITION_MIN = 6, POSITION_MAX = 94;
  var MIN_SCALE = 1, MAX_SCALE = 1.8, ZOOM_STEP = 0.14;
  /* 漂浮与指针力场参数，偏移量单位为画布百分比，距离单位为像素 */
  var SPRING = 3.6, FORCE = 22, DAMPING = 0.88, OFFSET_LIMIT_PX = 34;
  var POINTER_RADIUS = 180, POINTER_ACCEL = 420, VELOCITY_WEIGHT = 0.2, VELOCITY_LIMIT = 700;
  var DAMP_RATE = Math.log(DAMPING) * 60;

  var items = [], width = 1, height = 1, pctX = 100, pctY = 100;
  var enabled = true, paused = false, focusIndex = -1, suppressClick = false;
  var drag = null, pan = null, viewTarget = null, chartBox = null;
  var view = { scale: 1, x: 0, y: 0 };
  var frameId = 0, lastApply = 0, frameInterval = 25, drawThreshold = 0.25;
  var EASE_RESET = 0.14;
  var force = { v: 0, w: 0 };

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

  function readPosition(el) {
    if (!window.getComputedStyle) {
      return [50, 50];
    }
    var style = window.getComputedStyle(el);
    var x = parseFloat(style.getPropertyValue('--x'));
    var y = parseFloat(style.getPropertyValue('--y'));
    return [isNaN(x) ? 50 : x, isNaN(y) ? 50 : y];
  }

  function measure() {
    width = canvas.offsetWidth || 1;
    height = canvas.offsetHeight || 1;
    pctX = 100 / width;
    pctY = 100 / height;
    chartBox = null;
  }

  function r2(value) {
    return Math.round(value * 100) / 100;
  }

  /* 切线取前后邻点的连线方向，四段边因此连续；邻点重合时退化为直线。 */
  function buildTangents() {
    var count = items.length;
    for (var i = 0; i < count; i += 1) {
      var self = items[i];
      var prev = items[(i + count - 1) % count];
      var next = items[(i + 1) % count];

      var tx = next.px - prev.px;
      var ty = next.py - prev.py;
      var length = Math.sqrt(tx * tx + ty * ty);

      if (length < 0.0001) {
        tx = next.px - self.px;
        ty = next.py - self.py;
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

  /* 三次贝塞尔的控制点沿两端切线偏移，曲率随节点位置连续变化 */
  function draw() {
    buildTangents();
    for (var i = 0; i < EDGES.length; i += 1) {
      var path = lines[i];
      var a = items[EDGES[i][0]];
      var b = items[EDGES[i][1]];
      if (!path || !a || !b) {
        continue;
      }
      var ax = a.px, ay = a.py, bx = b.px, by = b.py;
      var dx = bx - ax;
      var dy = by - ay;
      var offset = (Math.sqrt(dx * dx + dy * dy) || 1) * 0.3;
      var offA = a.tx || a.ty ? offset : 0;
      var offB = b.tx || b.ty ? offset : 0;
      path.setAttribute('d',
        'M' + r2(ax) + ' ' + r2(ay) +
        ' C' + r2(ax + a.tx * offA) + ' ' + r2(ay + a.ty * offA) +
        ' ' + r2(bx - b.tx * offB) + ' ' + r2(by - b.ty * offB) +
        ' ' + r2(bx) + ' ' + r2(by));
    }
    for (i = 0; i < items.length; i += 1) {
      items[i].drawnX = items[i].px;
      items[i].drawnY = items[i].py;
    }
  }

  /* 位移超过阈值才重绘连线，平缓漂浮期间省去路径写入 */
  function needDraw() {
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      if (Math.abs(item.px - item.drawnX) > drawThreshold ||
          Math.abs(item.py - item.drawnY) > drawThreshold) {
        return true;
      }
    }
    return false;
  }

  /* 像素坐标统一在这里更新，连线与力场直接复用；位移未变时跳过样式写入 */
  function applyOffset(item) {
    item.px = (item.baseX + item.ox) * width * 0.01;
    item.py = (item.baseY + item.oy) * height * 0.01;
    var x = r2(item.ox * width * 0.01);
    var y = r2(item.oy * height * 0.01);
    if (x !== item.sx || y !== item.sy) {
      item.sx = x;
      item.sy = y;
      item.el.style.transform = 'translate(-50%, -50%) translate3d(' + x + 'px, ' + y + 'px, 0)';
    }
  }

  function resetOffset(item) {
    item.ox = 0;
    item.oy = 0;
    item.vx = 0;
    item.vy = 0;
    applyOffset(item);
  }

  /* 指针力场在像素空间计算距离与方向，再换算回百分比加速度 */
  function pointerForce(item) {
    if (pointerStrength < 0.01) {
      return;
    }
    var dx = pointerPos.x - item.px;
    var dy = pointerPos.y - item.py;
    var distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > POINTER_RADIUS) {
      return;
    }

    var falloff = 1 - distance / POINTER_RADIUS;
    var pull = falloff * falloff * POINTER_ACCEL * pointerStrength;

    if (distance > 0.5) {
      force.v += (dx / distance) * pull * pctX;
      force.w += (dy / distance) * pull * pctY;
    }

    var vx = clamp(pointerVel.x, -VELOCITY_LIMIT, VELOCITY_LIMIT);
    var vy = clamp(pointerVel.y, -VELOCITY_LIMIT, VELOCITY_LIMIT);
    force.v += vx * VELOCITY_WEIGHT * falloff * pctX;
    force.w += vy * VELOCITY_WEIGHT * falloff * pctY;
  }

  function tick(now) {
    frameId = 0;
    if (!enabled) {
      return;
    }

    /* 节点运动缓慢，按 40 帧上限更新 */
    if (lastApply && now - lastApply < frameInterval) {
      schedule();
      return;
    }

    var dt = lastApply ? Math.min((now - lastApply) / 1000, 0.05) : 0.016;
    lastApply = now;

    if (!paused) {
      var damp = Math.exp(DAMP_RATE * dt);
      var seconds = now * 0.001;
      var limitX = OFFSET_LIMIT_PX * pctX;
      var limitY = OFFSET_LIMIT_PX * pctY;
      var target = pointerInside && !pointerOnNode && !pan ? 1 : 0;
      pointerStrength += (target - pointerStrength) * Math.min(1, dt * 8);

      for (var i = 0; i < items.length; i += 1) {
        var item = items[i];

        if (item.resetting) {
          item.ox += (item.targetOx - item.ox) * EASE_RESET;
          item.oy += (item.targetOy - item.oy) * EASE_RESET;

          if (Math.abs(item.targetOx - item.ox) < 0.05 && Math.abs(item.targetOy - item.oy) < 0.05) {
            item.baseX = clamp(item.homeX, POSITION_MIN, POSITION_MAX);
            item.baseY = clamp(item.homeY, POSITION_MIN, POSITION_MAX);
            item.el.style.setProperty('--x', r2(item.baseX) + '%');
            item.el.style.setProperty('--y', r2(item.baseY) + '%');
            item.ox = 0;
            item.oy = 0;
            item.vx = 0;
            item.vy = 0;
            item.resetting = false;
          }
        } else if (!(drag && drag.index === i)) {
          var amp = FORCE * item.amp;
          force.v = Math.sin(seconds / 4.5 + item.phase) * Math.cos(seconds / 9 + item.phase2) * amp - item.ox * SPRING;
          force.w = Math.cos(seconds / 5.5 + item.phase2) * Math.sin(seconds / 8.5 + item.phase) * amp - item.oy * SPRING;
          pointerForce(item);

          item.vx = (item.vx + force.v * dt) * damp;
          item.vy = (item.vy + force.w * dt) * damp;
          item.ox += item.vx * dt;
          item.oy += item.vy * dt;

          item.ox = clamp(item.ox, -limitX, limitX);
          item.oy = clamp(item.oy, -limitY, limitY);
          item.ox = clamp(item.ox, 3 - item.baseX, 97 - item.baseX);
          item.oy = clamp(item.oy, 3 - item.baseY, 97 - item.baseY);
        }

        applyOffset(item);
      }

      if (viewTarget) {
        view.scale += (viewTarget.scale - view.scale) * 0.18;
        view.x += (viewTarget.x - view.x) * 0.18;
        view.y += (viewTarget.y - view.y) * 0.18;

        if (Math.abs(viewTarget.scale - view.scale) < 0.002 && Math.abs(viewTarget.x - view.x) < 0.5 && Math.abs(viewTarget.y - view.y) < 0.5) {
          view.scale = viewTarget.scale;
          view.x = viewTarget.x;
          view.y = viewTarget.y;
          viewTarget = null;
        }

        clampView();
        applyView();
      }

      /* 指针停止后推力随速度衰减 */
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

  /* 基准位置由拖动与键盘微调共用，写入后清零漂浮位移 */
  function setBasePosition(index, x, y) {
    var item = items[index];
    item.resetting = false;
    item.baseX = clamp(x, POSITION_MIN, POSITION_MAX);
    item.baseY = clamp(y, POSITION_MIN, POSITION_MAX);
    item.el.style.setProperty('--x', r2(item.baseX) + '%');
    item.el.style.setProperty('--y', r2(item.baseY) + '%');
    item.ox = 0;
    item.oy = 0;
    item.vx = 0;
    item.vy = 0;
    applyOffset(item);
    /* 拖动期间把连线交给动画帧，避免每个 pointermove 都同步重排 SVG 路径 */
    if (enabled) {
      schedule();
    } else {
      draw();
    }
  }

  /* 复位带缓动，动画结束时把位移提交到布局位置；已在原位时直接落位 */
  function resetNodePosition(index) {
    var item = items[index];
    var offsetX = item.homeX - item.baseX;
    var offsetY = item.homeY - item.baseY;

    if (!enabled) {
      setBasePosition(index, item.homeX, item.homeY);
      return;
    }
    if (Math.abs(offsetX) < 0.2 && Math.abs(offsetY) < 0.2 && Math.abs(item.ox) < 0.2 && Math.abs(item.oy) < 0.2) {
      setBasePosition(index, item.homeX, item.homeY);
      return;
    }

    item.resetting = true;
    item.targetOx = offsetX;
    item.targetOy = offsetY;
    item.vx = 0;
    item.vy = 0;
    schedule();
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
      /* 节点拖动由本模块处理，阻止事件到达画布平移 */
      event.stopPropagation();
      items[index].resetting = false;
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

      if (!drag.moved) {
        drag.moved = true;
        items[drag.index].el.classList.add('is-dragging');
        canvas.setAttribute('data-dragging', 'true');
      }
      setBasePosition(drag.index, drag.originX + (dx * 100) / width, drag.originY + (dy * 100) / height);
    }

    /* 链接不参与浏览器拖拽与文本选择 */
    link.setAttribute('draggable', 'false');
    listen(link, 'dragstart', function (event) {
      event.preventDefault();
    });


    /* 方向键微调，Shift 加速，Home 复位 */
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

    if (pointerInput) {
      listen(link, 'pointerdown', onDown);
      listen(link, 'pointermove', onMove);
      listen(link, 'pointerup', finishDrag);
      listen(link, 'pointercancel', finishDrag);
    }

    listen(link, 'click', function (event) {
      if (suppressClick) {
        event.preventDefault();
      }
    });

    if (pointerInput) {
      listen(link, 'pointerenter', function () {
        /* 指针停在节点上时不施加推力 */
        pointerOnNode = true;
        setFocus(index);
      });
      listen(link, 'pointerleave', function () {
        pointerOnNode = false;
        if (!drag) {
          setFocus(-1);
        }
      });
    }
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
    var box = chartBox || (chartBox = chart.getBoundingClientRect());
    var px = clientX - box.left - box.width / 2;
    var py = clientY - box.top - box.height / 2;
    var ratio = scale / view.scale;
    view.x = px - (px - view.x) * ratio;
    view.y = py - (py - view.y) * ratio;
    view.scale = scale;
    clampView();
    applyView();
  }

  /* 视图复位带缓动；已在初始状态时直接落位 */
  function resetView() {
    if (!enabled || (Math.abs(view.scale - 1) < 0.001 && Math.abs(view.x) < 0.5 && Math.abs(view.y) < 0.5)) {
      view.scale = 1;
      view.x = 0;
      view.y = 0;
      viewTarget = null;
      applyView();
      return;
    }
    viewTarget = { scale: 1, x: 0, y: 0 };
    schedule();
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
    /* 初始比例下触摸不平移，避免与页面滚动冲突 */
    if (event.pointerType === 'touch' && view.scale <= 1.001) {
      return;
    }
    viewTarget = null;
    pan = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y
    };
    canvas.setAttribute('data-dragging', 'true');
    if (typeof canvas.setPointerCapture === 'function') {
      canvas.setPointerCapture(event.pointerId);
    }
  }

  /* 指针位置换算到画布坐标，并记录移动速度 */
  function onCanvasMove(event) {
    if (!enabled || paused) {
      return;
    }

    if (pan && pan.pointerId === event.pointerId) {
      view.x = pan.originX + (event.clientX - pan.startX);
      view.y = pan.originY + (event.clientY - pan.startY);
      clampView();
      applyView();
      return;
    }

    if (drag) {
      return;
    }

    var box = chartBox || (chartBox = chart.getBoundingClientRect());
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
    viewTarget = null;
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
      schedule();
    }
  }

  /* 停止漂浮与交互并回到静态形态；监听器保留，处理函数按 enabled 返回 */
  function stop() {
    if (!enabled) {
      return;
    }
    enabled = false;
    drag = null;
    pan = null;
    viewTarget = null;
    pointerInside = false;
    pointerOnNode = false;
    pointerStrength = 0;
    pointerVel.x = 0;
    pointerVel.y = 0;
    setFocus(-1);
    if (frameId) {
      window.cancelAnimationFrame(frameId);
      frameId = 0;
    }
    lastApply = 0;
    for (var i = 0; i < items.length; i += 1) {
      resetOffset(items[i]);
      items[i].el.classList.remove('is-dragging');
    }
    canvas.removeAttribute('data-dragging');
    view.scale = 1;
    view.x = 0;
    view.y = 0;
    canvas.style.removeProperty('transform');
    draw();
  }

  /* 系统偏好恢复为允许动效时重新启用漂浮与交互 */
  function start() {
    if (enabled) {
      return;
    }
    enabled = true;
    lastApply = 0;
    pointerStrength = 0;
    schedule();
  }

  function build() {
    var pos;
    for (var i = 0; i < nodeList.length; i += 1) {
      var el = nodeList[i];
      var link = el.querySelector('a');
      pos = readPosition(el);
      items.push({
        el: el,
        baseX: pos[0], baseY: pos[1], homeX: pos[0], homeY: pos[1],
        ox: 0, oy: 0, vx: 0, vy: 0, tx: 0, ty: 0,
        px: 0, py: 0, sx: null, sy: null, drawnX: 0, drawnY: 0,
        resetting: false,
        targetOx: 0,
        targetOy: 0,
        phase: (i * 1.7) % 6.28,
        phase2: (i * 2.9 + 1.1) % 6.28,
        amp: 0.8 + (i % 4) * 0.13
      });
      if (link) {
        bindNode(link, i);
      }
    }
    measure();
    for (i = 0; i < items.length; i += 1) {
      applyOffset(items[i]);
    }
    applyView();
    draw();
  }

  /* 画布尺寸变化后同步像素坐标、视图边界与连线 */
  function layout() {
    measure();
    for (var i = 0; i < items.length; i += 1) {
      applyOffset(items[i]);
    }
    clampView();
    applyView();
    draw();
  }

  if (pointerInput) {
    listen(canvas, 'pointerdown', onCanvasDown);
    listen(canvas, 'pointermove', onCanvasMove, { passive: true });
    listen(canvas, 'pointerleave', onCanvasLeave);
    listen(canvas, 'pointerenter', function () {
      chartBox = null;
    });
    listen(window, 'pointerup', finishPan, true);
    listen(window, 'pointercancel', finishPan, true);
    listen(window, 'pointerup', finishDrag, true);
    listen(window, 'pointercancel', finishDrag, true);
  }

  listen(window, 'scroll', function () {
    chartBox = null;
  }, { passive: true });

  listen(canvas, 'wheel', onWheel, { passive: false });

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
      /* 动效关闭时位置与视图已静止，无需重算 */
      if (!enabled) {
        return;
      }
      layout();
    });
    observer.observe(canvas);
  } else {
    listen(window, 'resize', function () {
      if (!enabled) {
        return;
      }
      layout();
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
      } else {
        start();
      }
    };
    if (typeof motionQuery.addEventListener === 'function') {
      listen(motionQuery, 'change', onMotionChange);
    } else if (typeof motionQuery.addListener === 'function') {
      motionQuery.addListener(onMotionChange);
    }
  }

  build();

  if (Capability.reducedMotion) {
    /* 载入时即减少动态效果：先呈现静态，偏好恢复后再启用 */
    stop();
  } else {
    schedule();
  }
})();
