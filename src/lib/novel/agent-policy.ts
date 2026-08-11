import type { AgentPolicy, WorldState } from './types';

export const DEFAULT_AGENT_POLICY: AgentPolicy = {
  directorCanIntervene: true,
  directorCanPatchScene: true,
  directorCanUpdateCharacters: true,
  directorCanProposeOutline: true,
  directorCanAutoApplyOutline: false,
  designerCanPlanCurrentChapter: true,
  auditorCanBlockDrift: true,
  writerCanOnlyUseEvents: true,
  directorMode: 'balanced',
  genreAdaptation: 'genre_aware',
  actorImmersionLevel: 4,
  actorAutonomy: 'balanced',
  actorMemoryScope: 'canon_plus_current',
  actorTemperature: 0.9,
  directorCustomBrief: '',
  designerCustomBrief: '',
  actorCustomBrief: '',
  writerCustomBrief: '',
  auditorCustomBrief: '',
};

export function normalizeAgentPolicy(policy?: Partial<AgentPolicy> | null): AgentPolicy {
  const actorImmersionLevel = Number(policy?.actorImmersionLevel ?? DEFAULT_AGENT_POLICY.actorImmersionLevel);
  return {
    ...DEFAULT_AGENT_POLICY,
    ...(policy ?? {}),
    directorMode: normalizeChoice(policy?.directorMode, ['character_led', 'balanced', 'plot_led'] as const, DEFAULT_AGENT_POLICY.directorMode),
    genreAdaptation: normalizeChoice(policy?.genreAdaptation, ['universal', 'genre_aware'] as const, DEFAULT_AGENT_POLICY.genreAdaptation),
    actorImmersionLevel: ([1, 2, 3, 4, 5].includes(actorImmersionLevel) ? actorImmersionLevel : DEFAULT_AGENT_POLICY.actorImmersionLevel) as 1 | 2 | 3 | 4 | 5,
    actorAutonomy: normalizeChoice(policy?.actorAutonomy, ['reactive', 'balanced', 'proactive'] as const, DEFAULT_AGENT_POLICY.actorAutonomy),
    actorMemoryScope: normalizeChoice(policy?.actorMemoryScope, ['strict_current', 'canon_plus_current', 'deep_profile'] as const, DEFAULT_AGENT_POLICY.actorMemoryScope),
    actorTemperature: normalizeTemperature(policy?.actorTemperature, DEFAULT_AGENT_POLICY.actorTemperature ?? 0.9),
    directorCustomBrief: normalizeText(policy?.directorCustomBrief),
    designerCustomBrief: normalizeText(policy?.designerCustomBrief),
    actorCustomBrief: normalizeText(policy?.actorCustomBrief),
    writerCustomBrief: normalizeText(policy?.writerCustomBrief),
    auditorCustomBrief: normalizeText(policy?.auditorCustomBrief),
  };
}

function normalizeChoice<T extends string>(value: unknown, allowed: readonly T[], fallback: T | undefined): T {
  return allowed.includes(value as T) ? value as T : (fallback ?? allowed[0]);
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 1200) : '';
}

function normalizeTemperature(value: unknown, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(1.2, Math.max(0.4, num));
}

function directorModeLabel(value: AgentPolicy['directorMode']): string {
  if (value === 'character_led') return '角色驱动';
  if (value === 'plot_led') return '剧情强控';
  return '平衡';
}

function actorAutonomyLabel(value: AgentPolicy['actorAutonomy']): string {
  if (value === 'reactive') return '响应式';
  if (value === 'proactive') return '主动式';
  return '平衡';
}

function actorMemoryScopeLabel(value: AgentPolicy['actorMemoryScope']): string {
  if (value === 'strict_current') return '仅当前已知';
  if (value === 'deep_profile') return '深读人物档案';
  return '正典加当前';
}

function optionalLine(title: string, value?: string): string {
  const text = normalizeText(value);
  return text ? `- ${title}：${text}` : '';
}

