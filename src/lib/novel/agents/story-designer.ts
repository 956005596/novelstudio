/**
 * Story Designer Agent
 *
 * 类似酒馆里的“导演/设定策划”角色：根据当前章、最近事件和设定边界，
 * 先设计下一步情节刺激，再交给 Director 调度角色自发演绎。
 */

import { chat, extractJSON, type ChatMessage } from '../llm';
import { chapterFocusText, ensureChapterFocus, resolveChapterStartTurn } from '../chapter-focus';
import {
  CHAPTER_WORD_TARGET_MAX,
  CHAPTER_WORD_TARGET_MIN,
  chapterWordTargetText,
} from '../chapter-policy';
import { currentVolumeText } from '../long-form-plan';
import { storyBibleText } from '../story-bible';
import { buildWorldContext } from '../world-context';
import { renderChapterBridgeForPrompt, type ChapterBridgeContext } from '../chapter-continuity';
import type { Character, NovelEvent, StoryDesign, WorldState } from '../types';

interface StoryDesignDraft {
  currentBeat?: string;
  scenePurpose?: string;
  eventSeeds?: string[];
  systemConcepts?: string[];
  progressionHooks?: string[];
  crowdPressure?: string[];
  temporaryCast?: string[];
  settingGuardrails?: string[];
  directorNotes?: string[];
  auditQuestions?: string[];
}

const STORY_DESIGN_PROTOCOL_ATTEMPTS = 3;

function toStringArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return fallback;
  const items = value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 6);
  return items.length > 0 ? items : fallback;
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

  return `# 基础逻辑检查
- 当前章内相位：${phase}
- 先按最近事件确认“已经发生”的事实；没有写进事件日志、当前章、项目总纲或人物档案的制度、组织、能力、关系结论，不得当作背景。
- 场景设计必须回答：为什么现在会发生，谁能知道，现场是否有条件支撑。
- 若当前章还处于铺垫/引爆前段，eventSeeds 必须优先给“征兆、逼近、误判、站位变化、情绪传染、选择压力”，不要一上来就写“怪物已经扑到脸上/敌人已经砍中人/奖励已经到账/组织已经成熟响应”。
- 如果项目题材需要固定流程（升级、破案、修炼、恋爱推进、商业谈判等），只能采用项目创作圣经已经定义的流程；没有定义就不要临时补一套。`;
}

