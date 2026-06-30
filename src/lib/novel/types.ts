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

export interface CharacterPersona {
  background: string;
  personality: string[];
  goals: string[];
  stance: string;
  speechStyle: string;
  attributes?: Record<string, number>;
  skills?: string[];
  equipment?: string[];
}

export interface CharacterState {
  emotion: string;
  location: string;
  relationships: Record<string, { value: number; note: string }>;
  hp?: number;
  mp?: number;
  level?: number;
  buffs?: string[];
}

export interface Character {
  id: string;
  name: string;
  role: 'protagonist' | 'antagonist' | 'npc';
  persona: CharacterPersona;
  currentState: CharacterState;
}

export interface PlotNode {
  index: number;
  title: string;
  description: string;
  targetTurn?: number;
  completed: boolean;
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
  plotNodes?: PlotNode[];        // 大纲解析出的剧情节点，供 Director 作为骨架
  writerHint?: string;           // 来自大纲的额外风格提示
}

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
  | { type: 'writer:done'; chapterId: string; content: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export type SocketInEvent =
  | { type: 'engine:start'; projectId: string }
  | { type: 'engine:pause' }
  | { type: 'engine:resume' }
  | { type: 'engine:stop' }
  | { type: 'director:command'; content: string }
  | { type: 'world:edit'; patch: Partial<WorldState> }
  | { type: 'character:edit'; characterId: string; patch: Partial<CharacterState> }
  | { type: 'writer:rewrite'; chapterId: string; content: string };
