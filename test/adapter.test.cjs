const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const C = require('../src/core.js');
const context = { BossCore: C, URL, Event: class { constructor(type) { this.type = type; } } };
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../src/adapter.js'), 'utf8'), context);
const { Adapter, DEFAULT_PROFILE: P } = context.BossAdapter;
function element(attrs = {}, text = '', selectors = {}) {
  return { selectors, innerText: text, textContent: text, childNodes: [{ nodeType: 3, textContent: text }],
    getAttribute(name) { return attrs[name] || null; }, href: attrs.href };
}
function adapter(selectors = {}, profile = {}, options = {}) {
  const doc = { selectors, location: { href: 'https://www.zhipin.com/job_detail/job1.html', pathname: '/job_detail/job1.html' } };
  class DOMAdapter extends Adapter {
    nodes(selector, scope = this.doc) { return scope.selectors?.[selector] || []; }
    health() {}
  }
  return new DOMAdapter(doc, profile, [], options);
}
const attrSelector = ['data-boss-id', 'data-bossid', 'data-boss-uid', 'data-recruiter-id', 'data-encrypt-boss-id'].map(a => '[' + a + ']').join(',');
test('recruiter IDs can be read from alternate scoped data attributes', () => {
  const scope = element({}, '', { [attrSelector]: [element({ 'data-bossid': 'boss-123' })] });
  const a = adapter({ [P.recruiterScope]: [scope] });
  assert.equal(a.recruiterInfo().recruiterId, 'boss-123');
});
test('scoped recruiter links work without requiring data-boss-id', () => {
  const scope = element({}, '', { 'a[href]': [element({ href: '/web/geek/chat?bossId=boss-123' })] });
  assert.equal(adapter({ [P.recruiterScope]: [scope] }).recruiterInfo().recruiterId, 'boss-123');
});
test('visible company plus recruiter supports identity when the numeric ID is absent', () => {
  const a = adapter({ [P.recruiterName]: [element({}, '测试招聘者')], [P.company]: [element({}, '示例公司·招聘经理')] });
  const identity = a.recruiterInfo();
  assert.equal(identity.identityType, 'visible-context'); assert.equal(identity.company, '示例公司');
  assert.ok(identity.recruiterId.startsWith('visible-context:'));
  assert.equal(adapter({ [P.recruiterName]: [element({}, '测试招聘者')] }).recruiterInfo().recruiterId, '');
});
test('conflicting platform IDs cannot be bypassed by a matching visible name', () => {
  const a = adapter({ [P.recruiter]: [element({ 'data-boss-id': 'boss-A' }), element({ 'data-boss-id': 'boss-B' })],
    [P.recruiterName]: [element({}, '测试招聘者')], [P.company]: [element({}, '示例公司')] });
  assert.equal(a.recruiterInfo().recruiterId, ''); assert.equal(a.recruiterInfo().identityDiagnostic.status, 'conflicting');
});
test('observed BOSS detail structure binds the communication button to the current job', () => {
  const a = adapter({ [P.recruiterName]: [element({}, '测试招聘者')], [P.company]: [element({}, '示例公司')],
    [P.detail]: [element({}, '这是测试岗位的完整描述内容，至少二十个字符，用于验证字段读取。')],
    [P.contact]: [element({ 'data-url': '/wapi/zpgeek/friend/add.json?jobId=job1&securityId=not-an-identity' }, '立即沟通')] });
  const job = a.inspectJob(); assert.equal(job.jobId, 'job1'); assert.equal(job.contactTargetJobId, 'job1');
  assert.equal(job.identityType, 'visible-context'); assert.equal(JSON.stringify(job.identityDiagnostic).includes('not-an-identity'), false);
});
test('visible chat identity requires the exact job link without recruiter or company matching', () => {
  const header = element({}, '', { 'a[href*="/job_detail/"]': [element({ href: 'https://www.zhipin.com/job_detail/job1.html' })],
    [P.chatRecruiterName]: [element({}, '测试招聘者')], [P.chatCompany]: [element({}, '示例公司')] });
  const a = adapter({ [P.chatHeader]: [header] });
  const expected = { jobId: 'job1', recruiterId: 'platform-123', recruiterName: '测试招聘者', company: '示例公司' };
  assert.doesNotThrow(() => a.assertIdentity(expected));
  assert.throws(() => a.assertIdentity({ ...expected, jobId: 'job2' }));
  assert.doesNotThrow(() => a.assertIdentity({ ...expected, company: '其他公司', recruiterName: '' }));
  header.selectors[P.chatRecruiterName] = []; header.selectors[P.chatCompany] = [];
  assert.doesNotThrow(() => a.assertIdentity(expected));
  header.selectors['a[href*="/job_detail/"]'] = [];
  assert.throws(() => a.assertIdentity(expected));
});
test('old default contact selector is migrated to the current button variant', () => {
  assert.ok(adapter({}, { contact: '.op-btn-chat' }).p.contact.includes('.btn-startchat'));
});

