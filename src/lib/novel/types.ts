/**
 * NovelStudio 共享类型
 */

export type EventType =
  | 'action'        // 角色行动
  | 'dialogue'      // 角色对话
  | 'state_change'  // 状态变化
  | 'scene_meta'    // 场景元信息（开场、转场、结束）
  | 'director';     // Director 注入事件

export interface NovelEvent {
  id: string;
  turn: number;
  agentId: string | null;
  agentName: string;
  type: EventType;
  content: string;
  target?: string | null;
  emotion?: string | null;
  context?: string | null;
  status: 'proposed' | 'confirmed' | 'rejected';
  createdAt: Date;
}

export interface ReaderReview {
  id: string;
  projectId: string;
  chapterId: string;
  readerId: string;
  readerName: string;
  focus: string;
  severity: number;
  summary: string;
  praise: string;
  problems: string[];
  suggestions: string[];
  exposedQuestions: string[];
  createdAt: Date | string;
}

export interface ChapterFocus {
  chapterNo: number;
  title: string;
  goal: string;
  scope: string;
  stage: string;
  startTurn?: number;
  activeNodeIndexes: number[];
  beats: string[];
  constraints: string[];
  targetTurns: number;
  targetWordMin: number;
  targetWordMax: number;
  manualOutline?: boolean;       // 用户/纲要调整提案确认后的细纲，不再被默认模板覆盖
  outlineUpdatedAt?: string;
  outlineRevisionNote?: string;
}

export interface StoryDesign {
  id: string;
  roleName: string;
  chapterNo: number;
  chapterTitle: string;
  currentBeat: string;
  scenePurpose: string;
  eventSeeds: string[];
  systemConcepts: string[];
  progressionHooks: string[];
  crowdPressure: string[];
  temporaryCast: string[];
  settingGuardrails: string[];
  directorNotes: string[];
  auditQuestions: string[];
  continuityAudit?: {
    status: 'passed' | 'blocked';
    issues: string[];
    repairInstruction: string;
    checkedAt: string;
  };
  updatedAt: string;
}

export interface NovelCraftLesson {
  id: string;
  chapterNo: number;
  sourceChapterId: string;
  sourceSceneName: string;
  summary: string;
  principles: string[];
  directorAdjustments: string[];
  writerGuidelines: string[];
  settingGuardrails: string[];
  severity: number;
  createdAt: string;
}

export interface RoundtableContextSelection {
  includeStoryBible: boolean;
  includeCurrentChapter: boolean;
  includeDirectorDesign: boolean;
  includeCurrentDraft: boolean;
  includeCurrentEvents: boolean;
  includeCharacters: boolean;
  includeAssets: boolean;
  includeEventTrace: boolean;
  selectedChapterNos: number[];
}

export type RoundtableDiscussionMode = 'proposal' | 'internal_review';

export type NovelAssetCategory =
  | 'talent'
  | 'profession'
  | 'skill'
  | 'equipment'
  | 'pet_mount'
  | 'monster_dungeon'
  | 'drop_resource'
  | 'faction_location'
  | 'foreshadow';

export type NovelAssetStatus = 'concept' | 'foreshadow' | 'available' | 'landed' | 'disabled';

export interface NovelAsset {
  id: string;
  name: string;
  category: NovelAssetCategory;
  status: NovelAssetStatus;
  grade?: string;
  summary: string;
  plotUse: string;
  mechanics?: string;
  triggerConditions?: string[];
  rules?: string[];
  linkedCharacters?: string[];
  chapterNo?: number | null;
  source?: 'user' | 'agent' | 'imported';
  updatedAt: string;
}

export interface ChapterSummary {
  id: string;
  chapterNo?: number | null;
  chapterTitle?: string | null;
  sceneName: string;
  content: string;
  wordCount?: number;
  startTurn?: number;
  endTurn?: number;
  createdAt?: Date | string;
  readerReviews?: ReaderReview[];
}

export interface CharacterPersona {
  gender?: string;
  background: string;
  personality: string[];
  goals: string[];
  stance: string;
  speechStyle: string;
  actorNotes?: string;
  identityNotes?: string;
  coreBeliefs?: string[];
  behaviorRules?: string[];
  speechRules?: string[];
  forbiddenRules?: string[];
  attributes?: Record<string, number>;
  skills?: string[];
  equipment?: string[];
  talents?: string[];
  mounts?: string[];
  pets?: string[];
  inventory?: string[];
  titles?: string[];
  profession?: string;
  // === 长篇深度字段 ===
  backstory?: string;          // 详细背景故事（300-500 字）
  growthArc?: string;          // 成长弧线（从哪里来，到哪里去）
  innerConflict?: string;      // 内在冲突/矛盾
  secrets?: string[];          // 角色秘密
  motivations?: string[];      // 动机层次（表层/深层）
  speechHabits?: string[];     // 口头禅/语言习惯
  appearance?: string;         // 外貌特征
  actingTemperature?: number;  // 该角色专属采样温度（0.4-1.2），覆盖全局 actorTemperature；性格越跳脱越放越高，越克制越放越低
  actingModel?: string;        // 该角色专属模型（覆盖全局默认模型）。不同性格的角色可用不同模型扮演，例如冲动角色用更鲜活的大模型、冷静配角用轻量模型
}

