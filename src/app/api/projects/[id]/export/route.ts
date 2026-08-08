/**
 * GET /api/projects/[id]/export?format=markdown|json
 * 导出整部小说为 Markdown 或 JSON
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { countReadableChars } from '@/lib/novel/chapter-text';
import { ensureChapterFocus } from '@/lib/novel/chapter-focus';
import { pickCanonicalDraft } from '@/lib/novel/canonical-chapter';
import type { WorldState } from '@/lib/novel/types';

type ChapterRow = {
  id: string;
  chapterNo: number | null;
  chapterTitle: string | null;
  sceneName: string;
  content: string;
  wordCount: number;
  startTurn: number;
  endTurn: number;
  createdAt: Date;
};

function selectedChapterDrafts(chapters: ChapterRow[], worldState: WorldState): ChapterRow[] {
  const grouped = new Map<string, ChapterRow[]>();
  for (const chapter of chapters) {
    const chapterNo = Number(chapter.chapterNo ?? 1) || 1;
    const key = String(chapterNo);
    const list = grouped.get(key) ?? [];
    list.push(chapter);
    grouped.set(key, list);
  }

  return Array.from(grouped.values())
    .map((drafts) => {
      const sorted = drafts.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return pickCanonicalDraft(sorted, worldState, sorted[0]?.chapterNo) ?? sorted[0];
    })
    .filter(Boolean)
    .sort((a, b) => Number(a.chapterNo ?? 1) - Number(b.chapterNo ?? 1));
}

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
  const worldState = ensureChapterFocus(JSON.parse(project.worldState) as WorldState);
  const chapters = selectedChapterDrafts(project.chapters, worldState);

  if (format === 'json') {
    return NextResponse.json({
      title: project.name,
      template: project.template,
      chapters: chapters.map((c, i) => ({
        index: i + 1,
        chapterNo: c.chapterNo,
        chapterTitle: c.chapterTitle,
        sceneName: c.sceneName,
        content: c.content,
        wordCount: countReadableChars(c.content),
        startTurn: c.startTurn,
        endTurn: c.endTurn,
      })),
    });
  }

  // markdown
  const md = [
    `# ${project.name}`,
    '',
    `> 风格模板：${project.template} · 共 ${chapters.length} 章 · 总字数 ${chapters.reduce((s, c) => s + countReadableChars(c.content), 0)}`,
    '',
    ...chapters.flatMap((c, i) => [
      `## 第 ${c.chapterNo ?? i + 1} 章 · ${c.chapterTitle ?? c.sceneName}`,
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
