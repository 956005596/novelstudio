/**
 * NovelStudio Engine — Socket.io Mini-Service
 * 
 * 端口：3003
 * 
 * 协议：
 *   入站 (frontend → server):
 *     - engine:start      { projectId, maxTurns? }
 *     - auto:chapter      { projectId, cycles?, turnsPerCycle? }
 *     - engine:pause
 *     - engine:resume
 *     - engine:stop
 *     - designer:prepare { projectId }
 *     - chapter:retreat  { projectId }
 *     - chapter:advance  { projectId }
 *     - chapter:reset    { projectId }
 *     - chapter:write    { projectId }
 *     - director:command  { projectId, content, refreshDesign?, priority? }
 *     - world:edit        { projectId, patch }
 *     - character:edit    { characterId, patch }
 *     - writer:rewrite    { chapterId, content }
 * 
 *   出站 (server → frontend):
 *     - engine:state      { status, turn }
 *     - world:update      { worldState }
 *     - character:update  { character }
 *     - event:new         { event }
 *     - writer:chunk      { chunk, chapterId }
 *     - writer:done       { chapterId, content }
 *     - reader:review     { review }
 *     - craft:lesson      { lesson }
 *     - log               { level, message }
 *     - snapshot          { projectId, worldState, characters }  // 连接时回放当前状态
 */

import { createServer } from 'http';
import { Server } from 'socket.io';
import { EngineManager } from './manager';

const PORT = 3003;

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

const engineManager = new EngineManager(io);

io.on('connection', (socket) => {
  console.log(`[socket] connected: ${socket.id}`);

  // 启动演绎
  socket.on('engine:start', async (
    data: { projectId: string; maxTurns?: number },
    ack?: (result: { ok: boolean; error?: string }) => void
  ) => {
    try {
      const started = await engineManager.start(data.projectId, socket, { maxTurns: data.maxTurns });
      ack?.(started ? { ok: true } : { ok: false, error: '当前任务仍在执行' });
    } catch (err: any) {
      socket.emit('log', { level: 'error', message: `启动失败: ${err.message}` });
      ack?.({ ok: false, error: err.message || '启动失败' });
    }
  });

  socket.on('auto:chapter', async (
    data: { projectId: string; cycles?: number; turnsPerCycle?: number },
    ack?: (result: { ok: boolean; error?: string }) => void
  ) => {
    try {
      const started = await engineManager.startChapterAuto(data.projectId, {
        cycles: data.cycles,
        turnsPerCycle: data.turnsPerCycle,
      });
      ack?.(started ? { ok: true } : { ok: false, error: '当前任务仍在执行' });
    } catch (err: any) {
      socket.emit('log', { level: 'error', message: `章节全自动启动失败: ${err.message}` });
      ack?.({ ok: false, error: err.message || '章节全自动启动失败' });
    }
  });

  socket.on('engine:pause', () => engineManager.pause());
  socket.on('engine:resume', () => engineManager.resume());
  socket.on('engine:stop', () => engineManager.stop());

  socket.on('designer:prepare', async (data: { projectId: string }) => {
    try {
      await engineManager.prepareStoryDesign(data.projectId);
    } catch (err: any) {
      socket.emit('log', { level: 'error', message: `导演设计失败: ${err.message}` });
    }
  });

  socket.on('chapter:advance', async (data: { projectId: string }) => {
    try {
      await engineManager.advanceChapter(data.projectId);
    } catch (err: any) {
      socket.emit('log', { level: 'error', message: `章节切换失败: ${err.message}` });
    }
  });

  socket.on('chapter:retreat', async (data: { projectId: string }) => {
    try {
      await engineManager.retreatChapter(data.projectId);
    } catch (err: any) {
      socket.emit('log', { level: 'error', message: `章节切换失败: ${err.message}` });
    }
  });

  socket.on('chapter:reset', async (
    data: { projectId: string },
    ack?: (response: { ok: boolean; result?: any; error?: string }) => void
  ) => {
    try {
      const result = await engineManager.resetCurrentChapter(data.projectId);
      ack?.({ ok: true, result });
    } catch (err: any) {
      const message = err.message || '重置当前章节失败';
      socket.emit('log', { level: 'error', message });
      ack?.({ ok: false, error: message });
    }
  });

  socket.on('chapter:write', async (data: { projectId: string }) => {
    try {
      await engineManager.writeCurrentChapter(data.projectId);
    } catch (err: any) {
      socket.emit('log', { level: 'error', message: `正文生成失败: ${err.message}` });
    }
  });

  socket.on('director:command', async (
    data: { projectId?: string; content: string; refreshDesign?: boolean; priority?: boolean },
    ack?: (result: { ok: boolean; error?: string }) => void
  ) => {
    try {
      await engineManager.directorCommand(data.content, data.projectId, {
        refreshDesign: data.refreshDesign,
        priority: data.priority,
      });
      ack?.({ ok: true });
    } catch (err: any) {
      socket.emit('log', { level: 'error', message: `指令失败: ${err.message}` });
      ack?.({ ok: false, error: err.message || '指令失败' });
    }
  });

  socket.on('world:edit', async (data: { projectId?: string; patch: any }) => {
    try {
      await engineManager.worldEdit(data.patch, data.projectId);
    } catch (err: any) {
      socket.emit('log', { level: 'error', message: `World 编辑失败: ${err.message}` });
    }
  });

  socket.on('character:edit', async (data: { projectId?: string; characterId: string; patch: any; personaPatch?: any }) => {
    try {
      await engineManager.characterEdit(data.characterId, data.patch, data.personaPatch ?? {}, data.projectId);
    } catch (err: any) {
      socket.emit('log', { level: 'error', message: `角色编辑失败: ${err.message}` });
    }
  });

  socket.on('writer:rewrite', async (data: { chapterId: string; content: string }) => {
    try {
      await engineManager.writerRewrite(data.chapterId, data.content);
    } catch (err: any) {
      socket.emit('log', { level: 'error', message: `文本改写失败: ${err.message}` });
    }
  });

  socket.on('snapshot', async (data: { projectId: string }) => {
    try {
      const snapshot = await engineManager.snapshot(data.projectId);
      socket.emit('snapshot', snapshot);
    } catch (err: any) {
      socket.emit('log', { level: 'error', message: `快照失败: ${err.message}` });
    }
  });

  socket.on('disconnect', () => {
    console.log(`[socket] disconnected: ${socket.id}`);
    // 不在这里停止 engine，让其他客户端可继续观察
  });

  socket.on('error', (err) => {
    console.error(`[socket] error (${socket.id}):`, err);
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[NovelEngine] WebSocket server running on 0.0.0.0:${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('[NovelEngine] SIGTERM received, shutting down...');
  httpServer.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('[NovelEngine] SIGINT received, shutting down...');
  httpServer.close(() => process.exit(0));
});
