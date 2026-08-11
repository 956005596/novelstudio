/**
 * Engine — 演绎编排循环
 * 
 * 每个 Turn 的执行流程：
 *   1. 加载 World State + 角色 + 最近事件 + 待处理指令
 *   2. Director 决策：选谁行动、是否注入事件、是否触发 Writer
 *   3. Director 注入事件（如有）→ 写入事件日志
 *   4. 对每个被选中的角色：
 *      a. Character Agent 生成行为提案
 *      b. (多个角色时) Director 仲裁
 *      c. 写入事件日志 + 更新角色状态
 *   5. 应用用户干预（World State edit / Director command）
 *   6. 更新张力、Turn 自增
 *   7. 持久化 World State
 *   8. 如果触发 Writer：聚合本场景事件 → 流式生成文本 → 保存 Chapter
 *   9. Reader 评审：对文笔/节奏/设定挑刺，作为待审反馈输出
 *   10. 推送 socket.io 事件
 */

import { v4 as uuid } from 'uuid';
import type { Socket } from 'socket.io';
import { db } from '../db';
import type {
  Character,
  ChapterSummary,
  NovelCraftLesson,
  NovelEvent,
  ReaderReview,
  SocketOutEvent,
  StoryDesign,
  WorldState,
} from './types';
import {
  WorldManager,
} from './world-state';
import {
  directorDecide,
  type DirectorNewCharacter,
  type CharacterProgressUpdate,
} from './agents/director';
import { characterPropose, commitProposal } from './agents/character';
import { writerStream, saveChapter } from './agents/writer';
import { runReaderReviews } from './agents/readers';
import { storyDesignerPlan } from './agents/story-designer';
import { summarizeCharacterChapterUpdates } from './agents/character-archivist';
import { buildDirectorDirectiveFromLesson, summarizeCraftLesson } from './agents/craft-lessons';
import { advanceChapterFocus, ensureChapterFocus, resolveChapterStartTurn, retreatChapterFocus } from './chapter-focus';
import { CHAPTER_WORD_TARGET_MAX, CHAPTER_WORD_TARGET_MIN, formatChapterWordTarget } from './chapter-policy';
import { countReadableChars } from './chapter-text';
import { repairChapterUntilValid, requiredCharacterNamesFromText } from './chapter-guardrails';
import { resetCurrentChapterData } from './reset-current-chapter';
import { ensureLLMReady, toLLMUserMessage } from './llm';
import { withCanonicalChapterId } from './canonical-chapter';
import { loadPreviousChapterBridge } from './chapter-continuity';
import { applyExperience, expRequiredForNextLevel } from './progression';
import { normalizeAgentPolicy } from './agent-policy';
import { auditStoryDesignContinuity } from './agents/continuity-auditor';
import type { ChapterBridgeContext } from './chapter-continuity';

const TURN_DELAY_MS = 4000;      // 每个 turn 之间的间隔，给前端时间消化 + 避免 LLM 限流
const WRITER_CHUNK_THRESHOLD = 18; // 安全阈值：事件太多时才提前收束，避免半章被写成短章
const INVALID_ACTOR_META_TEXT = /(?:我们(?:需要|根据|现在)|根据(?:现场简报|角色要求|设定)|生成.{0,12}(?:行动|对话)|作为(?:AI|角色Agent|模型)|角色(?:需要|应该|可以)|目标是|因此[，,:：]?\s*(?:行动|回答)|输出\s*JSON|提示词|LLM|Agent|分析如下|方案如下)/i;
const AUTO_REVIEW_REVISION_DRAFTS = 3; // 自动模式：初稿 + 最多两轮评审回流修正版
const activeWriterProjects = new Set<string>();

function chapterWordLabel(worldState: WorldState): string {
  const chapter = worldState.currentChapter;
  return formatChapterWordTarget(
    chapter?.targetWordMin ?? CHAPTER_WORD_TARGET_MIN,
    chapter?.targetWordMax ?? CHAPTER_WORD_TARGET_MAX
  );
}

function chapterProgress(worldState: WorldState): { current: number; target: number; startTurn: number } {
  const focused = ensureChapterFocus(worldState);
  const chapter = focused.currentChapter;
  const startTurn = resolveChapterStartTurn(focused, chapter);
  const current = Math.max(0, focused.turn - startTurn);
  const target = Math.max(1, Number(chapter?.targetTurns ?? 8));
  return { current, target, startTurn };
}

interface WriterRunResult {
  completed: boolean;
  chapter?: ChapterSummary;
  reviews: ReaderReview[];
  lesson?: NovelCraftLesson;
}

interface TurnRunResult {
  shouldStop: boolean;
  blocked: boolean;
}

/** 判断当前 Turn 是否达到节点完成阈值 */
function nextWorld_turnReached(currentTurn: number, threshold: number): boolean {
  return currentTurn >= threshold;
}

function buildActorConstraintHint(directives: { type?: string; content: string }[]): string {
  const priorityDirectives = directives
    .filter((directive) => directive.type === 'priority_command')
    .map((directive) => directive.content.trim())
    .filter(Boolean);
  const reviewDirectives = directives
    .map((directive) => directive.content.trim())
    .filter((content) => content.includes('【读者评审回流'));

  const parts: string[] = [];

  if (priorityDirectives.length > 0) {
    parts.push(`用户给 Director 的最高优先级章节方向已经生效。演员不能知道“用户指令”这个场外来源，但必须把行动收束到导演转化后的本章方向：
${priorityDirectives.map((content, index) => `【最高优先级${index + 1}】\n${content.slice(0, 1200)}`).join('\n\n')}`);
  }

  if (reviewDirectives.length > 0) {
    parts.push(`读者评审已回流给 Director，本轮演员只能感知到导演转化后的场景压力和行为边界：
- 不要直接提到“读者评审”“作者”“正文问题”等场外信息。
- 修正角色行动：只基于现场已公开信息、自身状态和当前章边界行动。
- 修正设定越界：不得凭空获得或使用未发生的技能、装备、天赋、等级、坐骑、称号或物品。
- 修正节奏拖沓：行动要制造可见变化，避免重复广播、围观惊呼和同类解释。

导演转化后的校准摘要：
${reviewDirectives.map((content, index) => `【回流${index + 1}】\n${content.slice(0, 1200)}`).join('\n\n')}`);
  }

  return parts.join('\n\n');
}

function worldDefinesProgressionSystem(worldState: WorldState): boolean {
  const source = [
    worldState.storyBibleNotes,
    worldState.writerHint,
    worldState.currentChapter?.goal,
    worldState.currentChapter?.scope,
    ...(worldState.currentChapter?.constraints ?? []),
    ...(worldState.storyDesign?.progressionHooks ?? []),
    ...(worldState.storyDesign?.settingGuardrails ?? []),
  ].filter(Boolean).join('\n');
  return /(等级|经验|升级|掉落|奖励|首杀|玩家|职业|Lv|EXP)/i.test(source);
}

function eventLooksLikeKill(event: NovelEvent): boolean {
  if (event.type !== 'action' && event.type !== 'director') return false;
  const content = event.content;
  if (/(没死|未死|没有死|不是击杀|没有击杀|没能杀死)/.test(content)) return false;
  return /(击杀|杀死|打死|杀掉|补杀|斩杀|处刑|砸死|捅死|挣扎骤停|当场瘫下|死透|尸体)/.test(content) &&
    /(怪物|小怪|BOSS|Boss|boss|黑影|裂隙生物|壳怪|兽|魔物|深渊)/.test(content);
}

function inferExperienceDelta(event: NovelEvent): number {
  const content = event.content;
  if (/首杀|世界BOSS|世界 Boss|BOSS|Boss|boss|领主/.test(content)) return 100;
  if (/精英|头目|大壳|巨型|司祭|层主/.test(content)) return 45;
  if (/小怪|低阶|黑影|裂隙生物/.test(content)) return 20;
  return 15;
}

function buildAutomaticProgressionUpdates(
  worldState: WorldState,
  events: NovelEvent[],
  characters: Character[],
  existingUpdates: CharacterProgressUpdate[]
): CharacterProgressUpdate[] {
  if (!worldDefinesProgressionSystem(worldState)) return [];
  const existingProgressNames = new Set(
    existingUpdates
      .filter((update) => Number(update.expDelta) > 0 || Number(update.level) > 0)
      .map((update) => update.characterName?.trim())
      .filter(Boolean)
  );
  const existingProgressIds = new Set(
    existingUpdates
      .filter((update) => Number(update.expDelta) > 0 || Number(update.level) > 0)
      .map((update) => update.characterId)
      .filter(Boolean)
  );
  const byName = new Map(characters.map((character) => [character.name, character]));
  const autoUpdates: CharacterProgressUpdate[] = [];

  for (const event of events) {
    if (!eventLooksLikeKill(event)) continue;
    const character = byName.get(event.agentName);
    if (!character) continue;
    if (existingProgressIds.has(character.id) || existingProgressNames.has(character.name)) continue;
    autoUpdates.push({
      characterId: character.id,
      characterName: character.name,
      reason: `自动补记：本轮事件明确写出 ${character.name} 对怪物完成击杀/补杀，而项目已定义经验体系；Director 未输出 expDelta，按低阶贡献保守结算。事件：${event.content.slice(0, 160)}`,
      evidenceEventIds: [event.id],
      expDelta: inferExperienceDelta(event),
    });
  }

  return autoUpdates.slice(0, 4);
}

