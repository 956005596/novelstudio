/**
 * GET  /api/projects/[id]   获取项目详情（含角色、当前 world state）
 * DELETE /api/projects/[id] 删除项目
 * PATCH /api/projects/[id]  更新项目 (directorLvl 等)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { WorldManager, rowToCharacter } from '@/lib/novel/world-state';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await db.project.findUnique({
    where: { id },
    include: { characters: true },
  });
  if (!project) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const worldState = JSON.parse(project.worldState);
  const characters = project.characters.map(rowToCharacter);
  return NextResponse.json({
    project: {
      id: project.id,
      name: project.name,
      template: project.template,
      status: project.status,
      currentTurn: project.currentTurn,
      directorLvl: project.directorLvl,
      createdAt: project.createdAt,
      worldState,
    },
    characters,
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await db.project.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const updated = await db.project.update({
    where: { id },
    data: {
      ...(body.directorLvl !== undefined ? { directorLvl: Number(body.directorLvl) } : {}),
      ...(body.status ? { status: body.status } : {}),
    },
  });
  return NextResponse.json({ project: updated });
}
