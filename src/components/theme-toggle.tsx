'use client';

import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';

const subscribe = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const mounted = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  if (!mounted) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className={compact ? 'h-8 px-2' : undefined}
        disabled
        aria-label="切换主题"
        title="切换主题"
      >
        <Moon className="h-4 w-4" />
        {!compact && <span>主题</span>}
      </Button>
    );
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className={compact ? 'h-8 px-2' : undefined}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      title={isDark ? '切换到日间模式' : '切换到夜间模式'}
    >
      {isDark ? (
        <Sun className="h-4 w-4" />
      ) : (
        <Moon className="h-4 w-4" />
      )}
      {!compact && <span>{isDark ? '日间' : '夜间'}</span>}
    </Button>
  );
}