export interface CharacterState {
  emotion: string;
  location: string;
  relationships: Record<string, { value: number; note: string }>;
  hp?: number;
  mp?: number;
  level?: number;
  exp?: number;
  nextLevelExp?: number;
  buffs?: string[];
  /** 身体状态：当前伤势/伤口/疼痛等，跨轮持续，防止角色每轮脑补或遗忘。 */
  injuries?: string[];
  /** 身体感受：此刻的身体直觉（如手发烫、腿发软、嗓子干），供角色代入。 */
  bodySensation?: string;
}

export interface Character {
  id: string;
  name: string;
  role: 'protagonist' | 'antagonist' | 'npc';
  persona: CharacterPersona;
  currentState: CharacterState;
}

/** 节点类型：支撑网状叙事 */
export type NodeType = 'main' | 'sub' | 'foreshadow' | 'daily';

export interface PlotNode {
  index: number;
  title: string;
  description: string;
  targetTurn?: number;
  completed: boolean;
  nodeType?: NodeType;          // main=主线 / sub=支线 / foreshadow=伏笔 / daily=日常缓冲
  subNodes?: string[];           // 子节点描述（拆细一个节点为多个阶段）
  priority?: number;             // 优先级 1-5，5=必经主线，1=可选日常
  estimatedTurns?: number;       // 预期持续多少 Turn（主线 8-15，支线 4-8，日常 2-4）
  linkedCharacters?: string[];   // 涉及的角色名
  tensionLevel?: number;         // 该节点张力水平 0-10
}

export interface VolumePlan {
  index: number;
  title: string;
  purpose: string;
  chapterStart: number;
  chapterEnd: number;
  nodeIndexes: number[];
  status: 'pending' | 'active' | 'done';
}

export interface LongFormPlan {
  targetWords: number;
  minWords: number;
  targetChapters: number;
  chapterWordMin: number;
  chapterWordMax: number;
  volumes: VolumePlan[];
  promise: string;
  pacingPrinciples: string[];
}

/** 世界观设定（用于长篇体量的背景支撑） */
export interface WorldLore {
  premise: string;                  // 故事前提/核心命题
  worldBackground: string;          // 世界观背景（300-500 字详细描述）
  geography: string[];              // 重要地点列表（含简述）
  factions: { name: string; description: string; stance: string }[];  // 势力/组织
  rules: string[];                  // 世界规则（魔法体系/科技水平/社会法则）
  themes: string[];                 // 主题与母题
  timeline: string;                 // 故事时间线/历史背景
}

export interface AgentPolicy {
  directorCanIntervene: boolean;          // Director 可在演绎跑偏时注入纠偏事件
  directorCanPatchScene: boolean;         // Director 可调整场景描述、张力、地点等运行态
  directorCanUpdateCharacters: boolean;   // Director 可根据已发生事实维护人物档案
  directorCanProposeOutline: boolean;     // Director 可把用户沟通整理成纲要/正典调整提案
  directorCanAutoApplyOutline: boolean;   // Director 可自动落库纲要/正典修改（高风险，默认关）
  designerCanPlanCurrentChapter: boolean; // 剧情设计师可生成当前章导演设计
  auditorCanBlockDrift: boolean;          // 设定审核可阻止越界设定、旧稿污染和剧情跑偏
  writerCanOnlyUseEvents: boolean;        // Writer 只能把已发生事件写成正文，不主动推进新大节点
  directorMode?: 'character_led' | 'balanced' | 'plot_led'; // 导演调度偏好：角色自发 / 平衡 / 剧情强控
  genreAdaptation?: 'universal' | 'genre_aware'; // 是否主动读取项目题材约定并套用对应叙事语法
  actorImmersionLevel?: 1 | 2 | 3 | 4 | 5; // 演员沉浸深度，越高越像角色本人思考
  actorAutonomy?: 'reactive' | 'balanced' | 'proactive'; // 演员自发行动强度
  actorTemperature?: number; // 角色演员采样温度，越高动作/台词越多样（0.4-1.2）
  actorMemoryScope?: 'strict_current' | 'canon_plus_current' | 'deep_profile'; // 演员可读取的人物信息边界
  directorCustomBrief?: string;       // 项目级 Director 岗位补充，不写具体剧情事实
  designerCustomBrief?: string;       // 项目级剧情设计/体系策划补充，不写具体剧情事实
  actorCustomBrief?: string;          // 项目级演员方法补充，不写具体剧情事实
  writerCustomBrief?: string;         // 项目级 Writer 补充，不写具体剧情事实
  auditorCustomBrief?: string;        // 项目级审核补充，不写具体剧情事实
}

