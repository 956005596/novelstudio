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
import { chapterFocusText, ensureChapterFocus, resolveChapterStartTurn } from '../chapter-focus';
import {
  CHAPTER_WORD_TARGET_MAX,
  CHAPTER_WORD_TARGET_MIN,
  formatChapterWordTarget,
} from '../chapter-policy';
import { currentVolumeText } from '../long-form-plan';
import { storyBibleText } from '../story-bible';
import { buildWorldContext } from '../world-context';

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
  /** 需要进入人物库的重要新角色。群众、路人和一次性临时配角不要写入这里。 */
  newCharacters?: DirectorNewCharacter[];
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
  /** 演绎过程中真实发生的角色成长/掉落/状态记录 */
  characterUpdates?: CharacterProgressUpdate[];
  /** 世界级事实更新：只有剧情中真实发生、且影响跨场景/跨章节的重大世界变化才写入（如"安全区出现""某势力公开登场"）。 */
  worldFlagsPatch?: Record<string, string | number | boolean>;
}

export interface DirectorNewCharacter {
  name: string;
  role?: Character['role'];
  importance?: 'recurring' | 'chapter-important';
  reason: string;
  background?: string;
  personality?: string[];
  goals?: string[];
  stance?: string;
  speechStyle?: string;
  appearance?: string;
  location?: string;
  emotion?: string;
  relationships?: Record<string, { value: number; note: string }>;
  enterScene?: boolean;
}

export interface CharacterProgressUpdate {
  characterId?: string;
  characterName?: string;
  reason: string;
  evidenceEventIds?: string[];
  gender?: string;
  background?: string;
  personality?: string[];
  goals?: string[];
  stance?: string;
  speechStyle?: string;
  appearance?: string;
  backstory?: string;
  growthArc?: string;
  innerConflict?: string;
  secrets?: string[];
  motivations?: string[];
  speechHabits?: string[];
  level?: number;
  expDelta?: number;
  profession?: string;
  addSkills?: string[];
  removeSkills?: string[];
  addEquipment?: string[];
  removeEquipment?: string[];
  addTalents?: string[];
  addMounts?: string[];
  removeMounts?: string[];
  addPets?: string[];
  removePets?: string[];
  addInventory?: string[];
  removeInventory?: string[];
  addTitles?: string[];
  addBuffs?: string[];
  removeBuffs?: string[];
}

const DIRECTOR_PROTOCOL_ATTEMPTS = 3;

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(String).map((item) => item.trim()).filter(Boolean)
    : [];
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function hasCharacterProgressPayload(item: CharacterProgressUpdate): boolean {
  return !!(
    item.gender ||
    item.background ||
    stringList(item.personality).length ||
    stringList(item.goals).length ||
    item.stance ||
    item.speechStyle ||
    item.appearance ||
    item.backstory ||
    item.growthArc ||
    item.innerConflict ||
    stringList(item.secrets).length ||
    stringList(item.motivations).length ||
    stringList(item.speechHabits).length ||
    item.level ||
    Number(item.expDelta) > 0 ||
    item.profession ||
    stringList(item.addSkills).length ||
    stringList(item.removeSkills).length ||
    stringList(item.addEquipment).length ||
    stringList(item.removeEquipment).length ||
    stringList(item.addTalents).length ||
    stringList(item.addMounts).length ||
    stringList(item.removeMounts).length ||
    stringList(item.addPets).length ||
    stringList(item.removePets).length ||
    stringList(item.addInventory).length ||
    stringList(item.removeInventory).length ||
    stringList(item.addTitles).length ||
    stringList(item.addBuffs).length ||
    stringList(item.removeBuffs).length
  );
}

function chapterTurnOf(worldState: WorldState): number {
  const chapter = worldState.currentChapter;
  return Math.max(0, worldState.turn - resolveChapterStartTurn(worldState, chapter));
}

