/**
 * PUT /api/projects/[id]/director-lvl   设置 Director 强度等级
 * body: { level: 1-5 }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const level = Math.max(1, Math.min(5, Number(body.level) || 3));
  await db.project.update({
    where: { id },
    data: { directorLvl: level },
  });
  return NextResponse.json({ level });
}
