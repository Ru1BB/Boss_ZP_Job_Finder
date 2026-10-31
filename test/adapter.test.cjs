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
    contains(other) { return this === other || Object.values(selectors).flat().includes(other); },
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

test('debug snapshots locate editors and send controls without including text, URLs or identity values', () => {
  const editor = element({ 'data-boss-id': 'PRIVATE-BOSS-ID' }, 'PRIVATE-DRAFT');
  editor.tagName = 'DIV'; editor.className = 'chat-input private-input'; editor.id = 'PRIVATE-EDITOR-ID'; editor.isContentEditable = true;
  editor.attributes = [{ name: 'class', value: editor.className }, { name: 'data-boss-id', value: 'PRIVATE-BOSS-ID' }];
  editor.getBoundingClientRect = () => ({ x: 10, y: 20, width: 300, height: 100 });
  const send = element({}, '发送'); send.tagName = 'BUTTON'; send.className = 'btn-send'; send.disabled = true;
  const a = adapter({ [P.composer]: [editor], [P.send]: [send],
    '[contenteditable="true"], textarea, [role="textbox"]': [editor], 'button, [role="button"], a, span': [send] });
  a.doc.location.href += '?securityId=PRIVATE-URL-TOKEN';
  const result = a.debugSnapshot(), text = JSON.stringify(result);
  assert.ok(result.candidates.editors[0].selectorHint.includes('div.chat-input'));
  assert.equal(result.candidates.configuredSend[0].disabled, true);
  assert.equal(result.candidates.editors[0].box.width, 300);
  for (const secret of ['PRIVATE-DRAFT', 'PRIVATE-BOSS-ID', 'PRIVATE-EDITOR-ID', 'PRIVATE-URL-TOKEN']) assert.equal(text.includes(secret), false);
});
test('debug snapshots remain available when normal diagnostics or selectors fail', () => {
  const a = adapter(); a.diagnostic = () => { throw new Error('PRIVATE-ERROR-DETAIL'); };
  const previous = a.nodes.bind(a); a.nodes = selector => { if (selector === P.chatHeader) throw new Error('bad selector'); return previous(selector); };
  const result = a.debugSnapshot(); assert.equal(result.basic.unavailable, true);
  assert.ok(result.errors.includes('chatContainers')); assert.ok(result.errors.includes('basicDiagnostic'));
  assert.equal(JSON.stringify(result).includes('PRIVATE-ERROR-DETAIL'), false);
});

