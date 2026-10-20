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
  const SCORING = Object.freeze([
    { key: 'skills', label: '核心技能与工作内容', max: 30 },
    { key: 'experience', label: '项目经历与可迁移能力', max: 20 },
    { key: 'requirements', label: '基本任职条件', max: 20 },
    { key: 'preferences', label: '求职偏好', max: 20 },
    { key: 'bonus', label: '加分项与优先条件', max: 10 }
  ].map(Object.freeze));
  const scoringPrompt = '采用固定100分制，按以下分项给分：' + SCORING.map(x => `${x.key}（${x.label}）0到${x.max}分`).join('；') + '。' +
    '先将岗位条款分为核心职责、明确必需条件、非必需加分条件。“加分项”“有下列经历者优先”“优先考虑”“有则更佳”“nice to have”“plus”等非必需条款只影响bonus，合计最多10分；缺少它们不得在skills、experience、requirements或preferences重复扣分，不得因此认定不适合。若同一技能在另一条款明确列为必须，则按必需条件评估，但同一缺口仍不得重复扣分。' +
    'skills评价完成核心工作的技能基础，experience评价相关项目、成果及可迁移能力，requirements评价明确必需的专业、学历、年级、实习时长等，preferences评价用户提供的岗位方向等偏好。北京及实习类型由脚本先过滤，不重复扣分。' +
    '各分项按匹配程度给分：充分匹配可得该项满分的90%到100%，大部分匹配75%到89%，部分匹配50%到74%，明显不匹配0%到49%。没有证据时不能当作已经掌握；未提及与明确不满足应区别说明，可迁移经历可以获得部分分数。信息缺失写入doubts，不在其他分项再次扣同一缺口。' +
    'hasBonusRequirements表示岗位是否列有非必需加分条件。有加分条件但简历没有相应证据时bonus可以为0；没有任何加分条款时hasBonusRequirements=false，bonus按10分中性计入，避免因岗位没有写加分项而降低总分。' +
    'reason说明各分项得分依据及主要扣分原因，区分必需条件与加分条件。总分由脚本加总，不自行另设权重、惩罚或一票否决。用户补充筛选要求可以说明偏好，但不改变本评分权重。';
  const defaults = () => ({
    provider: 'qwen', ...PROVIDERS.qwen, apiKey: '', resume: '', preferences: '',
    screeningPrompt: '综合考虑我的经历、技能和求职偏好，说明匹配理由与不确定性。',
    greetingPrompt: '用自然、简短的中文打招呼，突出真实匹配点，不编造经历，不承诺薪资或面试。',
    threshold: 80, maxContacts: 50, sendIntervalSeconds: 180, aiTimeoutSeconds: 180,
    refreshMinSeconds: 10, refreshMaxSeconds: 60, maxReplies: 5,
    scheduleEnabled: false, startTime: '', stopTime: '', autoSend: false, verifyChatWindow: true,
    openRejected: true, verifiedEmptyContact: false,
    switchCategoryOnExhausted: true,
    resumeName: '', internshipOnly: true, requiredCity: '北京', profile: {}
  });
  const fail = message => { throw new Error(message); };
  // Legacy marker: remove it from queued text and recognize old history; never append it.
  const AI_NOTICE = '（本消息由 AI 发送）';
  const PROJECT_INTRO = '此消息发送自本人开发的油猴插件，这是一个基于大模型的求职助手，可分析岗位匹配度并自动发送个性化打招呼。';
  const PROJECT_URL = 'https://github.com/Ru1BB/Boss_ZP_Job_Finder';
  function aiMessage(text) {
    let body = String(text || '').trim();
    if (!body) return '';
    while (AI_NOTICE && body.endsWith(AI_NOTICE)) body = body.slice(0, -AI_NOTICE.length).trimEnd();
    return body;
  }
  function anonymousMessage(text, resume = '', job = {}) {
    let body = String(text || '');
    const names = [...resume.matchAll(/(?:^|\n)\s*(?:姓名|名字)\s*[:：]\s*([\u4e00-\u9fff·]{2,12})/g)].map(m => m[1]);
    for (const name of names) body = body.split(name).join('我');
    if (job.recruiterName?.trim()) body = body.split(job.recruiterName.trim()).join('您');
    return aiMessage(body);
  }
  function greetingMessage(text, resume = '', job = {}) {
    let body = anonymousMessage(text, resume, job);
    if (!body) return '';
    body = body.replaceAll('这是一个基于大模型的求职助手，可分析岗位匹配度并自动发送个性化招呼。', '').trim();
    const introduction = PROJECT_INTRO;
    if (!body.includes(introduction)) body += '\n' + introduction;
    if (!body.includes(PROJECT_URL)) body += '\n自动发送项目：' + PROJECT_URL;
    return aiMessage(body);
  }
  function isAIOutgoing(message) {
    return message?.role === 'candidate' && typeof message.text === 'string' && (message.text.includes('AI') || message.text.includes(PROJECT_INTRO));
  }
  function fixedConfig(raw = {}) {
    const provider = raw.provider ?? 'qwen';
    if (!Object.hasOwn(PROVIDERS, provider)) fail('不支持的供应商');
    const preset = PROVIDERS[provider], c = { ...defaults(), ...raw, ...preset, provider };
    delete c.categoryLabels; // Retire the old manually entered category list.
    // Do not carry credentials from a previously configured different service to a new destination.
    if (raw.baseUrl && raw.baseUrl !== preset.baseUrl) { c.apiKey = ''; c.autoSend = false; }
    return c;
  }
  function validateConfig(c, requireAI = false) {
    if (!Object.hasOwn(PROVIDERS, c.provider)) fail('不支持的供应商');
    for (const key of ['baseUrl', 'model', 'apiKey', 'resume', 'preferences', 'screeningPrompt', 'greetingPrompt', 'resumeName', 'requiredCity']) {
      if (typeof c[key] !== 'string') fail(`配置 ${key} 必须是文字`);
    }
    for (const key of ['autoSend', 'verifyChatWindow', 'scheduleEnabled', 'internshipOnly', 'openRejected', 'verifiedEmptyContact', 'switchCategoryOnExhausted']) if (typeof c[key] !== 'boolean') fail(`配置 ${key} 必须是开关值`);
    for (const [key, min, max] of [['threshold', 0, 100], ['maxContacts', 1, 500],
      ['sendIntervalSeconds', 1, 86400], ['refreshMinSeconds', 1, 3600],
      ['refreshMaxSeconds', 1, 3600], ['maxReplies', 1, 100], ['aiTimeoutSeconds', 30, 600]]) {
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
    if (!x.greeting.trim()) fail('AI 招呼语为空');
    x.greeting = aiMessage(x.greeting);
    if (!x.greeting) fail('AI 招呼语缺少正文');
    return x;
  }
  function scoredAnalysis(raw, resume = '', options = {}) {
    const x = typeof raw === 'string' ? parseJSON(raw) : raw;
    const parts = x?.scoreBreakdown;
    if (!x || typeof x !== 'object' || Array.isArray(x) || typeof x.hasBonusRequirements !== 'boolean' ||
      !parts || typeof parts !== 'object' || Array.isArray(parts) || Object.keys(parts).length !== SCORING.length) fail('AI 分项评分结构无效');
    const scoreBreakdown = {};
    for (const { key, max } of SCORING) {
      if (!Number.isFinite(parts[key]) || parts[key] < 0 || parts[key] > max) fail('AI 分项评分超出范围：' + key);
      scoreBreakdown[key] = key === 'bonus' && !x.hasBonusRequirements ? max : parts[key];
    }
    const validEvidence = Array.isArray(x.greetingEvidence) && x.greetingEvidence.length > 0 && x.greetingEvidence.length <= 3 &&
      x.greetingEvidence.every(e => typeof e === 'string' && e.trim().length >= 4 && e.length <= 200 && (!resume || resume.includes(e.trim())));
    if (!validEvidence) {
      if (!options.recoverEvidence) fail('AI 招呼缺少可核对的简历原文依据');
      // Discard unsupported generated claims; quote a bounded resume fact instead.
      const fact = resume.split(/[\r\n]+/).map(s => s.trim()).find(s =>
        s.length >= 4 && s.length <= 140 && /开发|编程|Python|算法|测试|项目经验/.test(s) &&
        !/姓名|电话|邮箱|https?:|@|不得|不属于|尚未|简历自述|回答.*边界|^【|^求职/.test(s));
      x.greeting = fact ? '您好，我对该岗位感兴趣。简历中的一项经历或技能是：“' + fact + '”。希望结合实际经历进一步沟通岗位匹配情况。' :
        '您好，我对该岗位感兴趣，希望进一步了解工作内容，并结合本人实际经历沟通岗位匹配情况。';
      x.greetingEvidence = fact ? [fact] : []; x.evidenceRecovered = true;
      if (Array.isArray(x.doubts)) x.doubts.push('模型招呼原文依据不足，已改用真实简历片段或中性招呼，不代表具有直接相关经验');
    }
    const score = Math.round(Object.values(scoreBreakdown).reduce((sum, value) => sum + value, 0) * 10) / 10;
    return analysis({ ...x, scoreBreakdown, score, scoringVersion: 2, scoreMaxima: Object.fromEntries(SCORING.map(({ key, max }) => [key, max])) });
  }
  function hasVisibleScore(entries, jobId) {
    if (!jobId) return false;
    const matches = Object.values(entries).filter(entry => !entry.hidden && entry.job?.jobId === jobId);
    if (matches.some(entry => entry.retryApproved)) return false;
    return matches.some(entry => Number.isFinite(entry.analysis?.score) && entry.analysis.score >= 0 && entry.analysis.score <= 100);
  }
  function firstContactStatus(history) {
    if (history.some(m => m.role === 'candidate' && typeof m.text === 'string' && ((AI_NOTICE && m.text.includes(AI_NOTICE)) || m.text.includes(PROJECT_INTRO)))) return 'ai-sent';
    if (history.some(m => m.role === 'candidate')) return 'manual-sent';
    return history.length ? 'incoming-or-unknown' : 'empty';
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
  function decide(a, config) { return a.score >= config.threshold ? 'eligible' : 'rejected'; }
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
    if (kind === 'openOnly') return !!(c.openRejected && c.verifiedEmptyContact &&
      entry?.status === 'rejected' && !entry.handoff && !entry.openOnlyStatus &&
      !s.outbox.some(item => item.key === entry.key && ['contact', 'openOnly'].includes(item.kind)));
    if (now < (s.lastSendAt ?? 0) + c.sendIntervalSeconds * 1000) return false;
    if (kind === 'contact' && s.task.contacts >= c.maxContacts) return false;
    if (kind === 'contact' && (!entry || entry.status !== 'eligible' || entry.handoff ||
      s.outbox.some(item => item.key === entry.key && item.kind === 'contact' && ['sent', 'pending', 'uncertain', 'duplicate'].includes(item.status)))) return false;
    if (kind !== 'contact' && (!entry || entry.status !== 'contacted' || entry.handoff)) return false;
    if (kind === 'reply' && (s.task.replies[entry.key] || 0) >= c.maxReplies) return false;
    return true;
  }
  const emptyState = () => ({ task: null, lastSendAt: 0, blockedWindow: '', entries: {}, outbox: [], logs: [] });
  function clearActivity(s) {
    s.logs = [];
    const protectedKeys = new Set(s.outbox.filter(item => ['pending', 'sent', 'uncertain', 'opened'].includes(item.status)).map(item => item.key));
    for (const [key, entry] of Object.entries(s.entries)) {
      if (['contacted', 'uncertain', 'retryable', 'existing'].includes(entry.status) || protectedKeys.has(key)) {
        delete entry.pendingReply; entry.hidden = true;
      } else delete s.entries[key];
    }
    return s;
  }
  function hardFilter(job, c) {
    const type = job.employmentType || '', city = job.city || '';
    const text = [job.title, type, job.description].filter(Boolean).join('\n');
    const excludesInternship = /(?:不接受|不招(?:收|聘)?|不要(?!求)|不考虑|拒绝|谢绝)\s*(?:任何|在校)?\s*(?:的)?实习(?:生)?|非实习(?:岗|岗位)|实习(?:生)?\s*(?:勿投|勿扰|不招|不考虑|除外)/.test(text);
    const internshipText = /实习/.test(text);
    const dailySalary = /日薪|[\/／]\s*[天日]|按[天日](?:计薪|计酬|计算|结算)|每[天日]\s*\d|(?:元|块)\s*一[天日]/.test(job.salary || '');
    if (c.requiredCity && city && !city.startsWith(c.requiredCity)) return { status: 'rejected', reason: '工作地点不在' + c.requiredCity };
    if (c.internshipOnly && excludesInternship) return { status: 'rejected', reason: '岗位明确不接受实习，否定说明优先于实习关键词或日薪' };
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
    const item = { id, taskId: s.task.id, key: entry.key, kind, payload, status: 'pending', stage: 'reserved', createdAt: now };
    s.outbox.push(item); if (kind !== 'openOnly') s.lastSendAt = now;
    if (kind === 'contact') { s.task.contacts++; entry.status = 'uncertain'; }
    if (kind === 'openOnly') entry.openOnlyStatus = 'pending';
    if (kind === 'reply') s.task.replies[entry.key] = (s.task.replies[entry.key] || 0) + 1;
    if (kind === 'resume') entry.resumeStatus = 'uncertain';
    return item;
  }
  function publicConfig(c) { const { apiKey, ...safe } = c; return safe; }
  function leaseWinner(claims, now) {
    return claims.filter(c => c && c.expires > now).sort((a, b) => a.claimedAt - b.claimedAt || a.owner.localeCompare(b.owner))[0]?.owner ?? null;
  }
  return { AI_NOTICE, PROJECT_INTRO, PROJECT_URL, aiMessage, anonymousMessage, greetingMessage, isAIOutgoing, PROVIDERS, SCORING, scoringPrompt, scoredAnalysis, hasVisibleScore, firstContactStatus, fixedConfig, defaults, validateConfig, endpoint, networkFailure, httpFailure, schedule, randomDelay, parseJSON, analysis, reply, pair,
    sensitive, wantsResume, decide, allowed, createTask, canSend, emptyState, clearActivity, hardFilter, reserve, publicConfig, leaseWinner };
});
