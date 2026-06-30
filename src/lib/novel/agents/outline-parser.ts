/**
 * Outline Parser Agent
 *
 * 把用户输入的大纲（一句话简介 / 多段剧情 / 章节列表）解析为：
 *   - 风格判断（online-game / female-audience / business / custom）
 *   - World State（场景、位置、时间、初始张力）
 *   - 角色 Agent 列表（persona + currentState + relationships）
 *   - 剧情节点（plotNodes）供 Director 作为剧情骨架
 *
 * 用户输入什么粒度都行：
 *   - 一句话："退役剑士回归新服，被旧仇人队友陷害，副本里反杀"
 *   - 多段：开局/转折/高潮/结局
 *   - 章节：第1章 入口集合；第2章 Boss 战；第3章 装备分配冲突
 */

import { chat, extractJSON, type ChatMessage } from '../llm';
import type {
  Character,
  CharacterPersona,
  CharacterState,
  WorldState,
  WorldTemplate,
} from '../types';
import { getTemplate } from '../templates/online-game';

export interface ParsedOutline {
  templateKey: string;            // online-game | female-audience | business | custom
  templateReason: string;         // 为什么选这个模板
  worldState: WorldState;
  characters: Omit<Character, 'id'>[];
  plotNodes: PlotNode[];
  writerHint?: string;            // 给 Writer 的额外风格提示
}

export interface PlotNode {
  index: number;
  title: string;                  // 节点标题
  description: string;            // 节点描述
  targetTurn?: number;            // 预期在第几个 Turn 触发
  completed: boolean;
}

function buildSystemPrompt(): string {
  return `你是 NovelStudio 的 Outline Parser Agent，负责把用户的小说大纲解析为可演绎的结构化数据。

# 你的任务
1. 判断大纲最适合的风格模板
2. 生成初始 World State（场景/位置/时间/张力）
3. 生成 2-4 个核心角色（每个角色独立 Agent，需 persona + currentState + 关系网）
4. 把大纲拆解为 3-8 个剧情节点（plotNodes），供 Director 作为骨架

# 风格模板判断
- "online-game"：网游升级、副本、技能、装备、PK、玩家身份
- "female-audience"：感情纠葛、豪门、女主视角、情感张力
- "business"：商战、谈判、利益博弈、悬疑
- "custom"：以上都不符合，用通用叙事风格

# 角色设计原则
- **冲突优先**：角色之间必须有张力（盟友/敌人/暗藏立场），不要一团和气
- **隐藏动机**：至少一个角色有"表面立场"和"真实立场"的差距
- **目标明确**：每个角色要有 1-3 个具体短期目标
- **网游元素**（如选 online-game）：必须有等级/技能/装备/属性；技能名用「」括起
- **关系网**：relationships 必须互相填写，value 范围 -100 到 100

# 剧情节点拆解
- 从大纲里提取关键转折点
- 每个节点要有明确的"戏剧目标"（什么时候完成、完成后世界怎么变）
- targetTurn 是建议触发时机（每 3-5 turn 一个节点比较合理）
- 第一个节点通常是"开场铺垫"，最后一个节点是"高潮/反转"

# 输出格式（严格 JSON）
\`\`\`json
{
  "templateKey": "online-game" | "female-audience" | "business" | "custom",
  "templateReason": "为什么选这个模板（一句话）",
  "writerHint": "给 Writer 的额外风格提示（可空）",
  "worldState": {
    "sceneName": "场景名称",
    "sceneDescription": "场景描述（200 字内，含环境氛围和初始张力）",
    "location": "地理位置",
    "timeOfDay": "时间",
    "presentCharacterIds": [],
    "worldFlags": {},
    "tension": 3,
    "turn": 0,
    "plotNodes": [
      {
        "index": 1,
        "title": "节点标题",
        "description": "节点描述",
        "targetTurn": 2,
        "completed": false
      }
    ]
  },
  "characters": [
    {
      "name": "角色名",
      "role": "protagonist" | "antagonist" | "npc",
      "persona": {
        "background": "背景故事（100-200 字）",
        "personality": ["性格1", "性格2"],
        "goals": ["短期目标1", "目标2"],
        "stance": "立场和价值观",
        "speechStyle": "说话风格",
        "attributes": {"力量": 20, "敏捷": 15},
        "skills": ["技能1", "技能2"],
        "equipment": ["装备1"]
      },
      "currentState": {
        "emotion": "初始情绪",
        "location": "初始位置",
        "relationships": {
          "另一角色名": {"value": 30, "note": "关系说明"}
        },
        "hp": 100,
        "mp": 50,
        "level": 1,
        "buffs": []
      }
    }
  ]
}
\`\`\`

注意：
- 不要输出 JSON 之外的任何内容
- presentCharacterIds 留空数组，后端会自动填充
- relationships 必须互相填写（A 对 B 有关系，B 对 A 也要有）
- 网游模板必须有 attributes/skills/equipment，其他模板可省略`;
}

