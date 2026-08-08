export const NORMAL_PLAYER_LEVEL_CAP = 999;
export const BREAK_LIMIT_LEVEL_CAP = 9999;

export function normalizeLevel(level?: number): number {
  if (!Number.isFinite(level) || Number(level) <= 0) return 1;
  return Math.min(BREAK_LIMIT_LEVEL_CAP, Math.floor(Number(level)));
}

export function normalizeExp(exp?: number): number {
  return Number.isFinite(exp) && Number(exp) > 0 ? Math.floor(Number(exp)) : 0;
}

export function expRequiredForNextLevel(level?: number): number {
  if (normalizeLevel(level) >= BREAK_LIMIT_LEVEL_CAP) return 0;
  return Math.max(100, normalizeLevel(level) * 100);
}

export function applyExperience(
  currentLevel: number | undefined,
  currentExp: number | undefined,
  expDelta: number | undefined,
  explicitLevel?: number
): { level: number; exp: number; nextLevelExp: number; levelUps: number; expGained: number } {
  let level = normalizeLevel(currentLevel);
  let exp = normalizeExp(currentExp);
  const expGained = Number.isFinite(expDelta) ? Math.max(0, Math.floor(Number(expDelta))) : 0;
  let levelUps = 0;

  exp += expGained;
  const progressionCap = level >= NORMAL_PLAYER_LEVEL_CAP ? BREAK_LIMIT_LEVEL_CAP : NORMAL_PLAYER_LEVEL_CAP;
  while (level < progressionCap && exp >= expRequiredForNextLevel(level)) {
    exp -= expRequiredForNextLevel(level);
    level += 1;
    levelUps += 1;
  }
  if (level >= progressionCap) exp = 0;

  if (Number.isFinite(explicitLevel) && Number(explicitLevel) > level) {
    const nextLevel = Math.min(BREAK_LIMIT_LEVEL_CAP, Math.floor(Number(explicitLevel)));
    levelUps += Math.max(0, nextLevel - level);
    level = nextLevel;
    exp = level >= BREAK_LIMIT_LEVEL_CAP ? 0 : Math.min(exp, expRequiredForNextLevel(level) - 1);
  }

  return {
    level,
    exp,
    nextLevelExp: expRequiredForNextLevel(level),
    levelUps,
    expGained,
  };
}
