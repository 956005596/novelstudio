/**
 * NovelStudio 前端状态管理
 */

import { create } from 'zustand';
import { io, type Socket } from 'socket.io-client';
import type {
  Character,
  ChapterSummary,
  NovelCraftLesson,
  NovelEvent,
  ReaderReview,
  StoryDesign,
  WorldState,
} from '@/lib/novel/types';
import { countReadableChars } from '@/lib/novel/chapter-text';

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
  completedChapters: ChapterSummary[];
  readerReviews: Record<string, ReaderReview[]>; // chapterId -> reviews
  storyDesign: StoryDesign | null;
  craftLessons: NovelCraftLesson[];
  logs: LogEntry[];

  // UI
  initProjectId: (projectId: string, projectName: string, directorLvl: number) => void;
  setProjectName: (projectName: string) => void;
  connect: () => void;
  disconnect: () => void;
  setDirectorLvl: (lvl: number) => void;

  // 引擎控制
  startEngine: (options?: { maxTurns?: number }) => void;
  startChapterAuto: (options?: { cycles?: number; turnsPerCycle?: number }) => void;
  pauseEngine: () => void;
  resumeEngine: () => void;
  stopEngine: () => void;
  prepareStoryDesign: () => void;
  writeCurrentChapter: () => void;
  retreatChapter: () => void;
  advanceChapter: () => void;
  sendDirectorCommand: (content: string, options?: { refreshDesign?: boolean; priority?: boolean }) => Promise<boolean>;
  sendWorldEdit: (patch: Partial<WorldState>) => void;
  sendCharacterEdit: (characterId: string, patch: Partial<Character['currentState']>, personaPatch?: Partial<Character['persona']>) => void;
  sendWriterRewrite: (chapterId: string, content: string) => void;
  cleanupInvalidCurrentChapter: (projectId: string) => Promise<any>;
  resetCurrentChapter: (projectId: string) => Promise<void>;
  resetProject: (projectId: string) => Promise<void>;
  setPacingMode: (mode: 'fast' | 'balanced' | 'slow') => void;
  replaceReaderReviews: (chapterId: string, reviews: ReaderReview[]) => void;

  // 内部
  _onWorldUpdate: (ws: WorldState) => void;
  _onCharacterUpdate: (c: Character) => void;
  _onEventNew: (e: NovelEvent) => void;
  _onChaptersLoaded: (chapters: ChapterSummary[]) => void;
  _onWriterChunk: (chunk: string, chapterId: string) => void;
  _onWriterDone: (chapterId: string, content: string, chapter?: ChapterSummary) => void;
  _onWriterFailed: (chapterId: string, message: string) => void;
  _onReaderReview: (review: ReaderReview) => void;
  _onDesignerUpdate: (design: StoryDesign) => void;
  _onCraftLesson: (lesson: NovelCraftLesson) => void;
  _onEngineState: (status: EngineStatus, turn: number) => void;
  _onLog: (level: LogEntry['level'], message: string) => void;
  _onSnapshot: (data: any) => void;
  reset: () => void;
}

let logIdCounter = 0;

function sortEvents(events: NovelEvent[]): NovelEvent[] {
  return [...events].sort((a, b) => {
    const byTurn = a.turn - b.turn;
    if (byTurn !== 0) return byTurn;
    return new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime();
  });
}

