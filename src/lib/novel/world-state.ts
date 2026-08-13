/**
 * World State 管理器
 * 
 * 职责：
 *   - 加载/持久化 World State（Prisma + JSON）
 *   - 加载/持久化角色状态
 *   - 追加事件日志（不可变）
 *   - 应用用户干预（World State 编辑 / Director 指令）
 */

import { db } from '../db';
import type {
  Character,
  CharacterPersona,
  CharacterState,
  NovelEvent,
  ReaderReview,
  WorldState,
  WorldTemplate,
} from './types';
import { getTemplate } from './templates/online-game';
import { v4 as uuid } from 'uuid';
import { ensureChapterFocus } from './chapter-focus';
import { ensureChapterCharacterSnapshot } from './chapter-character-snapshot';
import { expRequiredForNextLevel } from './progression';
import { DEFAULT_AGENT_POLICY, normalizeAgentPolicy } from './agent-policy';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]'
  );
}

function assertPlainPatch(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(`${label} 必须是对象补丁，不能是文本或数组`);
  }
}

function stripNumericKeys<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !/^\d+$/.test(key))
  ) as T;
}

function normalizeWorldStateJson(value: string): WorldState {
  const parsed = JSON.parse(value);
  assertPlainPatch(parsed, 'World State');
  return ensureChapterFocus(stripNumericKeys(parsed) as unknown as WorldState);
}

/** 把 Prisma 行 → 前端 Character */
export function rowToCharacter(row: any): Character {
  const currentState = JSON.parse(row.currentState) as CharacterState;
  const normalizedState: CharacterState =
    typeof currentState.level === 'number'
      ? {
          ...currentState,
          exp: currentState.exp ?? 0,
          nextLevelExp: currentState.nextLevelExp ?? expRequiredForNextLevel(currentState.level),
        }
      : currentState;

  return {
    id: row.id,
    name: row.name,
    role: row.role,
    persona: JSON.parse(row.persona) as CharacterPersona,
    currentState: normalizedState,
  };
}

