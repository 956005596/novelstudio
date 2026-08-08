/**
 * GET  /api/projects/[id]   获取项目详情（含角色、当前 world state）
 * DELETE /api/projects/[id] 删除项目
 * PATCH /api/projects/[id]  更新项目 (directorLvl 等)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { WorldManager, rowToCharacter } from '@/lib/novel/world-state';
import { ensureChapterFocus } from '@/lib/novel/chapter-focus';
import { ensureChapterCharacterSnapshot } from '@/lib/novel/chapter-character-snapshot';
import { normalizeAgentPolicy } from '@/lib/novel/agent-policy';

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
  let worldState = ensureChapterFocus(JSON.parse(project.worldState));
  if (!worldState.agentPolicy) {
    worldState = { ...worldState, agentPolicy: normalizeAgentPolicy() };
    await db.project.update({
      where: { id },
      data: { worldState: JSON.stringify(worldState) },
    });
  }
  const characters = project.characters.map(rowToCharacter);
  await ensureChapterCharacterSnapshot(id, worldState, characters);
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
  const data: Record<string, string | number> = {};

  if (body.name !== undefined) {
    const name = String(body.name ?? '').trim();
    if (!name) {
      return NextResponse.json({ error: '项目名不能为空' }, { status: 400 });
    }
    if (name.length > 80) {
      return NextResponse.json({ error: '项目名不能超过 80 个字符' }, { status: 400 });
    }
    data.name = name;
  }

  if (body.directorLvl !== undefined) {
    data.directorLvl = Number(body.directorLvl);
  }

  if (body.status) {
    data.status = String(body.status);
  }

  const updated = await db.project.update({
    where: { id },
    data,
  });
  return NextResponse.json({ project: updated });
}
