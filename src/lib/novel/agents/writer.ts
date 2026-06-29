/**
 * Writer Agent
 * 
 * 接收事件日志，生成小说文本。
 * 
 * 关键设计：
 *   1. Style Anchor：每次生成前读取最近 2000 字作为风格锚点
 *   2. 流式输出：通过 chatStream 实时推送 chunk
 *   3. 不总结剧情：只演绎事件，不解说"接下来发生了什么"
 *   4. 风格指南：来自 WorldTemplate.writerStyleGuide
 */

import { chatStream, type ChatMessage } from '../llm';
import type {
  Character,
  NovelEvent,
  WorldTemplate,
} from '../types';
import type { WorldManager } from '../world-state';

export interface WriterContext {
  template: WorldTemplate;
  worldSceneName: string;
  worldSceneDescription: string;
  characters: Character[];
  events: NovelEvent[];     // 本段要演绎的事件（按时间顺序）
  previousText?: string;    // 上一段已生成的文本（风格锚点）
  userRewrite?: string;     // 用户改写后的文本（如果有，作为新的风格锚点）
}

/**
 * 把事件列表渲染成 LLM 可读的剧本
 */
function renderEventsAsScript(events: NovelEvent[], characters: Character[]): string {
  const charMap = new Map(characters.map((c) => [c.name, c]));
  return events
    .map((e) => {
      if (e.type === 'scene_meta' || e.type === 'director') {
        return `【场景】${e.content}`;
      }
      const c = charMap.get(e.agentName);
      const emotionTag = e.emotion ? `（情绪：${e.emotion}）` : '';
      const targetTag = e.target ? ` → 目标：${e.target}` : '';
      const stance = c ? `\n  立场：${c.persona.stance}` : '';
      const speechStyle = c ? `\n  说话风格：${c.persona.speechStyle}` : '';
      const typeLabel =
        e.type === 'dialogue' ? '对话' : e.type === 'action' ? '行动' : '状态变化';
      return `[T${e.turn}] ${e.agentName} ${typeLabel}${emotionTag}${targetTag}\n  内容：${e.content}${stance}${speechStyle}`;
    })
    .join('\n\n');
}

/**
 * 流式生成小说文本
 * onChunk 接收增量文本，返回完整文本
 */
export async function writerStream(
  wm: WorldManager,
  ctx: WriterContext,
  onChunk: (delta: string) => void
): Promise<string> {
  const styleAnchor = (ctx.userRewrite ?? ctx.previousText ?? '').slice(-2000);

  const systemPrompt = `你是 NovelStudio 的 Writer Agent，负责把事件日志演绎为小说文本。

# 风格模板：${ctx.template.name}
${ctx.template.description}

# 文字风格指南
${ctx.template.writerStyleGuide}

# 当前场景
${ctx.worldSceneName}
${ctx.worldSceneDescription}

# 在场角色（用于保持角色声音一致）
${ctx.characters
  .map(
    (c) =>
      `## ${c.name}（${c.role}）
- 性格：${c.persona.personality.join('、')}
- 立场：${c.persona.stance}
- 说话风格：${c.persona.speechStyle}`
  )
  .join('\n\n')}

${styleAnchor ? `# 风格锚点（最近文本，请保持风格连贯）
"""
${styleAnchor}
"""` : '# 风格锚点：这是开头，请奠定整体基调'}

# 你的写作原则
1. **演绎而非总结**：不要写"接下来发生了一场战斗"，要写出战斗本身——动作、对话、心理
2. **事件 → 文本**：每个事件都要展开为具体的场景描写、对话、动作。可以重新组织顺序、补充细节，但不能改变事件本身
3. **角色声音**：对话要符合角色性格。主角话少，反派油滑，治疗细心
4. **节奏控制**：高潮段落（战斗、PK）短句密集；缓冲段落可以放慢
5. **网游元素**：技能名用「」括起，装备/属性可以稍作描写但不要堆砌数字
6. **不写"未发生"的事**：只演绎事件日志中的内容，不要预测或推进未发生的事件
7. **段落分明**：每段 2-5 句，对话独立成段
8. **中文输出**：避免翻译腔，不要在段尾加英文标点

# 输出
直接开始写小说正文，不要加标题、不要加"以下是文本"之类的元说明。`;

  const userPrompt = `# 本段事件日志（按时间顺序）

${renderEventsAsScript(ctx.events, ctx.characters)}

# 任务
请把以上事件演绎为小说文本。要求：
- 每个事件都要在文本中体现
- 角色对话要符合各自说话风格
- 场景细节、动作描写、心理活动要饱满
- 段落分明，节奏有张有弛
- 直接开始正文，不要加任何元说明`;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  return await chatStream(messages, onChunk, {
    temperature: 0.88,
    maxTokens: 2048,
  });
}

/**
 * 保存生成的章节到数据库
 */
export async function saveChapter(
  wm: WorldManager,
  sceneName: string,
  content: string,
  startTurn: number,
  endTurn: number
): Promise<string> {
  const chapter = await db.chapter.create({
    data: {
      projectId: wm.projectId,
      sceneName,
      content,
      wordCount: content.length,
      startTurn,
      endTurn,
    },
  });
  return chapter.id;
}

// 导入 db
import { db } from '../../db';
