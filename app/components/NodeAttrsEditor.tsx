'use client';

import { useEffect, useRef, useState } from 'react';
import type { NodeAttrsSnapshot } from '../lib/hooks';

// #492 goal-item-3 — dashboard editor for node display attributes.
//
// Scope: display_name / team / tags ONLY.
//
// 🔴 alias is DELIBERATELY not editable here. It is the message
// routing key; changing it must go through the rename 2PC endpoint.
// A user editing "the name" here would reasonably expect that others
// @-mentioning them would keep working — which they will, because
// display_name is a label, not the routing key. Explaining that in
// the UI is the point of the caption below the display_name input.
//
// Optimistic-lock (attrs_revision) semantics:
//   • The parent snapshot carries `attrs_revision` at open time.
//   • PUT sends that revision as `base_attrs_revision`.
//   • Hub compares; if stale, returns 409 with `current_attrs_revision`.
//   • This modal shows an actionable prompt + a "重新加载" button
//     that re-reads (calls onCompleted to trigger the parent SWR
//     revalidate) and lets the user retry with the fresh baseline.
//
// tag input semantics (per 通信龙 constraint ③ + #49 pre-review):
//
// Two independent implementations of the same rule always drift
// (drift-detect story from PR #48 upload cap: mirror-of-hub-constant
// only catches ONE direction of divergence). So client-side does NOT
// try to predict the server's dedup rule. Instead:
//
//   1. On add, warn advisorily if the new tag case-folds to an
//      existing one — a hint, NOT a decision.
//   2. On save success, adopt the hub's returned tag list as the
//      authoritative state (setTags(hubResp.tags)) and surface the
//      diff to the user ("以下已合并/清理: ...").
//
// This way the server's `narrowTags` is the ONE source of truth for
// what actually got stored. If the server tomorrow adds a rule (e.g.
// strip trailing punctuation), the client shows the correct result
// with no code change.
//
// The MAX_TAG_LEN / MAX_TAGS caps below are the only client-side
// hard-guards — they're display constraints (chip-editor UI), not
// dedup logic, so no drift risk.

const MAX_ATTR_LEN = 120;   // display_name / team
const MAX_TAG_LEN = 64;
const MAX_TAGS = 16;

/** Trim + drop empty/oversize + count cap. This is a DISPLAY guard
 *  (chip-editor UI), NOT authoritative dedup. Dedup is the server's
 *  job; we adopt whatever the server returns. */
function displayGuardTags(raw: string[]): string[] {
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const trimmed = t.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > MAX_TAG_LEN) continue;
    out.push(trimmed);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Case-fold + control-char strip. Mirror of server's dedup key so
 *  we can OFFER an advisory hint at add-time — the ACTUAL decision
 *  remains server-side. If the hint is wrong (server rule diverges),
 *  the post-save reconciliation shows the truth. */
function tagAdvisoryKey(t: string): string {
  // eslint-disable-next-line no-control-regex
  return t.trim().replace(/[\u0000-\u001f\u007f]+/g, ' ').toLowerCase();
}

/** Compute what was merged/cleaned between what the user tried to
 *  send and what the server actually stored. Returns human-readable
 *  Chinese notice lines, empty when there's nothing to say. */
function reconcileTagsNotice(submitted: string[], stored: string[]): string[] {
  const storedKeys = new Set(stored.map(t => tagAdvisoryKey(t)));
  const notices: string[] = [];
  const droppedGroups = new Map<string, string[]>(); // stored-key → original variants
  for (const s of submitted) {
    const key = tagAdvisoryKey(s);
    if (!storedKeys.has(key)) continue;
    const matchedStored = stored.find(t => tagAdvisoryKey(t) === key);
    if (matchedStored && matchedStored !== s) {
      // Server chose a canonical form different from what user typed
      const arr = droppedGroups.get(matchedStored) ?? [];
      if (s !== matchedStored) arr.push(s);
      if (arr.length > 0) droppedGroups.set(matchedStored, arr);
    }
  }
  for (const [canonical, variants] of droppedGroups) {
    if (variants.length > 0) {
      notices.push(`「${variants.join('」、「')}」已合并到「${canonical}」`);
    }
  }
  const submittedKeys = new Set(submitted.map(t => tagAdvisoryKey(t)));
  const totallyDropped = submitted.filter(s => {
    const k = tagAdvisoryKey(s);
    return !storedKeys.has(k) && submittedKeys.has(k);
  });
  if (totallyDropped.length > 0) {
    notices.push(`「${totallyDropped.join('」、「')}」被清理（含控制字符或格式不合规）`);
  }
  return notices;
}

export interface NodeAttrsEditorProps {
  alias: string;
  nodeId: string;
  /** Current attrs as known by the parent SWR cache. Modal edits
   *  never mutate this directly — parent revalidates on save. */
  snapshot: NodeAttrsSnapshot;
  onClose: () => void;
  /** Called after a successful save; parent should re-fetch nodes
   *  so the new values (and bumped attrs_revision) land in state. */
  onSaved: () => void;
}

