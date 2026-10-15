const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const C = require('../src/core.js');
const context = { BossCore: C, URL };
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../src/adapter.js'), 'utf8'), context);
const { Adapter, DEFAULT_PROFILE: P } = context.BossAdapter;
function element(attrs = {}, text = '', selectors = {}) {
  return { selectors, innerText: text, textContent: text, childNodes: [{ nodeType: 3, textContent: text }],
    getAttribute(name) { return attrs[name] || null; }, href: attrs.href };
}
function adapter(selectors = {}, profile = {}) {
  const doc = { selectors, location: { href: 'https://www.zhipin.com/job_detail/job1.html', pathname: '/job_detail/job1.html' } };
  class DOMAdapter extends Adapter {
    nodes(selector, scope = this.doc) { return scope.selectors?.[selector] || []; }
    health() {}
  }
  return new DOMAdapter(doc, profile);
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
test('visible chat identity requires the exact job link, company and recruiter', () => {
  const header = element({}, '', { 'a[href*="/job_detail/"]': [element({ href: 'https://www.zhipin.com/job_detail/job1.html' })],
    [P.chatRecruiterName]: [element({}, '测试招聘者')], [P.chatCompany]: [element({}, '示例公司')] });
  const a = adapter({ [P.chatHeader]: [header] });
  const expected = { jobId: 'job1', recruiterId: 'platform-123', recruiterName: '测试招聘者', company: '示例公司' };
  assert.doesNotThrow(() => a.assertIdentity(expected));
  assert.throws(() => a.assertIdentity({ ...expected, jobId: 'job2' }));
  assert.throws(() => a.assertIdentity({ ...expected, company: '其他公司' }));
  header.selectors['a[href*="/job_detail/"]'] = [];
  assert.throws(() => a.assertIdentity(expected));
});
test('old default contact selector is migrated to the current button variant', () => {
  assert.ok(adapter({}, { contact: '.op-btn-chat' }).p.contact.includes('.btn-startchat'));
});