function relationshipEntriesForExistingCharacters(
  relationships: Record<string, { value: number; note: string }> | undefined,
  characters: Character[]
): Record<string, { value: number; note: string }> {
  if (!relationships) return {};
  const names = new Set(characters.map((character) => character.name));
  return Object.fromEntries(
    Object.entries(relationships)
      .filter(([name]) => names.has(name))
      .map(([name, relation]) => [
        name,
        {
          value: Math.max(-20, Math.min(25, Number(relation.value) || 0)),
          note: relation.note || '初识/同校，关系待剧情展开',
        },
      ])
  );
}

function directorNewCharacterToCharacter(
  item: DirectorNewCharacter,
  worldState: WorldState,
  characters: Character[]
): Omit<Character, 'id'> {
  return {
    name: item.name,
    role: item.role ?? 'npc',
    persona: {
      background: item.background || `${item.name}在第 ${worldState.currentChapter?.chapterNo ?? 1} 章登场，后续作用待剧情展开。`,
      personality: item.personality?.length ? item.personality : ['待观察'],
      goals: item.goals?.length ? item.goals : ['在当前事件中保持自身立场'],
      stance: item.stance || item.reason || '立场待剧情展开',
      speechStyle: item.speechStyle || '说话方式待观察',
      appearance: item.appearance || '',
      backstory: item.reason ? `登场原因：${item.reason}` : '',
      growthArc: '',
      innerConflict: '',
      secrets: [],
      motivations: item.goals?.length ? item.goals : [],
      speechHabits: [],
      skills: [],
      equipment: [],
      talents: [],
      mounts: [],
      pets: [],
      inventory: [],
      titles: [],
    },
    currentState: {
      emotion: item.emotion || '警觉',
      location: item.location || worldState.location,
      relationships: relationshipEntriesForExistingCharacters(item.relationships, characters),
      hp: 100,
      mp: 50,
      level: 1,
      exp: 0,
      nextLevelExp: expRequiredForNextLevel(1),
      buffs: [],
    },
  };
}

function eventLine(event: NovelEvent): string {
  const target = event.target ? ` -> ${event.target}` : '';
  const emotion = event.emotion ? ` [${event.emotion}]` : '';
  return `[T${event.turn}] ${event.agentName}${target}${emotion}: ${event.content}`;
}

function buildTurnActorHint(
  decisionCommentary: string | undefined,
  currentTurnEvents: NovelEvent[],
  actorConstraintHint: string
): string {
  const parts = [
    '本轮是接力演绎，不是各自独立发言。后行动者必须承接本轮已经发生的最后一个具体动作，并让现场状态产生下一步变化。',
  ];

  if (decisionCommentary) {
    parts.push(`Director 本轮意图：${decisionCommentary}`);
  }

  if (currentTurnEvents.length > 0) {
    parts.push(`本轮已经发生，必须接住，不能重复表演：\n${currentTurnEvents.map(eventLine).join('\n')}`);
  } else {
    parts.push('你是本轮第一个行动者：先接住 Director 给出的现场变化，不要发散到旁枝。');
  }

  parts.push('行动要求：优先回应最近一个人/事件；不要重复“我也去拉人/我也挡人/我也喊退后”这类并列动作，除非你明确是在补位或改变结果。');

  if (actorConstraintHint) {
    parts.push(actorConstraintHint);
  }

  return parts.join('\n\n');
}

function normalizeList(items?: string[]): string[] {
  return (items ?? []).map((item) => item.trim()).filter(Boolean);
}

function addUnique(base: string[] | undefined, additions?: string[]): string[] {
  const next = normalizeList(base);
  for (const item of normalizeList(additions)) {
    if (!next.includes(item)) next.push(item);
  }
  return next;
}

function removeItems(base: string[] | undefined, removals?: string[]): string[] {
  const removeSet = new Set(normalizeList(removals));
  return normalizeList(base).filter((item) => !removeSet.has(item));
}

function cleanText(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function mergeCharacterProgressUpdates(updates: CharacterProgressUpdate[]): CharacterProgressUpdate[] {
  const merged = new Map<string, CharacterProgressUpdate>();

  for (const update of updates) {
    const name = update.characterName?.trim();
    const key = update.characterId || name;
    if (!key) continue;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...update,
        characterName: name || update.characterName,
        reason: cleanText(update.reason) ?? '本轮角色状态更新',
      });
      continue;
    }

    const expDelta = Number.isFinite(Number(update.expDelta)) ? Math.max(0, Math.floor(Number(update.expDelta))) : undefined;
    const existingExpDelta = Number.isFinite(Number(existing.expDelta)) ? Math.max(0, Math.floor(Number(existing.expDelta))) : undefined;
    const level = Number.isFinite(Number(update.level)) ? Math.floor(Number(update.level)) : undefined;
    const existingLevel = Number.isFinite(Number(existing.level)) ? Math.floor(Number(existing.level)) : undefined;
    const reasons = addUnique(existing.reason ? [existing.reason] : [], update.reason ? [update.reason] : []);

    merged.set(key, {
      ...existing,
      characterId: existing.characterId || update.characterId,
      characterName: existing.characterName || name || update.characterName,
      reason: reasons.join('\n'),
      evidenceEventIds: addUnique(existing.evidenceEventIds, update.evidenceEventIds),
      gender: existing.gender || update.gender,
      background: existing.background || update.background,
      personality: addUnique(existing.personality, update.personality),
      goals: addUnique(existing.goals, update.goals),
      stance: existing.stance || update.stance,
      speechStyle: existing.speechStyle || update.speechStyle,
      appearance: existing.appearance || update.appearance,
      backstory: existing.backstory || update.backstory,
      growthArc: existing.growthArc || update.growthArc,
      innerConflict: existing.innerConflict || update.innerConflict,
      secrets: addUnique(existing.secrets, update.secrets),
      motivations: addUnique(existing.motivations, update.motivations),
      speechHabits: addUnique(existing.speechHabits, update.speechHabits),
      level: Math.max(existingLevel ?? 0, level ?? 0) || undefined,
      expDelta: Math.max(existingExpDelta ?? 0, expDelta ?? 0) || undefined,
      profession: existing.profession || update.profession,
      addSkills: addUnique(existing.addSkills, update.addSkills),
      removeSkills: addUnique(existing.removeSkills, update.removeSkills),
      addEquipment: addUnique(existing.addEquipment, update.addEquipment),
      removeEquipment: addUnique(existing.removeEquipment, update.removeEquipment),
      addTalents: addUnique(existing.addTalents, update.addTalents),
      addMounts: addUnique(existing.addMounts, update.addMounts),
      removeMounts: addUnique(existing.removeMounts, update.removeMounts),
      addPets: addUnique(existing.addPets, update.addPets),
      removePets: addUnique(existing.removePets, update.removePets),
      addInventory: addUnique(existing.addInventory, update.addInventory),
      removeInventory: addUnique(existing.removeInventory, update.removeInventory),
      addTitles: addUnique(existing.addTitles, update.addTitles),
      addBuffs: addUnique(existing.addBuffs, update.addBuffs),
      removeBuffs: addUnique(existing.removeBuffs, update.removeBuffs),
    });
  }

  return Array.from(merged.values());
}

function hasMechanicalProgressPayload(update: CharacterProgressUpdate): boolean {
  return !!(
    Number(update.level) > 0 ||
    Number(update.expDelta) > 0 ||
    cleanText(update.profession) ||
    normalizeList(update.addSkills).length ||
    normalizeList(update.removeSkills).length ||
    normalizeList(update.addEquipment).length ||
    normalizeList(update.removeEquipment).length ||
    normalizeList(update.addTalents).length ||
    normalizeList(update.addMounts).length ||
    normalizeList(update.removeMounts).length ||
    normalizeList(update.addPets).length ||
    normalizeList(update.removePets).length ||
    normalizeList(update.addInventory).length ||
    normalizeList(update.removeInventory).length ||
    normalizeList(update.addTitles).length ||
    normalizeList(update.addBuffs).length ||
    normalizeList(update.removeBuffs).length
  );
}

function stripMechanicalProgress(update: CharacterProgressUpdate): CharacterProgressUpdate {
  return {
    ...update,
    level: undefined,
    expDelta: undefined,
    profession: undefined,
    addSkills: [],
    removeSkills: [],
    addEquipment: [],
    removeEquipment: [],
    addTalents: [],
    addMounts: [],
    removeMounts: [],
    addPets: [],
    removePets: [],
    addInventory: [],
    removeInventory: [],
    addTitles: [],
    addBuffs: [],
    removeBuffs: [],
  };
}

function validateCharacterProgressEvidence(
  updates: CharacterProgressUpdate[],
  evidenceEvents: NovelEvent[]
): { accepted: CharacterProgressUpdate[]; rejected: CharacterProgressUpdate[] } {
  const eventById = new Map(evidenceEvents.map((event) => [event.id, event]));
  const accepted: CharacterProgressUpdate[] = [];
  const rejected: CharacterProgressUpdate[] = [];

  for (const update of updates) {
    if (!hasMechanicalProgressPayload(update)) {
      accepted.push(update);
      continue;
    }
    const evidence = normalizeList(update.evidenceEventIds)
      .map((id) => eventById.get(id))
      .filter((event): event is NovelEvent => Boolean(event));
    if (evidence.length > 0) {
      accepted.push(update);
      continue;
    }

    rejected.push(update);
    const profileOnly = stripMechanicalProgress(update);
    if (hasProfileUpdatePayload(profileOnly)) accepted.push(profileOnly);
  }

  return { accepted, rejected };
}

