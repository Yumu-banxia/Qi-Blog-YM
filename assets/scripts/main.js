(function () {
  'use strict';

  var root = document.documentElement;
  var capability = window.Capability || null;
  var STORAGE_KEY = 'theme';

  function readStoredTheme() {
    try {
      var value = window.localStorage.getItem(STORAGE_KEY);
      return value === 'light' || value === 'dark' ? value : null;
    } catch (error) {
      return null;
    }
  }

  function writeStoredTheme(theme) {
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch (error) {
      /* 存储不可用时仅保留当前会话的主题状态 */
    }
  }

  function systemTheme() {
    if (!window.matchMedia) {
      return 'light';
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  var themeToggle = document.querySelector('.theme-toggle');
  var themeColorMeta = document.querySelector('meta[name="theme-color"]');

  /* 同步移动端浏览器界面的底色，避免地址栏与页面底色不一致 */
  function syncThemeColor() {
    if (!themeColorMeta || !window.getComputedStyle) {
      return;
    }
    var value = window.getComputedStyle(root).getPropertyValue('--color-bg');
    value = value ? value.replace(/^\s+|\s+$/g, '') : '';
    if (value) {
      themeColorMeta.setAttribute('content', value);
    }
  }

  function renderTheme(theme) {
    root.setAttribute('data-theme', theme);
    if (themeToggle) {
      themeToggle.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
    }
    syncThemeColor();
  }

  function persistTheme(theme) {
    if (capability && typeof capability.setTheme === 'function') {
      capability.setTheme(theme);
      return;
    }
    writeStoredTheme(theme);
  }

  /* capability.js 已在首屏解析主题，脚本缺失时在此兜底 */
  var resolvedTheme = root.getAttribute('data-theme');
  if (resolvedTheme !== 'light' && resolvedTheme !== 'dark') {
    resolvedTheme = readStoredTheme() || systemTheme();
  }
  renderTheme(resolvedTheme);

  if (themeToggle) {
    themeToggle.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      persistTheme(next);
      renderTheme(next);
    });
  }

  var darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function handleSystemThemeChange() {
    if (!readStoredTheme()) {
      renderTheme(systemTheme());
    }
  }

  if (darkQuery && typeof darkQuery.addEventListener === 'function') {
    darkQuery.addEventListener('change', handleSystemThemeChange);
  } else if (darkQuery && typeof darkQuery.addListener === 'function') {
    darkQuery.addListener(handleSystemThemeChange);
  }

  var navToggle = document.querySelector('.nav-toggle');
  var siteNav = document.getElementById('site-nav');

  function setNavOpen(open) {
    if (!navToggle || !siteNav) {
      return;
    }
    navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      siteNav.setAttribute('data-open', 'true');
    } else {
      siteNav.removeAttribute('data-open');
    }
  }

  function isNavOpen() {
    return Boolean(navToggle) && navToggle.getAttribute('aria-expanded') === 'true';
  }

  if (navToggle && siteNav) {
    navToggle.addEventListener('click', function () {
      setNavOpen(!isNavOpen());
    });

    siteNav.addEventListener('click', function (event) {
      if (event.target.closest && event.target.closest('a')) {
        setNavOpen(false);
      }
    });

    document.addEventListener('keydown', function (event) {
      if ((event.key === 'Escape' || event.keyCode === 27) && isNavOpen()) {
        setNavOpen(false);
        navToggle.focus();
      }
    });

    document.addEventListener('click', function (event) {
      if (!isNavOpen()) {
        return;
      }
      if (!siteNav.contains(event.target) && !navToggle.contains(event.target)) {
        setNavOpen(false);
      }
    });
  }

  var yearSlots = document.querySelectorAll('[data-year]');
  var currentYear = String(new Date().getFullYear());

  for (var index = 0; index < yearSlots.length; index += 1) {
    yearSlots[index].textContent = currentYear;
  }

  /* 滚动出现：设备允许动效且浏览器具备观察器时启用 */
  var motionAllowed = !capability || capability.allow('motion');
  var revealTargets = document.querySelectorAll('[data-reveal]');

  function revealElement(node) {
    /* 同一列表内的条目按顺序错开出现，避免整页条目同时位移 */
    var parent = node.parentNode;
    var delay = 0;
    if (parent && parent.children && node.style) {
      for (var order = 0; order < parent.children.length; order += 1) {
        if (parent.children[order] === node) {
          delay = Math.min(order * 70, 210);
          break;
        }
      }
      if (delay) {
        node.style.transitionDelay = delay + 'ms';
      }
    }
    if (node.classList) {
      node.classList.add('is-revealed');
      return;
    }
    if (!node.className || node.className.indexOf('is-revealed') === -1) {
      node.className = node.className ? node.className + ' is-revealed' : 'is-revealed';
    }
  }

  if (motionAllowed && revealTargets.length && typeof window.IntersectionObserver === 'function') {
    var revealObserver = new window.IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i += 1) {
        if (entries[i].isIntersecting) {
          revealElement(entries[i].target);
          revealObserver.unobserve(entries[i].target);
        }
      }
    }, { rootMargin: '0px 0px -2% 0px', threshold: 0.05 });

    for (var target = 0; target < revealTargets.length; target += 1) {
      revealObserver.observe(revealTargets[target]);
    }

    /* 键盘聚焦时立即显示，避免焦点落在未入场的内容上 */
    document.addEventListener('focusin', function (event) {
      var node = event.target;
      while (node && node.getAttribute) {
        if (node.getAttribute('data-reveal') !== null) {
          revealElement(node);
          return;
        }
        node = node.parentNode;
      }
    });
  }
})();

