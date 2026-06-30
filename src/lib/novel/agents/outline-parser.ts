/**
 * Outline Parser Agent (v2 — 多步流水线)
 *
 * 把用户输入的大纲解析为丰满的演绎世界，支持 200w 字长篇。
 *
 * 流水线（每步独立 LLM 调用，避免单次输出截断）：
 *   1. compressOutline   — 超长大纲先压缩
 *   2. buildWorldLore    — 构建世界观设定（背景/势力/地理/规则/主题）
 *   3. buildCharacters   — 设计角色深度档案（背景/成长弧线/内在冲突/秘密）
 *   4. buildPlotNodes    — 拆解剧情节点
 *   5. assembleWorldState — 组装初始 World State
 *
 * 每步通过 onProgress 回调上报进度，前端实时显示。
 */

import { chat, extractJSON, type ChatMessage } from '../llm';
import type {
  Character,
  CharacterPersona,
  CharacterState,
  PlotNode,
  WorldLore,
  WorldState,
} from '../types';

// 长大纲阈值
const LONG_OUTLINE_THRESHOLD = 3000;
const COMPRESSED_TARGET = 1500;
const PARSE_MAX_TOKENS = 6000;

export type ProgressStage =
  | 'compressing'     // 压缩超长大纲
  | 'world-lore'      // 构建世界观
  | 'characters'      // 设计角色
  | 'plot-nodes'      // 拆解剧情节点
  | 'assembling'      // 组装 World State
  | 'done'
  | 'error';

export interface ProgressEvent {
  stage: ProgressStage;
  message: string;
  progress: number;   // 0-100
  detail?: any;       // 阶段产物预览（如世界观摘要）
}

export interface ParsedOutline {
  templateKey: string;
  templateReason: string;
  worldState: WorldState;
  characters: Omit<Character, 'id'>[];
  plotNodes: PlotNode[];
  writerHint?: string;
}

export type ProgressCallback = (event: ProgressEvent) => void;

// ============================================================
// 阶段 1：压缩超长大纲
// ============================================================
async function compressOutline(
  longOutline: string,
  onProgress: ProgressCallback
): Promise<string> {
  onProgress({
    stage: 'compressing',
    message: `大纲超长（${longOutline.length} 字），正在压缩为结构化摘要…`,
    progress: 5,
  });

  const sysPrompt = `你是 NovelStudio 的大纲压缩器。用户输入了一份超长小说大纲（${longOutline.length} 字），请把它压缩为 ${COMPRESSED_TARGET} 字左右的结构化摘要。

# 压缩原则
1. **保留**：所有角色名、核心剧情节点、关键转折、人物关系、矛盾冲突、世界观要素
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

// ============================================================
// 阶段 2：构建世界观设定
// ============================================================
async function buildWorldLore(
  outline: string,
  onProgress: ProgressCallback
): Promise<{ worldLore: WorldLore; templateKey: string; templateReason: string; writerHint: string; initialScene: { sceneName: string; sceneDescription: string; location: string; timeOfDay: string; tension: number } }> {
  onProgress({
    stage: 'world-lore',
    message: '正在构建世界观：背景、势力、地理、规则、主题…',
    progress: 20,
  });

  const sysPrompt = `你是 NovelStudio 的世界观架构师，负责为长篇小说构建丰满的世界观设定。

# 任务
基于用户大纲，生成详细的世界观档案。这是 200w 字长篇的背景支撑，要够丰满。

# 输出格式（严格 JSON）
\`\`\`json
{
  "templateKey": "online-game" | "female-audience" | "business" | "custom",
  "templateReason": "为什么选这个模板（一句话）",
  "writerHint": "给 Writer 的整体风格提示",
  "worldLore": {
    "premise": "故事前提/核心命题（50-100 字）",
    "worldBackground": "世界观背景（300-500 字详细描述，包括时代/社会/科技或魔法水平/历史脉络）",
    "geography": ["地点1（简述）", "地点2（简述）", "..."],
    "factions": [
      { "name": "势力名", "description": "势力描述", "stance": "立场（友好/敌对/中立/复杂）" }
    ],
    "rules": ["世界规则1（魔法体系/科技/社会法则）", "规则2", "..."],
    "themes": ["主题1（如：救赎/背叛/成长）", "主题2"],
    "timeline": "故事时间线/历史背景（100-200 字）"
  },
  "initialScene": {
    "sceneName": "开场场景名",
    "sceneDescription": "开场场景描述（200 字内，含环境氛围和初始张力）",
    "location": "地理位置",
    "timeOfDay": "时间",
    "tension": 3
  }
}
\`\`\`

注意：
- 只输出 JSON，不要任何说明
- worldBackground 要够详细，让 Director 后续能基于此创造冲突
- factions 至少 2 个，让故事有势力博弈空间
- geography 至少 3 个地点，支持后续场景切换
- rules 要明确，让角色行为有边界
- 确保 JSON 完整闭合`;

  const messages: ChatMessage[] = [
    { role: 'system', content: sysPrompt },
    { role: 'user', content: `# 用户大纲\n"""\n${outline}\n"""` },
  ];

  const raw = await chat(messages, { temperature: 0.7, maxTokens: PARSE_MAX_TOKENS });
  const parsed = extractJSON<any>(raw);

  if (!parsed || !parsed.worldLore) {
    console.error('[OutlineParser] 世界观解析失败，raw:', raw.slice(0, 500));
    throw new Error('世界观构建失败，请重试');
  }

  onProgress({
    stage: 'world-lore',
    message: `世界观构建完成：${parsed.worldLore.geography?.length ?? 0} 地点 / ${parsed.worldLore.factions?.length ?? 0} 势力`,
    progress: 40,
    detail: parsed.worldLore,
  });

  return parsed;
}

