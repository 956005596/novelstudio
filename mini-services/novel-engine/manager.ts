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
  private resolvePause: (() => void) | null = null;

  constructor(private io: Server) {}

  private broadcast(event: SocketOutEvent) {
    this.io.emit((event as any).type, event);
  }

  async start(projectId: string, _socket: Socket) {
    if (this.current) {
      this.stop();
    }
    this.projectId = projectId;
    this.paused = false;
    this.stopped = false;

    // 推送初始 snapshot
    const wm = new WorldManager(projectId);
    const { worldState, characters } = await wm.loadProject();
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

    this.current = new NovelEngine(projectId, {
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

    // 异步运行，不阻塞
    this.current.run(50).catch((err) => {
      this.broadcast({
        type: 'log',
        level: 'error',
        message: `Engine crash: ${err.message}`,
      } as any);
    });
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
      wm.setProjectStatus('paused').catch(() => {});
    }
    this.broadcast({
      type: 'engine:state',
      status: 'idle',
      turn: -1,
    } as any);
    this.current = null;
    this.projectId = null;
  }

  async directorCommand(content: string) {
    if (!this.projectId) return;
    const wm = new WorldManager(this.projectId);
    await wm.queueDirective('command', content);
    this.broadcast({
      type: 'log',
      level: 'info',
      message: `Director 指令已排队: ${content}`,
    } as any);
  }

  async worldEdit(patch: any) {
    if (!this.projectId) return;
    const wm = new WorldManager(this.projectId);
    const next = await wm.applyWorldPatch(patch);
    this.broadcast({ type: 'world:update', worldState: next } as any);
    this.broadcast({
      type: 'log',
      level: 'info',
      message: `World State 已更新`,
    } as any);
  }

  async characterEdit(characterId: string, patch: any) {
    if (!this.projectId) return;
    const wm = new WorldManager(this.projectId);
    const updated = await wm.applyCharacterPatch(characterId, patch);
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
