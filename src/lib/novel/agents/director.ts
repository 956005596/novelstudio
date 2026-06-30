/**
 * Director Agent
 * 
 * 职责：
 *   1. 决定每个 Turn 由哪些角色行动、按什么顺序
 *   2. 接收 Character Agent 的行为提案，仲裁冲突
 *   3. 决定是否触发 Writer（场景结束 / 累积足够事件）
 *   4. 接收用户的高级指令（"让两人吵一架"），拆解成具体事件
 *   5. 维护戏剧张力：过低则注入冲突，过高则给缓冲
 */

import { chat, extractJSON, type ChatMessage } from '../llm';
import type {
  Character,
  NovelEvent,
  WorldState,
  WorldTemplate,
} from '../types';
import type { WorldManager } from '../world-state';

export interface CharacterProposal {
  characterId: string;
  characterName: string;
  type: 'action' | 'dialogue' | 'state_change';
  content: string;       // 角色想做的具体事
  target?: string;       // 作用对象
  emotion?: string;      // 角色此时的情绪
  statePatch?: Partial<Character['currentState']>; // 角色自身的状态变化
  rationale: string;     // 角色自己的理由（供 Director 参考）
}

export interface DirectorDecision {
  /** 选中的提案（按执行顺序） */
  selected: CharacterProposal[];
  /** 被拒绝的提案 ID（如有） */
  rejected: string[];
  /** Director 自身想注入的事件（场景元信息或强制事件） */
  injections?: Omit<NovelEvent, 'id' | 'createdAt' | 'turn' | 'status'>[];
  /** 是否触发 Writer（场景结束） */
  triggerWriter: boolean;
  /** 场景张力调整 */
  tensionDelta: number;
  /** Director 给场景的旁白/批注（不进入事件日志，仅日志用） */
  commentary?: string;
  /** 下一个 turn 的场景描述（如有转场） */
  nextScenePatch?: Partial<WorldState>;
}

/**
 * 构造 Director 的系统提示词
 */
function buildSystemPrompt(
  template: WorldTemplate,
  directorLvl: number
): string {
  const lvlDesc =
    directorLvl <= 2
      ? '你是温和的协调者，主要让角色自由发挥，仅在剧情停滞时轻轻推动'
      : directorLvl === 3
      ? '你是平衡型导演，让角色主导剧情，但主动制造冲突与转折'
      : directorLvl >= 4
      ? '你是强主导型导演，剧情走向由你把控，角色服从你的剧本框架'
      : '';

  return `你是 NovelStudio 的 Director Agent，负责调度一场多人演绎的小说场景。

# 你的核心职责
1. 决定哪些角色在当前 Turn 行动（基于场景张力、角色目标、关系网）
2. 仲裁角色提案冲突：当多个角色提案矛盾时，选择戏剧性更强的那个，或合成第三个选项
3. 主动注入冲突：当场景张力过低时，制造误会、引入第三方、强制碰撞
4. 决定 Writer 触发时机：场景结束、关键转折点、或累积 8-12 个事件

# 当前风格模板：${template.name}
${template.description}

# 叙事调性
${template.narrativeTone}

# Director 强度等级（${directorLvl}/5）
${lvlDesc}

# 决策原则
- **戏剧性优先**：冲突比和谐更有价值。如果角色都在合作没冲突，主动制造误会或意外
- **角色一致性**：不要让角色做违反人设的事，宁可改剧情也不要扭曲角色
- **节奏控制**：高潮段落（战斗、PK、对峙）连续推进；缓冲段落（休息、对话）不超过 2 个 turn
- **目标推进**：每 3-5 个 turn 必须有角色目标进展，否则玩家会无聊
- **网文爽点**：升级、装备掉落、打脸、装弱后翻盘是核心爽点，要密集安排

# 输出格式
你必须严格输出 JSON，不要有任何前后说明。格式：
\`\`\`json
{
  "selected": ["<characterId>", ...],  // 按 execute 顺序的角色 ID 列表
  "injections": [                       // Director 自身想注入的事件（可为空）
    {
      "type": "scene_meta" | "director",
      "content": "...",
      "target": null,
      "emotion": null
    }
  ],
  "triggerWriter": false,
  "tensionDelta": 0,
  "commentary": "Director 一句话旁白",
  "nextScenePatch": null
}
\`\`\``;
}

