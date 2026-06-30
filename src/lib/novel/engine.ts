/**
 * Engine — 演绎编排循环
 * 
 * 每个 Turn 的执行流程：
 *   1. 加载 World State + 角色 + 最近事件 + 待处理指令
 *   2. Director 决策：选谁行动、是否注入事件、是否触发 Writer
 *   3. Director 注入事件（如有）→ 写入事件日志
 *   4. 对每个被选中的角色：
 *      a. Character Agent 生成行为提案
 *      b. (多个角色时) Director 仲裁
 *      c. 写入事件日志 + 更新角色状态
 *   5. 应用用户干预（World State edit / Director command）
 *   6. 更新张力、Turn 自增
 *   7. 持久化 World State
 *   8. 如果触发 Writer：聚合本场景事件 → 流式生成文本 → 保存 Chapter
 *   9. 推送 socket.io 事件
 */

import { v4 as uuid } from 'uuid';
import type { Socket } from 'socket.io';
import type {
  Character,
  NovelEvent,
  SocketOutEvent,
  WorldState,
} from './types';
import {
  WorldManager,
} from './world-state';
import {
  directorDecide,
  directorArbitrate,
  type CharacterProposal,
} from './agents/director';
import { characterPropose, commitProposal } from './agents/character';
import { writerStream, saveChapter } from './agents/writer';

const TURN_DELAY_MS = 4000;      // 每个 turn 之间的间隔，给前端时间消化 + 避免 LLM 限流
const WRITER_CHUNK_THRESHOLD = 8; // 累积多少事件触发 Writer（即使 Director 没主动触发）

/** 判断当前 Turn 是否达到节点完成阈值 */
function nextWorld_turnReached(currentTurn: number, threshold: number, node: any): boolean {
  // 如果当前 Turn 超过 targetTurn + estimatedTurns，认为节点应该完成
  return currentTurn >= threshold;
}

export interface EngineCallbacks {
  emit: (event: SocketOutEvent) => void;
  isPaused: () => boolean;
  isStopped: () => boolean;
  waitWhilePaused: () => Promise<void>;
}

export class NovelEngine {
  private wm: WorldManager;
  private cb: EngineCallbacks;
  private chapterStartTurn = 0;
  private chapterBuffer: NovelEvent[] = [];
  private lastWriterText = '';

  constructor(projectId: string, cb: EngineCallbacks) {
    this.wm = new WorldManager(projectId);
    this.cb = cb;
  }

  /** 主循环：从当前 turn 开始演绎，直到暂停/停止/触发 Writer 结束场景 */
  async run(maxTurns = 30): Promise<void> {
    await this.wm.setProjectStatus('running');
    this.emitLog('info', '演绎开始');

    let turnCount = 0;
    while (turnCount < maxTurns && !this.cb.isStopped()) {
      await this.cb.waitWhilePaused();
      if (this.cb.isStopped()) break;

      try {
        const shouldStop = await this.runOneTurn();
        if (shouldStop) break;
      } catch (err: any) {
        this.emitLog('error', `Turn 执行失败：${err.message}`);
        await sleep(1000);
      }

      turnCount++;
      await sleep(TURN_DELAY_MS);
    }

    await this.wm.setProjectStatus('paused');
    this.emitLog('info', `演绎暂停/结束，共执行 ${turnCount} 个 turn`);
  }

