/**
 * Reader Agents
 *
 * Writer 完成后触发的读者评审层。它只暴露问题和改写方向，
 * 不直接改正文，也不自动回写 world state。
 */

import { chat, extractJSON, toLLMUserMessage, type ChatMessage } from '../llm';
import type { Character, ChapterFocus, NovelEvent, ReaderReview } from '../types';
import type { WorldManager } from '../world-state';
import { rowToReaderReview } from '../world-state';
import { db } from '../../db';
import {
  CHAPTER_WORD_TARGET_MAX,
  CHAPTER_WORD_TARGET_MIN,
  formatChapterWordTarget,
} from '../chapter-policy';

interface ReaderPersona {
  id: string;
  name: string;
  focus: string;
  brief: string;
}

interface ReaderReviewDraft {
  readerId?: string;
  readerName?: string;
  focus?: string;
  severity?: number;
  summary?: string;
  praise?: string;
  problems?: string[];
  suggestions?: string[];
  exposedQuestions?: string[];
}

export interface ReaderReviewContext {
  chapterId: string;
  sceneName: string;
  sceneDescription: string;
  chapterText: string;
  events: NovelEvent[];
  characters: Character[];
  previousText?: string;
  currentChapter?: ChapterFocus;
}

const READER_PERSONAS: ReaderPersona[] = [
  {
    id: 'venom-style',
    name: '毒舌文笔党',
    focus: '文笔、画面、句子质感、情绪落点',
    brief: '嘴很毒，但要具体。抓空话、套话、尬燃、翻译腔、段落水分和没有画面的描写。',
  },
  {
    id: 'pacing-hook',
    name: '节奏催更党',
    focus: '推进、爽点、钩子、读者继续读的动力、剧情衔接突兀感',
    brief: '像番茄老读者一样挑刺。判断这一段有没有拖、有没有爽点、有没有章节钩子。',
  },
  {
    id: 'detail-auditor',
    name: '细节设定控',
    focus: '设定一致性、角色动机、信息权限、状态变化、因果链铺垫',
    brief: '对设定漏洞零容忍。检查角色知不知道该信息、能力是否越界、状态变化是否有依据。',
  },
];

function clipText(text: string, head = 2600, tail = 2600): string {
  if (text.length <= head + tail + 200) return text;
  return `${text.slice(0, head)}\n\n[中段省略 ${text.length - head - tail} 字]\n\n${text.slice(-tail)}`;
}

function renderEvents(events: NovelEvent[]): string {
  return events
    .map((event) => {
      const target = event.target ? ` -> ${event.target}` : '';
      const emotion = event.emotion ? ` [${event.emotion}]` : '';
      return `T${event.turn} ${event.agentName}/${event.type}${emotion}${target}: ${event.content}`;
    })
    .join('\n');
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 6);
}

function normalizeDraft(
  draft: ReaderReviewDraft,
  persona: ReaderPersona
): Required<ReaderReviewDraft> {
  const severity = Number(draft.severity);
  return {
    readerId: persona.id,
    readerName: persona.name,
    focus: persona.focus,
    severity: Number.isFinite(severity) ? Math.max(1, Math.min(5, Math.round(severity))) : 3,
    summary: String(draft.summary ?? '').trim(),
    praise: String(draft.praise ?? '').trim(),
    problems: toStringArray(draft.problems),
    suggestions: toStringArray(draft.suggestions),
    exposedQuestions: toStringArray(draft.exposedQuestions),
  };
}

function isUsableDraft(draft: Required<ReaderReviewDraft>): boolean {
  return (
    draft.summary.length >= 6 &&
    (draft.problems.length > 0 || draft.suggestions.length > 0)
  );
}

function reviewSchema(persona: ReaderPersona): string {
  return `{
  "readerId": "${persona.id}",
  "readerName": "${persona.name}",
  "focus": "${persona.focus}",
  "severity": 1-5,
  "summary": "一句具体总评",
  "praise": "最多一句，没有就留空",
  "problems": ["具体问题"],
  "suggestions": ["可执行建议"],
  "exposedQuestions": ["需要导演决定的问题"]
}`;
}

async function repairMissingReview(
  persona: ReaderPersona,
  baseUserPrompt: string
): Promise<Required<ReaderReviewDraft>> {
  const baseMessages: ChatMessage[] = [
    {
      role: 'system',
      content: `你是 NovelStudio 的单人读者评审：${persona.name}。
${persona.focus}。${persona.brief}
只评审，不写正文。必须指出文本中的具体问题和可执行修法。
只输出 JSON，不要 markdown，不要说明过程，不要复述正文，不要写分析总结。
直接输出单个 JSON 对象：第一个非空白字符必须是左花括号，最后一个非空白字符必须是右花括号，中间不出现任何 JSON 之外的文字。
${reviewSchema(persona)}`,
    },
    {
      role: 'user',
      content: `${baseUserPrompt}\n\n# 补评任务\n评审团漏掉了你，请只补一条评审。`,
    },
  ];

  let previousRaw = '';
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const messages = [...baseMessages];
      if (attempt > 1) {
        messages.push({
          role: 'user',
          content: `上次输出无法解析或内容为空：${previousRaw.slice(0, 1200)}\n\n重新输出：直接给单个 JSON 对象（第一个字符是 {，最后一个字符是 }），包含 summary 和至少一条 problems/suggestions。不要任何分析或说明。`,
        });
      }
      previousRaw = await chat(messages, { temperature: attempt === 1 ? 0.62 : 0.3, maxTokens: 4200 });
      const repaired = normalizeDraft(extractJSON<ReaderReviewDraft>(previousRaw) ?? {}, persona);
      if (isUsableDraft(repaired)) return repaired;
      lastError = new Error(`${persona.name} 补评内容为空`);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(toLLMUserMessage(lastError ?? new Error(`${persona.name} 补评失败`)));
}

