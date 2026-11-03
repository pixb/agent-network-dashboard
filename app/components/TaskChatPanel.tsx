'use client';

import { useState, useEffect, useRef, useCallback, useMemo, memo, Fragment } from 'react';
import { AliasAvatar } from './AliasAvatar';
import { AttachmentBlock, extractAttachments } from './AttachmentBlock';
import { isOnline as presenceIsOnline } from '../lib/presence';
import {
  buildTaskHistoryUrl,
  mergeTaskHistoryPage,
  oldestTaskHistoryCursor,
  type TaskHistoryCursor,
} from '../lib/task-history-pagination';

interface ChatTask {
  task_id: string;
  from_name: string;
  to_name: string;
  status: string;
  priority: string;
  content: string;
  result: string;
  created_at: string;
  completed_at?: string;
  client_request_id?: string;
  // #492 — hub `/api/tasks` uses `SELECT *` so meta_json (raw TEXT) is
  // present when the task carried attachments. May also arrive
  // already-parsed as `meta` from other code paths (send-side optimistic).
  // Both accepted by `extractAttachments`.
  meta_json?: string | null;
  meta?: { attachments?: unknown } | null;
}

type ChatEvent =
  | { kind: 'task'; task: ChatTask; at: string }
  | { kind: 'reply'; task: ChatTask; at: string };

/* ── Loop R3 (微信式时间分组): instead of stamping every bubble with
   "1m ago · 07/16, 09:50 AM", messages group under centered separators
   that appear when >5min passed since the previous message — exactly the
   WeChat intuition (time context when it changes, silence when it
   doesn't). Formats are contextual: today "14:32", yesterday "昨天
   14:32", within a week "星期二 14:32", this year "7月16日 14:32",
   older with the year. Exact per-message time survives in the bubble's
   title tooltip. */
const TIME_GROUP_GAP_MS = 5 * 60 * 1000;