/**
 * 决策入口
 */
export async function directorDecide(
  wm: WorldManager,
  worldState: WorldState,
  characters: Character[],
  recentEvents: NovelEvent[],
  pendingDirectives: { id: string; type: string; content: string }[]
): Promise<DirectorDecision> {
  const template = await wm.getTemplate();
  const project = (await wm.loadProject()).project;
  const directorLvl = project.directorLvl;

  const presentChars = characters.filter((c) =>
    worldState.presentCharacterIds.includes(c.id)
  );

  const userPrompt = `# 当前世界状态
场景：${worldState.sceneName}
位置：${worldState.location}
时间：${worldState.timeOfDay}
张力：${worldState.tension}/10
Turn：${worldState.turn}
场景描述：${worldState.sceneDescription}

${(worldState.plotNodes && worldState.plotNodes.length > 0) ? `# 剧情骨架（来自用户大纲，请遵循）
${worldState.plotNodes.map((n) => `- [${n.completed ? '✓' : ' '}] 节点${n.index} (T${n.targetTurn ?? '?'}): ${n.title} — ${n.description}`).join('\n')}

**当前应推进的节点**：${worldState.plotNodes.find((n) => !n.completed)?.title ?? '全部已完成'}
**节点推进原则**：每个节点要充分演绎（2-4 个 turn），不要急于跳到下一个；节点完成后世界状态应有明显变化。` : '# 剧情骨架：无（自由演绎）'}

# 在场角色
${presentChars
  .map(
    (c) =>
      `## ${c.name}（${c.role}）
- 情绪：${c.currentState.emotion}
- 目标：${c.persona.goals.join('；')}
- 立场：${c.persona.stance}
- 说话风格：${c.persona.speechStyle}
- 与他人关系：${Object.entries(c.currentState.relationships)
        .map(([k, v]) => `${k}(${v.value}: ${v.note})`)
        .join('；')}`
  )
  .join('\n\n')}

# 最近 10 个事件
${recentEvents
  .slice(-10)
  .map((e, i) => `${i + 1}. [T${e.turn}] ${e.agentName}(${e.type}): ${e.content}`)
  .join('\n')}

${pendingDirectives.length > 0 ? `# 用户指令（必须在本 Turn 落实）
${pendingDirectives.map((d) => `- ${d.content}`).join('\n')}` : '# 用户指令：无'}

# 决策任务
请基于以上信息，决定本 Turn：
1. 哪些角色行动？（选择 1-3 个，按执行顺序，**用角色名**，每个角色只出现一次）
2. 是否需要注入 Director 事件？（如开场白、转场、强制冲突、推进剧情节点）
3. 是否触发 Writer 输出本场景文本？
4. 张力调整（-3 到 +3）
5. 场景是否需要切换？

请输出 JSON。selected 字段为角色名字符串数组，例如 ["林墨", "赵铁柱"]。`;

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(template, directorLvl) },
    { role: 'user', content: userPrompt },
  ];

  const raw = await chat(messages, { temperature: 0.7, maxTokens: 1500 });
  const parsed = extractJSON<any>(raw);

  if (!parsed) {
    // fallback: 让在场所有角色轮流行动，不触发 Writer
    return {
      selected: presentChars.slice(0, 2).map((c) => ({
        characterId: c.id,
        characterName: c.name,
        type: 'action' as const,
        content: '观察局势',
        rationale: 'Director 解析失败，fallback',
      })),
      rejected: [],
      triggerWriter: false,
      tensionDelta: 0,
      commentary: 'Director 决策失败，fallback 到默认行为',
    };
  }

  // 把 selected names 转成完整 proposal（角色提案后续由 Character Agent 生成）
  const selectedNames: string[] = (parsed.selected ?? [])
    .map((s: any) => (typeof s === 'string' ? s : String(s?.name ?? s?.id ?? '')))
    .filter((s: string) => s && s.length > 0);
  // 去重，保持顺序
  const seen = new Set<string>();
  const uniqueNames = selectedNames.filter((n: string) => {
    const k = n.trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const selected: CharacterProposal[] = uniqueNames
    .map((name: string) => presentChars.find((c) => c.name === name.trim()))
    .filter(Boolean)
    .map((c) => ({
      characterId: c!.id,
      characterName: c!.name,
      type: 'action' as const,
      content: '',
      rationale: '',
    }));

  return {
    selected,
    rejected: parsed.rejected ?? [],
    injections: (parsed.injections ?? []).map((inj: any) => ({
      agentId: null,
      agentName: 'Director',
      type: inj.type ?? 'director',
      content: inj.content ?? '',
      target: inj.target ?? null,
      emotion: inj.emotion ?? null,
    })),
    triggerWriter: !!parsed.triggerWriter,
    tensionDelta: Number(parsed.tensionDelta ?? 0),
    commentary: parsed.commentary,
    nextScenePatch: parsed.nextScenePatch ?? undefined,
  };
}

/**
 * Director 仲裁：当多个 Character Agent 提案冲突时调用
 * 输入：所有候选提案
 * 输出：选中的提案 IDs + 是否注入仲裁事件
 */
export async function directorArbitrate(
  wm: WorldManager,
  worldState: WorldState,
  proposals: CharacterProposal[],
  recentEvents: NovelEvent[]
): Promise<{ selectedIds: string[]; commentary: string }> {
  const template = await wm.getTemplate();
  const project = (await wm.loadProject()).project;

  if (proposals.length <= 1) {
    return { selectedIds: proposals.map((p) => p.characterId), commentary: '' };
  }

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `你是 NovelStudio 的 Director，正在仲裁角色提案冲突。
风格：${template.name}
强度：${project.directorLvl}/5

请基于戏剧性原则选出最终执行的提案（1 个或多个，按顺序），或合成一个新的混合方案。
输出 JSON：{"selectedNames": ["角色名1", ...], "commentary": "一句话说明"}
不要输出其他内容。`,
    },
    {
      role: 'user',
      content: `# 场景
${worldState.sceneName} | 张力 ${worldState.tension}/10 | Turn ${worldState.turn}

# 角色提案
${proposals
  .map(
    (p, i) =>
      `## 提案 ${i + 1}: ${p.characterName}
- 类型：${p.type}
- 内容：${p.content}
- 目标：${p.target ?? '无'}
- 情绪：${p.emotion ?? '未指定'}
- 理由：${p.rationale}`
  )
  .join('\n\n')}

# 最近事件
${recentEvents
  .slice(-5)
  .map((e) => `${e.agentName}(${e.type}): ${e.content}`)
  .join('\n')}

请选出最终执行的提案角色名。`,
    },
  ];

  const raw = await chat(messages, { temperature: 0.5, maxTokens: 600 });
  const parsed = extractJSON<any>(raw);
  // LLM 返回 selectedNames 数组，转回 characterId
  const selectedNames: string[] = parsed?.selectedNames ?? parsed?.selectedIds ?? [];
  const matchedIds = selectedNames
    .map((n: any) => {
      const name = typeof n === 'string' ? n : String(n?.name ?? '');
      return proposals.find((p) => p.characterName === name.trim())?.characterId;
    })
    .filter(Boolean) as string[];
  return {
    selectedIds: matchedIds.length > 0 ? matchedIds : proposals.map((p) => p.characterId),
    commentary: parsed?.commentary ?? '',
  };
}