function canCorrectHardProfileField(
  currentValue: string | undefined,
  nextValue: string | undefined,
  reason: string
): boolean {
  if (!nextValue || nextValue === currentValue) return false;
  if (!currentValue) return true;
  return /用户|手动|正典|原文|正文|大纲|设定|明确|修正|确认/.test(reason);
}

function hasProfileUpdatePayload(update: CharacterProgressUpdate): boolean {
  return !!(
    cleanText(update.gender) ||
    cleanText(update.background) ||
    normalizeList(update.personality).length ||
    normalizeList(update.goals).length ||
    cleanText(update.stance) ||
    cleanText(update.speechStyle) ||
    cleanText(update.appearance) ||
    cleanText(update.backstory) ||
    cleanText(update.growthArc) ||
    cleanText(update.innerConflict) ||
    normalizeList(update.secrets).length ||
    normalizeList(update.motivations).length ||
    normalizeList(update.speechHabits).length
  );
}

export interface EngineCallbacks {
  emit: (event: SocketOutEvent) => void;
  isPaused: () => boolean;
  isStopped: () => boolean;
  waitWhilePaused: () => Promise<void>;
}

export class NovelEngine {
  private wm: WorldManager;
  private cb: EngineCallbacks;
  private chapterStartTurn = 0;
  private chapterBuffer: NovelEvent[] = [];
  private lastWriterText = '';
  private autoImproveMode = false;

  constructor(projectId: string, cb: EngineCallbacks) {
    this.wm = new WorldManager(projectId);
    this.cb = cb;
  }

  private async reopenEmptyChapterIfNeeded(worldState: WorldState, reason: string): Promise<WorldState> {
    const focused = ensureChapterFocus(worldState);
    const chapter = focused.currentChapter;
    if (!chapter) return focused;

    const startTurn = resolveChapterStartTurn(focused, chapter);
    if (focused.turn <= startTurn) return focused;

    const events = await this.wm.getChapterEvents(startTurn, focused.turn);
    if (events.length > 0) return focused;

    const chapterDraftCount = await db.chapter.count({
      where: {
        projectId: this.wm.projectId,
        chapterNo: chapter.chapterNo,
      },
    });
    if (chapterDraftCount > 0) return focused;

    const rebased = ensureChapterFocus({
      ...focused,
      currentChapter: {
        ...chapter,
        startTurn: focused.turn,
      },
      turnsSinceLastMain: 0,
    });

    await this.wm.saveWorldState(rebased);
    this.chapterStartTurn = rebased.turn;
    this.chapterBuffer = [];
    this.cb.emit({ type: 'world:update', worldState: rebased });
    this.emitLog(
      'info',
      `${reason}：检测到当前章没有事件也没有正文，但轮次仍停在旧进度，已自动把第 ${chapter.chapterNo} 章从 T${rebased.turn} 重新打开`
    );
    return rebased;
  }

  private async discardInvalidGeneratedChapterIfNeeded(worldState: WorldState): Promise<WorldState> {
    const focused = ensureChapterFocus(worldState);
    const chapter = focused.currentChapter;
    if (!chapter) return focused;
    const startTurn = resolveChapterStartTurn(focused, chapter);
    const events = await this.wm.getChapterEvents(startTurn, focused.turn);
    const invalidEvent = events.find((event) => event.agentId && INVALID_ACTOR_META_TEXT.test(event.content));
    if (!invalidEvent) return focused;

    const draftCount = await db.chapter.count({
      where: { projectId: this.wm.projectId, chapterNo: chapter.chapterNo },
    });
    if (draftCount > 0) {
      throw new Error(`第 ${chapter.chapterNo} 章已有正文，但事件日志中仍含角色分析文本；请先在章节目录确认要保留的正稿，再重置本章`);
    }

    const result = await resetCurrentChapterData(this.wm.projectId);
    this.chapterBuffer = [];
    this.chapterStartTurn = result.startTurn;
    this.cb.emit({ type: 'world:update', worldState: result.worldState });
    const refreshed = await this.wm.loadProject();
    for (const character of refreshed.characters) {
      this.cb.emit({ type: 'character:update', character });
    }
    this.emitLog(
      'warn',
      `检测到第 ${chapter.chapterNo} 章 T${invalidEvent.turn} 的角色输出混入创作分析，已撤销该章 ${result.deletedEvents} 条未成稿事件并恢复章初人物状态`
    );
    return result.worldState;
  }

  private async planAuditedStoryDesign(input: {
    worldState: WorldState;
    characters: Character[];
    recentEvents: NovelEvent[];
    pendingDirectives: { id: string; type: string; content: string }[];
    previousChapterBridge?: ChapterBridgeContext | null;
  }): Promise<StoryDesign | null> {
    const policy = normalizeAgentPolicy(input.worldState.agentPolicy);
    let directives = input.pendingDirectives;
    let design = await storyDesignerPlan(
      input.worldState,
      input.characters,
      input.recentEvents,
      directives,
      input.previousChapterBridge
    );
    if (!policy.auditorCanBlockDrift) return design;

    for (let attempt = 0; attempt < 2; attempt++) {
      this.emitLog('info', `设定审核：核对第 ${design.chapterNo} 章设计与上一章正稿、人物状态和已发生事件…`);
      const audit = await auditStoryDesignContinuity({
        worldState: input.worldState,
        characters: input.characters,
        recentEvents: input.recentEvents,
        design,
        previousChapterBridge: input.previousChapterBridge,
      });
      if (audit.status === 'passed') {
        return { ...design, continuityAudit: audit };
      }

      if (attempt === 0) {
        const feedback = audit.repairInstruction || audit.issues.join('；');
        this.emitLog('warn', `设定审核要求返工：${feedback || '导演设计存在硬连续性冲突'}`);
        directives = [
          ...directives,
          {
            id: `continuity-repair-${Date.now()}`,
            type: 'priority_command',
            content: `【设定审核返工】${feedback}。只修正本章导演设计，不得绕过上一章正稿和人物当前状态。`,
          },
        ];
        design = await storyDesignerPlan(
          input.worldState,
          input.characters,
          input.recentEvents,
          directives,
          input.previousChapterBridge
        );
        continue;
      }

      this.emitLog(
        'error',
        `导演设计被设定审核阻止：${audit.issues.join('；') || audit.repairInstruction}。请先用“方向提案”修正本章方向，再重新生成设计。`
      );
      return null;
    }
    return null;
  }

  /** 单独准备本章导演设计：不推进 Turn，不写事件。 */
  async prepareStoryDesign(): Promise<boolean> {
    if (!(await this.ensureGenerationReady('导演设计'))) return false;

    const loaded = await this.wm.loadProject();
    const worldState = await this.reopenEmptyChapterIfNeeded(loaded.worldState, '导演设计重算前');
    const initialAgentPolicy = normalizeAgentPolicy(worldState.agentPolicy);
    if (!initialAgentPolicy.designerCanPlanCurrentChapter) {
      this.emitLog('warn', 'Agent 权限：剧情设计师本章设计已关闭，未生成新导演设计');
      return false;
    }
    const recentEvents = await this.wm.getRecentEvents(20);
    const chapterNo = worldState.currentChapter?.chapterNo ?? 1;
    const pendingDirectives = await this.wm.peekPendingDirectives(chapterNo);
    const previousChapterBridge = await loadPreviousChapterBridge(
      this.wm.projectId,
      worldState,
      worldState.currentChapter?.chapterNo
    );

    this.emitLog('info', `第 ${worldState.currentChapter?.chapterNo ?? 1} 章导演设计生成中…`);
    let design: StoryDesign | null = null;
    try {
      design = await this.planAuditedStoryDesign({
        worldState,
        characters: loaded.characters,
        recentEvents,
        pendingDirectives,
        previousChapterBridge,
      });
    } catch (error: any) {
      this.emitLog('error', `导演设计未通过设定审核：${error.message}`);
      return false;
    }
    if (!design) return false;
    const nextWorld = { ...worldState, storyDesign: design };
    await this.wm.saveWorldState(nextWorld);
    this.cb.emit({ type: 'designer:update', design });
    this.cb.emit({ type: 'world:update', worldState: nextWorld });
    this.emitLog('info', `导演设计已就绪：${design.currentBeat}`);
    return true;
  }

  /** 显式进入下一章：标记当前章节点完成，清掉旧设计，生成下一章焦点。 */
  async advanceChapter(): Promise<void> {
    const loaded = await this.wm.loadProject();
    const nextWorld = advanceChapterFocus(loaded.worldState);
    await this.wm.saveWorldState(nextWorld);
    await this.wm.saveCurrentChapterCharacterSnapshot();
    this.chapterBuffer = [];
    this.chapterStartTurn = nextWorld.turn;
    this.cb.emit({ type: 'world:update', worldState: nextWorld });
    this.emitLog('info', `已进入第 ${nextWorld.currentChapter?.chapterNo ?? 1} 章：${nextWorld.currentChapter?.title ?? nextWorld.sceneName}`);
  }

  /** 回到上一章：撤销上一章之后的章节焦点，不删除事件和正文。 */
  async retreatChapter(): Promise<void> {
    const loaded = await this.wm.loadProject();
    const nextWorld = retreatChapterFocus(loaded.worldState);
    await this.wm.saveWorldState(nextWorld);
    await this.wm.saveCurrentChapterCharacterSnapshot();
    this.chapterBuffer = [];
    this.chapterStartTurn = nextWorld.turn;
    this.cb.emit({ type: 'world:update', worldState: nextWorld });
    this.emitLog('info', `已回到第 ${nextWorld.currentChapter?.chapterNo ?? 1} 章：${nextWorld.currentChapter?.title ?? nextWorld.sceneName}`);
  }