function debugMessage(id, text, role = 'recruiter', selectors = {}) {
  const row = element(id ? { 'data-mid': id } : {}, text, { [P.messageText]: text ? [element({}, text)] : [], ...selectors });
  row.tagName = 'LI'; row.className = 'message-item ' + (role === 'candidate' ? 'item-myself' : 'item-friend');
  row.matches = selector => selector === (role === 'candidate' ? P.messageOutgoing : P.messageIncoming);
  return row;
}
function messageWithAvatar(role = 'recruiter') {
  const row = debugMessage('fixture-message', '请介绍一下项目经验', role);
  const content = element(), figure = element(), image = element();
  content.tagName = 'DIV'; content.className = 'message-content'; content.matches = selector => selector === '.message-content';
  figure.tagName = 'DIV'; figure.className = 'figure'; figure.matches = selector => selector === '.figure';
  image.tagName = 'IMG'; image.className = 'image-circle'; image.matches = selector => selector === 'img.image-circle';
  image.parentElement = figure; figure.parentElement = content; content.parentElement = row; content.firstElementChild = figure;
  row.selectors[P.richMessage] = [image];
  const a = adapter({ [P.messages]: [row] }); a.assertChatReady = () => {};
  return { a, row, content, figure, image };
}
test('the observed BOSS avatar does not turn a text message into rich content', () => {
  for (const role of ['recruiter', 'candidate']) {
    const { a } = messageWithAvatar(role), history = a.history({});
    assert.equal(history[0].rich, false); assert.equal(history[0].text, '请介绍一下项目经验');
    assert.equal(history[0].role, role);
    const report = a.debugSnapshot().messages.rowDetails[0];
    assert.equal(report.matchedRichCount, 1); assert.equal(report.ignoredAvatarCount, 1);
    assert.equal(report.richCount, 0); assert.equal(report.contentKind, 'text');
    assert.equal(report.ignoredAvatarStructure[0].classes[0], 'image-circle');
  }
});
test('real pictures, audio and attachment cards remain rich beside a recognized avatar', () => {
  for (const tag of ['IMG', 'AUDIO', 'DIV']) {
    const { a, row } = messageWithAvatar();
    const payload = element(); payload.tagName = tag; payload.className = tag === 'DIV' ? 'file-card' : 'message-payload'; payload.matches = () => false;
    row.selectors[P.richMessage].push(payload);
    assert.equal(a.history({})[0].rich, true);
    const report = a.debugSnapshot().messages.rowDetails[0];
    assert.equal(report.ignoredAvatarCount, 1); assert.equal(report.richCount, 1);
  }
});
test('rounded images outside the exact avatar slot are not ignored', () => {
  for (const change of [fixture => { fixture.content.parentElement = element(); },
    fixture => { fixture.content.firstElementChild = element(); },
    fixture => { fixture.figure.matches = () => false; }]) {
    const fixture = messageWithAvatar(); change(fixture);
    assert.equal(fixture.a.history({})[0].rich, true);
    assert.equal(fixture.a.debugSnapshot().messages.rowDetails[0].ignoredAvatarCount, 0);
  }
});
test('deep diagnostics report message parsing shapes without exporting message IDs or text by default', () => {
  const row = debugMessage('PRIVATE-ID', 'PRIVATE-MESSAGE-CONTENT');
  const result = adapter({ [P.messages]: [row] }).debugSnapshot();
  const info = result.messages.rowDetails[0];
  assert.equal(info.hasMessageId, true); assert.equal(info.direction, 'recruiter');
  assert.equal(info.textMatchCount, 1); assert.equal(info.textLength, 'PRIVATE-MESSAGE-CONTENT'.length);
  assert.equal(info.historyRowShapeValid, true); assert.equal(info.contentKind, 'text');
  assert.equal(result.messages.contentIncluded, false);
  assert.equal(JSON.stringify(result).includes('PRIVATE-ID'), false); assert.equal(JSON.stringify(result).includes('PRIVATE-MESSAGE-CONTENT'), false);
});
test('deep diagnostics identify unmatched card text and show child class names instead of its text', () => {
  const child = element({}, 'PRIVATE-CARD-TEXT'); child.tagName = 'DIV'; child.className = 'unknown-card-content';
  const row = debugMessage('id', '', 'recruiter', { '[class], p, span': [child] }); row.innerText = 'PRIVATE-CARD-TEXT';
  const result = adapter({ [P.messages]: [row] }).debugSnapshot(), info = result.messages.rowDetails[0];
  assert.equal(info.contentKind, 'card-or-unmatched-text'); assert.equal(info.textLength, 0);
  assert.ok(info.issues.includes('row-has-content-but-no-parsed-text'));
  assert.equal(info.childStructure[0].classes[0], 'unknown-card-content'); assert.equal(info.childStructure[0].textLength, 17);
  assert.ok(result.diagnosis.some(message => message.includes('正文选择器')));
  assert.equal(JSON.stringify(result).includes('PRIVATE-CARD-TEXT'), false);
});
test('deep diagnostics distinguish missing IDs, duplicate IDs and unknown direction', () => {
  const missing = debugMessage('', '测试消息'), duplicate = debugMessage('duplicate', '重复消息');
  missing.matches = () => false;
  const result = adapter({ [P.messages]: [missing, duplicate, debugMessage('duplicate', '其他消息', 'candidate')] }).debugSnapshot();
  assert.ok(result.messages.rowDetails[0].issues.includes('missing-message-id'));
  assert.equal(result.messages.rowDetails[0].direction, 'unknown');
  assert.equal(result.messages.rowDetails[1].duplicateId, true); assert.equal(result.messages.rowDetails[2].historyRowShapeValid, false);
  assert.equal(JSON.stringify(result).includes('"duplicate"'), false);
});
test('message content export is explicit, bounded and separate from identity attributes', () => {
  const rows = Array.from({ length: 22 }, (_, i) => debugMessage('PRIVATE-ID-' + i, '正文内容'.repeat(200)));
  const a = adapter({ [P.messages]: rows });
  assert.equal(a.debugSnapshot({ includeMessageText: 'true' }).messages.contentIncluded, false);
  const result = a.debugSnapshot({ includeMessageText: true });
  assert.equal(result.messages.inspectedRows, 20); assert.equal(result.messages.olderRowsOmitted, 2);
  assert.equal(result.messages.rowDetails[0].row, 3);
  assert.equal(result.messages.rowDetails[0].parsedTextPreview.length, 500);
  assert.equal(result.messages.rowDetails[0].previewTruncated, true);
  assert.equal(JSON.stringify(result).includes('PRIVATE-ID-'), false);
});
test('debug button status includes the disabled CSS class and distinguishes offscreen nodes', () => {
  const send = element(); send.tagName = 'BUTTON'; send.className = 'btn-send disabled';
  send.getBoundingClientRect = () => ({ x: 20, y: -100, width: 60, height: 30 });
  const result = adapter({ [P.send]: [send] }).debugSnapshot();
  assert.equal(result.candidates.configuredSend[0].disabled, true);
  assert.equal(result.candidates.configuredSend[0].inViewport, false);
});
test('rich message diagnostics reveal element structure without exporting image URLs', () => {
  const image = element({ src: 'https://private.example/image-token' }); image.tagName = 'IMG'; image.className = 'avatar';
  const row = debugMessage('id', '消息正文', 'recruiter', { [P.richMessage]: [image] });
  const result = adapter({ [P.messages]: [row] }).debugSnapshot();
  assert.equal(result.messages.rowDetails[0].contentKind, 'rich-content');
  assert.equal(result.messages.rowDetails[0].richStructure[0].tag, 'IMG');
  assert.equal(result.messages.rowDetails[0].richStructure[0].classes[0], 'avatar');
  assert.equal(JSON.stringify(result).includes('image-token'), false);
});

