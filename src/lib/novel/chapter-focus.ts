import type { ChapterFocus, PlotNode, WorldState } from './types';
import { CHAPTER_WORD_TARGET_MAX, CHAPTER_WORD_TARGET_MIN } from './chapter-policy';
import { ensureLongFormPlan } from './long-form-plan';

function firstIncompleteNode(nodes: PlotNode[] = []): PlotNode | undefined {
  return nodes.find((node) => !node.completed);
}

function stageForChapterTurn(chapterTurn: number): string {
  return chapterTurn < 3 ? '铺垫' : chapterTurn < 7 ? '冲突' : '章末钩子';
}

function inferChapterNo(worldState: WorldState): number {
  const explicit = worldState.currentChapter?.chapterNo;
  if (explicit && explicit > 0) return explicit;
  return 1;
}

export function resolveChapterStartTurn(
  worldState: WorldState,
  chapter: Partial<ChapterFocus> | undefined = worldState.currentChapter
): number {
  if (typeof chapter?.startTurn === 'number') return chapter.startTurn;
  return (chapter?.chapterNo ?? inferChapterNo(worldState)) === 1 ? 0 : worldState.turn;
}

function genericChapterFocus(node: PlotNode | undefined, worldState: WorldState, chapterNoOverride?: number): ChapterFocus {
  const chapterNo = chapterNoOverride && chapterNoOverride > 0 ? chapterNoOverride : inferChapterNo(worldState);
  const title = node?.title ? node.title : `第 ${chapterNo} 章方向待定`;
  const startTurn = resolveChapterStartTurn(worldState, {
    chapterNo,
    startTurn: worldState.currentChapter?.startTurn,
  });
  const chapterTurn = Math.max(0, worldState.turn - startTurn);
  const requestedTurns = node?.estimatedTurns ?? 8;
  const plan = worldState.longFormPlan;
  const nodeDirection = node ? `参考阶段方向：“${node.title}”。${node.description}` : worldState.sceneDescription;
  return {
    chapterNo,
    title,
    goal: nodeDirection,
    scope: '本章只锁定方向、边界和强钩子；具体事件由 Director 和角色演绎自然生成，不把阶段节点当章节名。',
    stage: stageForChapterTurn(chapterTurn),
    startTurn,
    activeNodeIndexes: node ? [node.index] : [],
    targetTurns: Math.max(6, Math.min(requestedTurns, 10)),
    targetWordMin: plan?.chapterWordMin ?? CHAPTER_WORD_TARGET_MIN,
    targetWordMax: plan?.chapterWordMax ?? CHAPTER_WORD_TARGET_MAX,
    beats: [
      '用场景压力启动角色反应，而不是排队发言。',
      '让群众或临时配角制造外部压力。',
      '让主角做出符合当前认知和能力边界的选择。',
      '保留一个需要下一段继续读的钩子。',
    ],
    constraints: [
      '只围绕当前章任务推进。',
      '不要把后续大节点提前兑现。',
      '角色不得知道自己尚未获得的信息。',
    ],
  };
}

export function ensureChapterFocus(worldState: WorldState): WorldState {
  const plannedWorldState = ensureLongFormPlan(worldState);
  const node = firstIncompleteNode(plannedWorldState.plotNodes);
  const chapterNo = inferChapterNo(worldState);

  if (plannedWorldState.currentChapter) {
    const currentChapterNo = plannedWorldState.currentChapter.chapterNo ?? 1;
    const startTurn = resolveChapterStartTurn(plannedWorldState, {
      chapterNo: currentChapterNo,
      startTurn: plannedWorldState.currentChapter.startTurn,
    });
    const chapterTurn = Math.max(0, plannedWorldState.turn - startTurn);
    const targetTurns = Math.max(
      1,
      Number(plannedWorldState.currentChapter.targetTurns || node?.estimatedTurns || 8)
    );
    return {
      ...plannedWorldState,
      currentChapter: {
        ...plannedWorldState.currentChapter,
        startTurn,
        stage: stageForChapterTurn(chapterTurn),
        targetTurns,
        targetWordMin: plannedWorldState.currentChapter.targetWordMin ?? plannedWorldState.longFormPlan?.chapterWordMin ?? CHAPTER_WORD_TARGET_MIN,
        targetWordMax: plannedWorldState.currentChapter.targetWordMax ?? plannedWorldState.longFormPlan?.chapterWordMax ?? CHAPTER_WORD_TARGET_MAX,
      },
      pacingMode: plannedWorldState.pacingMode ?? 'slow',
      turnsSinceLastMain: plannedWorldState.turnsSinceLastMain ?? 0,
    };
  }

  return {
    ...plannedWorldState,
    currentChapter: genericChapterFocus(node, plannedWorldState),
    pacingMode: plannedWorldState.pacingMode ?? 'slow',
    turnsSinceLastMain: plannedWorldState.turnsSinceLastMain ?? 0,
  };
}

export function advanceChapterFocus(worldState: WorldState): WorldState {
  const focused = ensureChapterFocus(worldState);
  const nextChapterNo = Math.max(1, (focused.currentChapter?.chapterNo ?? 1) + 1);
  const activeIndexes = new Set(focused.currentChapter?.activeNodeIndexes ?? []);
  const plotNodes = focused.plotNodes?.map((node) =>
    activeIndexes.has(node.index) ? { ...node, completed: true } : node
  );
  const nextNode = firstIncompleteNode(plotNodes);
  const baseWorld = {
    ...focused,
    plotNodes,
    currentChapter: undefined,
    storyDesign: undefined,
    turnsSinceLastMain: 0,
  };

  return ensureChapterFocus({
    ...baseWorld,
    currentChapter: genericChapterFocus(nextNode, baseWorld, nextChapterNo),
  });
}

export function retreatChapterFocus(worldState: WorldState): WorldState {
  const focused = ensureChapterFocus(worldState);
  const chapterNo = focused.currentChapter?.chapterNo ?? 1;
  if (chapterNo <= 1) return focused;

  const previousIndex = Math.max(1, chapterNo - 1);
  const plotNodes = focused.plotNodes?.map((node) =>
    node.index >= previousIndex ? { ...node, completed: false } : node
  );
  const previousNode = plotNodes?.find((node) => node.index === previousIndex) ?? firstIncompleteNode(plotNodes);
  const baseWorld = {
    ...focused,
    plotNodes,
    currentChapter: undefined,
    storyDesign: undefined,
    turnsSinceLastMain: 0,
  };

  return ensureChapterFocus({
    ...baseWorld,
    currentChapter: genericChapterFocus(previousNode, baseWorld, previousIndex),
  });
}

export function chapterFocusText(worldState: WorldState): string {
  const focused = ensureChapterFocus(worldState);
  const chapter = focused.currentChapter;
  if (!chapter) return '当前章：未设置';
  return `第 ${chapter.chapterNo} 章《${chapter.title}》
目标：${chapter.goal}
范围：${chapter.scope}
阶段：${chapter.stage}
正文目标：${chapter.targetWordMin ?? CHAPTER_WORD_TARGET_MIN}-${chapter.targetWordMax ?? CHAPTER_WORD_TARGET_MAX} 字
本章节拍：
${chapter.beats.map((beat, index) => `${index + 1}. ${beat}`).join('\n')}
设定护栏：
${chapter.constraints.map((item) => `- ${item}`).join('\n')}`;
}
