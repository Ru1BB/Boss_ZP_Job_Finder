const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const C = require('../src/core.js');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/app.js'), 'utf8');
function runtime(overrides = {}, shared = null, clockOffset = 0) {
  let now = Date.parse('2026-10-14T02:00:00Z') + clockOffset;
  const store = shared || new Map(), location = { href: 'https://www.zhipin.com/web/geek/jobs?jobType=1902', pathname: '/web/geek/jobs', hash: '', reload() {} };
  const c = { ...C.defaults(), apiKey: 'fake-test-key', resume: '熟悉 JavaScript，开发过前端项目。', ...overrides };
  store.set('bossai.v1.config', c);
  class Clock extends Date { static now() { return now; } }
  class Adapter { health() {} }
  const context = { module: { exports: {} }, BossCore: C, BossAdapter: { Adapter, DEFAULT_PROFILE: {} },
    crypto: require('node:crypto').webcrypto, Date: Clock, URL, URLSearchParams, location,
    sessionStorage: { getItem() { return null; } },
    GM_getValue: (k, fallback = null) => store.has(k) ? structuredClone(store.get(k)) : fallback,
    GM_setValue: (k, v) => store.set(k, structuredClone(v)), GM_deleteValue: k => store.delete(k), GM_listValues: () => [...store.keys()],
    setTimeout: (fn, ms) => setTimeout(() => { if (ms === 500) { now += ms; context.module.exports.renewLease(); } fn(); }, ms === 500 ? 0 : ms), clearTimeout, document: {}, console };
  vm.runInNewContext(source, context);
  const api = context.module.exports;
  api.renewLease(); now += 2000; api.renewLease();
  return { api, store, c, location, context, advance(ms) { now += ms; api.renewLease(); }, state() { return store.get('bossai.v1.state'); } };
}

function quickRetryTimers(r) {
  r.context.setTimeout = (fn, ms) => setTimeout(() => { if (ms === 500) r.advance(ms); fn(); }, ms === 500 || ms === 1000 || ms === 2000 ? 0 : ms);
}

test('debug report exposes only execution flags and a read-only DOM snapshot', () => {
  const disabled = runtime(); assert.throws(() => disabled.api.debugReport(), /调试模式/);
  const r = runtime({ debugMode: true, verifyChatWindow: false, resume: 'PRIVATE-RESUME', apiKey: 'PRIVATE-KEY' });
  r.context.BossAdapter.Adapter.prototype.debugSnapshot = () => ({ page: '/web/geek/chat', candidates: { editors: [] } });
  const before = JSON.stringify([...r.store]);
  r.context.GM_xmlhttpRequest = () => { assert.fail('debug must never call AI'); };
  r.context.GM_openInTab = () => { assert.fail('debug must never open or send'); };
  const report = r.api.debugReport();
  assert.equal(report.checks.chatIdentityComparison, false); assert.equal(report.checks.historyAndDuplicateChecks, true);
  assert.equal(report.checks.receiptChecks, true);
  assert.equal(JSON.stringify(report).includes('PRIVATE-KEY'), false); assert.equal(JSON.stringify(report).includes('PRIVATE-RESUME'), false);
  assert.equal(JSON.stringify([...r.store]), before);
});
test('message text inclusion is passed only for this explicit diagnostic call', () => {
  const r = runtime({ debugMode: true }), flags = [];
  r.context.BossAdapter.Adapter.prototype.debugSnapshot = options => { flags.push(options.includeMessageText); return {}; };
  assert.equal(r.api.debugReport({ includeMessageText: true }).schemaVersion, 2);
  r.api.debugReport(); assert.deepEqual(flags, [true, false]);
  assert.equal(Object.hasOwn(r.store.get('bossai.v1.config'), 'includeMessageText'), false);
});

function failHealth(r, kind) {
  r.context.BossAdapter.Adapter.prototype.health = () => {
    const e = new Error('页面异常'); e.code = 'PAGE_HEALTH'; e.healthIssue = { kind }; throw e;
  };
}
test('main temporary failure preserves task, avoids rapid refresh and resumes after clearing', async () => {
  const r = runtime(); r.api.start(); const id = r.state().task.id;
  let reloads = 0; r.location.reload = () => reloads++;
  failHealth(r, 'transient'); await r.api.pump();
  assert.equal(r.state().task.status, 'running'); assert.ok(r.state().task.healthProbe);
  r.advance(6000); await r.api.pump(); assert.equal(reloads, 1);
  r.advance(6000); await r.api.pump(); assert.equal(reloads, 1);
  r.context.BossAdapter.Adapter.prototype.health = () => {};
  r.context.BossAdapter.Adapter.prototype.cards = () => [];
  r.context.BossAdapter.Adapter.prototype.advance = () => false;
  await r.api.pump();
  assert.equal(r.state().task.id, id); assert.equal(r.state().task.status, 'running');
  assert.equal(r.state().task.healthProbe, undefined);
});
test('persistent temporary errors reload with bounded backoff across page instances', async () => {
  let r = runtime(); r.api.start(); const id = r.state().task.id;
  r.state().task.contacts = 7; r.state().lastSendAt = 123;
  const initial = r.context.Date.now(); let reloads = 0;
  function brokenPage() { r.location.reload = () => reloads++; failHealth(r, 'transient'); }
  brokenPage(); await r.api.pump(); r.advance(6000); await r.api.pump();
  assert.equal(reloads, 1); assert.equal(r.state().task.healthProbe.retryAt - r.context.Date.now(), 60000);
  r.api.releaseLease();
  const offset = r.context.Date.now() - initial + 2000;
  r = runtime({}, r.store, offset); brokenPage();
  await r.api.pump(); // Recover the old execution token first.
  await r.api.pump(); assert.equal(reloads, 1);
  for (const delay of [120000, 240000, 480000, 600000, 600000]) {
    const due = r.state().task.healthProbe.retryAt;
    const remaining = due - r.context.Date.now();
    // Keep the execution lease alive while moving the fake clock.
    for (let elapsed = 0; elapsed < remaining; elapsed += 5000) r.advance(Math.min(5000, remaining - elapsed));
    await r.api.pump();
    assert.equal(r.state().task.healthProbe.retryAt - r.context.Date.now(), delay);
  }
  assert.equal(reloads, 6); assert.equal(r.state().task.id, id);
  assert.equal(r.state().task.contacts, 7); assert.equal(r.state().lastSendAt, 123);
});

test('normal refresh releases only its own lease and the next page recovers the same task promptly', async () => {
  const original = runtime(); original.api.start(); const id = original.state().task.id;
  const oldOwner = original.state().task.leaseToken;
  const other = runtime({}, original.store, 0);
  assert.equal(other.api.renewLease(), false);
  original.api.releaseLease();
  assert.equal(original.store.has('bossai.v1.lease.' + oldOwner), false);
  assert.ok(original.store.size > 0);
  assert.equal(other.api.renewLease(), true);
  await other.api.pump();
  assert.equal(other.state().task.id, id); assert.equal(other.state().task.status, 'running');
  assert.notEqual(other.state().task.leaseToken, oldOwner);
  assert.equal(original.api.renewLease(), false);
  const newOwner = other.state().task.leaseToken;
  await original.api.pump(); assert.equal(other.state().task.leaseToken, newOwner);
});

