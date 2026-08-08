import { chat, extractJSON, isLLMConfigurationError } from '../llm';
import type {
  ChapterSummary,
  NovelCraftLesson,
  NovelEvent,
  ReaderReview,
  WorldState,
} from '../types';
import { CHAPTER_WORD_TARGET_MAX, CHAPTER_WORD_TARGET_MIN, formatChapterWordTarget } from '../chapter-policy';
import { countReadableChars } from '../chapter-text';

interface CraftLessonDraft {
  summary?: string;
  principles?: string[];
  directorAdjustments?: string[];
  writerGuidelines?: string[];
  settingGuardrails?: string[];
}

function toStringArray(value: unknown, limit = 6): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, limit);
}

function reviewText(review: ReaderReview): string {
  return [
    `【${review.readerName}｜严重度 ${review.severity}/5｜${review.focus}】`,
    review.summary,
    review.problems.length ? `问题：${review.problems.join('；')}` : '',
    review.suggestions.length ? `建议：${review.suggestions.join('；')}` : '',
    review.exposedQuestions.length ? `待导演判断：${review.exposedQuestions.join('；')}` : '',
  ].filter(Boolean).join('\n');
}

function fallbackLesson(
  worldState: WorldState,
  chapter: ChapterSummary,
  reviews: ReaderReview[]
): NovelCraftLesson {
  const severeReviews = reviews.filter((review) => review.severity >= 4);
  const allProblems = reviews.flatMap((review) => review.problems).slice(0, 6);
  const allSuggestions = reviews.flatMap((review) => review.suggestions).slice(0, 6);
  const maxSeverity = reviews.reduce((max, review) => Math.max(max, review.severity), 3);
  const targetWordLabel = formatChapterWordTarget(
    worldState.currentChapter?.targetWordMin ?? CHAPTER_WORD_TARGET_MIN,
    worldState.currentChapter?.targetWordMax ?? CHAPTER_WORD_TARGET_MAX
  );

  return {
    id: `lesson-${chapter.id}`,
    chapterNo: worldState.currentChapter?.chapterNo ?? 1,
    sourceChapterId: chapter.id,
    sourceSceneName: chapter.sceneName,
    severity: maxSeverity,
    summary: severeReviews.length
      ? `本段需要回炉校准：${severeReviews.map((review) => review.summary).join('；')}`
      : `本段评审指出了 ${reviews.length} 类可改进问题，需要下一轮设计吸收。`,
  principles: [
      '【结构体系】同一轮事件要形成因果链，不要让角色各自独立行动。',
      '【节奏体系】每段正文必须有一个可见变化：误判升级、选择压力、关系变化或章末钩子。',
      ...allProblems.slice(0, 3),
    ].filter(Boolean),
    directorAdjustments: [
      '下一轮只给一个核心刺激，选 1-2 个最相关角色接力行动。',
      '把读者指出的问题转成场内压力，不要让演员知道评审存在。',
      ...allSuggestions.slice(0, 3),
    ].filter(Boolean),
    writerGuidelines: [
      '【文笔体系】正文按刺激、反应、反制、结果写成连续场面。',
      '【读者体验】减少系统说明和群众惊呼，把篇幅给角色选择和后果。',
      `【篇幅体系】每章正文控制在 ${targetWordLabel}，短了补场面，长了删解释。`,
    ],
    settingGuardrails: [
      '【设定体系】能力、资源、线索、关系、身份、等级或称号只在事件日志真实发生后才能写入。',
      '【信息权限】角色只能知道现场公开信息和自身可感知信息。',
    ],
    createdAt: new Date().toISOString(),
  };
}

export function buildDirectorDirectiveFromLesson(lesson: NovelCraftLesson): string {
  return `【读者评审回流｜章节自动模式】
来源：第 ${lesson.chapterNo} 章片段《${lesson.sourceSceneName}》
严重度：${lesson.severity}/5

评审归纳：
${lesson.summary}

下一轮 Director 校准：
${lesson.directorAdjustments.map((item, index) => `${index + 1}. ${item}`).join('\n')}

写作执行原则：
${lesson.writerGuidelines.map((item, index) => `${index + 1}. ${item}`).join('\n')}

设定护栏：
${lesson.settingGuardrails.map((item, index) => `${index + 1}. ${item}`).join('\n')}

演员不可感知“评审/作者/正文问题”。请把这些改进转化为场内压力、角色可感知事实和下一轮行动边界。`;
}

