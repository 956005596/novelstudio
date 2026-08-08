/**
 * POST /api/projects/[id]/sync-story-bible
 * 把用户补充总纲同步成可执行的卷规划、剧情节点和当前章细纲。
 */

import { NextRequest, NextResponse } from 'next/server';
import { chat, extractJSON, toLLMUserMessage, type ChatMessage } from '@/lib/novel/llm';
import { ensureChapterFocus } from '@/lib/novel/chapter-focus';
import { normalizeLongFormPlan } from '@/lib/novel/long-form-plan';
import { WorldManager } from '@/lib/novel/world-state';
import type { ChapterFocus, LongFormPlan, PlotNode, WorldState } from '@/lib/novel/types';

interface SyncDraft {
  longFormPlan?: Partial<LongFormPlan>;
  plotNodes?: Partial<PlotNode>[];
  currentChapter?: Partial<ChapterFocus>;
  summary?: string;
  risks?: string[];
}

const CHAPTER_WORD_MIN = 2000;
const CHAPTER_WORD_MAX = 2800;

function stringValue(value: unknown, fallback = ''): string {
  return String(value ?? fallback).trim();
}

function numberValue(value: unknown, fallback: number, min = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.floor(parsed)) : fallback;
}

function stringArray(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, limit)
    : [];
}

function sanitizePlotNodes(value: unknown, existing: PlotNode[] = []): PlotNode[] {
  if (!Array.isArray(value)) return existing;
  const nodes = value
    .map((item, index): PlotNode | null => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const input = item as Partial<PlotNode>;
      const nodeType =
        input.nodeType === 'main' || input.nodeType === 'sub' || input.nodeType === 'foreshadow' || input.nodeType === 'daily'
          ? input.nodeType
          : 'main';
      const title = stringValue(input.title, `节点${index + 1}`);
      const description = stringValue(input.description);
      if (!title || !description) return null;
      return {
        index: numberValue(input.index, index + 1, 1),
        title,
        description,
        nodeType,
        priority: numberValue(input.priority, nodeType === 'main' ? 5 : 3, 1),
        estimatedTurns: numberValue(input.estimatedTurns, nodeType === 'main' ? 10 : 5, 1),
        targetTurn: input.targetTurn === undefined ? index * 6 + 1 : numberValue(input.targetTurn, index * 6 + 1, 0),
        linkedCharacters: stringArray(input.linkedCharacters, 12),
        tensionLevel: numberValue(input.tensionLevel, nodeType === 'daily' ? 2 : 5, 0),
        subNodes: stringArray(input.subNodes, 12),
        completed: Boolean(input.completed),
      };
    })
    .filter(Boolean) as PlotNode[];

  if (nodes.length < 12) return existing;
  nodes.sort((a, b) => (a.targetTurn ?? 0) - (b.targetTurn ?? 0));
  return nodes.slice(0, 90).map((node, index) => ({ ...node, index: index + 1 }));
}

function sanitizeChapter(value: unknown, current: ChapterFocus | undefined, nodes: PlotNode[]): ChapterFocus | undefined {
  const firstOpenNode = nodes.find((node) => !node.completed) ?? nodes[0];
  if (!current && !firstOpenNode) return undefined;
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<ChapterFocus>
    : {};
  const chapterNo = numberValue(input.chapterNo, current?.chapterNo ?? 1, 1);
  const activeNodeIndexes = Array.isArray(input.activeNodeIndexes)
    ? input.activeNodeIndexes.map(Number).filter((item) => Number.isFinite(item) && item > 0).slice(0, 8)
    : firstOpenNode ? [firstOpenNode.index] : current?.activeNodeIndexes ?? [];
  return {
    chapterNo,
    title: stringValue(input.title, current?.title ?? firstOpenNode?.title ?? '未命名章节'),
    goal: stringValue(input.goal, current?.goal ?? firstOpenNode?.description ?? ''),
    scope: stringValue(input.scope, current?.scope ?? '只推进当前章目标，后续节点只作伏笔。'),
    stage: stringValue(input.stage, current?.stage ?? '铺垫'),
    startTurn: current?.startTurn,
    activeNodeIndexes,
    beats: stringArray(input.beats, 12).length
      ? stringArray(input.beats, 12)
      : current?.beats ?? [
          '建立本章场面压力和角色短期目标。',
          '用外部事件迫使主角做选择。',
          '让选择带来可见代价或阶段性收益。',
          '章末留下下一章必须继续读的问题。',
        ],
    constraints: stringArray(input.constraints, 16).length
      ? stringArray(input.constraints, 16)
      : current?.constraints ?? [
          '只围绕当前章任务推进。',
          '后续大节点只能伏笔，不能直接兑现。',
          '角色不得知道尚未通过剧情获得的信息。',
        ],
    targetTurns: numberValue(input.targetTurns, current?.targetTurns ?? firstOpenNode?.estimatedTurns ?? 8, 1),
    targetWordMin: numberValue(input.targetWordMin, current?.targetWordMin ?? CHAPTER_WORD_MIN, 300),
    targetWordMax: numberValue(input.targetWordMax, current?.targetWordMax ?? CHAPTER_WORD_MAX, 300),
    manualOutline: true,
    outlineUpdatedAt: new Date().toISOString(),
    outlineRevisionNote: '由用户补充总纲同步生成',
  };
}

