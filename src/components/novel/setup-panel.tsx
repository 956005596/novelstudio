'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { BookOpen, Plus, Trash2, Play, ArrowRight } from 'lucide-react';
import { useNovelStore } from '@/store/novel-store';
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

export function SetupPanel({ onEnter }: { onEnter: (projectId: string, projectName: string) => void }) {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [newName, setNewName] = useState('');
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    const res = await fetch('/api/projects');
    const data = await res.json();
    setProjects(data.projects ?? []);
  };

  useEffect(() => {
    refresh();
  }, []);

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
      // 自动进入
      onEnter(data.id, createdName);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
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

      {/* 创建新项目 */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5" /> 新建演绎项目
          </CardTitle>
          <CardDescription>
            选择风格模板，创建一个新世界。当前可用模板：网游升级
          </CardDescription>
        </CardHeader>
        <CardContent>
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
                      <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                        <Badge variant="outline">网游升级</Badge>
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
