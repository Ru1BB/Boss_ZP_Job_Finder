const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const header = `// ==UserScript==
// @name         BOSS AI 求职助手（试运行优先）
// @namespace    local.boss-ai
// @version      0.1.23
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
fs.writeFileSync(path.join(root, 'dist/boss-ai.user.js'), header + '\n(function () {\n\"use strict\";\n' +
  ['core.js', 'adapter.js', 'app.js'].map(f => fs.readFileSync(path.join(root, 'src', f), 'utf8')).join('\n') + '\n})();\n');
console.log('Built dist/boss-ai.user.js');
