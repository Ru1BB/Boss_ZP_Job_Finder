const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core.js');
const now = Date.parse('2026-10-14T02:00:00Z');
test('greetings append the project URL once before the AI notice', () => {
  const greeting = C.greetingMessage('您好，我做过实际项目');
  assert.ok(greeting.includes(C.PROJECT_URL)); assert.ok(greeting.endsWith(C.AI_NOTICE));
  assert.ok(greeting.includes('这是一个基于大模型的求职助手，可分析岗位匹配度并自动发送个性化招呼。'));
  assert.equal(C.greetingMessage(greeting), greeting);
  assert.equal(C.greetingMessage(''), '');
  const legacy = C.greetingMessage('您好\n自动发送项目：' + C.PROJECT_URL + '\n' + C.AI_NOTICE);
  assert.ok(legacy.includes('这是一个基于大模型的求职助手'));
  assert.equal(legacy.split(C.PROJECT_URL).length - 1, 1);
  assert.equal(C.greetingMessage(legacy), legacy);
});
test('AI receipt keyword requires an outgoing text message', () => {
  assert.equal(C.isAIOutgoing({ role: 'candidate', text: '与草稿不同 AI' }), true);
  assert.equal(C.isAIOutgoing({ role: 'recruiter', text: 'AI' }), false);
  assert.equal(C.isAIOutgoing({ role: 'candidate', text: '普通消息' }), false);
});
const setup = () => {
  const c = { ...C.defaults(), autoSend: true }, s = C.emptyState();
  s.task = C.createTask(c, now);
  const entry = { key: C.pair({ jobId: 'j', recruiterId: 'r' }), status: 'eligible' };
  s.entries[entry.key] = entry;
  return { c, s, entry };
};
test('defaults implement Beijing internships and independent refresh/send clocks', () => {
  const c = C.defaults();
  assert.equal(c.internshipOnly, true); assert.equal(c.requiredCity, '北京');
  assert.equal(c.autoSend, false); assert.equal(c.sendIntervalSeconds, 180);
  assert.equal(C.randomDelay(c, () => 0), 10000);
  assert.equal(C.randomDelay(c, () => 0.999999), 60000);
  assert.equal(C.randomDelay(c, () => 0.5), 35000);
});

