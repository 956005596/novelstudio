/**
 * NovelStudio 前端状态管理
 */

import { create } from 'zustand';
import { io, type Socket } from 'socket.io-client';
import type {
  Character,
  NovelEvent,
  WorldState,
} from '@/lib/novel/types';

export type EngineStatus = 'idle' | 'running' | 'paused' | 'ended';

export interface LogEntry {
  id: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  timestamp: number;
}

interface NovelStoreState {
  // 连接状态
  connected: boolean;
  socket: Socket | null;

  // 当前项目
  projectId: string | null;
  projectName: string | null;
  projectStatus: EngineStatus;
  directorLvl: number;

  // 数据
  worldState: WorldState | null;
  characters: Character[];
  events: NovelEvent[];
  chapterChunks: Record<string, string>;     // chapterId → 累积文本
  completedChapters: { id: string; content: string; sceneName: string }[];
  logs: LogEntry[];

  // UI
  initProjectId: (projectId: string, projectName: string, directorLvl: number) => void;
  connect: () => void;
  disconnect: () => void;
  setDirectorLvl: (lvl: number) => void;

  // 引擎控制
  startEngine: () => void;
  pauseEngine: () => void;
  resumeEngine: () => void;
  stopEngine: () => void;
  sendDirectorCommand: (content: string) => void;
  sendWorldEdit: (patch: Partial<WorldState>) => void;
  sendCharacterEdit: (characterId: string, patch: Partial<Character['currentState']>) => void;
  sendWriterRewrite: (chapterId: string, content: string) => void;

  // 内部
  _onWorldUpdate: (ws: WorldState) => void;
  _onCharacterUpdate: (c: Character) => void;
  _onEventNew: (e: NovelEvent) => void;
  _onWriterChunk: (chunk: string, chapterId: string) => void;
  _onWriterDone: (chapterId: string, content: string) => void;
  _onEngineState: (status: EngineStatus, turn: number) => void;
  _onLog: (level: LogEntry['level'], message: string) => void;
  _onSnapshot: (data: any) => void;
  reset: () => void;
}

let logIdCounter = 0;

export const useNovelStore = create<NovelStoreState>((set, get) => ({
  connected: false,
  socket: null,
  projectId: null,
  projectName: null,
  projectStatus: 'idle',
  directorLvl: 3,
  worldState: null,
  characters: [],
  events: [],
  chapterChunks: {},
  completedChapters: [],
  logs: [],

  initProjectId: (projectId, projectName, directorLvl) => {
    set({ projectId, projectName, directorLvl, worldState: null, characters: [], events: [], chapterChunks: {}, completedChapters: [], logs: [] });
  },

  connect: () => {
    const existing = get().socket;
    if (existing) return;

    const socket = io('/?XTransformPort=3003', {
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      timeout: 10000,
    });

    socket.on('connect', () => {
      set({ connected: true });
      get()._onLog('info', '已连接到演绎引擎');
    });
    socket.on('disconnect', () => {
      set({ connected: false });
      get()._onLog('warn', '与演绎引擎断开');
    });

    socket.on('engine:state', (data: any) =>
      get()._onEngineState(data.status, data.turn)
    );
    socket.on('world:update', (data: any) => get()._onWorldUpdate(data.worldState ?? data));
    socket.on('character:update', (data: any) => get()._onCharacterUpdate(data.character ?? data));
    socket.on('event:new', (data: any) => get()._onEventNew(data.event ?? data));
    socket.on('writer:chunk', (data: any) => get()._onWriterChunk(data.chunk, data.chapterId));
    socket.on('writer:done', (data: any) => get()._onWriterDone(data.chapterId, data.content));
    socket.on('log', (data: any) => get()._onLog(data.level, data.message));
    socket.on('snapshot', (data: any) => get()._onSnapshot(data));

    set({ socket });
  },

  disconnect: () => {
    const s = get().socket;
    if (s) {
      s.disconnect();
      set({ socket: null, connected: false });
    }
  },

  setDirectorLvl: (lvl) => set({ directorLvl: lvl }),

  startEngine: () => {
    const { socket, projectId } = get();
    if (!socket || !projectId) return;
    socket.emit('engine:start', { projectId });
  },
  pauseEngine: () => get().socket?.emit('engine:pause'),
  resumeEngine: () => get().socket?.emit('engine:resume'),
  stopEngine: () => get().socket?.emit('engine:stop'),
  sendDirectorCommand: (content) => get().socket?.emit('director:command', { content }),
  sendWorldEdit: (patch) => get().socket?.emit('world:edit', { patch }),
  sendCharacterEdit: (characterId, patch) =>
    get().socket?.emit('character:edit', { characterId, patch }),
  sendWriterRewrite: (chapterId, content) =>
    get().socket?.emit('writer:rewrite', { chapterId, content }),

  _onWorldUpdate: (ws) => set({ worldState: ws }),
  _onCharacterUpdate: (c) =>
    set((s) => ({
      characters: s.characters.some((x) => x.id === c.id)
        ? s.characters.map((x) => (x.id === c.id ? c : x))
        : [...s.characters, c],
    })),
  _onEventNew: (e) => set((s) => ({
    events: s.events.some((x) => x.id === e.id) ? s.events : [...s.events, e],
  })),
  _onWriterChunk: (chunk, chapterId) =>
    set((s) => ({
      chapterChunks: {
        ...s.chapterChunks,
        [chapterId]: (s.chapterChunks[chapterId] ?? '') + chunk,
      },
    })),
  _onWriterDone: (chapterId, content) =>
    set((s) => {
      const ws = s.worldState;
      const chunks = { ...s.chapterChunks };
      delete chunks[chapterId];
      return {
        chapterChunks: chunks,
        completedChapters: [
          ...s.completedChapters,
          { id: chapterId, content, sceneName: ws?.sceneName ?? '未命名场景' },
        ],
      };
    }),
  _onEngineState: (status, _turn) => set({ projectStatus: status }),
  _onLog: (level, message) =>
    set((s) => ({
      logs: [
        ...s.logs,
        { id: `log-${++logIdCounter}`, level, message, timestamp: Date.now() },
      ].slice(-200),
    })),
  _onSnapshot: (data) => {
    set({
      worldState: data.worldState,
      characters: data.characters,
      events: data.events,
    });
  },

  reset: () => set({
    projectId: null,
    projectName: null,
    projectStatus: 'idle',
    worldState: null,
    characters: [],
    events: [],
    chapterChunks: {},
    completedChapters: [],
    logs: [],
  }),
}));
