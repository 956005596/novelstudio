/**
 * LLM 封装层 — OpenAI 兼容接口
 * 提供两种调用：
 *   1. chat()        — 非流式，结构化输出（用于 Director / Character 决策）
 *   2. chatStream()  — 流式 SSE，逐 token 输出（用于 Writer 实时生成）
 *
 * 内置 429/5xx 重试与指数退避，避免限流中断演绎。
 */

import { readModelConfig, type ModelConfig, type ModelEndpointMode } from './model-config';

export const LLM_CONFIG_MESSAGE =
  '模型配置缺失：请在项目根目录或用户主目录创建 .z-ai-config，JSON 至少包含 baseUrl 和 apiKey；配置好之前不会启动演绎或生成正文。';

export class LLMConfigurationError extends Error {
  originalMessage: string;

  constructor(err: unknown) {
    const originalMessage = err instanceof Error ? err.message : String(err ?? '');
    super(LLM_CONFIG_MESSAGE);
    this.name = 'LLMConfigurationError';
    this.originalMessage = originalMessage;
  }
}

export function isLLMConfigurationError(err: unknown): boolean {
  if (err instanceof LLMConfigurationError) return true;
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /Configuration file not found|\.z-ai-config|baseUrl.*apiKey/i.test(msg);
}

export function toLLMUserMessage(err: unknown): string {
  if (isLLMConfigurationError(err)) return LLM_CONFIG_MESSAGE;
  const msg = err instanceof Error ? err.message : String(err ?? '未知模型错误');
  if (/只返回了推理内容|没有返回最终正文|reasoning_content/i.test(msg)) {
    return '模型只返回了推理内容，没有返回最终正文 content。DeepSeek 推理模型通常是输出额度太小或推理阶段过长导致；系统会自动加大 max_tokens 重试，若仍失败请换非推理模型或在模型侧关闭深度推理。';
  }
  if (/模型接口返回了网页 HTML|Unexpected token '<'|<!doctype|not valid JSON|Failed to parse JSON/i.test(msg)) {
    return '模型接口返回了网页 HTML，不是模型 JSON。Base URL 可以填根地址；Responses API 会自动尝试 /responses 和 /v1/responses，也可以在模型配置里自定义端点路径。';
  }
  if (/status 404|接口路径不可用/i.test(msg)) {
    return '模型接口路径不可用。请检查接口类型是 Responses API 还是 Chat Completions，或在模型配置里填写自定义端点路径。';
  }
  if (/status 401|unauthorized|invalid api key|鉴权/i.test(msg)) {
    return '模型鉴权失败。请检查 API Key、Token 或代理服务的鉴权配置。';
  }
  if (/模型请求失败|API request failed/i.test(msg)) {
    return `模型请求失败：${msg.replace(/\s+/g, ' ').slice(0, 240)}`;
  }
  return msg;
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

class LLMRequestError extends Error {
  status?: number;
  endpoint?: string;
  retryable: boolean;

  constructor(message: string, options: { status?: number; endpoint?: string; retryable?: boolean } = {}) {
    super(message);
    this.name = 'LLMRequestError';
    this.status = options.status;
    this.endpoint = options.endpoint;
    this.retryable = !!options.retryable;
  }
}

type ChatPayload = {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  max_tokens: number;
  stream?: boolean;
};

type ResponsesPayload = {
  model: string;
  input: Array<{ role: 'user' | 'assistant'; content: string }> | string;
  instructions?: string;
  temperature: number;
  max_output_tokens: number;
  stream?: boolean;
};

type ModelApiKind = 'responses' | 'chat_completions';

type EndpointCandidate = {
  endpoint: string;
  kind: ModelApiKind;
};

let endpointCacheKey = '';
let endpointCacheValue = '';
let endpointCacheKind: ModelApiKind | '' = '';

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function joinEndpointPath(baseUrl: string, endpointPath: string): string {
  const trimmed = endpointPath.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '');
  return `${normalizeBaseUrl(baseUrl)}/${trimmed.replace(/^\/+/, '')}`.replace(/\/+$/, '');
}

