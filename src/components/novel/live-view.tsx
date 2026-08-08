'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Play, Pause, Square, Send, ChevronLeft, ChevronRight, Activity,
  Globe, Users, FileText, MessageSquare, Zap, AlertTriangle, Info, BookOpen, BookMarked,
  RotateCcw, Loader2, ChevronDown, Package, Sparkles, Shield, Rows2,
  Settings, KeyRound, Server, PlugZap, CheckCircle2, MessagesSquare, PencilLine, X, Maximize2, Minimize2,
} from 'lucide-react';
import { useNovelStore, type EngineStatus, type LogEntry } from '@/store/novel-store';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import type {
  AgentPolicy,
  NovelAsset,
  NovelAssetCategory,
  NovelAssetStatus,
  NovelEvent,
  RoundtableContextSelection,
  RoundtableDiscussionMode,
  Character,
  ChapterFocus,
  ChapterSummary,
  ReaderReview,
  StoryDesign,
  WorldState,
} from '@/lib/novel/types';
import { ThemeToggle } from '@/components/theme-toggle';
import {
  CHAPTER_WORD_TARGET_MAX,
  CHAPTER_WORD_TARGET_MIN,
  formatChapterWordTarget,
} from '@/lib/novel/chapter-policy';
import { countReadableChars } from '@/lib/novel/chapter-text';
import { normalizeChapterTitle } from '@/lib/novel/chapter-title';
import { LONG_FORM_TARGET_CHAPTERS, LONG_FORM_TARGET_WORDS } from '@/lib/novel/long-form-plan';
import { getCanonicalChapterId } from '@/lib/novel/canonical-chapter';
import { normalizeAgentPolicy } from '@/lib/novel/agent-policy';
import { resolveChapterStartTurn } from '@/lib/novel/chapter-focus';
import {
  filterEventTraceEvents,
  selectEventTraceCharacters,
  traceReasonForEvent,
} from '@/lib/novel/event-trace';

const EVENT_TYPE_LABEL: Record<string, { label: string; color: string }> = {
  action: { label: '行动', color: 'bg-blue-100 text-blue-700 border-blue-200 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300' },
  dialogue: { label: '对话', color: 'bg-green-100 text-green-700 border-green-200 dark:border-green-800 dark:bg-green-950/35 dark:text-green-300' },
  state_change: { label: '变化', color: 'bg-amber-100 text-amber-700 border-amber-200 dark:border-amber-800 dark:bg-amber-950/35 dark:text-amber-300' },
  scene_meta: { label: '场景', color: 'bg-purple-100 text-purple-700 border-purple-200 dark:border-purple-800 dark:bg-purple-950/35 dark:text-purple-300' },
  director: { label: '导演', color: 'bg-rose-100 text-rose-700 border-rose-200 dark:border-rose-800 dark:bg-rose-950/35 dark:text-rose-300' },
};

interface ModelConfigStatus {
  configured: boolean;
  source: string | null;
  baseUrl: string;
  model: string;
  endpointMode: 'responses' | 'chat_completions' | 'auto';
  endpointPath: string;
  hasApiKey: boolean;
  chatId: string;
  userId: string;
  hasToken: boolean;
  checkedPaths: string[];
  error?: string;
}

type ModelConnectionState = 'unknown' | 'ok' | 'failed';
type CenterView = 'writer' | 'events' | 'design' | 'outline' | 'assets' | 'reviews' | 'lessons' | 'chapters' | 'logs' | 'split';
type WorkspaceSection = 'chapter' | 'project' | 'system';
type ActiveOperation = {
  label: string;
  detail?: string;
  startedAt: number;
  scope?: 'global' | 'local';
} | null;
type OutlineRevisionMode = 'both' | 'global' | 'chapter';
type OutlineRevisionSource = 'manual' | 'roundtable';

interface RoundtableEntry {
  id: string;
  topic: string;
  chapterNo?: number;
  chapterTitle?: string;
  contextChapterNos?: number[];
  discussionMode?: RoundtableDiscussionMode;
  reviewConfirmed?: boolean;
  designerOpinion?: string;
  directorOpinion: string;
  writerOpinion?: string;
  auditorOpinion: string;
  synthesis: string;
  directorInstruction: string;
  outlineRevisionRequest?: string;
  risks: string[];
  continuityAudit?: string[];
  mustFix?: string[];
  createdAt: string;
}

interface OutlineRevisionProposal {
  id: string;
  request: string;
  mode: OutlineRevisionMode;
  source?: 'manual' | 'roundtable';
  createdAt: string;
  scope: OutlineRevisionMode;
  title: string;
  reason: string;
  designerOpinion: string;
  directorOpinion: string;
  writerOpinion?: string;
  auditorOpinion: string;
  globalNotesAppend: string;
  longFormPlanPatch: any;
  currentChapterPatch: any;
  plotNodePatches: any[];
  directorInstruction: string;
  risks: string[];
  patchPreview?: Partial<WorldState>;
}

function outlineRevisionScopeLabel(proposal: Pick<OutlineRevisionProposal, 'scope' | 'source'>): string {
  if (proposal.source === 'roundtable') return '设计讨论采纳 · 只改本章方向';
  if (proposal.scope === 'global') return '只改总纲';
  if (proposal.scope === 'chapter') return '只改本章方向';
  return '总纲 + 本章方向';
}

function outlineRevisionApplyLabel(proposal: Pick<OutlineRevisionProposal, 'scope' | 'source'>): string {
  if (proposal.source === 'roundtable' || proposal.scope === 'chapter') return '应用到本章方向';
  if (proposal.scope === 'global') return '应用到总纲';
  return '应用到总纲 + 本章方向';
}

function outlineRevisionApplyDetail(proposal: Pick<OutlineRevisionProposal, 'scope' | 'source'>): string {
  if (proposal.source === 'roundtable' || proposal.scope === 'chapter') {
    return '正在写入本章标题、目标、范围和护栏；不会改总纲';
  }
  if (proposal.scope === 'global') {
    return '正在写入总纲、长篇规划或剧情节点；不会改本章方向';
  }
  return '正在写入总纲与本章方向，并清理旧导演设计';
}

function outlineRevisionSuccessLabel(proposal: Pick<OutlineRevisionProposal, 'scope' | 'source'>): string {
  if (proposal.source === 'roundtable' || proposal.scope === 'chapter') return '本章方向已应用';
  if (proposal.scope === 'global') return '总纲已应用';
  return '总纲与本章方向已应用';
}

function outlineRevisionLoadingText(mode: OutlineRevisionMode): string {
  if (mode === 'chapter') return '他们正在讨论本章标题、目标、范围、护栏和落地风险…';
  if (mode === 'global') return '他们正在讨论总纲、卷规划、长期牵引和设定风险…';
  return '他们正在讨论总纲与本章方向的联动风险…';
}

interface CharacterPromptPreview {
  characterId: string;
  characterName: string;
  actorPolicy: string;
  actorCustomBrief: string;
  characterActorNotes: string;
  systemPrompt: string;
  userPrompt: string;
}

interface DiscussionExecutionPlan {
  affects: string[];
  steps: Array<{ label: string; detail: string }>;
  reviseOutline: boolean;
  rewriteCurrentDraft: boolean;
  updateCharacterState: boolean;
  persistCanon: boolean;
}

const VIEW_SECTION_MAP: Record<CenterView, WorkspaceSection> = {
  writer: 'chapter',
  events: 'chapter',
  design: 'chapter',
  reviews: 'chapter',
  split: 'chapter',
  outline: 'project',
  assets: 'project',
  lessons: 'project',
  chapters: 'project',
  logs: 'system',
};

const SECTION_DEFAULT_VIEW: Record<WorkspaceSection, CenterView> = {
  chapter: 'design',
  project: 'outline',
  system: 'logs',
};

function nearbyRoundtableChapterNos(chapterNo?: number): number[] {
  if (!chapterNo || chapterNo <= 0) return [];
  const start = Math.max(1, chapterNo - 2);
  return Array.from({ length: chapterNo - start + 1 }, (_, index) => start + index);
}

function defaultRoundtableContextSelection(chapterNo?: number): RoundtableContextSelection {
  return {
    includeStoryBible: true,
    includeCurrentChapter: true,
    includeDirectorDesign: true,
    includeCurrentDraft: true,
    includeCurrentEvents: true,
    includeCharacters: true,
    includeAssets: true,
    includeEventTrace: true,
    selectedChapterNos: nearbyRoundtableChapterNos(chapterNo),
  };
}

function normalizeRoundtableContextSelection(
  selection: RoundtableContextSelection,
  chapterNo?: number
): RoundtableContextSelection {
  const selectedChapterNos = selection.selectedChapterNos.length
    ? selection.selectedChapterNos
    : chapterNo
      ? nearbyRoundtableChapterNos(chapterNo)
      : [];
  return {
    ...selection,
    selectedChapterNos: Array.from(new Set(selectedChapterNos)).sort((a, b) => a - b).slice(0, 10),
  };
}

function adoptedRoundtableStorageKey(projectId: string, chapterNo?: number): string {
  return `novel-roundtable-adopted:${projectId}:${chapterNo ?? 'unscoped'}`;
}

function legacyRoundtableStorageKey(projectId: string): string {
  return `novel-roundtable:${projectId}`;
}

function roundtableScrollStorageKey(projectId: string): string {
  return `novel-roundtable-scroll:${projectId}`;
}

function loadAdoptedRoundtableId(projectId: string, chapterNo?: number): string {
  if (typeof window === 'undefined') return '';
  if (!chapterNo) return '';
  return window.localStorage.getItem(adoptedRoundtableStorageKey(projectId, chapterNo)) ?? '';
}

function isRoundtableEntryForChapter(entry: RoundtableEntry, chapterNo?: number): boolean {
  if (!chapterNo) return false;
  return entry.chapterNo === chapterNo;
}

