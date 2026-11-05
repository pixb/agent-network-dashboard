'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { catalogFromHub, tagColor, tagCount, tagSuggestions, type TagCatalog } from '../lib/tag-catalog';

/**
 * Tag catalogue load — read-only, one request per network.
 *
 * `catalog === null` means "unknown": old Hub without the endpoint, a failed
 * read, or a 403. Every consumer must keep working in that state, showing the
 * plain text tags the rows already carry.
 */
export function useRequirementTags(networkId: string) {
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([networkId, attempt]);
  // Keep the last catalogue while a refresh is in flight: the manage dialog
  // must not unmount (and lose its success message) just because we re-read.
  const [response, setResponse] = useState<{ network: string; catalog: TagCatalog | null } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    async function read() {
      try {
        const params = new URLSearchParams({ network_id: networkId });
        const res = await fetch(`/api/hub/requirements/tags?${params}`, { cache: 'no-store', signal: controller.signal });
        if (!res.ok) { if (!controller.signal.aborted) setResponse({ network: networkId, catalog: null }); return; }
        const catalog = catalogFromHub(await res.json());
        if (!controller.signal.aborted) setResponse({ network: networkId, catalog });
      } catch {
        if (!controller.signal.aborted) setResponse({ network: networkId, catalog: null });
      }
    }
    void read();
    return () => controller.abort();
  }, [key, networkId]);
  const refresh = useCallback(() => setAttempt(value => value + 1), []);
  return { catalog: response?.network === networkId ? response.catalog : null, refresh };
}

/** One tag pill; a colour dot only when the Hub knows a colour for it. */
export function TagChip({ name, color, count, className = '' }: {
  name: string;
  color: string | null;
  count?: number | null;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 ${className}`}
      data-tag={name}
      data-tag-color={color || undefined}
    >
      {color && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />}
      {name}
      {typeof count === 'number' && count > 0 && (
        <span className="tabular-nums text-[9px] text-[var(--fg-dim)]">{count}</span>
      )}
    </span>
  );
}

/**
 * Tag box with suggestions from the Hub catalogue.
 *
 * Typing stays free-form (Hub accepts any tag), so this is a combobox, not a
 * select: Enter applies exactly what was typed, clicking a suggestion applies
 * that tag, and the already-applied tag is never offered back.
 */
export function TagPicker({ draft, applied, catalog, onDraftChange, onApply }: {
  /** What is typed right now — owned by the page so other controls see it. */
  draft: string;
  /** The tag actually filtering the list (from the URL). */
  applied: string;
  catalog: TagCatalog | null;
  onDraftChange: (tag: string) => void;
  onApply: (tag: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const suggestions = useMemo(
    () => (catalog ? tagSuggestions(catalog, draft === applied ? '' : draft, applied ? [applied] : [], 8) : []),
    [catalog, draft, applied],
  );

  const apply = useCallback((tag: string) => {
    onApply(tag.trim());
    setOpen(false);
    setActive(-1);
  }, [onApply]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  // 带内容就开面板：标签目录没有匹配项时面板原本整个消失，看起来像「补全挂了」，
  // 也看不到「回车按 X 筛选」这句说明（自由输入其实仍然可用）。
  const listOpen = open && (suggestions.length > 0 || draft.trim() !== '');

  return (
    <div
      ref={wrapRef}
      className="relative"
      onBlur={event => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setOpen(false);
        setActive(-1);
        // Same contract as before: leaving the box commits what is in it.
        if (draft.trim() !== applied) onApply(draft);
      }}
    >
      <div className="flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 focus-within:border-[var(--border-hover)]">
        {applied && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: tagColor(catalog, applied) || 'var(--fg-dim)' }} />}
        <input
          value={draft}
          onChange={event => { onDraftChange(event.target.value); setOpen(true); setActive(-1); }}
          onFocus={() => setOpen(true)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              apply(active >= 0 && suggestions[active] ? suggestions[active].name : draft);
            } else if (event.key === 'ArrowDown' && suggestions.length > 0) {
              event.preventDefault();
              setOpen(true);
              setActive(index => (index + 1) % suggestions.length);
            } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
              event.preventDefault();
              setActive(index => (index - 1 + suggestions.length) % suggestions.length);
            } else if (event.key === 'Escape') {
              setOpen(false);
              setActive(-1);
            }
          }}
          placeholder="精确标签"
          aria-label="精确标签"
          aria-controls="tag-suggestions"
          aria-autocomplete="list"
          className="w-28 bg-transparent text-sm text-white placeholder-gray-700 focus:outline-none"
        />
      </div>
      {listOpen && (
        <ul
          id="tag-suggestions"
          role="listbox"
          aria-label="标签建议"
          data-testid="tag-suggestions"
          className="absolute left-0 top-full z-20 mt-1 max-h-64 w-56 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] py-1 shadow-xl"
        >
          {suggestions.map((suggestion, index) => {
            const count = tagCount(catalog, suggestion.name);
            return (
              <li key={suggestion.name}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  tabIndex={-1}
                  data-testid={`tag-suggestion-${suggestion.name}`}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => apply(suggestion.name)}
                  className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs ${index === active ? 'bg-[var(--hover-tint)] text-[var(--fg)]' : 'text-[var(--fg-muted)]'}`}
                >
                  <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: suggestion.color || 'transparent', boxShadow: suggestion.color ? 'none' : 'inset 0 0 0 1px var(--border)' }} />
                  <span className="min-w-0 flex-1 truncate">{suggestion.name}</span>
                  {typeof count === 'number' && count > 0 && (
                    <span className="shrink-0 tabular-nums text-[11px] text-[var(--fg-dim)]">{count}</span>
                  )}
                </button>
              </li>
            );
          })}
          {suggestions.length === 0 && (
            <li role="status" data-testid="tag-suggestions-empty" className="px-2.5 py-1.5 text-[11px] text-[var(--fg-muted)]">
              没有匹配的标签
            </li>
          )}
          <li aria-hidden className="px-2.5 pt-1 text-[11px] text-[var(--fg-dim)]">
            {draft.trim() ? `回车按“${draft.trim()}”筛选` : '输入任意标签后回车筛选'}
          </li>
        </ul>
      )}
    </div>
  );
}
