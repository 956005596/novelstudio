'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BookOpen, Plus, Trash2, Play, ArrowRight, Sparkles, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { onlineGameTemplate } from '@/lib/novel/templates/online-game';

interface ProjectListItem {
  id: string;
  name: string;
  template: string;
  status: string;
  currentTurn: number;
  directorLvl: number;
  createdAt: string;
  _count: { characters: number; events: number; chapters: number };
}

const OUTLINE_EXAMPLES = [
  '退役剑士林墨回归新服，被旧仇人公会派来的卧底赵铁柱监视，副本里赵铁柱准备偷袭夺剑，被治疗苏晚识破。三人最终在 Boss 战前摊牌。',
  '豪门千金苏婉被未婚夫陆景琛退婚后，在闺蜜帮助下进入家族企业从基层做起，遇到表面冷淡实则护短的总裁助理沈墨，三人职场博弈中暗生情愫。',
  '商战：老牌车企德盛面临新能源转型，技术总监主张自研、CFO 主张收购初创公司，CEO 摇摆不定。三方在董事会上对决，最后揭露 CFO 与初创公司有利益输送。',
];

export function SetupPanel({ onEnter }: { onEnter: (projectId: string, projectName: string) => void }) {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [newName, setNewName] = useState('');
  const [loading, setLoading] = useState(false);

  // AI 生成模式
  const [outline, setOutline] = useState('');
  const [outlineName, setOutlineName] = useState('');
  const [generating, setGenerating] = useState(false);

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
        body: JSON.stringify({ name: newName.trim(), template: 'online-game' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '创建失败');
      toast.success(`项目「${newName.trim()}」已创建`);
      const createdName = newName.trim();
      setNewName('');
      await refresh();
      onEnter(data.id, createdName);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  // AI 大纲生成
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
    try {
      const res = await fetch('/api/projects/from-outline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outline: outline.trim(),
          name: outlineName.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'AI 解析失败');
      toast.success(
        `AI 已生成：${data.name}（${data.characterCount} 角色 / ${data.plotNodeCount} 剧情节点）`
      );
      setOutline('');
      setOutlineName('');
      await refresh();
      onEnter(data.id, data.name);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setGenerating(false);
    }
  };

  const deleteProject = async (id: string) => {
    if (!confirm('确定删除该项目及其所有数据？')) return;
    await fetch(`/api/projects/${id}`, { method: 'DELETE' });
    toast.success('已删除');
    refresh();
  };

  return (
    <div className="container mx-auto max-w-5xl py-8 px-4">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight mb-2 flex items-center gap-3">
          <BookOpen className="h-8 w-8 text-primary" />
          NovelStudio
          <span className="text-sm font-normal text-muted-foreground">AI 演绎叙事引擎</span>
        </h1>
        <p className="text-muted-foreground">
          多 Agent 自主演绎 · Director 调度冲突 · 实时生成小说文本 · 任意时刻干预校准
        </p>
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
                  故事大纲 <span className="text-muted-foreground">（一句话简介 / 多段剧情 / 章节列表都行）</span>
                </label>
                <Textarea
                  value={outline}
                  onChange={(e) => setOutline(e.target.value)}
                  placeholder="例如：退役剑士林墨回归新服，被旧仇人公会派来的卧底赵铁柱监视，副本里赵铁柱准备偷袭夺剑，被治疗苏晚识破…"
                  className="min-h-[140px] resize-y"
                  disabled={generating}
                />
                <div className="text-xs text-muted-foreground mt-1">
                  字数 {outline.length} · AI 会解析为：场景、角色（含性格/目标/关系）、剧情节点
                </div>
              </div>

              {/* 示例 */}
              {!outline && (
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

              <Button
                onClick={createFromOutline}
                disabled={generating || !outline.trim() || outline.trim().length < 10}
                className="w-full"
              >
                {generating ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" /> AI 解析中…（约 10-20 秒）
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4 mr-1" /> AI 生成世界并进入
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
                        <span>Turn {p.currentTurn}</span>
                        <span>·</span>
                        <span>{p._count.characters} 角色</span>
                        <span>·</span>
                        <span>{p._count.events} 事件</span>
                        <span>·</span>
                        <span>{p._count.chapters} 章</span>
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
