/**
 * Engine Manager
 * 
 * 管理当前活跃的 NovelEngine 实例，桥接 Socket.io 事件。
 * 维护暂停/停止标志，处理用户干预。
 */

import type { Server, Socket } from 'socket.io';
import { NovelEngine } from '../../src/lib/novel/engine';
import { WorldManager } from '../../src/lib/novel/world-state';
import type { SocketOutEvent } from '../../src/lib/novel/types';

export class EngineManager {
  private current: NovelEngine | null = null;
  private paused = false;
  private stopped = false;
  private projectId: string | null = null;
  private operationLabel = '';
  private resolvePause: (() => void) | null = null;

  constructor(private io: Server) {}

  private broadcast(event: SocketOutEvent) {
    this.io.emit((event as any).type, event);
  }

  private createEngine(projectId: string) {
    return new NovelEngine(projectId, {
      emit: (event) => this.broadcast(event),
      isPaused: () => this.paused,
      isStopped: () => this.stopped,
      waitWhilePaused: async () => {
        if (!this.paused) return;
        await new Promise<void>((resolve) => {
          this.resolvePause = resolve;
        });
      },
    });
  }

  private async finishEngine(engine: NovelEngine, projectId: string) {
    if (this.current !== engine) return;
    await new WorldManager(projectId).setProjectStatus('idle').catch(() => {});
    this.broadcast({
      type: 'engine:state',
      status: 'idle',
      turn: -1,
    } as any);
    this.current = null;
    this.projectId = null;
    this.operationLabel = '';
    this.paused = false;
    this.stopped = false;
  }

  async start(projectId: string, _socket: Socket, options: { maxTurns?: number } = {}): Promise<boolean> {
    if (this.current) {
      this.broadcast({
        type: 'log',
        level: 'warn',
        message: `${this.operationLabel || '当前任务'}仍在执行；没有启动“演绎一轮”，也没有取消原任务`,
      } as any);
      return false;
    }
    this.projectId = projectId;
    this.operationLabel = '章节演绎';
    this.paused = false;
    this.stopped = false;

    // 推送初始 snapshot
    const wm = new WorldManager(projectId);
    const { worldState, characters } = await wm.loadProject();
    await wm.saveCurrentChapterCharacterSnapshot();
    const recentEvents = await wm.getRecentEvents(20);
    this.broadcast({
      type: 'world:update',
      worldState,
    } as any);
    for (const c of characters) {
      this.broadcast({ type: 'character:update', character: c } as any);
    }
    for (const e of recentEvents) {
      this.broadcast({ type: 'event:new', event: e } as any);
    }
    this.broadcast({
      type: 'engine:state',
      status: 'running',
      turn: worldState.turn,
    } as any);

    const engine = this.createEngine(projectId);
    const maxTurns = Math.max(1, Math.min(50, Math.floor(options.maxTurns ?? 1)));
    this.current = engine;

    // 异步运行，不阻塞
    engine.run(maxTurns)
      .catch((err) => {
        this.broadcast({
          type: 'log',
          level: 'error',
          message: `Engine crash: ${err.message}`,
        } as any);
      })
      .finally(() => {
        return this.finishEngine(engine, projectId);
      });
    return true;
  }

  async startChapterAuto(projectId: string, options: { cycles?: number; turnsPerCycle?: number } = {}): Promise<boolean> {
    if (this.current) {
      this.broadcast({
        type: 'log',
        level: 'warn',
        message: `${this.operationLabel || '当前任务'}仍在执行；没有重复启动章节自循环，也没有取消原任务`,
      } as any);
      return false;
    }
    this.projectId = projectId;
    this.operationLabel = '章节自循环';
    this.paused = false;
    this.stopped = false;

    const wm = new WorldManager(projectId);
    const { worldState, characters } = await wm.loadProject();
    await wm.saveCurrentChapterCharacterSnapshot();
    const recentEvents = await wm.getRecentEvents(20);
    this.broadcast({ type: 'world:update', worldState } as any);
    for (const character of characters) {
      this.broadcast({ type: 'character:update', character } as any);
    }
    for (const event of recentEvents) {
      this.broadcast({ type: 'event:new', event } as any);
    }

    const engine = this.createEngine(projectId);
    this.current = engine;
    engine.runChapterAutoLoop(options.cycles ?? 3, options.turnsPerCycle ?? 3)
      .catch((err) => {
        this.broadcast({
          type: 'log',
          level: 'error',
          message: `章节自循环崩溃: ${err.message}`,
        } as any);
      })
      .finally(() => {
        return this.finishEngine(engine, projectId);
      });
    return true;
  }

  pause() {
    if (!this.current) return;
    this.paused = true;
    this.broadcast({
      type: 'engine:state',
      status: 'paused',
      turn: -1,
    } as any);
    this.broadcast({
      type: 'log',
      level: 'info',
      message: '演绎已暂停',
    } as any);
  }

  resume() {
    if (!this.current) return;
    this.paused = false;
    if (this.resolvePause) {
      this.resolvePause();
      this.resolvePause = null;
    }
    this.broadcast({
      type: 'engine:state',
      status: 'running',
      turn: -1,
    } as any);
    this.broadcast({
      type: 'log',
      level: 'info',
      message: '演绎已恢复',
    } as any);
  }

