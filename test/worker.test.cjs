const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const C = require('../src/core.js');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/app.js'), 'utf8');
async function run(options = {}) {
  const store = new Map(), now = Date.now(), callbacks = [], events = [];
  const job = { jobId: 'j', recruiterId: 'r', url: 'https://www.zhipin.com/job_detail/j.html', employmentType: '实习', city: '北京', contactTargetJobId: 'j', alreadyContacted: !!options.alreadyContacted };
  const c = { ...C.defaults(), autoSend: true, verifiedEmptyContact: !!options.verifiedEmptyContact, verifyChatWindow: options.verifyChatWindow !== false, resumeName: '测试简历.pdf', profile: { verifiedContact: true, firstContactOpensEmptyChat: true, verifiedReply: true, verifiedResume: true } };
  const s = C.emptyState(); s.task = C.createTask(c, now); s.task.leaseToken = 'leader';
  const cmd = { id: 'cmd', workerId: 'worker', taskId: s.task.id, sendId: 'send', owner: 'leader', createdAt: now,
    type: options.type || 'contact', phase: options.phase || 'chat', args: { job, text: '您好，我有相关项目经验', historyTail: 'in1', inboundId: 'in1', resumeName: c.resumeName } };
  s.outbox.push({ id: 'send', status: 'pending', taskId: s.task.id });
  if (options.retryApproved) { cmd.args.retryApproved = true; s.entries[C.pair(job)] = { job, retryApproved: true }; }
  const history = options.history || (cmd.type === 'contact' ? [] : [{ id: 'in1', role: 'recruiter', text: '请发一份简历', rich: false }]);
  let draft = '', editorReads = 0;
  const p = { detail: 'detail', chatIdentity: 'identity', contact: 'contact', send: 'send', resumeOpen: 'open', resumeDialog: 'dialog', resumeItem: 'item', resumeName: 'name', resumeSend: 'resumeSend', resumeReceipt: 'receipt', chatUrl: 'https://www.zhipin.com/web/geek/chat' };
  class FakeAdapter {
    constructor(doc, profile, jobs, config = {}) { this.p = p; this.verifyChatWindow = config.verifyChatWindow !== false; }
    health() {
      if (options.blocked) throw new Error('验证阻止');
      if (options.healthKind && !(options.recoverOnReload && events.includes('reloadWorker'))) {
        const e = new Error('页面检测异常'); e.code = 'PAGE_HEALTH'; e.healthIssue = { kind: options.healthKind }; throw e;
      }
    }
    chatReady() { return options.emptyChat ? events.includes('selectConversation') && !options.neverLoads : true; }
    assertIdentity() { if (this.verifyChatWindow && options.wrongIdentity) throw new Error('身份不匹配'); }
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
      if (selector === 'send' && !options.noReceipt) history.push({ id: 'out1', role: options.receiptRole || 'candidate', text: options.receiptText ?? draft });
    } }; }
    fill(text) {
      draft = text;
      events.push('fill');
      if (options.disableDuringFill) store.set('bossai.v1.config', { ...c, autoSend: false });
      if (options.stopDuringFill) store.set('bossai.v1.stopRequest', { manual: true });
      if (options.newMessageDuringFill) history.push({ id: 'in2', role: 'recruiter', text: '另一个问题' });
    }
    editor() { return { value: draft }; }
    editorMatches(text) { return !options.editorMismatch && ++editorReads > (options.editorDelayReads || 0) && draft === text; }
    jobId() { return 'j'; }
    inspectJob() { return job; }
    safeUrl(url) { return new URL(url); }
    selectConversation() { events.push('selectConversation'); }
  }
  for (const [key, value] of Object.entries({ config: c, state: s, command: cmd, 'lease.leader': { owner: 'leader', claimedAt: now - 1000, expires: now + 60000 } })) store.set('bossai.v1.' + key, value);
  if (options.consumed) store.set('bossai.v1.consumed.cmd', true);
  if (options.retired) store.set('bossai.v1.workerRetired.worker', { at: now });
  if (options.expired) s.task.endAt = now - 1;
  let offset = 0;
  class Clock extends Date { static now() { return now + offset; } }
  const context = { BossCore: C, BossAdapter: { Adapter: FakeAdapter, DEFAULT_PROFILE: p },
    crypto: require('node:crypto').webcrypto, URL, URLSearchParams, Date: Clock, console,
    sessionStorage: { getItem: () => 'worker', setItem() {} },
    location: { href: 'https://www.zhipin.com/web/geek/chat', hash: '', reload() { events.push('reloadWorker'); }, assign(url) { events.push('navigate:' + url); } },
    document: { createElement: () => ({ style: {} }), documentElement: { append() {} } },
    GM_getValue: (k, fallback = null) => store.has(k) ? structuredClone(store.get(k)) : fallback,
    GM_setValue: (k, v) => store.set(k, structuredClone(v)), GM_listValues: () => [...store.keys()], GM_deleteValue: k => store.delete(k),
    setInterval: f => callbacks.push(f), setTimeout: f => { f(); }, Event: class {},
    window: { close() { events.push('closeWorker'); if (options.closeThrows) throw new Error('close failed'); } },
    GM_getTab: callback => callback({}), GM_saveTab(tab, callback) { callback?.(); },
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

test('retired late-loading workers cannot send and close attempts remain bounded', async () => {
  const r = await run({ retired: true, closeThrows: true, extraTicks: 5 });
  assert.equal(r.result, undefined); assert.equal(r.events.includes('send'), false);
  assert.equal(r.events.includes('fill'), false); assert.equal(r.events.filter(x => x === 'closeWorker').length, 3);
});

test('temporary read failure refreshes once and then continues without sending', async () => {
  const r = await run({ type: 'history', healthKind: 'transient', recoverOnReload: true, extraTicks: 4 });
  assert.equal(r.result.ok, true); assert.equal(r.events.filter(x => x === 'reloadWorker').length, 1);
  assert.equal(r.events.includes('send'), false);
});
test('persistent temporary read failure is returned after only one refresh', async () => {
  const r = await run({ type: 'history', healthKind: 'transient', extraTicks: 7 });
  assert.equal(r.result.ok, false); assert.equal(r.result.healthIssue.kind, 'transient');
  assert.equal(r.events.filter(x => x === 'reloadWorker').length, 1);
});
test('real verification and uncertain sends never trigger recovery refresh or replay', async () => {
  for (const options of [{ healthKind: 'verification', extraTicks: 4 }, { healthKind: 'transient', consumed: true, extraTicks: 4 }]) {
    const r = await run(options); assert.equal(r.result.ok, false);
    assert.equal(r.events.includes('reloadWorker'), false); assert.equal(r.events.includes('send'), false);
  }
});
test('worker sends a single custom greeting to a verified empty conversation', async () => {
  const { events, result, history } = await run(); assert.equal(result.ok, true); assert.equal(result.data.confirmed, true);
  assert.equal(events.filter(x => x === 'send').length, 1);
  assert.equal(history.at(-1).text.endsWith(C.AI_NOTICE), false);
  assert.ok(history.at(-1).text.includes(C.PROJECT_URL));
  assert.ok(events.includes('closeWorker'));
});

test('open-only clicks the bound contact button once and never reads history, fills or sends', async () => {
  const { events, result } = await run({ type: 'openOnly', phase: 'detail', verifiedEmptyContact: true, extraTicks: 2 });
  assert.equal(result.data.opened, true); assert.equal(events.filter(e => e === 'contact').length, 1);
  assert.equal(events.includes('fill'), false); assert.equal(events.includes('send'), false); assert.ok(events.includes('closeWorker'));
});

test('open-only requires no-default-greeting verification and skips existing contacts', async () => {
  const unverified = await run({ type: 'openOnly' });
  assert.equal(unverified.result.ok, false); assert.equal(unverified.events.includes('contact'), false);
  const existing = await run({ type: 'openOnly', verifiedEmptyContact: true, alreadyContacted: true });
  assert.equal(existing.result.data.existing, true); assert.equal(existing.events.includes('contact'), false);
});

test('new outgoing AI keyword confirms despite changed wording or formatting', async () => {
  const { events, result } = await run({ receiptText: '网页改写后的招呼 AI' });
  assert.equal(result.data.confirmed, true);
  assert.equal(events.filter(e => e === 'send').length, 1);
});

test('new plugin introduction confirms a greeting and prevents a duplicate first contact', async () => {
  const current = await run({ receiptText: '招呼内容\n' + C.PROJECT_INTRO });
  assert.equal(current.result.data.confirmed, true);
  const prior = await run({ history: [{ id: 'old-plugin', role: 'candidate', text: C.PROJECT_INTRO }] });
  assert.equal(prior.result.data.priorAI, true); assert.equal(prior.events.includes('send'), false);
});

test('a new outgoing reply without an AI footer is still a valid receipt', async () => {
  const r = await run({ type: 'reply', receiptText: '我有相关项目经验。', history: [{ id: 'in1', role: 'recruiter', text: '有什么经历' }] });
  assert.equal(r.result.data.confirmed, true);
});

test('old messages and incoming messages cannot confirm a reply send', async () => {
  for (const options of [{ noReceipt: true }, { receiptText: '招聘者说 AI', receiptRole: 'recruiter' }]) {
    const { result } = await run({ type: 'reply', history: [
      { id: 'oldAI', role: 'candidate', text: '之前的 AI 消息' },
      { id: 'in1', role: 'recruiter', text: '请介绍项目经验' }
    ], ...options });
    assert.equal(result.data.confirmed, false);
  }
});

test('worker passes the explicit identity opt-out to drafting and receipt checks', async () => {
  const { events, result } = await run({ wrongIdentity: true, verifyChatWindow: false });
  assert.equal(result.ok, true); assert.equal(result.data.confirmed, true);
  assert.equal(events.filter(e => e === 'send').length, 1);
  const blocked = await run({ verifyChatWindow: false, stopDuringFill: true });
  assert.equal(blocked.events.includes('send'), false);
});
test('disabling auto-send during drafting prevents send and closes the worker', async () => {
  const { events, result } = await run({ disableDuringFill: true });
  assert.equal(result.ok, false); assert.equal(events.includes('send'), false); assert.ok(events.includes('closeWorker'));
});
test('reading a conversation closes the worker after returning data', async () => {
  const { events, result } = await run({ type: 'history' });
  assert.equal(result.ok, true); assert.ok(Array.isArray(result.data)); assert.ok(events.includes('closeWorker'));
});
test('worker sends replies without the removed footer', async () => {
  const { result, history } = await run({ type: 'reply', history: [{ id: 'in1', role: 'recruiter', text: '你有什么项目经验', rich: false }] });
  assert.equal(result.data.confirmed, true); assert.equal(history.at(-1).text.endsWith(C.AI_NOTICE), false);
  assert.equal(history.at(-1).text.includes(C.PROJECT_URL), false);
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

test('a persistently changed editor cancels before click and never retries writing', async () => {
  const { events, result } = await run({ editorMismatch: true });
  assert.equal(result.ok, false); assert.match(result.error, /输入框内容与拟发送消息不一致/);
  assert.equal(events.filter(e => e === 'fill').length, 1);
  assert.equal(events.includes('send'), false); assert.ok(events.includes('closeWorker'));
});

test('a delayed editor render is awaited without duplicate writes or duplicate sends', async () => {
  const { events, result } = await run({ editorDelayReads: 2 });
  assert.equal(result.ok, true); assert.equal(result.data.confirmed, true);
  assert.equal(events.filter(e => e === 'fill').length, 1);
  assert.equal(events.filter(e => e === 'send').length, 1);
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
test('even a verified requested attachment never opens or sends a file', async () => {
  const { events, result } = await run({ type: 'resume' });
  assert.equal(result.ok, false); assert.match(result.error, /附件自动发送已停用/); assert.equal(events.includes('resumeSend'), false); assert.equal(events.includes('resumeOpen'), false);
});
test('attachment mismatch and no explicit request never send files', async () => {
  for (const opts of [{ ambiguousResume: true }, { history: [{ id: 'in1', role: 'recruiter', text: '不用发简历', rich: false }] }]) {
    const { events, result } = await run({ type: 'resume', ...opts }); assert.equal(result.ok, false); assert.equal(events.includes('resumeSend'), false);
  }
});