  /** 重置当前章：只清掉本章事件、正文、评审和设计，不动前面章节。 */
  async resetCurrentChapter(): Promise<{
    chapterNo: number;
    chapterTitle: string;
    startTurn: number;
  }> {
    const result = await resetCurrentChapterData(this.wm.projectId);
    this.chapterBuffer = [];
    this.chapterStartTurn = result.startTurn;
    this.lastWriterText = '';
    this.cb.emit({ type: 'world:update', worldState: result.worldState });
    const refreshed = await this.wm.loadProject();
    for (const character of refreshed.characters) {
      this.cb.emit({ type: 'character:update', character });
    }
    this.emitLog(
      'info',
      `第 ${result.chapterNo} 章《${result.chapterTitle}》已重置：删除 ${result.deletedEvents} 条本章事件、${result.deletedChapters} 段正文、${result.deletedReaderReviews} 条评审、${result.deletedRoundtableEntries} 条本章设计讨论，恢复 ${result.restoredCharacters} 个人物快照，停用 ${result.rejectedDirectives} 条未消费导演指令`
    );
    return {
      chapterNo: result.chapterNo,
      chapterTitle: result.chapterTitle,
      startTurn: result.startTurn,
    };
  }

  /** 主循环：从当前 turn 开始演绎，直到暂停/停止/触发 Writer 结束场景 */
  async run(maxTurns = 30): Promise<void> {
    if (!(await this.ensureGenerationReady('演绎'))) return;

    const loaded = await this.wm.loadProject();
    const sanitizedWorld = await this.discardInvalidGeneratedChapterIfNeeded(loaded.worldState);
    const focusedWorld = await this.reopenEmptyChapterIfNeeded(sanitizedWorld, '演绎启动前');
    await this.wm.saveCurrentChapterCharacterSnapshot();
    const policy = normalizeAgentPolicy(focusedWorld.agentPolicy);
    const designReady =
      focusedWorld.storyDesign?.chapterNo === focusedWorld.currentChapter?.chapterNo &&
      (!policy.auditorCanBlockDrift || focusedWorld.storyDesign?.continuityAudit?.status === 'passed');
    if (!designReady && policy.designerCanPlanCurrentChapter) {
      const prepared = await this.prepareStoryDesign();
      if (!prepared) return;
    }
    const progress = chapterProgress(focusedWorld);
    if (progress.current >= progress.target) {
      await this.wm.setProjectStatus('idle');
      this.cb.emit({ type: 'engine:state', status: 'idle', turn: focusedWorld.turn });
      this.emitLog(
        'info',
        `第 ${focusedWorld.currentChapter?.chapterNo ?? 1} 章已达到收束点（${progress.current}/${progress.target} 轮），普通演绎已暂停；确认事件无误后再点“生成正文”`
      );
      return;
    }

    await this.wm.setProjectStatus('running');
    this.emitLog('info', `演绎开始，本次最多执行 ${maxTurns} 轮`);

    let turnCount = 0;
    try {
      while (turnCount < maxTurns && !this.cb.isStopped()) {
        await this.cb.waitWhilePaused();
        if (this.cb.isStopped()) break;

        try {
          const { shouldStop } = await this.runOneTurn();
          turnCount++;
          if (shouldStop) break;
        } catch (err: any) {
          this.emitLog('error', `Turn 执行失败：${err.message}`);
          break;
        }

        if (turnCount < maxTurns) {
          await sleep(TURN_DELAY_MS);
        }
      }
    } finally {
      await this.wm.setProjectStatus('idle').catch(() => {});
      this.cb.emit({ type: 'engine:state', status: 'idle', turn: -1 });
      this.emitLog('info', `单步演绎已停止，共执行 ${turnCount} 轮`);
    }
  }

  /** 章节自循环：设计 -> 演绎 -> 正文 -> 评审 -> 回流修正 -> 重评定稿。 */
  async runChapterAutoLoop(cycles = 3, turnsPerCycle = 3): Promise<void> {
    if (!(await this.ensureGenerationReady('章节自循环'))) return;

    await this.wm.setProjectStatus('running');
    this.autoImproveMode = true;
    this.cb.emit({ type: 'engine:state', status: 'running', turn: -1 });
    this.emitLog(
      'info',
      `章节自循环启动：设计 → 演绎 → 写作 → 评审 → 回流修正 → 重评定稿；最多 ${cycles} 轮，每轮 ${turnsPerCycle} 个 Turn`
    );

    let completed = false;
    let stopReason = '';
    try {
      for (let cycle = 1; cycle <= cycles && !this.cb.isStopped(); cycle++) {
        await this.cb.waitWhilePaused();
        if (this.cb.isStopped()) break;

        const loaded = await this.wm.loadProject();
        const sanitizedWorld = await this.discardInvalidGeneratedChapterIfNeeded(loaded.worldState);
        const focusedWorld = await this.reopenEmptyChapterIfNeeded(sanitizedWorld, '章节自循环开始前');
        const chapter = focusedWorld.currentChapter;
        const progress = chapterProgress(focusedWorld);
        this.emitLog(
          'info',
          `章节自循环 ${cycle}/${cycles}：第 ${chapter?.chapterNo ?? 1} 章设计校准中…`
        );
        if (progress.current >= progress.target) {
          this.emitLog(
            'info',
            `章节自循环：第 ${chapter?.chapterNo ?? 1} 章已到收束点（${progress.current}/${progress.target}），跳过演绎，直接写作和评审`
          );
          const writerResult = await this.writeCurrentChapterFromSavedEvents(focusedWorld, loaded.characters, {
            autoRevision: true,
          });
          if (writerResult.completed) {
            this.emitLog('info', '章节自循环：本章已完成写作、评审、反修和定稿');
            completed = true;
          } else {
            stopReason = '本章已收束，但正文生成或评审链路没有完成';
            this.emitLog('error', `章节自循环未完成：${stopReason}`);
          }
          break;
        }
        if (!(await this.prepareStoryDesign())) {
          stopReason = '导演设计没有通过结构校验或设定审核';
          break;
        }

        let writerResult: WriterRunResult | null = null;
        let designBlocked = false;
        for (let turn = 0; turn < turnsPerCycle && !this.cb.isStopped(); turn++) {
          await this.cb.waitWhilePaused();
          const turnResult = await this.runOneTurn();
          if (turnResult.blocked) {
            designBlocked = true;
            break;
          }
          const lastChapter = await this.maybeForceWriterForAutoCycle(false);
          if (lastChapter.completed) {
            writerResult = lastChapter;
            break;
          }
          if (turnResult.shouldStop) break;
          await sleep(TURN_DELAY_MS);
        }

        if (designBlocked) {
          stopReason = '导演设计未通过设定审核';
          this.emitLog('error', `章节自循环已停止：${stopReason}，没有继续空跑后续轮次`);
          break;
        }

        if (!writerResult?.completed && !this.cb.isStopped()) {
          writerResult = await this.maybeForceWriterForAutoCycle(true);
        }

        if (writerResult?.lesson) {
          this.emitLog('info', `章节自循环 ${cycle}/${cycles}：评审经验已沉淀，并回流 Director/剧情设计师`);
        } else if (writerResult?.completed) {
          this.emitLog('warn', `章节自循环 ${cycle}/${cycles}：正文已生成，但经验总结未产出`);
        }
        if (writerResult?.completed) {
          this.emitLog('info', '章节自循环：本章已生成最终正稿并完成重评，本次自动流程收束');
          completed = true;
          break;
        }
      }
      if (this.cb.isStopped() && !completed && !stopReason) {
        stopReason = '收到新的执行或停止指令';
      }
    } catch (error: any) {
      stopReason = error?.message || '未知执行错误';
      this.emitLog('error', `章节自循环在当前阶段失败：${stopReason}`);
    } finally {
      this.autoImproveMode = false;
      await this.wm.setProjectStatus('idle').catch(() => {});
      this.cb.emit({ type: 'engine:state', status: 'idle', turn: -1 });
    }
    if (completed) {
      this.emitLog('info', '章节自循环已完整完成');
    } else {
      const latest = ensureChapterFocus((await this.wm.loadProject()).worldState);
      const progress = chapterProgress(latest);
      this.emitLog(
        'error',
        `章节自循环未完成：${stopReason || `达到执行上限，但本章仍为 ${progress.current}/${progress.target} 轮`}。当前进度已保留，可修正后继续。`
      );
    }
  }

