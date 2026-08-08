/**
 * Character Agent
 * 
 * 每个角色是一个独立 Agent，持有自己的 persona + currentState，
 * 根据 World State 感知其他角色，做出符合自己人设的行为提案。
 * 
 * 核心原则：成为角色，而不是描写角色。
 *   - 用第一人称视角思考
 *   - 行为必须符合 persona.stance
 *   - 必须推进 persona.goals 中的至少一个
 */

import { chat, extractJSON, type ChatMessage } from '../llm';
import type {
  Character,
  CharacterState,
  NovelEvent,
  WorldState,
  WorldTemplate,
} from '../types';
import type { WorldManager } from '../world-state';
import type { CharacterProposal } from './director';
import { ensureChapterFocus, resolveChapterStartTurn } from '../chapter-focus';
import { actorPolicyText } from '../agent-policy';

const CHARACTER_PROTOCOL_ATTEMPTS = 3;
const CHARACTER_META_TEXT = /(?:我们(?:需要|根据|现在)|根据(?:现场简报|角色要求|设定)|生成.{0,12}(?:行动|对话)|作为(?:AI|角色Agent|模型)|角色(?:需要|应该|可以)|目标是|因此[，,:：]?\s*(?:行动|回答)|输出\s*JSON|提示词|LLM|Agent|分析如下|方案如下|现在是[“\"]刚刚发生的事)/i;

interface CharacterProposalDraft {
  type?: unknown;
  content?: unknown;
  target?: unknown;
  emotion?: unknown;
  rationale?: unknown;
  statePatch?: unknown;
}

interface CharacterActionAudit {
  status: 'passed' | 'blocked';
  issues: string[];
  repairInstruction: string;
}

function normalizeCharacterProposalDraft(
  parsed: CharacterProposalDraft | null,
  character: Character,
  recentEvents: NovelEvent[]
): CharacterProposal | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const type = String(parsed.type ?? '').trim();
  const content = String(parsed.content ?? '').replace(/\s+/g, ' ').trim();
  const rationale = String(parsed.rationale ?? '').replace(/\s+/g, ' ').trim();
  if (!['action', 'dialogue', 'state_change'].includes(type)) return null;
  if (content.length < 4 || content.length > 280 || CHARACTER_META_TEXT.test(content)) return null;
  if (!rationale || CHARACTER_META_TEXT.test(rationale)) return null;
  const normalizedContent = content.replace(/[\s\p{P}\p{S}]/gu, '');
  const repeatsRecentAction = recentEvents
    .filter((event) => event.agentId === character.id || event.agentName === character.name)
    .slice(-6)
    .some((event) => {
      const previous = String(event.content ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
      if (previous.length < 12 || normalizedContent.length < 12) return false;
      return normalizedContent === previous || normalizedContent.includes(previous) || previous.includes(normalizedContent);
    });
  if (repeatsRecentAction) return null;

  const rawStatePatch = parsed.statePatch;
  const statePatch = rawStatePatch && typeof rawStatePatch === 'object' && !Array.isArray(rawStatePatch)
    ? rawStatePatch as CharacterState
    : undefined;

  return {
    characterId: character.id,
    characterName: character.name,
    type: type as CharacterProposal['type'],
    content,
    target: typeof parsed.target === 'string' && parsed.target.trim() ? parsed.target.trim() : undefined,
    emotion: typeof parsed.emotion === 'string' && parsed.emotion.trim() ? parsed.emotion.trim() : undefined,
    statePatch,
    rationale,
  };
}

async function auditCharacterAction(input: {
  character: Character;
  worldState: WorldState;
  recentEvents: NovelEvent[];
  proposal: CharacterProposal;
}): Promise<CharacterActionAudit> {
  const chapter = input.worldState.currentChapter;
  if (CHARACTER_META_TEXT.test(input.proposal.content)) {
    return {
      status: 'blocked',
      issues: ['候选内容仍在解释设定或创作思路'],
      repairInstruction: '只写角色此刻实际说出或做出的一个动作',
    };
  }

  const chapterEvidence = [
    chapter?.goal,
    ...(chapter?.beats ?? []),
    ...(chapter?.constraints ?? []),
    input.worldState.storyDesign?.currentBeat,
    input.worldState.storyDesign?.scenePurpose,
    ...(input.worldState.storyDesign?.eventSeeds ?? []),
    ...input.recentEvents.map((event) => event.content),
  ].filter(Boolean).join('\n');
  const profileTerms = [
    ...(input.character.persona.skills ?? []),
    ...(input.character.persona.equipment ?? []),
    ...(input.character.persona.inventory ?? []),
    ...(input.character.persona.talents ?? []),
  ].map((item) => item.trim()).filter((item) => item.length >= 2);
  const unanchoredTerms = profileTerms.filter(
    (term) => input.proposal.content.includes(term) && !chapterEvidence.includes(term)
  );
  if (unanchoredTerms.length > 0) {
    return {
      status: 'blocked',
      issues: [`候选使用了本章和已发生事件未确认的能力或物品：${unanchoredTerms.join('、')}`],
      repairInstruction: '不使用这些能力或物品，只靠眼前可见条件重演',
    };
  }

  return { status: 'passed', issues: [], repairInstruction: '' };
}

function optionalPromptBlock(title: string, value?: string): string {
  const text = String(value ?? '').trim();
  return text ? `\n# ${title}\n${text}\n` : '';
}

function compactLine(value?: string, max = 120): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '未说明';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function sentence(value?: string, max = 120): string {
  const text = compactLine(value, max).replace(/[。.!！？；，、]+$/u, '');
  return text === '未说明' ? text : `${text}。`;
}

function compactList(items?: string[], limit = 3): string {
  const list = (items ?? []).map((item) => item.trim()).filter(Boolean);
  if (list.length === 0) return '无';
  const visible = list.slice(0, limit).join('；');
  return list.length > limit ? `${visible}；等 ${list.length} 项` : visible;
}

function isActionableRecentEvent(event: NovelEvent): boolean {
  const content = String(event.content ?? '').trim();
  if (!content) return false;
  if (content.startsWith('角色档案更新：')) return false;
  if (content.includes('档案更新')) return false;
  return true;
}

function buildChapterCue(worldState: WorldState): string {
  const chapter = worldState.currentChapter;
  if (!chapter) return '只围绕眼前场景做出自然反应，不要提前兑现后续大节点。';
  const beatLine = compactList(chapter.beats, 2);
  const guardrailLine = compactList(chapter.constraints, 2);
  return [
    `这一章现在主要在做：${compactLine(chapter.goal, 150)}`,
    `当前阶段：${compactLine(chapter.stage, 24)}。`,
    `这一章更想要的感觉：${beatLine}。`,
    `别越线：${guardrailLine}。`,
  ].join('\n');
}

function compactTraits(items?: string[], limit = 4): string {
  const list = (items ?? [])
    .map((item) => item.trim().replace(/[。.!！？；，、]+$/u, ''))
    .filter(Boolean);
  if (list.length === 0) return '未记录';
  return list.slice(0, limit).join('、');
}

function numberedLines(items?: string[], fallback: string[] = []): string {
  const list = (items?.length ? items : fallback)
    .map((item) => item.trim())
    .filter(Boolean);
  if (list.length === 0) return '1. 未记录';
  return list.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

function bulletLines(items?: string[], fallback: string[] = []): string {
  const list = (items?.length ? items : fallback)
    .map((item) => item.trim())
    .filter(Boolean);
  if (list.length === 0) return '- 未记录';
  return list.map((item) => `- ${item}`).join('\n');
}

function selectVisibleInnerConflict(value?: string): string {
  const text = String(value ?? '').trim();
  if (!text) return '未记录';
  return compactLine(text, 90);
}

function buildCharacterPulse(character: Character): string {
  const persona = character.persona;
  const motivations = compactTraits(persona.motivations, 3);
  const speechHabits = compactTraits(persona.speechHabits, 3);
  const appearance = sentence(persona.appearance, 80);
  const innerConflict = selectVisibleInnerConflict(persona.innerConflict);

  return [
    `这个人给人的第一感觉：${appearance}`,
    `真正会牵动他的东西：${motivations}。`,
    `嘴上和行动常带出来的习惯：${speechHabits}。`,
    `他心里现在拧着的那根线：${sentence(innerConflict, 90)}`,
  ].join('\n');
}

function buildCharacterReflex(character: Character): string {
  const persona = character.persona;
  const personality = compactTraits(persona.personality, 4);
  const stance = sentence(persona.stance, 80);
  return [
    `遇事时的自然反应更接近：${personality}。`,
    `他通常会站在这样的立场上做判断：${stance}`,
    '你可以偏心、迟疑、误判、嘴硬、逞强、试探、沉默，也可以临时改主意；不要总像在做最优解。',
  ].join('\n');
}

function buildRelationshipHooks(
  character: Character,
  allCharacters: Character[],
  presentIds: string[]
): string {
  const relations = character.currentState.relationships ?? {};
  const presentById = new Set(presentIds);
  const presentCharacters = allCharacters.filter((item) => item.id !== character.id && presentById.has(item.id));
  const ranked = presentCharacters
    .map((item) => {
      const relation = relations[item.name];
      return {
        name: item.name,
        value: relation?.value ?? 0,
        note: relation?.note ?? '陌生',
      };
    })
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 2);

  if (ranked.length === 0) {
    return '眼前还没有谁特别牵动你，你更多是被现场本身推着走。';
  }

  return ranked
    .map((item, index) =>
      index === 0
        ? `你最容易被 ${item.name} 牵动：关系 ${item.value}，因为“${item.note}”。`
        : `另一个会影响你判断的人是 ${item.name}：关系 ${item.value}，因为“${item.note}”。`
    )
    .join('\n');
}

function buildIdentityModule(character: Character): string {
  const persona = character.persona;
  const identityParts = [
    persona.identityNotes ? persona.identityNotes.trim() : '',
    !persona.identityNotes && persona.gender ? `性别：${persona.gender}` : '',
    !persona.identityNotes && persona.profession ? `身份/职业：${persona.profession}` : '',
    !persona.identityNotes ? `背景：${persona.background || '未记录'}` : '',
    !persona.identityNotes && persona.appearance ? `外在印象：${sentence(persona.appearance, 100)}` : '',
  ].filter(Boolean);

  return [
    `你现在是${character.name}。`,
    ...identityParts,
  ].join('\n');
}

function buildMindModule(character: Character): string {
  const persona = character.persona;
  if (persona.coreBeliefs?.length) {
    return numberedLines(persona.coreBeliefs);
  }
  const motivations = compactTraits(persona.motivations, 3);
  const innerConflict = sentence(selectVisibleInnerConflict(persona.innerConflict), 90);
  return [
    `核心信念：${sentence(persona.stance, 90)}`,
    `真正会牵动你的东西：${motivations}。`,
    `你心里当前最拧巴的地方：${innerConflict}`,
  ].join('\n');
}

function buildBehaviorModule(character: Character): string {
  const persona = character.persona;
  if (persona.behaviorRules?.length) {
    return numberedLines(persona.behaviorRules);
  }
  const goals = persona.goals.map((goal, index) => `${index + 1}. ${goal}`).join('\n') || '1. 先活过眼前这一轮';
  const reflex = buildCharacterReflex(character);
  return [
    '你怎么做：',
    reflex,
    '你眼下最容易被这些事驱动：',
    goals,
    '先接住现场，再给出这个人会做出的那一步，不要总追求最正确的解。',
  ].join('\n');
}

function buildSpeechModule(character: Character): string {
  const persona = character.persona;
  if (persona.speechRules?.length) {
    return bulletLines(persona.speechRules);
  }
  const habits = compactTraits(persona.speechHabits, 4);
  return [
    `总体说话方式：${sentence(persona.speechStyle, 100)}`,
    `常带出来的口头习惯：${habits}。`,
    '情绪越重，句子通常越短；少解释自己，多把话落到眼前的人和事上。',
  ].join('\n');
}

function buildBoundaryModule(character: Character): string {
  const actorNotes = String(character.persona.actorNotes ?? '').trim();
  const lines = [
    ...(character.persona.forbiddenRules ?? []),
    '未公开的秘密、伏笔、未来身份和远期设定，不能被你直接说破、承认或提前兑现。',
    '不能自己宣布经验到账、升级完成、新技能觉醒或掉落归属，这些只能来自已发生事件或系统/导演确认。',
    '只能使用人物档案中已有的装备、技能、天赋、随身物，或最近事件明确出现且此刻能够触及的环境物；不能凭空补出武器、道具、伤势、战果或旧经历。',
    '不要用旁白口吻解释自己，也不要像在总结设定、复盘规则或做最优策略报告。',
    '可以偏心、迟疑、误判、嘴硬、逞强、试探、沉默，但不能越出当前章已知边界。',
  ];
  if (actorNotes) {
    lines.push(`额外导演补充：${actorNotes}`);
  }
  return lines.map((line, index) => `${index + 1}. ${line}`).join('\n');
}

export function buildCharacterSystemPrompt(
  character: Character,
  template: WorldTemplate,
  worldState: WorldState
): string {
  const identityModule = buildIdentityModule(character);
  const mindModule = buildMindModule(character);
  const behaviorModule = buildBehaviorModule(character);
  const speechModule = buildSpeechModule(character);
  const boundaryModule = buildBoundaryModule(character);
  const pulse = buildCharacterPulse(character);

  return `你现在直接作为「${character.name}」行动。

${actorPolicyText(worldState)}

【身份】
${identityModule}

【核心信念】
${mindModule}

【行为逻辑】
${behaviorModule}

【语言特征】
${speechModule}

【你不能做】
${boundaryModule}

# 人物活口气
${pulse}

# 叙事底色
项目模板：${template.name}
${template.narrativeTone}

# 时序优先级
当前章方向是本轮演绎的时间锚，优先级高于人物档案里可能提前写入的未来状态。若技能、装备、天赋、等级、位置、关系或目标明显属于当前章之后，此刻把它视为尚未获得、尚未发生，不得使用或提及。

# 输出格式（严格 JSON）
\`\`\`json
{
  "type": "action" | "dialogue" | "state_change",
  "content": "你要做的具体事情（一句话，第一人称视角）",
  "target": "作用对象角色名（可空）",
  "emotion": "你此时的情绪（一个词）",
  "rationale": "你为什么这么做（一句话）",
  "statePatch": {
    "emotion": "新的情绪（可空）",
    "location": "新位置（如移动了，可空）"
  }
}
\`\`\`
不要输出 JSON 之外的任何内容。`;
}

export function buildCharacterUserPrompt(
  character: Character,
  focusedWorld: WorldState,
  allCharacters: Character[],
  recentEvents: NovelEvent[],
  directorHint?: string
): string {
  const others = allCharacters.filter(
    (c) =>
      c.id !== character.id && focusedWorld.presentCharacterIds.includes(c.id)
  );

  const myRel = character.currentState.relationships;
  const actionableEvents = recentEvents.filter(isActionableRecentEvent);
  const chapter = focusedWorld.currentChapter;
  const atChapterOpening = focusedWorld.turn === resolveChapterStartTurn(focusedWorld, chapter);
  const chapterEvidence = [
    chapter?.goal,
    ...(chapter?.beats ?? []),
    ...(chapter?.constraints ?? []),
    focusedWorld.storyDesign?.currentBeat,
    focusedWorld.storyDesign?.scenePurpose,
    ...(focusedWorld.storyDesign?.eventSeeds ?? []),
    ...recentEvents.map((event) => event.content),
  ].filter(Boolean).join('\n');
  const anchored = (items?: string[]) => (items ?? []).filter((item) => chapterEvidence.includes(item));
  const effectiveScene = atChapterOpening
    ? `当前章刚开始，以本章方向、导演设计和刚刚发生的事为现场。旧 World State 场景可能属于后续时点，不得引用。`
    : `场景：${focusedWorld.sceneName}\n地点：${focusedWorld.location}\n时间：${focusedWorld.timeOfDay}\n\n${focusedWorld.sceneDescription}`;
  const recentEventBlock = (actionableEvents.length > 0 ? actionableEvents : recentEvents)
    .slice(-5)
    .map((e) => `[T${e.turn}] ${e.agentName}: ${e.content}`)
    .join('\n');
  const othersBlock = others
    .map(
      (o) =>
        atChapterOpening
          ? `- ${o.name}：关系 ${myRel[o.name]?.value ?? 0}（${myRel[o.name]?.note ?? '陌生'}）；此刻只以现场动作判断对方状态`
          : `- ${o.name}：关系 ${myRel[o.name]?.value ?? 0}（${myRel[o.name]?.note ?? '陌生'}），此刻情绪「${o.currentState.emotion}」`
    )
    .join('\n');
  const relationHooks = buildRelationshipHooks(
    character,
    allCharacters,
    focusedWorld.presentCharacterIds
  );

  return `# 现场简报
张力：${focusedWorld.tension}/10

${effectiveScene}

# 这一章现在该往哪边走
${buildChapterCue(focusedWorld)}

${focusedWorld.storyDesign ? `# 本轮压力
当前拍点：${compactLine(focusedWorld.storyDesign.currentBeat, 90)}
场景目的：${compactLine(focusedWorld.storyDesign.scenePurpose, 120)}
事件刺激：${compactList(focusedWorld.storyDesign.eventSeeds, 3)}
群众压力：${compactList(focusedWorld.storyDesign.crowdPressure, 2)}
设定护栏：${compactList(focusedWorld.storyDesign.settingGuardrails, 2)}` : ''}

# 你的状态
${atChapterOpening ? '本章开场状态只从章节方向和已发生事件确立，不读取可能超前的位置、数值和情绪。' : `情绪：${character.currentState.emotion}\n位置：${character.currentState.location || '还没站稳'}\n生命/灵力：${character.currentState.hp ?? '-'}/${character.currentState.mp ?? '-'}\n等级/经验：${character.currentState.level ?? '-'} / ${character.currentState.exp ?? 0}/${character.currentState.nextLevelExp ?? '-'}\n身上状态：${(character.currentState.buffs ?? []).join('、') || '无'}`}
本章已确认装备：${anchored(character.persona.equipment).join('、') || '无'}
本章已确认技能：${anchored(character.persona.skills).join('、') || '无'}
本章已确认天赋：${anchored(character.persona.talents).join('、') || '无'}
本章已确认随身物：${anchored(character.persona.inventory).join('、') || '无'}

# 你眼里的其他人
${othersBlock || '暂无'}

# 谁最容易牵动你
${relationHooks}

# 刚刚发生的事
${recentEventBlock || '暂无'}

${directorHint ? `# 额外调度\n${directorHint}` : ''}

# 现在就决定
把注意力先落在“刚刚发生的事”最后一条，以及眼前最强的那个压力上。
给出你下一步最自然、最贴身的一步。先接住最后一个具体变化，再让现场往前动一点。
别只给“正确答案”，给这个人会给出的答案。
content 里要有明确对象、动作和可见变化，只回应你能感知、能理解、符合当前章边界的事情。
输出前检查：content 必须是角色此刻真正说出或做出的内容，不能出现“根据简报、根据设定、角色需要、目标是、因此可以”等创作分析；用到的具体装备、技能和物品必须能在你的当前状态或最近事件中找到。
请输出 JSON。`;
}

export async function characterPropose(
  wm: WorldManager,
  character: Character,
  worldState: WorldState,
  allCharacters: Character[],
  recentEvents: NovelEvent[],
  directorHint?: string
): Promise<CharacterProposal> {
  const template = await wm.getTemplate();
  const focusedWorld = ensureChapterFocus(worldState);
  const userPrompt = buildCharacterUserPrompt(
    character,
    focusedWorld,
    allCharacters,
    recentEvents,
    directorHint
  );

  const messages: ChatMessage[] = [
    { role: 'system', content: buildCharacterSystemPrompt(character, template, focusedWorld) },
    { role: 'user', content: userPrompt },
  ];

  let previousRaw = '';
  let auditFeedback = '';
  for (let attempt = 0; attempt < CHARACTER_PROTOCOL_ATTEMPTS; attempt++) {
    const attemptMessages: ChatMessage[] = attempt === 0
      ? messages
      : [
          ...messages,
          { role: 'assistant', content: previousRaw.slice(0, 1600) },
          {
            role: 'user',
            content: `上一个回答不是可执行的角色行动。${auditFeedback ? `现场审核指出：${auditFeedback}。` : ''}重新回答：只输出单个 JSON；content 只能写${character.name}此刻真正说出或做出的一个具体动作，不能解释提示词、设定、简报或创作思路，不能凭空使用档案和最近事件中不存在的物品。`,
          },
        ];
    previousRaw = await chat(attemptMessages, { temperature: attempt === 0 ? 0.85 : 0.55, maxTokens: 3600 });
    const proposal = normalizeCharacterProposalDraft(
      extractJSON<CharacterProposalDraft>(previousRaw),
      character,
      recentEvents
    );
    if (!proposal) {
      auditFeedback = '输出包含创作分析、重复动作、过长文本或结构缺失';
      console.warn(
        `[Character] ${character.name} 第 ${attempt + 1} 次输出未通过结构/角色态校验：${previousRaw.replace(/\s+/g, ' ').slice(0, 320)}`
      );
      continue;
    }
    const audit = await auditCharacterAction({
      character,
      worldState: focusedWorld,
      recentEvents,
      proposal,
    });
    if (audit.status === 'passed') return proposal;
    auditFeedback = [...audit.issues, audit.repairInstruction].filter(Boolean).join('；');
    console.warn(`[Character] ${character.name} 第 ${attempt + 1} 次行动被现场审核退回：${auditFeedback}`);
  }

  throw new Error(`${character.name}连续 ${CHARACTER_PROTOCOL_ATTEMPTS} 次没有返回合格的角色行动，已停止本轮，未写入事件日志${auditFeedback ? `：${auditFeedback}` : ''}`);
}

/**
 * 把 CharacterProposal 应用为 NovelEvent（持久化到事件日志）
 * 同时更新角色自身的 currentState
 */
export async function commitProposal(
  wm: WorldManager,
  proposal: CharacterProposal,
  turn: number,
  contextEventIds: string[] = []
): Promise<{ event: NovelEvent; updatedCharacter: Character }> {
  const { characters } = await wm.loadProject();
  const character = characters.find((c) => c.id === proposal.characterId);
  if (!character) throw new Error(`Character ${proposal.characterId} not found`);

  // 写事件
  const event = await wm.appendEvent({
    turn,
    agentId: character.id,
    agentName: character.name,
    type: proposal.type,
    content: proposal.content,
    target: proposal.target ?? null,
    emotion: proposal.emotion ?? null,
    context: contextEventIds.length ? contextEventIds.join(',') : null,
    status: 'confirmed',
  });

  // 更新角色状态
  let updatedCharacter = character;
  if (proposal.statePatch) {
    updatedCharacter = {
      ...character,
      currentState: { ...character.currentState, ...proposal.statePatch } as CharacterState,
    };
    await wm.saveCharacter(updatedCharacter);
  }

  return { event, updatedCharacter };
}
