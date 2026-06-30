/**
 * GET /api/projects         列出所有项目
 * POST /api/projects        创建新项目 { name, template }
 */

import { NextRequest, NextResponse } from 'next/server';
import { listProjects, createProject } from '@/lib/novel/world-state';

export async function GET() {
  const projects = await listProjects();
  return NextResponse.json({ projects });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const name = body.name?.trim();
  const template = body.template ?? 'online-game';
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }
  const id = await createProject(name, template);
  return NextResponse.json({ id });
}