  /** 执行单个 Turn，区分正常收束与设计审核阻断。 */
  private async runOneTurn(): Promise<TurnRunResult> {
    const loaded = await this.wm.loadProject();
    const worldState = ensureChapterFocus(loaded.worldState);
    const initialAgentPolicy = normalizeAgentPolicy(worldState.agentPolicy);
    const { characters } = loaded;
    let latestCharacters = characters;
    const recentEvents = await this.wm.getRecentEvents(20);
    const chapterNo = worldState.currentChapter?.chapterNo ?? 1;
    const pendingDirectives = await this.wm.peekPendingDirectives(chapterNo);

    let designWorld = worldState;
    const designIsCurrent =
      worldState.storyDesign?.chapterNo === chapterNo &&
      worldState.storyDesign.id === `design-${worldState.turn}` &&
      (!initialAgentPolicy.auditorCanBlockDrift ||
        worldState.storyDesign.continuityAudit?.status === 'passed');
    const shouldRefreshDesign =
      !designIsCurrent &&
      (!worldState.storyDesign ||
        worldState.storyDesign.chapterNo !== chapterNo ||
        worldState.turn % 3 === 0 ||
        pendingDirectives.length > 0);

    if (shouldRefreshDesign && initialAgentPolicy.designerCanPlanCurrentChapter) {
      this.emitLog('info', `Turn ${worldState.turn + 1}: 剧情设计师规划中…`);
      const previousChapterBridge = await loadPreviousChapterBridge(
        this.wm.projectId,
        worldState,
        worldState.currentChapter?.chapterNo
      );
      const design = await this.planAuditedStoryDesign({
        worldState,
        characters,
        recentEvents,
        pendingDirectives,
        previousChapterBridge,
      });
      if (!design) return { shouldStop: true, blocked: true };
      designWorld = { ...worldState, storyDesign: design };
      await this.wm.saveWorldState(designWorld);
      this.cb.emit({ type: 'designer:update', design });
      this.cb.emit({ type: 'world:update', worldState: designWorld });
      this.emitLog('info', `剧情设计师: ${design.currentBeat}`);
    } else if (shouldRefreshDesign && !initialAgentPolicy.designerCanPlanCurrentChapter) {
      this.emitLog('warn', 'Agent 权限：剧情设计师本章设计已关闭，沿用现有设计/章节细纲');
    }

    const appliedDirectives = pendingDirectives.length > 0
      ? await this.wm.consumePendingDirectives(chapterNo)
      : [];
    const actorConstraintHint = buildActorConstraintHint(appliedDirectives);

    // === 1. Director 决策 ===
    this.emitLog('info', `Turn ${designWorld.turn + 1}: Director 决策中…`);
    const decision = await directorDecide(
      this.wm,
      designWorld,
      characters,
      recentEvents,
      appliedDirectives
    );

    if (decision.commentary) {
      this.emitLog('info', `Director: ${decision.commentary}`);
    }

    // === 1.5 新重要角色入库 ===
    const currentTurnEvents: NovelEvent[] = [];
    let turnWorld = designWorld;
    const agentPolicy = normalizeAgentPolicy(turnWorld.agentPolicy);
    const createdCharacters: Character[] = [];
    const existingCharacterNames = new Set(latestCharacters.map((character) => character.name));
    for (const item of (decision.newCharacters ?? []).slice(0, 1)) {
      const name = item.name.trim();
      if (!name || existingCharacterNames.has(name)) continue;

      const created = await this.wm.createCharacter(
        directorNewCharacterToCharacter(item, turnWorld, latestCharacters)
      );
      latestCharacters = [...latestCharacters, created];
      existingCharacterNames.add(created.name);
      createdCharacters.push(created);
      this.cb.emit({ type: 'character:update', character: created });

      if (item.enterScene !== false) {
        turnWorld = ensureChapterFocus({
          ...turnWorld,
          presentCharacterIds: Array.from(new Set([...turnWorld.presentCharacterIds, created.id])),
        });
      }

      const event = await this.wm.appendEvent({
        turn: turnWorld.turn + 1,
        agentId: created.id,
        agentName: created.name,
        type: 'scene_meta',
        content: `重要角色登场：${created.name}。${item.reason || created.persona.background}`,
        target: null,
        emotion: created.currentState.emotion,
        context: null,
        status: 'confirmed',
      });
      this.chapterBuffer.push(event);
      currentTurnEvents.push(event);
      this.cb.emit({ type: 'event:new', event });
      this.emitLog('info', `新增重要角色：${created.name}`);
    }
    if (createdCharacters.length > 0) {
      await this.wm.saveWorldState(turnWorld);
      this.cb.emit({ type: 'world:update', worldState: turnWorld });
    }

    // === 2. 注入 Director 事件 ===
    const allowedInjections = agentPolicy.directorCanIntervene ? (decision.injections ?? []).slice(0, 1) : [];
    if (!agentPolicy.directorCanIntervene && (decision.injections?.length ?? 0) > 0) {
      this.emitLog('warn', 'Agent 权限：Director 跑偏干预已关闭，本轮 injections 已忽略');
    }
    for (const inj of allowedInjections) {
      const event = await this.wm.appendEvent({
        turn: turnWorld.turn + 1,
        agentId: null,
        agentName: 'Director',
        type: inj.type as any,
        content: inj.content,
        target: inj.target ?? null,
        emotion: inj.emotion ?? null,
        status: 'confirmed',
      });
      this.chapterBuffer.push(event);
      currentTurnEvents.push(event);
      this.cb.emit({ type: 'event:new', event });
      this.emitLog('info', `Director 注入: ${event.content}`);
    }

    // === 3. 角色行动 ===
    const presentChars = latestCharacters.filter((c) =>
      turnWorld.presentCharacterIds.includes(c.id)
    );

    // 用 Director 决策中的 selected 顺序
    let selectedChars: Character[] = decision.selected
      .map((p) => presentChars.find((c) => c.id === p.characterId))
      .filter(Boolean) as Character[];

    if (selectedChars.length === 0) {
      // fallback: 让前 2 个在场角色行动
      selectedChars = presentChars.slice(0, 2);
    }

    const maxActorsThisTurn = turnWorld.tension >= 8 ? 3 : 2;
    selectedChars = selectedChars.slice(0, maxActorsThisTurn);

    for (const c of selectedChars) {
      await this.cb.waitWhilePaused();
      if (this.cb.isStopped()) return { shouldStop: true, blocked: false };

      const currentCharacter =
        latestCharacters.find((item) => item.id === c.id) ?? c;
      const visibleEvents = recentEvents.concat(this.chapterBuffer.slice(-8));
      const contextIds = this.chapterBuffer
        .slice(-3)
        .map((event) => event.id);
      const turnHint = buildTurnActorHint(
        decision.commentary,
        currentTurnEvents,
        actorConstraintHint
      );

      this.emitLog('info', `Turn ${turnWorld.turn + 1}: ${c.name} 思考中…`);
      const proposal = await characterPropose(
        this.wm,
        currentCharacter,
        turnWorld,
        latestCharacters,
        visibleEvents,
        turnHint
      );
      this.emitLog(
        'info',
        `${c.name} 提案: [${proposal.type}] ${proposal.content}`
      );

      const { event, updatedCharacter } = await commitProposal(
        this.wm,
        proposal,
        turnWorld.turn + 1,
        contextIds
      );
      this.chapterBuffer.push(event);
      currentTurnEvents.push(event);
      this.cb.emit({ type: 'event:new', event });
      this.cb.emit({ type: 'character:update', character: updatedCharacter });
      latestCharacters = latestCharacters.map((c) =>
        c.id === updatedCharacter.id ? updatedCharacter : c
      );
    }

    // === 6. 应用本轮真实发生的成长/掉落/装备变化 ===
    const directorProgressEvidence = validateCharacterProgressEvidence(
      decision.characterUpdates ?? [],
      [...recentEvents, ...currentTurnEvents]
    );
    if (directorProgressEvidence.rejected.length > 0) {
      this.emitLog(
        'warn',
        `成长结算已拦截 ${directorProgressEvidence.rejected.length} 条无事件证据的等级/经验/技能/装备/状态变化`
      );
    }
    const automaticProgressUpdates = buildAutomaticProgressionUpdates(
      turnWorld,
      currentTurnEvents,
      latestCharacters,
      directorProgressEvidence.accepted
    );
    if (automaticProgressUpdates.length > 0) {
      this.emitLog(
        'info',
        `成长结算兜底：检测到击杀事件但 Director 未给经验，已自动补记 ${automaticProgressUpdates.map((item) => `${item.characterName}+${item.expDelta}`).join('、')}`
      );
    }
    const rawCharacterProgressUpdates = [
      ...directorProgressEvidence.accepted,
      ...automaticProgressUpdates,
    ];
    const characterProgressUpdates = mergeCharacterProgressUpdates(rawCharacterProgressUpdates);
    if (characterProgressUpdates.length < rawCharacterProgressUpdates.length) {
      this.emitLog(
        'warn',
        `成长/状态归档合并：本轮 ${rawCharacterProgressUpdates.length} 条人物更新合并为 ${characterProgressUpdates.length} 条，避免同一角色重复结算经验或掉落`
      );
    }
    const progressEvents = agentPolicy.directorCanUpdateCharacters
      ? await this.applyCharacterProgressUpdates(
          characterProgressUpdates,
          latestCharacters,
          turnWorld.turn + 1
        )
      : { characters: latestCharacters, updatedCharacters: [], events: [] };
    if (!agentPolicy.directorCanUpdateCharacters && characterProgressUpdates.length > 0) {
      this.emitLog('warn', 'Agent 权限：Director 人物档案归档已关闭，本轮 characterUpdates 已忽略');
    }
    if (progressEvents.events.length > 0) {
      latestCharacters = progressEvents.characters;
      for (const event of progressEvents.events) {
        this.chapterBuffer.push(event);
        this.cb.emit({ type: 'event:new', event });
      }
      for (const character of progressEvents.updatedCharacters) {
        this.cb.emit({ type: 'character:update', character });
      }
    }

    // === 7. 更新 World State ===
    // 判断本 Turn 是否推进了主线节点（通过 Director commentary 或 injection 内容判断）
    const directorText = (decision.commentary ?? '') + ' ' + (decision.injections ?? []).map(i => i.content).join(' ');
    const activeNodeIndexes = new Set(turnWorld.currentChapter?.activeNodeIndexes ?? []);
    const advancedMainNode =
      activeNodeIndexes.size > 0 &&
      /本章推进|章内推进|当前章|章节拍点/.test(directorText);

    // 节点完成检测：如果 Director 注入的事件提到"完成"某节点，标记完成
    let updatedPlotNodes = turnWorld.plotNodes;
    const chapterStartTurn = resolveChapterStartTurn(turnWorld, turnWorld.currentChapter);
    const chapterTurnAfterThisTurn = Math.max(0, turnWorld.turn + 1 - chapterStartTurn);
    const turnThreshold = turnWorld.currentChapter?.targetTurns ?? 8;
    const explicitChapterDone = /本章完成|章节完成|章末钩子完成|当前章完成/.test(directorText);
    const explicitPlotNodeDone = /剧情节点完成|阶段节点完成|主线节点完成/.test(directorText);
    const chapterCompleted = explicitChapterDone || nextWorld_turnReached(chapterTurnAfterThisTurn, turnThreshold);
    if (updatedPlotNodes && updatedPlotNodes.length > 0) {
      const nextNode = updatedPlotNodes.find(n =>
        !n.completed &&
        (activeNodeIndexes.size === 0 || activeNodeIndexes.has(n.index))
      );
      if (nextNode) {
        if (explicitPlotNodeDone) {
          updatedPlotNodes = updatedPlotNodes.map(n =>
            n.index === nextNode.index ? { ...n, completed: true } : n
          );
          this.emitLog('info', `剧情节点完成：${nextNode.title}`);
        }
      }
    }

    const nextWorld: WorldState = ensureChapterFocus({
      ...designWorld,
      ...turnWorld,
      turn: turnWorld.turn + 1,
      tension: Math.max(0, Math.min(10, turnWorld.tension + decision.tensionDelta)),
      plotNodes: updatedPlotNodes,
      turnsSinceLastMain: advancedMainNode ? 0 : (turnWorld.turnsSinceLastMain ?? 0) + 1,
      currentMainNodeIndex: updatedPlotNodes?.findIndex(n => n.nodeType === 'main' && !n.completed) ?? turnWorld.currentMainNodeIndex,
      ...(agentPolicy.directorCanPatchScene ? (decision.nextScenePatch ?? {}) : {}),
	    });
    if (!agentPolicy.directorCanPatchScene && decision.nextScenePatch) {
      this.emitLog('warn', 'Agent 权限：Director 场景补丁已关闭，本轮 nextScenePatch 已忽略');
    }
    await this.wm.saveWorldState(nextWorld);
    this.cb.emit({
      type: 'engine:state',
      status: 'running',
      turn: nextWorld.turn,
    });
    this.cb.emit({ type: 'world:update', worldState: nextWorld });

    // === 8. 是否到达本章收束点 ===
    const writerMaterialReady =
      chapterCompleted || this.chapterBuffer.length >= WRITER_CHUNK_THRESHOLD;
    if (decision.triggerWriter && !writerMaterialReady) {
      this.emitLog(
        'info',
        `Director 想触发 Writer，但本章素材还不足以稳定写成 ${chapterWordLabel(designWorld)}，继续演绎`
      );
    }
    if (chapterCompleted) {
      this.emitLog(
        'info',
        `第 ${designWorld.currentChapter?.chapterNo ?? 1} 章达到收束点（${chapterTurnAfterThisTurn}/${turnThreshold} 轮），普通演绎已暂停；确认事件无误后再点“生成正文”`
      );
      return { shouldStop: true, blocked: false };
    }
    if ((decision.triggerWriter && writerMaterialReady) || this.chapterBuffer.length >= WRITER_CHUNK_THRESHOLD) {
      this.emitLog(
        'info',
        `本章素材已足够生成正文；普通演绎不自动写正文，请确认事件后手动点击“生成正文”`
      );
    }

    return { shouldStop: false, blocked: false };
  }

