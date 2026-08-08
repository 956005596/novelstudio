import { db } from '../db';
import { ensureChapterFocus } from './chapter-focus';
import { pickCanonicalDraft, withCanonicalChapterId } from './canonical-chapter';
import type { WorldState } from './types';

export interface CleanupInvalidCurrentChapterResult {
  worldState: WorldState;
  chapterNo: number;
  chapterTitle: string;
  keptChapterId: string | null;
  deletedEvents: number;
  deletedChapterDrafts: number;
  deletedReaderReviews: number;
  rejectedDirectives: number;
  deletedRoundtableEntries: number;
}

export async function cleanupInvalidCurrentChapterData(
  projectId: string
): Promise<CleanupInvalidCurrentChapterResult> {
  const project = await db.project.findUnique({
    where: { id: projectId },
  });
  if (!project) throw new Error('项目不存在');

  const worldState = ensureChapterFocus(JSON.parse(project.worldState) as WorldState);
  const chapter = worldState.currentChapter;
  if (!chapter) throw new Error('当前章节不存在');

  const chapterNo = chapter.chapterNo;
  const chapterDrafts = await db.$queryRawUnsafe<Array<{
    id: string;
    chapterTitle: string | null;
    endTurn: number;
    chapterNo: number | null;
  }>>(
    `SELECT "id", "chapterNo", "chapterTitle", "endTurn"
       FROM "Chapter"
      WHERE "projectId" = ?
        AND COALESCE("chapterNo", ?) = ?
      ORDER BY "updatedAt" DESC, "createdAt" DESC`,
    projectId,
    chapterNo,
    chapterNo
  );
  const currentDraft = pickCanonicalDraft(chapterDrafts, worldState, chapterNo) ?? null;
  const staleDraftIds = chapterDrafts.filter((draft) => draft.id !== currentDraft?.id).map((draft) => draft.id);

  let deletedReaderReviews = 0;
  let deletedChapterDrafts = 0;
  if (staleDraftIds.length > 0) {
    const reviewResult = await db.readerReview.deleteMany({
      where: { projectId, chapterId: { in: staleDraftIds } },
    });
    deletedReaderReviews = reviewResult.count;

    const chapterResult = await db.chapter.deleteMany({
      where: { id: { in: staleDraftIds } },
    });
    deletedChapterDrafts = chapterResult.count;
  }

  const startTurn =
    typeof chapter.startTurn === 'number'
      ? chapter.startTurn
      : chapter.chapterNo === 1
        ? 0
        : worldState.turn;
  const keepTurn = currentDraft?.endTurn ?? startTurn;
  const eventResult = await db.event.deleteMany({
    where: {
      projectId,
      turn: {
        gt: startTurn,
      },
    },
  });
  // 清理失效演绎时，未消费的导演指令一并停用，避免旧对话继续注入新生成。
  const directiveResult = await db.directive.updateMany({
    where: {
      projectId,
      chapterNo,
      status: 'pending',
    },
    data: { status: 'rejected' },
  });
  let deletedRoundtableEntries = 0;
  try {
    const roundtableRows = await db.$queryRawUnsafe<Array<{ id: string; payload: string }>>(
      `SELECT "id", "payload" FROM "RoundtableEntry" WHERE "projectId" = ?`,
      projectId
    );
    const roundtableIds: string[] = [];
    for (const row of roundtableRows) {
      try {
        const parsed = JSON.parse(row.payload) as { chapterNo?: number };
        if (parsed.chapterNo === chapterNo) roundtableIds.push(row.id);
      } catch {
        // 单条 payload 损坏时跳过，不阻塞清理。
      }
    }
    if (roundtableIds.length > 0) {
      const deleteResult = await db.$executeRawUnsafe(
        `DELETE FROM "RoundtableEntry" WHERE "id" IN (${roundtableIds.map(() => '?').join(',')})`,
        ...roundtableIds
      );
      deletedRoundtableEntries = Number(deleteResult) || roundtableIds.length;
    }
  } catch {
    // RoundtableEntry 表可能尚未创建，视为没有可清理的讨论记录。
  }

  const keptChapterId = currentDraft?.id ?? null;
  const resetLessons = (worldState.craftLessons ?? []).filter(
    (lesson) => lesson.chapterNo !== chapterNo && lesson.sourceChapterId !== keptChapterId
  );
  const resetWorldStateBase = ensureChapterFocus({
    ...worldState,
    turn: keepTurn,
    tension: Math.min(6, Math.max(3, worldState.tension ?? 3)),
    currentChapter: {
      ...chapter,
      startTurn,
    },
    storyDesign: undefined,
    craftLessons: resetLessons,
    turnsSinceLastMain: 0,
  });
  const resetWorldState = keptChapterId
    ? withCanonicalChapterId(resetWorldStateBase, chapterNo, keptChapterId)
    : resetWorldStateBase;

  await db.project.update({
    where: { id: projectId },
    data: {
      worldState: JSON.stringify(resetWorldState),
      currentTurn: keepTurn,
      status: 'setup',
    },
  });

  return {
    worldState: resetWorldState,
    chapterNo,
    chapterTitle: currentDraft?.chapterTitle ?? chapter.title,
    keptChapterId,
    deletedEvents: eventResult.count,
    deletedChapterDrafts,
    deletedReaderReviews,
    rejectedDirectives: directiveResult.count,
    deletedRoundtableEntries,
  };
}
