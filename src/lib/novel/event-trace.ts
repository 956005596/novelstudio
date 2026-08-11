import type { Character, NovelEvent } from './types';

export type EventClosureStatus = Record<string, 'open' | 'closed'>;

type TraceReason = '持续状态' | '伏笔线索' | '未兑现后果' | '关系后果';

const TRACE_REASON_RULES: Array<{ reason: TraceReason; patterns: RegExp[] }> = [
  {
    reason: '持续状态',
    patterns: [
      // 身体/效果类持续状态，且不是泛指
      /(身中|中了|染上|被.*(附|蚀|封|烙)|残留).{0,6}(毒|诅咒|咒印|伤势|伤|污染|禁制|封印|印记|烙印|虚弱)/,
      /(持续|仍未|始终|一直).{0,8}(中毒|诅咒|咒印|虚弱|麻痹|眩晕|流血|标记|伤势)/,
      /状态.{0,4}(中毒|诅咒|虚弱|流血|伤势|标记|印记).{0,6}(未解除|未消退|仍在|持续)/,
      // 身体异常反应：发暗/渗血/刺痛/发烫/金纹亮起等具体身体变化（允许跨短句）
      /(手背|掌根|指尖|手腕|皮肤|伤口|疤痕|纹路|面板|天赋栏|那行字|视野).{0,26}(发暗|变黑|渗血|刺痛|发烫|亮起|灼烧|麻木|肿起|深了|更烫|热起来)/,
      /(黑线|金纹|残字|印记|标记|纹路).{0,12}(深了|扩散|蔓延|浮现|亮起|烫)/,
    ],
  },
  {
    reason: '伏笔线索',
    patterns: [
      /未解之谜|真相尚未|身份未明|来历不明|遗落|尘封|旧时代.{0,8}(秘密|真相)|神话时代.{0,8}(秘密|真相)|终焉器.{0,8}(沉默|沉寂|封印|真相)/,
      /(这条线索|这个线索|伏笔|谜团|疑点).{0,6}(待解|未解|指向|埋下|留下)/,
      // 悬而未决的异常现象：不是划伤/不该存在/说不通/不对劲，且尚未解释
      /(不是划伤|不是.{0,4}(伤口|伤)|不该存在|说不通|解释不清|无人能解释|没有来源|来历不明|像在|仿佛被)/,
    ],
  },
  {
    reason: '未兑现后果',
    patterns: [
      /(奖励|掉落|经验|EXP).{0,8}(待领取|未领取|未结算|待结算|未到账|欠着|差)/i,
      /(首杀|任务|悬赏).{0,8}(奖励待|待结算|未兑现|后续影响)/,
    ],
  },
  {
    reason: '关系后果',
    patterns: [
      /(欠.{0,4}(人情|债)|承诺过|立过誓|誓约仍|悬赏在身|被通缉|追杀中|关系.{0,4}破裂)/,
    ],
  },
];

function addUniqueCharacter(list: Character[], character?: Character | null) {
  if (!character) return;
  if (list.some((item) => item.id === character.id)) return;
  list.push(character);
}

function hasRelationshipWithProtagonist(character: Character, protagonists: Character[]): boolean {
  return protagonists.some((protagonist) =>
    Boolean(character.currentState.relationships?.[protagonist.name]) ||
    Boolean(protagonist.currentState.relationships?.[character.name])
  );
}

export function selectEventTraceCharacters(
  characters: Character[],
  presentCharacterIds: string[] = [],
  limit = 8
): Character[] {
  const presentIds = new Set(presentCharacterIds);
  const protagonists = characters.filter((character) => character.role === 'protagonist');
  const selected: Character[] = [];

  for (const character of protagonists) addUniqueCharacter(selected, character);
  for (const character of characters) {
    if (presentIds.has(character.id)) addUniqueCharacter(selected, character);
  }
  for (const character of characters) {
    if (hasRelationshipWithProtagonist(character, protagonists)) addUniqueCharacter(selected, character);
  }

  if (selected.length === 0) {
    for (const character of characters) addUniqueCharacter(selected, character);
  }

  return selected.slice(0, limit);
}

function textIncludesCharacter(text: string | null | undefined, character: Character): boolean {
  if (!text) return false;
  return text.includes(character.name);
}

function eventTraceText(event: NovelEvent): string {
  return [
    event.agentName,
    event.target ?? '',
    event.emotion ?? '',
    event.context ?? '',
    event.content,
  ].filter(Boolean).join('\n');
}

export function eventTouchesTrackedCharacters(event: NovelEvent, trackedCharacters: Character[]): boolean {
  if (trackedCharacters.length === 0) return false;
  const fields = [event.agentName, event.target ?? '', event.content, event.context ?? ''];
  const mentionsProtagonist = trackedCharacters.some((character) => character.role === 'protagonist') &&
    fields.some((field) => field.includes('主角') || field.includes('主角团'));

  return mentionsProtagonist || trackedCharacters.some((character) =>
    event.agentId === character.id ||
    event.agentName === character.name ||
    textIncludesCharacter(event.target, character) ||
    textIncludesCharacter(event.content, character) ||
    textIncludesCharacter(event.context, character)
  );
}

export function traceReasonForEvent(event: NovelEvent): TraceReason | null {
  // 角色档案更新、系统公告、场景描述不进入追踪
  if (/角色档案更新|档案更新|系统公告|文明接入|系统提示/.test(event.content ?? '')) return null;
  const text = eventTraceText(event);
  if (event.type === 'dialogue' || event.type === 'action') {
    const compact = text.replace(/\s+/g, '');
    // action/dialogue 必须是明确的持续/待结算事实，才值得追踪；普通动作（捡东西、顶住、喊话）不追踪。
    if (!/(中毒|诅咒|咒印|伤势|标记|承诺|誓约|悬赏|通缉|奖励待|掉落待|待领取|待结算|线索|谜团|真相未|秘密|后续影响|长期影响|刺痛|发暗|灼烧|黑线|金纹|烫|渗血|深了)/i.test(compact)) {
      return null;
    }
  }
  for (const rule of TRACE_REASON_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) return rule.reason;
  }
  return null;
}

export function eventLooksTraceWorthy(event: NovelEvent): boolean {
  return traceReasonForEvent(event) !== null;
}

function eventTouchesStoryScope(event: NovelEvent, trackedCharacters: Character[]): boolean {
  if (eventTouchesTrackedCharacters(event, trackedCharacters)) return true;
  const text = eventTraceText(event);
  return /主角|主角团|后续|长期|伏笔|线索|悬念|未解|持续状态|未兑现|结束原因|关系后果|奖励待结算/.test(text);
}

export function filterEventTraceEvents(
  events: NovelEvent[],
  trackedCharacters: Character[],
  eventClosureStatus: EventClosureStatus = {}
): NovelEvent[] {
  return events.filter((event) =>
    eventClosureStatus[event.id] !== 'closed' &&
    eventLooksTraceWorthy(event) &&
    eventTouchesStoryScope(event, trackedCharacters)
  );
}

export function formatEventTraceItem(event: NovelEvent): string {
  const target = event.target ? ` → ${event.target}` : '';
  const emotion = event.emotion ? ` [${event.emotion}]` : '';
  return `[${traceReasonForEvent(event) ?? '追踪项'}] T${event.turn} ${event.agentName}/${event.type}${target}${emotion}：${event.content}`;
}