  private async applyCharacterProgressUpdates(
    updates: CharacterProgressUpdate[],
    characters: Character[],
    turn: number
  ): Promise<{
    characters: Character[];
    updatedCharacters: Character[];
    events: NovelEvent[];
  }> {
    if (updates.length === 0) {
      return { characters, updatedCharacters: [], events: [] };
    }

    let nextCharacters = characters;
    const updatedCharacters: Character[] = [];
    const events: NovelEvent[] = [];

    for (const update of updates) {
      const character = nextCharacters.find((c) =>
        (update.characterId && c.id === update.characterId) ||
        (update.characterName && c.name === update.characterName.trim())
      );
      if (!character) continue;

      const gender = cleanText(update.gender);
      const genderChangeAllowed = canCorrectHardProfileField(
        character.persona.gender,
        gender,
        update.reason
      );
      const background = cleanText(update.background);
      const stance = cleanText(update.stance);
      const speechStyle = cleanText(update.speechStyle);
      const appearance = cleanText(update.appearance);
      const backstory = cleanText(update.backstory);
      const growthArc = cleanText(update.growthArc);
      const innerConflict = cleanText(update.innerConflict);
      const progression = applyExperience(
        character.currentState.level,
        character.currentState.exp,
        update.expDelta,
        update.level
      );
      const shouldWriteProgression =
        typeof character.currentState.level === 'number' ||
        typeof character.currentState.exp === 'number' ||
        typeof character.currentState.nextLevelExp === 'number' ||
        progression.expGained > 0 ||
        typeof update.level === 'number';

      const next: Character = {
        ...character,
        persona: {
          ...character.persona,
          gender: genderChangeAllowed ? gender : character.persona.gender,
          background: background || character.persona.background,
          personality: addUnique(character.persona.personality, update.personality),
          goals: addUnique(character.persona.goals, update.goals),
          stance: stance || character.persona.stance,
          speechStyle: speechStyle || character.persona.speechStyle,
          appearance: appearance || character.persona.appearance,
          backstory: backstory || character.persona.backstory,
          growthArc: growthArc || character.persona.growthArc,
          innerConflict: innerConflict || character.persona.innerConflict,
          secrets: addUnique(character.persona.secrets, update.secrets),
          motivations: addUnique(character.persona.motivations, update.motivations),
          speechHabits: addUnique(character.persona.speechHabits, update.speechHabits),
          profession: update.profession || character.persona.profession,
          skills: removeItems(
            addUnique(character.persona.skills, update.addSkills),
            update.removeSkills
          ),
          equipment: removeItems(
            addUnique(character.persona.equipment, update.addEquipment),
            update.removeEquipment
          ),
          talents: addUnique(character.persona.talents, update.addTalents),
          mounts: removeItems(
            addUnique(character.persona.mounts, update.addMounts),
            update.removeMounts
          ),
          pets: removeItems(
            addUnique(character.persona.pets, update.addPets),
            update.removePets
          ),
          inventory: removeItems(
            addUnique(character.persona.inventory, update.addInventory),
            update.removeInventory
          ),
          titles: addUnique(character.persona.titles, update.addTitles),
        },
        currentState: {
          ...character.currentState,
          level: shouldWriteProgression ? progression.level : character.currentState.level,
          exp: shouldWriteProgression ? progression.exp : character.currentState.exp,
          nextLevelExp: shouldWriteProgression
            ? progression.nextLevelExp
            : character.currentState.nextLevelExp,
          buffs: removeItems(
            addUnique(character.currentState.buffs, update.addBuffs),
            update.removeBuffs
          ),
        },
      };

      await this.wm.saveCharacter(next);
      nextCharacters = nextCharacters.map((c) => (c.id === next.id ? next : c));
      updatedCharacters.push(next);

      const changes = [
        genderChangeAllowed ? `性别修正：${gender}` : '',
        gender && !genderChangeAllowed && gender !== character.persona.gender ? `忽略性别漂移：${gender}` : '',
        background ? '背景补充' : '',
        normalizeList(update.personality).length ? `性格补充：${normalizeList(update.personality).join('、')}` : '',
        normalizeList(update.goals).length ? `目标更新：${normalizeList(update.goals).join('、')}` : '',
        stance ? `立场更新：${stance}` : '',
        speechStyle ? `说话方式更新：${speechStyle}` : '',
        appearance ? '外貌更新' : '',
        backstory ? '背景故事补充' : '',
        growthArc ? `成长弧线更新：${growthArc}` : '',
        innerConflict ? `内在冲突更新：${innerConflict}` : '',
        normalizeList(update.secrets).length ? `秘密/伏笔补充：${normalizeList(update.secrets).join('、')}` : '',
        normalizeList(update.motivations).length ? `动机补充：${normalizeList(update.motivations).join('、')}` : '',
        normalizeList(update.speechHabits).length ? `语言习惯补充：${normalizeList(update.speechHabits).join('、')}` : '',
        progression.expGained > 0 ? `获得经验 +${progression.expGained}` : '',
        progression.levelUps > 0 ? `升级至 Lv ${progression.level}` : '',
        update.level && progression.levelUps === 0 && progression.level !== character.currentState.level ? `等级修正为 Lv ${progression.level}` : '',
        update.profession ? `职业：${update.profession}` : '',
        normalizeList(update.addSkills).length ? `获得技能：${normalizeList(update.addSkills).join('、')}` : '',
        normalizeList(update.removeSkills).length ? `失去技能：${normalizeList(update.removeSkills).join('、')}` : '',
        normalizeList(update.addEquipment).length ? `获得装备：${normalizeList(update.addEquipment).join('、')}` : '',
        normalizeList(update.removeEquipment).length ? `移除装备：${normalizeList(update.removeEquipment).join('、')}` : '',
        normalizeList(update.addTalents).length ? `显现天赋：${normalizeList(update.addTalents).join('、')}` : '',
        normalizeList(update.addMounts).length ? `获得坐骑：${normalizeList(update.addMounts).join('、')}` : '',
        normalizeList(update.removeMounts).length ? `失去坐骑：${normalizeList(update.removeMounts).join('、')}` : '',
        normalizeList(update.addPets).length ? `获得宠物/契约兽：${normalizeList(update.addPets).join('、')}` : '',
        normalizeList(update.removePets).length ? `失去宠物/契约兽：${normalizeList(update.removePets).join('、')}` : '',
        normalizeList(update.addInventory).length ? `获得物品：${normalizeList(update.addInventory).join('、')}` : '',
        normalizeList(update.removeInventory).length ? `消耗物品：${normalizeList(update.removeInventory).join('、')}` : '',
        normalizeList(update.addTitles).length ? `获得称号：${normalizeList(update.addTitles).join('、')}` : '',
        normalizeList(update.addBuffs).length ? `获得状态：${normalizeList(update.addBuffs).join('、')}` : '',
        normalizeList(update.removeBuffs).length ? `移除状态：${normalizeList(update.removeBuffs).join('、')}` : '',
      ].filter(Boolean);

      const event = await this.wm.appendEvent({
        turn,
        agentId: next.id,
        agentName: next.name,
        type: 'state_change',
        content: `角色档案更新：${changes.join('；') || '状态发生变化'}。依据：${update.reason || '本轮演绎结果'}`,
        target: null,
        emotion: null,
        context: null,
        status: 'confirmed',
      });
      events.push(event);
      this.emitLog('info', `${next.name} 档案更新：${changes.join('；') || update.reason}`);
    }

    return { characters: nextCharacters, updatedCharacters, events };
  }