export async function storyDesignerPlan(
  worldState: WorldState,
  characters: Character[],
  recentEvents: NovelEvent[],
  pendingDirectives: { id: string; type: string; content: string }[],
  previousChapterBridge?: ChapterBridgeContext | null
): Promise<StoryDesign> {
  const focused = ensureChapterFocus(worldState);
  const chapter = focused.currentChapter!;
  const priorityDirectives = pendingDirectives.filter((d) => d.type === 'priority_command');
  const regularDirectives = pendingDirectives.filter((d) => d.type !== 'priority_command');
  const causalLogicBrief = buildCausalLogicBrief(focused, recentEvents);
  const longFormInfo = currentVolumeText(focused);
  const bibleInfo = storyBibleText(focused, { futureNodeLimit: 8 });
  const chapterWordText = chapterWordTargetText(
    chapter.targetWordMin ?? CHAPTER_WORD_TARGET_MIN,
    chapter.targetWordMax ?? CHAPTER_WORD_TARGET_MAX
  );
  const chapterBridgeInfo = renderChapterBridgeForPrompt(previousChapterBridge);
  const chapterStartTurn = resolveChapterStartTurn(focused, chapter);
  const currentChapterEvents = recentEvents.filter((event) => event.turn > chapterStartTurn);
  const isFreshChapter = currentChapterEvents.length === 0 && chapterTurnOf(focused) === 0;
  const currentSceneText = isFreshChapter
    ? `当前章尚无已发生事件。请直接按“当前章焦点”重建开场。
旧 World State 中的场景名、地点、灾变现象和人物数值可能属于后续时点，本轮不提供、不得引用。`
    : `${focused.sceneName}
${focused.sceneDescription}
地点：${focused.location}
时间：${focused.timeOfDay}`;

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `${buildWorldContext(focused)}

你是 NovelStudio 的“剧情设计师/设定策划”。

你的职责不是写正文，也不是替角色说话，而是为 Director 设计下一轮可演绎的情节刺激。

必须遵守：
0. 用户手动发给 Director 的“最高优先级指令”高于旧设计、自动经验、角色自发倾向和默认章纲；若冲突，以用户指令为准，但仍只改当前章内可演绎内容。
1. 基础逻辑第一：先判断最近事件里哪些事实已经发生，再设计下一步；不能把未来制度、后续组织或尚未公开的信息当成当前背景。
2. 只围绕当前章推进，不要提前兑现后续大节点。
3. 事件要能触发角色根据性格、能力、关系自发表态或行动。
4. 群众可以是群体压力；只有需要推动冲突时才具名化临时配角。
5. 设定护栏要指出哪些信息角色现在不能知道，哪些能力现在不能完整展露。
6. 输出要尖锐、可执行、短句，不要写空泛创作理论。
7. ${chapterWordText}；设计稿必须是单章容量，不能塞入多章进展。
8. 卷名、卷目标和长线阶段只来自用户大纲/长篇规划 Agent；剧情设计师只设计当前章事件，不得自行发明全书卷名或终局剧情。
9. 第 2 章及以后，必须先接住上一章正稿结尾，再设计新危机。上一章没有写到的地点、怪物、战斗、组织流程，不能在下一章开头当成已经发生。
10. 你同时承担“题材体系策划 Agent”：根据项目类型设计它真正需要的素材体系。网游可以设计天赋、职业、技能、装备、宠物、坐骑、副本、掉落；悬疑可以设计线索、嫌疑链、诡计、证词、误导；言情可以设计关系阶段、误会、吸引点、情感代价；商战可以设计筹码、资源、合同、舆论和博弈结构。每个体系点都要能带来至少一种：争夺、误判、代价、限制、反转、选择压力、玩法变化或长期悬念。
11. 想象力可以大胆、复杂、炫酷，但当前章只写“种子/可触发条件/可误判现象/可争夺物/可验证线索”，不要直接给未来神器、神宠、隐藏职业、终局身份或最终关系贴“待解锁”标签。
	12. 若当前章还在前 1-2 Turn，或 chapter phase 仍是“铺垫/引爆前段”，eventSeeds 必须按“前兆/逼近 -> 误判或分歧 -> 被迫选择”组织，不能直接给完整袭击结果。除非最近事件已经明确写出敌人贴脸、建筑坍塌、人已受伤，否则不要把“直接扑倒、直接秒杀、直接撞飞”写成第一拍。
		13. 当前章方向是时间锚。若初始场景、人物技能/装备/等级/位置明显写成了当前章之后的状态，设计必须服从当前章方向，把那些字段视为尚未发生，不得拿未来状态反推本章已经进入灾变或战斗。
		14. eventSeeds 必须具体到“能拍成画面”：每个刺激包含对象、动作、至少一个感官细节和一个未解的悬念/代价；避免“人群骚动”“气氛紧张”这类抽象刺激。设定和意象可以华丽、猎奇、有压迫感，但都要能落到角色的眼睛、皮肤、耳朵和脚下。
		14b. 本章意象边界（防跨章混用）：当前章是第 ${focused.currentChapter?.chapterNo ?? 1} 章，eventSeeds 里的具体意象必须来自「当前章焦点/节点描述/已发生事件」的范围内。
		${(() => {
      const chNo = focused.currentChapter?.chapterNo ?? 1;
      return chNo <= 2
        ? `第 ${chNo} 章属于"觉醒判定与校园首轮危机"开篇段。禁止引入【广播台】【裂缝/裂隙】【灰白弧面/灰白硬物】【禁退线/收声】【大壳怪/怪物】【伤者/血珠/渗血】【教堂叠影】等后续章节的专用意象。你可以用：面板/光纹/系统公告/人群分层/检测/空行/异常闪烁/杂音/推挤/外圈异响（但不得具体成某种怪物）。`
        : '';
    })()}
		${focused.writerHint ? `15. 项目题材风格（最高优先，覆盖通用模板调性）：\n${focused.writerHint}\n	设计的情节刺激、体系种子、成长钩子和群体压力都必须服务这个题材风格，不要照搬“升级/打怪/掉落”的默认套路。` : ''}
		15. 设计 JSON 总长不超过 1800 个中文字；currentBeat 和 scenePurpose 各不超过 100 字；每个数组最多 3 条，每条不超过 100 字。不写段落式剧情，只给 Director 可执行拍点。

输出 JSON，不要 markdown：
{
  "currentBeat": "当前应演绎的章节拍点",
  "scenePurpose": "本轮场景目的",
  "eventSeeds": ["可注入事件/刺激1，必须具体到导演能直接拍成画面：包含对象、动作、感官细节（光/声/温度/气味/压迫感）和一个小悬念或代价"],
  "systemConcepts": ["符合项目题材的体系奇观种子，每条都说明它如何催化剧情"],
  "progressionHooks": ["本章可演绎或可伏笔的成长/奖励/关系/线索/资源钩子，每条都带触发条件或代价"],
  "crowdPressure": ["群众/环境压力1"],
  "temporaryCast": ["可临时具名的人物入口"],
  "settingGuardrails": ["设定护栏1"],
  "directorNotes": ["交给 Director 的调度备注"],
  "auditQuestions": ["需要审核盯住的问题"]
}`,
    },
    {
      role: 'user',
      content: `# 当前章焦点
${chapterFocusText(focused)}

# 长篇规划
${longFormInfo}

# 全局总纲上下文
${bibleInfo}

# 上一章正稿接续
${chapter.chapterNo > 1 ? chapterBridgeInfo : '- 当前是第一章。'}

# 当前场景
${currentSceneText}
Turn：${focused.turn}
张力：${focused.tension}/10

# 在场角色
${characters
  .filter((c) => focused.presentCharacterIds.includes(c.id))
  .map((c) => isFreshChapter
    ? `- ${c.name}：性别=${c.persona.gender || '未记录'}；立场=${c.persona.stance}；目标=${c.persona.goals.join('、')}；性格=${c.persona.personality.join('、')}；其他数值/技能/装备可能属于后续时点，不得引用`
    : `- ${c.name}：性别=${c.persona.gender || '未记录'}；职业=${c.persona.profession || '未记录'}；等级=${c.currentState.level ?? '未记录'}；天赋=${(c.persona.talents ?? []).join('、') || '无'}；技能=${(c.persona.skills ?? []).join('、') || '无'}；装备=${(c.persona.equipment ?? []).join('、') || '无'}；坐骑/宠物=${(c.persona.mounts ?? []).join('、') || '无'} / ${(c.persona.pets ?? []).join('、') || '无'}；立场=${c.persona.stance}；目标=${c.persona.goals.join('、')}；性格=${c.persona.personality.join('、')}`)
  .join('\n')}

# 最近事件
${currentChapterEvents.slice(-8).map((e) => `[${e.id}] T${e.turn} ${e.agentName}/${e.type}: ${e.content}`).join('\n') || '暂无'}

${causalLogicBrief}

${priorityDirectives.length ? `# 最高优先级用户指令（必须覆盖旧设计并落实到本章拍点）\n${priorityDirectives.map((d) => `- ${d.content}`).join('\n')}` : '# 最高优先级用户指令：无'}

${regularDirectives.length ? `# 普通导演指令 / 评审回流（在不冲突时吸收）\n${regularDirectives.map((d) => `- ${d.content}`).join('\n')}` : '# 普通导演指令 / 评审回流：无'}

${focused.craftLessons?.length ? `# 已沉淀的小说体系经验（本轮必须吸收）
${focused.craftLessons.slice(-6).map((lesson, index) => {
  const items = [
    lesson.summary,
    ...lesson.directorAdjustments.slice(0, 2),
    ...lesson.settingGuardrails.slice(0, 2),
  ].filter(Boolean);
  return `${index + 1}. ${items.join('；')}`;
}).join('\n')}` : ''}

# 任务
为下一轮演绎设计情节刺激和设定护栏。若有最高优先级用户指令，必须先把它拆成当前章可演绎的连续拍点：常态/余波 -> 刺激 -> 角色反应 -> 选择或后果 -> 钩子；每一拍必须符合基础逻辑，不得把后续制度、能力、关系结论或组织资源提前当成已发生。第 2 章及以后必须先设计“上一章结尾 -> 本章开场”的过渡拍，再进入新危机；不要让剧情跳出当前章。如果当前章还处于前 1-2 Turn，请优先设计征兆、压迫感、站位变化、误判和选择窗口，而不是直接给完整碰撞结果。本章最终正文按“${chapterWordText}”组织容量。`,
    },
  ];

  let raw = '';
  for (let attempt = 0; attempt < STORY_DESIGN_PROTOCOL_ATTEMPTS; attempt++) {
    const attemptMessages: ChatMessage[] = attempt === 0
      ? messages
      : [
          ...messages,
          { role: 'assistant', content: raw.slice(0, 2400) },
          {
            role: 'user',
            content: '上一个回答不是完整的本章设计。不要解释，只输出单个 JSON；currentBeat、scenePurpose 必须是非空文本，eventSeeds、settingGuardrails、directorNotes 必须是非空数组。',
          },
        ];
    raw = await chat(attemptMessages, {
      model: 'gpt-5.6-luna',
      temperature: attempt === 0 ? 0.75 : 0.4,
      maxTokens: 8000,
      json: true,
    });
    const parsed = extractJSON<StoryDesignDraft>(raw);
    const currentBeat = String(parsed?.currentBeat ?? '').trim();
    const scenePurpose = String(parsed?.scenePurpose ?? '').trim();
    const eventSeeds = toStringArray(parsed?.eventSeeds);
    const settingGuardrails = toStringArray(parsed?.settingGuardrails);
    const directorNotes = toStringArray(parsed?.directorNotes);
    if (!parsed || !currentBeat || !scenePurpose || eventSeeds.length === 0 || settingGuardrails.length === 0 || directorNotes.length === 0) {
      console.warn(
        `[StoryDesigner] 第 ${attempt + 1} 次输出未通过结构校验：${raw.replace(/\s+/g, ' ').slice(0, 420)}`
      );
      continue;
    }

    return {
      id: `design-${focused.turn}`,
      roleName: '剧情设计师 · 体系策划',
      chapterNo: chapter.chapterNo,
      chapterTitle: chapter.title,
      currentBeat,
      scenePurpose,
      eventSeeds,
      systemConcepts: toStringArray(parsed.systemConcepts),
      progressionHooks: toStringArray(parsed.progressionHooks),
      crowdPressure: toStringArray(parsed.crowdPressure),
      temporaryCast: toStringArray(parsed.temporaryCast),
      settingGuardrails,
      directorNotes,
      auditQuestions: toStringArray(parsed.auditQuestions),
      updatedAt: new Date().toISOString(),
    };
  }

  throw new Error(`剧情设计师连续 ${STORY_DESIGN_PROTOCOL_ATTEMPTS} 次没有返回完整设计，未使用本地默认方案`);
}
