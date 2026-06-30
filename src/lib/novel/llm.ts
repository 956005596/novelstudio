/**
 * LLM 封装层 — 基于 z-ai-web-dev-sdk 接入 GLM-4.6
 * 提供两种调用：
 *   1. chat()        — 非流式，结构化输出（用于 Director / Character 决策）
 *   2. chatStream()  — 流式 SSE，逐 token 输出（用于 Writer 实时生成）
 * 
 * 内置 429/5xx 重试与指数退避，避免限流中断演绎。
 */

import ZAI from 'z-ai-web-dev-sdk';

let _zaiPromise: Promise<ZAI> | null = null;

function getZai(): Promise<ZAI> {
  if (!_zaiPromise) {
    _zaiPromise = ZAI.create();
  }
  return _zaiPromise;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  model?: string;
}

const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1500;

/** 判断错误是否可重试（429 限流 / 5xx 服务器错误 / 网络错误） */
function isRetryable(err: any): boolean {
  const msg = String(err?.message ?? '');
  if (/429|Too many requests|rate limit/i.test(msg)) return true;
  if (/5\d{2}|server error|internal error/i.test(msg)) return true;
  if (/fetch|network|ECONN|ETIMEDOUT/i.test(msg)) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 非流式 chat 调用，返回完整文本。带 429/5xx 重试。 */
export async function chat(
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<string> {
  const zai = await getZai();
  let lastErr: any = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response: any = await zai.chat.completions.create({
        messages,
        thinking: { type: 'disabled' },
        temperature: options.temperature ?? 0.8,
        max_tokens: options.maxTokens ?? 2048,
        ...(options.model ? { model: options.model } : {}),
      });
      return response?.choices?.[0]?.message?.content ?? '';
    } catch (err: any) {
      lastErr = err;
      if (!isRetryable(err) || attempt === MAX_RETRIES - 1) throw err;
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 500;
      console.warn(`[LLM] 重试 ${attempt + 1}/${MAX_RETRIES} in ${Math.round(backoff)}ms: ${err.message}`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

/**
 * 流式 chat 调用，回调 onChunk 收到增量文本
 * 返回完整文本。带 429/5xx 重试（仅在建立流失败时重试，已开始的流不重试）。
 */
export async function chatStream(
  messages: ChatMessage[],
  onChunk: (delta: string) => void,
  options: ChatOptions = {}
): Promise<string> {
  const zai = await getZai();
  let lastErr: any = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const stream: ReadableStream<Uint8Array> = await zai.chat.completions.create({
        messages,
        stream: true,
        thinking: { type: 'disabled' },
        temperature: options.temperature ?? 0.85,
        max_tokens: options.maxTokens ?? 4096,
        ...(options.model ? { model: options.model } : {}),
      } as any);

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let full = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE: 每条以 \n\n 分隔，每行 data: {...}
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const json = JSON.parse(data);
              const delta = json?.choices?.[0]?.delta?.content ?? '';
              if (delta) {
                full += delta;
                onChunk(delta);
              }
            } catch {
              // ignore parse errors (partial chunks)
            }
          }
        }
      }
      return full;
    } catch (err: any) {
      lastErr = err;
      if (!isRetryable(err) || attempt === MAX_RETRIES - 1) throw err;
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 500;
      console.warn(`[LLM Stream] 重试 ${attempt + 1}/${MAX_RETRIES} in ${Math.round(backoff)}ms: ${err.message}`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

/**
 * 尝试从 LLM 输出中提取 JSON 对象。
 * LLM 偶尔会加 ```json fence 或前后说明文本，这里做容错。
 * 也处理被截断的 JSON（自动补全闭合括号）。
 */
export function extractJSON<T = any>(raw: string): T | null {
  if (!raw) return null;

  // 1. 去掉 markdown fence
  let text = raw;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    text = fence[1].trim();
  } else {
    // 找第一个 { 到最后一个 }
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first >= 0 && last > first) {
      text = raw.slice(first, last + 1);
    } else if (first >= 0) {
      // 有 { 但没有 }，可能是截断
      text = raw.slice(first);
    }
  }

  // 2. 直接尝试
  try { return JSON.parse(text) as T; } catch {}

  // 3. 截断修复：补全缺失的闭合符号
  const repaired = repairTruncatedJSON(text);
  if (repaired !== text) {
    try { return JSON.parse(repaired) as T; } catch {}
  }

  // 4. 宽松模式：去掉尾随逗号
  const loose = text.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(loose) as T; } catch {}

  // 5. 宽松 + 修复
  const looseRepaired = repairTruncatedJSON(loose);
  if (looseRepaired !== loose) {
    try { return JSON.parse(looseRepaired) as T; } catch {}
  }

  return null;
}

/**
 * 修复被截断的 JSON：统计未闭合的 { 和 [，补全对应数量的 } 和 ]
 */
function repairTruncatedJSON(text: string): string {
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\') {
      escaped = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '{') openBraces++;
    else if (c === '}') openBraces--;
    else if (c === '[') openBrackets++;
    else if (c === ']') openBrackets--;
  }

  // 如果在字符串中间被截断，先闭合字符串
  let result = text;
  if (inString) {
    result += '"';
  }

  // 去掉尾随的逗号或冒号
  result = result.replace(/[\s,:]+$/, '');

  // 补全闭合符号
  result += ']'.repeat(Math.max(0, openBrackets));
  result += '}'.repeat(Math.max(0, openBraces));

  return result;
}
