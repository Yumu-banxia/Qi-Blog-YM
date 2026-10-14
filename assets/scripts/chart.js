/* 站点星图的指针交互
 * 指针进入星图后充当引力源：连线朝指针方向弯曲，节点按各自深度位移，
 * 距离最近的节点转为活跃星，指针落点显示一枚跟随的观测星。
 * 只在允许动效的档位启用；指针静止且数值回位后停止逐帧更新。
 */
(function () {
  'use strict';

  var chart = document.querySelector('.star-chart');
  if (!chart) {
    return;
  }

  var Capability = window.Capability || null;
  if (!Capability || typeof Capability.allow !== 'function' || !Capability.allow('motion')) {
    return;
  }

  var svg = chart.querySelector('.chart-lines');
  var lines = svg ? svg.querySelectorAll('path') : [];
  if (!lines.length) {
    return;
  }

  var EASE = 0.18;
  var SETTLE = 0.004;
  var ACTIVE_RADIUS = 56;
  var PULL_RANGE = 70;
  var PULL_STRENGTH = 0.55;
  var EDGES = [[0, 1], [1, 2], [2, 3], [3, 0]];

  var NODES = [
    { x: 12, y: 18, depth: 0, el: chart.querySelector('.chart-node-home') },
    { x: 74, y: 14, depth: 0, el: chart.querySelector('.chart-node-posts') },
    { x: 86, y: 52, depth: 0, el: chart.querySelector('.chart-node-works') },
    { x: 36, y: 84, depth: 0, el: chart.querySelector('.chart-node-about') }
  ];

  var left = 0;
  var top = 0;
  var width = 1;
  var height = 1;
  var inside = false;
  var running = false;
  var visible = true;
  var enabled = true;
  var active = -1;

  var target = { nx: 0, ny: 0, x: 0, y: 0 };
  var current = { nx: 0, ny: 0, x: 0, y: 0 };

  /* 深度取自样式表中的 --depth，保证节点位移与连线端点用同一份数值 */
  function readDepth(node) {
    if (!node.el || !window.getComputedStyle) {
      return 0;
    }
    var value = parseFloat(window.getComputedStyle(node.el).getPropertyValue('--depth'));
    return isNaN(value) ? 0 : value;
  }

  function measure() {
    var box = chart.getBoundingClientRect();
    left = box.left;
    top = box.top;
    width = box.width || 1;
    height = box.height || 1;
    for (var i = 0; i < NODES.length; i += 1) {
      NODES[i].depth = readDepth(NODES[i]);
    }
  }

  function nodeX(index) {
    return NODES[index].x + (current.nx * NODES[index].depth * 100) / width;
  }

  function nodeY(index) {
    return NODES[index].y + (current.ny * NODES[index].depth * 100) / height;
  }

  function drawLines() {
    var sx = (current.x * 100) / width;
    var sy = (current.y * 100) / height;

    for (var i = 0; i < EDGES.length; i += 1) {
      var path = lines[i];
      if (!path) {
        continue;
      }

      var ax = nodeX(EDGES[i][0]);
      var ay = nodeY(EDGES[i][0]);
      var bx = nodeX(EDGES[i][1]);
      var by = nodeY(EDGES[i][1]);
      var mx = (ax + bx) / 2;
      var my = (ay + by) / 2;
      var dx = sx - mx;
      var dy = sy - my;
      var distance = Math.sqrt(dx * dx + dy * dy);
      var pull = 0;

      if (inside && distance < PULL_RANGE) {
        pull = (1 - distance / PULL_RANGE) * PULL_STRENGTH;
      }

      if (pull < 0.001) {
        path.setAttribute('d', 'M' + ax.toFixed(2) + ' ' + ay.toFixed(2) +
          ' L' + bx.toFixed(2) + ' ' + by.toFixed(2));
      } else {
        path.setAttribute('d', 'M' + ax.toFixed(2) + ' ' + ay.toFixed(2) +
          ' Q' + (mx + dx * pull).toFixed(2) + ' ' + (my + dy * pull).toFixed(2) +
          ' ' + bx.toFixed(2) + ' ' + by.toFixed(2));
      }
    }
  }

  function markActive(index) {
    if (active === index) {
      return;
    }
    active = index;

    for (var i = 0; i < NODES.length; i += 1) {
      if (!NODES[i].el) {
        continue;
      }
      if (i === index) {
        NODES[i].el.classList.add('is-active');
      } else {
        NODES[i].el.classList.remove('is-active');
      }
    }

    for (var j = 0; j < EDGES.length; j += 1) {
      var path = lines[j];
      if (!path) {
        continue;
      }
      var linked = index >= 0 && (EDGES[j][0] === index || EDGES[j][1] === index);
      if (linked) {
        path.classList.add('is-active');
      } else {
        path.classList.remove('is-active');
      }
    }
  }

  function pickNode() {
    if (!inside) {
      markActive(-1);
      return;
    }

    var best = -1;
    var bestDistance = ACTIVE_RADIUS;

    for (var i = 0; i < NODES.length; i += 1) {
      var dx = current.x - (NODES[i].x / 100) * width;
      var dy = current.y - (NODES[i].y / 100) * height;
      var distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }

    markActive(best);
  }

  function apply() {
    chart.style.setProperty('--nx', current.nx.toFixed(4));
    chart.style.setProperty('--ny', current.ny.toFixed(4));
    chart.style.setProperty('--px', (current.x - width / 2).toFixed(2) + 'px');
    chart.style.setProperty('--py', (current.y - height / 2).toFixed(2) + 'px');
    drawLines();
    pickNode();
  }

  function schedule() {
    if (running || !enabled || !visible) {
      return;
    }
    running = true;
    window.requestAnimationFrame(step);
  }

  function step() {
    running = false;
    if (!enabled) {
      return;
    }

    var keys = ['nx', 'ny', 'x', 'y'];
    var settled = true;

    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      var goal = target[key];
      var next = current[key] + (goal - current[key]) * EASE;
      var limit = (key === 'x' || key === 'y') ? 0.5 : SETTLE;
      if (Math.abs(goal - next) < limit) {
        next = goal;
      } else {
        settled = false;
      }
      current[key] = next;
    }

    apply();

    if (!settled) {
      schedule();
    }
  }

  function onMove(event) {
    if (!enabled) {
      return;
    }
    if (event.pointerType === 'touch' && event.buttons === 0) {
      return;
    }

    measure();

    var x = event.clientX - left;
    var y = event.clientY - top;

    target.x = x;
    target.y = y;
    target.nx = Math.max(-1, Math.min(1, (x / width) * 2 - 1));
    target.ny = Math.max(-1, Math.min(1, (y / height) * 2 - 1));
    inside = true;

    chart.setAttribute('data-pointer', 'on');
    schedule();
  }

  function onLeave() {
    if (!enabled) {
      return;
    }
    inside = false;
    target.nx = 0;
    target.ny = 0;
    chart.removeAttribute('data-pointer');
    schedule();
  }

  /* 减少动态效果在运行中开启时，撤销全部交互并回到静态星图 */
  function stop() {
    enabled = false;
    inside = false;
    active = -1;
    chart.removeAttribute('data-pointer');
    chart.style.removeProperty('--nx');
    chart.style.removeProperty('--ny');
    chart.style.removeProperty('--px');
    chart.style.removeProperty('--py');

    for (var i = 0; i < NODES.length; i += 1) {
      if (NODES[i].el) {
        NODES[i].el.classList.remove('is-active');
      }
    }
    for (var j = 0; j < lines.length; j += 1) {
      lines[j].classList.remove('is-active');
      lines[j].removeAttribute('d');
    }
  }

  chart.addEventListener('pointermove', onMove, { passive: true });
  chart.addEventListener('pointerleave', onLeave);
  chart.addEventListener('pointercancel', onLeave);

  if (typeof window.IntersectionObserver === 'function') {
    var observer = new window.IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (visible) {
        schedule();
      }
    }, { threshold: 0.2 });
    observer.observe(chart);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      enabled = false;
      return;
    }
    if (chart.style.getPropertyValue('--nx') === '' && !inside) {
      return;
    }
    enabled = true;
    schedule();
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

  measure();
})();