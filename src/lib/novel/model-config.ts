import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model?: string;
  endpointMode?: ModelEndpointMode;
  endpointPath?: string;
  chatId?: string;
  userId?: string;
  token?: string;
}

export type ModelEndpointMode = 'responses' | 'chat_completions' | 'auto';

export interface ModelConfigStatus {
  configured: boolean;
  source: string | null;
  baseUrl: string;
  model: string;
  endpointMode: ModelEndpointMode;
  endpointPath: string;
  hasApiKey: boolean;
  chatId: string;
  userId: string;
  hasToken: boolean;
  checkedPaths: string[];
  error?: string;
}

const CONFIG_FILE = '.z-ai-config';

function unique(items: string[]): string[] {
  return Array.from(new Set(items));
}

function normalizeEndpointMode(value: unknown): ModelEndpointMode {
  if (value === 'chat_completions' || value === 'auto' || value === 'responses') {
    return value;
  }
  return 'responses';
}

export function getModelConfigReadPaths(): string[] {
  const cwd = process.cwd();
  return unique([
    path.join(cwd, CONFIG_FILE),
    path.join(cwd, 'mini-services/novel-engine', CONFIG_FILE),
    path.join(os.homedir(), CONFIG_FILE),
    '/etc/.z-ai-config',
  ]);
}

export function getModelConfigWritePaths(): string[] {
  const cwd = process.cwd();
  return unique([
    path.join(cwd, CONFIG_FILE),
    path.join(cwd, 'mini-services/novel-engine', CONFIG_FILE),
  ]);
}

async function readConfigFile(filePath: string): Promise<ModelConfig | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ModelConfig>;
    if (!parsed.baseUrl || !parsed.apiKey) return null;
    return {
      baseUrl: String(parsed.baseUrl).trim(),
      apiKey: String(parsed.apiKey).trim(),
      model: parsed.model ? String(parsed.model).trim() : undefined,
      endpointMode: normalizeEndpointMode(parsed.endpointMode),
      endpointPath: parsed.endpointPath ? String(parsed.endpointPath).trim() : undefined,
      chatId: parsed.chatId ? String(parsed.chatId).trim() : undefined,
      userId: parsed.userId ? String(parsed.userId).trim() : undefined,
      token: parsed.token ? String(parsed.token).trim() : undefined,
    };
  } catch {
    return null;
  }
}

export async function readModelConfig(): Promise<{ config: ModelConfig | null; source: string | null }> {
  for (const filePath of getModelConfigReadPaths()) {
    const config = await readConfigFile(filePath);
    if (config) return { config, source: filePath };
  }
  return { config: null, source: null };
}

export async function getModelConfigStatus(): Promise<ModelConfigStatus> {
  const { config, source } = await readModelConfig();
  return {
    configured: !!config,
    source,
    baseUrl: config?.baseUrl ?? '',
    model: config?.model ?? '',
    endpointMode: config?.endpointMode ?? 'responses',
    endpointPath: config?.endpointPath ?? '',
    hasApiKey: !!config?.apiKey,
    chatId: config?.chatId ?? '',
    userId: config?.userId ?? '',
    hasToken: !!config?.token,
    checkedPaths: getModelConfigReadPaths(),
    error: config ? undefined : '未找到有效 .z-ai-config',
  };
}

export async function getConfiguredModel(): Promise<string | undefined> {
  const { config } = await readModelConfig();
  return config?.model || undefined;
}

export async function saveModelConfig(input: Partial<ModelConfig>): Promise<ModelConfigStatus> {
  const { config: existing } = await readModelConfig();
  const apiKey = String(input.apiKey ?? '').trim() || existing?.apiKey || '';
  const model = String(input.model ?? existing?.model ?? '').trim();
  const endpointMode = normalizeEndpointMode(input.endpointMode ?? existing?.endpointMode ?? 'responses');
  const endpointPath = input.endpointPath === undefined
    ? String(existing?.endpointPath ?? '').trim()
    : String(input.endpointPath ?? '').trim();
  const chatId = String(input.chatId ?? '').trim();
  const userId = String(input.userId ?? '').trim();
  const token = String(input.token ?? '').trim() || existing?.token || '';
  const baseUrl = String(input.baseUrl ?? existing?.baseUrl ?? '').trim().replace(/\/+$/, '');

  if (!baseUrl) {
    throw new Error('baseUrl 不能为空，例如 https://api.openai.com 或 https://ai-pixel.online');
  }
  if (!apiKey) {
    throw new Error('apiKey 不能为空；如果已有 key，保存时可以留空沿用。');
  }

  const next: ModelConfig = {
    baseUrl,
    apiKey,
    ...(model ? { model } : {}),
    endpointMode,
    ...(endpointPath ? { endpointPath } : {}),
    ...(chatId ? { chatId } : {}),
    ...(userId ? { userId } : {}),
    ...(token ? { token } : {}),
  };

  const body = `${JSON.stringify(next, null, 2)}\n`;
  for (const filePath of getModelConfigWritePaths()) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, body, 'utf8');
    await fs.chmod(filePath, 0o600).catch(() => {});
  }

  return getModelConfigStatus();
}
