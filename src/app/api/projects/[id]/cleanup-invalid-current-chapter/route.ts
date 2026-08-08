/**
 * POST /api/projects/[id]/cleanup-invalid-current-chapter
 *
 * 维护清理：保留当前章最新正文稿，删除当前章旧演绎事件、历史稿和旧评审。
 * 只有用户显式触发这个接口才会删库；Agent 只能提出清理建议。
 */

import { NextRequest, NextResponse } from 'next/server';
import { cleanupInvalidCurrentChapterData } from '@/lib/novel/cleanup-invalid-current-chapter';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const result = await cleanupInvalidCurrentChapterData(id);
    return NextResponse.json({ ok: true, result });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err.message || '清理失效演绎失败' },
      { status: err.message === '项目不存在' ? 404 : 500 }
    );
  }
}
