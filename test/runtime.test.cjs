const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const C = require('../src/core.js');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/app.js'), 'utf8');
function runtime(overrides = {}, shared = null, clockOffset = 0) {
  let now = Date.parse('2026-10-14T02:00:00Z') + clockOffset;
  const store = shared || new Map(), location = { href: 'https://www.zhipin.com/web/geek/jobs', pathname: '/web/geek/jobs', hash: '', reload() {} };
  const c = { ...C.defaults(), apiKey: 'fake-test-key', resume: '熟悉 JavaScript，开发过前端项目。', ...overrides };
  store.set('bossai.v1.config', c);
  class Clock extends Date { static now() { return now; } }
  class Adapter { health() {} }
  const context = { module: { exports: {} }, BossCore: C, BossAdapter: { Adapter, DEFAULT_PROFILE: {} },
    crypto: require('node:crypto').webcrypto, Date: Clock, URL, URLSearchParams, location,
    sessionStorage: { getItem() { return null; } },
    GM_getValue: (k, fallback = null) => store.has(k) ? structuredClone(store.get(k)) : fallback,
    GM_setValue: (k, v) => store.set(k, structuredClone(v)), GM_deleteValue: k => store.delete(k), GM_listValues: () => [...store.keys()],
    setTimeout, clearTimeout, document: {}, console };
  vm.runInNewContext(source, context);
  const api = context.module.exports;
  api.renewLease(); now += 2000; api.renewLease();
  return { api, store, c, location, context, advance(ms) { now += ms; api.renewLease(); }, state() { return store.get('bossai.v1.state'); } };
}
test('manual stop blocks scheduler restart for the same Beijing time window', async () => {
  const r = runtime({ scheduleEnabled: true, startTime: '09:00', stopTime: '18:00' });
  r.api.start(); const id = r.state().task.id;
  r.api.stop('用户停止', true); await r.api.pump();
  assert.equal(r.state().task.status, 'stopped'); assert.equal(r.state().task.id, id);
  assert.ok(r.state().blockedWindow);
  r.advance(86400000); r.advance(2000); await r.api.pump();
  assert.equal(r.state().task.source, 'schedule'); assert.notEqual(r.state().task.id, id);
});
test('starting a new manual task resets session quota but not contact history', () => {
  const r = runtime(); r.api.start(); const s = r.state(); s.task.contacts = 50;
  s.entries.x = { status: 'uncertain', key: 'x' }; r.store.set('bossai.v1.state', s);
  r.api.stop('停止', true); r.advance(100); r.api.start();
  assert.equal(r.state().task.contacts, 0); assert.equal(r.state().entries.x.status, 'uncertain');
});
test('paused pending reply is quarantined and not replayed in a new session', () => {
  const r = runtime(); r.api.start(); const s = r.state();
  s.entries.x = { key: 'x', status: 'contacted', pendingReply: { kind: 'reply', payload: { text: '你好' } } };
  s.outbox.push({ id: 'out', status: 'pending', kind: 'reply', key: 'x' }); r.store.set('bossai.v1.state', s);
  r.api.stop('网络中断');
  assert.equal(r.state().outbox[0].status, 'uncertain'); assert.equal(r.state().entries.x.handoff, true);
  assert.equal(r.state().entries.x.pendingReply, undefined);
});
test('expired task is stopped before any DOM job scan or AI call', async () => {
  const r = runtime(); r.api.start(); const s = r.state(); s.task.endAt = 1; r.store.set('bossai.v1.state', s);
  await r.api.pump(); assert.equal(r.state().task.status, 'paused');
});
test('non-search BOSS tabs cannot own the main execution lease', () => {
  const r = runtime(); r.location.pathname = '/web/geek/chat';
  assert.equal(r.api.renewLease(), false); assert.throws(() => r.api.start());
});
test('critical matters and rich messages transfer before calling AI', async () => {
  const r = runtime();
  for (const m of [{ text: '明天可以来面试吗', rich: false }, { text: '', rich: true }]) {
    const decision = await r.api.chatDecision(r.c, {}, [{ id: 'i1', role: 'recruiter', ...m }]);
    assert.equal(decision.action, 'handoff');
  }
});
test('resume request produces an attachment decision without an AI call', async () => {
  const r = runtime();
  const decision = await r.api.chatDecision(r.c, {}, [{ id: 'i1', role: 'recruiter', text: '请发一份简历', rich: false }]);
  assert.equal(decision.action, 'resume'); assert.equal(decision.inboundId, 'i1');
});
test('no new recruiter messages means no duplicate AI reply', async () => {
  const r = runtime();
  assert.equal(await r.api.chatDecision(r.c, { lastInbound: 'i1' }, [{ id: 'i1', role: 'recruiter', text: '您好', rich: false }]), null);
  assert.equal(await r.api.chatDecision(r.c, {}, [{ id: 'o1', role: 'candidate', text: '您好', rich: false }]), null);
});
test('AI request targets the custom endpoint and does not follow redirects', async () => {
  const r = runtime({ baseUrl: 'https://maas.qianwenaiapi.com/compatible-mode/v1', model: 'qwen3.8-flash' });
  r.context.GM_xmlhttpRequest = args => {
    assert.equal(args.url, 'https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions');
    assert.equal(args.redirect, 'error'); assert.equal(args.anonymous, true);
    assert.equal(JSON.parse(args.data).model, 'qwen3.8-flash');
    queueMicrotask(() => args.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }) }));
    return { abort() {} };
  };
  assert.equal(await r.api.requestAI(r.c, 'test', { test: true }), '{"ok":true}');
});
test('GM permission failures and status-zero responses provide safe diagnostics', async () => {
  for (const mode of ['error', 'zero', 'throw']) {
    const r = runtime();
    r.context.GM_xmlhttpRequest = args => {
      if (mode === 'throw') throw new Error('not permitted: fake-test-key');
      queueMicrotask(() => mode === 'error' ? args.onerror({ error: 'not permitted: fake-test-key' }) : args.onload({ status: 0 }));
      return { abort() {} };
    };
    await assert.rejects(r.api.requestAI(r.c, 'test', {}), e => e.message.includes('@connect maas.qianwenaiapi.com') && !e.message.includes('fake-test-key'));
  }
});
test('DeepSeek requests always use the specified fixed endpoint and model', async () => {
  const r = runtime({ provider: 'deepseek', ...C.PROVIDERS.deepseek });
  r.context.GM_xmlhttpRequest = args => {
    assert.equal(args.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(JSON.parse(args.data).model, 'deepseek-flash');
    queueMicrotask(() => args.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }) }));
    return { abort() {} };
  };
  assert.equal(await r.api.requestAI(r.c, 'test', {}), '{"ok":true}');
});
test('a changed legacy destination cannot silently reuse stored credentials', () => {
  const r = runtime({ baseUrl: 'https://legacy.example/v1' });
  assert.throws(() => r.api.requestAI(r.c, 'test', {}), /重新填写/);
});
test('clicking start in an idle second tab takes ownership from the older idle tab', async () => {
  const first = runtime(), second = runtime({}, first.store, 1000);
  assert.throws(() => second.api.start(), /标签页/);
  await second.api.requestStart();
  assert.equal(second.state().task.status, 'running');
  assert.equal(second.state().task.source, 'manual');
  assert.equal(first.store.get('bossai.v1.startPreference'), null);
  assert.throws(() => first.api.start(), /标签页/);
});
test('manual start never steals execution from a running task', async () => {
  const first = runtime(); first.api.start();
  const originalTask = first.state().task.id;
  const second = runtime({}, first.store, 1000);
  await assert.rejects(second.api.requestStart(), /已有任务正在运行/);
  assert.equal(first.state().task.id, originalTask);
});
test('manual start checks route and configuration before requesting execution', async () => {
  const r = runtime(); r.location.pathname = '/job_detail/example.html';
  await assert.rejects(r.api.requestStart(), /职位搜索结果页/);
  assert.equal(r.store.has('bossai.v1.startPreference'), false);
});
test('scheduler does not start another task while a manual start is settling', async () => {
  const r = runtime({ scheduleEnabled: true, startTime: '09:00', stopTime: '18:00' });
  const pending = r.api.requestStart();
  await r.api.pump();
  assert.equal(r.state(), undefined);
  await pending;
  assert.equal(r.state().task.source, 'manual');
});
test('page commands close owned tabs before another page is opened', async () => {
  const r = runtime(); r.api.start(); const opened = [], tabs = {};
  r.context.GM_getTabs = callback => callback(tabs);
  r.context.GM_openInTab = url => {
    const workerId = new URLSearchParams(new URL(url).hash.slice(1)).get('bossaiWorker');
    assert.equal(Object.keys(tabs).length, 0);
    const handle = { closed: false, close() { this.closed = true; delete tabs[workerId]; this.onclose?.(); } };
    opened.push(handle); tabs[workerId] = { bossAIWorkerId: workerId };
    r.store.set('bossai.v1.workerRegistered.' + workerId, true);
    const cmd = r.store.get('bossai.v1.command');
    r.store.set('bossai.v1.result.' + cmd.id, { ok: true, data: { title: '测试岗位' } });
    return handle;
  };
  for (let i = 0; i < 3; i++) {
    await r.api.command('inspect', { job: { url: 'https://www.zhipin.com/job_detail/test.html' } }, r.state().task.id);
    assert.equal(Object.keys(tabs).length, 0); assert.equal(r.store.get('bossai.v1.activeWorker'), null);
  }
  assert.equal(opened.length, 3); assert.ok(opened.every(tab => tab.closed));
});
test('failed page commands also close their own tabs', async () => {
  const r = runtime(); r.api.start(); let closed = false;
  r.context.GM_getTabs = callback => callback({});
  r.context.GM_openInTab = () => {
    const cmd = r.store.get('bossai.v1.command');
    r.store.set('bossai.v1.result.' + cmd.id, { ok: false, error: '页面不匹配' });
    return { get closed() { return closed; }, close() { closed = true; } };
  };
  await assert.rejects(r.api.command('inspect', { job: { url: 'https://www.zhipin.com/job_detail/test.html' } }, r.state().task.id), /页面不匹配/);
  assert.equal(closed, true);
});
test('an unclosed old worker blocks new page creation', async () => {
  const r = runtime(); r.api.start(); let opened = 0;
  r.store.set('bossai.v1.activeWorker', { id: 'old' });
  r.context.GM_getTabs = callback => callback({ old: { bossAIWorkerId: 'old' } });
  r.context.GM_openInTab = () => { opened++; };
  r.context.setTimeout = (fn, ms) => setTimeout(fn, ms === 200 ? 0 : ms);
  await assert.rejects(r.api.command('inspect', { job: {} }, r.state().task.id), /尚未关闭/);
  assert.equal(opened, 0);
});
test('revoking sending takes effect immediately without saving other form fields', () => {
  const r = runtime({ autoSend: true }); r.api.start();
  r.store.set('bossai.v1.command', { id: 'send', type: 'reply', workerId: 'worker' });
  r.api.disableAutoSend();
  assert.equal(r.store.get('bossai.v1.config').autoSend, false);
  assert.equal(r.store.get('bossai.v1.cancel.send'), true);
  assert.equal(r.store.get('bossai.v1.closeWorker.worker'), true);
});
test('clear button stops the task, empties visible pending entries and keeps configuration', () => {
  const r = runtime(); r.api.start();
  const s = r.state(); s.logs.push({ message: '旧日志' });
  s.entries.pending = { key: 'pending', status: 'review' };
  s.entries.sent = { key: 'sent', status: 'contacted', pendingReply: { text: '待发送' } };
  s.task.contacts = 12;
  r.api.requestClearActivity();
  assert.equal(r.state().task.status, 'stopped'); assert.equal(r.state().logs.length, 0);
  assert.equal(r.state().entries.pending, undefined); assert.equal(r.state().entries.sent.hidden, true);
  assert.equal(r.state().entries.sent.pendingReply, undefined); assert.equal(r.state().task.contacts, 12);
  assert.equal(r.store.get('bossai.v1.config').apiKey, 'fake-test-key');
  assert.equal(r.store.get('bossai.v1.clearActivityRequest'), null);
});
test('clearing from a non-owner is queued and processed by the execution owner', async () => {
  const first = runtime(); first.api.start(); const s = first.state();
  s.entries.pending = { key: 'pending', status: 'eligible' };
  const second = runtime({}, first.store, 1000); second.api.requestClearActivity();
  assert.equal(first.state().entries.pending.status, 'eligible');
  await first.api.pump();
  assert.equal(first.state().task.status, 'stopped'); assert.equal(first.state().entries.pending, undefined);
});
