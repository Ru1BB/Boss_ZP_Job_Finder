const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const header = `// ==UserScript==
// @name         BOSS AI 求职助手（试运行优先）
// @namespace    local.boss-ai
// @version      0.1.41
// @updateURL    https://7355608.site/userscripts/boss-ai.meta.js
// @downloadURL  https://7355608.site/userscripts/boss-ai.user.js
// @description  AI 职位筛选、受控沟通与北京时间调度；请先校准页面
// @match        https://www.zhipin.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_getTab
// @grant        GM_saveTab
// @grant        GM_getTabs
// @grant        window.close
// @grant        GM_registerMenuCommand
// @connect      maas.qianwenaiapi.com
// @connect      api.deepseek.com
// @connect      self
// @run-at       document-idle
// @noframes
// ==/UserScript==
`;
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const reader = require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/resume-reader.entry.js')],
  bundle: true, write: false, format: 'iife', globalName: 'LocalResumeReader', platform: 'browser',
  target: 'chrome120', minify: true, legalComments: 'inline' }).outputFiles[0].text;
const notices = ['pdfjs-dist', 'fflate'].map(name => name + '\n' + fs.readFileSync(path.join(root, 'node_modules', name, 'LICENSE'), 'utf8')).join('\n\n');
fs.writeFileSync(path.join(root, 'dist/boss-ai.user.js'), header + '\n/* Bundled dependency licenses:\n' + notices.replaceAll('*/', '* /') + '\n*/\n(function () {\n\"use strict\";\n' +
  'let localReader; globalThis.BossResumeReader = { extract(...args) { if (!localReader) localReader = (() => {\n' + reader +
  '\nreturn LocalResumeReader; })(); return localReader.extract(...args); } };\n' +
  ['core.js', 'adapter.js', 'app.js'].map(f => fs.readFileSync(path.join(root, 'src', f), 'utf8')).join('\n') + '\n})();\n');
fs.writeFileSync(path.join(root, 'dist/boss-ai.meta.js'), header + '\n');
console.log('Built dist/boss-ai.user.js and dist/boss-ai.meta.js');
