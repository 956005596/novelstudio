import { db } from '@/lib/db';
import { countReadableChars } from './chapter-text';
import { pickCanonicalDraft } from './canonical-chapter';
import type { WorldState } from './types';

export interface ChapterBridgeContext {
  chapterNo: number;
  chapterTitle: string;
  wordCount: number;
  head: string;
  tail: string;
  prompt: string;
}

function clipHead(text: string, max = 800): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

function clipTail(text: string, max = 1400): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(-max);
}

export function renderChapterBridgeForPrompt(ctx?: ChapterBridgeContext | null): string {
  if (!ctx) return '- 无上一章正稿。若当前不是第一章，必须先确认上一章正稿是否存在。';
  return ctx.prompt;
}

export async function loadPreviousChapterBridge(
  projectId: string,
  worldState: WorldState,
  currentChapterNo?: number | null
): Promise<ChapterBridgeContext | null> {
  const chapterNo = Number(currentChapterNo ?? worldState.currentChapter?.chapterNo ?? 1);
  if (!Number.isFinite(chapterNo) || chapterNo <= 1) return null;
  const previousNo = chapterNo - 1;
  const drafts = await db.chapter.findMany({
    where: { projectId, chapterNo: previousNo },
    orderBy: { createdAt: 'desc' },
    take: 12,
  });
  const chapter = pickCanonicalDraft(drafts, worldState, previousNo);
  if (!chapter?.content?.trim()) return null;

  const title = chapter.chapterTitle ?? chapter.sceneName ?? `第 ${previousNo} 章`;
  const wordCount = chapter.wordCount || countReadableChars(chapter.content);
  const head = clipHead(chapter.content);
  const tail = clipTail(chapter.content);
  const prompt = `# 上一章正稿接续锚点（硬事实）
第 ${previousNo} 章《${title}》，可读字数 ${wordCount}

## 上一章开头参考
${head}

## 上一章结尾硬锚点
${tail}

## 章际接续要求
- 当前章开头必须从上一章结尾的时间、地点、人物位置、角色心理和公开信息接住。
- 若当前章需要跳到战斗、裂隙、广播台、台阶、安置点或安全区，必须先写清：间隔多久、角色怎么过去、什么事件把人群推到那里、谁先发现危险。
- 不能直接以“怪物已在打、砖头已砸下、台阶已被围住”开场，除非上一章结尾已经明确进入该战斗现场。
- 若事件日志已经跳到后续场面，Writer 需要在正文开头补一段章际桥：上一章余波 -> 当前场景变化 -> 新危机出现 -> 主角被迫行动。`;

  return {
    chapterNo: previousNo,
    chapterTitle: title,
    wordCount,
    head,
    tail,
    prompt,
  };
}
