/**
 * POST /api/projects/[id]/chapters/[chapterId]/reviews
 * 用当前 Reader 标准重新评审某段正文，不重写正文。
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { runReaderReviews } from '@/lib/novel/agents/readers';
import { ensureChapterFocus } from '@/lib/novel/chapter-focus';
import { loadPreviousChapterBridge } from '@/lib/novel/chapter-continuity';
import type { WorldState } from '@/lib/novel/types';
import {
  WorldManager,
  rowToCharacter,
  rowToEvent,
  rowToReaderReview,
} from '@/lib/novel/world-state';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; chapterId: string }> }
) {
  const { id, chapterId } = await params;
  const project = await db.project.findUnique({
    where: { id },
    include: { characters: true },
  });
  if (!project) {
    return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  }

  const chapter = await db.chapter.findFirst({
    where: { id: chapterId, projectId: id },
  });
  if (!chapter) {
    return NextResponse.json({ error: '章节不存在' }, { status: 404 });
  }

  const worldState = ensureChapterFocus(JSON.parse(project.worldState) as WorldState);
  const characters = project.characters.map(rowToCharacter);
  const events = await db.event.findMany({
    where: {
      projectId: id,
      turn: {
        gt: chapter.startTurn,
        lte: chapter.endTurn,
      },
    },
    orderBy: { turn: 'asc' },
  });
  const previousChapterBridge = await loadPreviousChapterBridge(
    id,
    worldState,
    chapter.chapterNo ?? worldState.currentChapter?.chapterNo
  );
  const previousReviews = await db.readerReview.findMany({
    where: { projectId: id, chapterId },
    select: { id: true },
  });

  try {
    const reviews = await runReaderReviews(new WorldManager(id), {
      chapterId,
      sceneName: chapter.sceneName,
      sceneDescription: worldState.sceneDescription,
      chapterText: chapter.content,
      events: events.map(rowToEvent),
      characters,
      previousText: previousChapterBridge?.prompt,
      currentChapter: worldState.currentChapter,
    });
    if (previousReviews.length > 0) {
      await db.readerReview.deleteMany({
        where: { id: { in: previousReviews.map((review) => review.id) } },
      });
    }
    return NextResponse.json({ reviews });
  } catch (err: any) {
    const existing = await db.readerReview.findMany({
      where: { projectId: id, chapterId },
      orderBy: { createdAt: 'asc' },
    });
    return NextResponse.json(
      {
        error: err.message || '重新评审失败',
        reviews: existing.map(rowToReaderReview),
      },
      { status: 500 }
    );
  }
}