function chatHeader(jobId = 'job1', name = '测试招聘者', company = '示例公司') {
  return element({}, '', { 'a[href*="/job_detail/"]': [element({ href: 'https://www.zhipin.com/job_detail/' + jobId + '.html' })],
    [P.chatRecruiterName]: [element({}, name)], [P.chatCompany]: [element({}, company)] });
}
test('nested header candidates describing the same recipient are deduplicated', () => {
  const a = adapter({ [P.chatHeader]: [chatHeader(), chatHeader(), element()] });
  assert.equal(a.identity().jobId, 'job1');
});
test('conflicting headers and multiple job links never select an arbitrary recipient', () => {
  assert.throws(() => adapter({ [P.chatHeader]: [chatHeader(), chatHeader('job2')] }).identity(), /冲突/);
  const header = chatHeader(); header.selectors['a[href*="/job_detail/"]'].push(element({ href: 'https://www.zhipin.com/job_detail/job2.html' }));
  assert.throws(() => adapter({ [P.chatHeader]: [header] }).identity(), /多个岗位/);
});
test('empty-chat placeholder is not treated as a loaded conversation', () => {
  const a = adapter({ [P.chatHeader]: [chatHeader()], [P.chatEmpty]: [element()] });
  assert.equal(a.chatReady(), false); assert.throws(() => a.identity(), /尚未选中/);
  assert.throws(() => adapter().identity(), /未找到聊天容器/);
});
test('observed list rows require an exact unique company and recruiter match', () => {
  let clicks = 0;
  const row = element({}, '', { [P.conversationName]: [element({}, '测试招聘者')], [P.conversationCompany]: [element({}, '示例公司')] });
  row.click = () => clicks++;
  const a = adapter({ [P.conversationRow]: [row] });
  const job = { jobId: 'job1', recruiterId: 'visible-context:x', recruiterName: '测试招聘者', company: '示例公司' };
  a.selectConversation(job); assert.equal(clicks, 1);
  assert.throws(() => a.selectConversation({ ...job, company: '其他公司' }), e => e.code === 'CHAT_NOT_FOUND');
  a.doc.selectors[P.conversationRow].push(row);
  assert.throws(() => a.selectConversation(job), e => e.code === 'CHAT_AMBIGUOUS'); assert.equal(clicks, 1);
});
test('explicit conflicting row IDs cannot be overridden by matching names', () => {
  const row = element({ 'data-job-id': 'other-job' }, '', { [P.conversationName]: [element({}, '测试招聘者')], [P.conversationCompany]: [element({}, '示例公司')] });
  assert.throws(() => adapter({ [P.conversationRow]: [row] }).selectConversation({ jobId: 'job1', recruiterId: 'r', recruiterName: '测试招聘者', company: '示例公司' }), /尚未加载/);
});
test('legacy saved defaults migrate but custom selectors are preserved', () => {
  const a = adapter({}, { version: 2, chatHeader: '.chat-info, .chat-header, .conversation-header', messages: '[data-message-id]', messageIdAttr: 'data-message-id' });
  assert.equal(a.p.chatHeader, P.chatHeader); assert.equal(a.p.messages, P.messages); assert.equal(a.p.messageIdAttr, 'data-mid');
  assert.equal(adapter({}, { version: 2, chatHeader: '.my-custom-header', messageIdAttr: 'custom-id' }).p.chatHeader, '.my-custom-header');
  assert.equal(adapter({}, { version: 3, messageIdAttr: 'data-message-id' }).p.messageIdAttr, 'data-message-id');
});
test('observed message IDs and direction are read without silently losing existing messages', () => {
  const message = element({ 'data-mid': 'mid-1' }, '', { [P.messageText]: [element({}, '您好')] });
  message.matches = selector => selector === P.messageIncoming;
  const a = adapter({ [P.chatHeader]: [chatHeader()], [P.messages]: [message] });
  const history = a.history(a.identity()); assert.equal(history.length, 1); assert.equal(history[0].id, 'mid-1');
  assert.equal(history[0].role, 'recruiter'); assert.equal(history[0].text, '您好');
});

