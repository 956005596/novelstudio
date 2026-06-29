/**
 * GET /api/projects/[id]/events   列出事件（可分页）
 *   query: limit (default 200), fromTurn
 */

import { NextRequest, NextResponse } from 'next/server';
import { WorldManager, rowToEvent } from '@/lib/novel/world-state';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get('limit') ?? 200);
  const fromTurn = Number(url.searchParams.get('fromTurn') ?? 0);

  const wm = new WorldManager(id);
  const events = await wm.getEvents(limit, fromTurn);
  return NextResponse.json({ events });
}
