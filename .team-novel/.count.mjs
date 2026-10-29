import { readFileSync } from 'node:fs';

const text = readFileSync(process.argv[2], 'utf8');
const lines = text.split(/\r?\n/);
const paras = lines.map((l) => l.trim()).filter(Boolean);
const body = paras.filter((p) => !p.startsWith('#')).join('\n');

const countAll = (s) => [...s].length;
const countNoSpace = (s) => [...s].filter((c) => !/\s/.test(c)).length;
const countHan = (s) => [...s].filter((c) => /[\u4e00-\u9fff]/.test(c)).length;
const countPunct = (s) => [...s].filter((c) => /[\u3000-\u303f\uff00-\uffef]/.test(c)).length;
const countHanOrAlnum = (s) => [...s].filter((c) => /[\u4e00-\u9fffA-Za-z0-9]/.test(c)).length;
const sentences = body.split(/[。！？]/).map((s) => s.trim()).filter(Boolean);

console.log(JSON.stringify({
  file: process.argv[2],
  totalChars: countAll(text),
  totalCharsNoSpace: countNoSpace(text),
  bodyCharsNoSpace: countNoSpace(body),
  bodyHan: countHan(body),
  bodyHanOrAlnum: countHanOrAlnum(body),
  bodyPunct: countPunct(body),
  paragraphs: paras.length,
  bodyParagraphs: paras.filter((p) => !p.startsWith('#')).length,
  sentences: sentences.length,
  title: paras[0],
}, null, 2));
