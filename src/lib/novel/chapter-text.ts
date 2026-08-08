const READABLE_PUNCTUATION_RE = /[\s　，。！？、；："'“”‘’（）()《》【】\[\]{}<>〈〉「」『』,.!?;:…—\-·]/g;

export function countReadableChars(text: string | null | undefined): number {
  if (!text) return 0;
  return Array.from(String(text).replace(READABLE_PUNCTUATION_RE, '')).length;
}
