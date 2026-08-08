export const CHAPTER_WORD_TARGET_MIN = 2000;
export const CHAPTER_WORD_TARGET_MAX = 2800;
export const CHAPTER_WORD_TARGET_LABEL = `${CHAPTER_WORD_TARGET_MIN}-${CHAPTER_WORD_TARGET_MAX} 字`;

export function formatChapterWordTarget(
  min = CHAPTER_WORD_TARGET_MIN,
  max = CHAPTER_WORD_TARGET_MAX
): string {
  return `${min}-${max} 字`;
}

export function chapterWordTargetText(
  min = CHAPTER_WORD_TARGET_MIN,
  max = CHAPTER_WORD_TARGET_MAX
): string {
  return `每章正文控制在 ${formatChapterWordTarget(min, max)} 左右`;
}
