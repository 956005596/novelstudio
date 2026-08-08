import type { Character, NovelEvent } from './types';

export type EventClosureStatus = Record<string, 'open' | 'closed'>;

type TraceReason = '持续状态' | '伏笔线索' | '未兑现后果' | '关系后果';

const TRACE_REASON_RULES: Array<{ reason: TraceReason; patterns: RegExp[] }> = [
  {
    reason: '持续状态',
    patterns: [
      /中毒|毒素|毒伤|诅咒|咒印|伤势|重伤|伤口|感染|失明|失聪|瘫痪|标记|印记|烙印|污染|后遗症|禁制|封印|虚弱/i,
      /持续.*(章|天|小时|轮|回合|到|至)/,
      /(状态|效果).*(持续|延续|未解除|未消退|仍在)/,
    ],
  },
  {
    reason: '伏笔线索',
    patterns: [
      /伏笔|线索|悬念|未解|谜团|秘密|隐瞒|暴露|真相|预兆|梦境|旧时代|神话时代|王权|终焉器/,
      /(可见|发现|察觉|意识到).*(异常|不对劲|不该存在|说不通)/,
    ],
  },
  {
    reason: '未兑现后果',
    patterns: [
      /未结算|结算异常|未兑现|待领取|未领取|欠发|漏发|奖励待|掉落未|首杀奖励|任务未完成|后续影响|长期影响/,
      /(经验|EXP|掉落|奖励|任务).*(未到账|未记录|未同步|漏记|缺失)/i,
    ],
  },
  {
    reason: '关系后果',
    patterns: [
      /誓约|承诺|欠债|债务|亏欠|通缉|追杀|仇恨|背叛|关系破裂|代价|报复|悬赏|锁定/,
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
  const text = eventTraceText(event);
  if (event.type === 'dialogue' || event.type === 'action') {
    const compact = text.replace(/\s+/g, '');
    if (!/(中毒|诅咒|标记|伤势|承诺|誓约|悬赏|通缉|奖励|掉落|经验|EXP|线索|谜团|真相|秘密|后续影响|长期影响|未兑现|未结算|未领取|旧时代|神话时代|王权|终焉器)/i.test(compact)) {
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
