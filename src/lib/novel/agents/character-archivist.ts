/**
 * Character Archivist
 *
 * 章节正文落地后统一归档人物变化。角色、写手、读者都可以提供证据，
 * 但人物库只通过这里输出的结构化补丁更新，避免多个 agent 各改各的。
 */

import { chat, extractJSON, type ChatMessage } from '../llm';
import type { Character, ChapterFocus, NovelEvent, ReaderReview } from '../types';
import type { CharacterProgressUpdate } from './director';

interface CharacterArchiveContext {
  chapterText: string;
  events: NovelEvent[];
  characters: Character[];
  reviews: ReaderReview[];
  currentChapter?: ChapterFocus;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 8)
    : [];
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function clipText(text: string, head = 3200, tail = 2400): string {
  if (text.length <= head + tail + 200) return text;
  return `${text.slice(0, head)}\n\n[中段省略 ${text.length - head - tail} 字]\n\n${text.slice(-tail)}`;
}

function renderCharacter(character: Character): string {
  const persona = character.persona;
  return `## ${character.name}（${character.role}）
- 性别：${persona.gender || '未记录'}
- 基础背景：${persona.background || '未记录'}
- 外貌：${persona.appearance || '未记录'}
- 性格：${persona.personality?.join('、') || '未记录'}
- 立场：${persona.stance || '未记录'}
- 目标：${persona.goals?.join('；') || '未记录'}
- 说话方式：${persona.speechStyle || '未记录'}
- 成长弧线：${persona.growthArc || '未记录'}
- 内在冲突：${persona.innerConflict || '未记录'}
- 秘密：${persona.secrets?.join('；') || '未记录'}
- 当前职业/等级/经验：${persona.profession || '未记录'} / ${character.currentState.level ? `Lv ${character.currentState.level}` : '未记录'} / ${character.currentState.exp ?? 0}/${character.currentState.nextLevelExp ?? '未记录'}
- 技能：${persona.skills?.join('、') || '无'}
- 装备：${persona.equipment?.join('、') || '无'}
- 天赋：${persona.talents?.join('、') || '无'}
- 坐骑/宠物：${persona.mounts?.join('、') || '无'} / ${persona.pets?.join('、') || '无'}
- 背包/随身物：${persona.inventory?.join('、') || '无'}
- 当前位置/情绪：${character.currentState.location || '未记录'} / ${character.currentState.emotion || '未记录'}`;
}

function renderEvents(events: NovelEvent[]): string {
  return events
    .map((event) => `T${event.turn} ${event.agentName}/${event.type}: ${event.content}`)
    .join('\n');
}

function renderReviews(reviews: ReaderReview[]): string {
  return reviews
    .map((review) => {
      const problems = review.problems?.slice(0, 3).join('；') || '无';
      const suggestions = review.suggestions?.slice(0, 3).join('；') || '无';
      const questions = review.exposedQuestions?.slice(0, 3).join('；') || '无';
      return `- ${review.readerName}：${review.summary}。问题：${problems}。建议：${suggestions}。暴露问题：${questions}`;
    })
    .join('\n');
}

function hasPayload(update: CharacterProgressUpdate): boolean {
  return !!(
    update.gender ||
    update.background ||
    stringList(update.personality).length ||
    stringList(update.goals).length ||
    update.stance ||
    update.speechStyle ||
    update.appearance ||
    update.backstory ||
    update.growthArc ||
    update.innerConflict ||
    stringList(update.secrets).length ||
    stringList(update.motivations).length ||
    stringList(update.speechHabits).length ||
    update.level ||
    Number(update.expDelta) > 0 ||
    update.profession ||
    stringList(update.addSkills).length ||
    stringList(update.removeSkills).length ||
    stringList(update.addEquipment).length ||
    stringList(update.removeEquipment).length ||
    stringList(update.addTalents).length ||
    stringList(update.addMounts).length ||
    stringList(update.removeMounts).length ||
    stringList(update.addPets).length ||
    stringList(update.removePets).length ||
    stringList(update.addInventory).length ||
    stringList(update.removeInventory).length ||
    stringList(update.addTitles).length ||
    stringList(update.addBuffs).length ||
    stringList(update.removeBuffs).length
  );
}

function normalizeUpdates(value: unknown): CharacterProgressUpdate[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item: any) => ({
      characterId: optionalString(item.characterId),
      characterName: optionalString(item.characterName),
      reason: optionalString(item.reason) ?? '章节正文归档',
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
      profession: optionalString(item.profession),
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
    }))
    .filter((item) => !!(item.characterId || item.characterName))
    .filter(hasPayload);
}

export async function summarizeCharacterChapterUpdates(
  ctx: CharacterArchiveContext
): Promise<CharacterProgressUpdate[]> {
  if (ctx.characters.length === 0 || !ctx.chapterText.trim()) return [];

  const chapterLabel = ctx.currentChapter
    ? `第 ${ctx.currentChapter.chapterNo} 章《${ctx.currentChapter.title}》`
    : '当前章节';

  const systemPrompt = `你是 NovelStudio 的“人物档案归档 Agent”。

你的职责：在章节正文落地后，根据正文、事件日志和读者评审，提取人物档案中已经被本章确认的变化。

硬规则：
1. 只归档已发生、已公开、正文明确写出的变化；不要设计未来剧情。
2. background/goals/stance 是“当前行动档案”，会直接影响演员自发行动；只能写角色当前已知和当前可执行的内容，不得写未来觉醒、终局身份、幕后真相、最终阵营、未来关系归宿或项目尚未公开的核心秘密。
3. 性别、身份、出身、核心背景是硬设定，只有用户明确修正或正文/大纲明确确认时才可更新。
4. 性格、立场、目标、成长弧线、内在冲突可以根据本章经历缓慢变化，但必须有 reason；未来方向优先写入 growthArc/backstory/secrets，且不能让角色当作已知事实。
5. 技能、装备、天赋、经验、等级、物品、称号、坐骑、宠物/契约兽只能在事件日志或正文明确获得/失去时更新；不要写“待解锁”。
6. 若项目定义了经验/等级体系，且正文/事件日志明确写了击杀、任务完成、首杀、机制破解或同类奖励结算，请输出 expDelta；若只是过程、未确认成功或无奖励结算，不要给经验。level 只在正文/系统提示明确显示升级到某级时填写；等级上限、破限条件和转职条件必须来自本项目创作圣经。
7. 职业、身份、境界、职级、关系阶段等体系字段只能在项目规则允许且正文明确触发时归档。
8. 群众、路人、一次性临时配角不建档，也不要输出更新。
9. 第一章开局人物关系通常是同学/同校/陌生/轻微信任；除非正文已经发生多次共同生死选择，否则不要概括为队友、伙伴、战友。

输出严格 JSON，不要 markdown：
{
  "characterUpdates": [
    {
      "characterName": "角色名",
      "reason": "本章哪一段事实支撑这个更新",
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
  ]
}`;

  const userPrompt = `# 归档章节
${chapterLabel}

# 当前人物档案
${ctx.characters.map(renderCharacter).join('\n\n')}

# 本章事件日志
${renderEvents(ctx.events) || '无'}

# 本章正文
${clipText(ctx.chapterText)}

# 读者评审暴露的问题
${renderReviews(ctx.reviews) || '无'}

# 任务
请输出本章结束后应该写入人物库的变化。若没有明确变化，输出 {"characterUpdates": []}。`;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const raw = await chat(messages, { temperature: 0.2, maxTokens: 1800 });
  const parsed = extractJSON<{ characterUpdates?: unknown }>(raw);
  return normalizeUpdates(parsed?.characterUpdates);
}
