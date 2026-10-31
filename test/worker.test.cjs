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
    fillDelay: options.fillDelay || 0, sendDelay: options.sendDelay || 0, type: options.type || 'contact', phase: options.phase || 'chat', args: { job, text: '您好，我有相关项目经验', historyTail: 'in1', inboundId: 'in1', resumeName: c.resumeName } };
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
    assertChatReady() { if (!this.chatReady()) throw new Error('聊天窗口未展开'); }
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
    setInterval: f => callbacks.push(f), setTimeout: (f, ms) => {
      if (ms === 500 && options.stopDuringDelay) store.set('bossai.v1.stopRequest', { manual: true });
      if (ms === 500 && !options.freezeDuringDelay) { offset += options.slowWait || 500; if (options.slowWait) events.push('slowWait'); }
      if (ms === 500 && options.freezeDuringDelay) {
        if (!events.includes('freeze')) {
          events.push('freeze'); offset += 16000;
          if (options.competingWorker) store.set('bossai.v1.workerLease.worker.competitor', { owner: 'competitor', claimedAt: now, expires: now + 60000 });
        } else offset += 500;
      }
      f();
    }, Event: class {},
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

test('first-contact diagnostics distinguish elapsed waits, click and confirmed receipt', async () => {
  const r = await run({ fillDelay: 500, sendDelay: 500 });
  assert.equal(r.result.ok, true);
  assert.equal(r.result.data.confirmed, true);
  const progress = r.store.get('bossai.v1.command').progress.map(x => x.message);
  assert.equal(progress.length, 7);
  assert.match(progress[0], /填入前等待已结束/);
  assert.match(progress[2], /发送前等待已结束/);
  assert.match(progress[4], /准备点击发送/);
  assert.match(progress[5], /已执行点击发送/);
  assert.match(progress[6], /回执确认成功/);
  assert.equal(r.events.filter(x => x === 'send').length, 1);
});

test('failed receipt diagnostics never report success or repeat the click', async () => {
  const r = await run({ noReceipt: true });
  assert.equal(r.result.data.confirmed, false);
  assert.match(r.store.get('bossai.v1.command').progress.at(-1).message, /未确认/);
  assert.equal(r.events.filter(x => x === 'send').length, 1);
});

test('retired late-loading workers cannot send and close attempts remain bounded', async () => {
  const r = await run({ retired: true, closeThrows: true, extraTicks: 5 });
  assert.equal(r.result, undefined); assert.equal(r.events.includes('send'), false);
  assert.equal(r.events.includes('fill'), false); assert.equal(r.events.filter(x => x === 'closeWorker').length, 3);
});

