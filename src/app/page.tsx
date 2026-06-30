'use client';

import { useState } from 'react';
import { SetupPanel } from '@/components/novel/setup-panel';
import { LiveView } from '@/components/novel/live-view';

type View =
  | { kind: 'setup' }
  | { kind: 'live'; projectId: string; projectName: string };

export default function Home() {
  const [view, setView] = useState<View>({ kind: 'setup' });

  if (view.kind === 'setup') {
    return (
      <SetupPanel
        onEnter={(projectId, projectName) =>
          setView({ kind: 'live', projectId, projectName })
        }
      />
    );
  }

  return (
    <LiveView
      projectId={view.projectId}
      projectName={view.projectName}
      onBack={() => setView({ kind: 'setup' })}
    />
  );
}
