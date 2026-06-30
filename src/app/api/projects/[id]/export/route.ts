/**
 * GET /api/projects/[id]/export?format=markdown|json
 * 导出整部小说为 Markdown 或 JSON
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const format = url.searchParams.get('format') ?? 'markdown';

  const project = await db.project.findUnique({
    where: { id },
    include: { chapters: { orderBy: { createdAt: 'asc' } } },
  });
  if (!project) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  if (format === 'json') {
    return NextResponse.json({
      title: project.name,
      template: project.template,
      chapters: project.chapters.map((c, i) => ({
        index: i + 1,
        sceneName: c.sceneName,
        content: c.content,
        wordCount: c.wordCount,
        startTurn: c.startTurn,
        endTurn: c.endTurn,
      })),
    });
  }

  // markdown
  const md = [
    `# ${project.name}`,
    '',
    `> 风格模板：${project.template} · 共 ${project.chapters.length} 章 · 总字数 ${project.chapters.reduce((s, c) => s + c.wordCount, 0)}`,
    '',
    ...project.chapters.flatMap((c, i) => [
      `## 第 ${i + 1} 章 · ${c.sceneName}`,
      '',
      c.content,
      '',
    ]),
  ].join('\n');

  return new NextResponse(md, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(project.name)}.md"`,
    },
  });
}
