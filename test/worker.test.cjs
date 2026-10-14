const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const C = require('../src/core.js');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/app.js'), 'utf8');
async function run(options = {}) {
  const store = new Map(), now = Date.now(), callbacks = [], events = [];
  const job = { jobId: 'j', recruiterId: 'r', url: 'https://www.zhipin.com/job_detail/j.html', employmentType: '实习', city: '北京' };
  const c = { ...C.defaults(), autoSend: true, resumeName: '测试简历.pdf', profile: { verifiedContact: true, firstContactOpensEmptyChat: true, verifiedReply: true, verifiedResume: true } };
  const s = C.emptyState(); s.task = C.createTask(c, now); s.task.leaseToken = 'leader';
  const cmd = { id: 'cmd', workerId: 'worker', taskId: s.task.id, sendId: 'send', owner: 'leader', createdAt: now,
    type: options.type || 'contact', phase: options.phase || 'chat', args: { job, text: '您好，我有相关项目经验', historyTail: 'in1', inboundId: 'in1', resumeName: c.resumeName } };
  s.outbox.push({ id: 'send', status: 'pending', taskId: s.task.id });
  const history = options.history || (cmd.type === 'contact' ? [] : [{ id: 'in1', role: 'recruiter', text: '请发一份简历', rich: false }]);
  let draft = '';
  const p = { detail: 'detail', chatIdentity: 'identity', contact: 'contact', send: 'send', resumeOpen: 'open', resumeDialog: 'dialog', resumeItem: 'item', resumeName: 'name', resumeSend: 'resumeSend', resumeReceipt: 'receipt', chatUrl: 'https://www.zhipin.com/web/geek/chat' };
  class FakeAdapter {
    constructor() { this.p = p; }
    health() { if (options.blocked) throw new Error('验证阻止'); }
    assertIdentity() { if (options.wrongIdentity) throw new Error('身份不匹配'); }
    history() { return structuredClone(history); }
    nodes(selector) {
      if (selector === 'receipt') return events.includes('resumeSend') ? [{ innerText: c.resumeName }] : [];
      if (selector === 'item') return [{ click() { events.push('selectResume'); } }];
      return [{}];
    }
    one() { return {}; }
    text() { return options.ambiguousResume ? '另一份简历' : c.resumeName; }
    button(selector) { return { click() {
      events.push(selector);
      if (selector === 'send') history.push({ id: 'out1', role: 'candidate', text: draft });
    } }; }
    fill(text) {
      draft = text;
      events.push('fill');
      if (options.stopDuringFill) store.set('bossai.v1.stopRequest', { manual: true });
      if (options.newMessageDuringFill) history.push({ id: 'in2', role: 'recruiter', text: '另一个问题' });
    }
    editor() { return { value: draft }; }
    jobId() { return 'j'; }
    inspectJob() { return job; }
    safeUrl(url) { return new URL(url); }
    selectConversation() { events.push('selectConversation'); }
  }
  for (const [key, value] of Object.entries({ config: c, state: s, command: cmd, 'lease.leader': { owner: 'leader', claimedAt: now - 1000, expires: now + 60000 } })) store.set('bossai.v1.' + key, value);
  if (options.consumed) store.set('bossai.v1.consumed.cmd', true);
  if (options.expired) s.task.endAt = now - 1;
  let offset = 0;
  class Clock extends Date { static now() { return now + offset; } }
  const context = { BossCore: C, BossAdapter: { Adapter: FakeAdapter, DEFAULT_PROFILE: p },
    crypto: require('node:crypto').webcrypto, URL, URLSearchParams, Date: Clock, console,
    sessionStorage: { getItem: () => 'worker', setItem() {} },
    location: { href: 'https://www.zhipin.com/web/geek/chat', hash: '', assign(url) { events.push('navigate:' + url); } },
    document: { createElement: () => ({ style: {} }), documentElement: { append() {} } },
    GM_getValue: (k, fallback = null) => store.has(k) ? structuredClone(store.get(k)) : fallback,
    GM_setValue: (k, v) => store.set(k, structuredClone(v)), GM_listValues: () => [...store.keys()], GM_deleteValue: k => store.delete(k),
    setInterval: f => callbacks.push(f), setTimeout: f => { f(); }, Event: class {},
    GM_registerMenuCommand() {}, GM_openInTab() {}, addEventListener() {} };
  vm.runInNewContext(source, context);
  // Initial tick is async; drain its promises and any repeated tick deterministically.
  await new Promise(resolve => setImmediate(resolve));
  offset = 2000;
  for (const fn of callbacks) { await fn(); }
  return { events, result: store.get('bossai.v1.result.cmd'), store, history };
}
test('worker sends a single custom greeting to a verified empty conversation', async () => {
  const { events, result, history } = await run(); assert.equal(result.ok, true); assert.equal(result.data.confirmed, true);
  assert.equal(events.filter(x => x === 'send').length, 1);
  assert.ok(history.at(-1).text.endsWith(C.AI_NOTICE));
});
test('worker adds disclosure to a queued legacy reply that has no marker', async () => {
  const { result, history } = await run({ type: 'reply', history: [{ id: 'in1', role: 'recruiter', text: '你有什么项目经验', rich: false }] });
  assert.equal(result.data.confirmed, true); assert.ok(history.at(-1).text.endsWith(C.AI_NOTICE));
});
test('platform default greeting blocks an extra custom greeting', async () => {
  const { events, result } = await run({ history: [{ id: 'old', role: 'candidate', text: '平台默认招呼' }] });
  assert.equal(result.data.confirmed, false); assert.equal(events.includes('send'), false);
});
test('stop signal immediately before click cancels send', async () => {
  const { events, result } = await run({ stopDuringFill: true }); assert.equal(result.ok, false); assert.equal(events.includes('send'), false);
});
test('new incoming message while drafting prevents stale send', async () => {
  const { events, result } = await run({ newMessageDuringFill: true }); assert.equal(result.ok, false); assert.equal(events.includes('send'), false);
});
test('consumed command after page reload is not reissued', async () => {
  const { events, result } = await run({ consumed: true }); assert.equal(result.data.confirmed, false); assert.equal(events.includes('send'), false);
});
test('expired window, wrong identity and verification block all sends', async () => {
  for (const overrides of [{ expired: true }, { wrongIdentity: true }, { blocked: true }]) {
    const { events, result } = await run(overrides); assert.equal(result.ok, false); assert.equal(events.includes('send'), false);
  }
});
test('requested unique attachment sends once and checks receipt', async () => {
  const { events, result } = await run({ type: 'resume' });
  assert.equal(result.ok, true); assert.equal(result.data.confirmed, true); assert.equal(events.filter(x => x === 'resumeSend').length, 1);
});
test('attachment mismatch and no explicit request never send files', async () => {
  for (const opts of [{ ambiguousResume: true }, { history: [{ id: 'in1', role: 'recruiter', text: '不用发简历', rich: false }] }]) {
    const { events, result } = await run({ type: 'resume', ...opts }); assert.equal(result.ok, false); assert.equal(events.includes('resumeSend'), false);
  }
});
