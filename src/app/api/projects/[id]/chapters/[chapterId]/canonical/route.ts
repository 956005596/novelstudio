/**
 * POST /api/projects/[id]/chapters/[chapterId]/canonical
 * 将某个章节草稿选定为本章正稿。不会删除历史稿。
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureChapterFocus } from '@/lib/novel/chapter-focus';
import { withCanonicalChapterId } from '@/lib/novel/canonical-chapter';
import type { WorldState } from '@/lib/novel/types';

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
  const chapterNo = chapter.chapterNo ?? worldState.currentChapter?.chapterNo ?? 1;
  const nextWorldState = withCanonicalChapterId(worldState, chapterNo, chapter.id);

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
      chapterTitle: chapter.chapterTitle,
      wordCount: chapter.wordCount,
    },
  });
}