async function persistReaderReview(
  wm: WorldManager,
  chapterId: string,
  draft: Required<ReaderReviewDraft>
): Promise<ReaderReview> {
  const row = await db.readerReview.create({
    data: {
      projectId: wm.projectId,
      chapterId,
      readerId: draft.readerId,
      readerName: draft.readerName,
      focus: draft.focus,
      severity: draft.severity,
      summary: draft.summary,
      praise: draft.praise,
      problems: JSON.stringify(draft.problems),
      suggestions: JSON.stringify(draft.suggestions),
      exposedQuestions: JSON.stringify(draft.exposedQuestions),
    },
  });
  return rowToReaderReview(row);
}

export async function runReaderReviews(
  wm: WorldManager,
  ctx: ReaderReviewContext
): Promise<ReaderReview[]> {
  const targetWordMin = ctx.currentChapter?.targetWordMin ?? CHAPTER_WORD_TARGET_MIN;
  const targetWordMax = ctx.currentChapter?.targetWordMax ?? CHAPTER_WORD_TARGET_MAX;
  const targetWordLabel = formatChapterWordTarget(targetWordMin, targetWordMax);
  const systemPrompt = `你是 NovelStudio 的读者评审团。只挑问题，不写正文。

必须同时检查：
1. 文笔是否有画面，是否有套话、解释腔和没有情绪落点的句子。
2. 剧情是否推进，章末是否有具体钩子。
3. 因果是否连续：不能从初次接触直接跳到成熟流程、奖励结算或关系定论。
4. 空间和动作是否连续：不许替正文脑补移动、让路、阻拦和跟随。
5. 信息权限是否越界：角色不能提前知道规则、能力、奖励、关系或幕后真相。
6. 当前正文目标是 ${targetWordLabel}，字数不足要判断是否收束过早，超出要判断是否注水。
7. 如果有上一章锚点，必须检查时间、地点、公开信息和情绪余波是否接上。

评审人格：
${READER_PERSONAS.map((persona) => `- ${persona.name}：${persona.focus}。${persona.brief}`).join('\n')}

 只输出 JSON，不要 markdown，不要说明思考过程。reviews 必须同时包含三个 readerId：venom-style、pacing-hook、detail-auditor。

输出纪律（违反任何一条都会判定为不合格）：
1. 禁止思考过程、禁止复述正文、禁止写分析总结。
2. 直接输出单个 JSON 对象，reviews 数组必须完整包含三个读者，缺一不可。
3. 第一个非空白字符必须是左花括号，最后一个非空白字符必须是右花括号，中间不出现任何 JSON 之外的文字。
4. 不要输出第二个 JSON，不要用 \`\`\`json 代码块包裹。
{
  "reviews": [${reviewSchema(READER_PERSONAS[0])}]
}`;

  const userPrompt = `# 场景
${ctx.sceneName}
${ctx.sceneDescription}

# 在场角色
${ctx.characters.map((character) => `- ${character.name}: ${character.persona.stance}; ${character.persona.personality.join('、')}`).join('\n')}

# 演绎事件
${renderEvents(ctx.events)}

${ctx.previousText ? `# 上一章/前文正稿锚点\n${clipText(ctx.previousText, 1400, 1800)}\n` : ''}
# 写手正文
当前正文长度：${ctx.chapterText.length} 字；目标：${targetWordLabel}
${clipText(ctx.chapterText)}

# 任务
让三个读者分别给出具体、可执行的评审。暴露的问题只进入待审，不得自动当作正史设定。`;

  const baseMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  let drafts: ReaderReviewDraft[] | undefined;
  let previousRaw = '';
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const messages = [...baseMessages];
      if (attempt > 1) {
        messages.push({
          role: 'user',
          content: `上次输出没有被解析为三人评审 JSON，很可能是你先写了一段分析、或 reviews 数组不完整。
重新回答，这次必须直接输出单个 JSON 对象：第一个非空白字符必须是左花括号，最后一个非空白字符必须是右花括号。
reviews 数组必须同时完整包含三个 readerId：venom-style、pacing-hook、detail-auditor，且每个都要有 summary 和至少一条 problems。
不要输出任何分析、说明、Markdown 或第二个 JSON。`,
        });
      }
      previousRaw = await chat(messages, { temperature: attempt === 1 ? 0.62 : 0.3, maxTokens: 7000 });
      const parsed = extractJSON<{ reviews?: ReaderReviewDraft[] }>(previousRaw);
      if (parsed?.reviews?.length) {
        drafts = parsed.reviews;
        break;
      }
      lastError = new Error('Reader 评审解析失败');
    } catch (error) {
      lastError = error;
    }
  }

  if (!drafts?.length) {
    throw new Error(toLLMUserMessage(lastError ?? new Error('Reader 评审解析失败')));
  }

  const normalized: Required<ReaderReviewDraft>[] = [];
  for (const persona of READER_PERSONAS) {
    const source = drafts.find((draft) => draft.readerId === persona.id) ?? {};
    const draft = normalizeDraft(source, persona);
    normalized.push(isUsableDraft(draft) ? draft : await repairMissingReview(persona, userPrompt));
  }

  if (normalized.length !== READER_PERSONAS.length || normalized.some((draft) => !isUsableDraft(draft))) {
    throw new Error('Reader 未返回完整的三人评审');
  }

  const saved: ReaderReview[] = [];
  for (const draft of normalized) {
    saved.push(await persistReaderReview(wm, ctx.chapterId, draft));
  }
  return saved;
}