function isPlainPatch(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]'
  );
}

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
  readerReviews: {},
  storyDesign: null,
  craftLessons: [],
  logs: [],

  initProjectId: (projectId, projectName, directorLvl) => {
    set({
      projectId,
      projectName,
      directorLvl,
      projectStatus: 'idle',
      worldState: null,
      characters: [],
      events: [],
      chapterChunks: {},
      completedChapters: [],
      readerReviews: {},
      storyDesign: null,
      craftLessons: [],
      logs: [],
    });
  },

  setProjectName: (projectName) => {
    set({ projectName });
  },

  connect: () => {
    const existing = get().socket;
    if (existing) {
      if (existing.connected) {
        set({ connected: true });
        return;
      }
      existing.connect();
      return;
    }

    const engineUrl =
      typeof window === 'undefined'
        ? 'http://localhost:3003'
        : (() => {
            const host = window.location.hostname;
            const engineHost =
              host === '127.0.0.1' || host === '0.0.0.0' || host === '::1'
                ? 'localhost'
                : host;
            return `${window.location.protocol}//${engineHost}:3003`;
          })();

    const socket = io(engineUrl, {
      transports: ['polling'],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      timeout: 10000,
    });

    socket.on('connect', () => {
      set({ connected: true });
      get()._onLog('info', '已连接到演绎引擎');
    });
    socket.on('disconnect', () => {
      const hadWriterStream = Object.values(get().chapterChunks).some((chunk) => chunk.length > 0);
      set({ connected: false, ...(hadWriterStream ? { chapterChunks: {} } : {}) });
      get()._onLog('warn', '与演绎引擎断开');
      if (hadWriterStream) {
        get()._onLog('warn', 'Writer 流已中断，未保存的临时正文已清空；请确认事件后重新生成正文');
      }
    });
    socket.on('connect_error', (err: any) => {
      set({ connected: false });
      get()._onLog('warn', `演绎引擎连接失败，正在重试：${err?.message ?? '未知错误'}`);
    });
    socket.io.on('reconnect', () => {
      set({ connected: true });
      get()._onLog('info', '演绎引擎已重新连接');
    });

    socket.on('engine:state', (data: any) =>
      get()._onEngineState(data.status, data.turn)
    );
    socket.on('world:update', (data: any) => get()._onWorldUpdate(data.worldState ?? data));
    socket.on('character:update', (data: any) => get()._onCharacterUpdate(data.character ?? data));
    socket.on('event:new', (data: any) => get()._onEventNew(data.event ?? data));
    socket.on('writer:chunk', (data: any) => get()._onWriterChunk(data.chunk, data.chapterId));
    socket.on('writer:done', (data: any) => get()._onWriterDone(data.chapterId, data.content, data.chapter));
    socket.on('writer:failed', (data: any) => get()._onWriterFailed(data.chapterId, data.message));
    socket.on('reader:review', (data: any) => get()._onReaderReview(data.review ?? data));
    socket.on('designer:update', (data: any) => get()._onDesignerUpdate(data.design ?? data));
    socket.on('craft:lesson', (data: any) => get()._onCraftLesson(data.lesson ?? data));
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

  startEngine: (options = {}) => {
    const { socket, projectId, projectStatus } = get();
    if (!socket?.connected || !projectId) return;
    if (projectStatus === 'running' || projectStatus === 'paused') {
      get()._onLog('warn', '当前任务仍在执行，没有重复启动演绎');
      return;
    }
    set({ projectStatus: 'running' });
    socket.emit(
      'engine:start',
      { projectId, maxTurns: options.maxTurns ?? 1 },
      (result?: { ok?: boolean; error?: string }) => {
        if (result?.ok === false) {
          set({ projectStatus: 'idle' });
          get()._onLog('warn', result.error || '演绎未启动');
        }
      }
    );
  },
  startChapterAuto: (options = {}) => {
    const { socket, projectId, projectStatus } = get();
    if (!socket?.connected || !projectId) return;
    if (projectStatus === 'running' || projectStatus === 'paused') {
      get()._onLog('warn', '当前任务仍在执行，没有重复启动章节自循环');
      return;
    }
    set({ projectStatus: 'running' });
    socket.emit(
      'auto:chapter',
      {
        projectId,
        cycles: options.cycles ?? 3,
        turnsPerCycle: options.turnsPerCycle ?? 3,
      },
      (result?: { ok?: boolean; error?: string }) => {
        if (result?.ok === false) {
          set({ projectStatus: 'idle' });
          get()._onLog('warn', result.error || '章节自循环未启动');
        }
      }
    );
  },
  pauseEngine: () => get().socket?.emit('engine:pause'),
  resumeEngine: () => get().socket?.emit('engine:resume'),
  stopEngine: () => get().socket?.emit('engine:stop'),
  prepareStoryDesign: () => {
    const { socket, projectId } = get();
    if (!socket || !projectId) return;
    socket.emit('designer:prepare', { projectId });
  },
  writeCurrentChapter: () => {
    const { socket, projectId } = get();
    if (!socket || !projectId) return;
    socket.emit('chapter:write', { projectId });
  },
  advanceChapter: () => {
    const { socket, projectId } = get();
    if (!socket || !projectId) return;
    socket.emit('chapter:advance', { projectId });
  },
  retreatChapter: () => {
    const { socket, projectId } = get();
    if (!socket || !projectId) return;
    socket.emit('chapter:retreat', { projectId });
  },
  sendDirectorCommand: (content, options = {}) => {
    const { socket, projectId } = get();
    if (!socket || !projectId) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean, message?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!ok && message) get()._onLog('error', message);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        get()._onLog('warn', 'Director 指令已发送，但暂未收到引擎确认');
        finish(true);
      }, 12000);
      socket.emit('director:command', {
        projectId,
        content,
        refreshDesign: options.refreshDesign ?? false,
        priority: options.priority ?? false,
      }, (result?: { ok?: boolean; error?: string }) => {
        if (result?.ok === false) {
          finish(false, result.error || 'Director 指令接收失败');
          return;
        }
        finish(true);
      });
    });
  },
  sendWorldEdit: (patch) => {
    const { socket, projectId } = get();
    if (!socket || !projectId) return;
    if (!isPlainPatch(patch)) {
      get()._onLog('error', 'World State 编辑失败：补丁必须是对象');
      return;
    }
    socket.emit('world:edit', { projectId, patch });
  },
  sendCharacterEdit: (characterId, patch, personaPatch = {}) =>
    isPlainPatch(patch)
      ? get().socket?.emit('character:edit', { projectId: get().projectId, characterId, patch, personaPatch })
      : get()._onLog('error', '角色状态编辑失败：补丁必须是对象'),
	  sendWriterRewrite: (chapterId, content) =>
	    get().socket?.emit('writer:rewrite', { chapterId, content }),

  cleanupInvalidCurrentChapter: async (projectId: string) => {
    const cleanupRes = await fetch(`/api/projects/${projectId}/cleanup-invalid-current-chapter`, { method: 'POST' });
    const cleanupData = await cleanupRes.json().catch(() => ({}));
    if (!cleanupRes.ok) {
      throw new Error(cleanupData.error || '清理失效演绎失败');
    }

    const [projRes, eventsRes, chaptersRes] = await Promise.all([
      fetch(`/api/projects/${projectId}`, { cache: 'no-store' }),
      fetch(`/api/projects/${projectId}/events?limit=500`, { cache: 'no-store' }),
      fetch(`/api/projects/${projectId}/chapters`, { cache: 'no-store' }),
    ]);
    const projData = await projRes.json();
    const eventsData = await eventsRes.json();
    const chaptersData = await chaptersRes.json();
    if (projData.project?.worldState) get()._onWorldUpdate(projData.project.worldState);
    if (projData.characters) {
      set({ characters: [] });
      projData.characters.forEach((c: Character) => get()._onCharacterUpdate(c));
    }
    set({
      events: eventsData.events ?? [],
      chapterChunks: {},
      storyDesign: projData.project?.worldState?.storyDesign ?? null,
      craftLessons: projData.project?.worldState?.craftLessons ?? [],
      projectStatus: 'idle',
    });
    get()._onChaptersLoaded(chaptersData.chapters ?? []);
    get()._onLog('info', '失效演绎已清理，当前正文稿已保留');
    return cleanupData.result;
  },

  resetCurrentChapter: async (projectId: string) => {
    const socket = get().socket;
    if (socket?.connected) {
      await new Promise<void>((resolve, reject) => {
        socket.timeout(20000).emit(
          'chapter:reset',
          { projectId },
          (err: Error | null, response?: { ok: boolean; error?: string }) => {
            if (err) {
              reject(new Error('演绎引擎没有响应，已取消本章重置'));
              return;
            }
            if (!response?.ok) {
              reject(new Error(response?.error || '重置当前章节失败'));
              return;
            }
            resolve();
          }
        );
      });
    } else {
      const resetRes = await fetch(`/api/projects/${projectId}/reset-current-chapter`, { method: 'POST' });
      if (!resetRes.ok) {
        const data = await resetRes.json().catch(() => ({}));
        throw new Error(data.error || '重置当前章节失败');
      }
    }

    const [projRes, eventsRes, chaptersRes] = await Promise.all([
      fetch(`/api/projects/${projectId}`, { cache: 'no-store' }),
      fetch(`/api/projects/${projectId}/events?limit=500`, { cache: 'no-store' }),
      fetch(`/api/projects/${projectId}/chapters`, { cache: 'no-store' }),
    ]);
    const projData = await projRes.json();
    const eventsData = await eventsRes.json();
    const chaptersData = await chaptersRes.json();
    if (projData.project?.worldState) get()._onWorldUpdate(projData.project.worldState);
    if (projData.characters) {
      set({ characters: [] });
      projData.characters.forEach((c: Character) => get()._onCharacterUpdate(c));
    }
    set({
      events: eventsData.events ?? [],
      chapterChunks: {},
      storyDesign: projData.project?.worldState?.storyDesign ?? null,
      craftLessons: projData.project?.worldState?.craftLessons ?? [],
      projectStatus: 'idle',
    });
    get()._onChaptersLoaded(chaptersData.chapters ?? []);
    get()._onLog('info', '当前章节已重置，前面章节和项目设定已保留');
  },

  resetProject: async (projectId: string) => {
    // 先停止引擎
    get().stopEngine();
    // 调用 API 重置
    const res = await fetch(`/api/projects/${projectId}/reset`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || '重置失败');
    }
    // 重新加载项目状态
    const projRes = await fetch(`/api/projects/${projectId}`);
    const projData = await projRes.json();
    if (projData.project?.worldState) get()._onWorldUpdate(projData.project.worldState);
    if (projData.characters) projData.characters.forEach((c: Character) => get()._onCharacterUpdate(c));
    // 清空前端累积状态
    set({
      events: [],
      chapterChunks: {},
      completedChapters: [],
      readerReviews: {},
      storyDesign: null,
      craftLessons: [],
      logs: [],
      projectStatus: 'idle',
    });
    get()._onLog('info', '项目已重置，可以重新启动演绎');
  },

  setPacingMode: (mode) => {
    const { socket, projectId } = get();
    socket?.emit('world:edit', { projectId, patch: { pacingMode: mode } });
    set((s) => ({
      worldState: s.worldState ? { ...s.worldState, pacingMode: mode } : s.worldState,
    }));
  },

  replaceReaderReviews: (chapterId, reviews) =>
    set((s) => ({
      readerReviews: {
        ...s.readerReviews,
        [chapterId]: reviews,
      },
      completedChapters: s.completedChapters.map((chapter) =>
        chapter.id === chapterId ? { ...chapter, readerReviews: reviews } : chapter
      ),
    })),

  _onWorldUpdate: (ws) => set({ worldState: ws, storyDesign: ws.storyDesign ?? null, craftLessons: ws.craftLessons ?? [] }),
  _onCharacterUpdate: (c) =>
    set((s) => ({
      characters: s.characters.some((x) => x.id === c.id)
        ? s.characters.map((x) => (x.id === c.id ? c : x))
        : [...s.characters, c],
    })),
  _onEventNew: (e) => set((s) => ({
    events: s.events.some((x) => x.id === e.id) ? s.events : sortEvents([...s.events, e]),
  })),
  _onChaptersLoaded: (chapters) => {
    const reviews: Record<string, ReaderReview[]> = {};
    for (const chapter of chapters) {
      reviews[chapter.id] = chapter.readerReviews ?? [];
    }
    set({
      completedChapters: chapters,
      readerReviews: reviews,
    });
  },
  _onWriterChunk: (chunk, chapterId) =>
    set((s) => ({
      chapterChunks: {
        ...s.chapterChunks,
        [chapterId]: (s.chapterChunks[chapterId] ?? '') + chunk,
      },
    })),
  _onWriterDone: (chapterId, content, chapter) =>
    set((s) => {
      const ws = s.worldState;
      const chunks = { ...s.chapterChunks };
      delete chunks[chapterId];
      const nextChapter: ChapterSummary = {
        id: chapterId,
        content,
        chapterNo: chapter?.chapterNo ?? ws?.currentChapter?.chapterNo,
        chapterTitle: chapter?.chapterTitle ?? ws?.currentChapter?.title,
        sceneName: chapter?.sceneName ?? ws?.sceneName ?? '未命名场景',
        wordCount: chapter?.wordCount ?? countReadableChars(content),
        startTurn: chapter?.startTurn,
        endTurn: chapter?.endTurn,
        createdAt: chapter?.createdAt ?? new Date().toISOString(),
        readerReviews: chapter?.readerReviews,
      };
      return {
        chapterChunks: chunks,
        completedChapters: s.completedChapters.some((c) => c.id === chapterId)
          ? s.completedChapters.map((c) =>
              c.id === chapterId
                ? { ...c, ...nextChapter }
                : c
            )
          : [
              ...s.completedChapters,
              nextChapter,
            ],
      };
    }),
  _onWriterFailed: (chapterId, message) =>
    set((s) => {
      const chunks = { ...s.chapterChunks };
      delete chunks[chapterId];
      const entry: LogEntry = {
        id: `log-${++logIdCounter}`,
        level: 'error',
        message: `Writer 未保存：${message}`,
        timestamp: Date.now(),
      };
      return {
        chapterChunks: chunks,
        logs: [
          ...s.logs,
          entry,
        ].slice(-200),
      };
    }),
  _onReaderReview: (review) =>
    set((s) => {
      const existing = s.readerReviews[review.chapterId] ?? [];
      if (existing.some((item) => item.id === review.id)) return s;
      return {
        readerReviews: {
          ...s.readerReviews,
          [review.chapterId]: [...existing, review],
        },
        completedChapters: s.completedChapters.map((chapter) =>
          chapter.id === review.chapterId
            ? {
                ...chapter,
                readerReviews: [...(chapter.readerReviews ?? []), review],
              }
            : chapter
        ),
      };
    }),
  _onDesignerUpdate: (design) => set({ storyDesign: design }),
  _onCraftLesson: (lesson) =>
    set((s) => ({
      craftLessons: s.craftLessons.some((item) => item.id === lesson.id)
        ? s.craftLessons.map((item) => (item.id === lesson.id ? lesson : item))
        : [...s.craftLessons, lesson].slice(-20),
      worldState: s.worldState
        ? {
            ...s.worldState,
            craftLessons: s.worldState.craftLessons?.some((item) => item.id === lesson.id)
              ? s.worldState.craftLessons.map((item) => (item.id === lesson.id ? lesson : item))
              : [...(s.worldState.craftLessons ?? []), lesson].slice(-20),
          }
        : s.worldState,
    })),
  _onEngineState: (status, _turn) => set({ projectStatus: status }),
  _onLog: (level, message) => {
    if (message.startsWith('节奏模式已切换为：')) return;
    set((s) => ({
      logs: [
        ...s.logs,
        { id: `log-${++logIdCounter}`, level, message, timestamp: Date.now() },
      ].slice(-200),
    }));
  },
  _onSnapshot: (data) => {
    set({
      worldState: data.worldState,
      storyDesign: data.worldState?.storyDesign ?? null,
      craftLessons: data.worldState?.craftLessons ?? [],
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
    readerReviews: {},
    storyDesign: null,
    craftLessons: [],
    logs: [],
  }),
}));