// Redacted fixture of the two UI regions in the supplied chat diagnostic.
// The position is a DIV, not an anchor; no platform job ID is fabricated.
function positionChat(overrides = {}) {
  const fields = { recruiterName: '测试招聘者', company: '示例公司', title: 'AI 应用开发·实习生', salary: '200-300元/天', city: '北京', ...overrides };
  const card = element({}, '', { [P.chatTitle]: [element({}, fields.title)], [P.chatSalary]: [element({}, fields.salary)], [P.chatCity]: [element({}, fields.city)] });
  const header = element({}, '', { [P.chatRecruiterName]: [element({}, fields.recruiterName)], [P.chatCompany]: [element({}, fields.company + '·招聘主管')], [P.chatPosition]: [card] });
  const job = { jobId: 'job1', contactTargetJobId: 'job1', recruiterId: 'expected-platform-id', ...fields };
  return { a: adapter({ [P.chatHeader]: [header] }), header, card, job };
}
test('a DIV position card matches only the job title without pretending it supplies a job ID', () => {
  const { a, job } = positionChat();
  const actual = a.identity(); assert.equal(actual.identityType, 'visible-fields'); assert.equal(actual.jobId, undefined);
  assert.equal(actual.title, 'AI 应用开发·实习生'); assert.doesNotThrow(() => a.assertIdentity(job));
  assert.throws(() => C.pair(actual));
});
test('job links in historical messages cannot masquerade as the active job', () => {
  const { a, header, card, job } = positionChat();
  header.matches = selector => selector === '.chat-conversation';
  header.selectors['a[href*="/job_detail/"]'] = [element({ href: 'https://www.zhipin.com/job_detail/history-job.html' })];
  header.selectors['.top-info-content, .chat-position-content'] = [card];
  assert.equal(a.identity().identityType, 'visible-fields'); assert.doesNotThrow(() => a.assertIdentity(job));
  card.selectors['a[href*="/job_detail/"]'] = [element({ href: 'https://www.zhipin.com/job_detail/other-current-job.html' })];
  assert.throws(() => a.assertIdentity(job), /不一致/);
});
test('each mismatching or missing target field blocks a linkless position card', () => {
  const { a, job } = positionChat();
  for (const field of ['title']) {
    assert.throws(() => a.assertIdentity({ ...job, [field]: '其他字段' }), /不一致/);
    assert.throws(() => a.assertIdentity({ ...job, [field]: '' }), /字段缺失/);
  }
  assert.throws(() => a.assertIdentity({ ...job, contactTargetJobId: '' }), /绑定本岗位/);
  assert.throws(() => a.assertIdentity({ ...job, contactTargetJobId: 'other-job' }), /绑定本岗位/);
});

test('missing or different recruiter and company fields do not block a matching position card', () => {
  const { a, header, job } = positionChat();
  header.selectors[P.chatRecruiterName] = []; header.selectors[P.chatCompany] = [];
  assert.doesNotThrow(() => a.assertIdentity(job));
  assert.doesNotThrow(() => a.assertIdentity({ ...job, recruiterName: '其他招聘者', company: '' }));
  a.knownJobs = [{ ...job, jobId: 'another-job', company: '另一公司', recruiterName: '其他招聘者' }];
  assert.doesNotThrow(() => a.assertIdentity(job));
});