export function getResponsesEndpointCandidates(baseUrl: string, endpointPath?: string): string[] {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return [];
  if (endpointPath?.trim()) return [joinEndpointPath(normalized, endpointPath)];
  if (/\/responses$/i.test(normalized)) return [normalized];
  if (/\/v\d+$/i.test(normalized)) return [`${normalized}/responses`];
  return Array.from(new Set([
    `${normalized}/responses`,
    `${normalized}/v1/responses`,
  ]));
}

export function getChatCompletionEndpointCandidates(baseUrl: string, endpointPath?: string): string[] {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return [];
  if (endpointPath?.trim()) return [joinEndpointPath(normalized, endpointPath)];
  if (/\/chat\/completions$/i.test(normalized)) return [normalized];
  if (/\/v\d+$/i.test(normalized)) return [`${normalized}/chat/completions`];
  return Array.from(new Set([
    `${normalized}/chat/completions`,
    `${normalized}/v1/chat/completions`,
  ]));
}

function endpointMode(config: ModelConfig): ModelEndpointMode {
  return config.endpointMode ?? 'responses';
}

function endpointCandidates(config: ModelConfig): EndpointCandidate[] {
  const mode = endpointMode(config);
  if (mode === 'responses') {
    return getResponsesEndpointCandidates(config.baseUrl, config.endpointPath)
      .map((endpoint) => ({ endpoint, kind: 'responses' }));
  }
  if (mode === 'chat_completions') {
    return getChatCompletionEndpointCandidates(config.baseUrl, config.endpointPath)
      .map((endpoint) => ({ endpoint, kind: 'chat_completions' }));
  }
  if (config.endpointPath?.trim()) {
    const kind: ModelApiKind = /chat\/completions/i.test(config.endpointPath)
      ? 'chat_completions'
      : 'responses';
    return [{ endpoint: joinEndpointPath(config.baseUrl, config.endpointPath), kind }];
  }
  return [
    ...getResponsesEndpointCandidates(config.baseUrl).map((endpoint) => ({ endpoint, kind: 'responses' as const })),
    ...getChatCompletionEndpointCandidates(config.baseUrl).map((endpoint) => ({ endpoint, kind: 'chat_completions' as const })),
  ];
}

async function getLLMConfig(): Promise<ModelConfig> {
  const { config } = await readModelConfig();
  if (!config) {
    throw new LLMConfigurationError(new Error('Configuration file not found or invalid.'));
  }
  return config;
}

function getModelName(config: ModelConfig, options: ChatOptions): string {
  return options.model ?? config.model ?? config.chatId ?? 'gpt-5.4-mini';
}

