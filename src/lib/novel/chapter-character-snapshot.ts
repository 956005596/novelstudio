import { db } from '../db';
import type { Character, CharacterPersona, CharacterState, WorldState } from './types';

function rowToSnapshotCharacter(row: any): Character {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    persona: JSON.parse(row.persona) as CharacterPersona,
    currentState: JSON.parse(row.currentState) as CharacterState,
  };
}

function chapterNoOf(worldState: WorldState): number | null {
  const chapterNo = worldState.currentChapter?.chapterNo;
  return typeof chapterNo === 'number' && chapterNo > 0 ? chapterNo : null;
}

export async function ensureChapterCharacterSnapshot(
  projectId: string,
  worldState: WorldState,
  characters: Character[],
  options: { overwrite?: boolean } = {}
): Promise<number> {
  const chapterNo = chapterNoOf(worldState);
  if (!chapterNo) return 0;

  const existingCount = await db.characterChapterSnapshot.count({
    where: { projectId, chapterNo },
  });
  if (existingCount > 0 && !options.overwrite) return existingCount;

  if (options.overwrite && existingCount > 0) {
    await db.characterChapterSnapshot.deleteMany({
      where: { projectId, chapterNo },
    });
  }

  const presentIds = new Set(worldState.presentCharacterIds ?? []);
  if (characters.length === 0) return 0;

  await db.characterChapterSnapshot.createMany({
    data: characters.map((character) => ({
      projectId,
      chapterNo,
      characterId: character.id,
      name: character.name,
      role: character.role,
      persona: JSON.stringify(character.persona),
      currentState: JSON.stringify(character.currentState),
      isPresent: presentIds.has(character.id),
    })),
  });

  return characters.length;
}

export async function restoreChapterCharacterSnapshot(
  projectId: string,
  worldState: WorldState,
  startTurn: number
): Promise<{ characters: Character[]; restoredCount: number; deletedNewCharacters: number; presentCharacterIds: string[] }> {
  const chapterNo = chapterNoOf(worldState);
  if (!chapterNo) {
    return { characters: [], restoredCount: 0, deletedNewCharacters: 0, presentCharacterIds: worldState.presentCharacterIds ?? [] };
  }

  const snapshots = await db.characterChapterSnapshot.findMany({
    where: { projectId, chapterNo },
    orderBy: { createdAt: 'asc' },
  });
  if (snapshots.length === 0) {
    return { characters: [], restoredCount: 0, deletedNewCharacters: 0, presentCharacterIds: worldState.presentCharacterIds ?? [] };
  }

  const snapshotIds = new Set(snapshots.map((snapshot) => snapshot.characterId));
  const firstSnapshotAt = snapshots[0]?.createdAt;

  let restoredCount = 0;
  for (const snapshot of snapshots) {
    await db.character.upsert({
      where: { id: snapshot.characterId },
      update: {
        name: snapshot.name,
        role: snapshot.role,
        persona: snapshot.persona,
        currentState: snapshot.currentState,
      },
      create: {
        id: snapshot.characterId,
        projectId,
        name: snapshot.name,
        role: snapshot.role,
        persona: snapshot.persona,
        currentState: snapshot.currentState,
      },
    });
    restoredCount += 1;
  }

  const allCharacters = await db.character.findMany({ where: { projectId } });
  let deletedNewCharacters = 0;
  for (const character of allCharacters) {
    if (snapshotIds.has(character.id)) continue;
    const hasBeforeChapterEvent = await db.event.count({
      where: {
        projectId,
        agentId: character.id,
        turn: { lt: startTurn },
      },
    });
    const likelyCreatedAfterSnapshot = firstSnapshotAt ? character.createdAt >= firstSnapshotAt : true;
    if (hasBeforeChapterEvent === 0 && likelyCreatedAfterSnapshot) {
      await db.character.delete({ where: { id: character.id } });
      deletedNewCharacters += 1;
    }
  }

  const rows = await db.character.findMany({ where: { projectId } });
  const characters = rows.map(rowToSnapshotCharacter);
  const presentCharacterIds = snapshots
    .filter((snapshot) => snapshot.isPresent)
    .map((snapshot) => snapshot.characterId);

  return {
    characters,
    restoredCount,
    deletedNewCharacters,
    presentCharacterIds,
  };
}
