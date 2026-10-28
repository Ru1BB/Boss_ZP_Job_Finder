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
      try { return [...scope.querySelectorAll(selector)].filter(n => n.getClientRects().length && !n.closest('#boss-ai-host, #boss-ai-debug-host')); }
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
    assertChatReady() {
      if (!this.chatReady()) throw new Error('聊天窗口未展开，不能发送；请先打开会话');
      this.editor();
    }
    isAvatarImage(media, row) {
      // Observed avatar slot: message row > .message-content > .figure:first-child
      // > img.image-circle. Rounded images inside message bodies stay rich content.
      if (media.tagName !== 'IMG' || !media.matches?.('img.image-circle')) return false;
      const figure = media.parentElement, content = figure?.parentElement;
      return !!(figure?.matches?.('.figure') && content?.matches?.('.message-content') &&
        content.parentElement === row && content.firstElementChild === figure);
    }
    richNodes(row) { return this.nodes(this.p.richMessage, row).filter(media => !this.isAvatarImage(media, row)); }
    isSystemNotice(n) {
      // Only the observed platform attachment receipt is ignored, never arbitrary
      // unknown-direction messages or recruiter text quoting a receipt.
      if (n.matches('.message-item.item-system') && !n.matches(this.p.messageIncoming) && !n.matches(this.p.messageOutgoing)) {
        const receipt = this.text('.hyper-link.text', n).replace(/\s/g, '');
        if (/^您的附件简历.+已发送给Boss点击查看附件$/.test(receipt) &&
            receipt === String(n.innerText || n.textContent || '').replace(/\s/g, '') && !this.richNodes(n).length) return true;
      }
      // This allowlist identifies the platform's competitor-analysis promotion,
      // not arbitrary blue cards or messages that merely quote its title.
      if (!n.matches(this.p.messageIncoming) || n.matches(this.p.messageOutgoing)) return false;
      const cards = this.nodes('.message-card-wrap', n);
      if (cards.length !== 1 || !cards[0].matches('.message-card-wrap.blue')) return false;
      const card = cards[0], titles = this.nodes('.message-card-top-title', card), buttons = this.nodes('.message-card-buttons .card-btn', card);
      if (titles.length !== 1 || buttons.length !== 1) return false;
      const title = this.normalizeField(titles[0].innerText || titles[0].textContent).replace(/\s/g, '');
      if (!/^(?:你|您)与该职位竞争者PK情况$/i.test(title) || this.normalizeField(buttons[0].innerText || buttons[0].textContent) !== '查看详细分析') return false;
      if (this.text(this.p.messageText, n) || this.richNodes(n).some(media => !card.contains(media))) return false;
      // Preserve any real text attached outside the card. Only the row's time
      // label may coexist with this known system notice.
      const cardText = this.normalizeField(card.innerText || card.textContent);
      if (!cardText) return false;
      let remaining = this.normalizeField(n.innerText || n.textContent).replace(cardText, '');
      for (const time of this.nodes('.item-time', n)) remaining = remaining.replace(this.normalizeField(time.innerText || time.textContent), '');
      return !remaining.trim();
    }
    messageBody(row) {
      return this.nodes(this.p.messageText, row).map(node => {
        // BOSS places read status beside .text-content inside .text.
        const contents = this.p.messageText === '.text' ? this.nodes('.text-content', node) : [];
        if (contents.length) return contents.map(n => n.innerText || n.textContent || '').join('\n');
        return node.innerText || node.textContent || '';
      }).join('\n').trim();
    }
    history(job) {
      this.health(); this.assertChatReady();
      const seen = new Set();
      return this.nodes(this.p.messages).flatMap(n => {
        const id = n.getAttribute(this.p.messageIdAttr) || (this.p.messageIdAttr === 'data-mid' ? n.getAttribute('data-message-id') : null);
        if (!id || seen.has(id)) throw new Error('消息缺少唯一 ID 或 ID 重复');
        seen.add(id);
        const incoming = n.matches(this.p.messageIncoming), outgoing = n.matches(this.p.messageOutgoing);
        if (this.isSystemNotice(n)) return [];
        if (incoming === outgoing) throw new Error('无法判别消息方向，已停止该会话');
        return [{ id, role: incoming ? 'recruiter' : 'candidate', text: this.messageBody(n).slice(0, 6000),
          rich: this.richNodes(n).length > 0 }];
      });
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
    debugSnapshot(options = {}) {
      const includeMessageText = options.includeMessageText === true;
      const errors = [];
      const safe = (name, fn, fallback) => { try { return fn(); } catch { errors.push(name); return fallback; } };
      const nodes = (name, selector) => safe(name, () => this.nodes(selector), []);
      const classes = node => String(typeof node.className === 'string' ? node.className : '').split(/\s+/)
        .filter(x => /^[A-Za-z_][\w-]{0,79}$/.test(x)).slice(0, 6);
      const selectorPart = node => {
        const tag = /^[a-z][\w-]*$/i.test(node.tagName || '') ? node.tagName.toLowerCase() : 'element';
        const siblings = [...(node.parentElement?.children || [])].filter(n => n.tagName === node.tagName);
        return tag + classes(node).map(c => '.' + c).join('') + (siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : '');
      };
      const describe = node => {
        const ancestors = []; let current = node;
        for (let i = 0; current && i < 5; i++, current = current.parentElement) ancestors.unshift(selectorPart(current));
        const rect = node.getBoundingClientRect?.();
        return { tag: node.tagName || '', classes: classes(node), hasId: !!node.id,
          selectorHint: ancestors.join(' > '),
          attributes: [...(node.attributes || [])].map(a => a.name).filter(n => /^(?:id|class|role|type|contenteditable|disabled|aria-|data-)/.test(n) && !n.startsWith('data-v-')).slice(0, 25),
          editable: !!node.isContentEditable, visible: this.healthVisible(node), disabled: !!node.disabled || node.getAttribute?.('aria-disabled') === 'true' ||
            !!node.classList?.contains('disabled') || String(typeof node.className === 'string' ? node.className : '').split(/\s+/).includes('disabled'),
          inViewport: rect ? rect.width > 0 && rect.height > 0 && (rect.x || 0) + rect.width > 0 && (rect.y || 0) + rect.height > 0 &&
            (rect.x || 0) < (this.doc.defaultView?.innerWidth ?? Infinity) && (rect.y || 0) < (this.doc.defaultView?.innerHeight ?? Infinity) : null,
          box: rect ? { x: Math.round(rect.x || 0), y: Math.round(rect.y || 0), width: Math.round(rect.width || 0), height: Math.round(rect.height || 0) } : null };
      };
      const capture = (name, selector, max = 8) => nodes(name, selector).slice(0, max).map(describe);
      const sendCandidates = nodes('sendCandidates', 'button, [role="button"], a, span')
        .filter(n => /^发送$/.test((n.innerText || n.textContent || '').trim())).slice(0, 8).map(describe);
      const candidates = {
        chatContainers: capture('chatContainers', this.p.chatHeader),
        chatPositions: capture('chatPositions', '.chat-position-content, .chat-position-content .position-content'),
        editors: capture('editors', '[contenteditable="true"], textarea, [role="textbox"]'),
        configuredEditor: capture('configuredEditor', this.p.composer),
        configuredSend: capture('configuredSend', this.p.send), sendCandidates,
        conversationRows: capture('conversationRows', this.p.conversationRow, 5),
        recentMessageRows: nodes('recentMessageRows', this.p.messages).slice(-5).map(describe),
        frames: capture('frames', 'iframe', 5)
      };
      const messageNodes = nodes('messageRows', this.p.messages);
      const ids = messageNodes.map((node, i) => safe('messageId.' + i, () => node.getAttribute(this.p.messageIdAttr) ||
        (this.p.messageIdAttr === 'data-mid' ? node.getAttribute('data-message-id') : null), null));
      const idCounts = new Map(); for (const id of ids) if (id) idCounts.set(id, (idCounts.get(id) || 0) + 1);
      const offset = Math.max(0, messageNodes.length - 20);
      const rowDetails = messageNodes.slice(-20).map((node, i) => {
        const index = offset + i, label = 'message.' + index;
        const incoming = safe(label + '.incoming', () => node.matches(this.p.messageIncoming), null);
        const outgoing = safe(label + '.outgoing', () => node.matches(this.p.messageOutgoing), null);
        const directionKnown = typeof incoming === 'boolean' && typeof outgoing === 'boolean' && incoming !== outgoing;
        const textNodes = safe(label + '.textNodes', () => this.nodes(this.p.messageText, node), []);
        const text = safe(label + '.text', () => this.messageBody(node), '');
        const rowText = String(node.innerText || node.textContent || '').trim();
        const matchedRich = safe(label + '.rich', () => this.nodes(this.p.richMessage, node), []);
        const ignoredAvatars = matchedRich.filter(media => this.isAvatarImage(media, node));
        const rich = matchedRich.filter(media => !this.isAvatarImage(media, node));
        const systemCard = safe(label + '.systemCard', () => this.isSystemNotice(node), false);
        const duplicateId = !!ids[index] && idCounts.get(ids[index]) > 1;
        const issues = [];
        if (!ids[index]) issues.push('missing-message-id');
        if (duplicateId) issues.push('duplicate-message-id');
        if (!directionKnown && !systemCard) issues.push('unknown-or-conflicting-direction');
        if (!systemCard && !text.trim()) issues.push(rowText ? 'row-has-content-but-no-parsed-text' : 'no-parsed-text');
        if (!systemCard && rich.length) issues.push('rich-content');
        const children = safe(label + '.structure', () => this.nodes('[class], p, span', node), []);
        const result = { row: index + 1, ...describe(node), hasMessageId: !!ids[index], duplicateId,
          direction: directionKnown ? incoming ? 'recruiter' : 'candidate' : 'unknown',
          textMatchCount: textNodes.length, textLength: text.length, parsedTextLength: Math.min(6000, text.length),
          rowTextLength: rowText.length, richCount: rich.length, ignoredSystemCard: systemCard,
          matchedRichCount: matchedRich.length, ignoredAvatarCount: ignoredAvatars.length,
          textStructure: textNodes.slice(0, 6).map(n => ({ ...describe(n), textLength: String(n.innerText || n.textContent || '').trim().length })),
          richStructure: rich.slice(0, 8).map(describe),
          ignoredAvatarStructure: ignoredAvatars.slice(0, 4).map(describe),
          historyRowShapeValid: !!ids[index] && !duplicateId && (directionKnown || systemCard),
          contentKind: systemCard ? 'ignored-system-card' : rich.length ? 'rich-content' : text.trim() ? 'text' : rowText ? 'card-or-unmatched-text' : 'empty',
          issues, childStructure: children.slice(0, 30).map(child => ({ tag: child.tagName || '', classes: classes(child),
            textLength: String(child.innerText || child.textContent || '').trim().length })),
          structureTruncated: children.length > 30 };
        if (includeMessageText) {
          result.parsedTextPreview = text.slice(0, 500); result.rowTextPreview = rowText.slice(0, 500);
          result.previewTruncated = text.length > 500 || rowText.length > 500;
        }
        return result;
      });
      const diagnosis = [];
      if (!messageNodes.length) diagnosis.push('未找到消息行：先展开目标会话，再核对messages选择器');
      if (rowDetails.some(row => row.issues.includes('missing-message-id') || row.duplicateId)) diagnosis.push('存在缺失或重复消息ID，会阻止正常读取聊天历史');
      if (rowDetails.some(row => row.direction === 'unknown' && !row.ignoredSystemCard)) diagnosis.push('部分消息无法区分收发方向，需要核对消息方向选择器');
      if (rowDetails.some(row => row.contentKind === 'card-or-unmatched-text')) diagnosis.push('消息行有内容，但正文选择器没有读到文字；查看对应childStructure定位正文或卡片');
      if (rowDetails.some(row => row.contentKind === 'rich-content')) diagnosis.push('存在图片/文件等非纯文本内容，需结合卡片结构判断，不能当作纯文字自动回复');
      if (rowDetails.length && rowDetails.every(row => row.historyRowShapeValid && (row.ignoredSystemCard || row.textLength > 0 && row.richCount === 0))) diagnosis.push('已采样消息的ID、方向和纯文字正文形状可读取；不代表发送流程已验证');
      const original = safe('basicDiagnostic', () => this.diagnostic(), { unavailable: true });
      const basic = { counts: original.counts || {}, messageSummary: original.messageSummary || null,
        job: original.job || null, unavailable: !!original.unavailable,
        identityStatus: original.identity === '岗位 ID 可核对' ? 'job-id-readable' : /岗位名称可读取/.test(original.identity || '') ? 'job-title-readable' :
          /尚未选中/.test(original.identity || '') ? 'no-selected-conversation' : 'missing-or-ambiguous' };
      return { page: this.doc.location.pathname,
        health: safe('health', () => this.healthIssue()?.kind || 'normal', 'unknown'),
        basic, candidates, messages: { totalMatchedRows: messageNodes.length, inspectedRows: rowDetails.length,
          olderRowsOmitted: offset, contentIncluded: includeMessageText, rowDetails }, diagnosis, errors,
        notice: includeMessageText ? '本次已勾选包含最近20条消息正文，每段最多500字，可能含招聘者信息或联系方式；分享前核对。仍不读取草稿、身份属性值或插件配置中的简历与Key，不提交AI、不发送消息。' :
          '只读诊断：默认只记录结构、方向、ID是否存在和文字长度，不包含正文、草稿、完整URL、身份属性值、简历或Key。selectorHint仅为结构线索，不提交AI、不发送消息。' };
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
