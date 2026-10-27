const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const { zipSync, strToU8 } = require('fflate');
const { DOMParser } = require('@xmldom/xmldom');
const bundle = require('esbuild').buildSync({ entryPoints: [path.resolve('src/resume-reader.entry.js')],
  bundle: true, write: false, format: 'iife', globalName: 'Reader', platform: 'browser' }).outputFiles[0].text;
function reader() {
  const context = { console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout,
    TextDecoder, TextEncoder, Uint8Array, Uint16Array, Uint32Array, ArrayBuffer, Float32Array, Float64Array,
    structuredClone, URL, Blob, DOMParser, ReadableStream, TransformStream, AbortController, AbortSignal,
    DOMMatrix: class {}, navigator: { userAgent: 'Chrome test', platform: 'Windows' } };
  vm.runInNewContext(bundle, context); return context.Reader;
}
function file(name, data) {
  const bytes = typeof data === 'string' ? strToU8(data) : data;
  return { name, size: bytes.length, arrayBuffer: async () => bytes.slice().buffer };
}
function pdfFixture() {
  const text = 'BT /F1 12 Tf 50 750 Td (Resume Python development project testing experience) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${text.length} >>\nstream\n${text}\nendstream`];
  let result = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(result.length); result += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = result.length;
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(x => `${String(x).padStart(10, '0')} 00000 n \n`).join('');
  return result + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
}
test('text resumes are extracted locally with file and length limits', async () => {
  const r = reader(); const text = '本科在读，熟悉Python，开发过数据分析与软件测试项目。';
  assert.equal(await r.extract(file('resume.txt', text)), text);
  await assert.rejects(r.extract(file('resume.doc', text)), /DOCX/);
  await assert.rejects(r.extract(file('resume.txt', '太短')), /足够/);
  await assert.rejects(r.extract({ name: 'resume.pdf', size: 11 * 1024 * 1024 }), /10MB/);
});
test('DOCX extracts only document paragraphs without rendering markup', async () => {
  const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>教育背景：本科在读，熟悉Python程序开发。</w:t></w:r></w:p><w:p><w:r><w:t>项目经历：独立完成数据分析与测试。</w:t></w:r></w:p></w:body></w:document>';
  const result = await reader().extract(file('resume.docx', zipSync({ 'word/document.xml': strToU8(xml), 'word/irrelevant.bin': new Uint8Array(10) })));
  assert.ok(result.includes('本科在读')); assert.ok(result.includes('\n项目经历'));
  await assert.rejects(reader().extract(file('bad.docx', zipSync({ 'x': strToU8('bad') }))), /正文/);
});
test('bundled PDF parser extracts text with no network, worker URL or eval', async () => {
  const r = reader(); const result = await r.extract(file('resume.pdf', pdfFixture()));
  assert.ok(result.includes('Python development project'));
});
