/**
 * POST /api/projects/[id]/chapters/[chapterId]/focus
 * 将某个已落地章节设为当前设计焦点，便于重新设计旧章。
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureChapterFocus } from '@/lib/novel/chapter-focus';
import { normalizeChapterTitle } from '@/lib/novel/chapter-title';
import {
  CHAPTER_WORD_TARGET_MAX,
  CHAPTER_WORD_TARGET_MIN,
} from '@/lib/novel/chapter-policy';
import type { ChapterFocus, WorldState } from '@/lib/novel/types';

function numberValue(value: unknown, fallback: number, min = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.floor(parsed)) : fallback;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; chapterId: string }> }
) {
  const { id, chapterId } = await params;

  const chapter = await db.chapter.findFirst({
    where: { id: chapterId, projectId: id },
  });
  if (!chapter) {
    return NextResponse.json({ error: '章节草稿不存在' }, { status: 404 });
  }

  const project = await db.project.findUnique({ where: { id } });
  if (!project) {
    return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  }

  const worldState = ensureChapterFocus(JSON.parse(project.worldState) as WorldState);
  const previousFocus = worldState.currentChapter;
  const chapterNo = numberValue(chapter.chapterNo, previousFocus?.chapterNo ?? 1, 1);
  const title = normalizeChapterTitle(
    chapter.chapterTitle || chapter.sceneName,
    chapterNo
  ) || `第 ${chapterNo} 章`;
  const targetWordMin =
    previousFocus?.chapterNo === chapterNo
      ? previousFocus.targetWordMin
      : worldState.longFormPlan?.chapterWordMin ?? CHAPTER_WORD_TARGET_MIN;
  const targetWordMax =
    previousFocus?.chapterNo === chapterNo
      ? previousFocus.targetWordMax
      : worldState.longFormPlan?.chapterWordMax ?? CHAPTER_WORD_TARGET_MAX;
  const targetTurns =
    previousFocus?.chapterNo === chapterNo
      ? previousFocus.targetTurns
      : Math.max(6, Math.min(10, numberValue((chapter.endTurn ?? 0) - (chapter.startTurn ?? 0), 8, 1)));
  const currentChapter: ChapterFocus = {
    chapterNo,
    title,
    goal:
      previousFocus?.chapterNo === chapterNo
        ? previousFocus.goal
        : `重新设计第 ${chapterNo} 章《${title}》：先审视现有正稿的因果、爽点、连续性和章节钩子，再决定章名、目标、范围和正文修正方式。`,
    scope:
      previousFocus?.chapterNo === chapterNo
        ? previousFocus.scope
        : '只处理该章与必要前后文衔接；不把设计讨论写入总纲；如果会影响后续已落地章节，必须列出需要同步回修的章节。',
    stage: '重设计',
    startTurn: worldState.turn,
    activeNodeIndexes: previousFocus?.chapterNo === chapterNo ? previousFocus.activeNodeIndexes : [],
    targetTurns,
    targetWordMin,
    targetWordMax,
    beats:
      previousFocus?.chapterNo === chapterNo
        ? previousFocus.beats
        : [
            '先指出旧稿最主要的问题：因果、爽点、节奏、连续性或设定权限。',
            '只重排当前章应承担的剧情功能，不把后续大节点提前兑现。',
            '明确哪些内容保留、哪些内容重写、哪些内容需要和前后章节衔接。',
            '章末必须留下一个读者愿意继续看的问题或压力。',
          ],
    constraints:
      previousFocus?.chapterNo === chapterNo
        ? previousFocus.constraints
        : [
            '章节目录里的当前正稿是旧稿基线，设计讨论必须先读旧稿再提修改。',
            '旧稿不会因为切换设计焦点自动删除；只有“修正当前稿/重置本章”才会产生新稿或清空旧数据。',
            '不得把已采纳设计讨论写入总纲。',
            '如果修改会影响后续已落地章节，必须在风险中列出回修范围。',
          ],
    manualOutline: true,
    outlineUpdatedAt: new Date().toISOString(),
    outlineRevisionNote: '从章节目录切换为重新设计焦点',
  };

  const nextWorldState = ensureChapterFocus({
    ...worldState,
    currentChapter,
    storyDesign: undefined,
  });

  await db.project.update({
    where: { id },
    data: {
      worldState: JSON.stringify(nextWorldState),
      currentTurn: nextWorldState.turn,
    },
  });

  return NextResponse.json({
    ok: true,
    worldState: nextWorldState,
    chapter: {
      id: chapter.id,
      chapterNo,
      chapterTitle: title,
      wordCount: chapter.wordCount,
    },
  });
}
