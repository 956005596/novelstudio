/**
 * Outline Parser Agent (v2 — 多步流水线)
 *
 * 把用户输入的大纲解析为丰满的演绎世界，支持 100w+ 字长篇。
 *
 * 流水线（每步独立 LLM 调用，避免单次输出截断）：
 *   1. readOutline       — 完整读取用户大纲，不做有损压缩或截断
 *   2. buildWorldLore    — 构建世界观设定（背景/势力/地理/规则/主题）
 *   3. buildCharacters   — 设计角色深度档案（背景/成长弧线/内在冲突/秘密）
 *   4. buildPlotNodes    — 拆解剧情节点
 *   5. buildLongFormPlan — 根据用户大纲生成长篇卷结构
 *   6. assembleWorldState — 组装初始 World State
 *
 * 每步通过 onProgress 回调上报进度，前端实时显示。
 */

import { chat, extractJSON, type ChatMessage } from '../llm';
import type {
  Character,
  CharacterPersona,
  CharacterState,
  LongFormPlan,
  PlotNode,
  WorldLore,
  WorldState,
} from '../types';
import {
  LONG_FORM_MIN_WORDS,
  LONG_FORM_TARGET_CHAPTERS,
  LONG_FORM_TARGET_WORDS,
  buildEmptyLongFormPlan,
  normalizeLongFormPlan,
} from '../long-form-plan';
import {
  CHAPTER_WORD_TARGET_MAX,
  CHAPTER_WORD_TARGET_MIN,
} from '../chapter-policy';
import { expRequiredForNextLevel } from '../progression';

const PARSE_MAX_TOKENS = 8000;

