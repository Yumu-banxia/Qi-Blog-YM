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

  function canUseCanvas() {
    try {
      return Boolean(document.createElement('canvas').getContext);
    } catch (error) {
      return false;
    }
  }

  var env = {
    customProperties: cssSupports('--probe: 0'),
    matchMedia: typeof window.matchMedia === 'function',
    animationFrame: typeof window.requestAnimationFrame === 'function',
    intersectionObserver: typeof window.IntersectionObserver === 'function',
    blur: cssSupports('backdrop-filter: blur(1px)') || cssSupports('-webkit-backdrop-filter: blur(1px)'),
    canvas: canUseCanvas()
  };

  var cores = nav.hardwareConcurrency || 0;
  var memory = nav.deviceMemory || 0;
  var connection = nav.connection || null;
  var saveData = Boolean(connection && connection.saveData);
  var slowNetwork = Boolean(connection && /(slow-)?2g$/i.test(connection.effectiveType || ''));
  var prefersReducedMotion = queryMatches('(prefers-reduced-motion: reduce)');
  var legacyUA = LEGACY_PATTERN.test(ua);

  var tier = 'medium';
  var reason = 'baseline';

  if (legacyUA || !env.customProperties || !env.matchMedia || !env.animationFrame) {
    tier = 'minimal';
    reason = legacyUA ? 'legacy-ua' : 'limited-runtime';
  } else if (CONSTRAINED_PATTERN.test(ua) || (cores > 0 && cores <= 2) || (memory > 0 && memory <= 1) || saveData || slowNetwork) {
    tier = 'low';
    reason = (saveData || slowNetwork) ? 'network' : 'hardware';
  } else if (cores >= 8 && memory >= 4 && !prefersReducedMotion) {
    tier = 'high';
    reason = 'ample';
  }

  /* 各档位允许加载的高开销项 */
  var features = {
    effects: tier === 'high' || tier === 'medium',
    motion: (tier === 'high' || tier === 'medium') && !prefersReducedMotion,
    blur: env.blur && (tier === 'high' || tier === 'medium'),
    smoothScroll: tier === 'high' || tier === 'medium',
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
    return match ? match[1] : '';
  }

  /* 超低端设备改挂兜底样式表，规避弹性布局与自定义属性缺失导致的排版错乱 */
  if (tier === 'minimal') {
    var lite = document.createElement('link');
    lite.rel = 'stylesheet';
    lite.href = scriptBase() + 'assets/styles/lite.css';
    head().appendChild(lite);
  }

  window.Capability = {
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
    },
    load: function (name, src, onload) {
      if (features[name] !== true) {
        return false;
      }
      var script = document.createElement('script');
      script.src = src;
      script.async = true;
      if (typeof onload === 'function') {
        script.onload = onload;
      }
      head().appendChild(script);
      return true;
    }
  };
})();

