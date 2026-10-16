#!/usr/bin/env node
/* 站内一致性检查
 * 依据 docs/content-plan.md 的约定核对：本地引用与锚点、图片固有尺寸、文章在列表与归档中的记录、
 * 搜索索引与文章头部是否一致。默认只读，加 --write-index 按文章页面重建索引，
 * 加 --sizes 输出各页面首屏资源的体积统计。
 *
 * 用法：
 *   node tools/check-content.mjs
 *   node tools/check-content.mjs --write-index
 *   node tools/check-content.mjs --sizes
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const WRITE_INDEX = args.includes('--write-index');
const SHOW_SIZES = args.includes('--sizes');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'release', 'tools']);

const problems = [];
const counts = {};

function abs(rel) {
  return path.join(ROOT, rel);
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function writeText(file, text) {
  fs.writeFileSync(file, text, 'utf8');
}

function listFiles(dir, filter, out) {
  const base = path.join(ROOT, dir);
  const result = out || [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    const next = dir ? dir + '/' + entry.name : entry.name;
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }
    if (entry.isDirectory()) {
      listFiles(next, filter, result);
    } else if (!filter || filter(next)) {
      result.push(next);
    }
  }
  return result;
}

function problem(file, line, message) {
  problems.push({ file, line, message });
}

function lineOf(html, index) {
  let line = 1;
  for (let i = 0; i < index && i < html.length; i += 1) {
    if (html[i] === '\n') {
      line += 1;
    }
  }
  return line;
}

function parseAttrs(raw) {
  const attrs = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))|([a-zA-Z_:][-a-zA-Z0-9_:.]*)/g;
  let match = pattern.exec(raw);
  while (match) {
    if (match[1]) {
      attrs[match[1].toLowerCase()] = match[2] !== undefined ? match[2] : (match[3] !== undefined ? match[3] : match[4]);
    } else if (match[5]) {
      attrs[match[5].toLowerCase()] = '';
    }
    match = pattern.exec(raw);
  }
  return attrs;
}

/* 顺序扫描标签，跳过注释与脚本、样式的内容，用于读取属性与位置 */
function eachTag(html, visit) {
  const lower = html.toLowerCase();
  let i = 0;
  while (i < html.length) {
    const start = html.indexOf('<', i);
    if (start === -1) {
      break;
    }
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', start) || html.startsWith('<?', start)) {
      const end = html.indexOf('>', start);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    let j = start + 1;
    let quote = '';
    while (j < html.length) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) {
          quote = '';
        }
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      j += 1;
    }
    if (j >= html.length) {
      break;
    }
    const inner = html.slice(start + 1, j);
    const nameMatch = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(inner);
    if (!nameMatch) {
      i = j + 1;
      continue;
    }
    const name = nameMatch[1].toLowerCase();
    const selfClosing = inner.trimEnd().endsWith('/');
    visit({
      name,
      attrs: parseAttrs(inner.slice(nameMatch[1].length)),
      raw: html.slice(start, j + 1),
      index: start,
      line: lineOf(html, start)
    });
    i = j + 1;
    if ((name === 'script' || name === 'style') && !selfClosing) {
      const close = lower.indexOf('</' + name, i);
      i = close === -1 ? html.length : close;
    }
  }
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', hellip: '\u2026',
  mdash: '\u2014', ndash: '\u2013', ldquo: '\u201c', rdquo: '\u201d', times: '\u00d7', rarr: '\u2192'
};

function decodeEntities(text) {
  return text.replace(/&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, body) => {
    if (body.charAt(0) === '#') {
      const code = body.charAt(1) === 'x' || body.charAt(1) === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : all;
  });
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function imageSize(file) {
  const buf = fs.readFileSync(file);
  if (buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buf[offset + 1];
      const length = buf.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
    return null;
  }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      return {
        width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
        height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
      };
    }
    if (kind === 'VP8 ') {
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff
      };
    }
    if (kind === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

function isExternal(value) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || value.startsWith('//');
}

