'use client';

import { useSyncExternalStore } from 'react';
import { SetupPanel } from '@/components/novel/setup-panel';
import { LiveView } from '@/components/novel/live-view';

type View =
  | { kind: 'setup' }
  | { kind: 'live'; projectId: string; projectName: string };

const LAST_PROJECT_KEY = 'novelstudio:last-project';
const LAST_PROJECT_EVENT = 'novelstudio:last-project-changed';
const EMPTY_PROJECT_SNAPSHOT = '';

function readLastProjectSnapshot(): string {
  try {
    const raw = window.localStorage.getItem(LAST_PROJECT_KEY);
    if (!raw) return EMPTY_PROJECT_SNAPSHOT;
    const parsed = JSON.parse(raw) as { projectId?: string; projectName?: string };
    if (parsed.projectId && parsed.projectName) {
      return JSON.stringify({ projectId: parsed.projectId, projectName: parsed.projectName });
    }
  } catch {
    return EMPTY_PROJECT_SNAPSHOT;
  }
  return EMPTY_PROJECT_SNAPSHOT;
}

function getServerLastProjectSnapshot() {
  return EMPTY_PROJECT_SNAPSHOT;
}

function subscribeLastProjectChange(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === LAST_PROJECT_KEY) onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(LAST_PROJECT_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(LAST_PROJECT_EVENT, onChange);
  };
}

function notifyLastProjectChanged() {
  window.dispatchEvent(new Event(LAST_PROJECT_EVENT));
}

function viewFromSnapshot(snapshot: string): View {
  if (!snapshot) return { kind: 'setup' };
  try {
    const parsed = JSON.parse(snapshot) as { projectId?: string; projectName?: string };
    if (parsed.projectId && parsed.projectName) {
      return { kind: 'live', projectId: parsed.projectId, projectName: parsed.projectName };
    }
  } catch {
    return { kind: 'setup' };
  }
  return { kind: 'setup' };
}

export default function Home() {
  const lastProjectSnapshot = useSyncExternalStore(
    subscribeLastProjectChange,
    readLastProjectSnapshot,
    getServerLastProjectSnapshot
  );
  const view = viewFromSnapshot(lastProjectSnapshot);

  const enterProject = (projectId: string, projectName: string) => {
    window.localStorage.setItem(LAST_PROJECT_KEY, JSON.stringify({ projectId, projectName }));
    notifyLastProjectChanged();
  };

  if (view.kind === 'setup') {
    return (
      <SetupPanel
        onEnter={enterProject}
      />
    );
  }

  return (
    <LiveView
      projectId={view.projectId}
      projectName={view.projectName}
      onProjectRenamed={(projectName) => {
        window.localStorage.setItem(LAST_PROJECT_KEY, JSON.stringify({ projectId: view.projectId, projectName }));
        notifyLastProjectChanged();
      }}
      onBack={() => {
        window.localStorage.removeItem(LAST_PROJECT_KEY);
        notifyLastProjectChanged();
      }}
    />
  );
}