  /** 触发 Writer：把累积事件生成为小说文本 */
  private async runWriter(
    worldState: WorldState,
    characters: Character[]
  ): Promise<WriterRunResult> {
    if (this.chapterBuffer.length === 0) return { completed: false, reviews: [] };

    await this.cb.waitWhilePaused();
    if (this.cb.isStopped()) return { completed: false, reviews: [] };

    const projectId = this.wm.projectId;
    if (activeWriterProjects.has(projectId)) {
      this.emitLog('warn', 'Writer 已在生成正文，本次重复写作请求已忽略');
      return { completed: false, reviews: [] };
    }
    activeWriterProjects.add(projectId);
    try {
      return await this.runWriterLocked(worldState, characters);
    } finally {
      activeWriterProjects.delete(projectId);
    }
  }

  private async runWriterLocked(
    worldState: WorldState,
    characters: Character[]
  ): Promise<WriterRunResult> {
    const template = await this.wm.getTemplate();
    const events = [...this.chapterBuffer];
    const startTurn = this.chapterStartTurn;
    const endTurn = worldState.turn;
    const previousChapterBridge = await loadPreviousChapterBridge(
      this.wm.projectId,
      worldState,
      worldState.currentChapter?.chapterNo
    );
    const previousWriterText = this.lastWriterText || previousChapterBridge?.tail || '';

    this.emitLog(
      'info',
      `Writer 生成中（${events.length} 个事件，T${startTurn}-T${endTurn}）…`
    );

    const chapterId = uuid();
    let fullText = '';
    try {
      fullText = await writerStream(
        this.wm,
        {
          template,
          worldSceneName: worldState.sceneName,
          worldSceneDescription: worldState.sceneDescription,
          characters,
          events,
          previousText: previousWriterText,
          craftLessons: worldState.craftLessons ?? [],
          currentChapter: worldState.currentChapter,
          storyDesign: worldState.storyDesign,
          previousChapterBridge,
          writerHint: worldState.writerHint,
          writerCustomBrief: worldState.agentPolicy?.writerCustomBrief,
        },
        (chunk) => {
          this.cb.emit({ type: 'writer:chunk', chunk, chapterId });
        }
      );
    } catch (err: any) {
      this.emitLog('error', `Writer 生成失败：${err.message}`);
      return { completed: false, reviews: [] };
    }

    const targetMin = worldState.currentChapter?.targetWordMin ?? CHAPTER_WORD_TARGET_MIN;
    const targetMax = worldState.currentChapter?.targetWordMax ?? CHAPTER_WORD_TARGET_MAX;
    const repaired = await repairChapterUntilValid({
      content: fullText,
      targetMin,
      targetMax,
      characters,
      requiredCharacterNames: requiredCharacterNamesFromText(
        characters,
        worldState.storyDesign?.currentBeat,
        worldState.storyDesign?.scenePurpose,
        ...(worldState.storyDesign?.eventSeeds ?? []),
        ...(worldState.storyDesign?.settingGuardrails ?? []),
        ...(worldState.storyDesign?.directorNotes ?? [])
      ),
      currentChapter: worldState.currentChapter,
      storyDesign: worldState.storyDesign,
      previousChapterBridge,
      sourceContext: [
        previousChapterBridge?.prompt,
        events.map((event) => `T${event.turn} ${event.agentName}/${event.type}: ${event.content}`).join('\n'),
      ].filter(Boolean).join('\n\n'),
      maxAttempts: 4,
    });
    if (repaired.validation.issues.length > 0) {
      const message = repaired.validation.issues.map((issue) => issue.message).join('；');
      this.emitLog('error', `Writer 校验失败，未保存正文：${message}`);
      this.cb.emit({ type: 'writer:failed', chapterId, message });
      return { completed: false, reviews: [] };
    }
    if (repaired.repairAttempts > 0) {
      fullText = repaired.content;
      this.emitLog(
        'info',
        `Writer 已自动修稿 ${repaired.repairAttempts} 轮，当前可读字数 ${repaired.validation.readableCount}`
      );
    }

    // 保存到数据库。chapterId 同时作为流式输出 ID，便于后续评审挂载。
    const chapterNo = worldState.currentChapter?.chapterNo;
    const chapterTitle = worldState.currentChapter?.title;
    await saveChapter(this.wm, worldState.sceneName, fullText, startTurn, endTurn, chapterId, {
      chapterNo,
      chapterTitle,
    });
    if (typeof chapterNo === 'number') {
      const nextWorldState = withCanonicalChapterId(worldState, chapterNo, chapterId);
      await this.wm.saveWorldState(nextWorldState);
      worldState = nextWorldState;
    }
    const chapter: ChapterSummary = {
      id: chapterId,
      chapterNo,
      chapterTitle,
      sceneName: worldState.sceneName,
      content: fullText,
      wordCount: countReadableChars(fullText),
      startTurn,
      endTurn,
      createdAt: new Date().toISOString(),
    };
    this.lastWriterText = fullText;
    this.cb.emit({ type: 'writer:done', chapterId, content: fullText, chapter });

    let reviews: ReaderReview[] = [];
    let lesson: NovelCraftLesson | undefined;
    try {
      this.emitLog('info', 'Reader 评审中：文笔、节奏、设定一致性…');
      reviews = await runReaderReviews(this.wm, {
        chapterId,
        sceneName: worldState.sceneName,
        sceneDescription: worldState.sceneDescription,
        chapterText: fullText,
        events,
        characters: characters.filter((c) =>
          worldState.presentCharacterIds.includes(c.id)
        ),
        previousText: previousChapterBridge?.prompt ?? previousWriterText,
        currentChapter: worldState.currentChapter,
      });
      for (const review of reviews) {
        this.cb.emit({ type: 'reader:review', review });
      }
      this.emitLog('info', `Reader 完成：${reviews.length} 条评审`);
      lesson = await this.summarizeAndPersistCraftLesson(worldState, chapter, reviews, events);
      if (lesson && this.autoImproveMode) {
        await this.wm.queueDirective('command', buildDirectorDirectiveFromLesson(lesson));
        this.emitLog('info', '评审经验已自动转成下一轮 Director 改进指令');
      }
    } catch (err: any) {
      this.emitLog(
        'error',
        `Reader 评审失败：${err.message}。正文已保存为未评审稿，章节循环停在评审步骤`
      );
      return { completed: false, chapter, reviews: [] };
    }

    if (reviews.length !== 3) {
      this.emitLog(
        'error',
        `Reader 评审不完整：应有 3 条，实际 ${reviews.length} 条。正文已保存为未评审稿，章节未完成`
      );
      return { completed: false, chapter, reviews };
    }

    try {
      const refreshed = await this.wm.loadProject();
      const presentCharacters = refreshed.characters.filter((character) =>
        worldState.presentCharacterIds.includes(character.id)
      );
      this.emitLog('info', '人物档案归档中：根据本章正文、事件和评审校准角色信息…');
      const archiveUpdates = await summarizeCharacterChapterUpdates({
        chapterText: fullText,
        events,
        characters: presentCharacters,
        reviews,
        currentChapter: worldState.currentChapter,
      });
      const archiveResult = await this.applyCharacterProgressUpdates(
        archiveUpdates,
        refreshed.characters,
        worldState.turn
      );
      if (archiveResult.events.length > 0) {
        for (const event of archiveResult.events) {
          this.cb.emit({ type: 'event:new', event });
        }
        for (const character of archiveResult.updatedCharacters) {
          this.cb.emit({ type: 'character:update', character });
        }
        this.emitLog('info', `人物档案归档完成：更新 ${archiveResult.updatedCharacters.length} 人`);
      } else {
        this.emitLog('info', '人物档案归档完成：本章无明确档案变化');
      }
    } catch (err: any) {
      this.emitLog('warn', `人物档案归档失败：${err.message}`);
    }

    // 重置 buffer
    this.chapterBuffer = [];
    this.chapterStartTurn = worldState.turn + 1;
    this.emitLog('info', `Writer 完成，本段 ${fullText.length} 字`);
    return { completed: true, chapter, reviews, lesson };
  }

