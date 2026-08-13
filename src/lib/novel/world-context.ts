/**
 * World Context —— 动态生成的“当前世界认知”摘要。
 *
 * 从项目已有的结构化设定（世界观 worldLore、卷阶段、当前场景、世界事实 worldFlags、
 * 最近已发生事件）推导一份“此刻世界处于什么状态”的统一描述，注入给所有 Agent。
 *
 * 设计原则：
 * 1. 不写死任何题材规则——只从项目自身的设定推导，因此换题材、多场景、多世界通用。
 * 2. 是动态的：世界事实（worldFlags）随演绎演进，场景切换时世界认知跟着变。
 * 3. 回答 Agent 的四个问题：此刻在哪、世界处于什么阶段、这个世界有哪些已确立的事实、
 *    此刻角色能感知到什么。
 */

import type { WorldState, WorldLore, VolumePlan } from './types';

function list(items?: string[], limit = 8): string {
  const values = (items ?? []).map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, limit);
  return values.length ? values.map((item) => `- ${item}`).join('\n') : '- 未记录';
}

function compact(value?: string, max = 260): string {
  const text = String(value ?? '').trim();
  if (!text) return '- 未记录';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function activeVolume(volumes: VolumePlan[] | undefined, chapterNo: number): VolumePlan | undefined {
  return volumes?.find((volume) => chapterNo >= volume.chapterStart && chapterNo <= volume.chapterEnd) ??
    volumes?.find((volume) => volume.status === 'active') ??
    volumes?.[0];
}

/**
 * 构建当前世界认知摘要。所有 Agent 在决策前都应先读这份内容，基于同一个“此刻”行动。
 */
export function buildWorldContext(worldState: WorldState): string {
  const chapterNo = worldState.currentChapter?.chapterNo ?? 1;
  const lore: WorldLore | undefined = worldState.worldLore;
  const volume = activeVolume(worldState.longFormPlan?.volumes, chapterNo);
  const flags = worldState.worldFlags ?? {};

  // 当前场景
  const sceneBlock = `# 此刻的场景
- 地点：${worldState.location || '未记录'} · ${worldState.sceneName || ''}
- 时间：${worldState.timeOfDay || '未记录'}
- 场景描述：${compact(worldState.sceneDescription, 300)}`;

  // 世界阶段：从卷阶段推导当前处于什么时期
  const stageBlock = volume
    ? `# 世界所处的阶段
- 当前卷：第 ${volume.index} 卷《${volume.title}》（第 ${volume.chapterStart}-${volume.chapterEnd} 章）
- 卷目标：${compact(volume.purpose, 200)}
- 这一阶段的故事，正处在这个卷所定义的时间窗口里：${compact(volume.purpose, 160)}`
    : `# 世界所处的阶段
- 未定义卷结构。只能依据当前章、人物档案和已发生事件理解世界当前状态，不得自行发明更大阶段的剧情推进。`;

  // 世界已确立的事实：worldFlags 是随演绎演进的世界事实库
  const flagEntries = Object.entries(flags);
  const flagsBlock = flagEntries.length
    ? `# 世界已确立的事实（随演绎演进）
${flagEntries.map(([key, value]) => `- ${key}：${String(value)}`).join('\n')}`
    : `# 世界已确立的事实
- 尚未有跨场景的世界级事实被确立。只能以世界观设定、当前章和已发生事件为准。`;

  // 世界观规则与背景
  const loreRules = lore?.rules?.length ? list(lore.rules, 10) : '- 未定义世界规则';
  const loreBlock = lore
    ? `# 这个世界的规则与背景
- 前提：${compact(lore.premise, 200)}
- 背景：${compact(lore.worldBackground, 400)}
- 时间线：${compact(lore.timeline, 200)}
- 世界规则：
${loreRules}
- 重要地点：
${list(lore.geography, 8)}
- 势力/组织：
${(lore.factions ?? []).slice(0, 6).map((f) => `- ${f.name}（${f.stance}）：${compact(f.description, 100)}`).join('\n') || '- 未记录'}
- 主题：${list(lore.themes, 6)}`
    : `# 这个世界的规则与背景
- 未生成结构化世界观。只能使用当前章、人物档案和剧情节点中已有的信息；不要凭空补势力、组织、神系或终局设定。`;

  return `# 当前世界认知（所有 Agent 决策前先读）
${sceneBlock}

${stageBlock}

${flagsBlock}

${loreBlock}

# 世界认知使用纪律
- 你此刻的行动必须与"世界所处的阶段"和"此刻的场景"一致：这个阶段还没有的东西（组织、设施、制度、技术、怪物、关系）不能凭空出现。
- 世界观里的规则是长期设定，但只有"此刻已发生/已显现"的部分才出现在现场；未来阶段的规则只能作为远景，不能在当下兑现。
- 场景切换、阶段推进、新世界事实确立，都只能由真实发生的剧情事件带来，不能由 Agent 自行宣布。`;
}
