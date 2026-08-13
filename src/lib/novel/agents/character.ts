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
import { actorPolicyText, normalizeAgentPolicy } from '../agent-policy';

const CHARACTER_PROTOCOL_ATTEMPTS = 3;
const CHARACTER_META_TEXT = /(?:我们(?:需要|根据|现在)|根据(?:现场简报|角色要求|设定)|生成.{0,12}(?:行动|对话)|作为(?:AI|角色Agent|模型)|角色(?:需要|应该|可以)|目标是|因此[，,:：]?\s*(?:行动|回答)|输出\s*JSON|提示词|LLM|Agent|分析如下|方案如下|现在是[“\"]刚刚发生的事)/i;

interface CharacterProposalDraft {
  type?: unknown;
  content?: unknown;
  target?: unknown;
  emotion?: unknown;
  rationale?: unknown;
  statePatch?: unknown;
  // 兼容不同模型的字段变体
  action_type?: unknown;
  action?: unknown;
  next_step?: unknown;
  nextStep?: unknown;
  action_description?: unknown;
  actionDescription?: unknown;
  dialogue_text?: unknown;
  dialogueText?: unknown;
  content_text?: unknown;
  contentText?: unknown;
  reason?: unknown;
  why?: unknown;
  goal?: unknown;
  target_character?: unknown;
  targetCharacter?: unknown;
  current_emotion?: unknown;
  currentEmotion?: unknown;
  // 兼容 json 模式下模型可能输出的中文键
  类型?: unknown;
  动作?: unknown;
  行动?: unknown;
  内容?: unknown;
  话语?: unknown;
  说什么?: unknown;
  目标?: unknown;
  对象?: unknown;
  目标对象?: unknown;
  情绪?: unknown;
  当前情绪?: unknown;
  为什么?: unknown;
  理由?: unknown;
  台词?: unknown;
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

  // 兼容不同模型对动作内容/类型的字段命名差异。
  const pickText = (...keys: Array<unknown>): string => {
    for (const key of keys) {
      if (typeof key === 'string' && key.trim()) return key.trim();
    }
    return '';
  };
  const typeRaw = pickText(parsed.type, parsed.action_type, parsed.类型).toLowerCase();
  const typeMap: Record<string, string> = {
    action: 'action',
    act: 'action',
    move: 'action',
    movement: 'action',
    行动: 'action',
    动作: 'action',
    反应: 'action',
    行为: 'action',
    behaviour: 'action',
    behavior: 'action',
    dialogue: 'dialogue',
    dialog: 'dialogue',
    speak: 'dialogue',
    speech: 'dialogue',
    talk: 'dialogue',
    say: 'dialogue',
    line: 'dialogue',
    对话: 'dialogue',
    说话: 'dialogue',
    台词: 'dialogue',
    话语: 'dialogue',
    state_change: 'state_change',
    statechange: 'state_change',
    status_change: 'state_change',
    update: 'state_change',
    状态变化: 'state_change',
    状态: 'state_change',
    thought: 'action',
    reaction: 'action',
    response: 'action',
  };
  const type = typeMap[typeRaw] ?? '';
  const content = pickText(
    parsed.content,
    parsed.next_step,
    parsed.nextStep,
    parsed.action,
    parsed.action_description,
    parsed.actionDescription,
    parsed.dialogue_text,
    parsed.dialogueText,
    parsed.content_text,
    parsed.contentText,
    parsed.动作,
    parsed.行动,
    parsed.内容,
    parsed.话语,
    parsed.说什么,
    parsed.台词
  ).replace(/\s+/g, ' ');
  const rationale = pickText(parsed.rationale, parsed.reason, parsed.why, parsed.goal, parsed.为什么, parsed.理由).replace(/\s+/g, ' ');
  const target = pickText(parsed.target, parsed.target_character, parsed.targetCharacter, parsed.目标, parsed.对象, parsed.目标对象);
  const emotion = pickText(parsed.emotion, parsed.current_emotion, parsed.currentEmotion, parsed.情绪, parsed.当前情绪);

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
    target: target ? target : undefined,
    emotion: emotion ? emotion : undefined,
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

  // 防"凭空伤势"：content 明确声称出现新伤口/流血，但当前状态没有伤、最近事件也没有发生导致受伤的行为。
  // 只拦明确的伤口词（流血/渗血/烫伤/划伤/裂开/血肉模糊），不拦"手/腿/痛/麻"等身体部位和感受词，避免误伤正常身体反应。
  const injuryClaim = /(流血|渗血|淌血|飙血|血肉模糊|烫伤|灼伤|划伤|割伤|擦出.{0,4}血|裂开.{0,6}口子|伤口|血淋淋)/.test(input.proposal.content);
  if (injuryClaim) {
    const alreadyInjured = (input.character.currentState.injuries ?? []).length > 0 ||
      /血|伤|痛|裂|烫|疼|麻|肿/.test(input.character.currentState.bodySensation ?? '');
    const causedByEvents = input.recentEvents.some((e) =>
      /(伤|血|痛|裂|烫|撞|磕|摔|割|擦伤|烫伤|划伤)/.test(e.content ?? '') &&
      (e.agentId === input.character.id || e.agentName === input.character.name || (e.target ?? '').includes(input.character.name))
    );
    if (!alreadyInjured && !causedByEvents) {
      return {
        status: 'blocked',
        issues: ['候选凭空声称自己受伤/流血，但你的当前状态没有伤，最近事件里也没有导致你受伤的行为'],
        repairInstruction: '不要凭空说自己受伤或流血。如果你确实在这个动作里受伤（撞到、被烫、被划），先写这个受伤的动作本身，再把伤记入 statePatch.addInjuries。',
      };
    }
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
    '你只能知道自己在现场亲眼看到、亲耳听到、亲身经历的事，以及人物档案里真实属于你的记忆。作者侧的秘密、伏笔、未来剧情，你不知道，也绝不会说破。',
    '你身上的东西（装备、随身物、伤势、体力）都来自你的档案和一路经历；没有的东西，你手里就是没有。',
    '你不会解释自己、不会总结设定、不会复盘规则——你只是在活着，在想，在做。',
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

  return `你是「${character.name}」，一个真实活在这个世界里的、有血有肉的人。

你不是在写小说，不是在答题，不是在扮演。你就是这个人本身——你有名字、有来历、有在乎的人和事、有害怕和想要的东西。从你出生到现在，你一直在活着，刚刚过去的每一刻都真实发生在你身上：你看到了什么、听到了什么、身上哪里痛、心里在想什么。

接下来，你将以「${character.name}」的身份，继续你此刻正在过的生活。你会遇到新的变化，做出你的反应——不是最优解，不是标准答案，而是这个人会做出的那一步。

${actorPolicyText(worldState)}

# 你是谁
${identityModule}

# 你心里装着什么
${mindModule}

# 你会怎么做事
${behaviorModule}

# 你怎么说话
${speechModule}

# 你不越界的底线
${boundaryModule}

# 你的活口气
${pulse}

# 你所在世界的底色
项目模板：${template.name}
${template.narrativeTone}
${worldState.writerHint ? `\n项目题材风格：\n${worldState.writerHint}` : ''}

# 时间感
你只活在这一刻。人物档案里那些属于"未来的事"，此刻还没发生，你既不知道、也不会想到。

# 你的回答
直接输出一个 JSON，描述你此刻会做的那个动作。这是你作为活人的反应，不是格式练习。第一个字符是 {，最后一个字符是 }，中间只有 JSON。

规则：
1. 你是角色本人，所以 content 永远是第一人称的具体动作或话语，写的是"你做了什么"，不是"你分析了什么"。
2. 你不解释、不复述、不总结——你只是在做、在想、在说。
3. 不要输出任何 JSON 之外的文字、思考过程或解释。

\`\`\`json
{
  "type": "action" | "dialogue" | "state_change",
  "content": "你要做的具体事情（一句话，第一人称视角）",
  "target": "作用对象角色名（可空）",
  "emotion": "你此时的情绪（一个词）",
  "rationale": "你为什么这么做（一句话）",
  "statePatch": {
    "emotion": "新的情绪（可空）",
    "location": "新位置（如移动了，可空）",
    "addInjuries": ["你此刻新受的伤/疼痛，如「右手掌烫伤起泡」"],
    "clearInjuries": ["已经痊愈或不再影响你的旧伤，如「左手擦伤」"],
    "bodySensation": "你此刻最真实的身体感受（可空），如「掌心又麻又烫，连攥拳都费劲」"
  }
}
\`\`\`

现在，以「${character.name}」的身份，继续活你的这一刻。`;
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
  // 构建"你的记忆 + 现场"：优先保留你亲身参与/关于你的事件，让你记得自己一路做了什么；
  // 其他角色的事件只保留最近几条作为现场信息。
  const srcEvents = actionableEvents.length > 0 ? actionableEvents : recentEvents;
  const myId = character.id;
  const myName = character.name;
  const myEvents = srcEvents.filter((e) => e.agentId === myId || e.agentName === myName);
  const othersRecent = srcEvents.filter((e) => e.agentId !== myId && e.agentName !== myName).slice(-3);
  const memoryEvents = [...myEvents.slice(-8), ...othersRecent].sort((a, b) => a.turn - b.turn);
  const recentEventBlock = memoryEvents
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

${(() => {
  const p = focusedWorld.agentPolicy;
  const delegated = p?.directorMode === 'character_led' && p?.actorAutonomy === 'proactive';
  return delegated
    ? `# 这一轮没有导演替你安排
现在没有人替你制造冲突、推进剧情或替你决定该做什么——这一切都要靠你自己。
你不只是在"回应眼前的事"，更要作为一个有目标、有欲望、有恐惧的人，主动让眼前的生活向前走。
你可以：抓住自己最在意的东西去行动；被在场的人或物牵动；主动试探、逼近、退让、撒谎、求证；
甚至主动把一个处境往前推一步。但记住——你只能做"此刻的你"会做的事，不能突然知道不该知道的事。`
    : '';
})()}

${focusedWorld.storyDesign ? `# 本轮压力
当前拍点：${compactLine(focusedWorld.storyDesign.currentBeat, 90)}
场景目的：${compactLine(focusedWorld.storyDesign.scenePurpose, 120)}
事件刺激：${compactList(focusedWorld.storyDesign.eventSeeds, 3)}
群众压力：${compactList(focusedWorld.storyDesign.crowdPressure, 2)}
设定护栏：${compactList(focusedWorld.storyDesign.settingGuardrails, 2)}` : ''}

# 你的状态
${atChapterOpening ? '本章开场状态只从章节方向和已发生事件确立，不读取可能超前的位置、数值和情绪。' : `情绪：${character.currentState.emotion}\n位置：${character.currentState.location || '还没站稳'}\n生命/灵力：${character.currentState.hp ?? '-'}/${character.currentState.mp ?? '-'}\n等级/经验：${character.currentState.level ?? '-'} / ${character.currentState.exp ?? 0}/${character.currentState.nextLevelExp ?? '-'}\n身上状态：${(character.currentState.buffs ?? []).join('、') || '无'}\n你的伤：${(character.currentState.injuries ?? []).join('、') || '没有明显伤口'}\n身体感受：${character.currentState.bodySensation || '身体基本正常'}`}
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
你是「${character.name}」——一个从本章开头一路活到现在的人，不是来答题的。
你记得自己刚刚经历了什么：${recentEventBlock.split('\n')[0] || '眼前的现场'}。你的身体有记忆：${character.currentState.injuries?.length ? `你身上还带着这些伤——${character.currentState.injuries.join('、')}，它正影响着你的每一个动作。` : '你还没有明显伤口，但身体会累、会痛、会怕。'}
把注意力先落在“刚刚发生的事”最后一条，以及眼前最强的那个压力上。
给出你下一步最自然、最贴身的一步。先接住最后一个具体变化，再让现场往前动一点。
别只给“正确答案”，给这个人会给出的答案。
content 里要有明确对象、动作和可见变化，只回应你能感知、能理解、符合当前章边界的事情。
输出前检查：content 必须是角色此刻真正说出或做出的内容，不能出现“根据简报、根据设定、角色需要、目标是、因此可以、让我们、首先、总结、复盘”等任何创作分析或思考过程；用到的具体装备、技能和物品必须能在你的当前状态或最近事件中找到。优先接住“刚刚发生的事”里真实出现的刺激，但也可以基于现场氛围和人设做出合理推断、试探或抢先反应——只要不把推断当成已经发生的事实写死。
如果你的行动会让你受伤或改变身体状况（比如撞到、被烫、被划伤、流血），把这一变化写进 statePatch 的 addInjuries / bodySensation；如果旧伤不再影响你，写进 clearInjuries。别凭空说自己受伤，也别假装伤不存在。

直接输出单个 JSON 对象：第一个字符必须是左花括号，最后一个字符必须是右花括号，不写任何 JSON 之外的文字、不做任何铺垫或解释。`;
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
  const actorPolicy = normalizeAgentPolicy(focusedWorld.agentPolicy);
  // 温度优先级：角色专属 actingTemperature > 全局 actorTemperature > 默认 0.9。
  // 不同性格的角色用不同温度：跳脱/多变的角色放高，冷静/克制的角色放低，让演绎各有特点。
  const personaTemp = Number(character.persona.actingTemperature);
  const baseTemperature = Number.isFinite(personaTemp)
    ? Math.min(1.2, Math.max(0.4, personaTemp))
    : (actorPolicy.actorTemperature ?? 0.9);
  // 模型优先级：角色专属 actingModel > 全局默认模型。允许用不同模型扮演不同性格的角色。
  const personaModel = String(character.persona.actingModel ?? '').trim();
  for (let attempt = 0; attempt < CHARACTER_PROTOCOL_ATTEMPTS; attempt++) {
    const attemptMessages: ChatMessage[] = attempt === 0
      ? messages
      : [
          ...messages,
          // 不把上一段长分析喂回模型（那会诱导它继续分析），只追加硬性格式纠偏。
          {
            role: 'user',
            content: `你上一个回答里出现了大段思考/分析文字，而不是可执行的动作 JSON。重新回答：这次直接输出单个 JSON 对象，第一个字符必须是 {，最后一个必须是 }，中间不出现任何 JSON 之外的文字。content 只写${character.name}此刻真正说出或做出的一个具体动作（一句话，第一人称）。${auditFeedback ? `现场审核指出：${auditFeedback}。` : ''}不要解释、不要复述场景、不要写“我在想/我需要/首先”之类的话。`,
          },
        ];
    // 首次用配置温度给足发挥空间；重试时略降但仍保留一定多样性，避免重试变成同一句套话。
    previousRaw = await chat(attemptMessages, {
      ...(personaModel ? { model: personaModel } : {}),
      temperature: attempt === 0 ? baseTemperature : Math.min(0.95, baseTemperature - 0.15),
      maxTokens: 3600,
      json: true,
    });
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
    const patch = proposal.statePatch as CharacterState & {
      addInjuries?: string[];
      clearInjuries?: string[];
    };
    const current = character.currentState;
    const currentInjuries = current.injuries ?? [];
    const addInjuries = (patch.addInjuries ?? []).map((s) => String(s).trim()).filter(Boolean);
    const clearInjuries = new Set((patch.clearInjuries ?? []).map((s) => String(s).trim()).filter(Boolean));
    // 合并伤势：加上新伤，去掉已痊愈的
    const mergedInjuries = [...currentInjuries, ...addInjuries.filter((s) => !currentInjuries.includes(s))]
      .filter((s) => !clearInjuries.has(s));
    const { addInjuries: _ai, clearInjuries: _ci, ...restPatch } = patch;
    updatedCharacter = {
      ...character,
      currentState: {
        ...current,
        ...restPatch,
        ...(addInjuries.length || clearInjuries.size || currentInjuries.length
          ? { injuries: mergedInjuries.length ? mergedInjuries : undefined }
          : {}),
      } as CharacterState,
    };
    await wm.saveCharacter(updatedCharacter);
  }

  return { event, updatedCharacter };
}