// ============================================================
// 阶段 3：设计角色深度档案
// ============================================================
async function buildCharacters(
  outline: string,
  worldLore: WorldLore,
  templateKey: string,
  onProgress: ProgressCallback
): Promise<Omit<Character, 'id'>[]> {
  onProgress({
    stage: 'characters',
    message: '正在设计角色深度档案：背景故事、成长弧线、内在冲突、秘密…',
    progress: 55,
  });

  const sysPrompt = `你是 NovelStudio 的角色设计师，负责为长篇小说设计丰满的角色档案。

# 任务
基于大纲和世界观，设计 2-4 个核心角色。每个角色都要有深度，不能扁平化。

# 当前风格模板：${templateKey}
${templateKey === 'online-game'
    ? '网游模板：必须有 attributes/skills/equipment，技能名用「」括起，等级/装备/属性要具体'
    : '通用模板：可省略 attributes/skills/equipment'}

# 世界观背景（角色要与此契合）
${worldLore.worldBackground}

# 输出格式（严格 JSON）
\`\`\`json
{
  "characters": [
    {
      "name": "角色名",
      "role": "protagonist" | "antagonist" | "npc",
      "persona": {
        "background": "一句话背景",
        "backstory": "详细背景故事（300-500 字，包括身世/关键经历/转折点/与他人的渊源）",
        "personality": ["性格1", "性格2", "性格3"],
        "goals": ["短期目标1", "长期目标2"],
        "stance": "立场和价值观（一句话）",
        "speechStyle": "说话风格（一句话）",
        "speechHabits": ["口头禅1", "语言习惯1"],
        "growthArc": "成长弧线：从X状态→到Y状态，经历什么转变（100-200 字）",
        "innerConflict": "内在冲突/矛盾（如：责任vs情感、野心vs良知）",
        "secrets": ["角色秘密1（其他角色不知道的）", "秘密2"],
        "motivations": ["表层动机", "深层动机"],
        "appearance": "外貌特征（100 字内）",
        "attributes": {"力量": 20, "敏捷": 15},
        "skills": ["「技能1」", "「技能2」"],
        "equipment": ["装备1", "装备2"]
      },
      "currentState": {
        "emotion": "初始情绪",
        "location": "初始位置",
        "relationships": {
          "另一角色名": {"value": 30, "note": "关系说明（含历史渊源）"}
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

# 设计原则
1. **冲突优先**：角色之间必须有张力，至少一个角色有"表面立场"和"真实立场"的差距
2. **深度**：backstory 要够丰满，让角色有"为什么是这样的人"的合理性
3. **成长空间**：growthArc 要明确，让角色在 200w 字里有变化
4. **秘密**：每个角色至少 1 个秘密，可作为后续剧情伏笔
5. **关系网**：relationships 必须互相填写，note 要含历史渊源
6. **不扁平**：反派也要有合理动机，不要纯粹恶

只输出 JSON，不要说明文字。确保 JSON 完整闭合。`;

  const messages: ChatMessage[] = [
    { role: 'system', content: sysPrompt },
    { role: 'user', content: `# 用户大纲\n"""\n${outline}\n"""` },
  ];

  const raw = await chat(messages, { temperature: 0.75, maxTokens: PARSE_MAX_TOKENS });
  const parsed = extractJSON<any>(raw);

  if (!parsed || !Array.isArray(parsed.characters) || parsed.characters.length === 0) {
    console.error('[OutlineParser] 角色解析失败，raw:', raw.slice(0, 500));
    throw new Error('角色设计失败，请重试');
  }

  const characters: Omit<Character, 'id'>[] = parsed.characters.map((c: any) => ({
    name: c.name ?? '未命名角色',
    role: c.role ?? 'npc',
    persona: {
      background: c.persona?.background ?? '',
      backstory: c.persona?.backstory ?? '',
      personality: c.persona?.personality ?? [],
      goals: c.persona?.goals ?? [],
      stance: c.persona?.stance ?? '',
      speechStyle: c.persona?.speechStyle ?? '',
      speechHabits: c.persona?.speechHabits ?? [],
      growthArc: c.persona?.growthArc ?? '',
      innerConflict: c.persona?.innerConflict ?? '',
      secrets: c.persona?.secrets ?? [],
      motivations: c.persona?.motivations ?? [],
      appearance: c.persona?.appearance ?? '',
      attributes: c.persona?.attributes,
      skills: c.persona?.skills,
      equipment: c.persona?.equipment,
    } as CharacterPersona,
    currentState: {
      emotion: c.currentState?.emotion ?? '平静',
      location: c.currentState?.location ?? '未知',
      relationships: c.currentState?.relationships ?? {},
      hp: c.currentState?.hp,
      mp: c.currentState?.mp,
      level: c.currentState?.level,
      buffs: c.currentState?.buffs ?? [],
    } as CharacterState,
  }));

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

  onProgress({
    stage: 'characters',
    message: `角色设计完成：${characters.length} 个角色`,
    progress: 75,
    detail: characters.map(c => ({ name: c.name, role: c.role, hasBackstory: !!c.persona.backstory })),
  });

  return characters;
}

