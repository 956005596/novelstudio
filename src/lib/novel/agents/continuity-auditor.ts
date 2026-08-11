import { chat, extractJSON, type ChatMessage } from '../llm';
import { chapterFocusText, ensureChapterFocus, resolveChapterStartTurn } from '../chapter-focus';
import { renderChapterBridgeForPrompt, type ChapterBridgeContext } from '../chapter-continuity';
import { storyBibleText } from '../story-bible';
import type { Character, NovelEvent, StoryDesign, WorldState } from '../types';

export interface ContinuityAuditResult {
  status: 'passed' | 'blocked';
  issues: string[];
  repairInstruction: string;
  checkedAt: string;
}

interface AuditDraft {
  status?: string;
  issues?: unknown;
  repairInstruction?: string;
}

const AUDIT_PROTOCOL_ATTEMPTS = 3;

function normalizeAuditStatus(value: unknown): 'passed' | 'blocked' | null {
  const text = String(value ?? '').trim().toLowerCase();
  if (['passed', 'pass', 'allowed', 'allow', '通过', '允许'].includes(text)) return 'passed';
  if (['blocked', 'block', 'rejected', 'reject', '阻止', '拦截', '不通过'].includes(text)) return 'blocked';
  return null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, 6)
    : [];
}

export async function auditStoryDesignContinuity(input: {
  worldState: WorldState;
  characters: Character[];
  recentEvents: NovelEvent[];
  design: StoryDesign;
  previousChapterBridge?: ChapterBridgeContext | null;
}): Promise<ContinuityAuditResult> {
  const focused = ensureChapterFocus(input.worldState);
  const chapter = focused.currentChapter;
  if (!chapter) throw new Error('设定审核无法执行：当前章节方向缺失');
  const chapterStartTurn = resolveChapterStartTurn(focused, chapter);
  const currentChapterEvents = input.recentEvents.filter((event) => event.turn > chapterStartTurn);
  const isFreshChapter = currentChapterEvents.length === 0 && focused.turn === chapterStartTurn;
  const characterStateText = isFreshChapter
    ? input.characters
        .map((character) => `- ${character.name}：核心立场=${character.persona.stance}；性格=${character.persona.personality.join('、')}；当前数值/技能/装备可能属于后续时点，不作为本章开场正典`)
        .join('\n')
    : input.characters
        .map((character) => `- ${character.name}：位置=${character.currentState.location}；情绪=${character.currentState.emotion}；等级=${character.currentState.level ?? '未记录'}；经验=${character.currentState.exp ?? '未记录'}；职业=${character.persona.profession ?? '未记录'}；技能=${(character.persona.skills ?? []).join('、') || '无'}；装备=${(character.persona.equipment ?? []).join('、') || '无'}；状态=${(character.currentState.buffs ?? []).join('、') || '无'}`)
        .join('\n');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `你是 NovelStudio 的独立设定审核 Agent。你不创作剧情，只判断一份导演设计能否进入角色演绎。

只有以下硬冲突可以 blocked：
1. 时间倒退、已经完成的事件被当成尚未发生，或上一章结尾无法接到本章开场。
2. 角色位置、伤势、持有物、能力、等级、关系或已知信息与正典/已发生事件直接冲突。
3. 当前章设计越过章节方向，提前兑现未来节点，或把用户尚未确认的设定当成事实。
	4. 设计要求角色知道作者侧秘密、未来剧情或自己不可能获得的信息。

时序裁定：当前章方向是演绎时间锚。若 World State 或人物档案明显停在当前章之后，不得因为导演设计服从当前章方向而 blocked；应检查设计有没有继续引用那些超前状态。只有设计本身使用了超前事实才阻断。
若当前章是第一章、最近事件为空，且导演设计严格从章节方向开始，即使旧 World State 写着后续灾变现场，也应返回 passed，不要先写分析说明。

不要因为方案普通、节奏偏好不同或缺少惊喜而阻断。输出 JSON：
{"status":"passed|blocked","issues":["硬冲突"],"repairInstruction":"给剧情设计师的一段可执行返工要求"}

输出纪律（违反任何一条都会判定为不合格）：
1. 禁止思考过程、禁止复述待审核设计、禁止复述已发生事件、禁止写分析总结。
2. 直接输出单个 JSON 对象。第一个非空白字符必须是左花括号，最后一个非空白字符必须是右花括号，中间不出现任何 JSON 之外的文字。
3. status 只能是 "passed" 或 "blocked"；blocked 时 issues 必须写出具体冲突事实、repairInstruction 必须给出可执行修法，不得只写“硬冲突”或“不符合设定”。
4. 不要输出第二个 JSON，不要用 \`\`\`json 代码块包裹。`,
    },
    {
      role: 'user',
      content: `# 当前章
${chapterFocusText(focused)}

# 项目正典
${storyBibleText(focused, { futureNodeLimit: 5 })}

# 上一章正稿
${renderChapterBridgeForPrompt(input.previousChapterBridge)}

# 最近已发生事件
${currentChapterEvents.slice(-12).map((event) => `[${event.id}] T${event.turn} ${event.agentName}/${event.type}: ${event.content}`).join('\n') || '暂无'}

# 当前人物状态
${characterStateText}

# 待审核导演设计
章节：第 ${input.design.chapterNo} 章《${input.design.chapterTitle}》
当前拍点：${input.design.currentBeat}
场景目的：${input.design.scenePurpose}
事件刺激：${input.design.eventSeeds.join('；')}
成长钩子：${input.design.progressionHooks.join('；')}
设定护栏：${input.design.settingGuardrails.join('；')}
导演备注：${input.design.directorNotes.join('；')}

先核对硬事实，再决定是否允许进入演绎。`,
    },
  ];

  let raw = '';
  for (let attempt = 0; attempt < AUDIT_PROTOCOL_ATTEMPTS; attempt++) {
    const attemptMessages: ChatMessage[] = attempt === 0
      ? messages
      : [
          ...messages,
          { role: 'assistant', content: raw.slice(0, 2200) },
          {
            role: 'user',
            content: '上一个回答未遵守审核协议。不要解释，只输出单个 JSON。status 只能是 passed 或 blocked；blocked 必须指出具体冲突事实和可执行修法，不能只写“硬冲突”或“不符合设定”。',
          },
        ];
    raw = await chat(attemptMessages, {
      temperature: attempt === 0 ? 0.1 : 0,
      maxTokens: 5200,
    });
    const parsed = extractJSON<AuditDraft>(raw);
    const issues = stringList(parsed?.issues);
    const repairInstruction = String(parsed?.repairInstruction ?? '').trim();
    const normalizedStatus = normalizeAuditStatus(parsed?.status);
    const hasSpecificBlockedReason =
      normalizedStatus !== 'blocked' ||
      (issues.some((issue) => issue.length >= 8 && !/^(硬冲突|不符合设定|有冲突|冲突)$/i.test(issue)) && repairInstruction.length >= 8);
    if (!parsed || !normalizedStatus || !hasSpecificBlockedReason) {
      console.warn(
        `[ContinuityAuditor] 第 ${attempt + 1} 次输出未通过协议校验：${raw.replace(/\s+/g, ' ').slice(0, 420)}`
      );
      continue;
    }

    return {
      status: normalizedStatus,
      issues,
      repairInstruction,
      checkedAt: new Date().toISOString(),
    };
  }

  throw new Error(`设定审核连续 ${AUDIT_PROTOCOL_ATTEMPTS} 次没有返回完整结论，演绎未启动`);
}