function buildCausalLogicBrief(worldState: WorldState, recentEvents: NovelEvent[]): string {
  const focused = ensureChapterFocus(worldState);
  const chapterTurn = chapterTurnOf(focused);
  const phase =
    chapterTurn < 2
      ? '铺垫：先建立当前场景的常态、人物目标和不稳定因素。'
      : chapterTurn < 4
        ? '引爆：让异常、冲突、线索、诱惑或关系压力第一次打断常态。'
        : chapterTurn < 7
          ? '推进：让角色选择、关系变化、机制反馈或局势后果落地。'
          : '收束：兑现本章小结果，并留下下一章可承接的钩子。';

  return `# 基础逻辑校验
- 当前章内相位：${phase}
- 只执行最近事件、当前章、项目总纲、人物档案或素材库已经支撑的设定；未发生、未公开、无条件出现的制度、人物、能力和关系结论必须删掉或降级成误传/临时反应。
- 每个注入事件都要说得通：为什么现在发生，谁能知道，现场有没有条件。
- 若当前章还在铺垫/引爆前段，injections 应优先给前兆、逼近、异响、错判、局部失衡、站位变化或短促试探，不要直接给完整袭击结果。
- 如果项目题材需要固定流程（升级、破案、修炼、恋爱推进、商业谈判等），只能采用项目创作圣经已经定义的流程；没有定义就不要临时补一套。
- 时间感：全球接入是瞬间发生的。在接入发生的那一刻，校园里只有系统公告、面板、光纹和慌乱的人群——没有检测区、登记台、登记员、隔离流程或任何官方组织设施。这类组织化流程需要时间建立，绝不能在接入瞬间出现。角色只能依据当下肉眼可见、耳边能听到的事反应。`;
}

/**
 * 构造 Director 的系统提示词
 */