export async function parseOutline(outline: string): Promise<ParsedOutline> {
  const trimmed = outline.trim();
  if (!trimmed) {
    throw new Error('大纲不能为空');
  }

  const userPrompt = `# 用户大纲
"""
${trimmed}
"""

# 任务
请把以上大纲解析为结构化数据。如果大纲信息不足，你可以合理补充细节，但要保持与大纲一致的核心剧情走向。`;

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: userPrompt },
  ];

  const raw = await chat(messages, { temperature: 0.7, maxTokens: 4000 });
  const parsed = extractJSON<any>(raw);

  if (!parsed || !parsed.worldState || !parsed.characters) {
    throw new Error('AI 解析大纲失败，请重试或换种描述方式');
  }

  // 兜底：模板只支持 online-game，其他都降级为 online-game 但保留自定义风格
  const supportedTemplates = ['online-game'];
  const templateKey = supportedTemplates.includes(parsed.templateKey)
    ? parsed.templateKey
    : 'online-game';

  // 兜底字段
  const worldState: WorldState = {
    sceneName: parsed.worldState.sceneName ?? '未命名场景',
    sceneDescription: parsed.worldState.sceneDescription ?? '',
    location: parsed.worldState.location ?? '未知',
    timeOfDay: parsed.worldState.timeOfDay ?? '白天',
    presentCharacterIds: [],
    worldFlags: parsed.worldState.worldFlags ?? {},
    tension: parsed.worldState.tension ?? 3,
    turn: 0,
    // plotNodes 挂在 worldFlags 上（避免改 schema）
    ...(parsed.worldState.plotNodes
      ? { plotNodes: parsed.worldState.plotNodes }
      : {}),
  } as any;

  const characters: Omit<Character, 'id'>[] = (parsed.characters ?? []).map(
    (c: any) => ({
      name: c.name ?? '未命名角色',
      role: c.role ?? 'npc',
      persona: {
        background: c.persona?.background ?? '',
        personality: c.persona?.personality ?? [],
        goals: c.persona?.goals ?? [],
        stance: c.persona?.stance ?? '',
        speechStyle: c.persona?.speechStyle ?? '',
        attributes: c.persona?.attributes,
        skills: c.persona?.skills,
        equipment: c.persona?.equipment,
      } as CharacterPersona,
      currentState: {
        emotion: c.currentState?.emotion ?? '平静',
        location: c.currentState?.location ?? worldState.location,
        relationships: c.currentState?.relationships ?? {},
        hp: c.currentState?.hp,
        mp: c.currentState?.mp,
        level: c.currentState?.level,
        buffs: c.currentState?.buffs ?? [],
      } as CharacterState,
    })
  );

  // 互查 relationships：如果 A 提到 B 但 B 没提到 A，补一个默认关系
  for (const c of characters) {
    for (const otherName of Object.keys(c.currentState.relationships)) {
      const other = characters.find((x) => x.name === otherName);
      if (other && !other.currentState.relationships[c.name]) {
        const rel = c.currentState.relationships[otherName];
        other.currentState.relationships[c.name] = {
          value: rel.value, // 镜像
          note: `（${otherName} 视角未明确）`,
        };
      }
    }
  }

  return {
    templateKey,
    templateReason: parsed.templateReason ?? '',
    worldState,
    characters,
    plotNodes: parsed.worldState.plotNodes ?? [],
    writerHint: parsed.writerHint,
  };
}