test('health ignores challenge keywords in actual jobs and our own status log', () => {
  const a = adapter({ [P.detail]: [element({}, '负责安全验证和验证码系统')] });
  a.doc.body = { innerText: '安全验证 访问过于频繁' };
  assert.equal(a.healthIssue(), null);
  const b = adapter(); b.doc.body = { innerText: '检测到安全验证' };
  b.doc.getElementById = () => ({ innerText: '检测到安全验证' });
  assert.equal(b.healthIssue(), null);
});

test('health distinguishes independent block pages and temporary failures', () => {
  for (const [text, kind] of [['请完成验证', 'verification'], ['请先登录', 'login'], ['访问过于频繁', 'restriction'], ['页面加载失败', 'transient']]) {
    const a = adapter(); a.doc.body = { innerText: text };
    assert.equal(a.healthIssue().kind, kind);
    assert.throws(() => Adapter.prototype.health.call(a), e => e.code === 'PAGE_HEALTH' && e.healthIssue.kind === kind);
  }
});

test('health ignores hidden stale challenge controls but blocks visible controls over jobs', () => {
  const node = element(); node.matches = () => false;
  const a = adapter({ [P.blocked]: [node], [P.detail]: [element()] });
  a.doc.defaultView = { getComputedStyle: () => ({ visibility: 'hidden' }) };
  assert.equal(a.healthIssue(), null);
  a.doc.defaultView.getComputedStyle = () => ({ visibility: 'visible' });
  assert.equal(a.healthIssue().kind, 'verification');
});

function categoryFixture() {
  const clicked = [];
  const items = ['推荐', '测试(北京)', 'Python(北京)', '更多', '公司(北京)'].map((label, i) => {
    const node = element(i === 0 ? { 'aria-selected': 'true' } : {}, label);
    node.getBoundingClientRect = () => ({ top: i === 4 ? 500 : 100, height: 24 });
    node.click = () => clicked.push(label); return node;
  });
  const a = adapter({ [P.categoryLink]: items }); a.cards = () => [{ jobId: 'first' }];
  return { a, items, clicked };
}

