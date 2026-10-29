/**
 * 宽松 JSON 解析。
 * trace span 的 input/output 在插件侧按 traceInputMax 截断后还会补一个 `…`，
 * 直接 JSON.parse 会失败、只能退化成纯文本。这里把截断的 JSON 修补成「最后一个
 * 完整元素」的前缀树，至少能以 JsonViewer 展示结构。
 */
import type { JsonValue } from '@/components/JsonViewer';

export interface LooseJson {
  value: JsonValue;
  /** 原文带省略号，或解析时修补了截断 */
  truncated: boolean;
}

const isJsonObject = (value: unknown): value is JsonValue =>
  value !== null && typeof value === 'object';

/** 前缀还差哪些收尾符号；结尾在字符串内部时返回 null（该切点不可用）。 */
function closersFor(prefix: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of prefix) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') {
      if (!stack.length) return null;
      stack.pop();
    }
  }
  if (inString) return null;
  let out = '';
  for (let i = stack.length - 1; i >= 0; i -= 1) out += stack[i] === '{' ? '}' : ']';
  return out;
}

function repair(text: string): JsonValue | null {
  // 只在结构符号处回退：截断在字符串内部时，一直回退到该字符串之前的边界
  const cuts: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === ',' || char === '}' || char === ']') cuts.push(i);
  }
  cuts.push(text.length);
  for (let i = cuts.length - 1; i >= 0; i -= 1) {
    const cut = cuts[i];
    const prefix = text.slice(0, cut).replace(/[,\s]+$/, '');
    if (!prefix) continue;
    const suffix = closersFor(prefix);
    if (suffix === null) continue;
    try {
      const parsed: unknown = JSON.parse(prefix + suffix);
      return isJsonObject(parsed) ? (parsed as JsonValue) : null;
    } catch {
      /* 换更早的切点再试 */
    }
  }
  return null;
}

/** 对象/数组形态的 JSON（含被截断的）→ JsonViewer 可用的值；普通文本返回 null。 */
export function parseLooseJson(text?: string | null): LooseJson | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  const clipped = trimmed.endsWith('…');
  const body = clipped ? trimmed.replace(/…+$/, '') : trimmed;
  try {
    const parsed: unknown = JSON.parse(body);
    return isJsonObject(parsed) ? { value: parsed as JsonValue, truncated: clipped } : null;
  } catch {
    const value = repair(body);
    return value ? { value, truncated: true } : null;
  }
}
