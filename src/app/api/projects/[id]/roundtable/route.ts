/**
 * POST /api/projects/[id]/roundtable
 * 设计讨论：用户抛出议题，剧情设计师 / Director / 设定审核分别给意见。
 */

import { NextRequest, NextResponse } from 'next/server';
import { chat, extractJSON, toLLMUserMessage, type ChatMessage } from '@/lib/novel/llm';
import { ensureChapterFocus } from '@/lib/novel/chapter-focus';
import { formatChapterWordTarget } from '@/lib/novel/chapter-policy';
import { countReadableChars } from '@/lib/novel/chapter-text';
import { normalizeChapterTitle } from '@/lib/novel/chapter-title';
import { storyBibleText } from '@/lib/novel/story-bible';
import { WorldManager } from '@/lib/novel/world-state';
import { db } from '@/lib/db';
import { pickCanonicalDraft } from '@/lib/novel/canonical-chapter';
import {
  formatEventTraceItem,
  filterEventTraceEvents,
  selectEventTraceCharacters,
} from '@/lib/novel/event-trace';
import type {
  ChapterFocus,
  Character,
  NovelEvent,
  RoundtableContextSelection,
  RoundtableDiscussionMode,
} from '@/lib/novel/types';

interface RoundtableDraft {
  designerOpinion?: string;
  directorOpinion?: string;
  auditorOpinion?: string;
  synthesis?: string;
  directorInstruction?: string;
  outlineRevisionRequest?: string;
  risks?: string[];
  continuityAudit?: string[];
  mustFix?: string[];
}

interface RoundtableEntryPayload {
  id: string;
  topic: string;
  chapterNo?: number;
  chapterTitle?: string;
  contextChapterNos?: number[];
  discussionMode?: RoundtableDiscussionMode;
  reviewConfirmed?: boolean;
  designerOpinion?: string;
  directorOpinion: string;
  writerOpinion?: string;
  auditorOpinion: string;
  synthesis: string;
  directorInstruction: string;
  outlineRevisionRequest?: string;
  risks: string[];
  continuityAudit?: string[];
  mustFix?: string[];
  createdAt: string;
}

interface RoundtableRow {
  id: string;
  payload: string;
  createdAt: string | Date;
}

const DEFAULT_CONTEXT_SELECTION: RoundtableContextSelection = {
  includeStoryBible: true,
  includeCurrentChapter: true,
  includeDirectorDesign: true,
  includeCurrentDraft: true,
  includeCurrentEvents: true,
  includeCharacters: true,
  includeAssets: true,
  includeEventTrace: true,
  selectedChapterNos: [],
};

let roundtableTableReady: Promise<void> | null = null;

function ensureRoundtableTable(): Promise<void> {
  if (roundtableTableReady) return roundtableTableReady;
  roundtableTableReady = (async () => {
    await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "RoundtableEntry" (
      "id" TEXT PRIMARY KEY,
      "projectId" TEXT NOT NULL,
      "topic" TEXT NOT NULL,
      "payload" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE
    )
  `);
    await db.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "RoundtableEntry_projectId_createdAt_idx"
    ON "RoundtableEntry" ("projectId", "createdAt")
  `);
  })().catch((error) => {
    roundtableTableReady = null;
    throw error;
  });
  return roundtableTableReady;
}

function parseRoundtableEntry(row: RoundtableRow): RoundtableEntryPayload | null {
  try {
    const parsed = JSON.parse(row.payload) as RoundtableEntryPayload;
    return {
      ...parsed,
      id: parsed.id || row.id,
      createdAt: parsed.createdAt || new Date(row.createdAt).toISOString(),
    };
  } catch {
    return null;
  }
}

