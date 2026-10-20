/* DOM only. No private BOSS API calls; selectors are versioned user configuration. */
(function (root) {
  'use strict';
  const DEFAULT_PROFILE = {
    version: 4, verifiedContact: false, verifiedReply: false, verifiedResume: false,
    firstContactOpensEmptyChat: false,
    card: '.job-card-wrapper, .job-card-box', cardLink: 'a[href*="/job_detail/"]',
    nextPage: '.options-pages .next, .pagination-next', endMarker: '.job-list-empty',
    categoryLink: 'a[href="javascript:;"]',
    categoryRoot: '.c-expect-select',
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
    constructor(doc = document, profile = {}, knownJobs = [], options = {}) {
      this.doc = doc; this.p = { ...DEFAULT_PROFILE, ...profile }; this.knownJobs = knownJobs;
      this.verifyChatWindow = options.verifyChatWindow !== false;
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
    healthVisible(node) {
      for (let n = node; n; n = n.parentElement) {
        const style = this.doc.defaultView?.getComputedStyle?.(n);
        if (n.hidden || n.getAttribute?.('aria-hidden') === 'true' || style?.display === 'none' ||
          style?.visibility === 'hidden' || style?.visibility === 'collapse' || style?.opacity === '0') return false;
      }
      return true;
    }
    healthIssue() {
      const classify = text => /访问过于频繁|操作频繁|账号异常|访问受限/.test(text) ? 'restriction' :
        /登录失效|登录已过期|请先登录|重新登录/.test(text) ? 'login' :
        /安全验证|请完成验证|拖动滑块|验证码/.test(text) ? 'verification' :
        /网络异常|网络连接失败|页面加载失败|系统繁忙|服务开小差|请求超时/.test(text) ? 'transient' : null;
      const controls = this.nodes(this.p.blocked).filter(n => this.healthVisible(n));
      if (controls.length) return { kind: controls.some(n => n.matches?.('.login-dialog')) ? 'login' : 'verification' };
      for (const dialog of this.nodes('[role="dialog"]').filter(n => this.healthVisible(n))) {
        const kind = classify(dialog.innerText || '');
        if (kind) return { kind };
      }
      // Never classify normal job descriptions, chat messages or our own log as a block page.
      const functional = [this.p.cardLink, this.p.detail, this.p.composer, this.p.conversationRow]
        .some(selector => this.nodes(selector).length);
      if (functional) return null;
      let text = this.doc.body?.innerText || '';
      const host = this.doc.getElementById?.('boss-ai-host');
      if (host?.innerText) text = text.replace(host.innerText, '');
      text = text.trim();
      if (!text || text.length > 400) return null;
      const kind = classify(text); return kind ? { kind } : null;
    }
    health() {
      const issue = this.healthIssue();
      if (!issue) return;
      const labels = { verification: '安全验证', login: '登录失效', restriction: '平台限制', transient: '页面暂时异常' };
      const error = new Error('检测到' + labels[issue.kind]);
      error.code = 'PAGE_HEALTH'; error.healthIssue = issue; throw error;
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
          if (jobIds.length === 1) identities.push({ jobId: jobIds[0], recruiterId, recruiterName: name, company, identityType: 'visible-context' });
          else if (!jobIds.length) {
            let positions = this.nodes(this.p.chatPosition, header);
            if (!positions.length) positions = this.nodes('.chat-position-content', header);
            if (positions.length > 1) throw new Error('聊天区域包含多个岗位卡片，无法核对当前岗位');
            if (positions.length === 1) {
              const title = this.uniqueField(this.p.chatTitle, positions[0]), salary = this.uniqueField(this.p.chatSalary, positions[0], 'salary'), city = this.uniqueField(this.p.chatCity, positions[0], 'city');
              if (title) identities.push({ recruiterId, recruiterName: name, company, title, salary, city, identityType: 'visible-fields' });
            }
          }
        }
        const unique = [...new Map(identities.map(job => [JSON.stringify([job.jobId || '', job.title || '']), job])).values()];
        if (unique.length > 1) throw new Error('聊天区域身份互相冲突，已停止发送');
        if (!unique.length) throw new Error('聊天窗口已找到，但岗位名称字段缺失；需要岗位链接或岗位名称');
        return unique[0];
      }
      const job = { jobId: el.getAttribute(this.p.chatJobAttr), recruiterId: el.getAttribute(this.p.chatRecruiterAttr), identityType: 'platform-id' };
      if (!job.jobId) throw new Error('聊天页缺少岗位 ID，无法核对岗位');
      return job;
    }
    assertIdentity(job) {
      if (!this.verifyChatWindow) {
        // The user explicitly opts out of identity comparison, not UI readiness.
        if (!this.chatReady()) throw new Error('聊天窗口未展开，不能发送；请先打开会话');
        this.editor();
        return;
      }
      const actual = this.identity();
      root.BossCore.pair(job);
      if (actual.identityType === 'visible-fields') {
        // No job ID is invented. Match only the job title to a detail page
        // whose contact button explicitly targeted the expected job ID.
        if (job.contactTargetJobId !== job.jobId) throw new Error('可见字段核对需要详情页沟通按钮绑定本岗位，请重新读取职位');
        const fields = [['title', '岗位名称', '']];
        for (const [key, label, kind] of fields) {
          const expected = this.normalizeField(job[key], kind);
          if (!expected || expected !== this.normalizeField(actual[key], kind)) throw new Error('当前会话的' + label + '与目标职位不一致或字段缺失，已停止');
        }
        return;
      }
      if (actual.jobId === job.jobId) return;
      throw new Error('当前会话与目标岗位不一致，已停止');
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
    normalizeEditorText(text) {
      return String(text ?? '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim();
    }
    editorText(input = this.editor()) {
      return this.normalizeEditorText('value' in input ? input.value : (input.innerText ?? input.textContent ?? ''));
    }
    editorMatches(text) { return this.editorText() === this.normalizeEditorText(text); }
    fill(text) {
      const input = this.editor();
      if (this.editorText(input)) throw new Error('输入框已有草稿，请人工处理，避免覆盖');
      input.focus();
      if ('value' in input) {
        const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
        if (descriptor?.set) descriptor.set.call(input, text); else input.value = text;
      } else if (input.isContentEditable) {
        // textContent puts raw newlines in a normal-white-space DIV. Its rendered
        // innerText can then collapse them, especially the AI disclosure newline.
        // Use the editing path so BOSS receives input events and real line breaks.
        const selection = this.doc.getSelection?.(), range = this.doc.createRange?.();
        let inserted = false;
        if (selection && range && this.doc.execCommand) {
          range.selectNodeContents(input); range.collapse(false);
          selection.removeAllRanges(); selection.addRange(range);
          inserted = this.doc.execCommand('insertText', false, text);
        }
        if (!inserted) {
          if (this.editorText(input)) throw new Error('编辑器写入结果不明确，保留草稿并取消发送');
          input.innerText = text;
        }
      }
      else throw new Error('不支持的聊天编辑器');
      const Input = this.doc.defaultView?.InputEvent;
      input.dispatchEvent(Input ? new Input('input', { bubbles: true, inputType: 'insertText', data: text }) : new Event('input', { bubbles: true }));
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
        identity = actual.identityType === 'visible-fields' ? '岗位名称可读取；发送时仅匹配岗位名称，不核对薪资和城市（页面未提供岗位 ID）' : '岗位 ID 可核对';
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
    categoryName(node) {
      const values = [node.getAttribute('title'), node.getAttribute('aria-label'),
        node.textContent, node.innerText].map(value => this.normalizeField(value)).filter(Boolean);
      return values.find(value => !/(?:\.{3}|…)/.test(value)) || values[0] || '';
    }
    categoryChoices(config = {}) {
      const roots = this.nodes(this.p.categoryRoot);
      if (roots.length > 1) throw new Error('岗位类别容器不唯一，跳过自动切换');
      const eligible = label => label === '推荐' || /^[^()]+\([^()]+\)$/.test(label);
      // Overflow entries stay in this scoped DOM even while their dropdown is hidden.
      // Do not use nodes() here: its visibility filter would discard those entries.
      const raw = roots.length ? [...roots[0].querySelectorAll('a, li, [role="menuitem"], .expect-item, span, div')]
        .map(node => ({ node, label: this.categoryName(node) })).filter(item => eligible(item.label)) : null;
      const links = raw ? raw.filter(item => !raw.some(child => child !== item && child.label === item.label && item.node.contains(child.node))) :
        this.nodes(this.p.categoryLink).map(node => ({ node, label: this.categoryName(node) }));
      let choices;
      if (raw) choices = links;
      else {
        const recommended = links.filter(item => item.label === '推荐');
        if (!recommended.length) return [];
        const row = recommended[0].node.getBoundingClientRect();
        choices = links.filter(item => {
          const rect = item.node.getBoundingClientRect();
          return Math.abs(rect.top - row.top) < Math.max(16, row.height) &&
            eligible(item.label);
        });
      }
      const selected = node => [node, node.parentElement, node.closest?.('a, .expect-item, [role="menuitem"], li')].filter(Boolean).some(n =>
        n.getAttribute('aria-selected') === 'true' || ['page', 'true'].includes(n.getAttribute('aria-current')) ||
        ['active', 'selected', 'current'].some(name => n.classList?.contains(name)));
      const groups = new Map();
      for (const item of choices) {
        if (!groups.has(item.label)) groups.set(item.label, []);
        groups.get(item.label).push({ ...item, active: selected(item.node), visible: item.node.getClientRects ? item.node.getClientRects().length > 0 : true });
      }
      // Responsive top tabs and the overflow menu may render the same category twice.
      // Keep one logical category in page order; click an active/visible copy first.
      return [...groups.values()].map(copies => ({
        ...(copies.find(item => item.active && item.visible) || copies.find(item => item.visible) || copies[0]),
        active: copies.some(item => item.active), copies: copies.length
      }));
    }
    categoryFingerprint() { return this.cards().map(job => job.jobId).sort().join('|'); }
    planCategory(config, lastCategory = '') {
      const choices = this.categoryChoices(config);
      if (choices.length < 2) return null;
      const active = choices.filter(item => item.active);
      if (active.length > 1) throw new Error('岗位类别选中状态冲突，跳过自动切换');
      const current = active[0]?.label || lastCategory;
      const index = choices.findIndex(item => item.label === current);
      return { label: choices[(index + 1) % choices.length].label, before: this.categoryFingerprint() };
    }
    clickCategory(label, config) {
      this.health();
      const matches = this.categoryChoices(config).filter(item => item.label === label);
      if (matches.length !== 1) throw new Error('未找到唯一岗位类别入口，跳过自动切换');
      const href = matches[0].node.getAttribute('href');
      if (href && !/^javascript:\s*;?$/i.test(href) && this.safeUrl(href).pathname !== '/web/geek/jobs') throw new Error('岗位类别入口不是搜索页，跳过切换');
      matches[0].node.click();
    }
    categoryChanged(pending, config) {
      const active = this.categoryChoices(config).filter(item => item.active);
      if (active.length === 1 && active[0].label === pending.label) return true;
      const fingerprint = this.categoryFingerprint();
      return !!fingerprint && fingerprint !== pending.before;
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