export type ProgressStage =
  | 'reading-outline' // 完整读取用户大纲
  | 'world-lore'      // 构建世界观
  | 'characters'      // 设计角色
  | 'plot-nodes'      // 拆解剧情节点
  | 'long-form-plan'  // 生成长篇卷结构
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
// 阶段 2：构建世界观设定
// ============================================================
export async function buildWorldLore(
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
基于用户大纲，生成详细的世界观档案。这是 100w+ 字长篇的背景支撑，要够丰满。

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
- initialScene 必须是小说时间线上最早的实际开场，不是故事简介里最刺激的事件；若第 1 章发生在觉醒、灾变、穿越、案件或关系转折之前，开场必须停在转折之前，只允许埋征兆
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
// 阶段 3：设计角色深度档案（带截断重试）
// ============================================================
async function buildCharacters(
  outline: string,
  worldLore: WorldLore,
  initialScene: { sceneName: string; sceneDescription: string; location: string; timeOfDay: string },
  templateKey: string,
  onProgress: ProgressCallback
): Promise<Omit<Character, 'id'>[]> {
  onProgress({
    stage: 'characters',
    message: '正在设计角色深度档案：背景故事、成长弧线、内在冲突、秘密…',
    progress: 55,
  });

  const sysPrompt = buildCharacterPrompt(worldLore, initialScene, templateKey);
  const messages: ChatMessage[] = [
    { role: 'system', content: sysPrompt },
    { role: 'user', content: `# 用户大纲\n"""\n${outline}\n"""` },
  ];

  let raw = '';
  let parsed: any = null;
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      onProgress({
        stage: 'characters',
        message: attempts === 1
          ? '正在设计角色深度档案…'
          : `角色设计第 ${attempts} 次尝试（上次输出被截断，精简重试）…`,
        progress: 55,
      });

      // 第二次起用精简 prompt
      const useMessages: ChatMessage[] = attempts === 1 ? messages : [
        { role: 'system', content: buildCharacterPrompt(worldLore, initialScene, templateKey, true) },
        { role: 'user', content: `# 用户大纲\n"""\n${outline}\n"""` },
      ];

      raw = await chat(useMessages, { temperature: 0.7, maxTokens: PARSE_MAX_TOKENS });
      parsed = extractJSON<any>(raw);

      if (parsed && Array.isArray(parsed.characters) && parsed.characters.length > 0) {
        break; // 成功
      }

      console.warn(`[OutlineParser] 角色解析第 ${attempts} 次失败，raw 长度 ${raw.length}`);
    } catch (err: any) {
      console.error(`[OutlineParser] 角色设计第 ${attempts} 次 LLM 错误:`, err.message);
      if (attempts === maxAttempts) throw err;
    }
  }

  if (!parsed || !Array.isArray(parsed.characters) || parsed.characters.length === 0) {
    console.error('[OutlineParser] 角色解析最终失败，raw 前 500 字:', raw.slice(0, 500));
    throw new Error('角色设计失败，请重试');
  }

  const characters: Omit<Character, 'id'>[] = parsed.characters.map((c: any) => ({
    name: c.name ?? '未命名角色',
    role: c.role ?? 'npc',
    persona: {
      gender: c.persona?.gender ?? c.persona?.性别 ?? '',
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
      skills: c.persona?.skills ?? [],
      equipment: c.persona?.equipment ?? [],
      talents: c.persona?.talents ?? [],
      mounts: c.persona?.mounts ?? [],
      pets: c.persona?.pets ?? [],
      inventory: c.persona?.inventory ?? [],
      titles: c.persona?.titles ?? [],
      profession: c.persona?.profession,
    } as CharacterPersona,
    currentState: {
      emotion: c.currentState?.emotion ?? '平静',
      location: c.currentState?.location ?? '未知',
      relationships: c.currentState?.relationships ?? {},
      hp: c.currentState?.hp,
      mp: c.currentState?.mp,
      level: c.currentState?.level,
      exp: c.currentState?.exp ?? 0,
      nextLevelExp: c.currentState?.nextLevelExp ?? expRequiredForNextLevel(c.currentState?.level),
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

function buildCharacterPrompt(
  worldLore: WorldLore,
  initialScene: { sceneName: string; sceneDescription: string; location: string; timeOfDay: string },
  templateKey: string,
  simplified = false
): string {
  const loreContext = `# 世界观背景（角色要与此契合）
${worldLore.worldBackground}

# 小说实际开场（所有 currentState 和当前持有物必须停在这个时刻）
${initialScene.sceneName}｜${initialScene.location}｜${initialScene.timeOfDay}
${initialScene.sceneDescription}

世界观档案和长线大纲可以写未来，但人物的 currentState、goals、skills、equipment、talents、inventory、relationships 只能写这个开场时刻已经发生、已经拥有、已经认识的内容。`;

  if (simplified) {
    // 精简版：减少字段要求，确保输出完整
    return `你是 NovelStudio 的角色设计师。基于大纲和世界观，设计 2-3 个核心角色。

${loreContext}

# 输出格式（严格 JSON，确保完整闭合）
\`\`\`json
{
  "characters": [
    {
      "name": "角色名",
      "role": "protagonist" | "antagonist" | "npc",
      "persona": {
        "background": "当前已知身份/处境，不写未来觉醒、神器、终局身份",
        "gender": "男/女/其他/未知，用户大纲明确时必须照抄",
        "backstory": "作者侧背景备注（100-150 字，不给角色当已知事实）",
        "personality": ["性格1", "性格2"],
        "goals": ["当前可感知、可执行的目标"],
        "stance": "当前阶段立场，不写未来阵营",
        "speechStyle": "说话风格",
        "growthArc": "作者侧长线成长备注（50 字，不等于已发生）",
        "innerConflict": "当前已显露的内在冲突；没有就留空",
        "secrets": ["作者侧伏笔；若当前未揭露可留空"],
        "motivations": ["表层", "深层"],
        ${templateKey === 'online-game' ? '"attributes": {"力量": 20},\n        "skills": [],\n        "equipment": [],\n        "talents": [],\n        "inventory": [],' : ''}
        "appearance": "外貌"
      },
      "currentState": {
        "emotion": "情绪",
        "location": "位置",
        "relationships": {"另一角色": {"value": 10, "note": "同学/同校/初识；不要预设战友或队友"}},
        ${templateKey === 'online-game' ? '"hp": 100, "mp": 50, "level": 1, "exp": 0, "nextLevelExp": 100,' : ''}
        "buffs": []
      }
    }
  ]
}
\`\`\`

只输出 JSON，不要说明。确保 JSON 完整闭合，最后一个字符必须是 \`}\`。`;
  }

  return `你是 NovelStudio 的角色设计师，负责为长篇小说设计丰满的角色档案。

# 任务
基于大纲和世界观，设计 2-4 个核心角色。每个角色都要有深度，不能扁平化。

# 当前风格模板：${templateKey}
${templateKey === 'online-game'
    ? '网游模板：必须有 attributes。skills/equipment/talents/inventory 只写开局已经真实拥有且可使用的内容；后续觉醒、王器、转职、专属技能、打怪掉落不要预先写进角色卡，必须留给演绎过程动态获得。'
    : '通用模板：可省略 attributes/skills/equipment'}

${loreContext}

# 输出格式（严格 JSON）
\`\`\`json
{
  "characters": [
    {
      "name": "角色名",
      "role": "protagonist" | "antagonist" | "npc",
      "persona": {
        "background": "当前已知身份/处境（一句话）。不要写未来觉醒、未来能力、核心道具、幕后真相、终局身份或最终关系等未发生内容",
        "gender": "男/女/其他/未知，用户大纲明确时必须照抄",
        "backstory": "作者侧背景备注（200-300 字，包括身世/关键经历；不等于角色当前已知事实）",
        "personality": ["性格1", "性格2", "性格3"],
        "goals": ["当前章节可感知、可执行的短期目标", "近期目标；不要写终局目标"],
        "stance": "当前阶段立场和价值观（一句话），不要写未来阵营或终局对立",
        "speechStyle": "说话风格（一句话）",
        "speechHabits": ["口头禅1"],
        "growthArc": "作者侧长线成长备注：从X到Y，经历什么转变（80-150 字；不驱动当前演员）",
        "innerConflict": "当前已显露或可合理推断的内在冲突；没有就留空",
        "secrets": ["作者侧伏笔；若当前未揭露可留空，不要让角色知道"],
        "motivations": ["表层动机", "深层动机"],
        "appearance": "外貌特征（50 字内）",
        "attributes": {"力量": 20, "敏捷": 15},
        "skills": ["开局已掌握且现在能使用的技能；没有就留空"],
        "equipment": ["开局真实持有的装备；没有就留空"],
        "talents": ["开局已经公开或被本人确认的天赋；未知就留空"],
        "inventory": ["当前随身物；没有就留空"]
      },
      "currentState": {
        "emotion": "初始情绪",
        "location": "初始位置",
        "relationships": {
          "另一角色名": {"value": 10, "note": "同学/同校/初识/不熟；只有大纲明确才写旧识，不要预设战友或队友"}
        },
        "hp": 100,
        "mp": 50,
        "level": 1,
        "exp": 0,
        "nextLevelExp": 100,
        "buffs": []
      }
    }
  ]
}
\`\`\`

# 设计原则
1. **当前档案优先**：background/goals/stance 是演员当前会读取的行动依据，只能放开局已知事实，不放未来剧情。
2. **冲突优先**：角色之间可以有性格、利益、阶层或信息差张力，但第一章不要预设已经成队。
3. **深度**：backstory/growthArc/secrets 是作者侧备注，用于长篇追踪，不代表角色当前知道或已经发生。
4. **成长空间**：growthArc 要明确，让角色在 100w+ 字里有变化，但不要把结局直接写成当前目标。
5. **关系网**：relationships 必须符合开局事实；同班/同校通常 -5 到 +20，互救后才逐步升高，不能一开始就是战友/队友。
6. **不扁平**：反派也要有合理动机，不要纯粹恶
7. **不预设掉落**：不要提前列出未来技能、未来装备、未来天赋、未来坐骑、未来称号；这些必须通过后续演绎事件动态写入。

只输出 JSON，不要说明文字。确保 JSON 完整闭合。`;
}

// ============================================================
// 阶段 4：拆解剧情节点（网状结构：主线+支线+伏笔+日常）
// ============================================================
async function buildPlotNodes(
  outline: string,
  worldLore: WorldLore,
  characters: Omit<Character, 'id'>[],
  onProgress: ProgressCallback
): Promise<PlotNode[]> {
  onProgress({
    stage: 'plot-nodes',
    message: '正在拆解网状剧情：主线 + 支线 + 伏笔 + 日常缓冲…',
    progress: 85,
  });

  const charNames = characters.map(c => c.name).join('、');
  const factionsCount = worldLore.factions?.length ?? 0;
  const geographyCount = worldLore.geography?.length ?? 0;

  const sysPrompt = `你是 NovelStudio 的剧情架构师，负责为 100w+ 字长篇小说构建网状剧情结构。

# 任务
基于大纲、世界观和角色，生成 **48-72 个阶段剧情节点**，形成网状叙事结构，支撑 100w+ 长篇连载。每个节点不是一章，而是可支撑 3-8 章的阶段任务。

# 角色
${charNames}

# 世界观要素
- ${factionsCount} 个势力（可作支线来源）
- ${geographyCount} 个地点（可作场景切换）
- 主题：${worldLore.themes?.join('、') ?? '未明确'}

# 节点类型（必须混搭，不能全是主线）
1. **main（主线）**：12-18 个，必经剧情，priority 5，estimatedTurns 8-15
2. **sub（支线）**：18-28 个，角色个人线/势力博弈/世界事件，priority 3-4，estimatedTurns 4-8
3. **foreshadow（伏笔）**：10-16 个，埋线索/暗示/悬念，priority 2-3，estimatedTurns 2-4
4. **daily（日常缓冲）**：8-12 个，关系戏/休息/世界观展示，priority 1，estimatedTurns 2-4

# 节奏原则（100w+ 字长篇）
- **慢热**：前 5 个 Turn 不要推进主线，先日常+伏笔铺垫
- **起伏**：高潮段（main 高 tension）后必接缓冲段（daily 低 tension）
- **交织**：主线:支线 ≈ 1:2，每个主线节点前后穿插支线
- **悬念**：每 3-5 个节点埋一个伏笔，后续节点回收
- **角色线**：每个主要角色至少 1 条个人支线
- **大纲来源**：节点标题和描述必须来自用户大纲、世界观和角色关系；信息不足时写功能性标题，不得凭空补终局设定

# 输出格式（严格 JSON）
\`\`\`json
{
  "plotNodes": [
    {
      "index": 1,
      "title": "节点标题（4-8 字）",
      "description": "节点描述（80-150 字，含戏剧目标和关键事件）",
      "nodeType": "main" | "sub" | "foreshadow" | "daily",
      "priority": 1-5,
      "estimatedTurns": 2-15,
      "targetTurn": 2,
      "linkedCharacters": ["角色名1", "角色名2"],
      "tensionLevel": 0-10,
      "subNodes": ["子阶段1", "子阶段2"],
      "completed": false
    }
  ]
}
\`\`\`

# 排序原则
- 按 targetTurn 升序排列
- 第一个节点通常是 daily 或 foreshadow（铺垫）
- 主线节点均匀分布，不要扎堆
- 伏笔节点要在对应回收主线之前

只输出 JSON，不要说明文字。确保 JSON 完整闭合。`;

  const messages: ChatMessage[] = [
    { role: 'system', content: sysPrompt },
    { role: 'user', content: `# 用户大纲\n"""\n${outline}\n"""` },
  ];

  const raw = await chat(messages, { temperature: 0.7, maxTokens: 5000 });
  const parsed = extractJSON<any>(raw);

  if (!parsed || !Array.isArray(parsed.plotNodes)) {
    console.error('[OutlineParser] 剧情节点解析失败，raw:', raw.slice(0, 500));
    // 降级：返回基础网状节点
    return buildFallbackPlotNodes();
  }

  const nodes: PlotNode[] = parsed.plotNodes.map((n: any, i: number) => ({
    index: n.index ?? i + 1,
    title: n.title ?? `节点${i + 1}`,
    description: n.description ?? '',
    nodeType: n.nodeType ?? 'main',
    priority: n.priority ?? 3,
    estimatedTurns: n.estimatedTurns ?? 5,
    targetTurn: n.targetTurn,
    linkedCharacters: n.linkedCharacters ?? [],
    tensionLevel: n.tensionLevel ?? 5,
    subNodes: n.subNodes ?? [],
    completed: false,
  }));

  // 按 targetTurn 排序
  nodes.sort((a, b) => (a.targetTurn ?? 0) - (b.targetTurn ?? 0));
  // 重建 index
  nodes.forEach((n, i) => { n.index = i + 1; });

  onProgress({
    stage: 'plot-nodes',
    message: `网状剧情拆解完成：${nodes.length} 个节点（主线 ${nodes.filter(n => n.nodeType === 'main').length} / 支线 ${nodes.filter(n => n.nodeType === 'sub').length} / 伏笔 ${nodes.filter(n => n.nodeType === 'foreshadow').length} / 日常 ${nodes.filter(n => n.nodeType === 'daily').length}）`,
    progress: 95,
  });

  return nodes;
}

/** 降级节点生成（当 LLM 失败时） */
function buildFallbackPlotNodes(): PlotNode[] {
  return [
    { index: 1, title: '日常基线', description: '建立旧秩序、主角处境和核心关系，让读者知道灾变前的常态。', nodeType: 'daily', priority: 1, estimatedTurns: 3, targetTurn: 1, tensionLevel: 2, completed: false },
    { index: 2, title: '异常压近', description: '用环境、舆论或小范围异常埋下变化前兆，但不直接解释完整体系。', nodeType: 'foreshadow', priority: 2, estimatedTurns: 3, targetTurn: 4, tensionLevel: 3, completed: false },
    { index: 3, title: '主线启动', description: '第一场不可逆事件打破常态，角色被迫做出当前能力范围内的选择。', nodeType: 'main', priority: 5, estimatedTurns: 10, targetTurn: 8, tensionLevel: 6, completed: false },
    { index: 4, title: '关系成队', description: '通过危机后的分歧、互救或利益交换，让核心人物形成初始关系网。', nodeType: 'sub', priority: 3, estimatedTurns: 6, targetTurn: 18, tensionLevel: 5, completed: false },
    { index: 5, title: '规则初显', description: '展示世界规则的一角，并让角色因信息差付出代价或获得阶段性认知。', nodeType: 'foreshadow', priority: 3, estimatedTurns: 4, targetTurn: 26, tensionLevel: 4, completed: false },
    { index: 6, title: '初始危机', description: '让第一阶段矛盾集中爆发，解决局部问题，同时留下更大范围的问题。', nodeType: 'main', priority: 5, estimatedTurns: 12, targetTurn: 34, tensionLevel: 7, completed: false },
    { index: 7, title: '区域扩展', description: '把视野从初始场景扩展到更大的区域、势力或资源竞争。', nodeType: 'sub', priority: 4, estimatedTurns: 8, targetTurn: 48, tensionLevel: 6, completed: false },
    { index: 8, title: '阶段收束', description: '完成第一阶段目标，回收部分小伏笔，同时保留长线谜团。', nodeType: 'main', priority: 5, estimatedTurns: 10, targetTurn: 60, tensionLevel: 8, completed: false },
  ];
}

// ============================================================
// 阶段 5：根据用户大纲生成长篇卷结构
// ============================================================
async function buildLongFormPlan(
  outline: string,
  worldLore: WorldLore,
  characters: Omit<Character, 'id'>[],
  plotNodes: PlotNode[],
  onProgress: ProgressCallback
): Promise<LongFormPlan> {
  onProgress({
    stage: 'long-form-plan',
    message: '正在根据用户大纲生成 100w+ 长篇规划：卷结构、容量、阶段目标…',
    progress: 96,
  });

  const charNames = characters.map((c) => c.name).join('、') || '未明确';
  const nodeBrief = plotNodes
    .slice(0, 72)
    .map((node) => `${node.index}. ${node.title}（${node.nodeType ?? 'main'}）：${node.description}`)
    .join('\n');

  const sysPrompt = `你是 NovelStudio 的“长篇总纲规划 Agent”。

# 任务
根据用户大纲、世界观、角色和剧情节点，生成 100w+ 字长篇规划。你是执行层，不是开发者；卷名、卷目标和剧情阶段必须从用户输入中判断，不能使用开发者预设剧情。

# 硬约束
- 目标体量：至少 ${Math.round(LONG_FORM_MIN_WORDS / 10000)} 万字，建议 ${Math.round(LONG_FORM_TARGET_WORDS / 10000)} 万字以上
- 目标章节：约 350-450 章，默认 ${LONG_FORM_TARGET_CHAPTERS} 章
- 单章正文：${CHAPTER_WORD_TARGET_MIN}-${CHAPTER_WORD_TARGET_MAX} 字
- 规划 8-12 卷，每卷 30-60 章
- plotNodes 是阶段骨架，不是一章一个节点
- 卷名、卷目标、阶段承诺必须来自用户大纲/世界观/角色关系
- 如果大纲信息不足，卷名使用功能性标题，如“第一阶段：开局危机”，purpose 写明“待用户补充”，不得凭空发明终局、大反派、神话体系或道具

# 输出 JSON，不要 markdown
{
  "targetWords": 1000000,
  "minWords": 1000000,
  "targetChapters": 400,
  "chapterWordMin": ${CHAPTER_WORD_TARGET_MIN},
  "chapterWordMax": ${CHAPTER_WORD_TARGET_MAX},
  "volumes": [
    {
      "index": 1,
      "title": "卷名或功能性阶段名",
      "purpose": "本卷阶段目标、主要矛盾、要保留的长线悬念",
      "chapterStart": 1,
      "chapterEnd": 45,
      "nodeIndexes": [1, 2, 3],
      "status": "active"
    }
  ],
  "promise": "这本书如何支撑 100w+ 字，而不是十章收束",
  "pacingPrinciples": ["节奏原则1", "节奏原则2"]
}`;

  const messages: ChatMessage[] = [
    { role: 'system', content: sysPrompt },
    {
      role: 'user',
      content: `# 用户大纲\n"""\n${outline}\n"""\n\n# 世界观\n${worldLore.worldBackground}\n\n# 主要角色\n${charNames}\n\n# 剧情阶段节点\n${nodeBrief}`,
    },
  ];

  try {
    const raw = await chat(messages, { temperature: 0.65, maxTokens: 5000 });
    const parsed = extractJSON<Partial<LongFormPlan>>(raw);
    const plan = normalizeLongFormPlan(parsed);

    onProgress({
      stage: 'long-form-plan',
      message: plan.volumes.length
        ? `长篇规划完成：${plan.volumes.length} 卷 / 约 ${plan.targetChapters} 章`
        : '长篇规划未产出卷结构，已保留容量规则，等待补充大纲后再生成',
      progress: 97,
      detail: {
        targetChapters: plan.targetChapters,
        volumeCount: plan.volumes.length,
        volumes: plan.volumes.map((v) => ({ index: v.index, title: v.title, chapterStart: v.chapterStart, chapterEnd: v.chapterEnd })),
      },
    });

    return plan;
  } catch (err: any) {
    console.warn('[OutlineParser] 长篇规划生成失败，使用空规划:', err.message);
    return buildEmptyLongFormPlan();
  }
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

  // 阶段 1：完整读取用户大纲。这里不能压缩或截断，否则会丢失长篇规划和后续卷信息。
  const workOutline = trimmed;
  progress({
    stage: 'reading-outline',
    message: `正在读取完整大纲（${trimmed.length} 字），不会压缩或截断…`,
    progress: 5,
  });

  // 阶段 2：构建世界观
  const worldResult = await buildWorldLore(workOutline, progress);

  // 阶段 3：设计角色
  const characters = await buildCharacters(
    workOutline,
    worldResult.worldLore,
    worldResult.initialScene,
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

  const longFormPlan = await buildLongFormPlan(
    workOutline,
    worldResult.worldLore,
    characters,
    plotNodes,
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
    longFormPlan,
    writerHint: worldResult.writerHint,
    worldLore: worldResult.worldLore,
    pacingMode: 'slow',            // 默认慢热模式（100w+ 字长篇）
    currentMainNodeIndex: 0,
    turnsSinceLastMain: 0,
  };

  progress({
    stage: 'done',
    message: `解析完成：${characters.length} 角色 / ${plotNodes.length} 节点 / ${longFormPlan.volumes.length} 卷规划 / ${worldResult.worldLore.factions?.length ?? 0} 势力`,
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
