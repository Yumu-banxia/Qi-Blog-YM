#!/usr/bin/env node
/* 对项目自有脚本执行 Node.js 语法检查；第三方压缩库不在扫描范围内。 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['assets/scripts', 'tools'];
const files = [];

function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collect(fullPath);
    } else if (/\.m?js$/i.test(entry.name)) {
      files.push(fullPath);
    }
  }
}

for (const directory of SCAN_DIRS) {
  collect(path.join(ROOT, directory));
}

let failed = false;
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(path.relative(ROOT, file) + '\n');
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log('语法检查通过：' + files.length + ' 个项目脚本');
}
