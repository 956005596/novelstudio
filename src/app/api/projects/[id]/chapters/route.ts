/**
 * GET /api/projects/[id]/chapters   列出所有章节
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const chapters = await db.chapter.findMany({
    where: { projectId: id },
    orderBy: { createdAt: 'asc' },
  });
  return NextResponse.json({
    chapters: chapters.map((c) => ({
      id: c.id,
      sceneName: c.sceneName,
      content: c.content,
      wordCount: c.wordCount,
      startTurn: c.startTurn,
      endTurn: c.endTurn,
      createdAt: c.createdAt,
    })),
  });
}
