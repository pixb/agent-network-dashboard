'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// ── #492 preview half — inline image/video display ───────────────
//
// See docs/design-492-inline-preview.md for the full design rationale
// (通信龙 v2 review approved the "never inline" structure).
//
// The proxy at /api/hub/files/[fileId] ALWAYS returns bytes with
// `Content-Disposition: attachment` + `nosniff`. It also stamps a
// `X-Verified-Type` header when the file matches a magic-bytes-verified
// safe-media type. Client:
//   1. Fetches via the download proxy (browser downloads bytes to memory)
//   2. Reads `X-Verified-Type` — if absent, falls back to download card
//   3. Constructs `new Blob([bytes], {type: X-Verified-Type})`
//   4. `URL.createObjectURL(blob)` → `<img>` / `<video>` src
//
// The blob URL is a browser-owned handle, isolated from the dashboard
// origin. A whitelist bug can degrade rendering (image won't load) but
// can NEVER become an XSS on the dashboard origin.

/** Client-side ext hint — used ONLY to decide whether it's worth
 *  fetching the file to try the preview. The SERVER decides
 *  authoritatively whether to expose `X-Verified-Type` via magic
 *  bytes; this list just avoids fetching a PDF just to learn it
 *  isn't inline-able. Under-selection here = missed preview
 *  opportunity (only a UX cost). Over-selection = wasted fetch that
 *  falls back to card (only a bandwidth cost). Nothing security. */
const PREVIEW_HINT_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp',
  'mp4', 'webm', 'mov', // .mov may or may not verify as mp4; server decides
]);

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const VIDEO_MIMES = new Set(['video/mp4', 'video/webm']);

/** Auto-load images below this size. Larger images render as a
 *  click-to-load card to protect mobile bandwidth. Vincent uses this
 *  on his phone; a full 12 MiB image auto-loading over a random
 *  cellular connection is not the right default. */
const IMAGE_AUTOLOAD_MAX_BYTES = 5 * 1024 * 1024;

/**
 * #492 attachment descriptor as it appears in `meta.attachments[]` on
 * inbound tasks/messages. All fields are UNTRUSTED — the upload side
 * chose the name / mime, so treat every string as arbitrary bytes.
 * We render them as plain text, sanitize before use, and never let
 * them influence a URL beyond the strictly-regexed `file_id`.
 */
export interface Attachment {
  file_id?: string;
  path?: string;
  name?: string;
  mime?: string;
  size?: number;
  type?: string;
}

/** Same regex the download proxy uses. Duplicated intentionally — we
 *  don't want to bundle a server import into the client. Any change
 *  must be made in both places.
 *  Mirrors `app/api/hub/files/[fileId]/route.ts:FILE_ID_REGEX`.
 */