  /** 执行单个 Turn，返回是否应该停止 */
  private async runOneTurn(): Promise<boolean> {
    const { worldState, characters } = await this.wm.loadProject();
    const recentEvents = await this.wm.getRecentEvents(20);
    const pendingDirectives = await this.wm.consumePendingDirectives();

    // === 1. Director 决策 ===
    this.emitLog('info', `Turn ${worldState.turn + 1}: Director 决策中…`);
    const decision = await directorDecide(
      this.wm,
      worldState,
      characters,
      recentEvents,
      pendingDirectives
    );

    if (decision.commentary) {
      this.emitLog('info', `Director: ${decision.commentary}`);
    }

    // === 2. 注入 Director 事件 ===
    for (const inj of decision.injections ?? []) {
      const event = await this.wm.appendEvent({
        turn: worldState.turn + 1,
        agentId: null,
        agentName: 'Director',
        type: inj.type as any,
        content: inj.content,
        target: inj.target ?? null,
        emotion: inj.emotion ?? null,
        status: 'confirmed',
      });
      this.chapterBuffer.push(event);
      this.cb.emit({ type: 'event:new', event });
      this.emitLog('info', `Director 注入: ${event.content}`);
    }

    // === 3. 角色行动 ===
    const presentChars = characters.filter((c) =>
      worldState.presentCharacterIds.includes(c.id)
    );

    // 用 Director 决策中的 selected 顺序
    let selectedChars: Character[] = decision.selected
      .map((p) => presentChars.find((c) => c.id === p.characterId))
      .filter(Boolean) as Character[];

    if (selectedChars.length === 0) {
      // fallback: 让前 2 个在场角色行动
      selectedChars = presentChars.slice(0, 2);
    }

    const proposals: CharacterProposal[] = [];
    for (const c of selectedChars) {
      await this.cb.waitWhilePaused();
      if (this.cb.isStopped()) return true;

      this.emitLog('info', `Turn ${worldState.turn + 1}: ${c.name} 思考中…`);
      const proposal = await characterPropose(
        this.wm,
        c,
        worldState,
        characters,
        recentEvents.concat(this.chapterBuffer.slice(-5))
      );
      proposals.push(proposal);
      this.emitLog(
        'info',
        `${c.name} 提案: [${proposal.type}] ${proposal.content}`
      );
    }

    // === 4. 仲裁（如果多个角色都行动了） ===
    let finalProposals = proposals;
    if (proposals.length > 1) {
      // 检查是否冲突：简单 heuristic，看 target 是否互相指向
      const hasConflict = proposals.some(
        (p, i) =>
          p.target &&
          proposals.some(
            (q, j) =>
              i !== j &&
              q.target === p.characterName &&
              p.target === q.characterName
          )
      );
      if (hasConflict) {
        this.emitLog('info', 'Director 仲裁中…');
        const arb = await directorArbitrate(
          this.wm,
          worldState,
          proposals,
          recentEvents
        );
        finalProposals = proposals.filter((p) =>
          arb.selectedIds.includes(p.characterId)
        );
        if (arb.commentary) {
          this.emitLog('info', `Director 仲裁: ${arb.commentary}`);
        }
      }
    }

    // === 5. 提交事件 + 更新角色状态 ===
    const contextIds = this.chapterBuffer
      .slice(-3)
      .map((e) => e.id);
    for (const p of finalProposals) {
      await this.cb.waitWhilePaused();
      if (this.cb.isStopped()) return true;

      const { event, updatedCharacter } = await commitProposal(
        this.wm,
        p,
        worldState.turn + 1,
        contextIds
      );
      this.chapterBuffer.push(event);
      this.cb.emit({ type: 'event:new', event });
      this.cb.emit({ type: 'character:update', character: updatedCharacter });
    }

    // === 6. 更新 World State ===
    // 判断本 Turn 是否推进了主线节点（通过 Director commentary 或 injection 内容判断）
    const directorText = (decision.commentary ?? '') + ' ' + (decision.injections ?? []).map(i => i.content).join(' ');
    const advancedMainNode = /节点|推进|主线|完成/.test(directorText) && /主线|main/i.test(directorText);

    // 节点完成检测：如果 Director 注入的事件提到"完成"某节点，标记完成
    let updatedPlotNodes = worldState.plotNodes;
    if (updatedPlotNodes && updatedPlotNodes.length > 0) {
      const nextNode = updatedPlotNodes.find(n => !n.completed);
      if (nextNode) {
        // 简单 heuristic：如果 Director 注入提到节点标题或"完成"，且当前 Turn 超过 targetTurn + estimatedTurns
        const turnThreshold = (nextNode.targetTurn ?? 0) + (nextNode.estimatedTurns ?? 5);
        const mentionsNode = directorText.includes(nextNode.title) || /节点完成|节点\d+.*完成/.test(directorText);
        if (mentionsNode || nextWorld_turnReached(worldState.turn + 1, turnThreshold, nextNode)) {
          updatedPlotNodes = updatedPlotNodes.map(n =>
            n.index === nextNode.index ? { ...n, completed: true } : n
          );
          this.emitLog('info', `节点完成：${nextNode.title}（${nextNode.nodeType}）`);
        }
      }
    }

    const nextWorld: WorldState = {
      ...worldState,
      turn: worldState.turn + 1,
      tension: Math.max(0, Math.min(10, worldState.tension + decision.tensionDelta)),
      plotNodes: updatedPlotNodes,
      turnsSinceLastMain: advancedMainNode ? 0 : (worldState.turnsSinceLastMain ?? 0) + 1,
      currentMainNodeIndex: updatedPlotNodes?.findIndex(n => n.nodeType === 'main' && !n.completed) ?? worldState.currentMainNodeIndex,
      ...(decision.nextScenePatch ?? {}),
    };
    await this.wm.saveWorldState(nextWorld);
    this.cb.emit({
      type: 'engine:state',
      status: 'running',
      turn: nextWorld.turn,
    });
    this.cb.emit({ type: 'world:update', worldState: nextWorld });

    // === 7. 是否触发 Writer ===
    const shouldWriter =
      decision.triggerWriter || this.chapterBuffer.length >= WRITER_CHUNK_THRESHOLD;
    if (shouldWriter) {
      await this.runWriter(nextWorld, characters);
    }

    return false;
  }

