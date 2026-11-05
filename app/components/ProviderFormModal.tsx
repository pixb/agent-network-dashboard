'use client';

import { useEffect, useMemo, useState } from 'react';
import { useReturnFocus } from '../lib/useReturnFocus';

/**
 * Create/edit a model provider (RFC-028 P1 + #393 preset catalog). Single-step
 * modal mirroring the CreateNodeWizard shell (escape-to-close, SVG ✕, cyan
 * primary). The API key field is WRITE-ONLY: on edit of a provider that already
 * has a key it shows a "•••• configured" placeholder and an empty value means
 * "keep existing key"; the stored value is never fetched or displayed.
 *
 * #393 (Vincent UX): official providers (DeepSeek / MiniMax / GLM / Claude) are
 * offered as PRESETS — picking one auto-fills the Anthropic-compatible base_url
 * and turns the model field into a checkbox list of that provider's known
 * models, so the operator only supplies an API key. "自定义" falls back to the
 * manual base_url + comma-separated model entry for any other endpoint.
 */

export interface ProviderDraft {
  provider_id?: string;
  name: string;
  type: string;
  base_url: string;
  models: string[];
  enabled: boolean;
  hasKey?: boolean;
}

// Backend (#308) currently supports only the `anthropic` vendor — which means
// any Anthropic-COMPATIBLE endpoint (Claude api.anthropic.com, DeepSeek
// api.deepseek.com/anthropic, MiniMax api.minimax.chat/anthropic, …) via a
// custom base_url, not just Anthropic the company. Native OpenAI/Grok vendors
// aren't wired yet → shown disabled so users can't pick an erroring option.
const TYPES: { id: string; label: string; disabled?: boolean }[] = [
  { id: 'anthropic', label: 'Anthropic 兼容端点（Claude / DeepSeek / MiniMax 等）' },
  { id: 'openai-compatible', label: 'OpenAI-compatible（native，即将支持）', disabled: true },
  { id: 'grok', label: 'Grok（native，即将支持）', disabled: true },
];