function buildHeaders(config: ModelConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.apiKey}`,
    'X-Z-AI-From': 'Z',
    ...(config.chatId ? { 'X-Chat-Id': config.chatId } : {}),
    ...(config.userId ? { 'X-User-Id': config.userId } : {}),
    ...(config.token ? { 'X-Token': config.token } : {}),
  };
}

function buildPayload(
  config: ModelConfig,
  messages: ChatMessage[],
  options: ChatOptions,
  stream = false
): ChatPayload {
  return {
    model: getModelName(config, options),
    messages,
    temperature: options.temperature ?? (stream ? 0.85 : 0.8),
    max_tokens: options.maxTokens ?? (stream ? 4096 : 2048),
    ...(stream ? { stream: true } : {}),
  };
}

function buildResponsesPayload(
  config: ModelConfig,
  messages: ChatMessage[],
  options: ChatOptions,
  stream = false
): ResponsesPayload {
  const instructions = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join('\n\n');
  const input = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: message.content,
    }));

  return {
    model: getModelName(config, options),
    input: input.length > 0 ? input : '',
    ...(instructions ? { instructions } : {}),
    temperature: options.temperature ?? (stream ? 0.85 : 0.8),
    max_output_tokens: options.maxTokens ?? (stream ? 4096 : 2048),
    ...(stream ? { stream: true } : {}),
  };
}

function responseSnippet(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 240);
}

function isHtmlResponse(contentType: string, body?: string): boolean {
  return contentType.includes('text/html') || /^\s*<!doctype html/i.test(body ?? '') || /^\s*<html/i.test(body ?? '');
}

function canTryNextEndpoint(err: unknown): boolean {
  if (!(err instanceof LLMRequestError)) return false;
  if (err.status === 404 || err.status === 405) return true;
  return /网页 HTML|不是模型 JSON|不是聊天补全 JSON|不是聊天补全接口|不是 Responses API|接口路径不可用|返回格式不符合/i.test(err.message);
}

function cacheKey(config: ModelConfig): string {
  return `${normalizeBaseUrl(config.baseUrl)}|${config.endpointMode ?? 'responses'}|${config.endpointPath ?? ''}|${config.model ?? ''}|${config.chatId ?? ''}|${config.userId ?? ''}`;
}

function buildCandidatePayload(
  candidate: EndpointCandidate,
  config: ModelConfig,
  messages: ChatMessage[],
  options: ChatOptions,
  stream = false
): ChatPayload | ResponsesPayload {
  return candidate.kind === 'responses'
    ? buildResponsesPayload(config, messages, options, stream)
    : buildPayload(config, messages, options, stream);
}

async function openModelResponse(
  config: ModelConfig,
  messages: ChatMessage[],
  options: ChatOptions,
  stream = false
): Promise<{ response: Response; kind: ModelApiKind }> {
  const key = cacheKey(config);
  const candidates = endpointCandidates(config);
  const endpoints = endpointCacheKey === key && endpointCacheValue && endpointCacheKind
    ? [
        { endpoint: endpointCacheValue, kind: endpointCacheKind },
        ...candidates.filter((item) => item.endpoint !== endpointCacheValue),
      ]
    : candidates;

  if (endpoints.length === 0) {
    throw new LLMConfigurationError(new Error('baseUrl is empty.'));
  }

  let lastErr: unknown = null;
  for (const candidate of endpoints) {
    try {
      const res = await fetch(candidate.endpoint, {
        method: 'POST',
        headers: buildHeaders(config),
        body: JSON.stringify(buildCandidatePayload(candidate, config, messages, options, stream)),
      });
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const retryable = res.status === 429 || res.status >= 500;
        if (isHtmlResponse(contentType, body)) {
          throw new LLMRequestError('模型接口返回了网页 HTML，不是聊天补全 JSON。', {
            status: res.status,
            endpoint: candidate.endpoint,
            retryable,
          });
        }
        throw new LLMRequestError(
          `模型请求失败，status ${res.status}：${responseSnippet(body) || res.statusText}`,
          { status: res.status, endpoint: candidate.endpoint, retryable }
        );
      }

      if (isHtmlResponse(contentType)) {
        const body = await res.text().catch(() => '');
        throw new LLMRequestError('模型接口返回了网页 HTML，不是模型 JSON。', {
          status: res.status,
          endpoint: candidate.endpoint,
        });
      }

      endpointCacheKey = key;
      endpointCacheValue = candidate.endpoint;
      endpointCacheKind = candidate.kind;
      return { response: res, kind: candidate.kind };
    } catch (err) {
      lastErr = err;
      if (!canTryNextEndpoint(err)) throw err;
    }
  }

  throw lastErr ?? new Error('模型接口路径不可用。');
}

function contentToString(value: any): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      if (typeof part?.content === 'string') return part.content;
      if (typeof part?.delta === 'string') return part.delta;
      return '';
    })
    .join('');
}

function extractChoiceContent(response: any): string {
  const chunks: string[] = [];
  for (const choice of response?.choices ?? []) {
    const content =
      contentToString(choice?.message?.content) ||
      contentToString(choice?.delta?.content) ||
      contentToString(choice?.text);
    if (content) chunks.push(content);
  }
  return chunks.join('');
}

function extractChoiceReasoningContent(response: any): string {
  const chunks: string[] = [];
  for (const choice of response?.choices ?? []) {
    const content =
      contentToString(choice?.message?.reasoning_content) ||
      contentToString(choice?.delta?.reasoning_content);
    if (content) chunks.push(content);
  }
  return chunks.join('');
}

function createReasoningOnlyError(rawOrReasoning: string): LLMRequestError {
  return new LLMRequestError(
    `模型只返回了推理内容，没有返回最终正文 content：${responseSnippet(rawOrReasoning)}`,
    { retryable: true }
  );
}

function extractResponsesContent(response: any): string {
  if (typeof response?.output_text === 'string') return response.output_text;
  const chunks: string[] = [];
  for (const item of response?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (typeof content?.text === 'string') chunks.push(content.text);
      if (typeof content?.delta === 'string') chunks.push(content.delta);
    }
  }
  return chunks.join('');
}

function extractModelContent(response: any, kind: ModelApiKind): string {
  if (kind === 'responses') return extractResponsesContent(response) || extractChoiceContent(response);
  return extractChoiceContent(response) || extractResponsesContent(response);
}

async function createModelCompletion(
  config: ModelConfig,
  messages: ChatMessage[],
  options: ChatOptions
): Promise<{ parsed: any; kind: ModelApiKind }> {
  const key = cacheKey(config);
  const candidates = endpointCandidates(config);
  const endpoints = endpointCacheKey === key && endpointCacheValue && endpointCacheKind
    ? [
        { endpoint: endpointCacheValue, kind: endpointCacheKind },
        ...candidates.filter((item) => item.endpoint !== endpointCacheValue),
      ]
    : candidates;

  let lastErr: unknown = null;
  for (const candidate of endpoints) {
    try {
      const res = await fetch(candidate.endpoint, {
        method: 'POST',
        headers: buildHeaders(config),
        body: JSON.stringify(buildCandidatePayload(candidate, config, messages, options)),
      });
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      const raw = await res.text();

      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        if (isHtmlResponse(contentType, raw)) {
          throw new LLMRequestError('模型接口返回了网页 HTML，不是聊天补全 JSON。', {
            status: res.status,
            endpoint: candidate.endpoint,
            retryable,
          });
        }
        throw new LLMRequestError(
          `模型请求失败，status ${res.status}：${responseSnippet(raw) || res.statusText}`,
          { status: res.status, endpoint: candidate.endpoint, retryable }
        );
      }

      if (isHtmlResponse(contentType, raw)) {
        throw new LLMRequestError('模型接口返回了网页 HTML，不是模型 JSON。', {
          status: res.status,
          endpoint: candidate.endpoint,
        });
      }

      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new LLMRequestError(
          `模型接口返回的不是模型 JSON：${responseSnippet(raw)}`,
          { status: res.status, endpoint: candidate.endpoint }
        );
      }
      const content = extractModelContent(parsed, candidate.kind);
      if (!content.trim()) {
        const reasoning = extractChoiceReasoningContent(parsed);
        if (reasoning.trim()) {
          throw createReasoningOnlyError(reasoning);
        }
        throw new LLMRequestError(`模型接口返回格式不符合 ${candidate.kind === 'responses' ? 'Responses API' : '聊天补全'} 协议：${responseSnippet(raw)}`);
      }
      endpointCacheKey = key;
      endpointCacheValue = candidate.endpoint;
      endpointCacheKind = candidate.kind;
      return { parsed, kind: candidate.kind };
    } catch (err) {
      lastErr = err;
      if (!canTryNextEndpoint(err)) throw err;
    }
  }

  throw lastErr ?? new Error('模型接口路径不可用。');
}

export async function ensureLLMReady(): Promise<void> {
  try {
    const content = await chat(
      [
        { role: 'system', content: '你只做连通性检查。不要解释，不要输出 Markdown，最终回答只输出 OK。' },
        { role: 'user', content: '只输出 OK。' },
      ],
      { temperature: 0, maxTokens: 256 }
    );
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('模型接口返回格式不符合聊天补全协议。');
    }
  } catch (err) {
    throw new Error(toLLMUserMessage(err));
  }
}

/** 判断错误是否可重试（429 限流 / 5xx 服务器错误 / 网络错误） */
function isRetryable(err: any): boolean {
  if (err instanceof LLMRequestError && err.retryable) return true;
  const msg = String(err?.message ?? '');
  if (/429|Too many requests|rate limit/i.test(msg)) return true;
  if (/5\d{2}|server error|internal error/i.test(msg)) return true;
  if (/fetch|network|ECONN|ETIMEDOUT/i.test(msg)) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isReasoningOnlyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /只返回了推理内容|没有返回最终正文|reasoning_content/i.test(msg);
}

function expandMaxTokensForReasoning(options: ChatOptions): ChatOptions | null {
  const current = options.maxTokens ?? 2048;
  const next = Math.min(Math.max(current * 2, current + 1024, 1024), 16000);
  if (next <= current) return null;
  return { ...options, maxTokens: next };
}

/** 非流式 chat 调用，返回完整文本。带 429/5xx 重试。 */
export async function chat(
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<string> {
  const config = await getLLMConfig();
  let lastErr: any = null;
  let requestOptions = options;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const { parsed, kind } = await createModelCompletion(config, messages, requestOptions);
      return extractModelContent(parsed, kind);
    } catch (err: any) {
      lastErr = err;
      if (isReasoningOnlyError(err) && attempt < MAX_RETRIES - 1) {
        const expanded = expandMaxTokensForReasoning(requestOptions);
        if (expanded) {
          requestOptions = expanded;
          console.warn(`[LLM] 推理模型未返回最终 content，提升 max_tokens 到 ${requestOptions.maxTokens} 后重试。`);
          await sleep(300);
          continue;
        }
      }
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
  const config = await getLLMConfig();
  let lastErr: any = null;
  let requestOptions = options;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const { response, kind } = await openModelResponse(config, messages, requestOptions, true);
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();

      if (contentType.includes('application/json')) {
        const raw = await response.text();
        const parsed = JSON.parse(raw);
        const content = extractModelContent(parsed, kind);
        if (content) onChunk(content);
        if (!content.trim()) {
          const reasoning = extractChoiceReasoningContent(parsed);
          if (reasoning.trim()) throw createReasoningOnlyError(reasoning);
        }
        return content;
      }

      const stream = response.body;
      if (!stream) {
        throw new LLMRequestError('模型流式响应为空。');
      }

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let full = '';
      let reasoningOnly = '';

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
              const reasoningDelta =
                contentToString(json?.choices?.[0]?.delta?.reasoning_content) ||
                contentToString(json?.choices?.[0]?.message?.reasoning_content) ||
                contentToString(json?.reasoning_content);
              if (reasoningDelta) reasoningOnly += reasoningDelta;
              const delta =
                json?.type === 'response.output_text.delta'
                  ? contentToString(json.delta)
                  : contentToString(json?.delta) ||
                    contentToString(json?.choices?.[0]?.delta?.content) ||
                    contentToString(json?.choices?.[0]?.message?.content) ||
                    '';
              if (delta) {
                full += delta;
                onChunk(delta);
              }
              if (!delta && json?.type === 'response.completed') {
                const content = extractResponsesContent(json.response);
                if (content && !full) {
                  full += content;
                  onChunk(content);
                }
              }
            } catch {
              // ignore parse errors (partial chunks)
            }
          }
        }
      }
      if (!full.trim() && reasoningOnly.trim()) {
        throw createReasoningOnlyError(reasoningOnly);
      }
      return full;
    } catch (err: any) {
      lastErr = err;
      if (isReasoningOnlyError(err) && attempt < MAX_RETRIES - 1) {
        const expanded = expandMaxTokensForReasoning(requestOptions);
        if (expanded) {
          requestOptions = expanded;
          console.warn(`[LLM Stream] 推理模型未返回最终 content，提升 max_tokens 到 ${requestOptions.maxTokens} 后重试。`);
          await sleep(300);
          continue;
        }
      }
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