// One-line "12 KB" / "3.4 MB" formatter for attachment descriptions
// in the visible task text. Defensive against negatives / NaN
// (untrusted server payload) — returns "?" rather than crashing the
// render or leaking a weird string.
function formatBytesShort(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function eventTime(value?: string) {
  if (!value) return 0;
  return new Date(value.replace(' ', 'T') + (value.includes('T') ? '' : 'Z')).getTime() || 0;
}

function formatTimestamp(value?: string) {
  if (!value) return '--';
  const d = new Date(value.replace(' ', 'T') + (value.includes('T') ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function quotePreview(text: string, max = 140) {
  const compact = (text || '')
    .replace(/\[Dashboard 附件[\s\S]*$/m, '[附件]')
    .replace(/\s+/g, ' ')
    .trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

function extractAttachmentPreviews(text: string): string[] {
  const urls: string[] = [];
  for (const line of (text || '').split('\n')) {
    const match = line.match(/^\s*-\s*预览:\s*(\S+)\s*$/);
    if (match?.[1]) urls.push(match[1]);
  }
  return Array.from(new Set(urls));
}

/* Loop R30 (微信长按复制的桌面版): hover-reveal copy on every bubble —
   agent replies get copied constantly (specs, commands, reports). ✓
   feedback for 1.5s; clipboard API with a textarea fallback for
   non-secure contexts. Mobile (no hover) keeps it faintly visible. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      title={label}
      className="shrink-0 rounded p-0.5 text-[10px] leading-none transition-opacity opacity-50 sm:opacity-0 sm:group-hover/bubble:opacity-70 hover:!opacity-100 text-[var(--fg-dim)] hover:text-[var(--accent-text)]"
    >
      {copied ? <span className="text-[var(--success)]">✓</span> : (
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
    </button>
  );
}

/* Loop R12 (微信式图片): thumbnails shimmer while loading and degrade to a
   quiet "图片加载失败" tile on error; tapping opens an in-panel lightbox
   (dark backdrop, fit-to-screen, Esc/tap closes) instead of navigating to
   a raw browser tab. */
function ChatImage({ src, alt, thumbClass, onOpen }: { src: string; alt?: string; thumbClass: string; onOpen: (url: string) => void }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  if (state === 'error') {
    return (
      <span className={`${thumbClass} flex items-center justify-center bg-black/20 border border-[var(--border)] text-[10px] text-[var(--fg-dim)]`}>
        {t('图片加载失败', 'Image failed to load')}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-chat-image={src}
      onClick={() => onOpen(src)}
      aria-label={alt || t('查看大图', 'View full image')}
      className={`relative block overflow-hidden ${state === 'loading' ? 'animate-pulse bg-[var(--bg-elevated)]' : ''} ${thumbClass}`}
    >
      <img
        src={src}
        alt={alt || ''}
        loading="lazy"
        onLoad={() => setState('ready')}
        onError={() => setState('error')}
        className={`h-full w-full object-cover transition-opacity duration-200 ${state === 'ready' ? 'opacity-100' : 'opacity-0'}`}
      />
    </button>
  );
}

function ImageLightbox({ urls, initialIndex, onClose, opener }: { urls: string[]; initialIndex: number; onClose: () => void; opener: HTMLElement | null }) {
  // R21 (多图还债): navigate all images of the LOADED conversation —
  // ‹ › buttons + arrow keys, WeChat-style no-wrap ends.
  const [idx, setIdx] = useState(initialIndex);
  const url = urls[Math.min(idx, urls.length - 1)];
  const [loaded, setLoaded] = useState(false);
  const idxRef = useRef(idx);
  idxRef.current = idx;
  const step = (d: number) => {
    setIdx((i) => Math.max(0, Math.min(urls.length - 1, i + d)));
    setLoaded(false);
  };
  const stepRef = useRef(step);
  stepRef.current = step;
  const dialogRef = useRef<HTMLDivElement>(null);
  // onClose is recreated on every parent render (and the panel re-renders
  // every few seconds from soft refreshes) — a [onClose] dep would tear
  // down/re-run this effect mid-open and re-capture the "opener" as an
  // element INSIDE the dialog. Mount-only + ref keeps the true opener.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onClose = () => onCloseRef.current();
    // R13 a11y debt: modal focus management — focus into the dialog, trap
    // Tab, hand focus back on close. The opener is captured by the PANEL at
    // activation time and passed in: by the time this passive effect runs,
    // the thumbnail has already been blurred (measured: activeElement was
    // <body> here), so capturing it locally restored nothing.
    const focusables = () =>
      Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('a[href], button') || []);
    focusables()[0]?.focus();
    // Capture-phase so Escape closes the LIGHTBOX, not the chat panel
    // behind it (panel hosts listen for Escape too).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key === 'ArrowLeft') { stepRef.current(-1); return; }
      if (e.key === 'ArrowRight') { stepRef.current(1); return; }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0], last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
        e.preventDefault(); first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      // After this cleanup React removes the overlay; the browser then
      // blurs to <body>. Restore on a macrotask so we run AFTER that blur.
      setTimeout(() => {
        // Soft refreshes rebuild bubble subtrees, so the opener node may be
        // detached by now (focus() on a detached node is a silent no-op) —
        // re-find its replacement by aria-label.
        let el = opener;
        if (el && !document.contains(el)) {
          const label = el.getAttribute('aria-label');
          if (label) el = document.querySelector<HTMLElement>(`[aria-label="${CSS.escape(label)}"]`);
        }
        el?.focus?.();
      }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);  // opener/onCloseRef are stable for one open
  return (
    <div ref={dialogRef} className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85" onClick={onClose} role="dialog" aria-modal="true" aria-label={t('图片预览', 'Image preview')}>
      {!loaded && <div className="absolute h-6 w-6 animate-spin rounded-full border-2 border-white/30 border-t-white" />}
      <img
        key={url}
        src={url}
        alt=""
        onLoad={() => setLoaded(true)}
        className={`max-h-[92vh] max-w-[92vw] rounded object-contain transition-opacity duration-150 ${loaded ? 'opacity-100' : 'opacity-0'}`}
      />
      {urls.length > 1 && (
        <>
          <span className="absolute left-3 top-3 text-[11px] tabular-nums text-[var(--fg)]/70">{idx + 1}/{urls.length}</span>
          <button
            onClick={(e) => { e.stopPropagation(); step(-1); }}
            disabled={idx === 0}
            aria-label={t('上一张', 'Previous image')}
            className="absolute left-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-2xl text-[var(--fg)]/80 hover:bg-white/10 disabled:opacity-25"
          >
            ‹
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); step(1); }}
            disabled={idx === urls.length - 1}
            aria-label={t('下一张', 'Next image')}
            className="absolute right-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-2xl text-[var(--fg)]/80 hover:bg-white/10 disabled:opacity-25"
          >
            ›
          </button>
        </>
      )}
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="absolute right-12 top-3 text-[11px] text-[var(--fg)]/70 underline hover:text-[var(--fg)]"
      >
        {t('新标签打开', 'Open in new tab')}
      </a>
      <button onClick={onClose} aria-label={t('关闭预览', 'Close preview')} className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center text-lg text-[var(--fg)]/80 hover:text-[var(--fg)]">
        ×
      </button>
    </div>
  );
}

function AttachmentPreviews({ text, onOpen }: { text: string; onOpen: (url: string) => void }) {
  const urls = extractAttachmentPreviews(text);
  if (urls.length === 0) return null;
  return (
    <div className="mt-2 grid grid-cols-2 gap-2">
      {urls.map((url) => (
        <ChatImage key={url} src={url} alt="Dashboard attachment" thumbClass="h-28 w-full rounded-lg border border-[var(--accent)]/20" onOpen={onOpen} />
      ))}
    </div>
  );
}

function LocalFilePreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const isImage = file.type.startsWith('image/');
  // eslint-disable-next-line react-hooks/purity -- object URL creation is
  // idempotent-per-file here; memo + revoke-on-change avoids the
  // setState-in-effect double commit. Only allocated for images —
  // non-image tiles render a file-icon + name and don't need a blob.
  const url = useMemo(() => (isImage ? URL.createObjectURL(file) : ''), [file, isImage]);
  useEffect(() => {
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  }, [url]);

  // Short ext label for non-image tiles ("PDF", "PPTX", "ZIP" …).
  // Falls back to the leading MIME segment when there's no ext.
  const ext = (file.name.match(/\.([a-zA-Z0-9]{1,5})$/)?.[1] || file.type.split('/')[1] || 'FILE')
    .toUpperCase()
    .slice(0, 5);

  return (
    <div
      className="relative h-16 w-16 overflow-hidden rounded-lg border border-[var(--accent)]/25 bg-black/20"
      title={file.name}
    >
      {isImage && url ? (
        <img src={url} alt={file.name} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-0.5 px-1 text-center">
          <span className="text-lg">📄</span>
          <span className="max-w-full truncate text-[9px] font-semibold text-[var(--accent-text)]">{ext}</span>
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-xs text-[var(--fg)] hover:bg-[var(--danger)]"
        aria-label={`Remove ${file.name}`}
      >
        ×
      </button>
    </div>
  );
}

// 通信龙 07-31 GAP 2nd tier: translate hub status codes into human
// labels. The old form was `● ─ ● ─ ○ ─ ○  delivered` — a colored dot
// progression + the raw English word. Nobody could tell "delivered"
// (hub-side mark) from "acked" (node process received) from "replied"
// (agent actually processed).
//
// Two things this rewrite fixes:
//
// 1. STATUS_STEPS was `['created','delivered','running','replied']`.
//    Neither `created` nor `running` correspond to hub-emitted terminal
//    statuses (`created` is client-side optimistic, `running` is READ
//    by hub queries but never WRITTEN — grep server/src for `= 'running'`
//    returns zero). Real hub progression is queued → delivered → acked
//    → replied, and the old third dot literally never lit up.
//
// 2. `delivered` was labeled as if it meant "message reached the node".
//    Reading hub source (server/src/index.ts:1568 + tools.ts:1080/1232)
//    shows it's set at task-insert time — same instant as delivered_at
//    (which is why delivered_at delay is empirically 0). The label now
//    says "已推送" and the hover explicitly disclaims node reception.
//
// Vocabulary — must stay in sync with hub emits:
//   queued / delivered / acked / replied / failed  ← the primary 5
//   created                                        ← client-side pre-POST
//   closed / expired / cancelled                   ← terminal, non-reply
//   running                                        ← reserved (never written today)
//   <anything else>                                ← fail-loudly (raw + banner)
const STATUS_STEPS = ['queued', 'delivered', 'acked', 'replied'] as const;
type StatusInfo = { label: string; hover: string; color: string; icon: React.ReactNode };
const STATUS_INFO: Record<string, StatusInfo> = {
  created:   { label: '发送中',   hover: '客户端已建消息，尚未收到 hub 回执。', color: 'text-[var(--fg-muted)]',   icon: <IconSending /> },
  queued:    { label: '排队中',   hover: '已入队，尚未推给节点。节点可能离线、或通道拥堵。', color: 'text-[var(--fg-muted)]',   icon: <IconClock /> },
  delivered: { label: '已推送',   hover: 'hub 侧已标记推送。尚未确认节点是否收到（delivered_at 是入队时刻，不代表 SSE 已到达）。', color: 'text-sky-400',    icon: <IconCheck /> },
  acked:     { label: '已接收',   hover: '节点进程已确认收到。未必已处理——对方 agent 可能尚未唤醒。', color: 'text-[var(--fg)]',   icon: <IconCheckDouble /> },
  replied:   { label: '已回复',   hover: '对方已针对此消息回复。', color: 'text-emerald-400', icon: <IconCheckDouble filled /> },
  failed:    { label: '失败',     hover: '发送失败——详细原因见消息下方文本。', color: 'text-[var(--danger)]',    icon: <IconWarn /> },
  closed:    { label: '已关闭',   hover: '会话已被关闭，不再期待回复。', color: 'text-[var(--fg-muted)]',   icon: <IconClose /> },
  expired:   { label: '已超时',   hover: '在期限内未收到回复，任务已超时。', color: 'text-[var(--fg-muted)]',   icon: <IconClock /> },
  cancelled: { label: '已取消',   hover: '任务被主动取消。', color: 'text-[var(--fg-muted)]',   icon: <IconClose /> },
  running:   { label: '处理中',   hover: '节点进程正在处理（今日 hub 不写入此值，见组件注释）。', color: 'text-[var(--success)]',  icon: <IconClock /> },
};

function StatusBar({ status, result }: { status: string; result?: string }) {
  const info = STATUS_INFO[status];
  const known = !!info;
  // Progression label list for the hover — same string appended after
  // the per-status hover so the reader gets a compact map of the flow.
  // Not per-step timestamps: hub doesn't expose queued_at / acked_at
  // separately from delivered_at, so a per-step timeline would be
  // fabricated data. See feedback_assert_the_fact_not_the_declaration.
  const idx = STATUS_STEPS.indexOf(status as typeof STATUS_STEPS[number]);
  const flow = STATUS_STEPS.map((s, i) => {
    const mark = i < idx || (i === idx && idx >= 0) ? '✓' : '○';
    return `${mark} ${STATUS_INFO[s].label}`;
  }).join(' → ');
  const hoverText = known
    ? `${info.hover}\n\n进度：${flow}`
    : `未知状态「${status}」——请报 bug。UI 词库没有匹配项，可能 hub 加了新 status 但前端没跟上。`;
  const label = known ? info.label : status;
  const color = known ? info.color : 'text-yellow-400';

  // failed inline reason — hub has no dedicated failure_reason column
  // (task table: task_id/from_*/to_*/status/content/result/... —
  // grep-verified as of 2026-07-31). We show `result` first 40 chars
  // when present. When result is empty, we explicitly say "节点未提供
  // 原因" rather than falling back to a generic "未知错误" — that
  // distinguishes "hub has no error field" from "reason field exists
  // but got a bad value".
  const failedReason = status === 'failed'
    ? ((result && result.trim()) ? result.trim().slice(0, 40) : '节点未提供原因')
    : null;

  return (
    <div
      data-status-key={status}
      data-status-known={known ? 'true' : 'false'}
      data-status-label={label}
      className="inline-flex flex-col gap-0.5 mt-1.5"
    >
      <span
        title={hoverText}
        aria-label={known ? info.label : `未知状态 ${status}`}
        className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${color}`}
      >
        {known ? info.icon : <IconQuestion />}
        <span>{label}</span>
        {(status === 'delivered' || status === 'created') && (
          <span aria-hidden className="inline-flex items-center gap-0.5 ml-0.5">
            <span className="inline-block w-1 h-1 rounded-full bg-current opacity-70 animate-pulse" />
            <span className="inline-block w-1 h-1 rounded-full bg-current opacity-70 animate-pulse" style={{ animationDelay: '0.2s' }} />
            <span className="inline-block w-1 h-1 rounded-full bg-current opacity-70 animate-pulse" style={{ animationDelay: '0.4s' }} />
          </span>
        )}
      </span>
      {failedReason !== null && (
        <span
          data-status-reason={failedReason}
          className="text-[10px] text-[var(--danger)]/80 max-w-[260px] truncate"
          title={result || undefined}
        >
          {failedReason}
        </span>
      )}
    </div>
  );
}

// Icon primitives — inline SVG, single-color (currentColor), sized to
// match the 11px label text. No external icon library — keeps the
// StatusBar self-contained and avoids a Tailwind purge/tree-shake
// dance for icons only this component uses.
function IconClock() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
    </svg>
  );
}
function IconCheck() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12l6 6L20 6" />
    </svg>
  );
}
function IconCheckDouble({ filled }: { filled?: boolean } = {}) {
  return (
    <svg width="14" height="12" viewBox="0 0 28 24" fill="none" stroke="currentColor" strokeWidth={filled ? 2.5 : 2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12l6 6L18 6" />
      <path d="M10 12l6 6L26 6" opacity={filled ? 1 : 0.7} />
    </svg>
  );
}
function IconWarn() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L2 20h20L12 2z" /><path d="M12 9v5" /><circle cx="12" cy="17.5" r="0.6" fill="currentColor" />
    </svg>
  );
}
function IconClose() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><path d="M8 12h8" />
    </svg>
  );
}
function IconSending() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12l16-8-6 16-3-7-7-1z" />
    </svg>
  );
}
function IconQuestion() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.5 9.5a2.5 2.5 0 015 0c0 1.5-2.5 2-2.5 3.5" />
      <circle cx="12" cy="17" r="0.6" fill="currentColor" />
    </svg>
  );
}

// Full markdown rendering — handles tables, headings, lists, links, code,
// blockquotes via react-markdown + GFM. Earlier hand-rolled parser only did
// code blocks + bold; tables / headings showed as raw `|---|` text.
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useSSE } from '../lib/useSSE';
import { useNetworkId } from '../lib/network-context';
import { useHealth } from '../lib/hooks';
import { useMuted } from '../lib/chat-mute';
import { markChatRead } from '../lib/chat-unread';
import { readDraft, writeDraft } from '../lib/chat-drafts';
import { pinyinMatch, usePinyinReady } from '../lib/pinyin-match';
import { formatWeChatTime } from '../lib/time';
import { t } from '../lib/ui-lang';
import { chatOutboxForAlias, chatPrivateScope, putChatOutbox, removeChatOutbox } from '../lib/chat-outbox';
import { newDashboardRequestId, normalizeChatSendResult, requestIdFromTaskMeta } from '../lib/chat-send-state';
import { isOwnSender, senderLabelFor } from '../lib/chat-sender';

/* Loop R14 (气泡子树稳定性): the renderer map used to be an OBJECT LITERAL
   OF INLINE ARROWS inside MarkdownContent's JSX — every render produced new
   component types, so React unmounted and remounted the entire rendered
   markdown subtree on every soft refresh (measured: +36 ChatImage mounts in
   45s idle; any focused element inside a bubble fell back to <body>).
   Hoisting the map to a factory + memoizing per onImageClick keeps types
   stable; memo() on MarkdownContent then skips re-render entirely while
   text is unchanged. */
function buildMdComponents(onImageClick?: (url: string) => void) {
  return {
          h1: ({ children }) => <h1 className="text-base font-semibold text-[var(--fg)] mt-2 mb-1">{children}</h1>,
          h2: ({ children }) => <h2 className="text-sm font-semibold text-[var(--fg)] mt-2 mb-1">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-semibold text-[var(--accent-text)] mt-1.5 mb-0.5">{children}</h3>,
          p: ({ children }) => <p className="my-1">{children}</p>,
          strong: ({ children }) => <strong className="text-[var(--fg)] font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic text-[var(--fg-muted)]">{children}</em>,
          ul: ({ children }) => <ul className="list-disc pl-5 my-1 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 my-1 space-y-0.5">{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" className="text-[var(--accent-text)] underline">{children}</a>,
          blockquote: ({ children }) => <blockquote className="border-l-2 border-[var(--accent)]/30 pl-3 my-1 text-[var(--fg-muted)] italic">{children}</blockquote>,
          hr: () => <hr className="border-t border-[var(--border)] my-2" />,
          img: ({ src, alt }) => {
            const url = typeof src === 'string' ? src : '';
            if (!url) return null;
            if (!onImageClick) return <img src={url} alt={alt || ''} loading="lazy" className="my-1 max-h-48 rounded-lg" />;
            return <ChatImage src={url} alt={alt} thumbClass="my-1 h-40 w-full max-w-[240px] rounded-lg" onOpen={onImageClick} />;
          },
          code: ({ className, children }) => {
            const inline = !className?.startsWith('language-');
            if (inline) {
              return <code className="bg-[var(--code-bg)] rounded px-1.5 py-0.5 text-[var(--accent-text)] text-[11px] border border-[var(--border)]">{children}</code>;
            }
            const lang = className?.replace(/^language-/, '') || '';
            return (
              <div className="my-2 rounded-lg overflow-hidden border border-[var(--border)]">
                {lang && <div className="bg-[var(--code-bg)] px-3 py-1 text-[10px] text-[var(--fg-muted)] border-b border-[var(--border)]">{lang}</div>}
                <pre className="bg-[var(--code-bg)] px-3 py-2 text-[11px] text-green-300 overflow-x-auto"><code>{children}</code></pre>
              </div>
            );
          },
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full text-[12px] border-collapse">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-[var(--code-bg)]">{children}</thead>,
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => <tr className="border-b border-[var(--border)]">{children}</tr>,
          th: ({ children }) => <th className="text-left text-[var(--accent-text)] font-semibold px-2 py-1 border border-[var(--border)]">{children}</th>,
          td: ({ children }) => <td className="px-2 py-1 border border-[var(--border)] align-top">{children}</td>,
  } satisfies React.ComponentProps<typeof ReactMarkdown>['components'];
}

const MarkdownContent = memo(function MarkdownContent({ text, onImageClick }: { text: string; onImageClick?: (url: string) => void }) {
  const components = useMemo(() => buildMdComponents(onImageClick), [onImageClick]);
  if (!text) return <span className="text-[var(--fg-dim)] italic">No content</span>;
  return (
    <div className="break-words leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

interface TaskChatPanelProps {
  alias: string;
  onClose: () => void;
  /** When true, renders without outer panel chrome (for use inside CommandCenter) */
  inline?: boolean;
  /** Available nodes for @ mention */
  availableNodes?: string[];
  /** Loop R11: false for background CommandCenter tabs — pauses the 15s
   *  soft-refresh AND the SSE-event soft-refresh (in-flight send patches
   *  stay live). Reactivation runs one immediate catch-up. Default true. */
  active?: boolean;
  /** A nonmodal host can keep visible history live without owning global shortcuts. */
  keyboardActive?: boolean;
  /** Floating hosts manage their own focus so activation never steals it from window controls. */
  autoFocus?: boolean;
  /** Embedded scenes bind history, SSE and sends to the selected network. */
  scopeNetworkId?: string;
}

/** P0 chat batch (Vincent: 长消息=无排版文字墙): message bodies taller than
 *  ~12 rendered lines collapse behind 展开全文, with a fade-out hinting more
 *  content. Height is measured post-render (scrollHeight via ResizeObserver)
 *  so markdown output — code blocks, lists — counts at its real rendered
 *  height rather than by newline count. Attachments render OUTSIDE the
 *  collapse so a folded message never hides an image. */
const COLLAPSE_MAX_PX = 300; // ≈12 lines at 14px/1.65
const SCOPED_HISTORY_UNSUPPORTED = '当前 Hub 不支持按网络读取历史，请升级 Hub 后重新打开对话';

function CollapsibleText({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setOverflowing(el.scrollHeight > COLLAPSE_MAX_PX + 40);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const collapsed = overflowing && !expanded;
  return (
    <div>
      <div
        ref={ref}
        style={collapsed ? {
          maxHeight: COLLAPSE_MAX_PX,
          overflow: 'hidden',
          maskImage: 'linear-gradient(to bottom, black 72%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, black 72%, transparent 100%)',
        } : undefined}
      >
        {children}
      </div>
      {overflowing && (
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          className="mt-1 text-[12px] font-medium text-[var(--accent-text)] hover:text-[var(--accent-text)]"
        >
          {expanded ? t('收起 ⌃', 'Collapse ⌃') : t('展开全文 ⌄', 'Show full text ⌄')}
        </button>
      )}
    </div>
  );
}

export function TaskChatPanel({ alias, onClose, inline, availableNodes, active, keyboardActive, autoFocus = true, scopeNetworkId }: TaskChatPanelProps) {
  const isActive = active !== false;
  const ownsKeyboard = isActive && keyboardActive !== false;
  const { networkId } = useNetworkId();
  const scopedChatUrl = useCallback((url: string) => scopeNetworkId
    ? `${url}${url.includes('?') ? '&' : '?'}network_id=${encodeURIComponent(scopeNetworkId)}` : url, [scopeNetworkId]);
  // NetworkContext hydrates after the first client paint. Do not briefly read
  // another network's shard through an auth fallback while that happens.
  const privateStorageScope = networkId ? chatPrivateScope(networkId) : null;
  // R33 (微信聊天页头): presence via the same SSE definition as everywhere
  // (#214 "one definition"); useHealth is SWR-deduped with the page-level
  // poll, so this adds no extra requests while Overview is mounted.
  const { health } = useHealth();
  const chatMuted = useMuted(alias);
  const sseOnline = (() => {
    const m = health?.sse_sessions;
    if (!m) return null;
    if (m[alias]) return true;
    if (networkId && m[`${networkId}:${alias}`]) return true;
    // sse keys are `network_id:alias`; without a selected network scan by suffix
    for (const k of Object.keys(m)) if (k.endsWith(`:${alias}`)) return true;
    return false;
  })();
  const [messages, setMessages] = useState<ChatTask[]>([]);
  const [input, setInput] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [priority, setPriority] = useState('normal');
  const [sending, setSending] = useState(false);
  const [pollingIds, setPollingIds] = useState<Set<string>>(new Set());
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [historyErrorReason, setHistoryErrorReason] = useState('');
  const historyUnsupportedRef = useRef(false);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  // R23→R25: pinyin matching moved to the shared lib (also powers /nodes
  // and /messages search). Lazy chunk semantics unchanged.
  const pinyinReady = usePinyinReady();
  void pinyinReady; // render trigger when the lazy dict lands mid-typing
  const [attachLimitHit, setAttachLimitHit] = useState(false);
  // R39: k/n indicator while attachments upload (matters on slow links;
  // previously only the send-button spinner hinted anything).
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionNodes, setMentionNodes] = useState<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // #217 M4 (Vincent: 倒序加载, 上滑再拉旧的): history is paged. We load
  // only the newest PAGE on open and fetch one keyset page when the user
  // scrolls to the top. `before` + `before_task_id` preserve rows that share
  // the Hub's one-second created_at precision.
  // P0 chat batch (Vincent "感觉是一脑子全部拉了"): 20 tasks render up to
  // ~40 bubbles (task+reply) — a wall on open. 12 keeps the first paint to
  // roughly one viewport of conversation; scroll-up stays O(page).
  const HISTORY_PAGE = 12;
  const scrollRef = useRef<HTMLDivElement>(null);
  const skipAutoScrollRef = useRef(false);
  const anchoredRef = useRef(false);
  const [hasOlder, setHasOlder] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Loop R10 (微信式"下方有新消息"): while the user is scrolled up reading
  // history, incoming messages must NOT yank the view to the bottom —
  // they accumulate in a floating pill instead. atBottomRef mirrors the
  // user's last real scroll position (checking the DOM after an append
  // would always look "not at bottom" because the new content itself
  // grew the distance).
  const [newBelow, setNewBelow] = useState(0);
  const [lightbox, setLightbox] = useState<{ urls: string[]; idx: number } | null>(null);
  const [errorFor, setErrorFor] = useState<string | null>(null);
  // Loop R15 (会话内搜索): client-side filter over the LOADED window —
  // honest scope (the hint says so); load earlier messages to widen it.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIdx, setSearchIdx] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // R44 (微信桌面版直觉): Cmd/Ctrl+F while this panel is the active chat
  // opens the in-conversation search instead of browser find — the open
  // panel IS the user's context. Closing the panel restores browser find.
  useEffect(() => {
    if (!ownsKeyboard) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus({ preventScroll: !!scopeNetworkId }), 50);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ownsKeyboard, scopeNetworkId]);
  // 07-31 通信龙 batch (SPEC §12 header 🔍): ChatPane's search button
  // dispatches `chat:open-search` (detail.alias). Same effect as
  // Cmd/Ctrl+F, but reachable by pointer users. Filter on detail.alias
  // === alias so a search click on chat A doesn't accidentally open
  // search on chat B if both were somehow mounted.
  useEffect(() => {
    if (!ownsKeyboard) return;
    const onEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ alias?: string }>).detail;
      if (detail?.alias && detail.alias !== alias) return;
      setSearchOpen(true);
      setTimeout(() => searchInputRef.current?.focus({ preventScroll: !!scopeNetworkId }), 50);
    };
    window.addEventListener('chat:open-search', onEvent);
    return () => window.removeEventListener('chat:open-search', onEvent);
  }, [ownsKeyboard, alias, scopeNetworkId]);
  const lightboxOpenerRef = useRef<HTMLElement | null>(null);
  const openLightbox = useCallback((url: string) => {
    lightboxOpenerRef.current = document.activeElement as HTMLElement | null;
    // Collect every image of the loaded conversation in document order —
    // DOM-driven so it exactly matches what's rendered (markdown +
    // attachments, collapsed content included).
    const nodes = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>('[data-chat-image]') || []);
    const urls = Array.from(new Set(nodes.map((n) => n.getAttribute('data-chat-image') || '').filter(Boolean)));
    const idx = Math.max(0, urls.indexOf(url));
    setLightbox({ urls: urls.length ? urls : [url], idx });
  }, []);
  const atBottomRef = useRef(true);
  const prevBubblesRef = useRef(0);
  const forceScrollRef = useRef(false);

  // Load available nodes for @ mention
  // alias → network_id map for send scoping (P0 network_id fix): the
  // target node's own network is the ground truth; the sidebar-selected
  // network is the fallback when the map is empty (availableNodes path).
  const aliasNetRef = useRef<Record<string, string>>({});
  useEffect(() => {
    if (availableNodes) { setMentionNodes(availableNodes); return; }
    // #515: @-mention candidates must be actually reachable, not just
    // "hub row hasn't flipped to offline yet". Fetch health alongside
    // status so we can filter by presence.isOnline (SSE-reachable)
    // rather than the retired `status !== 'offline'` predicate.
    Promise.all([
      fetch('/api/hub/status').then(r => r.ok ? r.json() : { sessions: [] }),
      fetch('/api/hub/health').then(r => r.ok ? r.json() : {}),
    ]).then(([d, health]: [{ sessions?: { alias: string; status: string; network_id?: string }[] }, { sse_sessions?: Record<string, number> }]) => {
      const sessions = d.sessions || [];
      const map: Record<string, string> = {};
      for (const s of sessions) if (s.network_id) map[s.alias] = s.network_id;
      aliasNetRef.current = map;
      setMentionNodes(sessions.filter(s => presenceIsOnline(s, health?.sse_sessions)).map(s => s.alias));
    }).catch(() => {});
  }, [availableNodes]);

  // Loop R9 (微信草稿): unsent text survives closing the panel, switching
  // conversations and refreshing, per conversation. Text only — File
  // attachments can't be serialized. The debounced write covers "typing,
  // then refresh"; the effect cleanup covers "typing, then close within
  // the debounce window" (the timer dies with the unmount, so the tail
  // would otherwise be lost). Empty input deletes the draft, so sending
  // or clearing the box leaves no stale draft behind.
  const inputRef = useRef(input);
  inputRef.current = input;
  // R17 (移动端手感): touch keyboards have no Shift — Enter-to-send made
  // multiline input impossible on phones. WeChat mobile semantics: Enter
  // inserts a newline, the send button sends. Coarse pointer = touch.
  const coarsePointerRef = useRef(false);
  useEffect(() => {
    try { coarsePointerRef.current = window.matchMedia('(pointer: coarse)').matches; } catch {}
  }, []);
  useEffect(() => {
    if (!alias || !networkId) return;
    const draft = readDraft(alias, networkId);
    if (draft) {
      setInput(draft);
      requestAnimationFrame(() => { if (textareaRef.current) autoResize(textareaRef.current); });
    }
    return () => { writeDraft(alias, inputRef.current, networkId); };
  }, [alias, networkId]);
  useEffect(() => {
    if (!networkId) return;
    const timer = setTimeout(() => writeDraft(alias, input, networkId), 300);
    return () => clearTimeout(timer);
  }, [input, alias, networkId]);

  useEffect(() => {
    if (!alias) return;
    markChatRead(alias, networkId);
  }, [alias, networkId]);

  // Load task history for this node — newest `limit` only (M4).
  // Vincent tg923 (转圈加载太久): bound each request with an AbortController so
  // a stalled hub call can't leave the panel spinning forever.
  //
  // Timeout-degrade (Vincent "节点详情总是超时" on the large 通信龙 session):
  // the hub query itself is NOT the bottleneck — fetching the newest 20 for
  // that session measures ~3 ms (v0.9 ships the (to_name, created_at) index
  // + `skip_stats`), so a 12 s stall is a congested *transport* (HTTP/1.1
  // head-of-line blocking behind the long-lived SSE stream), not the query.
  // Robustness here, without pretending to "fix" the transport:
  //   • runFetch — one bounded attempt that only touches `messages`.
  //   • loadInitial — a retry ladder (newest 20 @ 10 s, then a tiny newest-6
  //     @ 6 s). Under congestion a smaller payload is far likelier to get
  //     through, so the panel opens with *some* recent history rather than a
  //     full-screen timeout. The composer below is never gated on history,
  //     so the user can always send even if both attempts fail.
  const runFetch = useCallback(async (
    limit: number,
    budgetMs: number,
    cursor?: TaskHistoryCursor,
  ): Promise<boolean> => {
    if (scopeNetworkId && historyUnsupportedRef.current) return false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), budgetMs);
    try {
      const res = await fetch(
        scopedChatUrl(buildTaskHistoryUrl(alias, limit, cursor)),
        { signal: ctrl.signal },
      );
      const data = await res.json();
      if (scopeNetworkId && res.status === 501 && data.error === 'hub_tasks_scope_unsupported') {
        historyUnsupportedRef.current = true;
        throw new Error(SCOPED_HISTORY_UNSUPPORTED);
      }
      if (!res.ok || data.ok === false) throw new Error(res.status === 401
        ? '会话已过期，请重新登录后读取历史'
        : res.status === 403 ? '无权读取当前网络的历史，请联系网络管理员' : `读取历史失败（HTTP ${res.status}）`);
      setHistoryErrorReason('');
      if (data.tasks) {
        const persistedRequestIds = new Set<string>();
        for (const task of data.tasks as ChatTask[]) {
          const requestId = requestIdFromTaskMeta(task.meta_json);
          if (requestId) {
            persistedRequestIds.add(requestId);
            removeChatOutbox(requestId, privateStorageScope);
          }
        }
        if (data.tasks.length < limit) setHasOlder(false);
        // Merge by identity and sort oldest-first. This preserves older pages,
        // optimistic sends, and SSE patches while a bounded newest-page refresh
        // updates current statuses.
        setMessages(prev => mergeTaskHistoryPage(prev, data.tasks, persistedRequestIds));
      }
      return true;
    } catch (error) {
      setHistoryErrorReason(error instanceof Error ? error.message : '读取历史失败');
      return false;
    } finally {
      clearTimeout(timer);
    }
  }, [alias, privateStorageScope, scopedChatUrl, scopeNetworkId]);

  // Single-attempt loader used for one older keyset page.
  const loadHistory = useCallback(async (cursor: TaskHistoryCursor) => {
    const ok = await runFetch(HISTORY_PAGE, 12_000, cursor);
    setHistoryError(!ok);
    setHistoryLoaded(true);
    return ok;
  }, [runFetch]);

  // Initial open — retry ladder so a congested transport still opens with
  // partial history instead of a full-screen "加载超时".
  const loadInitial = useCallback(async () => {
    setHistoryLoaded(false);
    setHistoryError(false);
    let ok = await runFetch(HISTORY_PAGE, 10_000);
    if (!ok) {
      ok = await runFetch(6, 6_000);
    }
    setHistoryError(!ok);
    setHistoryLoaded(true);
  }, [runFetch]);

  useEffect(() => {
    historyUnsupportedRef.current = false;
    setMessages([]);
    setHistoryLoaded(false);
    setHistoryError(false);
    anchoredRef.current = false;
    firstAnchorRef.current = true;
    atBottomRef.current = true;
    prevBubblesRef.current = 0;
    setNewBelow(0);
    setErrorFor(null);
    setHasOlder(true);
    loadInitial();
    // Text sends are persisted before POST. If the tab/app died during an
    // ambiguous request, restore the bubble instead of silently losing it;
    // tapping retry reuses the same durable request id and is safe.
    const pending = chatOutboxForAlias(alias, privateStorageScope).map((entry): ChatTask => ({
      task_id: entry.localTaskId,
      client_request_id: entry.requestId,
      from_name: 'Dashboard',
      to_name: entry.targetAlias,
      status: 'failed',
      priority: entry.priority,
      content: entry.content,
      result: '❌ 发送结果未确认，点此安全重试',
      created_at: entry.createdAt,
    }));
    if (pending.length > 0) {
      setMessages(prev => {
        const known = new Set(prev.map(item => item.task_id));
        return [...prev, ...pending.filter(item => !known.has(item.task_id))];
      });
    }
    // Focus textarea
    const focusTimer = autoFocus ? setTimeout(() => textareaRef.current?.focus({ preventScroll: !!scopeNetworkId }), 300) : undefined;
    return () => clearTimeout(focusTimer);
  }, [alias, loadInitial, privateStorageScope, scopeNetworkId, autoFocus]);

  // M4: user scrolled to the top → fetch one older page, keeping the
  // viewport anchored on the message they were looking at.
  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasOlder) return;
    const cursor = oldestTaskHistoryCursor(messages);
    if (!cursor) {
      setHasOlder(false);
      return;
    }
    setLoadingOlder(true);
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    skipAutoScrollRef.current = true;
    const loaded = await loadHistory({ task_id: cursor.task_id, created_at: cursor.created_at });
    requestAnimationFrame(() => {
      if (loaded && el) el.scrollTop += el.scrollHeight - prevHeight;
      if (!loaded) skipAutoScrollRef.current = false;
      setLoadingOlder(false);
    });
  }, [loadingOlder, hasOlder, loadHistory, messages]);

  const onMessagesScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = dist < 80;
    if (atBottomRef.current) setNewBelow(0);
    // The initial bottom-anchor is a smooth scroll, so its own scroll
    // events pass through scrollTop≈0 territory. Arm the older-page
    // trigger only after the container has actually reached the bottom
    // once — everything before that is layout/auto-scroll noise.
    if (!anchoredRef.current) {
      if (dist < 80) anchoredRef.current = true;
      return;
    }
    if (el.scrollTop < 40) loadOlder();
  }, [loadOlder]);

  // Auto-scroll to bottom on new messages — but not when we just
  // prepended older history (that would yank the user away from what
  // they scrolled up to read). P0 chat batch: the FIRST anchor after a
  // history load is instant ('auto') — a smooth scroll from the top made
  // the whole wall visibly fly past on open, which read as "everything
  // loaded at once". Subsequent new-message anchors stay smooth.
  const firstAnchorRef = useRef(true);
  useEffect(() => {
    const bubbles = messages.reduce((n, m) => n + (m.result ? 2 : 1), 0);
    const prevBubbles = prevBubblesRef.current;
    prevBubblesRef.current = bubbles;
    if (skipAutoScrollRef.current) {
      skipAutoScrollRef.current = false;
      return;
    }
    if (messages.length === 0) return;
    // R10: scrolled-up readers keep their place — count the arrivals
    // into the pill instead of yanking to the bottom. Own sends
    // (forceScrollRef) and the first anchor always jump.
    if (!firstAnchorRef.current && !forceScrollRef.current && !atBottomRef.current) {
      if (bubbles > prevBubbles) setNewBelow(n => n + (bubbles - prevBubbles));
      return;
    }
    const behavior: ScrollBehavior = firstAnchorRef.current ? 'auto' : 'smooth';
    firstAnchorRef.current = false;
    forceScrollRef.current = false;
    // Embedded scenes must not scroll their page/camera out of view with the chat.
    if (scopeNetworkId) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior });
    else messagesEndRef.current?.scrollIntoView({ behavior });
  }, [messages, scopeNetworkId]);

  // SSE-driven task updates: the server pushes new_reply events to the
  // sender's alias channel (/events/<from_session>), so we just listen for
  // them and patch the matching bubble immediately. No polling needed for
  // the normal path. The polling block below remains as a safety-net for
  // SSE-unavailable environments / disconnect windows.
  // Loop R5 (实时收消息): the subscription used to be gated on
  // pollingIds>0 — an IDLE panel was deaf, so messages sent to this alias
  // by OTHERS (or replies to tasks sent before mount) only appeared on
  // reopen. R1's shared channel makes an always-on subscription free (no
  // extra connection), so:
  //   · new_reply for OUR in-flight sends keeps the fast targeted patch;
  //   · any other new_task/new_message/new_reply soft-refreshes the
  //     window (debounced 1.5s trailing; runFetch merge-by-id keeps
  //     optimistic bubbles, so a refresh never drops an in-flight send).
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSoftRefreshRef = useRef(0);
  useEffect(() => () => { if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current); }, []);
  useSSE({
    url: scopedChatUrl('/api/hub/events'),
    enabled: true,
    onEvent: async (e: { type?: string; in_reply_to?: string; message_id?: string }) => {
      const t = e?.type || '';
      if (t === 'new_reply' && e.in_reply_to && pollingIds.has(e.in_reply_to)) {
        // Fast path: a reply to a task WE sent from this panel.
        try {
          const res = await fetch(scopedChatUrl(`/api/hub/tasks?task_id=${encodeURIComponent(e.in_reply_to)}`));
          const data = await res.json();
          const updated = data?.tasks?.[0];
          if (!updated) return;
          setMessages(prev => prev.map(m => m.task_id === e.in_reply_to ? { ...m, ...updated } : m));
          if (['replied', 'failed', 'closed', 'expired', 'cancelled'].includes(updated.status)) {
            setPollingIds(prev => { const n = new Set(prev); n.delete(e.in_reply_to!); return n; });
          }
        } catch {}
        return; // handled — don't ALSO soft-refresh for the same event
      }
      if (!['new_task', 'new_message', 'new_reply', 'broadcast'].includes(t)) return;
      if (!historyLoaded) return; // initial load owns the first paint
      if (!isActive) return;      // R11: background tabs catch up on activation instead
      // R11: floor between soft refreshes — on a busy fleet (192 agents)
      // events arrive faster than the 1.5s debounce can coalesce, and the
      // active panel refetched its window ~25×/min. One event batch every
      // ≥6s is plenty for a 12-item history window; sends still patch
      // instantly via the fast path above.
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      const wait = Math.max(1500, 6000 - (Date.now() - lastSoftRefreshRef.current));
      refreshTimerRef.current = setTimeout(() => {
        lastSoftRefreshRef.current = Date.now();
        runFetch(HISTORY_PAGE, 12_000);
      }, wait);
    },
  });

  // Loop R5b (honest finding): the hub only pushes events on the
  // sender's/recipient's OWN channels — a dashboard observer's channel gets
  // NOTHING for third-party traffic (verified: 12s capture during an
  // api→node send = only "connected"). Until the hub grows an observer
  // stream (ask filed), an OPEN panel soft-refreshes every 15s — paused
  // while the tab is hidden — so incoming messages appear without a
  // reopen. runFetch's merge-by-id keeps optimistic bubbles intact.
  // R11 (多面板降频): CommandCenter keeps EVERY tab mounted, so N tabs
  // used to mean N pollers AND N per-SSE-event soft-refreshers — measured
  // 40 history-window fetches/min with 4 tabs on a busy fleet. Only the
  // visible tab refreshes now; a tab returning to the foreground does one
  // immediate catch-up fetch so it never shows stale history.
  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    if (!historyLoaded || !isActive) {
      wasActiveRef.current = isActive;
      return;
    }
    if (!wasActiveRef.current) {
      runFetch(HISTORY_PAGE, 12_000);
      // R27 (微信手感): switching back to a tab refocuses the composer —
      // desktop only (focusing on touch pops the soft keyboard uninvited).
      if (autoFocus && !coarsePointerRef.current) textareaRef.current?.focus({ preventScroll: !!scopeNetworkId });
    }
    wasActiveRef.current = true;
    const id = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      runFetch(HISTORY_PAGE, 12_000);
    }, 15_000);
    return () => clearInterval(id);
  }, [historyLoaded, isActive, runFetch, scopeNetworkId, autoFocus]);

  // Polling fallback (SSE-unavailable / proxies stripping events).
  // Slow cadence so we're not the bulk of server load — SSE handles the fast path.
  useEffect(() => {
    if (pollingIds.size === 0) return;
    // 30s cadence — the SSE listener handles the fast path. Polling only
    // catches state when the SSE connection is unavailable (proxy stripping
    // events, browser HTTP/2 oddities, etc). Cap 1h to match server TTL.
    const startTime = Date.now();
    const interval = setInterval(async () => {
      if (Date.now() - startTime > 3600_000) {
        setPollingIds(new Set());
        clearInterval(interval);
        return;
      }
      for (const taskId of pollingIds) {
        try {
          const res = await fetch(scopedChatUrl(`/api/hub/tasks?task_id=${encodeURIComponent(taskId)}`));
          const data = await res.json();
          if (data.tasks?.[0]) {
            const updated = data.tasks[0];
            setMessages(prev => prev.map(m => m.task_id === taskId ? { ...m, ...updated } : m));
            if (['replied', 'failed', 'closed', 'expired', 'cancelled'].includes(updated.status)) {
              setPollingIds(prev => { const n = new Set(prev); n.delete(taskId); return n; });
            }
          }
        } catch {}
      }
    }, 30_000);
    return () => clearInterval(interval);
  }, [pollingIds, scopedChatUrl]);

  // #492 upload half — proxied to hub, Bearer server-side. The
  // returned attachment carries `file_id` (canonical hub identifier)
  // in the STRUCTURED payload only; we deliberately don't put
  // file_id anywhere copy/share-friendly (see #495: hub currently
  // doesn't enforce owner scope on `/api/files/:id`, so a leaked
  // file_id = leaked file).
  //
  // Errors surface via `throw` so `send()` catches them and paints
  // the failed-message bubble with the hub's user-visible `message`
  // (rate-limited / too-large / etc.) — never "点了没反应" silence.
  const uploadAttachments = async (files: File[]) => {
    const uploaded: Array<{ file_id: string; name: string; mime?: string; size?: number }> = [];
    if (files.length > 0) setUploadProgress({ done: 0, total: files.length });
    for (const file of files) {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/hub/upload', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` }));
      if (!res.ok || !data.ok || !data.file_id) {
        // Prefer server-provided human-readable `message`; fall back to
        // `error` code / raw status. Include filename for multi-file
        // uploads so the user knows WHICH file failed.
        const msg = data.message || data.error || `HTTP ${res.status}`;
        throw new Error(files.length > 1 ? `${file.name}: ${msg}` : msg);
      }
      uploaded.push({
        file_id: data.file_id,
        name: file.name,
        mime: data.mime || file.type,
        size: data.size ?? file.size,
      });
      setUploadProgress({ done: uploaded.length, total: files.length });
    }
    return uploaded;
  };

  const send = async () => {
    if ((!input.trim() && attachedFiles.length === 0) || sending) return;
    let taskContent = input.trim();
    // `alias` is the target rendered in the panel header. Do not mirror it in
    // effect-synchronised state: after switching the singleton chat popover,
    // React can render the new header one frame before that effect runs, and
    // an immediate send would otherwise be delivered to the previous node.
    let sendTo = alias;

    // Parse @mention at start: "@NodeName rest of message"
    const atMatch = taskContent.match(/^@(\S+)\s+([\s\S]+)/);
    if (atMatch) {
      const mentioned = mentionNodes.find(n => n.toLowerCase() === atMatch[1].toLowerCase());
      if (mentioned) {
        sendTo = mentioned;
        taskContent = atMatch[2];
      }
    }

    const filesToSend = attachedFiles;
    // Floating hosts return focus at the user's send action, never after an
    // awaited response that could arrive after they moved back to the scene.
    if (!autoFocus) textareaRef.current?.focus({ preventScroll: !!scopeNetworkId });
    setSending(true);
    setInput('');
    writeDraft(alias, '', networkId);
    forceScrollRef.current = true;
    setAttachedFiles([]);
    setShowMentions(false);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    // NB: user-visible attachment description only — file_id lives in
    // the structured `meta.attachments` field the LLM/agent side reads.
    // Keeping file_id out of the visible task text is deliberate
    // (#495: leaked file_id = leaked file until owner scope lands).
    const pendingAttachmentText = attachedFiles.length > 0
      ? `\n\n[Dashboard 附件待上传]\n${attachedFiles.map(f => `- 附件: ${f.name}`).join('\n')}`
      : '';

    // Optimistic echo first so the user always sees their message in history
    // even if the network call fails or the server returns ok:false. Earlier
    // version only added on data.ok=true → silent failures looked like
    // 'tasks get swallowed'.
    const requestId = newDashboardRequestId();
    const localTaskId = `tmp-${requestId}`;
    const optimistic: ChatTask = {
      task_id: localTaskId,
      from_name: 'Dashboard',
      to_name: sendTo,
      status: 'created',
      priority,
      content: `${taskContent}${pendingAttachmentText}`.trim(),
      result: '',
      created_at: new Date().toISOString(),
      client_request_id: requestId,
    };
    setMessages(prev => [...prev, optimistic]);

    // File objects cannot be restored safely after a browser/app restart.
    // Persist text-only sends; attachment retries remain available for the
    // current session through pendingFilesRef.
    if (filesToSend.length === 0) {
      putChatOutbox({
        requestId, localTaskId, panelAlias: alias, targetAlias: sendTo,
        content: taskContent, priority, networkId: scopeNetworkId || aliasNetRef.current[sendTo] || networkId || '',
        createdAt: optimistic.created_at,
      }, privateStorageScope);
    }

    try {
      const uploaded = await uploadAttachments(filesToSend);
      if (uploaded.length > 0) {
        // Human-readable description only — no file_id in visible
        // text (see #495). Receiver's structured `meta.attachments`
        // carries the file_id for cross-host fetch.
        const attachmentText = [
          '',
          '',
          '[Dashboard 附件]',
          ...uploaded.map(f =>
            `- 附件: ${f.name}${f.size != null ? ` (${formatBytesShort(f.size)})` : ''}`,
          ),
        ].join('\n');
        taskContent = `${taskContent}${attachmentText}`.trim();
        setMessages(prev => prev.map(m =>
          m.task_id === localTaskId ? { ...m, content: taskContent } : m,
        ));
      }
      await postTask(taskContent, sendTo, localTaskId, uploaded, requestId);
    } catch (e: unknown) {
      // Don't prefix "network error:" — this catch now covers semantic
      // errors thrown by uploadAttachments (rate-limited, too-large,
      // wrong content-type, ...) which already carry a Chinese
      // human-readable message. Prepending "network error:" mangles it
      // into "❌ network error: 上传太频繁 — 请 30 秒后再试" which
      // points the user at the wrong layer. If the message really IS
      // a raw fetch failure, `msg` is "Failed to fetch" / similar and
      // still reads truthfully without the prefix.
      const msg = e instanceof Error ? e.message : String(e);
      if (filesToSend.length > 0) pendingFilesRef.current.set(localTaskId, filesToSend);
      setMessages(prev => prev.map(m =>
        m.task_id === localTaskId ? { ...m, status: 'failed', result: `❌ ${msg}` } : m,
      ));
    }
    setSending(false);
    setUploadProgress(null);
    if (autoFocus) textareaRef.current?.focus({ preventScroll: !!scopeNetworkId });
  };

  // Core POST shared by send() and the failed-bubble retry (R4: WeChat-style
  // resend — a failed message shouldn't force the user to retype it).
  const postTask = async (taskContent: string, sendTo: string, localTaskId: string, uploaded: Array<{ file_id: string; name: string; mime?: string; size?: number }> = [], requestId?: string) => {
    try {
      const res = await fetch('/api/hub/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alias: sendTo, task: taskContent, priority, attachments: uploaded,
          ...(requestId ? { request_id: requestId } : {}),
          // P0: multi-network users MUST scope the send or the hub rejects.
          ...((scopeNetworkId || aliasNetRef.current[sendTo] || networkId) ? { network_id: scopeNetworkId || aliasNetRef.current[sendTo] || networkId } : {}),
        }),
      });
      const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      const normalized = normalizeChatSendResult(data);
      if (normalized.accepted && normalized.messageId) {
        setMessages(prev => prev.map(m =>
          m.task_id === localTaskId ? { ...m, task_id: normalized.messageId!, status: normalized.status! } : m,
        ));
        setPollingIds(prev => new Set(prev).add(normalized.messageId!));
        if (requestId) removeChatOutbox(requestId, privateStorageScope);
      } else {
        const reason = data.error || data.detail || `send failed (status ${res.status})`;
        setMessages(prev => prev.map(m =>
          m.task_id === localTaskId ? { ...m, status: 'failed', result: `❌ ${reason}` } : m,
        ));
      }
    } catch (e: unknown) {
      // See send() catch above — "network error:" prefix is dropped
      // for the same reason. Even for a genuine fetch failure the raw
      // browser message ("Failed to fetch") already reads as
      // network-layer without the prefix.
      const msg = e instanceof Error ? e.message : String(e);
      setMessages(prev => prev.map(m =>
        m.task_id === localTaskId ? { ...m, status: 'failed', result: `❌ ${msg}` } : m,
      ));
    }
  };

  // R4: tap-to-retry a failed send — reset the SAME bubble to in-flight and
  // re-POST with identical content/target; no retyping (WeChat red-! flow).
  // R36 (发图流程): files whose UPLOAD failed, keyed by the optimistic
  // task id — resend re-uploads them instead of sending the
  // "[Dashboard 附件待上传]" placeholder text with no image (measured bug:
  // retry after an upload failure lost the attachment entirely).
  const pendingFilesRef = useRef<Map<string, File[]>>(new Map());
  const retryLockRef = useRef<Set<string>>(new Set());
  const retrySend = async (m: ChatTask) => {
    // R5 (R4 self-review debt): double-click guard — a second tap while the
    // retry POST is in flight must not fire a duplicate send.
    if (retryLockRef.current.has(m.task_id)) return;
    retryLockRef.current.add(m.task_id);
    // Strip the un-uploaded placeholder; a retry with pending files
    // re-uploads them and rebuilds the real attachment block.
    const files = pendingFilesRef.current.get(m.task_id) || [];
    const cleanContent = m.content.replace(/\n*\[Dashboard 附件待上传\][\s\S]*$/, '').trim();
    setMessages(prev => prev.map(x =>
      x.task_id === m.task_id ? { ...x, status: 'created', result: '' } : x,
    ));
    try {
      let content = cleanContent;
      let uploaded: Awaited<ReturnType<typeof uploadAttachments>> = [];
      if (files.length > 0) {
        uploaded = await uploadAttachments(files);
        if (uploaded.length > 0) {
          content = `${content}\n\n[Dashboard 附件]\n${uploaded.map(f =>
            `- 附件: ${f.name}${f.size != null ? ` (${formatBytesShort(f.size)})` : ''}`,
          ).join('\n')}`.trim();
          setMessages(prev => prev.map(x => x.task_id === m.task_id ? { ...x, content } : x));
        }
      }
      await postTask(content, m.to_name, m.task_id, uploaded, m.client_request_id);
      pendingFilesRef.current.delete(m.task_id);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setMessages(prev => prev.map(x =>
        x.task_id === m.task_id ? { ...x, status: 'failed', result: `❌ ${msg}` } : x,
      ));
    } finally {
      retryLockRef.current.delete(m.task_id);
      setUploadProgress(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // R22: while the @ mention dropdown is open the keyboard drives IT —
    // previously Enter SENT the half-typed "@通" as a message. ↑↓ move,
    // Enter/Tab select, Escape closes (below).
    if (showMentions && filteredMentions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => (i + 1) % filteredMentions.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => (i - 1 + filteredMentions.length) % filteredMentions.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (!e.nativeEvent.isComposing) { e.preventDefault(); insertMention(filteredMentions[Math.min(mentionIndex, filteredMentions.length - 1)]); }
        return;
      }
    }
    // Enter sends, Shift+Enter inserts newline (standard DESKTOP chat UX —
    // users habit-pressed Enter expecting send). On touch (coarse pointer)
    // Enter inserts a newline instead: phones have no Shift, and WeChat
    // mobile sends via the button.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      if (coarsePointerRef.current) return; // mobile: newline
      e.preventDefault();
      send();
    }
    if (e.key === 'Escape') setShowMentions(false);
  };

  const handleInputChange = (value: string) => {
    setInput(value);
    // Check if user just typed @
    const lastAt = value.lastIndexOf('@');
    if (lastAt >= 0 && (lastAt === 0 || value[lastAt - 1] === ' ' || value[lastAt - 1] === '\n')) {
      const after = value.slice(lastAt + 1);
      if (!after.includes(' ') && !after.includes('\n')) {
        setMentionFilter(after.toLowerCase());
        setMentionIndex(0);
        setShowMentions(true);
        return;
      }
    }
    setShowMentions(false);
  };

  // #492 — accept any file type (not just images). The hub enforces
  // a 12 MiB per-file cap; we don't pre-reject on the client because
  // (a) the hub is the single source of truth for the limit,
  // (b) even oversize files should attempt the upload so the user
  //     sees the hub's "文件超过 12 MB 上限" message rather than
  //     silent client-side rejection.
  const addFiles = (files: FileList | File[]) => {
    const picked = Array.from(files);
    if (picked.length === 0) return;
    if (attachedFiles.length + picked.length > 6) {
      setAttachLimitHit(true);
      setTimeout(() => setAttachLimitHit(false), 3000);
    }
    setAttachedFiles(prev => [...prev, ...picked].slice(0, 6));
  };

  // ── 语音输入（对齐客户端） ────────────────────────────────────────
  // 录一段音 → 包成 File → 走已有的上传/附件链路（`/api/hub/upload` + `meta.attachments`）。
  // 不新开接口：附件那条路已经有 12 MiB 限制、429 文案、失败气泡，语音没有理由另起一套。
  // 编码：Chrome/Firefox 用 webm/opus；Safari 只有 audio/mp4，故按 isTypeSupported 逐个试。
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [recError, setRecError] = useState('');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<BlobPart[]>([]);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const REC_MAX_SECONDS = 120;

  const stopRecorder = () => {
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
    recorderRef.current = null;
    setRecording(false);
    setRecSeconds(0);
  };

  const startRecording = async () => {
    setRecError('');
    if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined'
      || !navigator.mediaDevices?.getUserMedia) {
      setRecError(t('这个浏览器不支持录音', 'Recording is not supported in this browser'));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
      const mime = types.find(type => MediaRecorder.isTypeSupported?.(type)) || '';
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recChunksRef.current = [];
      rec.ondataavailable = event => { if (event.data && event.data.size > 0) recChunksRef.current.push(event.data); };
      rec.onstop = () => {
        // 录音结束必须释放麦克风，否则浏览器标签页会一直亮着录音图标。
        stream.getTracks().forEach(track => track.stop());
        const type = rec.mimeType || mime || 'audio/webm';
        const blob = new Blob(recChunksRef.current, { type });
        recChunksRef.current = [];
        if (blob.size < 800) {
          // 太短的片段（误点一下）不值得发：明确说一句，而不是上传 0.1 秒的噪音。
          setRecError(t('录音太短，按住先说几句', 'Recording too short'));
          return;
        }
        const ext = type.includes('mp4') ? 'm4a' : 'webm';
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(11, 19);
        const file = new File([blob], `voice-${stamp}.${ext}`, { type });
        addFiles([file]);
      };
      rec.onerror = () => setRecError(t('录音出错了', 'Recording failed'));
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
      setRecSeconds(0);
      recTimerRef.current = setInterval(() => {
        setRecSeconds(prev => {
          if (prev + 1 >= REC_MAX_SECONDS) { stopRecorder(); return 0; }
          return prev + 1;
        });
      }, 1000);
    } catch (err) {
      // 权限被拒 / 没有麦克风：把原因写出来，不要按钮点了没反应。
      const name = (err as { name?: string })?.name || '';
      setRecError(name === 'NotAllowedError'
        ? t('麦克风权限被拒，请在浏览器设置里允许', 'Microphone permission denied')
        : t('没有可用的麦克风', 'No microphone available'));
    }
  };

  useEffect(() => () => {
    // 组件卸载时停止录音与计时，避免离开面板后麦克风还开着。
    if (recTimerRef.current) clearInterval(recTimerRef.current);
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
  }, []);

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files || []);
    if (files.length > 0) {
      addFiles(files);
      e.preventDefault();
    }
  };

  const insertMention = (nodeName: string) => {
    const lastAt = input.lastIndexOf('@');
    const before = input.slice(0, lastAt);
    setInput(`${before}@${nodeName} `);
    setShowMentions(false);
    textareaRef.current?.focus({ preventScroll: !!scopeNetworkId });
  };

  const filteredMentions = mentionNodes.filter(n =>
    n !== alias && pinyinMatch(n, mentionFilter)
  ).slice(0, 8);

  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
  };

  const chatEvents: ChatEvent[] = messages
    .flatMap((task): ChatEvent[] => {
      const events: ChatEvent[] = [{ kind: 'task', task, at: task.created_at }];
      // R19: a FAILED send stores its error in `result` — that must not
      // masquerade as an agent reply bubble; the red ! badge carries it.
      if (task.result && task.status !== 'failed') events.push({ kind: 'reply', task, at: task.completed_at || task.created_at });
      return events;
    })
    .sort((a, b) => {
      const delta = eventTime(a.at) - eventTime(b.at);
      if (delta !== 0) return delta;
      if (a.task.task_id !== b.task.task_id) return a.task.task_id.localeCompare(b.task.task_id);
      return a.kind === 'task' ? -1 : 1;
    });

  const query = searchQuery.trim().toLowerCase();
  const searchMatches = query
    ? chatEvents
        .filter((ev) => {
          const text = ev.kind === 'reply' ? ev.task.result : ev.task.content;
          return (text || '').toLowerCase().includes(query);
        })
        .map((ev) => `${ev.task.task_id}:${ev.kind}`)
    : [];
  const currentMatchKey = searchMatches.length ? searchMatches[Math.min(searchIdx, searchMatches.length - 1)] : null;
  // New query starts at the NEWEST match (WeChat searches backwards in time).
  useEffect(() => { setSearchIdx(Math.max(0, searchMatches.length - 1)); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [query]);
  useEffect(() => {
    if (!currentMatchKey) return;
    const el = scrollRef.current?.querySelector(`[data-ev="${CSS.escape(currentMatchKey)}"]`);
    const container = scrollRef.current;
    if (scopeNetworkId && el && container) container.scrollTo({ top: container.scrollTop + el.getBoundingClientRect().top - container.getBoundingClientRect().top - container.clientHeight / 2, behavior: 'smooth' });
    else el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [currentMatchKey, scopeNetworkId]);
  const stepMatch = (delta: number) => {
    if (!searchMatches.length) return;
    setSearchIdx((i) => (i + delta + searchMatches.length) % searchMatches.length);
  };
  const closeSearch = () => { setSearchOpen(false); setSearchQuery(''); };

  // Inline mode: just the chat content, no panel chrome
  const chatContent = (
    <>
        {/* Messages area */}
        {/* R12 of #190 mobile polish: the chat scroll surface used
            space-y-3 between task+reply pairs at mobile = 12 px, which
            in a long thread (the panel's bread-and-butter use case)
            adds up to a significant scroll length. Drop to space-y-2 at
            mobile and the per-pair grouping (line 540) from space-y-2
            to space-y-1.5 so messages read denser without losing the
            speaker-turn rhythm. Desktop unchanged at sm: and up. */}
        <div ref={scrollRef} onScroll={onMessagesScroll} data-testid="chat-messages-scroll" className="flex-1 overflow-y-auto px-3 py-3 sm:px-4 sm:py-4 space-y-2 sm:space-y-4">
          {searchOpen ? (
            <div className="sticky top-0 z-20 -mx-1 flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]/95 px-2 py-1.5 shadow-lg shadow-black/30 backdrop-blur">
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { e.stopPropagation(); closeSearch(); }
                  else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); stepMatch(1); }
                  else if (e.key === 'Enter') { e.preventDefault(); stepMatch(-1); }
                }}
                placeholder={t('搜索会话…', 'Search conversation…')}
                className="min-w-0 flex-1 bg-transparent text-xs text-[var(--fg)] placeholder-[var(--fg-dim)] focus:outline-none"
              />
              <span className="shrink-0 text-[10px] tabular-nums text-[var(--fg-dim)]">
                {searchMatches.length ? `${Math.min(searchIdx, searchMatches.length - 1) + 1}/${searchMatches.length}` : searchQuery.trim() ? t('0 条', '0 found') : t(`${chatEvents.length} 条内`, `in ${chatEvents.length}`)}
              </span>
              <button type="button" onClick={() => stepMatch(-1)} aria-label={t('上一条（更早）', 'Previous (older)')} className="shrink-0 rounded px-1 text-[var(--fg-dim)] hover:text-[var(--accent-text)]">↑</button>
              <button type="button" onClick={() => stepMatch(1)} aria-label={t('下一条（更新）', 'Next (newer)')} className="shrink-0 rounded px-1 text-[var(--fg-dim)] hover:text-[var(--accent-text)]">↓</button>
              <button type="button" onClick={closeSearch} aria-label={t('关闭搜索', 'Close search')} className="shrink-0 rounded px-1 text-[var(--fg-dim)] hover:text-[var(--fg)]">×</button>
            </div>
          ) : (
            <div className="sticky top-0 z-20 flex justify-end pointer-events-none -mb-8">
              <button
                type="button"
                onClick={() => { setSearchOpen(true); setTimeout(() => searchInputRef.current?.focus({ preventScroll: !!scopeNetworkId }), 50); }}
                aria-label={t('搜索会话', 'Search conversation')}
                className="pointer-events-auto inline-flex min-h-[40px] min-w-[40px] items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-elevated)]/80 text-[var(--fg-dim)] shadow hover:text-[var(--accent-text)] sm:min-h-0 sm:min-w-0 sm:p-1.5"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
                </svg>
              </button>
            </div>
          )}
          {!historyLoaded && (
            <div className="flex justify-center py-8">
              <div className="w-5 h-5 border-2 border-[var(--accent)]/30 border-t-cyan-500 rounded-full animate-spin" />
            </div>
          )}
          {/* M4: top-of-thread row — scroll-to-top auto-loads older, and
              the row is also tappable for short threads that don't
              overflow (nothing to scroll). Quiet "beginning" marker
              once history is exhausted. */}
          {historyLoaded && hasOlder && messages.length > 0 && (
            <button
              type="button"
              onClick={loadOlder}
              className="w-full flex justify-center py-2 text-[11px] text-[var(--fg-dim)] hover:text-[var(--fg-muted)]"
            >
              {loadingOlder ? (
                <span className="w-4 h-4 border-2 border-[var(--accent)]/30 border-t-cyan-500 rounded-full animate-spin" />
              ) : (
                <span>↑ Load earlier messages</span>
              )}
            </button>
          )}
          {historyLoaded && !hasOlder && messages.length > 0 && (
            <div className="text-center text-[10px] text-[var(--fg-dim)] py-1">— beginning of history —</div>
          )}
          {historyLoaded && !historyError && messages.length === 0 && (
            <div className="text-center py-12">
              <div className="text-3xl mb-3">💬</div>
              <div className="text-[var(--fg-muted)] text-sm">Start a conversation</div>
              <div className="text-[var(--fg-dim)] text-xs mt-1">Send a task to {alias}</div>
            </div>
          )}
          {/* Vincent tg923 + timeout-degrade: both bounded attempts failed —
              usually a congested transport, not the query. Degrade to a calm
              "slow connection" message and, crucially, tell the user the
              composer below still works so a stuck history never blocks
              sending. Retry re-runs the full ladder (20 → 6). */}
          {historyLoaded && historyError && messages.length === 0 && (
            <div className="text-center py-12">
              <div className="text-[var(--fg-muted)] text-sm">{scopeNetworkId && historyErrorReason ? historyErrorReason : '连接较慢，暂未加载出历史'}</div>
              <div className="text-[var(--fg-dim)] text-xs mt-1">你仍可在下方直接给 {alias} 发消息</div>
              {historyErrorReason !== SCOPED_HISTORY_UNSUPPORTED && <button
                type="button"
                onClick={() => loadInitial()}
                className="mt-3 text-xs text-[var(--accent-text)] hover:text-[var(--accent-text)] underline"
              >
                重试加载历史
              </button>}
            </div>
          )}

          {chatEvents.map((event, i) => {
            const m = event.task;
            // WeChat-style time separator: first message, or >5min gap.
            const prevAt = i > 0 ? chatEvents[i - 1].at : null;
            const showSep = !prevAt || eventTime(event.at) - eventTime(prevAt) > TIME_GROUP_GAP_MS;
            const sepEl = showSep ? (
              <div className="flex justify-center py-1.5">
                <span className="text-[10px] text-[var(--fg-dim)] bg-[var(--bg-elevated)] rounded px-2 py-0.5">{formatWeChatTime(event.at)}</span>
              </div>
            ) : null;
            // Distinguish task source so users can tell when a peer agent
            // forwarded a task vs when they themselves sent it from Dashboard.
            // #35：`hub` 不是当前用户。它是 Hub 自己的发送身份（tasks.from_name
            // 的默认值），广播/系统通知走这里；口径统一放在 chat-sender 里。
            const fromUser = isOwnSender(m.from_name);
            const senderLabel = senderLabelFor(m.from_name);
            const senderBadge = fromUser
              ? null
              : <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-purple-500/15 border border-purple-500/30 text-[9px] text-purple-300 font-medium">↳ {senderLabel}</span>;
            if (event.kind === 'reply') {
              return (
                <Fragment key={`${m.task_id}:reply`}>
                {sepEl}
                <div className="flex justify-start" data-ev={`${m.task_id}:reply`}>
                  <div title={event.at} className={`group/bubble max-w-[92%] sm:max-w-[min(85%,56ch)] bg-green-500/8 rounded-2xl rounded-bl-md px-3 py-2.5 sm:px-4 ${currentMatchKey === `${m.task_id}:reply` ? 'ring-2 ring-yellow-400/60' : ''}`}>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        {m.to_name && <AliasAvatar alias={m.to_name} size={14} />}
                        <span className="text-[10px] text-[var(--fg)] font-medium truncate">{m.to_name}</span>
                        <span className="text-[9px] text-green-300/70">replied</span>
                      </div>
                      <CopyButton text={m.result || ''} label={t('复制回复', 'Copy reply')} />
                    </div>
                    <div className="mb-2 rounded-lg border-l-2 border-cyan-400/40 bg-black/20 px-2.5 py-1.5">
                      <div className="text-[9px] text-[var(--accent-text)]/80">
                        引用 {senderLabel} 的任务 · {formatTimestamp(m.created_at)}
                      </div>
                      <div className="mt-0.5 max-h-10 overflow-hidden text-[11px] leading-5 text-[var(--fg-muted)]">
                        {quotePreview(m.content) || 'No content'}
                      </div>
                    </div>
                    <div className="text-[14px] leading-[1.65] text-[var(--fg)]">
                      <CollapsibleText><MarkdownContent text={m.result} onImageClick={openLightbox} /></CollapsibleText>
                      <AttachmentPreviews text={m.result} onOpen={openLightbox} />
                      {/* #492: structured attachments from meta.attachments —
                          hub delivers file_id + name/mime/size and the
                          <AttachmentBlock> click path fetches via the
                          `/api/hub/files/<id>` proxy (Bearer added
                          server-side; no token in URL/logs). Historical
                          messages render automatic because meta is in the
                          persisted task row, not on the wire event. */}
                      {extractAttachments(m).map((att, i) => (
                        <AttachmentBlock key={`att-r-${att.file_id ?? att.path ?? i}`} attachment={att} />
                      ))}
                    </div>
                  </div>
                </div>
                </Fragment>
              );
            }
            return (
            <Fragment key={`${m.task_id}:task`}>
            {sepEl}
            <div className="space-y-1.5 sm:space-y-2">
              {/* Outgoing task — labeled with origin so peer-forwarded tasks are obvious */}
              <div className="flex items-center justify-end gap-1.5" data-ev={`${m.task_id}:task`}>
                {m.status === 'failed' && fromUser && (
                  <button
                    type="button"
                    onClick={() => setErrorFor((cur) => (cur === m.task_id ? null : m.task_id))}
                    title={(m.result || '').replace(/^❌\s*/, '') || t('发送失败', 'Send failed')}
                    aria-label={t('发送失败，点击查看原因', 'Send failed — tap for reason')}
                    aria-expanded={errorFor === m.task_id}
                    className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--danger)] text-[11px] font-bold leading-none text-[var(--fg)]"
                  >
                    !
                  </button>
                )}
                <div title={m.created_at} className={`group/bubble max-w-[92%] sm:max-w-[min(85%,56ch)] bg-[var(--accent)]/8 rounded-2xl rounded-br-md px-3 py-2.5 sm:px-4 ${currentMatchKey === `${m.task_id}:task` ? 'ring-2 ring-yellow-400/60' : ''}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-[10px] font-medium ${fromUser ? 'text-[var(--accent-text)]' : 'text-purple-300'}`}>{senderLabel}</span>
                    {!fromUser && <span className="text-[9px] text-[var(--fg-dim)]">forwarded to {m.to_name}</span>}
                    <span className="flex-1" />
                    <CopyButton text={m.content || ''} label={t('复制内容', 'Copy message')} />
                  </div>
                  <div className="text-[14px] leading-[1.65] text-[var(--fg)]">
                    <CollapsibleText><MarkdownContent text={m.content} onImageClick={openLightbox} /></CollapsibleText>
                    <AttachmentPreviews text={m.content} onOpen={openLightbox} />
                    {/* #492: outbound-task attachments render too — user
                        uploads with a task carry file_id in meta_json;
                        showing them here means the send-side and
                        receive-side see the same clickable blocks. */}
                    {extractAttachments(m).map((att, i) => (
                      <AttachmentBlock key={`att-t-${att.file_id ?? att.path ?? i}`} attachment={att} />
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center justify-between mt-1.5 gap-2 sm:gap-3">
                    <StatusBar status={m.status} result={m.result} />
                    <div className="flex items-center gap-2 shrink-0">
                      {/* R4: WeChat send-feedback loop — spinner while the
                          optimistic bubble is still in flight; tap-to-resend
                          on failure (same bubble, no retyping). */}
                      {m.task_id.startsWith('tmp-') && m.status !== 'failed' && (
                        <span aria-label={t('发送中', 'Sending')} className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--accent)]/30 border-t-cyan-400" />
                      )}
                      {m.status === 'failed' && fromUser && (
                        <button
                          type="button"
                          onClick={() => retrySend(m)}
                          className="inline-flex items-center gap-1 rounded-md border border-red-500/40 bg-[var(--danger)]/10 px-1.5 py-0.5 text-[10px] font-medium text-red-300 hover:bg-[var(--danger)]/20"
                        >
                          <span aria-hidden>↻</span> {t('重发', 'Resend')}
                        </button>
                      )}
                      {senderBadge}
                    </div>
                  </div>
                </div>
              </div>

              {m.status === 'failed' && errorFor === m.task_id && (
                <div className="flex justify-end">
                  <div className="max-w-[92%] rounded-lg border border-red-500/30 bg-[var(--danger)]/10 px-2.5 py-1.5 text-[11px] leading-5 text-red-300">
                    {(m.result || '').replace(/^❌\s*/, '') || t('发送失败', 'Send failed')}
                  </div>
                </div>
              )}

              {/* Typing indicator when running */}
              {m.status === 'running' && !m.result && (
                <div className="flex justify-start">
                  <div className="bg-[var(--bg-secondary)] rounded-2xl rounded-bl-md px-4 py-3">
                    <div className="flex gap-1">
                      <span className="w-2 h-2 rounded-full bg-[var(--fg-muted)] animate-bounce" style={{ animationDelay: '0s' }} />
                      <span className="w-2 h-2 rounded-full bg-[var(--fg-muted)] animate-bounce" style={{ animationDelay: '0.15s' }} />
                      <span className="w-2 h-2 rounded-full bg-[var(--fg-muted)] animate-bounce" style={{ animationDelay: '0.3s' }} />
                    </div>
                  </div>
                </div>
              )}
            </div>
            </Fragment>
            );
          })}
          <div ref={messagesEndRef} />
          {newBelow > 0 && (
            <div className="sticky bottom-1 z-10 flex justify-center pointer-events-none">
              <button
                type="button"
                onClick={() => {
                  setNewBelow(0);
                  atBottomRef.current = true;
                  if (scopeNetworkId) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
                  else messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
                }}
                className="pointer-events-auto flex items-center gap-1 rounded-full border border-[var(--accent)]/30 bg-[var(--bg-elevated)] px-3 py-1 text-[11px] text-[var(--accent-text)] shadow-lg shadow-black/40 hover:bg-[var(--accent)]/10"
              >
                ↓ {t(`${newBelow} 条新消息`, `${newBelow} new message${newBelow > 1 ? 's' : ''}`)}
              </button>
            </div>
          )}
        </div>

        {/* Input area */}
        <div className="border-t border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:px-4">
          <div className="flex items-end gap-2">
            <div className="flex-1 relative">
              {/* @ mention dropdown */}
              {showMentions && filteredMentions.length > 0 && (
                <div className="absolute bottom-full left-0 right-0 mb-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl shadow-black/50 overflow-hidden z-10 max-h-48 overflow-y-auto">
                  {filteredMentions.map((node, i) => (
                    <button key={node} onClick={() => insertMention(node)}
                      onMouseEnter={() => setMentionIndex(i)}
                      aria-selected={i === mentionIndex}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-colors ${i === mentionIndex ? 'bg-[var(--accent)]/10' : 'hover:bg-[var(--accent)]/10'}`}>
                      <AliasAvatar alias={node} size={16} />
                      <span className="text-[var(--fg-muted)]">{node}</span>
                    </button>
                  ))}
                </div>
              )}
              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => { handleInputChange(e.target.value); autoResize(e.target); }}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={`Message ${alias}...`}
                rows={1}
                className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl px-3 py-2.5 pr-[6.75rem] text-base sm:px-4 sm:pr-24 sm:text-sm text-[var(--fg)] placeholder-[var(--fg-dim)] focus:border-[var(--accent)]/40 focus:outline-none resize-none transition-colors"
              />
              <div className="absolute right-2 bottom-1.5 flex items-center gap-1">
                <label className="inline-flex min-h-[44px] min-w-[44px] -my-3 items-center justify-center sm:min-h-0 sm:min-w-0 sm:m-0 sm:p-1 text-[var(--fg-dim)] hover:text-[var(--accent-text)] cursor-pointer rounded hover:bg-[var(--accent)]/10" title={t('附加文件', 'Attach file')}>
                  <input
                    type="file"
                    multiple
                    className="hidden"
                    onChange={e => { if (e.target.files) addFiles(e.target.files); e.currentTarget.value = ''; }}
                  />
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 6.5l-7.78 7.78a3 3 0 104.24 4.24l8.49-8.49a5 5 0 00-7.07-7.07L5.89 11.45a7 7 0 109.9 9.9l7.07-7.07" />
                  </svg>
                </label>
                <button
                  type="button"
                  onClick={() => (recording ? stopRecorder() : void startRecording())}
                  aria-label={recording ? t('停止录音', 'Stop recording') : t('录一段语音', 'Record voice message')}
                  aria-pressed={recording}
                  data-testid="chat-voice-toggle"
                  title={recording ? t('停止录音', 'Stop recording') : t('录一段语音', 'Record voice message')}
                  className={`inline-flex min-h-[44px] min-w-[44px] -my-3 items-center justify-center rounded sm:min-h-0 sm:min-w-0 sm:m-0 sm:p-1 cursor-pointer hover:bg-[var(--accent)]/10 ${recording ? 'text-[var(--danger)]' : 'text-[var(--fg-dim)] hover:text-[var(--accent-text)]'}`}
                >
                  {recording ? (
                    <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <rect x="7" y="7" width="10" height="10" rx="1.5" />
                    </svg>
                  ) : (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.5a6 6 0 006-6V11m-12 1.5v.5a6 6 0 0012 0M12 18.5V22m0-19a3 3 0 013 3v6a3 3 0 11-6 0V6a3 3 0 013-3z" />
                    </svg>
                  )}
                </button>
                {/* 窄屏隐藏：44px 的附件与语音按钮之后，这个下拉会把输入区再压掉一截
                    （实测 320 下按钮块占 125px，输入框 212px，留给文本的只剩几十像素）。 */}
                <select value={priority} onChange={e => setPriority(e.target.value)}
                  className="hidden bg-transparent text-[9px] text-[var(--fg-dim)] focus:outline-none cursor-pointer sm:block">
                  <option value="normal">N</option>
                  <option value="high">H</option>
                  <option value="low">L</option>
                </select>
              </div>
            </div>
            {/* R17 of #190: send button was p-2.5 + w-5 icon = ~40 x 40
                hit zone, 4 px short of the iOS 44 px guideline on
                the short axis. Bump to inline-flex + min-h/w 44. */}
            <button onClick={send} aria-label="Send message" disabled={sending || (!input.trim() && attachedFiles.length === 0)}
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center bg-[var(--accent)] hover:opacity-90 disabled:bg-[var(--border)] disabled:text-[var(--fg-dim)] text-[var(--accent-fg)] rounded-xl transition-all shrink-0 active:scale-95">
              {sending ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                </svg>
              )}
            </button>
          </div>
          {(recording || recError) && (
            <div className="mt-1 flex items-center gap-1.5 text-[10px]" role="status" data-testid="chat-voice-status">
              {recording ? (
                <>
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--danger)]" aria-hidden="true" />
                  <span className="text-[var(--danger)]">
                    {t('录音中', 'Recording')} {String(Math.floor(recSeconds / 60)).padStart(1, '0')}:{String(recSeconds % 60).padStart(2, '0')}
                  </span>
                  <span className="text-[var(--fg-dim)]">{t('再点一次停止并附加', 'Tap again to stop and attach')}</span>
                </>
              ) : (
                <span className="text-[var(--danger)]">{recError}</span>
              )}
            </div>
          )}
          {uploadProgress && (
            <div className="mt-1 flex items-center gap-1.5 text-[10px] text-[var(--accent-text)]" role="status">
              <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-[var(--accent)]/30 border-t-cyan-400" />
              {t(`上传附件 ${uploadProgress.done}/${uploadProgress.total}…`, `Uploading ${uploadProgress.done}/${uploadProgress.total}…`)}
            </div>
          )}
          {attachLimitHit && (
            <div className="mt-1 text-[10px] text-amber-400" role="status">{t('最多同时附带 6 个附件', 'Up to 6 attachments at a time')}</div>
          )}
          {attachedFiles.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {attachedFiles.map((file, index) => (
                <LocalFilePreview
                  key={`${file.name}-${file.size}-${index}`}
                  file={file}
                  onRemove={() => setAttachedFiles(prev => prev.filter((_, i) => i !== index))}
                />
              ))}
            </div>
          )}
          <div className="hidden sm:flex justify-between text-[9px] text-[var(--fg-dim)] mt-1.5">
            <span>{input.includes('@') ? `Sending to: ${alias}` : `Type @ to mention another node`}</span>
            <span>Enter to send · paste image</span>
          </div>
        </div>
        {lightbox && <ImageLightbox urls={lightbox.urls} initialIndex={lightbox.idx} opener={lightboxOpenerRef.current} onClose={() => setLightbox(null)} />}
    </>
  );

  if (inline) {
    return <div className="flex flex-col h-full">{chatContent}</div>;
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40 lg:hidden anet-fade-in" onClick={onClose} />
      <div className="fixed top-0 right-0 h-[100dvh] w-full lg:w-[640px] xl:w-[760px] 2xl:w-[860px] bg-[var(--bg)] border-l border-[var(--border)] z-50 flex flex-col shadow-2xl shadow-black/60 animate-slide-in">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
          <div className="flex items-center gap-3">
            <AliasAvatar alias={alias} size={32} />
            <div>
              <div className="flex items-center gap-1.5 text-sm font-semibold text-[var(--fg)]">
                <span>{alias}</span>
                {chatMuted && (
                  <svg aria-label={t('已开启免打扰', 'Muted')} role="img" className="h-3.5 w-3.5 text-[var(--fg-dim)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.88 4.12A6 6 0 0118 9v3.6l1.5 2.4H12M6.3 6.3A5.98 5.98 0 006 9v3.6L4.5 15H13M10 19a2 2 0 004 0M3 3l18 18" />
                  </svg>
                )}
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-[var(--fg-muted)]">
                {sseOnline !== null && (
                  <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${sseOnline ? 'bg-green-400' : 'bg-gray-600'}`} />
                )}
                <span>
                  {pollingIds.size > 0
                    ? t('处理中…', 'Processing…')
                    : sseOnline === null ? 'Ready' : sseOnline ? t('在线', 'Online') : t('离线', 'Offline')}
                </span>
              </div>
            </div>
          </div>
          {/* R16 of #190: was p-1.5 + w-5 h-5 svg = ~32 px tap target.
              The chat panel close is high-frequency on mobile (user
              dismisses to scroll the underlying page); bump to a
              uniform 44 x 44 hit zone via inline-flex + min-h/w. */}
          <button onClick={onClose} aria-label="Close chat" className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-[var(--fg-muted)] hover:text-[var(--fg)] rounded-lg hover:bg-[var(--bg-elevated)]">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {chatContent}
      </div>
    </>
  );
}
