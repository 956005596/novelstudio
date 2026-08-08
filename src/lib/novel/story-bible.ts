import { normalizeLongFormPlan } from './long-form-plan';
import { agentPolicyText } from './agent-policy';
import type { NovelAsset, PlotNode, VolumePlan, WorldLore, WorldState } from './types';

function list(items: string[] | undefined, limit = 8): string {
  const values = (items ?? []).map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, limit);
  return values.length ? values.map((item) => `- ${item}`).join('\n') : '- 未记录';
}

function nodeTypeLabel(node?: PlotNode): string {
  if (!node?.nodeType) return '阶段';
  if (node.nodeType === 'main') return '主线';
  if (node.nodeType === 'sub') return '支线';
  if (node.nodeType === 'foreshadow') return '伏笔';
  return '日常';
}

function nodeLine(node: PlotNode): string {
  const parts = [
    `节点${node.index}`,
    `【${nodeTypeLabel(node)}】`,
    node.title,
    node.description ? `— ${node.description}` : '',
    node.completed ? '（已完成）' : '',
  ];
  return `- ${parts.filter(Boolean).join(' ')}`;
}

function activeVolume(volumes: VolumePlan[], chapterNo: number): VolumePlan | undefined {
  return volumes.find((volume) => chapterNo >= volume.chapterStart && chapterNo <= volume.chapterEnd) ??
    volumes.find((volume) => volume.status === 'active') ??
    volumes[0];
}

function worldLoreText(worldLore?: WorldLore): string {
  if (!worldLore) {
    return `# 世界观总设定
- 未生成结构化世界观。只能使用当前章、人物档案和剧情节点中已经存在的信息；不要凭空补势力、组织、神系或终局设定。`;
  }

  const factions = (worldLore.factions ?? [])
    .slice(0, 6)
    .map((item) => `- ${item.name}（${item.stance}）：${item.description}`)
    .join('\n') || '- 未记录';

  return `# 世界观总设定
前提：${worldLore.premise || '未记录'}
背景：${worldLore.worldBackground || '未记录'}
主题：${(worldLore.themes ?? []).join('、') || '未记录'}
时间线：${worldLore.timeline || '未记录'}
重要地点：
${list(worldLore.geography, 8)}
势力/组织：
${factions}
世界规则：
${list(worldLore.rules, 8)}`;
}

function userStoryBibleNotesText(notes?: string): string {
  const value = String(notes ?? '').trim();
  return `# 用户补充总纲/创作圣经
${value || '- 未补充。不得自行补写卷名、终局、神系、势力结构或关键历史。'}`;
}

const assetCategoryLabels: Record<string, string> = {
  talent: '天赋',
  profession: '职业',
  skill: '技能',
  equipment: '装备',
  pet_mount: '宠物/坐骑',
  monster_dungeon: '怪物/副本',
  drop_resource: '掉落/资源',
  faction_location: '势力/地点',
  foreshadow: '伏笔/谜题',
};

const assetStatusLabels: Record<string, string> = {
  concept: '概念',
  foreshadow: '可伏笔',
  available: '剧情可调度',
  landed: '已落地',
  disabled: '禁用/废弃',
};

function assetLine(asset: NovelAsset): string {
  const category = assetCategoryLabels[asset.category] ?? asset.category;
  const status = assetStatusLabels[asset.status] ?? asset.status;
  const grade = asset.grade ? `；品级=${asset.grade}` : '';
  const chapter = typeof asset.chapterNo === 'number' ? `；参考阶段=第${asset.chapterNo}章附近` : '';
  const triggers = asset.triggerConditions?.length ? `；触发条件=${asset.triggerConditions.slice(0, 4).join('、')}` : '';
  const mechanics = asset.mechanics ? `；机制=${asset.mechanics.slice(0, 240)}` : '';
  const rules = asset.rules?.length ? `；规则/限制=${asset.rules.slice(0, 3).join('、')}` : '';
  const linked = asset.linkedCharacters?.length ? `；可能牵涉=${asset.linkedCharacters.slice(0, 4).join('、')}` : '';
  return `- 【${category}/${status}】${asset.name}${grade}${chapter}：${asset.summary || '未写摘要'}；剧情用途=${asset.plotUse || '待补充'}${mechanics}${triggers}${rules}${linked}`;
}