test('chat window verification defaults on for old configs and requires explicit boolean opt-out', () => {
  assert.equal(C.defaults().verifyChatWindow, true);
  assert.equal(C.fixedConfig({}).verifyChatWindow, true);
  assert.equal(C.validateConfig(C.fixedConfig({ verifyChatWindow: false })).verifyChatWindow, false);
  assert.throws(() => C.validateConfig(C.fixedConfig({ verifyChatWindow: 'false' })), /verifyChatWindow/);
});
test('configuration rejects invalid schedules, bounds and inverted jitter', () => {
  for (const overrides of [{ maxContacts: 0 }, { threshold: NaN }, { sendIntervalSeconds: 1.5 },
    { refreshMinSeconds: 61, refreshMaxSeconds: 60 }, { scheduleEnabled: true },
    { scheduleEnabled: true, startTime: '09:00', stopTime: '09:00' }]) {
    assert.throws(() => C.validateConfig({ ...C.defaults(), ...overrides }));
  }
});
test('AI timeout defaults migrate to 180 seconds and allow only bounded whole seconds', () => {
  assert.equal(C.fixedConfig({ provider: 'qwen' }).aiTimeoutSeconds, 180);
  for (const aiTimeoutSeconds of [29, 601, 60.5, '180', NaN]) assert.throws(() => C.validateConfig({ ...C.defaults(), aiTimeoutSeconds }));
  for (const aiTimeoutSeconds of [30, 180, 600]) assert.doesNotThrow(() => C.validateConfig({ ...C.defaults(), aiTimeoutSeconds }));
});
test('provider endpoints and models are fixed and reject unknown providers', () => {
  assert.equal(C.fixedConfig().baseUrl, 'https://maas.qianwenaiapi.com/compatible-mode/v1');
  assert.equal(C.fixedConfig({ provider: 'qwen', model: 'override' }).model, 'qwen3.8-flash');
  const deepseek = C.fixedConfig({ provider: 'deepseek', model: 'override' });
  assert.equal(deepseek.baseUrl, 'https://api.deepseek.com'); assert.equal(deepseek.model, 'deepseek-flash');
  assert.throws(() => C.fixedConfig({ provider: 'other' }));
  assert.throws(() => C.fixedConfig({ provider: '__proto__' }));
});
test('legacy endpoint migration clears credentials only when destination changes', () => {
  const same = C.fixedConfig({ ...C.defaults(), apiKey: 'test-key', model: 'legacy-model' });
  assert.equal(same.apiKey, 'test-key'); assert.equal(same.model, 'qwen3.8-flash');
  const changed = C.fixedConfig({ ...C.defaults(), apiKey: 'test-key', baseUrl: 'https://old.example/v1', autoSend: true });
  assert.equal(changed.apiKey, ''); assert.equal(changed.autoSend, false);
  assert.equal(changed.baseUrl, C.PROVIDERS.qwen.baseUrl);
});
test('Beijing internship hard filter never infers from body mentioning the city', () => {
  const c = C.defaults();
  assert.equal(C.hardFilter({ employmentType: '全职', city: '北京' }, c).status, 'rejected');
  assert.equal(C.hardFilter({ employmentType: '实习', city: '上海' }, c).status, 'rejected');
  assert.equal(C.hardFilter({ employmentType: '实习', city: '北京·海淀区' }, c).status, 'pass');
  assert.equal(C.hardFilter({ description: '北京实习生', employmentType: '', city: '' }, c).status, 'review');
  assert.equal(C.hardFilter({ employmentType: '实习/全职', city: '北京' }, c).status, 'pass');
});
test('internship text and daily salary are alternative positive signals', () => {
  const c = C.defaults();
  for (const salary of ['200-300元/天', '150／天', '日薪200元', '每日 200 元', '200元一天', '按天计薪']) {
    assert.equal(C.hardFilter({ employmentType: '全职', salary, city: '北京' }, c).status, 'pass', salary);
  }
  assert.equal(C.hardFilter({ description: '招聘开发实习生', salary: '4-6K/月', city: '北京' }, c).status, 'pass');
  assert.equal(C.hardFilter({ title: '实习生', city: '北京' }, c).status, 'pass');
  assert.equal(C.hardFilter({ salary: '8-12K/月', city: '北京' }, c).status, 'review');
  assert.equal(C.hardFilter({ salary: '200元/天', city: '上海' }, c).status, 'rejected');
  assert.equal(C.hardFilter({ salary: '200元/天', city: '' }, c).status, 'review');
  assert.equal(C.hardFilter({ description: '餐补20元/天', salary: '8K/月', employmentType: '全职', city: '北京' }, c).status, 'rejected');
});
test('AI disclosure is appended once to greetings and replies, including old queued text', () => {
  assert.equal(C.aiMessage('您好'), '您好\n' + C.AI_NOTICE);
  assert.equal(C.aiMessage(C.aiMessage('您好')), C.aiMessage('您好'));
  assert.equal(C.aiMessage('您好\n' + C.AI_NOTICE + '\n' + C.AI_NOTICE), C.aiMessage('您好'));
  assert.equal(C.aiMessage(''), '');
  assert.ok(C.analysis({ score: 90, suitable: true, uncertain: false, reason: '符合', doubts: [], greeting: '您好' }).greeting.endsWith(C.AI_NOTICE));
  assert.ok(C.reply({ action: 'reply', text: '我有项目经验', reason: '有依据', evidence: ['项目经验'] }).text.endsWith(C.AI_NOTICE));
});
test('known personal names are replaced at the final message boundary', () => {
  const result = C.anonymousMessage('您好赵女士，我是张小明，来自示例大学。', '姓名：张小明。\n学校：示例大学', { recruiterName: '赵女士' });
  assert.equal(result.includes('张小明'), false); assert.equal(result.includes('赵女士'), false);
  assert.ok(result.includes('示例大学')); assert.ok(result.endsWith(C.AI_NOTICE));
});
test('daily Beijing window start inclusive/end exclusive independent of host timezone', () => {
  const c = { ...C.defaults(), scheduleEnabled: true, startTime: '09:00', stopTime: '18:00' };
  assert.equal(C.schedule(c, Date.parse('2026-10-14T00:59:59Z')).active, false);
  assert.equal(C.schedule(c, Date.parse('2026-10-14T01:00:00Z')).active, true);
  assert.equal(C.schedule(c, Date.parse('2026-10-14T10:00:00Z')).active, false);
});
test('overnight window has same ID on both sides of midnight', () => {
  const c = { ...C.defaults(), scheduleEnabled: true, startTime: '22:00', stopTime: '02:00' };
  const a = C.schedule(c, Date.parse('2026-10-14T15:00:00Z'));
  const b = C.schedule(c, Date.parse('2026-10-14T17:00:00Z'));
  assert.equal(a.active, true); assert.equal(b.active, true); assert.equal(a.id, b.id);
  assert.equal(C.schedule(c, Date.parse('2026-10-14T18:00:00Z')).active, false);
});
test('resume from frozen tab cannot send after deadline or in next window', () => {
  const { c, s, entry } = setup();
  s.task.endAt = now + 1000;
  assert.equal(C.canSend(s, c, now + 1000, 'contact', entry), false);
  c.scheduleEnabled = true; c.startTime = '09:00'; c.stopTime = '18:00';
  s.task.endAt = now + 86400000 * 5; s.task.windowId = C.schedule(c, now).id;
  assert.equal(C.allowed(s, c, now + 86400000), false);
});
test('manual new task resets quota, persistent spacing and dedupe survive', () => {
  const { c, s, entry } = setup();
  C.reserve(s, c, now, 'contact', entry, { text: '你好' });
  assert.equal(s.task.contacts, 1); assert.equal(entry.status, 'uncertain');
  s.task = C.createTask(c, now + 1000);
  assert.equal(s.task.contacts, 0); assert.equal(s.lastSendAt, now);
  assert.equal(s.entries[entry.key].status, 'uncertain');
  assert.equal(C.canSend(s, c, now + 1000, 'contact', entry), false);
});
test('all outbound types share spacing; quota does not stop established chat', () => {
  const { c, s, entry } = setup(); c.maxContacts = 1;
  C.reserve(s, c, now, 'contact', entry, {}); entry.status = 'contacted';
  assert.equal(C.canSend(s, c, now + 180000, 'contact', entry), false);
  assert.equal(C.canSend(s, c, now + 179999, 'reply', entry), false);
  assert.equal(C.canSend(s, c, now + 180000, 'reply', entry), true);
  C.reserve(s, c, now + 180000, 'reply', entry, {});
  assert.equal(C.canSend(s, c, now + 180001, 'resume', entry), false);
});
test('unowned, handoff and exhausted-reply conversations cannot auto reply', () => {
  const { c, s, entry } = setup();
  assert.equal(C.canSend(s, c, now, 'reply', null), false);
  assert.equal(C.canSend(s, c, now, 'reply', entry), false);
  entry.status = 'contacted'; entry.handoff = true;
  assert.equal(C.canSend(s, c, now, 'reply', entry), false);
  entry.handoff = false; s.task.replies[entry.key] = 5;
  assert.equal(C.canSend(s, c, now, 'reply', entry), false);
});
test('stopping cancels permission for every pending outbound type', () => {
  const { c, s, entry } = setup(); entry.status = 'contacted'; s.task.status = 'stopped';
  for (const kind of ['contact', 'reply', 'resume']) assert.equal(C.canSend(s, c, now, kind, entry), false);
});
test('job dedupe key requires recruiter and job and avoids delimiter collisions', () => {
  assert.throws(() => C.pair({ jobId: 'j' }));
  assert.notEqual(C.pair({ recruiterId: 'a:b', jobId: 'c' }), C.pair({ recruiterId: 'a', jobId: 'b:c' }));
  assert.notEqual(C.pair({ recruiterId: 'a', jobId: '1' }), C.pair({ recruiterId: 'a', jobId: '2' }));
});
test('AI malformed values and blank greetings fail closed', () => {
  const good = { score: 88, suitable: true, uncertain: false, reason: '符合', doubts: [], greeting: '您好' };
  assert.equal(C.analysis(JSON.stringify(good)).score, 88);
  for (const bad of ['nonsense', '{}', JSON.stringify({ ...good, score: '90' }), JSON.stringify({ ...good, greeting: '' }), JSON.stringify({ ...good, score: 101 })]) assert.throws(() => C.analysis(bad));
  assert.equal(C.decide({ ...good, uncertain: true }, C.defaults()), 'eligible');
  assert.equal(C.decide({ ...good, score: 79 }, C.defaults()), 'rejected');
});
test('score alone decides AI eligibility regardless of suitable or uncertain flags', () => {
  for (const suitable of [true, false]) for (const uncertain of [true, false]) {
    assert.equal(C.decide({ score: 62, suitable, uncertain }, { threshold: 60 }), 'eligible');
    assert.equal(C.decide({ score: 80, suitable, uncertain }, { threshold: 80 }), 'eligible');
    assert.equal(C.decide({ score: 79, suitable, uncertain }, { threshold: 80 }), 'rejected');
  }
});