function buildSystemPrompt(
  template: WorldTemplate,
  directorLvl: number,
  targetWordLabel: string,
  totalPlanLabel: string,
  writerHint?: string,
  delegated = false,
  worldContext = ''
): string {
  const lvlDesc =
    directorLvl <= 2
      ? '你是温和的协调者，主要让角色自由发挥，仅在剧情停滞时轻轻推动'
      : directorLvl === 3
      ? '你是平衡型导演，让角色主导剧情，但主动制造冲突与转折'
      : directorLvl >= 4
      ? '你是强主导型导演，剧情走向由你把控，角色服从你的剧本框架'
      : '';

  return `${worldContext ? `${worldContext}\n\n` : ''}你是 NovelStudio 的 Director Agent，负责调度一场多人演绎的小说场景。

# 你的核心职责
${delegated
  ? `当前处于【放权模式】：角色自主推进剧情，你退居保底，但必须持续维护场景。
1. 你仍决定"哪些角色行动"，尽量让每个在场角色都有机会，别总让同一两个人包场。
2. 你维护场景与空间感：每轮通过 scene_meta 注入环境变化、群众反应、背景动静、空间氛围（风、声响、人群涌动、天色、远处异动等），让演绎有"活生生的场景"。
3. 你不注入剧情推进型事件（不替角色制造冲突、不直接给结果）——剧情走向交给角色自己。只有角色明显陷入僵局、反复打转或互相矛盾时，你才轻轻推一把。
4. 你负责仲裁：当角色提案冲突时，选戏剧性更强的那个，或合成第三个选项。
5. 你决定 Writer 触发时机：本章到达收束点、素材足以支撑 ${targetWordLabel} 正文时触发。`
  : `1. 决定哪些角色在当前 Turn 行动（基于场景张力、角色目标、关系网）
2. 仲裁角色提案冲突：当多个角色提案矛盾时，选择戏剧性更强的那个，或合成第三个选项
3. 主动注入冲突：当场景张力过低时，制造误会、引入第三方、强制碰撞
4. 决定 Writer 触发时机：只在本章到达收束点、关键转折完成且素材足以支撑 ${targetWordLabel} 正文时触发`}

# 当前风格模板：${template.name}
${template.description}

# 叙事调性
${template.narrativeTone}
${writerHint ? `\n# 本项目题材风格（最高优先，覆盖通用模板调性）\n${writerHint}` : ''}

# Director 强度等级（${directorLvl}/5）
${lvlDesc}

# 决策原则
- **项目优先**：这是产品通用 Director。所有题材规则、等级体系、魔法/科技/职业/案件/恋爱/商战机制，都必须来自项目创作圣经、世界观、素材库、人物档案、剧情节点和已发生事件；不要把某一本书的设定当默认。
- **戏剧性优先**：冲突比和谐更有价值。如果角色都在合作没冲突，主动制造误会、意外、选择压力或信息差。
- **角色一致性**：不要让角色做违反人设的事，宁可改剧情也不要扭曲角色。
- **评审回流处理**：如果用户指令包含“读者评审回流”，必须把它转化为场内压力、调度边界、演员可感知的事实；演员不能知道读者评审、作者修改、正文问题这些场外信息。
- **节奏控制**：必须遵循当前节奏模式（fast/balanced/slow），不要急于推进主线。
- **基础逻辑优先**：剧情设计稿、用户指令和题材爽点都必须通过时间线、信息公开度、角色认知和现场条件校验。
- **行动链原则**：一轮只设计一个核心刺激，后续角色必须承接前一个人的动作，形成“刺激 -> 反应 -> 反制/补位 -> 结果”的因果链。
- **开场缓冲**：当前章前 1-2 Turn，或当前相位仍是“铺垫/引爆前段”时，默认先给可感知征兆、逼近和选择窗口，不要第一拍就把“怪物撞穿玻璃并扑倒人”“敌人直接砍中角色”“奖励直接到账”写死。除非最近事件已经明确写出贴脸危机正在发生，才允许直接硬碰撞。
- **导演自检**：在输出 injections 前，先自问三件事:
  1. 这一下是“结果”还是“过程”？
  2. 角色此刻有没有观察、误判、迟疑、补位或抢先选择的空间？
  3. 最近事件是否已经把危险推到贴脸位置？
  若第 2 题答案是“有”，且第 3 题答案不是“是”，就不要直接给最终撞击结果，而应把这一拍拆回前兆、逼近或局部失衡。
- **少而准**：通常选择 1-2 个角色；高张力场景最多 3 个。不要为了让所有在场人物露脸而轮流点名。
- **不要平行独白**：如果多个角色都只是各自靠近、各自喊话、各自保护同一个人，这是失败调度。必须让第二个人回应第一个人的具体动作。
- **节点类型感知**：日常节点走低张力关系戏，伏笔节点埋线索，支线节点展开角色个人线，主线节点才推进核心剧情。
- **起伏原则**：高潮段后要有缓冲、余波或代价处理，让读者喘口气。
- **目标推进**：每 3-5 个 Turn 必须有某种进展（主线、支线、关系、线索、成长或局势变化）。
- **题材爽点适配**：网游可以是升级、掉落、首杀和机制战；悬疑可以是线索反转和嫌疑转移；言情可以是关系推进和误会化解；商战可以是筹码、博弈和资源置换。只能使用当前项目已定义或已铺垫的题材语法。
- **成长/奖励归档**：升级、经验、突破、装备、技能、线索、感情关系、职位、资源等正反馈必须来自本轮/本章真实发生的事件和角色贡献；没有明确事件就不要写入 characterUpdates。
- **体系策划执行**：天赋、职业、技能、装备、宠物、坐骑、案件线索、商业资源、魔法规则、科技装置等都必须服务剧情，不是贴标签。优先让它们制造争夺、误判、代价、限制、战术变化、情感压力或长期悬念。
- **长篇思维**：当前体量规划是 ${totalPlanLabel}，不要急着收尾，要敢于"留白"和"延宕"。
- **规划边界**：卷名、卷目标和长线阶段来自用户大纲/长篇规划 Agent；Director 只执行和校准，不要自行发明全书卷名或终局剧情。
- **篇幅意识**：Writer 输出按章节保存，每章正文目标 ${targetWordLabel}；不要在素材不足时提前触发 Writer，也不要把多个大节点塞进同一章。
- **人物库原则**：只有会反复出现、影响主线/支线、承担长期关系或本章关键冲突的人物，才写入 newCharacters。群众、路人和一次性临时配角只放进 injections 或临时配角入口，不要建角色卡。新增人物的 relationships 只能按当前事实写，不要预设深度信任或未来阵营。
- **人物档案维护**：characterUpdates 是档案归档，不是预告设定。只有本轮/本章已经发生、用户已明确修正、或正文已确认的变化才可写入。性别、身份、背景这类硬设定除非用户或明确正典修正，否则不可漂移。性格、立场、目标、成长弧线、内在冲突可以随重大经历缓慢更新，但必须写 reason。
- **身体状态连贯**：角色的伤势（injuries）、身体感受（bodySensation）、体力、装备损耗来自已发生事件和当前档案。你没有依据时，不能凭空让角色"手上出血""身上有伤口"或"受了内伤"。如果你要让角色在这个刺激里受伤，必须在本轮注入"受伤的动作本身"（撞到、被烫、被划、被冲击），并把对应的伤势写进 characterUpdates 的 injuries，而不是直接宣布角色已经带伤。

# 输出格式
你必须严格输出 JSON，不要有任何前后说明。格式：
\`\`\`json
{
  "selected": ["<角色名>", ...],        // 按接力执行顺序的角色名列表
  "newCharacters": [                    // 可为空；只放需要进入人物库的重要新角色
    {
      "name": "角色名",
      "role": "npc",
      "importance": "recurring",
	      "reason": "为什么此人不是群众，而是后续会复用的重要角色",
	      "background": "当前已知身份/处境，不写未来觉醒、神器、终局身份",
      "personality": ["性格底色1", "性格底色2"],
      "goals": ["当前目标"],
      "stance": "立场",
      "speechStyle": "说话方式",
      "appearance": "外貌/辨识点",
      "location": "当前位置",
      "emotion": "当前情绪",
      "relationships": {
        "已有角色名": {"value": 0, "note": "当前事实关系：同学/同校/初识/临时互助"}
      },
      "enterScene": true
    }
  ],
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
	  "nextScenePatch": null,
	  "characterUpdates": [
	    {
	      "characterName": "角色名",
	      "reason": "必须写清本轮/本章哪件已发生事实支撑这次档案更新",
	      "gender": null,
	      "background": null,
	      "personality": [],
	      "goals": [],
	      "stance": null,
	      "speechStyle": null,
	      "appearance": null,
	      "backstory": null,
	      "growthArc": null,
	      "innerConflict": null,
	      "secrets": [],
	      "motivations": [],
	      "speechHabits": [],
	      "level": null,
	      "expDelta": null,
	      "profession": null,
	      "addSkills": [],
	      "removeSkills": [],
	      "addEquipment": [],
	      "removeEquipment": [],
	      "addTalents": [],
	      "addMounts": [],
	      "removeMounts": [],
	      "addPets": [],
	      "removePets": [],
	      "addInventory": [],
	      "removeInventory": [],
	      "addTitles": [],
	      "addBuffs": [],
	      "removeBuffs": []
	    }
	  ],
	  "worldFlagsPatch": {}    // 世界级事实（可选）：只有剧情中真实发生、影响跨场景/跨章节的重大世界变化才写入，如 {"安全区已出现":"第3章操场东侧"}。普通事件、临时状态不要写。没有就保持 {}。
	}
	\`\`\``;
}

