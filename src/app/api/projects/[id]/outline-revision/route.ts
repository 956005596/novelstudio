/**
 * POST  /api/projects/[id]/outline-revision   生成总纲/本章方向调整提案
 * PATCH /api/projects/[id]/outline-revision   应用已确认提案
 */

import { NextRequest, NextResponse } from 'next/server';
import { chat, extractJSON, toLLMUserMessage, type ChatMessage } from '@/lib/novel/llm';
import { db } from '@/lib/db';
import { ensureChapterFocus } from '@/lib/novel/chapter-focus';
import { normalizeChapterTitle } from '@/lib/novel/chapter-title';
import { normalizeLongFormPlan } from '@/lib/novel/long-form-plan';
import { storyBibleText } from '@/lib/novel/story-bible';
import { WorldManager } from '@/lib/novel/world-state';
import type { ChapterFocus, LongFormPlan, PlotNode, WorldState } from '@/lib/novel/types';

interface OutlineRevisionDraft {
  source?: 'manual' | 'roundtable';
  mode?: 'global' | 'chapter' | 'both';
  scope?: 'global' | 'chapter' | 'both';
  title?: string;
  reason?: string;
  designerOpinion?: string;
  directorOpinion?: string;
  auditorOpinion?: string;
  globalNotesAppend?: string;
  longFormPlanPatch?: Partial<LongFormPlan>;
  currentChapterPatch?: Partial<ChapterFocus>;
  plotNodePatches?: Partial<PlotNode>[];
  directorInstruction?: string;
  risks?: string[];
}

const MAX_ARRAY_ITEMS = 12;

