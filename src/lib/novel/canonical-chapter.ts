import type { WorldState } from './types';

export function canonicalChapterKey(chapterNo?: number | null): string {
  return String(chapterNo ?? 1);
}

export function getCanonicalChapterId(
  worldState: WorldState | null | undefined,
  chapterNo?: number | null
): string | undefined {
  return worldState?.canonicalChapterIds?.[canonicalChapterKey(chapterNo)];
}

export function withCanonicalChapterId(
  worldState: WorldState,
  chapterNo: number,
  chapterId: string
): WorldState {
  return {
    ...worldState,
    canonicalChapterIds: {
      ...(worldState.canonicalChapterIds ?? {}),
      [canonicalChapterKey(chapterNo)]: chapterId,
    },
  };
}

export function pickCanonicalDraft<T extends { id: string; chapterNo?: number | null }>(
  drafts: T[],
  worldState: WorldState | null | undefined,
  chapterNo?: number | null
): T | undefined {
  const canonicalId = getCanonicalChapterId(worldState, chapterNo);
  return drafts.find((draft) => draft.id === canonicalId) ?? drafts[0];
}
