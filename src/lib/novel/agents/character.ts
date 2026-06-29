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

function buildSystemPrompt(
  character: Character,
  template: WorldTemplate
): string {
  return `你是 NovelStudio 中的角色「${character.name}」，你"是"这个角色，不是在描写他。

# 角色背景
${character.persona.background}

# 性格
${character.persona.personality.join('、')}

# 立场
${character.persona.stance}

# 说话风格
${character.persona.speechStyle}

# 短期目标
${character.persona.goals.map((g, i) => `${i + 1}. ${g}`).join('\n')}

# 风格模板：${template.name}
${template.narrativeTone}

# 你的行为原则
1. **第一人称视角**：你看到什么、想到什么、要做什么——而不是"角色做了什么"
2. **人设一致性**：你的行为必须符合性格和立场。贪婪的角色不会无私助人，冷静的角色不会突然暴怒
3. **目标推进**：每个行为要么推进某个短期目标，要么应对眼前的威胁/机会
4. **关系敏感**：你对其他角色的态度由 currentState.relationships 决定。对盟友信任，对敌人警惕
5. **行为而非描写**：你要做某件事，不是叙述某件事。"我拔剑指着他" 而非 "他感到了威胁"
6. **网游元素**：你是玩家/角色，可以释放技能、查看属性、装备物品。技能名用「」括起

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

export async function characterPropose(
  wm: WorldManager,
  character: Character,
  worldState: WorldState,
  allCharacters: Character[],
  recentEvents: NovelEvent[],
  directorHint?: string
): Promise<CharacterProposal> {
  const template = await wm.getTemplate();

  // 此角色感知到的其他在场角色
  const others = allCharacters.filter(
    (c) =>
      c.id !== character.id && worldState.presentCharacterIds.includes(c.id)
  );

  const myRel = character.currentState.relationships;
  const userPrompt = `# 当前场景
${worldState.sceneName} | ${worldState.location} | ${worldState.timeOfDay} | 张力 ${worldState.tension}/10

${worldState.sceneDescription}

# 你的当前状态
- 情绪：${character.currentState.emotion}
- 位置：${character.currentState.location}
- HP：${character.currentState.hp ?? '-'}/MP：${character.currentState.mp ?? '-'} / 等级 ${character.currentState.level ?? '-'}
- Buff：${(character.currentState.buffs ?? []).join('、') || '无'}
- 装备：${(character.persona.equipment ?? []).join('、')}
- 技能：${(character.persona.skills ?? []).join('、')}

# 你对在场其他人的看法
${others
  .map(
    (o) =>
      `- ${o.name}：${myRel[o.name]?.value ?? 0}（${myRel[o.name]?.note ?? '陌生'}）。他/她现在的情绪是「${o.currentState.emotion}」`
  )
  .join('\n')}

# 最近发生的事（按时间顺序）
${recentEvents
  .slice(-8)
  .map((e) => `[T${e.turn}] ${e.agentName}: ${e.content}`)
  .join('\n')}

${directorHint ? `# Director 暗示\n${directorHint}` : ''}

# 你的决策
你下一步要做什么？请输出 JSON。`;

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(character, template) },
    { role: 'user', content: userPrompt },
  ];

  const raw = await chat(messages, { temperature: 0.85, maxTokens: 600 });
  const parsed = extractJSON<any>(raw);

  if (!parsed) {
    // fallback: 简单观察行为
    return {
      characterId: character.id,
      characterName: character.name,
      type: 'action',
      content: raw.slice(0, 200) || '观察局势，没有动作',
      emotion: character.currentState.emotion,
      rationale: 'LLM 输出解析失败，fallback',
    };
  }

  return {
    characterId: character.id,
    characterName: character.name,
    type: parsed.type ?? 'action',
    content: parsed.content ?? '',
    target: parsed.target ?? undefined,
    emotion: parsed.emotion ?? undefined,
    statePatch: parsed.statePatch,
    rationale: parsed.rationale ?? '',
  };
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
