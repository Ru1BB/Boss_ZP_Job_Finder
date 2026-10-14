/* Shared pure logic; no browser globals or credentials. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BossCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Public provider settings are fixed here. Credentials remain in Tampermonkey storage.
  const PROVIDERS = Object.freeze({
    qwen: Object.freeze({ baseUrl: 'https://maas.qianwenaiapi.com/compatible-mode/v1', model: 'qwen3.8-flash' }),
    deepseek: Object.freeze({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' })
  });
  const defaults = () => ({
    provider: 'qwen', ...PROVIDERS.qwen, apiKey: '', resume: '', preferences: '',
    screeningPrompt: '综合考虑我的经历、技能和求职偏好，说明匹配理由与不确定性。',
    greetingPrompt: '用自然、简短的中文打招呼，突出真实匹配点，不编造经历，不承诺薪资或面试。',
    threshold: 80, maxContacts: 50, sendIntervalSeconds: 180,
    refreshMinSeconds: 10, refreshMaxSeconds: 60, maxReplies: 5,
    scheduleEnabled: false, startTime: '', stopTime: '', autoSend: false,
    resumeName: '', internshipOnly: true, requiredCity: '北京', profile: {}
  });
  const fail = message => { throw new Error(message); };
  const AI_NOTICE = '（本消息由 AI 发送）';
  function aiMessage(text) {
    let body = String(text || '').trim();
    if (!body) return '';
    while (body.endsWith(AI_NOTICE)) body = body.slice(0, -AI_NOTICE.length).trimEnd();
    return body ? body + '\n' + AI_NOTICE : '';
  }
  function fixedConfig(raw = {}) {
    const provider = raw.provider ?? 'qwen';
    if (!Object.hasOwn(PROVIDERS, provider)) fail('不支持的供应商');
    const preset = PROVIDERS[provider], c = { ...defaults(), ...raw, ...preset, provider };
    // Do not carry credentials from a previously configured different service to a new destination.
    if (raw.baseUrl && raw.baseUrl !== preset.baseUrl) { c.apiKey = ''; c.autoSend = false; }
    return c;
  }
  function validateConfig(c, requireAI = false) {
    if (!Object.hasOwn(PROVIDERS, c.provider)) fail('不支持的供应商');
    for (const key of ['baseUrl', 'model', 'apiKey', 'resume', 'preferences', 'screeningPrompt', 'greetingPrompt', 'resumeName', 'requiredCity']) {
      if (typeof c[key] !== 'string') fail(`配置 ${key} 必须是文字`);
    }
    for (const key of ['autoSend', 'scheduleEnabled', 'internshipOnly']) if (typeof c[key] !== 'boolean') fail(`配置 ${key} 必须是开关值`);
    for (const [key, min, max] of [['threshold', 0, 100], ['maxContacts', 1, 500],
      ['sendIntervalSeconds', 1, 86400], ['refreshMinSeconds', 1, 3600],
      ['refreshMaxSeconds', 1, 3600], ['maxReplies', 1, 100]]) {
      if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max) fail(`配置 ${key} 必须是 ${min}–${max} 的整数`);
    }
    if (c.refreshMaxSeconds < c.refreshMinSeconds) fail('随机等待上限不能小于下限');
    if (c.scheduleEnabled && (!validTime(c.startTime) || !validTime(c.stopTime) || c.startTime === c.stopTime)) fail('请配置不同的开始和停止时间（HH:mm）');
    if (c.baseUrl) endpoint(c.baseUrl);
    if (requireAI && (!c.baseUrl || !c.model.trim() || !c.apiKey.trim() || !c.resume.trim())) fail('请填写 API 地址、模型、Key 和简历文字');
    if (!c.profile || typeof c.profile !== 'object' || Array.isArray(c.profile)) fail('页面适配配置必须是 JSON 对象');
    for (const [key, value] of Object.entries(c.profile)) {
      if (['verifiedContact', 'verifiedReply', 'verifiedResume', 'firstContactOpensEmptyChat'].includes(key)) {
        if (typeof value !== 'boolean') fail('页面流程验证标记必须为 true 或 false');
      } else if (key !== 'version' && typeof value !== 'string') fail('页面选择器和属性名必须为文字');
    }
    return c;
  }
  function endpoint(base) {
    let u;
    try { u = new URL(base); } catch { fail('API 地址无效'); }
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) fail('API 地址必须是无凭证、查询参数和片段的 HTTPS 地址');
    return u.href.replace(/\/$/, '').replace(/\/chat\/completions$/, '') + '/chat/completions';
  }
  function networkFailure(target, event) {
    const host = new URL(target).hostname;
    // Classify only. Never display raw provider/extension errors: they can contain credentials.
    const raw = typeof event === 'string' ? event : String(event?.error || event?.message || '');
    const reason = /not.?permitted|not.?allowed|permission|whitelist|@connect|not.?whitelisted/i.test(raw) ? '油猴拒绝了跨域访问' :
      /certificate|cert_|ssl|tls/i.test(raw) ? '证书或 TLS 连接失败' :
      /name_not_resolved|dns/i.test(raw) ? '域名解析失败' :
      /redirect/i.test(raw) ? '接口发生重定向，请填写最终 API 地址' :
      /timeout|timed.?out/i.test(raw) ? '连接超时' : '未收到有效 HTTP 响应，尚不能判断 Key 或模型是否正确';
    return `AI 网络请求失败：${reason}。目标域名：${host}。请检查油猴是否允许连接此域名（脚本顶部需有 // @connect ${host}），再检查网络/代理。不要发送 API Key 或原始请求日志。`;
  }
  function httpFailure(status) {
    const hints = { 400: '请求参数或模型不兼容，请核对模型及 JSON 输出支持',
      401: '认证失败，请核对本服务商提供的 Key', 402: '账户额度或付款状态异常',
      403: '访问被拒绝，请核对账号、模型和地域权限', 404: '接口路径或模型不存在',
      405: '接口不接受此请求方法，请核对 Base URL', 429: '达到调用频率或额度限制，请稍后手动重试' };
    return `AI 请求失败 HTTP ${status}：${hints[status] || (status >= 500 ? '服务商或上游服务异常' : '请检查接口配置及服务商状态')}`;
  }
  const validTime = s => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
  function schedule(c, now) {
    if (!c.scheduleEnabled) return null;
    if (!validTime(c.startTime) || !validTime(c.stopTime) || c.startTime === c.stopTime) return null;
    const day = 86400000, shifted = now + 8 * 3600000;
    const midnight = Math.floor(shifted / day) * day - 8 * 3600000;
    const minutes = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
    let start = midnight + minutes(c.startTime) * 60000;
    let end = midnight + minutes(c.stopTime) * 60000;
    if (end <= start) { end += day; if (now < start) { start -= day; end -= day; } }
    return { id: String(start), start, end, active: now >= start && now < end };
  }
  function randomDelay(c, rng = Math.random) {
    return (c.refreshMinSeconds + Math.floor(rng() * (c.refreshMaxSeconds - c.refreshMinSeconds + 1))) * 1000;
  }
  function parseJSON(s) {
    if (typeof s !== 'string' || s.length > 50000) fail('AI 返回内容无效');
    try { return JSON.parse(s.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')); }
    catch { fail('AI 未返回有效 JSON，已暂停'); }
  }
  function analysis(raw) {
    const x = typeof raw === 'string' ? parseJSON(raw) : raw;
    if (!x || typeof x !== 'object' || !Number.isFinite(x.score) || x.score < 0 || x.score > 100 ||
      typeof x.suitable !== 'boolean' || typeof x.uncertain !== 'boolean' ||
      typeof x.reason !== 'string' || !x.reason.trim() || !Array.isArray(x.doubts) ||
      !x.doubts.every(v => typeof v === 'string') || typeof x.greeting !== 'string' || x.greeting.length > 500) fail('AI 筛选结果结构无效');
    if (x.suitable && !x.uncertain && !x.greeting.trim()) fail('AI 招呼语为空');
    x.greeting = aiMessage(x.greeting);
    return x;
  }
  function reply(raw) {
    const x = typeof raw === 'string' ? parseJSON(raw) : raw;
    if (!x || !['reply', 'resume', 'handoff'].includes(x.action) || typeof x.text !== 'string' ||
      typeof x.reason !== 'string' || !Array.isArray(x.evidence) || !x.evidence.every(v => typeof v === 'string') ||
      x.text.length > 1000 || (x.action === 'reply' && (!x.text.trim() || !x.evidence.length))) fail('AI 回复结果结构无效');
    if (x.action === 'reply') x.text = aiMessage(x.text);
    return x;
  }
  function pair(job) {
    if (!job || !job.jobId || !job.recruiterId) fail('无法可靠识别岗位及招聘者');
    return JSON.stringify([String(job.recruiterId), String(job.jobId)]);
  }
  const sensitive = text => /面试|约面|几点|周[一二三四五六日天]|明天|后天|到岗|入职|薪资|工资|待遇|底薪|期望薪|报价|微信|手机号|电话|邮箱|身份证|银行卡|转账|付款|验证码|下载|安装|点击链接|加.{0,3}(微|v|V)/i.test(text);
  const wantsResume = text => !/不用|不必|不需要|不要|别发|无需|已(?:经)?收到|收到了|不方便|暂不|不用再/.test(text) && /(?:请|麻烦|方便|能|可以|能否|能不能).{0,12}(?:发|给|传|提供).{0,12}简历|(?:发|传|给).{0,8}(?:一份|一下|份|个|下).{0,8}简历|简历.{0,12}(?:发我|发来|发一下|给我|方便发)|resume\s*please/i.test(text);
  function decide(a, config) { return !a.uncertain && a.suitable && a.score >= config.threshold ? 'eligible' : a.uncertain ? 'review' : 'rejected'; }
  function allowed(state, c, now) {
    if (!state.task || state.task.status !== 'running') return false;
    if (state.task.endAt != null && now >= state.task.endAt) return false;
    const w = schedule(c, now);
    return !c.scheduleEnabled || !!(w && w.active && state.task.windowId === w.id);
  }
  function createTask(c, now, source = 'manual') {
    const w = schedule(c, now);
    if (c.scheduleEnabled && !w?.active) fail('当前不在配置的运行时段内');
    return { id: `${now}-${Math.random().toString(36).slice(2)}`, status: 'running', source,
      startedAt: now, endAt: w?.end ?? null, windowId: w?.id ?? null, contacts: 0,
      nextScanAt: now, exhausted: false, visited: [], replies: {}, searchUrl: '', leaseToken: '' };
  }
  function canSend(s, c, now, kind, entry) {
    if (!allowed(s, c, now) || !c.autoSend) return false;
    if (now < (s.lastSendAt ?? 0) + c.sendIntervalSeconds * 1000) return false;
    if (kind === 'contact' && s.task.contacts >= c.maxContacts) return false;
    if (kind !== 'contact' && (!entry || entry.status !== 'contacted' || entry.handoff)) return false;
    if (kind === 'reply' && (s.task.replies[entry.key] || 0) >= c.maxReplies) return false;
    return true;
  }
  const emptyState = () => ({ task: null, lastSendAt: 0, blockedWindow: '', entries: {}, outbox: [], logs: [] });
  function hardFilter(job, c) {
    const type = job.employmentType || '', city = job.city || '';
    const text = [job.title, type, job.description].filter(Boolean).join('\n');
    const internshipText = /实习/.test(text);
    const dailySalary = /日薪|[\/／]\s*[天日]|按[天日](?:计薪|计酬|计算|结算)|每[天日]\s*\d|(?:元|块)\s*一[天日]/.test(job.salary || '');
    if (c.requiredCity && city && !city.startsWith(c.requiredCity)) return { status: 'rejected', reason: '工作地点不在' + c.requiredCity };
    if (c.internshipOnly && !internshipText && !dailySalary) {
      if (/全职|正式|兼职/.test(type)) return { status: 'rejected', reason: '未包含实习文本且薪资不是日薪' };
      return { status: 'review', reason: '未找到实习文本或明确日薪，需人工确认' };
    }
    if (c.requiredCity && !city) return { status: 'review', reason: '工作地点缺少可靠字段，需人工确认' };
    return { status: 'pass', reason: '' };
  }
  function reserve(s, c, now, kind, entry, payload) {
    if (!canSend(s, c, now, kind, entry)) fail('当前不允许发送');
    const id = `${s.task.id}-${s.outbox.length}-${now}`;
    const item = { id, taskId: s.task.id, key: entry.key, kind, payload, status: 'pending', createdAt: now };
    s.outbox.push(item); s.lastSendAt = now;
    if (kind === 'contact') { s.task.contacts++; entry.status = 'uncertain'; }
    if (kind === 'reply') s.task.replies[entry.key] = (s.task.replies[entry.key] || 0) + 1;
    if (kind === 'resume') entry.resumeStatus = 'uncertain';
    return item;
  }
  function publicConfig(c) { const { apiKey, ...safe } = c; return safe; }
  function leaseWinner(claims, now) {
    return claims.filter(c => c && c.expires > now).sort((a, b) => a.claimedAt - b.claimedAt || a.owner.localeCompare(b.owner))[0]?.owner ?? null;
  }
  return { AI_NOTICE, aiMessage, PROVIDERS, fixedConfig, defaults, validateConfig, endpoint, networkFailure, httpFailure, schedule, randomDelay, parseJSON, analysis, reply, pair,
    sensitive, wantsResume, decide, allowed, createTask, canSend, emptyState, hardFilter, reserve, publicConfig, leaseWinner };
});