test('category rotation stays in the recommendation row and wraps without clicking more or companies', () => {
  const { a, items, clicked } = categoryFixture(), c = { requiredCity: '北京' };
  assert.equal(a.planCategory(c).label, '测试(北京)');
  a.clickCategory('测试(北京)', c); assert.deepEqual(clicked, ['测试(北京)']);
  items[0].getAttribute = () => null;
  assert.equal(a.planCategory(c, 'Python(北京)').label, '推荐');
  assert.equal(a.categoryChoices(c).length, 3);
});

test('categories follow page order, ignore old manual names and merge duplicate copies', () => {
  const { a, items } = categoryFixture(); items[0].getAttribute = () => null;
  assert.equal(a.planCategory({ categoryLabels: 'Python(北京)\n测试(北京)' }, 'Python(北京)').label, '推荐');
  a.doc.selectors[P.categoryLink].push(items[1]);
  assert.equal(a.categoryChoices({ requiredCity: '北京' }).length, 3);
  assert.equal(a.categoryChoices({ requiredCity: '北京' }).find(item => item.label === '测试(北京)').copies, 2);
});

test('category transition requires an active target or changed nonempty job IDs', () => {
  const { a } = categoryFixture(), c = { requiredCity: '北京' }, pending = { label: 'Python(北京)', before: 'first' };
  assert.equal(a.categoryChanged(pending, c), false);
  a.cards = () => []; assert.equal(a.categoryChanged(pending, c), false);
  a.cards = () => [{ jobId: 'next' }]; assert.equal(a.categoryChanged(pending, c), true);
  assert.equal(a.planCategory({ categoryLabels: '推荐' }).label, '测试(北京)');
});

test('scoped categories include hidden overflow entries and use full DOM text instead of clipped text', () => {
  const clicked = [], rec = element({ 'aria-selected': 'true' }, '推荐');
  const clipped = element({}, '前端/移动开…'); clipped.textContent = '前端/移动开发(北京)';
  const hidden = element({}, '后端开发（北京）'); hidden.getClientRects = () => [];
  clipped.click = () => clicked.push('front'); hidden.click = () => clicked.push('backend');
  const root = { querySelectorAll: () => [rec, clipped, hidden] };
  const a = adapter({ [P.categoryRoot]: [root] }); a.cards = () => [];
  const c = { requiredCity: '北京' };
  assert.deepEqual(Array.from(a.categoryChoices(c), item => item.label), ['推荐', '前端/移动开发(北京)', '后端开发(北京)']);
  a.clickCategory('前端/移动开发(北京)', c); a.clickCategory('后端开发(北京)', c);
  assert.deepEqual(clicked, ['front', 'backend']);
  assert.equal(a.planCategory({ categoryLabels: '后端开发(北京)\n前端/移动开发(北京)' }, '后端开发(北京)').label, '前端/移动开发(北京)');
});

test('full title resolves a literal ellipsis and nested category text is not treated as two options', () => {
  const rec = element({ 'aria-selected': 'true' }, '推荐');
  const leaf = element({ title: '电子/硬件开发（北京）' }, '电子/硬件开发（北…');
  const anchor = element({}, '电子/硬件开发（北京）', { span: [leaf] }); leaf.parentElement = anchor;
  const root = { querySelectorAll: () => [rec, anchor, leaf] };
  const a = adapter({ [P.categoryRoot]: [root] }); a.cards = () => [];
  assert.equal(a.categoryChoices({ requiredCity: '北京' }).length, 2);
  assert.equal(a.planCategory({ requiredCity: '北京' }).label, '电子/硬件开发(北京)');
});