const FILE_ID_REGEX = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Sanitize a filename for display AND for the download-attribute on
 * the synthesized anchor. The upload side controls this bytes — we
 * strip anything that would break shell / display / disposition
 * headers. Also clamp length so a 4 KB path can't wall-of-text the
 * bubble.
 *
 * Kept intentionally narrow:
 *   - `/` and `\` → `_` (defeat path traversal in `<a download>`)
 *   - control chars (CR/LF/TAB/NUL) → `_`
 *   - leading `.` stripped (avoid hidden-file leak on download)
 *   - clamp to 200 chars
 *   - if empty after all that → `"file"` fallback
 */
function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return 'file';
  let s = raw
    .replace(/[/\\]/g, '_')
    .replace(/[\r\n\t\0]/g, '_');
  while (s.startsWith('.')) s = s.slice(1);
  if (s.length > 200) s = s.slice(0, 200);
  return s || 'file';
}

/**
 * Whitelist the mime for display. Everything outside a conservative
 * set of characters is stripped. Empty → falsy render (block hides
 * the mime chip rather than showing junk).
 */
function sanitizeMime(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^a-zA-Z0-9./+-]/g, '').slice(0, 100);
}

/**
 * Format a byte count as `"12.4 KB"`. Defensive on non-numeric input.
 * Empty string when the size is missing / negative — the block just
 * omits the size chip in that case.
 */
function formatBytes(bytes: unknown): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Emoji icon by MIME family — informational only, not load-bearing. */
function iconFor(mime: string, name: string): string {
  const lc = (mime || '').toLowerCase();
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (lc.startsWith('image/')) return '🖼️';
  if (lc.startsWith('video/')) return '🎬';
  if (lc.startsWith('audio/')) return '🎵';
  if (lc.includes('pdf') || ext === 'pdf') return '📄';
  if (['ppt', 'pptx'].includes(ext)) return '📊';
  if (['doc', 'docx'].includes(ext)) return '📝';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📈';
  if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext)) return '📦';
  return '📎';
}

/**
 * Render one attachment as a clickable download block.
 *
 * Click path (#492 hard gate — must produce a byte-identical file):
 *   1. `fetch('/api/hub/files/<file_id>', {credentials:'include'})`
 *      — same-origin, session cookie carries auth; the server-side
 *      proxy attaches the Bearer token so nothing sensitive is on
 *      the client wire OR in browser history / logs.
 *   2. Response body → `blob()` (byte-preserving).
 *   3. `URL.createObjectURL(blob)` → transient blob: URL.
 *   4. Synthetic `<a href="blob:" download="<sanitized-name>">` +
 *      programmatic click → browser starts the download using the
 *      sanitized filename.
 *   5. `URL.revokeObjectURL()` in a `finally` so the blob is GC'd
 *      even if the click flow throws mid-way.
 *
 * If the attachment has no `file_id` (a legacy path-only attachment
 * from a single-host feishu adapter that predates cross-host upload),
 * we render an informational block with the path visible but no
 * download button — the block honestly signals "can't fetch this
 * cross-host, needs re-upload".
 *
 * Errors surface via a small inline error string, not `alert()`, so
 * the chat scroll position isn't lost. Two seconds of visible
 * feedback is enough for the user to see + retry.
 */
/** Shared blob-URL fetcher — returns {blobUrl, verifiedType} or
 *  throws. Used by both InlineImage/InlineVideo (for preview) and
 *  the download button (for the save-to-disk flow). Caller owns the
 *  returned blobUrl lifecycle (must revoke). */
async function fetchVerified(fileId: string): Promise<{ blobUrl: string; verifiedType: string | null; blob: Blob }> {
  const res = await fetch(`/api/hub/files/${encodeURIComponent(fileId)}`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // Header lookup is case-insensitive; Next's Response uses this pattern.
  const verifiedType = res.headers.get('x-verified-type');
  // Only trust the whitelist values — anything else is dropped so a
  // future server bug can't smuggle an arbitrary type in.
  const trusted =
    verifiedType && (IMAGE_MIMES.has(verifiedType) || VIDEO_MIMES.has(verifiedType))
      ? verifiedType
      : null;
  const rawBlob = await res.blob();
  const blob = trusted ? new Blob([rawBlob], { type: trusted }) : rawBlob;
  return { blobUrl: URL.createObjectURL(blob), verifiedType: trusted, blob };
}

/** Filename extension helper — lowercase, no dot, empty for extensionless. */
function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** True when it's worth trying an inline preview (client-side hint
 *  only — server decides authoritatively). */
function shouldTryPreview(name: string, mime: string): boolean {
  if (IMAGE_MIMES.has(mime) || VIDEO_MIMES.has(mime)) return true;
  const ext = extOf(name);
  return ext !== '' && PREVIEW_HINT_EXTS.has(ext);
}

/**
 * Inline image preview. Auto-loads for images below
 * IMAGE_AUTOLOAD_MAX_BYTES; renders a click-to-load card for larger
 * images (mobile bandwidth protection). If the server doesn't return
 * `X-Verified-Type` in the whitelist, or if the fetch fails, calls
 * `onNotInlineable` so the parent falls back to the download card.
 */
function InlineImage({
  fileId,
  name,
  size,
  onNotInlineable,
}: {
  fileId: string;
  name: string;
  size: number | undefined;
  onNotInlineable: () => void;
}) {
  const autoLoad = typeof size === 'number' && size <= IMAGE_AUTOLOAD_MAX_BYTES;
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const notInlineableRef = useRef(onNotInlineable);
  notInlineableRef.current = onNotInlineable;

  const load = useCallback(async () => {
    if (loading || blobUrl) return;
    setLoading(true);
    try {
      const { blobUrl: url, verifiedType } = await fetchVerified(fileId);
      if (!verifiedType || !IMAGE_MIMES.has(verifiedType)) {
        // Server declined — the file's real type isn't a safe image.
        // Release the URL immediately and hand off to the download card.
        URL.revokeObjectURL(url);
        notInlineableRef.current();
        return;
      }
      setBlobUrl(url);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [fileId, loading, blobUrl]);

  useEffect(() => {
    if (autoLoad) void load();
  }, [autoLoad, load]);

  // Revoke on unmount OR when blobUrl replaced.
  useEffect(() => {
    if (!blobUrl) return;
    return () => URL.revokeObjectURL(blobUrl);
  }, [blobUrl]);

  if (failed) {
    return (
      <div className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-sm text-amber-200">
        图片加载失败 · 请点击下方下载按钮查看
      </div>
    );
  }

  if (blobUrl) {
    return (
      <div className="mt-2 overflow-hidden rounded-lg border border-white/10 bg-black/20">
        {/* eslint-disable-next-line @next/next/no-img-element -- blob: URL, next/image can't handle */}
        <img
          src={blobUrl}
          alt={name}
          className="block max-h-[50vh] w-auto max-w-full cursor-zoom-in object-contain"
          // "Open in new tab" satisfies the "点开大图" acceptance gate
          // without threading blob URLs through the multi-image
          // TaskChatPanel lightbox (that integration is a follow-up).
          onClick={() => window.open(blobUrl, '_blank', 'noopener')}
        />
      </div>
    );
  }

  // Not loaded yet — either loading spinner or click-to-load card.
  return (
    <button
      type="button"
      onClick={load}
      disabled={loading}
      className="mt-2 flex w-full items-center gap-2 rounded-lg border border-cyan-500/20 bg-cyan-500/5 px-3 py-2 text-left text-sm text-cyan-100 transition hover:border-cyan-400/40 hover:bg-cyan-500/10 disabled:cursor-wait disabled:opacity-60"
    >
      <span aria-hidden className="text-lg">🖼️</span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="shrink-0 text-xs text-cyan-300">
        {loading ? '加载中…' : '点击查看'}
      </span>
    </button>
  );
}

/**
 * Inline video preview. NEVER auto-loads — 5 videos on-screen at
 * 12 MiB each = 60 MiB memory spike. Renders a poster card that
 * fetches + creates the blob only on click, then swaps to
 * `<video controls autoplay>`.
 *
 * Trade-off (per design doc §5.2): blob URL means full file
 * downloaded before first byte plays; there's no range/seek. Fine
 * under the current 12 MiB hub cap; if the cap ever rises, this
 * component needs a real streaming source (server-side signed URL
 * with byte-range support), not a blob.
 */
function InlineVideo({
  fileId,
  name,
  onNotInlineable,
}: {
  fileId: string;
  name: string;
  onNotInlineable: () => void;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const notInlineableRef = useRef(onNotInlineable);
  notInlineableRef.current = onNotInlineable;

  const load = useCallback(async () => {
    if (loading || blobUrl) return;
    setLoading(true);
    try {
      const { blobUrl: url, verifiedType } = await fetchVerified(fileId);
      if (!verifiedType || !VIDEO_MIMES.has(verifiedType)) {
        URL.revokeObjectURL(url);
        notInlineableRef.current();
        return;
      }
      setBlobUrl(url);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [fileId, loading, blobUrl]);

  useEffect(() => {
    if (!blobUrl) return;
    return () => URL.revokeObjectURL(blobUrl);
  }, [blobUrl]);

  if (failed) {
    return (
      <div className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-sm text-amber-200">
        视频加载失败 · 请点击下方下载按钮查看
      </div>
    );
  }

  if (blobUrl) {
    return (
      <div className="mt-2 overflow-hidden rounded-lg border border-white/10 bg-black/20">
        <video
          src={blobUrl}
          controls
          autoPlay
          className="block max-h-[50vh] w-full"
        >
          您的浏览器不支持内联视频播放，请下载后查看。
        </video>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={load}
      disabled={loading}
      className="mt-2 flex w-full items-center gap-2 rounded-lg border border-cyan-500/20 bg-cyan-500/5 px-3 py-2 text-left text-sm text-cyan-100 transition hover:border-cyan-400/40 hover:bg-cyan-500/10 disabled:cursor-wait disabled:opacity-60"
    >
      <span aria-hidden className="text-lg">🎬</span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="shrink-0 text-xs text-cyan-300">
        {loading ? '加载中…' : '▶ 播放'}
      </span>
    </button>
  );
}

export function AttachmentBlock({ attachment }: { attachment: Attachment }) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ext-based hint says "try preview" — set to false after the
  // server declines (no X-Verified-Type) or after a hard fetch
  // failure. Once false, only the download card renders.
  const [previewGivenUp, setPreviewGivenUp] = useState(false);

  const safeName = sanitizeName(attachment.name);
  const safeMime = sanitizeMime(attachment.mime);
  const safeSize = formatBytes(attachment.size);
  const icon = iconFor(safeMime, safeName);

  const hasValidFileId =
    typeof attachment.file_id === 'string' && FILE_ID_REGEX.test(attachment.file_id);

  const tryPreview = hasValidFileId && !previewGivenUp && shouldTryPreview(safeName, safeMime);
  const ext = extOf(safeName);
  // Client hint only — server verifies. We just pick which preview
  // component to try first. If the ext is ambiguous (e.g. missing),
  // default to image since image detection is cheap and safe.
  const previewKind: 'image' | 'video' | null = tryPreview
    ? (VIDEO_MIMES.has(safeMime) || ['mp4', 'webm', 'mov'].includes(ext) ? 'video' : 'image')
    : null;

  async function handleDownload() {
    if (!hasValidFileId || !attachment.file_id) return;
    setError(null);
    setDownloading(true);
    let objectUrl: string | null = null;
    try {
      const res = await fetch(
        `/api/hub/files/${encodeURIComponent(attachment.file_id)}`,
        { credentials: 'include' },
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const blob = await res.blob();
      objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = safeName;
      // rel="noopener" — belt on the synthetic click.
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setDownloading(false);
    }
  }

  // path-only attachment (legacy) — no download button, just an
  // informational tile so the user knows what was sent even if we
  // can't fetch it.
  if (!hasValidFileId) {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-lg border border-white/10 bg-[var(--hover-tint)] px-3 py-2 text-sm text-neutral-300">
        <span aria-hidden>{icon}</span>
        <span className="min-w-0 flex-1 truncate">{safeName}</span>
        {safeSize && <span className="shrink-0 text-xs text-neutral-500">{safeSize}</span>}
        <span
          className="shrink-0 text-xs text-neutral-500"
          title="Attachment has no file_id — single-host path only. Ask the sender to re-upload."
        >
          (host-local)
        </span>
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-col">
      {/* Inline preview: rendered when ext hint suggests media and the
          server hasn't declined yet. On decline (`onNotInlineable`) or
          hard failure, we drop back to just the download card below. */}
      {previewKind === 'image' && attachment.file_id && (
        <InlineImage
          fileId={attachment.file_id}
          name={safeName}
          size={typeof attachment.size === 'number' ? attachment.size : undefined}
          onNotInlineable={() => setPreviewGivenUp(true)}
        />
      )}
      {previewKind === 'video' && attachment.file_id && (
        <InlineVideo
          fileId={attachment.file_id}
          name={safeName}
          onNotInlineable={() => setPreviewGivenUp(true)}
        />
      )}
      {/* Download card — always available for save-to-disk, even when
          the preview is shown. Users still need a way to save a copy
          off the ephemeral blob URL. */}
      <button
        type="button"
        onClick={handleDownload}
        disabled={downloading}
        className="flex w-full items-center gap-2 rounded-lg border border-cyan-500/20 bg-cyan-500/5 px-3 py-2 text-left text-sm text-cyan-100 transition hover:border-cyan-400/40 hover:bg-cyan-500/10 disabled:cursor-wait disabled:opacity-60 mt-2 first:mt-0"
        title={`Download ${safeName}`}
      >
        <span aria-hidden className="text-lg">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{safeName}</span>
        {safeSize && <span className="shrink-0 text-xs text-neutral-400">{safeSize}</span>}
        {safeMime && (
          <span className="shrink-0 rounded bg-[var(--hover-tint)] px-1.5 py-0.5 text-[11px] text-neutral-400">
            {safeMime}
          </span>
        )}
        <span className="shrink-0 text-xs text-cyan-300">
          {downloading ? '下载中…' : error ? `⚠ ${error}` : '↓ 下载'}
        </span>
      </button>
    </div>
  );
}

/**
 * Parse `attachments[]` from a message-like row. Accepts both the
 * pre-parsed `meta.attachments` shape and the raw `meta_json` string
 * shape (hub returns the latter from `SELECT *` on the tasks table
 * because SQLite stores meta_json as TEXT).
 *
 * Returns `[]` for anything that isn't a shape-valid array of objects
 * — never throws. Callers can render freely without try/catch.
 */
export function extractAttachments(row: unknown): Attachment[] {
  if (!row || typeof row !== 'object') return [];
  const record = row as Record<string, unknown>;

  // Try pre-parsed `meta` first.
  let meta: unknown = record.meta;

  // Fall back to `meta_json` (raw TEXT column).
  if (!meta && typeof record.meta_json === 'string' && record.meta_json.length > 0) {
    try {
      meta = JSON.parse(record.meta_json);
    } catch {
      return [];
    }
  }

  if (!meta || typeof meta !== 'object') return [];
  const metaObj = meta as Record<string, unknown>;
  const raw = metaObj.attachments;
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .map((a) => ({
      file_id: typeof a.file_id === 'string' ? a.file_id : undefined,
      path: typeof a.path === 'string' ? a.path : undefined,
      name: typeof a.name === 'string' ? a.name : undefined,
      mime: typeof a.mime === 'string' ? a.mime : undefined,
      size: typeof a.size === 'number' ? a.size : undefined,
      type: typeof a.type === 'string' ? a.type : undefined,
    }));
}