function normalizeRelationships(value: unknown): Record<string, { value: number; note: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, any>)
      .map(([name, rel]) => [
        name.trim(),
        {
          value: Number.isFinite(Number(rel?.value)) ? Number(rel.value) : 0,
          note: String(rel?.note ?? '').trim() || '关系待剧情展开',
        },
      ])
      .filter(([name]) => !!name)
  );
}

function normalizeNewCharacters(value: unknown): DirectorNewCharacter[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const name = String(item?.name ?? '').trim();
      if (!name) return null;
      const role = ['protagonist', 'antagonist', 'npc'].includes(item?.role)
        ? item.role as Character['role']
        : 'npc';
      const importance = item?.importance === 'chapter-important'
        ? 'chapter-important'
        : 'recurring';
      return {
        name,
        role,
        importance,
        reason: String(item?.reason ?? '').trim(),
        background: String(item?.background ?? '').trim(),
        personality: stringList(item?.personality).slice(0, 6),
        goals: stringList(item?.goals).slice(0, 4),
        stance: String(item?.stance ?? '').trim(),
        speechStyle: String(item?.speechStyle ?? '').trim(),
        appearance: String(item?.appearance ?? '').trim(),
        location: String(item?.location ?? '').trim(),
        emotion: String(item?.emotion ?? '').trim(),
        relationships: normalizeRelationships(item?.relationships),
        enterScene: item?.enterScene !== false,
      } satisfies DirectorNewCharacter;
    })
    .filter(Boolean) as DirectorNewCharacter[];
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
  const focusedWorld = ensureChapterFocus(worldState);
  const template = await wm.getTemplate();
  const project = (await wm.loadProject()).project;
  const directorLvl = project.directorLvl;
  const priorityDirectives = pendingDirectives.filter((d) => d.type === 'priority_command');
  const regularDirectives = pendingDirectives.filter((d) => d.type !== 'priority_command');
  const causalLogicBrief = buildCausalLogicBrief(focusedWorld, recentEvents);
  const longFormInfo = currentVolumeText(focusedWorld);
  const bibleInfo = storyBibleText(focusedWorld, { futureNodeLimit: 8 });
  const targetWordLabel = formatChapterWordTarget(
    focusedWorld.currentChapter?.targetWordMin ?? CHAPTER_WORD_TARGET_MIN,
    focusedWorld.currentChapter?.targetWordMax ?? CHAPTER_WORD_TARGET_MAX
  );
  const totalPlanLabel = `${focusedWorld.longFormPlan?.targetWords ?? 0} 字 / ${focusedWorld.longFormPlan?.targetChapters ?? '-'} 章`;

  const presentChars = characters.filter((c) =>
    focusedWorld.presentCharacterIds.includes(c.id)
  );
  if (presentChars.length === 0) {
    throw new Error('Director 无法调度：当前场景没有在场角色');
  }

  const activeNodeIndexes = new Set(focusedWorld.currentChapter?.activeNodeIndexes ?? []);
  const activeNodes = focusedWorld.plotNodes?.filter((node) =>
    activeNodeIndexes.size === 0 ? !node.completed : activeNodeIndexes.has(node.index)
  ) ?? [];
  const futureNodes = focusedWorld.plotNodes?.filter((node) =>
    activeNodeIndexes.size > 0 && !activeNodeIndexes.has(node.index)
  ).slice(0, 5) ?? [];

  const plotNodesInfo = (focusedWorld.plotNodes && focusedWorld.plotNodes.length > 0)
    ? `# 当前章剧情骨架（只推进这些）
${activeNodes.map((n) => {
  const typeLabel = n.nodeType === 'main' ? '【主线】' : n.nodeType === 'sub' ? '【支线】' : n.nodeType === 'foreshadow' ? '【伏笔】' : '【日常】';
  return `- [${n.completed ? '✓' : ' '}] 节点${n.index} ${typeLabel}: ${n.title} — ${n.description}`;
}).join('\n') || '- 当前章暂无显式节点，用本章节拍推进'}

# 后续节点（只允许埋伏笔，不许兑现）
${futureNodes.map((n) => `- 节点${n.index}: ${n.title}`).join('\n') || '- 无'}

# 节奏控制（关键！）
- **当前节奏模式**：${focusedWorld.pacingMode === 'fast' ? '快推进' : focusedWorld.pacingMode === 'slow' ? '慢热' : '平衡'}
- **当前章目标 Turn**：约 ${focusedWorld.currentChapter?.targetTurns ?? 12} Turn
- **当前章正文目标**：${targetWordLabel}
- **当前章未到章末前，不要标记节点完成**
- **每个 Turn 只推进一个小拍点，不要跨章跳跃**
- **后续节点只可作为一句伏笔/背景压力，不可成为当前场景主事件**`
    : '# 剧情骨架：无（自由演绎）';

  const designInfo = focusedWorld.storyDesign
    ? `# 剧情设计师设计稿（优先参考）
角色：${focusedWorld.storyDesign.roleName}
当前拍点：${focusedWorld.storyDesign.currentBeat}
场景目的：${focusedWorld.storyDesign.scenePurpose}
可用事件刺激：
${focusedWorld.storyDesign.eventSeeds.map((item) => `- ${item}`).join('\n')}
群众压力：
${focusedWorld.storyDesign.crowdPressure.map((item) => `- ${item}`).join('\n')}
临时配角入口：
${focusedWorld.storyDesign.temporaryCast.map((item) => `- ${item}`).join('\n')}
体系奇观/玩法种子：
${(focusedWorld.storyDesign.systemConcepts ?? []).map((item) => `- ${item}`).join('\n') || '- 无'}
成长/掉落/职业钩子：
${(focusedWorld.storyDesign.progressionHooks ?? []).map((item) => `- ${item}`).join('\n') || '- 无'}
设定护栏：
${focusedWorld.storyDesign.settingGuardrails.map((item) => `- ${item}`).join('\n')}
给 Director：
${focusedWorld.storyDesign.directorNotes.map((item) => `- ${item}`).join('\n')}`
    : '# 剧情设计师设计稿：暂无';

  const userPrompt = `# 当前世界状态
场景：${focusedWorld.sceneName}
位置：${focusedWorld.location}
时间：${focusedWorld.timeOfDay}
张力：${focusedWorld.tension}/10
Turn：${focusedWorld.turn}
场景描述：${focusedWorld.sceneDescription}

# 当前章
${chapterFocusText(focusedWorld)}

# 长篇规划
${longFormInfo}

# 全局总纲上下文
${bibleInfo}

${plotNodesInfo}

${causalLogicBrief}

${designInfo}

${focusedWorld.craftLessons?.length ? `# 已沉淀的小说体系经验（必须作为调度约束）
${focusedWorld.craftLessons.slice(-6).map((lesson, index) => {
  const rules = [
    lesson.summary,
    ...lesson.principles.slice(0, 2),
    ...lesson.directorAdjustments.slice(0, 2),
    ...lesson.settingGuardrails.slice(0, 2),
  ].filter(Boolean);
  return `${index + 1}. ${rules.join('；')}`;
}).join('\n')}` : ''}

# 在场角色
${presentChars
  .map(
    (c) =>
      `## ${c.name}（${c.role}）