function scoredJob(parts = {}, extra = {}) {
  return { suitable: true, uncertain: false, reason: '核心要求匹配，加分经历尚未证实。', doubts: [], greeting: '您好，我对该岗位感兴趣',
    greetingEvidence: ['开发过前端项目'], hasBonusRequirements: true, scoreBreakdown: { skills: 27, experience: 17, requirements: 18, preferences: 18, bonus: 0, ...parts }, ...extra };
}

test('evidence recovery discards unsupported claims and quotes a real transferable fact', () => {
  const resume = '姓名：测试\n熟悉 Python，开发过运动数据处理项目。';
  const recovered = C.scoredAnalysis(scoredJob({}, { greeting: '我有十年生产训练经验', greetingEvidence: ['虚构经历'] }), resume, { recoverEvidence: true });
  assert.equal(recovered.evidenceRecovered, true);
  assert.ok(recovered.greeting.includes('熟悉 Python，开发过运动数据处理项目。'));
  assert.equal(recovered.greeting.includes('十年'), false);
  assert.equal(recovered.score, 80);
  const neutral = C.scoredAnalysis(scoredJob({}, { greetingEvidence: [] }), '姓名：测试', { recoverEvidence: true });
  assert.equal(neutral.greetingEvidence.length, 0); assert.ok(neutral.greeting.includes('进一步了解工作内容'));
  assert.throws(() => C.scoredAnalysis(scoredJob({ skills: 999 }, { greetingEvidence: [] }), resume, { recoverEvidence: true }), /评分超出/);
});
test('weighted job score is calculated by code and optional conditions contribute at most ten points', () => {
  assert.equal(C.SCORING.reduce((sum, part) => sum + part.max, 0), 100);
  assert.deepEqual(C.SCORING.map(part => part.max), [30, 20, 20, 20, 10]);
  const withoutBonus = C.scoredAnalysis(JSON.stringify(scoredJob({}, { score: 999 })));
  const fullBonus = C.scoredAnalysis(scoredJob({ bonus: 10 }));
  assert.equal(withoutBonus.score, 80); assert.equal(fullBonus.score, 90); assert.equal(withoutBonus.scoringVersion, 2);
  assert.equal(C.decide(withoutBonus, C.defaults()), 'eligible');
  assert.ok(withoutBonus.greeting.endsWith(C.AI_NOTICE));
});
test('a job without optional requirements receives the neutral bonus value rather than a penalty', () => {
  const result = C.scoredAnalysis(scoredJob({}, { hasBonusRequirements: false }));
  assert.equal(result.scoreBreakdown.bonus, 10); assert.equal(result.score, 90);
});
test('malformed breakdowns, missing classifications and out-of-range parts are rejected', () => {
  for (const parts of [{ bonus: 11 }, { skills: -1 }, { skills: 31 }, { experience: 21 }, { preferences: 21 }, { experience: '22' }, { preferences: Infinity }, { requirements: NaN }]) {
    assert.throws(() => C.scoredAnalysis(scoredJob(parts)));
  }
  for (const extra of [{ scoreBreakdown: null }, { scoreBreakdown: [] }, { hasBonusRequirements: 'false' }, { hasBonusRequirements: undefined }, { scoreBreakdown: { skills: 40 } }, { scoreBreakdown: { ...scoredJob().scoreBreakdown, extra: 1 } }]) {
    assert.throws(() => C.scoredAnalysis(scoredJob({}, extra)));
  }
});
test('preference scoring can change a total by twenty points and stores the applied rubric', () => {
  const low = C.scoredAnalysis(scoredJob({ preferences: 0 }));
  const high = C.scoredAnalysis(scoredJob({ preferences: 20 }, { scoringVersion: 1, scoreMaxima: { preferences: 5 } }));
  assert.equal(high.score - low.score, 20); assert.equal(high.scoringVersion, 2); assert.equal(high.scoreMaxima.preferences, 20);
  assert.equal(high.scoreMaxima.skills, 30); assert.equal(high.scoreMaxima.experience, 20);
});
test('visible scored jobs are skipped by job ID but hidden, unscored or approved retries are not', () => {
  const entry = { job: { jobId: 'job1' }, analysis: { score: 0 } };
  assert.equal(C.hasVisibleScore({ x: entry }, 'job1'), true);
  assert.equal(C.hasVisibleScore({ x: entry }, 'job2'), false);
  assert.equal(C.hasVisibleScore({ x: { ...entry, hidden: true } }, 'job1'), false);
  assert.equal(C.hasVisibleScore({ x: { ...entry, analysis: null } }, 'job1'), false);
  assert.equal(C.hasVisibleScore({ x: { ...entry, analysis: { score: '80' } } }, 'job1'), false);
  assert.equal(C.hasVisibleScore({ x: entry, y: { ...entry, retryApproved: true } }, 'job1'), false);
});
test('weighted totals retain one decimal place and enforce the displayed threshold', () => {
  const result = C.scoredAnalysis(scoredJob({ skills: 26.85 }));
  assert.equal(result.score, 79.9); assert.equal(C.decide(result, C.defaults()), 'rejected');
  assert.equal(C.scoredAnalysis(scoredJob({ skills: 30, experience: 20, requirements: 20, preferences: 20, bonus: 10 })).score, 100);
});
test('greeting experience requires actual resume excerpts and rejects invented evidence', () => {
  const resume = '熟悉 JavaScript，开发过前端项目。';
  assert.equal(C.scoredAnalysis(scoredJob(), resume).greetingEvidence[0], '开发过前端项目');
  for (const greetingEvidence of [[], ['带领十人团队提升性能50%'], ['项目'], undefined]) {
    assert.throws(() => C.scoredAnalysis(scoredJob({}, { greetingEvidence }), resume), /简历原文依据/);
  }
});
test('AI disclosure only proves an outgoing AI message, not a recruiter quotation', () => {
  assert.equal(C.firstContactStatus([]), 'empty');
  assert.equal(C.firstContactStatus([{ role: 'candidate', text: '您好' + C.AI_NOTICE }]), 'ai-sent');
  assert.equal(C.firstContactStatus([{ role: 'candidate', text: '平台默认招呼' }]), 'manual-sent');
  assert.equal(C.firstContactStatus([{ role: 'recruiter', text: C.AI_NOTICE }]), 'incoming-or-unknown');
});
test('local sent and uncertain records prevent contact even if the entry is accidentally eligible', () => {
  for (const status of ['sent', 'pending', 'uncertain', 'duplicate']) {
    const { s, c, entry } = setup(); s.outbox.push({ key: entry.key, kind: 'contact', status });
    assert.equal(C.canSend(s, c, now, 'contact', entry), false);
  }
  const { s, c, entry } = setup(); s.outbox.push({ key: entry.key, kind: 'contact', status: 'reviewed-not-sent' });
  assert.equal(C.canSend(s, c, now, 'contact', entry), true);
});
test('clear activity removes pending items while retaining dedupe and spacing records', () => {
  const { s, c, entry } = setup();
  s.logs = [{ message: '旧日志' }]; s.task.contacts = 7; s.task.visited = ['old-job']; s.lastSendAt = now;
  s.entries[entry.key].status = 'contacted'; s.entries[entry.key].pendingReply = { text: '排队回复' };
  s.entries.review = { key: 'review', status: 'review' }; s.entries.eligible = { key: 'eligible', status: 'eligible' };
  s.entries.uncertain = { key: 'uncertain', status: 'uncertain', handoff: true };
  s.entries.existing = { key: 'existing', status: 'existing' };
  s.outbox.push({ id: 'old', key: entry.key, status: 'sent' });
  C.clearActivity(s);
  assert.deepEqual(s.logs, []); assert.equal(s.entries.review, undefined); assert.equal(s.entries.eligible, undefined);
  assert.equal(s.entries[entry.key].status, 'contacted'); assert.equal(s.entries[entry.key].hidden, true);
  assert.equal(s.entries[entry.key].pendingReply, undefined); assert.equal(s.entries.uncertain.handoff, true);
  assert.equal(s.entries.existing.hidden, true); assert.equal(s.outbox.length, 1);
  assert.equal(s.lastSendAt, now); assert.equal(s.task.contacts, 7); assert.deepEqual(s.task.visited, ['old-job']);
  assert.equal(C.canSend(s, c, now + 1000, 'reply', s.entries[entry.key]), false);
});
test('reply schema requires evidence and rejects invented action names', () => {
  assert.throws(() => C.reply('{"action":"reply","text":"你好","reason":"","evidence":[]}'));
  assert.throws(() => C.reply('{"action":"send_file","text":"","reason":"","evidence":[]}'));
  assert.equal(C.reply('{"action":"handoff","text":"","reason":"需要确认","evidence":[]}').action, 'handoff');
});
test('important incoming matters always transfer to human', () => {
  for (const text of ['明天面试可以吗', '期望薪资多少', '加一下微信', '什么时候到岗', '发验证码']) assert.equal(C.sensitive(text), true);
  assert.equal(C.sensitive('用过哪些前端框架'), false);
});
test('resume requests require affirmative intent and reject negation', () => {
  for (const text of ['请发一份简历', '方便发一下你的简历吗', '简历发我一下', '发一下简历']) assert.equal(C.wantsResume(text), true, text);
  for (const text of ['不用发简历', '不需要你的简历', '已经收到简历', '简历很不错', '暂不需要发简历']) assert.equal(C.wantsResume(text), false, text);
});
test('API address is normalized and must be HTTPS without embedded credentials', () => {
  assert.equal(C.endpoint('https://api.deepseek.com'), 'https://api.deepseek.com/chat/completions');
  assert.equal(C.endpoint('https://dashscope.aliyuncs.com/compatible-mode/v1/'), 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(C.endpoint('https://example.com/v1/chat/completions'), 'https://example.com/v1/chat/completions');
  for (const url of ['http://example.com', 'https://key@example.com', 'https://example.com?key=secret', 'https://example.com#x']) assert.throws(() => C.endpoint(url));
});
test('export omits API key', () => {
  const c = { ...C.defaults(), apiKey: 'secret-test-value' };
  assert.equal(JSON.stringify(C.publicConfig(c)).includes('secret-test-value'), false);
});
test('custom endpoint has one completion suffix and network errors give exact-host guidance', () => {
  const target = C.endpoint('https://maas.qianwenaiapi.com/compatible-mode/v1');
  assert.equal(target, 'https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions');
  const error = C.networkFailure(target, { error: 'not permitted: secret-fake-key' });
  assert.match(error, /油猴拒绝了跨域访问/); assert.match(error, /@connect maas\.qianwenaiapi\.com/);
  assert.equal(error.includes('secret-fake-key'), false);
});
test('network diagnostics do not confuse missing HTTP response with invalid credentials', () => {
  assert.match(C.networkFailure('https://example.com', {}), /尚不能判断 Key 或模型/);
  assert.match(C.networkFailure('https://example.com', { error: 'ERR_NAME_NOT_RESOLVED' }), /域名解析失败/);
  assert.match(C.httpFailure(401), /认证失败/); assert.match(C.httpFailure(404), /接口路径或模型不存在/);
});
test('multi-tab lease elects one deterministic winner and expires stale tabs', () => {
  const a = { owner: 'a', claimedAt: 1, expires: 100 }, b = { owner: 'b', claimedAt: 1, expires: 100 };
  assert.equal(C.leaseWinner([b, a], 5), 'a');
  assert.equal(C.leaseWinner([a, { ...b, expires: 200 }], 100), 'b');
  assert.equal(C.leaseWinner([a, b], 101), null);
});