test('top and overflow copies merge after switching, retaining active state and preferring the visible copy', () => {
  const rec = element({}, '推荐'), top = element({}, '后端开发(北京)'), folded = element({ 'aria-selected': 'true' }, '后端开发（北京）');
  top.getClientRects = () => [{}]; folded.getClientRects = () => []; let clicked = '';
  top.click = () => clicked = 'top'; folded.click = () => clicked = 'folded';
  const a = adapter({ [P.categoryRoot]: [{ querySelectorAll: () => [rec, top, folded] }] }); a.cards = () => [{ jobId: 'same' }];
  const choices = a.categoryChoices({}); assert.equal(choices.length, 2);
  assert.equal(choices[1].active, true); assert.equal(choices[1].copies, 2);
  assert.equal(a.categoryChanged({ label: '后端开发(北京)', before: 'same' }, {}), true);
  a.clickCategory('后端开发(北京)', {}); assert.equal(clicked, 'top');
});
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
test('legacy saved defaults migrate but custom selectors are preserved', () => {
  const a = adapter({}, { version: 2, chatHeader: '.chat-info, .chat-header, .conversation-header', messages: '[data-message-id]', messageIdAttr: 'data-message-id' });
  assert.equal(a.p.chatHeader, P.chatHeader); assert.equal(a.p.messages, P.messages); assert.equal(a.p.messageIdAttr, 'data-mid');
  assert.equal(adapter({}, { version: 2, chatHeader: '.my-custom-header', messageIdAttr: 'custom-id' }).p.chatHeader, '.my-custom-header');
  assert.equal(adapter({}, { version: 3, messageIdAttr: 'data-message-id' }).p.messageIdAttr, 'data-message-id');
});
test('observed message IDs and direction are read without silently losing existing messages', () => {
  const message = element({ 'data-mid': 'mid-1' }, '', { [P.messageText]: [element({}, '您好')] });
  message.matches = selector => selector === P.messageIncoming;
  const a = adapter({ [P.chatHeader]: [chatHeader()], [P.composer]: [element()], [P.messages]: [message] });
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
test('incomplete position cards and multiple cards do not authorize sending', () => {
  for (const field of ['title']) {
    assert.throws(() => positionChat({ [field]: '' }).a.identity(), /岗位名称字段缺失/);
  }
  const { a, header, card } = positionChat(); header.selectors[P.chatPosition].push(card);
  assert.throws(() => a.identity(), /多个岗位卡片/);
});
test('v3 saved name and company defaults migrate without resetting custom profiles', () => {
  const a = adapter({}, { version: 3, chatRecruiterName: '.name, .boss-name', chatCompany: '.company-name, .company' });
  assert.equal(a.p.chatRecruiterName, P.chatRecruiterName); assert.equal(a.p.chatCompany, P.chatCompany);
  assert.equal(adapter({}, { version: 3, chatRecruiterName: '.custom-name', chatCompany: '.custom-company' }).p.chatCompany, '.custom-company');
});
test('diagnostic distinguishes a readable position card from a platform ID and never leaks field text', () => {
  const { a } = positionChat();
  const result = a.diagnostic(); assert.match(result.identity, /仅诊断，不用于发送目标比对/);
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
  const a = adapter({ [P.chatHeader]: [chatHeader()], [P.composer]: [element()], [P.messages]: rows });
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


test('observed attachment system receipt is ignored without inventing a sender', () => {
  const text = '您的附件简历 测试.pdf 已发送给Boss点击查看附件';
  const row = debugMessage('receipt-1', text);
  row.matches = selector => selector === '.message-item.item-system';
  row.selectors['.hyper-link.text'] = [element({}, text)];
  const a = adapter({ [P.messages]: [row] }); a.assertChatReady = () => {};
  assert.equal(a.history({}).length, 0);
  const report = a.debugSnapshot().messages.rowDetails[0];
  assert.equal(report.ignoredSystemCard, true); assert.equal(report.historyRowShapeValid, true);
  assert.equal(report.issues.length, 0);
  row.innerText = row.textContent = '未知系统消息';
  assert.throws(() => a.history({}), /无法判别消息方向/);
});

test('recruiter quoting an attachment receipt remains an incoming message', () => {
  const text = '您的附件简历 测试.pdf 已发送给Boss点击查看附件';
  const row = debugMessage('quoted-receipt', text);
  row.selectors['.hyper-link.text'] = [element({}, text)];
  const a = adapter({ [P.messages]: [row] }); a.assertChatReady = () => {};
  assert.equal(a.history({})[0].role, 'recruiter');
});


test('known BOSS text-content excludes sibling read status but preserves literal status words in the body', () => {
  const row = debugMessage('read-status', '已读\n\n你好，已读这段说明');
  row.selectors[P.messageText][0].selectors['.text-content'] = [element({}, '你好，已读这段说明')];
  const a = adapter({ [P.messages]: [row] }); a.assertChatReady = () => {};
  assert.equal(a.history({})[0].text, '你好，已读这段说明');
  assert.equal(a.debugSnapshot({ includeMessageText: true }).messages.rowDetails[0].parsedTextPreview, '你好，已读这段说明');
});


test('chat readiness does not read or compare job IDs, titles or recruiter identity', () => {
  const a = adapter({ [P.chatHeader]: [element()], [P.composer]: [element()] });
  a.identity = () => assert.fail('identity comparison was removed');
  assert.doesNotThrow(() => a.assertChatReady());
  a.doc.selectors[P.messages] = [debugMessage('ready-1', '正常消息')];
  assert.equal(a.history({ jobId: 'unrelated', title: '不一致的岗位' }).length, 1);
  a.doc.selectors[P.chatEmpty] = [element()]; assert.throws(() => a.assertChatReady(), /未展开/);
  a.doc.selectors[P.chatEmpty] = []; a.doc.selectors[P.composer] = [];
  assert.throws(() => a.assertChatReady(), /唯一元素/);
});


test('default adapter no longer exposes attachment or reply adaptation fields', () => {
  const a = adapter({}, { resumeOpen: '.old', verifiedReply: true });
  for (const key of ['resumeOpen', 'resumeDialog', 'resumeReceipt', 'verifiedReply', 'verifiedResume', 'conversationName']) {
    assert.equal(Object.hasOwn(P, key), false); assert.equal(Object.hasOwn(a.p, key), false);
  }
});

test('contact navigation accepts only explicit same-site chat links for the current job', () => {
  const a = adapter();
  const good = 'https://www.zhipin.com/web/geek/chat?jobId=job1&securityId=test';
  assert.equal(a.contactChatUrl(element({ 'data-url': good }), { jobId: 'job1' }), good);
  for (const href of ['/web/geek/chat', '/web/geek/chat?jobId=other', 'https://example.com/web/geek/chat?jobId=job1', 'javascript:void(0)'])
    assert.equal(a.contactChatUrl(element({ href }), { jobId: 'job1' }), '');
});

function popupAdapter({ draft = '', closeCount = 1 } = {}) {
  const content = element(), dialog = element(), close = element();
  content.closest = selector => selector === '.dialog-con' ? dialog : null;
  content.selectors['textarea.input-area'] = [{ value: draft }];
  dialog.selectors['.icon-close, .dialog-close, .close-icon, .close, [aria-label="关闭"], [title="关闭"], [aria-label="Close"]'] = Array.from({ length: closeCount }, () => close);
  const a = adapter({ '.startchat-content': [content] });
  return { a, close };
}
test('only the identified empty inline chat popup exposes its close control', () => {
  const { a, close } = popupAdapter();
  assert.equal(a.startChatPopup().close, close);
  assert.equal(adapter().startChatPopup(), null);
  assert.throws(() => popupAdapter({ draft: '人工草稿' }).a.startChatPopup(), /已有草稿/);
  assert.throws(() => popupAdapter({ closeCount: 0 }).a.startChatPopup(), /关闭按钮/);
  assert.throws(() => popupAdapter({ closeCount: 2 }).a.startChatPopup(), /关闭按钮/);
});
test('continuation accepts only the same job and an explicit continue label', () => {
  const a = adapter(), button = element({}, '继续沟通'); a.button = () => button;
  assert.equal(a.continueContactButton({ jobId: 'job1' }), button);
  assert.throws(() => a.continueContactButton({ jobId: 'other' }), /已离开当前岗位/);
  button.innerText = '立即沟通';
  assert.throws(() => a.continueContactButton({ jobId: 'job1' }), /不重复点击/);
});
