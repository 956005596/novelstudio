'use client';

import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import {
  Play, Pause, Square, Send, ChevronLeft, Activity,
  Globe, Users, FileText, MessageSquare, Zap, AlertTriangle, Info, BookOpen,
  RotateCcw, Loader2,
} from 'lucide-react';
import { useNovelStore } from '@/store/novel-store';
import { useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import type { NovelEvent, Character } from '@/lib/novel/types';

const EVENT_TYPE_LABEL: Record<string, { label: string; color: string }> = {
  action: { label: '行动', color: 'bg-blue-100 text-blue-700 border-blue-200' },
  dialogue: { label: '对话', color: 'bg-green-100 text-green-700 border-green-200' },
  state_change: { label: '变化', color: 'bg-amber-100 text-amber-700 border-amber-200' },
  scene_meta: { label: '场景', color: 'bg-purple-100 text-purple-700 border-purple-200' },
  director: { label: '导演', color: 'bg-rose-100 text-rose-700 border-rose-200' },
};

export function LiveView({ projectId, projectName, onBack }: {
  projectId: string;
  projectName: string;
  onBack: () => void;
}) {
  const store = useNovelStore();
  const [directorCmd, setDirectorCmd] = useState('');
  const [editingCharacter, setEditingCharacter] = useState<string | null>(null);
  const [charEmotionInput, setCharEmotionInput] = useState('');
  const [charLocationInput, setCharLocationInput] = useState('');
  const [worldSceneInput, setWorldSceneInput] = useState('');
  const [resetting, setResetting] = useState(false);
  const [centerView, setCenterView] = useState<'writer' | 'events' | 'split'>('split');

  const eventScrollRef = useRef<HTMLDivElement>(null);
  const writerScrollRef = useRef<HTMLDivElement>(null);
  const logScrollRef = useRef<HTMLDivElement>(null);

  // 初始化
  useEffect(() => {
    store.initProjectId(projectId, projectName, 3);
    store.connect();
    // 加载项目详情
    fetch(`/api/projects/${projectId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.project?.worldState) store._onWorldUpdate(data.project.worldState);
        if (data.characters) data.characters.forEach((c: Character) => store._onCharacterUpdate(c));
        store.setDirectorLvl(data.project?.directorLvl ?? 3);
      })
      .catch(console.error);
    // 加载历史事件
    fetch(`/api/projects/${projectId}/events?limit=200`)
      .then((r) => r.json())
      .then((data) => {
        (data.events ?? []).forEach((e: NovelEvent) => store._onEventNew(e));
      })
      .catch(console.error);

    return () => {
      store.stopEngine();
      store.disconnect();
      store.reset();
    };
  }, [projectId]);

  // 自动滚动
  useEffect(() => {
    eventScrollRef.current?.scrollTo({ top: 999999, behavior: 'smooth' });
  }, [store.events.length]);
  useEffect(() => {
    writerScrollRef.current?.scrollTo({ top: 999999, behavior: 'smooth' });
  }, [store.chapterChunks, store.completedChapters.length]);
  useEffect(() => {
    logScrollRef.current?.scrollTo({ top: 999999, behavior: 'smooth' });
  }, [store.logs.length]);

  const handleStart = () => {
    store.startEngine();
    toast.success('演绎已启动');
  };
  const handlePause = () => {
    store.pauseEngine();
    toast.info('演绎已暂停');
  };
  const handleResume = () => {
    store.resumeEngine();
    toast.info('演绎已恢复');
  };
  const handleStop = () => {
    if (!confirm('确定停止演绎？需要重新启动才能继续。')) return;
    store.stopEngine();
    toast.info('演绎已停止');
  };
  const handleReset = async () => {
    const confirmed = confirm(
      '确定重置当前项目？\n\n' +
      '将清空：所有事件日志、已生成章节、用户指令、World State 运行时状态\n' +
      '保留：项目本身、角色设定（背景/性格/目标）、世界观、剧情节点\n\n' +
      '适合"演绎得不好想重来"的场景，基于同一设定重新演绎。'
    );
    if (!confirmed) return;
    setResetting(true);
    try {
      await store.resetProject(projectId);
      toast.success('项目已重置，可以重新启动演绎');
    } catch (e: any) {
      toast.error(`重置失败: ${e.message}`);
    } finally {
      setResetting(false);
    }
  };
  const handleDirectorCmd = () => {
    if (!directorCmd.trim()) return;
    store.sendDirectorCommand(directorCmd.trim());
    toast.success('指令已发送给 Director');
    setDirectorCmd('');
  };
  const handleDirectorLvlChange = async (lvl: number) => {
    store.setDirectorLvl(lvl);
    await fetch(`/api/projects/${projectId}/director-lvl`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: lvl }),
    });
    toast.success(`Director 强度已设为 ${lvl}/5`);
  };
  const handleCharacterEdit = (c: Character) => {
    setEditingCharacter(c.id);
    setCharEmotionInput(c.currentState.emotion);
    setCharLocationInput(c.currentState.location);
  };
  const saveCharacterEdit = () => {
    if (!editingCharacter) return;
    store.sendCharacterEdit(editingCharacter, {
      emotion: charEmotionInput,
      location: charLocationInput,
    });
    setEditingCharacter(null);
    toast.success('角色状态已更新');
  };
  const handleWorldSceneEdit = () => {
    if (!store.worldState) return;
    store.sendWorldEdit({ sceneDescription: worldSceneInput });
    setWorldSceneInput('');
    toast.success('场景描述已更新');
  };

  const isRunning = store.projectStatus === 'running';
  const writerText = Object.entries(store.chapterChunks).map(([_, v]) => v).join('');
  const completedText = store.completedChapters.map((c) => c.content).join('\n\n');
  const fullWriterText = completedText + (writerText ? '\n\n' + writerText : '');

  return (
    <div className="min-h-screen flex flex-col">
      {/* 顶栏 */}
      <header className="border-b bg-background/95 backdrop-blur sticky top-0 z-10">
        <div className="px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Button variant="ghost" size="sm" onClick={onBack}>
              <ChevronLeft className="h-4 w-4" /> 项目
            </Button>
            <Separator orientation="vertical" className="h-5" />
            <div className="min-w-0">
              <div className="font-semibold truncate">{projectName}</div>
              <div className="text-xs text-muted-foreground flex items-center gap-2">
                <Badge variant="outline" className={
                  store.connected ? 'border-green-500 text-green-700' : 'border-red-500 text-red-700'
                }>
                  {store.connected ? '已连接' : '未连接'}
                </Badge>
                <span>Turn {store.worldState?.turn ?? 0}</span>
                <span>·</span>
                <span>张力 {store.worldState?.tension ?? 0}/10</span>
                <span>·</span>
                <span className={isRunning ? 'text-green-600' : ''}>
                  {isRunning ? '演绎中' : store.projectStatus === 'paused' ? '已暂停' : '空闲'}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!isRunning && store.projectStatus !== 'paused' && (
              <Button size="sm" onClick={handleStart} disabled={!store.connected || resetting}>
                <Play className="h-4 w-4 mr-1" /> 启动演绎
              </Button>
            )}
            {isRunning && (
              <Button size="sm" variant="outline" onClick={handlePause} disabled={resetting}>
                <Pause className="h-4 w-4 mr-1" /> 暂停
              </Button>
            )}
            {store.projectStatus === 'paused' && (
              <Button size="sm" onClick={handleResume} disabled={resetting}>
                <Play className="h-4 w-4 mr-1" /> 继续
              </Button>
            )}
            {(isRunning || store.projectStatus === 'paused') && (
              <Button size="sm" variant="destructive" onClick={handleStop} disabled={resetting}>
                <Square className="h-4 w-4 mr-1" /> 停止
              </Button>
            )}
            <Separator orientation="vertical" className="h-5" />
            <Button
              size="sm"
              variant="outline"
              onClick={handleReset}
              disabled={resetting || isRunning}
              title={isRunning ? '请先停止演绎再重置' : '清空事件日志和章节，回到 Turn 0 重新演绎'}
            >
              {resetting ? (
                <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> 重置中…</>
              ) : (
                <><RotateCcw className="h-4 w-4 mr-1" /> 重置</>
              )}
            </Button>
          </div>
        </div>
      </header>

      {/* 三栏 */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[280px_1fr_320px] gap-px bg-border overflow-hidden">
        {/* 左栏：角色面板 */}
        <aside className="bg-background overflow-y-auto">
          <CharacterPanel
            characters={store.characters}
            worldState={store.worldState}
            editingId={editingCharacter}
            charEmotionInput={charEmotionInput}
            charLocationInput={charLocationInput}
            setCharEmotionInput={setCharEmotionInput}
            setCharLocationInput={setCharLocationInput}
            onEdit={handleCharacterEdit}
            onSave={saveCharacterEdit}
            onCancel={() => setEditingCharacter(null)}
          />
        </aside>

        {/* 中栏：事件日志 + Writer 输出（Tab 切换 + 可调高度） */}
        <section className="bg-background overflow-hidden flex flex-col">
          {/* Tab 切换 */}
          <div className="border-b bg-muted/30 flex items-center gap-1 px-2 py-1.5 flex-shrink-0">
            <button
              onClick={() => setCenterView('writer')}
              className={`px-3 py-1 text-xs rounded-md transition-colors flex items-center gap-1.5 ${
                centerView === 'writer' ? 'bg-background text-foreground font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <FileText className="h-3.5 w-3.5" />
              小说正文
              {writerText && <span className="text-[10px] text-amber-600 animate-pulse">●</span>}
              <span className="text-[10px] text-muted-foreground">({fullWriterText.length})</span>
            </button>
            <button
              onClick={() => setCenterView('events')}
              className={`px-3 py-1 text-xs rounded-md transition-colors flex items-center gap-1.5 ${
                centerView === 'events' ? 'bg-background text-foreground font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Activity className="h-3.5 w-3.5" />
              事件日志
              <span className="text-[10px] text-muted-foreground">({store.events.length})</span>
            </button>
            <button
              onClick={() => setCenterView('split')}
              className={`px-3 py-1 text-xs rounded-md transition-colors flex items-center gap-1.5 ${
                centerView === 'split' ? 'bg-background text-foreground font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Separator className="h-3.5 w-3.5" />
              分屏
            </button>
          </div>

          {/* 内容区 */}
          <div className="flex-1 overflow-hidden flex flex-col">
            {centerView === 'writer' && (
              <div className="flex-1 overflow-hidden">
                <WriterPanel text={fullWriterText} streamText={writerText} scrollRef={writerScrollRef} fullHeight />
              </div>
            )}
            {centerView === 'events' && (
              <div className="flex-1 overflow-hidden">
                <EventLogPanel events={store.events} scrollRef={eventScrollRef} fullHeight />
              </div>
            )}
            {centerView === 'split' && (
              <div className="flex-1 grid grid-rows-2 gap-px bg-border overflow-hidden">
                <div className="bg-background overflow-hidden flex flex-col">
                  <EventLogPanel events={store.events} scrollRef={eventScrollRef} />
                </div>
                <div className="bg-background overflow-hidden flex flex-col">
                  <WriterPanel text={fullWriterText} streamText={writerText} scrollRef={writerScrollRef} />
                </div>
              </div>
            )}
          </div>
        </section>

        {/* 右栏：干预面板 */}
        <aside className="bg-background overflow-y-auto">
          <InterventionPanel
            directorCmd={directorCmd}
            setDirectorCmd={setDirectorCmd}
            onSendCmd={handleDirectorCmd}
            directorLvl={store.directorLvl}
            onLvlChange={handleDirectorLvlChange}
            worldState={store.worldState}
            worldSceneInput={worldSceneInput}
            setWorldSceneInput={setWorldSceneInput}
            onWorldEdit={handleWorldSceneEdit}
            logs={store.logs}
            logScrollRef={logScrollRef}
            completedChapters={store.completedChapters}
          />
        </aside>
      </main>
    </div>
  );
}

// ============== 角色面板 ==============
function CharacterPanel({
  characters, worldState, editingId, charEmotionInput, charLocationInput,
  setCharEmotionInput, setCharLocationInput, onEdit, onSave, onCancel,
}: {
  characters: Character[];
  worldState: any;
  editingId: string | null;
  charEmotionInput: string;
  charLocationInput: string;
  setCharEmotionInput: (v: string) => void;
  setCharLocationInput: (v: string) => void;
  onEdit: (c: Character) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const present = characters.filter((c) => worldState?.presentCharacterIds?.includes(c.id));
  return (
    <div className="p-4">
      <div className="flex items-center gap-2 mb-4">
        <Users className="h-5 w-5 text-primary" />
        <h2 className="font-semibold">角色 ({present.length})</h2>
      </div>
      <div className="space-y-3">
        {present.map((c) => (
          <div key={c.id} className="p-3 rounded-md border bg-card">
            <div className="flex items-center justify-between mb-2">
              <div className="font-medium flex items-center gap-2">
                {c.name}
                <Badge variant={
                  c.role === 'protagonist' ? 'default' :
                  c.role === 'antagonist' ? 'destructive' : 'secondary'
                }>
                  {c.role === 'protagonist' ? '主角' :
                   c.role === 'antagonist' ? '反派' : 'NPC'}
                </Badge>
              </div>
            </div>
            {editingId === c.id ? (
              <div className="space-y-2">
                <Input
                  value={charEmotionInput}
                  onChange={(e) => setCharEmotionInput(e.target.value)}
                  placeholder="情绪"
                  className="h-8 text-sm"
                />
                <Input
                  value={charLocationInput}
                  onChange={(e) => setCharLocationInput(e.target.value)}
                  placeholder="位置"
                  className="h-8 text-sm"
                />
                <div className="flex gap-2">
                  <Button size="sm" className="h-7" onClick={onSave}>保存</Button>
                  <Button size="sm" variant="ghost" className="h-7" onClick={onCancel}>取消</Button>
                </div>
              </div>
            ) : (
              <>
                <div className="text-xs text-muted-foreground space-y-1">
                  <div>情绪：<span className="text-foreground">{c.currentState.emotion}</span></div>
                  <div>位置：<span className="text-foreground">{c.currentState.location}</span></div>
                  {c.currentState.level && (
                    <div>Lv {c.currentState.level} · HP {c.currentState.hp} · MP {c.currentState.mp}</div>
                  )}
                  {/* 性格标签 */}
                  {c.persona.personality?.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {c.persona.personality.map((p, i) => (
                        <Badge key={i} variant="outline" className="text-[10px]">
                          {p}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {/* 关系 */}
                  <div className="flex flex-wrap gap-1 mt-1">
                    {Object.entries(c.currentState.relationships ?? {}).map(([name, r]: any) => (
                      <Badge
                        key={name}
                        variant="outline"
                        className={`text-[10px] ${
                          r.value > 50 ? 'border-green-500 text-green-700' :
                          r.value < 0 ? 'border-red-500 text-red-700' : ''
                        }`}
                        title={r.note}
                      >
                        {name} {r.value > 0 ? '+' : ''}{r.value}
                      </Badge>
                    ))}
                  </div>
                </div>

                {/* 深度档案 - 可展开 */}
                {(c.persona.backstory || c.persona.growthArc || c.persona.innerConflict || c.persona.secrets?.length) && (
                  <details className="mt-2 group">
                    <summary className="text-xs font-medium cursor-pointer text-primary hover:underline flex items-center gap-1">
                      <BookOpen className="h-3 w-3" />
                      角色档案
                      <span className="text-muted-foreground group-open:hidden">（点击展开）</span>
                    </summary>
                    <div className="mt-2 space-y-2 text-xs">
                      {c.persona.backstory && (
                        <div>
                          <div className="font-medium text-foreground mb-0.5">背景故事</div>
                          <div className="text-muted-foreground leading-relaxed">{c.persona.backstory}</div>
                        </div>
                      )}
                      {c.persona.growthArc && (
                        <div>
                          <div className="font-medium text-foreground mb-0.5">成长弧线</div>
                          <div className="text-muted-foreground leading-relaxed">{c.persona.growthArc}</div>
                        </div>
                      )}
                      {c.persona.innerConflict && (
                        <div>
                          <div className="font-medium text-foreground mb-0.5">内在冲突</div>
                          <div className="text-muted-foreground leading-relaxed italic">{c.persona.innerConflict}</div>
                        </div>
                      )}
                      {c.persona.motivations?.length > 0 && (
                        <div>
                          <div className="font-medium text-foreground mb-0.5">动机层次</div>
                          <ul className="text-muted-foreground space-y-0.5 ml-3 list-disc">
                            {c.persona.motivations.map((m, i) => <li key={i}>{m}</li>)}
                          </ul>
                        </div>
                      )}
                      {c.persona.secrets?.length > 0 && (
                        <div>
                          <div className="font-medium text-foreground mb-0.5">秘密</div>
                          <ul className="text-muted-foreground space-y-0.5 ml-3 list-disc">
                            {c.persona.secrets.map((s, i) => <li key={i} className="italic">{s}</li>)}
                          </ul>
                        </div>
                      )}
                      {c.persona.speechHabits?.length > 0 && (
                        <div>
                          <div className="font-medium text-foreground mb-0.5">说话习惯</div>
                          <div className="text-muted-foreground">{c.persona.speechHabits.join('；')}</div>
                        </div>
                      )}
                      {c.persona.appearance && (
                        <div>
                          <div className="font-medium text-foreground mb-0.5">外貌</div>
                          <div className="text-muted-foreground">{c.persona.appearance}</div>
                        </div>
                      )}
                      {c.persona.skills?.length > 0 && (
                        <div>
                          <div className="font-medium text-foreground mb-0.5">技能</div>
                          <div className="flex flex-wrap gap-1">
                            {c.persona.skills.map((s, i) => (
                              <Badge key={i} variant="outline" className="text-[10px]">{s}</Badge>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </details>
                )}

                <Button
                  size="sm" variant="ghost" className="h-6 mt-2 w-full text-xs"
                  onClick={() => onEdit(c)}
                >
                  干预状态
                </Button>
              </>
            )}
          </div>
        ))}
        {present.length === 0 && (
          <div className="text-center text-sm text-muted-foreground py-8">
            暂无在场角色
          </div>
        )}
      </div>
    </div>
  );
}

// ============== 事件日志 ==============
function EventLogPanel({ events, scrollRef, fullHeight }: { events: NovelEvent[]; scrollRef: any; fullHeight?: boolean }) {
  return (
    <div className="flex flex-col h-full">
      {!fullHeight && (
        <div className="px-4 py-2 border-b bg-muted/30 flex items-center gap-2 flex-shrink-0">
          <Activity className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">事件日志</h3>
          <span className="text-xs text-muted-foreground">({events.length})</span>
        </div>
      )}
      <ScrollArea className="flex-1" ref={scrollRef}>
        <div className="p-3 space-y-2">
          {events.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-8">
              等待演绎启动…
            </div>
          ) : (
            events.map((e) => {
              const meta = EVENT_TYPE_LABEL[e.type] ?? EVENT_TYPE_LABEL.action;
              return (
                <div key={e.id} className="text-sm border-l-2 pl-3 py-1 hover:bg-accent/30">
                  <div className="flex items-center gap-2 mb-0.5">
                    <Badge variant="outline" className={`text-[10px] ${meta.color}`}>
                      {meta.label}
                    </Badge>
                    <span className="text-xs font-medium">{e.agentName}</span>
                    {e.emotion && (
                      <span className="text-[10px] text-muted-foreground italic">[{e.emotion}]</span>
                    )}
                    {e.target && (
                      <span className="text-[10px] text-muted-foreground">→ {e.target}</span>
                    )}
                    <span className="text-[10px] text-muted-foreground ml-auto">T{e.turn}</span>
                  </div>
                  <div className="text-foreground/90 text-[13px] leading-snug">{e.content}</div>
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ============== Writer 输出 ==============
function WriterPanel({ text, streamText, scrollRef, fullHeight }: {
  text: string; streamText: string; scrollRef: any; fullHeight?: boolean;
}) {
  return (
    <div className="flex flex-col h-full">
      {!fullHeight && (
        <div className="px-4 py-2 border-b bg-muted/30 flex items-center gap-2 flex-shrink-0">
          <FileText className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">小说文本</h3>
          <span className="text-xs text-muted-foreground">({text.length} 字)</span>
          {streamText && (
            <Badge variant="outline" className="text-[10px] border-amber-500 text-amber-700 animate-pulse">
              生成中…
            </Badge>
          )}
        </div>
      )}
      <ScrollArea className="flex-1" ref={scrollRef}>
        <div className="p-4 max-w-3xl mx-auto">
          {text ? (
            <article className="prose prose-sm max-w-none whitespace-pre-wrap leading-relaxed">
              {text}
            </article>
          ) : (
            <div className="text-center text-sm text-muted-foreground py-8">
              Writer 输出将在这里实时呈现…
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ============== 干预面板 ==============
function InterventionPanel({
  directorCmd, setDirectorCmd, onSendCmd, directorLvl, onLvlChange,
  worldState, worldSceneInput, setWorldSceneInput, onWorldEdit,
  logs, logScrollRef, completedChapters,
}: any) {
  return (
    <div className="p-4 space-y-4">
      {/* Director 指令 */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Zap className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Director 指令</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-2">
          高层干预：影响剧情走向但不必手操细节
        </p>
        <Textarea
          value={directorCmd}
          onChange={(e) => setDirectorCmd(e.target.value)}
          placeholder="例如：让林墨和赵铁柱吵一架；让苏晚发现赵铁柱的秘密；制造一个误会"
          className="text-sm min-h-[80px] resize-none"
        />
        <Button size="sm" className="w-full mt-2" onClick={onSendCmd} disabled={!directorCmd.trim()}>
          <Send className="h-3 w-3 mr-1" /> 发送给 Director
        </Button>
      </div>

      <Separator />

      {/* Director 强度 */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">Director 强度</h3>
          <Badge variant="outline">{directorLvl}/5</Badge>
        </div>
        <Slider
          value={[directorLvl]}
          min={1} max={5} step={1}
          onValueChange={(v) => onLvlChange(v[0])}
        />
        <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
          <span>协调者</span>
          <span>平衡</span>
          <span>强主导</span>
        </div>
      </div>

      <Separator />

      {/* 世界观设定（来自大纲） */}
      {worldState?.worldLore && (
        <>
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Globe className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold">世界观设定</h3>
            </div>
            <details className="group">
              <summary className="text-xs cursor-pointer text-primary hover:underline">
                {worldState.worldLore.prelude?.slice(0, 60) || worldState.worldLore.premise?.slice(0, 60) || '点击展开'}
                <span className="text-muted-foreground ml-1 group-open:hidden">…</span>
              </summary>
              <div className="mt-2 space-y-2 text-xs">
                {worldState.worldLore.premise && (
                  <div>
                    <div className="font-medium text-foreground">故事前提</div>
                    <div className="text-muted-foreground">{worldState.worldLore.premise}</div>
                  </div>
                )}
                {worldState.worldLore.worldBackground && (
                  <div>
                    <div className="font-medium text-foreground">世界背景</div>
                    <div className="text-muted-foreground leading-relaxed">{worldState.worldLore.worldBackground}</div>
                  </div>
                )}
                {worldState.worldLore.timeline && (
                  <div>
                    <div className="font-medium text-foreground">时间线</div>
                    <div className="text-muted-foreground">{worldState.worldLore.timeline}</div>
                  </div>
                )}
                {worldState.worldLore.geography?.length > 0 && (
                  <div>
                    <div className="font-medium text-foreground">重要地点</div>
                    <ul className="text-muted-foreground space-y-0.5 ml-3 list-disc">
                      {worldState.worldLore.geography.map((g, i) => <li key={i}>{g}</li>)}
                    </ul>
                  </div>
                )}
                {worldState.worldLore.factions?.length > 0 && (
                  <div>
                    <div className="font-medium text-foreground">势力</div>
                    <div className="space-y-1">
                      {worldState.worldLore.factions.map((f, i) => (
                        <div key={i} className="p-1.5 rounded border bg-muted/30">
                          <div className="flex items-center gap-1">
                            <span className="font-medium">{f.name}</span>
                            <Badge variant="outline" className={`text-[9px] ${
                              f.stance === '敌对' ? 'border-red-500 text-red-700' :
                              f.stance === '友好' ? 'border-green-500 text-green-700' : ''
                            }`}>{f.stance}</Badge>
                          </div>
                          <div className="text-muted-foreground mt-0.5">{f.description}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {worldState.worldLore.rules?.length > 0 && (
                  <div>
                    <div className="font-medium text-foreground">世界规则</div>
                    <ul className="text-muted-foreground space-y-0.5 ml-3 list-disc">
                      {worldState.worldLore.rules.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                  </div>
                )}
                {worldState.worldLore.themes?.length > 0 && (
                  <div>
                    <div className="font-medium text-foreground">主题</div>
                    <div className="flex flex-wrap gap-1">
                      {worldState.worldLore.themes.map((t, i) => (
                        <Badge key={i} variant="outline" className="text-[10px]">{t}</Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </details>
          </div>
          <Separator />
        </>
      )}

      {/* 剧情节点（来自大纲） */}
      {worldState?.plotNodes && worldState.plotNodes.length > 0 && (
        <>
          <div>
            <div className="flex items-center gap-2 mb-2">
              <BookOpen className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold">剧情节点</h3>
              <Badge variant="outline">
                {worldState.plotNodes.filter((n: any) => n.completed).length}/{worldState.plotNodes.length}
              </Badge>
            </div>
            {/* 节点类型统计 */}
            <div className="flex flex-wrap gap-1 mb-2 text-[10px]">
              {(['main', 'sub', 'foreshadow', 'daily'] as const).map(t => {
                const count = worldState.plotNodes.filter((n: any) => n.nodeType === t).length;
                if (count === 0) return null;
                const label = t === 'main' ? '主线' : t === 'sub' ? '支线' : t === 'foreshadow' ? '伏笔' : '日常';
                const color = t === 'main' ? 'border-rose-300 text-rose-700 bg-rose-50' :
                              t === 'sub' ? 'border-blue-300 text-blue-700 bg-blue-50' :
                              t === 'foreshadow' ? 'border-purple-300 text-purple-700 bg-purple-50' :
                              'border-green-300 text-green-700 bg-green-50';
                return (
                  <Badge key={t} variant="outline" className={`text-[9px] ${color}`}>
                    {label} {count}
                  </Badge>
                );
              })}
            </div>
            <ScrollArea className="max-h-[300px]">
              <div className="space-y-1.5 pr-2">
                {worldState.plotNodes.map((n: any) => {
                  const typeColor = n.nodeType === 'main' ? 'border-l-rose-500' :
                                    n.nodeType === 'sub' ? 'border-l-blue-500' :
                                    n.nodeType === 'foreshadow' ? 'border-l-purple-500' :
                                    'border-l-green-500';
                  const typeLabel = n.nodeType === 'main' ? '主线' : n.nodeType === 'sub' ? '支线' : n.nodeType === 'foreshadow' ? '伏笔' : '日常';
                  return (
                    <div
                      key={n.index}
                      className={`text-xs p-2 rounded border border-l-4 ${typeColor} ${
                        n.completed ? 'bg-green-50 border-green-200 line-through opacity-60' : 'bg-amber-50 border-amber-200'
                      }`}
                    >
                      <div className="font-medium flex items-center gap-1 flex-wrap">
                        {n.completed ? '✓' : '○'} 节点{n.index} · {n.title}
                        <Badge variant="outline" className="text-[9px]">{typeLabel}</Badge>
                        {n.priority && <span className="text-[9px] text-muted-foreground">P{n.priority}</span>}
                        {n.targetTurn && <span className="text-[9px] text-muted-foreground">T{n.targetTurn}</span>}
                        {n.estimatedTurns && <span className="text-[9px] text-muted-foreground">~{n.estimatedTurns}T</span>}
                      </div>
                      <div className="text-muted-foreground mt-0.5">{n.description}</div>
                      {n.linkedCharacters?.length > 0 && (
                        <div className="flex flex-wrap gap-0.5 mt-1">
                          {n.linkedCharacters.map((c: string, i: number) => (
                            <span key={i} className="text-[9px] px-1 py-0.5 rounded bg-muted text-muted-foreground">{c}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </div>
          <Separator />
        </>
      )}

      {/* 节奏控制 */}
      {worldState?.plotNodes && worldState.plotNodes.length > 0 && (
        <>
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Activity className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold">剧情节奏</h3>
            </div>
            <div className="grid grid-cols-3 gap-1">
              {([
                { key: 'fast', label: '快推进', desc: '每 2-3T 推进主线' },
                { key: 'balanced', label: '平衡', desc: '每 4-6T 推进主线' },
                { key: 'slow', label: '慢热', desc: '每 8-15T 推进主线' },
              ] as const).map(m => (
                <button
                  key={m.key}
                  onClick={() => store.setPacingMode(m.key)}
                  className={`p-2 rounded-md border text-center transition-all ${
                    worldState.pacingMode === m.key
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-muted text-muted-foreground hover:bg-accent'
                  }`}
                  title={m.desc}
                >
                  <div className="text-xs font-medium">{m.label}</div>
                  <div className="text-[9px] opacity-80">{m.desc}</div>
                </button>
              ))}
            </div>
            {worldState.turnsSinceLastMain !== undefined && (
              <div className="text-[10px] text-muted-foreground mt-1.5">
                距上次主线推进：{worldState.turnsSinceLastMain} Turn
              </div>
            )}
          </div>
          <Separator />
        </>
      )}

      {/* World State 编辑 */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Globe className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">World State</h3>
        </div>
        <div className="text-xs text-muted-foreground space-y-1 mb-2">
          <div>场景：<span className="text-foreground">{worldState?.sceneName ?? '-'}</span></div>
          <div>位置：<span className="text-foreground">{worldState?.location ?? '-'}</span></div>
          <div>时间：<span className="text-foreground">{worldState?.timeOfDay ?? '-'}</span></div>
        </div>
        <Textarea
          value={worldSceneInput}
          onChange={(e) => setWorldSceneInput(e.target.value)}
          placeholder="修改场景描述（覆盖原值）"
          className="text-xs min-h-[60px] resize-none"
        />
        <Button size="sm" variant="outline" className="w-full mt-2" onClick={onWorldEdit} disabled={!worldSceneInput.trim()}>
          应用场景补丁
        </Button>
      </div>

      <Separator />

      {/* 已完成章节 */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <BookOpen className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">已完成段落</h3>
          <Badge variant="outline">{completedChapters.length}</Badge>
        </div>
        {completedChapters.length === 0 ? (
          <div className="text-xs text-muted-foreground">尚未生成完整段落</div>
        ) : (
          <div className="space-y-1">
            {completedChapters.map((c: any, i: number) => (
              <div key={c.id} className="text-xs p-2 rounded border">
                <div className="font-medium">第 {i + 1} 段 · {c.sceneName}</div>
                <div className="text-muted-foreground">{c.content.length} 字</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Separator />

      {/* 日志 */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <MessageSquare className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">引擎日志</h3>
        </div>
        <ScrollArea className="h-[180px]" ref={logScrollRef}>
          <div className="space-y-1 pr-2">
            {logs.length === 0 ? (
              <div className="text-xs text-muted-foreground">无日志</div>
            ) : (
              logs.map((log: any) => (
                <div key={log.id} className="text-[11px] flex items-start gap-1.5">
                  {log.level === 'error' ? (
                    <AlertTriangle className="h-3 w-3 text-destructive flex-shrink-0 mt-0.5" />
                  ) : log.level === 'warn' ? (
                    <AlertTriangle className="h-3 w-3 text-amber-500 flex-shrink-0 mt-0.5" />
                  ) : (
                    <Info className="h-3 w-3 text-muted-foreground flex-shrink-0 mt-0.5" />
                  )}
                  <span className={
                    log.level === 'error' ? 'text-destructive' :
                    log.level === 'warn' ? 'text-amber-600' : 'text-muted-foreground'
                  }>
                    {log.message}
                  </span>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