function clip(text: string, max = 1600): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[截断 ${text.length - max} 字]`;
}

function stringValue(value: unknown, fallback = ''): string {
  return String(value ?? fallback).trim();
}

function stringArray(value: unknown, limit = MAX_ARRAY_ITEMS): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, limit)
    : [];
}

function revisionMode(value: unknown, fallback: 'global' | 'chapter' | 'both' = 'both'): 'global' | 'chapter' | 'both' {
  return value === 'global' || value === 'chapter' || value === 'both' ? value : fallback;
}

function numberValue(value: unknown, fallback: number, min = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.floor(parsed)) : fallback;
}

function statusValue(value: unknown): 'pending' | 'active' | 'done' {
  return value === 'done' || value === 'active' ? value : 'pending';
}

function sanitizeLongFormPlanPatch(value: unknown): Partial<LongFormPlan> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Partial<LongFormPlan>;
  const patch: Partial<LongFormPlan> = {};
  if (input.targetWords !== undefined) patch.targetWords = numberValue(input.targetWords, 1_000_000, 0);
  if (input.minWords !== undefined) patch.minWords = numberValue(input.minWords, 0, 0);
  if (input.targetChapters !== undefined) patch.targetChapters = numberValue(input.targetChapters, 400, 1);
  if (input.chapterWordMin !== undefined) patch.chapterWordMin = numberValue(input.chapterWordMin, 2000, 300);
  if (input.chapterWordMax !== undefined) patch.chapterWordMax = numberValue(input.chapterWordMax, patch.chapterWordMin ?? 2800, patch.chapterWordMin ?? 300);
  if (input.promise !== undefined) patch.promise = stringValue(input.promise);
  if (input.pacingPrinciples !== undefined) patch.pacingPrinciples = stringArray(input.pacingPrinciples, 8);
  if (Array.isArray(input.volumes)) {
    patch.volumes = input.volumes
      .map((volume, index) => ({
        index: numberValue(volume?.index, index + 1, 1),
        title: stringValue(volume?.title, `第 ${index + 1} 卷`),
        purpose: stringValue(volume?.purpose, '待补充卷目标'),
        chapterStart: numberValue(volume?.chapterStart, index * 40 + 1, 1),
        chapterEnd: numberValue(volume?.chapterEnd, (index + 1) * 40, 1),
        nodeIndexes: Array.isArray(volume?.nodeIndexes)
          ? volume.nodeIndexes.map(Number).filter((item) => Number.isFinite(item) && item > 0).slice(0, 50)
          : [],
        status: statusValue(volume?.status),
      }))
      .filter((volume) => volume.title && volume.purpose)
      .slice(0, 30);
  }
  return patch;
}

function sanitizeChapterPatch(value: unknown, current?: ChapterFocus): Partial<ChapterFocus> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Partial<ChapterFocus>;
  const patch: Partial<ChapterFocus> = {};
  if (input.title !== undefined) patch.title = normalizeChapterTitle(
    stringValue(input.title, current?.title ?? '未命名章节'),
    current?.chapterNo
  );
  if (input.goal !== undefined) patch.goal = stringValue(input.goal, current?.goal ?? '');
  if (input.scope !== undefined) patch.scope = stringValue(input.scope, current?.scope ?? '');
  if (input.stage !== undefined) patch.stage = stringValue(input.stage, current?.stage ?? '铺垫');
  if (input.activeNodeIndexes !== undefined && Array.isArray(input.activeNodeIndexes)) {
    patch.activeNodeIndexes = input.activeNodeIndexes.map(Number).filter((item) => Number.isFinite(item) && item > 0).slice(0, 8);
  }
  if (input.beats !== undefined) patch.beats = stringArray(input.beats, 12);
  if (input.constraints !== undefined) patch.constraints = stringArray(input.constraints, 16);
  if (input.targetTurns !== undefined) patch.targetTurns = numberValue(input.targetTurns, current?.targetTurns ?? 8, 1);
  if (input.targetWordMin !== undefined) patch.targetWordMin = numberValue(input.targetWordMin, current?.targetWordMin ?? 2000, 300);
  if (input.targetWordMax !== undefined) patch.targetWordMax = numberValue(input.targetWordMax, current?.targetWordMax ?? 2800, patch.targetWordMin ?? 300);
  return patch;
}

function sanitizePlotNodePatch(value: unknown): Partial<PlotNode> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Partial<PlotNode>;
  const index = numberValue(input.index, 0, 0);
  if (!index) return null;
  const patch: Partial<PlotNode> = { index };
  if (input.title !== undefined) patch.title = stringValue(input.title);
  if (input.description !== undefined) patch.description = stringValue(input.description);
  if (input.completed !== undefined) patch.completed = Boolean(input.completed);
  if (input.nodeType === 'main' || input.nodeType === 'sub' || input.nodeType === 'foreshadow' || input.nodeType === 'daily') {
    patch.nodeType = input.nodeType;
  }
  if (input.subNodes !== undefined) patch.subNodes = stringArray(input.subNodes, 12);
  if (input.priority !== undefined) patch.priority = numberValue(input.priority, 3, 1);
  if (input.estimatedTurns !== undefined) patch.estimatedTurns = numberValue(input.estimatedTurns, 8, 1);
  if (input.linkedCharacters !== undefined) patch.linkedCharacters = stringArray(input.linkedCharacters, 12);
  if (input.tensionLevel !== undefined) patch.tensionLevel = numberValue(input.tensionLevel, 3, 0);
  if (input.targetTurn !== undefined) patch.targetTurn = numberValue(input.targetTurn, 0, 0);
  return patch;
}

function sanitizeDraft(draft: OutlineRevisionDraft, current?: ChapterFocus): OutlineRevisionDraft {
  return {
    source: draft.source === 'roundtable' ? 'roundtable' : 'manual',
    scope: draft.scope === 'global' || draft.scope === 'chapter' ? draft.scope : draft.scope === 'both' ? 'both' : 'chapter',
    title: stringValue(draft.title, '纲要调整提案'),
    reason: stringValue(draft.reason),
    designerOpinion: stringValue(draft.designerOpinion),
    directorOpinion: stringValue(draft.directorOpinion),
    auditorOpinion: stringValue(draft.auditorOpinion),
    globalNotesAppend: stringValue(draft.globalNotesAppend),
    longFormPlanPatch: sanitizeLongFormPlanPatch(draft.longFormPlanPatch),
    currentChapterPatch: sanitizeChapterPatch(draft.currentChapterPatch, current),
    plotNodePatches: Array.isArray(draft.plotNodePatches)
      ? draft.plotNodePatches.map(sanitizePlotNodePatch).filter(Boolean).slice(0, 20) as Partial<PlotNode>[]
      : [],
    directorInstruction: stringValue(draft.directorInstruction),
    risks: stringArray(draft.risks, 8),
  };
}

function restrictRoundtableDraft(draft: OutlineRevisionDraft): OutlineRevisionDraft {
  return {
    ...draft,
    source: 'roundtable',
    scope: 'chapter',
    globalNotesAppend: '',
    longFormPlanPatch: {},
    plotNodePatches: [],
  };
}

function restrictDraftByMode(draft: OutlineRevisionDraft, mode: 'global' | 'chapter' | 'both'): OutlineRevisionDraft {
  if (mode === 'chapter') {
    return {
      ...draft,
      scope: 'chapter',
      globalNotesAppend: '',
      longFormPlanPatch: {},
      plotNodePatches: [],
    };
  }
  if (mode === 'global') {
    return {
      ...draft,
      scope: 'global',
      currentChapterPatch: {},
    };
  }
  return {
    ...draft,
    scope: 'both',
  };
}

function objectHasKeys(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

function hasApplicableRevision(proposal: OutlineRevisionDraft): boolean {
  return Boolean(
    stringValue(proposal.globalNotesAppend) ||
    objectHasKeys(proposal.longFormPlanPatch) ||
    objectHasKeys(proposal.currentChapterPatch) ||
    (Array.isArray(proposal.plotNodePatches) && proposal.plotNodePatches.length > 0)
  );
}

function mergeNotes(existing: string | undefined, addition: string, title: string): string | undefined {
  const next = addition.trim();
  if (!next) return existing;
  const block = `## ${title}\n${next}`;
  return existing?.trim() ? `${existing.trim()}\n\n${block}` : block;
}

