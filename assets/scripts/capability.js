/* 设备能力分级
 * 依据 User-Agent、硬件线索与运行时 API 可用性划分档位，结果写入 data-cap，
 * 供 CSS 与后续模块决定高开销项的加载。本文件在 <head> 中同步执行，
 * 需要在功能机上保持可解析，因此使用 ES3 语法。
 */
(function () {
  'use strict';

  var root = document.documentElement;
  var nav = typeof navigator === 'undefined' ? {} : navigator;
  var ua = nav.userAgent || '';

  /* 功能机与老式移动浏览器的特征片段 */
  var LEGACY_PATTERN = /(MIDP|CLDC|J2ME|Symbian|Series60|Series40|Nokia|SonyEricsson|Ericsson|BlackBerry|BB10|Windows Phone|IEMobile|Palm|webOS|Opera Mini|Opera Mobi|NetFront|DoCoMo|KDDI|UP\.Browser|POLARIS)/i;
  /* 现代内核，但硬件或网络条件受限的机型 */
  var CONSTRAINED_PATTERN = /(Android [0-4]\.|Android 5\.[01]|Silk|Kindle|UCBrowser|Quark|MQQBrowser|MiuiBrowser|BaiduBrowser|MIUI|Trident)/i;

  function queryMatches(query) {
    return typeof window.matchMedia === 'function' && window.matchMedia(query).matches === true;
  }

  function cssSupports(rule) {
    return typeof window.CSS !== 'undefined' &&
      typeof window.CSS.supports === 'function' &&
      window.CSS.supports(rule) === true;
  }

  /* 核心运行时：任一项缺失，脚本的增强部分都无从成立，判为最低档 */
  var coreRuntime = {
    querySelector: typeof document.querySelector === 'function',
    events: typeof window.addEventListener === 'function',
    customProperties: cssSupports('--probe: 0'),
    matchMedia: typeof window.matchMedia === 'function',
    animationFrame: typeof window.requestAnimationFrame === 'function'
  };

  var missingCore = '';
  for (var coreKey in coreRuntime) {
    if (Object.prototype.hasOwnProperty.call(coreRuntime, coreKey) && coreRuntime[coreKey] !== true) {
      missingCore = coreKey;
      break;
    }
  }

  /* 非核心接口：缺失时只关闭对应增强，不改变档位。
     intersectionObserver 供滚动出现与星图暂停使用；resizeObserver 供星图重新量取尺寸使用；
     pointerEvents 供星图的指针交互使用，缺失时键盘微调与漂浮仍可用。 */
  var env = {
    intersectionObserver: typeof window.IntersectionObserver === 'function',
    resizeObserver: typeof window.ResizeObserver === 'function',
    pointerEvents: typeof window.PointerEvent === 'function'
  };

  var cores = nav.hardwareConcurrency || 0;
  var memory = nav.deviceMemory || 0;
  var connection = nav.connection || null;
  var saveData = Boolean(connection && connection.saveData);
  var slowNetwork = Boolean(connection && /(slow-)?2g$/i.test(connection.effectiveType || ''));
  var prefersReducedMotion = queryMatches('(prefers-reduced-motion: reduce)');
  var motionQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var legacyUA = LEGACY_PATTERN.test(ua);

  var tier = 'medium';
  var reason = 'baseline';

  if (legacyUA || missingCore) {
    tier = 'minimal';
    reason = legacyUA ? 'legacy-ua' : 'limited-runtime';
  } else if (CONSTRAINED_PATTERN.test(ua)) {
    tier = 'low';
    reason = 'constrained-ua';
  } else if (saveData || slowNetwork) {
    tier = 'low';
    reason = 'network';
  } else if ((cores > 0 && cores <= 2) || (memory > 0 && memory <= 1)) {
    tier = 'low';
    reason = 'hardware';
  } else if (cores >= 8 && memory >= 4 && !prefersReducedMotion) {
    tier = 'high';
    reason = 'ample';
  }

  /* 各档位允许加载的高开销项 */
  var features = {
    motion: (tier === 'high' || tier === 'medium') && !prefersReducedMotion,
    optionalScripts: tier === 'high' || tier === 'medium'
  };

  root.setAttribute('data-cap', tier);
  root.setAttribute('data-cap-reason', reason);

  var rootClasses = 'has-js';
  if (env.intersectionObserver) {
    rootClasses += ' has-observer';
  }
  root.className = root.className ? root.className + ' ' + rootClasses : rootClasses;

  if (!features.motion) {
    root.setAttribute('data-motion', 'reduced');
  }

  /* 首屏主题解析，避免明暗切换时的闪烁 */
  var theme = queryMatches('(prefers-color-scheme: dark)') ? 'dark' : 'light';
  try {
    var stored = window.localStorage.getItem('theme');
    if (stored === 'light' || stored === 'dark') {
      theme = stored;
    }
  } catch (error) {
    /* 存储不可用时沿用系统偏好 */
  }
  root.setAttribute('data-theme', theme);

  function head() {
    return document.head || document.getElementsByTagName('head')[0];
  }

  function scriptBase() {
    var current = document.currentScript;
    var scripts = document.getElementsByTagName('script');
    var source = (current && current.src) ? current.src : (scripts.length ? scripts[scripts.length - 1].src : '');
    var match = /^(.*)assets\/scripts\/capability\.js/.exec(source);
    if (match) {
      return match[1];
    }
    /* 无法从脚本地址推导时退回文档地址，pages/ 下的页面需要上溯一层 */
    var base = document.baseURI || '';
    if (!base) {
      return '';
    }
    return base.indexOf('/pages/') !== -1 ? base.replace(/pages\/[^/]*$/, '') : base.replace(/[^/]*$/, '');
  }

  /* 超低端设备改挂兜底样式表，规避弹性布局与自定义属性缺失导致的排版错乱 */
  if (tier === 'minimal') {
    var lite = document.createElement('link');
    lite.rel = 'stylesheet';
    lite.href = scriptBase() + 'assets/styles/lite.css';
    head().appendChild(lite);
  }

  var capability = {
    tier: tier,
    reason: reason,
    env: env,
    features: features,
    reducedMotion: prefersReducedMotion,
    saveData: saveData,
    allow: function (name) {
      return features[name] === true;
    },
    setTheme: function (next) {
      theme = next;
      root.setAttribute('data-theme', next);
      try {
        window.localStorage.setItem('theme', next);
      } catch (error) {
        /* 存储不可用时仅保留当前会话状态 */
      }
    }
  };

  window.Capability = capability;

  /* 系统偏好可能在页面运行期间变化，同步能力状态与全局动效样式。 */
  if (motionQuery) {
    var onMotionChange = function (event) {
      prefersReducedMotion = event.matches === true;
      capability.reducedMotion = prefersReducedMotion;
      features.motion = (tier === 'high' || tier === 'medium') && !prefersReducedMotion;
      if (features.motion) {
        root.removeAttribute('data-motion');
      } else {
        root.setAttribute('data-motion', 'reduced');
      }
    };

    if (typeof motionQuery.addEventListener === 'function') {
      motionQuery.addEventListener('change', onMotionChange);
    } else if (typeof motionQuery.addListener === 'function') {
      motionQuery.addListener(onMotionChange);
    }
  }
})();