test('an unreleased live tab still excludes competitors until its lease expires', () => {
  const a = runtime(); a.api.start(); const b = runtime({}, a.store, 0);
  assert.equal(b.api.renewLease(), false); assert.equal(a.api.renewLease(), true);
  b.advance(16000); b.advance(2000); assert.equal(b.api.renewLease(), true);
});
test('stop time prevents a scheduled transient recovery refresh', async () => {
  const r = runtime({ scheduleEnabled: true, startTime: '09:00', stopTime: '11:00' }); r.api.start();
  let reloads = 0; r.location.reload = () => reloads++; failHealth(r, 'transient');
  await r.api.pump(); r.advance(6000); await r.api.pump(); assert.equal(reloads, 1);
  r.state().task.endAt = r.context.Date.now(); await r.api.pump();
  assert.notEqual(r.state().task.status, 'running'); assert.equal(reloads, 1);
});
test('persistent real verification pauses after passive recheck and never reloads', async () => {
  const r = runtime(); r.api.start(); let reloads = 0; r.location.reload = () => reloads++;
  failHealth(r, 'verification'); await r.api.pump(); assert.equal(r.state().task.status, 'running');
  r.advance(6000); await r.api.pump(); assert.notEqual(r.state().task.status, 'running'); assert.equal(reloads, 0);
});
test('manual stop during health recovery prevents refresh and further actions', async () => {
  const r = runtime(); r.api.start(); let reloads = 0; r.location.reload = () => reloads++;
  failHealth(r, 'transient'); await r.api.pump(); r.api.stop('手动停止', true);
  r.advance(6000); await r.api.pump(); assert.equal(reloads, 0); assert.equal(r.state().task.status, 'stopped');
});
test('worker health metadata preserves global challenges versus local temporary failures', async () => {
  for (const kind of ['verification', 'login', 'restriction', 'transient']) {
    const r = runtime({ autoSend: true }); r.api.start(); const entry = chatEntry(r, kind); entry.status = 'eligible'; entry.taskId = r.state().task.id; entry.analysis = { greeting: '您好' };
    workerStub(r, () => ({ ok: false, error: '页面异常', healthIssue: { kind } }));
    await r.api.pump();
    assert.equal(r.state().task.status === 'running', kind === 'transient');
    if (kind === 'transient') { assert.equal(r.state().entries[entry.key].handoff, false); assert.equal(r.state().entries[entry.key].retry.action, 'send'); }
  }
});
function modelResult() {
  return { scoreBreakdown: { skills: 27, experience: 17, requirements: 18, preferences: 18, bonus: 0 }, hasBonusRequirements: true,
    suitable: true, uncertain: false, reason: '匹配', doubts: [], greeting: '您好，我开发过前端项目', greetingEvidence: ['开发过前端项目'] };
}
function respondAI(args, value) {
  queueMicrotask(() => args.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] }) }));
}
function workerStub(r, respond) {
  r.context.GM_getTabs = callback => callback({});
  r.context.GM_openInTab = () => {
    const cmd = r.store.get('bossai.v1.command');
    r.store.set('bossai.v1.result.' + cmd.id, respond(cmd));
    return { closed: false, close() { this.closed = true; } };
  };
}
function chatEntry(r, id) {
  const job = { jobId: id, recruiterId: 'boss-' + id, url: 'https://www.zhipin.com/job_detail/' + id + '.html' };
  const key = C.pair(job), entry = { key, job, status: 'contacted' };
  r.state().entries[key] = entry; r.state().task.nextChatAt = 0; return entry;
}

test('work type changes navigate before any job or send action and preserve the task', async () => {
  const r = runtime({ internshipOnly: false }); r.api.start(); const id = r.state().task.id;
  let target = ''; r.location.assign = url => { target = url; };
  r.context.BossAdapter.Adapter.prototype.cards = () => { assert.fail('must navigate first'); };
  await r.api.pump(); assert.equal(new URL(target).searchParams.get('jobType'), '1901');
  assert.equal(r.state().task.id, id); assert.equal(r.state().task.contacts, 0);
  assert.ok(r.state().task.employmentSync);
});

test('read-only temporary errors retry twice then hand off only that job', async () => {
  const r = runtime(); r.api.start();
  r.context.BossAdapter.Adapter.prototype.cards = () => [{ jobId: 'j', url: 'https://www.zhipin.com/job_detail/j.html' }];
  workerStub(r, () => ({ ok: false, error: '职位详情未加载' }));
  await r.api.pump(); let entry = Object.values(r.state().entries)[0];
  assert.equal(entry.retry.attempt, 1); assert.equal(entry.handoff, false);
  for (const delay of [60000, 120000]) {
    for (let i = 0; i < delay / 5000; i++) r.advance(5000);
    await r.api.pump();
  }
  entry = Object.values(r.state().entries)[0];
  assert.equal(entry.retry, undefined); assert.equal(entry.handoff, true);
  assert.equal(r.state().task.status, 'running'); assert.ok(r.state().task.visited.includes('j'));
});
test('manual stop cancels persisted delayed retries without starting any new page', async () => {
  const r = runtime({ autoSend: true }); r.api.start(); const entry = chatEntry(r, 'cancel-retry');
  entry.retry = { action: 'history', taskId: r.state().task.id, at: r.context.Date.now() + 60000, attempt: 1 };
  r.api.stop('用户停止', true); assert.equal(r.state().entries[entry.key].retry, undefined);
  r.context.GM_openInTab = () => { assert.fail('stopped retry must not open a tab'); };
  for (let i = 0; i < 13; i++) r.advance(5000);
  await r.api.pump(); assert.equal(r.state().task.status, 'stopped');
});

test('temporary send failure before any page click retries the existing reservation once without extra quota', async () => {
  const r = runtime({ autoSend: true, sendIntervalSeconds: 1 }); r.api.start();
  const job = { jobId: 'safe', recruiterId: 'r', url: 'https://www.zhipin.com/job_detail/safe.html' }, key = C.pair(job);
  r.state().entries[key] = { key, job, status: 'eligible', taskId: r.state().task.id, analysis: { greeting: '您好，我有项目经验' } };
  let calls = 0;
  workerStub(r, () => ++calls === 1 ? { ok: false, error: '操作按钮不可用' } : { ok: true, data: { confirmed: true } });
  await r.api.pump(); assert.equal(r.state().entries[key].retry.action, 'send'); assert.equal(r.state().task.contacts, 1);
  for (let i = 0; i < 13; i++) r.advance(5000);
  await r.api.pump(); assert.equal(calls, 2); assert.equal(r.state().task.contacts, 1);
  assert.equal(r.state().outbox.length, 1); assert.equal(r.state().outbox[0].status, 'sent');
});

test('temporary errors after opening or clicking send never schedule automatic replays', async () => {
  for (const stage of ['opening', 'drafting', 'clicked']) {
    const r = runtime({ autoSend: true }); r.api.start(); const entry = chatEntry(r, stage);
    entry.status = 'eligible'; entry.taskId = r.state().task.id; entry.analysis = { greeting: '您好' };
    workerStub(r, cmd => { r.store.set('bossai.v1.sendStage.' + cmd.sendId, { stage, commandId: cmd.id }); return { ok: false, error: '操作按钮不可用' }; });
    await r.api.pump(); assert.equal(r.state().entries[entry.key].retry, undefined);
    assert.equal(r.state().entries[entry.key].handoff, true);
  }
});
test('safe delayed send reservations survive refresh without being turned into uncertain sends', async () => {
  const original = runtime({ autoSend: true }); original.api.start(); const entry = chatEntry(original, 'queued'); entry.status = 'eligible';
  const item = C.reserve(original.state(), original.c, original.context.Date.now(), 'contact', entry, { text: '您好' });
  original.store.set('bossai.v1.sendStage.' + item.id, { stage: 'prepared', commandId: 'failed-before-opening' });
  entry.retry = { action: 'send', sendId: item.id, taskId: original.state().task.id, at: original.context.Date.now() + 60000, attempt: 1 };
  original.api.releaseLease(); const restored = runtime({ autoSend: true }, original.store, 2000);
  await restored.api.pump();
  assert.equal(restored.state().outbox[0].status, 'pending'); assert.equal(restored.state().entries[entry.key].handoff, undefined);
  assert.equal(restored.state().entries[entry.key].retry.action, 'send');
  restored.api.stop('手动停止', true); assert.equal(restored.state().outbox[0].status, 'not-sent');
});