function mergeUniqueText(...groups: Array<Array<string | null | undefined> | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const group of groups) {
    for (const raw of group ?? []) {
      const item = String(raw ?? '').trim();
      if (!item || seen.has(item)) continue;
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

function roundtableListBlock(title: string, items?: string[]): string {
  const clean = mergeUniqueText(items);
  if (clean.length === 0) return '';
  return [`【${title}】`, ...clean.map((item) => `- ${item}`)].join('\n');
}

function buildRoundtableExecutionBrief(entry: RoundtableEntry): string {
  return [
    '【已采纳设计讨论，必须落地】',
    `用户原话：${entry.topic}`,
    '',
    roundtableListBlock('必须先修', entry.mustFix),
    roundtableListBlock('连续性审计', entry.continuityAudit),
    '【采纳方案】',
    entry.synthesis,
    '',
    '【Director 执行指令】',
    entry.directorInstruction,
    entry.outlineRevisionRequest ? `\n【本章方向修订请求】\n${entry.outlineRevisionRequest}` : '',
    '',
    '执行纪律：',
    '- 上述“必须先修”不是建议，必须进入本章方向、导演设计、正文重写或人物状态中的对应位置。',
    '- 已采纳设计讨论不得写入总纲/正典补充；如果确实要改总纲，必须由用户在方向提案页单独确认。',
    '- 如果涉及经验、等级、掉落、奖励、装备、技能、天赋、职业、位置、伤势、关系等已发生事实，后续生成必须同步更新正文与人物状态，不能只在讨论里表态。',
    '- 如果当前已有正文，旧稿中与采纳结论冲突的段落必须重写；旧事件日志只能作参考，不能反过来覆盖新口径。',
  ].filter(Boolean).join('\n');
}

function roundtableSourceText(entry: RoundtableEntry): string {
  return [
    entry.topic,
    entry.synthesis,
    entry.directorInstruction,
    entry.outlineRevisionRequest,
    ...(entry.mustFix ?? []),
    ...(entry.continuityAudit ?? []),
    ...(entry.risks ?? []),
  ].filter(Boolean).join('\n');
}

function discussionHasOutlineRevisionIntent(entry: RoundtableEntry): boolean {
  const source = roundtableSourceText(entry);
  return Boolean(entry.outlineRevisionRequest?.trim()) ||
    /章节名|章名|标题|改名|重命名|重写|改写|重新改写|剧情走向|本章目标|章方向|细纲/.test(source) ||
    (/(当前章|本章|第\s*\d+\s*章)/.test(source) && /改|调|换|重写|改写|方向|目标|范围|护栏/.test(source));
}

function discussionTouchesCharacterState(entry: RoundtableEntry): boolean {
  return /人物状态|角色状态|经验|等级|掉落|奖励|装备|技能|天赋|职业|位置|伤势|血量|魔力|关系|背包|expDelta|HP|MP/.test(roundtableSourceText(entry));
}

function discussionTouchesAssetLibrary(entry: RoundtableEntry): boolean {
  return /素材库|素材|天赋|职业|技能|装备|宠物|坐骑|怪物|副本|掉落|品阶|道具|资产/.test(roundtableSourceText(entry));
}

function discussionTouchesCurrentDraft(entry: RoundtableEntry): boolean {
  if (entry.discussionMode === 'internal_review' && !entry.reviewConfirmed) return false;
  return /当前正文|正稿|旧稿|当前稿|重写|改正文|修正文|逐句|落进正文|正文兑现|补进正文|重评/.test(roundtableSourceText(entry));
}

function buildDiscussionExecutionPlan(entry: RoundtableEntry, currentDraft?: ChapterSummary | null): DiscussionExecutionPlan {
  const reviseOutline = discussionHasOutlineRevisionIntent(entry);
  const persistCanon = false;
  const updateCharacterState = discussionTouchesCharacterState(entry);
  const touchesAssets = discussionTouchesAssetLibrary(entry);
  const rewriteCurrentDraft = Boolean(currentDraft && discussionTouchesCurrentDraft(entry));
  const affects = mergeUniqueText([
    reviseOutline ? '本章方向' : '',
    '导演设计',
    touchesAssets ? '素材库' : '',
    updateCharacterState ? '人物状态' : '',
    rewriteCurrentDraft ? '当前正文' : '',
    !currentDraft ? '后续演绎/正文' : '',
  ]);
  const steps: DiscussionExecutionPlan['steps'] = [];

  if (reviseOutline) {
    steps.push({
      label: '写入方向',
      detail: '把结论转成本章方向补丁并落库，不写入总纲',
    });
  } else {
    steps.push({
      label: '刷新设计',
      detail: '作为最高优先级指令刷新本章导演设计',
    });
  }

  steps.push({
    label: '同步 Director',
    detail: '后续演绎必须按采纳结论执行',
  });

  if (updateCharacterState) {
    steps.push({
      label: '同步人物状态',
      detail: '经验、等级、掉落、位置、关系等必须在后续状态或正文里兑现',
    });
  }

  if (rewriteCurrentDraft) {
    steps.push({
      label: '重写当前正文',
      detail: '已有正文会生成一版新的当前稿并重新评审',
    });
  } else if (currentDraft) {
    steps.push({
      label: '正文不自动改',
      detail: '当前稿保留；后续可手动按结论修正文',
    });
  } else {
    steps.push({
      label: '进入演绎/写作',
      detail: '还没有正文，后续事件和正文会读取这次结论',
    });
  }

  return { affects, steps, reviseOutline, rewriteCurrentDraft, updateCharacterState, persistCanon };
}

function supplementOutlineProposalFromDiscussion(
  proposal: OutlineRevisionProposal,
  entry: RoundtableEntry,
  currentChapter?: ChapterFocus | null
): OutlineRevisionProposal {
  const executionBrief = buildRoundtableExecutionBrief(entry);
  const mustFix = mergeUniqueText(entry.mustFix, entry.continuityAudit);
  const proposalChapterPatch = proposal.currentChapterPatch && typeof proposal.currentChapterPatch === 'object'
    ? proposal.currentChapterPatch
    : {};
  const baseConstraints = Array.isArray(proposalChapterPatch.constraints)
    ? proposalChapterPatch.constraints
    : currentChapter?.constraints ?? [];

  return {
    ...proposal,
    source: 'roundtable',
    mode: 'chapter',
    scope: 'chapter',
    globalNotesAppend: '',
    longFormPlanPatch: {},
    plotNodePatches: [],
    currentChapterPatch: {
      ...proposalChapterPatch,
      constraints: mustFix.length
        ? mergeUniqueText(baseConstraints, mustFix).slice(0, 24)
        : proposalChapterPatch.constraints,
    },
    directorInstruction: [proposal.directorInstruction, executionBrief].filter(Boolean).join('\n\n'),
    risks: mergeUniqueText(proposal.risks, entry.risks).slice(0, 12),
  };
}

type ChapterDraftGroup = {
  key: string;
  chapterNo: number;
  title: string;
  drafts: ChapterSummary[];
  currentDraft: ChapterSummary;
  currentWordCount: number;
  totalDraftWords: number;
  reviewCount: number;
  generatedAt: string;
  startTurn: number | null;
  endTurn: number | null;
};

function chapterCreatedTime(chapter: ChapterSummary): number {
  if (!chapter.createdAt) return 0;
  const date = chapter.createdAt instanceof Date ? chapter.createdAt : new Date(chapter.createdAt);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function chapterWordCount(chapter: ChapterSummary): number {
  return countReadableChars(chapter.content);
}

function chapterTitleForDisplay(
  worldState: WorldState | null | undefined,
  chapterNo: number,
  fallbackTitle?: string | null
): string {
  const current = worldState?.currentChapter;
  const currentTitle = current?.chapterNo === chapterNo ? normalizeChapterTitle(current.title, chapterNo) : '';
  const draftTitle = normalizeChapterTitle(fallbackTitle, chapterNo);
  const direct = currentTitle || draftTitle;
  if (direct && direct !== '方向待定' && direct !== '未命名章节') return direct;
  const nodeTitle = worldState?.plotNodes?.find((node) => !node.completed)?.title?.trim();
  return nodeTitle || direct || '未命名章节';
}

function buildChapterDraftGroups(
  chapters: ChapterSummary[],
  worldState?: WorldState | null,
  readerReviews: Record<string, ReaderReview[]> = {}
): ChapterDraftGroup[] {
  const currentChapter = worldState?.currentChapter;
  const fallbackChapterNo = currentChapter?.chapterNo ?? 1;
  const fallbackChapterTitle = currentChapter?.title ?? '未命名章节';
  const sortedDrafts = [...chapters].sort((a, b) => {
    const chapterDelta = Number(a.chapterNo ?? fallbackChapterNo) - Number(b.chapterNo ?? fallbackChapterNo);
    if (chapterDelta !== 0) return chapterDelta;
    const timeDelta = chapterCreatedTime(a) - chapterCreatedTime(b);
    if (timeDelta !== 0) return timeDelta;
    return (a.startTurn ?? 0) - (b.startTurn ?? 0);
  });
  const grouped = new Map<string, Omit<ChapterDraftGroup, 'currentDraft' | 'currentWordCount' | 'generatedAt'>>();

  for (const draft of sortedDrafts) {
    const chapterNo = Number(draft.chapterNo ?? fallbackChapterNo) || 1;
    const title = chapterTitleForDisplay(worldState, chapterNo, draft.chapterTitle ?? fallbackChapterTitle);
    const key = String(chapterNo);
    const reviewCount = readerReviews[draft.id]?.length ?? draft.readerReviews?.length ?? 0;
    const existing = grouped.get(key);
    if (existing) {
      existing.drafts.push(draft);
      existing.totalDraftWords += chapterWordCount(draft);
      existing.reviewCount += reviewCount;
      existing.startTurn =
        typeof draft.startTurn === 'number'
          ? existing.startTurn === null
            ? draft.startTurn
            : Math.min(existing.startTurn, draft.startTurn)
          : existing.startTurn;
      existing.endTurn =
        typeof draft.endTurn === 'number'
          ? existing.endTurn === null
            ? draft.endTurn
            : Math.max(existing.endTurn, draft.endTurn)
          : existing.endTurn;
    } else {
      grouped.set(key, {
        key,
        chapterNo,
        title,
        drafts: [draft],
        totalDraftWords: chapterWordCount(draft),
        reviewCount,
        startTurn: typeof draft.startTurn === 'number' ? draft.startTurn : null,
        endTurn: typeof draft.endTurn === 'number' ? draft.endTurn : null,
      });
    }
  }

  return Array.from(grouped.values())
    .map((group) => {
      const drafts = group.drafts.sort((a, b) => {
        const timeDelta = chapterCreatedTime(b) - chapterCreatedTime(a);
        if (timeDelta !== 0) return timeDelta;
        return (b.endTurn ?? 0) - (a.endTurn ?? 0);
      });
      const canonicalId = getCanonicalChapterId(worldState, group.chapterNo);
      const currentDraft = drafts.find((draft) => draft.id === canonicalId) ?? drafts[0];
      return {
        ...group,
        title: chapterTitleForDisplay(worldState, group.chapterNo, currentDraft.chapterTitle ?? group.title),
        drafts,
        currentDraft,
        currentWordCount: chapterWordCount(currentDraft),
        generatedAt: formatEventCreatedAt(currentDraft.createdAt),
      };
    })
    .sort((a, b) => a.chapterNo - b.chapterNo);
}

export function LiveView({ projectId, projectName, onProjectRenamed, onBack }: {
  projectId: string;
  projectName: string;
  onProjectRenamed?: (projectName: string) => void;
  onBack: () => void;
}) {
  const store = useNovelStore();
  const [displayProjectName, setDisplayProjectName] = useState(projectName);
  const [projectNameDraft, setProjectNameDraft] = useState(projectName);
  const [editingProjectName, setEditingProjectName] = useState(false);
  const [savingProjectName, setSavingProjectName] = useState(false);
  const [directorCmd, setDirectorCmd] = useState('');
  const [editingCharacter, setEditingCharacter] = useState<string | null>(null);
  const [charEmotionInput, setCharEmotionInput] = useState('');
  const [charLocationInput, setCharLocationInput] = useState('');
  const [charGenderInput, setCharGenderInput] = useState('');
  const [charBackgroundInput, setCharBackgroundInput] = useState('');
  const [charStanceInput, setCharStanceInput] = useState('');
  const [charSpeechStyleInput, setCharSpeechStyleInput] = useState('');
  const [charPersonalityInput, setCharPersonalityInput] = useState('');
  const [charGoalsInput, setCharGoalsInput] = useState('');
  const [charActorNotesInput, setCharActorNotesInput] = useState('');
  const [charIdentityNotesInput, setCharIdentityNotesInput] = useState('');
  const [charCoreBeliefsInput, setCharCoreBeliefsInput] = useState('');
  const [charBehaviorRulesInput, setCharBehaviorRulesInput] = useState('');
  const [charSpeechRulesInput, setCharSpeechRulesInput] = useState('');
  const [charForbiddenRulesInput, setCharForbiddenRulesInput] = useState('');
  const [worldSceneInput, setWorldSceneInput] = useState('');
  const [resetting, setResetting] = useState(false);
  const [cleaningInvalid, setCleaningInvalid] = useState(false);
  const [centerView, setCenterView] = useState<CenterView>('design');
  const [workspaceSection, setWorkspaceSection] = useState<WorkspaceSection>('chapter');
  const [roundtableTopic, setRoundtableTopic] = useState('');
  const [roundtableEntries, setRoundtableEntries] = useState<RoundtableEntry[]>([]);
  const [roundtableLoading, setRoundtableLoading] = useState(false);
  const [roundtablePendingTopic, setRoundtablePendingTopic] = useState('');
  const [roundtableError, setRoundtableError] = useState('');
  const [roundtableContext, setRoundtableContext] = useState<RoundtableContextSelection>(() => defaultRoundtableContextSelection());
  const [roundtableDiscussionMode, setRoundtableDiscussionMode] = useState<RoundtableDiscussionMode>('internal_review');
  const [roundtableScrollToBottomToken, setRoundtableScrollToBottomToken] = useState(0);
  const [adoptedRoundtableId, setAdoptedRoundtableId] = useState('');
  const [adoptedRewriteInstruction, setAdoptedRewriteInstruction] = useState('');
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [modelConfig, setModelConfig] = useState<ModelConfigStatus | null>(null);
  const [modelConnection, setModelConnection] = useState<ModelConnectionState>('unknown');
  const [checkingModel, setCheckingModel] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [activeOperation, setActiveOperation] = useState<ActiveOperation>(null);
  const [rewritingChapterId, setRewritingChapterId] = useState('');
  const [selectingCanonicalId, setSelectingCanonicalId] = useState('');
  const [focusingChapterId, setFocusingChapterId] = useState('');
  const [outlineRevisionRequest, setOutlineRevisionRequest] = useState('');
  const [outlineRevisionMode, setOutlineRevisionMode] = useState<OutlineRevisionMode>('both');
  const [outlineRevisionProposal, setOutlineRevisionProposal] = useState<OutlineRevisionProposal | null>(null);
  const [outlineRevisionLoading, setOutlineRevisionLoading] = useState(false);
  const [outlineRevisionApplying, setOutlineRevisionApplying] = useState(false);
  const [outlineRevisionError, setOutlineRevisionError] = useState('');
  const [storyBibleSyncing, setStoryBibleSyncing] = useState(false);

  const eventScrollRef = useRef<HTMLDivElement>(null);
  const writerScrollRef = useRef<HTMLDivElement>(null);
  const reviewScrollRef = useRef<HTMLDivElement>(null);
  const logScrollRef = useRef<HTMLDivElement>(null);
  const operationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completedCountRef = useRef(0);
  const eventCountRef = useRef(0);
  const fetchedEventRangesRef = useRef<Set<string>>(new Set());

  const switchCenterView = (view: CenterView) => {
    setCenterView(view);
    setWorkspaceSection(VIEW_SECTION_MAP[view]);
  };

  const switchWorkspaceSection = (section: WorkspaceSection) => {
    setWorkspaceSection(section);
    setCenterView((current) => (VIEW_SECTION_MAP[current] === section ? current : SECTION_DEFAULT_VIEW[section]));
  };

  const refreshRoundtableEntries = async (showError = false) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/roundtable`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '设计讨论同步失败');
      setRoundtableEntries(Array.isArray(data.entries) ? data.entries : []);
    } catch (err: any) {
      if (showError) toast.error(err.message || '设计讨论同步失败');
    }
  };

  const notifyRoundtableChanged = () => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(`novel-roundtable-sync:${projectId}`, String(Date.now()));
  };

  const migrateLegacyRoundtableEntries = async () => {
    if (typeof window === 'undefined') return false;
    const key = legacyRoundtableStorageKey(projectId);
    const raw = window.localStorage.getItem(key);
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        window.localStorage.removeItem(key);
        return false;
      }
      const res = await fetch(`/api/projects/${projectId}/roundtable`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: parsed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '旧会话迁移失败');
      window.localStorage.removeItem(key);
      setRoundtableEntries(Array.isArray(data.entries) ? data.entries : []);
      return true;
    } catch (err) {
      console.warn('[NovelStudio] 旧设计讨论迁移失败', err);
      return false;
    }
  };

  useEffect(() => {
    setDisplayProjectName(projectName);
    setProjectNameDraft(projectName);
  }, [projectName]);

  useEffect(() => {
    setWorkspaceSection(VIEW_SECTION_MAP[centerView]);
  }, [centerView]);

  // 初始化
  useEffect(() => {
    store.initProjectId(projectId, projectName, 3);
    store.connect();
    // 加载项目详情
    fetch(`/api/projects/${projectId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.project?.name) {
          setDisplayProjectName(data.project.name);
          setProjectNameDraft(data.project.name);
          store.setProjectName(data.project.name);
          onProjectRenamed?.(data.project.name);
        }
        if (data.project?.worldState) store._onWorldUpdate(data.project.worldState);
        if (data.characters) data.characters.forEach((c: Character) => store._onCharacterUpdate(c));
        store.setDirectorLvl(data.project?.directorLvl ?? 3);
        if (data.project?.status) {
          const loadedStatus = data.project.status === 'paused' ? 'idle' : data.project.status;
          store._onEngineState(loadedStatus as EngineStatus, data.project.currentTurn ?? -1);
        }
      })
      .catch((err) => console.warn('[NovelStudio] 项目详情加载失败', err));
    // 加载历史事件
    fetch(`/api/projects/${projectId}/events?limit=200`)
      .then((r) => r.json())
      .then((data) => {
        (data.events ?? []).forEach((e: NovelEvent) => store._onEventNew(e));
      })
      .catch((err) => console.warn('[NovelStudio] 历史事件加载失败', err));
    // 加载历史章节和读者评审
    fetch(`/api/projects/${projectId}/chapters`)
      .then((r) => r.json())
      .then((data) => {
        store._onChaptersLoaded(data.chapters ?? []);
      })
      .catch((err) => console.warn('[NovelStudio] 历史章节加载失败', err));
    migrateLegacyRoundtableEntries().then((migrated) => {
      if (!migrated) refreshRoundtableEntries();
    });
    refreshModelConfig();

    return () => {
      store.stopEngine();
      store.disconnect();
      store.reset();
    };
  }, [projectId]);

  useEffect(() => {
    const onFocus = () => {
      refreshRoundtableEntries();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshRoundtableEntries();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === `novel-roundtable-sync:${projectId}`) refreshRoundtableEntries();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [projectId]);

  const cancelProjectNameEdit = () => {
    setProjectNameDraft(displayProjectName);
    setEditingProjectName(false);
  };

  const saveProjectName = async () => {
    const nextName = projectNameDraft.trim();
    if (!nextName) {
      toast.error('项目名不能为空');
      return;
    }
    if (nextName === displayProjectName) {
      setEditingProjectName(false);
      return;
    }
    setSavingProjectName(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nextName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '项目名保存失败');
      const savedName = data.project?.name ?? nextName;
      setDisplayProjectName(savedName);
      setProjectNameDraft(savedName);
      store.setProjectName(savedName);
      onProjectRenamed?.(savedName);
      setEditingProjectName(false);
      toast.success('项目名已更新');
    } catch (err: any) {
      toast.error(err.message || '项目名保存失败');
    } finally {
      setSavingProjectName(false);
    }
  };

  // 自动滚动
  useEffect(() => {
    eventScrollRef.current?.scrollTo({ top: 999999, behavior: 'smooth' });
  }, [store.events.length]);
  useEffect(() => {
    writerScrollRef.current?.scrollTo({ top: 999999, behavior: 'smooth' });
  }, [store.chapterChunks, store.completedChapters.length]);
  useEffect(() => {
    reviewScrollRef.current?.scrollTo({ top: 999999, behavior: 'smooth' });
  }, [store.readerReviews, store.completedChapters.length]);
  useEffect(() => {
    logScrollRef.current?.scrollTo({ top: 999999, behavior: 'smooth' });
  }, [store.logs.length]);
	  useEffect(() => {
      const chapterNo = store.worldState?.currentChapter?.chapterNo;
      if (!chapterNo) return;
	    if (adoptedRoundtableId) {
        const adoptedEntry = roundtableEntries.find((entry) => entry.id === adoptedRoundtableId);
        if (adoptedEntry?.chapterNo === chapterNo) {
          window.localStorage.setItem(adoptedRoundtableStorageKey(projectId, chapterNo), adoptedRoundtableId);
        }
	    } else {
        window.localStorage.removeItem(adoptedRoundtableStorageKey(projectId, chapterNo));
	    }
	  }, [projectId, store.worldState?.currentChapter?.chapterNo, adoptedRoundtableId, roundtableEntries]);

  useEffect(() => {
    return () => {
      if (operationTimerRef.current) clearTimeout(operationTimerRef.current);
    };
  }, []);

  const showOperation = (label: string, detail?: string, ttlMs = 8000, scope: 'global' | 'local' = 'global') => {
    if (operationTimerRef.current) clearTimeout(operationTimerRef.current);
    setActiveOperation({ label, detail, startedAt: Date.now(), scope });
    if (ttlMs > 0) {
      operationTimerRef.current = setTimeout(() => {
        setActiveOperation(null);
        operationTimerRef.current = null;
      }, ttlMs);
    }
  };

  const clearOperation = () => {
    if (operationTimerRef.current) clearTimeout(operationTimerRef.current);
    operationTimerRef.current = null;
    setActiveOperation(null);
  };

  const handleStart = async () => {
    if (isChapterAtClosure) {
      toast.info('本章已到收束点，不再继续演绎；请先生成正文，避免污染当前章事件日志');
      return;
    }
    if (!(await ensureModelUsable('演绎一轮'))) return;
    showOperation('演绎一轮', '本次只推进一轮角色行动，结束后会自动停住', 6000);
    store.startEngine({ maxTurns: 1 });
    toast.success('已启动单轮演绎');
  };
  const handlePause = () => {
    showOperation('暂停演绎', '已向引擎发送暂停指令', 4000);
    store.pauseEngine();
    toast.info('演绎已暂停');
  };
  const handleResume = () => {
    showOperation('恢复演绎', '已向引擎发送继续指令', 4000);
    store.resumeEngine();
    toast.info('演绎已恢复');
  };
  const handleStop = () => {
    if (!confirm('确定停止演绎？需要重新启动才能继续。')) return;
    showOperation('停止演绎', '正在停止当前演绎循环', 5000);
    store.stopEngine();
    toast.info('演绎已停止');
  };
  const handleReset = async () => {
    const chapterLabel = currentChapter
      ? `第 ${currentChapter.chapterNo} 章《${normalizeChapterTitle(currentChapter.title, currentChapter.chapterNo)}》`
      : '当前章节';
    const confirmed = confirm(
      `确定重置${chapterLabel}？\n\n` +
      '将清空：本章事件日志、本章正文、对应读者评审、本章导演设计、本章设计讨论记录\n' +
      '将停用：本章还未生效的导演指令（设计讨论里发过、还没落地的旧话）\n' +
      '保留：前面章节、项目设定、角色基础档案、世界观、剧情节点\n\n' +
      '适合“这一章演绎得不好，想从本章开头重跑”的场景。'
    );
    if (!confirmed) return;
    setResetting(true);
    showOperation('重置本章', '正在清空当前章事件、正文、评审和导演设计', 0);
    try {
      await store.resetCurrentChapter(projectId);
      await refreshRoundtableEntries();
      showOperation('重置完成', '可以从本章重新生成设计和演绎', 6000);
      toast.success(`${chapterLabel}已重置，可以从本章重新演绎`);
    } catch (e: any) {
      clearOperation();
      toast.error(`重置失败: ${e.message}`);
    } finally {
      setResetting(false);
    }
  };

  const handleCleanupInvalid = async () => {
    const chapterLabel = currentChapter
      ? `第 ${currentChapter.chapterNo} 章《${normalizeChapterTitle(currentChapter.title, currentChapter.chapterNo)}》`
      : '当前章节';
    const confirmed = confirm(
      `清理 ${chapterLabel} 的失效演绎？\n\n` +
      '将删除：当前章旧事件日志、同章历史稿、旧读者评审、旧导演设计/经验总结、本章设计讨论记录\n' +
      '将停用：本章还未生效的导演指令（设计讨论里发过、还没落地的旧话）\n' +
      '保留：当前章最新正文稿、角色基础档案、项目设定、世界观和剧情节点\n\n' +
      '适合“已经有可用正文，但旧跑戏事件污染了讨论/统计”的场景。'
    );
    if (!confirmed) return;
    setCleaningInvalid(true);
    showOperation('清理失效演绎', '正在保留当前正文稿，并移除旧跑戏事件与旧稿', 0);
    try {
      const result = await store.cleanupInvalidCurrentChapter(projectId);
      await refreshRoundtableEntries();
      showOperation('清理完成', '当前章上下文已回到最新正文稿', 6000);
      toast.success(
        `已清理：事件 ${result.deletedEvents} 条，历史稿 ${result.deletedChapterDrafts} 份，旧评审 ${result.deletedReaderReviews} 条，讨论 ${result.deletedRoundtableEntries} 条，停用未消费指令 ${result.rejectedDirectives} 条`
      );
    } catch (err: any) {
      showOperation('清理失败', err.message || '清理失效演绎失败', 8000);
      toast.error(err.message || '清理失效演绎失败');
    } finally {
      setCleaningInvalid(false);
    }
  };
  const handleDirectorCmd = async () => {
    if (!directorCmd.trim()) return;
    if (!store.connected) {
      toast.error('未连接演绎引擎，暂时不能发送 Director 指令');
      return;
    }
    if (!(await ensureModelUsable('发送 Director 最高优先级指令'))) return;
    showOperation('发送 Director 指令', '等待引擎确认并刷新本章导演设计', 0);
    const ok = await store.sendDirectorCommand(directorCmd.trim(), { refreshDesign: true, priority: true });
    if (!ok) {
      clearOperation();
      toast.error('Director 指令发送失败');
      return;
    }
    showOperation('校准导演设计', '指令已接收，正在重算本章导演设计', 10000);
    toast.success('最高优先级指令已发送，正在校准本章导演设计');
    setDirectorCmd('');
  };
  const handleReviewFeedbackToDirector = async (content: string, label = '读者评审') => {
    if (!content.trim()) return false;
    if (!store.connected) {
      toast.error('未连接演绎引擎，暂时不能回流给 Director');
      return false;
    }
    showOperation(label, '评审正在回流给 Director，等待引擎确认', 0);
    const ok = await store.sendDirectorCommand(content.trim(), { refreshDesign: true });
    if (!ok) {
      clearOperation();
      toast.error(`${label}回流失败`);
      return false;
    }
    switchCenterView('design');
    showOperation('评审已回流', 'Director 正在据此校准设计和下一轮演绎约束', 10000);
    toast.success(`${label}已回流给 Director，正在校准导演设计`);
    return true;
  };
  const handleRerunReaderReviews = async (chapterId: string) => {
    if (!(await ensureModelUsable('重新评审'))) return false;
    showOperation('重新评审', 'Reader 正在重审剧情突兀、铺垫不足和因果断裂', 0);
    try {
      const res = await fetch(`/api/projects/${projectId}/chapters/${chapterId}/reviews`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '重新评审失败');
      store.replaceReaderReviews(chapterId, data.reviews ?? []);
      showOperation('重新评审完成', '评审已替换为新的 Reader 结果', 6000);
      toast.success('Reader 已按新的突兀/因果断裂标准重新评审');
      return true;
    } catch (err: any) {
      clearOperation();
      toast.error(err.message || '重新评审失败');
      return false;
    }
  };
  const handleDirectorLvlChange = async (lvl: number) => {
    store.setDirectorLvl(lvl);
    await fetch(`/api/projects/${projectId}/director-lvl`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: lvl }),
    });
    toast.success(`Director 强度已设为 ${lvl}/5`);
  };
  const handleCharacterEdit = (c: Character) => {
    setEditingCharacter(c.id);
    setCharEmotionInput(c.currentState.emotion);
    setCharLocationInput(c.currentState.location);
    setCharGenderInput(c.persona.gender ?? '');
    setCharBackgroundInput(c.persona.background ?? '');
    setCharStanceInput(c.persona.stance ?? '');
    setCharSpeechStyleInput(c.persona.speechStyle ?? '');
    setCharPersonalityInput(listToEditorText(c.persona.personality));
    setCharGoalsInput(listToEditorText(c.persona.goals));
    setCharActorNotesInput(c.persona.actorNotes ?? '');
    setCharIdentityNotesInput(c.persona.identityNotes ?? '');
    setCharCoreBeliefsInput(listToEditorText(c.persona.coreBeliefs));
    setCharBehaviorRulesInput(listToEditorText(c.persona.behaviorRules));
    setCharSpeechRulesInput(listToEditorText(c.persona.speechRules));
    setCharForbiddenRulesInput(listToEditorText(c.persona.forbiddenRules));
  };
  const saveCharacterEdit = () => {
    if (!editingCharacter) return;
    store.sendCharacterEdit(editingCharacter, {
      emotion: charEmotionInput,
      location: charLocationInput,
    }, {
      gender: normalizeOptionalText(charGenderInput),
      background: charBackgroundInput.trim(),
      stance: charStanceInput.trim(),
      speechStyle: charSpeechStyleInput.trim(),
      personality: editorTextToList(charPersonalityInput),
      goals: editorTextToList(charGoalsInput),
      actorNotes: normalizeOptionalText(charActorNotesInput),
      identityNotes: normalizeOptionalText(charIdentityNotesInput),
      coreBeliefs: editorTextToList(charCoreBeliefsInput),
      behaviorRules: editorTextToList(charBehaviorRulesInput),
      speechRules: editorTextToList(charSpeechRulesInput),
      forbiddenRules: editorTextToList(charForbiddenRulesInput),
    });
    setEditingCharacter(null);
    toast.success('人物档案与演员提示已更新');
  };
  const handleWorldSceneEdit = () => {
    if (!store.worldState) return;
    store.sendWorldEdit({ sceneDescription: worldSceneInput });
    setWorldSceneInput('');
    toast.success('场景描述已更新');
  };
  const handlePlanningSettingsSave = (settings: {
    targetWordMin: number;
    targetWordMax: number;
    targetTurns: number;
    targetWords: number;
    targetChapters: number;
  }) => {
    if (!store.worldState || !currentChapter) return;
    const targetWordMin = Math.max(300, Math.floor(settings.targetWordMin));
    const targetWordMax = Math.max(targetWordMin, Math.floor(settings.targetWordMax));
    const targetTurns = Math.max(1, Math.floor(settings.targetTurns));
    const targetWords = Math.max(0, Math.floor(settings.targetWords));
    const targetChapters = Math.max(1, Math.floor(settings.targetChapters));
    const currentLongFormPlan = store.worldState.longFormPlan;
    const plotNodes = store.worldState.plotNodes?.map((node: any) =>
      node.completed
        ? node
        : {
            ...node,
            estimatedTurns: targetTurns,
          }
    );
    store.sendWorldEdit({
      ...(plotNodes ? { plotNodes } : {}),
      currentChapter: {
        ...currentChapter,
        targetWordMin,
        targetWordMax,
        targetTurns,
      },
      longFormPlan: {
        ...currentLongFormPlan,
        targetWords,
        minWords: Math.min(currentLongFormPlan?.minWords ?? targetWords, targetWords),
        targetChapters,
        chapterWordMin: targetWordMin,
        chapterWordMax: targetWordMax,
        volumes: currentLongFormPlan?.volumes ?? [],
        promise: currentLongFormPlan?.promise ?? '',
        pacingPrinciples: currentLongFormPlan?.pacingPrinciples ?? [],
      },
      storyDesign: null as any,
    });
    toast.success('全局容量设置已保存，当前章和后续章节默认容量已同步');
  };
  const handleStoryBibleNotesSave = async (notes: string) => {
    if (!store.worldState) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/story-bible-notes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storyBibleNotes: notes.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '总纲补充保存失败');
      if (data.worldState) store._onWorldUpdate(data.worldState);
      toast.success('总纲补充已保存，后续导演设计、剧情设计和讨论会读取');
    } catch (err: any) {
      toast.error(err.message || '总纲补充保存失败');
    }
	  };
  const handleAgentPolicySave = (patch: Partial<AgentPolicy>) => {
    const current = normalizeAgentPolicy(store.worldState?.agentPolicy);
    store.sendWorldEdit({
      agentPolicy: {
        ...current,
        ...patch,
      },
      storyDesign: null as any,
    });
    toast.success('Agent 权限已更新，旧导演设计已失效');
  };
		  const handlePrepareDesign = async () => {
	    if (!(await ensureModelUsable('生成导演设计'))) return;
		    showOperation('生成导演设计', '剧情设计师正在规划本章拍点、事件刺激和设定护栏', 0);
	    store.prepareStoryDesign();
	    switchCenterView('design');
	    toast.success('已请求生成本章导演设计');
	  };
	  const handleWriteChapter = async () => {
    const writerIsStreaming = Object.values(store.chapterChunks).some((chunk) => chunk.length > 0);
    if (writerIsStreaming) {
      toast.info('Writer 已在生成正文，不会重复启动');
      return;
    }
    if (!isChapterAtClosure) {
      toast.info(`本章还没到收束点（${chapterProgress}/${chapterTargetTurns}），先继续演绎`);
      return;
	    }
	    if (!(await ensureModelUsable('生成正文'))) return;
		    showOperation('生成正文', 'Writer 正在根据本章事件写正文，正文区会流式更新', 0);
	    store.writeCurrentChapter();
		    switchCenterView('writer');
	    toast.success('已请求 Writer 根据本章事件生成正文');
  };
  const handleRewriteChapter = async (
    chapterId: string,
    instruction?: string,
    options: { rerunReviews?: boolean; stayOnDesign?: boolean; forceFullRewrite?: boolean } = {}
  ) => {
    if (!chapterId || rewritingChapterId) return;
    setRewritingChapterId(chapterId);
    showOperation('修正章节当前稿', '正在按采纳结论重写，并保存为新的当前稿', 0);
    try {
      const res = await fetch(`/api/projects/${projectId}/chapters/${chapterId}/rewrite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instruction: instruction?.trim() || adoptedRewriteInstruction.trim(),
          forceFullRewrite: options.forceFullRewrite ?? false,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '章节重写失败');
      if (data.worldState) store._onWorldUpdate(data.worldState);
      if (Array.isArray(data.updatedCharacters)) {
        data.updatedCharacters.forEach((character: Character) => store._onCharacterUpdate(character));
      }
      store._onChaptersLoaded(data.chapters ?? (data.chapter ? [...store.completedChapters, data.chapter] : store.completedChapters));
      const nextChapterId = data.chapter?.id;
      if (options.rerunReviews && nextChapterId) {
        showOperation('章节当前稿已更新', '正在用新稿重新评审', 0);
        await handleRerunReaderReviews(nextChapterId);
      }
      switchCenterView(options.stayOnDesign ? 'design' : 'chapters');
      showOperation(
        options.rerunReviews ? '修正文并重评完成' : '章节当前稿已更新',
        options.rerunReviews ? '新稿已保存，Reader 评审已刷新' : '新稿已保存；旧稿保留在历史稿里',
        7000
      );
      toast.success(data.warning ? `已生成当前稿：${data.warning}` : '已生成新的章节当前稿');
    } catch (err: any) {
      clearOperation();
      toast.error(err.message || '章节重写失败');
    } finally {
      setRewritingChapterId('');
    }
  };
	  const handleSelectCanonicalDraft = async (chapterId: string) => {
    if (!chapterId || selectingCanonicalId) return;
    setSelectingCanonicalId(chapterId);
    showOperation('选定正稿', '正在把该版本设为本章当前正文', 0);
    try {
      const res = await fetch(`/api/projects/${projectId}/chapters/${chapterId}/canonical`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '选定正稿失败');
      if (data.worldState) store._onWorldUpdate(data.worldState);
      showOperation('正稿已选定', '后续讨论、评审、修正都会优先读取这版正文', 6000);
      toast.success('已设为本章正稿');
    } catch (err: any) {
      clearOperation();
      toast.error(err.message || '选定正稿失败');
    } finally {
      setSelectingCanonicalId('');
    }
  };
  const handleChapterAuto = async () => {
    const writerIsStreaming = Object.values(store.chapterChunks).some((chunk) => chunk.length > 0);
    if (writerIsStreaming) {
      toast.info('Writer 正在生成正文，等当前稿完成后再启动章节自循环');
      return;
    }
	    if (!(await ensureModelUsable('章节自循环'))) return;
		    showOperation('章节自循环', '设计 → 演绎 → 写作 → 评审 → 回流修正 → 重评定稿', 0);
	    store.startChapterAuto({ cycles: 3, turnsPerCycle: 3 });
	    toast.success(isChapterAtClosure ? '章节自循环已启动：将直接写作、评审并反修' : '章节自循环已启动');
	  };

  const handleFocusChapterForDesign = async (chapterId: string) => {
    if (isRunning) {
      toast.error('请先停止演绎，再切换章节设计焦点');
      return;
    }
    setFocusingChapterId(chapterId);
    showOperation('切换设计焦点', '正在把该章节设为当前导演设计对象', 0, 'local');
    try {
      const res = await fetch(`/api/projects/${projectId}/chapters/${chapterId}/focus`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '切换章节设计焦点失败');
      if (data.worldState) store._onWorldUpdate(data.worldState);
      setOutlineRevisionProposal(null);
      setOutlineRevisionRequest('');
      switchCenterView('design');
      showOperation('设计焦点已切换', '可以重新生成导演设计，或在设计讨论里提出改章方向', 6000, 'local');
      toast.success(
        data.chapter?.chapterNo
          ? `已切到第 ${data.chapter.chapterNo} 章，可以重新设计`
          : '已切换章节设计焦点'
      );
    } catch (err: any) {
      clearOperation();
      toast.error(err.message || '切换章节设计焦点失败');
    } finally {
      setFocusingChapterId('');
    }
  };
	  const handleAdvanceChapter = () => {
	    showOperation('切换下一章', '正在移动章节焦点并准备新的导演设计', 6000);
	    store.advanceChapter();
	    toast.success('已请求进入下一章');
	  };
	  const handleRetreatChapter = () => {
	    showOperation('切回上一章', '正在切换章节焦点，不删除已有记录', 6000);
	    store.retreatChapter();
	    toast.info('已切回上一章焦点，不删除已生成记录');
	  };
  const handleRoundtableSubmit = async () => {
    const topic = roundtableTopic.trim();
    if (!topic) return;
	    if (!(await ensureModelUsable('发起设计讨论'))) return;
      setRoundtableError('');
	    setRoundtablePendingTopic(topic);
      setRoundtableTopic('');
	    setRoundtableLoading(true);
      switchCenterView('design');
      setRoundtableScrollToBottomToken((token) => token + 1);
	    showOperation(
        roundtableDiscussionMode === 'internal_review' ? 'Agent 内部讨论中' : '设计讨论中',
        roundtableDiscussionMode === 'internal_review'
          ? '剧情设计师、Director 和设定审核正在评估可行性'
          : '剧情设计师、Director 和审核正在回复',
        0,
        'local'
      );
	    try {
	      const res = await fetch(`/api/projects/${projectId}/roundtable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic,
          discussionMode: roundtableDiscussionMode,
          contextSelection: normalizeRoundtableContextSelection(roundtableContext, currentChapter?.chapterNo),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '设计讨论失败');
      const scopedEntry = data.entry
        ? {
            ...data.entry,
            chapterNo: data.entry.chapterNo ?? currentChapter?.chapterNo,
            chapterTitle: data.entry.chapterTitle ?? currentChapter?.title,
            contextChapterNos: data.entry.contextChapterNos ?? normalizeRoundtableContextSelection(roundtableContext, currentChapter?.chapterNo).selectedChapterNos,
          }
        : data.entry;
	      setRoundtableEntries((items) => [scopedEntry, ...items].filter(Boolean).slice(0, 20));
        notifyRoundtableChanged();
	      switchCenterView('design');
        setRoundtableScrollToBottomToken((token) => token + 1);
	      showOperation(
          roundtableDiscussionMode === 'internal_review' ? '内部讨论完成' : '设计讨论完成',
          roundtableDiscussionMode === 'internal_review'
            ? '可以继续追问，也可以把可行方案转成执行'
            : '可以应用结论，或继续讨论细化本章设计',
          6000,
          'local'
        );
	      toast.success(roundtableDiscussionMode === 'internal_review' ? 'Agent 已完成可行性评估' : '设计讨论已同步到导演设计');
	    } catch (err: any) {
        const message = err.message || '设计讨论失败';
        setRoundtableError(message);
        setRoundtableTopic(topic);
	      clearOperation();
	      toast.error(message);
	    } finally {
      setRoundtableLoading(false);
      setRoundtablePendingTopic('');
    }
  };
  const handleAdoptRoundtable = async (entry: RoundtableEntry) => {
    if (entry.discussionMode === 'internal_review') {
      try {
        const res = await fetch(`/api/projects/${projectId}/roundtable`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entryId: entry.id, reviewConfirmed: true }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '确认评估失败');
        const confirmedEntry = data.entry ? { ...entry, ...data.entry, reviewConfirmed: true } : { ...entry, reviewConfirmed: true };
        setAdoptedRoundtableId(entry.id);
        setRoundtableEntries((items) => items.map((item) =>
          item.id === entry.id ? confirmedEntry : item
        ));
        notifyRoundtableChanged();
        switchCenterView('design');
        showOperation('已确认评估', '这条内部讨论只标记为已确认；不会自动修改项目。要真正改方向，请下一步点“开始改方向”。', 7000);
        toast.success('已确认这条评估；要真正修改，请继续生成修改方案');
      } catch (err: any) {
        clearOperation();
        toast.error(err.message || '确认评估失败');
      }
      return;
    }
    if (!entry.directorInstruction.trim()) return;
    if (!store.connected) {
      toast.error('未连接演绎引擎，暂时不能采纳为 Director 指令');
      return;
	    }
    const executionBrief = buildRoundtableExecutionBrief(entry);
    const currentDraft = currentChapterCompletedChapters[0];
    const plan = buildDiscussionExecutionPlan(entry, currentDraft);
	    showOperation('应用讨论结论', '正在作为最高优先级指令刷新导演设计', 10000);
    const ok = await store.sendDirectorCommand(executionBrief, { refreshDesign: true, priority: true });
    if (!ok) {
      clearOperation();
      toast.error('讨论结论应用失败');
      return;
    }
	    setAdoptedRoundtableId(entry.id);
		    switchCenterView('design');
    if (currentDraft && plan.rewriteCurrentDraft) {
      const rewriteInstruction = [
        '【已采纳设计讨论，修正当前正文】',
        '请按下面已采纳结论重写整章当前稿，保存为新的本章正稿；旧稿只能作为避坑参考，不要继续沿用已否定设定。',
        '',
        executionBrief,
      ].filter(Boolean).join('\n');
      setAdoptedRewriteInstruction(rewriteInstruction);
      toast.success('已采纳讨论结论，正在按结论修正当前稿');
      await handleRewriteChapter(currentDraft.id, rewriteInstruction, { rerunReviews: true, forceFullRewrite: true });
      return;
    }
    toast.success(currentDraft ? '已采纳并刷新导演设计；当前正文未自动改' : '已采纳为最高优先级 Director 指令，正在校准导演设计');
  };
  const handleOutlineRevisionGenerate = async (
    requestOverride?: string,
    modeOverride?: OutlineRevisionMode,
    sourceOverride: OutlineRevisionSource = 'manual'
  ) => {
    const requestSource = typeof requestOverride === 'string' ? requestOverride : outlineRevisionRequest;
    const request = requestSource.trim();
    const mode = modeOverride ?? outlineRevisionMode;
    if (!request) return;
    if (!(await ensureModelUsable('生成方向提案'))) return;
    setOutlineRevisionRequest(request);
    setOutlineRevisionMode(mode);
    setOutlineRevisionError('');
    setOutlineRevisionLoading(true);
    showOperation('生成方向提案', outlineRevisionLoadingText(mode).replace('他们正在', '剧情设计师、Director 和设定审核正在').replace('…', ''), 0, 'local');
    try {
      const res = await fetch(`/api/projects/${projectId}/outline-revision`, {
        method: 'POST',
	        headers: { 'Content-Type': 'application/json' },
		        body: JSON.stringify({ request, mode, source: sourceOverride }),
	      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '方向提案生成失败');
      setOutlineRevisionProposal(data.proposal);
	      switchCenterView('outline');
      showOperation('方向提案已生成', `请确认后再${outlineRevisionApplyLabel(data.proposal)}`, 6000, 'local');
      toast.success('方向提案已生成，确认后可应用');
    } catch (err: any) {
      const message = err.message || '方向提案生成失败';
      setOutlineRevisionError(message);
      clearOperation();
      toast.error(message);
    } finally {
      setOutlineRevisionLoading(false);
    }
	  };
  const buildOutlineRevisionRequestFromDiscussion = (entry: RoundtableEntry) => (
    [
      entry.outlineRevisionRequest?.trim() || [
      '请把这次设计讨论整理成可应用的正典/总纲/本章方向提案。',
      '',
      '用户原话：',
      entry.topic,
      '',
      'Director 理解：',
      entry.directorOpinion,
      '',
      '折中方案：',
      entry.synthesis,
      '',
      '设定审核：',
      entry.auditorOpinion,
      ].filter(Boolean).join('\n'),
      '',
      roundtableListBlock('采纳时必须一并落地', entry.mustFix),
      roundtableListBlock('连续性审计', entry.continuityAudit),
      '',
      '落库要求：',
      '- 这是设计讨论转本章方向，不得写入总纲/正典补充。',
      '- “必须一并落地”里的内容必须进入 currentChapterPatch.constraints 或 directorInstruction 的对应位置，不得只写在三方意见里。',
      '- 如果涉及经验、等级、掉落、奖励、装备、技能、天赋、职业、人物状态、位置、伤势、关系等事实，必须明确后续 Writer/Director 怎样在正文或人物状态中兑现。',
    ].filter(Boolean).join('\n')
  );
  const handleOutlineRevisionFromDiscussion = (entry: RoundtableEntry) => {
    const request = buildOutlineRevisionRequestFromDiscussion(entry);
    void handleOutlineRevisionGenerate(request, 'chapter', 'roundtable');
  };
  const handleApplyOutlineRevisionFromDiscussion = async (entry: RoundtableEntry) => {
    if (outlineRevisionLoading || outlineRevisionApplying) return;
    const request = buildOutlineRevisionRequestFromDiscussion(entry);
    const mode: OutlineRevisionMode = 'chapter';
    if (!request) return;
    if (!(await ensureModelUsable('应用设计讨论到本章方向'))) return;
    setOutlineRevisionRequest(request);
    setOutlineRevisionMode(mode);
    setOutlineRevisionProposal(null);
    setOutlineRevisionError('');
    setOutlineRevisionLoading(true);
    showOperation('生成本章方向补丁', '正在把设计讨论转成可落盘的章名、目标、范围和护栏修改', 0);
    try {
      const res = await fetch(`/api/projects/${projectId}/outline-revision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request, mode, source: 'roundtable' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '本章方向补丁生成失败');
      const proposal = supplementOutlineProposalFromDiscussion(data.proposal as OutlineRevisionProposal, entry, currentChapter);
      if (!proposal) throw new Error('本章方向补丁为空');
      setOutlineRevisionLoading(false);
      setOutlineRevisionApplying(true);
      showOperation('应用本章方向', '正在写入章节方向，并清理旧导演设计', 0);
      const applyRes = await fetch(`/api/projects/${projectId}/outline-revision`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposal, source: 'roundtable' }),
      });
      const applyData = await applyRes.json().catch(() => ({}));
      if (!applyRes.ok) throw new Error(applyData.error || '本章方向应用失败');
      if (applyData.worldState) store._onWorldUpdate(applyData.worldState);
      setOutlineRevisionProposal(null);
      setOutlineRevisionRequest('');
      setAdoptedRoundtableId(entry.id);
	      switchCenterView('design');
      if (store.connected) {
        await store.sendDirectorCommand(buildRoundtableExecutionBrief(entry), { refreshDesign: true, priority: true });
      }
      const currentDraft = currentChapterCompletedChapters[0];
      const plan = buildDiscussionExecutionPlan(entry, currentDraft);
      if (currentDraft && plan.rewriteCurrentDraft) {
        const rewriteInstruction = [
          '【已采纳设计讨论，修正当前正文】',
          '请按下面已采纳结论重写整章当前稿，保存为新的本章正稿；旧稿只能作为避坑参考，不要继续沿用已否定设定。',
          '',
          buildRoundtableExecutionBrief(entry),
        ].filter(Boolean).join('\n');
        setAdoptedRewriteInstruction(rewriteInstruction);
        toast.success('已应用方向，正在继续按结论生成新正文稿');
        await handleRewriteChapter(currentDraft.id, rewriteInstruction, { rerunReviews: true, forceFullRewrite: true });
        return;
      }
      showOperation('本章方向已应用', store.connected ? '已同步刷新导演设计；后续演绎会读取新方向' : '旧导演设计已清空；连接演绎引擎后再生成新设计', 7000);
      toast.success(store.connected ? '已应用到本章方向，并刷新导演设计' : '已应用到本章方向');
    } catch (err: any) {
      const message = err.message || '本章方向应用失败';
      setOutlineRevisionError(message);
      clearOperation();
      toast.error(message);
    } finally {
      setOutlineRevisionLoading(false);
      setOutlineRevisionApplying(false);
    }
  };
  const handleOutlineRevisionApply = async (proposal: OutlineRevisionProposal) => {
    if (!proposal || outlineRevisionApplying) return;
    setOutlineRevisionApplying(true);
    setOutlineRevisionError('');
    const successLabel = outlineRevisionSuccessLabel(proposal);
    showOperation(outlineRevisionApplyLabel(proposal), outlineRevisionApplyDetail(proposal), 0);
    try {
      const res = await fetch(`/api/projects/${projectId}/outline-revision`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposal }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '方向修改应用失败');
      if (data.worldState) store._onWorldUpdate(data.worldState);
      setOutlineRevisionProposal(null);
      setOutlineRevisionRequest('');
      setAdoptedRoundtableId('');
      switchCenterView('design');
      if (store.connected) {
        store.prepareStoryDesign();
        showOperation(`${successLabel}，正在生成导演设计`, '旧导演设计已清空；剧情设计师正在按新边界刷新本章蓝图', 0);
        toast.success(`${successLabel}，正在刷新导演设计`);
      } else {
        showOperation(successLabel, '连接演绎引擎后再生成导演设计，让新方向生效', 7000);
        toast.success(`${successLabel}；连接后请生成导演设计`);
      }
    } catch (err: any) {
      const message = err.message || '方向修改应用失败';
      setOutlineRevisionError(message);
      clearOperation();
      toast.error(message);
    } finally {
      setOutlineRevisionApplying(false);
    }
  };

  const handleSyncStoryBible = async () => {
    if (storyBibleSyncing) return;
    if (!(await ensureModelUsable('同步总纲到执行节点'))) return;
    setStoryBibleSyncing(true);
    setOutlineRevisionError('');
    showOperation('同步总纲到执行节点', '正在把用户补充总纲重建为卷规划、执行节点和当前章方向', 0);
    try {
      const res = await fetch(`/api/projects/${projectId}/sync-story-bible`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '同步总纲失败');
      if (data.worldState) store._onWorldUpdate(data.worldState);
      setOutlineRevisionProposal(null);
	      switchCenterView('outline');
      showOperation('总纲同步完成', `已生成 ${data.volumeCount ?? 0} 卷 / ${data.nodeCount ?? 0} 个执行节点`, 8000);
      toast.success(`总纲已同步：${data.volumeCount ?? 0} 卷 / ${data.nodeCount ?? 0} 个节点`);
    } catch (err: any) {
      const message = err.message || '同步总纲失败';
      setOutlineRevisionError(message);
      showOperation('同步失败', message, 8000);
      toast.error(message);
    } finally {
      setStoryBibleSyncing(false);
    }
  };

  const handleToggleEventClosure = (eventId: string, closed: boolean) => {
    if (!store.worldState) return;
    store.sendWorldEdit({
      eventClosureStatus: {
        ...(store.worldState.eventClosureStatus ?? {}),
        [eventId]: closed ? 'closed' : 'open',
      },
    });
    toast.success(closed ? '事件已标记为结束' : '事件已重新开启');
  };

  const isRunning = store.projectStatus === 'running';
  const currentChapter = store.worldState?.currentChapter;
  const chapterDraftGroups = buildChapterDraftGroups(store.completedChapters, store.worldState, store.readerReviews);
  const landedChapterCount = chapterDraftGroups.length;
  const historicalDraftCount = Math.max(0, store.completedChapters.length - landedChapterCount);
  const latestLandedChapterNo = chapterDraftGroups.length
    ? chapterDraftGroups[chapterDraftGroups.length - 1].chapterNo
    : undefined;
  const currentChapterDraftGroups = currentChapter
    ? chapterDraftGroups.filter((group) => group.chapterNo === currentChapter.chapterNo)
    : chapterDraftGroups;
  const currentChapterCompletedChapters = currentChapterDraftGroups.map((group) => group.currentDraft);
  const currentChapterDraft = currentChapterCompletedChapters[0] ?? null;
  const chapterStartTurn = currentChapter && store.worldState
    ? resolveChapterStartTurn(store.worldState, currentChapter)
    : 0;
  const chapterEndTurn = store.worldState?.turn ?? 0;
  const draftStartTurn =
    typeof currentChapterDraft?.startTurn === 'number' ? currentChapterDraft.startTurn : null;
  const draftEndTurn =
    typeof currentChapterDraft?.endTurn === 'number' ? currentChapterDraft.endTurn : null;
  const eventRangeStartTurn =
    draftStartTurn !== null && draftEndTurn !== null ? draftStartTurn : chapterStartTurn;
  const eventRangeEndTurn =
    draftStartTurn !== null && draftEndTurn !== null ? draftEndTurn : chapterEndTurn;
  const currentChapterEvents = currentChapter
    ? store.events.filter((event) => event.turn > eventRangeStartTurn && event.turn <= eventRangeEndTurn)
    : store.events;
  const effectiveRoundtableContext = normalizeRoundtableContextSelection(roundtableContext, currentChapter?.chapterNo);
  const currentChapterRoundtableEntries = roundtableEntries.filter((entry) =>
    isRoundtableEntryForChapter(entry, currentChapter?.chapterNo)
  );
  const currentChapterAdoptedRoundtableId =
    currentChapterRoundtableEntries.some((entry) => entry.id === adoptedRoundtableId)
      ? adoptedRoundtableId
      : '';
  const roundtableChapterOptions = Array.from(new Set([
    ...(currentChapter?.chapterNo ? [currentChapter.chapterNo] : []),
    ...chapterDraftGroups.map((group) => group.chapterNo),
  ])).sort((a, b) => a - b);
  const writerText = Object.entries(store.chapterChunks).map(([_, v]) => v).join('');
  const completedText = currentChapterCompletedChapters.map((c) => c.content).join('\n\n');
  const fullWriterText = completedText + (writerText ? '\n\n' + writerText : '');
  const reviewCount = currentChapterCompletedChapters.reduce(
    (sum, chapter) => sum + (store.readerReviews[chapter.id]?.length ?? chapter.readerReviews?.length ?? 0),
    0
  );
  const chapterProgress = currentChapter && store.worldState
    ? Math.max(0, (store.worldState.turn ?? 0) - chapterStartTurn)
    : 0;
  const chapterTargetTurns = Math.max(1, Number(currentChapter?.targetTurns ?? 8));
  const isChapterAtClosure = !!currentChapter && chapterProgress >= chapterTargetTurns;
  const storyDesign = store.storyDesign ?? store.worldState?.storyDesign ?? null;
  const centerViewMeta: Record<CenterView, { title: string; desc: string; icon: ReactNode }> = {
	    design: {
	      title: '导演设计',
	      desc: '本章方向、设计讨论、上下文和下一步执行入口。',
	      icon: <Zap className="h-4 w-4 text-primary" />,
	    },
	    events: {
	      title: '事件日志',
	      desc: '角色实际跑戏过程，不等于正文事实。',
	      icon: <Activity className="h-4 w-4 text-primary" />,
	    },
	    writer: {
	      title: '小说正文',
	      desc: '根据本章事件生成和查看当前正稿。',
	      icon: <FileText className="h-4 w-4 text-primary" />,
	    },
	    reviews: {
	      title: '读者评审',
	      desc: '检查正文的节奏、连续性、设定和爽点。',
	      icon: <MessageSquare className="h-4 w-4 text-primary" />,
	    },
	    outline: {
	      title: '方向提案',
	      desc: '总纲、章节名、目标和剧情走向的可应用修改。',
	      icon: <PencilLine className="h-4 w-4 text-primary" />,
	    },
	    assets: {
	      title: '素材库',
	      desc: '天赋、职业、技能、装备、宠物、坐骑和伏笔材料。',
	      icon: <Package className="h-4 w-4 text-primary" />,
	    },
	    lessons: {
	      title: '经验总结',
	      desc: '从评审和修正中沉淀给后续章节的经验。',
	      icon: <BookMarked className="h-4 w-4 text-primary" />,
	    },
	    chapters: {
	      title: '章节目录',
	      desc: '查看已经落地的正稿和历史稿。',
	      icon: <BookOpen className="h-4 w-4 text-primary" />,
	    },
	    logs: {
	      title: '引擎日志',
	      desc: '模型、连接、执行状态和错误排查。',
	      icon: <Info className="h-4 w-4 text-primary" />,
	    },
	    split: {
	      title: '分屏',
	      desc: '同时查看事件和正文的辅助视图。',
	      icon: <Rows2 className="h-4 w-4 text-primary" />,
	    },
	  };
		  const chapterWordLabel = currentChapter
		    ? formatChapterWordTarget(
		        currentChapter.targetWordMin ?? CHAPTER_WORD_TARGET_MIN,
	        currentChapter.targetWordMax ?? CHAPTER_WORD_TARGET_MAX
	      )
	    : formatChapterWordTarget();
	  const latestLog = store.logs[store.logs.length - 1] ?? null;
	  const streamingWriter = Object.values(store.chapterChunks).some((chunk) => chunk.length > 0);
  const storyDesignUpdatedAt = storyDesign?.updatedAt ? new Date(storyDesign.updatedAt).getTime() : 0;
  const visibleOperation: ActiveOperation =
    activeOperation?.scope !== 'local' && activeOperation
      ? activeOperation
      : streamingWriter
        ? { label: 'Writer 正在生成正文', detail: '正文区正在流式输出', startedAt: Date.now() }
        : isRunning
          ? { label: '演绎运行中', detail: '角色行动会持续写入事件日志', startedAt: Date.now() }
          : null;

  useEffect(() => {
    const chapterNo = currentChapter?.chapterNo;
    if (!chapterNo) {
      setAdoptedRoundtableId('');
      return;
    }
    const stored = loadAdoptedRoundtableId(projectId, chapterNo);
    const valid = stored && roundtableEntries.some((entry) => entry.id === stored && entry.chapterNo === chapterNo);
    setAdoptedRoundtableId(valid ? stored : '');
  }, [projectId, currentChapter?.chapterNo, roundtableEntries]);

  useEffect(() => {
    if (!currentChapter || eventRangeEndTurn <= eventRangeStartTurn || currentChapterEvents.length > 0) {
      return;
    }
    const rangeKey = `${projectId}:${currentChapter.chapterNo}:${eventRangeStartTurn}:${eventRangeEndTurn}`;
    if (fetchedEventRangesRef.current.has(rangeKey)) return;
    fetchedEventRangesRef.current.add(rangeKey);

    const fromTurn = Math.max(0, eventRangeStartTurn + 1);
    const limit = Math.max(200, eventRangeEndTurn - eventRangeStartTurn + 20);
    fetch(`/api/projects/${projectId}/events?fromTurn=${fromTurn}&limit=${limit}`)
      .then((r) => r.json())
      .then((data) => {
        (data.events ?? [])
          .filter((event: NovelEvent) => event.turn > eventRangeStartTurn && event.turn <= eventRangeEndTurn)
          .forEach((event: NovelEvent) => store._onEventNew(event));
      })
      .catch((err) => {
        console.warn('[NovelStudio] 补拉本章事件日志失败', err);
        toast.error('补拉本章事件日志失败');
      });
  }, [
    projectId,
    currentChapter?.chapterNo,
    currentChapterEvents.length,
    eventRangeStartTurn,
    eventRangeEndTurn,
  ]);

  useEffect(() => {
    if (!activeOperation || !storyDesignUpdatedAt) return;
    const waitsForDesign = [
      '生成导演设计',
      '发送 Director 指令',
      '校准导演设计',
      '评审已回流',
      '应用讨论结论',
    ].some((label) => activeOperation.label.includes(label));
    if (waitsForDesign && storyDesignUpdatedAt >= activeOperation.startedAt - 1000) {
      showOperation('导演设计已更新', '新的本章设计已经刷新到导演设计页', 6000);
    }
  }, [storyDesignUpdatedAt]);

  useEffect(() => {
    if (!activeOperation || !latestLog || latestLog.level !== 'error') return;
    if (latestLog.timestamp < activeOperation.startedAt) return;
    clearOperation();
    toast.error(latestLog.message);
  }, [latestLog?.id]);

  useEffect(() => {
    if (store.projectStatus !== 'idle' || streamingWriter || !activeOperation || activeOperation.scope === 'local') return;
    if (Date.now() - activeOperation.startedAt < 1500) return;
    const clearsWhenIdle = [
      '演绎一轮',
      '章节自循环',
      '停止演绎',
      '暂停演绎',
      '恢复演绎',
      '自动模式运行中',
    ].some((label) => activeOperation.label.includes(label));
    if (clearsWhenIdle) {
      showOperation('已回到待启动', '本次执行已结束，可以继续讨论、演绎或写作', 5000);
    }
  }, [store.projectStatus, streamingWriter, activeOperation?.label, activeOperation?.scope]);

  useEffect(() => {
    const previous = completedCountRef.current;
    const current = currentChapterCompletedChapters.length;
    completedCountRef.current = current;
    if (current > previous && activeOperation?.label.includes('生成正文')) {
      showOperation('正文生成完成', 'Writer 已输出正文，Reader 会继续评审', 7000);
    }
  }, [currentChapterCompletedChapters.length]);

  useEffect(() => {
    const previous = eventCountRef.current;
    const current = currentChapterEvents.length;
    eventCountRef.current = current;
    if (current > previous && activeOperation?.label.includes('章节自循环')) {
      showOperation('章节自循环运行中', '事件日志已追加，正在继续本章闭环', 8000);
    }
  }, [currentChapterEvents.length]);

		  async function refreshModelConfig(): Promise<ModelConfigStatus | null> {
    try {
      const res = await fetch('/api/model-config', { cache: 'no-store' });
      const data = await res.json();
      setModelConfig(data);
      if (!data?.configured) setModelConnection('unknown');
      return data;
    } catch {
      setModelConfig(null);
      setModelConnection('unknown');
      return null;
    }
  }

  async function ensureModelUsable(actionName: string): Promise<boolean> {
    let latestConfig = modelConfig;
    if (!latestConfig?.configured) {
      latestConfig = await refreshModelConfig();
    }
    if (!latestConfig?.configured) {
      setModelDialogOpen(true);
      toast.error(`先配置模型，再${actionName}`);
      return false;
    }
    if (modelConnection === 'ok') return true;
    setCheckingModel(true);
    try {
      const res = await fetch('/api/model-config/test', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '模型连接失败');
      setModelConnection('ok');
      return true;
    } catch (err: any) {
      const msg = err.message || '模型连接失败';
      setModelConnection('failed');
      setModelDialogOpen(true);
      toast.error(msg);
      return false;
    } finally {
      setCheckingModel(false);
    }
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* 顶栏 */}
      <header className="border-b bg-background/95 backdrop-blur flex-shrink-0">
        <div className="px-3 py-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Button variant="ghost" size="sm" onClick={onBack}>
              <ChevronLeft className="h-4 w-4" /> 项目
            </Button>
            <Separator orientation="vertical" className="h-5" />
            <div className="min-w-0">
              <div className="font-semibold truncate flex items-center gap-2">
                {editingProjectName ? (
                  <div className="flex min-w-[220px] max-w-[380px] items-center gap-1">
                    <Input
                      value={projectNameDraft}
                      onChange={(event) => setProjectNameDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          saveProjectName();
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          cancelProjectNameEdit();
                        }
                      }}
                      className="h-8 min-w-0 text-sm font-semibold"
                      maxLength={80}
                      autoFocus
                      disabled={savingProjectName}
                      aria-label="项目名"
                    />
                    <Button
                      type="button"
                      size="icon"
                      className="h-8 w-8 flex-shrink-0"
                      onClick={saveProjectName}
                      disabled={savingProjectName}
                      title="保存项目名"
                    >
                      {savingProjectName ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <CheckCircle2 className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 flex-shrink-0"
                      onClick={cancelProjectNameEdit}
                      disabled={savingProjectName}
                      title="取消修改"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="group flex min-w-0 max-w-[360px] items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-accent"
                    onClick={() => {
                      setProjectNameDraft(displayProjectName);
                      setEditingProjectName(true);
                    }}
                    title="修改项目名"
                  >
                    <span className="truncate">{displayProjectName}</span>
                    <PencilLine className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </button>
                )}
                {currentChapter && (
                  <Badge variant="outline" className="text-[10px] border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
                    第 {currentChapter.chapterNo} 章 · {normalizeChapterTitle(currentChapter.title, currentChapter.chapterNo)}
                  </Badge>
                )}
                <Badge variant="outline" className={
                  `text-[10px] ${store.connected ? 'border-green-500 text-green-700' : 'border-red-500 text-red-700'}`
                }>
                  {store.connected ? '已连接' : '未连接'}
                </Badge>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle compact />
            <Button
              size="sm"
              variant={modelConfig?.configured ? 'outline' : 'secondary'}
              onClick={() => setModelDialogOpen(true)}
              title={
                !modelConfig?.configured
                  ? '需要先配置模型'
                  : modelConnection === 'failed'
                    ? '模型连接失败'
                    : modelConnection === 'ok'
                      ? '模型连接已通过'
                      : '模型已配置'
              }
              className={
                !modelConfig?.configured || modelConnection === 'failed'
                  ? 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-950/45'
                  : ''
              }
            >
              {checkingModel ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : modelConfig?.configured && modelConnection !== 'failed' ? (
                <PlugZap className="h-4 w-4 mr-1" />
              ) : (
                <KeyRound className="h-4 w-4 mr-1" />
              )}
              模型
            </Button>
            {isRunning && (
              <Button size="sm" variant="outline" onClick={handlePause} disabled={resetting}>
                <Pause className="h-4 w-4 mr-1" /> 暂停
              </Button>
            )}
            {store.projectStatus === 'paused' && (
              <Button size="sm" onClick={handleResume} disabled={resetting}>
                <Play className="h-4 w-4 mr-1" /> 继续
              </Button>
            )}
            {(isRunning || store.projectStatus === 'paused') && (
              <Button size="sm" variant="destructive" onClick={handleStop} disabled={resetting}>
                <Square className="h-4 w-4 mr-1" /> 停止
              </Button>
            )}
            <Separator orientation="vertical" className="h-5" />
            <Button
              size="sm"
              variant="outline"
              onClick={() => setGuideOpen(true)}
              title="查看界面各区域和推荐操作顺序"
            >
              <Info className="h-4 w-4 mr-1" /> 使用引导
            </Button>
          </div>
        </div>
	      </header>

      <RunStatusBar
        connected={store.connected}
        projectStatus={store.projectStatus}
        operation={visibleOperation}
        latestLog={latestLog}
        eventCount={currentChapterEvents.length}
        completedCount={landedChapterCount}
        draftCount={historicalDraftCount}
        chapterProgress={chapterProgress}
        targetTurns={chapterTargetTurns}
        writerActive={streamingWriter}
        onShowLogs={() => switchCenterView('logs')}
        onShowChapters={() => switchCenterView('chapters')}
      />

	      {/* 内容区 */}
      <main className="flex-1 grid grid-cols-1 gap-px bg-border overflow-hidden min-h-0 lg:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[252px_minmax(0,1fr)_260px] 2xl:grid-cols-[272px_minmax(0,1fr)_288px]">
        {/* 左栏：控制面板 */}
        <aside className="hidden bg-background overflow-y-auto min-h-0 lg:block">
          <InterventionPanel
            directorCmd={directorCmd}
            setDirectorCmd={setDirectorCmd}
            onSendCmd={handleDirectorCmd}
            directorLvl={store.directorLvl}
            onLvlChange={handleDirectorLvlChange}
            worldState={store.worldState}
            worldSceneInput={worldSceneInput}
            setWorldSceneInput={setWorldSceneInput}
            onWorldEdit={handleWorldSceneEdit}
            completedChapters={currentChapterCompletedChapters}
            currentChapter={currentChapter}
            storyDesign={storyDesign}
            onPacingModeChange={store.setPacingMode}
	            onPlanningSettingsSave={handlePlanningSettingsSave}
	            onStoryBibleNotesSave={handleStoryBibleNotesSave}
	            onAgentPolicySave={handleAgentPolicySave}
            onRetreatChapter={handleRetreatChapter}
            onAdvanceChapter={handleAdvanceChapter}
            onResetChapter={handleReset}
            onCleanupInvalid={handleCleanupInvalid}
            onShowView={switchCenterView}
            currentView={centerView}
            assetCount={store.worldState?.assetLibrary?.length ?? 0}
            lessonsCount={store.craftLessons.length}
            chapterCount={chapterDraftGroups.length}
            logCount={store.logs.length}
            outlinePending={!!outlineRevisionProposal}
            connected={store.connected}
            isRunning={isRunning}
            checkingModel={checkingModel}
            resetting={resetting}
            cleaningInvalid={cleaningInvalid}
            canCleanupInvalid={currentChapterCompletedChapters.length > 0}
            eventsCount={currentChapterEvents.length}
            chapterProgress={chapterProgress}
            reviewCount={reviewCount}
          />
        </aside>

        {/* 中栏：事件日志 + Writer 输出（Tab 切换 + 可调高度） */}
        <section className="bg-background overflow-hidden flex flex-col min-h-0">
          {/* Tab 切换 */}
          <div className="border-b bg-muted/20 px-2 py-2 flex-shrink-0">
            <div className="flex items-center gap-2 overflow-x-auto overflow-y-hidden">
              <button
                onClick={() => switchWorkspaceSection('chapter')}
                className={`h-8 rounded-md px-3 text-xs transition-colors whitespace-nowrap ${
                  workspaceSection === 'chapter' ? 'bg-background text-foreground font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
                title="当前章的设计、演绎、正文和评审"
              >
                章节工作台
              </button>
              <button
                onClick={() => switchWorkspaceSection('project')}
                className={`h-8 rounded-md px-3 text-xs transition-colors whitespace-nowrap ${
                  workspaceSection === 'project' ? 'bg-background text-foreground font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
                title="总纲、素材、经验和章节档案"
              >
                项目设定
              </button>
              <button
                onClick={() => switchWorkspaceSection('system')}
                className={`h-8 rounded-md px-3 text-xs transition-colors whitespace-nowrap ${
                  workspaceSection === 'system' ? 'bg-background text-foreground font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
                title="模型配置、运行状态和引擎日志"
              >
                系统监控
              </button>
              <div className="ml-auto hidden min-w-0 items-center gap-1.5 border-l pl-3 md:flex" title={centerViewMeta[centerView].desc}>
                {centerViewMeta[centerView].icon}
                <span className="truncate text-xs font-medium">{centerViewMeta[centerView].title}</span>
                {outlineRevisionProposal && centerView === 'outline' && (
                  <Badge variant="outline" className="border-amber-300 bg-amber-50 text-[10px] text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/25 dark:text-amber-200">
                    待应用
                  </Badge>
                )}
                {writerText && centerView === 'writer' && <span className="text-[10px] text-amber-600 animate-pulse">写作中</span>}
              </div>
            </div>
          </div>

          {centerView !== 'design' && (
            <CenterStepStartBar
              centerView={centerView}
              connected={store.connected}
              isRunning={isRunning}
              checkingModel={checkingModel}
              writerActive={streamingWriter}
              currentChapter={currentChapter}
              currentChapterDesign={storyDesign}
              eventsCount={currentChapterEvents.length}
              chapterProgress={chapterProgress}
              chapterTargetTurns={chapterTargetTurns}
              completedCount={currentChapterCompletedChapters.length}
              reviewCount={reviewCount}
              currentDraft={currentChapterCompletedChapters[0] ?? null}
              onPrepareDesign={handlePrepareDesign}
              onStart={handleStart}
              onWriteChapter={handleWriteChapter}
              onChapterAuto={handleChapterAuto}
              onRerunReviews={(chapterId) => {
                void handleRerunReaderReviews(chapterId);
              }}
              onShowView={switchCenterView}
            />
          )}

          {/* 内容区 */}
          <div className="flex-1 overflow-hidden flex flex-col min-h-0">
            {centerView === 'writer' && (
              <div className="flex-1 overflow-hidden min-h-0">
                <WriterPanel
                  text={fullWriterText}
                  streamText={writerText}
                  scrollRef={writerScrollRef}
                  fullHeight
                  landedChaptersCount={landedChapterCount}
                  latestLandedChapterNo={latestLandedChapterNo}
                  currentChapterNo={currentChapter?.chapterNo}
                  onOpenChapters={() => switchCenterView('chapters')}
                />
              </div>
            )}
            {centerView === 'events' && (
              <div className="flex-1 overflow-hidden min-h-0">
                <EventLogPanel
                  events={currentChapterEvents}
                  scrollRef={eventScrollRef}
                  fullHeight
                  hasCurrentDraft={!!currentChapterDraft}
                  currentChapter={currentChapter}
                  characters={store.characters}
                  presentCharacterIds={store.worldState?.presentCharacterIds ?? []}
                  eventClosureStatus={store.worldState?.eventClosureStatus ?? {}}
                  onToggleEventClosure={handleToggleEventClosure}
                />
              </div>
            )}
            {centerView === 'reviews' && (
              <div className="flex-1 overflow-hidden min-h-0">
                <ReaderReviewPanel
                  chapters={currentChapterCompletedChapters}
                  readerReviews={store.readerReviews}
                  worldState={store.worldState}
                  scrollRef={reviewScrollRef}
                  fullHeight
                  canSend={store.connected}
                  onSendToDirector={handleReviewFeedbackToDirector}
                  onRerunReviews={handleRerunReaderReviews}
                />
              </div>
            )}
            {centerView === 'design' && (
              <div className="flex-1 overflow-hidden min-h-0">
                <StoryDesignPanel
                  currentChapter={currentChapter}
                  storyDesign={storyDesign}
                  currentDraft={currentChapterCompletedChapters[0] ?? null}
                  rewritingChapterId={rewritingChapterId}
                  discussionTopic={roundtableTopic}
                  setDiscussionTopic={setRoundtableTopic}
                  discussionMode={roundtableDiscussionMode}
                  setDiscussionMode={setRoundtableDiscussionMode}
                  discussionEntries={currentChapterRoundtableEntries}
                  discussionLoading={roundtableLoading}
                  pendingTopic={roundtablePendingTopic}
                  discussionError={roundtableError}
                  contextSelection={effectiveRoundtableContext}
                  onContextSelectionChange={setRoundtableContext}
                  chapterOptions={roundtableChapterOptions}
                  assetCount={store.worldState?.assetLibrary?.length ?? 0}
                  hasPendingOutlineProposal={!!outlineRevisionProposal}
                  outlineProposalTitle={outlineRevisionProposal?.title ?? ''}
                  adoptedEntryId={currentChapterAdoptedRoundtableId}
                  scrollStorageKey={roundtableScrollStorageKey(projectId)}
                  scrollToBottomToken={roundtableScrollToBottomToken}
                  connected={store.connected}
                  isRunning={isRunning}
                  checkingModel={checkingModel}
                  eventsCount={currentChapterEvents.length}
                  chapterProgress={chapterProgress}
                  chapterTargetTurns={chapterTargetTurns}
                  completedCount={currentChapterCompletedChapters.length}
                  reviewCount={reviewCount}
                  onPrepareDesign={handlePrepareDesign}
                  onStart={handleStart}
                  onChapterAuto={handleChapterAuto}
                  onWriteChapter={handleWriteChapter}
                  onResetChapter={handleReset}
                  onShowView={switchCenterView}
                  onShowOutlineProposal={() => switchCenterView('outline')}
                  onDiscussionSubmit={handleRoundtableSubmit}
	                  onAdoptDiscussion={handleAdoptRoundtable}
	                  onGenerateOutlineFromDiscussion={handleOutlineRevisionFromDiscussion}
	                  onApplyOutlineFromDiscussion={handleApplyOutlineRevisionFromDiscussion}
	                  onRewriteAdoptedChapter={(entry) => {
                    const currentDraft = currentChapterCompletedChapters[0];
                    if (!currentDraft) {
                      toast.info('当前章还没有正文，先演绎或生成正文');
                      return;
                    }
                    const rewriteInstruction = [
                      '【已采纳设计讨论，修正当前正文】',
                      '请按下面已采纳结论重写整章当前稿，保存为新的本章正稿；旧稿只能作为避坑参考，不要继续沿用已否定设定。',
                      '',
                      buildRoundtableExecutionBrief(entry),
                    ].filter(Boolean).join('\n');
                    setAdoptedRewriteInstruction(rewriteInstruction);
                    void handleRewriteChapter(currentDraft.id, rewriteInstruction, { rerunReviews: true, forceFullRewrite: true });
                  }}
                  fullHeight
                />
              </div>
            )}
            {centerView === 'outline' && (
              <div className="flex-1 overflow-hidden min-h-0">
                <OutlineRevisionPanel
                  worldState={store.worldState}
                  mode={outlineRevisionMode}
                  setMode={setOutlineRevisionMode}
                  request={outlineRevisionRequest}
                  setRequest={setOutlineRevisionRequest}
                  proposal={outlineRevisionProposal}
                  loading={outlineRevisionLoading}
                  applying={outlineRevisionApplying}
                  error={outlineRevisionError}
                  onGenerate={handleOutlineRevisionGenerate}
                  onApply={handleOutlineRevisionApply}
                  onClearProposal={() => setOutlineRevisionProposal(null)}
                  onShowDesign={() => switchCenterView('design')}
                  onSyncStoryBible={handleSyncStoryBible}
                  syncingStoryBible={storyBibleSyncing}
                  fullHeight
                />
              </div>
            )}
            {centerView === 'assets' && (
              <div className="flex-1 overflow-hidden min-h-0">
                <AssetLibraryPanel
                  projectId={projectId}
                  worldState={store.worldState}
                  currentChapterNo={currentChapter?.chapterNo}
                  onWorldUpdate={(worldState) => store._onWorldUpdate(worldState)}
                  onShowDesign={() => switchCenterView('design')}
                  fullHeight
                />
              </div>
            )}
            {centerView === 'lessons' && (
              <div className="flex-1 overflow-hidden min-h-0">
                <CraftLessonsPanel
                  craftLessons={store.craftLessons}
                  fullHeight
                />
              </div>
            )}
            {centerView === 'chapters' && (
              <div className="flex-1 overflow-hidden min-h-0">
                <ChapterCatalogPanel
                  chapters={store.completedChapters}
                  readerReviews={store.readerReviews}
	                  worldState={store.worldState}
	                  rewritingChapterId={rewritingChapterId}
	                  selectingCanonicalId={selectingCanonicalId}
                  focusingChapterId={focusingChapterId}
                  currentChapterNo={currentChapter?.chapterNo}
	                  onRewriteChapter={handleRewriteChapter}
	                  onSelectCanonicalDraft={handleSelectCanonicalDraft}
                  onFocusChapterForDesign={handleFocusChapterForDesign}
                  onOpenDesign={() => switchCenterView('design')}
	                  fullHeight
	                />
              </div>
            )}
            {centerView === 'logs' && (
              <div className="flex-1 overflow-hidden min-h-0">
                <EngineLogPanel logs={store.logs} scrollRef={logScrollRef} fullHeight />
              </div>
            )}
            {centerView === 'split' && (
              <div className="flex-1 grid grid-rows-2 gap-px bg-border overflow-hidden min-h-0">
                <div className="bg-background overflow-hidden flex flex-col min-h-0">
                  <EventLogPanel
                    events={currentChapterEvents}
                    scrollRef={eventScrollRef}
                    hasCurrentDraft={!!currentChapterDraft}
                    currentChapter={currentChapter}
                    characters={store.characters}
                    presentCharacterIds={store.worldState?.presentCharacterIds ?? []}
                    eventClosureStatus={store.worldState?.eventClosureStatus ?? {}}
                    onToggleEventClosure={handleToggleEventClosure}
                  />
                </div>
                <div className="bg-background overflow-hidden flex flex-col min-h-0">
                  <WriterPanel
                    text={fullWriterText}
                    streamText={writerText}
                    scrollRef={writerScrollRef}
                    landedChaptersCount={landedChapterCount}
                    latestLandedChapterNo={latestLandedChapterNo}
                    currentChapterNo={currentChapter?.chapterNo}
                    onOpenChapters={() => switchCenterView('chapters')}
                  />
                </div>
              </div>
            )}
          </div>
        </section>

        {/* 右栏：人物面板 */}
        <aside className="hidden bg-background overflow-y-auto min-h-0 xl:block">
          <CharacterPanel
            projectId={projectId}
            characters={store.characters}
            worldState={store.worldState}
            editingId={editingCharacter}
            charEmotionInput={charEmotionInput}
            charLocationInput={charLocationInput}
            charGenderInput={charGenderInput}
            charBackgroundInput={charBackgroundInput}
            charStanceInput={charStanceInput}
            charSpeechStyleInput={charSpeechStyleInput}
            charPersonalityInput={charPersonalityInput}
            charGoalsInput={charGoalsInput}
            charActorNotesInput={charActorNotesInput}
            charIdentityNotesInput={charIdentityNotesInput}
            charCoreBeliefsInput={charCoreBeliefsInput}
            charBehaviorRulesInput={charBehaviorRulesInput}
            charSpeechRulesInput={charSpeechRulesInput}
            charForbiddenRulesInput={charForbiddenRulesInput}
            setCharEmotionInput={setCharEmotionInput}
            setCharLocationInput={setCharLocationInput}
            setCharGenderInput={setCharGenderInput}
            setCharBackgroundInput={setCharBackgroundInput}
            setCharStanceInput={setCharStanceInput}
            setCharSpeechStyleInput={setCharSpeechStyleInput}
            setCharPersonalityInput={setCharPersonalityInput}
            setCharGoalsInput={setCharGoalsInput}
            setCharActorNotesInput={setCharActorNotesInput}
            setCharIdentityNotesInput={setCharIdentityNotesInput}
            setCharCoreBeliefsInput={setCharCoreBeliefsInput}
            setCharBehaviorRulesInput={setCharBehaviorRulesInput}
            setCharSpeechRulesInput={setCharSpeechRulesInput}
            setCharForbiddenRulesInput={setCharForbiddenRulesInput}
            onEdit={handleCharacterEdit}
            onSave={saveCharacterEdit}
            onCancel={() => setEditingCharacter(null)}
          />
        </aside>
      </main>
      <ModelConfigDialog
        open={modelDialogOpen}
        onOpenChange={setModelDialogOpen}
        status={modelConfig}
        connectionState={modelConnection}
        setConnectionState={setModelConnection}
        onSaved={async () => {
          await refreshModelConfig();
        }}
      />
      <UsageGuideDialog open={guideOpen} onOpenChange={setGuideOpen} chapterWordLabel={chapterWordLabel} />
    </div>
  );
}

function UsageGuideDialog({ open, onOpenChange, chapterWordLabel }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chapterWordLabel: string;
}) {
  const flow = [
    ['确认方向', '先在左栏切到导演设计，中栏会显示本章方向、蓝图和下一步主动作。'],
    ['设计讨论', '有想法先在导演设计页发起讨论；评估只判断可行性，方案才用于采纳执行。'],
    ['生成设计', '采纳后的结论会成为最高优先级，但仍要生成导演蓝图，形成拍点、事件刺激和护栏。'],
    ['演绎事件', '演绎一轮只推进角色行动；看事件日志确认角色有没有接住设计，不把日志当正文。'],
    ['生成正文', `事件到收束点后再写正文，当前章节目标 ${chapterWordLabel}。`],
    ['评审回流', '正文出来后先评审，再决定修正文、补事件、改方向，或进入下一章。'],
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>界面使用引导</DialogTitle>
          <DialogDescription>
            这套界面不是聊天窗口，而是“导演设计、演绎事件、正文输出、读者评审、回流修正”的章节工作台。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-2">
            {flow.map(([title, desc], index) => (
              <div key={title} className="rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] text-primary-foreground">
                    {index + 1}
                  </span>
                  <div className="text-sm font-semibold">{title}</div>
                </div>
                <div className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{desc}</div>
              </div>
            ))}
          </div>
          <div className="space-y-3 text-sm">
            <GuideBlock
              title="左栏：工作区目录"
              lines={[
                '负责切换导演设计、事件、正文、评审、素材、日志。',
                '只放导航和少量设置，不承载章节执行主动作。',
                '章节切换、演绎偏好、维护操作收在折叠区。',
              ]}
            />
            <GuideBlock
              title="中栏：工作台"
		              lines={[
		                '顶部只显示当前页标题和说明。',
		                '导演设计页负责讨论、提案落地和下一步执行。',
		                '事件日志只看跑戏，不把日志当正文事实。',
		                '小说正文看 Writer 写出的当前稿和历史稿。',
		                `正文长度：当前章节目标 ${chapterWordLabel}。`,
		                '读者评审：看文笔、节奏、设定问题。',
		              ]}
            />
            <GuideBlock
              title="右栏：人物事实"
              lines={[
                '看谁在场、位置、情绪、等级、经验和关系。',
                '人物长期状态会影响后续章节。',
                '剧情推进回到章节工作台执行。',
              ]}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>知道了</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GuideBlock({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="font-semibold">{title}</div>
      <ul className="mt-2 space-y-1 text-xs leading-relaxed text-muted-foreground">
        {lines.map((line) => (
          <li key={line}>- {line}</li>
        ))}
      </ul>
    </div>
  );
}

function relationTone(value: number): string {
  if (value >= 70) return '信任';
  if (value >= 35) return '友善';
  if (value > -20) return '中立';
  if (value > -60) return '戒备';
  return '敌对';
}

function relationBarWidth(value: number): string {
  return `${Math.max(0, Math.min(100, value + 100) / 2)}%`;
}

function chapterWordLabelOf(chapter?: any): string {
  return formatChapterWordTarget(
    chapter?.targetWordMin ?? CHAPTER_WORD_TARGET_MIN,
    chapter?.targetWordMax ?? CHAPTER_WORD_TARGET_MAX
  );
}

function targetWordsLabel(value?: number): string {
  const words = Math.max(0, Math.floor(value ?? LONG_FORM_TARGET_WORDS));
  if (words >= 10000) {
    const wan = words / 10000;
    return `${Number.isInteger(wan) ? wan : wan.toFixed(1).replace(/\.0$/, '')}万字`;
  }
  return `${words}字`;
}

function CenterStepStartBar({
  centerView,
  connected,
  isRunning,
  checkingModel,
  writerActive,
  currentChapter,
  currentChapterDesign,
  eventsCount,
  chapterProgress,
  chapterTargetTurns,
  completedCount,
  reviewCount,
  currentDraft,
  onPrepareDesign,
  onStart,
  onWriteChapter,
  onChapterAuto,
  onRerunReviews,
  onShowView,
}: {
  centerView: CenterView;
  connected: boolean;
  isRunning: boolean;
  checkingModel: boolean;
  writerActive: boolean;
  currentChapter: any;
  currentChapterDesign: StoryDesign | null;
  eventsCount: number;
  chapterProgress: number;
  chapterTargetTurns: number;
  completedCount: number;
  reviewCount: number;
  currentDraft: ChapterSummary | null;
  onPrepareDesign: () => void;
  onStart: () => void;
  onWriteChapter: () => void;
  onChapterAuto: () => void;
  onRerunReviews: (chapterId: string) => void;
  onShowView: (view: CenterView) => void;
}) {
  const actionDisabled = !connected || checkingModel || isRunning || writerActive;
  const atClosure = chapterProgress >= chapterTargetTurns;
  const chapterLabel = currentChapter ? `第 ${currentChapter.chapterNo} 章` : '当前章';
  const autoFlowLabel = '设计 → 演绎 → 写作 → 评审 → 回流 → 反修/定稿';
  let title = '';
  let desc = '';
  let icon: ReactNode = null;
  let label = '';
  let onClick: () => void = () => {};
  let disabled = actionDisabled;
  let secondary: ReactNode = null;

  if (centerView === 'design') {
    title = '导演设计';
    desc = currentChapterDesign
      ? `已生成本章方案；可重新校准设计，或启动章节自循环：${autoFlowLabel}。`
      : '先让剧情设计师生成本章拍点、事件刺激和设定护栏。';
    icon = <Zap className="mr-1 h-3.5 w-3.5" />;
    label = currentChapterDesign ? '重新设计' : '开始设计';
    onClick = onPrepareDesign;
    secondary = (
      <Button type="button" size="sm" variant="outline" className="h-8 text-xs" onClick={onChapterAuto} disabled={actionDisabled}>
        <Sparkles className="mr-1 h-3.5 w-3.5" /> 章节自循环
      </Button>
    );
  } else if (centerView === 'events') {
    title = '事件日志';
    desc = atClosure
      ? '本章事件已到收束点；继续演绎会污染当前章，下一步应写正文。'
      : currentChapterDesign
        ? `从这里启动角色演绎，事件会追加到日志里（${chapterProgress}/${chapterTargetTurns}）。`
        : '还没有本章导演设计，先生成设计再演绎。';
    icon = atClosure ? <FileText className="mr-1 h-3.5 w-3.5" /> : <Play className="mr-1 h-3.5 w-3.5" />;
    label = atClosure ? '开始写作' : currentChapterDesign ? '演绎一轮' : '开始设计';
    onClick = atClosure ? onWriteChapter : currentChapterDesign ? onStart : onPrepareDesign;
  } else if (centerView === 'writer') {
    title = '小说正文';
    desc = writerActive
      ? 'Writer 正在流式输出，本页会持续更新。'
      : atClosure
        ? `用本章 ${eventsCount} 条事件生成 ${chapterWordLabelOf(currentChapter)} 正文。`
        : `正文要等事件收束后再写；章节自循环会执行：${autoFlowLabel}。当前 ${chapterProgress}/${chapterTargetTurns}。`;
    icon = atClosure ? <FileText className="mr-1 h-3.5 w-3.5" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />;
    label = writerActive ? '写作中' : atClosure ? (completedCount > 0 ? '再写一稿' : '开始写作') : '章节自循环';
    onClick = atClosure ? onWriteChapter : onChapterAuto;
    disabled = writerActive || (!connected || checkingModel || isRunning);
  } else if (centerView === 'reviews') {
    title = '读者评审';
    desc = currentDraft
      ? reviewCount > 0
        ? '当前稿已有评审；可重新评审，或回到设计讨论做回流修正。'
        : '让 Reader 检查当前稿的突兀、因果、节奏、设定和字数。'
      : atClosure
        ? '还没有正文，先从本章事件生成正文。'
        : `还没有正文和足够事件；章节自循环会执行：${autoFlowLabel}。`;
    icon = currentDraft ? <MessageSquare className="mr-1 h-3.5 w-3.5" /> : <FileText className="mr-1 h-3.5 w-3.5" />;
    label = currentDraft ? (reviewCount > 0 ? '重新评审' : '开始评审') : atClosure ? '开始写作' : '章节自循环';
    onClick = currentDraft ? () => onRerunReviews(currentDraft.id) : atClosure ? onWriteChapter : onChapterAuto;
    secondary = currentDraft && reviewCount > 0 ? (
      <Button type="button" size="sm" variant="outline" className="h-8 text-xs" onClick={() => onShowView('design')}>
        <Zap className="mr-1 h-3.5 w-3.5" /> 回流设计
      </Button>
    ) : null;
  } else if (centerView === 'lessons') {
    title = '经验总结';
    desc = `经验来自 Reader 评审；章节自循环会把经验回流到下一版写作：${autoFlowLabel}。`;
    icon = <Sparkles className="mr-1 h-3.5 w-3.5" />;
    label = '章节自循环';
    onClick = onChapterAuto;
  } else {
    return null;
  }

  return (
    <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b bg-background px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{title}</span>
          <Badge variant="outline" className="text-[10px]">{chapterLabel}</Badge>
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{desc}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {secondary}
        <Button type="button" size="sm" className="h-8 text-xs" onClick={onClick} disabled={disabled}>
          {icon}
          {label}
        </Button>
      </div>
    </div>
  );
}

function RunStatusBar({
  connected,
  projectStatus,
  operation,
  latestLog,
  eventCount,
  completedCount,
  draftCount,
  chapterProgress,
  targetTurns,
  writerActive,
  onShowLogs,
  onShowChapters,
}: {
  connected: boolean;
  projectStatus: EngineStatus;
  operation: ActiveOperation;
  latestLog: LogEntry | null;
  eventCount: number;
  completedCount: number;
  draftCount: number;
  chapterProgress: number;
  targetTurns: number;
  writerActive: boolean;
  onShowLogs: () => void;
  onShowChapters: () => void;
}) {
  const isBusy = !!operation || projectStatus === 'running' || writerActive;
  const statusLabel =
    operation?.label ??
    (projectStatus === 'paused'
      ? '已暂停'
      : connected
        ? '空闲'
        : '未连接');
  const detail =
    operation?.detail ??
    latestLog?.message ??
    (connected ? '等待下一步操作' : '演绎引擎未连接');
  const tone =
    !connected ? 'border-red-200 bg-red-50 text-red-900 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-200' :
    latestLog?.level === 'error' ? 'border-red-200 bg-red-50 text-red-900 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-200' :
    isBusy ? 'border-blue-200 bg-blue-50 text-blue-950 dark:border-blue-900/70 dark:bg-blue-950/25 dark:text-blue-100' :
    'border-border bg-muted/30 text-muted-foreground';

  return (
    <div className={`border-b px-3 py-1.5 text-xs ${tone}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className={`text-[10px] bg-background/80 ${isBusy ? 'border-blue-300 text-blue-700 dark:border-blue-800 dark:text-blue-300' : ''}`}
          >
            {isBusy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            {statusLabel}
          </Badge>
          <span className="min-w-0 truncate" title={detail}>
            {detail}
          </span>
        </div>
        <div className="hidden shrink-0 items-center gap-2 text-[11px] lg:flex">
          <span>本章 {chapterProgress}/{targetTurns} 轮</span>
          <span className="text-border">·</span>
          <span>事件 {eventCount}</span>
          <span className="text-border">·</span>
          <button
            type="button"
            className="hover:text-foreground"
            onClick={onShowChapters}
            title="查看已经写入数据库的章节正文"
          >
            正稿 {completedCount} 章 · 历史稿 {draftCount}
          </button>
          <Button type="button" size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={onShowLogs}>
            看日志
          </Button>
        </div>
      </div>
    </div>
  );
}

function WorkspaceNavigator({
  currentView,
  currentChapter,
  currentChapterDesign,
  eventsCount,
  chapterProgress,
  chapterTargetTurns,
  completedCount,
  reviewCount,
  assetCount,
  lessonsCount,
  chapterCount,
  logCount,
  outlinePending,
  onShowView,
}: {
  currentView: CenterView;
  currentChapter: any;
  currentChapterDesign: StoryDesign | null;
  eventsCount: number;
  chapterProgress: number;
  chapterTargetTurns: number;
  completedCount: number;
  reviewCount: number;
  assetCount: number;
  lessonsCount: number;
  chapterCount: number;
  logCount: number;
  outlinePending: boolean;
  onShowView: (view: CenterView) => void;
}) {
  const targetTurns = Math.max(1, Number(chapterTargetTurns || currentChapter?.targetTurns || 8));
  const progressNow = Math.max(0, Number(chapterProgress || 0));
  type NavItem = { view: CenterView; icon: ReactNode; label: string; detail: string; done?: boolean; attention?: boolean };
  const chapterItems: NavItem[] = [
    {
      view: 'design',
      icon: <Zap className="h-3.5 w-3.5" />,
      label: '导演设计',
      detail: currentChapterDesign ? '已生成本章蓝图' : '待生成蓝图',
      done: !!currentChapterDesign,
    },
    {
      view: 'events',
      icon: <Activity className="h-3.5 w-3.5" />,
      label: '事件日志',
      detail: `${eventsCount} 条 · ${progressNow}/${targetTurns} 轮`,
      done: progressNow >= targetTurns && eventsCount > 0,
      attention: progressNow >= targetTurns && completedCount === 0,
    },
    {
      view: 'writer',
      icon: <FileText className="h-3.5 w-3.5" />,
      label: '小说正文',
      detail: completedCount > 0 ? `${completedCount} 稿` : '未生成',
      done: completedCount > 0,
    },
    {
      view: 'reviews',
      icon: <MessageSquare className="h-3.5 w-3.5" />,
      label: '读者评审',
      detail: reviewCount > 0 ? `${reviewCount} 条` : '等正文',
      done: reviewCount > 0,
    },
  ];
  const projectItems: NavItem[] = [
    {
      view: 'outline',
      icon: <PencilLine className="h-3.5 w-3.5" />,
      label: '方向提案',
      detail: outlinePending ? '有待应用提案' : '总纲/章方向',
      attention: outlinePending,
    },
    {
      view: 'assets',
      icon: <Package className="h-3.5 w-3.5" />,
      label: '素材库',
      detail: `${assetCount} 项`,
    },
    {
      view: 'lessons',
      icon: <BookMarked className="h-3.5 w-3.5" />,
      label: '经验总结',
      detail: `${lessonsCount} 条`,
    },
    {
      view: 'chapters',
      icon: <BookOpen className="h-3.5 w-3.5" />,
      label: '章节目录',
      detail: `${chapterCount} 章`,
    },
  ];
  const systemItems: NavItem[] = [
    {
      view: 'logs',
      icon: <Info className="h-3.5 w-3.5" />,
      label: '引擎日志',
      detail: `${logCount} 条`,
    },
  ];
  const renderItem = (item: NavItem) => {
    const active = currentView === item.view;
    return (
      <button
        key={item.view}
        type="button"
        onClick={() => onShowView(item.view)}
        className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors ${
          active
            ? 'border-primary bg-primary/10 text-primary'
            : item.attention
              ? 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100 dark:border-amber-900/60 dark:bg-amber-950/25 dark:text-amber-200'
              : 'border-transparent bg-transparent hover:bg-accent'
        }`}
      >
        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded bg-muted/60">
          {item.icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{item.label}</span>
          <span className="block truncate text-[10px] text-muted-foreground">{item.detail}</span>
        </span>
        {item.done && <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-primary" />}
      </button>
    );
  };
  const renderSection = (title: string, desc: string, items: NavItem[]) => (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 px-0.5">
        <div className="text-[11px] font-medium text-muted-foreground">{title}</div>
        <div className="hidden truncate text-[10px] text-muted-foreground 2xl:block">{desc}</div>
      </div>
      {items.map(renderItem)}
    </div>
  );

  return (
    <section className="rounded-md border bg-card p-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Rows2 className="h-4 w-4 flex-shrink-0 text-primary" />
          <h3 className="truncate text-sm font-semibold">工作区</h3>
        </div>
        {currentChapter && (
          <Badge variant="outline" className="flex-shrink-0 text-[10px]">
            第 {currentChapter.chapterNo} 章
          </Badge>
        )}
      </div>
      {renderSection('章节流水线', '设计、演绎、正文、评审', chapterItems)}
      <div className="my-1.5 h-px bg-border" />
      {renderSection('项目资料', '总纲、素材、沉淀', projectItems)}
      <div className="my-1.5 h-px bg-border" />
      {renderSection('系统工具', '模型、日志、排错', systemItems)}
    </section>
  );
}

function abilityList(items?: string[]): string[] {
  return (items ?? []).map((item) => item.trim()).filter(Boolean);
}

function listToEditorText(items?: string[]): string {
  return abilityList(items).join('\n');
}

function editorTextToList(value: string): string[] {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeOptionalText(value: string): string | undefined {
  const text = value.trim();
  return text || undefined;
}

function shortPath(value?: string | null): string {
  if (!value) return '未写入';
  const home = typeof window === 'undefined' ? '' : '';
  const parts = value.split('/');
  return parts.length > 4 ? `.../${parts.slice(-3).join('/')}` : value || home;
}

function ModelConfigDialog({
  open,
  onOpenChange,
  status,
  connectionState,
  setConnectionState,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: ModelConfigStatus | null;
  connectionState: ModelConnectionState;
  setConnectionState: (state: ModelConnectionState) => void;
  onSaved: () => Promise<void> | void;
}) {
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [endpointMode, setEndpointMode] = useState<'responses' | 'chat_completions' | 'auto'>('responses');
  const [endpointPath, setEndpointPath] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [chatId, setChatId] = useState('');
  const [userId, setUserId] = useState('');
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState('');
  const [savedMessage, setSavedMessage] = useState('');
  const [verifiedConfigKey, setVerifiedConfigKey] = useState('');

  useEffect(() => {
    if (!open) return;
    setBaseUrl(status?.baseUrl ?? '');
    setModel(status?.model ?? '');
    setEndpointMode(status?.endpointMode ?? 'responses');
    setEndpointPath(status?.endpointPath ?? '');
    setApiKey('');
    setChatId(status?.chatId ?? '');
    setUserId(status?.userId ?? '');
    setToken('');
    setTestMessage('');
    setSavedMessage('');
  }, [open, status?.baseUrl, status?.model, status?.endpointMode, status?.endpointPath, status?.chatId, status?.userId]);

  const currentPlainConfigKey = [
    baseUrl.trim().replace(/\/+$/, ''),
    model.trim(),
    endpointMode,
    endpointPath.trim(),
    chatId.trim(),
    userId.trim(),
  ].join('|');
  const savedPlainConfigKey = [
    status?.baseUrl?.trim().replace(/\/+$/, '') ?? '',
    status?.model?.trim() ?? '',
    status?.endpointMode ?? 'responses',
    status?.endpointPath?.trim() ?? '',
    status?.chatId?.trim() ?? '',
    status?.userId?.trim() ?? '',
  ].join('|');
  const hasPlainConfigChanges = currentPlainConfigKey !== savedPlainConfigKey;
  const hasSecretConfigChanges = Boolean(apiKey.trim() || token.trim());
  const hasConfigChanges = hasPlainConfigChanges || hasSecretConfigChanges;
  const modelFailureHints = (() => {
    if (!testMessage || testMessage.includes('正常')) return [];
    const hints: string[] = [];
    if (/DeepSeek|推理内容|reasoning_content|最终正文 content/i.test(testMessage)) {
      hints.push('DeepSeek 推理模型只返回 reasoning_content 时，优先换非推理模型，或在模型侧关闭深度推理。');
    }
    if (/聊天补全|chat|choices|chat\.completion/i.test(testMessage) || endpointMode === 'chat_completions') {
      hints.push('DeepSeek / OpenAI 兼容 Chat 模型建议选择 Chat Completions，端点留空或填 /v1/chat/completions。');
    }
    if (/Responses API|responses|404|路径|HTML|网页/i.test(testMessage) || endpointMode === 'responses') {
      hints.push('如果服务商不支持 Responses API，把接口类型切到 Chat Completions 后再测试。');
    }
    if (/鉴权|401|unauthorized|api key|token/i.test(testMessage)) {
      hints.push('鉴权失败时检查 API Key、Token、代理服务鉴权头是否都填在同一套配置里。');
    }
    return Array.from(new Set(hints)).slice(0, 3);
  })();

  const saveConfig = async (options: { silent?: boolean; preserveConnection?: boolean } = {}): Promise<boolean> => {
    const { silent = false, preserveConnection = false } = options;
    setSaving(true);
    if (!silent) setTestMessage('');
    setSavedMessage('');
    try {
      const res = await fetch('/api/model-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl,
          model,
          endpointMode,
          endpointPath,
          apiKey,
          chatId,
          userId,
          token,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '保存失败');
      await onSaved();
      const nextVerifiedConfigKey = hasSecretConfigChanges ? '' : currentPlainConfigKey;
      if (apiKey.trim()) setApiKey('');
      if (token.trim()) setToken('');
      if (!preserveConnection && hasConfigChanges && verifiedConfigKey !== nextVerifiedConfigKey) {
        setConnectionState('unknown');
      }
      if (!silent) {
        setSavedMessage('配置已保存');
        toast.success('模型配置已保存');
      }
      return true;
    } catch (err: any) {
      toast.error(err.message || '保存失败');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestMessage('');
    setSavedMessage('');
    try {
      const saved = await saveConfig({ silent: true });
      if (!saved) return;
      const res = await fetch('/api/model-config/test', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '测试失败');
      setTestMessage(data.message || '模型连接正常');
      setVerifiedConfigKey(currentPlainConfigKey);
      setConnectionState('ok');
      toast.success('模型连接正常');
    } catch (err: any) {
      const msg = err.message || '测试失败';
      setTestMessage(msg);
      setConnectionState('failed');
      toast.error(msg);
    } finally {
      setTesting(false);
    }
  };

  const saveAndClose = async () => {
    const saved = await saveConfig();
    if (saved) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(calc(100vw-2rem),42rem)] max-w-[calc(100vw-2rem)] overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            模型配置
          </DialogTitle>
          <DialogDescription>
            OpenAI 兼容接口
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 min-w-0">
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs flex items-center justify-between gap-3 min-w-0 overflow-hidden">
            <div className="flex items-center gap-2 min-w-0">
              {status?.configured ? (
                <CheckCircle2 className="h-4 w-4 text-green-600 flex-shrink-0" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0" />
              )}
              <span className={`shrink-0 ${status?.configured ? 'text-green-700 dark:text-green-300' : 'text-amber-700 dark:text-amber-300'}`}>
                {!status?.configured
                  ? '未配置'
                  : connectionState === 'ok'
                    ? '连接正常'
                    : connectionState === 'failed'
                      ? '连接失败'
                      : '已配置，待测试'}
              </span>
            </div>
            <span className="truncate text-muted-foreground" title={status?.source ?? undefined}>
              {shortPath(status?.source)}
            </span>
          </div>

          <div className="grid gap-2 min-w-0">
            <Label htmlFor="model-base-url" className="text-xs">
              <Server className="h-3.5 w-3.5" />
              Base URL
            </Label>
            <Input
              id="model-base-url"
              className="w-full min-w-0"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.openai.com/v1"
              autoComplete="off"
            />
          </div>

          <div className="grid gap-2 min-w-0">
            <Label htmlFor="model-name" className="text-xs">
              <PlugZap className="h-3.5 w-3.5" />
              Model
            </Label>
            <Input
              id="model-name"
              className="w-full min-w-0"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="gpt-4.1 / glm-4.6 / 本地模型名"
              autoComplete="off"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] gap-3 min-w-0">
            <div className="grid gap-2 min-w-0">
              <Label htmlFor="model-endpoint-mode" className="text-xs">
                <Server className="h-3.5 w-3.5" />
                接口类型
              </Label>
              <Select value={endpointMode} onValueChange={(value) => setEndpointMode(value as typeof endpointMode)}>
                <SelectTrigger id="model-endpoint-mode" className="w-full min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="responses">Responses API</SelectItem>
                  <SelectItem value="chat_completions">Chat Completions</SelectItem>
                  <SelectItem value="auto">自动探测</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2 min-w-0">
              <Label htmlFor="model-endpoint-path" className="text-xs">
                端点路径
              </Label>
              <Input
                id="model-endpoint-path"
                className="w-full min-w-0"
                value={endpointPath}
                onChange={(e) => setEndpointPath(e.target.value)}
                placeholder={endpointMode === 'chat_completions' ? '/v1/chat/completions' : '/v1/responses（留空自动）'}
                autoComplete="off"
              />
            </div>
          </div>

          <div className="grid gap-2 min-w-0">
            <Label htmlFor="model-api-key" className="text-xs">
              <KeyRound className="h-3.5 w-3.5" />
              API Key
            </Label>
            <Input
              id="model-api-key"
              className="w-full min-w-0"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={status?.hasApiKey ? '留空沿用已保存密钥' : 'sk-...'}
              autoComplete="new-password"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 min-w-0">
            <div className="grid gap-2 min-w-0">
              <Label htmlFor="model-chat-id" className="text-xs">Chat ID</Label>
              <Input
                id="model-chat-id"
                className="w-full min-w-0"
                value={chatId}
                onChange={(e) => setChatId(e.target.value)}
                placeholder="可选"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2 min-w-0">
              <Label htmlFor="model-user-id" className="text-xs">User ID</Label>
              <Input
                id="model-user-id"
                className="w-full min-w-0"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder="可选"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2 min-w-0">
              <Label htmlFor="model-token" className="text-xs">Token</Label>
              <Input
                id="model-token"
                className="w-full min-w-0"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={status?.hasToken ? '沿用' : '可选'}
                autoComplete="new-password"
              />
            </div>
          </div>

          {testMessage && (
            <div className={`rounded-md border px-3 py-2 text-xs ${
              testMessage.includes('正常')
                ? 'border-green-200 bg-green-50 text-green-700 dark:border-green-900/60 dark:bg-green-950/25 dark:text-green-300'
                : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/25 dark:text-amber-300'
            }`}>
              {testMessage}
              {modelFailureHints.length > 0 && (
                <ul className="mt-2 space-y-1 border-t border-current/15 pt-2">
                  {modelFailureHints.map((hint) => (
                    <li key={hint} className="flex gap-1.5 leading-relaxed">
                      <span className="mt-[7px] h-1 w-1 flex-shrink-0 rounded-full bg-current opacity-70" />
                      <span>{hint}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {savedMessage && !testMessage && (
            <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700 dark:border-green-900/60 dark:bg-green-950/25 dark:text-green-300">
              {savedMessage}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={test} disabled={testing || saving || (!status?.configured && (!baseUrl.trim() || !apiKey.trim()))}>
            {testing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <PlugZap className="h-4 w-4 mr-1" />}
            测试连接
          </Button>
          <Button onClick={saveAndClose} disabled={saving || testing}>
            {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============== 角色面板 ==============
function CharacterPanel({
  projectId,
  characters, worldState, editingId, charEmotionInput, charLocationInput, charGenderInput,
  charBackgroundInput, charStanceInput, charSpeechStyleInput, charPersonalityInput, charGoalsInput, charActorNotesInput,
  charIdentityNotesInput, charCoreBeliefsInput, charBehaviorRulesInput, charSpeechRulesInput, charForbiddenRulesInput,
  setCharEmotionInput, setCharLocationInput, setCharGenderInput,
  setCharBackgroundInput, setCharStanceInput, setCharSpeechStyleInput, setCharPersonalityInput, setCharGoalsInput, setCharActorNotesInput,
  setCharIdentityNotesInput, setCharCoreBeliefsInput, setCharBehaviorRulesInput, setCharSpeechRulesInput, setCharForbiddenRulesInput,
  onEdit, onSave, onCancel,
}: {
  projectId: string;
  characters: Character[];
  worldState: any;
  editingId: string | null;
  charEmotionInput: string;
  charLocationInput: string;
  charGenderInput: string;
  charBackgroundInput: string;
  charStanceInput: string;
  charSpeechStyleInput: string;
  charPersonalityInput: string;
  charGoalsInput: string;
  charActorNotesInput: string;
  charIdentityNotesInput: string;
  charCoreBeliefsInput: string;
  charBehaviorRulesInput: string;
  charSpeechRulesInput: string;
  charForbiddenRulesInput: string;
  setCharEmotionInput: (v: string) => void;
  setCharLocationInput: (v: string) => void;
  setCharGenderInput: (v: string) => void;
  setCharBackgroundInput: (v: string) => void;
  setCharStanceInput: (v: string) => void;
  setCharSpeechStyleInput: (v: string) => void;
  setCharPersonalityInput: (v: string) => void;
  setCharGoalsInput: (v: string) => void;
  setCharActorNotesInput: (v: string) => void;
  setCharIdentityNotesInput: (v: string) => void;
  setCharCoreBeliefsInput: (v: string) => void;
  setCharBehaviorRulesInput: (v: string) => void;
  setCharSpeechRulesInput: (v: string) => void;
  setCharForbiddenRulesInput: (v: string) => void;
  onEdit: (c: Character) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [characterView, setCharacterView] = useState<'chapter' | 'all'>('chapter');
  const [characterSearch, setCharacterSearch] = useState('');
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  const presentIds = new Set<string>(worldState?.presentCharacterIds ?? []);
  const activeNodeIndexes = new Set<number>(worldState?.currentChapter?.activeNodeIndexes ?? []);
  const linkedNames = new Set<string>(
    (worldState?.plotNodes ?? [])
      .filter((node: any) =>
        activeNodeIndexes.size === 0
          ? !node.completed
          : activeNodeIndexes.has(node.index)
      )
      .flatMap((node: any) => node.linkedCharacters ?? [])
  );
  const chapterCharacters = characters.filter((c) =>
    presentIds.has(c.id) || linkedNames.has(c.name)
  );
  const visibleBase =
    characterView === 'chapter'
      ? (chapterCharacters.length > 0 ? chapterCharacters : characters.filter((c) => presentIds.has(c.id)))
      : characters;
  const visibleCharacters = visibleBase.filter((c) =>
    !characterSearch.trim() ||
    c.name.includes(characterSearch.trim()) ||
    c.role.includes(characterSearch.trim()) ||
    c.persona.personality?.some((tag) => tag.includes(characterSearch.trim()))
  );
  const selectedCharacter = selectedCharacterId
    ? characters.find((character) => character.id === selectedCharacterId) ?? null
    : null;
  const selectedIsChapterRelevant = selectedCharacter
    ? chapterCharacters.some((character) => character.id === selectedCharacter.id)
    : false;

  return (
    <div className="p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-primary" />
          <h2 className="font-semibold">人物</h2>
        </div>
        <span className="text-[10px] text-muted-foreground">点击查看完整档案</span>
      </div>
      <div className="grid grid-cols-2 gap-1 mb-2 rounded-md bg-muted p-1">
        <button
          type="button"
          onClick={() => setCharacterView('chapter')}
          className={`h-8 rounded text-xs transition-colors ${
            characterView === 'chapter'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          本章涉及 {chapterCharacters.length || 0}
        </button>
        <button
          type="button"
          onClick={() => setCharacterView('all')}
          className={`h-8 rounded text-xs transition-colors ${
            characterView === 'all'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          全部人物 {characters.length}
        </button>
      </div>
      {characters.length > 8 && (
        <Input
          value={characterSearch}
          onChange={(e) => setCharacterSearch(e.target.value)}
          placeholder="搜索人物"
          className="h-8 text-xs mb-3"
        />
      )}
      <div className="space-y-2">
        {visibleCharacters.map((c) => {
          const personality = abilityList(c.persona.personality);

          return (
          <div key={c.id} className="rounded-md border bg-card transition-colors hover:bg-accent/40">
            <button
              type="button"
              onClick={() => setSelectedCharacterId(c.id)}
              className="w-full p-2.5 text-left"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium flex items-center gap-1.5 flex-wrap">
                    <span className="text-sm">{c.name}</span>
                    <Badge variant={
                      c.role === 'protagonist' ? 'default' :
                      c.role === 'antagonist' ? 'destructive' : 'secondary'
                    } className="h-5 px-1.5 text-[10px]">
                      {c.role === 'protagonist' ? '主角' :
                       c.role === 'antagonist' ? '反派' : 'NPC'}
                    </Badge>
                    {c.persona.gender && (
                      <span className="text-[10px] font-normal text-muted-foreground">
                        {c.persona.gender}
                      </span>
                    )}
                    {presentIds.has(c.id) ? (
                      <Badge variant="outline" className="h-5 border-green-300 bg-green-50 px-1.5 text-[10px] text-green-700 dark:border-green-800 dark:bg-green-950/30 dark:text-green-300">
                        在场
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="h-5 px-1.5 text-[10px] text-muted-foreground">
                        未入场
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1.5 space-y-1 text-[11px] text-muted-foreground">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="shrink-0 text-foreground">{c.currentState.emotion || '状态未知'}</span>
                      <span className="text-border">·</span>
                      <span className="truncate" title={c.currentState.location}>{c.currentState.location || '位置未记录'}</span>
                    </div>
                    <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                      {c.currentState.level && <span>Lv {c.currentState.level}</span>}
                      {(typeof c.currentState.exp === 'number' || typeof c.currentState.nextLevelExp === 'number') && (
                        <span>EXP {c.currentState.exp ?? 0}/{c.currentState.nextLevelExp ?? '-'}</span>
                      )}
                      {typeof c.currentState.hp === 'number' && <span>HP {c.currentState.hp}</span>}
                      {typeof c.currentState.mp === 'number' && <span>MP {c.currentState.mp}</span>}
                    </div>
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 mt-1 text-muted-foreground flex-shrink-0" />
              </div>
              {personality.length > 0 && (
                <div className="flex flex-wrap items-center gap-1 mt-1.5">
                  {personality.slice(0, 2).map((p, i) => (
                    <Badge key={i} variant="outline" className="h-5 max-w-[8rem] truncate px-1.5 text-[10px]">
                      {p}
                    </Badge>
                  ))}
                  {personality.length > 2 && (
                    <span className="text-[10px] text-muted-foreground">+{personality.length - 2}</span>
                  )}
                </div>
              )}
            </button>
          </div>
          );
        })}
        {visibleCharacters.length === 0 && (
          <div className="text-center text-sm text-muted-foreground py-8">
            暂无人物
          </div>
        )}
      </div>
      <CharacterProfileDialog
        projectId={projectId}
        character={selectedCharacter}
        open={!!selectedCharacter}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedCharacterId(null);
            onCancel();
          }
        }}
        currentChapter={worldState?.currentChapter}
        isPresent={!!selectedCharacter && presentIds.has(selectedCharacter.id)}
        isChapterRelevant={selectedIsChapterRelevant}
        editingId={editingId}
        charEmotionInput={charEmotionInput}
        charLocationInput={charLocationInput}
        charGenderInput={charGenderInput}
        charBackgroundInput={charBackgroundInput}
        charStanceInput={charStanceInput}
        charSpeechStyleInput={charSpeechStyleInput}
        charPersonalityInput={charPersonalityInput}
        charGoalsInput={charGoalsInput}
        charActorNotesInput={charActorNotesInput}
        charIdentityNotesInput={charIdentityNotesInput}
        charCoreBeliefsInput={charCoreBeliefsInput}
        charBehaviorRulesInput={charBehaviorRulesInput}
        charSpeechRulesInput={charSpeechRulesInput}
        charForbiddenRulesInput={charForbiddenRulesInput}
        setCharEmotionInput={setCharEmotionInput}
        setCharLocationInput={setCharLocationInput}
        setCharGenderInput={setCharGenderInput}
        setCharBackgroundInput={setCharBackgroundInput}
        setCharStanceInput={setCharStanceInput}
        setCharSpeechStyleInput={setCharSpeechStyleInput}
        setCharPersonalityInput={setCharPersonalityInput}
        setCharGoalsInput={setCharGoalsInput}
        setCharActorNotesInput={setCharActorNotesInput}
        setCharIdentityNotesInput={setCharIdentityNotesInput}
        setCharCoreBeliefsInput={setCharCoreBeliefsInput}
        setCharBehaviorRulesInput={setCharBehaviorRulesInput}
        setCharSpeechRulesInput={setCharSpeechRulesInput}
        setCharForbiddenRulesInput={setCharForbiddenRulesInput}
        onEdit={onEdit}
        onSave={onSave}
        onCancel={onCancel}
      />
    </div>
  );
}

const CHARACTER_FIELD_DEFS: Array<{ title: string; desc: string }> = [
  { title: '基础信息', desc: '姓名、性别、身份定位、职业和外貌。这里只放当前已知事实；除非用户或正文明确修正，否则所有 agent 必须保持一致。' },
  { title: '性格', desc: '角色当前稳定的行为底色，会影响自发行动、说话方式和危机选择；可随重大事件缓慢变化。' },
  { title: '立场', desc: '角色在当前章节已形成的态度。未来阵营和终局立场不能提前写进这里。' },
  { title: '目标', desc: '角色当前可感知、可执行的目标。长线命运、幕后真相、未来阵营目标不能提前驱动演员。' },
  { title: '背景', desc: '角色当前已知来历和身份来源，用来防止凭空改设定；未发生的觉醒、神器、终局身份不放这里。' },
  { title: '成长弧线', desc: '作者侧长线备注，不等于角色已知道或已发生；每章结束后只按正文确认的经历更新。' },
  { title: '内在冲突', desc: '作者侧观察到的心理拉扯，必须来自已发生情节，不做未来剧透。' },
  { title: '秘密', desc: '作者侧伏笔/隐藏信息；只有正文揭露后才会转入当前行动档案。' },
  { title: '能力资产', desc: '等级、天赋、技能、装备、物品、称号、坐骑等，只能由演绎中真实发生的获得/失去来更新。' },
];

function CharacterProfileDialog({
  projectId,
  character,
  open,
  onOpenChange,
  currentChapter,
  isPresent,
  isChapterRelevant,
  editingId,
  charEmotionInput,
  charLocationInput,
  charGenderInput,
  charBackgroundInput,
  charStanceInput,
  charSpeechStyleInput,
  charPersonalityInput,
  charGoalsInput,
  charActorNotesInput,
  charIdentityNotesInput,
  charCoreBeliefsInput,
  charBehaviorRulesInput,
  charSpeechRulesInput,
  charForbiddenRulesInput,
  setCharEmotionInput,
  setCharLocationInput,
  setCharGenderInput,
  setCharBackgroundInput,
  setCharStanceInput,
  setCharSpeechStyleInput,
  setCharPersonalityInput,
  setCharGoalsInput,
  setCharActorNotesInput,
  setCharIdentityNotesInput,
  setCharCoreBeliefsInput,
  setCharBehaviorRulesInput,
  setCharSpeechRulesInput,
  setCharForbiddenRulesInput,
  onEdit,
  onSave,
  onCancel,
}: {
  projectId: string;
  character: Character | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentChapter?: any;
  isPresent: boolean;
  isChapterRelevant: boolean;
  editingId: string | null;
  charEmotionInput: string;
  charLocationInput: string;
  charGenderInput: string;
  charBackgroundInput: string;
  charStanceInput: string;
  charSpeechStyleInput: string;
  charPersonalityInput: string;
  charGoalsInput: string;
  charActorNotesInput: string;
  charIdentityNotesInput: string;
  charCoreBeliefsInput: string;
  charBehaviorRulesInput: string;
  charSpeechRulesInput: string;
  charForbiddenRulesInput: string;
  setCharEmotionInput: (v: string) => void;
  setCharLocationInput: (v: string) => void;
  setCharGenderInput: (v: string) => void;
  setCharBackgroundInput: (v: string) => void;
  setCharStanceInput: (v: string) => void;
  setCharSpeechStyleInput: (v: string) => void;
  setCharPersonalityInput: (v: string) => void;
  setCharGoalsInput: (v: string) => void;
  setCharActorNotesInput: (v: string) => void;
  setCharIdentityNotesInput: (v: string) => void;
  setCharCoreBeliefsInput: (v: string) => void;
  setCharBehaviorRulesInput: (v: string) => void;
  setCharSpeechRulesInput: (v: string) => void;
  setCharForbiddenRulesInput: (v: string) => void;
  onEdit: (c: Character) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [promptPreview, setPromptPreview] = useState<CharacterPromptPreview | null>(null);
  const [promptPreviewLoading, setPromptPreviewLoading] = useState(false);
  const [promptPreviewError, setPromptPreviewError] = useState('');

  useEffect(() => {
    if (!open || !character) return;
    let cancelled = false;
    setPromptPreviewLoading(true);
    setPromptPreviewError('');
    setPromptPreview(null);

    void (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/characters/${character.id}/prompt-preview`, {
          cache: 'no-store',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '人物提示词预览加载失败');
        if (!cancelled) {
          setPromptPreview(data.preview ?? null);
        }
      } catch (err: any) {
        if (!cancelled) {
          setPromptPreviewError(err.message || '人物提示词预览加载失败');
        }
      } finally {
        if (!cancelled) {
          setPromptPreviewLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    open,
    projectId,
    character?.id,
    character?.persona.actorNotes,
    character?.persona.identityNotes,
    character?.persona.coreBeliefs?.join('|'),
    character?.persona.behaviorRules?.join('|'),
    character?.persona.speechRules?.join('|'),
    character?.persona.forbiddenRules?.join('|'),
    character?.persona.background,
    character?.persona.stance,
    character?.persona.speechStyle,
    character?.persona.personality?.join('|'),
    character?.persona.goals?.join('|'),
    character?.currentState.emotion,
    character?.currentState.location,
    currentChapter?.chapterNo,
  ]);

  if (!character) return null;

  const persona = character.persona;
  const state = character.currentState;
  const goals = abilityList(persona.goals);
  const personality = abilityList(persona.personality);
  const motivations = abilityList(persona.motivations);
  const secrets = abilityList(persona.secrets);
  const speechHabits = abilityList(persona.speechHabits);
  const talents = abilityList(persona.talents);
  const skills = abilityList(persona.skills);
  const equipment = abilityList(persona.equipment);
  const mounts = abilityList(persona.mounts);
  const pets = abilityList(persona.pets);
  const inventory = abilityList(persona.inventory);
  const titles = abilityList(persona.titles);
  const buffs = abilityList(state.buffs);
  const relationEntries = Object.entries(state.relationships ?? {}) as Array<[string, { value: number; note: string }]>;
  const isEditing = editingId === character.id;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="border-b px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3 pr-8">
            <div className="min-w-0">
              <DialogTitle className="flex flex-wrap items-center gap-2">
                <span>{character.name}</span>
                <Badge variant={character.role === 'protagonist' ? 'default' : character.role === 'antagonist' ? 'destructive' : 'secondary'}>
                  {character.role === 'protagonist' ? '主角' : character.role === 'antagonist' ? '反派' : 'NPC'}
                </Badge>
                {persona.gender && <Badge variant="outline">{persona.gender}</Badge>}
                {isPresent && <Badge variant="outline" className="border-green-300 text-green-700 dark:border-green-800 dark:text-green-300">当前在场</Badge>}
                {isChapterRelevant && <Badge variant="outline">本章涉及</Badge>}
              </DialogTitle>
              <DialogDescription className="mt-1">
                {currentChapter ? `第 ${currentChapter.chapterNo} 章《${normalizeChapterTitle(currentChapter.title, currentChapter.chapterNo)}》的人物档案视图` : '人物档案视图'}
              </DialogDescription>
            </div>
            <Button
              type="button"
              size="sm"
              variant={isEditing ? 'secondary' : 'outline'}
              className="h-8 text-xs"
              onClick={() => (isEditing ? onCancel() : onEdit(character))}
            >
              {isEditing ? '取消编辑' : '干预档案'}
            </Button>
          </div>
        </DialogHeader>

        <div className="max-h-[calc(92vh-6rem)] overflow-y-auto px-5 py-4">
          <Tabs defaultValue="profile" className="space-y-4">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="profile">档案视图</TabsTrigger>
              <TabsTrigger value="prompt">演员提示词</TabsTrigger>
            </TabsList>

            <TabsContent value="profile" className="space-y-4">
              {isEditing && (
                <div className="rounded-md border bg-muted/20 p-3">
                  <div className="mb-2 text-sm font-medium">手动修正基础状态</div>
                  <div className="grid gap-2 md:grid-cols-3">
                    <Input value={charEmotionInput} onChange={(e) => setCharEmotionInput(e.target.value)} placeholder="情绪" className="h-8 text-sm" />
                    <Input value={charLocationInput} onChange={(e) => setCharLocationInput(e.target.value)} placeholder="位置" className="h-8 text-sm" />
                    <Input value={charGenderInput} onChange={(e) => setCharGenderInput(e.target.value)} placeholder="性别，例如：女" className="h-8 text-sm" />
                  </div>
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" className="h-8 text-xs" onClick={onSave}>保存修正</Button>
                    <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={onCancel}>取消</Button>
                  </div>
                </div>
              )}

              <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
                <div className="space-y-4">
                  <CharacterProfileSection title="基础信息" desc={CHARACTER_FIELD_DEFS[0].desc}>
                    <div className="grid gap-2 text-xs md:grid-cols-2">
                      <CharacterDetailRow label="性别" value={persona.gender || '未记录'} />
                      <CharacterDetailRow label="职业" value={persona.profession || '未记录'} />
                      <CharacterDetailRow label="情绪" value={state.emotion || '未记录'} />
                      <CharacterDetailRow label="位置" value={state.location || '未记录'} />
                      <CharacterDetailRow label="等级" value={state.level ? `Lv ${state.level}` : '未记录'} />
                      <CharacterDetailRow label="经验" value={`${state.exp ?? 0} / ${state.nextLevelExp ?? '未记录'}`} />
                      <CharacterDetailRow label="生命/灵力" value={`${typeof state.hp === 'number' ? state.hp : '-'} / ${typeof state.mp === 'number' ? state.mp : '-'}`} />
                    </div>
                    <CharacterTextBlock title="外貌" content={persona.appearance} />
                    <CharacterTextBlock title="背景" content={persona.background} />
                  </CharacterProfileSection>

                  <CharacterProfileSection title="当前行动档案" desc="这些字段会影响 agent 的自发行动，只能放当前章节已知、角色能据此行动的信息。">
                    <CharacterListBlock title="性格" items={personality} />
                    <CharacterTextBlock title="立场" content={persona.stance} />
                    <CharacterListBlock title="目标" items={goals} />
                    <CharacterTextBlock title="说话方式" content={persona.speechStyle} />
                    <CharacterListBlock title="说话习惯" items={speechHabits} />
                  </CharacterProfileSection>

                  <CharacterProfileSection title="作者备注 / 长线伏笔" desc="这里是作者侧追踪，不直接给演员当作已发生事实；只有正文确认后才会进入当前行动档案。">
                    <CharacterTextBlock title="背景故事" content={persona.backstory} />
                    <CharacterTextBlock title="成长弧线" content={persona.growthArc} />
                    <CharacterTextBlock title="内在冲突" content={persona.innerConflict} italic />
                    <CharacterListBlock title="动机层次" items={motivations} />
                    <CharacterListBlock title="秘密" items={secrets} italic />
                  </CharacterProfileSection>
                </div>

                <div className="space-y-4">
                  <CharacterProfileSection title="能力资产" desc={CHARACTER_FIELD_DEFS[8].desc}>
                    <CharacterTagSection icon={<Sparkles className="h-3.5 w-3.5 text-amber-600" />} title="天赋" items={talents} empty="暂无天赋记录" />
                    <CharacterTagSection icon={<Shield className="h-3.5 w-3.5 text-blue-600" />} title="当前技能" items={skills} empty="暂无技能记录，剧情获得后会更新" />
                    <CharacterTagSection icon={<Package className="h-3.5 w-3.5 text-emerald-600" />} title="当前装备" items={equipment} empty="暂无装备记录，掉落/任务获得后会更新" />
                    <CharacterTagSection title="称号" items={titles} empty="暂无称号记录" />
                    <CharacterTagSection title="坐骑" items={mounts} empty="暂无坐骑记录" />
                    <CharacterTagSection title="宠物/契约兽" items={pets} empty="暂无宠物记录，契约或孵化后会更新" />
                    <CharacterTagSection title="随身物" items={inventory} empty="暂无随身物记录" />
                    <CharacterTagSection title="当前状态" items={buffs} empty="暂无状态记录" />
                  </CharacterProfileSection>

                  <CharacterProfileSection title="人物关系" desc="开局通常是同学、同校、陌生或轻微信任；只有共同经历足够明确后才升级为伙伴、队友、战友。">
                    <RelationshipDetails entries={relationEntries} />
                  </CharacterProfileSection>

                  <CharacterProfileSection title="字段含义" desc="这些定义会作为人物档案维护规则，避免性别、目标、立场这类基础信息再次漂移。">
                    <div className="space-y-2">
                      {CHARACTER_FIELD_DEFS.slice(1).map((item) => (
                        <div key={item.title} className="rounded-md border bg-muted/20 px-3 py-2 text-xs">
                          <div className="font-medium text-foreground">{item.title}</div>
                          <div className="mt-1 leading-relaxed text-muted-foreground">{item.desc}</div>
                        </div>
                      ))}
                    </div>
                  </CharacterProfileSection>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="prompt" className="space-y-4">
              <CharacterProfileSection title="提示词说明" desc="这里展示的是当前真实会喂给演员 Agent 的内容。项目级规则对所有人物共用；角色档案和演员备注只影响当前人物。">
                <div className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs text-muted-foreground leading-relaxed">
                  预览基于当前章节、当前人物档案和最近事件重新生成。保存人物档案后，这里的系统 Prompt 和现场 Prompt 会随之更新。
                </div>
              </CharacterProfileSection>

              {isEditing && (
                <CharacterProfileSection title="直接影响当前人物 Prompt 的字段" desc="这些修改会改变角色系统 Prompt；它们不是全局规则，只影响这个人物。">
                  <div className="grid gap-3">
                    <div className="grid gap-1.5">
                      <Label className="text-xs">角色背景</Label>
                      <Textarea value={charBackgroundInput} onChange={(e) => setCharBackgroundInput(e.target.value)} placeholder="当前已知的角色背景" className="min-h-[96px] text-sm" />
                    </div>
                    <div className="grid gap-1.5">
                      <Label className="text-xs">【身份】补充</Label>
                      <Textarea
                        value={charIdentityNotesInput}
                        onChange={(e) => setCharIdentityNotesInput(e.target.value)}
                        placeholder="例如：你是《王座空悬》的主角。十七岁，高三学生。眼神从来不像学生……"
                        className="min-h-[120px] text-sm"
                      />
                    </div>
                    <div className="grid gap-1.5 md:grid-cols-2">
                      <div className="grid gap-1.5">
                        <Label className="text-xs">立场</Label>
                        <Textarea value={charStanceInput} onChange={(e) => setCharStanceInput(e.target.value)} placeholder="角色当前立场" className="min-h-[96px] text-sm" />
                      </div>
                      <div className="grid gap-1.5">
                        <Label className="text-xs">说话方式</Label>
                        <Textarea value={charSpeechStyleInput} onChange={(e) => setCharSpeechStyleInput(e.target.value)} placeholder="角色说话风格" className="min-h-[96px] text-sm" />
                      </div>
                    </div>
                    <div className="grid gap-1.5 md:grid-cols-2">
                      <div className="grid gap-1.5">
                        <Label className="text-xs">【核心信念】（每行一条）</Label>
                        <Textarea
                          value={charCoreBeliefsInput}
                          onChange={(e) => setCharCoreBeliefsInput(e.target.value)}
                          placeholder="裁定不是压制，是让每个存在找到自己的位置。&#10;这一世选择相信同伴。"
                          className="min-h-[132px] text-sm"
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label className="text-xs">【行为逻辑】（每行一条）</Label>
                        <Textarea
                          value={charBehaviorRulesInput}
                          onChange={(e) => setCharBehaviorRulesInput(e.target.value)}
                          placeholder="遇到危机时，第一反应是拆解问题，而不是宣泄情绪。&#10;看到某人受伤时，手指会先不由自主握紧。"
                          className="min-h-[132px] text-sm"
                        />
                      </div>
                    </div>
                    <div className="grid gap-1.5 md:grid-cols-2">
                      <div className="grid gap-1.5">
                        <Label className="text-xs">【语言特征】（每行一条）</Label>
                        <Textarea
                          value={charSpeechRulesInput}
                          onChange={(e) => setCharSpeechRulesInput(e.target.value)}
                          placeholder="多用句号，少用感叹号。&#10;需要下决定时，说“走了”，不说“我们上”。"
                          className="min-h-[132px] text-sm"
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label className="text-xs">【你不能做】（每行一条）</Label>
                        <Textarea
                          value={charForbiddenRulesInput}
                          onChange={(e) => setCharForbiddenRulesInput(e.target.value)}
                          placeholder="在某卷之前绝不直接承认真实身份。&#10;绝不主动详细讲述某个背叛事件。"
                          className="min-h-[132px] text-sm"
                        />
                      </div>
                    </div>
                    <div className="grid gap-1.5 md:grid-cols-2">
                      <div className="grid gap-1.5">
                        <Label className="text-xs">性格（每行一条）</Label>
                        <Textarea value={charPersonalityInput} onChange={(e) => setCharPersonalityInput(e.target.value)} placeholder="冷静&#10;嘴硬心软" className="min-h-[120px] text-sm" />
                      </div>
                      <div className="grid gap-1.5">
                        <Label className="text-xs">目标（每行一条）</Label>
                        <Textarea value={charGoalsInput} onChange={(e) => setCharGoalsInput(e.target.value)} placeholder="保护同伴&#10;拿到首杀奖励" className="min-h-[120px] text-sm" />
                      </div>
                    </div>
                    <div className="grid gap-1.5">
                      <Label className="text-xs">该角色的演员备注</Label>
                      <Textarea value={charActorNotesInput} onChange={(e) => setCharActorNotesInput(e.target.value)} placeholder="只写这个角色额外需要遵守的演绎偏好，不写世界终局或未来剧透。" className="min-h-[120px] text-sm" />
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" className="h-8 text-xs" onClick={onSave}>保存到人物档案</Button>
                      <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={onCancel}>取消</Button>
                    </div>
                  </div>
                </CharacterProfileSection>
              )}

              <CharacterProfileSection title="项目级演员规则" desc="这一层来自 Agent 配置，所有人物共享。若你想改全员演法，去模型配置里的演员补充。">
                {promptPreviewLoading ? (
                  <PromptPreviewStatus icon={<Loader2 className="h-3.5 w-3.5 animate-spin" />} text="正在生成人物提示词预览…" />
                ) : promptPreviewError ? (
                  <PromptPreviewStatus icon={<AlertTriangle className="h-3.5 w-3.5 text-red-500" />} text={promptPreviewError} tone="error" />
                ) : (
                  <>
                    <CharacterTextBlock title="项目级演员补充" content={promptPreview?.actorCustomBrief} />
                    <PromptPreviewBlock title="共享演员规则" content={promptPreview?.actorPolicy} />
                  </>
                )}
              </CharacterProfileSection>

              <CharacterProfileSection title="角色系统 Prompt" desc="这一层由产品级规则 + 这个人物的档案 + 该角色演员备注共同组成。">
                {!promptPreviewLoading && !promptPreviewError && (
                  <>
                    <CharacterTextBlock title="角色演员备注" content={promptPreview?.characterActorNotes || '未填写'} />
                    <PromptPreviewBlock title="System Prompt" content={promptPreview?.systemPrompt} />
                  </>
                )}
              </CharacterProfileSection>

              <CharacterProfileSection title="当前现场 Prompt" desc="这一层会把当前章边界、最近事件、人物状态、装备/技能等现场信息喂给角色。">
                {!promptPreviewLoading && !promptPreviewError && (
                  <PromptPreviewBlock title="User Prompt" content={promptPreview?.userPrompt} />
                )}
              </CharacterProfileSection>
            </TabsContent>
          </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CharacterProfileSection({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-md border bg-card p-3">
      <div className="mb-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {desc && <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{desc}</div>}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function CharacterStatusDetails({
  character,
  titles,
  buffs,
}: {
  character: Character;
  titles: string[];
  buffs: string[];
}) {
  const state = character.currentState;
  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-1.5 font-medium">
        <Activity className="h-3.5 w-3.5 text-primary" />
        当前状态
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-muted-foreground">
        <CharacterDetailRow label="情绪" value={state.emotion} />
        <CharacterDetailRow label="位置" value={state.location} />
        <CharacterDetailRow label="等级" value={state.level ? `Lv ${state.level}` : '未记录'} />
        <CharacterDetailRow label="经验" value={`${state.exp ?? 0} / ${state.nextLevelExp ?? '未记录'}`} />
        <CharacterDetailRow label="生命" value={typeof state.hp === 'number' ? `${state.hp}` : '未记录'} />
        <CharacterDetailRow label="灵力" value={typeof state.mp === 'number' ? `${state.mp}` : '未记录'} />
        <CharacterDetailRow label="性别" value={character.persona.gender || '未记录'} />
        <CharacterDetailRow label="职业" value={character.persona.profession || '未记录'} />
      </div>
      {titles.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {titles.map((title, index) => (
            <Badge key={index} variant="outline" className="text-[10px] border-amber-300 text-amber-700 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              {title}
            </Badge>
          ))}
        </div>
      )}
      {buffs.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {buffs.map((buff, index) => (
            <Badge key={index} variant="outline" className="text-[10px] border-blue-300 text-blue-700 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300">
              {buff}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function CharacterDetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <span>{label}：</span>
      <span className="text-foreground break-words">{value}</span>
    </div>
  );
}

function CharacterTagSection({
  title,
  items,
  empty,
  icon,
}: {
  title: string;
  items: string[];
  empty: string;
  icon?: ReactNode;
}) {
  return (
    <div className="space-y-1.5 text-xs">
      <div className="flex items-center gap-1.5 font-medium">
        {icon}
        {title}
      </div>
      {items.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {items.map((item, index) => (
            <Badge key={index} variant="outline" className="text-[10px] whitespace-normal break-words">
              {item}
            </Badge>
          ))}
        </div>
      ) : (
        <div className="text-muted-foreground">{empty}</div>
      )}
    </div>
  );
}

function RelationshipDetails({ entries }: { entries: Array<[string, { value: number; note: string }]> }) {
  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-1.5 font-medium">
        <Users className="h-3.5 w-3.5 text-primary" />
        人物关系
      </div>
      <div className="text-[11px] text-muted-foreground leading-relaxed">
        关系值范围 -100 到 100；负数偏敌对，0 附近中立，正数偏信任。
      </div>
      {entries.length > 0 ? (
        <div className="space-y-2">
          {entries.map(([name, relation]) => {
            const valueLabel = relation.value > 0 ? `+${relation.value}` : `${relation.value}`;
            const tone = relationTone(relation.value);
            const barColor =
              relation.value >= 70 ? 'bg-green-500' :
              relation.value >= 35 ? 'bg-emerald-500' :
              relation.value > -20 ? 'bg-slate-400' :
              relation.value > -60 ? 'bg-amber-500' :
              'bg-red-500';
            return (
              <div key={name} className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground truncate">{name}</span>
                  <span className="text-muted-foreground flex-shrink-0">
                    {tone} {valueLabel}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className={`h-full rounded-full ${barColor}`} style={{ width: relationBarWidth(relation.value) }} />
                </div>
                {relation.note && (
                  <div className="text-[11px] text-muted-foreground leading-relaxed">{relation.note}</div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-muted-foreground">暂无关系记录</div>
      )}
    </div>
  );
}

function CharacterArchiveDetails({ character, goals }: { character: Character; goals: string[] }) {
  const persona = character.persona;
  const motivations = abilityList(persona.motivations);
  const secrets = abilityList(persona.secrets);
  const speechHabits = abilityList(persona.speechHabits);

  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-1.5 font-medium">
        <BookOpen className="h-3.5 w-3.5 text-primary" />
        人物档案
      </div>
      <CharacterTextBlock title="背景" content={persona.background} />
      <CharacterTextBlock title="性别" content={persona.gender} />
      <CharacterTextBlock title="立场" content={persona.stance} />
      <CharacterTextBlock title="说话方式" content={persona.speechStyle} />
      <CharacterTextBlock title="外貌" content={persona.appearance} />
      <CharacterListBlock title="目标" items={goals} />
      <CharacterTextBlock title="背景故事" content={persona.backstory} />
      <CharacterTextBlock title="成长弧线" content={persona.growthArc} />
      <CharacterTextBlock title="内在冲突" content={persona.innerConflict} italic />
      <CharacterListBlock title="动机层次" items={motivations} />
      <CharacterListBlock title="秘密" items={secrets} italic />
      <CharacterListBlock title="说话习惯" items={speechHabits} />
    </div>
  );
}

function CharacterTextBlock({ title, content, italic }: { title: string; content?: string; italic?: boolean }) {
  if (!content) return null;
  return (
    <div>
      <div className="font-medium text-foreground mb-0.5">{title}</div>
      <div className={`text-muted-foreground leading-relaxed ${italic ? 'italic' : ''}`}>{content}</div>
    </div>
  );
}

function CharacterListBlock({ title, items, italic }: { title: string; items: string[]; italic?: boolean }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="font-medium text-foreground mb-0.5">{title}</div>
      <ul className="text-muted-foreground space-y-0.5 ml-3 list-disc">
        {items.map((item, index) => (
          <li key={index} className={italic ? 'italic' : undefined}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function PromptPreviewStatus({
  icon,
  text,
  tone = 'muted',
}: {
  icon: ReactNode;
  text: string;
  tone?: 'muted' | 'error';
}) {
  return (
    <div
      className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${
        tone === 'error'
          ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-300'
          : 'bg-muted/20 text-muted-foreground'
      }`}
    >
      {icon}
      <span>{text}</span>
    </div>
  );
}

function PromptPreviewBlock({ title, content }: { title: string; content?: string }) {
  if (!content) return null;
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-foreground">{title}</div>
      <div className="max-h-[320px] overflow-auto rounded-md border bg-background p-3">
        <pre className="whitespace-pre-wrap break-words text-[11px] leading-5 text-muted-foreground">
          {content}
        </pre>
      </div>
    </div>
  );
}

// ============== 事件日志 ==============
function EventLogPanel({
  events,
  scrollRef,
  fullHeight,
  hasCurrentDraft = false,
  currentChapter,
  characters,
  presentCharacterIds = [],
  eventClosureStatus = {},
  onToggleEventClosure,
}: {
  events: NovelEvent[];
  scrollRef: any;
  fullHeight?: boolean;
  hasCurrentDraft?: boolean;
  currentChapter?: any;
  characters: Character[];
  presentCharacterIds?: string[];
  eventClosureStatus?: Record<string, 'open' | 'closed'>;
  onToggleEventClosure?: (eventId: string, closed: boolean) => void;
}) {
  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {!fullHeight && (
        <div className="px-4 py-2 border-b bg-muted/30 flex items-center gap-2 flex-shrink-0">
          <Activity className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">事件日志</h3>
          <span className="text-xs text-muted-foreground">({events.length})</span>
        </div>
      )}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
      >
        <div className="p-3 space-y-2">
          <EventTraceDocument
            events={events}
            currentChapter={currentChapter}
            hasCurrentDraft={hasCurrentDraft}
            characters={characters}
            presentCharacterIds={presentCharacterIds}
            eventClosureStatus={eventClosureStatus}
            onToggleEventClosure={onToggleEventClosure}
          />
          {events.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-8">
              {hasCurrentDraft
                ? '当前章已有正文，但没有找到对应事件日志；这通常是正文来自修正文/历史稿，或原事件已被清理。'
                : '事件日志会显示角色跑戏过程。先在导演设计页生成本章蓝图，再启动演绎。'}
            </div>
          ) : (
            <>
              {events.map((e) => {
                const meta = EVENT_TYPE_LABEL[e.type] ?? EVENT_TYPE_LABEL.action;
                return (
                  <div key={e.id} className="text-sm border-l-2 pl-3 py-1 hover:bg-accent/30">
                    <div className="flex items-center gap-2 mb-0.5">
                      <Badge variant="outline" className={`text-[10px] ${meta.color}`}>
                        {meta.label}
                      </Badge>
                      <span className="text-xs font-medium">{e.agentName}</span>
                      {e.emotion && (
                        <span className="text-[10px] text-muted-foreground italic">[{e.emotion}]</span>
                      )}
                      {e.target && (
                        <span className="text-[10px] text-muted-foreground">→ {e.target}</span>
                      )}
                      <span className="text-[10px] text-muted-foreground ml-auto">第 {e.turn} 轮</span>
                    </div>
                    <div className="text-foreground/90 text-[13px] leading-snug">{e.content}</div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function formatEventCreatedAt(value: Date | string | null | undefined): string {
  if (!value) return '时间未知';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return date.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function EventTraceDocument({
  events,
  currentChapter,
  hasCurrentDraft,
  characters,
  presentCharacterIds,
  eventClosureStatus,
  onToggleEventClosure,
}: {
  events: NovelEvent[];
  currentChapter?: any;
  hasCurrentDraft: boolean;
  characters: Character[];
  presentCharacterIds: string[];
  eventClosureStatus: Record<string, 'open' | 'closed'>;
  onToggleEventClosure?: (eventId: string, closed: boolean) => void;
}) {
  const chapterLabel = currentChapter ? `第 ${currentChapter.chapterNo} 章《${normalizeChapterTitle(currentChapter.title, currentChapter.chapterNo)}》` : '当前筛选范围';
  const trackedCharacters = selectEventTraceCharacters(characters, presentCharacterIds);
  const openEvents = filterEventTraceEvents(events, trackedCharacters, eventClosureStatus);
  return (
    <details className="rounded-md border bg-muted/20 p-2" open>
      <summary className="cursor-pointer list-none text-xs font-medium">
        事件追踪文档
        <span className="ml-2 text-[10px] font-normal text-muted-foreground">
          {chapterLabel} · 活跃追踪 {openEvents.length} 条
        </span>
      </summary>
      <div className="mt-2 space-y-2">
        <div className="rounded border bg-background px-2 py-2 text-[11px] leading-relaxed text-muted-foreground">
          只记录会跨章节影响剧情的活跃项：伏笔线索、持续状态（中毒/诅咒/伤势/标记）、未兑现奖励或承诺、重要关系后果。
          普通动作、临时位置、情绪、面板数值不进入这里；状态结束时，需要在后续事件或设计讨论里写清结束原因。
        </div>
        <div className="space-y-1 text-[11px]">
          <div className="hidden grid-cols-[6rem_6rem_5rem_7rem_5rem_minmax(0,1fr)] gap-2 rounded bg-background px-2 py-1 font-medium text-muted-foreground md:grid">
            <span>类型</span>
            <span>章节</span>
            <span>记录时间</span>
            <span>Turn</span>
            <span>结束状态</span>
            <span>追踪项</span>
          </div>
          {openEvents.slice(-30).map((event) => {
            const meta = EVENT_TYPE_LABEL[event.type] ?? EVENT_TYPE_LABEL.action;
            const reason = traceReasonForEvent(event) ?? '追踪项';
            const related = [event.agentName, event.target].filter(Boolean).join(' → ');
            return (
              <div key={event.id} className="grid gap-1.5 rounded border bg-background px-2 py-1.5 md:grid-cols-[6rem_6rem_5rem_7rem_5rem_minmax(0,1fr)] md:gap-2">
                <span className="text-foreground">{reason}</span>
                <span className="truncate text-muted-foreground md:text-foreground" title={chapterLabel}>{chapterLabel}</span>
                <span className="text-muted-foreground">{formatEventCreatedAt(event.createdAt)}</span>
                <span className="text-muted-foreground">T{event.turn}</span>
                <button
                  type="button"
                  className={`h-6 rounded-md border px-2 text-[10px] transition-colors ${
                    'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-300'
                  }`}
                  onClick={() => onToggleEventClosure?.(event.id, true)}
                  title="点击标记此追踪项已结束；结束后会从活跃追踪移出，结束原因请通过后续事件或设计讨论写明"
                >
                  开启中
                </button>
                <span className="min-w-0 leading-relaxed">
                  <span className="mr-1 text-muted-foreground">
                    {related}
                    <Badge variant="outline" className={`ml-1 text-[9px] ${meta.color}`}>{meta.label}</Badge>
                  </span>
                  {event.content}
                </span>
              </div>
            );
          })}
          {openEvents.length === 0 && (
            <div className="rounded border border-dashed bg-background px-2 py-3 text-center text-muted-foreground">
              当前没有活跃伏笔或持续状态。普通动作不会进入这里；中毒、诅咒、未兑现奖励、秘密暴露等跨章节影响会显示在这里。
            </div>
          )}
        </div>
      </div>
      {hasCurrentDraft && (
        <div className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
          当前章已有正文时，这里只做未闭环追踪；若追踪项未写入正稿，不能自动视为正典事实。
        </div>
      )}
    </details>
  );
}

// ============== 引擎日志 ==============
function EngineLogPanel({ logs, scrollRef, fullHeight }: {
  logs: LogEntry[];
  scrollRef: any;
  fullHeight?: boolean;
}) {
  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {!fullHeight && (
        <div className="px-4 py-2 border-b bg-muted/30 flex items-center gap-2 flex-shrink-0">
          <Info className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">引擎日志</h3>
          <span className="text-xs text-muted-foreground">({logs.length})</span>
        </div>
      )}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
      >
        <div className="p-4 space-y-2">
          {logs.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-8">
              暂无引擎日志。连接状态、模型调用、自动闭环和错误信息会显示在这里。
            </div>
          ) : (
            logs.map((log) => {
              const isError = log.level === 'error';
              const isWarn = log.level === 'warn';
              return (
                <div
                  key={log.id}
                  className={`rounded-md border px-3 py-2 text-sm ${
                    isError
                      ? 'border-red-200 bg-red-50/70 dark:border-red-900/60 dark:bg-red-950/25'
                      : isWarn
                        ? 'border-amber-200 bg-amber-50/70 dark:border-amber-900/60 dark:bg-amber-950/25'
                        : 'bg-card'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {isError ? (
                      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" />
                    ) : isWarn ? (
                      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
                    ) : (
                      <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className={
                        isError ? 'text-destructive' :
                        isWarn ? 'text-amber-700 dark:text-amber-300' :
                        'text-foreground'
                      }>
                        {log.message}
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ============== Writer 输出 ==============
function WriterPanel({
  text,
  streamText,
  scrollRef,
  fullHeight,
  landedChaptersCount = 0,
  latestLandedChapterNo,
  currentChapterNo,
  onOpenChapters,
}: {
  text: string;
  streamText: string;
  scrollRef: any;
  fullHeight?: boolean;
  landedChaptersCount?: number;
  latestLandedChapterNo?: number;
  currentChapterNo?: number;
  onOpenChapters?: () => void;
}) {
  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {!fullHeight && (
        <div className="px-4 py-2 border-b bg-muted/30 flex items-center gap-2 flex-shrink-0">
          <FileText className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">小说文本</h3>
          <span className="text-xs text-muted-foreground">({countReadableChars(text)} 字)</span>
          {streamText && (
            <Badge variant="outline" className="text-[10px] border-amber-500 text-amber-700 animate-pulse dark:border-amber-700 dark:text-amber-300">
              生成中…
            </Badge>
          )}
        </div>
      )}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
      >
        <div className="w-full p-4">
          {text ? (
            <article className="prose prose-sm max-w-none whitespace-pre-wrap leading-relaxed">
              {text}
            </article>
          ) : (
            <div className="mx-auto max-w-md rounded-md border bg-muted/20 p-4 text-center text-sm text-muted-foreground">
              <div>
                {currentChapterNo
                  ? `第 ${currentChapterNo} 章还没有落地正文。这里显示的是当前焦点章的正稿，不是跑戏日志。`
                  : '当前章节正文视图为空。这里显示的是当前焦点章的正稿，不是跑戏日志。'}
              </div>
              {landedChaptersCount > 0 ? (
                <div className="mt-3 space-y-2">
                  <div>
                    章节目录已有 {landedChaptersCount} 章正稿
                    {latestLandedChapterNo ? `，最新到第 ${latestLandedChapterNo} 章` : ''}。
                  </div>
                  {onOpenChapters && (
                    <Button type="button" size="sm" variant="outline" onClick={onOpenChapters}>
                      <BookOpen className="mr-1 h-3.5 w-3.5" />
                      打开章节目录
                    </Button>
                  )}
                </div>
              ) : (
                <div className="mt-2">正文会在事件积累到收束点后生成。</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatChapterCreatedAt(value?: Date | string): string {
  if (!value) return '刚刚';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return date.toLocaleString();
}

function turnRangeLabel(chapter: ChapterSummary): string {
  const start = typeof chapter.startTurn === 'number' ? chapter.startTurn : null;
  const end = typeof chapter.endTurn === 'number' ? chapter.endTurn : null;
  if (start === null && end === null) return 'Turn 未记录';
  if (start === null) return `T?-${end}`;
  if (end === null) return `T${start}-?`;
  return `T${start}-${end}`;
}

function ChapterCatalogPanel({
  chapters,
  readerReviews,
  worldState,
  rewritingChapterId,
  selectingCanonicalId,
  focusingChapterId,
  currentChapterNo,
  onRewriteChapter,
  onSelectCanonicalDraft,
  onFocusChapterForDesign,
  onOpenDesign,
  fullHeight,
}: {
  chapters: ChapterSummary[];
  readerReviews: Record<string, ReaderReview[]>;
  worldState?: WorldState | null;
  rewritingChapterId?: string;
  selectingCanonicalId?: string;
  focusingChapterId?: string;
  currentChapterNo?: number;
  onRewriteChapter?: (chapterId: string) => void;
  onSelectCanonicalDraft?: (chapterId: string) => void;
  onFocusChapterForDesign?: (chapterId: string) => void;
  onOpenDesign?: () => void;
  fullHeight?: boolean;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const chapterGroups = buildChapterDraftGroups(chapters, worldState, readerReviews);
  const effectiveSelectedKey = chapterGroups.some((group) => group.key === selectedKey)
    ? selectedKey
    : chapterGroups[chapterGroups.length - 1]?.key ?? null;
  const selectedChapter =
    chapterGroups.find((group) => group.key === effectiveSelectedKey) ?? null;
  const totalWords = chapterGroups.reduce(
    (sum, chapter) => sum + chapter.currentWordCount,
    0
  );
  const selectedDraft =
    selectedChapter?.drafts.find((draft) => draft.id === selectedDraftId) ??
    selectedChapter?.currentDraft ??
    null;
  const selectedTurnLabel = selectedChapter
    ? turnRangeLabel({
        id: selectedChapter.key,
        sceneName: selectedChapter.title,
        content: selectedChapter.currentDraft.content,
        startTurn: selectedChapter.startTurn ?? undefined,
        endTurn: selectedChapter.endTurn ?? undefined,
      })
    : '';
  const selectedDraftReviews = selectedDraft
    ? readerReviews[selectedDraft.id]?.length ?? selectedDraft.readerReviews?.length ?? 0
    : 0;
  const selectedDraftIsCurrent = !!selectedDraft && selectedDraft.id === selectedChapter?.currentDraft.id;
  const selectedHistoricalCount = Math.max(0, (selectedChapter?.drafts.length ?? 0) - 1);
  const historicalDraftIds = new Map(
    (selectedChapter?.drafts ?? [])
      .filter((draft) => draft.id !== selectedChapter?.currentDraft.id)
      .map((draft, index) => [draft.id, `历史稿 ${index + 1}`])
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {!fullHeight && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b bg-muted/30 px-4 py-2">
          <BookOpen className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">章节目录</h3>
        </div>
      )}
      <div className="grid flex-1 min-h-0 grid-cols-1 gap-px overflow-hidden bg-border lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-y-auto bg-background p-3">
          <div className="mb-3 rounded-md border bg-muted/20 p-3 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">章节正文</span>
              <Badge variant="outline">{chapterGroups.length} 章</Badge>
            </div>
            <div className="mt-1 text-muted-foreground">
              当前稿合计 {totalWords} 字，历史稿 {Math.max(0, chapters.length - chapterGroups.length)} 份。旧稿只做回溯，不拼进章节正文。
            </div>
          </div>
          {chapterGroups.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
              暂无落地正文。生成正文完成后会出现在这里。
            </div>
          ) : (
            <div className="space-y-2">
	              {chapterGroups.map((chapter) => {
	                const active = selectedChapter?.key === chapter.key;
                const isDesignFocus = currentChapterNo === chapter.chapterNo;
	                return (
	                  <button
                    key={chapter.key}
                    type="button"
                    onClick={() => setSelectedKey(chapter.key)}
                    className={`w-full rounded-md border p-2 text-left text-xs transition-colors ${
                      active ? 'border-primary bg-primary/5' : 'bg-background hover:bg-muted/40'
                    }`}
                  >
	                    <div className="flex items-center justify-between gap-2">
	                      <span className="min-w-0 truncate font-medium">
	                        第 {chapter.chapterNo} 章《{chapter.title}》
	                      </span>
                      <span className="flex flex-shrink-0 items-center gap-1">
                        {isDesignFocus && <Badge className="text-[9px]">设计焦点</Badge>}
	                        {chapter.reviewCount > 0 && <Badge variant="outline" className="text-[9px]">{chapter.reviewCount} 评</Badge>}
                      </span>
	                    </div>
                    <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
                      <span>生成 {chapter.generatedAt}</span>
                      <span>当前稿 {chapter.currentWordCount} 字</span>
                      <span>历史稿 {Math.max(0, chapter.drafts.length - 1)} 份</span>
                      <span>
                        {turnRangeLabel({
                          id: chapter.key,
                          sceneName: chapter.title,
                          content: chapter.currentDraft.content,
                          startTurn: chapter.startTurn ?? undefined,
                          endTurn: chapter.endTurn ?? undefined,
                        })}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </aside>
        <section className="flex min-h-0 flex-col overflow-hidden bg-background">
          {selectedChapter ? (
            <>
              <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-muted/20 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-sm font-semibold">
                      第 {selectedChapter.chapterNo} 章《{selectedChapter.title}》
                    </h3>
                    <Badge variant="outline" className="text-[10px]">{selectedTurnLabel}</Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    当前稿 {selectedChapter.currentWordCount} 字 · 历史稿 {selectedHistoricalCount} 份
                    {selectedChapter.reviewCount > 0 ? ` · ${selectedChapter.reviewCount} 条读者评审` : ''} · 生成 {selectedChapter.generatedAt}
                  </div>
                  <div className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                    改这一章的方向、章名、剧情走向：点“{currentChapterNo === selectedChapter.chapterNo ? '去导演设计改方向' : '切到这章改方向'}”。
                    只改现有正文表述、不动章方向：点“重写当前正文”。
                  </div>
                </div>
	                <div className="flex flex-wrap items-center gap-2">
                {onFocusChapterForDesign && (
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 text-xs"
                    variant={currentChapterNo === selectedChapter.chapterNo ? 'secondary' : 'default'}
                    onClick={() =>
                      currentChapterNo === selectedChapter.chapterNo
                        ? onOpenDesign?.()
                        : onFocusChapterForDesign(selectedChapter.currentDraft.id)
                    }
                    disabled={focusingChapterId === selectedChapter.currentDraft.id}
                    title={
                      currentChapterNo === selectedChapter.chapterNo
                        ? '进入导演设计，直接改这一章的方向、章名、目标和剧情走向'
                        : '先把这一章设为当前设计焦点，再进入导演设计调整方向和剧情走向'
                    }
                  >
                    {focusingChapterId === selectedChapter.currentDraft.id ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <PencilLine className="mr-1 h-3.5 w-3.5" />
                    )}
                    {currentChapterNo === selectedChapter.chapterNo ? '去导演设计改方向' : '切到这章改方向'}
                  </Button>
                )}
	                {onSelectCanonicalDraft && selectedDraft && !selectedDraftIsCurrent && (
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => onSelectCanonicalDraft(selectedDraft.id)}
                    disabled={selectingCanonicalId === selectedDraft.id}
                    title="把当前预览的历史稿设为本章正稿；历史稿不会被删除"
                  >
                    {selectingCanonicalId === selectedDraft.id ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                    )}
                    设为正稿
                  </Button>
                )}
                {onRewriteChapter && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    onClick={() => onRewriteChapter(selectedChapter.currentDraft.id)}
                    disabled={rewritingChapterId === selectedChapter.currentDraft.id}
                    title="按当前章节目标重新生成一版正文，并保存为新的当前稿；旧稿保留在历史稿里"
                  >
                    {rewritingChapterId === selectedChapter.currentDraft.id ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RotateCcw className="mr-1 h-3.5 w-3.5" />
                    )}
                    重写当前正文
                  </Button>
                )}
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                <div className="grid h-full min-h-0 grid-cols-1 gap-px bg-border xl:grid-cols-[minmax(0,1fr)_240px]">
                  <div className="min-h-0 overflow-y-auto overflow-x-hidden bg-background">
                    <div className="w-full p-5">
                      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <Badge variant="outline" className="text-[10px]">
                          {selectedDraftIsCurrent ? '当前稿 / 正稿' : '历史稿预览'}
                        </Badge>
                        {selectedDraft && <span>{chapterWordCount(selectedDraft)} 字</span>}
                        {selectedDraft && <span>{turnRangeLabel(selectedDraft)}</span>}
                        {selectedDraftReviews > 0 && <span>{selectedDraftReviews} 条评审</span>}
                      </div>
                      <article className="whitespace-pre-wrap text-sm leading-relaxed">
                        {selectedDraft?.content}
                      </article>
                    </div>
                  </div>
                  <aside className="min-h-0 overflow-y-auto bg-background p-3">
                    <div className="mb-2 text-xs font-semibold">历史稿</div>
                    <div className="space-y-2">
                      {selectedChapter.drafts.map((draft, index) => {
                        const isCurrent = draft.id === selectedChapter.currentDraft.id;
                        const activeDraft = selectedDraft?.id === draft.id;
                        return (
                          <button
                            key={draft.id}
                            type="button"
                            onClick={() => setSelectedDraftId(draft.id)}
                            className={`w-full rounded-md border p-2 text-left text-xs transition-colors ${
                              activeDraft ? 'border-primary bg-primary/5' : 'hover:bg-muted/40'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium">{isCurrent ? '当前稿' : historicalDraftIds.get(draft.id)}</span>
                              {isCurrent && <Badge className="text-[9px]">使用中</Badge>}
                            </div>
                            <div className="mt-1 text-[11px] text-muted-foreground">
                              {chapterWordCount(draft)} 字 · {turnRangeLabel(draft)}
                            </div>
                            <div className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                              {draft.content.slice(0, 80)}
                            </div>
                            {!isCurrent && onSelectCanonicalDraft && (
                              <div className="mt-2">
                                <span
                                  className="inline-flex h-6 items-center rounded-md bg-primary px-2 text-[10px] font-medium text-primary-foreground"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    onSelectCanonicalDraft(draft.id);
                                  }}
                                >
                                  {selectingCanonicalId === draft.id ? '选定中…' : '设为正稿'}
                                </span>
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </aside>
                </div>
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
              还没有可查看的落地正文。
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ============== 导演/设定设计 ==============
function StoryDesignPanel({
  currentChapter,
  storyDesign,
  currentDraft,
  rewritingChapterId,
  discussionTopic,
  setDiscussionTopic,
  discussionMode,
  setDiscussionMode,
  discussionEntries,
  discussionLoading,
  pendingTopic,
  discussionError,
  contextSelection,
  onContextSelectionChange,
  chapterOptions,
  assetCount,
  hasPendingOutlineProposal,
  outlineProposalTitle,
  adoptedEntryId,
  scrollStorageKey,
  scrollToBottomToken,
  connected,
  isRunning,
  checkingModel,
  eventsCount,
  chapterProgress,
  chapterTargetTurns,
  completedCount,
  reviewCount,
  onPrepareDesign,
  onStart,
  onChapterAuto,
  onWriteChapter,
  onResetChapter,
  onShowView,
  onShowOutlineProposal,
	  onDiscussionSubmit,
	  onAdoptDiscussion,
	  onGenerateOutlineFromDiscussion,
	  onApplyOutlineFromDiscussion,
	  onRewriteAdoptedChapter,
  fullHeight,
}: {
  currentChapter: any;
  storyDesign: StoryDesign | null;
  currentDraft: ChapterSummary | null;
  rewritingChapterId: string;
  discussionTopic: string;
  setDiscussionTopic: (value: string) => void;
  discussionMode: RoundtableDiscussionMode;
  setDiscussionMode: (value: RoundtableDiscussionMode) => void;
  discussionEntries: RoundtableEntry[];
  discussionLoading: boolean;
  pendingTopic: string;
  discussionError: string;
  contextSelection: RoundtableContextSelection;
  onContextSelectionChange: (selection: RoundtableContextSelection) => void;
  chapterOptions: number[];
  assetCount: number;
  hasPendingOutlineProposal: boolean;
  outlineProposalTitle: string;
  adoptedEntryId: string;
  scrollStorageKey: string;
  scrollToBottomToken: number;
  connected: boolean;
  isRunning: boolean;
  checkingModel: boolean;
  eventsCount: number;
  chapterProgress: number;
  chapterTargetTurns: number;
  completedCount: number;
  reviewCount: number;
  onPrepareDesign: () => void;
  onStart: () => void;
  onChapterAuto: () => void;
  onWriteChapter: () => void;
  onResetChapter: () => void;
  onShowView: (view: CenterView) => void;
  onShowOutlineProposal: () => void;
	  onDiscussionSubmit: () => void;
	  onAdoptDiscussion: (entry: RoundtableEntry) => void;
	  onGenerateOutlineFromDiscussion: (entry: RoundtableEntry) => void;
	  onApplyOutlineFromDiscussion: (entry: RoundtableEntry) => void;
	  onRewriteAdoptedChapter: (entry: RoundtableEntry) => void;
  fullHeight?: boolean;
}) {
  const currentChapterDesign =
    storyDesign &&
    currentChapter &&
    storyDesign.chapterNo === currentChapter.chapterNo
      ? storyDesign
      : null;
  const adoptedEntry = discussionEntries.find((entry) => entry.id === adoptedEntryId) ?? null;
  const adoptedEntryIsReviewOnly = adoptedEntry?.discussionMode === 'internal_review';
  const hasAppliedProposal = Boolean(adoptedEntry && !adoptedEntryIsReviewOnly);
  const hasConfirmedReview = Boolean(adoptedEntry && adoptedEntryIsReviewOnly);
  const [expandedPane, setExpandedPane] = useState<'summary' | 'chat' | null>(null);
  const summaryExpanded = expandedPane === 'summary';
  const chatExpanded = expandedPane === 'chat';
  const currentChapterLabel = currentChapter
    ? `第 ${currentChapter.chapterNo} 章 · ${normalizeChapterTitle(currentChapter.title, currentChapter.chapterNo)}`
    : '当前章节';
  const designUpdatedAt = currentChapterDesign
    ? new Date(currentChapterDesign.updatedAt).toLocaleTimeString()
    : '';
  const designStats = currentChapterDesign
    ? [
        { label: '事件刺激', value: currentChapterDesign.eventSeeds.length },
        { label: '玩法种子', value: currentChapterDesign.systemConcepts?.length ?? 0 },
        { label: '成长钩子', value: currentChapterDesign.progressionHooks?.length ?? 0 },
        { label: '设定护栏', value: currentChapterDesign.settingGuardrails.length },
      ]
    : [];
  const designLayoutClass = expandedPane
    ? 'grid-rows-[minmax(0,1fr)]'
    : 'grid-rows-[minmax(12rem,0.65fr)_minmax(22rem,1.35fr)] 2xl:grid-cols-[minmax(19rem,0.72fr)_minmax(0,1.28fr)] 2xl:grid-rows-[minmax(0,1fr)]';

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {!fullHeight && (
        <div className="px-4 py-2 border-b bg-muted/30 flex items-center gap-2 flex-shrink-0">
          <Zap className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">导演设计</h3>
        </div>
      )}
      <div className="flex-shrink-0 border-b bg-background px-3 py-2">
        <StoryDesignNextStepBar
          connected={connected}
          isRunning={isRunning}
          checkingModel={checkingModel}
          currentChapter={currentChapter}
          currentChapterDesign={currentChapterDesign}
          hasAppliedProposal={hasAppliedProposal}
          hasConfirmedReview={hasConfirmedReview}
          eventsCount={eventsCount}
          chapterProgress={chapterProgress}
          chapterTargetTurns={chapterTargetTurns}
          completedCount={completedCount}
          reviewCount={reviewCount}
          onPrepareDesign={onPrepareDesign}
          onStart={onStart}
          onChapterAuto={onChapterAuto}
          onWriteChapter={onWriteChapter}
          onResetChapter={onResetChapter}
          onShowView={onShowView}
          onConvertConfirmedReview={adoptedEntryIsReviewOnly && adoptedEntry ? () => onGenerateOutlineFromDiscussion(adoptedEntry) : undefined}
        />
      </div>
      <div className="flex-1 min-h-0 overflow-hidden bg-muted/10">
        <div className={`grid h-full min-h-0 gap-2 p-2 ${designLayoutClass}`}>
          {!chatExpanded && (
            <div className={`min-h-0 overflow-hidden rounded-md border bg-background ${summaryExpanded ? 'overflow-y-auto' : ''}`}>
              <div className="border-b px-3 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <BookOpen className="h-4 w-4 text-primary" />
                    <h3 className="font-semibold">本章蓝图</h3>
                    {currentChapterDesign ? (
                      <Badge className="text-[10px]">已生成</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px]">待生成</Badge>
                    )}
                    {hasAppliedProposal && <Badge variant="outline" className="text-[10px]">结论已采纳</Badge>}
                    {hasConfirmedReview && <Badge variant="outline" className="text-[10px]">评估未落地</Badge>}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setExpandedPane(summaryExpanded ? null : 'summary')}
                    title={summaryExpanded ? '退出本章蓝图全屏' : '本章蓝图在当前栏位全屏'}
                  >
                    {summaryExpanded ? <Minimize2 className="mr-1 h-3.5 w-3.5" /> : <Maximize2 className="mr-1 h-3.5 w-3.5" />}
                    {summaryExpanded ? '还原' : '放大'}
                  </Button>
                </div>
              </div>

              <div className="min-h-0 space-y-3 overflow-y-auto p-3">
                {hasPendingOutlineProposal && (
                  <section className="rounded-md border border-amber-300/70 bg-amber-50/70 px-3 py-2.5 dark:border-amber-900/60 dark:bg-amber-950/20">
                    <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline" className="bg-background/70 text-[10px]">待应用方向提案</Badge>
                          <span className="truncate text-xs font-medium">{outlineProposalTitle || '新的总纲/本章方向修改'}</span>
                        </div>
                        <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                          先确认是否写入项目；应用后会清理旧导演设计，再按新方向生成或修正文。
                        </div>
                      </div>
                      <Button size="sm" className="h-8 shrink-0 text-xs" onClick={onShowOutlineProposal}>
                        <PencilLine className="mr-1 h-3.5 w-3.5" />
                        去应用
                      </Button>
                    </div>
                  </section>
                )}

                <section className="rounded-md border bg-muted/20 px-3 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[11px] font-medium text-muted-foreground">当前章节</div>
                      <div className="truncate text-sm font-semibold">{currentChapterLabel}</div>
                    </div>
                    {currentChapter?.stage && <Badge variant="outline" className="text-[10px]">{currentChapter.stage}</Badge>}
                  </div>
                  <div className="mt-2 max-h-28 overflow-y-auto text-sm leading-relaxed">
                    {currentChapter?.goal ?? '还没有当前章方向。'}
                  </div>
                  {currentChapter?.scope && (
                    <details className="mt-2 rounded-md border bg-background px-2.5 py-1.5">
                      <summary className="cursor-pointer list-none text-[11px] font-medium text-muted-foreground">
                        查看本章边界
                      </summary>
                      <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{currentChapter.scope}</div>
                    </details>
                  )}
                </section>

                {adoptedEntry && (
                  <section className={`rounded-md border px-3 py-2.5 ${
                    adoptedEntryIsReviewOnly ? 'border-amber-300/70 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/20' : 'border-primary/30 bg-primary/5'
                  }`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={adoptedEntryIsReviewOnly ? 'outline' : 'default'} className="text-[10px]">
                        {adoptedEntryIsReviewOnly ? '评估未落地' : '已采纳'}
                      </Badge>
                      <div className="min-w-0 flex-1 truncate text-xs font-medium">
                        {adoptedEntryIsReviewOnly ? '这条讨论只确认判断，没有改项目' : '这条讨论已成为本章优先结论'}
                      </div>
                    </div>
                    <div className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                      {adoptedEntryIsReviewOnly
                        ? '要真正修改，请先预览方向提案，再确认应用。'
                        : '已有正文时，还需要“按结论修正文”才会改到正文稿。'}
                    </div>
                  </section>
                )}

                <section className="rounded-md border bg-background px-3 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-semibold">导演蓝图</div>
                    <div className="text-[10px] text-muted-foreground">
                      {currentChapterDesign ? `更新 ${designUpdatedAt}` : '未生成'}
                    </div>
                  </div>
                  {currentChapterDesign ? (
                    <>
                      <div className="mt-2 rounded-md bg-muted/35 px-3 py-2">
                        <div className="text-xs font-medium">当前拍点</div>
                        <div className="mt-1 text-sm leading-relaxed">{currentChapterDesign.currentBeat}</div>
                      </div>
                      <div className="mt-2 text-xs leading-relaxed text-muted-foreground">
                        <span className="font-medium text-foreground">场景目的：</span>{currentChapterDesign.scenePurpose}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {designStats.map((item) => (
                          <Badge key={item.label} variant="outline" className="bg-muted/20 text-[10px] font-normal">
                            {item.label} {item.value}
                          </Badge>
                        ))}
                      </div>
                      {currentChapterDesign.eventSeeds.length > 0 && (
                        <div className="mt-3">
                          <div className="mb-1 text-xs font-medium">下一批事件刺激</div>
                          <ul className="space-y-1">
                            {currentChapterDesign.eventSeeds.slice(0, 3).map((item, index) => (
                              <li key={index} className="flex gap-1.5 text-xs leading-relaxed text-muted-foreground">
                                <span className="mt-[7px] h-1 w-1 flex-shrink-0 rounded-full bg-primary/70" />
                                <span>{item}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <details className="mt-3 rounded-md border bg-background px-3 py-2">
                        <summary className="cursor-pointer list-none text-xs font-medium">
                          完整蓝图
                        </summary>
                        <div className="mt-3 max-h-[42vh] overflow-y-auto pr-1">
                          <div className="grid gap-3 xl:grid-cols-2">
                            <DesignList title="可用事件刺激" items={currentChapterDesign.eventSeeds} tone="event" />
                            <DesignList title="体系奇观/玩法种子" items={currentChapterDesign.systemConcepts ?? []} tone="note" />
                            <DesignList title="成长/掉落/职业钩子" items={currentChapterDesign.progressionHooks ?? []} tone="audit" />
                            <DesignList title="群众压力" items={currentChapterDesign.crowdPressure} tone="crowd" />
                            <DesignList title="临时配角入口" items={currentChapterDesign.temporaryCast} tone="cast" />
                            <DesignList title="设定护栏" items={currentChapterDesign.settingGuardrails} tone="guard" />
                            <DesignList title="交给 Director" items={currentChapterDesign.directorNotes} tone="note" />
                            <DesignList title="待审核问题" items={currentChapterDesign.auditQuestions} tone="audit" />
                          </div>
                        </div>
                      </details>
                    </>
                  ) : (
                    <div className="mt-2 rounded-md border border-dashed px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                      还没有本章导演设计。先在右侧说清本章想法，或直接生成导演蓝图。
                    </div>
                  )}
                </section>
              </div>
            </div>
          )}

          {!summaryExpanded && (
          <DirectorDesignChat
            topic={discussionTopic}
            setTopic={setDiscussionTopic}
            discussionMode={discussionMode}
            setDiscussionMode={setDiscussionMode}
            entries={discussionEntries}
            loading={discussionLoading}
            pendingTopic={pendingTopic}
            error={discussionError}
            contextSelection={contextSelection}
            onContextSelectionChange={onContextSelectionChange}
            chapterOptions={chapterOptions}
            assetCount={assetCount}
            adoptedEntryId={adoptedEntryId}
            scrollStorageKey={scrollStorageKey}
            scrollToBottomToken={scrollToBottomToken}
            onSubmit={onDiscussionSubmit}
	            onAdopt={onAdoptDiscussion}
	            onGenerateOutlineFromDiscussion={onGenerateOutlineFromDiscussion}
	            onApplyOutlineFromDiscussion={onApplyOutlineFromDiscussion}
	            onRewriteAdoptedChapter={onRewriteAdoptedChapter}
            connected={connected}
            isRunning={isRunning}
            checkingModel={checkingModel}
            currentChapter={currentChapter}
            currentChapterDesign={currentChapterDesign}
            currentDraft={currentDraft}
            rewritingChapterId={rewritingChapterId}
            eventsCount={eventsCount}
            chapterProgress={chapterProgress}
            chapterTargetTurns={chapterTargetTurns}
            completedCount={completedCount}
            reviewCount={reviewCount}
            onPrepareDesign={onPrepareDesign}
            onStart={onStart}
            onChapterAuto={onChapterAuto}
            onWriteChapter={onWriteChapter}
            onShowView={onShowView}
            expanded={chatExpanded}
            onToggleExpanded={() => setExpandedPane(chatExpanded ? null : 'chat')}
          />
          )}
        </div>
      </div>
    </div>
	  );
	}

function StoryDesignNextStepBar({
  connected,
  isRunning,
  checkingModel,
  currentChapter,
  currentChapterDesign,
  hasAppliedProposal,
  hasConfirmedReview,
  eventsCount,
  chapterProgress,
  chapterTargetTurns,
  completedCount,
  reviewCount,
  onPrepareDesign,
  onStart,
  onChapterAuto,
  onWriteChapter,
  onResetChapter,
  onShowView,
  onConvertConfirmedReview,
}: {
  connected: boolean;
  isRunning: boolean;
  checkingModel: boolean;
  currentChapter: any;
  currentChapterDesign: StoryDesign | null;
  hasAppliedProposal: boolean;
  hasConfirmedReview: boolean;
  eventsCount: number;
  chapterProgress: number;
  chapterTargetTurns: number;
  completedCount: number;
  reviewCount: number;
  onPrepareDesign: () => void;
  onStart: () => void;
  onChapterAuto: () => void;
  onWriteChapter: () => void;
  onResetChapter: () => void;
  onShowView: (view: CenterView) => void;
  onConvertConfirmedReview?: () => void;
}) {
  const targetTurns = Math.max(1, Number(chapterTargetTurns || currentChapter?.targetTurns || 8));
  const progressNow = Math.max(0, Number(chapterProgress || 0));
  const hasEnoughEvents = progressNow >= targetTurns;
  const hasUsableDesign = !!currentChapterDesign;
  const actionDisabled = !connected || checkingModel || isRunning;
  const chapterWordLabel = chapterWordLabelOf(currentChapter);
  const manualDirectionApplied = Boolean(currentChapter?.manualOutline);
  const hasExistingMaterial = eventsCount > 0 || completedCount > 0 || reviewCount > 0;

  let title = connected ? '先确认本章设计' : '先连接演绎引擎';
  let desc = connected
    ? '讨论结论或导演设计确认后，可以直接在这里演绎一轮。'
    : '连接后这里会串起设计、演绎、正文和评审。';
  let primary: ReactNode = null;
  let secondary: ReactNode = null;
  let tertiary: ReactNode = null;
  let quaternary: ReactNode = null;

  if (isRunning) {
    title = '正在演绎本章事件';
    desc = '先观察事件日志，确认角色行动是否接住了本章设计。';
    primary = (
      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => onShowView('events')}>
        <Activity className="mr-1 h-3.5 w-3.5" /> 查看事件
      </Button>
    );
  } else if (manualDirectionApplied || hasAppliedProposal) {
    title = hasUsableDesign ? '新方向已应用，选择落地方式' : '新方向已应用，先刷新导演设计';
    desc = hasExistingMaterial
      ? '当前章已有旧事件、正文或评审。想沿着现有进度微调，就继续演绎或修正文；想完全按新设定重跑，先重置本章。'
      : `先按新方向生成本章蓝图，再让角色演绎；正文目标 ${chapterWordLabel}。`;
    primary = hasUsableDesign ? (
      <Button size="sm" className="h-8 text-xs" onClick={onStart} disabled={actionDisabled || hasEnoughEvents}>
        <Play className="mr-1 h-3.5 w-3.5" /> 演绎一轮
      </Button>
    ) : (
      <Button size="sm" className="h-8 text-xs" onClick={onPrepareDesign} disabled={!connected || checkingModel}>
        <Zap className="mr-1 h-3.5 w-3.5" /> 生成设计
      </Button>
    );
    secondary = hasUsableDesign ? (
      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onChapterAuto} disabled={actionDisabled || hasEnoughEvents}>
        <Sparkles className="mr-1 h-3.5 w-3.5" /> 章节自循环
      </Button>
    ) : null;
    tertiary = (
      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => onShowView('outline')} disabled={checkingModel}>
        <PencilLine className="mr-1 h-3.5 w-3.5" /> 继续调整方向
      </Button>
    );
    quaternary = hasExistingMaterial ? (
      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onResetChapter} disabled={isRunning}>
        <RotateCcw className="mr-1 h-3.5 w-3.5" /> 重置本章重跑
      </Button>
    ) : null;
  } else if (hasConfirmedReview && !hasAppliedProposal) {
    title = '评估已确认，尚未落地';
    desc = '内部评估不会改方向或正文。需要采用这个想法时，先转成方向提案并确认应用。';
    primary = (
      <Button size="sm" className="h-8 text-xs" onClick={onConvertConfirmedReview} disabled={!onConvertConfirmedReview || checkingModel}>
        <PencilLine className="mr-1 h-3.5 w-3.5" />
        预览方向提案
      </Button>
    );
    secondary = (
      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => onShowView('design')}>
        <MessagesSquare className="mr-1 h-3.5 w-3.5" /> 继续讨论
      </Button>
    );
  } else if (completedCount > 0 && reviewCount > 0) {
    title = '评审已出来，回流修正';
    desc = '去读者评审页，把问题回流给 Director，再决定是否改设计或进入下一章。';
    primary = (
      <Button size="sm" className="h-8 text-xs" onClick={() => onShowView('reviews')}>
        <MessageSquare className="mr-1 h-3.5 w-3.5" /> 看评审
      </Button>
    );
    secondary = (
      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => onShowView('writer')}>
        <FileText className="mr-1 h-3.5 w-3.5" /> 看正文
      </Button>
    );
  } else if (completedCount > 0) {
    title = '正文已生成，等待评审';
    desc = `先检查正文是否顺，目标 ${chapterWordLabel}；评审出来后再回流修正。`;
    primary = (
      <Button size="sm" className="h-8 text-xs" onClick={() => onShowView('writer')}>
        <FileText className="mr-1 h-3.5 w-3.5" /> 看正文
      </Button>
    );
  } else if (!hasUsableDesign) {
    title = hasAppliedProposal ? '先把采纳结论转成导演设计' : '先生成本章导演设计';
    desc = hasAppliedProposal
      ? '讨论结论只是优先指令，还需要刷新出本章拍点和事件刺激后再演绎。'
      : '没有设计就演绎，角色容易各跑各的。先让导演给本章拍点和事件刺激。';
    primary = (
      <Button size="sm" className="h-8 text-xs" onClick={onPrepareDesign} disabled={!connected || checkingModel}>
        <Zap className="mr-1 h-3.5 w-3.5" />
        生成设计
      </Button>
    );
  } else if (eventsCount === 0) {
    title = '设计就绪，启动事件演绎';
    desc = `从本章设计进入角色跑戏；正文目标 ${chapterWordLabel}。`;
    primary = (
      <Button size="sm" className="h-8 text-xs" onClick={onStart} disabled={actionDisabled}>
        <Play className="mr-1 h-3.5 w-3.5" /> 演绎一轮
      </Button>
    );
    secondary = (
      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onChapterAuto} disabled={actionDisabled}>
        <Sparkles className="mr-1 h-3.5 w-3.5" /> 章节自循环
      </Button>
    );
  } else if (hasEnoughEvents) {
    title = '本章已到收束点，生成正文';
    desc = `本章进度 ${progressNow}/${targetTurns}，继续演绎会污染当前章事件；现在用已有事件写正文。`;
    primary = (
      <Button size="sm" className="h-8 text-xs" onClick={onWriteChapter} disabled={actionDisabled}>
        <FileText className="mr-1 h-3.5 w-3.5" /> 生成正文
      </Button>
    );
    secondary = (
      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => onShowView('events')}>
        <Activity className="mr-1 h-3.5 w-3.5" /> 查看事件
      </Button>
    );
  } else {
    title = '继续围绕本章演绎';
    desc = `本章进度 ${progressNow}/${targetTurns}，已有 ${eventsCount} 条事件；补足事件后再生成正文。`;
    primary = (
      <Button size="sm" className="h-8 text-xs" onClick={onStart} disabled={actionDisabled}>
        <Play className="mr-1 h-3.5 w-3.5" /> 演绎一轮
      </Button>
    );
    secondary = (
      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onChapterAuto} disabled={actionDisabled}>
        <Sparkles className="mr-1 h-3.5 w-3.5" /> 章节自循环
      </Button>
    );
  }

  return (
    <div className="rounded-md border border-foreground/15 bg-background px-3 py-2.5 shadow-sm">
      <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{title}</span>
            {hasAppliedProposal && <Badge className="text-[10px]">讨论已应用</Badge>}
            {hasConfirmedReview && !hasAppliedProposal && <Badge variant="outline" className="text-[10px]">评估未落地</Badge>}
            {!connected && <Badge variant="outline" className="text-[10px]">未连接</Badge>}
          </div>
          <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{desc}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
            <span>进度 {progressNow}/{targetTurns}</span>
            <span className="text-border">·</span>
            <span>事件 {eventsCount}</span>
            <span className="text-border">·</span>
            <span>正文 {completedCount}</span>
            <span className="text-border">·</span>
            <span>评审 {reviewCount}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 xl:justify-end">
          {primary}
          {secondary}
          {tertiary}
          {quaternary}
        </div>
      </div>
    </div>
  );
}

function DirectorDesignChat({
  topic,
  setTopic,
  discussionMode,
  setDiscussionMode,
  entries,
  loading,
  pendingTopic,
  error,
  contextSelection,
  onContextSelectionChange,
  chapterOptions,
  assetCount,
  adoptedEntryId,
  scrollStorageKey,
  scrollToBottomToken,
  onSubmit,
	  onAdopt,
	  onGenerateOutlineFromDiscussion,
	  onApplyOutlineFromDiscussion,
	  onRewriteAdoptedChapter,
  connected,
  isRunning,
  checkingModel,
  currentChapter,
  currentChapterDesign,
  currentDraft,
  rewritingChapterId,
  eventsCount,
  chapterProgress,
  chapterTargetTurns,
  completedCount,
  reviewCount,
  onPrepareDesign,
  onStart,
  onChapterAuto,
  onWriteChapter,
  onShowView,
  expanded = false,
  onToggleExpanded,
}: {
  topic: string;
  setTopic: (value: string) => void;
  discussionMode: RoundtableDiscussionMode;
  setDiscussionMode: (value: RoundtableDiscussionMode) => void;
  entries: RoundtableEntry[];
  loading: boolean;
  pendingTopic: string;
  error: string;
  contextSelection: RoundtableContextSelection;
  onContextSelectionChange: (selection: RoundtableContextSelection) => void;
  chapterOptions: number[];
  assetCount: number;
  adoptedEntryId: string;
  scrollStorageKey: string;
  scrollToBottomToken: number;
  onSubmit: () => void;
	  onAdopt: (entry: RoundtableEntry) => void;
	  onGenerateOutlineFromDiscussion: (entry: RoundtableEntry) => void;
	  onApplyOutlineFromDiscussion: (entry: RoundtableEntry) => void;
	  onRewriteAdoptedChapter: (entry: RoundtableEntry) => void;
  connected: boolean;
  isRunning: boolean;
  checkingModel: boolean;
  currentChapter: any;
  currentChapterDesign: StoryDesign | null;
  currentDraft: ChapterSummary | null;
  rewritingChapterId: string;
  eventsCount: number;
  chapterProgress: number;
  chapterTargetTurns: number;
  completedCount: number;
  reviewCount: number;
  onPrepareDesign: () => void;
  onStart: () => void;
  onChapterAuto: () => void;
  onWriteChapter: () => void;
  onShowView: (view: CenterView) => void;
  expanded?: boolean;
  onToggleExpanded?: () => void;
}) {
  const ordered = entries.slice().sort((a, b) =>
    new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()
  );
  const latestEntry = ordered[0] ?? null;
  const adoptedEntry = adoptedEntryId ? entries.find((entry) => entry.id === adoptedEntryId) ?? null : null;
  const adoptedStatusLabel = adoptedEntry
    ? adoptedEntry.discussionMode === 'internal_review'
      ? '已有确认评估'
      : '已有采纳结论'
    : '';
  const pendingTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const scrollRef = useRef<HTMLDivElement>(null);
  const discussionModeLabel = discussionMode === 'internal_review' ? '评估想法' : '生成方案';
  const inputPlaceholder = discussionMode === 'internal_review'
    ? '发起一个想法，让 Agent 先内部讨论可行性...（如：主角击杀怪物后必须有经验反馈，这会影响哪些章？）'
    : '告诉 Director 你的想法...（如：Lv10 后才彻底游戏化；本章节奏太快了；按这个结论改正文）';

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof window === 'undefined') return;
    const raw = window.localStorage.getItem(scrollStorageKey);
    if (raw === null) {
      requestAnimationFrame(() => {
        el.scrollTop = 0;
      });
      return;
    }
    const top = Number(raw);
    if (!Number.isFinite(top)) return;
    requestAnimationFrame(() => {
      el.scrollTop = Math.max(0, Math.min(top, el.scrollHeight));
    });
  }, [scrollStorageKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || scrollToBottomToken === 0) return;
    requestAnimationFrame(() => {
      el.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }, [scrollToBottomToken, entries.length, loading]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el || typeof window === 'undefined') return;
    window.localStorage.setItem(scrollStorageKey, String(el.scrollTop));
  };

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-md border bg-background">
      <div className="flex-shrink-0 border-b px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <MessagesSquare className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">设计讨论</h3>
            <Badge variant="outline" className="text-[10px]">{discussionModeLabel}</Badge>
            <span className="hidden truncate text-[11px] text-muted-foreground md:inline">
              {adoptedStatusLabel || (entries.length ? '只显示最新一轮' : '先讨论，再落地')}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="hidden text-[11px] text-muted-foreground md:block">
              {loading ? '回复中' : 'Enter 发送'}
            </div>
            {onToggleExpanded && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={onToggleExpanded}
                title={expanded ? '退出设计讨论全屏' : '设计讨论在当前栏位全屏'}
              >
                {expanded ? <Minimize2 className="mr-1 h-3.5 w-3.5" /> : <Maximize2 className="mr-1 h-3.5 w-3.5" />}
                {expanded ? '还原' : '放大'}
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="flex-shrink-0 border-b bg-background p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">讨论方式</span>
          <div className="inline-flex rounded-md border bg-muted/20 p-0.5">
            <button
              type="button"
              className={`inline-flex h-7 items-center gap-1.5 rounded px-2 text-xs transition-colors ${
                discussionMode === 'internal_review'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setDiscussionMode('internal_review')}
              title="先让 Agent 内部讨论可行性、风险和需要补的上下文"
            >
              <MessagesSquare className="h-3.5 w-3.5" />
              先评估
            </button>
            <button
              type="button"
              className={`inline-flex h-7 items-center gap-1.5 rounded px-2 text-xs transition-colors ${
                discussionMode === 'proposal'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setDiscussionMode('proposal')}
              title="直接生成可采纳、可执行的导演方案"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              生成提案
            </button>
          </div>
          <span className="text-[11px] text-muted-foreground">
            {discussionMode === 'internal_review' ? '只判断可行性，不改项目' : '生成可应用结论'}
          </span>
        </div>
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_4rem]">
          <Textarea
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (topic.trim() && !loading) onSubmit();
              }
            }}
            placeholder={inputPlaceholder}
            className="min-h-[72px] max-h-[160px] resize-y text-sm leading-relaxed"
          />
          <Button className="h-10 md:h-full" onClick={onSubmit} disabled={!topic.trim() || loading} title={loading ? '讨论生成中' : '发送设计讨论'}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
        <RoundtableContextPicker
          selection={contextSelection}
          onChange={onContextSelectionChange}
          chapterOptions={chapterOptions}
          currentChapterNo={currentChapter?.chapterNo}
          eventsCount={eventsCount}
          completedCount={completedCount}
          assetCount={assetCount}
        />
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden bg-muted/20 px-4 py-4"
      >
        <div className="w-full space-y-4">
          {loading && pendingTopic && (
            <div className="space-y-3">
              <ChatBubble role="我" time={pendingTime} content={pendingTopic} mine />
              <TypingBubble time={pendingTime} />
            </div>
          )}
          {ordered.length === 0 && !loading ? (
            <div className="rounded-md border border-dashed bg-background p-5 text-center text-sm text-muted-foreground">
              上面输入想法后，Agent 会先讨论可行性和影响范围；采纳后再进入当前章或方向提案。
            </div>
          ) : latestEntry ? (
            <DirectorChatThread
              key={latestEntry.id}
              entry={latestEntry}
              adopted={latestEntry.id === adoptedEntryId}
              onAdopt={onAdopt}
              onGenerateOutlineFromDiscussion={onGenerateOutlineFromDiscussion}
              onApplyOutlineFromDiscussion={onApplyOutlineFromDiscussion}
              onRewriteAdoptedChapter={onRewriteAdoptedChapter}
              onConvertReviewToProposal={() => onGenerateOutlineFromDiscussion(latestEntry)}
              connected={connected}
              isRunning={isRunning}
              checkingModel={checkingModel}
              currentChapter={currentChapter}
              currentChapterDesign={currentChapterDesign}
              currentDraft={currentDraft}
              rewritingChapterId={rewritingChapterId}
              eventsCount={eventsCount}
              chapterProgress={chapterProgress}
              chapterTargetTurns={chapterTargetTurns}
              completedCount={completedCount}
              reviewCount={reviewCount}
              onPrepareDesign={onPrepareDesign}
              onStart={onStart}
              onChapterAuto={onChapterAuto}
              onWriteChapter={onWriteChapter}
              onShowView={onShowView}
            />
          ) : null}
          {error && !loading && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs leading-relaxed text-destructive">
              发送失败：{error}
            </div>
          )}
        </div>
      </div>

    </section>
  );
}

function RoundtableContextPicker({
  selection,
  onChange,
  chapterOptions,
  currentChapterNo,
  eventsCount,
  completedCount,
  assetCount,
}: {
  selection: RoundtableContextSelection;
  onChange: (selection: RoundtableContextSelection) => void;
  chapterOptions: number[];
  currentChapterNo?: number;
  eventsCount: number;
  completedCount: number;
  assetCount: number;
}) {
  const selectedChapterNos = selection.selectedChapterNos.length
    ? selection.selectedChapterNos
    : currentChapterNo
      ? nearbyRoundtableChapterNos(currentChapterNo)
      : [];
  const normalizedSelection = { ...selection, selectedChapterNos };
  const docOptions: Array<{ key: keyof Omit<RoundtableContextSelection, 'selectedChapterNos'>; label: string; detail: string }> = [
    { key: 'includeStoryBible', label: '总纲', detail: '正典、规则、长期设定' },
    { key: 'includeCurrentChapter', label: '本章方向', detail: '章名、目标、边界' },
    { key: 'includeDirectorDesign', label: '导演设计', detail: '当前拍点和护栏' },
    { key: 'includeCurrentDraft', label: '正文稿', detail: `${completedCount} 章` },
    { key: 'includeCurrentEvents', label: '本章事件', detail: `${eventsCount} 条` },
    { key: 'includeCharacters', label: '人物档案', detail: '性别、位置、关系' },
    { key: 'includeAssets', label: '素材库', detail: `${assetCount} 项` },
    { key: 'includeEventTrace', label: '事件追踪', detail: '伏笔/持续状态' },
  ];
  const selectedDocCount = docOptions.filter((item) => normalizedSelection[item.key]).length;

  const update = (patch: Partial<RoundtableContextSelection>) => {
    onChange(normalizeRoundtableContextSelection({ ...normalizedSelection, ...patch }, currentChapterNo));
  };
  const toggleChapter = (chapterNo: number, checked: boolean) => {
    const next = checked
      ? [...selectedChapterNos, chapterNo]
      : selectedChapterNos.filter((item) => item !== chapterNo);
    update({ selectedChapterNos: next });
  };

  return (
    <details className="mt-2 rounded-md border bg-muted/20 px-2.5 py-2">
      <summary className="cursor-pointer list-none text-[11px] font-medium">
        关联上下文
        <span className="ml-2 text-[10px] font-normal text-muted-foreground">
          默认近三章 · 文档 {selectedDocCount}/{docOptions.length} · 第 {selectedChapterNos.join('、') || '未选'} 章
        </span>
      </summary>
      <div className="mt-2 max-h-[220px] space-y-2 overflow-y-auto pr-1">
        <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-4">
          {docOptions.map((item) => (
            <label key={item.key} className="flex gap-2 rounded-md border bg-background px-2 py-1.5 text-xs">
              <input
                type="checkbox"
                className="mt-0.5 h-3.5 w-3.5"
                checked={Boolean(normalizedSelection[item.key])}
                onChange={(event) => update({ [item.key]: event.target.checked } as Partial<RoundtableContextSelection>)}
              />
              <span className="min-w-0">
                <span className="block font-medium">{item.label}</span>
                <span className="block truncate text-[10px] text-muted-foreground">{item.detail}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="rounded-md border bg-background px-2 py-2">
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-medium">关联章节</div>
            <div className="flex flex-wrap gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[10px]"
                onClick={() => onChange(defaultRoundtableContextSelection(currentChapterNo))}
              >
                近三章
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[10px]"
                onClick={() => update({
                  includeStoryBible: false,
                  includeDirectorDesign: false,
                  includeAssets: false,
                  includeCurrentEvents: false,
                  includeCurrentDraft: true,
                  includeCurrentChapter: true,
                  includeCharacters: true,
                  includeEventTrace: true,
                  selectedChapterNos: currentChapterNo ? [currentChapterNo] : [],
                })}
              >
                最小
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {chapterOptions.length ? chapterOptions.map((chapterNo) => (
              <label
                key={chapterNo}
                className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11px] ${
                  selectedChapterNos.includes(chapterNo) ? 'border-primary bg-primary/10 text-primary' : 'bg-muted/20 text-muted-foreground'
                }`}
              >
                <input
                  type="checkbox"
                  className="h-3 w-3"
                  checked={selectedChapterNos.includes(chapterNo)}
                  onChange={(event) => toggleChapter(chapterNo, event.target.checked)}
                />
                第 {chapterNo} 章
              </label>
            )) : (
              <div className="text-[11px] text-muted-foreground">还没有可关联章节；本次只会关联当前章方向和项目文档。</div>
            )}
          </div>
          <div className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
            默认关联当前章和前两章。事件追踪只同步会跨章节影响剧情的活跃项：伏笔、持续状态、未兑现奖励/承诺、关系后果；普通动作、临时位置、情绪、面板数值不进入。
          </div>
        </div>
      </div>
    </details>
  );
}

function DirectorChatThread({
  entry,
  adopted,
	  onAdopt,
	  onGenerateOutlineFromDiscussion,
	  onApplyOutlineFromDiscussion,
	  onRewriteAdoptedChapter,
	  onConvertReviewToProposal,
  connected,
  isRunning,
  checkingModel,
  currentChapter,
  currentChapterDesign,
  currentDraft,
  rewritingChapterId,
  eventsCount,
  chapterProgress,
  chapterTargetTurns,
  completedCount,
  reviewCount,
  onPrepareDesign,
  onStart,
  onChapterAuto,
  onWriteChapter,
  onShowView,
}: {
  entry: RoundtableEntry;
  adopted: boolean;
	  onAdopt: (entry: RoundtableEntry) => void;
	  onGenerateOutlineFromDiscussion: (entry: RoundtableEntry) => void;
	  onApplyOutlineFromDiscussion: (entry: RoundtableEntry) => void;
	  onRewriteAdoptedChapter: (entry: RoundtableEntry) => void;
	  onConvertReviewToProposal: () => void;
  connected: boolean;
  isRunning: boolean;
  checkingModel: boolean;
  currentChapter: any;
  currentChapterDesign: StoryDesign | null;
  currentDraft: ChapterSummary | null;
  rewritingChapterId: string;
  eventsCount: number;
  chapterProgress: number;
  chapterTargetTurns: number;
  completedCount: number;
  reviewCount: number;
  onPrepareDesign: () => void;
  onStart: () => void;
  onChapterAuto: () => void;
  onWriteChapter: () => void;
  onShowView: (view: CenterView) => void;
}) {
  const time = new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const executionPlan = buildDiscussionExecutionPlan(entry, currentDraft);
  const hasOutlineRevision = executionPlan.reviseOutline || executionPlan.persistCanon;
  const isInternalReview = entry.discussionMode === 'internal_review';
  const hasDiscussionDetails = Boolean(
    entry.continuityAudit?.length ||
    entry.mustFix?.length ||
    entry.risks?.length ||
    entry.directorOpinion ||
    entry.auditorOpinion ||
    entry.designerOpinion
  );
  const detailCount =
    (entry.continuityAudit?.length ?? 0) +
    (entry.mustFix?.length ?? 0) +
    (entry.risks?.length ?? 0);
  return (
    <div className="space-y-3">
      <ChatBubble role="我" time={time} content={entry.topic} mine />
      <div className={`w-full rounded-md border bg-background p-4 text-sm ${adopted ? 'border-primary/40 bg-primary/5' : ''}`}>
        <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            {isInternalReview ? (entry.reviewConfirmed ? '评估已确认' : '可行性评估') : adopted ? '已确认方案' : '可应用方案'}
            {isInternalReview && <Badge variant="outline" className="text-[10px]">内部讨论</Badge>}
          </span>
          <span>{time}</span>
        </div>
        <div className="mb-2 text-xs font-medium">综合结论</div>
        <div className="whitespace-pre-wrap leading-7">{entry.synthesis}</div>
        {hasDiscussionDetails && (
          <details className="mt-3 rounded-md border bg-muted/20 px-3 py-2">
            <summary className="cursor-pointer list-none text-xs font-medium text-muted-foreground">
              查看推理依据
              <span className="ml-2 text-[10px] font-normal">
                三方意见{detailCount ? ` · ${detailCount} 条审计/风险` : ''}
              </span>
            </summary>
            <div className="mt-3 space-y-3">
              <div className="grid gap-2 xl:grid-cols-3">
                <OpinionNote
                  title="剧情设计师"
                  content={entry.designerOpinion || '这条旧讨论生成时尚未包含剧情设计师意见；新的设计讨论会自动加入剧情设计师。'}
                />
                <OpinionNote title="Director" content={entry.directorOpinion} />
                <OpinionNote title="设定审核" content={entry.auditorOpinion} />
              </div>
              <DiscussionDetailList title="连续性审计" items={entry.continuityAudit} tone="audit" />
              <DiscussionDetailList title="必须先修" items={entry.mustFix} tone="fix" />
              <DiscussionDetailList title="风险提醒" items={entry.risks} tone="risk" />
            </div>
          </details>
        )}
	        {adopted ? (
	          <AppliedDiscussionFlow
            reviewOnly={isInternalReview}
            connected={connected}
            isRunning={isRunning}
            checkingModel={checkingModel}
            currentChapter={currentChapter}
            currentChapterDesign={currentChapterDesign}
            currentDraft={currentDraft}
            rewritingChapterId={rewritingChapterId}
            eventsCount={eventsCount}
            chapterProgress={chapterProgress}
            chapterTargetTurns={chapterTargetTurns}
            completedCount={completedCount}
            reviewCount={reviewCount}
            onPrepareDesign={onPrepareDesign}
            onStart={onStart}
            onChapterAuto={onChapterAuto}
            onWriteChapter={onWriteChapter}
            onShowView={onShowView}
	            onRewriteAdoptedChapter={() => onRewriteAdoptedChapter(entry)}
	            onConvertReviewToProposal={onConvertReviewToProposal}
              onApplyReviewToDirection={() => onApplyOutlineFromDiscussion(entry)}
	          />
	        ) : (
          <DiscussionExecutionPlanCard
            plan={executionPlan}
            reviewOnly={isInternalReview}
            onExecute={() => isInternalReview ? onApplyOutlineFromDiscussion(entry) : hasOutlineRevision ? onApplyOutlineFromDiscussion(entry) : onAdopt(entry)}
            onProposal={() => onGenerateOutlineFromDiscussion(entry)}
            onConfirmReview={isInternalReview ? () => onAdopt(entry) : undefined}
          />
	        )}
      </div>
    </div>
  );
}

function OpinionNote({ title, content }: { title: string; content: string }) {
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <div className="text-xs font-medium">{title}</div>
      <div className="mt-1 max-h-36 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
        {content}
      </div>
    </div>
  );
}

function DiscussionDetailList({
  title,
  items,
  tone,
}: {
  title: string;
  items?: string[];
  tone: 'audit' | 'fix' | 'risk';
}) {
  if (!items?.length) return null;
  const toneClass =
    tone === 'fix'
      ? 'border-red-200 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/25 dark:text-red-200'
      : tone === 'risk'
        ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/25 dark:text-amber-200'
        : 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/25 dark:text-sky-200';
  return (
    <div className={`rounded-md border px-3 py-2 ${toneClass}`}>
      <div className="text-xs font-medium">{title}</div>
      <ul className="mt-1 space-y-1">
        {items.map((item, index) => (
          <li key={index} className="flex gap-1.5 text-xs leading-relaxed">
            <span className="mt-[7px] h-1 w-1 flex-shrink-0 rounded-full bg-current opacity-70" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DiscussionExecutionPlanCard({
  plan,
  reviewOnly = false,
  onExecute,
  onProposal,
  onConfirmReview,
}: {
  plan: DiscussionExecutionPlan;
  reviewOnly?: boolean;
  onExecute: () => void;
  onProposal: () => void;
  onConfirmReview?: () => void;
}) {
  const needsOutlineProposal = reviewOnly || plan.reviseOutline || plan.persistCanon;
  const visibleSteps = reviewOnly
    ? [
        { label: '直接修改', detail: '基于这条评估，立刻生成并应用本章方向修改。' },
        { label: '刷新设计', detail: '写入后会立刻刷新导演设计，后续演绎读取新方向。' },
        { label: '修正文', detail: '如果当前章已有正文，再按新方向决定是否重写当前稿。' },
      ]
    : plan.steps;
  const primaryLabel = reviewOnly ? '直接修改本章' : needsOutlineProposal ? '预览方向提案' : '采纳到设计';
  const primaryTitle = reviewOnly
    ? '直接生成并应用本章方向修改，不再跳去别处二次确认'
    : needsOutlineProposal
    ? reviewOnly
      ? '先生成一份修改方案；这一步还不会直接写入项目'
      : '先生成一份可预览的方向提案，不立即写入项目'
    : '把结论作为最高优先级送入导演设计，不直接修改正文';
  const statusTitle = reviewOnly
    ? '当前只是评估，但你可以直接改'
    : needsOutlineProposal
      ? '需要先生成方向提案'
      : '可以直接采纳到导演设计';
  const statusDesc = reviewOnly
    ? '如果你已经决定要改，直接点“直接修改本章”就会生成并应用到当前章方向；不需要再跳去别的地方。'
    : needsOutlineProposal
      ? '这条结论涉及总纲、章名、方向或正典，必须先预览补丁，再确认写入。'
      : '这条结论只校准当前导演设计，不会直接改正文；正文需要后续单独生成或修正。';
  const handlePrimary = () => {
    if (!reviewOnly && needsOutlineProposal) {
      onProposal();
      return;
    }
    onExecute();
  };
  return (
    <div className="mt-4 rounded-md border bg-muted/25 px-3 py-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="text-xs font-medium">{statusTitle}</div>
          <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{statusDesc}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {plan.affects.map((item) => (
              <Badge key={item} variant="outline" className="bg-background text-[10px]">
                {item}
              </Badge>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 lg:justify-end">
          <Button size="sm" className="h-8 text-xs" onClick={handlePrimary} title={primaryTitle}>
            {needsOutlineProposal ? <PencilLine className="mr-1 h-3.5 w-3.5" /> : <CheckCircle2 className="mr-1 h-3.5 w-3.5" />}
            {primaryLabel}
          </Button>
          {reviewOnly && (
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onProposal} title="先看修改方案，再决定要不要应用">
              <PencilLine className="mr-1 h-3.5 w-3.5" />
              先看修改方案
            </Button>
          )}
          {reviewOnly && onConfirmReview && (
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onConfirmReview} title="只确认这条评估，不修改项目内容">
              <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
              只确认不修改
            </Button>
          )}
        </div>
      </div>
      <div className="mt-3 rounded-md bg-background/70 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
        {reviewOnly
          ? '“直接修改本章”会基于这条评估立刻写入当前章方向并刷新导演设计；“先看修改方案”只预览，不落库；“只确认不修改”只做标记。'
          : plan.rewriteCurrentDraft
            ? '这次应用会继续生成新的当前正文稿。旧稿不会被删除，但不再作为当前正稿。'
            : plan.reviseOutline || plan.persistCanon
              ? '这次会先改方向/正典并刷新导演设计；当前正文不会自动变，已有正文需要再修正文。'
              : '这次只会刷新导演设计，不会自动改当前正文。需要改正文时，执行后再点“按结论修正文”。'}
      </div>
      <details className="mt-2 rounded-md border bg-background/70 px-2.5 py-2">
        <summary className="cursor-pointer list-none text-[11px] font-medium text-muted-foreground">
          {reviewOnly ? '查看落地路径' : '查看执行细节'}
        </summary>
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          {visibleSteps.map((step, index) => (
            <div key={`${step.label}-${index}`} className="rounded-md border bg-background px-2.5 py-2">
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[10px] font-medium text-primary">
                  {index + 1}
                </span>
                <span className="text-xs font-medium">{step.label}</span>
              </div>
              <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{step.detail}</div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function AppliedDiscussionFlow({
  reviewOnly = false,
  connected,
  isRunning,
  checkingModel,
  currentChapter,
  currentChapterDesign,
  currentDraft,
  rewritingChapterId,
  eventsCount,
  chapterProgress,
  chapterTargetTurns,
  completedCount,
  reviewCount,
  onPrepareDesign,
  onStart,
  onChapterAuto,
  onWriteChapter,
  onShowView,
  onRewriteAdoptedChapter,
  onConvertReviewToProposal,
  onApplyReviewToDirection,
}: {
  reviewOnly?: boolean;
  connected: boolean;
  isRunning: boolean;
  checkingModel: boolean;
  currentChapter: any;
  currentChapterDesign: StoryDesign | null;
  currentDraft: ChapterSummary | null;
  rewritingChapterId: string;
  eventsCount: number;
  chapterProgress: number;
  chapterTargetTurns: number;
  completedCount: number;
  reviewCount: number;
  onPrepareDesign: () => void;
  onStart: () => void;
  onChapterAuto: () => void;
  onWriteChapter: () => void;
  onShowView: (view: CenterView) => void;
  onRewriteAdoptedChapter: () => void;
  onConvertReviewToProposal: () => void;
  onApplyReviewToDirection?: () => void;
}) {
  const targetTurns = Math.max(1, Number(chapterTargetTurns || currentChapter?.targetTurns || 8));
  const progressNow = Math.max(0, Number(chapterProgress || 0));
  const hasEnoughEvents = progressNow >= targetTurns;
  const actionDisabled = !connected || checkingModel || isRunning;
  const steps = reviewOnly
    ? [
        { key: 'confirmed', label: '已确认', done: true },
        { key: 'proposal', label: '方向提案', done: false },
        { key: 'apply', label: '应用', done: false },
        { key: 'rewrite', label: '修正文', done: false },
      ]
    : [
        { key: 'applied', label: '已应用', done: true },
        { key: 'design', label: '设计校准', done: !!currentChapterDesign },
        { key: 'events', label: '演绎事件', done: eventsCount > 0 },
        { key: 'writer', label: '正文', done: completedCount > 0 },
        { key: 'review', label: '评审回流', done: reviewCount > 0 },
      ];

  let title = reviewOnly ? '评估已确认' : '讨论结论已采纳到设计';
  let desc = reviewOnly
    ? '这条内部讨论已经确认，但还没开始修改。下一步请点“开始改方向”，生成修改方案后再应用。'
    : '已作为最高优先级指令刷新导演设计；如果当前章已有正文，还需要单独修正文。';
  let primary: ReactNode = (
    <Button size="sm" className="h-8 text-xs" onClick={onPrepareDesign} disabled={!connected || checkingModel}>
      <Zap className="mr-1 h-3.5 w-3.5" />
      重新生成设计
    </Button>
  );
  let secondary: ReactNode = null;
  let tertiary: ReactNode = null;

  if (reviewOnly) {
    primary = (
      <Button size="sm" className="h-8 text-xs" onClick={onApplyReviewToDirection} disabled={checkingModel || !onApplyReviewToDirection}>
        <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
        直接修改本章
      </Button>
    );
    secondary = (
      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onConvertReviewToProposal} disabled={checkingModel}>
        <PencilLine className="mr-1 h-3.5 w-3.5" />
        先看修改方案
      </Button>
    );
  } else if (!connected) {
    title = '讨论结论已采纳，等待连接';
    desc = '演绎引擎未连接，设计和演绎按钮暂不可用。';
    primary = null;
  } else if (isRunning) {
    title = '正在按采纳方案演绎';
    desc = '先看事件日志，确认角色行动是否接住了讨论结论。';
    primary = (
      <Button size="sm" className="h-8 text-xs" onClick={() => onShowView('events')}>
        <Activity className="mr-1 h-3.5 w-3.5" /> 看事件
      </Button>
    );
  } else if (currentDraft && reviewCount > 0) {
    title = '结论已采纳，正文待修';
    desc = '当前章已有正文和评审，采纳的新点不会自动改旧稿；先按采纳结论生成一版新当前稿，再重评。';
    primary = (
      <Button
        size="sm"
        className="h-8 text-xs"
        onClick={onRewriteAdoptedChapter}
        disabled={checkingModel || rewritingChapterId === currentDraft.id}
      >
        {rewritingChapterId === currentDraft.id ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="mr-1 h-3.5 w-3.5" />}
        按结论修正文
      </Button>
    );
    secondary = (
      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => onShowView('writer')}>
        <FileText className="mr-1 h-3.5 w-3.5" /> 看正文
      </Button>
    );
  } else if (currentDraft) {
    title = '结论已采纳，正文待修';
    desc = '当前章已有正文，采纳的新点需要生成一版新当前稿才会落到正文里。';
    primary = (
      <Button
        size="sm"
        className="h-8 text-xs"
        onClick={onRewriteAdoptedChapter}
        disabled={checkingModel || rewritingChapterId === currentDraft.id}
      >
        {rewritingChapterId === currentDraft.id ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="mr-1 h-3.5 w-3.5" />}
        按结论修正文
      </Button>
    );
    secondary = (
      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => onShowView('writer')}>
        <FileText className="mr-1 h-3.5 w-3.5" /> 看旧稿
      </Button>
    );
  } else if (hasEnoughEvents) {
    title = '事件已够，生成正文';
    desc = `本章进度 ${progressNow}/${targetTurns}，继续演绎容易污染当前章。`;
    primary = (
      <Button size="sm" className="h-8 text-xs" onClick={onWriteChapter} disabled={actionDisabled}>
        <FileText className="mr-1 h-3.5 w-3.5" /> 生成正文
      </Button>
    );
    secondary = (
      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => onShowView('events')}>
        <Activity className="mr-1 h-3.5 w-3.5" /> 看事件
      </Button>
    );
  } else if (currentChapterDesign && eventsCount === 0) {
    title = '设计已校准，演绎一轮';
    desc = '现在让角色按新设计跑戏，事件日志会成为正文素材。';
    primary = (
      <Button size="sm" className="h-8 text-xs" onClick={onStart} disabled={actionDisabled}>
        <Play className="mr-1 h-3.5 w-3.5" /> 演绎一轮
      </Button>
    );
    secondary = (
      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onChapterAuto} disabled={actionDisabled}>
        <Sparkles className="mr-1 h-3.5 w-3.5" /> 章节自循环
      </Button>
    );
  } else if (currentChapterDesign) {
    title = '继续围绕方案演绎';
    desc = `本章进度 ${progressNow}/${targetTurns}，补足事件后再生成正文。`;
    primary = (
      <Button size="sm" className="h-8 text-xs" onClick={onStart} disabled={actionDisabled}>
        <Play className="mr-1 h-3.5 w-3.5" /> 演绎一轮
      </Button>
    );
    secondary = (
      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onChapterAuto} disabled={actionDisabled}>
        <Sparkles className="mr-1 h-3.5 w-3.5" /> 章节自循环
      </Button>
    );
  }

  if (reviewOnly) {
    title = '评估已确认，但可以直接修改';
    desc = '如果你已经决定采用这条判断，点“直接修改本章”就会立刻写入当前章方向并刷新导演设计；不需要再跳到别处应用。';
    tertiary = (
      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => onShowView('design')}>
        <MessagesSquare className="mr-1 h-3.5 w-3.5" />
        继续讨论
      </Button>
    );
  }

  return (
    <div className="mt-3 rounded-md border bg-background/80 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {steps.map((step, index) => (
          <div key={step.key} className="flex items-center gap-1.5">
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] ${
                step.done ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              }`}
            >
              {step.label}
            </span>
            {index < steps.length - 1 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="text-xs font-medium">{title}</div>
          <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{desc}</div>
        </div>
        <div className="flex flex-wrap gap-2 lg:justify-end">
          {primary}
          {secondary}
          {tertiary}
        </div>
      </div>
    </div>
  );
}

function TypingBubble({ time }: { time: string }) {
  return (
    <div className="flex justify-start">
      <div className="w-full rounded-md border bg-background px-4 py-3 text-sm shadow-sm">
        <div className="mb-1 flex items-center justify-between gap-4 text-xs text-muted-foreground">
          <span>剧情设计师 / Director / 设定审核</span>
          <span>{time}</span>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>回复中，正在合并三方意见…</span>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({
  role,
  time,
  content,
  mine,
}: {
  role: string;
  time: string;
  content: string;
  mine?: boolean;
}) {
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`${mine ? 'max-w-[86%]' : 'w-full'} rounded-md px-4 py-3 text-sm shadow-sm ${
          mine
            ? 'bg-neutral-950 text-white'
            : 'border bg-background text-foreground'
        }`}
      >
        <div className={`mb-1 flex items-center justify-between gap-4 text-xs ${mine ? 'text-white/60' : 'text-muted-foreground'}`}>
          <span>{role}</span>
          <span>{time}</span>
        </div>
        <div className="whitespace-pre-wrap leading-7">{content}</div>
      </div>
    </div>
  );
}

function OutlineRevisionPanel({
  worldState,
  mode,
  setMode,
  request,
  setRequest,
  proposal,
  loading,
  applying,
  error,
  onGenerate,
  onApply,
  onClearProposal,
  onShowDesign,
  onSyncStoryBible,
  syncingStoryBible,
  fullHeight,
}: {
  worldState: WorldState | null;
  mode: OutlineRevisionMode;
  setMode: (mode: OutlineRevisionMode) => void;
  request: string;
  setRequest: (value: string) => void;
  proposal: OutlineRevisionProposal | null;
  loading: boolean;
  applying: boolean;
  error: string;
  onGenerate: () => void;
  onApply: (proposal: OutlineRevisionProposal) => void;
  onClearProposal: () => void;
  onShowDesign: () => void;
  onSyncStoryBible: () => void;
  syncingStoryBible: boolean;
  fullHeight?: boolean;
}) {
  const chapter = worldState?.currentChapter;
  const plan = worldState?.longFormPlan;
  const plotNodes = worldState?.plotNodes ?? [];
  const storyBibleNotes = worldState?.storyBibleNotes?.trim() ?? '';
  const nodePlanMayNeedSync = storyBibleNotes.length > 0 && plotNodes.length > 0 && !plan?.volumes?.length;
  const modeOptions: { key: OutlineRevisionMode; label: string; desc: string }[] = [
    { key: 'both', label: '总纲 + 章方向', desc: '先改大方向，再落到当前章' },
    { key: 'global', label: '只改总纲', desc: '体量、卷规划、长期设定' },
    { key: 'chapter', label: '只改本章方向', desc: '标题、目标、范围、护栏' },
  ];
  const excitementPresets: Array<{ label: string; mode: OutlineRevisionMode; request: string }> = [
    {
      label: '提升精彩度',
      mode: 'both',
      request:
        '我觉得目前大纲不够精彩，请先识别本项目题材和读者期待，再重新诊断总纲和当前章方向。重点增强：开篇钩子、危机升级、主角压迫感、爽点兑现节奏、反转、悬念、角色矛盾、长期目标牵引。不要只是加大场面，不要提前摊开后期体系；要让第一卷能支撑更长篇幅。当前章只锁定方向、边界和钩子，不要强制写死每一步。请给出可应用的总纲/章方向修改提案。',
    },
    {
      label: '强化第一卷',
      mode: 'both',
      request:
        '请重调第一卷规划，让它至少能支撑 40 章以上：围绕核心危机初现、旧秩序松动、主角受压、关键异常、关系撕裂和第一批阶段性阻力逐步展开。不要十章内把大线说完；每 3-5 章要有阶段性小高潮、代价、奖励或新谜题。',
    },
    {
      label: '只改当前章',
      mode: 'chapter',
      request:
        '只调整当前章方向，让本章更精彩但不越界。要求：开场更有生活质感，异常征兆更有压迫感，核心危机要有明确因果和视觉冲击；体系展示要震撼但秩序不能凭空成熟；主角受压要造成可见选择和心理压力；章末必须留下强钩子。请改标题、目标、范围和设定护栏；除非必要，不要固定每一步节拍。',
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {!fullHeight && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b bg-muted/30 px-4 py-2">
          <PencilLine className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">方向提案</h3>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <div className="grid min-h-full gap-4 p-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <div className="space-y-3">
            <div className="rounded-md border bg-card p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="font-semibold">项目总纲</div>
                <Badge variant="outline" className="text-[10px]">
                  {plan?.targetChapters ?? LONG_FORM_TARGET_CHAPTERS} 章
                </Badge>
              </div>
              <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
                {storyBibleNotes ? (
                  <details className="rounded border bg-muted/20 px-2 py-1.5" open>
                    <summary className="cursor-pointer font-medium text-foreground">用户补充总纲 / 正典设定</summary>
                    <div className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap pr-1">{storyBibleNotes}</div>
                  </details>
                ) : (
                  <div className="rounded border border-dashed px-2 py-2">
                    还没有用户补充总纲。你和导演讨论后沉淀的大设定，会显示在这里，并优先影响后续规划。
                  </div>
                )}
                <div>
                  <span className="font-medium text-foreground">体量：</span>
                  {targetWordsLabel(plan?.targetWords)}
                  {' / '}
                  每章 {plan?.chapterWordMin ?? CHAPTER_WORD_TARGET_MIN}-{plan?.chapterWordMax ?? CHAPTER_WORD_TARGET_MAX} 字
                </div>
                <div>
                  <span className="font-medium text-foreground">长篇承诺：</span>
                  {plan?.promise || '未生成，等待用户大纲/规划补充'}
                </div>
                <div>
                  <div className="mb-1 font-medium text-foreground">卷规划</div>
                  {plan?.volumes?.length ? (
                    <div className="space-y-1">
                      {plan.volumes.slice(0, 6).map((volume: any) => (
                        <div key={volume.index} className="rounded border bg-muted/30 px-2 py-1.5">
                          第 {volume.index} 卷《{volume.title}》 · 第 {volume.chapterStart}-{volume.chapterEnd} 章
                          <div className="mt-0.5">{volume.purpose}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded border border-dashed px-2 py-2">还没有卷规划。这里应该由你的总纲或方向提案补，而不是开发层硬编。</div>
                  )}
                </div>
		              </div>
		            </div>

		            <div className="rounded-md border bg-card p-3">
	              <div className="mb-2 flex items-center justify-between gap-2">
	                <div className="font-semibold">当前章方向</div>
                <Badge variant={chapter?.manualOutline ? 'default' : 'outline'} className="text-[10px]">
                  {chapter?.manualOutline ? '人工修订' : '自动生成'}
                </Badge>
              </div>
              {chapter ? (
                <div className="space-y-3 text-xs leading-relaxed">
                  <div>
                    <div className="font-medium">第 {chapter.chapterNo} 章《{chapter.title}》</div>
                    <div className="mt-1 text-muted-foreground">{chapter.goal}</div>
                    <div className="mt-1 text-muted-foreground">{chapter.scope}</div>
                  </div>
                  <div>
                    <div className="mb-1 font-medium">本章节拍</div>
                    <ol className="space-y-1">
                      {(chapter.beats ?? []).map((beat: string, index: number) => (
                        <li key={index} className="flex gap-1.5 text-muted-foreground">
                          <span className="text-foreground">{index + 1}.</span>
                          <span>{beat}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                  <div>
                    <div className="mb-1 font-medium">设定护栏</div>
                    <ul className="space-y-1">
                      {(chapter.constraints ?? []).map((item: string, index: number) => (
                        <li key={index} className="flex gap-1.5 text-muted-foreground">
                          <span className="mt-[7px] h-1 w-1 flex-shrink-0 rounded-full bg-muted-foreground/60" />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
	                </div>
	              ) : (
                <div className="text-sm text-muted-foreground">当前章方向还没有生成。</div>
              )}
            </div>
          </div>

          <div className="flex min-h-[32rem] flex-col rounded-md border bg-background">
            <div className="border-b p-3">
              <div className="mb-2 flex items-center gap-2">
                <PencilLine className="h-4 w-4 text-primary" />
                <div className="font-semibold">让编导生成方向提案</div>
              </div>
              <div className="grid gap-2 md:grid-cols-3">
                {modeOptions.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setMode(item.key)}
                    className={`rounded-md border px-3 py-2 text-left transition-colors ${
                      mode === item.key ? 'border-primary bg-primary/10 text-primary' : 'bg-card hover:bg-muted/60'
                    }`}
                  >
                    <div className="text-xs font-medium">{item.label}</div>
                    <div className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{item.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-3">
              <div className="space-y-3">
	                <div className="flex flex-wrap gap-2">
	                  <Button
	                    type="button"
	                    size="sm"
	                    variant={nodePlanMayNeedSync ? 'default' : 'outline'}
	                    className="h-8 text-xs"
	                    onClick={onSyncStoryBible}
	                    disabled={loading || applying || syncingStoryBible || !storyBibleNotes}
	                  >
	                    {syncingStoryBible ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Rows2 className="mr-1 h-3.5 w-3.5" />}
	                    同步总纲到节点
	                  </Button>
	                  {excitementPresets.map((preset) => (
	                    <Button
                      key={preset.label}
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs"
                      onClick={() => {
                        setMode(preset.mode);
                        setRequest(preset.request);
                      }}
                      disabled={loading || applying}
                    >
                      <Sparkles className="mr-1 h-3.5 w-3.5" />
                      {preset.label}
                    </Button>
                  ))}
                </div>
                <Textarea
                  value={request}
                  onChange={(event) => setRequest(event.target.value)}
                  placeholder="写你想怎么调整。比如：第三章改成主角第一次主动选择，而不是继续被动挨压；章名换得更有悬念；本章只限定危机、边界和强钩子，具体行动让角色演绎。"
                  className="min-h-[120px] max-h-[240px] resize-y text-sm leading-relaxed"
                />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => onGenerate()} disabled={!request.trim() || loading || applying}>
                    {loading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
                    生成方向提案
                  </Button>
                  {proposal && (
                    <Button size="sm" variant="outline" onClick={onClearProposal} disabled={loading || applying}>
                      清空提案
                    </Button>
                  )}
                </div>
                {error && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                    {error}
                  </div>
                )}

                {loading && (
                  <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
                    <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                    {outlineRevisionLoadingText(mode)}
                  </div>
                )}

                {proposal && (
                  <OutlineRevisionProposalCard
                    proposal={proposal}
                    applying={applying}
                    onApply={onApply}
                    onShowDesign={onShowDesign}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function OutlineRevisionProposalCard({
  proposal,
  applying,
  onApply,
  onShowDesign,
}: {
  proposal: OutlineRevisionProposal;
  applying: boolean;
  onApply: (proposal: OutlineRevisionProposal) => void;
  onShowDesign: () => void;
}) {
  const isRoundtableProposal = proposal.source === 'roundtable';
  const scopeLabel = outlineRevisionScopeLabel(proposal);
  const applyLabel = outlineRevisionApplyLabel(proposal);
  return (
    <div className="rounded-md border bg-card p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-semibold">{proposal.title || '方向提案'}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {new Date(proposal.createdAt).toLocaleString()} · {scopeLabel}
          </div>
        </div>
        <Badge variant="outline" className="text-[10px]">待确认</Badge>
      </div>
      {proposal.reason && (
        <div className="mt-3 rounded-md bg-muted/35 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          {proposal.reason}
        </div>
      )}
      <div className="mt-3 grid gap-2 xl:grid-cols-2">
        <OpinionBlock title="剧情设计师" content={proposal.designerOpinion} />
        <OpinionBlock title="Director" content={proposal.directorOpinion} />
        <OpinionBlock title="设定审核" content={proposal.auditorOpinion} />
      </div>
      <div className="mt-3 grid gap-3 xl:grid-cols-2">
        {!isRoundtableProposal && <PatchPreview title="总纲追加" value={proposal.globalNotesAppend} />}
        {!isRoundtableProposal && <PatchPreview title="长篇规划修改" value={proposal.longFormPlanPatch} />}
        <PatchPreview title="当前章方向修改" value={proposal.currentChapterPatch} />
        {!isRoundtableProposal && <PatchPreview title="剧情节点修改" value={proposal.plotNodePatches} />}
      </div>
      {isRoundtableProposal && (
        <div className="mt-3 rounded-md border bg-muted/25 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          设计讨论采纳只会写入当前章方向与 Director 执行指令，不会追加到总纲或长篇规划。
        </div>
      )}
      {proposal.risks?.length > 0 && (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/25 dark:text-amber-200">
          <div className="font-medium">风险</div>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {proposal.risks.map((risk, index) => <li key={index}>{risk}</li>)}
          </ul>
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onApply(proposal)} disabled={applying}>
          {applying ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1 h-3.5 w-3.5" />}
          {applyLabel}
        </Button>
        <Button size="sm" variant="outline" onClick={onShowDesign}>
          回导演设计
        </Button>
      </div>
    </div>
  );
}

function OpinionBlock({ title, content }: { title: string; content: string }) {
  if (!content) return null;
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <div className="mb-1 text-xs font-medium">{title}</div>
      <div className="text-xs leading-relaxed text-muted-foreground">{content}</div>
    </div>
  );
}

function PatchPreview({ title, value }: { title: string; value: unknown }) {
  const empty =
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0);
  if (empty) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <details className="rounded-md border bg-background px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium">{title}</summary>
      <pre className="mt-2 max-h-44 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted-foreground">
        {text}
      </pre>
    </details>
  );
}

function DesignList({ title, items, tone }: {
  title: string;
  items: string[];
  tone: 'event' | 'crowd' | 'cast' | 'guard' | 'note' | 'audit';
}) {
  if (!items?.length) return null;
  const color =
    tone === 'event' ? 'text-blue-700 dark:text-blue-300' :
    tone === 'crowd' ? 'text-amber-700 dark:text-amber-300' :
    tone === 'cast' ? 'text-green-700 dark:text-green-300' :
    tone === 'guard' ? 'text-red-700 dark:text-red-300' :
    tone === 'audit' ? 'text-purple-700 dark:text-purple-300' :
    'text-foreground';
  return (
    <div className="mt-3">
      <div className={`text-xs font-medium mb-1 ${color}`}>{title}</div>
      <ul className="space-y-1">
        {items.map((item, index) => (
          <li key={index} className="text-xs leading-relaxed text-muted-foreground flex gap-1.5">
            <span className="mt-[7px] h-1 w-1 rounded-full bg-muted-foreground/60 flex-shrink-0" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ============== 创作资产库 ==============
const ASSET_CATEGORY_OPTIONS: Array<{ value: NovelAssetCategory; label: string; desc: string }> = [
  { value: 'talent', label: '天赋', desc: '觉醒、血脉、唯一性能力' },
  { value: 'profession', label: '职业', desc: '转职路线、隐藏职业、体系定位' },
  { value: 'skill', label: '技能', desc: '主动/被动/组合技/禁术' },
  { value: 'equipment', label: '装备', desc: '武器、防具、神器、成长装备' },
  { value: 'pet_mount', label: '宠物/坐骑', desc: '契约兽、战宠、移动载具' },
  { value: 'monster_dungeon', label: '怪物/副本', desc: '深渊种、秘境、关卡机制' },
  { value: 'drop_resource', label: '掉落/资源', desc: '材料、货币、稀有奖励' },
  { value: 'faction_location', label: '势力/地点', desc: '组织、城市、学院、禁区' },
  { value: 'foreshadow', label: '伏笔', desc: '谜题、预言、后续引爆点' },
];

const ASSET_STATUS_OPTIONS: Array<{ value: NovelAssetStatus; label: string; desc: string; badge: string }> = [
  { value: 'concept', label: '灵感池', desc: '暂不进入编导调度，可继续打磨', badge: 'bg-muted text-muted-foreground' },
  { value: 'foreshadow', label: '可伏笔', desc: '可以埋线索，但不能完整揭示', badge: 'bg-purple-100 text-purple-700 dark:bg-purple-950/35 dark:text-purple-300' },
  { value: 'available', label: '剧情可调度', desc: '允许编导在合适剧情触发时调用', badge: 'bg-blue-100 text-blue-700 dark:bg-blue-950/35 dark:text-blue-300' },
  { value: 'landed', label: '已落地', desc: '已经进入正稿或事件事实', badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/35 dark:text-emerald-300' },
  { value: 'disabled', label: '禁用/废弃', desc: '保留记录，但不进入生成上下文', badge: 'bg-red-100 text-red-700 dark:bg-red-950/35 dark:text-red-300' },
];

const ASSET_GRADE_PRESETS = [
  '白板',
  '黑铁',
  '白银',
  '黄金',
  '暗金',
  '钻石',
  '传说',
  '神话',
  '禁断',
  '劫灭',
  '终焉',
];

const TALENT_GRADE_PRESETS = [
  'SSS',
  'SS',
  'S',
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
];

function assetCategoryLabel(category: NovelAssetCategory): string {
  return ASSET_CATEGORY_OPTIONS.find((item) => item.value === category)?.label ?? category;
}

function assetStatusMeta(status: NovelAssetStatus) {
  return ASSET_STATUS_OPTIONS.find((item) => item.value === status) ?? ASSET_STATUS_OPTIONS[0];
}

function splitAssetList(value: string): string[] {
  return value
    .split(/[\n,，、]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function createEmptyAsset(currentChapterNo?: number): NovelAsset {
  return {
    id: `asset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    category: 'talent',
    status: 'concept',
    grade: '',
    summary: '',
    plotUse: '',
    mechanics: '',
    rules: [],
    triggerConditions: [],
    linkedCharacters: [],
    chapterNo: null,
    source: 'user',
    updatedAt: new Date().toISOString(),
  };
}

function AssetLibraryPanel({
  projectId,
  worldState,
  currentChapterNo,
  onWorldUpdate,
  onShowDesign,
  fullHeight,
}: {
  projectId: string;
  worldState: WorldState | null;
  currentChapterNo?: number;
  onWorldUpdate: (worldState: WorldState) => void;
  onShowDesign: () => void;
  fullHeight?: boolean;
}) {
  const [items, setItems] = useState<NovelAsset[]>(() => worldState?.assetLibrary ?? []);
  const [draft, setDraft] = useState<NovelAsset>(() => createEmptyAsset(currentChapterNo));
  const [rulesText, setRulesText] = useState('');
  const [triggerText, setTriggerText] = useState('');
  const [linkedText, setLinkedText] = useState('');
  const [editingId, setEditingId] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<NovelAssetCategory | 'all'>('all');
  const [designRequest, setDesignRequest] = useState('围绕当前大纲，按每类约 10 个补充天赋、职业、技能、装备、宠物/坐骑、副本怪物、掉落资源、势力地点和伏笔。要求天马行空，机制要能催化剧情；天赋使用 SSS/SS/S/A/B/C/D/E/F 独立品阶，其他素材使用 11 阶品阶；早期不要直接发放过强能力。');
  const [designing, setDesigning] = useState(false);
  const [designNote, setDesignNote] = useState('');
  const [designRisks, setDesignRisks] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const activeItems = items.filter((item) => item.status !== 'disabled');
  const currentChapterItems = items.filter((item) => item.status === 'available');
  const visibleItems = selectedCategory === 'all'
    ? items
    : items.filter((item) => item.category === selectedCategory);

  useEffect(() => {
    setItems(worldState?.assetLibrary ?? []);
    setDirty(false);
  }, [worldState?.assetLibrary]);

  const resetDraft = () => {
    setDraft(createEmptyAsset(currentChapterNo));
    setRulesText('');
    setTriggerText('');
    setLinkedText('');
    setEditingId('');
  };

  const markDirty = (next: NovelAsset[]) => {
    setItems(next);
    setDirty(true);
  };

  const upsertDraft = () => {
    const name = draft.name.trim();
    if (!name) {
      toast.error('先写素材名称');
      return;
    }
    const nextAsset: NovelAsset = {
      ...draft,
      name,
      grade: (draft.grade ?? '').trim(),
      summary: draft.summary.trim(),
      plotUse: draft.plotUse.trim(),
      mechanics: (draft.mechanics ?? '').trim(),
      triggerConditions: splitAssetList(triggerText),
      rules: splitAssetList(rulesText),
      linkedCharacters: splitAssetList(linkedText),
      chapterNo: draft.chapterNo && draft.chapterNo > 0 ? Number(draft.chapterNo) : null,
      source: draft.source ?? 'user',
      updatedAt: new Date().toISOString(),
    };
    const next = items.some((item) => item.id === nextAsset.id)
      ? items.map((item) => item.id === nextAsset.id ? nextAsset : item)
      : [nextAsset, ...items];
    markDirty(next);
    resetDraft();
  };

  const editAsset = (asset: NovelAsset) => {
    setEditingId(asset.id);
    setDraft({
      ...asset,
      rules: asset.rules ?? [],
      triggerConditions: asset.triggerConditions ?? [],
      linkedCharacters: asset.linkedCharacters ?? [],
      chapterNo: asset.chapterNo ?? null,
    });
    setRulesText((asset.rules ?? []).join('\n'));
    setTriggerText((asset.triggerConditions ?? []).join('\n'));
    setLinkedText((asset.linkedCharacters ?? []).join('、'));
  };

  const setAssetStatus = (asset: NovelAsset, status: NovelAssetStatus) => {
    markDirty(items.map((item) => item.id === asset.id
      ? { ...item, status, updatedAt: new Date().toISOString() }
      : item
    ));
  };

  const removeAsset = (asset: NovelAsset) => {
    markDirty(items.filter((item) => item.id !== asset.id));
    if (editingId === asset.id) resetDraft();
  };

  const addPreset = (preset: Pick<NovelAsset, 'name' | 'category' | 'status' | 'grade' | 'summary' | 'plotUse' | 'mechanics' | 'rules' | 'triggerConditions'>) => {
    const asset: NovelAsset = {
      ...createEmptyAsset(currentChapterNo),
      ...preset,
      id: `asset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chapterNo: null,
      updatedAt: new Date().toISOString(),
    };
    markDirty([asset, ...items]);
  };

  const designAssets = async () => {
    setDesigning(true);
    setDesignNote('');
    setDesignRisks([]);
    try {
      const res = await fetch(`/api/projects/${projectId}/asset-library/design`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: designRequest, targetPerCategory: 10 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '素材设计失败');
      const generated = Array.isArray(data.assets) ? data.assets as NovelAsset[] : [];
      if (!generated.length) throw new Error('没有生成可用素材');
      const existingKeys = new Set(items.map((item) => `${item.category}:${item.name}`));
      const merged = [
        ...generated.filter((item) => !existingKeys.has(`${item.category}:${item.name}`)),
        ...items,
      ].slice(0, 300);
      markDirty(merged);
      setDesignNote(String(data.strategy ?? '').trim());
      setDesignRisks(Array.isArray(data.risks) ? data.risks.map(String).filter(Boolean).slice(0, 8) : []);
      toast.success(`体系策划新增 ${merged.length - items.length} 条素材候选，请确认后保存`);
    } catch (err: any) {
      toast.error(err.message || '素材设计失败');
    } finally {
      setDesigning(false);
    }
  };

  const saveAssets = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/asset-library`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assets: items }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '素材库保存失败');
      if (data.worldState) onWorldUpdate(data.worldState);
      setDirty(false);
      toast.success('素材库已保存，旧导演设计已失效');
    } catch (err: any) {
      toast.error(err.message || '素材库保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {!fullHeight && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b bg-muted/30 px-4 py-2">
          <Package className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">素材库</h3>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <div className="grid min-h-full gap-4 p-4 xl:grid-cols-[minmax(20rem,0.78fr)_minmax(0,1.22fr)]">
          <div className="space-y-3">
            <div className="rounded-md border bg-card p-3">
              <div className="mb-3 flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold">创作资产库</div>
                  <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    保存后会进入总纲上下文，剧情设计师、Director 和 Writer 后续会读取这些素材。
                  </div>
                </div>
                <Badge variant="outline" className="text-[10px]">
                  {activeItems.length} 可用记录
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded border bg-muted/25 px-2 py-1.5">
                  可调度素材 <span className="font-semibold">{currentChapterItems.length}</span>
                </div>
                <div className="rounded border bg-muted/25 px-2 py-1.5">
                  全部记录 <span className="font-semibold">{items.length}</span>
                </div>
              </div>
              {dirty && (
                <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/25 dark:text-amber-200">
                  有未保存改动。保存后需要重新生成导演设计，才能让新素材进入后续编导上下文。
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={saveAssets} disabled={saving || !dirty}>
                  {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1 h-3.5 w-3.5" />}
                  保存素材库
                </Button>
                <Button size="sm" variant="outline" onClick={onShowDesign}>
                  去导演设计
                </Button>
              </div>
            </div>

            <div className="rounded-md border bg-card p-3">
              <div className="mb-2 flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                <div className="font-semibold">设计素材库</div>
              </div>
                <div className="mb-2 text-xs leading-relaxed text-muted-foreground">
                让体系策划 Agent 读取当前总纲、章方向、角色和已有素材，生成分类素材候选。素材不会强制绑定章节或人物，真正出场由剧情触发。
              </div>
              <Textarea
                value={designRequest}
                onChange={(event) => setDesignRequest(event.target.value)}
                className="min-h-[86px] resize-none text-xs leading-relaxed"
                placeholder="写你希望素材库往哪个方向扩展，比如更炫酷的天赋体系、宠物进化线、副本机制、掉落经济、职业分支..."
              />
              <Button size="sm" onClick={designAssets} disabled={designing || !designRequest.trim()} className="mt-2 w-full">
                {designing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
                让体系策划设计素材库
              </Button>
              {designNote && (
                <div className="mt-2 rounded-md border bg-muted/25 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground">设计思路：</span>{designNote}
                </div>
              )}
              {designRisks.length > 0 && (
                <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/25 dark:text-amber-200">
                  <div className="font-medium">使用风险</div>
                  <ul className="mt-1 space-y-1">
                    {designRisks.map((risk, index) => <li key={index}>· {risk}</li>)}
                  </ul>
                </div>
              )}
            </div>

            <div className="rounded-md border bg-card p-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="font-semibold">{editingId ? '编辑素材' : '新增素材'}</div>
                {editingId && (
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={resetDraft}>
                    取消编辑
                  </Button>
                )}
              </div>
              <div className="space-y-2">
                <div className="grid gap-2 md:grid-cols-2">
                  <div>
                    <Label className="text-xs">名称</Label>
                    <Input
                      value={draft.name}
                      onChange={(event) => setDraft({ ...draft, name: event.target.value })}
	                      placeholder="如：异常判定、契约兽胚胎、镜像首领、关键线索"
                      className="mt-1 h-8 text-xs"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">参考阶段（可空）</Label>
                    <Input
                      type="number"
                      min={1}
                      value={draft.chapterNo ?? ''}
                      onChange={(event) => setDraft({ ...draft, chapterNo: event.target.value ? Number(event.target.value) : null })}
                      placeholder="不是强制绑定，可为空"
                      className="mt-1 h-8 text-xs"
                    />
                  </div>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  <div>
                    <Label className="text-xs">类别</Label>
                    <Select value={draft.category} onValueChange={(value) => setDraft({ ...draft, category: value as NovelAssetCategory })}>
                      <SelectTrigger className="mt-1 h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ASSET_CATEGORY_OPTIONS.map((item) => (
                          <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">状态/权限</Label>
                    <Select value={draft.status} onValueChange={(value) => setDraft({ ...draft, status: value as NovelAssetStatus })}>
                      <SelectTrigger className="mt-1 h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ASSET_STATUS_OPTIONS.map((item) => (
                          <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div>
                  <Label className="text-xs">{draft.category === 'talent' ? '天赋品阶' : '品级/阶位'}</Label>
                  <Input
                    value={draft.grade ?? ''}
                    onChange={(event) => setDraft({ ...draft, grade: event.target.value })}
                    placeholder={draft.category === 'talent'
                      ? '如：SSS、SS、S、A、B、C、D、E、F'
                      : '如：白板、黑铁、白银、黄金、暗金、钻石、传说、神话、禁断、劫灭、终焉...'}
                    className="mt-1 h-8 text-xs"
                  />
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {(draft.category === 'talent' ? TALENT_GRADE_PRESETS : ASSET_GRADE_PRESETS).map((grade) => (
                      <button
                        key={grade}
                        type="button"
                        onClick={() => setDraft({ ...draft, grade })}
                        className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                          draft.grade === grade ? 'border-primary bg-primary/10 text-primary' : 'bg-background text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {grade}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <Label className="text-xs">设定摘要</Label>
                  <Textarea
                    value={draft.summary}
                    onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
                    placeholder="它是什么、爽点在哪里、和世界规则怎么相容。"
                    className="mt-1 min-h-[72px] resize-none text-xs leading-relaxed"
                  />
                </div>
                <div>
                  <Label className="text-xs">剧情用途</Label>
                  <Textarea
                    value={draft.plotUse}
                    onChange={(event) => setDraft({ ...draft, plotUse: event.target.value })}
                    placeholder="它应该怎样催化剧情：制造危机、奖励、反转、谜题、角色冲突或成长选择。"
                    className="mt-1 min-h-[72px] resize-none text-xs leading-relaxed"
                  />
                </div>
                <div>
                  <Label className="text-xs">机制/效果</Label>
                  <Textarea
                    value={draft.mechanics ?? ''}
                    onChange={(event) => setDraft({ ...draft, mechanics: event.target.value })}
                    placeholder="写为何属于此阶、核心机制、主动/被动效果、引爆/成长方式、代价或冷却。怪物/副本要写机制谜题、破解条件、团队矛盾和掉落反馈。数值可以先按爽点草案写，后续按剧情节奏调整。"
                    className="mt-1 min-h-[120px] resize-y text-xs leading-relaxed"
                  />
                </div>
                <div>
                  <Label className="text-xs">触发/出场条件</Label>
                  <Textarea
                    value={triggerText}
                    onChange={(event) => setTriggerText(event.target.value)}
                    placeholder="一行一条。比如：角色第一次见到觉醒者、深渊副本掉落、检测误判、交易传闻、战斗压力逼出。"
                    className="mt-1 min-h-[68px] resize-none text-xs leading-relaxed"
                  />
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  <div>
                    <Label className="text-xs">规则/限制</Label>
                    <Textarea
                      value={rulesText}
                      onChange={(event) => setRulesText(event.target.value)}
                      placeholder="一行一条，避免变成万能设定。"
                      className="mt-1 min-h-[68px] resize-none text-xs leading-relaxed"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">可能牵涉对象（可空）</Label>
                    <Textarea
                      value={linkedText}
                      onChange={(event) => setLinkedText(event.target.value)}
                      placeholder="不是绑定，只是提示。可留空。"
                      className="mt-1 min-h-[68px] resize-none text-xs leading-relaxed"
                    />
                  </div>
                </div>
                <Button size="sm" onClick={upsertDraft} className="w-full">
                  {editingId ? '更新素材' : '加入素材库'}
                </Button>
              </div>
            </div>

            <div className="rounded-md border bg-card p-3">
              <div className="mb-2 font-semibold">快速种子</div>
              <div className="grid gap-2">
                {[
                  {
	                    name: '反常判定',
                    category: 'talent' as NovelAssetCategory,
                    status: 'foreshadow' as NovelAssetStatus,
	                    grade: '待定',
	                    summary: '公开判定结果与角色真实潜力不一致，形成误判、压力和后续逆转空间。',
	                    plotUse: '让角色承受外界误读，同时埋下后续反转；当前章只能表现社会压力和异常细节。',
	                    mechanics: '核心机制：【结果错位】。低阶检测、表层证据或公共评价只能读出错误结论，但高阶规则会在异常事件中留下无法解释的空窗。前期不直接给战斗数值或终局答案，只制造误判、排挤和后续反差。',
	                    triggerConditions: ['公开检测、审查、评估或证词出现异常结果', '其他角色目击或讨论结果时才能描写'],
	                    rules: ['早期不得直接解释真相', '不能立刻获得万能外挂'],
	                  },
	                  {
	                    name: '封闭规则场',
                    category: 'monster_dungeon' as NovelAssetCategory,
                    status: 'foreshadow' as NovelAssetStatus,
	                    grade: '低阶-中阶',
	                    summary: '局部空间被特殊规则覆盖，形成不稳定的小型危机场。',
	                    plotUse: '把日常空间变成压力场，推动关系分裂、秩序崩坏或关键选择。',
	                    mechanics: '核心机制：【局部规则覆盖】。进入区域后常识被新规则替换，出口、时间感、证据、怪物或资源都出现轻微错位。早期只表现混乱和误判，不出现成熟攻略或完整说明书。',
	                    triggerConditions: ['异常规则影响到日常空间', '角色进入异常区域或听到幸存者描述'],
	                    rules: ['成熟流程不能凭空出现', '先出现混乱和误判'],
	                  },
	                  {
	                    name: '未孵化契约物',
                    category: 'pet_mount' as NovelAssetCategory,
                    status: 'concept' as NovelAssetStatus,
                    grade: '神话胚胎',
	                    summary: '来源不明的生命或器物胚胎，可能与角色产生长期绑定。',
                    plotUse: '作为中期宠物/伙伴线，可带来培养、进化、交易和争夺玩法。',
	                    mechanics: '核心机制：【未孵化契约】。胚胎会吸收特定能量、情绪、资源或线索并产生微弱回应，契约对象、形态和成长路线未定。前期只允许影子、心跳、异常温度等线索。',
	                    triggerConditions: ['奖励、交易、遗迹、案件物证或异常残骸中发现', '前期只可用传闻或异常阴影铺垫'],
                    rules: ['前期只做影子，不直接孵化'],
                  },
                  {
	                    name: '价值镜像首领',
                    category: 'monster_dungeon' as NovelAssetCategory,
                    status: 'concept' as NovelAssetStatus,
                    grade: '钻石-传说',
	                    summary: '由在场者最重视的价值物、秘密或资源映射而成的机制型首领。',
	                    plotUse: '把对抗变成责任考验：持有关键价值的人会被所有人看见、保护、质疑并逼迫出手。',
	                    mechanics: '核心机制：【价值映照】复制在场者最有价值的物品、秘密、关系或资源并获得其特性；【镜像弱点】只有原持有者用原物或原证据命中，才会短暂暴露核心；【投影回馈】胜利后掉落限时投影复制品或线索，制造炫耀、责任和争夺。',
	                    triggerConditions: ['中后期首次出现团队危机、世界首领或关键案件', '角色资源价值开始形成阶层差距', '需要制造团队保护关键人物的戏剧性'],
	                    rules: ['不能只靠常规输出解决', '投影回馈必须限时或有限代价，避免破坏体系'],
	                  },
                ].map((preset) => (
                  <button
                    key={preset.name}
                    type="button"
                    onClick={() => addPreset(preset)}
                    className="rounded-md border bg-background px-3 py-2 text-left text-xs transition-colors hover:bg-muted/50"
                  >
                    <div className="font-medium">{preset.name}</div>
                    <div className="mt-1 text-muted-foreground">{assetCategoryLabel(preset.category)} · {assetStatusMeta(preset.status).label}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="min-h-[32rem] rounded-md border bg-background">
            <div className="border-b p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-semibold">素材状态</div>
                  <div className="mt-1 text-xs text-muted-foreground">状态就是生成权限，避免素材污染当前章。</div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {ASSET_STATUS_OPTIONS.map((status) => (
                    <Badge key={status.value} variant="outline" className="text-[10px]">
                      {status.label} {items.filter((item) => item.status === status.value).length}
                    </Badge>
                  ))}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setSelectedCategory('all')}
                  className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                    selectedCategory === 'all' ? 'border-primary bg-primary/10 text-primary' : 'bg-card text-muted-foreground hover:text-foreground'
                  }`}
                >
                  全部 {items.length}
                </button>
                {ASSET_CATEGORY_OPTIONS.map((category) => (
                  <button
                    key={category.value}
                    type="button"
                    onClick={() => setSelectedCategory(category.value)}
                    className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                      selectedCategory === category.value ? 'border-primary bg-primary/10 text-primary' : 'bg-card text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {category.label} {items.filter((item) => item.category === category.value).length}
                  </button>
                ))}
              </div>
            </div>
            <div className="max-h-[calc(100vh-14rem)] overflow-y-auto p-3">
              {visibleItems.length === 0 ? (
                <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
                  {items.length === 0
                    ? '还没有素材。先让体系策划设计素材库，或手动加入天赋、职业、技能、装备、宠物、坐骑、副本和伏笔。'
                    : '当前分类还没有素材。可以切换分类，或让体系策划继续补。'}
                </div>
              ) : (
                <AssetCategoryGroups
                  assets={visibleItems}
                  onEdit={editAsset}
                  onStatus={setAssetStatus}
                  onRemove={removeAsset}
                  grouped={selectedCategory === 'all'}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AssetCategoryGroups({
  assets,
  onEdit,
  onStatus,
  onRemove,
  grouped,
}: {
  assets: NovelAsset[];
  onEdit: (asset: NovelAsset) => void;
  onStatus: (asset: NovelAsset, status: NovelAssetStatus) => void;
  onRemove: (asset: NovelAsset) => void;
  grouped: boolean;
}) {
  if (!grouped) {
    return (
      <div className="space-y-3">
        {assets.map((asset) => (
          <AssetLibraryCard
            key={asset.id}
            asset={asset}
            onEdit={onEdit}
            onStatus={onStatus}
            onRemove={onRemove}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {ASSET_CATEGORY_OPTIONS.map((category) => {
        const groupAssets = assets.filter((asset) => asset.category === category.value);
        if (!groupAssets.length) return null;
        return (
          <section key={category.value} className="space-y-2">
            <div className="sticky top-0 z-10 flex items-center justify-between rounded-md border bg-background/95 px-3 py-2 backdrop-blur">
              <div>
                <div className="text-sm font-semibold">{category.label}</div>
                <div className="text-[11px] text-muted-foreground">{category.desc}</div>
              </div>
              <Badge variant="outline" className="text-[10px]">{groupAssets.length}</Badge>
            </div>
            <div className="space-y-3">
              {groupAssets.map((asset) => (
                <AssetLibraryCard
                  key={asset.id}
                  asset={asset}
                  onEdit={onEdit}
                  onStatus={onStatus}
                  onRemove={onRemove}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function AssetLibraryCard({
  asset,
  onEdit,
  onStatus,
  onRemove,
}: {
  asset: NovelAsset;
  onEdit: (asset: NovelAsset) => void;
  onStatus: (asset: NovelAsset, status: NovelAssetStatus) => void;
  onRemove: (asset: NovelAsset) => void;
}) {
  const status = assetStatusMeta(asset.status);
  return (
    <div className={`rounded-md border bg-card p-3 text-sm ${asset.status === 'disabled' ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="font-semibold">{asset.name}</div>
            <span className={`rounded px-1.5 py-0.5 text-[10px] ${status.badge}`}>{status.label}</span>
            <Badge variant="outline" className="text-[10px]">{assetCategoryLabel(asset.category)}</Badge>
            {asset.grade && <Badge variant="secondary" className="text-[10px]">{asset.grade}</Badge>}
            {asset.chapterNo && <Badge variant="outline" className="text-[10px]">参考第 {asset.chapterNo} 章附近</Badge>}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{status.desc}</div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => onEdit(asset)}>编辑</Button>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive" onClick={() => onRemove(asset)}>删除</Button>
        </div>
      </div>
      {asset.summary && (
        <div className="mt-3 text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">设定：</span>{asset.summary}
        </div>
      )}
      {asset.plotUse && (
        <div className="mt-2 text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">用途：</span>{asset.plotUse}
        </div>
      )}
      {asset.mechanics && (
        <div className="mt-3 rounded border bg-muted/25 px-2 py-1.5">
          <div className="mb-1 text-[10px] font-medium">机制/效果</div>
          <div className="whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">{asset.mechanics}</div>
        </div>
      )}
      {asset.triggerConditions?.length ? (
        <div className="mt-3 rounded border bg-muted/25 px-2 py-1.5">
          <div className="mb-1 text-[10px] font-medium">触发/出场条件</div>
          <ul className="space-y-1">
            {asset.triggerConditions.slice(0, 6).map((condition, index) => (
              <li key={index} className="text-[11px] leading-relaxed text-muted-foreground">· {condition}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {(asset.rules?.length || asset.linkedCharacters?.length) ? (
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {asset.rules?.length ? (
            <div className="rounded border bg-muted/25 px-2 py-1.5">
              <div className="mb-1 text-[10px] font-medium">规则限制</div>
              <ul className="space-y-1">
                {asset.rules.slice(0, 5).map((rule, index) => (
                  <li key={index} className="text-[11px] leading-relaxed text-muted-foreground">· {rule}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {asset.linkedCharacters?.length ? (
            <div className="rounded border bg-muted/25 px-2 py-1.5">
              <div className="mb-1 text-[10px] font-medium">可能牵涉对象</div>
              <div className="flex flex-wrap gap-1">
                {asset.linkedCharacters.slice(0, 8).map((name) => (
                  <Badge key={name} variant="secondary" className="text-[10px]">{name}</Badge>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-1.5 border-t pt-3">
        <Button size="sm" variant={asset.status === 'concept' ? 'default' : 'outline'} className="h-7 px-2 text-xs" onClick={() => onStatus(asset, 'concept')}>概念</Button>
        <Button size="sm" variant={asset.status === 'foreshadow' ? 'default' : 'outline'} className="h-7 px-2 text-xs" onClick={() => onStatus(asset, 'foreshadow')}>可伏笔</Button>
        <Button size="sm" variant={asset.status === 'available' ? 'default' : 'outline'} className="h-7 px-2 text-xs" onClick={() => onStatus(asset, 'available')}>
          剧情可调度
        </Button>
        <Button size="sm" variant={asset.status === 'landed' ? 'default' : 'outline'} className="h-7 px-2 text-xs" onClick={() => onStatus(asset, 'landed')}>已落地</Button>
        <Button size="sm" variant={asset.status === 'disabled' ? 'default' : 'outline'} className="h-7 px-2 text-xs" onClick={() => onStatus(asset, 'disabled')}>禁用</Button>
      </div>
    </div>
  );
}

// ============== 经验总结 ==============
function CraftLessonsPanel({ craftLessons, fullHeight }: {
  craftLessons: any[];
  fullHeight?: boolean;
}) {
  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {!fullHeight && (
        <div className="px-4 py-2 border-b bg-muted/30 flex items-center gap-2 flex-shrink-0">
          <BookMarked className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">经验总结</h3>
          <span className="text-xs text-muted-foreground">({craftLessons.length})</span>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <div className="w-full space-y-3 p-4">
          {craftLessons.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-8">
              Writer 出正文、Reader 完成评审后，这里会沉淀导演改进和写作经验。
            </div>
          ) : (
            craftLessons.slice().reverse().map((lesson) => (
              <div key={lesson.id} className="rounded-md border bg-card p-4 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="font-semibold leading-relaxed">{lesson.summary}</div>
                  <Badge variant="outline" className="text-[10px] flex-shrink-0">
                    严重度 {lesson.severity}/5
                  </Badge>
                </div>
                {lesson.directorAdjustments?.length > 0 && (
                  <LessonList title="导演改进" items={lesson.directorAdjustments} tone="director" />
                )}
                {lesson.writerGuidelines?.length > 0 && (
                  <LessonList title="写作经验" items={lesson.writerGuidelines} tone="writer" />
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function LessonList({ title, items, tone }: {
  title: string;
  items: string[];
  tone: 'director' | 'writer';
}) {
  const color = tone === 'director' ? 'text-blue-700 dark:text-blue-300' : 'text-emerald-700 dark:text-emerald-300';
  return (
    <div className="mt-3">
      <div className={`text-xs font-medium mb-1 ${color}`}>{title}</div>
      <ul className="space-y-1">
        {items.map((item, index) => (
          <li key={index} className="text-xs leading-relaxed text-muted-foreground flex gap-1.5">
            <span className="mt-[7px] h-1 w-1 rounded-full bg-muted-foreground/60 flex-shrink-0" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PlanningSettingsInline({ currentChapter, longFormPlan, onSave }: {
  currentChapter: any;
  longFormPlan: any;
  onSave: (settings: {
    targetWordMin: number;
    targetWordMax: number;
    targetTurns: number;
    targetWords: number;
    targetChapters: number;
  }) => void;
}) {
  const [targetWordMin, setTargetWordMin] = useState(() => String(currentChapter?.targetWordMin ?? CHAPTER_WORD_TARGET_MIN));
  const [targetWordMax, setTargetWordMax] = useState(() => String(currentChapter?.targetWordMax ?? CHAPTER_WORD_TARGET_MAX));
  const [targetTurns, setTargetTurns] = useState(() => String(currentChapter?.targetTurns ?? 8));
  const [targetWords, setTargetWords] = useState(() => String(longFormPlan?.targetWords ?? LONG_FORM_TARGET_WORDS));
  const [targetChapters, setTargetChapters] = useState(() => String(longFormPlan?.targetChapters ?? LONG_FORM_TARGET_CHAPTERS));

  const numberValue = (value: string, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return (
    <div className="mt-2 rounded-md border bg-background/75 p-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="text-[11px] font-medium">全局容量</div>
        <Badge variant="outline" className="bg-background text-[10px]">
          {targetWordMin || '-'}-{targetWordMax || '-'} 字
        </Badge>
      </div>
      <div className="mb-2 text-[10px] leading-relaxed text-muted-foreground">
        保存后作为后续章节默认值；当前章会立即同步。
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <PlanningNumberInput label="每章下限" value={targetWordMin} onChange={setTargetWordMin} />
        <PlanningNumberInput label="每章上限" value={targetWordMax} onChange={setTargetWordMax} />
        <PlanningNumberInput label="默认轮次" value={targetTurns} onChange={setTargetTurns} />
        <PlanningNumberInput label="全书章数" value={targetChapters} onChange={setTargetChapters} />
        <div className="col-span-2">
          <PlanningNumberInput label="全书目标字数" value={targetWords} onChange={setTargetWords} />
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="mt-2 h-8 w-full text-xs"
        onClick={() =>
          onSave({
            targetWordMin: numberValue(targetWordMin, currentChapter?.targetWordMin ?? CHAPTER_WORD_TARGET_MIN),
            targetWordMax: numberValue(targetWordMax, currentChapter?.targetWordMax ?? CHAPTER_WORD_TARGET_MAX),
            targetTurns: numberValue(targetTurns, currentChapter?.targetTurns ?? 8),
            targetWords: numberValue(targetWords, longFormPlan?.targetWords ?? LONG_FORM_TARGET_WORDS),
            targetChapters: numberValue(targetChapters, longFormPlan?.targetChapters ?? LONG_FORM_TARGET_CHAPTERS),
          })
        }
      >
        保存全局容量
      </Button>
    </div>
  );
}

function StoryBibleSupplementInline({ value, onSave }: {
  value?: string;
  onSave: (notes: string) => void;
}) {
  const [notes, setNotes] = useState(() => value ?? '');
  const trimmed = notes.trim();
  const saved = (value ?? '').trim();
  const dirty = trimmed !== saved;

  return (
    <details className="mt-2 rounded-md border bg-background/75 p-2">
      <summary className="cursor-pointer list-none">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[11px] font-medium">总纲补充</div>
            <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
              {trimmed || '补世界观、卷规划、后续剧情、禁用设定'}
            </div>
          </div>
          <Badge variant={saved ? 'default' : 'outline'} className="shrink-0 text-[10px]">
            {saved ? '已补充' : '未补充'}
          </Badge>
        </div>
      </summary>
      <div className="mt-2 space-y-2">
        <div className="rounded-md bg-muted/45 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
          保存后会进入 Director、剧情设计师和设计讨论的共同上下文；这里写的是你的权威补充，执行者读取，系统不自行编卷名或终局。
        </div>
        <Textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="例如：第一卷只写江城深渊初降和校园觉醒，不提前进入诸神/远古势力；第一章必须先日常放学，再异常征兆，再深渊降临，最后觉醒检测。白晏性别为女。"
          className="min-h-[84px] max-h-[160px] resize-y overflow-y-auto text-xs leading-relaxed"
        />
        <div className="grid grid-cols-2 gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={() => setNotes(value ?? '')}
            disabled={!dirty}
          >
            恢复已保存
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8 text-xs"
            onClick={() => onSave(trimmed)}
            disabled={!dirty}
          >
            保存补充
          </Button>
        </div>
      </div>
    </details>
  );
}

function AgentPolicyInline({
  policy,
  onSave,
}: {
  policy: AgentPolicy;
  onSave: (patch: Partial<AgentPolicy>) => void;
}) {
  type BooleanAgentPolicyKey =
    | 'directorCanIntervene'
    | 'directorCanPatchScene'
    | 'directorCanUpdateCharacters'
    | 'directorCanProposeOutline'
    | 'directorCanAutoApplyOutline'
    | 'designerCanPlanCurrentChapter'
    | 'auditorCanBlockDrift'
    | 'writerCanOnlyUseEvents';
  const rows: Array<{
    key: BooleanAgentPolicyKey;
    label: string;
    desc: string;
    danger?: boolean;
  }> = [
    { key: 'directorCanIntervene', label: 'Director 可干预跑偏', desc: '演绎偏离章节目标时，可注入纠偏事件或收束指令。' },
    { key: 'directorCanPatchScene', label: 'Director 可改场景', desc: '允许落库地点、张力、场景描述等运行态补丁。' },
    { key: 'directorCanUpdateCharacters', label: 'Director 可改人物档案', desc: '允许根据已发生事实写入等级、装备、状态、关系变化。' },
    { key: 'directorCanProposeOutline', label: 'Director 可提方向提案', desc: '可把你的沟通整理成正典、大纲和本章方向修改。' },
    { key: 'directorCanAutoApplyOutline', label: 'Director 自动应用纲要', desc: '高风险：允许不经确认直接改正典/大纲。默认关闭。', danger: true },
    { key: 'designerCanPlanCurrentChapter', label: '剧情设计师可出本章设计', desc: '允许生成当前章拍点、事件刺激和设定护栏。' },
    { key: 'auditorCanBlockDrift', label: '设定审核可阻断越界', desc: '允许指出并阻断旧稿污染、信息越界和能力凭空到账。' },
    { key: 'writerCanOnlyUseEvents', label: 'Writer 只写已发生事件', desc: 'Writer 不主动推进未演绎的大节点。' },
  ];

  return (
    <details className="mt-2 rounded-md border bg-background/75 p-2">
      <summary className="cursor-pointer list-none">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[11px] font-medium">Agent 权限</div>
            <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
              导演干预、纲要提案、人物归档、写作边界
            </div>
          </div>
          <Badge variant="outline" className="shrink-0 text-[10px]">
            {policy.directorMode === 'plot_led' ? '强控' : policy.directorMode === 'character_led' ? '角色驱动' : '平衡'}
          </Badge>
        </div>
      </summary>
      <div className="mt-2 space-y-2">
        <div className="rounded-md bg-muted/45 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
          这里是产品级 Agent 工作方式，不写单本小说设定。具体世界观、等级、神话、恋爱、悬疑、商战规则写进“总纲补充”或素材库。
        </div>
        <div className="grid gap-2">
          <label className="grid gap-1 text-[10px] text-muted-foreground">
            <span>Director 调度模式</span>
            <select
              className="h-8 rounded-md border bg-background px-2 text-xs text-foreground"
              value={policy.directorMode}
              onChange={(event) => onSave({ directorMode: event.target.value as AgentPolicy['directorMode'] })}
            >
              <option value="character_led">角色驱动：更尊重演员自发反应</option>
              <option value="balanced">平衡：剧情目标与角色自发并重</option>
              <option value="plot_led">剧情强控：更主动纠偏和推节点</option>
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1 text-[10px] text-muted-foreground">
              <span>题材适配</span>
              <select
                className="h-8 rounded-md border bg-background px-2 text-xs text-foreground"
                value={policy.genreAdaptation}
                onChange={(event) => onSave({ genreAdaptation: event.target.value as AgentPolicy['genreAdaptation'] })}
              >
                <option value="genre_aware">读取项目题材语法</option>
                <option value="universal">保持通用</option>
              </select>
            </label>
            <label className="grid gap-1 text-[10px] text-muted-foreground">
              <span>演员沉浸</span>
              <select
                className="h-8 rounded-md border bg-background px-2 text-xs text-foreground"
                value={String(policy.actorImmersionLevel)}
                onChange={(event) => onSave({ actorImmersionLevel: Number(event.target.value) as AgentPolicy['actorImmersionLevel'] })}
              >
                <option value="1">1 / 5：工具式行动</option>
                <option value="2">2 / 5：轻度人设</option>
                <option value="3">3 / 5：稳定角色</option>
                <option value="4">4 / 5：深度代入</option>
                <option value="5">5 / 5：方法派演员</option>
              </select>
            </label>
            <label className="grid gap-1 text-[10px] text-muted-foreground">
              <span>演员自主性</span>
              <select
                className="h-8 rounded-md border bg-background px-2 text-xs text-foreground"
                value={policy.actorAutonomy}
                onChange={(event) => onSave({ actorAutonomy: event.target.value as AgentPolicy['actorAutonomy'] })}
              >
                <option value="reactive">响应式</option>
                <option value="balanced">平衡</option>
                <option value="proactive">主动式</option>
              </select>
            </label>
            <label className="grid gap-1 text-[10px] text-muted-foreground">
              <span>演员记忆边界</span>
              <select
                className="h-8 rounded-md border bg-background px-2 text-xs text-foreground"
                value={policy.actorMemoryScope}
                onChange={(event) => onSave({ actorMemoryScope: event.target.value as AgentPolicy['actorMemoryScope'] })}
              >
                <option value="strict_current">仅当前已知</option>
                <option value="canon_plus_current">正典加当前</option>
                <option value="deep_profile">深读人物档案</option>
              </select>
            </label>
          </div>
        </div>
        <div className="space-y-1.5">
          {rows.map((row) => (
            <label
              key={row.key}
              className={`flex gap-2 rounded-md border px-2 py-1.5 text-xs ${row.danger ? 'border-amber-300 bg-amber-50/50 dark:border-amber-900/60 dark:bg-amber-950/20' : 'bg-background'}`}
            >
              <input
                type="checkbox"
                className="mt-0.5 h-3.5 w-3.5"
                checked={policy[row.key]}
                onChange={(event) => onSave({ [row.key]: event.target.checked })}
              />
              <span className="min-w-0">
                <span className="block font-medium">{row.label}</span>
                <span className="mt-0.5 block text-[10px] leading-relaxed text-muted-foreground">{row.desc}</span>
              </span>
            </label>
          ))}
        </div>
        <details className="rounded-md border bg-muted/20 p-2">
          <summary className="cursor-pointer list-none text-[11px] font-medium">
            岗位补充
          </summary>
          <div className="mt-2 space-y-2">
            {([
              ['directorCustomBrief', 'Director 补充', '例如：更重视角色因果链，不要为了爽点牺牲人物逻辑。'],
              ['designerCustomBrief', '剧情设计师补充', '例如：每次设计都先识别题材，再给当前章可演绎刺激。'],
              ['actorCustomBrief', '演员补充', '例如：角色先有误判、恐惧、欲望，再有行动。'],
              ['writerCustomBrief', 'Writer 补充', '例如：正文优先写选择和后果，少写说明书。'],
              ['auditorCustomBrief', '审核补充', '例如：重点抓信息越界、旧稿污染、关系突变。'],
            ] as Array<[keyof AgentPolicy, string, string]>).map(([key, label, placeholder]) => (
              <label key={key} className="grid gap-1 text-[10px] text-muted-foreground">
                <span>{label}</span>
                <Textarea
                  defaultValue={String(policy[key] ?? '')}
                  placeholder={placeholder}
                  className="min-h-[58px] resize-y text-xs leading-relaxed"
                  onBlur={(event) => {
                    const value = event.target.value.trim();
                    if (value !== String(policy[key] ?? '')) onSave({ [key]: value });
                  }}
                />
              </label>
            ))}
          </div>
        </details>
      </div>
    </details>
  );
}

function PlanningNumberInput({ label, value, onChange }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="min-w-0">
      <span className="mb-1 block text-[10px] text-muted-foreground">{label}</span>
      <Input
        type="number"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-7 px-2 text-xs"
      />
    </label>
  );
}

// ============== 读者评审 ==============
function compactList(items: string[], max = 3): string {
  const picked = items.map((item) => item.trim()).filter(Boolean).slice(0, max);
  return picked.length > 0 ? picked.map((item) => `- ${item}`).join('\n') : '- 无';
}

function reviewToDirective(review: ReaderReview, chapter?: ChapterSummary): string {
  return `【读者评审回流｜单条】
来源：${review.readerName}（严重度 ${review.severity}/5）
当前稿：${chapter?.sceneName ?? '当前章节'}${chapter?.startTurn !== undefined ? `，T${chapter.startTurn}-${chapter.endTurn}` : ''}

导演校准：
- 参考该评审修正下一轮调度，不要直接改写已生成正文。
- 优先处理会影响本章节奏、设定一致性、角色动机和信息权限的问题。
- 如果评审指出剧情突兀、铺垫不足或因果断裂，下一轮必须先补“混乱、反应、通知、误判、组织形成”的过渡事件，再推进结果。
- 如需纠正，请用 Director 注入事件、场景约束或角色选择来让剧情自然回正。

演员约束：
- 角色只能根据已公开信息和自身感知行动，不得知道读者评审内容。
- 演员不得凭空获得未发生的技能、装备、天赋、等级或物品。
- 若评审指出角色语气/动机问题，下一轮让角色用行动或对话补足动机，而不是旁白解释。

评审摘要：
${review.summary}

问题：
${compactList(review.problems)}

建议：
${compactList(review.suggestions)}

回流问题：
${compactList(review.exposedQuestions)}`;
}

function chapterReviewsToDirective(
  chapter: ChapterSummary,
  reviews: ReaderReview[],
  index: number,
  worldState?: WorldState | null
): string {
  const severe = reviews.filter((review) => review.severity >= 4);
  const sourceReviews = severe.length > 0 ? severe : reviews;
  const chapterNo = chapter.chapterNo ?? index + 1;
  const title = chapterTitleForDisplay(worldState, chapterNo, chapter.chapterTitle ?? chapter.sceneName);
  return `【读者评审回流｜当前稿汇总】
当前稿：第 ${chapterNo} 章 · ${title}，${chapterWordCount(chapter)} 字，T${chapter.startTurn ?? '-'}-${chapter.endTurn ?? '-'}
评审数量：${reviews.length}

导演校准：
- 下一轮先消化这些评审，再决定谁行动、是否注入事件、是否触发 Writer。
- 若节奏评审指出本章拖长，优先推进本章钩子或收束，不要继续重复同类群众反应。
- 若评审指出剧情突兀，先补足因果链：前一状态 -> 角色反应 -> 组织/系统信息来源 -> 再出现登记、检测、战斗或奖励。
- 若设定评审指出越界，立刻收紧信息权限、状态变化、装备/技能来源。
- 若文笔评审指出空话，后续 Writer 应减少抽象总结，改用具体动作、物象和对话落点。

演员约束：
- 演员不知道评审文本，只感受到导演给出的场景压力和行为边界。
- 角色行动必须符合当前章边界、已发生事件和角色卡，不允许为修剧情而突然变聪明或知道隐秘设定。
- 所有成长、掉落、技能、装备、天赋变化必须先在事件里真实发生，再更新档案。

重点摘要：
${sourceReviews.map((review) => `- ${review.readerName}（${review.severity}/5）：${review.summary}`).join('\n')}

待处理问题：
${compactList(sourceReviews.flatMap((review) => review.problems), 6)}

建议动作：
${compactList(sourceReviews.flatMap((review) => review.suggestions), 6)}

回流给导演/审核：
${compactList(sourceReviews.flatMap((review) => review.exposedQuestions), 6)}`;
}

function ReaderReviewPanel({ chapters, readerReviews, worldState, scrollRef, fullHeight, onSendToDirector, onRerunReviews, canSend }: {
  chapters: ChapterSummary[];
  readerReviews: Record<string, ReaderReview[]>;
  worldState?: WorldState | null;
  scrollRef: any;
  fullHeight?: boolean;
  onSendToDirector?: (content: string, label?: string) => boolean | Promise<boolean>;
  onRerunReviews?: (chapterId: string) => boolean | Promise<boolean>;
  canSend?: boolean;
}) {
  const [feedbackState, setFeedbackState] = useState<Record<string, 'sending' | 'sent'>>({});
  const [rerunChapterId, setRerunChapterId] = useState<string>('');
  const chapterReviews = chapters
    .map((chapter, index) => ({
      chapter,
      index,
      reviews: readerReviews[chapter.id] ?? chapter.readerReviews ?? [],
    }))
    .filter((item) => item.reviews.length > 0);

  const sendSummaryToDirector = async (
    key: string,
    content: string,
    label: string
  ) => {
    if (!onSendToDirector) return;
    setFeedbackState((state) => ({ ...state, [key]: 'sending' }));
    try {
      const ok = await onSendToDirector(content, label);
      setFeedbackState((state) => {
        const next = { ...state };
        if (ok) {
          next[key] = 'sent';
        } else {
          delete next[key];
        }
        return next;
      });
    } catch {
      setFeedbackState((state) => {
        const next = { ...state };
        delete next[key];
        return next;
      });
      toast.error(`${label}回流失败`);
    }
  };

  const rerunReviews = async (chapterId: string) => {
    if (!onRerunReviews) return;
    setRerunChapterId(chapterId);
    try {
      await onRerunReviews(chapterId);
    } finally {
      setRerunChapterId('');
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {!fullHeight && (
        <div className="px-4 py-2 border-b bg-muted/30 flex items-center gap-2 flex-shrink-0">
          <MessageSquare className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">读者评审</h3>
          <span className="text-xs text-muted-foreground">
            ({chapterReviews.reduce((sum, item) => sum + item.reviews.length, 0)})
          </span>
        </div>
      )}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
      >
        <div className="p-4 space-y-4">
          {chapterReviews.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-8">
              Writer 完成当前稿后，读者评审会出现在这里。
            </div>
          ) : (
            chapterReviews.map(({ chapter, index, reviews }) => {
              const chapterNo = chapter.chapterNo ?? index + 1;
              const title = chapterTitleForDisplay(worldState, chapterNo, chapter.chapterTitle ?? chapter.sceneName);
              return (
              <div key={chapter.id} className="space-y-2">
	                <div className="flex items-center justify-between gap-2 text-sm">
                  <div className="flex items-center gap-2 min-w-0">
                    <BookOpen className="h-4 w-4 text-primary flex-shrink-0" />
                    <span className="font-semibold truncate">
                      第 {chapterNo} 章当前稿 · {title}
                    </span>
                    <Badge variant="outline" className="text-[10px] flex-shrink-0">
                      {chapterWordCount(chapter)} 字
                    </Badge>
                    <span className="text-[11px] text-muted-foreground flex-shrink-0">
                      生成 {formatEventCreatedAt(chapter.createdAt)}
                    </span>
                  </div>
	                  <div className="flex flex-shrink-0 gap-1.5">
	                    <Button
	                      type="button"
	                      size="sm"
	                      variant="outline"
	                      className="h-7 px-2 text-xs"
	                      disabled={rerunChapterId === chapter.id}
	                      onClick={() => rerunReviews(chapter.id)}
	                      title="不重写正文，只用最新读者提示词重新审当前稿，重点抓剧情突兀、铺垫不足和因果断裂"
	                    >
	                      {rerunChapterId === chapter.id ? (
	                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
	                      ) : (
	                        <RotateCcw className="h-3 w-3 mr-1" />
	                      )}
	                      重新评审
	                    </Button>
	                    <Button
	                      type="button"
	                      size="sm"
	                      variant="outline"
	                      className="h-7 px-2 text-xs"
	                      disabled={!canSend || feedbackState[`summary:${chapter.id}`] === 'sending'}
	                      onClick={() => sendSummaryToDirector(
	                        `summary:${chapter.id}`,
	                        chapterReviewsToDirective(chapter, reviews, index, worldState),
	                        '当前稿评审汇总'
	                      )}
	                      title="把当前稿所有读者评审整理成导演校准和演员约束，送入下一轮 Director 指令队列"
	                    >
	                      {feedbackState[`summary:${chapter.id}`] === 'sending' ? (
	                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
	                      ) : feedbackState[`summary:${chapter.id}`] === 'sent' ? (
	                        <CheckCircle2 className="h-3 w-3 mr-1" />
	                      ) : (
	                        <Send className="h-3 w-3 mr-1" />
	                      )}
	                      {feedbackState[`summary:${chapter.id}`] === 'sending'
	                        ? '回流中'
	                        : feedbackState[`summary:${chapter.id}`] === 'sent'
	                          ? '已回流'
	                          : '汇总回流'}
	                    </Button>
	                  </div>
                </div>
                <div className="grid gap-2">
                  {reviews.map((review) => (
                    <ReaderReviewCard
                      key={review.id}
                      review={review}
                      chapter={chapter}
                      canSend={canSend}
                      onSendToDirector={onSendToDirector}
                    />
	                  ))}
	                </div>
	              </div>
            );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function ReaderReviewCard({ review, chapter, onSendToDirector, canSend }: {
  review: ReaderReview;
  chapter?: ChapterSummary;
  onSendToDirector?: (content: string, label?: string) => boolean | Promise<boolean>;
  canSend?: boolean;
}) {
  const [sendState, setSendState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const severityColor =
    review.severity >= 5 ? 'border-red-500 text-red-700 bg-red-50 dark:border-red-700 dark:bg-red-950/30 dark:text-red-300' :
    review.severity >= 4 ? 'border-orange-500 text-orange-700 bg-orange-50 dark:border-orange-700 dark:bg-orange-950/30 dark:text-orange-300' :
    review.severity >= 3 ? 'border-amber-500 text-amber-700 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300' :
    'border-green-500 text-green-700 bg-green-50 dark:border-green-700 dark:bg-green-950/30 dark:text-green-300';

  const sendReviewToDirector = async () => {
    if (!onSendToDirector) return;
    setSendState('sending');
    try {
      const ok = await onSendToDirector(reviewToDirective(review, chapter), `${review.readerName}评审`);
      setSendState(ok ? 'sent' : 'idle');
    } catch {
      setSendState('idle');
      toast.error(`${review.readerName}评审回流失败`);
    }
  };

  return (
    <div className="rounded-md border bg-card p-3 text-sm">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="font-semibold flex items-center gap-2 flex-wrap">
            {review.readerName}
            <Badge variant="outline" className={`text-[10px] ${severityColor}`}>
              严重度 {review.severity}/5
            </Badge>
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">{review.focus}</div>
        </div>
	        <Button
	          type="button"
	          size="sm"
	          variant="outline"
	          className="h-7 px-2 text-xs flex-shrink-0"
	          disabled={!canSend || sendState === 'sending'}
	          onClick={sendReviewToDirector}
	          title="把这条评审整理成 Director 校准指令，并约束下一轮演员行动"
	        >
	          {sendState === 'sending' ? (
	            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
	          ) : sendState === 'sent' ? (
	            <CheckCircle2 className="h-3 w-3 mr-1" />
	          ) : (
	            <Send className="h-3 w-3 mr-1" />
	          )}
	          {sendState === 'sending' ? '回流中' : sendState === 'sent' ? '已回流' : '回流 Director'}
	        </Button>
      </div>

      <div className="text-foreground/90 leading-relaxed">{review.summary}</div>
      {review.praise && (
        <div className="mt-2 text-xs text-green-700 bg-green-50 border border-green-100 rounded px-2 py-1 dark:border-green-900/60 dark:bg-green-950/25 dark:text-green-300">
          有效之处：{review.praise}
        </div>
      )}

      <ReviewList title="问题" items={review.problems} tone="bad" />
      <ReviewList title="建议" items={review.suggestions} tone="good" />
      <ReviewList title="回流给导演/审核" items={review.exposedQuestions} tone="audit" />
    </div>
  );
}

function ReviewList({ title, items, tone }: {
  title: string;
  items: string[];
  tone: 'bad' | 'good' | 'audit';
}) {
  if (!items.length) return null;
  const titleClass =
    tone === 'bad' ? 'text-red-700 dark:text-red-300' :
    tone === 'good' ? 'text-blue-700 dark:text-blue-300' :
    'text-purple-700 dark:text-purple-300';
  return (
    <div className="mt-2">
      <div className={`text-xs font-medium mb-1 ${titleClass}`}>{title}</div>
      <ul className="space-y-1">
        {items.map((item, index) => (
          <li key={index} className="text-xs leading-relaxed text-muted-foreground flex gap-1.5">
            <span className="mt-[7px] h-1 w-1 rounded-full bg-muted-foreground/60 flex-shrink-0" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MaintenanceControls({
  connected,
  isRunning,
  resetting,
  cleaningInvalid,
  canCleanupInvalid,
  currentChapter,
  longFormPlan,
  storyBibleNotes,
  agentPolicy,
  onResetChapter,
  onCleanupInvalid,
  onPlanningSettingsSave,
  onStoryBibleNotesSave,
  onAgentPolicySave,
}: {
  connected: boolean;
  isRunning: boolean;
  resetting: boolean;
  cleaningInvalid: boolean;
  canCleanupInvalid: boolean;
  currentChapter: any;
  longFormPlan: any;
  storyBibleNotes?: string;
  agentPolicy?: Partial<AgentPolicy>;
  onResetChapter: () => void;
  onCleanupInvalid: () => void;
  onPlanningSettingsSave: (settings: {
    targetWordMin: number;
    targetWordMax: number;
    targetTurns: number;
    targetWords: number;
    targetChapters: number;
	  }) => void;
	  onStoryBibleNotesSave: (notes: string) => void;
	  onAgentPolicySave: (patch: Partial<AgentPolicy>) => void;
	}) {
  const policy = normalizeAgentPolicy(agentPolicy);
	  return (
    <div className="space-y-2">
	      <details className="rounded-md border bg-muted/20 p-2.5">
	        <summary className="flex cursor-pointer list-none items-center justify-between gap-2">
	          <span className="flex items-center gap-2 text-sm font-semibold">
	            <Shield className="h-4 w-4 text-primary" />
	            维护操作
	          </span>
	          <span className="text-[10px] text-muted-foreground">重置 / 清理</span>
	        </summary>
	        <div className="mt-2 grid grid-cols-2 gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={onResetChapter}
            disabled={resetting || cleaningInvalid || isRunning || !connected}
            title={isRunning ? '请先停止演绎再重置本章' : '只清空当前章节的事件、正文、评审和导演设计'}
          >
            {resetting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="mr-1 h-3.5 w-3.5" />}
            重置本章
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={onCleanupInvalid}
            disabled={resetting || cleaningInvalid || isRunning || !canCleanupInvalid}
            title="保留当前正文稿，清理旧事件日志、同章历史稿和旧评审"
          >
            {cleaningInvalid ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Shield className="mr-1 h-3.5 w-3.5" />}
            清理失效
          </Button>
        </div>
      </details>

	      <details className="rounded-md border bg-background/70 p-2.5">
	        <summary className="flex cursor-pointer list-none items-center justify-between gap-2">
	          <span className="flex items-center gap-2 text-sm font-semibold">
	            <BookMarked className="h-4 w-4 text-primary" />
		            项目规则与 Agent
	          </span>
	          <span className="text-[10px] text-muted-foreground">容量 / 总纲 / Agent</span>
	        </summary>
        {currentChapter ? (
          <div className="mt-2 space-y-2">
            <PlanningSettingsInline
              key={[
                currentChapter.chapterNo,
                currentChapter.targetWordMin,
                currentChapter.targetWordMax,
                currentChapter.targetTurns,
                longFormPlan?.targetWords,
                longFormPlan?.targetChapters,
              ].join(':')}
              currentChapter={currentChapter}
              longFormPlan={longFormPlan}
              onSave={onPlanningSettingsSave}
            />
	            <StoryBibleSupplementInline
	              key={`story-bible-notes:${storyBibleNotes ?? ''}`}
	              value={storyBibleNotes ?? ''}
	              onSave={onStoryBibleNotesSave}
	            />
	            <AgentPolicyInline policy={policy} onSave={onAgentPolicySave} />
	          </div>
        ) : (
          <div className="mt-2 rounded-md border bg-muted/30 px-2 py-2 text-[11px] text-muted-foreground">
            暂无当前章节，先创建或切换章节后再调整作品规划。
          </div>
        )}
      </details>
    </div>
  );
}

// ============== 干预面板 ==============
function InterventionPanel({
  directorLvl, onLvlChange,
  worldState, worldSceneInput, setWorldSceneInput, onWorldEdit,
  completedChapters, currentChapter, storyDesign,
  onPacingModeChange, onPlanningSettingsSave, onStoryBibleNotesSave, onAgentPolicySave,
  onRetreatChapter, onAdvanceChapter,
  onResetChapter, onCleanupInvalid, onShowView,
  currentView, assetCount, lessonsCount, chapterCount, logCount, outlinePending,
  connected, isRunning, checkingModel, resetting, cleaningInvalid, canCleanupInvalid,
  eventsCount, chapterProgress, reviewCount,
}: any) {
  const currentChapterDesign =
    storyDesign &&
    currentChapter &&
    storyDesign.chapterNo === currentChapter.chapterNo
      ? storyDesign
      : null;
  const longFormPlan = worldState?.longFormPlan;
  const targetTurns = Math.max(1, Number(currentChapter?.targetTurns ?? 8));
  const chapterHasEnoughEvents = !!currentChapter && (chapterProgress ?? 0) >= targetTurns;

  return (
    <div className="p-3 space-y-2">
      <WorkspaceNavigator
        currentView={currentView}
        currentChapter={currentChapter}
        currentChapterDesign={currentChapterDesign}
        eventsCount={eventsCount ?? 0}
        chapterProgress={chapterProgress ?? 0}
        chapterTargetTurns={targetTurns}
        completedCount={completedChapters?.length ?? 0}
        reviewCount={reviewCount ?? 0}
        assetCount={assetCount ?? 0}
        lessonsCount={lessonsCount ?? 0}
        chapterCount={chapterCount ?? 0}
        logCount={logCount ?? 0}
        outlinePending={!!outlinePending}
        onShowView={onShowView}
      />

      <section className="rounded-md border bg-card p-2.5">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 flex-shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-xs font-semibold">
              {currentChapter
                ? `第 ${currentChapter.chapterNo} 章 · ${normalizeChapterTitle(currentChapter.title, currentChapter.chapterNo)}`
                : '当前章'}
            </h3>
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              {chapterProgress ?? 0}/{targetTurns} 轮 · {eventsCount ?? 0} 事件 · {completedChapters?.length ?? 0} 正文
            </div>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            onClick={onRetreatChapter}
            disabled={!connected || isRunning || !currentChapter || currentChapter.chapterNo <= 1}
            title="上一章"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            onClick={onAdvanceChapter}
            disabled={!connected || isRunning || !currentChapter}
            title="下一章"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
        {chapterHasEnoughEvents && (
          <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/25 dark:text-amber-200">
            已到 {chapterProgress}/{targetTurns} 轮收束点。下一步应生成正文，别再追加演绎事件。
          </div>
        )}
      </section>

      {(() => {
        const pacingOptions = [
          { key: 'fast', label: '快', desc: '2-3 轮推进主线' },
          { key: 'balanced', label: '平衡', desc: '4-6 轮推进主线' },
          { key: 'slow', label: '慢', desc: '8-15 轮推进主线' },
        ] as const;
        const currentPacing =
          pacingOptions.find((item) => item.key === worldState?.pacingMode) ??
          pacingOptions.find((item) => item.key === 'balanced')!;
        return (
          <details className="rounded-md border bg-muted/20 p-2.5">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm font-semibold">
                <Activity className="h-4 w-4 text-primary" />
                演绎偏好
              </span>
              <span className="text-[10px] text-muted-foreground">
                导演 {directorLvl}/5 · {currentPacing.label}
              </span>
            </summary>
            <div className="mt-3 space-y-3">
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">导演介入</span>
                  <Badge variant="outline" className="text-[10px]">{directorLvl}/5</Badge>
                </div>
                <Slider
                  value={[directorLvl]}
                  min={1} max={5} step={1}
                  onValueChange={(v) => onLvlChange(v[0])}
                />
                <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                  <span>少干预</span>
                  <span>平衡</span>
                  <span>强控场</span>
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">推进速度</span>
                  <Badge variant="outline" className="text-[10px]">{currentPacing.label}</Badge>
                </div>
                <div className="grid grid-cols-3 gap-1">
                  {pacingOptions.map((mode) => (
                    <button
                      key={mode.key}
                      type="button"
                      onClick={() => onPacingModeChange(mode.key)}
                      className={`rounded-md border px-2 py-1.5 text-center transition-colors ${
                        (worldState?.pacingMode ?? 'balanced') === mode.key
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-muted text-muted-foreground hover:bg-accent'
                      }`}
                      title={mode.desc}
                    >
                      <div className="text-xs font-medium">{mode.label}</div>
                      <div className="text-[9px] opacity-80">{mode.desc}</div>
                    </button>
                  ))}
                </div>
                {worldState?.turnsSinceLastMain !== undefined && (
                  <div className="mt-1.5 text-[10px] text-muted-foreground">
                    距上次主线推进：{worldState.turnsSinceLastMain} 轮
                  </div>
                )}
              </div>
            </div>
          </details>
        );
      })()}

      <div className="px-0.5 pt-1 text-[10px] font-medium uppercase text-muted-foreground">高级设置</div>
      <MaintenanceControls
        connected={connected}
        isRunning={isRunning}
        resetting={!!resetting}
        cleaningInvalid={!!cleaningInvalid}
        canCleanupInvalid={!!canCleanupInvalid}
        currentChapter={currentChapter}
        longFormPlan={longFormPlan}
        storyBibleNotes={worldState?.storyBibleNotes ?? ''}
        agentPolicy={worldState?.agentPolicy}
	        onResetChapter={onResetChapter}
	        onCleanupInvalid={onCleanupInvalid}
	        onPlanningSettingsSave={onPlanningSettingsSave}
        onStoryBibleNotesSave={onStoryBibleNotesSave}
        onAgentPolicySave={onAgentPolicySave}
      />

      <details className="rounded-md border bg-muted/20 p-2.5">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Globe className="h-4 w-4 text-primary" />
            场景与世界观
          </span>
          <span className="text-[10px] text-muted-foreground">
            {worldState?.sceneName ?? '当前场景'}
          </span>
        </summary>
        <div className="mt-3 space-y-3">
          {worldState?.worldLore && (
            <div>
              <div className="mb-1.5 text-xs font-medium">世界观设定</div>
              <details className="group rounded-md border bg-background/70 px-2.5 py-2">
                <summary className="cursor-pointer list-none text-xs text-primary hover:underline">
                  {worldState.worldLore.prelude?.slice(0, 60) || worldState.worldLore.premise?.slice(0, 60) || '点击展开'}
                  <span className="ml-1 text-muted-foreground group-open:hidden">…</span>
                </summary>
              <div className="mt-2 space-y-2 text-xs">
                {worldState.worldLore.premise && (
                  <div>
                    <div className="font-medium text-foreground">故事前提</div>
                    <div className="text-muted-foreground">{worldState.worldLore.premise}</div>
                  </div>
                )}
                {worldState.worldLore.worldBackground && (
                  <div>
                    <div className="font-medium text-foreground">世界背景</div>
                    <div className="text-muted-foreground leading-relaxed">{worldState.worldLore.worldBackground}</div>
                  </div>
                )}
                {worldState.worldLore.timeline && (
                  <div>
                    <div className="font-medium text-foreground">时间线</div>
                    <div className="text-muted-foreground">{worldState.worldLore.timeline}</div>
                  </div>
                )}
                {worldState.worldLore.geography?.length > 0 && (
                  <div>
                    <div className="font-medium text-foreground">重要地点</div>
                    <ul className="text-muted-foreground space-y-0.5 ml-3 list-disc">
                      {worldState.worldLore.geography.map((g, i) => <li key={i}>{g}</li>)}
                    </ul>
                  </div>
                )}
                {worldState.worldLore.factions?.length > 0 && (
                  <div>
                    <div className="font-medium text-foreground">势力</div>
                    <div className="space-y-1">
                      {worldState.worldLore.factions.map((f, i) => (
                        <div key={i} className="p-1.5 rounded border bg-muted/30">
                          <div className="flex items-center gap-1">
                            <span className="font-medium">{f.name}</span>
                            <Badge variant="outline" className={`text-[9px] ${
                              f.stance === '敌对' ? 'border-red-500 text-red-700' :
                              f.stance === '友好' ? 'border-green-500 text-green-700' : ''
                            }`}>{f.stance}</Badge>
                          </div>
                          <div className="text-muted-foreground mt-0.5">{f.description}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {worldState.worldLore.rules?.length > 0 && (
                  <div>
                    <div className="font-medium text-foreground">世界规则</div>
                    <ul className="text-muted-foreground space-y-0.5 ml-3 list-disc">
                      {worldState.worldLore.rules.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                  </div>
                )}
                {worldState.worldLore.themes?.length > 0 && (
                  <div>
                    <div className="font-medium text-foreground">主题</div>
                    <div className="flex flex-wrap gap-1">
                      {worldState.worldLore.themes.map((t, i) => (
                        <Badge key={i} variant="outline" className="text-[10px]">{t}</Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </details>
            </div>
          )}

          <div>
            <div className="mb-1.5 text-xs font-medium">场景微调</div>
            <div className="mb-2 space-y-1 text-xs text-muted-foreground">
              <div>场景：<span className="text-foreground">{worldState?.sceneName ?? '-'}</span></div>
              <div>位置：<span className="text-foreground">{worldState?.location ?? '-'}</span></div>
              <div>时间：<span className="text-foreground">{worldState?.timeOfDay ?? '-'}</span></div>
            </div>
            <Textarea
              value={worldSceneInput}
              onChange={(e) => setWorldSceneInput(e.target.value)}
              placeholder="只修正当前场景描述，不改长期世界观"
              className="min-h-[60px] resize-none text-xs"
            />
            <Button size="sm" variant="outline" className="mt-2 w-full" onClick={onWorldEdit} disabled={!worldSceneInput.trim()}>
              应用场景补丁
            </Button>
          </div>
        </div>
      </details>

    </div>
  );
}