// ============================================================
// 阶段 4：拆解剧情节点
// ============================================================
async function buildPlotNodes(
  outline: string,
  worldLore: WorldLore,
  characters: Omit<Character, 'id'>[],
  onProgress: ProgressCallback
): Promise<PlotNode[]> {
  onProgress({
    stage: 'plot-nodes',
    message: '正在拆解剧情节点：开局→转折→高潮→结局…',
    progress: 85,
  });

  const charNames = characters.map(c => c.name).join('、');

  const sysPrompt = `你是 NovelStudio 的剧情架构师，负责把大纲拆解为可演绎的剧情节点。

# 任务
基于大纲和已有角色，生成 5-10 个剧情节点，作为 Director 推进剧情的骨架。

# 角色
${charNames}

# 输出格式（严格 JSON）
\`\`\`json
{
  "plotNodes": [
    {
      "index": 1,
      "title": "节点标题（4-8 字）",
      "description": "节点描述（50-100 字，含戏剧目标和关键事件）",
      "targetTurn": 2,
      "completed": false
    }
  ]
}
\`\`\`

# 拆解原则
1. 第一个节点是"开局铺垫"，最后一个节点是"高潮/结局"
2. 中间节点要有起伏：铺垫→冲突→转折→危机→解决→新冲突
3. targetTurn 间隔 2-4，让每个节点能充分演绎
4. description 要具体，让 Director 知道"这个节点要发生什么"
5. 节点之间要有因果链，不能跳跃

只输出 JSON，不要说明文字。确保 JSON 完整闭合。`;

  const messages: ChatMessage[] = [
    { role: 'system', content: sysPrompt },
    { role: 'user', content: `# 用户大纲\n"""\n${outline}\n"""` },
  ];

  const raw = await chat(messages, { temperature: 0.6, maxTokens: 3000 });
  const parsed = extractJSON<any>(raw);

  if (!parsed || !Array.isArray(parsed.plotNodes)) {
    console.error('[OutlineParser] 剧情节点解析失败，raw:', raw.slice(0, 500));
    // 降级：返回默认节点
    return [
      { index: 1, title: '开场', description: '故事开场', targetTurn: 1, completed: false },
      { index: 2, title: '推进', description: '剧情推进', targetTurn: 4, completed: false },
      { index: 3, title: '高潮', description: '高潮冲突', targetTurn: 8, completed: false },
    ];
  }

  onProgress({
    stage: 'plot-nodes',
    message: `剧情节点拆解完成：${parsed.plotNodes.length} 个节点`,
    progress: 95,
  });

  return parsed.plotNodes.map((n: any, i: number) => ({
    index: n.index ?? i + 1,
    title: n.title ?? `节点${i + 1}`,
    description: n.description ?? '',
    targetTurn: n.targetTurn,
    completed: false,
  }));
}