test('maintenance deletes only aged temporary data and preserves uncertain send evidence', () => {
  const r = runtime(); r.api.start(); const old = r.context.Date.now() - 8 * 86400000;
  for (const key of ['result.old', 'consumed.protected']) { r.store.set('bossai.v1.' + key, true); r.store.set('bossai.v1.meta.' + key, old); }
  r.state().outbox.push({ id: 'uncertain', status: 'uncertain', key: 'keep' });
  r.store.set('bossai.v1.sendStage.uncertain', { stage: 'clicked', commandId: 'protected' });
  const result = r.api.maintainRuntime(true);
  assert.equal(result.removed, 1); assert.equal(r.store.has('bossai.v1.result.old'), false);
  assert.equal(r.store.get('bossai.v1.consumed.protected'), true); assert.equal(r.state().outbox[0].status, 'uncertain');
  assert.equal(r.api.maintainRuntime(), null);
});

test('AI resume organization is grounded in extracted text and does not save configuration automatically', async () => {
  const r = runtime(); const source = '教育背景：本科在读。项目经历：开发过Python数据分析工具，负责测试与数据清洗。';
  r.context.GM_xmlhttpRequest = args => { assert.equal(JSON.parse(args.data).messages.length, 2); respondAI(args,
    { sections: [{ title: '项目经历', facts: ['开发过Python数据分析工具，负责测试与数据清洗。'] }] }); return { abort() {} }; };
  const output = await r.api.generateResume(r.c, source);
  assert.ok(output.includes('Python数据分析')); assert.equal(r.store.get('bossai.v1.config').resume, r.c.resume);
});
test('invalid or fabricated AI resume facts are retried three times and rejected', async () => {
  const r = runtime(); quickRetryTimers(r); let calls = 0;
  r.context.GM_xmlhttpRequest = args => { calls++; respondAI(args, { sections: [{ title: '项目经历', facts: ['十年架构经验'] }] }); return { abort() {} }; };
  await assert.rejects(r.api.generateResume(r.c, '本科在读，熟悉Python，开发过软件测试和数据处理项目。'), /连续尝试3次/);
  assert.equal(calls, 3);
});

function interruptedExecution(type = 'inspect', stage = 'clicked', data = null) {
  const original = runtime({ autoSend: true }); original.api.start();
  const s = original.state(), taskId = s.task.id;
  const job = { jobId: 'interrupted', recruiterId: 'recruiter', url: 'https://www.zhipin.com/job_detail/interrupted.html' };
  const key = C.pair(job); s.entries[key] = { key, job, status: type === 'contact' ? 'uncertain' : 'contacted' };
  const command = { id: 'old-command', workerId: 'old-worker', taskId, owner: s.task.leaseToken, type, args: { job }, createdAt: original.context.Date.now() };
  if (['contact', 'reply', 'resume', 'openOnly'].includes(type)) {
    command.sendId = 'old-send'; s.outbox.push({ id: 'old-send', taskId, kind: type, key, status: 'pending', payload: {}, stage: 'reserved' });
    s.task.contacts = 6; s.lastSendAt = original.context.Date.now();
    original.store.set('bossai.v1.sendStage.old-send', { stage, commandId: command.id });
    if (stage === 'clicked' || stage === 'confirmed') original.store.set('bossai.v1.consumed.' + command.id, true);
  }
  original.store.set('bossai.v1.command', command);
  original.store.set('bossai.v1.activeWorker', { id: command.workerId, commandId: command.id });
  original.store.set('bossai.v1.workerRegistered.' + command.workerId, true);
  if (data) original.store.set('bossai.v1.result.' + command.id, { ok: true, data });
  const restored = runtime({ autoSend: true }, original.store, 20000);
  restored.context.GM_getTabs = callback => callback({});
  return { ...restored, key, taskId, command };
}

test('leadership change cancels interrupted read commands and continues the same task', async () => {
  for (const type of ['inspect', 'history']) {
    const r = interruptedExecution(type); let opened = 0;
    r.context.GM_openInTab = () => { opened++; assert.fail('recovery only cleans the old worker'); };
    await r.api.pump();
    assert.equal(r.state().task.status, 'running'); assert.equal(r.state().task.id, r.taskId);
    assert.equal(r.store.get('bossai.v1.command'), null); assert.equal(r.store.get('bossai.v1.cancel.old-command'), true);
    assert.equal(r.store.get('bossai.v1.activeWorker'), null); assert.equal(r.state().entries[r.key].handoff, undefined);
    assert.equal(opened, 0);
  }
});

test('uncertain sends are quarantined per conversation without replay or task reset on takeover', async () => {
  for (const type of ['contact', 'reply', 'resume', 'openOnly']) {
    const r = interruptedExecution(type); await r.api.pump();
    assert.equal(r.state().task.status, 'running'); assert.equal(r.state().task.contacts, 6);
    assert.equal(r.state().outbox[0].status, 'uncertain'); assert.equal(r.state().entries[r.key].handoff, true);
    assert.equal(r.store.get('bossai.v1.command'), null);
    assert.equal(r.state().outbox.length, 1);
  }
});

test('confirmed worker receipts survive takeover even if the result was not consumed by the old main page', async () => {
  for (const result of [{ confirmed: true }, null]) {
    const r = interruptedExecution('contact', 'confirmed', result); await r.api.pump();
    assert.equal(r.state().task.status, 'running'); assert.equal(r.state().outbox[0].status, 'sent');
    assert.equal(r.state().entries[r.key].status, 'contacted'); assert.equal(r.state().entries[r.key].handoff, undefined);
    assert.equal(r.state().task.contacts, 6);
  }
});

test('manual stop during recovery is respected and a pending cleanup cannot be run twice', async () => {
  const r = interruptedExecution('inspect'); let callback, queries = 0;
  r.context.GM_getTabs = cb => { queries++; callback = cb; };
  const first = r.api.pump(); await new Promise(resolve => setImmediate(resolve));
  await r.api.pump(); assert.equal(queries, 1);
  r.api.stop('用户停止', true); callback({}); await first;
  assert.equal(r.state().task.status, 'stopped'); assert.equal(r.state().task.id, r.taskId);
});

test('recovery still pauses if an old worker cannot be closed', async () => {
  const r = interruptedExecution('inspect');
  r.context.GM_getTabs = cb => cb({ old: { bossAIWorkerId: 'old-worker' } });
  r.context.setTimeout = (fn, ms) => setTimeout(fn, ms === 200 ? 0 : ms);
  await r.api.pump(); assert.equal(r.state().task.status, 'paused');
  assert.ok(r.state().logs.some(x => x.message.includes('旧工作页关闭未确认')));
});

