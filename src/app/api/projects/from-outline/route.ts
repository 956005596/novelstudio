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

export const maxDuration = 120; // Vercel/serverless 超时配置

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const outline = body.outline?.trim();
  if (!outline) {
    return NextResponse.json({ error: '请输入大纲' }, { status: 400 });
  }
  if (outline.length < 10) {
    return NextResponse.json(
      { error: '大纲太短了，至少写 10 个字，让 AI 有足够信息生成世界' },
      { status: 400 }
    );
  }

  // 1. AI 解析大纲（内置重试，最多 5 次）
  let parsed;
  try {
    parsed = await parseOutline(outline);
  } catch (err: any) {
    console.error('[from-outline] 解析失败:', err.message);
    // 区分错误类型给用户更友好的提示
    const msg = err.message || '';
    let friendly = msg;
    if (/429|Too many requests|rate limit/i.test(msg)) {
      friendly = 'AI 服务当前繁忙（限流），请稍等 30 秒后重试';
    } else if (/AI 服务暂时不可用|网络|fetch|ECONN/i.test(msg)) {
      friendly = 'AI 服务暂时不可用，请稍后重试';
    } else if (/格式异常|缺少必要字段|未生成/i.test(msg)) {
      friendly = 'AI 输出格式异常，请换种描述方式重试（例如增加一些细节）';
    }
    return NextResponse.json(
      { error: friendly, detail: msg },
      { status: 500 }
    );
  }

  // 2. 确定项目名称
  const name =
    body.name?.trim() ||
    parsed.worldState.sceneName ||
    outline.slice(0, 20) + (outline.length > 20 ? '…' : '');

  // 3. 创建项目
  try {
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
  } catch (err: any) {
    console.error('[from-outline] 数据库写入失败:', err.message);
    return NextResponse.json(
      { error: '项目创建失败，请重试', detail: err.message },
      { status: 500 }
    );
  }
}
