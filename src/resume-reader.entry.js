// Bundled locally into the userscript; no CDN or document upload.
import { getDocument } from 'pdfjs-dist/build/pdf.mjs';
import 'pdfjs-dist/build/pdf.worker.mjs';
import { unzipSync } from 'fflate';

const limit = 60000;
function normalize(text) {
  const result = String(text).replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (result.length < 20) throw new Error('未提取到足够的简历文字；扫描版PDF请先转换为文字版，不支持图片OCR');
  if (result.length > limit) throw new Error('简历文字超过60000字，请删减后重试');
  return result;
}
export async function extract(file, progress = () => {}) {
  if (!file || !file.size || file.size > 10 * 1024 * 1024) throw new Error('请选择不超过10MB的简历文件');
  const type = String(file.name || '').split('.').pop().toLowerCase();
  if (!['pdf', 'docx', 'txt', 'md'].includes(type)) throw new Error('支持PDF、DOCX、TXT和MD；旧版DOC请另存为DOCX');
  progress('正在本地读取简历文件');
  const data = new Uint8Array(await file.arrayBuffer());
  if (type === 'txt' || type === 'md') {
    let text = new TextDecoder('utf-8').decode(data);
    if ((text.match(/\ufffd/g) || []).length > Math.max(2, text.length * 0.01)) text = new TextDecoder('gb18030').decode(data);
    return normalize(text);
  }
  if (type === 'docx') {
    const files = unzipSync(data, { filter: entry => {
      if (entry.name !== 'word/document.xml') return false;
      if (entry.originalSize > 6 * 1024 * 1024) throw new Error('DOCX解压内容过大');
      return true;
    } });
    if (!files['word/document.xml']) throw new Error('DOCX没有可读取的正文');
    const xml = new TextDecoder().decode(files['word/document.xml']);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('不支持含外部实体声明的DOCX');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('DOCX正文格式损坏');
    return normalize([...doc.getElementsByTagNameNS('*', 'p')].map(p =>
      [...p.getElementsByTagNameNS('*', 't')].map(t => t.textContent).join('')).join('\n'));
  }
  const task = getDocument({ data, isEvalSupported: false, useWorkerFetch: false,
    isOffscreenCanvasSupported: false, useWasm: false, disableFontFace: true });
  let expired = false;
  const timer = setTimeout(() => { expired = true; void task.destroy().catch(() => {}); }, 45000);
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 20) throw new Error('简历超过20页，请精简后重试');
    let text = '';
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      progress(`正在本地提取PDF文字：${pageNo}/${pdf.numPages}页`);
      const page = await pdf.getPage(pageNo), content = await page.getTextContent();
      text += content.items.map(item => (item.str || '') + (item.hasEOL ? '\n' : ' ')).join('') + '\n';
      page.cleanup();
      if (text.length > limit) throw new Error('简历文字超过60000字，请精简后重试');
    }
    return normalize(text);
  } catch (error) {
    if (expired) throw new Error('PDF解析超过45秒，请转换为TXT或DOCX重试');
    if (error?.name === 'PasswordException') throw new Error('PDF已加密，请使用无密码的简历副本');
    if (/PDF/.test(error.message) || /简历|文字/.test(error.message)) throw error;
    throw new Error('PDF解析失败，请检查文件或另存为文字版PDF', { cause: error });
  } finally { clearTimeout(timer); await task.destroy().catch(() => {}); }
}
