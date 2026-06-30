/**
 * POST /api/projects/from-outline
 * body: { outline: string, name?: string }
 *
 * AI 解析大纲 → 创建项目（World State + 角色 + plotNodes）
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { parseOutline } from '@/lib/novel/agents/outline-parser';
import type { WorldState } from '@/lib/novel/types';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const outline = body.outline?.trim();
  if (!outline) {
    return NextResponse.json({ error: 'outline is required' }, { status: 400 });
  }

  // 1. AI 解析大纲
  let parsed;
  try {
    parsed = await parseOutline(outline);
  } catch (err: any) {
    return NextResponse.json(
      { error: `大纲解析失败: ${err.message}` },
      { status: 500 }
    );
  }

  // 2. 确定项目名称
  const name =
    body.name?.trim() ||
    parsed.worldState.sceneName ||
    outline.slice(0, 20) + (outline.length > 20 ? '…' : '');

  // 3. 创建项目
  const project = await db.project.create({
    data: {
      name,
      template: parsed.templateKey,
      worldState: JSON.stringify(parsed.worldState),
      status: 'setup',
    },
  });

  // 4. 创建角色 + 回填 presentCharacterIds
  const characterIds: string[] = [];
  for (const c of parsed.characters) {
    const row = await db.character.create({
      data: {
        projectId: project.id,
        name: c.name,
        role: c.role,
        persona: JSON.stringify(c.persona),
        currentState: JSON.stringify(c.currentState),
      },
    });
    characterIds.push(row.id);
  }

  // 5. 更新 World State 的 presentCharacterIds
  const finalWorld: WorldState = {
    ...parsed.worldState,
    presentCharacterIds: characterIds,
  };
  await db.project.update({
    where: { id: project.id },
    data: { worldState: JSON.stringify(finalWorld) },
  });

  return NextResponse.json({
    id: project.id,
    name,
    template: parsed.templateKey,
    templateReason: parsed.templateReason,
    writerHint: parsed.writerHint,
    characterCount: characterIds.length,
    plotNodeCount: parsed.plotNodes.length,
  });
}