/* 引用分三类：可解析的本地文件、页面锚点、外部地址 */
function localTarget(fromFile, value, keepQuery) {
  let target = value;
  if (!keepQuery) {
    const cut = target.search(/[?#]/);
    if (cut !== -1) {
      target = target.slice(0, cut);
    }
  }
  if (!target) {
    return null;
  }
  const fromDir = path.dirname(path.join(ROOT, fromFile));
  return rel(path.resolve(fromDir, target));
}

function fragmentOf(value) {
  const cut = value.indexOf('#');
  return cut === -1 ? null : value.slice(cut + 1);
}

const htmlFiles = listFiles('', (f) => f.endsWith('.html')).sort();
const cssFiles = listFiles('assets/styles', (f) => f.endsWith('.css')).sort();
const documents = {};

for (const file of htmlFiles) {
  const html = readText(abs(file));
  documents[file] = html;

  const ids = new Map();
  const links = [];

  eachTag(html, (tag) => {
    if (tag.attrs.id) {
      if (ids.has(tag.attrs.id)) {
        problem(file, tag.line, 'id 重复：' + tag.attrs.id);
      }
      ids.set(tag.attrs.id, tag.line);
    }

    const targets = [];
    if (tag.name === 'a' && tag.attrs.href) {
      targets.push(['href', tag.attrs.href]);
    }
    if ((tag.name === 'img' || tag.name === 'script') && tag.attrs.src) {
      targets.push(['src', tag.attrs.src]);
    }
    if (tag.name === 'link' && tag.attrs.href) {
      targets.push(['href', tag.attrs.href]);
    }
    if (tag.name === 'meta' && (tag.attrs.property === 'og:image')) {
      targets.push(['content', tag.attrs.content]);
    }

    for (const [attr, value] of targets) {
      if (!value || isExternal(value) || value.startsWith('#')) {
        if (value && value.startsWith('#') && value.length > 1) {
          links.push({ href: value, line: tag.line });
        }
        continue;
      }
      if (value.startsWith('/')) {
        problem(file, tag.line, attr + ' 使用站点根绝对地址，本地打开会失效：' + value);
        continue;
      }
      const target = localTarget(file, value, tag.name === 'a');
      if (target && !fs.existsSync(path.join(ROOT, target))) {
        problem(file, tag.line, attr + ' 指向不存在的文件：' + value);
      }
      if (tag.name === 'a') {
        links.push({ href: value, line: tag.line });
      }
    }

    if (tag.name === 'img' && tag.attrs.src && tag.attrs.width && tag.attrs.height) {
      const target = localTarget(file, tag.attrs.src, false);
      const full = target ? path.join(ROOT, target) : '';
      if (target && fs.existsSync(full)) {
        const size = imageSize(full);
        if (size && (Number(tag.attrs.width) !== size.width || Number(tag.attrs.height) !== size.height)) {
          problem(file, tag.line, '图片固有尺寸 ' + size.width + 'x' + size.height +
            ' 与属性 ' + tag.attrs.width + 'x' + tag.attrs.height + ' 不一致：' + tag.attrs.src);
        }
      }
    }
  });

  for (const link of links) {
    const fragment = fragmentOf(link.href);
    if (!fragment) {
      continue;
    }
    const base = link.href.split('#')[0];
    const target = base ? localTarget(file, link.href, true) : file;
    if (!target || !documents[target]) {
      continue;
    }
    if (target === file && !documents[file]) {
      continue;
    }
    const targetHtml = documents[target];
    if (targetHtml.indexOf('id="' + fragment + '"') === -1) {
      problem(file, link.line, '锚点不存在：' + link.href);
    }
  }

  counts[file] = ids.size;
}

for (const file of cssFiles) {
  const css = readText(abs(file));
  /* @supports 的条件里会出现用于能力探测的占位地址，跳过这些区段 */
  const skipRanges = [];
  const supportsPattern = /@supports[^{]*/g;
  let supports = supportsPattern.exec(css);
  while (supports) {
    skipRanges.push([supports.index, supports.index + supports[0].length]);
    supports = supportsPattern.exec(css);
  }
  const pattern = /url\(\s*("([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/g;
  let match = pattern.exec(css);
  while (match) {
    const value = match[2] !== undefined ? match[2] : (match[3] !== undefined ? match[3] : match[4]);
    const inSupports = skipRanges.some((range) => match.index >= range[0] && match.index < range[1]);
    if (!inSupports && value && !isExternal(value) && !value.startsWith('data:') && !value.startsWith('#')) {
      if (value.startsWith('/')) {
        problem(file, lineOf(css, match.index), 'url() 使用站点根绝对地址：' + value);
      } else {
        const target = localTarget(file, value, false);
        if (target && !fs.existsSync(path.join(ROOT, target))) {
          problem(file, lineOf(css, match.index), 'url() 指向不存在的文件：' + value);
        }
      }
    }
    match = pattern.exec(css);
  }
}

/* 应用清单图标 */
{
  const manifest = JSON.parse(readText(abs('manifest.webmanifest')));
  for (const icon of manifest.icons || []) {
    if (!fs.existsSync(abs(icon.src))) {
      problem('manifest.webmanifest', 1, '图标不存在：' + icon.src);
      continue;
    }
    const size = imageSize(abs(icon.src));
    if (size && icon.sizes && icon.sizes !== size.width + 'x' + size.height) {
      problem('manifest.webmanifest', 1, '图标尺寸声明 ' + icon.sizes + ' 与实际 ' + size.width + 'x' + size.height + ' 不一致：' + icon.src);
    }
  }
  for (const key of ['start_url', 'scope']) {
    const value = manifest[key];
    if (value && value !== './' && !fs.existsSync(abs(value.replace(/^\.\//, '')))) {
      problem('manifest.webmanifest', 1, key + ' 指向不存在的文件：' + value);
    }
  }
}

/* 未知地址页面不请求站点资源，样式全部内联 */
{
  const html = readText(abs('404.html'));
  eachTag(html, (tag) => {
    const value = tag.attrs.src || tag.attrs.href;
    if (!value || value.startsWith('#')) {
      return;
    }
    if (tag.name === 'link' || tag.name === 'script' || tag.name === 'img') {
      problem('404.html', tag.line, '未知地址页面不应引用外部资源：<' + tag.name + ' ' + (tag.attrs.src ? 'src' : 'href') + '="' + value + '">');
    }
  });
}

/* 文章页面与列表、归档、索引的同步关系 */
const postFiles = htmlFiles.filter((f) => /^pages\/post-[^/]*\.html$/.test(f)).sort();
const articles = new Map();

for (const file of postFiles) {
  const html = documents[file];
  const head = html.indexOf('<header class="article-head">');
  const headEnd = html.indexOf('</header>', head);
  const headHtml = head === -1 ? '' : html.slice(head, headEnd);
  const title = /<h1>([\s\S]*?)<\/h1>/.exec(headHtml);
  const time = /<time datetime="([^"]+)">([^<]+)<\/time>/.exec(headHtml);
  const description = /<meta name="description" content="([^"]*)"/.exec(html);
  const tagBlock = /<ul class="tags">([\s\S]*?)<\/ul>/.exec(headHtml);
  const tags = tagBlock
    ? Array.from(tagBlock[1].matchAll(/<li>([\s\S]*?)<\/li>/g)).map((m) => stripTags(m[1]))
    : [];

  if (!title || !time) {
    problem(file, 1, '文章头部缺少标题或日期');
    continue;
  }

  const proseStart = html.indexOf('<div class="prose">');
  const proseEnd = html.indexOf('<nav class="related"');
  let bodyHtml = proseStart === -1 ? '' : html.slice(proseStart, proseEnd === -1 ? html.length : proseEnd);
  /* 代码块与外联代码标记的文本不进入索引，正文其余文字按顺序拼成一段 */
  bodyHtml = bodyHtml.replace(/<pre>[\s\S]*?<\/pre>/g, ' ').replace(/<code>[\s\S]*?<\/code>/g, ' ');
  const body = stripTags(bodyHtml);

  articles.set(file, {
    file: path.basename(file),
    path: file,
    title: stripTags(title[1]),
    date: time[1],
    summary: description ? decodeEntities(description[1]) : '',
    tags,
    body
  });
}

const orderedArticles = Array.from(articles.values()).sort((a, b) => (a.date < b.date ? 1 : -1));

/* 列表页与归档页需要收录全部文章 */
for (const page of ['pages/posts.html', 'pages/archive.html', 'index.html']) {
  const html = documents[page];
  if (!html) {
    continue;
  }
  const hrefs = Array.from(html.matchAll(/href="(?:pages\/)?(post-[^"#]+\.html)"/g)).map((m) => m[1]);
  const seen = new Set(hrefs);
  const expected = page === 'index.html'
    ? orderedArticles.slice(0, 2).map((a) => a.file)
    : orderedArticles.map((a) => a.file);
  for (const file of expected) {
    if (!seen.has(file)) {
      problem(page, 1, '缺少文章入口：' + file);
    }
  }
  if (page !== 'index.html') {
    for (const file of seen) {
      if (!articles.has('pages/' + file)) {
        problem(page, 1, '指向不存在的文章：' + file);
      }
    }
  }
}

/* 站内指向文章的链接文字应与文章标题一致 */
for (const page of htmlFiles) {
  const html = documents[page];
  const pattern = /<a\b[^>]*href="((?:\.\.\/)?(?:pages\/)?post-[^"#]+\.html)"[^>]*>([\s\S]*?)<\/a>/g;
  let match = pattern.exec(html);
  while (match) {
    const file = 'pages/' + match[1].replace('../', '').replace('pages/', '');
    const article = articles.get(file);
    if (article) {
      const pagerTitle = /<span class="pager-title">([\s\S]*?)<\/span>/.exec(match[2]);
      const text = stripTags(pagerTitle ? pagerTitle[1] : match[2]);
      if (text && text !== article.title) {
        problem(page, lineOf(html, match.index), '链接文字与文章标题不一致：' + text);
      }
    }
    match = pattern.exec(html);
  }
}

/* 归档页标签计数与分组内容 */
{
  const html = documents['pages/archive.html'] || '';
  const counts = new Map();
  const countPattern = /<a href="#tag-([^"]+)">([^<]*)<span class="tag-count">(\d+)<\/span><\/a>/g;
  let match = countPattern.exec(html);
  while (match) {
    counts.set(match[1], Number(match[3]));
    match = countPattern.exec(html);
  }

  const groupPattern = /<section class="tag-group" id="tag-([^"]+)"[\s\S]*?<\/section>/g;
  const listed = new Map();
  match = groupPattern.exec(html);
  while (match) {
    const items = Array.from(match[0].matchAll(/href="(post-[^"#]+\.html)"/g)).map((m) => m[1]);
    listed.set(match[1], items);
    match = groupPattern.exec(html);
  }

  for (const [tag, count] of counts) {
    const items = listed.get(tag) || [];
    if (items.length !== count) {
      problem('pages/archive.html', 1, '标签「' + tag + '」计数为 ' + count + '，实际列出 ' + items.length + ' 篇');
    }
    for (const item of items) {
      const article = articles.get('pages/' + item);
      if (article && article.tags.indexOf(tag) === -1) {
        problem('pages/archive.html', 1, '文章《' + article.title + '》未标注标签「' + tag + '」');
      }
    }
  }
  for (const tag of listed.keys()) {
    if (!counts.has(tag)) {
      problem('pages/archive.html', 1, '标签「' + tag + '」缺少计数');
    }
  }
}

/* 搜索索引 */
const INDEX_FILE = 'assets/data/search-index.js';
const INDEX_HEADER = '/* 站内搜索索引：由文章页面提取生成，新增或修改文章后需要重新生成 */\nwindow.SearchIndex = ';
{
  const text = readText(abs(INDEX_FILE));
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  const entries = start === -1 || end === -1 ? [] : JSON.parse(text.slice(start, end + 1));

  const expectedEntries = orderedArticles.map((article) => ({
    title: article.title,
    file: article.file,
    date: article.date,
    tags: article.tags,
    summary: article.summary,
    body: article.body
  }));

  if (WRITE_INDEX) {
    writeText(abs(INDEX_FILE), INDEX_HEADER + JSON.stringify(expectedEntries) + ';\n');
    console.log('已重建 ' + INDEX_FILE + '，共 ' + expectedEntries.length + ' 条');
  } else {
    if (entries.length !== expectedEntries.length) {
      problem(INDEX_FILE, 1, '索引条目 ' + entries.length + ' 条，文章 ' + expectedEntries.length + ' 篇');
    }
    for (const expected of expectedEntries) {
      const found = entries.find((entry) => entry.file === expected.file);
      if (!found) {
        problem(INDEX_FILE, 1, '缺少文章索引：' + expected.file);
        continue;
      }
      for (const key of ['title', 'date', 'summary', 'body']) {
        if (found[key] !== expected[key]) {
          problem(INDEX_FILE, 1, '索引字段与文章不一致（' + expected.file + ' 的 ' + key + '），可运行 --write-index 重建');
        }
      }
      if (JSON.stringify(found.tags) !== JSON.stringify(expected.tags)) {
        problem(INDEX_FILE, 1, '索引标签与文章不一致：' + expected.file);
      }
    }
    const order = entries.map((entry) => entry.date);
    const sorted = order.slice().sort().reverse();
    if (JSON.stringify(order) !== JSON.stringify(sorted)) {
      problem(INDEX_FILE, 1, '索引未按日期倒序排列');
    }
  }
}

/* 体积统计 */
if (SHOW_SIZES) {
  const gzip = (text) => zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 9 }).length;
  const rows = [];
  for (const file of htmlFiles) {
    const html = documents[file];
    let css = '';
    let own = '';
    eachTag(html, (tag) => {
      if (tag.name === 'link' && tag.attrs.rel === 'stylesheet' && tag.attrs.href && !isExternal(tag.attrs.href)) {
        const target = localTarget(file, tag.attrs.href, false);
        if (target && fs.existsSync(path.join(ROOT, target))) {
          css += readText(path.join(ROOT, target));
        }
      }
      if (tag.name === 'script' && tag.attrs.src && !isExternal(tag.attrs.src)) {
        const target = localTarget(file, tag.attrs.src, false);
        if (target && target.indexOf('assets/vendor/') === -1 && fs.existsSync(path.join(ROOT, target))) {
          own += readText(path.join(ROOT, target));
        }
      }
    });
    const total = html + css + own;
    rows.push({
      页面: file,
      'HTML+CSS+脚本': (Buffer.byteLength(total, 'utf8') / 1024).toFixed(1) + ' KB',
      gzip: (gzip(total) / 1024).toFixed(1) + ' KB'
    });
  }
  console.log('');
  console.table(rows);
}

if (problems.length) {
  console.log('');
  for (const item of problems) {
    console.log(item.file + ':' + item.line + '  ' + item.message);
  }
}

console.log('');
console.log('检查完成：问题 ' + problems.length + ' 项，页面 ' + htmlFiles.length + ' 个。');
process.exit(problems.length ? 1 : 0);
