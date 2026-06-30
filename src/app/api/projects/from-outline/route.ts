/**
 * POST /api/projects/from-outline
 * body: { outline: string, name?: string }
 *
 * 改用 SSE (Server-Sent Events) 流式返回进度：
 *   - 每个阶段 emit 一个 event:data 事件
 *   - 最后 emit event:done 带最终项目 ID
 *   - 出错 emit event:error
 *
 * 前端通过 EventSource 或 fetch + ReadableStream 接收。
 */

import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import {
  parseOutline,
  type ProgressEvent,
} from '@/lib/novel/agents/outline-parser';
import type { WorldState } from '@/lib/novel/types';

export const maxDuration = 180;
export const dynamic = 'force-dynamic';

function sseFormat(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const outline = body.outline?.trim();
  const customName = body.name?.trim();

  if (!outline) {
    return new Response(sseFormat('error', { error: '请输入大纲' }), {
      status: 400,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }
  if (outline.length < 10) {
    return new Response(
      sseFormat('error', { error: '大纲太短了，至少写 10 个字' }),
      {
        status: 400,
        headers: { 'Content-Type': 'text/event-stream' },
      }
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: any) => {
        controller.enqueue(encoder.encode(sseFormat(event, data)));
      };

      // 进度回调
      const onProgress = (event: ProgressEvent) => {
        send('progress', event);
      };

      send('progress', {
        stage: 'starting',
        message: '开始解析大纲…',
        progress: 1,
      });

      try {
        // === 阶段 1-5：解析大纲（带进度回调） ===
        const parsed = await parseOutline(outline, onProgress);

        // === 阶段 6：保存到数据库 ===
        send('progress', {
          stage: 'saving',
          message: '正在保存项目和角色到数据库…',
          progress: 99,
        });

        const name =
          customName ||
          parsed.worldState.sceneName ||
          outline.slice(0, 20) + (outline.length > 20 ? '…' : '');

        const project = await db.project.create({
          data: {
            name,
            template: parsed.templateKey,
            worldState: JSON.stringify(parsed.worldState),
            status: 'setup',
          },
        });

        const characterIds: string[] = [];
        for (const c of parsed.characters) {
          const row = await db.character.create({
            data: {
              projectId: project.id,
              name: c.name,
              role: c.role,
              persona: JSON.stringify(c.persona),
              currentState: JSON.stringify(c.currentState),
            },
          });
          characterIds.push(row.id);
        }

        const finalWorld: WorldState = {
          ...parsed.worldState,
          presentCharacterIds: characterIds,
        };
        await db.project.update({
          where: { id: project.id },
          data: { worldState: JSON.stringify(finalWorld) },
        });

        // === 完成 ===
        send('done', {
          id: project.id,
          name,
          template: parsed.templateKey,
          templateReason: parsed.templateReason,
          writerHint: parsed.writerHint,
          characterCount: characterIds.length,
          plotNodeCount: parsed.plotNodes.length,
          factionCount: parsed.worldState.worldLore?.factions?.length ?? 0,
        });
      } catch (err: any) {
        console.error('[from-outline] 解析失败:', err.message);
        let friendly = err.message;
        if (/429|Too many requests|rate limit/i.test(err.message)) {
          friendly = 'AI 服务当前繁忙（限流），请稍等 30 秒后重试';
        } else if (/fetch|ECONN|网络/i.test(err.message)) {
          friendly = 'AI 服务暂时不可用，请稍后重试';
        }
        send('error', { error: friendly, detail: err.message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
