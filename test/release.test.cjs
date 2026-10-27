const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'dist/boss-ai.user.js'), 'utf8');
const meta = fs.readFileSync(path.join(root, 'dist/boss-ai.meta.js'), 'utf8');
const version = require('../package.json').version;
test('published metadata exactly matches the complete userscript header', () => {
  assert.equal(meta.trim(), script.slice(0, script.indexOf('// ==/UserScript==') + '// ==/UserScript=='.length));
  assert.equal(meta.match(/^\/\/ @version\s+(\S+)/m)[1], version);
  assert.equal(meta.includes('apiKey'), false);
});
test('update links point to the intended HTTPS domain and stable file names', () => {
  assert.equal(meta.match(/^\/\/ @updateURL\s+(\S+)/m)[1], 'https://7355608.site/userscripts/boss-ai.meta.js');
  assert.equal(meta.match(/^\/\/ @downloadURL\s+(\S+)/m)[1], 'https://7355608.site/userscripts/boss-ai.user.js');
  assert.match(meta, /^\/\/ @namespace\s+local\.boss-ai$/m);
});