// #393 preset catalog. Each base_url is an Anthropic-compatible endpoint
// (verified 401-reachable). `models` are sensible defaults the operator can
// tick on/off; extras can still be typed. Keep `custom` last as the escape
// hatch to the manual URL/model flow.
interface ProviderPreset {
  id: string;
  label: string;
  type: string;
  base_url: string;
  models: string[];
  keyPlaceholder?: string;
}
const PRESETS: ProviderPreset[] = [
  { id: 'deepseek', label: 'DeepSeek', type: 'anthropic', base_url: 'https://api.deepseek.com/anthropic', models: ['deepseek-v4-pro', 'deepseek-v4-flash'], keyPlaceholder: 'sk-…' },
  { id: 'minimax', label: 'MiniMax', type: 'anthropic', base_url: 'https://api.minimaxi.com/anthropic', models: ['MiniMax-M2.7'], keyPlaceholder: 'MiniMax API key' },
  { id: 'glm', label: '智谱 GLM', type: 'anthropic', base_url: 'https://open.bigmodel.cn/api/anthropic', models: ['glm-4.7', 'glm-5.2', 'glm-4.6'], keyPlaceholder: '{id}.{secret}' },
  { id: 'claude', label: 'Claude（Anthropic 官方）', type: 'anthropic', base_url: 'https://api.anthropic.com', models: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'], keyPlaceholder: 'sk-ant-…' },
  { id: 'custom', label: '自定义（手动填 URL / 模型）', type: 'anthropic', base_url: '', models: [] },
];

function detectPreset(baseUrl?: string): string {
  if (!baseUrl) return 'custom';
  const hit = PRESETS.find(p => p.id !== 'custom' && p.base_url === baseUrl.trim());
  return hit ? hit.id : 'custom';
}

type Phase = 'form' | 'saving' | 'done' | 'unconfirmed' | 'error';

const inputCls =
  'w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--fg)] focus:border-cyan-600 focus:outline-none';

function parseModels(text: string): string[] {
  return text.split(',').map(m => m.trim()).filter(Boolean);
}

export function ProviderFormModal({
  initial,
  onClose,
  onSaved,
}: {
  initial?: ProviderDraft | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  useReturnFocus();
  const editing = !!initial?.provider_id;
  const [presetId, setPresetId] = useState(() => detectPreset(initial?.base_url));
  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState(initial?.type ?? TYPES[0].id);
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? '');
  // Checked preset models (only used while a non-custom preset is selected).
  const [checkedModels, setCheckedModels] = useState<string[]>(initial?.models ?? []);
  // Free-text models — for `custom` it's the whole list, for a preset it's extras.
  const [modelsText, setModelsText] = useState(() => {
    const p = detectPreset(initial?.base_url);
    if (p === 'custom') return (initial?.models ?? []).join(', ');
    // extras = initial models not in the preset's default list
    const preset = PRESETS.find(x => x.id === p);
    const extras = (initial?.models ?? []).filter(m => !preset?.models.includes(m));
    return extras.join(', ');
  });
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [phase, setPhase] = useState<Phase>('form');
  const [msg, setMsg] = useState('');

  const preset = useMemo(() => PRESETS.find(p => p.id === presetId) ?? PRESETS[PRESETS.length - 1], [presetId]);
  const isCustom = presetId === 'custom';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && phase !== 'saving') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, phase]);

  function selectPreset(id: string) {
    setPresetId(id);
    const p = PRESETS.find(x => x.id === id);
    if (!p) return;
    if (id !== 'custom') {
      setType(p.type);
      setBaseUrl(p.base_url);
      // default-check all preset models; keep any prior extras in the text box
      setCheckedModels(p.models);
      if (!name.trim() || PRESETS.some(x => x.label === name.trim())) setName(p.label);
    } else {
      setBaseUrl('');
      setCheckedModels([]);
    }
  }

  function toggleModel(m: string) {
    setCheckedModels(prev => (prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m]));
  }

  const finalModels = useMemo(() => {
    const extras = parseModels(modelsText);
    if (isCustom) return extras;
    return Array.from(new Set([...checkedModels, ...extras]));
  }, [isCustom, checkedModels, modelsText]);

  const nameValid = name.trim().length > 0;
  const urlValid = baseUrl.trim().length > 0;
  // Secret-first (RFC-028): a provider can't be created without a vault key,
  // so the API key is required on CREATE. On edit the key + vendor are
  // immutable (update_provider patches name/base_url/models only).
  const keyValid = editing || apiKey.trim().length > 0;
  const modelsValid = finalModels.length > 0;
  const canSave = nameValid && urlValid && keyValid && modelsValid && phase !== 'saving';

  async function handleSave() {
    setPhase('saving'); setMsg('');
    const payload = {
      ...(initial?.provider_id ? { provider_id: initial.provider_id } : {}),
      name: name.trim(), type, base_url: baseUrl.trim(), models: finalModels, enabled,
      ...(apiKey ? { apiKey } : {}),
    };
    try {
      const r = await fetch('/api/anet/providers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data?.ok) {
        setPhase('done'); onSaved?.();
        // close shortly after success so the list refresh is visible
        setTimeout(onClose, 350);
      } else if (data?.unconfirmed) {
        setPhase('unconfirmed');
        setMsg(`后端 RFC-028 未就绪：${data?.error || '不可用'}（hub 需 #308 + 升级）`);
      } else {
        setPhase('error');
        setMsg(data?.error ? `保存失败：${data.error}` : '保存失败');
      }
    } catch (e) {
      setPhase('error');
      setMsg(`保存失败：${e instanceof Error ? e.message : '网络错误'}`);
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={() => phase !== 'saving' && onClose()} aria-hidden />
      <div
        role="dialog"
        aria-label={editing ? '编辑供应商' : '新增供应商'}
        className="fixed left-1/2 top-1/2 z-50 max-h-[92vh] w-[min(94vw,480px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] shadow-2xl"
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3">
          <div className="text-sm font-semibold text-[var(--fg)]">{editing ? '编辑供应商' : '新增供应商'}</div>
          <button onClick={onClose} aria-label="关闭" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-3 px-4 py-4">
          {phase === 'unconfirmed' || phase === 'error' ? (
            <div className={`rounded-md border px-3 py-2 text-xs ${phase === 'unconfirmed' ? 'border-amber-500/30 bg-amber-500/5 text-[var(--warning)]' : 'border-red-500/30 bg-[var(--danger)]/5 text-red-300'}`}>
              {msg}
            </div>
          ) : null}

          {/* #393 preset provider picker (hidden while editing — base_url/vendor are immutable) */}
          {!editing && (
            <label className="block space-y-1">
              <span className="text-xs text-[var(--fg-muted)]">供应商 <span className="text-[var(--danger)]/70">*</span></span>
              <select value={presetId} onChange={e => selectPreset(e.target.value)} className={inputCls}>
                {PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              {!isCustom && <span className="text-[11px] text-[var(--fg-dim)]">已选官方供应商：Base URL 自动填好，勾选模型 + 填 API Key 即可。</span>}
            </label>
          )}

          <label className="block space-y-1">
            <span className="text-xs text-[var(--fg-muted)]">名称 <span className="text-[var(--danger)]/70">*</span></span>
            <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="例如 DeepSeek-V4-Pro" className={inputCls} />
          </label>

          {/* 类型 only surfaces in custom / edit — presets imply anthropic. */}
          {(isCustom || editing) && (
            <label className="block space-y-1">
              <span className="text-xs text-[var(--fg-muted)]">类型{editing ? '（不可修改）' : ''}</span>
              <select value={type} onChange={e => setType(e.target.value)} disabled={editing} className={`${inputCls} ${editing ? 'opacity-60 cursor-not-allowed' : ''}`}>
                {TYPES.map(t => <option key={t.id} value={t.id} disabled={t.disabled}>{t.label}</option>)}
              </select>
            </label>
          )}

          <label className="block space-y-1">
            <span className="text-xs text-[var(--fg-muted)]">Base URL <span className="text-[var(--danger)]/70">*</span>{!isCustom && !editing && <span className="text-[var(--fg-dim)]">（已自动填充）</span>}</span>
            <input
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder="https://api.anthropic.com"
              disabled={!isCustom && !editing}
              className={`${inputCls} ${(!isCustom && !editing) ? 'opacity-60 cursor-not-allowed' : ''}`}
            />
            {isCustom && !editing && <span className="text-[11px] text-[var(--fg-dim)]">Anthropic 兼容端点：Claude <span className="font-mono">api.anthropic.com</span> · DeepSeek <span className="font-mono">api.deepseek.com/anthropic</span> · MiniMax <span className="font-mono">api.minimax.chat/anthropic</span>。</span>}
          </label>

          {/* Models: preset → checkbox list + extras; custom → comma text. */}
          {!isCustom && !editing ? (
            <div className="block space-y-1">
              <span className="text-xs text-[var(--fg-muted)]">模型 <span className="text-[var(--danger)]/70">*</span><span className="text-[var(--fg-dim)]">（勾选，可多选）</span></span>
              <div className="flex flex-wrap gap-2">
                {preset.models.map(m => {
                  const on = checkedModels.includes(m);
                  return (
                    <button
                      type="button"
                      key={m}
                      onClick={() => toggleModel(m)}
                      className={`rounded-md border px-2.5 py-1 text-xs font-mono transition-colors ${on ? 'border-cyan-600 bg-[var(--accent)]/15 text-[var(--accent-text)]' : 'border-[var(--border)] bg-[var(--bg)] text-[var(--fg-muted)] hover:border-gray-600'}`}
                    >
                      {on ? '✓ ' : ''}{m}
                    </button>
                  );
                })}
              </div>
              <input value={modelsText} onChange={e => setModelsText(e.target.value)} placeholder="其他模型（逗号分隔，可留空）" className={`${inputCls} mt-1`} />
            </div>
          ) : (
            <label className="block space-y-1">
              <span className="text-xs text-[var(--fg-muted)]">模型（逗号分隔）{editing ? '' : <span className="text-[var(--danger)]/70"> *</span>}</span>
              <input value={modelsText} onChange={e => setModelsText(e.target.value)} placeholder="claude-sonnet-4-6, deepseek-chat" className={inputCls} />
            </label>
          )}

          <label className="block space-y-1">
            <span className="text-xs text-[var(--fg-muted)]">API Key {editing ? <span className="text-[var(--fg-dim)]">（不可在此修改）</span> : <span className="text-[var(--danger)]/70">*</span>}</span>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={editing ? '•••• configured（密钥库已存）' : (preset.keyPlaceholder ?? 'sk-…')}
              className={`${inputCls} ${editing ? 'opacity-60 cursor-not-allowed' : ''}`}
              autoComplete="off"
              disabled={editing}
            />
            <span className="text-[11px] text-[var(--fg-dim)]">{editing ? '密钥不可在此改；如需轮换 key 走单独的密钥库流程。' : '写入即存入密钥库，UI 不回显 key 值。'}</span>
          </label>

          <label className="flex items-center gap-2 pt-1">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="accent-cyan-500" />
            <span className="text-xs text-[var(--fg)]">启用</span>
          </label>
        </div>

        <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-[var(--fg-muted)] hover:text-[var(--fg)]">取消</button>
          <button
            type="button"
            disabled={!canSave}
            onClick={handleSave}
            className={`rounded-md px-4 py-1.5 text-sm font-medium ${canSave ? 'bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent)]' : 'bg-[var(--bg-elevated)] text-[var(--fg-dim)] cursor-not-allowed'}`}
          >
            {phase === 'saving' ? '保存中…' : phase === 'done' ? '✓ 已保存' : editing ? '保存' : '新增'}
          </button>
        </div>
      </div>
    </>
  );
}