test('starting a new task with old conversations reads a job before polling chats', async () => {
  const r = runtime({ autoSend: true, refreshMinSeconds: 10, refreshMaxSeconds: 15 }); r.api.start(); chatEntry(r, 'old-chat');
  r.api.stop('重新启动', true); r.api.start();
  r.context.BossAdapter.Adapter.prototype.cards = () => [{ jobId: 'new', url: 'https://www.zhipin.com/job_detail/new.html' }];
  const calls = [];
  workerStub(r, cmd => { calls.push(cmd.type); return { ok: true, data: { jobId: 'new', recruiterId: 'boss-new', city: '上海', title: '实习开发', employmentType: '实习' } }; });
  await r.api.pump(); assert.deepEqual(calls, ['inspect']); assert.equal(r.state().task.status, 'running');
  assert.ok(r.state().logs.some(x => x.message.includes('开始读取职位详情')));
});

test('waiting status explains page registration, elapsed time and scan cooldown without private data', () => {
  const r = runtime(); r.api.start(); const taskId = r.state().task.id;
  r.store.set('bossai.v1.command', { taskId, type: 'inspect', workerId: 'w', phase: 'new', createdAt: r.context.Date.now() - 5000 });
  assert.match(r.api.currentActivity(), /读取职位详情.*5秒.*90秒.*等待后台工作页/);
  r.store.set('bossai.v1.workerRegistered.w', true); assert.equal(r.api.currentActivity().includes('等待后台工作页加载'), false);
  r.store.delete('bossai.v1.command'); r.state().task.nextScanAt = r.context.Date.now() + 10000;
  assert.match(r.api.currentActivity(), /等待下一轮扫描，约10秒/);
  r.api.stop('停止'); assert.equal(r.api.currentActivity(), '');
});

test('AI retries transport, JSON and score failures up to three total attempts', async () => {
  for (const failure of ['transport', 'json', 'score']) {
    const r = runtime(); quickRetryTimers(r); let calls = 0;
    r.context.GM_xmlhttpRequest = args => {
      calls++;
      assert.ok(JSON.parse(args.data).messages[0].content.includes('严格只输出一个完整的合法 JSON 对象'));
      if (calls < 3 && failure === 'transport') queueMicrotask(() => args.onerror({ status: 503 }));
      else respondAI(args, calls < 3 ? failure === 'json' ? '{broken' : { ...modelResult(), scoreBreakdown: {} } : modelResult());
      return { abort() {} };
    };
    assert.equal((await r.api.analyze(r.c, { jobId: 'j' })).score, 80); assert.equal(calls, 3);
  }
});

test('bad greeting evidence recovers in one AI call without stopping the task', async () => {
  const r = runtime(); r.api.start(); let calls = 0;
  r.context.GM_xmlhttpRequest = args => { calls++; respondAI(args, { ...modelResult(), greeting: '虚构训练经验', greetingEvidence: [] }); return { abort() {} }; };
  const result = await r.api.analyze(r.c, { jobId: 'j' });
  assert.equal(calls, 1); assert.equal(result.evidenceRecovered, true); assert.equal(result.greeting.includes('虚构训练经验'), false);
  assert.equal(r.state().task.status, 'running');
});

test('three invalid AI responses stop the task instead of endlessly skipping every job', async () => {
  const r = runtime(); quickRetryTimers(r); r.api.start(); let calls = 0;
  r.context.BossAdapter.Adapter.prototype.cards = () => [{ jobId: 'j', url: 'https://www.zhipin.com/job_detail/j.html' }];
  workerStub(r, () => ({ ok: true, data: { jobId: 'j', recruiterId: 'r', city: '北京', employmentType: '实习', title: '开发实习' } }));
  r.context.GM_xmlhttpRequest = args => { calls++; respondAI(args, '{broken'); return { abort() {} }; };
  await r.api.pump(); assert.equal(calls, 3); assert.equal(r.state().task.status, 'paused');
  assert.ok(r.state().logs.some(x => x.message.includes('连续尝试3次失败')));
});

test('manual stop after a failed AI call prevents subsequent retry requests', async () => {
  const r = runtime(); quickRetryTimers(r); r.api.start(); let calls = 0;
  r.context.GM_xmlhttpRequest = args => { calls++; queueMicrotask(() => { args.onerror({ status: 503 }); r.api.stop('用户停止', true); }); return { abort() {} }; };
  await assert.rejects(r.api.analyze(r.c, { jobId: 'j' })); assert.equal(calls, 1);
});

test('a failed clicked send remains uncertain and is not retried while the task continues', async () => {
  const r = runtime({ autoSend: true }); r.api.start(); const entry = chatEntry(r, 'send');
  entry.status = 'eligible'; entry.taskId = r.state().task.id; entry.analysis = { greeting: '您好' }; let calls = 0;
  workerStub(r, cmd => { calls++; r.store.set('bossai.v1.sendStage.' + cmd.sendId, { stage: 'clicked', commandId: cmd.id });
    r.store.set('bossai.v1.consumed.' + cmd.id, true); return { ok: false, error: '无法判别消息方向，已停止该会话' }; });
  await r.api.pump(); assert.equal(r.state().task.status, 'running'); assert.equal(r.state().outbox[0].status, 'uncertain');
  assert.equal(r.state().entries[entry.key].handoff, true); assert.equal(calls, 1);
});

test('login and platform restrictions still stop globally even inside a chat action', async () => {
  const r = runtime({ autoSend: true }); r.api.start(); const entry = chatEntry(r, 'blocked'); entry.status = 'eligible'; entry.taskId = r.state().task.id; entry.analysis = { greeting: '您好' };
  workerStub(r, () => ({ ok: false, error: '检测到登录、验证或平台限制，请手动处理后重新启动' }));
  await r.api.pump(); assert.equal(r.state().task.status, 'paused');
});
test('an unreadable job is marked visited and later jobs are still inspected', async () => {
  const r = runtime(); r.api.start(); const seen = [];
  r.context.BossAdapter.Adapter.prototype.cards = () => ['first', 'second'].map(jobId => ({ jobId, url: 'https://www.zhipin.com/job_detail/' + jobId + '.html' }));
  workerStub(r, cmd => { seen.push(cmd.args.job.jobId); return { ok: false, error: '页面选择器无效，无法读取职位' }; });
  await r.api.pump(); assert.equal(r.state().task.status, 'running'); assert.ok(r.state().task.visited.includes('first'));
  r.advance(61000); r.advance(2000); await r.api.pump();
  await r.api.pump(); assert.deepEqual(seen, ['first', 'second']);
});

test('manual stop blocks scheduler restart for the same Beijing time window', async () => {
  const r = runtime({ scheduleEnabled: true, startTime: '09:00', stopTime: '18:00' });
  r.api.start(); const id = r.state().task.id;
  r.api.stop('用户停止', true); await r.api.pump();
  assert.equal(r.state().task.status, 'stopped'); assert.equal(r.state().task.id, id);
  assert.ok(r.state().blockedWindow);
  r.advance(86400000); r.advance(2000); await r.api.pump();
  assert.equal(r.state().task.source, 'schedule'); assert.notEqual(r.state().task.id, id);
});

test('exhausted results refresh after random wait and resume the same task after reload', async () => {
  const r = runtime(); r.api.start(); const id = r.state().task.id; let reloads = 0;
  r.location.reload = () => reloads++;
  r.context.BossAdapter.Adapter.prototype.cards = () => [];
  r.context.BossAdapter.Adapter.prototype.advance = () => 'end';
  r.state().task.contacts = 7; r.state().task.visited.push('old');
  await r.api.pump(); assert.equal(r.state().task.exhausted, true); assert.equal(reloads, 0);
  await r.api.pump(); assert.equal(reloads, 0);
  r.advance(61000); r.advance(2000); await r.api.pump();
  assert.equal(reloads, 1); assert.equal(r.state().task.exhausted, false); assert.equal(r.state().task.contacts, 7);
  const restored = runtime({}, r.store, 80000);
  restored.context.BossAdapter.Adapter.prototype.cards = () => [];
  restored.context.BossAdapter.Adapter.prototype.advance = () => 'end';
  await restored.api.pump();
  assert.equal(restored.state().task.status, 'running'); assert.equal(restored.state().task.id, id);
  assert.equal(restored.state().task.contacts, 7); assert.ok(restored.state().task.visited.includes('old'));
});

