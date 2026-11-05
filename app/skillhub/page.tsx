'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNetworkId } from '../lib/network-context';

type Skill = {
  skill_id: string; slug: string; name: string; description: string; version: string;
  status: 'pending' | 'published' | 'rejected'; source_type: 'node' | 'user';
  source_alias?: string; updated_at: string; review_note?: string; content?: string;
};

const EMPTY = { slug: '', name: '', description: '', version: '1.0.0', content: '# Skill\n\nDescribe when and how an agent should use this skill.\n' };

export default function SkillHubPage() {
  const { networkId } = useNetworkId();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [reviewer, setReviewer] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showUpload, setShowUpload] = useState(false);
  const [draft, setDraft] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Skill | null>(null);
  const [publicLicense, setPublicLicense] = useState('');
  const [publicPublisher, setPublicPublisher] = useState('');
  const [exported, setExported] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    const qs = new URLSearchParams({ review: '1' });
    if (networkId) qs.set('network_id', networkId);
    if (query.trim()) qs.set('q', query.trim());
    try {
      const res = await fetch(`/api/anet/skills?${qs}`, { cache: 'no-store' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.unconfirmed ? '当前 Hub 尚未升级 SkillHub 后端' : (data.error || '加载失败'));
      setSkills(Array.isArray(data.skills) ? data.skills : []);
      setReviewer(!!data.reviewer);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [networkId, query]);

  useEffect(() => { const id = setTimeout(refresh, 180); return () => clearTimeout(id); }, [refresh]);

  async function submit(e: FormEvent) {
    e.preventDefault(); setSaving(true); setError('');
    try {
      const res = await fetch('/api/anet/skills', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, ...(networkId ? { network_id: networkId } : {}) }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || '上传失败');
      setShowUpload(false); setDraft(EMPTY); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  async function review(skillId: string, decision: 'published' | 'rejected') {
    const res = await fetch('/api/anet/skills', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skill_id: skillId, decision, ...(networkId ? { network_id: networkId } : {}) }),
    });
    const data = await res.json();
    if (!data.ok) setError(data.error || '审核失败'); else refresh();
  }

  async function openSkill(skill: Skill) {
    const qs = new URLSearchParams({ skill_id: skill.skill_id });
    if (networkId) qs.set('network_id', networkId);
    const res = await fetch(`/api/anet/skills?${qs}`, { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) setError(data.error || '读取失败'); else {
      setSelected(data.skill); setPublicLicense(''); setPublicPublisher(''); setExported(false);
    }
  }

  async function exportPublicSubmission() {
    setError(''); setExported(false);
    if (!selected || selected.status !== 'published' || !reviewer) {
      setError('只有网络审核员可以导出已在网络内发布的 Skill'); return;
    }
    if (!publicLicense || !publicPublisher.trim()) {
      setError('公开投稿前请选择许可证并填写公开发布者名称'); return;
    }
    const content = selected.content || '';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
    const contentSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const publicBundle = {
      schema_version: 1,
      metadata: {
        schema_version: 1,
        slug: selected.slug,
        name: selected.name,
        description: selected.description || '',
        version: selected.version,
        license: publicLicense,
        publisher: { name: publicPublisher.trim() },
        tags: [],
        published_at: new Date().toISOString().slice(0, 10),
      },
      content,
      content_sha256: contentSha256,
    };
    const blob = new Blob([`${JSON.stringify(publicBundle, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${selected.slug}-${selected.version}.skillhub-submission.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setExported(true);
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] p-4 text-[var(--fg)] sm:p-6">
      <div className="mb-6 flex items-center gap-3">
        <div>
          <h1 className="ml-10 text-xl font-semibold text-[var(--fg)] lg:ml-0">SkillHub</h1>
          <p className="mt-1 text-xs text-[var(--fg-muted)]">节点沉淀可复用能力，审核后供整个网络使用；网络内发布不会自动公开。</p>
        </div>
        <button onClick={() => setShowUpload(true)} className="ml-auto rounded-lg bg-[var(--hl)] px-3 py-2 text-sm font-medium text-[var(--bg)] hover:opacity-90">上传 Skill</button>
      </div>

      <div className="mb-4 max-w-3xl">
        <input aria-label="搜索 Skills" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索名称、slug 或说明…" className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm outline-none focus:border-[var(--hl)]" />
      </div>
      {error && <div className="mb-4 max-w-3xl rounded-lg border border-[var(--danger)] bg-[var(--hover-tint)] p-3 text-sm text-[var(--danger)]">{error}</div>}

      <div className="grid max-w-5xl gap-3 md:grid-cols-2 xl:grid-cols-3">
        {loading ? [1,2,3].map(i => <div key={i} className="h-40 animate-pulse rounded-xl bg-[var(--bg-elevated)]" />) : skills.map(skill => (
          <article key={skill.skill_id} className="flex min-h-40 flex-col rounded-2xl bg-[var(--bg-secondary)] p-4">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1"><h2 className="truncate font-semibold text-[var(--fg)]">{skill.name}</h2><code className="text-xs text-[var(--hl)]">{skill.slug}@{skill.version}</code></div>
              <span className={`rounded-full bg-[var(--hover-tint)] px-2 py-0.5 text-[10px] ${skill.status === 'published' ? 'text-[var(--success)]' : skill.status === 'pending' ? 'text-[var(--warning)]' : 'text-[var(--danger)]'}`}>{skill.status === 'published' ? '网络内发布' : skill.status === 'pending' ? '待审核' : '已拒绝'}</span>
            </div>
            <p className="mt-3 line-clamp-3 text-sm text-[var(--fg-muted)]">{skill.description || '暂无说明'}</p>
            <div className="mt-auto flex items-center gap-2 pt-4 text-xs text-[var(--fg-muted)]">
              <span>{skill.source_type === 'node' ? '节点' : '用户'} · {skill.source_alias || 'unknown'}</span>
              <button onClick={() => openSkill(skill)} className="ml-auto rounded px-2 py-1 text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]">查看</button>
              {reviewer && skill.status === 'pending' && <span className="flex gap-1"><button onClick={() => review(skill.skill_id, 'rejected')} className="rounded px-2 py-1 text-[var(--danger)] hover:bg-[var(--hover-tint)]">拒绝</button><button onClick={() => review(skill.skill_id, 'published')} className="rounded px-2 py-1 text-[var(--success)] hover:bg-[var(--hover-tint)]">发布</button></span>}
            </div>
          </article>
        ))}
        {!loading && skills.length === 0 && <div className="col-span-full rounded-2xl bg-[var(--bg-secondary)] p-10 text-center text-sm text-[var(--fg-muted)]">还没有 Skill。让节点总结经验，或上传第一份 SKILL.md。</div>}
      </div>

      {showUpload && <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4" style={{ backgroundColor: 'color-mix(in srgb, var(--bg) 70%, transparent)' }} onMouseDown={e => { if (e.target === e.currentTarget) setShowUpload(false); }}>
        <form onSubmit={submit} className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-[var(--border-hover)] bg-[var(--bg-secondary)] p-5 sm:rounded-2xl">
          <div className="mb-4 flex items-center"><h2 className="text-lg font-semibold">上传 Skill</h2><button type="button" onClick={() => setShowUpload(false)} className="ml-auto text-[var(--fg-dim)]">✕</button></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-[var(--fg-muted)]">名称<input required value={draft.name} onChange={e => setDraft({...draft, name:e.target.value})} className="mt-1 w-full rounded border border-[var(--border-hover)] bg-[var(--col-inset)] p-2 text-sm" /></label>
            <label className="text-xs text-[var(--fg-muted)]">Slug<input required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value={draft.slug} onChange={e => setDraft({...draft, slug:e.target.value})} className="mt-1 w-full rounded border border-[var(--border-hover)] bg-[var(--col-inset)] p-2 font-mono text-sm" /></label>
            <label className="text-xs text-[var(--fg-muted)] sm:col-span-2">说明<input value={draft.description} onChange={e => setDraft({...draft, description:e.target.value})} className="mt-1 w-full rounded border border-[var(--border-hover)] bg-[var(--col-inset)] p-2 text-sm" /></label>
            <label className="text-xs text-[var(--fg-muted)]">版本<input required value={draft.version} onChange={e => setDraft({...draft, version:e.target.value})} className="mt-1 w-full rounded border border-[var(--border-hover)] bg-[var(--col-inset)] p-2 font-mono text-sm" /></label>
            <label className="text-xs text-[var(--fg-muted)] sm:col-span-2">SKILL.md<textarea required rows={12} value={draft.content} onChange={e => setDraft({...draft, content:e.target.value})} className="mt-1 w-full rounded border border-[var(--border-hover)] bg-[var(--col-inset)] p-3 font-mono text-xs" /></label>
          </div>
          <div className="mt-4 flex justify-end gap-2"><button type="button" onClick={() => setShowUpload(false)} className="rounded border border-[var(--border-hover)] px-3 py-2 text-sm">取消</button><button disabled={saving} className="rounded bg-[var(--hl)] px-3 py-2 text-sm font-medium text-[var(--bg)] disabled:opacity-50">{saving ? '上传中…' : '提交审核'}</button></div>
        </form>
      </div>}
      {selected && <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" style={{ backgroundColor: 'color-mix(in srgb, var(--bg) 70%, transparent)' }} onMouseDown={e => { if (e.target === e.currentTarget) setSelected(null); }}>
        <section className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-t-2xl border border-[var(--border-hover)] bg-[var(--bg-secondary)] p-5 sm:rounded-2xl">
          <div className="flex items-start gap-3"><div><h2 className="text-lg font-semibold">{selected.name}</h2><code className="text-xs text-[var(--hl)]">{selected.slug}@{selected.version}</code></div><button onClick={() => setSelected(null)} className="ml-auto text-[var(--fg-dim)]">✕</button></div>
          <pre className="mt-4 overflow-x-auto whitespace-pre-wrap rounded-xl border border-[var(--border)] bg-[var(--code-bg)] p-4 text-xs leading-6 text-[var(--fg-muted)]">{selected.content}</pre>
          {reviewer && selected.status === 'published' && <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--hover-tint)] p-4">
            <h3 className="text-sm font-semibold">投稿到 anet.sh 公共 SkillHub</h3>
            <p className="mt-1 text-xs leading-5 text-[var(--fg-muted)]">导出只生成本地投稿包，不会自动公开。公共仓库还会进行第二次审核；包内不会包含 network_id、节点 ID、用户 ID、token alias 或私有审核记录。</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_180px_auto]">
              <input aria-label="公开发布者名称" value={publicPublisher} onChange={e => setPublicPublisher(e.target.value)} placeholder="公开发布者名称" maxLength={120} className="rounded border border-[var(--border-hover)] bg-[var(--col-inset)] px-3 py-2 text-xs" />
              <select aria-label="公开许可证" value={publicLicense} onChange={e => setPublicLicense(e.target.value)} className="rounded border border-[var(--border-hover)] bg-[var(--col-inset)] px-3 py-2 text-xs">
                <option value="">选择许可证</option><option value="Apache-2.0">Apache-2.0</option><option value="MIT">MIT</option><option value="CC-BY-4.0">CC-BY-4.0</option>
              </select>
              <button type="button" onClick={exportPublicSubmission} className="rounded bg-[var(--hl)] px-3 py-2 text-xs font-medium text-[var(--bg)]">导出公共投稿包</button>
            </div>
            <div className="mt-2 flex items-center gap-3 text-xs"><a href="https://anet.sh/skillhub/contribute" target="_blank" rel="noreferrer" className="text-[var(--hl)]">查看公共投稿步骤 ↗</a>{exported && <span className="text-[var(--success)]">已下载，尚未公开</span>}</div>
          </div>}
        </section>
      </div>}
    </div>
  );
}
