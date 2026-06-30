/**
 * GET  /api/projects/[id]/characters   列出角色
 * POST /api/projects/[id]/characters   添加角色
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { rowToCharacter } from '@/lib/novel/world-state';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const rows = await db.character.findMany({ where: { projectId: id } });
  return NextResponse.json({ characters: rows.map(rowToCharacter) });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const row = await db.character.create({
    data: {
      projectId: id,
      name: body.name,
      role: body.role ?? 'npc',
      persona: JSON.stringify(body.persona ?? {}),
      currentState: JSON.stringify(body.currentState ?? {}),
    },
  });
  return NextResponse.json({ character: rowToCharacter(row) });
}
