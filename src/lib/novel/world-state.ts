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
  WorldState,
  WorldTemplate,
} from './types';
import { getTemplate } from './templates/online-game';
import { v4 as uuid } from 'uuid';

/** 把 Prisma 行 → 前端 Character */
export function rowToCharacter(row: any): Character {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    persona: JSON.parse(row.persona) as CharacterPersona,
    currentState: JSON.parse(row.currentState) as CharacterState,
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

export class WorldManager {
  constructor(public projectId: string) {}

  /** 加载项目 + 世界状态 */
  async loadProject() {
    const project = await db.project.findUnique({
      where: { id: this.projectId },
      include: { characters: true },
    });
    if (!project) throw new Error(`Project ${this.projectId} not found`);
    const worldState = JSON.parse(project.worldState) as WorldState;
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
    await db.project.update({
      where: { id: this.projectId },
      data: {
        worldState: JSON.stringify(worldState),
        currentTurn: worldState.turn,
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

  /** 应用 World State 补丁（用户干预） */
  async applyWorldPatch(patch: Partial<WorldState>): Promise<WorldState> {
    const { worldState } = await this.loadProject();
    const next: WorldState = { ...worldState, ...patch };
    await this.saveWorldState(next);
    return next;
  }

  /** 应用角色状态补丁 */
  async applyCharacterPatch(
    characterId: string,
    patch: Partial<CharacterState>
  ): Promise<Character> {
    const { characters } = await this.loadProject();
    const c = characters.find((x) => x.id === characterId);
    if (!c) throw new Error(`Character ${characterId} not found`);
    const next: Character = {
      ...c,
      currentState: { ...c.currentState, ...patch },
    };
    await this.saveCharacter(next);
    return next;
  }

  /** 把用户的 Director 指令存入待处理队列 */
  async queueDirective(type: 'command' | 'world_state_edit' | 'text_rewrite', content: string) {
    return db.directive.create({
      data: { projectId: this.projectId, type, content, status: 'pending' },
    });
  }

  /** 取出并标记 directive 为 applied */
  async consumePendingDirectives() {
    const items = await db.directive.findMany({
      where: { projectId: this.projectId, status: 'pending' },
      orderBy: { createdAt: 'asc' },
    });
    if (items.length === 0) return [];
    await db.directive.updateMany({
      where: { id: { in: items.map((i) => i.id) } },
      data: { status: 'applied' },
    });
    return items;
  }

  /** 设置项目状态 */
  async setProjectStatus(status: 'setup' | 'running' | 'paused' | 'ended') {
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
  templateKey: string = 'online-game'
): Promise<string> {
  const tpl = getTemplate(templateKey);
  const initialWorld: WorldState = {
    sceneName: tpl.initialScene.name,
    sceneDescription: tpl.initialScene.description,
    location: tpl.initialScene.location,
    timeOfDay: tpl.initialScene.timeOfDay,
    presentCharacterIds: [], // 创建角色后填充
    worldFlags: {},
    tension: 3,
    turn: 0,
  };

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

  return project.id;
}

/**
 * 列出所有项目
 */
export async function listProjects() {
  return db.project.findMany({
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { characters: true, events: true, chapters: true } } },
  });
}

/** 生成 UUID */
export function genId(): string {
  return uuid();
}
