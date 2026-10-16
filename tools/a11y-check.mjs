#!/usr/bin/env node
/* 无障碍核对
 * 以无头 Chromium 打开本地文件，注入 axe-core 扫描九个页面的默认状态，
 * 以及首页暗色主题、首页搜索面板、作品页灯箱三种交互状态。
 * axe-core 只在核对时注入，不属于页面运行依赖。
 *
 * 用法：
 *   node tools/a11y-check.mjs --axe <axe.min.js 路径>
 * 取得 axe-core：
 *   curl -L -o axe.min.js https://cdn.jsdelivr.net/npm/axe-core@4/axe.min.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, browserName, shutdown, openPage, navigate, evaluate, setViewport, closePage, fileUrl, sleep } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PAGES = [
  'index.html',
  'pages/posts.html',
  'pages/post-reader.html',
  'pages/post-capability.html',
  'pages/post-no-build.html',
  'pages/works.html',
  'pages/archive.html',
  'pages/about.html',
  '404.html'
];

/* 默认状态下不可见的界面，单独扫描一次 */
const SCENES = [
  { file: 'index.html', name: '首页·暗色主题', open: `document.querySelector('.theme-toggle').click()` },
  { file: 'index.html', name: '首页·搜索面板', open: `document.querySelector('.search-toggle').click()` },
  { file: 'pages/works.html', name: '作品页·灯箱', open: `document.querySelector('.shot-open').click()` }
];

/* 只取违规项，规则沿用 axe-core 默认集合 */
const RUN = `axe.run(document, { resultTypes: ['violations'] }).then((report) => report.violations.map((item) => ({
  id: item.id,
  impact: item.impact,
  help: item.help,
  nodes: item.nodes.length,
  target: item.nodes.length ? item.nodes[0].target.join(' ') : ''
})))`;

const results = [];
const pageErrors = [];

function check(name, ok, detail) {
  results.push({ name, ok: ok === true });
  console.log((ok === true ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''));
}

function axeSourcePath() {
  const index = process.argv.indexOf('--axe');
  const value = index !== -1 ? process.argv[index + 1] : process.env.QI_AXE;
  return value ? path.resolve(value) : '';
}

function describe(list) {
  if (!list.length) {
    return '未发现问题';
  }
  return list
    .map((row) => row.id + '(' + row.impact + '·' + row.nodes + ')' + (row.target ? ' ' + row.target : ''))
    .join(' | ');
}

const axePath = axeSourcePath();
if (!axePath) {
  console.error('缺少 --axe 参数。先取得 axe-core，例如：');
  console.error('  curl -L -o axe.min.js https://cdn.jsdelivr.net/npm/axe-core@4/axe.min.js');
  console.error('  然后 node tools/a11y-check.mjs --axe axe.min.js');
  process.exit(2);
}
if (!fs.existsSync(axePath)) {
  console.error('找不到 axe-core 文件：' + axePath);
  process.exit(2);
}

const axeSource = fs.readFileSync(axePath, 'utf8');
const browser = await launch();

try {
  for (const scene of PAGES.map((file) => ({ file })).concat(SCENES)) {
    const label = scene.name || scene.file;
    const page = await openPage(browser, 'about:blank');
    page.client.on((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        const detail = msg.params.exceptionDetails;
        pageErrors.push(label + ': ' + (detail.exception && detail.exception.description ? detail.exception.description : detail.text));
      }
    });
    await setViewport(page.client, 1440, 900);
    await navigate(page.client, fileUrl(ROOT + '/' + scene.file));
    await sleep(900);
    if (scene.open) {
      await evaluate(page.client, scene.open);
      await sleep(700);
    }
    await evaluate(page.client, axeSource);
    const version = await evaluate(page.client, 'axe.version');
    const found = await evaluate(page.client, RUN);
    const severe = found.filter((row) => row.impact === 'serious' || row.impact === 'critical');
    const rest = found.filter((row) => row.impact !== 'serious' && row.impact !== 'critical');
    check(label + ' 无严重或致命无障碍违规', severe.length === 0,
      'axe ' + version + '，严重 ' + severe.length + ' 项，其余 ' + rest.length + ' 项' + (severe.length ? '：' + describe(severe) : rest.length ? '：' + describe(rest) : ''));
    await closePage(page);
  }
  check('页面脚本错误为空', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 400));
} catch (error) {
  check('核对过程异常', false, String(error && error.stack ? error.stack : error));
} finally {
  await shutdown(browser);
}

const failed = results.filter((item) => !item.ok);
console.log('');
console.log('无障碍核对完成（' + browserName() + '）：共 ' + results.length + ' 项，失败 ' + failed.length + ' 项。');
process.exit(failed.length ? 1 : 0);