function assetLibraryText(worldState: WorldState): string {
  const assets = (worldState.assetLibrary ?? []).filter((asset) => asset.status !== 'disabled');
  if (!assets.length) {
    return `# 创作资产库
- 未建立。涉及天赋、职业、技能、装备、宠物/坐骑、副本、掉落、势力和伏笔时，只能使用当前总纲/人物档案/正文已经确认的信息，不要临时乱编长期体系。`;
  }
  const current = assets.filter((asset) =>
    asset.status === 'landed' ||
    asset.status === 'available' ||
    asset.status === 'foreshadow'
  );
  const future = assets
    .filter((asset) => !current.includes(asset))
    .slice(0, 12);

  return `# 创作资产库
剧情可调度/可伏笔/已落地：
${current.length ? current.map(assetLine).join('\n') : '- 无。若需要新体系素材，先在素材库建概念，再由剧情事件触发。'}

后续资产预备（只可远景伏笔，不可直接兑现）：
${future.length ? future.map(assetLine).join('\n') : '- 无'}

资产库纪律：
- 素材库不是章节排班表；参考阶段和可能牵涉对象都不是强制绑定。
- 天赋、装备、宠物、职业等只有在角色相遇、检测、战斗、交易、掉落、任务、误判等剧情触发后，才能被描写出来。
- 品级、等级、职业、装备阶梯、魔法境界、科技代际、怪物强度、感情阶段、案件线索等级等体系，只能采用本项目创作圣经或素材库中已经定义的版本；产品层不提供默认体系。
- 没有项目品级/品阶定义的素材只能当灵感，不能直接作为奖励、能力、身份或世界事实发放。
- 高阶素材必须体现该体系的独特命题、限制、代价、触发条件和剧情用途，不要只写更高数值。
- 怪物、副本、敌人、案件、商业危机、恋爱障碍、修炼瓶颈等阻力的爽点应来自机制、谜题、选择、误判、代价、关系压力和反馈，不要只变成更厚血条或更大麻烦。
- 成长、奖励、升级、转职、告白、破案、晋升、突破、装备获得等正反馈必须来自已确认事件和角色贡献；不能因为角色想要、剧情需要或设计讨论就凭空到账。
- 如果项目是游戏/网游题材，经验、等级、首杀、掉落、职业、复活等必须遵守本项目创作圣经；如果项目不是游戏题材，不要自动引入面板、等级、职业或系统公告。
- “概念/可伏笔”不是角色已拥有，不得写进人物能力栏。
- “剧情可调度”也必须通过事件、选择、代价或争夺落地，不能凭空发放。
- “已落地”才能进入人物档案、世界事实和后续正典。`;
}

export function storyBibleText(
  worldState: WorldState,
  options: {
    futureNodeLimit?: number;
    includeWorldLore?: boolean;
  } = {}
): string {
  const chapter = worldState.currentChapter;
  const chapterNo = chapter?.chapterNo ?? 1;
  const activeIndexes = new Set(chapter?.activeNodeIndexes ?? []);
  const nodes = worldState.plotNodes ?? [];
  const activeNodes = nodes.filter((node) =>
    activeIndexes.size > 0 ? activeIndexes.has(node.index) : !node.completed
  );
  const futureNodes = nodes
    .filter((node) =>
      activeIndexes.size > 0 ? !activeIndexes.has(node.index) && !node.completed : !node.completed
    )
    .slice(0, options.futureNodeLimit ?? 8);
  const plan = normalizeLongFormPlan(worldState.longFormPlan);
  const volume = activeVolume(plan.volumes, chapterNo);
  const volumeText = volume
    ? `当前卷：第 ${volume.index} 卷《${volume.title}》（第 ${volume.chapterStart}-${volume.chapterEnd} 章）
卷目标：${volume.purpose}
卷内节点：${volume.nodeIndexes.length ? volume.nodeIndexes.join('、') : '未绑定'}`
    : `当前卷：未生成。卷名、卷目标和剧情阶段必须由用户大纲/规划 Agent 产生，Director 和剧情设计师不得自行补写。`;

  return `${userStoryBibleNotesText(worldState.storyBibleNotes)}\n\n${agentPolicyText(worldState)}\n\n${assetLibraryText(worldState)}\n\n${options.includeWorldLore === false ? '' : `${worldLoreText(worldState.worldLore)}\n\n`}# 全局创作圣经
目标体量：${plan.minWords ? `最低 ${Math.round(plan.minWords / 10000)} 万字，` : ''}目标 ${Math.round(plan.targetWords / 10000)} 万字 / 约 ${plan.targetChapters} 章
单章容量：${plan.chapterWordMin}-${plan.chapterWordMax} 字
长篇承诺：${plan.promise}
${volumeText}

# 当前章绑定节点（只能推进这些）
${activeNodes.length ? activeNodes.map(nodeLine).join('\n') : '- 当前章没有绑定节点，只能按本章节拍推进。'}

# 后续节点（只可伏笔，不可兑现）
${futureNodes.length ? futureNodes.map(nodeLine).join('\n') : '- 无'}

# 总纲执行纪律
${list(plan.pacingPrinciples, 8)}
- 用户补充总纲的优先级高于自动长篇规划；但不得悄悄覆盖已经落地的当前章正文事实，除非用户明确要求重写。
- 当前章只落当前章目标；后续节点最多作为一句伏笔、环境压力或读者预期，不得成为当前场景主事件。
- 如果用户指令与旧事件日志/旧设计冲突，用户指令和当前章正文优先；旧演绎只能作为历史素材。`;
}