  /** 触发 Writer：把累积事件生成为小说文本 */
  private async runWriter(
    worldState: WorldState,
    characters: Character[]
  ): Promise<void> {
    if (this.chapterBuffer.length === 0) return;

    await this.cb.waitWhilePaused();
    if (this.cb.isStopped()) return;

    const template = await this.wm.getTemplate();
    const events = [...this.chapterBuffer];
    const startTurn = this.chapterStartTurn;
    const endTurn = worldState.turn;

    this.emitLog(
      'info',
      `Writer 生成中（${events.length} 个事件，T${startTurn}-T${endTurn}）…`
    );

    const chapterId = uuid();
    let fullText = '';
    try {
      fullText = await writerStream(
        this.wm,
        {
          template,
          worldSceneName: worldState.sceneName,
          worldSceneDescription: worldState.sceneDescription,
          characters: characters.filter((c) =>
            worldState.presentCharacterIds.includes(c.id)
          ),
          events,
          previousText: this.lastWriterText,
        },
        (chunk) => {
          this.cb.emit({ type: 'writer:chunk', chunk, chapterId });
        }
      );
    } catch (err: any) {
      this.emitLog('error', `Writer 生成失败：${err.message}`);
      return;
    }

    // 保存到数据库
    await saveChapter(this.wm, worldState.sceneName, fullText, startTurn, endTurn);
    this.lastWriterText = fullText;
    this.cb.emit({ type: 'writer:done', chapterId, content: fullText });

    // 重置 buffer
    this.chapterBuffer = [];
    this.chapterStartTurn = worldState.turn + 1;
    this.emitLog('info', `Writer 完成，本段 ${fullText.length} 字`);
  }

  private emitLog(level: 'info' | 'warn' | 'error', message: string) {
    this.cb.emit({ type: 'log', level, message });
    // 同时打 stdout，方便 mini-service 日志
    if (level === 'error') console.error(`[Engine] ${message}`);
    else console.log(`[Engine] ${message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