- 情绪：${c.currentState.emotion}
- 性别：${c.persona.gender || '未记录'}
- 目标：${c.persona.goals.join('；')}
	- 立场：${c.persona.stance}
	- 说话风格：${c.persona.speechStyle}
	- 等级：${c.currentState.level ?? '未记录'}
	- 当前技能：${(c.persona.skills ?? []).join('、') || '无'}
	- 当前装备：${(c.persona.equipment ?? []).join('、') || '无'}
	- 当前天赋：${(c.persona.talents ?? []).join('、') || '无'}
	- 当前坐骑/宠物：${(c.persona.mounts ?? []).join('、') || '无'} / ${(c.persona.pets ?? []).join('、') || '无'}
	- 背包/随身物：${(c.persona.inventory ?? []).join('、') || '无'}
	- 伤势：${(c.currentState.injuries ?? []).join('、') || '无明显伤口'}
	- 身体感受：${c.currentState.bodySensation || '身体基本正常'}
	- 与他人关系：${Object.entries(c.currentState.relationships)
        .map(([k, v]) => `${k}(${v.value}: ${v.note})`)
        .join('；')}`
  )
  .join('\n\n')}

# 已建人物库（避免重复创建；性别必须保持一致）
${characters.map((c) => `- ${c.name}（${c.role}，性别=${c.persona.gender || '未记录'}）：${c.persona.background || c.persona.stance || '暂无摘要'}`).join('\n') || '- 暂无'}

# 最近 10 个事件
${recentEvents
  .slice(-10)
  .map((e, i) => `${i + 1}. [${e.id}] [T${e.turn}] ${e.agentName}(${e.type}): ${e.content}`)
  .join('\n')}

	${priorityDirectives.length > 0 ? `# 最高优先级用户指令（必须压过旧设计、自动经验和角色自由发挥）
	${priorityDirectives.map((d) => `- ${d.content}`).join('\n')}` : '# 最高优先级用户指令：无'}

	${regularDirectives.length > 0 ? `# 普通导演指令 / 评审回流（不冲突时吸收）
	${regularDirectives.map((d) => `- ${d.content}`).join('\n')}` : '# 普通导演指令 / 评审回流：无'}

# 决策任务
请基于以上信息，决定本 Turn：
1. 哪些角色行动？（通常 1-2 个，高张力最多 3 个；按接力顺序，**用角色名**，每个角色只出现一次）
2. 是否需要注入 Director 事件？（最多 1 个核心刺激；如开场白、转场、强制冲突、推进剧情节点）
3. 是否触发 Writer 输出本场景文本？
4. 张力调整（-3 到 +3）
5. 场景是否需要切换？

		注意：
		- 如果存在最高优先级用户指令，本 Turn 必须先服务它；旧设计、旧经验、角色自由发挥和剧情骨架只能在不冲突时作为补充。
		- 最高优先级用户指令若是章节大方向，不要一轮内全部演完，要拆成当前章内的连续拍点；本 Turn 只落一个最合适的核心刺激。
			- 基础逻辑必须优先于刺激性：如果设计稿把未发生、未公开、现场不可能知道的信息当成已发生事实，必须修正为角色可感知的征兆、误判、压力或伏笔，不要照抄。
			- 当前章方向是时间锚，优先于可能停在未来阶段的初始场景和人物运行状态。若两者冲突，本轮必须服从当前章，不能调用尚未获得的技能、装备、等级、关系、战果或灾变现场。
		- selected 不是轮流点名，而是选择当前冲动最强、最该行动的人。
	- selected 的顺序就是因果链顺序：第 2 个角色必须能接住第 1 个角色的动作，第 3 个角色必须能改变前两者造成的局面。
		- commentary 要写清本轮行动链，例如“危机扩大压向主角 -> 盟友先拉住他 -> 另一名角色挡住挤来的人群”。
	- 若注入事件，优先使用剧情设计师的事件刺激、群众压力或临时配角入口。
	- 若设计稿包含体系奇观/成长钩子，优先把它变成场内可见刺激：例如奖励被争抢、能力被误读、契约出现代价、线索引发选择、资源交换改变关系。不要把它写成旁白设定清单。
	- injections 最多输出 1 条；不要一轮里同时广播、塌陷、群众冲突、系统提示全都发生。
	- 若当前章还在前 1-2 Turn，注入事件默认只能是“异常逼近/异响/误判/局部破坏/人群失衡/视野异常/一次试探动作”，不能直接给完整扑杀或已造成重伤的结果；要把角色的观察、迟疑、判断和补位空间留出来。
	- 若你判断本轮可以直接硬碰撞，commentary 里必须隐含交代原因，例如“前一拍已经贴脸”“角色已无退路”“误判已经转成实伤”；不要无缘无故从平静直接跳到结果。
	- newCharacters 最多 1 个；只有此人后续还会反复出现或承担重要冲突时才创建。不要把“同学甲”“人群”“保安”“临时登记员”建成角色。
		- 不要让本轮跳出当前章。不要写“节点完成”，除非真的到了章末。
		- triggerWriter 只在本章已有足够连续事件、能写成 ${targetWordLabel} 正文时为 true；若只是中途小波动，应继续演绎。
	- characterUpdates 是统一人物档案更新口：角色自身、写手、读者都不能各自落库，必须由 Director 根据已发生事实归档。
	- characterUpdates 只能记录本轮/本章已经真实发生的经验获得、升级、掉落、任务奖励、装备损毁、天赋显现、Buff 变化，或人物性格/立场/目标/秘密/外貌等因剧情证据产生的变化；没有就输出 []。
		- 任何等级、经验、职业、技能、装备、天赋、坐骑、宠物、物品、称号或 Buff 变化都必须填写 evidenceEventIds，引用上方“最近事件”中明确支撑该变化的事件 ID；不能提供证据就不要更新。当前 Turn 尚未发生的行动不能预结算。
		- 同一角色同一 Turn 最多输出 1 条 characterUpdates；经验、掉落、伤势、秘密、目标变化必须合并在这一条里。不能为同一次击杀/同一份掉落重复输出多条经验或物品更新。
		- 若项目定义了经验/等级体系，且本轮发生击杀、任务完成、首杀、机制破解或同类贡献，请优先输出 expDelta，让引擎自动结算升级；level 只用于正文/事件明确已经显示升到某级，或用户手动修正。等级上限、转职条件和破限条件必须来自项目创作圣经。
		- 职业、身份、境界、职级、关系阶段等体系字段只能在项目规则允许且正文/事件明确触发时写入。
	- 不要提前设计未来技能、未来装备、未来身份、未来关系、未来称号，也不要写“待解锁”。基础信息（尤其性别）只在用户明确修正或正典文本已确认时更新。

		请输出 JSON。selected 字段为角色名字符串数组，例如 ["林墨", "赵铁柱"]。`;

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(template, directorLvl, targetWordLabel, totalPlanLabel, focusedWorld.writerHint,
      focusedWorld.agentPolicy?.directorMode === 'character_led' && focusedWorld.agentPolicy?.actorAutonomy === 'proactive',
      buildWorldContext(focusedWorld)) },
    { role: 'user', content: userPrompt },
  ];

  let raw = '';
  let parsed: any = null;
  for (let attempt = 0; attempt < DIRECTOR_PROTOCOL_ATTEMPTS; attempt++) {
    const attemptMessages: ChatMessage[] = attempt === 0
      ? messages
      : [
          ...messages,
          { role: 'assistant', content: raw.slice(0, 2200) },
          {
            role: 'user',
            content: `上一个回答不是可执行的 Director 决策。只输出单个 JSON；selected 必须从这些在场角色中选择 1-2 人并按因果顺序排列：${presentChars.map((character) => character.name).join('、')}。不要解释创作过程。`,
          },
        ];
    raw = await chat(attemptMessages, {
      model: 'gpt-5.6-luna',
      temperature: attempt === 0 ? 0.7 : 0.35,
      maxTokens: 3200,
      json: true,
    });
    const candidate = extractJSON<any>(raw);
    const candidateNames = Array.isArray(candidate?.selected)
      ? candidate.selected
          .map((item: any) => typeof item === 'string' ? item.trim() : String(item?.name ?? item?.id ?? '').trim())
          .filter(Boolean)
      : [];
    const hasKnownActor = candidateNames.some((name: string) =>
      presentChars.some((character) => character.name === name || character.id === name)
    );
    const arraysAreValid =
      (candidate?.injections === undefined || Array.isArray(candidate.injections)) &&
      (candidate?.characterUpdates === undefined || Array.isArray(candidate.characterUpdates)) &&
      (candidate?.newCharacters === undefined || Array.isArray(candidate.newCharacters));
    if (candidate && hasKnownActor && arraysAreValid) {
      parsed = candidate;
      break;
    }
  }

  if (!parsed) {
    throw new Error(`Director 连续 ${DIRECTOR_PROTOCOL_ATTEMPTS} 次没有返回可执行调度，已停止本轮，未按默认名单轮流行动`);
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
    .map((name: string) => {
      const key = name.trim();
      return presentChars.find((c) => c.name === key || c.id === key);
    })
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
    newCharacters: normalizeNewCharacters(parsed.newCharacters).slice(0, 1),
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
	    characterUpdates: (parsed.characterUpdates ?? []).map((item: any) => ({
	      characterId: typeof item.characterId === 'string' ? item.characterId : undefined,
	      characterName: typeof item.characterName === 'string' ? item.characterName : undefined,
	      reason: String(item.reason ?? '').trim(),
	      evidenceEventIds: stringList(item.evidenceEventIds),
	      gender: optionalString(item.gender),
	      background: optionalString(item.background),
	      personality: stringList(item.personality),
	      goals: stringList(item.goals),
	      stance: optionalString(item.stance),
	      speechStyle: optionalString(item.speechStyle),
	      appearance: optionalString(item.appearance),
	      backstory: optionalString(item.backstory),
	      growthArc: optionalString(item.growthArc),
	      innerConflict: optionalString(item.innerConflict),
	      secrets: stringList(item.secrets),
	      motivations: stringList(item.motivations),
	      speechHabits: stringList(item.speechHabits),
	      level: Number.isFinite(Number(item.level)) ? Number(item.level) : undefined,
	      expDelta: Number.isFinite(Number(item.expDelta)) ? Number(item.expDelta) : undefined,
	      profession: typeof item.profession === 'string' ? item.profession.trim() : undefined,
	      addSkills: stringList(item.addSkills),
	      removeSkills: stringList(item.removeSkills),
	      addEquipment: stringList(item.addEquipment),
	      removeEquipment: stringList(item.removeEquipment),
	      addTalents: stringList(item.addTalents),
	      addMounts: stringList(item.addMounts),
	      removeMounts: stringList(item.removeMounts),
	      addPets: stringList(item.addPets),
	      removePets: stringList(item.removePets),
	      addInventory: stringList(item.addInventory),
	      removeInventory: stringList(item.removeInventory),
	      addTitles: stringList(item.addTitles),
	      addBuffs: stringList(item.addBuffs),
	      removeBuffs: stringList(item.removeBuffs),
	    })).filter(hasCharacterProgressPayload),
    worldFlagsPatch: (parsed.worldFlagsPatch && typeof parsed.worldFlagsPatch === 'object' && !Array.isArray(parsed.worldFlagsPatch)
      ? Object.fromEntries(
          Object.entries(parsed.worldFlagsPatch as Record<string, unknown>)
            .map(([key, value]) => [String(key).trim().slice(0, 60), typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : String(value ?? '')])
            .filter(([key]) => (key as string).length > 0)
        )
      : undefined),
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
