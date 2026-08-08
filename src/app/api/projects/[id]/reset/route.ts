/**
 * POST /api/projects/[id]/reset
 *
 * 重置项目演绎状态：
 *   - 清空所有事件日志（Event）
 *   - 清空所有已生成章节（Chapter）
 *   - 清空所有读者评审（ReaderReview）
 *   - 清空所有用户指令（Directive）
 *   - 重置 World State：turn=0, tension=初始值, 保留 worldLore/plotNodes/角色关系/场景
 *   - 重置角色 currentState 回到初始情绪/位置（保留 persona 不变）
 *
 * 保留：项目本身、角色 persona（背景故事/性格/目标）、世界观设定、剧情节点模板
 * 这样用户可以基于同一设定重新演绎，观察不同的故事走向
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import type { WorldState, CharacterState } from '@/lib/novel/types';
import { ensureChapterFocus } from '@/lib/novel/chapter-focus';
import { expRequiredForNextLevel } from '@/lib/novel/progression';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const project = await db.project.findUnique({
    where: { id },
    include: { characters: true },
  });
  if (!project) {
    return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  }

  // 1. 清空事件、章节、指令
  await Promise.all([
    db.event.deleteMany({ where: { projectId: id } }),
    db.readerReview.deleteMany({ where: { projectId: id } }),
    db.chapter.deleteMany({ where: { projectId: id } }),
    db.directive.deleteMany({ where: { projectId: id } }),
  ]);

  // 2. 重置 World State
  const ws = ensureChapterFocus(JSON.parse(project.worldState) as WorldState);
  const resetWs: WorldState = ensureChapterFocus({
    ...ws,
    turn: 0,
    tension: 3,
    worldFlags: {},
    storyDesign: undefined,
    pacingMode: ws.pacingMode ?? 'slow',
    turnsSinceLastMain: 0,
    currentMainNodeIndex: 0,
    plotNodes: ws.plotNodes?.map(n => ({ ...n, completed: false })),
  });

  await db.project.update({
    where: { id },
    data: {
      worldState: JSON.stringify(resetWs),
      currentTurn: 0,
      status: 'setup',
    },
  });

  // 3. 重置角色 currentState（情绪回到"平静"，位置回到场景初始位置）
  for (const c of project.characters) {
    const state = JSON.parse(c.currentState) as CharacterState;
    const resetState: CharacterState = {
      ...state,
      emotion: '平静',
      location: resetWs.location,
      hp: state.hp ?? 100,
      mp: state.mp ?? 50,
      exp: state.exp ?? 0,
      nextLevelExp: state.nextLevelExp ?? expRequiredForNextLevel(state.level),
      buffs: [],
    };
    await db.character.update({
      where: { id: c.id },
      data: { currentState: JSON.stringify(resetState) },
    });
  }

  return NextResponse.json({
    ok: true,
    message: '项目已重置',
    reset: {
      eventsDeleted: true,
      chaptersDeleted: true,
      readerReviewsDeleted: true,
      directivesDeleted: true,
      turnReset: 0,
      tensionReset: 3,
      characterStatesReset: project.characters.length,
    },
  });
}
