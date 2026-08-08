import { NextRequest, NextResponse } from 'next/server';
import { buildCharacterSystemPrompt, buildCharacterUserPrompt } from '@/lib/novel/agents/character';
import { actorPolicyText, normalizeAgentPolicy } from '@/lib/novel/agent-policy';
import { ensureChapterFocus, resolveChapterStartTurn } from '@/lib/novel/chapter-focus';
import { WorldManager } from '@/lib/novel/world-state';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; characterId: string }> }
) {
  const { id, characterId } = await params;

  try {
    const wm = new WorldManager(id);
    const { worldState, characters, template } = await wm.loadProject();
    const focusedWorld = ensureChapterFocus(worldState);
    const character = characters.find((item) => item.id === characterId);
    if (!character) {
      return NextResponse.json({ error: '人物不存在' }, { status: 404 });
    }

    const chapterStartTurn = resolveChapterStartTurn(focusedWorld, focusedWorld.currentChapter);
    const recentEvents =
      focusedWorld.turn > chapterStartTurn
        ? await wm.getChapterEvents(chapterStartTurn, focusedWorld.turn)
        : await wm.getRecentEvents(8);

    return NextResponse.json({
      ok: true,
      preview: {
        characterId: character.id,
        characterName: character.name,
        actorPolicy: actorPolicyText(focusedWorld),
        actorCustomBrief: normalizeAgentPolicy(focusedWorld.agentPolicy).actorCustomBrief,
        characterActorNotes: String(character.persona.actorNotes ?? '').trim(),
        systemPrompt: buildCharacterSystemPrompt(character, template, focusedWorld),
        userPrompt: buildCharacterUserPrompt(
          character,
          focusedWorld,
          characters,
          recentEvents.slice(-8)
        ),
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || '人物提示词预览生成失败' },
      { status: 500 }
    );
  }
}
