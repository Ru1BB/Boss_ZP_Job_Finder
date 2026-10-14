const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const C = require('../src/core.js');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/app.js'), 'utf8');
function runtime(overrides = {}) {
  let now = Date.parse('2026-10-14T02:00:00Z');
  const store = new Map(), location = { href: 'https://www.zhipin.com/web/geek/jobs', pathname: '/web/geek/jobs', hash: '', reload() {} };
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
