'use client';

import { useState, useCallback } from 'react';
import { useChatUnread } from '../lib/chat-unread';
import { useHealth } from '../lib/hooks';
import { useNetworkId } from '../lib/network-context';
import { useHasDraft } from '../lib/chat-drafts';
import { isMuted, useMuteVersion } from '../lib/chat-mute';
import { TaskChatPanel } from './TaskChatPanel';
import { t } from '../lib/ui-lang';

interface CommandCenterProps {
  /** Currently open chat tabs */
  tabs: string[];
  activeTab: string;
  onOpenTab: (alias: string) => void;
  onCloseTab: (alias: string) => void;
  onSetActive: (alias: string) => void;
  onClose: () => void;
}

/**
 * Multi-tab chat panel for commanding multiple agents simultaneously.
 * Wraps TaskChatPanel with a tab bar for switching between agents.
 */
export function CommandCenter({ tabs, activeTab, onOpenTab, onCloseTab, onSetActive, onClose }: CommandCenterProps) {
  const { unreadCount } = useChatUnread();
  const muteVersion = useMuteVersion();
  void muteVersion;
  // R33: tab dot now shows PRESENCE (green online / gray offline, same SSE
  // definition as everywhere) — the active tab is already marked by the
  // border+text color, so the old active-state dot was redundant.
  const { health } = useHealth();
  const { networkId } = useNetworkId();
  const isOnline = (alias: string) => {
    const m = health?.sse_sessions;
    if (!m) return false;
    if (m[alias]) return true;
    if (networkId && m[`${networkId}:${alias}`]) return true;
    // sse keys are `network_id:alias`; without a selected network scan by suffix
    for (const k of Object.keys(m)) if (k.endsWith(`:${alias}`)) return true;
    return false;
  };
  if (tabs.length === 0) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/30 z-40 lg:hidden" onClick={onClose} />

      {/* Panel */}
      <div className="fixed top-0 right-0 h-[100dvh] w-full lg:w-[500px] bg-[#0b0b0d] border-l border-[#26262b] z-50 flex flex-col shadow-2xl shadow-black/60 animate-slide-in">
        {/* Tab bar */}
        <div className="flex items-center border-b border-[#26262b] bg-[#111113] overflow-x-auto">
          <div className="flex-1 flex min-w-0">
            {tabs.map(alias => (
              <button
                key={alias}
                onClick={() => onSetActive(alias)}
                className={`flex items-center gap-1.5 px-3 py-2.5 text-xs border-b-2 transition-colors shrink-0 ${
                  activeTab === alias
                    ? 'border-cyan-400 text-cyan-300 bg-cyan-500/5'
                    : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
              >
                <div className={`w-2 h-2 rounded-full ${isOnline(alias) ? 'bg-green-400' : 'bg-gray-600'}`} />
                <span className="max-w-[80px] truncate">{alias}</span>
                {isMuted(alias) && (
                  <svg aria-label="已开启免打扰" role="img" className="h-3 w-3 shrink-0 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.88 4.12A6 6 0 0118 9v3.6l1.5 2.4H12M6.3 6.3A5.98 5.98 0 006 9v3.6L4.5 15H13M10 19a2 2 0 004 0M3 3l18 18" />
                  </svg>
                )}
                {/* R8: WeChat unread badge on BACKGROUND tabs (the active
                    tab is being read — no badge). */}
                {activeTab !== alias && <TabDraftMark alias={alias} />}
                {activeTab !== alias && unreadCount(alias) > 0 && isMuted(alias) && (
                  <span className="h-2 w-2 shrink-0 rounded-full bg-red-500/80" />
                )}
                {activeTab !== alias && unreadCount(alias) > 0 && !isMuted(alias) && (
                  <span className="min-w-[15px] h-[15px] px-1 rounded-full bg-red-500 text-white text-[11px] font-semibold leading-[15px] text-center">
                    {unreadCount(alias) > 99 ? '99+' : unreadCount(alias)}
                  </span>
                )}
                {/* R21 of #190 mobile a11y: nested close had no aria-label
                    (screen-readers spoke just "button") and an ~8 px
                    tap target (p-0.5 + text "×"). Both fixed; nested
                    <button> inside <button> remains invalid HTML but
                    is browser-tolerated and refactoring to role="tab"
                    is out of scope for this round. */}
                <button
                  onClick={e => { e.stopPropagation(); onCloseTab(alias); }}
                  aria-label={`Close ${alias} chat tab`}
                  className="ml-1 inline-flex h-7 w-7 items-center justify-center text-gray-600 hover:text-gray-300 rounded-md hover:bg-[var(--hover-tint)]"
                >
                  ×
                </button>
              </button>
            ))}
          </div>
          {/* R21 mobile a11y: outer command-center close was SVG-only
              and screen-reader silent; also bumped to 44 x 44 hit zone
              from 32 x ~36. */}
          <button onClick={onClose} aria-label="Close command center" className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-gray-500 hover:text-white shrink-0 border-l border-[#26262b]">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Active chat - render all but only show active (preserves state) */}
        <div className="flex-1 relative overflow-hidden">
          {tabs.map(alias => (
            <div key={alias} className={`absolute inset-0 ${activeTab === alias ? 'block' : 'hidden'}`}>
              <InlineChat alias={alias} active={activeTab === alias} />
            </div>
          ))}
        </div>
      </div>

      <style jsx global>{`
        @keyframes slide-in {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        .animate-slide-in {
          animation: slide-in 0.2s ease-out;
        }
      `}</style>
    </>
  );
}

/** R10: "[草稿]" mark on background tabs — per-alias hook needs its own
 *  component (hooks can't run inside the tabs.map callback). */
function TabDraftMark({ alias }: { alias: string }) {
  const hasDraft = useHasDraft(alias);
  if (!hasDraft) return null;
  return <span className="text-[11px] text-red-400/90 shrink-0">{t('[草稿]', '[draft]')}</span>;
}

/** Inline chat without the panel chrome (used inside CommandCenter tabs) */
function InlineChat({ alias, active }: { alias: string; active: boolean }) {
  // Reuse TaskChatPanel's logic but render without the outer frame
  return <TaskChatPanel alias={alias} onClose={() => {}} inline active={active} />;
}

/**
 * Hook to manage multi-tab command center state.
 */
export function useCommandCenter() {
  const [tabs, setTabs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState('');

  // Loop R6: stable identities so memo'd consumers (AgentCard) don't
  // re-render just because the Overview re-rendered.
  const openTab = useCallback((alias: string) => {
    setTabs(prev => prev.includes(alias) ? prev : [...prev, alias]);
    setActiveTab(alias);
  }, []);

  const closeTab = (alias: string) => {
    setTabs(prev => {
      const next = prev.filter(t => t !== alias);
      if (activeTab === alias) setActiveTab(next[next.length - 1] || '');
      return next;
    });
  };

  const closeAll = () => {
    setTabs([]);
    setActiveTab('');
  };

  return { tabs, activeTab, openTab, closeTab, closeAll, setActiveTab };
}