// ============================================================
// 主函数：流水线编排
// ============================================================
export async function parseOutline(
  outline: string,
  onProgress?: ProgressCallback
): Promise<ParsedOutline> {
  const trimmed = outline.trim();
  if (!trimmed) {
    throw new Error('大纲不能为空');
  }

  const progress = onProgress ?? (() => {});

  console.log(`[OutlineParser] 输入大纲 ${trimmed.length} 字`);

  // 阶段 1：压缩（如需要）
  let workOutline = trimmed;
  if (trimmed.length > LONG_OUTLINE_THRESHOLD) {
    try {
      workOutline = await compressOutline(trimmed, progress);
      if (!workOutline || workOutline.length < 50) {
        throw new Error('压缩后大纲过短');
      }
    } catch (err: any) {
      console.error('[OutlineParser] 压缩失败，降级用原文前 3000 字:', err.message);
      workOutline = trimmed.slice(0, 3000);
    }
  }

  // 阶段 2：构建世界观
  const worldResult = await buildWorldLore(workOutline, progress);

  // 阶段 3：设计角色
  const characters = await buildCharacters(
    workOutline,
    worldResult.worldLore,
    worldResult.templateKey,
    progress
  );

  // 阶段 4：拆解剧情节点
  const plotNodes = await buildPlotNodes(
    workOutline,
    worldResult.worldLore,
    characters,
    progress
  );

  // 阶段 5：组装
  progress({
    stage: 'assembling',
    message: '正在组装 World State 并保存…',
    progress: 98,
  });

  const worldState: WorldState = {
    sceneName: worldResult.initialScene.sceneName,
    sceneDescription: worldResult.initialScene.sceneDescription,
    location: worldResult.initialScene.location,
    timeOfDay: worldResult.initialScene.timeOfDay,
    presentCharacterIds: [], // 后端回填
    worldFlags: {},
    tension: worldResult.initialScene.tension ?? 3,
    turn: 0,
    plotNodes,
    writerHint: worldResult.writerHint,
    worldLore: worldResult.worldLore,
  };

  progress({
    stage: 'done',
    message: `解析完成：${characters.length} 角色 / ${plotNodes.length} 节点 / ${worldResult.worldLore.factions?.length ?? 0} 势力`,
    progress: 100,
  });

  return {
    templateKey: worldResult.templateKey,
    templateReason: worldResult.templateReason,
    worldState,
    characters,
    plotNodes,
    writerHint: worldResult.writerHint,
  };
}

// 兼容旧 API（无进度回调）
export async function parseOutlineSimple(outline: string): Promise<ParsedOutline> {
  return parseOutline(outline);
}