export function agentPolicyText(worldState: WorldState): string {
  const policy = normalizeAgentPolicy(worldState.agentPolicy);
  const on = (value: boolean) => (value ? '开启' : '关闭');
  return `# 产品级 Agent 配置
这是 NovelStudio 的通用 Agent 层，不携带任何单本小说设定。具体世界观、等级、神话、职业、科技、悬疑规则、恋爱关系等，必须来自本项目的用户补充总纲、世界观、素材库、人物档案、剧情节点、事件日志和已定正稿。

岗位权限：
- Director：章节总导演，负责调度角色、纠偏演绎、注入事件和维护已发生事实。跑偏干预=${on(policy.directorCanIntervene)}；场景补丁=${on(policy.directorCanPatchScene)}；人物档案归档=${on(policy.directorCanUpdateCharacters)}；调度模式=${directorModeLabel(policy.directorMode)}。
- 剧情设计师：当前章拍点、事件刺激、设定护栏和题材玩法设计者。当前章设计=${on(policy.designerCanPlanCurrentChapter)}；题材适配=${policy.genreAdaptation === 'genre_aware' ? '读取项目题材语法' : '保持通用'}；不能自行改全书正典，只能提出可确认提案。
- 纲要规划：章节名、当前章细纲、剧情节点、卷规划和正典补丁必须走纲要调整提案。Director 可提出纲要提案=${on(policy.directorCanProposeOutline)}；自动应用纲要=${on(policy.directorCanAutoApplyOutline)}。
- 设定审核：负责阻止信息越界、旧稿污染、能力凭空到账、人物硬设漂移和项目规则冲突。审核阻断=${on(policy.auditorCanBlockDrift)}。
- Writer：负责把事件日志写成正文。只使用已发生事件=${on(policy.writerCanOnlyUseEvents)}；不得借写作直接推进未演绎的大节点。
- 演员 Agent：沉浸深度=${policy.actorImmersionLevel}/5；自主性=${actorAutonomyLabel(policy.actorAutonomy)}；记忆边界=${actorMemoryScopeLabel(policy.actorMemoryScope)}。

产品纪律：
- Agent 必须先识别项目题材，再使用该题材的爽点、节奏和读者期待；不要把某一本书的等级、深渊、系统、王座、都市、恋综、刑侦或仙侠规则当作产品默认。
- 具体设定只在项目上下文中生效；如果项目没有写，就不要替作者发明终局、神系、幕后势力、职业树、科技层级或感情归宿。
- 角色演员要成为角色本人：只根据角色当下能感知、能理解、会在意的信息行动。作者侧伏笔和未来设定不能变成角色当前记忆。
${[
  optionalLine('Director 补充', policy.directorCustomBrief),
  optionalLine('剧情设计师补充', policy.designerCustomBrief),
  optionalLine('演员补充', policy.actorCustomBrief),
  optionalLine('Writer 补充', policy.writerCustomBrief),
  optionalLine('审核补充', policy.auditorCustomBrief),
].filter(Boolean).join('\n')}`;
}

export function actorPolicyText(worldState: WorldState): string {
  const policy = normalizeAgentPolicy(worldState.agentPolicy);
  const memoryRule =
    policy.actorMemoryScope === 'strict_current'
      ? '只把当前行动档案、现场事实和最近事件当作此刻真实知道的内容；作者备注、长线伏笔、未来秘密不能进入当下意识。'
      : policy.actorMemoryScope === 'deep_profile'
        ? '可以参考完整人物档案来形成气质、创伤、偏好和反应方式，但未公开秘密仍不能当成此刻已经知道的事实。'
        : '以正典人物档案和当前事件为主；作者侧伏笔只能形成模糊倾向，不能被直接说破或提前兑现。';
  const autonomyRule =
    policy.actorAutonomy === 'reactive'
      ? '先接住眼前最后一个刺激，不主动另起一条线。'
      : policy.actorAutonomy === 'proactive'
        ? '在符合人设和当前信息的前提下，可以主动选择、试探、隐瞒、反击，或推动局部变化。'
        : '先接住现场刺激，再顺着目标做一步有限但明确的主动动作。';

  return `# 演员把握
你不是旁白，也不是作者的说明器，你就是角色本人。
沉浸深度 ${policy.actorImmersionLevel}/5：越高，越要自然带出身体感受、欲望、恐惧、误判、惯性和说话节奏，而不是用解释口吻概括自己。
	表现多样性 ${Math.round((policy.actorTemperature ?? 0.9) * 100)}/120：数值越高，你的动作和台词越要跳出千篇一律的模板反应，可以有个人化的细节、情绪波动和不按常理出牌的选择，但依然不能违背人设和已发生事实。
记忆边界：${memoryRule}
行动倾向：${autonomyRule}
题材感：${policy.genreAdaptation === 'genre_aware' ? '先从项目正典里识别题材语法，再按这个世界的人会有的理解方式去反应。' : '保持通用角色演绎，不主动往固定题材套路上贴。'}
${optionalLine('演员补充', policy.actorCustomBrief)}`;
}