export interface WorldState {
  sceneName: string;
  sceneDescription: string;
  location: string;
  timeOfDay: string;
  presentCharacterIds: string[];
  worldFlags: Record<string, string | number | boolean>;
  tension: number;
  turn: number;
  currentChapter?: ChapterFocus; // 当前章聚焦，Director 只围绕这一章推进
  storyDesign?: StoryDesign;     // 剧情设计师给 Director 的待用情节/事件方案
  assetLibrary?: NovelAsset[];   // 创作资产库：天赋、职业、装备、宠物、技能、副本、伏笔等统一素材
  craftLessons?: NovelCraftLesson[]; // 读者评审沉淀出的小说体系经验
  plotNodes?: PlotNode[];        // 大纲解析出的剧情节点，供 Director 作为骨架
  longFormPlan?: LongFormPlan;   // 长篇体量规划：卷结构、章节容量、节奏纪律
  storyBibleNotes?: string;      // 用户补充的总纲/世界观/卷规划/禁用设定，优先提供给导演与剧情设计师
  agentPolicy?: AgentPolicy;     // 项目级 Agent 权限与干预边界
  canonicalChapterIds?: Record<string, string>; // 每章手动选定的正稿 ID，优先于“最新稿”判定
  eventClosureStatus?: Record<string, 'open' | 'closed'>; // 事件追踪状态：open=开启中/未结束，closed=已关闭/已结束
  writerHint?: string;           // 来自大纲的额外风格提示
  worldLore?: WorldLore;         // 世界观设定（长篇支撑）
  pacingMode?: PacingMode;       // 节奏模式：快推进/平衡/慢热
  currentMainNodeIndex?: number; // 当前主线节点索引
  turnsSinceLastMain?: number;   // 距离上次主线推进多少 Turn（用于节奏控制）
}

export type PacingMode = 'fast' | 'balanced' | 'slow';

export interface WorldTemplate {
  key: string;
  name: string;
  description: string;
  sceneTypes: { name: string; description: string; tensionBoost: number }[];
  narrativeTone: string;
  writerStyleGuide: string;
  defaultAttributes: string[];
  defaultSkills: string[];
  initialScene: {
    name: string;
    description: string;
    location: string;
    timeOfDay: string;
  };
  presetCharacters?: Omit<Character, 'id'>[];
}

export type DirectiveType = 'command' | 'world_state_edit' | 'text_rewrite';

export interface DirectorDirective {
  id: string;
  chapterNo?: number;
  type: DirectiveType;
  content: string;
  status: 'pending' | 'applied' | 'rejected';
}

export type SocketOutEvent =
  | { type: 'engine:state'; status: 'idle' | 'running' | 'paused' | 'ended'; turn: number }
  | { type: 'world:update'; worldState: WorldState }
  | { type: 'character:update'; character: Character }
  | { type: 'event:new'; event: NovelEvent }
  | { type: 'writer:chunk'; chunk: string; chapterId: string }
  | { type: 'writer:done'; chapterId: string; content: string; chapter?: ChapterSummary }
  | { type: 'writer:failed'; chapterId: string; message: string }
  | { type: 'reader:review'; review: ReaderReview }
  | { type: 'designer:update'; design: StoryDesign }
  | { type: 'craft:lesson'; lesson: NovelCraftLesson }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export type SocketInEvent =
  | { type: 'engine:start'; projectId: string; maxTurns?: number }
  | { type: 'engine:pause' }
  | { type: 'engine:resume' }
  | { type: 'engine:stop' }
  | { type: 'auto:chapter'; projectId: string; cycles?: number; turnsPerCycle?: number }
  | { type: 'designer:prepare'; projectId: string }
  | { type: 'chapter:retreat'; projectId: string }
  | { type: 'chapter:advance'; projectId: string }
  | { type: 'chapter:reset'; projectId: string }
  | { type: 'director:command'; content: string; refreshDesign?: boolean; priority?: boolean }
  | { type: 'world:edit'; projectId?: string; patch: Partial<WorldState> }
  | { type: 'character:edit'; projectId?: string; characterId: string; patch: Partial<CharacterState>; personaPatch?: Partial<CharacterPersona> }
  | { type: 'writer:rewrite'; chapterId: string; content: string };
