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

import { chatStream, toLLMUserMessage, type ChatMessage } from '../llm';
import {
  CHAPTER_WORD_TARGET_MAX,
  CHAPTER_WORD_TARGET_MIN,
  formatChapterWordTarget,
} from '../chapter-policy';
import { countReadableChars } from '../chapter-text';
import { renderCharacterFactsForPrompt, renderStoryDesignForPrompt } from '../chapter-guardrails';
import { renderChapterBridgeForPrompt, type ChapterBridgeContext } from '../chapter-continuity';
import type {
  Character,
  ChapterFocus,
  NovelCraftLesson,
  NovelEvent,
  StoryDesign,
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
  craftLessons?: NovelCraftLesson[];
  currentChapter?: ChapterFocus;
  storyDesign?: StoryDesign;
  previousChapterBridge?: ChapterBridgeContext | null;
  writerHint?: string;
  writerCustomBrief?: string;
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
  const chapterNo = ctx.currentChapter?.chapterNo ?? 1;
  const previousChapterBridge = renderChapterBridgeForPrompt(ctx.previousChapterBridge);
  const targetWordMin = ctx.currentChapter?.targetWordMin ?? CHAPTER_WORD_TARGET_MIN;
  const targetWordMax = ctx.currentChapter?.targetWordMax ?? CHAPTER_WORD_TARGET_MAX;
  const targetWordLabel = formatChapterWordTarget(targetWordMin, targetWordMax);

  const systemPrompt = `你是 NovelStudio 的 Writer Agent，负责把事件日志演绎为小说文本。

# 风格模板：${ctx.template.name}
${ctx.template.description}

# 文字风格指南
${ctx.template.writerStyleGuide}

# 叙事引擎任务
你接收的是导演和角色共同演绎出来的一场戏。你的任务不是逐条翻译日志，而是把角色的动作、对话、微反应和因果接力转成正式小说正文。
- 角色说过的话可以保留，但要放进自然场面里。
- 角色没明说但动作已经体现的情绪，用动作、物象、停顿和环境反应写出来。
- 战斗和危机场景优先写“发生了什么变化”，不要堆说明书。
- 情感高潮处允许留白，少用解释性总结。
- 禁止套话式描写，尤其避免“眼中闪过寒光”“气势陡然暴涨”“全场震惊”这类空句。
${ctx.writerHint ? `\n# 项目写作提示\n${ctx.writerHint}` : ''}
${ctx.writerCustomBrief ? `\n# Writer 补充\n${ctx.writerCustomBrief}` : ''}

# 当前场景
${ctx.worldSceneName}
${ctx.worldSceneDescription}

${chapterNo > 1 ? previousChapterBridge : '# 上一章正稿接续锚点：当前是第一章，无需章际接续。'}

# 当前章方向（硬约束，必须优先于旧稿和普通事件日志）
第 ${chapterNo} 章《${ctx.currentChapter?.title ?? '未命名章节'}》
目标：${ctx.currentChapter?.goal ?? '-'}
范围：${ctx.currentChapter?.scope ?? '-'}
节拍：
${ctx.currentChapter?.beats?.map((beat, index) => `${index + 1}. ${beat}`).join('\n') || '- 无'}
护栏：
${ctx.currentChapter?.constraints?.map((item) => `- ${item}`).join('\n') || '- 无'}

# 篇幅约束（硬约束，超出会被打回重写）
- 本次 Writer 输出视为一章正文，目标篇幅：${targetWordLabel}。
- 少于 ${targetWordMin} 可读字不要急着收尾；用动作、环境、对话、心理反应和余波把已发生事件写完整。
- 不得超过 ${targetWordMax} 可读字：超出的部分必须靠删减设定解释、群众惊呼、重复心理和拖慢节奏的铺陈来压缩，而不是靠扩写；宁可删到 ${targetWordLabel}，也不要输出超长稿。
- 系统统计“可读字数”时会排除空格、换行和标点，但正文必须保留正常中文标点，不要写成无标点长段。
- 为补足篇幅只能深化事件日志中已经发生的事，不能新增后续大节点、未来技能、未来装备或提前觉醒结果。

# 人物基础设定库（硬约束，不能被旧稿、事件日志或模型惯性覆盖）
${renderCharacterFactsForPrompt(ctx.characters)}

# 当前剧情设计师/导演设计（高优先级，正文必须落实其中的本章拍点、点名角色和设定护栏）
${renderStoryDesignForPrompt(ctx.storyDesign)}

${styleAnchor ? `# 风格锚点（最近文本，请保持风格连贯）
"""
${styleAnchor}
"""` : '# 风格锚点：这是开头，请奠定整体基调'}

${ctx.craftLessons?.length ? `# 已沉淀的写作经验（本段必须吸收）
${ctx.craftLessons.slice(-6).map((lesson, index) => {
  const rules = [
    lesson.summary,
    ...lesson.writerGuidelines.slice(0, 3),
    ...lesson.settingGuardrails.slice(0, 2),
  ].filter(Boolean);
  return `${index + 1}. ${rules.join('；')}`;
}).join('\n')}` : ''}

# 你的写作原则
1. **演绎而非总结**：不要写"接下来发生了一场战斗"，要写出战斗本身——动作、对话、心理
2. **事件 → 因果链 → 文本**：先找出每个 Turn 的核心刺激和角色接力，再写成连续场面。可以重新组织句序、合并同类动作、补充过渡，但不能改变事件本身
3. **角色声音**：对话要符合角色性格。主角话少，反派油滑，治疗细心
4. **节奏控制**：高潮段落（战斗、PK）短句密集；缓冲段落可以放慢
5. **网游元素**：技能名用「」括起，装备/属性可以稍作描写但不要堆砌数字
6. **不写"未发生"的事**：只演绎事件日志中的内容，不要预测或推进未发生的事件
7. **段落分明**：每段 2-5 句，对话独立成段
8. **中文输出**：避免翻译腔，不要在段尾加英文标点
9. **修复机械感**：不要按日志逐条翻译成“甲做了、乙做了、丙做了”。同一 Turn 内必须写出前后承接：谁造成了变化，谁看见并回应，回应又怎样改变现场
10. **章节篇幅**：正文最终落在 ${targetWordLabel}；宁可压缩解释，也要保留连续场面和章末钩子
11. **章际接续**：第 2 章及以后，开头必须先接住上一章正稿结尾。上一章没有写到的战斗、地点、怪物、组织流程，不能在本章第一句直接当成已经发生；需要先补过渡段。
12. **不硬切镜头**：如果事件日志已经跳到战斗中段，你可以在不改变事件结果的前提下，先写“上一章余波 -> 场景变化 -> 危机逼近 -> 被迫行动”的桥，再进入事件日志。
13. **成长反馈闭环**：如果当前章方向、导演设计或事件日志要求击杀后有经验/等级/掉落/奖励反馈，必须贴近有效贡献者写出短促、可结算的文本锚点，例如“苏见山眼前一闪：【经验 +20】”；不要写成长篇教学面板，也不要让无贡献者群体凭空涨经验。

# 番茄流强钩子写法（面向免费网文读者，目标是让人放不下手机）
14. **开篇三句给钩子**：每一章开头 2-3 句内，必须抛出一个具体、可感知的悬念或异常——一个不对的画面、一声不该出现的响动、一个身份的违和、一件解释不清的东西。不要用"这一天很平常"式的起手。
15. **画面要能"看见"**：环境、物品、能力要有质感——光影、温度、重量、气味、声音、压迫感。把"操场很乱"写成"广播台的喇叭电流断了半截，汗味混着铁锈味糊在所有人鼻腔里"；把"觉醒"写出身体的实感：骨骼、血液、光从皮肤底下渗出来。设定可以华丽，但必须附着在具体感官上，不能只报名词。
16. **悬念留白，不解释完**：一个异常出现后，先给读者"它不对劲"的震撼，不要立刻解释来源和原理。让读者自己脑补、猜测、往下读。作者侧设定的完整真相留在后文，这一章只露出冰山一角。
17. **每段结束留小钩子**：段落之间用"停顿、转折、逼近"制造"再读一段"的惯性；章节末尾必须是一个悬而未决的强钩子（危险逼近、身份疑云、奖励待揭晓、关系撕裂），不能收在平淡处。
18. **放大"颅内高潮"的瞬间**：觉醒、判定、首杀、掉落、秘密浮现这些节点，要写出"全世界为之一静 / 只有他知道 / 别人看不懂的恐怖与爽点"的对撞。主角的异常越是不被理解，越要写出那种"只有读者懂"的张力。
19. **语言节奏**：短句破节奏，长句蓄势；情绪节点不要用"震惊"“震撼”这类标签词，用具体反应（血液冲上头顶、后背发凉、瞳孔缩了一下）来传递。

# 输出
直接开始写小说正文，不要加标题、不要加"以下是文本"之类的元说明。`;

  const userPrompt = `# 本段事件日志（按时间顺序）

${renderEventsAsScript(ctx.events, ctx.characters)}

# 任务
请把以上事件演绎为小说文本。要求：
- 每个事件都要在文本中体现
- 第 ${chapterNo} 章开头必须和上一章正稿结尾连贯；如果上一章结尾还停在某个冲击、选择、关系变化或场景余波，就先写余波和场景变化，再进入新行动或新危机
- 同一 Turn 的事件要写成一条连续动作链，不要像多人各自独立行动
- 角色对话要符合各自说话风格
- 场景细节、动作描写、心理活动要饱满，画面要有质感（光影、温度、气味、压迫感），设定和意象可以华丽，让读者能展开想象
- 开篇 2-3 句抛出一个具体悬念或异常；关键节点（觉醒/判定/异常逼近）要写出震撼感和"只有读者懂"的张力
- 正文可读字数必须落在 ${targetWordLabel} 之间，这是硬约束；宁可压缩解释也要控制在范围内，超过 ${targetWordMax} 会被直接打回重写；正常使用中文标点，不要为了计数删标点
- 段落分明，节奏有张有弛，每段尽量留一个小钩子，章末必须是悬而未决的强钩子
- 不要解释完所有异常，留白让读者脑补
- 直接开始正文，不要加任何元说明`;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  try {
    return await chatStream(messages, onChunk, {
      temperature: 0.88,
      maxTokens: 3000,
    });
  } catch (err) {
    throw new Error(toLLMUserMessage(err));
  }
}

/**
 * 保存生成的章节到数据库
 */
export async function saveChapter(
  wm: WorldManager,
  sceneName: string,
  content: string,
  startTurn: number,
  endTurn: number,
  chapterId?: string,
  chapterMeta?: { chapterNo?: number; chapterTitle?: string }
): Promise<string> {
  const chapter = await db.chapter.create({
    data: {
      ...(chapterId ? { id: chapterId } : {}),
      projectId: wm.projectId,
      chapterNo: chapterMeta?.chapterNo,
      chapterTitle: chapterMeta?.chapterTitle,
      sceneName,
      content,
      wordCount: countReadableChars(content),
      startTurn,
      endTurn,
    },
  });
  return chapter.id;
}

// 导入 db
import { db } from '../../db';
