'use client';

// 新版本提示（对齐客户端 UpdatePrompt）。
//
// 背景：Dashboard 是本地部署的 SPA，发布新版本后正在打开的标签页不会知道，
// 用户会继续用旧代码，遇到的行为与刚发的版不一致（例如新按钮没出现）。
// 这里在页面加载时记下当时服务端的版本，之后定时 / 获得焦点时再问一次，
// 变了就显示一条可关闭的提示，点「刷新」才重新加载——绝不自动刷新打断输入。
import { useEffect, useRef, useState } from 'react';

const POLL_MS = 5 * 60 * 1000;

export default function UpdateBanner() {
  const [stale, setStale] = useState<{ loaded: string; current: string } | null>(null);
  const loadedVersion = useRef<string | null>(null);
  const dismissed = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const ask = async () => {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        const version = typeof data?.version === 'string' ? data.version : null;
        if (!version || cancelled) return;
        if (!loadedVersion.current) { loadedVersion.current = version; return; }
        if (version !== loadedVersion.current && !dismissed.current) {
          setStale({ loaded: loadedVersion.current, current: version });
        }
      } catch { /* 网络抖动不打扰用户 */ }
    };
    void ask();
    const timer = setInterval(ask, POLL_MS);
    // 「切回这个标签页」是最常见的时机：用户离开一阵再回来，正好检查一次。
    const onFocus = () => { void ask(); };
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, []);

  if (!stale) return null;
  return (
    <div
      role="status"
      data-testid="update-banner"
      className="pointer-events-auto fixed bottom-16 left-1/2 z-50 flex max-w-[92vw] -translate-x-1/2 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]/95 px-3 py-2 text-xs text-[var(--fg)] shadow-lg backdrop-blur lg:bottom-6"
    >
      <span>
        有新版本可用（<span className="font-mono">{stale.loaded.replace(/^0\.6\.4-preview\./, '')}</span>
        {' → '}
        <span className="font-mono">{stale.current.replace(/^0\.6\.4-preview\./, '')}</span>）
      </span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="inline-flex min-h-11 items-center rounded-md bg-[var(--accent)] px-2.5 text-[11px] font-medium text-[var(--accent-fg)] hover:opacity-90 sm:min-h-0 sm:py-1"
      >
        刷新
      </button>
      <button
        type="button"
        aria-label="关闭更新提示"
        onClick={() => { dismissed.current = true; setStale(null); }}
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)] sm:min-h-0 sm:min-w-0 sm:p-1"
      >
        ✕
      </button>
    </div>
  );
}
