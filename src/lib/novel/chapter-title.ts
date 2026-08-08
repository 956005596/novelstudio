export function normalizeChapterTitle(title: string | null | undefined, chapterNo?: number | null): string {
  const raw = String(title ?? '').trim();
  if (!raw) return '';

  const prefix = typeof chapterNo === 'number' && Number.isFinite(chapterNo)
    ? new RegExp(`^第\\s*${chapterNo}\\s*(?:章节|章|回|集|卷)?\\s*[·:：、\\-—]*\\s*`)
    : /^第\s*\d+\s*(?:章节|章|回|集|卷)?\s*[·:：、\-—]*\s*/;
  let cleaned = raw.replace(prefix, '').trim();
  const bracketed = cleaned.match(/^《(.+)》$/);
  if (bracketed?.[1]) cleaned = bracketed[1].trim();

  return cleaned || raw;
}
