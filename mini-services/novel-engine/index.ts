/**
 * NovelStudio Engine — Socket.io Mini-Service
 * 
 * 端口：3003
 * 
 * 协议：
 *   入站 (frontend → server):
 *     - engine:start      { projectId }
 *     - engine:pause
 *     - engine:resume
 *     - engine:stop
 *     - director:command  { content }
 *     - world:edit        { patch }
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
 *     - log               { level, message }
 *     - snapshot          { projectId, worldState, characters }  // 连接时回放当前状态
 */

import { createServer } from 'http';
import { Server } from 'socket.io';
import { EngineManager } from './manager';

const PORT = 3003;

const httpServer = createServer();
const io = new Server(httpServer, {
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

const engineManager = new EngineManager(io);

io.on('connection', (socket) => {
  console.log(`[socket] connected: ${socket.id}`);

  // 启动演绎
  socket.on('engine:start', async (data: { projectId: string }) => {
    try {
      await engineManager.start(data.projectId, socket);
    } catch (err: any) {
      socket.emit('log', { level: 'error', message: `启动失败: ${err.message}` });
    }
  });

  socket.on('engine:pause', () => engineManager.pause());
  socket.on('engine:resume', () => engineManager.resume());
  socket.on('engine:stop', () => engineManager.stop());

  socket.on('director:command', async (data: { content: string }) => {
    try {
      await engineManager.directorCommand(data.content);
    } catch (err: any) {
      socket.emit('log', { level: 'error', message: `指令失败: ${err.message}` });
    }
  });

  socket.on('world:edit', async (data: { patch: any }) => {
    try {
      await engineManager.worldEdit(data.patch);
    } catch (err: any) {
      socket.emit('log', { level: 'error', message: `World 编辑失败: ${err.message}` });
    }
  });

  socket.on('character:edit', async (data: { characterId: string; patch: any }) => {
    try {
      await engineManager.characterEdit(data.characterId, data.patch);
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

httpServer.listen(PORT, () => {
  console.log(`[NovelEngine] WebSocket server running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('[NovelEngine] SIGTERM received, shutting down...');
  httpServer.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('[NovelEngine] SIGINT received, shutting down...');
  httpServer.close(() => process.exit(0));
});
