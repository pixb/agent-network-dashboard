'use client';

import { useId, useRef, useState } from 'react';
import Link from 'next/link';
import { AliasAvatar } from './AliasAvatar';
import { SESSION_STATUS_TEXT_CLASS } from '../lib/status';
import { t } from '../lib/ui-lang';

interface HeaderSession {
  alias: string;
  status: string;
  agent: string;
  server: string;
}

/** The parent keys this header by alias, so delayed clipboard feedback cannot
 * appear on another node after navigation. Copy exactly the displayed alias. */
export function NodeDetailHeader({ alias, session, sse }: {
  alias: string;
  session: HeaderSession | null;
  sse: number;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'pending' | 'copied' | 'failed'>('idle');
  const [message, setMessage] = useState('');
  const pending = useRef(false);
  const feedbackId = useId();
  const ready = session?.alias === alias;
  const statusColor = SESSION_STATUS_TEXT_CLASS[session?.status || ''] || SESSION_STATUS_TEXT_CLASS.offline;
  const statusIndicator = <>
    <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
      sse > 0 ? (session?.status === 'working' ? 'animate-pulse bg-green-500' : 'bg-emerald-400') : 'bg-gray-500'
    }`} />
    <span className={`shrink-0 text-[11px] font-semibold uppercase tracking-wide ${statusColor}`}>{session?.status || 'unknown'}</span>
  </>;

  const copyAlias = async () => {
    if (!ready || pending.current) return;
    setMessage('');
    if (!navigator.clipboard?.writeText) {
      setCopyState('failed');
      setMessage(t('浏览器不支持复制，请选中名称手动复制。', 'Clipboard unavailable. Select the name to copy it.'));
      return;
    }
    pending.current = true;
    setCopyState('pending');
    try {
      await navigator.clipboard.writeText(alias);
      setCopyState('copied');
      setMessage(t('已复制别名', 'Alias copied'));
    } catch {
      setCopyState('failed');
      setMessage(t('无法复制，请允许剪贴板访问后重试，或手动复制名称。', 'Could not copy. Allow clipboard access and retry, or copy the name manually.'));
    } finally {
      pending.current = false;
    }
  };

  return (
    <header className="mb-6 ml-10 flex items-center gap-3 lg:ml-0" data-testid="node-detail-header">
      <Link href="/nodes" className="shrink-0 text-sm text-[var(--fg-muted)] hover:text-[var(--fg)]">&larr; Nodes</Link>
      <AliasAvatar alias={alias} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h1 title={alias} className="min-w-0 truncate text-xl font-semibold text-[var(--fg)] sm:text-2xl">{alias}</h1>
          <button type="button" onClick={copyAlias} disabled={!ready}
            aria-label="Copy alias" title={ready ? 'Copy alias' : 'Waiting for node information'}
            aria-busy={copyState === 'pending'} aria-disabled={!ready || copyState === 'pending'}
            aria-describedby={message ? feedbackId : undefined}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-text)] disabled:cursor-not-allowed disabled:opacity-40 aria-disabled:opacity-40 sm:h-9 sm:w-9">
            <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              {copyState === 'copied' ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>}
            </svg>
          </button>
          <span className="hidden shrink-0 items-center gap-2 sm:inline-flex">{statusIndicator}</span>
        </div>
        <div className="flex min-h-4 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="inline-flex shrink-0 items-center gap-2 sm:hidden">{statusIndicator}</span>
          {session?.agent && <span className="min-w-0 truncate text-[var(--fg-muted)]" title={[session.agent, session.server].filter(Boolean).join(' · ')}>
            {session.agent}{session.server ? <> <span className="mx-1 text-[var(--fg-dim)]">·</span> {session.server}</> : null}
          </span>}
          <span id={feedbackId} role="status" aria-atomic="true" className={copyState === 'failed' ? 'text-[var(--danger)]' : 'text-[var(--success)]'}>{message}</span>
        </div>
      </div>
    </header>
  );
}