test('platform job ID matching does not require a readable recruiter ID', () => {
  const a = adapter({ [P.chatIdentity]: [element({ [P.chatJobAttr]: 'job1' })] });
  const job = { jobId: 'job1', recruiterId: 'stored-recruiter' };
  assert.doesNotThrow(() => a.assertIdentity(job));
  assert.throws(() => a.assertIdentity({ ...job, jobId: 'job2' }), /不一致/);
});
test('same-title known jobs do not veto the requested title-only matching', () => {
  const { a, job } = positionChat();
  a.knownJobs = [{ ...job, jobId: 'other-job' }];
  assert.doesNotThrow(() => a.assertIdentity(job));
  a.knownJobs = [{ ...job, jobId: 'other-job', title: '另一个实习岗位' }, job];
  assert.doesNotThrow(() => a.assertIdentity(job));
});
test('incomplete position cards and multiple cards do not authorize sending', () => {
  for (const field of ['title']) {
    assert.throws(() => positionChat({ [field]: '' }).a.identity(), /岗位名称字段缺失/);
  }
  const { a, header, card } = positionChat(); header.selectors[P.chatPosition].push(card);
  assert.throws(() => a.identity(), /多个岗位卡片/);
});
test('format normalization is limited to spacing, salary dash and city suffix', () => {
  const { a, job } = positionChat({ salary: '200 – 300 元/天', city: '北京市' });
  assert.doesNotThrow(() => a.assertIdentity({ ...job, salary: '200-300元/天', city: '北京' }));
  assert.doesNotThrow(() => a.assertIdentity({ ...job, salary: '200-300元/月' }));
  assert.throws(() => a.assertIdentity({ ...job, title: 'AI应用开发实习生' }), /岗位名称/);
  assert.doesNotThrow(() => a.assertIdentity({ ...job, city: '上海' }));
});
test('v3 saved name and company defaults migrate without resetting custom profiles', () => {
  const a = adapter({}, { version: 3, chatRecruiterName: '.name, .boss-name', chatCompany: '.company-name, .company' });
  assert.equal(a.p.chatRecruiterName, P.chatRecruiterName); assert.equal(a.p.chatCompany, P.chatCompany);
  assert.equal(adapter({}, { version: 3, chatRecruiterName: '.custom-name', chatCompany: '.custom-company' }).p.chatCompany, '.custom-company');
});
test('diagnostic distinguishes a readable position card from a platform ID and never leaks field text', () => {
  const { a } = positionChat();
  const result = a.diagnostic(); assert.match(result.identity, /页面未提供岗位 ID/);
  assert.equal(result.counts.chatHeader, 1);
  assert.equal(JSON.stringify(result).includes('测试招聘者'), false);
  assert.equal(JSON.stringify(result).includes('200-300'), false);
});

function pkNotice(options = {}) {
  const title = options.title || '你与该职位竞争者PK情况', button = options.button || '查看详细分析';
  const cardText = title + '\n测试说明\n' + button, image = element();
  const card = element({}, cardText, { '.message-card-top-title': [element({}, title)], '.message-card-buttons .card-btn': [element({}, button)] });
  card.matches = selector => selector === '.message-card-wrap.blue'; card.contains = node => node === image;
  const selectors = { '.message-card-wrap': [card], '.item-time': [element({}, '13:18')], [P.richMessage]: [image] };
  if (options.extraText) selectors[P.messageText] = [element({}, options.extraText)];
  if (options.externalMedia) selectors[P.richMessage].push(element());
  const row = element({ 'data-mid': options.id || 'notice-1' }, '13:18\n' + cardText + (options.extraText || ''), selectors);
  row.matches = selector => selector === (options.outgoing ? P.messageOutgoing : P.messageIncoming);
  return row;
}
function messageHistory(rows) {
  const a = adapter({ [P.chatHeader]: [chatHeader()], [P.messages]: rows });
  return { a, history: a.history(a.identity()) };
}
test('the exact competitor-PK system card from the supplied screenshot is excluded from conversation history', () => {
  const { a, history } = messageHistory([pkNotice()]);
  assert.equal(history.length, 0);
  const summary = a.diagnostic().messageSummary;
  assert.equal(summary.visibleRows, 1); assert.equal(summary.ignoredSystemCards, 1); assert.equal(summary.conversationRows, 0);
});
test('the system card does not hide a real recruiter question or an outgoing greeting', () => {
  for (const incoming of [true, false]) {
    const row = element({ 'data-mid': 'real-1' }, '', { [P.messageText]: [element({}, '您好，我想进一步沟通')] });
    row.matches = selector => selector === (incoming ? P.messageIncoming : P.messageOutgoing);
    for (const rows of [[pkNotice(), row], [row, pkNotice()]]) {
      const { history } = messageHistory(rows);
      assert.equal(history.length, 1); assert.equal(history[0].id, 'real-1');
      assert.equal(history[0].role, incoming ? 'recruiter' : 'candidate');
    }
  }
});
test('unknown cards, outgoing cards and additional payloads are never silently ignored', () => {
  for (const options of [{ title: '面试邀请' }, { button: '查看其他信息' }, { outgoing: true }, { extraText: '招聘者补充的真实问题' }, { externalMedia: true }]) {
    assert.equal(messageHistory([pkNotice(options)]).history.length, 1);
  }
});
test('plain messages quoting the PK promotion remain real messages', () => {
  const row = element({ 'data-mid': 'real-1' }, '', { [P.messageText]: [element({}, '你与该职位竞争者PK情况 查看详细分析')] });
  row.matches = selector => selector === P.messageIncoming;
  assert.equal(messageHistory([row]).history.length, 1);
});
test('real text outside the known card is retained even if it uses an unknown text selector', () => {
  const row = pkNotice(); row.innerText += '\n你每周能实习几天？';
  assert.equal(messageHistory([row]).history.length, 1);
});