function normalizeImportedRoundtableEntry(value: unknown): RoundtableEntryPayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Partial<RoundtableEntryPayload>;
  const topic = String(row.topic ?? '').trim();
  if (!topic) return null;
  const createdAt = row.createdAt ? String(row.createdAt) : new Date().toISOString();
  return {
    id: String(row.id || `roundtable-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    topic,
    chapterNo: Number.isFinite(Number(row.chapterNo)) && Number(row.chapterNo) > 0 ? Math.floor(Number(row.chapterNo)) : undefined,
    chapterTitle: row.chapterTitle ? String(row.chapterTitle) : undefined,
    contextChapterNos: toNumberArray(row.contextChapterNos, 10),
    discussionMode: normalizeDiscussionMode(row.discussionMode, 'proposal'),
    reviewConfirmed: Boolean(row.reviewConfirmed),
    designerOpinion: row.designerOpinion ? String(row.designerOpinion) : undefined,
    directorOpinion: String(row.directorOpinion ?? ''),
    writerOpinion: row.writerOpinion ? String(row.writerOpinion) : undefined,
    auditorOpinion: String(row.auditorOpinion ?? ''),
    synthesis: String(row.synthesis ?? ''),
    directorInstruction: String(row.directorInstruction ?? ''),
    outlineRevisionRequest: row.outlineRevisionRequest ? String(row.outlineRevisionRequest) : undefined,
    risks: Array.isArray(row.risks) ? row.risks.map(String).slice(0, 8) : [],
    continuityAudit: Array.isArray(row.continuityAudit) ? row.continuityAudit.map(String).slice(0, 8) : undefined,
    mustFix: Array.isArray(row.mustFix) ? row.mustFix.map(String).slice(0, 8) : undefined,
    createdAt,
  };
}

async function listRoundtableEntries(projectId: string, limit = 50): Promise<RoundtableEntryPayload[]> {
  await ensureRoundtableTable();
  const rows = await db.$queryRawUnsafe<RoundtableRow[]>(
    `SELECT "id", "payload", "createdAt"
       FROM "RoundtableEntry"
      WHERE "projectId" = ?
      ORDER BY "createdAt" DESC
      LIMIT ?`,
    projectId,
    limit
  );
  return rows.map(parseRoundtableEntry).filter((entry): entry is RoundtableEntryPayload => Boolean(entry));
}

async function getRoundtableEntry(projectId: string, entryId: string): Promise<RoundtableEntryPayload | null> {
  await ensureRoundtableTable();
  const rows = await db.$queryRawUnsafe<RoundtableRow[]>(
    `SELECT "id", "payload", "createdAt"
       FROM "RoundtableEntry"
      WHERE "projectId" = ? AND "id" = ?
      LIMIT 1`,
    projectId,
    entryId
  );
  return rows.map(parseRoundtableEntry).find(Boolean) ?? null;
}

async function saveRoundtableEntry(projectId: string, entry: RoundtableEntryPayload) {
  await ensureRoundtableTable();
  await db.$executeRawUnsafe(
    `INSERT OR REPLACE INTO "RoundtableEntry" ("id", "projectId", "topic", "payload", "createdAt")
     VALUES (?, ?, ?, ?, ?)`,
    entry.id,
    projectId,
    entry.topic,
    JSON.stringify(entry),
    entry.createdAt
  );
  await db.project.update({
    where: { id: projectId },
    data: { updatedAt: new Date() },
  }).catch(() => {});
}

function clip(text: string, max = 1600): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[截断 ${text.length - max} 字]`;
}

function chapterWordCount(chapter: { content: string }): number {
  return countReadableChars(chapter.content);
}

function chapterTitleForContext(
  chapterNo: number | null | undefined,
  fallbackTitle: string | null | undefined,
  currentChapter?: ChapterFocus
): string {
  const no = chapterNo ?? currentChapter?.chapterNo ?? 1;
  const currentTitle = currentChapter?.chapterNo === no ? normalizeChapterTitle(currentChapter.title, no) : '';
  return currentTitle || normalizeChapterTitle(fallbackTitle, no) || `第 ${no} 章`;
}

function historyDraftLabel(totalDrafts: number, draftIndex: number): string {
  return `历史稿 ${Math.max(1, totalDrafts - draftIndex)}`;
}

function formatHistoricalDraft(input: {
  label: string;
  chapterRow: {
    chapterNo: number | null;
    chapterTitle: string | null;
    sceneName: string;
    content: string;
    startTurn?: number | null;
    endTurn?: number | null;
  };
  currentChapter?: ChapterFocus;
}): string {
  const { label, chapterRow, currentChapter } = input;
  const turnRange =
    typeof chapterRow.startTurn === 'number' || typeof chapterRow.endTurn === 'number'
      ? `；Turn ${chapterRow.startTurn ?? '?'}-${chapterRow.endTurn ?? '?'}`
      : '';
  return `## ${label}
标题：第 ${chapterRow.chapterNo ?? currentChapter?.chapterNo ?? '?'} 章《${chapterTitleForContext(chapterRow.chapterNo, chapterRow.chapterTitle ?? chapterRow.sceneName, currentChapter)}》
字数：${chapterWordCount(chapterRow)}${turnRange}
说明：这是旧版本正文。可以借鉴更好的开场、节奏、段落和桥段；但它不会自动成为当前事实，采纳后必须重写进当前稿。
正文片段：
${clip(chapterRow.content, 3200)}`;
}

function toStringArray(value: unknown, limit = 5): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, limit)
    : [];
}

function toNumberArray(value: unknown, limit = 8): number[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const result: number[] = [];
  for (const item of value) {
    const number = Number(item);
    if (!Number.isInteger(number) || number <= 0 || seen.has(number)) continue;
    seen.add(number);
    result.push(number);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeDiscussionMode(
  value: unknown,
  fallback: RoundtableDiscussionMode = 'internal_review'
): RoundtableDiscussionMode {
  if (value === 'proposal' || value === 'internal_review') return value;
  return fallback;
}

function nearbyRoundtableChapterNos(chapterNo: number): number[] {
  if (!Number.isInteger(chapterNo) || chapterNo <= 0) return [];
  const start = Math.max(1, chapterNo - 2);
  return Array.from({ length: chapterNo - start + 1 }, (_, index) => start + index);
}

function normalizeContextSelection(
  value: unknown,
  currentChapterNo: number
): RoundtableContextSelection {
  const source =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Partial<RoundtableContextSelection>
      : {};
  const selectedChapterNos = toNumberArray(source.selectedChapterNos, 10);
  if (selectedChapterNos.length === 0 && currentChapterNo > 0) {
    selectedChapterNos.push(...nearbyRoundtableChapterNos(currentChapterNo));
  }
  return {
    includeStoryBible: source.includeStoryBible ?? DEFAULT_CONTEXT_SELECTION.includeStoryBible,
    includeCurrentChapter: source.includeCurrentChapter ?? DEFAULT_CONTEXT_SELECTION.includeCurrentChapter,
    includeDirectorDesign: source.includeDirectorDesign ?? DEFAULT_CONTEXT_SELECTION.includeDirectorDesign,
    includeCurrentDraft: source.includeCurrentDraft ?? DEFAULT_CONTEXT_SELECTION.includeCurrentDraft,
    includeCurrentEvents: source.includeCurrentEvents ?? DEFAULT_CONTEXT_SELECTION.includeCurrentEvents,
    includeCharacters: source.includeCharacters ?? DEFAULT_CONTEXT_SELECTION.includeCharacters,
    includeAssets: source.includeAssets ?? DEFAULT_CONTEXT_SELECTION.includeAssets,
    includeEventTrace: source.includeEventTrace ?? DEFAULT_CONTEXT_SELECTION.includeEventTrace,
    selectedChapterNos,
  };
}

function uniqueStrings(items: string[], limit = 8): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= limit) break;
  }
  return result;
}