function sanitizePlan(value: unknown, existing: LongFormPlan | undefined, nodeCount: number): LongFormPlan {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<LongFormPlan> : {};
  return normalizeLongFormPlan({
    ...existing,
    ...raw,
    targetChapters: raw.targetChapters ?? existing?.targetChapters ?? 800,
    targetWords: raw.targetWords ?? existing?.targetWords ?? 2_000_000,
    volumes: Array.isArray(raw.volumes)
      ? raw.volumes.map((volume, index) => ({
          index: numberValue(volume?.index, index + 1, 1),
          title: stringValue(volume?.title, `第 ${index + 1} 卷`),
          purpose: stringValue(volume?.purpose, '待补充卷目标'),
          chapterStart: numberValue(volume?.chapterStart, index * 60 + 1, 1),
          chapterEnd: numberValue(volume?.chapterEnd, (index + 1) * 60, 1),
          nodeIndexes: Array.isArray(volume?.nodeIndexes)
            ? volume.nodeIndexes.map(Number).filter((item) => Number.isFinite(item) && item > 0).slice(0, nodeCount)
            : [],
          status: volume?.status === 'done' || volume?.status === 'active' ? volume.status : index === 0 ? 'active' : 'pending',
        }))
      : existing?.volumes,
  });
}

function worldBrief(worldState: WorldState): string {
  return [
    `当前章：第 ${worldState.currentChapter?.chapterNo ?? 1} 章《${worldState.currentChapter?.title ?? '未命名'}》`,
    `当前章目标：${worldState.currentChapter?.goal ?? '-'}`,
    `旧执行节点数：${worldState.plotNodes?.length ?? 0}`,
    `已完成节点：${worldState.plotNodes?.filter((node) => node.completed).map((node) => `${node.index}.${node.title}`).join('、') || '-'}`,
    `已有卷规划：${worldState.longFormPlan?.volumes?.map((volume) => `第${volume.index}卷《${volume.title}》${volume.chapterStart}-${volume.chapterEnd}章`).join('；') || '-'}`,
  ].join('\n');
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const wm = new WorldManager(id);
    const { worldState } = await wm.loadProject();
    const focused = ensureChapterFocus(worldState);
    const notes = stringValue(focused.storyBibleNotes);
    if (notes.length < 50) {
      return NextResponse.json({ error: '用户补充总纲太少，无法同步为执行节点' }, { status: 400 });
    }

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `你是 NovelStudio 的总纲同步 Agent。你的任务是把用户补充总纲同步成可执行结构。

硬规则：
1. 用户补充总纲是最高优先级，旧执行节点只能参考，不能覆盖新正典。
2. plotNodes 是阶段执行节点，不是一章一个节点。必须生成 36-72 个节点，支撑长篇连载。
3. longFormPlan 必须包含卷规划。卷规划来自用户总纲，不要写产品默认设定。
4. currentChapter 只写当前章细纲，不能提前揭开后期真相。
5. 保留已完成节点的历史事实感，但如果旧节点明显过时，可以用新标题/描述重写，不要继续沿用错误内容。
6. 输出严格 JSON，不要 markdown，不要解释。

JSON 结构：
{
  "summary": "同步说明",
  "longFormPlan": {
    "targetWords": 2000000,
    "minWords": 1000000,
    "targetChapters": 800,
    "chapterWordMin": 2000,
    "chapterWordMax": 2800,
    "promise": "长篇承诺",
    "pacingPrinciples": ["节奏纪律"],
    "volumes": [{"index":1,"title":"卷名","purpose":"卷目标","chapterStart":1,"chapterEnd":70,"nodeIndexes":[1,2,3],"status":"active"}]
  },
  "plotNodes": [
    {
      "index": 1,
      "title": "节点标题",
      "description": "80-180字，说明阶段目标、关键冲突、爽点或伏笔",
      "nodeType": "main|sub|foreshadow|daily",
      "priority": 1,
      "estimatedTurns": 8,
      "targetTurn": 1,
      "linkedCharacters": ["角色名"],
      "tensionLevel": 5,
      "subNodes": ["子阶段"],
      "completed": false
    }
  ],
  "currentChapter": {
    "chapterNo": 2,
    "title": "当前章标题",
    "goal": "当前章目标",
    "scope": "当前章范围",
    "stage": "铺垫/冲突/章末钩子",
    "activeNodeIndexes": [1],
    "beats": ["本章节拍"],
    "constraints": ["设定护栏"],
    "targetTurns": 8,
    "targetWordMin": 2000,
    "targetWordMax": 2800
  },
  "risks": ["需要用户确认或重写的风险"]
}`,
      },
      {
        role: 'user',
        content: `# 当前项目状态
${worldBrief(focused)}

# 用户补充总纲 / 正典设定
"""
${notes}
"""

# 旧执行节点
${focused.plotNodes?.map((node) => `${node.index}. ${node.title}：${node.description}；completed=${node.completed}`).join('\n') || '- 无'}

请同步为 longFormPlan、plotNodes、currentChapter。`,
      },
    ];

    const raw = await chat(messages, { temperature: 0.45, maxTokens: 7000 });
    const parsed = extractJSON<SyncDraft>(raw);
    if (!parsed) throw new Error('总纲同步结果解析失败');

    const plotNodes = sanitizePlotNodes(parsed.plotNodes, focused.plotNodes ?? []);
    const longFormPlan = sanitizePlan(parsed.longFormPlan, focused.longFormPlan, plotNodes.length);
    const currentChapter = sanitizeChapter(parsed.currentChapter, focused.currentChapter, plotNodes);

    const next = await wm.applyWorldPatch({
      longFormPlan,
      plotNodes,
      ...(currentChapter ? { currentChapter } : {}),
      storyDesign: undefined,
    });

    return NextResponse.json({
      ok: true,
      worldState: next,
      summary: stringValue(parsed.summary, '已将用户补充总纲同步为执行结构'),
      risks: stringArray(parsed.risks, 12),
      nodeCount: plotNodes.length,
      volumeCount: longFormPlan.volumes.length,
    });
  } catch (err) {
    return NextResponse.json({ error: toLLMUserMessage(err) }, { status: 500 });
  }
}
