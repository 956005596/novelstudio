import { db } from '../db';
import { ensureChapterFocus } from './chapter-focus';
import { restoreChapterCharacterSnapshot } from './chapter-character-snapshot';
import type { WorldState } from './types';

export interface ResetCurrentChapterResult {
  worldState: WorldState;
  chapterNo: number;
  chapterTitle: string;
  startTurn: number;
  deletedEvents: number;
  deletedChapters: number;
  deletedReaderReviews: number;
  restoredCharacters: number;
  deletedNewCharacters: number;
  rejectedDirectives: number;
  deletedRoundtableEntries: number;
}

export async function resetCurrentChapterData(projectId: string): Promise<ResetCurrentChapterResult> {
  const project = await db.project.findUnique({
    where: { id: projectId },
  });
  if (!project) throw new Error('项目不存在');

  const worldState = ensureChapterFocus(JSON.parse(project.worldState) as WorldState);
  const chapter = worldState.currentChapter;
  if (!chapter) throw new Error('当前章节不存在');
  const fallbackNode = worldState.plotNodes?.find((node) => !node.completed);
  const resolvedTitle = /方向待定/.test(chapter.title) && fallbackNode?.title
    ? fallbackNode.title
    : chapter.title;

  const startTurn =
    typeof chapter.startTurn === 'number'
      ? chapter.startTurn
      : chapter.chapterNo === 1
        ? 0
        : worldState.turn;

  const chaptersToDelete = await db.chapter.findMany({
    where: {
      projectId,
      OR: [
        { chapterNo: chapter.chapterNo },
        { startTurn: { gte: startTurn } },
      ],
    },
    select: { id: true },
  });
  const chapterIds = chaptersToDelete.map((item) => item.id);

  let deletedReaderReviews = 0;
  let deletedChapters = 0;
  if (chapterIds.length > 0) {
    const reviewResult = await db.readerReview.deleteMany({
      where: { projectId, chapterId: { in: chapterIds } },
    });
    deletedReaderReviews = reviewResult.count;
    const chapterResult = await db.chapter.deleteMany({
      where: { id: { in: chapterIds } },
    });
    deletedChapters = chapterResult.count;
  }

  const eventResult = await db.event.deleteMany({
    where: {
      projectId,
      turn: { gte: startTurn },
    },
  });
  // 用户在设计讨论/导演指令里说过、但还没被本章消费的话，重置后不再注入新生成。
  const directiveResult = await db.directive.updateMany({
    where: {
      projectId,
      chapterNo: chapter.chapterNo,
      status: 'pending',
    },
    data: { status: 'rejected' },
  });
  // 设计讨论记录本身不进生成 prompt，但重置本章时应一并清掉，避免旧对话继续挂在页面上。
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
        if (parsed.chapterNo === chapter.chapterNo) roundtableIds.push(row.id);
      } catch {
        // 单条 payload 损坏时跳过，不阻塞重置。
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

  const activeIndexes = new Set(chapter.activeNodeIndexes ?? []);
  const firstActiveIndex =
    activeIndexes.size > 0 ? Math.min(...Array.from(activeIndexes)) : undefined;
  const resetPlotNodes = worldState.plotNodes?.map((node) => {
    const belongsToCurrentOrFuture =
      activeIndexes.has(node.index) ||
      (typeof firstActiveIndex === 'number' && node.index > firstActiveIndex);
    return belongsToCurrentOrFuture ? { ...node, completed: false } : node;
  });
  const deletedChapterIdSet = new Set(chapterIds);
  const resetLessons = (worldState.craftLessons ?? []).filter(
    (lesson) =>
      lesson.chapterNo !== chapter.chapterNo &&
      !deletedChapterIdSet.has(lesson.sourceChapterId)
  );
  const resetCanonicalChapterIds = { ...(worldState.canonicalChapterIds ?? {}) };
  delete resetCanonicalChapterIds[String(chapter.chapterNo)];
  const restoredSnapshot = await restoreChapterCharacterSnapshot(projectId, worldState, startTurn);

  const resetWorldState = ensureChapterFocus({
    ...worldState,
    turn: startTurn,
    tension: 3,
    currentChapter: {
      ...chapter,
      startTurn,
      title: resolvedTitle,
    },
    presentCharacterIds: restoredSnapshot.presentCharacterIds.length
      ? restoredSnapshot.presentCharacterIds
      : worldState.presentCharacterIds,
    plotNodes: resetPlotNodes,
    storyDesign: undefined,
    craftLessons: resetLessons,
    turnsSinceLastMain: 0,
    canonicalChapterIds: resetCanonicalChapterIds,
  });

  await db.project.update({
    where: { id: projectId },
    data: {
      worldState: JSON.stringify(resetWorldState),
      currentTurn: startTurn,
      status: 'setup',
    },
  });

  return {
    worldState: resetWorldState,
    chapterNo: chapter.chapterNo,
    chapterTitle: chapter.title,
    startTurn,
    deletedEvents: eventResult.count,
    deletedChapters,
    deletedReaderReviews,
    restoredCharacters: restoredSnapshot.restoredCount,
    deletedNewCharacters: restoredSnapshot.deletedNewCharacters,
    rejectedDirectives: directiveResult.count,
    deletedRoundtableEntries,
  };
}