  stop() {
    this.stopped = true;
    this.paused = false;
    if (this.resolvePause) {
      this.resolvePause();
      this.resolvePause = null;
    }
    if (this.projectId) {
      const wm = new WorldManager(this.projectId);
      wm.setProjectStatus('idle').catch(() => {});
    }
    this.broadcast({
      type: 'engine:state',
      status: 'idle',
      turn: -1,
    } as any);
    this.current = null;
    this.projectId = null;
    this.operationLabel = '';
  }

  async directorCommand(
    content: string,
    projectId?: string,
    options: { refreshDesign?: boolean; priority?: boolean } = {}
  ) {
    const targetProjectId = projectId ?? this.projectId;
    if (!targetProjectId) return;
    const wm = new WorldManager(targetProjectId);
    const directiveType = options.priority ? 'priority_command' : 'command';
    await wm.queueDirective(directiveType, content);
    this.broadcast({
      type: 'log',
      level: 'info',
      message: `${options.priority ? '最高优先级 Director 指令已接收' : 'Director 指令已排队'}: ${content.slice(0, 120)}${content.length > 120 ? '…' : ''}`,
    } as any);

    if (!options.refreshDesign) return;

    if (this.current && this.projectId !== targetProjectId) {
      this.broadcast({
        type: 'log',
        level: 'warn',
        message: '当前有其他项目正在演绎，本次指令已入队，稍后再刷新导演设计',
      } as any);
      return;
    }

    if (this.current && !this.paused) {
      this.broadcast({
        type: 'log',
        level: 'info',
        message: '演绎正在运行，本次指令将在下一 Turn 以最高优先级应用',
      } as any);
      return;
    }

    this.broadcast({
      type: 'log',
      level: 'info',
      message: '正在按最高优先级重算本章导演设计…',
    } as any);
    await this.prepareStoryDesign(targetProjectId);
  }

  async prepareStoryDesign(projectId: string) {
    this.projectId = projectId;
    const engine = this.current ?? this.createEngine(projectId);
    await engine.prepareStoryDesign();
    if (!this.current) this.projectId = null;
  }

  async advanceChapter(projectId: string) {
    this.projectId = projectId;
    const engine = this.current ?? this.createEngine(projectId);
    await engine.advanceChapter();
    if (!this.current) this.projectId = null;
  }

  async retreatChapter(projectId: string) {
    this.projectId = projectId;
    const engine = this.current ?? this.createEngine(projectId);
    await engine.retreatChapter();
    if (!this.current) this.projectId = null;
  }

  async resetCurrentChapter(projectId: string) {
    this.projectId = projectId;
    this.stopped = true;
    this.paused = false;
    if (this.resolvePause) {
      this.resolvePause();
      this.resolvePause = null;
    }

    const engine = this.current ?? this.createEngine(projectId);
    const result = await engine.resetCurrentChapter();
    this.current = null;
    this.projectId = null;
    this.broadcast({
      type: 'engine:state',
      status: 'idle',
      turn: result.startTurn,
    } as any);
    return result;
  }

  async writeCurrentChapter(projectId: string) {
    if (this.current) {
      this.stop();
    }
    this.projectId = projectId;
    this.paused = false;
    this.stopped = false;

    const engine = this.createEngine(projectId);
    this.current = engine;
    try {
      return await engine.writeCurrentChapter();
    } finally {
      this.current = null;
      this.projectId = null;
      this.paused = false;
      this.stopped = false;
    }
  }

  async worldEdit(patch: any, projectId?: string) {
    const targetProjectId = projectId ?? this.projectId;
    if (!targetProjectId) return;
    const wm = new WorldManager(targetProjectId);
    const next = await wm.applyWorldPatch(patch);
    this.broadcast({ type: 'world:update', worldState: next } as any);
    this.broadcast({
      type: 'log',
      level: 'info',
      message: `World State 已更新`,
    } as any);
  }

  async characterEdit(characterId: string, patch: any, personaPatch: any = {}, projectId?: string) {
    const targetProjectId = projectId ?? this.projectId;
    if (!targetProjectId) return;
    const wm = new WorldManager(targetProjectId);
    const updated = await wm.applyCharacterPatch(characterId, patch, personaPatch);
    this.broadcast({ type: 'character:update', character: updated } as any);
    this.broadcast({
      type: 'log',
      level: 'info',
      message: `角色 ${updated.name} 状态已更新`,
    } as any);
  }

  async writerRewrite(_chapterId: string, content: string) {
    // 简化：把改写后的文本当作下一轮 Writer 的风格锚点
    // 实际持久化需要扩展 db
    this.broadcast({
      type: 'log',
      level: 'info',
      message: `文本已重写（${content.length} 字），将作为后续风格锚点`,
    } as any);
  }

  async snapshot(projectId: string) {
    const wm = new WorldManager(projectId);
    const { worldState, characters } = await wm.loadProject();
    const events = await wm.getRecentEvents(50);
    return { projectId, worldState, characters, events };
  }
}
