/* DOM only. No private BOSS API calls; selectors are versioned user configuration. */
(function (root) {
  'use strict';
  const DEFAULT_PROFILE = {
    version: 4, verifiedContact: false, verifiedReply: false, verifiedResume: false,
    firstContactOpensEmptyChat: false,
    card: '.job-card-wrapper, .job-card-box', cardLink: 'a[href*="/job_detail/"]',
    nextPage: '.options-pages .next, .pagination-next', endMarker: '.job-list-empty',
    detail: '.job-detail-section .job-sec-text, .job-sec-text', title: '.job-banner .name h1, .job-name',
    employmentType: '.job-banner .job-status, .job-banner .job-type', city: '.job-banner .text-city, .job-banner .job-area',
    salary: '.job-banner .salary',
    recruiter: '[data-boss-id]', recruiterAttr: 'data-boss-id',
    recruiterScope: '.boss-info, .boss-info-box, .job-boss-info',
    recruiterName: '.job-boss-info h2.name, .boss-info h2, .boss-info .name, .boss-info-box h2, .boss-name',
    company: '.sider-company .company-info a, .job-boss-info .boss-info-attr, .job-company-info .company-name, .job-banner .company-name, .boss-info .company-name, .boss-info .boss-title',
    contact: '.op-btn-chat, .btn-startchat', chatUrl: 'https://www.zhipin.com/web/geek/chat',
    conversation: '[data-boss-id][data-job-id]', conversationRecruiterAttr: 'data-boss-id', conversationJobAttr: 'data-job-id',
    conversationRow: '.friend-content', conversationName: '.name-box .name-text',
    conversationCompany: '.name-box > span:nth-of-type(2)',
    chatIdentity: '[data-current-boss-id][data-current-job-id]', chatRecruiterAttr: 'data-current-boss-id', chatJobAttr: 'data-current-job-id',
    chatHeader: '.chat-conversation, .chat-info, .chat-header, .conversation-header',
    chatEmpty: '.chat-conversation .chat-no-data',
    chatRecruiterName: '.top-info-content .name-text, .chat-info .name, .chat-header .name, .conversation-header .name, .boss-name',
    chatCompany: '.top-info-content .base-title, .company-name, .company',
    chatPosition: '.chat-position-content .position-content', chatTitle: '.position-name', chatSalary: '.salary', chatCity: '.city',
    messages: '.chat-record .message-item, [data-message-id]', messageIdAttr: 'data-mid',
    messageIncoming: '.message-item.item-friend, .message-item.friend', messageOutgoing: '.message-item.item-myself, .message-item.myself',
    messageText: '.text', richMessage: 'img:not(.emoji), audio, video, .file-card',
    composer: '#chat-input', send: '.btn-send',
    resumeOpen: '.btn-resume', resumeDialog: '.resume-dialog', resumeItem: '.resume-item',
    resumeName: '.resume-name', resumeSend: '.btn-send', resumeReceipt: '.resume-card',
    blocked: '.geetest_panel, .captcha-box, .verify-wrap, .login-dialog'
  };
  class Adapter {
    constructor(doc = document, profile = {}, knownJobs = []) {
      this.doc = doc; this.p = { ...DEFAULT_PROFILE, ...profile }; this.knownJobs = knownJobs;
      if (profile.contact === '.op-btn-chat') this.p.contact = DEFAULT_PROFILE.contact;
      // Migrate only shipped defaults; preserve deliberate custom selectors.
      const legacy = { chatHeader: '.chat-info, .chat-header, .conversation-header', messages: '[data-message-id]',
        messageIdAttr: 'data-message-id', messageIncoming: '.message-item.friend', messageOutgoing: '.message-item.myself' };
      if (!profile.version || profile.version < 3) for (const [key, value] of Object.entries(legacy)) {
        if (profile[key] === value) this.p[key] = DEFAULT_PROFILE[key];
      }
      if (!profile.version || profile.version < 4) {
        if (profile.chatRecruiterName === '.name, .boss-name') this.p.chatRecruiterName = DEFAULT_PROFILE.chatRecruiterName;
        if (profile.chatCompany === '.company-name, .company') this.p.chatCompany = DEFAULT_PROFILE.chatCompany;
      }
    }
    nodes(selector, scope = this.doc) {
      if (!selector) return [];
      try { return [...scope.querySelectorAll(selector)].filter(n => n.getClientRects().length && !n.closest('#boss-ai-host')); }
      catch { throw new Error('页面选择器无效，请检查高级适配配置'); }
    }
    one(selector, scope = this.doc, optional = false) {
      const ns = this.nodes(selector, scope);
      if (optional && !ns.length) return null;
      if (ns.length !== 1) throw new Error('页面结构不明确：需要唯一元素 ' + selector);
      return ns[0];
    }
    text(selector, scope = this.doc) { return this.nodes(selector, scope).map(n => n.innerText || n.textContent || '').join('\n').trim(); }
    health() {
      if (this.nodes(this.p.blocked).length || /安全验证|访问过于频繁|账号异常|请完成验证/.test(this.doc.body?.innerText || '')) throw new Error('检测到登录、验证或平台限制，请手动处理后重新启动');
    }
    safeUrl(url) {
      const u = new URL(url, this.doc.location.href);
      if (u.origin !== 'https://www.zhipin.com' || !/^\/(job_detail\/|web\/geek\/)/.test(u.pathname)) throw new Error('拒绝导航到非 BOSS 职位或聊天地址');
      return u;
    }
    jobId(url) { return new URL(url, this.doc.location.href).pathname.match(/\/job_detail\/([^/.]+)/)?.[1] || ''; }
    uniqueText(selector, scope = this.doc, person = false) {
      const values = this.nodes(selector, scope).map(n => {
        const direct = person ? [...(n.childNodes || [])].filter(c => c.nodeType === 3).map(c => c.textContent).join('') : '';
        return (direct.trim() || n.innerText || n.textContent || '').split('\n')[0]
          .replace(/(?:刚刚活跃|今日活跃|本周活跃|本月活跃|\d+分钟前活跃).*$/, '').split(/\s*[·•]\s*/)[0].trim();
      }).filter(Boolean);
      const unique = [...new Set(values)]; return unique.length === 1 ? unique[0] : '';
    }
    normalizeField(value, kind = '') {
      let text = String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
      if (kind === 'salary') text = text.replace(/\s/g, '').replace(/[–—−~～]/g, '-');
      if (kind === 'city') text = text.replace(/市$/, '');
      return text;
    }
    uniqueField(selector, scope = this.doc, kind = '') {
      const values = [...new Set(this.nodes(selector, scope).map(n => this.normalizeField(n.innerText || n.textContent || '', kind)).filter(Boolean))];
      return values.length === 1 ? values[0] : '';
    }
    visibleRecruiter(name, company) { return name && company ? 'visible-context:' + JSON.stringify([company, name]) : ''; }
    recruiterInfo() {
      const candidates = [], add = (value, source) => {
        if (value && /^[a-zA-Z0-9_~.-]{1,200}$/.test(value)) candidates.push({ value, source });
      };
      for (const n of this.nodes(this.p.recruiter)) add(n.getAttribute(this.p.recruiterAttr), 'configured:' + this.p.recruiterAttr);
      const attrs = ['data-boss-id', 'data-bossid', 'data-boss-uid', 'data-recruiter-id', 'data-encrypt-boss-id'];
      const scopes = this.nodes(this.p.recruiterScope), contacts = this.nodes(this.p.contact);
      for (const n of [...scopes, ...contacts, ...scopes.flatMap(scope => this.nodes(attrs.map(a => '[' + a + ']').join(','), scope))]) {
        for (const attr of attrs) add(n.getAttribute(attr), attr);
      }
      for (const n of [...contacts, ...scopes.flatMap(scope => this.nodes('a[href]', scope))]) {
        try {
          const u = new URL(n.getAttribute('href') || '', this.doc.location.href);
          if (u.origin !== 'https://www.zhipin.com') continue;
          for (const key of ['bossId', 'bossid', 'encryptBossId', 'boss_id']) add(u.searchParams.get(key), 'link:' + key);
          add(u.pathname.match(/\/boss_detail\/([^/.]+)\.html/)?.[1], 'link:boss_detail');
        } catch { /* invalid or javascript link */ }
      }
      const ids = [...new Set(candidates.map(c => c.value))];
      const name = this.uniqueText(this.p.recruiterName, this.doc, true), company = this.uniqueText(this.p.company);
      const contextId = this.visibleRecruiter(name, company);
      return { recruiterId: ids.length === 1 ? ids[0] : ids.length === 0 ? contextId : '',
        recruiterName: name, company, identityType: ids.length === 1 ? 'platform-id' : contextId && !ids.length ? 'visible-context' : 'unresolved',
        identityDiagnostic: { candidateCount: ids.length, sources: [...new Set(candidates.map(c => c.source))],
          nameFound: !!name, companyFound: !!company,
          status: ids.length > 1 ? 'conflicting' : ids.length || contextId ? 'resolved' : 'missing' } };
    }
    cards() {
      this.health();
      const links = this.nodes(this.p.card).flatMap(card => this.nodes(this.p.cardLink, card));
      return [...new Map(links.map(a => {
        const u = this.safeUrl(a.href); u.hash = '';
        const id = this.jobId(u.href);
        return [id, { jobId: id, url: u.href, summary: (a.closest(this.p.card)?.innerText || a.innerText || '').slice(0, 10000) }];
      }).filter(([id]) => id)).values()];
    }
    inspectJob() {
      this.health();
      const jobId = this.jobId(this.doc.location.href);
      const description = this.text(this.p.detail);
      if (!jobId || description.length < 20) throw new Error('职位详情未加载或选择器不匹配');
      const recruiter = this.recruiterInfo();
      const contactText = this.text(this.p.contact);
      const buttons = this.nodes(this.p.contact);
      let contactTargetJobId = '';
      if (buttons.length === 1) {
        try {
          const target = new URL(buttons[0].getAttribute('data-url') || '', this.doc.location.href);
          if (target.origin === 'https://www.zhipin.com') contactTargetJobId = target.searchParams.get('jobId') || '';
        } catch { /* no explicit target */ }
      }
      return { jobId, ...recruiter, url: this.doc.location.href.split('#')[0],
        title: this.uniqueField(this.p.title).slice(0, 200), description: description.slice(0, 20000),
        employmentType: (this.text(this.p.employmentType) || (/实习/.test(this.text(this.p.title)) ? '实习' : '')).slice(0, 100), city: this.uniqueField(this.p.city).slice(0, 100),
        salary: this.uniqueField(this.p.salary).slice(0, 200),
        contactTargetJobId,
        alreadyContacted: /继续沟通|已沟通/.test(contactText) };
    }
    chatReady() {
      return !this.nodes(this.p.chatEmpty).length && !!(this.nodes(this.p.chatIdentity).length || this.nodes(this.p.chatHeader).length);
    }
    identityJobLinks(header) {
      // A historical message may link to another job. Only the active header/card
      // supplies a job link in the current full conversation container.
      const regions = header.matches?.('.chat-conversation') ? this.nodes('.top-info-content, .chat-position-content', header) : [header];
      return [...new Set(regions.flatMap(scope => this.nodes('a[href*="/job_detail/"]', scope)))];
    }
    identity() {
      if (this.nodes(this.p.chatEmpty).length) throw new Error('聊天页尚未选中目标会话，不能发送');
      const el = this.one(this.p.chatIdentity, this.doc, true);
      if (!el) {
        const headers = this.nodes(this.p.chatHeader), identities = [];
        if (!headers.length) throw new Error('聊天窗口未加载或适配不匹配：未找到聊天容器，请在消息页运行只读诊断');
        for (const header of headers) {
          const links = this.identityJobLinks(header);
          const jobIds = [...new Set(links.map(a => this.jobId(this.safeUrl(a.href).href)).filter(Boolean))];
          const name = this.uniqueText(this.p.chatRecruiterName, header, true), company = this.uniqueText(this.p.chatCompany, header);
          const recruiterId = this.visibleRecruiter(name, company);
          if (jobIds.length > 1) throw new Error('聊天区域包含多个岗位，无法核对当前岗位');
          if (jobIds.length === 1 && recruiterId) identities.push({ jobId: jobIds[0], recruiterId, recruiterName: name, company, identityType: 'visible-context' });
          else if (!jobIds.length && recruiterId) {
            const positions = this.nodes(this.p.chatPosition, header);
            if (positions.length > 1) throw new Error('聊天区域包含多个岗位卡片，无法核对当前岗位');
            if (positions.length === 1) {
              const title = this.uniqueField(this.p.chatTitle, positions[0]), salary = this.uniqueField(this.p.chatSalary, positions[0], 'salary'), city = this.uniqueField(this.p.chatCity, positions[0], 'city');
              if (title && salary && city) identities.push({ recruiterId, recruiterName: name, company, title, salary, city, identityType: 'visible-fields' });
            }
          }
        }
        const unique = [...new Map(identities.map(job => [JSON.stringify([job.jobId || '', job.recruiterId, job.title || '', job.salary || '', job.city || '']), job])).values()];
        if (unique.length > 1) throw new Error('聊天区域身份互相冲突，已停止发送');
        if (!unique.length) throw new Error('聊天窗口已找到，但招聘者、公司或岗位卡片字段不完整；需要岗位链接，或完整的岗位名称/薪资/城市');
        return unique[0];
      }
      const job = { jobId: el.getAttribute(this.p.chatJobAttr), recruiterId: el.getAttribute(this.p.chatRecruiterAttr), identityType: 'platform-id' };
      root.BossCore.pair(job);
      return job;
    }
    assertIdentity(job) {
      const actual = this.identity();
      root.BossCore.pair(job);
      if (actual.identityType === 'visible-fields') {
        // No job ID is invented. Match all five independent fields to a detail page
        // whose contact button explicitly targeted the expected job ID.
        if (job.contactTargetJobId !== job.jobId) throw new Error('可见字段核对需要详情页沟通按钮绑定本岗位，请重新读取职位');
        const fields = [['recruiterName', '招聘者', ''], ['company', '公司', ''], ['title', '岗位名称', ''], ['salary', '薪资', 'salary'], ['city', '城市', 'city']];
        for (const [key, label, kind] of fields) {
          const expected = this.normalizeField(job[key], kind);
          if (!expected || expected !== this.normalizeField(actual[key], kind)) throw new Error('当前会话的' + label + '与目标职位不一致或字段缺失，已停止');
        }
        if (this.knownJobs.some(other => other?.jobId && other.jobId !== job.jobId && fields.every(([key, , kind]) => this.normalizeField(other[key], kind) === this.normalizeField(actual[key], kind)))) {
          throw new Error('多个已读取岗位的展示信息完全相同，不能唯一核对岗位，需要岗位 ID 或人工处理');
        }
        return;
      }
      if (root.BossCore.pair(actual) === root.BossCore.pair(job)) return;
      if (actual.jobId === job.jobId && actual.identityType === 'visible-context' && job.recruiterName && job.company &&
        actual.recruiterName === job.recruiterName && actual.company === job.company) return;
      throw new Error('当前会话与目标岗位/招聘者不一致，已停止');
    }
    isSystemNotice(n) {
      // This allowlist identifies the platform's competitor-analysis promotion,
      // not arbitrary blue cards or messages that merely quote its title.
      if (!n.matches(this.p.messageIncoming) || n.matches(this.p.messageOutgoing)) return false;
      const cards = this.nodes('.message-card-wrap', n);
      if (cards.length !== 1 || !cards[0].matches('.message-card-wrap.blue')) return false;
      const card = cards[0], titles = this.nodes('.message-card-top-title', card), buttons = this.nodes('.message-card-buttons .card-btn', card);
      if (titles.length !== 1 || buttons.length !== 1) return false;
      const title = this.normalizeField(titles[0].innerText || titles[0].textContent).replace(/\s/g, '');
      if (!/^(?:你|您)与该职位竞争者PK情况$/i.test(title) || this.normalizeField(buttons[0].innerText || buttons[0].textContent) !== '查看详细分析') return false;
      if (this.text(this.p.messageText, n) || this.nodes(this.p.richMessage, n).some(media => !card.contains(media))) return false;
      // Preserve any real text attached outside the card. Only the row's time
      // label may coexist with this known system notice.
      const cardText = this.normalizeField(card.innerText || card.textContent);
      if (!cardText) return false;
      let remaining = this.normalizeField(n.innerText || n.textContent).replace(cardText, '');
      for (const time of this.nodes('.item-time', n)) remaining = remaining.replace(this.normalizeField(time.innerText || time.textContent), '');
      return !remaining.trim();
    }
    history(job) {
      this.health(); this.assertIdentity(job);
      const seen = new Set();
      return this.nodes(this.p.messages).flatMap(n => {
        const id = n.getAttribute(this.p.messageIdAttr) || (this.p.messageIdAttr === 'data-mid' ? n.getAttribute('data-message-id') : null);
        if (!id || seen.has(id)) throw new Error('消息缺少唯一 ID 或 ID 重复');
        seen.add(id);
        const incoming = n.matches(this.p.messageIncoming), outgoing = n.matches(this.p.messageOutgoing);
        if (incoming === outgoing) throw new Error('无法判别消息方向，已停止该会话');
        if (this.isSystemNotice(n)) return [];
        return [{ id, role: incoming ? 'recruiter' : 'candidate', text: this.text(this.p.messageText, n).slice(0, 6000),
          rich: this.nodes(this.p.richMessage, n).length > 0 }];
      });
    }
    selectConversation(job) {
      this.health();
      let matches = this.nodes(this.p.conversation).filter(n => n.getAttribute(this.p.conversationRecruiterAttr) === job.recruiterId && n.getAttribute(this.p.conversationJobAttr) === job.jobId);
      if (!matches.length && job.recruiterName && job.company) {
        matches = this.nodes(this.p.conversationRow).filter(n => {
          const rid = n.getAttribute(this.p.conversationRecruiterAttr), jid = n.getAttribute(this.p.conversationJobAttr);
          if (rid && rid !== job.recruiterId || jid && jid !== job.jobId) return false;
          return this.uniqueText(this.p.conversationName, n, true) === job.recruiterName && this.uniqueText(this.p.conversationCompany, n) === job.company;
        });
      }
      if (matches.length !== 1) {
        const error = new Error(matches.length ? '同公司同招聘者出现多个会话，需人工核对' : '目标招聘者会话尚未加载，或公司/招聘者字段不匹配');
        error.code = matches.length ? 'CHAT_AMBIGUOUS' : 'CHAT_NOT_FOUND'; throw error;
      }
      matches[0].click();
    }
    editor() { return this.one(this.p.composer); }
    fill(text) {
      const input = this.editor();
      if ((input.value || input.textContent || '').trim()) throw new Error('输入框已有草稿，请人工处理，避免覆盖');
      input.focus();
      if ('value' in input) {
        const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
        if (descriptor?.set) descriptor.set.call(input, text); else input.value = text;
      } else if (input.isContentEditable) input.textContent = text;
      else throw new Error('不支持的聊天编辑器');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    button(selector, scope) {
      const n = this.one(selector, scope);
      if (n.disabled || n.getAttribute('aria-disabled') === 'true' || n.classList.contains('disabled')) throw new Error('操作按钮不可用');
      return n;
    }
    diagnostic() {
      const counts = {};
      for (const key of ['cardLink', 'detail', 'salary', 'recruiter', 'contact', 'conversation', 'conversationRow', 'chatIdentity', 'chatHeader', 'chatEmpty', 'chatRecruiterName', 'chatCompany', 'chatPosition', 'chatTitle', 'chatSalary', 'chatCity', 'messages', 'composer', 'send', 'resumeOpen', 'resumeDialog']) {
        try { counts[key] = this.nodes(this.p[key]).length; } catch { counts[key] = '选择器错误'; }
      }
      const visibleMessages = this.nodes(this.p.messages), ignoredCards = visibleMessages.filter(n => this.isSystemNotice(n)).length;
      let job, identity, chatIdentity;
      try { const x = this.inspectJob(); job = { jobIdFound: !!x.jobId, recruiterIdFound: !!x.recruiterId, descriptionLength: x.description.length }; } catch { /* not detail */ }
      try {
        const actual = this.identity(); chatIdentity = actual;
        identity = actual.identityType === 'visible-fields' ? '招聘者、公司、岗位名称、薪资及城市可读取；发送时需逐项匹配目标职位（页面未提供岗位 ID）' : '岗位及招聘者可核对';
      } catch (e) { identity = e.message; }
      const chat = this.nodes(this.p.chatHeader).map(scope => ({
        container: scope.className || scope.tagName || '',
        jobLinks: this.identityJobLinks(scope).length,
        recruiterFields: this.nodes(this.p.chatRecruiterName, scope).length,
        companyFields: this.nodes(this.p.chatCompany, scope).length,
        // Structural hints only: no conversation text, tokens, names or attribute values.
        structure: this.nodes('[class], [id], [data-mid], [data-job-id]', scope).slice(0, 60).map(n => ({
          tag: n.tagName, class: typeof n.className === 'string' ? n.className : '', hasId: !!n.id,
          attributes: [...(n.attributes || [])].map(a => a.name).filter(name => !name.startsWith('data-v-'))
        }))
      }));
      const recruiter = chatIdentity ? { candidateCount: chatIdentity.identityType === 'platform-id' ? 1 : 0,
        sources: [chatIdentity.identityType], nameFound: !!chatIdentity.recruiterName, companyFound: !!chatIdentity.company, status: 'resolved' } : this.recruiterInfo().identityDiagnostic;
      return { page: this.doc.location.pathname, counts, job, recruiter, identity,
        messageSummary: { visibleRows: visibleMessages.length, ignoredSystemCards: ignoredCards, conversationRows: visibleMessages.length - ignoredCards },
        chat,
        warning: '诊断只读取页面，不证明立即沟通是否自动发送招呼。verified 标记必须在人工验证流程后设置。' };
    }
    advance() {
      this.health();
      const next = this.nodes(this.p.nextPage);
      if (next.length > 1) throw new Error('翻页按钮不唯一');
      if (next.length === 1 && !next[0].disabled && next[0].getAttribute('aria-disabled') !== 'true' && !next[0].classList.contains('disabled')) {
        next[0].click(); return 'page';
      }
      if (this.nodes(this.p.endMarker).length || next.length) return 'end';
      const cards = this.nodes(this.p.cardLink);
      if (cards.length) cards.at(-1).scrollIntoView({ block: 'end' });
      this.doc.defaultView.scrollBy(0, Math.max(600, this.doc.defaultView.innerHeight));
      return 'scroll';
    }
  }
  root.BossAdapter = { Adapter, DEFAULT_PROFILE };
})(globalThis);
