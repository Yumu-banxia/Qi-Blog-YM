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

  function renderTheme(theme) {
    root.setAttribute('data-theme', theme);
    if (themeToggle) {
      themeToggle.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
    }
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
})();

