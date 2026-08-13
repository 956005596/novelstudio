'use client';

import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BookOpen, Plus, Trash2, Play, ArrowRight, Sparkles, Loader2, AlertCircle, RotateCw, CheckCircle2, Globe, Users, GitBranch, Save } from 'lucide-react';
import { toast } from 'sonner';
import { onlineGameTemplate } from '@/lib/novel/templates/online-game';
import { ThemeToggle } from '@/components/theme-toggle';

interface ProjectListItem {
  id: string;
  name: string;
  template: string;
  status: string;
  currentTurn: number;
  directorLvl: number;
  createdAt: string;
  _count: {
    characters: number;
    events: number;
    chapters: number;
    chapterDrafts?: number;
    staleChapterDrafts?: number;
  };
}

const OUTLINE_EXAMPLES = [
  '退役剑士林墨回归新服，被旧仇人公会派来的卧底赵铁柱监视，副本里赵铁柱准备偷袭夺剑，被治疗苏晚识破。三人最终在 Boss 战前摊牌。',
  '豪门千金苏婉被未婚夫陆景琛退婚后，在闺蜜帮助下进入家族企业从基层做起，遇到表面冷淡实则护短的总裁助理沈墨，三人职场博弈中暗生情愫。',
  '商战：老牌车企德盛面临新能源转型，技术总监主张自研、CFO 主张收购初创公司，CEO 摇摆不定。三方在董事会上对决，最后揭露 CFO 与初创公司有利益输送。',
];

// 阶段定义（用于进度展示）
const STAGES = [
  { key: 'reading-outline', label: '读取大纲', icon: BookOpen },
  { key: 'world-lore', label: '构建世界观', icon: Globe },
  { key: 'characters', label: '设计角色', icon: Users },
  { key: 'plot-nodes', label: '拆解剧情', icon: GitBranch },
  { key: 'long-form-plan', label: '长篇规划', icon: BookOpen },
  { key: 'saving', label: '保存项目', icon: Save },
] as const;

interface StageState {
  status: 'pending' | 'running' | 'done' | 'error';
  message?: string;
}

