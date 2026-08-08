import {
  CHAPTER_WORD_TARGET_MAX,
  CHAPTER_WORD_TARGET_MIN,
} from './chapter-policy';
import type { LongFormPlan, VolumePlan, WorldState } from './types';

export const LONG_FORM_TARGET_WORDS = 1_000_000;
export const LONG_FORM_TARGET_CHAPTERS = 400;
export const LONG_FORM_MIN_WORDS = 0;

const DEFAULT_PACING_PRINCIPLES = [
  '卷名、卷目标和长线转折必须由用户大纲或长篇规划 Agent 生成，开发层不得硬编码剧情走向。',
  '每章只推进一个明确场面目标，后续大节点只能作为伏笔或压力，不得在当前章直接兑现。',
  '主线、支线、日常、伏笔交替出现，用角色关系、局部危机和阶段目标支撑长线阅读。',
  '装备、技能、天赋、等级、称号和掉落必须通过事件逐步获得，不提前铺满角色卡。',
  '如果长篇规划尚未生成，Director 只能按用户配置的体量慢推进，并提示需要先导入或生成长篇总纲。',
];

export function buildEmptyLongFormPlan(): LongFormPlan {
  return {
    targetWords: LONG_FORM_TARGET_WORDS,
    minWords: LONG_FORM_MIN_WORDS,
    targetChapters: LONG_FORM_TARGET_CHAPTERS,
    chapterWordMin: CHAPTER_WORD_TARGET_MIN,
    chapterWordMax: CHAPTER_WORD_TARGET_MAX,
    volumes: [],
    promise: '长篇规划尚未由用户大纲生成。系统只保留用户配置的体量规则，具体卷名、卷目标和剧情阶段必须交给大纲解析/规划 Agent 生成。',
    pacingPrinciples: DEFAULT_PACING_PRINCIPLES,
  };
}

export function normalizeLongFormPlan(plan: Partial<LongFormPlan> | null | undefined): LongFormPlan {
  const empty = buildEmptyLongFormPlan();
  if (!plan) return empty;

  const targetWords = Math.max(Number(plan.targetWords) || empty.targetWords, 0);
  const targetChapters = Math.max(Number(plan.targetChapters) || empty.targetChapters, 1);
  const volumes: VolumePlan[] = Array.isArray(plan.volumes)
    ? plan.volumes
        .map((volume, index): VolumePlan => {
          const chapterStart = Math.max(1, Number(volume.chapterStart) || index * 40 + 1);
          const status: VolumePlan['status'] =
            volume.status === 'done' || volume.status === 'active' ? volume.status : 'pending';
          return {
            index: Number(volume.index) || index + 1,
            title: String(volume.title ?? `第 ${index + 1} 阶段`).trim(),
            purpose: String(volume.purpose ?? '待根据用户大纲补充阶段目标').trim(),
            chapterStart,
            chapterEnd: Math.max(chapterStart, Number(volume.chapterEnd) || (index + 1) * 40),
            nodeIndexes: Array.isArray(volume.nodeIndexes)
              ? volume.nodeIndexes.map(Number).filter((item) => Number.isFinite(item) && item > 0)
              : [],
            status,
          };
        })
        .filter((volume) => volume.title && volume.purpose)
    : [];

  if (volumes.length > 0 && !volumes.some((volume) => volume.status === 'active')) {
    volumes[0].status = 'active';
  }

  return {
    targetWords,
    minWords: Math.max(Number(plan.minWords) || empty.minWords, 0),
    targetChapters,
    chapterWordMin: Number(plan.chapterWordMin) || CHAPTER_WORD_TARGET_MIN,
    chapterWordMax: Number(plan.chapterWordMax) || CHAPTER_WORD_TARGET_MAX,
    volumes,
    promise: String(plan.promise ?? empty.promise).trim() || empty.promise,
    pacingPrinciples: Array.isArray(plan.pacingPrinciples) && plan.pacingPrinciples.length > 0
      ? plan.pacingPrinciples.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 8)
      : empty.pacingPrinciples,
  };
}

export function ensureLongFormPlan(worldState: WorldState): WorldState {
  const existing = worldState.longFormPlan;
  return {
    ...worldState,
    longFormPlan: normalizeLongFormPlan(existing),
  };
}

export function currentVolumeText(worldState: WorldState): string {
  const plan = normalizeLongFormPlan(worldState.longFormPlan);
  const chapterNo = worldState.currentChapter?.chapterNo ?? 1;
  const volume =
    plan.volumes.find((item) => chapterNo >= item.chapterStart && chapterNo <= item.chapterEnd) ??
    plan.volumes[0];

  if (!volume) {
    return `长篇规划：目标 ${Math.round(plan.targetWords / 10000)} 万字，约 ${plan.targetChapters} 章。
当前卷：未生成。卷名、卷目标和剧情阶段必须根据用户大纲由规划 Agent 生成，开发层不得补写。
长篇承诺：${plan.promise}
节奏纪律：
${plan.pacingPrinciples.map((item) => `- ${item}`).join('\n')}`;
  }

  return `长篇规划：目标 ${Math.round(plan.targetWords / 10000)} 万字，约 ${plan.targetChapters} 章。
当前卷：第 ${volume.index} 卷《${volume.title}》（第 ${volume.chapterStart}-${volume.chapterEnd} 章）
卷目标：${volume.purpose}
长篇承诺：${plan.promise}
节奏纪律：
${plan.pacingPrinciples.map((item) => `- ${item}`).join('\n')}`;
}