/** 把 Prisma 行 → NovelEvent */
export function rowToEvent(row: any): NovelEvent {
  return {
    id: row.id,
    turn: row.turn,
    agentId: row.agentId,
    agentName: row.agentName,
    type: row.type,
    content: row.content,
    target: row.target,
    emotion: row.emotion,
    context: row.context,
    status: row.status,
    createdAt: row.createdAt,
  };
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** 把 Prisma 行 → ReaderReview */
export function rowToReaderReview(row: any): ReaderReview {
  return {
    id: row.id,
    projectId: row.projectId,
    chapterId: row.chapterId,
    readerId: row.readerId,
    readerName: row.readerName,
    focus: row.focus,
    severity: row.severity,
    summary: row.summary,
    praise: row.praise,
    problems: parseStringArray(row.problems),
    suggestions: parseStringArray(row.suggestions),
    exposedQuestions: parseStringArray(row.exposedQuestions),
    createdAt: row.createdAt,
  };
}

export class WorldManager {
  constructor(public projectId: string) {}

  /** 加载项目 + 世界状态 */
  async loadProject() {
    const project = await db.project.findUnique({
      where: { id: this.projectId },
      include: { characters: true },
    });
    if (!project) throw new Error(`Project ${this.projectId} not found`);
    let worldState = normalizeWorldStateJson(project.worldState);
    if (!worldState.agentPolicy) {
      worldState = { ...worldState, agentPolicy: normalizeAgentPolicy() };
      await db.project.update({
        where: { id: this.projectId },
        data: { worldState: JSON.stringify(worldState) },
      });
    }
    const characters = project.characters.map(rowToCharacter);
    const template = getTemplate(project.template);
    return { project, worldState, characters, template };
  }

  async getTemplate(): Promise<WorldTemplate> {
    const project = await db.project.findUnique({
      where: { id: this.projectId },
      select: { template: true },
    });
    return getTemplate(project?.template ?? 'online-game');
  }

  /** 持久化 World State */
  async saveWorldState(worldState: WorldState) {
    const next = ensureChapterFocus(stripNumericKeys(worldState as unknown as Record<string, unknown>) as unknown as WorldState);
    await db.project.update({
      where: { id: this.projectId },
      data: {
        worldState: JSON.stringify(next),
        currentTurn: next.turn,
      },
    });
  }

  /** 持久化单个角色状态 */
  async saveCharacter(character: Character) {
    await db.character.update({
      where: { id: character.id },
      data: {
        persona: JSON.stringify(character.persona),
        currentState: JSON.stringify(character.currentState),
      },
    });
  }

  async saveCurrentChapterCharacterSnapshot(options: { overwrite?: boolean } = {}) {
    const { worldState, characters } = await this.loadProject();
    return ensureChapterCharacterSnapshot(this.projectId, worldState, characters, options);
  }

  /** 创建新角色。用于剧情推进中出现的长期重要人物；同名角色直接复用。 */
  async createCharacter(character: Omit<Character, 'id'>): Promise<Character> {
    const existing = await db.character.findFirst({
      where: {
        projectId: this.projectId,
        name: character.name,
      },
    });
    if (existing) return rowToCharacter(existing);

    const row = await db.character.create({
      data: {
        projectId: this.projectId,
        name: character.name,
        role: character.role,
        persona: JSON.stringify(character.persona),
        currentState: JSON.stringify(character.currentState),
      },
    });
    return rowToCharacter(row);
  }

  /** 追加事件（不可变，只能追加） */
  async appendEvent(event: Omit<NovelEvent, 'id' | 'createdAt'>): Promise<NovelEvent> {
    const row = await db.event.create({
      data: {
        projectId: this.projectId,
        turn: event.turn,
        agentId: event.agentId,
        agentName: event.agentName,
        type: event.type,
        content: event.content,
        target: event.target ?? null,
        emotion: event.emotion ?? null,
        context: event.context ?? null,
        status: event.status,
      },
    });
    return rowToEvent(row);
  }

  /** 批量获取事件（按时间正序） */
  async getEvents(limit = 100, fromTurn = 0) {
    const rows = await db.event.findMany({
      where: {
        projectId: this.projectId,
        status: 'confirmed',
        turn: { gte: fromTurn },
      },
      orderBy: [{ turn: 'asc' }, { createdAt: 'asc' }],
      take: limit,
    });
    return rows.map(rowToEvent);
  }

  /** 获取最近 N 个事件（用于 Writer 的 context） */
  async getRecentEvents(count = 20): Promise<NovelEvent[]> {
    const rows = await db.event.findMany({
      where: { projectId: this.projectId, status: 'confirmed' },
      orderBy: [{ turn: 'desc' }, { createdAt: 'desc' }],
      take: count,
    });
    return rows.reverse().map(rowToEvent);
  }

  /** 获取当前章节范围内的事件：章节 startTurn 是边界，不把上一章最后一轮混进来。 */
  async getChapterEvents(startTurn: number, endTurn: number): Promise<NovelEvent[]> {
    const rows = await db.event.findMany({
      where: {
        projectId: this.projectId,
        status: 'confirmed',
        turn: {
          gt: startTurn,
          lte: endTurn,
        },
      },
      orderBy: [{ turn: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(rowToEvent);
  }

  /** 应用 World State 补丁（用户干预） */
  async applyWorldPatch(patch: Partial<WorldState>): Promise<WorldState> {
    assertPlainPatch(patch, 'World State 编辑');
    const { worldState } = await this.loadProject();
    const next: WorldState = ensureChapterFocus({ ...worldState, ...patch });
    await this.saveWorldState(next);
    return next;
  }

  /** 应用角色状态补丁 */
  async applyCharacterPatch(
    characterId: string,
    patch: Partial<CharacterState>,
    personaPatch: Partial<CharacterPersona> = {}
  ): Promise<Character> {
    assertPlainPatch(patch, '角色状态编辑');
    assertPlainPatch(personaPatch, '角色档案编辑');
    const { characters } = await this.loadProject();
    const c = characters.find((x) => x.id === characterId);
    if (!c) throw new Error(`Character ${characterId} not found`);
    const next: Character = {
      ...c,
      persona: { ...c.persona, ...personaPatch },
      currentState: { ...c.currentState, ...patch },
    };
    await this.saveCharacter(next);
    const refreshed = await this.loadProject();
    await ensureChapterCharacterSnapshot(
      this.projectId,
      refreshed.worldState,
      refreshed.characters.map((character) => (character.id === next.id ? next : character)),
      { overwrite: true }
    );
    return next;
  }

  /** 把用户的 Director 指令存入待处理队列 */
  async queueDirective(
    type: 'priority_command' | 'command' | 'world_state_edit' | 'text_rewrite',
    content: string,
    chapterNo?: number
  ) {
    const targetChapterNo = chapterNo ?? (await this.loadProject()).worldState.currentChapter?.chapterNo;
    return db.directive.create({
      data: {
        projectId: this.projectId,
        chapterNo: targetChapterNo,
        type,
        content,
        status: 'pending',
      },
    });
  }

  private sortDirectivesByPriority<T extends { type: string; createdAt: Date }>(items: T[]): T[] {
    const priorityRank = (type: string) => (type === 'priority_command' ? 0 : 1);
    return [...items].sort((a, b) => {
      const byPriority = priorityRank(a.type) - priorityRank(b.type);
      if (byPriority !== 0) return byPriority;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
  }

  /** 只读查看待处理指令，用于演绎前设计，不改变指令状态。 */
  async peekPendingDirectives(chapterNo: number) {
    const items = await db.directive.findMany({
      where: { projectId: this.projectId, chapterNo, status: 'pending' },
      orderBy: { createdAt: 'asc' },
    });
    return this.sortDirectivesByPriority(items);
  }

  /** 取出并标记 directive 为 applied */
  async consumePendingDirectives(chapterNo: number) {
    const items = await db.directive.findMany({
      where: { projectId: this.projectId, chapterNo, status: 'pending' },
      orderBy: { createdAt: 'asc' },
    });
    const sorted = this.sortDirectivesByPriority(items);
    if (items.length === 0) return [];
    await db.directive.updateMany({
      where: { id: { in: items.map((i) => i.id) } },
      data: { status: 'applied' },
    });
    return sorted;
  }

  /** 设置项目状态 */
  async setProjectStatus(status: 'setup' | 'idle' | 'running' | 'paused' | 'ended') {
    await db.project.update({
      where: { id: this.projectId },
      data: { status },
    });
  }
}

/**
 * 工厂：创建新项目（使用预设模板与角色）
 */
export async function createProject(
  name: string,
  templateKey: string = 'online-game',
  writerHint?: string
): Promise<string> {
  const tpl = getTemplate(templateKey);
  const initialWorld: WorldState = ensureChapterFocus({
    sceneName: tpl.initialScene.name,
    sceneDescription: tpl.initialScene.description,
    location: tpl.initialScene.location,
    timeOfDay: tpl.initialScene.timeOfDay,
    presentCharacterIds: [], // 创建角色后填充
    worldFlags: {},
    tension: 3,
    turn: 0,
    agentPolicy: { ...DEFAULT_AGENT_POLICY },
    ...(writerHint?.trim() ? { writerHint: writerHint.trim() } : {}),
  });

  const project = await db.project.create({
    data: {
      name,
      template: templateKey,
      worldState: JSON.stringify(initialWorld),
      status: 'setup',
    },
  });

  // 创建预设角色
  const characterIds: string[] = [];
  if (tpl.presetCharacters) {
    for (const c of tpl.presetCharacters) {
      const row = await db.character.create({
        data: {
          projectId: project.id,
          name: c.name,
          role: c.role,
          persona: JSON.stringify(c.persona),
          currentState: JSON.stringify(c.currentState),
        },
      });
      characterIds.push(row.id);
    }
    initialWorld.presentCharacterIds = characterIds;
    await db.project.update({
      where: { id: project.id },
      data: { worldState: JSON.stringify(initialWorld) },
    });
  }

  const snapshotRows = await db.character.findMany({ where: { projectId: project.id } });
  await ensureChapterCharacterSnapshot(project.id, initialWorld, snapshotRows.map(rowToCharacter), { overwrite: true });

  return project.id;
}

/**
 * 列出所有项目
 */
export async function listProjects() {
  const projects = await db.project.findMany({
    orderBy: { updatedAt: 'desc' },
    include: {
      _count: { select: { characters: true, events: true, chapters: true } },
    },
  });

  const chapterCounts = await db.$queryRawUnsafe<Array<{
    projectId: string;
    effectiveChapters: number | bigint | null;
    chapterDrafts: number | bigint | null;
  }>>(
    `SELECT "projectId",
            COUNT(DISTINCT COALESCE("chapterNo", 0)) AS "effectiveChapters",
            COUNT(*) AS "chapterDrafts"
       FROM "Chapter"
      GROUP BY "projectId"`
  );
  const chapterCountMap = new Map(
    chapterCounts.map((item) => [
      item.projectId,
      {
        effectiveChapters: Number(item.effectiveChapters ?? 0),
        chapterDrafts: Number(item.chapterDrafts ?? 0),
      },
    ])
  );

  return projects.map(({ _count, ...project }) => {
    const chapterStats = chapterCountMap.get(project.id);
    const effectiveChapterCount = chapterStats?.effectiveChapters ?? _count.chapters;
    const chapterDraftCount = chapterStats?.chapterDrafts ?? _count.chapters;
    return {
      ...project,
      _count: {
        ..._count,
        chapters: effectiveChapterCount || chapterDraftCount,
        chapterDrafts: chapterDraftCount,
        staleChapterDrafts: Math.max(0, chapterDraftCount - (effectiveChapterCount || 0)),
      },
    };
  });
}

/** 生成 UUID */
export function genId(): string {
  return uuid();
}