test('exhausted search switches category once, waits for confirmation and preserves quota and visited jobs', async () => {
  const r = runtime(); r.api.start(); const id = r.state().task.id; let clicks = 0;
  r.state().task.contacts = 9; r.state().task.visited.push('old'); r.state().task.exhausted = true;
  const proto = r.context.BossAdapter.Adapter.prototype;
  proto.planCategory = () => ({ label: 'Python(北京)', before: 'old' });
  proto.clickCategory = () => { clicks++; assert.equal(r.state().task.categoryPending.label, 'Python(北京)'); };
  proto.categoryChanged = () => true;
  await r.api.pump(); assert.equal(clicks, 1); assert.equal(r.state().task.categoryPending.label, 'Python(北京)');
  await r.api.pump(); assert.equal(clicks, 1);
  r.advance(2000); await r.api.pump();
  assert.equal(r.state().task.categoryPending, undefined); assert.equal(r.state().task.contacts, 9);
  assert.equal(r.state().task.id, id); assert.ok(r.state().task.visited.includes('old'));
  assert.equal(r.state().task.status, 'running');
});

test('unconfirmed category switching falls back to refresh without repeated clicks or stopping', async () => {
  const r = runtime(); r.api.start(); r.state().task.exhausted = true; let clicks = 0, reloads = 0;
  r.location.reload = () => reloads++;
  const proto = r.context.BossAdapter.Adapter.prototype;
  proto.planCategory = () => ({ label: '测试(北京)', before: 'old' }); proto.clickCategory = () => clicks++;
  proto.categoryChanged = () => false;
  await r.api.pump(); r.advance(16000); r.advance(2000); await r.api.pump();
  assert.equal(clicks, 1); assert.equal(r.state().task.categoryPending, undefined);
  await r.api.pump(); assert.equal(reloads, 1); assert.equal(r.state().task.status, 'running');
});

test('a persisted category transition resumes after reload and expired tasks cannot click categories', async () => {
  const r = runtime(); r.api.start(); r.state().task.categoryPending = { label: 'Python(北京)', before: 'old', at: r.context.Date.now() };
  const restored = runtime({}, r.store, 25000); restored.context.BossAdapter.Adapter.prototype.categoryChanged = () => true;
  await restored.api.pump(); await restored.api.pump(); assert.equal(restored.state().task.categoryPending, undefined);
  restored.state().task.exhausted = true; restored.state().task.endAt = 1;
  restored.context.BossAdapter.Adapter.prototype.clickCategory = () => assert.fail('expired tasks must not click');
  await restored.api.pump(); assert.equal(restored.state().task.status, 'paused');
});

test('refresh returning to recommendation restores the last confirmed category once', async () => {
  const r = runtime(); r.api.start(); r.state().task.currentCategory = 'Python(北京)'; let clicks = 0;
  const proto = r.context.BossAdapter.Adapter.prototype;
  proto.categoryChoices = () => [{ label: '推荐', active: true }, { label: 'Python(北京)', active: false }];
  proto.categoryFingerprint = () => 'old'; proto.clickCategory = label => { clicks++; assert.equal(label, 'Python(北京)'); };
  proto.categoryChanged = () => false;
  await r.api.pump(); assert.equal(clicks, 1); assert.equal(r.state().task.categoryPending.restoring, true);
  r.advance(16000); r.advance(2000); await r.api.pump();
  assert.equal(r.state().task.currentCategory, undefined); assert.equal(r.state().task.categoryPending, undefined);
  assert.equal(r.state().task.status, 'running');
});

test('rejected entry dispatches open-only without a message and is not treated as contacted', async () => {
  const r = runtime({ autoSend: true, verifiedEmptyContact: true }); r.api.start(); const entry = chatEntry(r, 'reject');
  entry.status = 'rejected'; entry.taskId = r.state().task.id; let calls = 0;
  workerStub(r, cmd => { calls++; assert.equal(cmd.type, 'openOnly'); assert.equal(cmd.args.text, undefined); return { ok: true, data: { opened: true } }; });
  r.state().task.contacts = r.c.maxContacts; r.state().lastSendAt = Date.parse('2026-10-14T02:00:00Z');
  const last = r.state().lastSendAt;
  await r.api.pump(); assert.equal(calls, 1); assert.equal(r.state().task.contacts, r.c.maxContacts);
  assert.equal(r.state().lastSendAt, last);
  assert.equal(r.state().entries[entry.key].status, 'rejected'); assert.equal(r.state().entries[entry.key].handoff, true);
  assert.equal(r.state().outbox[0].status, 'opened'); assert.equal(r.state().task.status, 'running');
});

test('interrupted open-only actions do not move the real-message interval clock', () => {
  const r = runtime(); r.api.start(); const s = r.state(); s.lastSendAt = 123;
  s.entries.x = { key: 'x', status: 'rejected' };
  s.outbox.push({ id: 'open', key: 'x', kind: 'openOnly', status: 'pending' });
  r.api.stop('停止'); assert.equal(r.state().lastSendAt, 123);
  assert.equal(r.state().outbox[0].status, 'uncertain');
});