function applyPlotNodePatches(nodes: PlotNode[] | undefined, patches: Partial<PlotNode>[] | undefined): PlotNode[] | undefined {
  if (!patches?.length) return nodes;
  const byIndex = new Map((nodes ?? []).map((node) => [node.index, node]));
  for (const patch of patches) {
    if (!patch.index) continue;
    const existing = byIndex.get(patch.index);
    byIndex.set(patch.index, {
      index: patch.index,
      title: patch.title ?? existing?.title ?? `节点${patch.index}`,
      description: patch.description ?? existing?.description ?? '待补充',
      completed: patch.completed ?? existing?.completed ?? false,
      nodeType: patch.nodeType ?? existing?.nodeType,
      subNodes: patch.subNodes ?? existing?.subNodes,
      priority: patch.priority ?? existing?.priority,
      estimatedTurns: patch.estimatedTurns ?? existing?.estimatedTurns,
      linkedCharacters: patch.linkedCharacters ?? existing?.linkedCharacters,
      tensionLevel: patch.tensionLevel ?? existing?.tensionLevel,
      targetTurn: patch.targetTurn ?? existing?.targetTurn,
    });
  }
  return Array.from(byIndex.values()).sort((a, b) => a.index - b.index);
}

function buildPatch(worldState: WorldState, proposal: OutlineRevisionDraft): Partial<WorldState> {
  const focused = ensureChapterFocus(worldState);
  const title = proposal.title || '纲要调整';
  const fromRoundtable = proposal.source === 'roundtable';
  const plan = normalizeLongFormPlan(focused.longFormPlan);
  const hasLongFormPatch = !fromRoundtable && objectHasKeys(proposal.longFormPlanPatch);
  const hasChapterPatch = objectHasKeys(proposal.currentChapterPatch);
  const hasPlotNodePatches = !fromRoundtable && Array.isArray(proposal.plotNodePatches) && proposal.plotNodePatches.length > 0;
  const longFormPlan = normalizeLongFormPlan({
    ...plan,
    ...(proposal.longFormPlanPatch ?? {}),
  });
  const currentChapter = hasChapterPatch && focused.currentChapter
    ? {
        ...focused.currentChapter,
        ...(proposal.currentChapterPatch ?? {}),
        manualOutline: true,
        outlineUpdatedAt: new Date().toISOString(),
        outlineRevisionNote: proposal.reason || title,
      }
    : undefined;
  const plotNodes = applyPlotNodePatches(focused.plotNodes, fromRoundtable ? [] : proposal.plotNodePatches);

  return {
    storyBibleNotes: mergeNotes(focused.storyBibleNotes, fromRoundtable ? '' : proposal.globalNotesAppend ?? '', title),
    ...(hasLongFormPatch ? { longFormPlan } : {}),
    ...(currentChapter ? { currentChapter } : {}),
    ...(hasPlotNodePatches && plotNodes ? { plotNodes } : {}),
    storyDesign: undefined,
  };
}

