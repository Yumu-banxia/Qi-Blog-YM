/* Firefox 核对用的 Marionette 客户端
 * 仅使用 Node 内置模块，不引入依赖。Firefox 自 141 起不再提供 DevTools 协议接口，
 * 因此改用 WebDriver 的 Marionette 通道。环境变量 QI_FIREFOX 可指定 firefox 可执行文件地址。
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  'C:/Program Files/Mozilla Firefox/firefox.exe',
  'C:/Program Files (x86)/Mozilla Firefox/firefox.exe'
];

/* 关闭首次运行、遥测与更新提示，令无头实例的启动时间保持稳定 */
const BASE_PREFS = {
  'browser.shell.checkDefaultBrowser': false,
  'browser.startup.homepage_override.mstone': 'ignore',
  'browser.sessionstore.resume_from_crash': false,
  'datareporting.policy.dataSubmissionEnabled': false,
  'datareporting.healthreport.uploadEnabled': false,
  'toolkit.telemetry.enabled': false,
  'toolkit.telemetry.unified': false,
  'app.update.auto': false,
  'extensions.update.enabled': false,
  'marionette.enabled': true
};

export function firefoxPath() {
  const value = (process.env.QI_FIREFOX || '').trim();
  if (value && fs.existsSync(value)) {
    return value;
  }
  for (const item of CANDIDATES) {
    if (fs.existsSync(item)) {
      return item;
    }
  }
  throw new Error('未找到 Firefox 可执行文件');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function writePrefs(profile, prefs) {
  const lines = Object.keys(prefs).map((key) => 'user_pref("' + key + '", ' + JSON.stringify(prefs[key]) + ');');
  fs.writeFileSync(path.join(profile, 'user.js'), lines.join('\n') + '\n', 'utf8');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitPort(port, timeout) {
  const deadline = Date.now() + (timeout || 40000);
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (open) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

/* Marionette 的报文格式为「长度:JSON」，长度按 UTF-8 字节数计算 */
function frame(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return Buffer.concat([Buffer.from(body.length + ':', 'ascii'), body]);
}

export async function launchFirefox(options) {
  const settings = options || {};
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qi-firefox-'));
  writePrefs(profile, Object.assign({}, BASE_PREFS, settings.prefs || {}, { 'marionette.port': port }));

  const args = ['-no-remote', '-new-instance', '-profile', profile, '-marionette'];
  if (settings.headless !== false) {
    args.push('-headless');
  }
  args.push('about:blank');

  const child = spawn(firefoxPath(), args, {
    env: Object.assign({}, process.env, { MOZ_HEADLESS: settings.headless === false ? '' : '1' }),
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  if (!(await waitPort(port, settings.timeout))) {
    try { child.kill(); } catch (error) { /* 忽略 */ }
    throw new Error('等待 Marionette 端口超时：' + stderr.slice(-400));
  }

  const client = await connect(port);
  const browser = { child, profile, port, client, stderr: () => stderr };
  await client.send('WebDriver:NewSession', { capabilities: { alwaysMatch: {} } });
  return browser;
}

export function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buffer = Buffer.alloc(0);
    let handshake = false;
    let seq = 0;
    const pending = new Map();
    const waiters = [];
    const inbox = [];

    function deliver(message) {
      if (!handshake) {
        handshake = true;
        return;
      }
      /* 命令应答为 [1, id, error, result]，事件为 [2, name, params] */
      const id = message[1];
      if (message[0] === 1 && pending.has(id)) {
        const slot = pending.get(id);
        pending.delete(id);
        if (message[2]) {
          slot.reject(new Error(JSON.stringify(message[2]).slice(0, 300)));
        } else {
          slot.resolve(message[3]);
        }
        return;
      }
      const waiter = waiters.shift();
      if (waiter) {
        waiter(message);
      } else {
        inbox.push(message);
      }
    }

    function read() {
      for (;;) {
        const index = buffer.indexOf(0x3a);
        if (index < 0) {
          return;
        }
        const length = Number(buffer.subarray(0, index).toString('ascii'));
        if (!Number.isFinite(length)) {
          reject(new Error('Marionette 报文长度异常'));
          return;
        }
        if (buffer.length < index + 1 + length) {
          return;
        }
        const text = buffer.subarray(index + 1, index + 1 + length).toString('utf8');
        buffer = buffer.subarray(index + 1 + length);
        deliver(JSON.parse(text));
      }
    }

    socket.once('connect', () => resolve({
      send(name, params) {
        return new Promise((res, rej) => {
          const id = ++seq;
          pending.set(id, { resolve: res, reject: rej });
          socket.write(frame([0, id, name, params || {}]));
        });
      },
      next() {
        return new Promise((res) => {
          if (inbox.length) {
            res(inbox.shift());
            return;
          }
          waiters.push(res);
        });
      },
      port,
      close() {
        try { socket.destroy(); } catch (error) { /* 忽略 */ }
      }
    }));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      read();
    });
    socket.once('error', () => reject(new Error('Marionette 通道连接失败')));
  });
}

export async function shutdownFirefox(browser) {
  try {
    await browser.client.send('WebDriver:DeleteSession', {});
  } catch (error) {
    /* 会话已结束时忽略 */
  }
  try { browser.client.close(); } catch (error) { /* 忽略 */ }
  try { browser.child.kill(); } catch (error) { /* 忽略 */ }
  await sleep(600);
  try { fs.rmSync(browser.profile, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
}

/* WebDriver 的应答体统一为 { value: ... }，取出其中的实际结果 */
function result(reply) {
  return reply && typeof reply === 'object' && 'value' in reply ? reply.value : reply;
}

/* 页面内脚本统一包成函数体，脚本内部用 return 输出结果 */
export async function evaluate(browser, source, args) {
  const script = 'return (function () {\n' + source + '\n})();';
  return result(await browser.client.send('WebDriver:ExecuteScript', { script, args: args || [] }));
}

export async function navigate(browser, url) {
  await browser.client.send('WebDriver:Navigate', { url });
  await sleep(300);
}

export async function screenshot(browser, file) {
  const data = result(await browser.client.send('WebDriver:TakeScreenshot', {}));
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
}

export { sleep };