function looksIncompleteSummary(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return /并把|并在|并将|后把|然后把|即可将.+并把$|，并把$|，并在$|，然后$/.test(trimmed);
}

function rawSnippet(text: string, limit = 240): string {
  return text.replace(/\s+/g, ' ').slice(0, limit);
}

async function parseRoundtableDraftWithRepair(
  messages: ChatMessage[],
  raw: string
): Promise<RoundtableDraft | null> {
  let parsed = extractJSON<RoundtableDraft>(raw);
  if (parsed) return parsed;

  console.warn(`[roundtable] 初次解析失败，准备重排 JSON：${rawSnippet(raw)}`);

  const repairPrompt = `你上一条回复没有形成可解析 JSON。不要解释，不要 Markdown，不要补充前后说明，只输出一个 JSON 对象。

字段要求：
{
  "designerOpinion": "剧情设计师意见",
  "directorOpinion": "Director 意见",
  "auditorOpinion": "设定审核意见",
  "synthesis": "折中方案",
  "directorInstruction": "如果用户采纳，发给 Director 的执行指令",
  "outlineRevisionRequest": "需要改总纲/本章方向时填写，否则空字符串",
  "risks": ["风险1"],
  "continuityAudit": ["连续性问题1"],
  "mustFix": ["必须先修1"]
}

要求：
1. 所有字段都必须存在。
2. risks / continuityAudit / mustFix 必须是数组，没有内容时返回 []。
3. 只输出 JSON 本体。`;

  const repairedRaw = await chat(
    [
      ...messages,
      { role: 'assistant', content: raw || '（上一条为空）' },
      { role: 'user', content: repairPrompt },
    ],
    { temperature: 0.2, maxTokens: 2600 }
  );
  parsed = extractJSON<RoundtableDraft>(repairedRaw);
  if (parsed) return parsed;

  console.warn(`[roundtable] 重排 JSON 仍失败，准备低温重试：${rawSnippet(repairedRaw)}`);

  const retryRaw = await chat(messages, { temperature: 0.2, maxTokens: 2600 });
  return extractJSON<RoundtableDraft>(retryRaw);
}

function includesAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function detectUserContinuityFlags(
  topic: string,
  currentDraftText: string | null | undefined,
  characters: any[]
): { continuityAudit: string[]; mustFix: string[]; risks: string[] } {
  const lowerTopic = topic.toLowerCase();
  const text = currentDraftText ?? '';
  const continuityTopic =
    includesAny(topic, ['突然', '转眼', '上一秒', '下一秒', '突兀', '衔接', '位置', '操场', '拉着', '带着', '走', '怎么', '为啥']) ||
    lowerTopic.includes('baiyan');

  if (!continuityTopic) {
    return { continuityAudit: [], mustFix: [], risks: [] };
  }

  const matchedCharacter =
    characters.find((character) => topic.includes(character.name))?.name ??
    (lowerTopic.includes('baiyan') ? '白晏' : '用户点名角色');
  const actionSignals = ['操场', '觉醒', '列队', '围观', '拉着', '带着', '离开', '走']
    .filter((keyword) => topic.includes(keyword) || text.includes(keyword));

  return {
    continuityAudit: [
      `用户点名了连续性问题：${matchedCharacter} 的位置、状态和动作链必须按当前正稿核对，不能用旧事件日志或推测解释过去。${actionSignals.length ? `相关信号：${actionSignals.join('、')}。` : ''}`,
    ],
    mustFix: [
      `如果当前正稿存在“${matchedCharacter}仍在操场/觉醒/被围观”后立刻“拉人离开/带人走”的跳变，必须先补过渡、改动作或删去后一句，不能继续推进下一拍。`,
    ],
    risks: [
      '用户已经指出空间/动作连续性断裂；若圆桌只给创作方向、不承认文本问题，会导致导演继续沿错误状态推演。',
    ],
  };
}

function detectOutlineChangeRequest(topic: string, chapter?: ChapterFocus): string {
  const compactTopic = topic.replace(/\s+/g, '');
  const currentChapterNo = chapter?.chapterNo ?? 1;
  const chapterSignals = [
    `第${currentChapterNo}章`,
    `第${currentChapterNo}章节`,
    `第 ${currentChapterNo} 章`,
    '本章',
    '当前章',
    '第三章',
    '第3章',
    '第 3 章',
  ];
  const outlineSignals = [
    '章节名',
    '章名',
    '标题',
    '改名',
    '重命名',
    '细纲',
    '大纲',
    '总纲',
    '剧情走向',
    '走向',
    '重写',
    '改写',
    '重新改写',
    '调整剧情',
    '调整章节',
    '章节目标',
    '本章目标',
    '节拍',
    '剧情节点',
  ];
  const wantsOutline =
    includesAny(topic, outlineSignals) ||
    includesAny(compactTopic, outlineSignals) ||
    (includesAny(topic, chapterSignals) && includesAny(topic, ['改', '调', '重写', '改写', '换', '不理解']));

  if (!wantsOutline) return '';

  return [
    `请把这次导演设计讨论转成第 ${currentChapterNo} 章的可应用“本章方向”修改。`,
    `用户原话：${topic}`,
    '',
    '必须处理：章节名、当前章目标、范围、设定护栏、剧情走向。',
    '不要强制写死每一步细纲；除非用户明确要求固定节拍，否则只给方向、边界、冲突压力和不可违背的禁区，让角色演绎自行生长。',
    '如果用户指定了具体章节号，以用户指定章节为准；如果当前焦点不是该章，需要在 risks 中说明并避免误改其他章节。',
    '应用后必须清空旧导演设计，重新生成本章导演设计，不要继续沿旧方向推进。',
  ].join('\n');
}

