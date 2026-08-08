import { countReadableChars } from './chapter-text';
import { formatChapterWordTarget } from './chapter-policy';
import { chat, type ChatMessage } from './llm';
import type { ChapterBridgeContext } from './chapter-continuity';
import type { Character, ChapterFocus, StoryDesign } from './types';

export interface ChapterValidationIssue {
  code:
    | 'too_short'
    | 'too_long'
    | 'gender_conflict'
    | 'missing_required_character'
    | 'weak_chapter_bridge'
    | 'missing_progression_feedback';
  message: string;
  fatal?: boolean;
}

export interface ChapterValidationResult {
  readableCount: number;
  issues: ChapterValidationIssue[];
}

function genderRule(gender?: string): string {
  const label = gender || '未记录';
  if (label.includes('女')) {
    return '只能用“她/女生/女同学/少女/女孩”等女性称谓，禁止写成男生、男孩、少年、男子、男人或用男性化指代。';
  }
  if (label.includes('男')) {
    return '只能用“他/男生/男同学/少年/男孩”等男性称谓，禁止写成女生、女孩、少女、女子、女人或用女性化指代。';
  }
  return '不要自行改写性别。';
}

export function renderCharacterFactsForPrompt(characters: Character[], limit = 24): string {
  const selected = characters.slice(0, limit);
  if (selected.length === 0) return '- 无';

  return selected
    .map((character) => {
      const persona = character.persona;
      const relationships = Object.entries(character.currentState.relationships ?? {})
        .slice(0, 8)
        .map(([name, relation]) => `${name}：${relation.note}`)
        .join('；');

      return `## ${character.name}（${character.role}）
- 性别：${persona.gender || '未记录'}
- 身份/背景：${persona.background || '未记录'}
- 外貌：${persona.appearance || '未记录'}
- 性格：${persona.personality.join('、') || '未记录'}
- 立场：${persona.stance || '未记录'}
- 目标：${persona.goals.join('、') || '未记录'}
- 职业/等级：${persona.profession || '未记录'} / ${character.currentState.level ? `Lv ${character.currentState.level}` : '未记录'}
- 天赋：${persona.talents?.join('、') || '无'}
- 技能：${persona.skills?.join('、') || '无'}
- 装备：${persona.equipment?.join('、') || '无'}
- 坐骑/宠物：${persona.mounts?.join('、') || '无'} / ${persona.pets?.join('、') || '无'}
- 背包/随身物：${persona.inventory?.join('、') || '无'}
- 关系：${relationships || '未记录'}
- 性别称谓硬约束：${genderRule(persona.gender)}`;
    })
    .join('\n\n');
}