function currentChapterText(chapter?: ChapterFocus): string {
  if (!chapter) return '- 当前章未设置';
  return `第 ${chapter.chapterNo} 章《${chapter.title}》
目标：${chapter.goal}
范围：${chapter.scope}
阶段：${chapter.stage}
轮次：${chapter.targetTurns}
字数：${chapter.targetWordMin}-${chapter.targetWordMax}
绑定节点：${chapter.activeNodeIndexes?.join('、') || '-'}
节拍：
${chapter.beats?.map((beat, index) => `${index + 1}. ${beat}`).join('\n') || '-'}
护栏：
${chapter.constraints?.map((item) => `- ${item}`).join('\n') || '-'}`;
}

function planText(worldState: WorldState): string {
  const plan = normalizeLongFormPlan(worldState.longFormPlan);
  return `目标：${plan.targetWords} 字 / ${plan.targetChapters} 章
单章：${plan.chapterWordMin}-${plan.chapterWordMax} 字
承诺：${plan.promise}
卷规划：
${plan.volumes.length ? plan.volumes.map((volume) => `- 第${volume.index}卷《${volume.title}》：第${volume.chapterStart}-${volume.chapterEnd}章；${volume.purpose}`).join('\n') : '- 未生成'}
节奏纪律：
${plan.pacingPrinciples.map((item) => `- ${item}`).join('\n')}`;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const request = stringValue(body.request);
  const source = body.source === 'roundtable' ? 'roundtable' : 'manual';
  const requestedMode = revisionMode(body.mode);
  const mode = source === 'roundtable' ? 'chapter' : requestedMode;
  if (!request) {
    return NextResponse.json({ error: '请输入要调整的总纲/本章方向需求' }, { status: 400 });
  }

  try {
    const wm = new WorldManager(id);
    const { worldState, characters } = await wm.loadProject();
    const focused = ensureChapterFocus(worldState);
    const chapter = focused.currentChapter;
    const bibleInfo = storyBibleText(focused, { futureNodeLimit: 12 });
    const recentEvents = await wm.getRecentEvents(12);

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `你是 NovelStudio 的纲要修订会议，由剧情设计师、Director、设定审核共同给出“可应用的总纲/本章方向调整提案”。

你不是开发者，不要说“我会改代码”。你只能基于用户需求和当前创作圣经提出故事规划调整。

硬性要求：
1. 用户本次需求优先级最高，但不能悄悄覆盖已经落地正文事实；如需推翻正文，必须在 risks 中说明需要重写。
2. 区分总纲和本章方向：
   - 总纲：长篇承诺、卷规划、世界观补充、后续大节点、节奏纪律。
   - 本章方向：当前章标题、目标、范围、核心冲突、护栏、目标轮次、字数。
3. 不能凭空替用户硬编终局、神系、卷名；如果需要补，必须标明“建议/待用户确认”。
4. 修改本章方向要符合基础逻辑，尤其第一章应避免“平常放学”和“深渊已长期降临/成熟登记制度”同时出现。
5. 不要让当前章跨太远。当前章只服务本章目标，后续节点只能伏笔。
6. 输出 JSON，不要 markdown。
7. 如果用户说“不够精彩/想提升爽点/大纲平淡”，必须先按以下维度诊断并落到补丁里：
   - 开篇钩子：第一屏是否有日常基线、异常裂纹、不可逆变化。
   - 危机升级：每 3-5 章是否有小高潮、代价、奖励或新谜题。
   - 主角压迫：主角的短期困境是否具体可见，不只是“被排挤”四个字。
   - 爽点兑现：爽点不能只靠设定说明，要靠选择、反制、误判翻盘和关系变化。
   - 反转与悬念：每卷至少有持续问题，当前章至少有一个读者想翻页的问题。
   - 角色冲突：同学、旁观者、制度、怪物压力要能相互挤压，而不是各演各的。
   - 长线牵引：服务 100 万字以上体量，不要 10 章讲完主线，也不要提前摊开终局。
8. “精彩”不是简单增加打斗、掉落、装备、技能和大场面；必须保持当前阶段的信息权限和世界逻辑。
9. 不要默认生成死细纲。除非用户明确要求固定节拍/固定顺序，否则 currentChapterPatch 可以只改 title、goal、scope、stage、constraints，不要强行改 beats。
10. 如果用户需求中出现“必须落地 / 必须先修 / mustFix / 连续性审计 / 采纳时必须一并落地”，必须逐条进入可应用补丁：当前章问题进入 currentChapterPatch.constraints，执行动作进入 directorInstruction；只有非设计讨论采纳来源才允许把跨章节规则写入 globalNotesAppend；不得只写在 reason、opinion 或 risks 里。
11. 网游成长闭环是硬约束：击杀、首杀、任务完成、机制破解或有效贡献如果被用户点名需要反馈，currentChapterPatch.constraints 必须明确“正文要出现短促经验/等级/掉落/奖励反馈”，directorInstruction 必须要求 Director 同步人物状态 expDelta/掉落归档。
12. 当来源是设计讨论采纳（source=roundtable）时，只允许生成本章方向补丁：globalNotesAppend 必须为空，longFormPlanPatch 和 plotNodePatches 必须为空；讨论结论不得写入总纲/正典补充。

JSON 结构：
{
  "scope": "global|chapter|both",
  "title": "提案名",
  "reason": "为什么要这样调",
  "designerOpinion": "剧情设计师意见",
  "directorOpinion": "Director 意见",
  "auditorOpinion": "设定审核意见",
  "globalNotesAppend": "要追加到用户补充总纲里的内容；没有则空字符串",
  "longFormPlanPatch": {
    "targetWords": 1000000,
    "targetChapters": 400,
    "chapterWordMin": 2000,
    "chapterWordMax": 2800,
    "promise": "长篇承诺",
    "pacingPrinciples": ["节奏纪律"],
    "volumes": [{"index":1,"title":"待用户确认的卷名","purpose":"卷目标","chapterStart":1,"chapterEnd":40,"nodeIndexes":[1],"status":"active"}]
  },
  "currentChapterPatch": {
    "title": "当前章标题",
    "goal": "当前章目标",
    "scope": "当前章范围",
    "stage": "铺垫/冲突/章末钩子",
    "activeNodeIndexes": [1],
    "beats": ["节拍1"],
    "constraints": ["护栏1"],
    "targetTurns": 8,
    "targetWordMin": 2000,
    "targetWordMax": 2800
  },
  "plotNodePatches": [{"index":1,"title":"节点标题","description":"节点描述","nodeType":"main","completed":false,"estimatedTurns":8,"linkedCharacters":["角色名"]}],
  "directorInstruction": "应用后建议发给 Director 的一句执行指令",
  "risks": ["风险"]
}`,
      },
      {
        role: 'user',
        content: `# 用户要调整的范围
${mode}

# 来源
${source === 'roundtable' ? '设计讨论采纳：只改本章方向，不写总纲。' : '手动方向提案：可按用户选择修改总纲或本章。'}

# 用户需求
${request}

# 当前全局创作圣经
${bibleInfo}

# 当前长篇总纲
${planText(focused)}

# 当前章方向
${currentChapterText(chapter)}

# 当前剧情节点
${focused.plotNodes?.slice(0, 40).map((node) => `节点${node.index} [${node.nodeType ?? 'stage'}] ${node.title}：${node.description}；completed=${node.completed}`).join('\n') || '- 无'}

# 角色基础事实
${characters.map((character) => `- ${character.name}：${character.persona.gender ? `性别=${character.persona.gender}；` : ''}${character.persona.background ?? ''}`).join('\n') || '- 无'}

# 最近事件日志（低优先级，只能辅助定位）
${recentEvents.map((event) => `T${event.turn} ${event.agentName}: ${event.content}`).join('\n') || '- 无'}

# 任务
生成一份可以应用的纲要调整提案。`,
      },
    ];

    const raw = await chat(messages, { temperature: 0.55, maxTokens: 3200 });
    const parsed = extractJSON<OutlineRevisionDraft>(raw);
    if (!parsed) throw new Error('纲要调整提案解析失败');
    const proposal = source === 'roundtable'
      ? restrictRoundtableDraft(sanitizeDraft(parsed, chapter))
      : restrictDraftByMode(sanitizeDraft(parsed, chapter), mode);
    const patch = buildPatch(focused, proposal);

    return NextResponse.json({
      proposal: {
        id: `outline-revision-${Date.now()}`,
        request,
        mode,
        source,
        createdAt: new Date().toISOString(),
        ...proposal,
        patchPreview: patch,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: toLLMUserMessage(err) }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const rawProposal = (body.proposal ?? {}) as OutlineRevisionDraft;
  const source = body.source === 'roundtable' || rawProposal.source === 'roundtable' ? 'roundtable' : 'manual';
  const mode = source === 'roundtable'
    ? 'chapter'
    : revisionMode(body.mode ?? rawProposal.mode ?? rawProposal.scope);
  const proposal = source === 'roundtable'
    ? restrictRoundtableDraft(sanitizeDraft(rawProposal, undefined))
    : restrictDraftByMode(sanitizeDraft(rawProposal, undefined), mode);
  if (!hasApplicableRevision(proposal)) {
    return NextResponse.json({ error: '缺少可应用的纲要调整提案' }, { status: 400 });
  }

  try {
    const wm = new WorldManager(id);
    const { worldState } = await wm.loadProject();
    const focused = ensureChapterFocus(worldState);
    const sanitized = source === 'roundtable'
      ? restrictRoundtableDraft(sanitizeDraft(proposal, focused.currentChapter))
      : restrictDraftByMode(sanitizeDraft(proposal, focused.currentChapter), mode);
    const patch = buildPatch(focused, sanitized);
    const next = await wm.applyWorldPatch(patch);
    const chapterNo = focused.currentChapter?.chapterNo;
    const patchedTitle = normalizeChapterTitle(sanitized.currentChapterPatch?.title, chapterNo);
    if (typeof chapterNo === 'number' && patchedTitle) {
      await db.chapter.updateMany({
        where: { projectId: id, chapterNo },
        data: { chapterTitle: patchedTitle },
      });
    }
    return NextResponse.json({ ok: true, worldState: next, appliedPatch: patch });
  } catch (err) {
    return NextResponse.json({ error: toLLMUserMessage(err) }, { status: 500 });
  }
}