function characterLine(character: any): string {
  const persona = character.persona ?? {};
  const state = character.currentState ?? {};
  const gender = persona.gender ? `性别=${persona.gender}；` : '性别=未记录；';
  const location = state.location ? `位置=${state.location}；` : '';
  const emotion = state.emotion ? `情绪=${state.emotion}；` : '';
  const talents = persona.talents?.length ? `天赋=${persona.talents.join('、')}；` : '';
  const skills = persona.skills?.length ? `技能=${persona.skills.join('、')}；` : '';
  return `- ${character.name}（${character.role}）：${gender}${location}${emotion}${talents}${skills}立场=${persona.stance ?? '-'}；性格=${(persona.personality ?? []).join('、') || '-'}；背景=${persona.background ?? '-'}`;
}

function characterFactLine(character: any): string {
  const persona = character.persona ?? {};
  const gender = persona.gender ? `性别=${persona.gender}；` : '性别=未记录；';
  const stance = persona.stance ? `立场=${persona.stance}；` : '';
  const personality = Array.isArray(persona.personality) && persona.personality.length
    ? `性格=${persona.personality.join('、')}；`
    : '';
  const background = persona.background ? `背景=${persona.background}` : '背景=-';
  return `- ${character.name}（${character.role}）：${gender}${stance}${personality}${background}`;
}