export function SetupPanel({ onEnter }: { onEnter: (projectId: string, projectName: string) => void }) {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [newName, setNewName] = useState('');
  const [newHint, setNewHint] = useState('');
  const [loading, setLoading] = useState(false);

  // AI 生成模式
  const [outline, setOutline] = useState('');
  const [outlineName, setOutlineName] = useState('');
  const [generating, setGenerating] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  // 进度跟踪
  const [progressMsg, setProgressMsg] = useState<string>('');
  const [progressPercent, setProgressPercent] = useState(0);
  const [stageStates, setStageStates] = useState<Record<string, StageState>>({});
  const abortRef = useRef<AbortController | null>(null);

  const refresh = async () => {
    const res = await fetch('/api/projects');
    const data = await res.json();
    setProjects(data.projects ?? []);
  };

  useEffect(() => {
    refresh();
  }, []);

  // 预设模板创建
  const createProject = async () => {
    if (!newName.trim()) {
      toast.error('请输入项目名称');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), template: 'online-game', writerHint: newHint.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '创建失败');
      toast.success(`项目「${newName.trim()}」已创建`);
      const createdName = newName.trim();
      setNewName('');
      setNewHint('');
      await refresh();
      onEnter(data.id, createdName);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  // AI 大纲生成（SSE 流式）
  const createFromOutline = async () => {
    if (!outline.trim()) {
      toast.error('请输入大纲');
      return;
    }
    if (outline.trim().length < 10) {
      toast.error('大纲太短了，至少写 10 个字');
      return;
    }

    setGenerating(true);
    setLastError(null);
    setProgressMsg('准备中…');
    setProgressPercent(0);
    setStageStates({});

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/projects/from-outline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outline: outline.trim(),
          name: outlineName.trim() || undefined,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      // 解析 SSE 流
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finalResult: any = null;
      let streamError: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE: 每个 event 以 \n\n 分隔
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          let eventType = 'message';
          let dataStr = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              dataStr += line.slice(5).trim();
            }
          }
          if (!dataStr) continue;

          try {
            const data = JSON.parse(dataStr);

            if (eventType === 'progress') {
              setProgressMsg(data.message || '');
              setProgressPercent(data.progress || 0);

              // 更新阶段状态
              if (data.stage && STAGES.some(s => s.key === data.stage)) {
                setStageStates(prev => {
                  const next = { ...prev };
                  // 标记之前的阶段为 done
                  const currentIdx = STAGES.findIndex(s => s.key === data.stage);
                  for (let i = 0; i < currentIdx; i++) {
                    const k = STAGES[i].key;
                    if (!next[k] || next[k].status === 'pending') {
                      next[k] = { status: 'done' };
                    }
                  }
                  next[data.stage] = {
                    status: data.progress >= 100 && data.stage === 'done' ? 'done' : 'running',
                    message: data.message,
                  };
                  return next;
                });
              }
            } else if (eventType === 'done') {
              finalResult = data;
              // 标记所有阶段 done
              setStageStates(prev => {
                const next = { ...prev };
                for (const s of STAGES) {
                  next[s.key] = { status: 'done' };
                }
                return next;
              });
            } else if (eventType === 'error') {
              streamError = data.error || '解析失败';
              // 标记当前运行中阶段为 error
              setStageStates(prev => {
                const next = { ...prev };
                for (const s of STAGES) {
                  if (next[s.key]?.status === 'running') {
                    next[s.key] = { status: 'error', message: streamError! };
                  }
                }
                return next;
              });
            }
          } catch (e) {
            // ignore parse errors
          }
        }
      }

      if (streamError) {
        setLastError(streamError);
        throw new Error(streamError);
      }

      if (!finalResult) {
        throw new Error('未收到完成信号');
      }

      toast.success(
        `AI 已生成：${finalResult.name}（${finalResult.characterCount} 角色 / ${finalResult.plotNodeCount} 节点 / ${finalResult.factionCount ?? 0} 势力）`
      );
      setOutline('');
      setOutlineName('');
      setLastError(null);
      await refresh();
      onEnter(finalResult.id, finalResult.name);
    } catch (e: any) {
      if (e.name === 'AbortError') {
        toast.info('已取消');
      } else {
        setLastError(e.message);
        toast.error(e.message);
      }
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  };

  const cancelGeneration = () => {
    abortRef.current?.abort();
    setGenerating(false);
  };

  const deleteProject = async (id: string) => {
    if (!confirm('确定删除该项目及其所有数据？')) return;
    await fetch(`/api/projects/${id}`, { method: 'DELETE' });
    toast.success('已删除');
    refresh();
  };

  return (
    <div className="container mx-auto max-w-5xl py-8 px-4">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold tracking-tight mb-2 flex items-center gap-3">
            <BookOpen className="h-8 w-8 text-primary" />
            NovelStudio
            <span className="text-sm font-normal text-muted-foreground">AI 演绎叙事引擎</span>
          </h1>
          <p className="text-muted-foreground">
            多 Agent 自主演绎 · Director 调度冲突 · 实时生成小说文本 · 任意时刻干预校准
          </p>
        </div>
        <ThemeToggle />
      </div>

      {/* 创建新项目 - 双模式 */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5" /> 新建演绎项目
          </CardTitle>
          <CardDescription>
            两种方式：直接用预设模板快速启动，或输入你的大纲让 AI 自动生成世界与角色
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="outline">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="outline" className="gap-1.5">
                <Sparkles className="h-3.5 w-3.5" /> AI 生成（输入大纲）
              </TabsTrigger>
              <TabsTrigger value="preset">预设模板（快速启动）</TabsTrigger>
            </TabsList>

            {/* AI 大纲模式 */}
            <TabsContent value="outline" className="mt-4 space-y-3">
              <div>
                <label className="text-sm font-medium mb-1.5 block">
                  项目名称（可空，AI 会自动起名）
                </label>
                <Input
                  value={outlineName}
                  onChange={(e) => setOutlineName(e.target.value)}
                  placeholder="例如：幽暗森林首杀记"
                  disabled={generating}
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1.5 block">
                  故事大纲 <span className="text-muted-foreground">（一句话简介 / 多段剧情 / 章节列表都行，长大纲会完整解析）</span>
                </label>
                <Textarea
                  value={outline}
                  onChange={(e) => setOutline(e.target.value)}
                  placeholder="例如：退役剑士林墨回归新服，被旧仇人公会派来的卧底赵铁柱监视，副本里赵铁柱准备偷袭夺剑，被治疗苏晚识破…"
                  className="min-h-[140px] resize-y"
                  disabled={generating}
                />
                <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2 flex-wrap">
                  <span>字数 {outline.length}</span>
                  {outline.length > 3000 && (
                    <Badge variant="outline" className="text-blue-700 border-blue-300 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300">
                      长大纲，将按原文解析
                    </Badge>
                  )}
                  {outline.length > 10000 && (
                    <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                      超长，解析会更慢
                    </Badge>
                  )}
                  <span>· AI 会解析为：世界观、角色档案、剧情节点</span>
                </div>
              </div>

              {/* 示例 */}
              {!outline && !generating && (
                <div className="flex flex-wrap gap-1.5">
                  <span className="text-xs text-muted-foreground py-1">参考示例：</span>
                  {OUTLINE_EXAMPLES.map((ex, i) => (
                    <button
                      key={i}
                      onClick={() => setOutline(ex)}
                      className="text-xs px-2 py-1 rounded-md border bg-muted/50 hover:bg-muted transition-colors"
                      disabled={generating}
                    >
                      {ex.slice(0, 24)}…
                    </button>
                  ))}
                </div>
              )}

              {/* 进度展示 */}
              {generating && (
                <div className="border rounded-md p-4 bg-muted/30 space-y-3">
                  {/* 当前消息 */}
                  <div className="flex items-center gap-2 text-sm">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    <span className="font-medium">{progressMsg}</span>
                    <span className="ml-auto text-muted-foreground">{progressPercent}%</span>
                  </div>

                  {/* 进度条 */}
                  <div className="h-2 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all duration-500 ease-out"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>

                  {/* 阶段步骤 */}
                  <div className="grid grid-cols-5 gap-2">
                    {STAGES.map((s) => {
                      const state = stageStates[s.key] ?? { status: 'pending' };
                      const Icon = s.icon;
                      return (
                        <div
                          key={s.key}
                          className={`flex flex-col items-center gap-1 p-2 rounded-md border text-center transition-all ${
                            state.status === 'done'
                              ? 'border-green-300 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950/30 dark:text-green-300'
                              : state.status === 'running'
                              ? 'border-primary bg-primary/5 text-primary'
                              : state.status === 'error'
                              ? 'border-destructive bg-destructive/5 text-destructive'
                              : 'border-muted text-muted-foreground'
                          }`}
                        >
                          {state.status === 'done' ? (
                            <CheckCircle2 className="h-4 w-4" />
                          ) : state.status === 'running' ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : state.status === 'error' ? (
                            <AlertCircle className="h-4 w-4" />
                          ) : (
                            <Icon className="h-4 w-4" />
                          )}
                          <span className="text-[10px] font-medium">{s.label}</span>
                        </div>
                      );
                    })}
                  </div>

                  {/* 取消按钮 */}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="w-full text-xs"
                    onClick={cancelGeneration}
                  >
                    取消生成
                  </Button>
                </div>
              )}

              {/* 错误提示 */}
              {lastError && !generating && (
                <div className="flex items-start gap-2 p-3 rounded-md border border-destructive/30 bg-destructive/5 text-destructive">
                  <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 text-sm">
                    <div className="font-medium">解析失败</div>
                    <div className="text-xs opacity-90 mt-0.5">{lastError}</div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={createFromOutline}
                  >
                    <RotateCw className="h-3 w-3 mr-1" /> 重试
                  </Button>
                </div>
              )}

              <Button
                onClick={createFromOutline}
                disabled={generating || !outline.trim() || outline.trim().length < 10}
                className="w-full"
              >
                {generating ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    AI 工作中…
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4 mr-1" />
                    AI 生成世界并进入
                  </>
                )}
              </Button>
            </TabsContent>

            {/* 预设模板模式 */}
            <TabsContent value="preset" className="mt-4">
              <div className="flex gap-3 items-start">
                <div className="flex-1">
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && createProject()}
                    placeholder="项目名称，例如：幽暗森林首杀记"
                    disabled={loading}
                  />
                </div>
                <div className="min-w-[200px] p-3 rounded-md bg-muted/50 border">
                  <div className="text-sm font-medium mb-1">{onlineGameTemplate.name}</div>
                  <div className="text-xs text-muted-foreground line-clamp-2">
                    {onlineGameTemplate.description}
                  </div>
                </div>
                <Button onClick={createProject} disabled={loading || !newName.trim()}>
                  <Play className="h-4 w-4 mr-1" /> 创建并进入
                </Button>
              </div>
              <div className="text-xs text-muted-foreground mt-2">
                预设模板包含 3 个固定角色（林墨/苏晚/赵铁柱）和预设场景，适合快速体验。
              </div>
              <div className="mt-3">
                <label className="text-sm font-medium mb-1.5 block">
                  题材风格 <span className="text-muted-foreground">（可选，会被所有创作 Agent 遵循）</span>
                </label>
                <textarea
                  value={newHint}
                  onChange={(e) => setNewHint(e.target.value)}
                  rows={3}
                  placeholder="例：都市虐恋，暧昧拉扯，细腻心理描写，误会推进，节奏舒缓。或：悬疑推理，线索层层反转，冷硬文风。或：轻松日常，吐槽流，快节奏爽感。"
                  className="border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 flex w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm min-h-[72px] resize-y"
                  disabled={loading}
                />
                <div className="text-xs text-muted-foreground mt-1">
                  Director、剧情设计师、角色演员、Writer 和评审都会按这个风格来创作与判断。
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* 项目列表 */}
      <Card>
        <CardHeader>
          <CardTitle>已有项目</CardTitle>
          <CardDescription>选择一个项目继续演绎，或删除重新开始</CardDescription>
        </CardHeader>
        <CardContent>
          {projects.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              还没有项目，创建一个开始吧
            </div>
          ) : (
            <ScrollArea className="max-h-[500px]">
              <div className="space-y-2">
                {projects.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between p-4 rounded-md border hover:bg-accent/50 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{p.name}</div>
                      <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
                        <Badge variant="outline">
                          {p.template === 'online-game' ? '网游升级' : p.template}
                        </Badge>
                        <span>第 {p.currentTurn} 轮</span>
                        <span>·</span>
                        <span>{p._count.characters} 角色</span>
                        <span>·</span>
                        <span>{p._count.events} 事件</span>
                        <span>·</span>
                        <span>{p._count.chapters} 有效章</span>
                        {(p._count.chapterDrafts ?? p._count.chapters) > p._count.chapters && (
                          <>
                            <span>·</span>
                            <span>{p._count.chapterDrafts} 历史稿</span>
                          </>
                        )}
                        <span>·</span>
                        <span>Director {p.directorLvl}/5</span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="default" onClick={() => onEnter(p.id, p.name)}>
                        进入 <ArrowRight className="h-3 w-3 ml-1" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => deleteProject(p.id)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