test('a previously scored rejected job can open once when it is visible in the current search', async () => {
  const r = runtime({ autoSend: true, verifiedEmptyContact: true }); r.api.start(); const entry = chatEntry(r, 'old-reject');
  entry.status = 'rejected'; entry.taskId = 'old-task'; entry.analysis = { score: 40 };
  r.context.BossAdapter.Adapter.prototype.cards = () => [{ jobId: entry.job.jobId, url: entry.job.url }];
  workerStub(r, cmd => { assert.equal(cmd.type, 'openOnly'); return { ok: true, data: { opened: true } }; });
  await r.api.pump(); assert.equal(r.state().entries[entry.key].openOnlyStatus, 'opened');
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

test('job analysis sends the weighted optional-condition rule and uses the computed total', async () => {
  const r = runtime(); let called = false;
  r.context.GM_xmlhttpRequest = args => {
    called = true;
    const request = JSON.parse(args.data), system = request.messages[0].content;
    assert.ok(system.includes('有下列经历者优先')); assert.ok(system.includes('不得重复扣分'));
    assert.ok(system.includes('合计最多10分')); assert.ok(system.includes('scoreBreakdown'));
    assert.equal(JSON.parse(request.messages[1].content).job.jobId, 'job1');
    queueMicrotask(() => args.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ score: 12,
      scoreBreakdown: { skills: 27, experience: 17, requirements: 18, preferences: 18, bonus: 0 }, hasBonusRequirements: true,
      suitable: false, uncertain: true, reason: '主要条件匹配，缺少的仅为加分经历', doubts: ['加分经历未证实'], greeting: '您好，我开发过前端项目，对该岗位感兴趣', greetingEvidence: ['开发过前端项目'] }) } }] }) }));
    return { abort() {} };
  };
  const result = await r.api.analyze(r.c, { jobId: 'job1' });
  assert.equal(called, true); assert.equal(result.score, 80); assert.equal(result.scoreBreakdown.bonus, 0);
  assert.equal(C.decide(result, r.c), 'eligible');
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
test('manual AI deadline uses the configured limit and preserves timeout when abort fires synchronously', async () => {
  const r = runtime({ aiTimeoutSeconds: 90 }), timers = []; let request, aborts = 0;
  r.context.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return 1; }; r.context.clearTimeout = () => {};
  r.context.GM_xmlhttpRequest = args => { request = args; return { abort() { aborts++; args.onabort(); } }; };
  const pending = r.api.requestAI(r.c, 'test', { resume: 'private-resume-text' }, '职位分析');
  assert.equal(request.timeout, 90000); assert.equal(timers[0].ms, 90000);
  const rejected = assert.rejects(pending, e => /职位分析请求超时/.test(e.message) && e.message.includes('90秒') && !e.message.includes('private-resume-text') && !e.message.includes('fake-test-key'));
  timers[0].fn(); await rejected; assert.equal(aborts, 1);
  request.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: '{"late":true}' } }] }) });
});
test('native AI timeout reports the configured purpose without issuing a retry', async () => {
  const r = runtime({ aiTimeoutSeconds: 240 }); let request, calls = 0;
  r.context.GM_xmlhttpRequest = args => { request = args; calls++; return { abort() {} }; };
  const pending = r.api.requestAI(r.c, 'test', {}, '聊天回复');
  const rejected = assert.rejects(pending, /聊天回复请求超时.*240秒/);
  request.ontimeout(); await rejected; assert.equal(calls, 1);
});
test('stopping a long-running AI request remains cancellation rather than timeout', async () => {
  const r = runtime({ aiTimeoutSeconds: 600 }); r.api.start(); let aborts = 0;
  r.context.GM_xmlhttpRequest = args => ({ abort() { aborts++; args.onabort(); } });
  const pending = r.api.requestAI(r.c, 'test', {});
  const rejected = assert.rejects(pending, /^Error: 请求已停止$/);
  r.api.stop('停止'); await rejected; assert.equal(aborts, 1); assert.equal(r.state().task.status, 'paused');
});
test('short connection tests require ok:true and do not mistake arbitrary JSON for success', async () => {
  for (const [value, success] of [[{ ok: true }, true], [{ ok: false }, false], [{ error: 'test-error' }, false], [null, false]]) {
    const r = runtime();
    r.context.GM_xmlhttpRequest = args => {
      assert.equal(JSON.parse(args.data).messages[1].content, '{"test":true}');
      queueMicrotask(() => args.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }) }));
      return { abort() {} };
    };
    if (success) assert.equal((await r.api.testConnection(r.c)).ok, true);
    else await assert.rejects(r.api.testConnection(r.c), /不能判定测试通过/);
  }
});
test('error envelopes, truncated JSON and absent text are reported without exposing raw response data', async () => {
  for (const [envelope, reason] of [[{ error: { message: 'fake-test-key' } }, /服务返回错误/],
    [{ choices: [{ finish_reason: 'length', message: { content: '{"partial":' } }] }, /被截断/],
    [{ choices: [{ message: { content: null } }] }, /文字正文/],
    [{ choices: [] }, /文字正文/]]) {
    const r = runtime();
    r.context.GM_xmlhttpRequest = args => {
      queueMicrotask(() => args.onload({ status: 200, responseText: JSON.stringify(envelope) }));
      return { abort() {} };
    };
    await assert.rejects(r.api.requestAI(r.c, 'test', {}), e => reason.test(e.message) && !e.message.includes('fake-test-key'));
  }
});
test('formal analysis only sends necessary job text, excluding URLs and local identity/automation fields', async () => {
  const r = runtime(); let payload;
  r.context.GM_xmlhttpRequest = args => {
    payload = JSON.parse(JSON.parse(args.data).messages[1].content);
    queueMicrotask(() => args.onerror({ status: 503 })); return { abort() {} };
  };
  await assert.rejects(r.api.analyze(r.c, { jobId: 'j', title: '测试岗位', description: '测试描述', city: '北京', salary: '100元/天', company: '示例公司',
    url: 'https://www.zhipin.com/job_detail/j.html?securityId=private-local-value', recruiterId: 'local-id', contactTargetJobId: 'j', identityDiagnostic: { token: 'private-local-value' } }));
  assert.equal(payload.job.description, '测试描述'); assert.equal(payload.job.salary, '100元/天');
  assert.equal(JSON.stringify(payload).includes('private-local-value'), false);
  assert.equal(Object.hasOwn(payload.job, 'recruiterId'), false);
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
test('first contact preparation and inspection both open in background', async () => {
  const r = runtime(); r.api.start();
  const options = [];
  r.context.GM_getTabs = callback => callback({});
  r.context.GM_openInTab = (url, setting) => {
    options.push(setting);
    const cmd = r.store.get('bossai.v1.command');
    r.store.set('bossai.v1.result.' + cmd.id, { ok: true, data: {} });
    return { closed: false, close() { this.closed = true; } };
  };
  for (const type of ['inspect', 'contact'])
    await r.api.command(type, { job: { url: 'https://www.zhipin.com/job_detail/test.html' } }, r.state().task.id);
  assert.equal(options[0].active, false);
  assert.equal(options[1].active, false);
  assert.equal(options[1].setParent, true);
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

test('confirmed handle closure overrides stale registry data and cleanup stays idempotent', async () => {
  const r = runtime(); r.api.start();
  r.store.set('bossai.v1.activeWorker', { id: 'old' });
  let registryReads = 0;
  r.context.GM_getTabs = cb => { registryReads++; cb({ old: { bossAIWorkerId: 'old' } }); };
  const handle = { closed: false, close() { this.closed = true; } };
  assert.equal(await r.api.closeManagedWorker('old', handle), true);
  assert.equal(await r.api.closeManagedWorker('old'), true);
  assert.equal(registryReads, 0); assert.equal(r.store.get('bossai.v1.activeWorker'), null);
  assert.ok(r.store.get('bossai.v1.workerRetired.old'));
  assert.equal(r.store.get('bossai.v1.closeWorker.old'), true);
});

test('registered workers need consecutive absent registry snapshots before retirement', async () => {
  const r = runtime(); let reads = 0;
  r.store.set('bossai.v1.activeWorker', { id: 'old' }); r.store.set('bossai.v1.workerRegistered.old', true);
  r.context.setTimeout = (fn, ms) => setTimeout(fn, ms === 200 ? 0 : ms);
  r.context.GM_getTabs = cb => { reads++; cb(reads === 2 ? { old: { bossAIWorkerId: 'old' } } : {}); };
  assert.equal(await r.api.closeManagedWorker('old'), true); assert.equal(reads, 4);
  assert.equal(await r.api.closeManagedWorker('old'), true);
});

test('unknown old workers never silently retire merely because the registry is empty', async () => {
  const r = runtime(); r.store.set('bossai.v1.activeWorker', { id: 'unknown' });
  r.context.setTimeout = (fn, ms) => setTimeout(fn, ms === 200 ? 0 : ms);
  r.context.GM_getTabs = cb => cb({});
  assert.equal(await r.api.closeManagedWorker('unknown'), false);
  assert.equal(r.store.has('bossai.v1.workerRetired.unknown'), false);
  assert.equal(r.store.get('bossai.v1.activeWorker').id, 'unknown');
});

test('manual stale-state cleanup requires confirmation and preserves uncertain send records', async () => {
  for (const approved of [false, true]) {
    const r = interruptedExecution('contact'); r.api.stop('停止', true);
    r.store.delete('bossai.v1.workerRegistered.old-worker');
    r.context.setTimeout = (fn, ms) => setTimeout(fn, ms === 200 ? 0 : ms);
    let confirmations = 0; r.context.window = { confirm() { confirmations++; return approved; } };
    await r.api.clearWorkerBlock();
    assert.equal(confirmations, 1);
    assert.equal(r.store.get('bossai.v1.activeWorker') === null, approved);
    assert.equal(r.state().outbox[0].status, 'uncertain'); assert.equal(r.state().task.contacts, 6);
    assert.equal(r.state().entries[r.key].handoff, true);
    if (approved) assert.equal(r.store.get('bossai.v1.workerRetired.old-worker').manual, true);
  }
});

test('manual cleanup refuses running tasks and still-visible worker tabs', async () => {
  const r = runtime(); r.api.start();
  await assert.rejects(r.api.clearWorkerBlock(), /先停止/);
  r.api.stop('停止', true); r.store.set('bossai.v1.activeWorker', { id: 'old' });
  r.context.setTimeout = (fn, ms) => setTimeout(fn, ms === 200 ? 0 : ms);
  r.context.GM_getTabs = cb => cb({ old: { bossAIWorkerId: 'old' } });
  r.context.window = { confirm() { assert.fail('visible worker must not be retired by confirmation'); } };
  await assert.rejects(r.api.clearWorkerBlock(), /仍检测到旧工作页/);
  assert.equal(r.store.has('bossai.v1.workerRetired.old'), false);
});

test('retiring an old id cannot clear a different active worker', async () => {
  const r = runtime(); r.store.set('bossai.v1.activeWorker', { id: 'new' });
  assert.equal(await r.api.closeManagedWorker('old', { closed: true, close() {} }), true);
  assert.equal(r.store.get('bossai.v1.activeWorker').id, 'new');
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
  second.api.renewLease(); second.api.completeClearActivity();
  assert.equal(first.state().task.status, 'stopped'); assert.equal(first.state().entries.pending, undefined);
});
test('a detail page clears a stopped task without any search page', async () => {
  const r = runtime(); r.api.start(); r.api.stop('停止', true);
  r.state().entries.pending = { key: 'pending', status: 'review' };
  r.location.pathname = '/job_detail/test.html'; r.api.renewLease();
  r.api.requestClearActivity();
  r.advance(2000); await r.api.pump();
  assert.equal(r.state().entries.pending, undefined); assert.equal(r.state().logs.length, 0);
  assert.equal(r.store.get('bossai.v1.clearActivityRequest'), null);
  assert.equal(r.state().task.status, 'stopped');
  // The temporary maintenance lease never grants permission to run jobs from detail pages.
  r.api.renewLease(); assert.throws(() => r.api.start());
});
test('clear during an in-flight AI request completes without waiting for pump cleanup', async () => {
  const r = runtime(); r.api.start();
  r.state().entries.pending = { key: 'pending', status: 'review' };
  r.context.BossAdapter.Adapter.prototype.cards = () => [{ jobId: 'job1', url: 'https://www.zhipin.com/job_detail/job1.html' }];
  r.context.GM_getTabs = callback => callback({});
  r.context.GM_openInTab = () => {
    const cmd = r.store.get('bossai.v1.command');
    r.store.set('bossai.v1.result.' + cmd.id, { ok: true, data: { jobId: 'job1', recruiterId: 'boss1',
      title: '实习开发', city: '北京', employmentType: '实习', description: '测试岗位' } });
    return { closed: false, close() { this.closed = true; } };
  };
  let aiPending = false;
  r.context.GM_xmlhttpRequest = () => { aiPending = true; return { abort() {} }; };
  const pending = r.api.pump();
  for (let i = 0; i < 1000 && !aiPending; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(aiPending, true);
  r.api.requestClearActivity();
  // Still in the same call stack: the previous pump's finally has not run yet.
  assert.equal(r.store.get('bossai.v1.clearActivityRequest'), null);
  assert.equal(r.state().entries.pending, undefined); assert.equal(r.state().logs.length, 0);
  await pending;
  assert.equal(r.state().task.status, 'stopped'); assert.equal(r.state().logs.length, 0);
});
test('clear during a pending start prevents that start from reviving the task', async () => {
  const r = runtime(); const pending = r.api.requestStart();
  r.api.requestClearActivity();
  assert.equal(r.store.get('bossai.v1.clearActivityRequest'), null);
  await assert.rejects(pending, /清空操作取消/);
  assert.notEqual(r.state().task?.status, 'running');
});
test('a scored visible job is skipped across new tasks without opening a page or calling AI', async () => {
  const r = runtime(); r.api.start(); const s = r.state();
  s.entries.known = { key: 'known', job: { jobId: 'job1' }, analysis: { score: 80 }, status: 'review' };
  r.api.stop('停止', true); r.api.start(); let opened = 0, called = 0;
  r.context.BossAdapter.Adapter.prototype.cards = () => [{ jobId: 'job1', url: 'https://www.zhipin.com/job_detail/job1.html' }];
  r.context.BossAdapter.Adapter.prototype.advance = () => 'end';
  r.context.GM_openInTab = () => { opened++; throw new Error('不应读页'); };
  r.context.GM_xmlhttpRequest = () => { called++; throw new Error('不应调用AI'); };
  await r.api.pump();
  assert.equal(opened, 0); assert.equal(called, 0); assert.ok(r.state().task.visited.includes('job1'));
  assert.ok(r.state().logs.some(item => item.message.includes('已有评分')));
});
test('explicitly approved retries are freshly inspected and scored despite a previous visible score', async () => {
  const r = runtime(); r.api.start(); const job = { jobId: 'job1', recruiterId: 'boss1', contactTargetJobId: 'job1',
    title: '开发实习', city: '北京', employmentType: '实习', description: '完整的测试职位描述', alreadyContacted: true };
  const key = C.pair(job); r.state().entries[key] = { key, job, analysis: { score: 66 }, retryApproved: true, status: 'review' };
  r.context.BossAdapter.Adapter.prototype.cards = () => [{ jobId: 'job1', url: 'https://www.zhipin.com/job_detail/job1.html' }];
  let opened = 0, called = 0;
  r.context.GM_getTabs = callback => callback({});
  r.context.GM_openInTab = () => { opened++; const cmd = r.store.get('bossai.v1.command');
    r.store.set('bossai.v1.result.' + cmd.id, { ok: true, data: job }); return { closed: false, close() { this.closed = true; } };
  };
  r.context.GM_xmlhttpRequest = args => { called++; queueMicrotask(() => args.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    scoreBreakdown: { skills: 27, experience: 17, requirements: 18, preferences: 18, bonus: 0 }, hasBonusRequirements: true,
    suitable: true, uncertain: false, reason: '匹配', doubts: [], greeting: '您好，我开发过前端项目，期待进一步沟通', greetingEvidence: ['开发过前端项目'] }) } }] }) })); return { abort() {} }; };
  await r.api.pump();
  assert.equal(opened, 1); assert.equal(called, 1); assert.equal(r.state().entries[key].analysis.score, 80);
  assert.equal(r.state().entries[key].analysis.scoringVersion, 2);
});

