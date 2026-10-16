/* 浏览器核对用的 DevTools 协议客户端
 * 仅使用 Node 内置模块与全局 WebSocket，不引入依赖。Node 需要 22 以上。
 * 内核默认为 Chrome；环境变量 QI_BROWSER 可取 chrome、edge，或直接给出可执行文件地址。
 * 无头浏览器按环境需要加上 --no-sandbox，便于在受限账户下运行。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = {
  chrome: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
  ],
  edge: [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ]
};

/* 环境变量同时接受内核名称与可执行文件地址，便于在缺少常用安装位置的机器上运行 */
export function browserName() {
  const value = (process.env.QI_BROWSER || '').trim();
  if (value === 'edge' || value === 'chrome') {
    return value;
  }
  return 'chrome';
}

export function browserPath() {
  const value = (process.env.QI_BROWSER || '').trim();
  if (value && value !== 'edge' && value !== 'chrome' && fs.existsSync(value)) {
    return value;
  }
  for (const item of CANDIDATES[browserName()]) {
    if (fs.existsSync(item)) {
      return item;
    }
  }
  throw new Error('未找到 ' + browserName() + ' 浏览器可执行文件');
}

export async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qi-browser-'));
  const child = spawn(browserPath(), [
    '--headless=new',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--remote-allow-origins=*',
    '--hide-scrollbars',
    '--allow-file-access-from-files',
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const portFile = path.join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 25000;
  while (!fs.existsSync(portFile)) {
    if (child.exitCode !== null) {
      throw new Error('浏览器提前退出：' + stderr.slice(-400));
    }
    if (Date.now() > deadline) {
      try { child.kill(); } catch (error) { /* 忽略 */ }
      throw new Error('等待调试端口超时：' + stderr.slice(-400));
    }
    await sleep(100);
  }

  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
  return { child, profile, endpoint: 'http://127.0.0.1:' + port };
}

export async function shutdown(browser) {
  try { browser.child.kill(); } catch (error) { /* 忽略 */ }
  await sleep(400);
  try { fs.rmSync(browser.profile, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
}

export async function openPage(browser, url) {
  const res = await fetch(browser.endpoint + '/json/new?' + url, { method: 'PUT' });
  const target = await res.json();
  const client = await connect(target.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  return { targetId: target.id, client, browser };
}

export function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const listeners = [];
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          const id = ++seq;
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      on(handler) { listeners.push(handler); },
      close() { try { ws.close(); } catch (error) { /* 忽略 */ } }
    }));
    ws.addEventListener('error', () => reject(new Error('调试通道连接失败')));
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const slot = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) {
          slot.rej(new Error(JSON.stringify(msg.error)));
        } else {
          slot.res(msg.result);
        }
        return;
      }
      if (msg.method) {
        for (const listener of listeners) {
          listener(msg);
        }
      }
    });
  });
}

export function once(client, method, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 ' + method + ' 超时')), timeout || 15000);
    client.on((msg) => {
      if (msg.method === method) {
        clearTimeout(timer);
        resolve(msg.params);
      }
    });
  });
}

export async function navigate(client, url) {
  const loaded = once(client, 'Page.loadEventFired');
  await client.send('Page.navigate', { url });
  await loaded;
  await sleep(350);
}

export async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error('页面求值失败：' + JSON.stringify(result.exceptionDetails).slice(0, 500));
  }
  return result.result.value;
}

export async function setViewport(client, width, height) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width,
    height: height || 900,
    deviceScaleFactor: 1,
    mobile: width < 768
  });
}

export async function setReducedMotion(client, value) {
  await client.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value }]
  });
}

export async function setUserAgent(client, userAgent) {
  await client.send('Network.enable');
  await client.send('Network.setUserAgentOverride', { userAgent });
}

export async function closePage(page) {
  try { page.client.close(); } catch (error) { /* 忽略 */ }
  try {
    await fetch(page.browser.endpoint + '/json/close/' + page.targetId, { method: 'GET' });
  } catch (error) { /* 忽略 */ }
}

export function fileUrl(relPath) {
  return 'file:///' + relPath.replace(/\\/g, '/');
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