function buildEventTraceDocument(input: {
  selectedChapterNos: number[];
  chapters: any[];
  currentChapter?: ChapterFocus;
  currentChapterEvents: NovelEvent[];
  allEvents: NovelEvent[];
  characters: Character[];
  presentCharacterIds?: string[];
  eventClosureStatus?: Record<string, 'open' | 'closed'>;
}): string {
  const {
    selectedChapterNos,
    chapters,
    currentChapter,
    currentChapterEvents,
    allEvents,
    characters,
    presentCharacterIds = [],
    eventClosureStatus = {},
  } = input;
  const chapterSet = new Set(selectedChapterNos);
  const trackedCharacters = selectEventTraceCharacters(characters, presentCharacterIds);
  const grouped = new Map<number, any[]>();
  for (const chapter of chapters) {
    const no = chapter.chapterNo ?? currentChapter?.chapterNo;
    if (!Number.isInteger(no) || !chapterSet.has(no)) continue;
    const list = grouped.get(no) ?? [];
    list.push(chapter);
    grouped.set(no, list);
  }

  const sections: string[] = [];
  for (const chapterNo of selectedChapterNos) {
    const drafts = [...(grouped.get(chapterNo) ?? [])].sort((a, b) =>
      new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()
    );
    const canonical = drafts[0] ?? null;
    const isCurrent = currentChapter?.chapterNo === chapterNo;
    const startTurn = canonical?.startTurn ?? (isCurrent ? currentChapter?.startTurn ?? 0 : null);
    const endTurn = canonical?.endTurn ?? (isCurrent ? undefined : null);
    const events = filterEventTraceEvents((isCurrent
      ? currentChapterEvents
      : allEvents.filter((event) =>
          typeof startTurn === 'number' && typeof endTurn === 'number'
            ? event.turn > startTurn && event.turn <= endTurn
            : false
        )),
      trackedCharacters,
      eventClosureStatus
    );
    const title = chapterTitleForContext(
      chapterNo,
      canonical?.chapterTitle ?? canonical?.sceneName,
      isCurrent ? currentChapter : undefined
    );
    const createdAt = canonical?.createdAt ? new Date(canonical.createdAt).toLocaleString('zh-CN') : '未落正文';
    const turnRange =
      typeof startTurn === 'number' || typeof endTurn === 'number'
        ? `T${startTurn ?? '?'}-${endTurn ?? (isCurrent ? '当前' : '?')}`
        : 'Turn 未记录';
    sections.push([
      `## 第 ${chapterNo} 章《${title}》`,
      `正文状态：${canonical ? `已有正稿/最新稿，${chapterWordCount(canonical)} 字` : '未落正文'}`,
      `正文生成时间：${createdAt}`,
      `事件范围：${turnRange}`,
      `活跃追踪项数量：${events.length}`,
      '活跃追踪项（伏笔 / 持续状态 / 未兑现后果）：',
      events.length
        ? events.slice(-10).map((event) => `- [开启中] ${formatEventTraceItem(event)}`).join('\n')
        : '- 无活跃追踪项',
      canonical?.content
        ? `正稿摘要片段：${clip(canonical.content.replace(/\s+/g, ' '), 500)}`
        : '',
    ].filter(Boolean).join('\n'));
  }

  if (sections.length === 0) return '- 未选择可追踪章节';
  return [
    '这是一份“剧情追踪文档”：只追踪会跨章节影响剧情的活跃项，包括伏笔线索、持续状态（如中毒/诅咒/伤势/标记）、未兑现奖励或承诺、重要关系后果。普通动作、临时位置、情绪、面板数值和已结束记录不进入；若持续状态结束，需要在后续事件或设计讨论里写明结束原因。它用于防止编导盲猜前文；若与当前正稿冲突，以当前正稿和用户本次指令为准。',
    '',
    ...sections,
  ].join('\n\n');
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const entries = await listRoundtableEntries(id);
  return NextResponse.json({ entries });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const imported = Array.isArray(body.entries)
    ? body.entries.map(normalizeImportedRoundtableEntry).filter((entry): entry is RoundtableEntryPayload => Boolean(entry)).slice(0, 50)
    : [];
  if (imported.length) {
    for (const entry of imported) {
      await saveRoundtableEntry(id, entry);
    }
  } else {
    await ensureRoundtableTable();
  }
  const entries = await listRoundtableEntries(id);
  return NextResponse.json({ entries, imported: imported.length });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const entryId = String(body.entryId ?? '').trim();
  if (!entryId) {
    return NextResponse.json({ error: '缺少讨论记录 ID' }, { status: 400 });
  }

  const existing = await getRoundtableEntry(id, entryId);
  if (!existing) {
    return NextResponse.json({ error: '讨论记录不存在' }, { status: 404 });
  }

  const entry: RoundtableEntryPayload = {
    ...existing,
    reviewConfirmed: typeof body.reviewConfirmed === 'boolean'
      ? body.reviewConfirmed
      : existing.reviewConfirmed,
  };
  await saveRoundtableEntry(id, entry);
  return NextResponse.json({ entry });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const topic = String(body.topic ?? '').trim();
  const discussionMode = normalizeDiscussionMode(body.discussionMode);
  if (!topic) {
    return NextResponse.json({ error: '缺少讨论议题' }, { status: 400 });
  }

  try {
    const wm = new WorldManager(id);
    const { worldState, characters } = await wm.loadProject();
    const focused = ensureChapterFocus(worldState);
    const chapter = focused.currentChapter;
    const contextSelection = normalizeContextSelection(body.contextSelection, chapter?.chapterNo ?? 1);
    const targetWordLabel = chapter
      ? formatChapterWordTarget(chapter.targetWordMin, chapter.targetWordMax)
      : formatChapterWordTarget();
    const bibleInfo = storyBibleText(focused, { futureNodeLimit: 10 });
    const outlineUpdatedAt = chapter?.outlineUpdatedAt ? Date.parse(chapter.outlineUpdatedAt) : 0;
    const designUpdatedAt = focused.storyDesign?.updatedAt ? Date.parse(focused.storyDesign.updatedAt) : 0;
    const designIsStale = Boolean(focused.storyDesign && outlineUpdatedAt && (!designUpdatedAt || designUpdatedAt < outlineUpdatedAt));
    const activeNodeIndexes = new Set(chapter?.activeNodeIndexes ?? []);
    const currentPlotNodes = (focused.plotNodes ?? []).filter((node) =>
      activeNodeIndexes.size > 0 ? activeNodeIndexes.has(node.index) : !node.completed
    );
    const futurePlotNodes = (focused.plotNodes ?? [])
      .filter((node) =>
        activeNodeIndexes.size > 0 ? !activeNodeIndexes.has(node.index) && !node.completed : !node.completed
      )
      .slice(0, 8);
    const chapterStartTurn = chapter?.chapterNo === 1
      ? 0
      : chapter?.startTurn ?? 0;
    const chapterEvents = await wm.getChapterEvents(chapterStartTurn, focused.turn);
    const allProjectEvents = await wm.getEvents(800, 0);
    const chapterDraftRows = await db.chapter.findMany({
      where: {
        projectId: id,
      },
      orderBy: [
        { createdAt: 'desc' },
      ],
      take: 20,
      include: { readerReviews: true },
    });
    const currentChapterDrafts = chapterDraftRows
      .filter((chapterRow) =>
        chapter?.chapterNo
          ? (chapterRow.chapterNo ?? chapter?.chapterNo) === chapter.chapterNo
          : true
      )
      .slice(0, 3);
    const currentDraft = pickCanonicalDraft(currentChapterDrafts, focused, chapter?.chapterNo) ?? null;
    const hasCurrentDraft = Boolean(currentDraft?.content?.trim());
    const currentDraftReviews = currentDraft?.readerReviews ?? [];
    const staleDrafts = currentChapterDrafts.filter((draft) => draft.id !== currentDraft?.id);
    const currentChapterEvents = chapterEvents.length
      ? chapterEvents
      : await wm.getRecentEvents(12);
    const presentCharacters = characters.filter((character) =>
      focused.presentCharacterIds.includes(character.id)
    );
    const linkedChapterDrafts = chapterDraftRows.filter((chapterRow) =>
      contextSelection.selectedChapterNos.includes(chapterRow.chapterNo ?? -1)
    );
    const eventTraceDocument = buildEventTraceDocument({
      selectedChapterNos: contextSelection.selectedChapterNos,
      chapters: chapterDraftRows,
      currentChapter: chapter,
      currentChapterEvents,
      allEvents: allProjectEvents,
      characters,
      presentCharacterIds: focused.presentCharacterIds,
      eventClosureStatus: focused.eventClosureStatus,
    });
    const assetLibrary = focused.assetLibrary ?? [];
    const selectedContextSummary = [
      contextSelection.includeStoryBible ? '总纲/正典' : '',
      contextSelection.includeCurrentChapter ? '当前章方向' : '',
      contextSelection.includeDirectorDesign ? '导演设计稿' : '',
      contextSelection.includeCurrentDraft ? '当前章正稿/历史稿' : '',
      contextSelection.includeCurrentEvents ? '当前章事件日志' : '',
      contextSelection.includeCharacters ? '人物档案' : '',
      contextSelection.includeAssets ? '素材库' : '',
      contextSelection.includeEventTrace ? '事件追踪文档' : '',
      contextSelection.selectedChapterNos.length ? `关联章节：${contextSelection.selectedChapterNos.join('、')}` : '',
    ].filter(Boolean).join('；') || '仅用户本次议题';
    const modeInstruction = discussionMode === 'internal_review'
      ? `本次模式：Agent 内部讨论 / 可行性评估。
重点不是立刻执行，而是让剧情设计师、Director、设定审核围绕用户想法做会审：
- 先判断这个想法是否值得进入项目、是否符合当前类型和当前章阶段。
- 明确它会影响哪些内容：总纲、本章方向、正文、人物状态、素材库、事件追踪。
- 三方必须有真实分歧：至少一方提出边界或反对点。
- synthesis 写“可行性结论 + 推荐下一步”，不要写成已经执行。
- directorInstruction 写“如果用户采纳，下一步应如何落地”，不要承诺已经改完。
- 如果想法需要落地到大纲/本章方向/正文，仍然要给 outlineRevisionRequest、mustFix 和 risks，方便用户一键转执行。`
      : `本次模式：生成可应用方案。
重点是把用户想法转成可采纳的项目修改建议；如果涉及大纲、本章方向、正文或人物状态，要明确写出落地位置和下一步动作。`;
    const currentChapterBlock = contextSelection.includeCurrentChapter
      ? `第 ${chapter?.chapterNo ?? 1} 章：${chapterTitleForContext(chapter?.chapterNo, chapter?.title ?? focused.sceneName, chapter)}
阶段：${chapter?.stage ?? '-'}
目标：${chapter?.goal ?? focused.sceneDescription}
范围：${chapter?.scope ?? '-'}
正文目标：${targetWordLabel}
目标轮次：${chapter?.targetTurns ?? '-'}
方向更新时间：${chapter?.outlineUpdatedAt ?? '-'}
方向修订备注：${chapter?.outlineRevisionNote ?? '-'}`
      : '- 用户本次未关联当前章方向';
    const chapterBeatsBlock = contextSelection.includeCurrentChapter
      ? chapter?.beats?.map((beat, index) => `${index + 1}. ${beat}`).join('\n') || '- 无'
      : '- 未关联';
    const storyBibleBlock = contextSelection.includeStoryBible
      ? bibleInfo
      : '- 用户本次未关联总纲/正典';
    const currentNodesBlock = contextSelection.includeCurrentChapter && currentPlotNodes.length
      ? currentPlotNodes.map((node) => `- 节点${node.index} [${node.nodeType ?? 'stage'}] ${node.title}：${node.description}；completed=${node.completed}`).join('\n')
      : '- 当前章未绑定节点，或用户本次未关联当前章方向。';
    const currentDraftBlock = contextSelection.includeCurrentDraft
      ? (currentDraft ? `标题：第 ${currentDraft.chapterNo ?? chapter?.chapterNo ?? 1} 章《${chapterTitleForContext(currentDraft.chapterNo, currentDraft.chapterTitle ?? currentDraft.sceneName, chapter)}》
字数：${chapterWordCount(currentDraft)}
正文片段：
${clip(currentDraft.content, 4200)}` : '- 当前章还没有正文')
      : '- 用户本次未关联当前章正文';
    const linkedChapterDraftsBlock = linkedChapterDrafts.length
      ? linkedChapterDrafts
          .filter((draft) => draft.id !== currentDraft?.id)
          .slice(0, 6)
          .map((draft) => `## 第 ${draft.chapterNo ?? '?'} 章《${chapterTitleForContext(draft.chapterNo, draft.chapterTitle ?? draft.sceneName, chapter)}》
字数：${chapterWordCount(draft)}；Turn ${draft.startTurn ?? '?'}-${draft.endTurn ?? '?'}
正文片段：${clip(draft.content.replace(/\s+/g, ' '), 900)}`)
          .join('\n\n') || '- 关联章节只有当前章正稿'
      : '- 无额外关联章节正文';
    const directorDesignBlock = contextSelection.includeDirectorDesign
      ? `${designIsStale ? '注意：该导演设计稿生成时间早于当前章方向更新时间，属于旧大纲产物。若与当前总纲/章方向/剧情节点冲突，必须废弃旧设计。' : '该导演设计稿未检测到早于当前章方向。'}
当前拍点：${focused.storyDesign?.currentBeat ?? '-'}
场景目的：${focused.storyDesign?.scenePurpose ?? '-'}
可用事件刺激：
${focused.storyDesign?.eventSeeds?.map((item) => `- ${item}`).join('\n') || '- 无'}
群众压力：
${focused.storyDesign?.crowdPressure?.map((item) => `- ${item}`).join('\n') || '- 无'}
临时配角入口：
${focused.storyDesign?.temporaryCast?.map((item) => `- ${item}`).join('\n') || '- 无'}
设定护栏：
${focused.storyDesign?.settingGuardrails?.map((item) => `- ${item}`).join('\n') || '- 无'}`
      : '- 用户本次未关联当前导演设计稿';
    const presentCharactersBlock = contextSelection.includeCharacters
      ? presentCharacters.map(characterLine).join('\n') || '- 无'
      : '- 用户本次未关联运行态人物';
    const characterFactsBlock = contextSelection.includeCharacters
      ? characters.map(characterFactLine).join('\n') || '- 无'
      : '- 用户本次未关联人物档案';
    const assetLibraryBlock = contextSelection.includeAssets
      ? (assetLibrary.length
          ? assetLibrary.slice(0, 80).map((asset) => `- [${asset.category}/${asset.status}] ${asset.name}${asset.grade ? `（${asset.grade}）` : ''}：${asset.summary}；用途=${asset.plotUse}`).join('\n')
          : '- 无')
      : '- 用户本次未关联素材库';
    const currentEventsBlock = contextSelection.includeCurrentEvents
      ? (hasCurrentDraft
          ? `本章已有落地正文，事件日志降级为历史演绎素材。本章事件日志共 ${currentChapterEvents.length} 条；除非某个事件已经写入上方“当前章已落地正文”，否则不得认定为当前章事实。`
          : currentChapterEvents.map((event) => `T${event.turn} ${event.agentName}/${event.type}: ${event.content}`).join('\n') || '- 无')
      : '- 用户本次未关联当前章事件日志';

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `你是 NovelStudio 的编导圆桌主持人。

${modeInstruction}

你要让三个身份各抒己见：
- 剧情设计师：关心本章情节结构、事件刺激、群众压力、临时配角入口、当前拍点是否能支撑演绎。
- Director：关心场面调度、角色接力、冲突推进、如何把剧情设计转成下一步行动。
- 设定审核：关心信息权限、时间线、网游体系、装备/等级/天赋是否有依据。

要求：
1. 这不是命令执行，不要直接改世界状态，不要代替用户做决定。
2. 必须围绕当前章，不要跳到后续大节点。
3. 三方意见要有分歧感，不能都说同一句好话。
4. 如果用户是在沟通世界规则、等级体系、长期设定、素材体系、大纲方向、本章标题、本章目标或剧情走向，必须给出 outlineRevisionRequest；但如果用户同时点名“当前章/第 N 章/正文/旧稿/正稿/现在这版”，也必须写入 mustFix 和 directorInstruction，说明当前正文或人物状态要怎样兑现，不能只停在提案层。
5. 如果用户是在讨论当前章问题，剧情设计师必须先判断“本章接下来该演绎哪一拍”，不能泛泛谈创作理论。
6. 最后给出一个可采纳方案，并转写成一条可发给 Director 的执行指令；若更适合改大纲，directorInstruction 要写“先应用纲要/本章方向，再重新生成导演设计”。只有用户没有要求当前章或正文兑现时，才可以写“当前章暂不兑现”。
7. 如果用户议题明显有风险，要直接指出。
8. 用户本次议题是最高优先级；涉及角色性别、姓名、关系、已落地正文时，必须优先服从用户本次议题。
9. 事实优先级从高到低：用户本次议题 > 当前章已落地正文 > 当前章目标/节拍 > 人物基础设定库 > 已应用导演设计 > 运行态场景/事件日志。
10. 如果“当前章已落地正文”已经存在，事件日志、运行态在场角色、旧正文版本只能作为历史素材/废稿线索，不得反过来覆盖正文事实。
11. 当前正文没有写到的人物、怪物、战斗、等级、技能、组织和制度，不要说“已经出现/已经推进”；只能说“旧演绎中出现过，若要采用需重写进正文”。
12. 如果旧事件日志和当前正文冲突，直接判定旧事件日志需要回退或废弃，不要把冲突归咎给当前正文。
13. 如果用户提到“历史稿 1 / 历史稿 2 / 历史2 / 上一版”等，必须对照下方“历史正文版本”里的对应片段来比较，不要凭空猜。
14. 先做连续性审计，再讨论方案。必须逐项检查：空间连续性（地点、距离、视线、移动路径）、动作连续性（上一动作到下一动作是否有桥）、状态连续性（刚觉醒/被围观/受压/受伤后能否立刻冷静带人行动）、信息权限（角色知道什么）。
15. 如果用户点名某个矛盾，第一反应必须是对照当前正稿承认或否定；正文没有过渡就判为真问题。不要用“可以调度”“可能发生”替文本辩护。
16. 对“白晏在操场觉醒/列队/被围观，转眼又拉着别人走/带人离开”这类问题，必须判定为高优先级连续性问题：先补过渡、改动作主语、写清移动路径，或回退错误段落。
17. 如果下方标记“导演设计稿已过期”，必须以当前总纲、当前章方向、当前剧情节点为准；旧设计只能作为废稿参考，不能继续沿用被用户删掉的信息。
18. 如果用户要求改章节名、重写第 N 章、调整本章目标/剧情走向/节拍/细纲，必须输出 outlineRevisionRequest，不要只给 directorInstruction。
19. 一旦输出 outlineRevisionRequest，directorInstruction 必须表达“先应用本章方向修改并重新生成导演设计”，不能继续沿旧设计推进；若当前已有正文且用户要求改正文，directorInstruction 还必须追加“按采纳结论重写当前正稿”。
21. 网游/成长类硬规则要形成闭环：如果用户指出击杀、首杀、任务、贡献、破解机制后缺少经验/等级/掉落/奖励反馈，mustFix 必须写清“本章方向护栏 + 正文反馈 + 人物状态 expDelta/掉落归档”三处都要落地。
20. 本章方向不是死细纲。除非用户明确要求固定顺序，否则只改章节名、目标、范围、护栏、核心冲突和剧情方向，不要把角色演绎的每一步都写死。

输出 JSON，不要 markdown：
{
  "designerOpinion": "剧情设计师角度的意见",
  "directorOpinion": "Director 角度的意见",
  "auditorOpinion": "设定审核角度的意见",
  "synthesis": "折中后的可采纳方案",
  "directorInstruction": "如果用户采纳，应该发给 Director 的执行指令",
  "outlineRevisionRequest": "如果本议题应该进入正典/总纲/本章方向，请写成可交给纲要修订会议的请求；否则空字符串",
  "risks": ["风险1"],
  "continuityAudit": ["按当前正稿列出的空间/动作/状态连续性问题"],
  "mustFix": ["采纳前必须修的文本问题"]
}`,
      },
      {
        role: 'user',
        content: `# 用户讨论议题
${topic}

# 当前章
${currentChapterBlock}

# 本次用户选择关联的上下文
${selectedContextSummary}

# 本次讨论模式
${modeInstruction}

# 本章节拍
${chapterBeatsBlock}

# 全局总纲上下文
${storyBibleBlock}

# 当前剧情节点（当前章只能推进这些）
${currentNodesBlock}

# 后续剧情节点（只可伏笔，不可兑现）
${futurePlotNodes.length
  ? futurePlotNodes.map((node) => `- 节点${node.index} [${node.nodeType ?? 'stage'}] ${node.title}：${node.description}`).join('\n')
  : '- 无'}

# 当前章已落地正文（按当前章节号读取，不是最近章节）
${currentDraftBlock}

# 关联章节正文
${linkedChapterDraftsBlock}

# 当前剧情设计师/导演设计稿
${directorDesignBlock}

# 当前运行态场景（低优先级）
${hasCurrentDraft ? '注意：本章已有落地正文。以下运行态场景可能来自旧演绎，只能供定位，不能覆盖正文事实。' : '本章尚无正文时，可以把运行态场景作为演绎依据。'}
${focused.sceneName}
${focused.sceneDescription}
地点：${focused.location}
时间：${focused.timeOfDay}
Turn：${focused.turn}
张力：${focused.tension}/10

# 运行态在场角色（低优先级）
${hasCurrentDraft ? '注意：本章已有落地正文。未在当前正文出现的人物，不得仅凭这里判定为本章已出场。' : '本章尚无正文时，可以参考这里决定下一拍谁行动。'}
${presentCharactersBlock}

# 人物基础设定库（性别/身份修正看这里；不要从运行态位置推断剧情事实）
${characterFactsBlock}

# 素材库
${assetLibraryBlock}

# 事件追踪文档
${contextSelection.includeEventTrace ? eventTraceDocument : '- 用户本次未关联事件追踪文档'}

# 当前章事件日志
${currentEventsBlock}

# 当前正文评审
${currentDraftReviews.map((review) => `- ${review.readerName}: ${review.summary}`).join('\n') || '- 无'}

# 历史正文版本（可比较，但不是当前事实）
${hasCurrentDraft && staleDrafts.length
  ? staleDrafts.map((chapterRow, index) => formatHistoricalDraft({
      label: historyDraftLabel(currentChapterDrafts.length, index + 1),
      chapterRow,
      currentChapter: chapter,
    })).join('\n\n')
  : '- 无'}

# 任务
请组织一次简洁但有分歧的设计讨论。
先给出连续性审计，再给三方意见；如果用户指出的问题被当前正稿支持，必须明确写入 continuityAudit、mustFix、risks 和 directorInstruction。`,
      },
    ];

    const raw = await chat(messages, { temperature: 0.72, maxTokens: 2200 });
    let parsed = await parseRoundtableDraftWithRepair(messages, raw);
    if (!parsed) throw new Error('设计讨论解析失败');
    if (discussionMode === 'internal_review' && looksIncompleteSummary(String(parsed.synthesis ?? ''))) {
      const repairRaw = await chat([
        ...messages,
        { role: 'assistant', content: raw },
        {
          role: 'user',
          content: '你上一条内部评估的 synthesis 结尾像是被截断了。保持原判断不变，只把未说完的结论、推荐下一步和未完成的句子补完整，继续输出同一份 JSON，不要省略字段。',
        },
      ], { temperature: 0.5, maxTokens: 2800 });
      const repaired = extractJSON<RoundtableDraft>(repairRaw);
      if (repaired) parsed = repaired;
    }
    const localContinuity = detectUserContinuityFlags(topic, currentDraft?.content, characters);
    const localOutlineRequest = detectOutlineChangeRequest(topic, chapter);
    const continuityAudit = uniqueStrings([
      ...toStringArray(parsed.continuityAudit, 8),
      ...localContinuity.continuityAudit,
    ], 8);
    const mustFix = uniqueStrings([
      ...toStringArray(parsed.mustFix, 8),
      ...localContinuity.mustFix,
    ], 8);
    const baseAuditorOpinion = String(parsed.auditorOpinion ?? '').trim() || '设定审核认为需要先确认角色当前能知道什么、能做到什么。';
    const auditorOpinion = localContinuity.continuityAudit.length > 0 && !/(连续|位置|动作|状态|操场|觉醒|拉着|带着)/.test(baseAuditorOpinion)
      ? `${localContinuity.continuityAudit[0]}\n${baseAuditorOpinion}`
      : baseAuditorOpinion;
    const outlineRevisionRequest = String(parsed.outlineRevisionRequest ?? '').trim() || localOutlineRequest;
    const baseDirectorInstruction = String(parsed.directorInstruction ?? '').trim() || topic;
    const outlineFirstInstruction = outlineRevisionRequest
      ? `先应用本章方向修改并重新生成导演设计；不要继续沿旧方向推进。${baseDirectorInstruction}`
      : baseDirectorInstruction;
    const directorInstruction = mustFix.length > 0 && !/(连续|过渡|位置|动作|状态|移动|路径)/.test(outlineFirstInstruction)
      ? `先修连续性：${mustFix[0]} 然后再执行：${outlineFirstInstruction}`
      : outlineFirstInstruction;

    const entry: RoundtableEntryPayload = {
      id: `roundtable-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      topic,
      chapterNo: chapter?.chapterNo,
      chapterTitle: chapter ? chapterTitleForContext(chapter.chapterNo, chapter.title ?? focused.sceneName, chapter) : undefined,
      contextChapterNos: contextSelection.selectedChapterNos,
      discussionMode,
      reviewConfirmed: false,
      designerOpinion: String(parsed.designerOpinion ?? '').trim() || '剧情设计师认为需要先收窄当前章拍点，设计能触发角色行动的事件刺激。',
      directorOpinion: String(parsed.directorOpinion ?? '').trim() || 'Director 认为需要先明确本章拍点，再决定是否推进。',
      auditorOpinion,
      synthesis: String(parsed.synthesis ?? '').trim() || '先收窄为当前章可演绎的一拍，再由 Director 生成具体设计。',
      directorInstruction,
      outlineRevisionRequest,
      risks: uniqueStrings([
        ...toStringArray(parsed.risks, 8),
        ...localContinuity.risks,
        ...(outlineRevisionRequest ? ['这是本章方向/总纲变更；未应用前不会改变章节名、目标或剧情走向。'] : []),
      ], 8),
      continuityAudit,
      mustFix,
      createdAt: new Date().toISOString(),
    };

    await saveRoundtableEntry(id, entry);

    return NextResponse.json({ entry });
  } catch (err) {
    return NextResponse.json({ error: toLLMUserMessage(err) }, { status: 500 });
  }
}