test('temporary read failure refreshes once and then continues without sending', async () => {
  const r = await run({ type: 'inspect', healthKind: 'transient', recoverOnReload: true, extraTicks: 4 });
  assert.equal(r.result.ok, true); assert.equal(r.events.filter(x => x === 'reloadWorker').length, 1);
  assert.equal(r.events.includes('send'), false);
});
test('persistent temporary read failure is returned after only one refresh', async () => {
  const r = await run({ type: 'inspect', healthKind: 'transient', extraTicks: 7 });
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

test('an unrelated new outgoing AI message cannot confirm this send', async () => {
  const { events, result } = await run({ receiptText: '网页改写后的招呼 AI' });
  assert.equal(result.data.confirmed, false);
  assert.equal(events.filter(e => e === 'send').length, 1);
});

test('plugin introduction alone is not a receipt but still prevents duplicate first contact', async () => {
  const current = await run({ receiptText: '招呼内容\n' + C.PROJECT_INTRO });
  assert.equal(current.result.data.confirmed, false);
  const prior = await run({ history: [{ id: 'old-plugin', role: 'candidate', text: C.PROJECT_INTRO }] });
  assert.equal(prior.result.data.priorAI, true); assert.equal(prior.events.includes('send'), false);
});

test('worker sends without comparing chat identity and retains stop checks', async () => {
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
test('platform default greeting blocks an extra custom greeting', async () => {
  const { events, result } = await run({ history: [{ id: 'old', role: 'candidate', text: '平台默认招呼' }] });
  assert.equal(result.data.confirmed, false); assert.equal(events.includes('send'), false);
});
test('an outgoing AI notice skips greeting without claiming an uncertain send', async () => {
  const { events, result } = await run({ history: [{ id: 'old', role: 'candidate', text: '您好\n' + C.AI_NOTICE }] });
  assert.equal(result.data.priorAI, true); assert.equal(events.includes('send'), false);
});
test('a target conversation that never loads times out without another contact click or send', async () => {
  const { events, result } = await run({ phase: 'opening', emptyChat: true, neverLoads: true, extraTicks: 3, tickMs: 14000 });
  assert.equal(result.ok, false); assert.match(result.error, /聊天窗口未自动展开/);
  assert.equal(events.filter(x => x === 'selectConversation').length, 0);
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
test('expired window and platform verification still block all sends', async () => {
  for (const overrides of [{ expired: true }, { blocked: true }]) {
    const { events, result } = await run(overrides);
    if (!overrides.expired) assert.equal(result.ok, false);
    assert.equal(events.includes('send'), false); assert.ok(events.includes('closeWorker'));
  }
});
test('even a verified requested attachment never opens or sends a file', async () => {
  const { events, result } = await run({ type: 'resume' });
  assert.equal(result.ok, false); assert.match(result.error, /功能已移除/); assert.equal(events.includes('resumeSend'), false); assert.equal(events.includes('resumeOpen'), false);
});
test('attachment mismatch and no explicit request never send files', async () => {
  for (const opts of [{ ambiguousResume: true }, { history: [{ id: 'in1', role: 'recruiter', text: '不用发简历', rich: false }] }]) {
    const { events, result } = await run({ type: 'resume', ...opts }); assert.equal(result.ok, false); assert.equal(events.includes('resumeSend'), false);
  }
});


test('configurable delays still allow one send but stop prevents filling or clicking', async () => {
  const normal = await run({ fillDelay: 1000, sendDelay: 1000 });
  assert.equal(normal.result.ok, true); assert.equal(normal.events.filter(e => e === 'send').length, 1);
  const beforeFill = await run({ fillDelay: 1000, stopDuringDelay: true });
  assert.equal(beforeFill.events.includes('fill'), false); assert.equal(beforeFill.events.includes('send'), false);
  const beforeSend = await run({ sendDelay: 1000, stopDuringDelay: true });
  assert.equal(beforeSend.events.includes('fill'), true); assert.equal(beforeSend.events.includes('send'), false);
});


test('removed reply, history and attachment commands cannot inspect or send in a worker', async () => {
  for (const type of ['reply', 'history', 'resume']) {
    const { events, result } = await run({ type });
    assert.equal(result.ok, false); assert.match(result.error, /功能已移除/);
    assert.equal(events.includes('send'), false); assert.equal(events.includes('fill'), false);
    assert.equal(events.includes('selectConversation'), false);
  }
});


test('worker refresh during fill or send waiting never reopens a job or repeats a send', async () => {
  for (const phase of ['waitingFill', 'waitingSend']) {
    const { events, result } = await run({ phase });
    assert.equal(result.ok, false); assert.match(result.error, /工作页已重载/);
    assert.equal(events.includes('contact'), false); assert.equal(events.includes('fill'), false);
    assert.equal(events.includes('send'), false); assert.equal(events.some(x => x.startsWith('navigate:')), false);
  }
});


test('a background-delayed worker re-elects before sending instead of reporting task stopped', async () => {
  const r = await run({ fillDelay: 1000, freezeDuringDelay: true });
  assert.equal(r.result.ok, true); assert.equal(r.result.data.confirmed, true);
  assert.equal(r.events.filter(e => e === 'send').length, 1); assert.ok(r.events.includes('freeze'));
});

test('a competing worker prevents sending and returns a precise local error', async () => {
  const r = await run({ fillDelay: 1000, freezeDuringDelay: true, competingWorker: true });
  assert.equal(r.result.ok, false); assert.equal(r.result.code, 'WORKER_LEASE_UNAVAILABLE');
  assert.equal(r.events.includes('send'), false); assert.equal(r.events.includes('fill'), false);
});


test('a two-second send delay completes after one late callback instead of multiplying the wait', async () => {
  const r = await run({ sendDelay: 2000, slowWait: 5000 });
  assert.equal(r.result.ok, true); assert.equal(r.result.data.confirmed, true);
  assert.equal(r.events.filter(e => e === 'slowWait').length, 1);
  assert.equal(r.events.filter(e => e === 'send').length, 1);
});
