/**
 * POST /api/projects/[id]/reset-current-chapter
 *
 * 只重置当前章节：
 *   - 删除当前章 startTurn 之后的事件日志
 *   - 删除当前章对应的 Writer 正文和读者评审
 *   - 清空本章导演设计与当前章经验总结
 *   - 将 World State 回到当前章起点
 *
 * 保留：前面章节、项目设定、角色档案、世界观、剧情节点历史。
 */

import { NextRequest, NextResponse } from 'next/server';
import { resetCurrentChapterData } from '@/lib/novel/reset-current-chapter';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const result = await resetCurrentChapterData(id);
    return NextResponse.json({ ok: true, result });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err.message || '重置当前章节失败' },
      { status: err.message === '项目不存在' ? 404 : 500 }
    );
  }
}