export async function summarizeCraftLesson({
  worldState,
  chapter,
  reviews,
  events,
  previousLessons,
}: {
  worldState: WorldState;
  chapter: ChapterSummary;
  reviews: ReaderReview[];
  events: NovelEvent[];
  previousLessons?: NovelCraftLesson[];
}): Promise<NovelCraftLesson> {
  if (reviews.length === 0) {
    return fallbackLesson(worldState, chapter, reviews);
  }

  const maxSeverity = reviews.reduce((max, review) => Math.max(max, review.severity), 1);
  const targetWordLabel = formatChapterWordTarget(
    worldState.currentChapter?.targetWordMin ?? CHAPTER_WORD_TARGET_MIN,
    worldState.currentChapter?.targetWordMax ?? CHAPTER_WORD_TARGET_MAX
  );
  const systemPrompt = `你是 NovelStudio 的小说体系复盘编辑。

你的任务不是再评审一遍，而是把读者评审沉淀为“下一轮可执行的创作经验”。
经验必须覆盖或选择性归入这些小说体系维度：
- 文笔体系：句子、画面、情绪落点、段落密度。
- 节奏体系：推进、钩子、爽点、拖沓控制。
- 角色体系：动机、关系、行动承接、角色声音。
- 设定体系：信息权限、规则边界、状态变化依据。
- 网游体系：等级、技能、装备、掉落、任务奖励、数值展示。
- 篇幅体系：每章正文是否控制在 ${targetWordLabel}，是否因为过短而仓促或因为过长而注水。

必须输出 JSON，不要 markdown：
{
  "summary": "一句总经验，说明这段暴露的核心问题",
  "principles": ["可复用小说原则"],
  "directorAdjustments": ["下一轮导演设计/调度要怎么改"],
  "writerGuidelines": ["写手落正文时要怎么改"],
  "settingGuardrails": ["设定、角色信息权限、装备技能状态要守住什么"]
}`;

  const userPrompt = `# 当前章
第 ${worldState.currentChapter?.chapterNo ?? 1} 章：${worldState.currentChapter?.title ?? worldState.sceneName}
目标：${worldState.currentChapter?.goal ?? worldState.sceneDescription}

# 本段片段
${chapter.sceneName}，${countReadableChars(chapter.content)} 字

# 本段事件摘要
${events.slice(-12).map((event) => `T${event.turn} ${event.agentName}: ${event.content}`).join('\n')}

# 读者评审
${reviews.map(reviewText).join('\n\n')}

${previousLessons?.length ? `# 已有经验，避免重复
${previousLessons.slice(-5).map((lesson) => `- ${lesson.summary}`).join('\n')}` : ''}

# 任务
沉淀为下一轮“设计 -> 演绎 -> 正文”的经验总结。要具体，不要空泛。`;

  try {
    const raw = await chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0.55, maxTokens: 1200 }
    );
    const parsed = extractJSON<CraftLessonDraft>(raw);
    const fallback = fallbackLesson(worldState, chapter, reviews);
    return {
      ...fallback,
      summary: String(parsed?.summary ?? fallback.summary).trim() || fallback.summary,
      principles: toStringArray(parsed?.principles, 8).length
        ? toStringArray(parsed?.principles, 8)
        : fallback.principles,
      directorAdjustments: toStringArray(parsed?.directorAdjustments, 8).length
        ? toStringArray(parsed?.directorAdjustments, 8)
        : fallback.directorAdjustments,
      writerGuidelines: toStringArray(parsed?.writerGuidelines, 8).length
        ? toStringArray(parsed?.writerGuidelines, 8)
        : fallback.writerGuidelines,
      settingGuardrails: toStringArray(parsed?.settingGuardrails, 8).length
        ? toStringArray(parsed?.settingGuardrails, 8)
        : fallback.settingGuardrails,
    };
  } catch (err) {
    if (isLLMConfigurationError(err)) throw err;
    return fallbackLesson(worldState, chapter, reviews);
  }
}
