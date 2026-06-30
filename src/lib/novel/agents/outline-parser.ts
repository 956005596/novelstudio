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
 *   - 长大纲：8000+ 字详细剧本也支持，会先压缩再解析
 *
 * 超长大纲处理策略：
 *   - 输入 > 3000 字时，先调用 LLM 压缩成结构化摘要（保留核心剧情/角色/转折）
 *   - 再用压缩后的摘要走标准解析流程
 *   - 避免单次 LLM 调用输入过长导致输出截断或格式错误
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

// 长大纲阈值：超过此字数先压缩
const LONG_OUTLINE_THRESHOLD = 3000;
// 压缩后目标字数
const COMPRESSED_TARGET = 1500;
// LLM 输出 max tokens（中文需要更多 token，给 8000）
const PARSE_MAX_TOKENS = 8000;

export interface ParsedOutline {
  templateKey: string;
  templateReason: string;
  worldState: WorldState;
  characters: Omit<Character, 'id'>[];
  plotNodes: PlotNode[];
  writerHint?: string;
}

export interface PlotNode {
  index: number;
  title: string;
  description: string;
  targetTurn?: number;
  completed: boolean;
}

/**
 * 压缩超长大纲：保留核心剧情/角色/转折，去掉冗余描写
 */
async function compressOutline(longOutline: string): Promise<string> {
  const sysPrompt = `你是 NovelStudio 的大纲压缩器。用户输入了一份超长小说大纲（${longOutline.length} 字），请把它压缩为 ${COMPRESSED_TARGET} 字左右的结构化摘要。

# 压缩原则
1. **保留**：所有角色名、核心剧情节点、关键转折、人物关系、矛盾冲突
2. **去掉**：环境描写的细节、心理活动、对话原文、场景氛围
3. **结构化**：按"背景-角色-剧情节点"组织
4. **不丢信息**：压缩后 AI 还能基于此生成完整 World State

# 输出格式
\`\`\`
背景：一句话概括故事背景

角色：
- 角色名（身份）：核心目标 / 与他人关系
- ...

剧情节点：
1. 节点1（开局）：描述
2. 节点2（转折）：描述
...
\`\`\`

只输出压缩后的大纲，不要任何说明文字。`;

  const messages: ChatMessage[] = [
    { role: 'system', content: sysPrompt },
    { role: 'user', content: longOutline },
  ];

  const compressed = await chat(messages, { temperature: 0.3, maxTokens: 2500 });
  console.log(`[OutlineParser] 长大纲压缩：${longOutline.length} → ${compressed.length} 字`);
  return compressed.trim();
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
- 网游模板必须有 attributes/skills/equipment，其他模板可省略
- **输出要精简**：background 控制在 100 字内，description 控制在 50 字内，避免输出超长被截断
- **确保 JSON 完整闭合**：最后必须是 \`}\` 结尾，不能中途截断`;
}