test('interruption distinguishes proven pre-click stages from clicked or legacy unknown sends', () => {
  for (const stage of ['prepared', 'opening', 'drafting', 'clicked', undefined]) {
    const r = runtime(); r.api.start(); const s = r.state();
    s.entries.x = { key: 'x', status: 'uncertain' }; s.outbox.push({ id: 'send', key: 'x', kind: 'contact', status: 'pending' });
    if (stage) r.store.set('bossai.v1.sendStage.send', { stage, commandId: 'cmd' });
    r.api.stop('选择器不匹配');
    const before = ['prepared', 'opening', 'drafting'].includes(stage);
    assert.equal(r.state().outbox[0].status, before ? 'not-sent' : 'uncertain');
    assert.equal(r.state().entries.x.status, before ? 'retryable' : 'uncertain');
    assert.ok(r.state().entries.x.note.includes('选择器不匹配'));
  }
});
test('a consumed command cannot be treated as proven unsent from an older stage', () => {
  const r = runtime(); r.api.start(); const s = r.state(); s.entries.x = { key: 'x', status: 'uncertain' };
  s.outbox.push({ id: 'send', key: 'x', kind: 'contact', status: 'pending' });
  r.store.set('bossai.v1.sendStage.send', { stage: 'prepared', commandId: 'cmd' }); r.store.set('bossai.v1.consumed.cmd', true);
  r.api.stop('停止'); assert.equal(r.state().outbox[0].status, 'uncertain');
});
test('explicit per-job unsent confirmation requires a stopped task and preserves quotas and spacing', () => {
  const r = runtime(); r.api.start(); r.state().task.contacts = 7; r.api.stop('停止', true);
  const s = r.state(), lastSend = s.lastSendAt; s.entries.x = { key: 'x', status: 'uncertain', handoff: true };
  s.outbox.push({ key: 'x', id: 'old', kind: 'contact', status: 'uncertain' });
  r.api.approveContactRetry('x');
  assert.equal(r.state().entries.x.status, 'review'); assert.equal(r.state().entries.x.retryApproved, true);
  assert.equal(r.state().outbox[0].status, 'reviewed-not-sent'); assert.equal(r.state().task.contacts, 7); assert.equal(r.state().lastSendAt, lastSend);
  r.api.start(); r.state().entries.x.status = 'uncertain'; assert.throws(() => r.api.approveContactRetry('x'), /先停止/);
});
test('confirmed local delivery cannot be unlocked with an unsent confirmation', () => {
  const r = runtime(); r.api.start(); r.api.stop('停止', true); const s = r.state();
  s.entries.x = { key: 'x', status: 'uncertain' }; s.outbox.push({ key: 'x', id: 'old', kind: 'contact', status: 'sent' });
  assert.throws(() => r.api.approveContactRetry('x'), /禁止重复/);
});
test('existing AI greeting is recorded as a duplicate rather than an unknown delivery', () => {
  const r = runtime(); r.api.start(); const s = r.state(); s.entries.x = { key: 'x', status: 'uncertain' };
  const item = { id: 'old', key: 'x', kind: 'contact', payload: {} }; s.outbox.push(item);
  r.api.settle(s, item, { confirmed: false, priorAI: true, reason: '已存在AI标注' });
  assert.equal(item.status, 'duplicate'); assert.equal(s.entries.x.status, 'contacted');
});