  private async runAutoWriterRevisionCycle(
    focusedWorld: WorldState,
    characters: Character[],
    events: NovelEvent[],
    startTurn: number,
    maxDrafts = AUTO_REVIEW_REVISION_DRAFTS
  ): Promise<WriterRunResult> {
    let currentWorld = ensureChapterFocus(focusedWorld);
    let currentCharacters = characters;
    let lastResult: WriterRunResult = { completed: false, reviews: [] };

    for (let draftNo = 1; draftNo <= maxDrafts && !this.cb.isStopped(); draftNo++) {
      await this.cb.waitWhilePaused();
      const revision = draftNo > 1;
      this.chapterBuffer = [...events];
      this.chapterStartTurn = startTurn;
      this.emitLog(
        'info',
        revision
          ? `章节自循环：根据 Reader 评审和导演回流写第 ${draftNo} 版修正版`
          : `章节自循环：Writer 写第 ${draftNo} 版初稿并交给 Reader 评审`
      );

      const result = await this.runWriter(currentWorld, currentCharacters);
      lastResult = result;
      if (!result.completed) return result;
      if (result.reviews.length !== 3) {
        this.emitLog('error', '章节自循环：Reader 评审不完整，停在评审步骤，不会误标完成');
        return { ...result, completed: false };
      }

      const maxReviewSeverity = result.reviews.reduce(
        (max, review) => Math.max(max, review.severity),
        result.lesson?.severity ?? 0
      );
      const shouldRevise =
        draftNo < maxDrafts &&
        (result.lesson || result.reviews.length > 0) &&
        maxReviewSeverity >= 3;

      if (!shouldRevise) {
        this.emitLog(
          'info',
          maxReviewSeverity >= 3
            ? '章节自循环：已达到自动修稿上限，最后一版设为本章正稿'
            : '章节自循环：Reader 未发现需要自动回炉的问题，当前稿设为本章正稿'
        );
        break;
      }

      this.emitLog(
        'info',
        `章节自循环：Reader 严重度 ${maxReviewSeverity}/5，回流导演设计后自动再写一版`
      );
      if (!(await this.prepareStoryDesign())) return lastResult;
      const refreshed = await this.wm.loadProject();
      currentWorld = ensureChapterFocus(refreshed.worldState);
      currentCharacters = refreshed.characters;
    }

    return lastResult;
  }

  private async advanceAfterCompletedChapter(focusedWorld: WorldState, logPrefix: string): Promise<void> {
    const refreshed = ensureChapterFocus((await this.wm.loadProject()).worldState);
    const baseWorld =
      refreshed.currentChapter?.chapterNo === focusedWorld.currentChapter?.chapterNo
        ? refreshed
        : focusedWorld;
    const advancedWorld = advanceChapterFocus(baseWorld);
    await this.wm.saveWorldState(advancedWorld);
    await this.wm.saveCurrentChapterCharacterSnapshot();
    this.chapterBuffer = [];
    this.chapterStartTurn = advancedWorld.turn;
    this.cb.emit({ type: 'world:update', worldState: advancedWorld });
    this.emitLog(
      'info',
      `${logPrefix}：第 ${baseWorld.currentChapter?.chapterNo ?? 1} 章已定稿，进入第 ${advancedWorld.currentChapter?.chapterNo ?? 1} 章焦点`
    );
  }

  private async maybeForceWriterForAutoCycle(force: boolean): Promise<WriterRunResult> {
    if (this.chapterBuffer.length === 0) return { completed: false, reviews: [] };

    const { worldState, characters } = await this.wm.loadProject();
    const focusedWorld = await this.reopenEmptyChapterIfNeeded(worldState, '正文生成前');
    const chapterStartTurn = resolveChapterStartTurn(focusedWorld, focusedWorld.currentChapter);
    const chapterTurn = Math.max(0, focusedWorld.turn - chapterStartTurn);
    const targetTurns = focusedWorld.currentChapter?.targetTurns ?? 8;
    const chapterReady = chapterTurn >= targetTurns || this.chapterBuffer.length >= WRITER_CHUNK_THRESHOLD;

    if (!chapterReady) {
      if (force) {
        this.emitLog(
          'info',
          `章节自循环：本章素材还不足以写成 ${chapterWordLabel(focusedWorld)}（${chapterTurn}/${targetTurns} 轮），继续设计和演绎`
        );
      }
      return { completed: false, reviews: [] };
    }

    if (!force && this.chapterBuffer.length < WRITER_CHUNK_THRESHOLD) {
      return { completed: false, reviews: [] };
    }

    this.emitLog(
      'info',
      force
        ? `章节自循环：本章达到收束点，写出 ${chapterWordLabel(focusedWorld)} 正文（${this.chapterBuffer.length} 个事件）`
        : `章节自循环：事件达到安全阈值，写出 ${chapterWordLabel(focusedWorld)} 正文`
    );
    const events = [...this.chapterBuffer];
    const result = this.autoImproveMode
      ? await this.runAutoWriterRevisionCycle(focusedWorld, characters, events, this.chapterStartTurn)
      : await this.runWriter(focusedWorld, characters);
    if (result.completed) {
      await this.advanceAfterCompletedChapter(focusedWorld, '章节自循环');
    }
    return result;
  }

  /** 从数据库里已经确认的本章事件生成正文，不再追加新的演绎事件。 */
  async writeCurrentChapter(): Promise<WriterRunResult> {
    if (!(await this.ensureGenerationReady('生成正文'))) {
      return { completed: false, reviews: [] };
    }

    const { worldState, characters } = await this.wm.loadProject();
    const focusedWorld = ensureChapterFocus(worldState);
    const progress = chapterProgress(focusedWorld);
    if (progress.current < progress.target) {
      this.emitLog(
        'warn',
        `第 ${focusedWorld.currentChapter?.chapterNo ?? 1} 章还没到收束点（${progress.current}/${progress.target}），先继续演绎，不生成正文`
      );
      return { completed: false, reviews: [] };
    }

    await this.wm.setProjectStatus('running');
    this.cb.emit({ type: 'engine:state', status: 'running', turn: focusedWorld.turn });
    try {
      return await this.writeCurrentChapterFromSavedEvents(focusedWorld, characters);
    } finally {
      await this.wm.setProjectStatus('idle').catch(() => {});
      this.cb.emit({ type: 'engine:state', status: 'idle', turn: -1 });
    }
  }

  private async writeCurrentChapterFromSavedEvents(
    worldState: WorldState,
    characters: Character[],
    options: { autoRevision?: boolean } = {}
  ): Promise<WriterRunResult> {
    const focusedWorld = ensureChapterFocus(worldState);
    const progress = chapterProgress(focusedWorld);
    const events = await this.wm.getChapterEvents(progress.startTurn, focusedWorld.turn);

    if (events.length === 0) {
      this.emitLog(
        'warn',
        `第 ${focusedWorld.currentChapter?.chapterNo ?? 1} 章没有可写入正文的本章事件，请先重置本章或补跑到收束点`
      );
      return { completed: false, reviews: [] };
    }

    this.chapterBuffer = events;
    this.chapterStartTurn = progress.startTurn;
    const result = options.autoRevision || this.autoImproveMode
      ? await this.runAutoWriterRevisionCycle(focusedWorld, characters, events, progress.startTurn)
      : await this.runWriter(focusedWorld, characters);
    if (result.completed) {
      await this.advanceAfterCompletedChapter(
        focusedWorld,
        options.autoRevision || this.autoImproveMode ? '章节自循环' : '正文生成'
      );
    }
    return result;
  }

  private async summarizeAndPersistCraftLesson(
    worldState: WorldState,
    chapter: ChapterSummary,
    reviews: ReaderReview[],
    events: NovelEvent[]
  ): Promise<NovelCraftLesson | undefined> {
    if (reviews.length === 0) return undefined;

    const loaded = await this.wm.loadProject();
    const currentWorld = ensureChapterFocus(loaded.worldState);
    const previousLessons = currentWorld.craftLessons ?? [];
    const lesson = await summarizeCraftLesson({
      worldState: currentWorld,
      chapter,
      reviews,
      events,
      previousLessons,
    });
    const nextLessons = [...previousLessons, lesson].slice(-20);
    const nextWorld = { ...currentWorld, craftLessons: nextLessons };
    await this.wm.saveWorldState(nextWorld);
    this.cb.emit({ type: 'craft:lesson', lesson });
    this.cb.emit({ type: 'world:update', worldState: nextWorld });
    this.emitLog('info', `经验总结：${lesson.summary}`);
    return lesson;
  }

  private emitLog(level: 'info' | 'warn' | 'error', message: string) {
    this.cb.emit({ type: 'log', level, message });
    // 同时打 stdout，方便 mini-service 日志
    if (level === 'error') console.error(`[Engine] ${message}`);
    else console.log(`[Engine] ${message}`);
  }

  private async ensureGenerationReady(actionName: string): Promise<boolean> {
    try {
      await ensureLLMReady();
      return true;
    } catch (err) {
      await this.wm.setProjectStatus('idle').catch(() => {});
      this.cb.emit({ type: 'engine:state', status: 'idle', turn: -1 });
      this.emitLog('error', `${actionName}未启动：${toLLMUserMessage(err)}`);
      return false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
