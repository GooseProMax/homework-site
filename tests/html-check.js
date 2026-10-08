'use strict';

/**
 * HTML 结构与 CSS 类名体检：
 *   node tests/html-check.js
 *
 * 1. 标签是否配对（能发现漏掉的 </div>）
 * 2. 代码里用到的 class 是否在 styles.css 里有定义（防样式漏写）
 * 3. 页面里出现的 id 是否唯一
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? `\n     ↳ ${detail}` : ''}`);
  }
}

console.log('\nHTML / CSS 体检…\n');

/* ------------------------------ 标签配对 ------------------------------ */
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const stack = [];
const problems = [];
const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
let match = tagPattern.exec(html);
while (match) {
  const closing = match[1] === '/';
  const tag = match[2].toLowerCase();
  const selfClosing = match[3] === '/';
  if (VOID_TAGS.has(tag) || selfClosing) {
    match = tagPattern.exec(html);
    continue;
  }
  if (!closing) {
    stack.push(tag);
  } else {
    const last = stack.pop();
    if (last !== tag) problems.push(`</${tag}> 对不上 <${last || '空'}>`);
  }
  match = tagPattern.exec(html);
}
if (stack.length) problems.push(`没有闭合的标签：${stack.join(', ')}`);
check('HTML 标签配对正确', problems.length === 0, problems.join('；'));

/* ------------------------------ id 唯一 ------------------------------ */
const ids = Array.from(html.matchAll(/\sid="([^"]+)"/g)).map((m) => m[1]);
const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);
check('页面 id 不重复', duplicated.length === 0, duplicated.join(', '));

/* ------------------------------ class 是否有样式 ------------------------------ */
const jsFiles = ['js/util.js', 'js/api.js', 'js/store.js', 'js/render.js', 'js/modals.js', 'js/app.js'];
const jsCode = jsFiles.map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');

const usedClasses = new Set();
const classSources = [
  ...Array.from(html.matchAll(/class="([^"]+)"/g)).map((m) => m[1]),
  ...Array.from(jsCode.matchAll(/class: `([^`]+)`/g)).map((m) => m[1]),
  ...Array.from(jsCode.matchAll(/class: '([^']+)'/g)).map((m) => m[1]),
  ...Array.from(jsCode.matchAll(/class: "([^"]+)"/g)).map((m) => m[1]),
  ...Array.from(jsCode.matchAll(/className = `([^`]+)`/g)).map((m) => m[1]),
];
classSources.forEach((value) => {
  // 去掉模板变量 ${...}，再拆空格
  value
    .replace(/\$\{[^}]*\}/g, ' ')
    .split(/\s+/)
    .map((name) => name.trim())
    .filter((name) => /^[a-z][a-z0-9-]*$/i.test(name) && !name.endsWith('-'))
    .forEach((name) => usedClasses.add(name));
});

const missing = Array.from(usedClasses).filter((name) => !new RegExp(`\\.${name}(?![\\w-])`).test(css));
check('代码里用到的 class 都有样式定义', missing.length === 0, missing.join(', '));

/* ------------------------------ 关键元素在不在 ------------------------------ */
['btn-add', 'btn-major', 'btn-schedule', 'btn-settings', 'weeks', 'list-body', 'timetable', 'modal', 'gate'].forEach((id) => {
  check(`关键元素 #${id} 存在`, html.includes(`id="${id}"`));
});

console.log(`\n结果：${passed} 项通过，${failed} 项失败\n`);
if (failed) process.exitCode = 1;