export function renderStoryDesignForPrompt(storyDesign?: StoryDesign): string {
  if (!storyDesign) return '- 无';
  return [
    `当前拍点：${storyDesign.currentBeat || '-'}`,
    `场景目的：${storyDesign.scenePurpose || '-'}`,
    storyDesign.eventSeeds?.length ? `可用事件刺激：\n${storyDesign.eventSeeds.map((item) => `- ${item}`).join('\n')}` : '',
    storyDesign.systemConcepts?.length ? `体系奇观/玩法种子：\n${storyDesign.systemConcepts.map((item) => `- ${item}`).join('\n')}` : '',
    storyDesign.progressionHooks?.length ? `成长/掉落/职业钩子：\n${storyDesign.progressionHooks.map((item) => `- ${item}`).join('\n')}` : '',
    storyDesign.crowdPressure?.length ? `群众压力：\n${storyDesign.crowdPressure.map((item) => `- ${item}`).join('\n')}` : '',
    storyDesign.temporaryCast?.length ? `临时配角入口：\n${storyDesign.temporaryCast.map((item) => `- ${item}`).join('\n')}` : '',
    storyDesign.settingGuardrails?.length ? `设定护栏：\n${storyDesign.settingGuardrails.map((item) => `- ${item}`).join('\n')}` : '',
    storyDesign.directorNotes?.length ? `导演提示：\n${storyDesign.directorNotes.map((item) => `- ${item}`).join('\n')}` : '',
    storyDesign.auditQuestions?.length ? `审核问题：\n${storyDesign.auditQuestions.map((item) => `- ${item}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

export function requiredCharacterNamesFromText(characters: Character[], ...texts: Array<string | null | undefined>): string[] {
  const source = texts.filter(Boolean).join('\n');
  if (!source) return [];
  return characters
    .map((character) => character.name)
    .filter((name) => source.includes(name));
}

function sentenceWindows(content: string, name: string): string[] {
  const windows: string[] = [];
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sentenceRe = new RegExp(`[^。！？\\n]{0,50}${escaped}[^。！？\\n]{0,50}`, 'g');
  for (const match of content.matchAll(sentenceRe)) {
    windows.push(match[0]);
  }
  return windows;
}

function hasGenderConflictWindow(window: string, name: string, gender: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (gender.includes('女')) {
    return new RegExp(`(${escaped}.{0,8}(是|这个|那个|作为|身为|像个|像一个)?(男生|男孩|男同学|少年|男子|男人)|(男生|男孩|男同学|少年|男子|男人).{0,8}${escaped})`).test(window);
  }
  if (gender.includes('男')) {
    return new RegExp(`(${escaped}.{0,8}(是|这个|那个|作为|身为|像个|像一个)?(女生|女孩|女同学|少女|女子|女人)|(女生|女孩|女同学|少女|女子|女人).{0,8}${escaped})`).test(window);
  }
  return false;
}

function chapterConstraintText(chapter?: ChapterFocus): string {
  if (!chapter) return '';
  return [
    chapter.goal,
    chapter.scope,
    ...(chapter.beats ?? []),
    ...(chapter.constraints ?? []),
  ].filter(Boolean).join('\n');
}

function storyDesignConstraintText(storyDesign?: StoryDesign): string {
  if (!storyDesign) return '';
  return [
    storyDesign.currentBeat,
    storyDesign.scenePurpose,
    ...(storyDesign.eventSeeds ?? []),
    ...(storyDesign.progressionHooks ?? []),
    ...(storyDesign.settingGuardrails ?? []),
    ...(storyDesign.directorNotes ?? []),
  ].filter(Boolean).join('\n');
}

function requiresProgressionFeedback(input: {
  currentChapter?: ChapterFocus;
  storyDesign?: StoryDesign;
  instruction?: string;
}): boolean {
  const source = [
    chapterConstraintText(input.currentChapter),
    storyDesignConstraintText(input.storyDesign),
    input.instruction,
  ].filter(Boolean).join('\n');
  if (!source) return false;
  if (/(不写|不要|禁止|不得).{0,12}(经验|EXP|等级|掉落|奖励)/i.test(source)) return false;
  return /(杀怪|击杀|杀死|打死|补杀|首杀|有效贡献).{0,40}(经验|EXP|等级|升级|掉落|奖励|反馈|结算)|经验反馈|经验条|加经验|获得经验|经验值|掉落反馈|首杀奖励/i.test(source);
}

function contentHasMonsterKill(content: string): boolean {
  return /(击杀|杀死|打死|杀掉|补杀|首杀|处刑|砸死|捅死|斩杀|挣扎骤停|当场瘫下|死透|尸体)/.test(content) &&
    /(怪物|小怪|BOSS|Boss|boss|黑影|裂隙生物|壳怪|兽|魔物|深渊)/.test(content);
}

function contentHasProgressionFeedback(content: string): boolean {
  return /(经验|EXP|Exp|exp|等级|升级|Lv\s*\d+|LV\s*\d+|经验条|奖励|掉落|战利品|结算|贡献)/.test(content);
}

export function validateChapterContent(input: {
  content: string;
  targetMin: number;
  targetMax: number;
  characters: Character[];
  requiredCharacterNames?: string[];
  enforceWordTarget?: boolean;
  currentChapter?: ChapterFocus;
  storyDesign?: StoryDesign;
  instruction?: string;
  previousChapterBridge?: ChapterBridgeContext | null;
}): ChapterValidationResult {
  const readableCount = countReadableChars(input.content);
  const issues: ChapterValidationIssue[] = [];
  const targetLabel = formatChapterWordTarget(input.targetMin, input.targetMax);

  if (input.enforceWordTarget !== false && readableCount < input.targetMin) {
    issues.push({
      code: 'too_short',
      message: `正文可读字数 ${readableCount}，低于目标 ${targetLabel}。`,
    });
  }

  if (input.enforceWordTarget !== false && readableCount > input.targetMax) {
    issues.push({
      code: 'too_long',
      message: `正文可读字数 ${readableCount}，超过目标 ${targetLabel}。`,
    });
  }

  for (const name of input.requiredCharacterNames ?? []) {
    if (!input.content.includes(name)) {
      issues.push({
        code: 'missing_required_character',
        fatal: true,
        message: `导演设计/采纳结论点名了“${name}”，但正文没有出现该角色。`,
      });
    }
  }

  if (input.currentChapter && input.currentChapter.chapterNo > 1 && input.previousChapterBridge) {
    const start = input.content.trim().slice(0, 700);
    const previousTail = input.previousChapterBridge.tail;
    const previousAlreadyInCombat = /(小怪|怪物|黑浆|断砖|广播台|台阶|安全区|首杀|扑|砸|血|口器|尸)/.test(previousTail);
    const startsInCombat = /^(断砖|砖|刀|剑|血|黑浆|小怪|怪物|台阶|广播台|轰|砰|刺|扑|撞|撕|爆|口器|尸)/.test(start) ||
      (/^(那一刻|下一秒|又是一|仍|还在|直到)/.test(start) && /(小怪|怪物|黑浆|台阶|广播台|伤者|首杀|安全区|口器)/.test(start));
    const hasBridge = /(几分钟前|刚才|余波|上一章|上一刻|还|仍|刚|之后|消散|熄灭|前一场|上一场|先前|方才)/.test(start);

    if (startsInCombat && !hasBridge && !previousAlreadyInCombat) {
      issues.push({
        code: 'weak_chapter_bridge',
        fatal: true,
        message: `第 ${input.currentChapter.chapterNo} 章开头像战斗中段，但上一章《${input.previousChapterBridge.chapterTitle}》结尾没有进入该战斗现场。必须先补上一章余波到本章危机的过渡。`,
      });
    }
  }

  if (
    requiresProgressionFeedback({
      currentChapter: input.currentChapter,
      storyDesign: input.storyDesign,
      instruction: input.instruction,
    }) &&
    contentHasMonsterKill(input.content) &&
    !contentHasProgressionFeedback(input.content)
  ) {
    issues.push({
      code: 'missing_progression_feedback',
      fatal: true,
      message: '当前章方向/采纳结论要求“击杀后有经验、等级、掉落或奖励反馈”，但正文出现明确杀怪后没有任何可见成长反馈。必须在关键击杀后补入短促的经验/奖励反馈，不能只停留在设计讨论里。',
    });
  }

  for (const character of input.characters) {
    if (!character.name || !input.content.includes(character.name)) continue;
    const gender = character.persona.gender ?? '';
    const windows = sentenceWindows(input.content, character.name);

    if (gender.includes('女')) {
      const conflict = windows.find((window) => hasGenderConflictWindow(window, character.name, gender));
      if (conflict) {
        issues.push({
          code: 'gender_conflict',
          fatal: true,
          message: `${character.name} 的档案性别是女，但正文附近出现男性称谓：“${conflict.slice(0, 80)}”。`,
        });
      }
    }

    if (gender.includes('男')) {
      const conflict = windows.find((window) => hasGenderConflictWindow(window, character.name, gender));
      if (conflict) {
        issues.push({
          code: 'gender_conflict',
          fatal: true,
          message: `${character.name} 的档案性别是男，但正文附近出现女性称谓：“${conflict.slice(0, 80)}”。`,
        });
      }
    }
  }

  return { readableCount, issues };
}

function cleanChapterText(raw: string): string {
  return raw
    .replace(/^```(?:\w+)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/^第[一二三四五六七八九十百\d]+章[^\n]*\n+/, '')
    .replace(/^《[^》]+》\s*\n+/, '')
    .replace(/^(以下是|正文[:：]|小说正文[:：]|修正版[:：]).*\n+/i, '')
    .trim();
}

function buildRepairMessages(input: {
  content: string;
  issues: ChapterValidationIssue[];
  targetMin: number;
  targetMax: number;
  characters: Character[];
  requiredCharacterNames?: string[];
  currentChapter?: ChapterFocus;
  storyDesign?: StoryDesign;
  instruction?: string;
  sourceContext?: string;
  enforceWordTarget?: boolean;
  previousChapterBridge?: ChapterBridgeContext | null;
}): ChatMessage[] {
  const targetLabel = formatChapterWordTarget(input.targetMin, input.targetMax);
  const compressMode = input.issues.some((issue) => issue.code === 'too_long');
  const targetMid = Math.floor((input.targetMin + input.targetMax) / 2);
  const wordTargetRule =
    input.enforceWordTarget === false
      ? '- 这次是局部修正，不要为了字数重写全章；保持原稿篇幅和段落结构，优先修正硬性事实错误。'
      : `- 正文可读字数必须落在 ${targetLabel}；系统统计时会排除空格、换行和标点，但正文必须保留正常中文标点。`;
  return [
    {
      role: 'system',
      content: `你是 NovelStudio 的章节修稿 Writer。只输出修正后的小说正文，不要标题、解释或 markdown。

硬性修稿要求：
- 先修正列出的失败项，再保持原文主要情节、叙述视角和章节节奏。
${wordTargetRule}
- ${compressMode ? `当前稿过长，必须压缩到约 ${targetMid} 可读字。删除重复人群反应、同义解释、重复心理和拖慢节奏的铺陈，不要扩写。` : '如果当前稿过短，只扩写当前章已经发生的日常、违和、反应、对话、心理、环境和余波。'}
- 涉及角色性别、身份、关系、姓名时，以“人物基础设定库”为最高事实约束。
- 不要新增当前章之外的大节点，不要提前兑现后续体系、装备、技能、等级、掉落或组织制度。
- 如果失败项要求补经验/等级/掉落/奖励反馈，必须贴近有效贡献者写出短促、可结算的文本锚点，例如“苏见山眼前一闪：【经验 +20】”；不要写成长篇教学面板。
- 不要为了计数删掉标点；中文句读要正常。`,
    },
    {
      role: 'user',
      content: `# 当前章
第 ${input.currentChapter?.chapterNo ?? 1} 章《${input.currentChapter?.title ?? '未命名章节'}》
目标：${input.currentChapter?.goal ?? '-'}
范围：${input.currentChapter?.scope ?? '-'}
节拍：
${input.currentChapter?.beats?.map((beat, index) => `${index + 1}. ${beat}`).join('\n') || '- 无'}
护栏：
${input.currentChapter?.constraints?.map((item) => `- ${item}`).join('\n') || '- 无'}

# 用户/导演最高优先级修正
${input.instruction || '- 无'}

# 当前剧情设计师/导演设计
${renderStoryDesignForPrompt(input.storyDesign)}

# 人物基础设定库
${renderCharacterFactsForPrompt(input.characters)}

# 必须在正文落实的点名角色
${input.requiredCharacterNames?.length ? input.requiredCharacterNames.map((name) => `- ${name}`).join('\n') : '- 无'}

# 失败项
${input.issues.map((issue, index) => `${index + 1}. ${issue.message}`).join('\n')}

${input.sourceContext ? `# 可参考上下文\n${input.sourceContext.slice(0, 2600)}\n` : ''}
${input.previousChapterBridge ? `# 上一章正稿结尾（章际桥硬约束）\n${input.previousChapterBridge.prompt.slice(0, 2600)}\n` : ''}
# 待修正文
"""
${input.content.slice(0, 9000)}
"""

# 输出
直接输出修正后的完整中文小说正文。`,
    },
  ];
}

export async function repairChapterUntilValid(input: {
  content: string;
  targetMin: number;
  targetMax: number;
  characters: Character[];
  requiredCharacterNames?: string[];
  currentChapter?: ChapterFocus;
  storyDesign?: StoryDesign;
  instruction?: string;
  sourceContext?: string;
  maxAttempts?: number;
  enforceWordTarget?: boolean;
  previousChapterBridge?: ChapterBridgeContext | null;
}): Promise<{
  content: string;
  validation: ChapterValidationResult;
  repairAttempts: number;
}> {
  let content = cleanChapterText(input.content);
  let validation = validateChapterContent({
    content,
    targetMin: input.targetMin,
    targetMax: input.targetMax,
    characters: input.characters,
    requiredCharacterNames: input.requiredCharacterNames,
    enforceWordTarget: input.enforceWordTarget,
    currentChapter: input.currentChapter,
    storyDesign: input.storyDesign,
    instruction: input.instruction,
    previousChapterBridge: input.previousChapterBridge,
  });
  const maxAttempts = input.maxAttempts ?? 2;
  let repairAttempts = 0;

  while (validation.issues.length > 0 && repairAttempts < maxAttempts) {
    repairAttempts += 1;
    const hasTooLong = validation.issues.some((issue) => issue.code === 'too_long');
    content = cleanChapterText(await chat(
      buildRepairMessages({
        content,
        issues: validation.issues,
        targetMin: input.targetMin,
        targetMax: input.targetMax,
        characters: input.characters,
        requiredCharacterNames: input.requiredCharacterNames,
        currentChapter: input.currentChapter,
        storyDesign: input.storyDesign,
        instruction: input.instruction,
        sourceContext: input.sourceContext,
        enforceWordTarget: input.enforceWordTarget,
        previousChapterBridge: input.previousChapterBridge,
      }),
      { temperature: hasTooLong ? 0.32 : 0.48, maxTokens: hasTooLong ? 4200 : 6800 }
    ));
    validation = validateChapterContent({
      content,
      targetMin: input.targetMin,
      targetMax: input.targetMax,
      characters: input.characters,
      requiredCharacterNames: input.requiredCharacterNames,
      enforceWordTarget: input.enforceWordTarget,
      currentChapter: input.currentChapter,
      storyDesign: input.storyDesign,
      instruction: input.instruction,
      previousChapterBridge: input.previousChapterBridge,
    });
  }

  return { content, validation, repairAttempts };
}