export function NodeAttrsEditor({ alias, nodeId, snapshot, onClose, onSaved }: NodeAttrsEditorProps) {
  const [displayName, setDisplayName] = useState<string>(snapshot.display_name ?? '');
  const [team, setTeam] = useState<string>(snapshot.team ?? '');
  const [tags, setTags] = useState<string[]>(snapshot.tags);
  const [newTag, setNewTag] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflictAt, setConflictAt] = useState<number | null>(null);
  // Post-save reconciliation notice: what the server merged/cleaned
  // from what the user actually sent. Non-blocking — the modal stays
  // open so the user can see the reconciled list.
  const [notice, setNotice] = useState<string[] | null>(null);
  // Advisory hint at add-time: `Prod` vs `prod` case-folds to the
  // same server key. This is a HINT, not a decision — the server
  // still gets to enforce, and we adopt whatever it stores.
  const [addAdvisory, setAddAdvisory] = useState<string | null>(null);
  // Baseline revision the FORM is editing against. Advances on save
  // and on "重新加载" (which pulls a fresh value in through parent).
  const [baseRev, setBaseRev] = useState<number>(snapshot.attrs_revision);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Re-sync baseline + fields when parent hands us a new snapshot
  // (post-conflict reload OR external revalidation). Only pull in
  // the FIELDS if the user hasn't started editing yet — otherwise
  // we'd stomp their in-progress input.
  const dirtyRef = useRef(false);
  useEffect(() => {
    setBaseRev(snapshot.attrs_revision);
    if (!dirtyRef.current) {
      setDisplayName(snapshot.display_name ?? '');
      setTeam(snapshot.team ?? '');
      setTags(snapshot.tags);
    }
  }, [snapshot.attrs_revision, snapshot.display_name, snapshot.team, snapshot.tags]);

  // ESC to close + trap Tab within the dialog (mirrors ImageLightbox
  // pattern from TaskChatPanel).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const markDirty = () => { dirtyRef.current = true; };

  const addTag = () => {
    const cleaned = newTag.trim();
    if (!cleaned) return;
    if (cleaned.length > MAX_TAG_LEN) {
      setError(`标签不能超过 ${MAX_TAG_LEN} 字符`);
      return;
    }
    if (tags.length >= MAX_TAGS) {
      setError(`最多 ${MAX_TAGS} 个标签`);
      return;
    }
    // Exact-duplicate short-circuit (avoids adding literal duplicates
    // that would visibly clutter the chip list).
    if (tags.includes(cleaned)) {
      setNewTag('');
      return;
    }
    // Advisory only — server enforces. Add anyway; server may or may
    // not merge (its rule can change independently of ours). The
    // notice on save shows the truth.
    const newKey = tagAdvisoryKey(cleaned);
    const collidesWith = tags.find(t => tagAdvisoryKey(t) === newKey);
    if (collidesWith) {
      setAddAdvisory(`「${cleaned}」和已有的「${collidesWith}」可能会被服务端当作同一个（保存时告诉你结果）`);
    } else {
      setAddAdvisory(null);
    }
    setTags([...tags, cleaned]);
    setNewTag('');
    setError(null);
    markDirty();
  };

  const removeTag = (t: string) => {
    setTags(tags.filter(x => x !== t));
    markDirty();
  };

  const handleSave = async () => {
    if (saving) return;
    setError(null);
    setConflictAt(null);
    setNotice(null);
    setAddAdvisory(null);
    setSaving(true);
    const submittedTags = displayGuardTags(tags);
    try {
      const body: Record<string, unknown> = {
        base_attrs_revision: baseRev,
        display_name: displayName.trim().length > 0 ? displayName.trim() : null,
        team: team.trim().length > 0 ? team.trim() : null,
        tags: submittedTags,
      };
      const res = await fetch(
        `/api/hub/nodes/${encodeURIComponent(nodeId)}/attrs`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const data = await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` }));
      if (res.status === 409) {
        const currentRev = typeof data.current_attrs_revision === 'number'
          ? data.current_attrs_revision
          : null;
        setConflictAt(currentRev);
        setError(data.message || '编辑冲突');
        return;
      }
      if (!res.ok || !data.ok) {
        setError(data.message || `保存失败 (HTTP ${res.status})`);
        return;
      }
      // Success — adopt hub's returned values as the new local state
      // (see the "two independent implementations always drift"
      // rationale at the top of this file). tags is the load-bearing
      // one; display_name/team also refreshed for the same reason.
      const returnedTags: string[] = Array.isArray(data.tags) ? data.tags : [];
      const notices = reconcileTagsNotice(submittedTags, returnedTags);
      // If the server reconciled something, KEEP THE MODAL OPEN so
      // the user sees what happened. They can close manually. Modal
      // closes automatically only when submitted list === stored list.
      setTags(returnedTags);
      if (typeof data.display_name === 'string' || data.display_name === null) {
        setDisplayName(data.display_name ?? '');
      }
      if (typeof data.team === 'string' || data.team === null) {
        setTeam(data.team ?? '');
      }
      if (typeof data.attrs_revision === 'number') {
        setBaseRev(data.attrs_revision);
      }
      dirtyRef.current = false;
      // Parent revalidates SWR either way so the /nodes list picks
      // up the new values.
      onSaved();
      if (notices.length > 0) {
        setNotice(notices);
        // Do NOT close — let the user see the reconciled state.
      } else {
        onClose();
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleReloadConflict = () => {
    // Trigger parent revalidate; the snapshot prop will update
    // (attrs_revision changes), which our useEffect above catches.
    dirtyRef.current = false;
    onSaved();
    setConflictAt(null);
    setError(null);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-label={`编辑节点 ${alias} 属性`}
        aria-modal="true"
        className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-4 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-white">编辑属性</h2>
            <p className="mt-0.5 truncate text-xs text-[var(--fg-muted)]">
              节点：<span className="text-[var(--fg)]">{alias}</span>
              <span className="mx-1.5 text-gray-700">·</span>
              修订版本：<span className="text-[var(--fg)]">{baseRev}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="shrink-0 rounded-md p-1 text-[var(--fg-muted)] hover:bg-white/5 hover:text-white"
          >
            ×
          </button>
        </div>

        <div className="mt-4 space-y-4">
          <label className="block">
            <span className="text-xs text-[var(--fg-muted)]">显示名 · display_name</span>
            <input
              type="text"
              value={displayName}
              onChange={e => { setDisplayName(e.target.value); markDirty(); setError(null); }}
              maxLength={MAX_ATTR_LEN}
              placeholder="留空以清除"
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-cyan-500/40 focus:outline-none"
            />
            <span className="mt-1 block text-[11px] text-[var(--fg-muted)]">
              仅用于显示，不影响别人 @ 你的路由名（alias 保持 <code className="text-[var(--fg-muted)]">{alias}</code>）
            </span>
          </label>

          <label className="block">
            <span className="text-xs text-[var(--fg-muted)]">团队 · team</span>
            <input
              type="text"
              value={team}
              onChange={e => { setTeam(e.target.value); markDirty(); setError(null); }}
              maxLength={MAX_ATTR_LEN}
              placeholder="如：Comm / 商务组 / Bots"
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-cyan-500/40 focus:outline-none"
            />
          </label>

          <div>
            <span className="text-xs text-[var(--fg-muted)]">标签 · tags（最多 {MAX_TAGS} 个）</span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {tags.map(tag => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded-full border border-cyan-500/20 bg-cyan-500/5 px-2 py-0.5 text-xs text-cyan-100"
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() => removeTag(tag)}
                    aria-label={`移除 ${tag}`}
                    className="text-cyan-400/70 hover:text-red-300"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <input
                type="text"
                value={newTag}
                onChange={e => setNewTag(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); addTag(); }
                }}
                maxLength={MAX_TAG_LEN}
                placeholder="新标签（回车添加）"
                className="flex-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-cyan-500/40 focus:outline-none"
                disabled={tags.length >= MAX_TAGS}
              />
              <button
                type="button"
                onClick={addTag}
                disabled={!newTag.trim() || tags.length >= MAX_TAGS}
                className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100 hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                添加
              </button>
            </div>
            {addAdvisory && (
              // Advisory, not decisive — see the design comment at the
              // top of this file. Amber (not red) because the user may
              // still want to save; server will make the final call.
              <div className="mt-1 text-[11px] text-amber-300/80" role="status">
                {addAdvisory}
              </div>
            )}
          </div>
        </div>

        {notice && notice.length > 0 && (
          <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            <div className="mb-1 font-semibold">已保存 — 服务端做了这些整理：</div>
            <ul className="list-disc space-y-0.5 pl-4">
              {notice.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
            <div className="mt-1 text-[11px] text-amber-200/60">
              以上是服务端的实存结果，已同步到此表单
            </div>
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-md border border-red-700/40 bg-red-900/20 px-3 py-2 text-xs text-red-200">
            {error}
            {conflictAt !== null && (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-red-300/70">最新版本：{conflictAt}</span>
                <button
                  type="button"
                  onClick={handleReloadConflict}
                  className="ml-auto rounded border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-red-100 hover:bg-red-500/20"
                >
                  重新加载最新值
                </button>
              </div>
            )}
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--fg)] hover:bg-white/5 disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-md bg-cyan-600 px-3 py-2 text-sm text-white hover:bg-cyan-500 disabled:cursor-wait disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
