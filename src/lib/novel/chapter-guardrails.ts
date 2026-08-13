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
    | 'missing_progression_feedback'
    | 'design_echo';
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
  // 性别称谓必须是紧贴目标角色的描述词，中间只能出现“像/是/身为/作为”等链接词或极短的非标点间隙，
  // 禁止跨越“，。！？；、\n”等短语边界去匹配句子里其他角色（如“矮个女生”“一个男生”）的称谓。
  const gap = '[^，。！？；、\\n]{0,6}';
  const linker = '(是|这个|那个|作为|身为|像个|像一个|像)';
  const maleTerms = '(男生|男孩|男同学|少年|男子|男人)';
  const femaleTerms = '(女生|女孩|女同学|少女|女子|女人)';
  // 方向 1：姓名在前，如“赵铁山像个女生一样”——必须带链接词，且只查与档案性别相反的称谓。
  // 方向 2：相反称谓在前且紧贴姓名，如“女生赵铁山”——仅允许极短无标点间隙。
  if (gender.includes('女')) {
    return new RegExp(`${escaped}${gap}${linker}${gap}${maleTerms}`).test(window) ||
      new RegExp(`${maleTerms}${gap}${linker}?${escaped}`).test(window);
  }
  if (gender.includes('男')) {
    return new RegExp(`${escaped}${gap}${linker}${gap}${femaleTerms}`).test(window) ||
      new RegExp(`${femaleTerms}${gap}${linker}?${escaped}`).test(window);
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
  eventText?: string;
}): ChapterValidationResult {
  const readableCount = countReadableChars(input.content);
  const issues: ChapterValidationIssue[] = [];
  const targetLabel = formatChapterWordTarget(input.targetMin, input.targetMax);

  // 检测“设计复述/写作计划”混入：如果正文含有导演设计或修稿指令的结构性标题词，
  // 说明模型把设计 JSON 或计划照抄成了正文，而不是真的写了小说正文。
  const designEchoRe = /(最终节拍|可用事件|体系奇观|设定护栏|成长[\/、]?掉落[\/、]?职业钩子|群众压力|临时配角入口|其余需要整合的上下文|待修正文|目标约|大纲：|结构：|节拍[:：])/;
  const echoMatch = input.content.match(designEchoRe);
  if (echoMatch) {
    issues.push({
      code: 'design_echo',
      fatal: true,
      message: `正文疑似混入了导演设计/写作计划（“${echoMatch[0].trim().slice(0, 20)}”），而不是完整的小说正文。请只输出正式小说正文，不要复述设计字段或写作思路。`,
    });
  }

  // 检测“越章意象”混入：正文出现事件日志中完全没有的、明确属于后续章节的专有名词，
  // 说明 Writer 把后续章的场景（广播台对峙、大壳怪、禁退线等）错误写进了本章。
  // 只用明确的后续章专有词，不用“伤口/血/裂缝”这类通用词，避免误伤正常创作。
  if (input.eventText) {
    const inventedImagery = [
      { term: '广播台', pattern: /广播台|广播室/ },
      { term: '大壳怪', pattern: /大壳怪|壳怪|巨壳/ },
      { term: '禁退线', pattern: /禁退线|后撤线|收声|噤声/ },
      { term: '教堂叠影', pattern: /教堂叠影|叠影/ },
      { term: '静默求生', pattern: /静默求生|静默压制/ },
      { term: '灰白硬物', pattern: /灰白(?:硬物|弧面|物)|弧面/ },
      { term: '血痕', pattern: /血痕|渗血|拖出血|血珠/ },
      { term: '裂缝', pattern: /墙根裂缝|砖缝里的裂缝|裂缝边缘/ },
    ];
    const eventSrc = input.eventText;
    for (const item of inventedImagery) {
      if (item.pattern.test(input.content) && !item.pattern.test(eventSrc)) {
        issues.push({
          code: 'design_echo',
          fatal: true,
          message: `正文出现了事件日志中没有的后续章意象“${item.term}”。请只写本章事件里真实发生的内容，不要把广播台、大壳怪、禁退线等后续章场景写进当前章。`,
        });
        break;
      }
    }
  }

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
  let text = raw
    .replace(/^```(?:\w+)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/^第[一二三四五六七八九十百\d]+章[^\n]*\n+/, '')
    .replace(/^《[^》]+》\s*\n+/, '')
    .replace(/^(以下是|正文[:：]|小说正文[:：]|修正版[:：]|用户需要我输出).*\n+/i, '')
    .trim();

  // 剥离开头的写作思考/计划（修稿模型常先输出“嗯，用户要求…”“我要先…”“结构上…”再写正文）。
  const headMetaRe = /^(?:嗯|好的|好|那么|首先|用户[要求希望让]*|我需要|我要|我先|让我|这次|本章|作为|整体|结构上|节奏上|角色|注意|最终|草稿|目标)[^。！？\n]{0,200}[。！？\n]/;
  // 找到第一个真正像正文的段落起点：正文通常以角色动作/对话/场景描写开头。
  // 策略：若开头若干段是计划性文字（含“章节”“正文”“字数”“结构”“节奏”“护栏”“事件日志”“演绎”“风格锚点”等元词），整体跳过。
  const metaWordRe = /(章节|正文|字数|篇幅|可读|结构|节奏|护栏|事件日志|演绎|风格锚点|用户要求|写作|计划|框架|大纲|需要|补充|修正|衔接|铺垫|高潮|收尾|章末钩子|悬念|对话要|符合设定|核心是|护栏：)/;
  const paragraphs = text.split(/\n\s*\n/);
  let start = 0;
  for (let i = 0; i < paragraphs.length && i < 8; i++) {
    const para = paragraphs[i].replace(/\s+/g, ' ').trim();
    if (!para) continue;
    // 以写作计划动词开头，或整段含元词（尤其“符合设定”“护栏”“需要”“注意”“结构上”），或“第N拍/需要保持/开始写/结尾”规划段，视为计划段跳过。
    if (
      /^(嗯|好的|好，|用户[要求希望让]*|我需要|我要|我先|让我|这次|整体|结构上|节奏上|已经提供了|可以用|核心是|篇幅|注意|角色|先看|先写|草稿|目标|我将|让我|结尾[:：]?)/.test(para) ||
      /^第[一二三四五六七八九十]+拍/.test(para) ||
      /^(需要保持|开始写|结束写|第一拍|第二拍|第三拍)/.test(para) ||
      (metaWordRe.test(para) && i <= 1)
    ) {
      start = i + 1;
    } else {
      break;
    }
  }
  if (start > 0) {
    text = paragraphs.slice(start).join('\n\n').trim();
  }

  // 剥离后首段仍可能混有元前缀（如“注意几个护栏：…；【文明接入完成。…”），
  // 先按行剥离写作自述（“我必须只输出…”“让我写…”“实际上，仔细看看…”），再找强场景句截断。
  const lines = text.split('\n');
  let lineStart = 0;
  for (let i = 0; i < lines.length && i < 5; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (/^(我必须|让我|我要|我只|只输出|实际上，?|仔细|来看看|来看|先看看|我需要|我先|我应该|好的|好，|嗯，|现在|注意|下面|接下来|上一步|上一轮|第一拍|第二拍|第三拍|我写|其实|然后|在|而|但|不过)/.test(line) ||
        /(只输出正文|不加开头|干净版本|写一个|风格|视角|保持一致|待修正文|事件日志|看看|估算|导演要求|最终节拍|可用事件|我会这样处理|重新考虑|让我重新)/.test(line)) {
      lineStart = i + 1;
    } else {
      break;
    }
  }
  if (lineStart > 0) text = lines.slice(lineStart).join('\n').trim();

  // 首段如果是“说明性/提纲式”句式（在…上 / 为… / 带有…效果 / 然后 / 实际上 等高频出现），
  // 说明模型把设定说明当成了正文开头，整段剥离，直到出现真正的场景/动作/对话。
  const paragraphs2 = text.split(/\n\s*\n/);
  let paraStart = 0;
  for (let i = 0; i < paragraphs2.length && i < 5; i++) {
    const para = paragraphs2[i].replace(/\s+/g, ' ').trim();
    if (!para) continue;
    const explanationScore =
      (para.match(/(然后|在.{0,8}(上|里|处)|为[““']|带有.{0,6}效果|实际上|其实|也就是说|这意味着|让我|我需要|用户说|导演要求|会这样处理|重新考虑|现在，我需要|最后|首先|其次)/g) || []).length;
    const isRealScene = /(【|「|冷蓝|操场|广播|系统音|苏见山.{0,6}(站|走|抬|蹲|看|望|攥|挡|没|扫|低头)|赵铁山|白晏|所有人|天空|一脚|忽然|突然|轰|吱|嗡)/.test(para);
    if (explanationScore >= 2 && !isRealScene) {
      paraStart = i + 1;
    } else {
      break;
    }
  }
  if (paraStart > 0) text = paragraphs2.slice(paraStart).join('\n\n').trim();

  const firstLine = text.split(/\n/)[0] ?? '';
  const sceneStart = firstLine.search(/(【[^】]+】|「文明|冷蓝色?的光屏|冷蓝|淡金|操场|江城一高|广播|系统音|低沉的|光屏|天空|教室|门口|人群中|所有人|无数目光|苏见山|赵铁山|白晏)/);
  if (sceneStart > 0 && sceneStart < firstLine.length) {
    const candidate = text.slice(sceneStart).trim();
    if (candidate.length > 80) text = candidate;
  }

  // 剥离修稿模型在正文末尾追加的思考/统计/说明性内容：
  // 常见开头如“现在数数”“我数汉字”“第一段…= 39”“草稿”“目标约”“字数统计”“让我数”。
  // 允许其前面出现 --- / ——— 分隔线或空行；匹配到即从该行起截断，覆盖后续多行统计。
  // 注意“第一段路”这类正常正文不算元内容，故“第N段”后需紧跟冒号/等号/逗号/换行/句号才算统计段。
  const metaStartRe = /(?:^|\n)\s*(?:[-—]{2,}\s*)?(?:(?:现在|下面|我|让我)[来要]*[数统概梳整理核对计算]+|字数统计|可读字符|目标约|草稿[:：]?|修正后字数|(?:第一|第二|第三|第四|第五|第六)[一二三四五六七八九十\d]*段(?=\s*[:：=，,。]))[^\n]*/;
  const metaMatch = text.match(metaStartRe);
  let cleaned = text;
  if (metaMatch && typeof metaMatch.index === 'number') {
    cleaned = text.slice(0, metaMatch.index).trim();
  }
  return cleaned.length > 0 ? cleaned : text;
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
  const currentCount = input.issues.find((issue) => issue.code === 'too_long' || issue.code === 'too_short')?.message.match(/\d+/)?.[0];
  const wordTargetRule =
    input.enforceWordTarget === false
      ? '- 这次是局部修正，不要为了字数重写全章；保持原稿篇幅和段落结构，优先修正硬性事实错误。'
      : `- 正文可读字数必须落在 ${targetLabel}；系统统计时会排除空格、换行和标点，但正文必须保留正常中文标点。`;
  const compressRule = compressMode
    ? `- 当前稿过长，必须一次压缩到位：可读字数必须 ≤ ${input.targetMax}（目标约 ${targetMid}）。当前约 ${currentCount} 字，至少删减掉重复人群反应、同义解释、重复心理、拖慢节奏的铺陈和无关细节；不要扩写。如果压缩后仍超过，系统会继续打回重写，直到达标。`
    : `- 如果当前稿过短，只扩写当前章已经发生的日常、违和、反应、对话、心理、环境和余波。`;
  return [
    {
      role: 'system',
      content: `你是 NovelStudio 的章节修稿 Writer。只输出修正后的小说正文，不要标题、解释或 markdown。

硬性修稿要求：
- 先修正列出的失败项，再保持原文主要情节、叙述视角和章节节奏。
${wordTargetRule}
${compressRule}
- 涉及角色性别、身份、关系、姓名时，以“人物基础设定库”为最高事实约束。
- 不要新增当前章之外的大节点，不要提前兑现后续体系、装备、技能、等级、掉落或组织制度。
- 如果失败项要求补经验/等级/掉落/奖励反馈，必须贴近有效贡献者写出短促、可结算的文本锚点，例如“苏见山眼前一闪：【经验 +20】”；不要写成长篇教学面板。
- 不要为了计数删掉标点；中文句读要正常。

输出纪律（违反任何一条都会判定为不合格）：
1. 你的整个输出就是小说正文本身，从第一个字到最后一个字都必须是正文。
2. 禁止输出任何元内容：不得写“草稿”“我来写”“我需要压缩”“字数统计”“现在我数一下”“第一段…= 39”“目标约2400”“保留现有内容的关键节拍”等思考、计划、计数或说明。
3. 不得以“用户需要我”“我必须”“首先”“好的”等开头，不得在正文前后追加任何解释。
4. 直接以正文第一句开始，正文最后一句自然结束。`,
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
直接输出修正后的完整中文小说正文。你的全部输出就是正文本身：第一个字符必须是正文第一句，最后一个字符必须是正文结尾，不得包含任何字数统计、修改说明、草稿标注或“以下是正文”之类的元内容。`,
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
  eventText?: string;
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
    eventText: input.eventText,
  });
  const maxAttempts = input.maxAttempts ?? 4;
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
      { model: 'gpt-5.6-luna', temperature: hasTooLong ? 0.32 : 0.48, maxTokens: hasTooLong ? 4200 : 6800 }
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
      eventText: input.eventText,
    });
  }

  // 保底：LLM 修稿仍压不下来时，按句号断句截断到目标上限内，保证正文可以落库。
  if (input.enforceWordTarget !== false && validation.issues.some((issue) => issue.code === 'too_long')) {
    const truncated = truncateToMaxLength(content, input.targetMax);
    if (truncated !== content) {
      content = truncated;
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
        eventText: input.eventText,
      });
      repairAttempts += 1;
    }
  }

  // 最终清理：剥离修稿模型混入正文首尾的思考/统计/规划文字。
  const finalCleaned = cleanChapterText(content);
  if (finalCleaned !== content) {
    content = finalCleaned;
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
      eventText: input.eventText,
    });
  }

  return { content, validation, repairAttempts };
}

/** 把超长正文按句子边界截断到目标可读字数以内（优先保留开头完整场面）。 */
function truncateToMaxLength(content: string, targetMax: number): string {
  const sentences = content.split(/(?<=[。！？])/);
  let current = '';
  let count = 0;
  for (const sentence of sentences) {
    const sentenceCount = countReadableChars(sentence);
    if (count + sentenceCount > targetMax) break;
    current += sentence;
    count += sentenceCount;
  }
  const result = current.trim();
  return result.length > 0 && result !== content.trim() ? result : content.trim();
}
