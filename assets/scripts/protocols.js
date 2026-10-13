/* 协议链接支持
 * 登记常见互联网方案，按浏览器可处理程度分类，统一处理跳转方式、
 * 安全属性以及不可用方案的提示与复制入口。
 */
(function () {
  'use strict';

  /* 分类说明，同时作为链接提示文本 */
  var KINDS = {
    web: { note: '' },
    native: { note: '交给系统关联的应用处理' },
    app: { note: '需要本机已安装对应客户端' },
    legacy: { note: '现代浏览器多已停用该协议' },
    p2p: { note: '需要专用客户端或网关' },
    crypto: { note: '需要钱包应用处理' },
    feed: { note: '订阅协议，通常交给阅读器处理' },
    altnet: { note: '需要专用客户端或代理访问' },
    unsafe: { note: '出于安全考虑，页面内已停用' },
    unknown: { note: '未登记的方案，浏览器可能无响应' }
  };

  /* 方案与分类登记表 */
  var LIST = [
    ['http', 'web'], ['https', 'web'],

    ['mailto', 'native'], ['tel', 'native'], ['sms', 'native'], ['smsto', 'native'],
    ['geo', 'native'], ['webcal', 'native'], ['callto', 'native'], ['facetime', 'native'],

    ['xmpp', 'app'], ['jabber', 'app'], ['irc', 'app'], ['ircs', 'app'],
    ['matrix', 'app'], ['sip', 'app'], ['sips', 'app'], ['skype', 'app'],
    ['tg', 'app'], ['whatsapp', 'app'], ['line', 'app'], ['threema', 'app'],
    ['weixin', 'app'], ['wecom', 'app'], ['dingtalk', 'app'], ['lark', 'app'],
    ['feishu', 'app'], ['tencent', 'app'], ['mqq', 'app'], ['qq', 'app'],
    ['discord', 'app'], ['slack', 'app'], ['zoommtg', 'app'], ['msteams', 'app'],
    ['alipay', 'app'], ['alipays', 'app'], ['taobao', 'app'], ['tm', 'app'],
    ['zhihu', 'app'], ['bilibili', 'app'], ['xhs', 'app'], ['douyin', 'app'],
    ['kuaishou', 'app'], ['sinaweibo', 'app'], ['steam', 'app'], ['epic', 'app'],
    ['market', 'app'], ['intent', 'app'], ['android-app', 'app'], ['itms-apps', 'app'],
    ['smtp', 'app'], ['pop', 'app'], ['pop3', 'app'], ['imap', 'app'],
    ['ldap', 'app'], ['ldaps', 'app'], ['ws', 'app'], ['wss', 'app'],
    ['view-source', 'app'], ['blob', 'app'], ['filesystem', 'app'],
    ['chrome', 'app'], ['resource', 'app'], ['moz-extension', 'app'],
    ['chrome-extension', 'app'], ['jar', 'app'],

    ['ftp', 'legacy'], ['ftps', 'legacy'], ['sftp', 'legacy'], ['tftp', 'legacy'],
    ['file', 'legacy'], ['gopher', 'legacy'], ['gophers', 'legacy'],
    ['finger', 'legacy'], ['wais', 'legacy'], ['whois', 'legacy'],
    ['telnet', 'legacy'], ['tn3270', 'legacy'], ['rlogin', 'legacy'], ['rsh', 'legacy'],
    ['archie', 'legacy'], ['veronica', 'legacy'], ['prospero', 'legacy'],
    ['z3950', 'legacy'], ['cddb', 'legacy'], ['daytime', 'legacy'], ['netstat', 'legacy'],
    ['nntp', 'legacy'], ['nntps', 'legacy'], ['news', 'legacy'],
    ['rtsp', 'legacy'], ['rtsps', 'legacy'], ['rtmp', 'legacy'], ['rtmps', 'legacy'],
    ['mms', 'legacy'], ['mmsh', 'legacy'], ['ssh', 'legacy'], ['nfs', 'legacy'],
    ['smb', 'legacy'], ['ntp', 'legacy'], ['dns', 'legacy'],

    ['magnet', 'p2p'], ['ed2k', 'p2p'], ['thunder', 'p2p'], ['torrent', 'p2p'],
    ['ipfs', 'p2p'], ['ipns', 'p2p'], ['dat', 'p2p'], ['hyper', 'p2p'],
    ['ssb', 'p2p'], ['onion', 'p2p'], ['i2p', 'p2p'], ['zeronet', 'p2p'],
    ['freenet', 'p2p'], ['sia', 'p2p'], ['ar', 'p2p'], ['bittorrent', 'p2p'],

    ['bitcoin', 'crypto'], ['bitcoincash', 'crypto'], ['ethereum', 'crypto'],
    ['lightning', 'crypto'], ['litecoin', 'crypto'], ['monero', 'crypto'],
    ['dogecoin', 'crypto'], ['nano', 'crypto'], ['solana', 'crypto'],

    ['feed', 'feed'], ['rss', 'feed'], ['atom', 'feed'], ['podcast', 'feed'],
    ['itpc', 'feed'], ['pcast', 'feed'], ['opml', 'feed'],

    ['gemini', 'altnet'], ['titan', 'altnet'], ['spartan', 'altnet'], ['nex', 'altnet'],
    ['scorpion', 'altnet'], ['molerat', 'altnet'], ['nostr', 'altnet'],
    ['acct', 'altnet'], ['at', 'altnet'],

    ['javascript', 'unsafe'], ['vbscript', 'unsafe'], ['data', 'unsafe']
  ];

  /* 需要额外标记与复制入口的分类 */
  var MARKED = {
    legacy: true,
    p2p: true,
    crypto: true,
    altnet: true,
    unknown: true
  };

  var REGISTRY = {};
  var index;

  for (index = 0; index < LIST.length; index += 1) {
    REGISTRY[LIST[index][0]] = { scheme: LIST[index][0], kind: LIST[index][1] };
  }

  function schemeOf(href) {
    var match = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/.exec(href || '');
    return match ? match[1].toLowerCase() : '';
  }

  function classify(href) {
    var scheme = schemeOf(href);
    if (!scheme) {
      return null;
    }

    var entry = REGISTRY[scheme];
    if (entry) {
      return { scheme: scheme, kind: entry.kind, note: KINDS[entry.kind].note };
    }

    if (/^web\+[a-z0-9]+$/.test(scheme)) {
      return { scheme: scheme, kind: 'app', note: '自定义协议，需本机注册处理程序' };
    }

    return { scheme: scheme, kind: 'unknown', note: KINDS.unknown.note };
  }

  function isExternal(url) {
    var match = /^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/([^\/?#]*)/.exec(url || '');
    if (!match) {
      return false;
    }
    if (typeof location === 'undefined' || !location.host) {
      return true;
    }
    return match[1].toLowerCase() !== location.host.toLowerCase();
  }

  var hasClipboard = typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === 'function';

  function writeClipboard(value, onDone) {
    if (hasClipboard) {
      navigator.clipboard.writeText(value).then(onDone, function () {
        legacyCopy(value, onDone);
      });
      return;
    }
    legacyCopy(value, onDone);
  }

  function legacyCopy(value, onDone) {
    var area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      onDone();
    } catch (error) {
      /* 复制不可用时保留地址文本 */
    }
    document.body.removeChild(area);
  }

  function appendMarker(link, info) {
    var raw = link.getAttribute('href') || '';
    var text = (link.textContent || '').replace(/^\s+|\s+$/g, '');
    var parent = link.parentNode;

    var tag = document.createElement('span');
    tag.className = 'protocol-tag';
    tag.setAttribute('aria-hidden', 'true');
    tag.textContent = info.scheme;
    parent.insertBefore(tag, link.nextSibling);

    var anchor = tag;

    if (text.indexOf(raw) === -1) {
      var address = document.createElement('code');
      address.className = 'protocol-address';
      address.textContent = raw;
      parent.insertBefore(address, anchor.nextSibling);
      anchor = address;
    }

    if (!hasClipboard && !document.queryCommandSupported) {
      return;
    }

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'protocol-copy';
    button.textContent = '复制';
    button.setAttribute('aria-label', '复制地址 ' + raw);
    button.addEventListener('click', function () {
      writeClipboard(raw, function () {
        button.textContent = '已复制';
        window.setTimeout(function () {
          button.textContent = '复制';
        }, 1500);
      });
    });
    parent.insertBefore(button, anchor.nextSibling);
  }

  function annotate(link, decorate) {
    var href = link.getAttribute('href') || '';

    if (!href || href.charAt(0) === '#' || href.charAt(0) === '?' || href.charAt(0) === '.') {
      return;
    }
    if (href.charAt(0) === '/' || href.indexOf('//') === 0) {
      return;
    }

    var info = classify(href);
    if (!info) {
      return;
    }

    link.setAttribute('data-scheme', info.scheme);
    link.setAttribute('data-scheme-kind', info.kind);

    if (info.kind === 'unsafe') {
      link.setAttribute('data-scheme-status', 'unsafe');
      link.removeAttribute('href');
      link.setAttribute('aria-disabled', 'true');
      link.setAttribute('tabindex', '-1');
      link.setAttribute('title', info.note);
      return;
    }

    link.setAttribute('data-scheme-status', info.kind);

    if (info.note) {
      link.setAttribute('title', info.note);
    }

    if (info.kind === 'web' && isExternal(link.href)) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    }

    if (decorate && MARKED[info.kind]) {
      appendMarker(link, info);
    }
  }

  function run() {
    var capability = window.Capability;
    var decorate = !capability || capability.tier !== 'minimal';
    var links = document.getElementsByTagName('a');

    for (var i = 0; i < links.length; i += 1) {
      annotate(links[i], decorate);
    }
  }

  window.Protocols = {
    kinds: KINDS,
    registry: REGISTRY,
    classify: classify,
    schemes: function () {
      var names = [];
      for (var name in REGISTRY) {
        if (Object.prototype.hasOwnProperty.call(REGISTRY, name)) {
          names.push(name);
        }
      }
      return names.sort();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();