test('title-only matching accepts missing chat salary and city without affecting title rejection', () => {
  const { a, job } = positionChat({ salary: '', city: '' });
  assert.doesNotThrow(() => a.assertIdentity({ ...job, salary: '任意薪资', city: '任意城市' }));
  assert.throws(() => a.assertIdentity({ ...job, title: '另一个岗位' }), /岗位名称/);
  assert.throws(() => a.assertIdentity({ ...job, title: '' }), /字段缺失/);
});

test('explicit opt-out skips missing or mismatching job fields but still requires a loaded chat and unique editor', () => {
  const selectors = { [P.chatHeader]: [element()], [P.composer]: [element()] };
  const a = adapter(selectors, {}, { verifyChatWindow: false });
  const job = { jobId: 'target', recruiterId: 'r' };
  assert.doesNotThrow(() => a.assertIdentity(job));
  assert.throws(() => adapter(selectors).assertIdentity(job), /岗位名称字段缺失/);
  selectors[P.chatIdentity] = [element({ [P.chatJobAttr]: 'other' })];
  assert.doesNotThrow(() => a.assertIdentity(job));
  selectors[P.chatEmpty] = [element()]; assert.throws(() => a.assertIdentity(job), /未展开/);
  delete selectors[P.chatEmpty]; selectors[P.composer] = [];
  assert.throws(() => a.assertIdentity(job), /唯一元素/);
});

test('position-region fallback reads the title when the position-content wrapper is absent', () => {
  const { a, header, card, job } = positionChat();
  header.selectors[P.chatPosition] = [];
  header.selectors['.chat-position-content'] = [card];
  assert.doesNotThrow(() => a.assertIdentity(job));
  card.selectors[P.chatTitle] = [];
  assert.throws(() => a.assertIdentity(job), /岗位名称字段缺失/);
});

function editableFixture() {
  const events = [], input = { isContentEditable: true, textContent: '', innerText: '', focus() {}, dispatchEvent(e) { events.push(e.type); } };
  const a = adapter({ [P.composer]: [input] });
  return { a, input, events };
}

test('contenteditable fallback writes rendered multiline text including the AI disclosure', () => {
  const { a, input, events } = editableFixture();
  const text = '您好，我做过相关项目。\n（本消息由 AI 发送）';
  a.fill(text);
  assert.equal(input.innerText, text); assert.equal(input.textContent, '');
  assert.equal(a.editorMatches(text), true); assert.deepEqual(events, ['input', 'change']);
});

test('native editing inserts once into a collapsed selection inside the empty editor', () => {
  const { a, input } = editableFixture(); let calls = 0, selected;
  const range = { selectNodeContents(n) { selected = n; }, collapse(end) { assert.equal(end, false); } };
  a.doc.getSelection = () => ({ removeAllRanges() {}, addRange(r) { assert.equal(r, range); } });
  a.doc.createRange = () => range;
  a.doc.execCommand = (command, ui, text) => { calls++; assert.equal(command, 'insertText'); input.innerText = text; return true; };
  a.fill('经历介绍\nAI 标注'); assert.equal(selected, input); assert.equal(calls, 1);
  assert.equal(a.editorMatches('经历介绍\nAI 标注'), true);
});

test('editor normalization allows only CRLF, NBSP and edge whitespace equivalents', () => {
  const { a, input } = editableFixture();
  input.innerText = '项目\u00a0经历\r\nAI 标注\n';
  assert.equal(a.editorMatches('项目 经历\nAI 标注'), true);
  assert.equal(a.editorMatches('项目 经历AI 标注'), false);
  assert.equal(a.editorMatches('其他经历\nAI 标注'), false);
  input.value = ''; assert.equal(a.editorMatches('项目 经历\nAI 标注'), false);
});

test('existing rendered drafts and ambiguous partial insertion are preserved', () => {
  const { a, input } = editableFixture();
  input.innerText = '已有草稿'; assert.throws(() => a.fill('新文字'), /已有草稿/); assert.equal(input.innerText, '已有草稿');
  input.innerText = '';
  a.doc.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
  a.doc.createRange = () => ({ selectNodeContents() {}, collapse() {} });
  a.doc.execCommand = () => { input.innerText = '部分写入'; return false; };
  assert.throws(() => a.fill('新文字'), /写入结果不明确/); assert.equal(input.innerText, '部分写入');
});