test('stopping during the before-open delay prevents opening a worker', async () => {
  const r = runtime({ beforeOpenSeconds: 2, refreshMinSeconds: 1, refreshMaxSeconds: 1 }); r.api.start();
  r.context.BossAdapter.Adapter.prototype.cards = () => [{ jobId: 'delay-job', url: 'https://www.zhipin.com/job_detail/delay-job.html' }];
  let opened = false;
  r.context.GM_openInTab = () => { opened = true; throw new Error('must not open'); };
  r.context.setTimeout = fn => { r.api.stop('用户停止', true); queueMicrotask(fn); };
  await r.api.pump(); assert.equal(opened, false); assert.equal(r.state().task.status, 'stopped');
});


test('legacy conversations and queued replies never cause inbox polling or sending', async () => {
  const r = runtime({ autoSend: true }); r.api.start();
  const entry = chatEntry(r, 'legacy'); entry.pendingReply = { kind: 'reply', payload: { text: '旧回复' } };
  entry.retry = { action: 'history', at: 0, taskId: r.state().task.id };
  r.state().outbox.push({ id: 'old-reply', kind: 'reply', key: entry.key, taskId: r.state().task.id, status: 'pending' });
  r.context.BossAdapter.Adapter.prototype.cards = () => [];
  r.context.BossAdapter.Adapter.prototype.advance = () => 'end';
  r.context.GM_openInTab = () => assert.fail('must not open chat pages');
  r.context.GM_xmlhttpRequest = () => assert.fail('must not generate chat replies');
  await r.api.pump(); assert.equal(r.state().task.status, 'running');
  assert.equal(r.state().entries[entry.key].pendingReply, undefined); assert.equal(r.state().entries[entry.key].retry, undefined);
  assert.equal(r.state().outbox[0].status, 'uncertain'); assert.equal(r.api.chatDecision, undefined);
});


test('status shows the actual command deadline including configured waits', () => {
  const r = runtime(); r.api.start(); const taskId = r.state().task.id;
  r.store.set('bossai.v1.command', { taskId, workerId: 'w', type: 'contact', phase: 'waitingSend', timeoutMs: 210000, createdAt: r.context.Date.now() });
  assert.match(r.api.currentActivity(), /上限210秒/);
});


test('an unsendable first eligible entry cannot starve another eligible contact', async () => {
  const r = runtime({ autoSend: true }); r.api.start(); const taskId = r.state().task.id;
  const a = chatEntry(r, 'blocked-first'), b = chatEntry(r, 'ready-second');
  for (const entry of [a, b]) { entry.status = 'eligible'; entry.taskId = taskId; entry.analysis = { greeting: '您好，我有项目经验' }; }
  r.state().outbox.push({ id: 'prior', key: a.key, kind: 'contact', status: 'sent', taskId });
  const sent = []; workerStub(r, cmd => { sent.push(cmd.args.job.jobId); return { ok: true, data: { confirmed: true } }; });
  await r.api.pump(); assert.deepEqual(sent, ['ready-second']); assert.equal(r.state().entries[b.key].status, 'contacted');
});

test('next-job delay also starts after a contact finishes, not only before the send', () => {
  const r = runtime({ nextJobSeconds: 30, refreshMinSeconds: 1, refreshMaxSeconds: 1 }); r.api.start();
  const entry = chatEntry(r, 'settled'); const item = { id: 'new-send', key: entry.key, kind: 'contact', payload: {} };
  r.state().outbox.push(item); r.api.settle(r.state(), item, { confirmed: true });
  assert.equal(r.state().task.nextScanAt, r.context.Date.now() + 31000);
});


test('worker lease loss skips the affected contact but keeps the main task running', async () => {
  const r = runtime({ autoSend: true }); r.api.start(); const entry = chatEntry(r, 'lease-lost');
  entry.status = 'eligible'; entry.taskId = r.state().task.id; entry.analysis = { greeting: '您好，我有项目经验' };
  workerStub(r, () => ({ ok: false, code: 'WORKER_LEASE_UNAVAILABLE', error: '工作页执行权未能稳定，已跳过本次动作，不重新发送' }));
  await r.api.pump(); assert.equal(r.state().task.status, 'running');
  assert.equal(r.state().entries[entry.key].handoff, true);
});


test('delayed browser callbacks count their real elapsed time rather than repeating nominal chunks', async () => {
  const r = runtime(); let ticks = 0, guards = 0;
  r.context.setTimeout = fn => { ticks++; r.advance(5000); queueMicrotask(fn); };
  await r.api.guardedDelay(2000, () => { guards++; });
  assert.equal(ticks, 1); assert.equal(guards, 2);
});