export async function parseOutline(outline: string): Promise<ParsedOutline> {
  const trimmed = outline.trim();
  if (!trimmed) {
    throw new Error('大纲不能为空');
  }

  console.log(`[OutlineParser] 输入大纲 ${trimmed.length} 字`);

  // 长大纲先压缩
  let workOutline = trimmed;
  let wasCompressed = false;
  if (trimmed.length > LONG_OUTLINE_THRESHOLD) {
    console.log(`[OutlineParser] 大纲超长（${trimmed.length} > ${LONG_OUTLINE_THRESHOLD}），启动压缩`);
    try {
      workOutline = await compressOutline(trimmed);
      wasCompressed = true;
      if (!workOutline || workOutline.length < 50) {
        throw new Error('压缩后大纲为空或过短');
      }
    } catch (err: any) {
      console.error('[OutlineParser] 压缩失败，降级用原文前 3000 字:', err.message);
      workOutline = trimmed.slice(0, 3000);
    }
  }

  const userPrompt = `# 用户大纲
"""
${workOutline}
"""

${wasCompressed ? `# 注意
以上是经过压缩的大纲摘要（原文 ${trimmed.length} 字 → 压缩 ${workOutline.length} 字），请基于摘要生成结构化数据。` : ''}

# 任务
请把以上大纲解析为结构化数据。如果大纲信息不足，你可以合理补充细节，但要保持与大纲一致的核心剧情走向。`;

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: userPrompt },
  ];

  let raw: string;
  try {
    raw = await chat(messages, { temperature: 0.7, maxTokens: PARSE_MAX_TOKENS });
  } catch (err: any) {
    console.error('[OutlineParser] LLM 调用失败:', err.message);
    throw new Error(`AI 服务暂时不可用: ${err.message}（请稍后重试）`);
  }

  if (!raw || raw.trim().length === 0) {
    throw new Error('AI 返回为空，请重试');
  }

  console.log(`[OutlineParser] LLM 原始输出 ${raw.length} 字，前 500 字:`, raw.slice(0, 500));
  console.log('[OutlineParser] LLM 原始输出后 300 字:', raw.slice(-300));

  const parsed = extractJSON<any>(raw);

  if (!parsed) {
    console.error('[OutlineParser] JSON 解析失败，原始输出:', raw.slice(0, 1000));
    throw new Error('AI 输出格式异常，请换种描述方式重试');
  }

  // 兼容字段名差异：有些 LLM 会把 worldState 写成 world，characters 写成 character_list 等
  const rawWorld = parsed.worldState ?? parsed.world ?? parsed.scene ?? {};
  const rawChars = parsed.characters ?? parsed.character_list ?? parsed.characterList ?? [];

  if (!rawWorld || (Array.isArray(rawChars) && rawChars.length === 0)) {
    console.error('[OutlineParser] 缺少必要字段，parsed 顶层 keys:', Object.keys(parsed));
    throw new Error('AI 输出缺少必要字段（World State 或角色），请重试');
  }

  // 兜底：模板只支持 online-game，其他都降级为 online-game
  const supportedTemplates = ['online-game'];
  const templateKey = supportedTemplates.includes(parsed.templateKey)
    ? parsed.templateKey
    : 'online-game';

  // 兜底字段
  const worldState: WorldState = {
    sceneName: rawWorld.sceneName ?? rawWorld.name ?? '未命名场景',
    sceneDescription: rawWorld.sceneDescription ?? rawWorld.description ?? '',
    location: rawWorld.location ?? '未知',
    timeOfDay: rawWorld.timeOfDay ?? rawWorld.time ?? '白天',
    presentCharacterIds: [],
    worldFlags: rawWorld.worldFlags ?? {},
    tension: Number(rawWorld.tension ?? 3),
    turn: 0,
    ...(Array.isArray(rawWorld.plotNodes) ? { plotNodes: rawWorld.plotNodes } : {}),
    ...(parsed.writerHint ? { writerHint: parsed.writerHint } : {}),
  } as any;

  // 兜底角色字段
  const characters: Omit<Character, 'id'>[] = (Array.isArray(rawChars) ? rawChars : []).map(
    (c: any) => ({
      name: c.name ?? '未命名角色',
      role: c.role ?? 'npc',
      persona: {
        background: c.persona?.background ?? c.background ?? '',
        personality: c.persona?.personality ?? c.personality ?? [],
        goals: c.persona?.goals ?? c.goals ?? [],
        stance: c.persona?.stance ?? c.stance ?? '',
        speechStyle: c.persona?.speechStyle ?? c.speechStyle ?? c.speech_style ?? '',
        attributes: c.persona?.attributes ?? c.attributes,
        skills: c.persona?.skills ?? c.skills,
        equipment: c.persona?.equipment ?? c.equipment,
      } as CharacterPersona,
      currentState: {
        emotion: c.currentState?.emotion ?? c.emotion ?? '平静',
        location: c.currentState?.location ?? c.location ?? worldState.location,
        relationships: c.currentState?.relationships ?? c.relationships ?? {},
        hp: c.currentState?.hp ?? c.hp,
        mp: c.currentState?.mp ?? c.mp,
        level: c.currentState?.level ?? c.level,
        buffs: c.currentState?.buffs ?? c.buffs ?? [],
      } as CharacterState,
    })
  );

  if (characters.length === 0) {
    throw new Error('AI 未生成任何角色，请重试');
  }

  // 互查 relationships
  for (const c of characters) {
    for (const otherName of Object.keys(c.currentState.relationships)) {
      const other = characters.find((x) => x.name === otherName);
      if (other && !other.currentState.relationships[c.name]) {
        const rel = c.currentState.relationships[otherName];
        other.currentState.relationships[c.name] = {
          value: rel.value,
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
    plotNodes: rawWorld.plotNodes ?? [],
    writerHint: parsed.writerHint,
  };
}
