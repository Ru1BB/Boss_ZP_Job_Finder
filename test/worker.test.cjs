const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const C = require('../src/core.js');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/app.js'), 'utf8');
async function run(options = {}) {
  const store = new Map(), now = Date.now(), callbacks = [], events = [];
  const job = { jobId: 'j', recruiterId: 'r', url: 'https://www.zhipin.com/job_detail/j.html', employmentType: '实习', city: '北京', contactTargetJobId: 'j', alreadyContacted: !!options.alreadyContacted };
  const c = { ...C.defaults(), autoSend: true, resumeName: '测试简历.pdf', profile: { verifiedContact: true, firstContactOpensEmptyChat: true, verifiedReply: true, verifiedResume: true } };
  const s = C.emptyState(); s.task = C.createTask(c, now); s.task.leaseToken = 'leader';
  const cmd = { id: 'cmd', workerId: 'worker', taskId: s.task.id, sendId: 'send', owner: 'leader', createdAt: now,
    type: options.type || 'contact', phase: options.phase || 'chat', args: { job, text: '您好，我有相关项目经验', historyTail: 'in1', inboundId: 'in1', resumeName: c.resumeName } };
  s.outbox.push({ id: 'send', status: 'pending', taskId: s.task.id });
  if (options.retryApproved) { cmd.args.retryApproved = true; s.entries[C.pair(job)] = { job, retryApproved: true }; }
  const history = options.history || (cmd.type === 'contact' ? [] : [{ id: 'in1', role: 'recruiter', text: '请发一份简历', rich: false }]);
  let draft = '';
  const p = { detail: 'detail', chatIdentity: 'identity', contact: 'contact', send: 'send', resumeOpen: 'open', resumeDialog: 'dialog', resumeItem: 'item', resumeName: 'name', resumeSend: 'resumeSend', resumeReceipt: 'receipt', chatUrl: 'https://www.zhipin.com/web/geek/chat' };
  class FakeAdapter {
    constructor() { this.p = p; }
    health() { if (options.blocked) throw new Error('验证阻止'); }
    chatReady() { return options.emptyChat ? events.includes('selectConversation') && !options.neverLoads : true; }
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
      if (options.disableDuringFill) store.set('bossai.v1.config', { ...c, autoSend: false });
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
    window: { close() { events.push('closeWorker'); } },
    GM_getTab: callback => callback({}), GM_saveTab() {},
    GM_registerMenuCommand() {}, GM_openInTab() {}, addEventListener() {} };
  vm.runInNewContext(source, context);
  // Initial tick is async; drain its promises and any repeated tick deterministically.
  await new Promise(resolve => setImmediate(resolve));
  offset = 2000;
  for (const fn of callbacks) { await fn(); }
  for (let i = 0; i < (options.extraTicks || 0); i++) {
    offset += options.tickMs || 2000;
    for (const fn of callbacks) await fn();
  }
  return { events, result: store.get('bossai.v1.result.cmd'), store, history };
}
test('worker sends a single custom greeting to a verified empty conversation', async () => {
  const { events, result, history } = await run(); assert.equal(result.ok, true); assert.equal(result.data.confirmed, true);
  assert.equal(events.filter(x => x === 'send').length, 1);
  assert.ok(history.at(-1).text.endsWith(C.AI_NOTICE));
  assert.ok(events.includes('closeWorker'));
});
test('disabling auto-send during drafting prevents send and closes the worker', async () => {
  const { events, result } = await run({ disableDuringFill: true });
  assert.equal(result.ok, false); assert.equal(events.includes('send'), false); assert.ok(events.includes('closeWorker'));
});
test('reading a conversation closes the worker after returning data', async () => {
  const { events, result } = await run({ type: 'history' });
  assert.equal(result.ok, true); assert.ok(Array.isArray(result.data)); assert.ok(events.includes('closeWorker'));
});
test('worker adds disclosure to a queued legacy reply that has no marker', async () => {
  const { result, history } = await run({ type: 'reply', history: [{ id: 'in1', role: 'recruiter', text: '你有什么项目经验', rich: false }] });
  assert.equal(result.data.confirmed, true); assert.ok(history.at(-1).text.endsWith(C.AI_NOTICE));
});
test('platform default greeting blocks an extra custom greeting', async () => {
  const { events, result } = await run({ history: [{ id: 'old', role: 'candidate', text: '平台默认招呼' }] });
  assert.equal(result.data.confirmed, false); assert.equal(events.includes('send'), false);
});
test('an outgoing AI notice skips greeting without claiming an uncertain send', async () => {
  const { events, result } = await run({ history: [{ id: 'old', role: 'candidate', text: '您好\n' + C.AI_NOTICE }] });
  assert.equal(result.data.priorAI, true); assert.equal(events.includes('send'), false);
});
test('approved recovery opens the existing conversation without clicking contact again', async () => {
  const { events, result } = await run({ phase: 'detail', alreadyContacted: true, retryApproved: true, extraTicks: 1 });
  assert.equal(result.data.confirmed, true); assert.equal(events.includes('contact'), false);
  assert.ok(events.some(e => e.startsWith('navigate:')));
});

test('blank chat page selects the target once and waits before sending', async () => {
  const { events, result } = await run({ phase: 'opening', emptyChat: true, extraTicks: 1 });
  assert.equal(result.ok, true); assert.equal(result.data.confirmed, true);
  assert.equal(events.filter(x => x === 'selectConversation').length, 1);
  assert.equal(events.filter(x => x === 'send').length, 1);
  assert.equal(events.includes('contact'), false);
});
test('a target conversation that never loads times out without another contact click or send', async () => {
  const { events, result } = await run({ phase: 'opening', emptyChat: true, neverLoads: true, extraTicks: 3, tickMs: 14000 });
  assert.equal(result.ok, false); assert.match(result.error, /聊天窗口超时/);
  assert.equal(events.filter(x => x === 'selectConversation').length, 1);
  assert.equal(events.includes('contact'), false); assert.equal(events.includes('send'), false);
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
    const { events, result } = await run(overrides);
    if (!overrides.expired) assert.equal(result.ok, false);
    assert.equal(events.includes('send'), false); assert.ok(events.includes('closeWorker'));
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
