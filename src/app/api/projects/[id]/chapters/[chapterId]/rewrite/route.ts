/**
 * POST /api/projects/[id]/chapters/[chapterId]/rewrite
 * Generate a new current draft for the same chapter. Old drafts are kept as history.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { chat, extractJSON, toLLMUserMessage, type ChatMessage } from '@/lib/novel/llm';
import {
  CHAPTER_WORD_TARGET_MAX,
  CHAPTER_WORD_TARGET_MIN,
  formatChapterWordTarget,
} from '@/lib/novel/chapter-policy';
import { ensureChapterFocus } from '@/lib/novel/chapter-focus';
import { countReadableChars } from '@/lib/novel/chapter-text';
import { normalizeChapterTitle } from '@/lib/novel/chapter-title';
import {
  renderCharacterFactsForPrompt,
  renderStoryDesignForPrompt,
  repairChapterUntilValid,
  requiredCharacterNamesFromText,
} from '@/lib/novel/chapter-guardrails';
import type { ChapterSummary, Character, WorldState } from '@/lib/novel/types';
import { rowToCharacter, rowToReaderReview, WorldManager } from '@/lib/novel/world-state';
import { withCanonicalChapterId } from '@/lib/novel/canonical-chapter';
import { loadPreviousChapterBridge, renderChapterBridgeForPrompt, type ChapterBridgeContext } from '@/lib/novel/chapter-continuity';
import { applyExperience } from '@/lib/novel/progression';

function cleanChapterText(raw: string): string {
  return raw
    .replace(/^```(?:\w+)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/^第[一二三四五六七八九十百\d]+章[^\n]*\n+/, '')
    .replace(/^《[^》]+》\s*\n+/, '')
    .replace(/^(以下是|正文[:：]|小说正文[:：]).*\n+/i, '')
    .trim();
}

function serializeChapter(row: any): ChapterSummary {
  return {
    id: row.id,
    chapterNo: row.chapterNo,
    chapterTitle: row.chapterTitle,
    sceneName: row.sceneName,
    content: row.content,
    wordCount: row.wordCount,
    startTurn: row.startTurn,
    endTurn: row.endTurn,
    createdAt: row.createdAt,
    readerReviews: row.readerReviews?.map(rowToReaderReview) ?? [],
  };
}

function clip(text: string, max = 1600): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[截断 ${text.length - max} 字]`;
}

function historicalDraftLabel(totalDrafts: number, draftIndex: number): string {
  return `历史稿 ${Math.max(1, totalDrafts - draftIndex)}`;
}

function formatHistoricalDraftForPrompt(input: {
  label: string;
  row: {
    id: string;
    chapterNo: number | null;
    chapterTitle: string | null;
    sceneName: string;
    content: string;
    startTurn?: number | null;
    endTurn?: number | null;
  };
  chapterTitle?: string;
}): string {
  const { label, row, chapterTitle } = input;
  const turnRange =
    typeof row.startTurn === 'number' || typeof row.endTurn === 'number'
      ? `；Turn ${row.startTurn ?? '?'}-${row.endTurn ?? '?'}`
      : '';
  return `## ${label}
标题：第 ${row.chapterNo ?? '?'} 章《${chapterTitle || normalizeChapterTitle(row.chapterTitle ?? row.sceneName, row.chapterNo)}》
字数：${countReadableChars(row.content)}${turnRange}
说明：旧版本只可作为可借鉴素材。若用户要求采用其中优点，必须重写进本次新稿，不能把旧稿当作当前事实。
正文片段：
${clip(row.content, 2800)}`;
}

interface LocalEditPatch {
  find?: string;
  replace?: string;
  reason?: string;
}

interface LocalEditDraft {
  patches?: LocalEditPatch[];
  notes?: string;
}

function isLocalEditInstruction(instruction: string): boolean {
  const text = instruction.trim();
  if (!text) return false;
  if (/全文|全篇|整章|重写|重构|重新写|改写成|扩写|压缩|换一种写法|从头/.test(text)) {
    return false;
  }
  return /只|仅|局部|部分|别动|不要动|保留|维持|不改|只改|只调整|只修正|改.*(性别|称谓|名字|姓名|白晏|男|女)|baiyan/i.test(text);
}

function buildLocalEditMessages(input: {
  instruction: string;
  chapterNo: number;
  chapterTitle: string;
  currentText: string;
  historicalDrafts: string;
  worldState: WorldState;
  characters: Character[];
}): ChatMessage[] {
  const currentChapter = input.worldState.currentChapter;
  return [
    {
      role: 'system',
      content: `你是《空悬王座》的局部修稿编辑。你不能重写整章，只能返回可定位的局部替换补丁。

硬性要求：
- 只处理用户明确要求修正的局部问题。
- 不要改开篇、叙事节奏、段落顺序、世界观设定或其他句子，除非用户明确点名。
- 每个补丁必须给出当前正文中完全存在的 find 原文片段，以及 replace 替换片段。
- find 必须足够短且唯一，建议 20-180 字；不要返回整章。
- 如果用户说“只改白晏性别/称谓”，只替换白晏相关称谓和必要上下文。
- 如果你无法定位原文片段，返回 {"patches":[]}，不要编造整章正文。

输出 JSON，不要 markdown：
{
  "patches": [
    { "find": "当前正文里的原句或短段", "replace": "替换后的原句或短段", "reason": "为什么改" }
  ],
  "notes": "一句话说明"
}`,
    },
    {
      role: 'user',
      content: `# 用户局部修正要求
${input.instruction}

# 当前章
第 ${input.chapterNo} 章《${input.chapterTitle}》
目标：${currentChapter?.goal ?? '-'}
范围：${currentChapter?.scope ?? '-'}
护栏：
${currentChapter?.constraints?.map((item) => `- ${item}`).join('\n') || '- 无'}

# 人物基础设定库
${renderCharacterFactsForPrompt(input.characters)}

# 当前正文（只能在这里做局部替换）
"""
${input.currentText}
"""

# 同章历史稿（只用于理解用户提到“历史2更好”等，不允许整段搬运覆盖当前稿）
${input.historicalDrafts || '- 无'}

# 输出
返回 JSON 补丁。`,
    },
  ];
}

function applyLocalEditPatches(content: string, patches: LocalEditPatch[]): {
  content: string;
  applied: number;
  skipped: number;
} {
  let next = content;
  let applied = 0;
  let skipped = 0;

  for (const patch of patches) {
    const find = patch.find?.trim();
    const replace = patch.replace?.trim();
    if (!find || !replace || find === replace) {
      skipped += 1;
      continue;
    }
    const firstIndex = next.indexOf(find);
    if (firstIndex < 0 || next.indexOf(find, firstIndex + find.length) >= 0) {
      skipped += 1;
      continue;
    }
    next = `${next.slice(0, firstIndex)}${replace}${next.slice(firstIndex + find.length)}`;
    applied += 1;
  }

  return { content: next, applied, skipped };
}

async function loadSerializedChapters(projectId: string): Promise<ChapterSummary[]> {
  const rows = await db.chapter.findMany({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
    include: {
      readerReviews: { orderBy: { createdAt: 'asc' } },
    },
  });
  return rows.map(serializeChapter);
}

function regexpEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseExpGainNearCharacter(content: string, characterName: string): number {
  const name = regexpEscape(characterName);
  const patterns = [
    new RegExp(`${name}[\\s\\S]{0,360}(?:经验|EXP|Exp|exp)\\s*[：: ]*[+＋]\\s*(\\d+)`, 'g'),
    new RegExp(`(?:经验|EXP|Exp|exp)\\s*[：: ]*[+＋]\\s*(\\d+)[\\s\\S]{0,360}${name}`, 'g'),
  ];
  let total = 0;
  const seen = new Set<string>();
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const raw = match[1];
      const value = Number(raw);
      const key = `${match.index}:${raw}`;
      if (!Number.isFinite(value) || value <= 0 || seen.has(key)) continue;
      seen.add(key);
      total += Math.floor(value);
    }
  }
  return total;
}

async function loadChapterProgressionBaselines(
  projectId: string,
  chapterNo: number,
  characters: Character[]
): Promise<Map<string, Character>> {
  const baselines = new Map(characters.map((character) => [character.id, character]));
  const snapshots = await db.characterChapterSnapshot.findMany({
    where: { projectId, chapterNo },
  }).catch(() => []);

  for (const snapshot of snapshots) {
    try {
      baselines.set(snapshot.characterId, {
        id: snapshot.characterId,
        name: snapshot.name,
        role: snapshot.role === 'protagonist' || snapshot.role === 'antagonist' || snapshot.role === 'npc'
          ? snapshot.role
          : 'npc',
        persona: JSON.parse(snapshot.persona),
        currentState: JSON.parse(snapshot.currentState),
      });
    } catch {
      // Ignore malformed legacy snapshots; current character state remains the fallback.
    }
  }

  return baselines;
}

async function applyChapterTextProgression(
  wm: WorldManager,
  projectId: string,
  chapterNo: number,
  content: string,
  characters: Character[]
): Promise<Character[]> {
  const baselines = await loadChapterProgressionBaselines(projectId, chapterNo, characters);
  const updated: Character[] = [];
  for (const character of characters) {
    const baseline = baselines.get(character.id) ?? character;
    const expDelta = content.includes(character.name)
      ? parseExpGainNearCharacter(content, character.name)
      : 0;
    const hasProgressionState =
      typeof baseline.currentState.level === 'number' ||
      typeof baseline.currentState.exp === 'number' ||
      typeof baseline.currentState.nextLevelExp === 'number';
    if (!hasProgressionState && expDelta <= 0) continue;
    const progression = applyExperience(
      baseline.currentState.level,
      baseline.currentState.exp,
      expDelta
    );
    const currentLevel = character.currentState.level;
    const currentExp = character.currentState.exp;
    const currentNextLevelExp = character.currentState.nextLevelExp;
    if (
      currentLevel === progression.level &&
      currentExp === progression.exp &&
      currentNextLevelExp === progression.nextLevelExp
    ) {
      continue;
    }
    const next: Character = {
      ...character,
      currentState: {
        ...character.currentState,
        level: progression.level,
        exp: progression.exp,
        nextLevelExp: progression.nextLevelExp,
      },
    };
    await wm.saveCharacter(next);
    updated.push(next);
  }
  return updated;
}

function buildRewriteMessages(input: {
  instruction: string;
  chapterNo: number;
  chapterTitle: string;
  currentText: string;
  historicalDrafts: string;
  targetMin: number;
  targetMax: number;
  worldState: WorldState;
  characters: Character[];
  previousChapterBridge?: ChapterBridgeContext | null;
}): ChatMessage[] {
  const targetLabel = formatChapterWordTarget(input.targetMin, input.targetMax);
  const currentChapter = input.worldState.currentChapter;
  const isChapterOne = input.chapterNo === 1;
  const chapterBridgeInfo = renderChapterBridgeForPrompt(input.previousChapterBridge);
  return [
    {
      role: 'system',
      content: `你是《空悬王座》的章节全篇重写 Writer，只负责输出小说正文。

硬性要求：
- 输出完整章节正文，不要标题、不要解释、不要 markdown。
- 正文可读字数控制在 ${targetLabel}，建议约 ${Math.floor((input.targetMin + input.targetMax) / 2)} 可读字；正文必须保留正常中文标点，不要写成无标点长段。
- 用户指令优先级最高，但必须符合基础因果逻辑。
- 这是全篇重写模式；只有当用户明确要求重写整章、扩写、压缩、重构或重做开篇时才应该使用。
- 按“当前章目标 / 当前章范围 / 本章节拍 / 用户最高优先级修正”重写，不要沿用旧稿错误。
- 如果用户修正涉及角色性别、身份、关系、姓名或已出现情节，必须在正文里落实到可见文本。
- 如果用户提到“历史稿 1 / 历史稿 2 / 历史2 / 上一版”等，必须对照下方“同章历史稿”借鉴对应优点，再写进新当前稿。
- 人物基础设定库是硬约束。比如档案写明是女，就不能写成男生、男孩、少年或男性化称谓。
- 不要写当前章范围外的大节点，不要提前兑现后续体系。
- 不要凭空新增已经成型的制度、装备、技能、等级、掉落或组织，除非当前章细纲/用户修正明确要求。
- 如果当前章方向或用户修正要求“杀怪后有经验/等级/掉落/奖励反馈”，必须贴近有效贡献者写出短促、可结算的反馈文本，例如“苏见山眼前一闪：【经验 +20】”；不要写成长篇教学面板。
- ${isChapterOne ? '第一章不得以裂隙、坠落、战斗、登记、检测、安置流程开场；如仍是开篇，应先有日常基线和违和预兆。' : '本章不必套用第一章固定顺序，只按当前章细纲重写。'}
- ${isChapterOne ? '当前是第一章，无需章际接续。' : '本章开头必须接住上一章正稿结尾；上一章没有写到的战斗、地点、怪物、组织流程，不能在本章第一句当成既成事实。'}
- 角色知道的事只能来自当场公开信息。`,
    },
    {
      role: 'user',
      content: `# 章节
第 ${input.chapterNo} 章《${input.chapterTitle}》

# 当前章目标
${currentChapter?.goal ?? '重写本章，使其开场自然，因果连续。'}

# 当前章范围
${currentChapter?.scope ?? '只写当前章，不提前兑现后续大节点。'}

# 本章节拍
${(currentChapter?.beats ?? []).map((beat, index) => `${index + 1}. ${beat}`).join('\n') || '- 日常到深渊降临，再到无天赋压力和空悬王座钩子。'}

# 本章硬性护栏
${currentChapter?.constraints?.map((item) => `- ${item}`).join('\n') || '- 无'}

# 上一章正稿接续
${isChapterOne ? '- 当前是第一章。' : chapterBridgeInfo}

# 当前剧情设计师/导演设计
${renderStoryDesignForPrompt(input.worldState.storyDesign)}

# 人物基础设定库
${renderCharacterFactsForPrompt(input.characters)}

# 用户最高优先级修正
${input.instruction}

# 旧稿问题参考
旧稿只用于定位需要修正的地方。若旧稿与用户修正冲突，用户修正优先；若旧稿已有可保留的连续段落，可以保留并局部改写。

# 旧稿片段（只用于避坑，不要照抄）
"""
${input.currentText.slice(0, 3600)}
"""

# 同章历史稿（可借鉴，不是当前事实）
${input.historicalDrafts || '- 无'}

# 输出
直接输出 ${targetLabel} 的中文小说正文。`,
    },
  ];
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; chapterId: string }> }
) {
  const { id, chapterId } = await params;
  const body = await req.json().catch(() => ({}));
  const instruction = String(body.instruction ?? '').trim();
  const forceFullRewrite = Boolean(body.forceFullRewrite || body.mode === 'full');

  const chapter = await db.chapter.findFirst({
    where: { id: chapterId, projectId: id },
  });
  if (!chapter) {
    return NextResponse.json({ error: '章节不存在' }, { status: 404 });
  }

  const wm = new WorldManager(id);
  let worldState: WorldState;
  let characters: Character[] = [];
  try {
    const loaded = await wm.loadProject();
    worldState = loaded.worldState;
    characters = loaded.characters;
  } catch {
    const project = await db.project.findUnique({
      where: { id },
      include: { characters: true },
    });
    if (!project) {
      return NextResponse.json({ error: '项目不存在' }, { status: 404 });
    }
    worldState = ensureChapterFocus(JSON.parse(project.worldState));
    characters = project.characters.map(rowToCharacter);
  }

  const currentChapter = worldState.currentChapter;
  const chapterNo = chapter.chapterNo ?? currentChapter?.chapterNo ?? 1;
  const currentChapterTitle =
    currentChapter?.chapterNo === chapterNo && currentChapter.title?.trim()
      ? normalizeChapterTitle(currentChapter.title, chapterNo)
      : null;
  const chapterTitle = currentChapterTitle || normalizeChapterTitle(chapter.chapterTitle, chapterNo) || '深渊降临前夜';
  const targetMin = currentChapter?.targetWordMin ?? CHAPTER_WORD_TARGET_MIN;
  const targetMax = currentChapter?.targetWordMax ?? CHAPTER_WORD_TARGET_MAX;
  const promptInstruction =
    instruction ||
    '按“日常祥和 -> 违和预兆 -> 深渊降临 -> 全球觉醒 -> 主角无天赋被排挤 -> 空悬王座钩子”重写本章。';
  const localEditMode = !forceFullRewrite && isLocalEditInstruction(promptInstruction);
  const siblingDraftRows = await db.chapter.findMany({
    where: {
      projectId: id,
      chapterNo,
      NOT: { id: chapter.id },
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  const historicalDrafts = siblingDraftRows
    .map((row, index) => formatHistoricalDraftForPrompt({
      label: historicalDraftLabel(siblingDraftRows.length + 1, index + 1),
      row,
      chapterTitle,
    }))
    .join('\n\n');
  const previousChapterBridge = await loadPreviousChapterBridge(id, worldState, chapterNo);

  try {
    let initialContent = '';
    let localPatchStats: { content: string; applied: number; skipped: number } | null = null;

    if (localEditMode) {
      const rawPatch = await chat(
        buildLocalEditMessages({
          instruction: promptInstruction,
          chapterNo,
          chapterTitle,
          currentText: chapter.content,
          historicalDrafts,
          worldState,
          characters,
        }),
        { temperature: 0.24, maxTokens: 2200 }
      );
      const parsed = extractJSON<LocalEditDraft>(rawPatch);
      const patches = Array.isArray(parsed?.patches) ? parsed.patches.slice(0, 8) : [];
      localPatchStats = applyLocalEditPatches(chapter.content, patches);
      if (localPatchStats.applied === 0) {
        throw new Error('局部修正没有找到可定位的原文片段，未保存。请在指令里贴出要修改的原句，或明确要求“重写整章”。');
      }
      initialContent = cleanChapterText(localPatchStats.content);
    } else {
      initialContent = cleanChapterText(await chat(
        buildRewriteMessages({
          instruction: promptInstruction,
          chapterNo,
          chapterTitle,
          currentText: chapter.content,
          historicalDrafts,
          targetMin,
          targetMax,
          worldState,
          characters,
          previousChapterBridge,
        }),
        { temperature: 0.72, maxTokens: 5200 }
      ));
    }

    if (!initialContent) {
      throw new Error('模型没有返回正文');
    }

    const requiredCharacterNames = localEditMode
      ? requiredCharacterNamesFromText(characters, promptInstruction)
      : requiredCharacterNamesFromText(
          characters,
          promptInstruction,
          currentChapter?.goal,
          currentChapter?.scope,
          ...(currentChapter?.beats ?? []),
          worldState.storyDesign?.currentBeat,
          worldState.storyDesign?.scenePurpose,
          ...(worldState.storyDesign?.eventSeeds ?? []),
          ...(worldState.storyDesign?.settingGuardrails ?? []),
          ...(worldState.storyDesign?.directorNotes ?? [])
        );

    const repaired = await repairChapterUntilValid({
      content: initialContent,
      targetMin,
      targetMax,
      characters,
      requiredCharacterNames,
      currentChapter,
      storyDesign: worldState.storyDesign,
      instruction: promptInstruction,
      previousChapterBridge,
      sourceContext: [
        previousChapterBridge?.prompt,
        chapter.content,
      ].filter(Boolean).join('\n\n'),
      maxAttempts: localEditMode ? 0 : 2,
      enforceWordTarget: !localEditMode,
    });
    const content = repaired.content;
    if (!content) {
      throw new Error('模型没有返回正文');
    }
    if (repaired.validation.issues.length > 0) {
      throw new Error(`章节重写校验失败，未保存问题稿：${repaired.validation.issues.map((issue) => issue.message).join('；')}`);
    }

    const saved = await db.chapter.create({
      data: {
        projectId: id,
        chapterNo,
        chapterTitle,
        sceneName: `第 ${chapterNo} 章当前稿：${chapterTitle}`,
        content,
        wordCount: repaired.validation.readableCount,
        startTurn: chapter.startTurn,
        endTurn: chapter.endTurn,
      },
      include: { readerReviews: true },
    });
    const updatedCharacters = await applyChapterTextProgression(wm, id, chapterNo, content, characters);
    worldState = withCanonicalChapterId(worldState, chapterNo, saved.id);
    await db.project.update({
      where: { id },
      data: { worldState: JSON.stringify(worldState), currentTurn: worldState.turn },
    });

    const warning = localEditMode
      ? `局部修正已应用 ${localPatchStats?.applied ?? 0} 处，跳过 ${localPatchStats?.skipped ?? 0} 处；未按字数目标重写全章，当前可读字数 ${repaired.validation.readableCount}。`
      : repaired.repairAttempts > 0
        ? `已自动修稿 ${repaired.repairAttempts} 轮，当前可读字数 ${repaired.validation.readableCount}。`
        : undefined;

    return NextResponse.json({
      chapter: serializeChapter(saved),
      chapters: await loadSerializedChapters(id),
      updatedCharacters,
      worldState,
      warning,
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        error: toLLMUserMessage(err),
        chapters: await loadSerializedChapters(id),
      },
      { status: 500 }
    );
  }
}
