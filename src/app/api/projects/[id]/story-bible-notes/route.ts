/**
 * PUT /api/projects/[id]/story-bible-notes
 * 保存用户补充总纲。走 REST 落盘，不依赖演绎引擎 socket。
 */

import { NextRequest, NextResponse } from 'next/server';
import { WorldManager } from '@/lib/novel/world-state';
import { toLLMUserMessage } from '@/lib/novel/llm';

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const storyBibleNotes = String(body.storyBibleNotes ?? '').trim();
  const patch: Record<string, unknown> = {};
  if (body.storyBibleNotes !== undefined) patch.storyBibleNotes = storyBibleNotes;
  if (typeof body.writerHint === 'string') patch.writerHint = body.writerHint.trim();

  try {
    const wm = new WorldManager(id);
    const next = await wm.applyWorldPatch({ ...patch, storyDesign: undefined });
    return NextResponse.json({ ok: true, worldState: next });
  } catch (err) {
    return NextResponse.json({ error: toLLMUserMessage(err) }, { status: 500 });
  }
}
