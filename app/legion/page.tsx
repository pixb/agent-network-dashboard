'use client';

/**
 * 军团 —— 组织架构图（#1636 / owner 2026-10-25）。
 *
 * 数据源和 /org 同一条（Hub 通讯录投影：人 → 部门 → 名下 Agent），
 * 但这里不是列表，是三层同心环：圆心是网络，第一环部门，第二环人，
 * 最外环 Agent。
 *
 * 三条硬约束（也是这页唯一的验收口径）：
 *   1. 坐标全部来自 app/lib/legion-layout.ts 的纯函数，本组件不算角度；
 *   2. 只用 globals.css 的 token，不新增硬编码色（color-ratchet 会红）；
 *   3. 空 / 401 / 500 各有独立状态，不能用「网络里没人」掩盖鉴权或故障
 *      —— 这条和 #1636 空态修的是同一个病。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { buildLegionLayout, toPixel, type LegionNode } from '../lib/legion-layout';
import { LEGION_LABEL_PEOPLE } from '../lib/legion-view-constants';
import { getAvatarUrl, useAvatarsVersion } from '../lib/avatars';
import { legionFetcher as fetcher, deptFetcher, legionReadError, scopedUrl, type PeopleResponse, type DepartmentsResponse, type StatusResponse } from '../lib/legion-data';
import { EmptyState } from '../components/EmptyState';
import { restoreFocusAfterUnmount } from '../lib/focus-fallback';
import { useNetworkId } from '../lib/network-context';
import { NetworkRequiredNotice } from '../components/NetworkRequiredNotice';

/**
 * callback ref + ResizeObserver。
 *
 * 不能写成 useEffect(() => ..., [])：图容器只在数据到达后才挂载，
 * 而那时的 effect 早就跑过了、ref.current 还是 null —— 尺寸永远停在 0，
 * SVG 宽高是 1px，整张图静默消失（节点数 0，页面其它部分看起来正常，
 * 最容易当成「布局算法坏了」）。callback ref 在节点真正挂载/卸载时都会触发。
 */
function useElementSize<T extends HTMLElement>() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    observer.current = ro;
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  return { ref, size };
}

function statusTone(status?: string) {
  if (status === 'working' || status === 'busy') return 'var(--success)';
  if (status === 'idle' || status === 'ready') return 'var(--info)';
  if (!status || status === 'offline' || status === 'unknown') return 'var(--fg-dim)';
  return 'var(--border-hover)';
}

/** 部门扇区弧带：angle 0 = 12 点、顺时针，和布局模块同一套坐标约定。 */
function arcPath(cx: number, cy: number, r: number, start: number, span: number): string {
  const end = start + span;
  const ax = cx + r * Math.sin(start);
  const ay = cy - r * Math.cos(start);
  const bx = cx + r * Math.sin(end);
  const by = cy - r * Math.cos(end);
  return `M ${ax} ${ay} A ${r} ${r} 0 ${span > Math.PI ? 1 : 0} 1 ${bx} ${by}`;
}

function ringLabel(node: LegionNode): string {
  if (node.kind === 'core') return '圆心';
  if (node.kind === 'group') return '部门';
  if (node.kind === 'person') return '成员';
  return 'Agent';
}

export default function LegionPage() {
  // #1636-P1 —— 当前选中网络。拼进 SWR key：切网 = 换 key = 重新取数，不会串上一个网络的数据。
  const { networkId, ready: networkReady } = useNetworkId();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  // 全屏演示（和 3D 页同口径）：把 2D 图铺满视口，会议室/PPT 用。
  const [isFullscreen, setIsFullscreen] = useState(false);
  // 净屏（和 3D 同口径）：隐掉头部与右侧面板，只留环图；Esc 恢复。
  const [cleanView, setCleanView] = useState(false);
  // 与 3D 一致：图例即筛选，只看某个状态的 Agent。
  const [statusOnly, setStatusOnly] = useState<'working' | 'idle' | 'offline' | null>(null);
  // manifest 拉完会派发 avatar 事件；订阅它才能在拿到头像 URL 后重渲染 SVG。
  const avatarsVersion = useAvatarsVersion();
  void avatarsVersion;
  const stageRef = useRef<HTMLDivElement | null>(null);
  // 「返回全体」点完按钮就卸载；不接管焦点就会掉回 body。
  const panelRef = useRef<HTMLElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  // 悬停/聚焦只影响亮度，不改布局：图不能因为鼠标划过就重排。
  const [hovered, setHovered] = useState<string | null>(null);
  const [focusGroup, setFocusGroup] = useState<string | null>(null);
  // ?present=1：与 3D 对齐，直接进净屏（演示/截图用一条链接）。
  // 只读一次 URL，退出后不回写——按 Esc 退出就该退出。
  const presentDeeplinkSettled = useRef(false);
  useEffect(() => {
    if (typeof window === 'undefined' || presentDeeplinkSettled.current) return;
    presentDeeplinkSettled.current = true;
    if (new URLSearchParams(window.location.search).get('present') !== '1') return;
    setCleanView(true);
  }, []);


  // 复制反馈：2D 早已把 focus/node 写回地址（链接可转人），但界面上没有复制入口，
  // 3D 有「复制链接」+ 反馈。这里补齐，文案与 3D 一致。
  const [shareInfo, setShareInfo] = useState('');
  // 窄屏把「次要操作」收进「更多」：390 宽下工具栏会折成两行，把图往下压掉 100 多像素。
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  // 大网络里节点列表很长：只列部门/圆心，键盘找部门时不用滚过几十个成员。
  const [listDeptsOnly, setListDeptsOnly] = useState(false);
  // 与 3D 共用同一个本地偏好：切视图后不用重新勾一次。
  useEffect(() => {
    setListDeptsOnly(window.localStorage.getItem('legion-list-depts-only') === '1');
  }, []);
  const toggleDeptsOnly = (next: boolean) => {
    setListDeptsOnly(next);
    window.localStorage.setItem('legion-list-depts-only', next ? '1' : '0');
  };
  // 深链 ?focus= 指向的部门不存在时，要明确告诉用户，而不是静默给一张没聚焦的图。
  const [focusMissing, setFocusMissing] = useState<string | null>(null);
  const [view, setView] = useState({ k: 1, tx: 0, ty: 0 });
  // 折叠的是布局节点 id（dept:xxx），不是 Hub 的 department_id。
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [exporting, setExporting] = useState(false);
  // 键盘/读屏入口：SVG 节点虽然可 Tab，但 400 个节点要按 400 次；给一个列表。
  const [listOpen, setListOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [exportError, setExportError] = useState('');
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const { ref, size } = useElementSize<HTMLDivElement>();

  // 节点 id 属于当前网络；换 SWR key 不会自动清掉旧网络的选中/聚焦状态。
  // 和 AliasAvatar 一样在渲染时调整，避免新网络先提交一帧旧节点高亮。
  const [viewNetworkId, setViewNetworkId] = useState(networkId);
  if (viewNetworkId !== networkId) {
    setViewNetworkId(networkId);
    setSelected(null);
    setFocusGroup(null);
    setHovered(null);
    setCollapsed(new Set());
    setView({ k: 1, tx: 0, ty: 0 });
  }

  const people = useSWR<PeopleResponse>(networkReady && networkId ? scopedUrl('/api/hub/people?limit=200&offset=0', networkId) : null, fetcher, {
    refreshInterval: 30000,
    shouldRetryOnError: false,
  });
  const hierarchy = useSWR<DepartmentsResponse | null>(
    networkReady && networkId ? scopedUrl('/api/hub/departments', networkId) : null, deptFetcher, { refreshInterval: 60000, shouldRetryOnError: false },
  );
  const status = useSWR<StatusResponse>(networkReady && networkId ? scopedUrl('/api/hub/status', networkId) : null, fetcher, {
    refreshInterval: 15000,
    shouldRetryOnError: false,
  });

  const peopleList = people.data?.people ?? [];
  const orphans = people.data?.agents_without_owner ?? [];
  const layout = useMemo(
    () => buildLegionLayout({
      people: peopleList,
      orphans,
      departments: hierarchy.data?.departments,
      members: hierarchy.data?.members,
      collapsed: [...collapsed],
    }),
    [peopleList, orphans, hierarchy.data, collapsed],
  );
  const statusByAlias = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of status.data?.sessions ?? []) map.set(s.alias, s.status);
    return map;
  }, [status.data]);

  // 图例带数量（和 3D 一致）：working / idle / 其余算离线未上报。
  const statusCounts = useMemo(() => {
    const counts = { working: 0, idle: 0, offline: 0 };
    for (const n of layout.nodes) {
      if (n.kind !== 'agent') continue;
      const st = statusByAlias.get(n.label);
      if (st === 'working') counts.working += 1;
      else if (st === 'idle' || st === 'ready') counts.idle += 1;
      else counts.offline += 1;
    }
    return counts;
  }, [layout.nodes, statusByAlias]);

  const points = useMemo(() => {
    if (size.width === 0 || size.height === 0) return new Map<string, { x: number; y: number }>();
    const map = new Map<string, { x: number; y: number }>();
    for (const node of layout.nodes) map.set(node.id, toPixel(node, size, 0.84));
    return map;
  }, [layout, size]);

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const hit = new Set<string>();
    for (const node of layout.nodes) {
      if (`${node.label} ${node.sublabel ?? ''}`.toLowerCase().includes(q)) hit.add(node.id);
    }
    // 命中的人/部门把子孙节点一起点亮，否则搜「平台」只能看见一个点。
    let grew = true;
    while (grew) {
      grew = false;
      for (const edge of layout.edges) {
        if (hit.has(edge.from) && !hit.has(edge.to)) { hit.add(edge.to); grew = true; }
      }
    }
    return hit;
  }, [layout, query]);

  const { childrenOf, parentOf } = useMemo(() => {
    const children = new Map<string, string[]>();
    const parents = new Map<string, string>();
    for (const edge of layout.edges) {
      const arr = children.get(edge.from) ?? [];
      arr.push(edge.to);
      children.set(edge.from, arr);
      parents.set(edge.to, edge.from);
    }
    return { childrenOf: children, parentOf: parents };
  }, [layout]);

  /** 一个节点的「血脉」：向上到圆心，向下到所有子孙。悬停时只点亮这一支。 */
  const related = useCallback((id: string) => {
    const set = new Set<string>([id]);
    for (let cur = parentOf.get(id); cur && !set.has(cur); cur = parentOf.get(cur)) set.add(cur);
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const child of childrenOf.get(cur) ?? []) {
        if (!set.has(child)) { set.add(child); stack.push(child); }
      }
    }
    return set;
  }, [childrenOf, parentOf]);

  // 搜索优先于悬停/聚焦：正在找东西时，鼠标划过不该把命中结果盖掉。
  const activeSet = useMemo(() => {
    if (matched) return matched;
    const anchor = hovered ?? focusGroup;
    return anchor ? related(anchor) : null;
  }, [matched, hovered, focusGroup, related]);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** 只有真的有下级的部门才可折叠；空部门折了也没意义。 */
  const canCollapse = useCallback((id: string) => {
    const node = layout.nodes.find(n => n.id === id);
    if (!node || node.kind !== 'group') return false;
    return layout.nodes.some(n => n.parentId === id);
  }, [layout]);

  const selectedNode = layout.nodes.find(n => n.id === selected) ?? null;
  // 选中部门时把它名下的成员/Agent 标出来：3D 那边已经这么做了（飞到正面 +
  // 成员描环），2D 只有「选中高亮」，来回切视图会失去方向感。
  const selectedMemberIds = useMemo(() => {
    if (!selectedNode || selectedNode.kind !== 'group') return null;
    const set = related(selectedNode.id);
    return new Set(layout.nodes.filter(n => (n.kind === 'person' || n.kind === 'agent') && set.has(n.id)).map(n => n.id));
  }, [layout.nodes, related, selectedNode]);
  const selectedChildren = selected
    ? layout.nodes.filter(n => n.parentId === selected)
    : [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField = !!target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
      // 在搜索框里打字时，空格/方向键都归输入框；只有 Esc 例外（清词保焦点）。
      if (inField) {
        if (e.key === 'Escape' && query) {
          e.preventDefault();
          setQuery('');
        }
        return;
      }
      // `/` 聚焦本页搜索。整站 Quick search 也绑了 `/`（CommandPalette），
      // 所以这里在捕获阶段拦下并 stopImmediatePropagation —— 在军团页上，
      // 「/」应该是搜军团成员，不是弹全局命令面板；全局面板仍可用 ⌘K。
      if (e.key === '/') {
        e.preventDefault();
        e.stopImmediatePropagation();
        searchRef.current?.focus();
        return;
      }
      // 全站 HelpOverlay 也绑了 `?`；本页在捕获阶段拦截，优先弹本页速查表。
      if (e.key === '?') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setHelpOpen(v => !v);
        return;
      }
      // 回车打开选中节点（Agent→节点页，成员/部门→/org）；和 3D 页一致。
      // 焦点在节点列表里时不做（回车 = 选中，再按一次才打开），避免一按就跳走。
      const inList = !!(document.activeElement && document.activeElement.closest('[role="listbox"]'));
      if (e.key === 'Enter' && selected && !inList) {
        const node = layout.nodes.find(n => n.id === selected);
        if (node && (node.kind === 'agent' || node.kind === 'person' || node.kind === 'group')) {
          e.preventDefault();
          router.push(node.kind === 'agent'
            ? `/nodes/${encodeURIComponent(node.label)}`
            : node.kind === 'group'
              ? `/org?focus=${encodeURIComponent(node.label)}`
              : '/org');
          return;
        }
      }
      // 空格折叠当前选中的部门（焦点在节点上时由节点自己处理，避免双触发）。
      if (e.key === ' ' && selected && canCollapse(selected) && !(e.target instanceof Element && e.target.closest('[role="button"]'))) {
        e.preventDefault();
        toggleCollapse(selected);
        return;
      }
      if (e.key !== 'Escape') return;
      if (helpOpen) { e.preventDefault(); setHelpOpen(false); return; }
      // 与 3D 一致：演示（净屏）状态下 Esc 先退出净屏。
      if (cleanView) { e.preventDefault(); setCleanView(false); return; }
      // 一次 Esc 只退一样：先清搜索，再退选中/聚焦。
      if (query) {
        e.preventDefault();
        setQuery('');
        return;
      }
      setSelected(null);
      setFocusGroup(null);
      setHovered(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [selected, canCollapse, toggleCollapse, query, layout.nodes, router, helpOpen, statusOnly, cleanView]);

  // 从 /org 的「在军团图里看」跳过来：/legion?focus=<部门名>
  // 用 location.search 而不是 useSearchParams，避免这个客户端页要额外包 Suspense。
  // URL 里的 focus 没应用完之前不往回写（StrictMode 重跑 effect 会抹掉参数）。
  const urlFocusSettled = useRef(false);
  useEffect(() => {
    if (typeof window === 'undefined' || urlFocusSettled.current) return;
    const focus = new URLSearchParams(window.location.search).get('focus');
    if (!focus) { urlFocusSettled.current = true; return; }
    // 数据还在加载时绝不能判定「找不到」：部门是后到的，早判会把正常深链误判成失效
    // （实测会把 ?focus=平台 判成不存在，而且 settle 之后再也不重试）。
    if (loading || layout.nodes.length === 0) return;
    const node = layout.nodes.find(n => n.kind === 'group' && n.label === focus);
    urlFocusSettled.current = true;
    if (!node) { setFocusMissing(focus); return; }
    setFocusGroup(node.id);
    setSelected(node.id);
  }, [layout.nodes]);

  // 反向同步：选中「只看这个部门」后把 focus 写回 URL，复制地址就能把同一个
  // 视角发给别人。
  useEffect(() => {
    if (typeof window === 'undefined' || !urlFocusSettled.current) return;
    const params = new URLSearchParams(window.location.search);
    const label = focusGroup ? layout.nodes.find(n => n.id === focusGroup)?.label : null;
    if (label) params.set('focus', label);
    else params.delete('focus');
    const qs = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  }, [focusGroup, layout.nodes]);

  // /legion?node=<名字>：和 3D 同口径（成员 display_name、Agent alias），
  // 打开后直接选中该节点；选中变化也写回地址，链接可转人。
  const urlNodeSettled = useRef(false);
  useEffect(() => {
    if (typeof window === 'undefined' || urlNodeSettled.current) return;
    const want = new URLSearchParams(window.location.search).get('node');
    if (!want) { urlNodeSettled.current = true; return; }
    const node = layout.nodes.find(n => n.label === want && n.kind !== 'group');
    const loaded = layout.stats.people + layout.stats.agents > 0;
    if (!node) {
      if (loaded) urlNodeSettled.current = true;
      return;
    }
    urlNodeSettled.current = true;
    setSelected(node.id);
  }, [layout.nodes]);

  useEffect(() => {
    if (typeof window === 'undefined' || !urlNodeSettled.current) return;
    const params = new URLSearchParams(window.location.search);
    const picked = selected ? layout.nodes.find(n => n.id === selected) : null;
    // 部门走 ?focus=，这里只写成员/Agent —— 否则写出来的 ?node=部门 读回时
    // 会被「节点深链不认部门」的规则忽略，变成坏链接。
    if (picked && picked.kind !== 'group' && picked.kind !== 'core') params.set('node', picked.label);
    else params.delete('node');
    const qs = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  }, [selected, layout.nodes]);

  // 合并 callback ref 必须是稳定引用：每次渲染新建函数会让 React 反复
  // detach/attach，measure → setSize → 重渲染 → 死循环（实测 Maximum update depth）。
  const stageCallbackRef = useCallback((el: HTMLDivElement | null) => {
    ref(el);
    stageRef.current = el;
  }, [ref]);

  const toggleFullscreen = useCallback(async () => {
    const el = pageRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await el.requestFullscreen();
    } catch {
      // 被浏览器/iframe 拒绝时保持原样
    }
  }, []);

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // 筛选开着时单独挂 Esc：主键盘处理器是 capture 阶段注册的，和全站
  // （HelpOverlay / CommandPalette）的 Esc 抢事件，实测收不到。
  useEffect(() => {
    if (!statusOnly) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setStatusOnly(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [statusOnly]);

  useEffect(() => {
    if (!cleanView) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setCleanView(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [cleanView]);

  const reset = useCallback(() => setView({ k: 1, tx: 0, ty: 0 }), []);
  const zoomBy = useCallback((factor: number, anchor?: { x: number; y: number }) => {
    setView(v => {
      const k = Math.min(3, Math.max(0.5, v.k * factor));
      // 有锚点（滚轮）就以指针为准，没有就用容器中心（＋/－ 按钮、键盘）。
      const cx = anchor?.x ?? size.width / 2;
      const cy = anchor?.y ?? size.height / 2;
      return { k, tx: cx - (cx - v.tx) * (k / v.k), ty: cy - (cy - v.ty) * (k / v.k) };
    });
  }, [layout, size.height, size.width, statusByAlias]);

  /**
   * 导出当前视图为 PNG。两条坑：
   *  1. Tailwind 的 `fill-[var(--fg)]` / `text-[10px]` 是类名，独立 SVG 里
   *     没有那条样式表，直接序列化会变成黑字 16px → 逐节点内联 computed style。
   *  2. SVG 背景是透明的，深色主题下导出的图上文字独自漂在透明底上 →
   *     先铺一层 --bg 实底，再 2x 光栅化（ retina 屏不糊）。
   */
  const exportPng = useCallback(async () => {
    const svg = svgRef.current;
    if (!svg) return;
    setExporting(true);
    setExportError('');
    try {
      const w = svg.clientWidth || size.width || 900;
      const h = svg.clientHeight || size.height || 620;
      const clone = svg.cloneNode(true) as SVGSVGElement;
      const PROPS = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'font-size', 'font-weight', 'font-family', 'letter-spacing', 'opacity', 'paint-order', 'text-anchor'];
      const inline = (src: Element, dst: Element) => {
        const cs = getComputedStyle(src);
        const style = (dst as SVGElement).style;
        for (const prop of PROPS) {
          const value = cs.getPropertyValue(prop);
          if (value) style.setProperty(prop, value);
        }
        const sc = src.children;
        const dc = dst.children;
        for (let i = 0; i < sc.length && i < dc.length; i++) inline(sc[i], dc[i]);
      };
      inline(svg, clone);
      // 渐变引用在序列化后可能解析不到（导出图里圆心曾整块变黑，浅色主题尤其明显）。
      // 把 url(#...) 的填充换成实心底色，保证导出图在任何主题下都可读。
      const coreFill = getComputedStyle(document.documentElement).getPropertyValue('--bg-elevated').trim() || '#1f1f24';
      clone.querySelectorAll('[fill*="url("]').forEach(el => {
        el.setAttribute('fill', coreFill);
        // inline() 把 fill 写进了 style，属性会被 style 压过 —— 两边都要改。
        (el as SVGElement).style.fill = coreFill;
      });
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', String(w));
      clone.setAttribute('height', String(h));
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0b0b0d';
      const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bgRect.setAttribute('width', String(w));
      bgRect.setAttribute('height', String(h));
      bgRect.setAttribute('fill', bg);
      clone.insertBefore(bgRect, clone.firstChild);

      const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('SVG 转图片失败'));
        img.src = url;
      });
      const scale = 2;
      const HEAD = Math.round(54 * scale);
      const FOOT = Math.round(28 * scale);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale) + HEAD + FOOT;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('浏览器不支持 canvas');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, HEAD, Math.round(w * scale), Math.round(h * scale));

      // 导出图加标题栏/图例/时间：单独存下来也能说清是谁的军团、什么时候导的。
      const cssVar = (name: string, fallback: string) =>
        getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
      const fg = cssVar('--fg', '#e5e7eb');
      const dim = cssVar('--fg-muted', '#9ca3af');
      const font = 'system-ui, -apple-system, "Segoe UI", "Noto Sans SC", sans-serif';
      const px = (n: number) => Math.round(n * scale);
      const personCount = layout.nodes.filter(n => n.kind === 'person').length;
      const agentCount = layout.nodes.filter(n => n.kind === 'agent').length;
      const deptCount = layout.nodes.filter(n => n.kind === 'group').length;
      const workingCount = [...statusByAlias.values()].filter(v => v === 'working').length;
      const subtitle = deptCount > 0
        ? `${deptCount} 个部门 · ${personCount} 名成员 · ${agentCount} 个 Agent · ${workingCount} 个运行中`
        : `${personCount} 名成员 · ${agentCount} 个 Agent · ${workingCount} 个运行中`;

      ctx.textBaseline = 'middle';
      ctx.fillStyle = fg;
      ctx.font = `600 ${px(17)}px ${font}`;
      ctx.textAlign = 'left';
      ctx.fillText('军团组织架构', px(16), px(24));
      ctx.fillStyle = dim;
      ctx.font = `${px(12)}px ${font}`;
      ctx.fillText(subtitle, px(16), px(42));
      ctx.textAlign = 'right';
      ctx.font = `${px(11)}px ${font}`;
      ctx.fillText(`导出 ${new Date().toLocaleString('zh-CN', { hour12: false })}`, canvas.width - px(16), px(24));

      // 底部图例：颜色读主题 token（之前写死 #4ade80/#7dd3fc，浅色主题导出时
      // 会和页面上的青绿不一致）。
      const legend: Array<[string, string]> = [
        [cssVar('--success', '#4ade80'), '运行中'],
        [cssVar('--fg-dim', '#6b7280'), '空闲 / 离线'],
        [cssVar('--accent', '#7dd3fc'), '聚焦 / 命中'],
      ];
      let lx = px(16);
      const ly = canvas.height - FOOT / 2;
      ctx.textAlign = 'left';
      for (const [color, label] of legend) {
        ctx.beginPath();
        ctx.arc(lx + px(3), ly, px(3.5), 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.fillStyle = dim;
        ctx.font = `${px(10.5)}px ${font}`;
        ctx.fillText(label, lx + px(12), ly);
        lx += px(12 + 10.5 * label.length + 18);
      }
      ctx.textAlign = 'right';
      ctx.fillText('ANet · Legion', canvas.width - px(16), ly);

      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('PNG 编码失败');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `legion-${new Date().toISOString().slice(0, 10)}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 0);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : '导出失败');
    } finally {
      setExporting(false);
    }
  }, [layout, size.height, size.width, statusByAlias]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, { x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setView(v => ({ ...v, tx: drag.current!.tx + (e.clientX - drag.current!.x), ty: drag.current!.ty + (e.clientY - drag.current!.y) }));
  };
  const onPointerUp = () => { drag.current = null; };

  const baseRadius = (Math.min(size.width, size.height) / 2) * 0.84;
  // 节点尺寸随画布缩放：1280 下取 1，375 下约 0.66。不缩的话部门圆直径
  // 44px 会大于环差，父子部门在窄屏上叠成一坨（实测 375 下圆心只差 29px）。
  const nodeScale = Math.max(0.62, Math.min(1, Math.min(size.width, size.height) / 520));
  // 网络还没确定时也计入 loading：否则 SWR 的 null key 让 isLoading=false，
  // 页面会误显示「军团还没有成员」。
  const loading = !networkReady || (people.isLoading && !people.data) || hierarchy.isLoading;
  const error = legionReadError(people.error, hierarchy.error);

  return (
    <div ref={pageRef} data-legion-root className={`min-h-screen bg-[var(--bg)] text-[var(--fg)] ${isFullscreen ? 'h-[100dvh] overflow-auto' : ''}`}>
      <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
        <div className={`mb-4 flex flex-wrap items-end justify-between gap-3 ${cleanView ? 'invisible' : 'visible'}`}>
          <div>
            <h1 className="text-lg font-semibold text-white">Legion</h1>
            <p className="mt-1 text-xs text-[var(--fg-muted)]">
              军团编制：圆心是网络，外三环依次是部门、成员与名下 Agent。
            </p>
            {matched && matched.size === 0 && (
              <p className="mt-1 flex items-center gap-2 text-[11px] text-[var(--fg-muted)]">
                没有匹配的成员或部门
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="rounded px-1.5 py-0.5 text-[10px] text-[var(--accent-text)] hover:bg-[var(--hover-tint)]"
                >
                  清空搜索
                </button>
              </p>
            )}
            {/* 搜索有匹配时也要有反馈：之前只有「0 结果」有文案，屏幕阅读器用户输入后
                完全不知道筛出了几个节点。用 live region 播报数量。 */}
            {query.trim() && matched && matched.size > 0 && (
              <p role="status" aria-live="polite" data-testid="legion-search-status" className="mt-1 text-[11px] text-[var(--fg-muted)]">
                匹配 {matched.size} 个节点
              </p>
            )}
            {!loading && !error && layout.stats.people === 0 && layout.stats.groups > 0 && (
              <p role="status" className="mt-1 text-[11px] text-[var(--fg-muted)]" data-testid="legion-empty-members">
                已有 {layout.stats.groups} 个部门，还没有成员加入 —— 成员绑定 Agent 后会自动出现在环上。
                <span className="text-[var(--fg-dim)]">绑定在客户端完成；本页会自动刷新，不用手动重载。</span>
              </p>
            )}
            {hierarchy.data === null && (
              <p className="mt-1 text-[11px] text-[var(--fg-muted)]">
                当前 Hub 没有部门树接口，编制按通讯录的部门名分组（升级 Hub 后自动变为真实层级）。
              </p>
            )}
            {focusMissing && (
              <p role="status" data-testid="legion-focus-missing"
                className="mt-2 inline-flex items-center gap-2 rounded-full bg-[var(--danger)]/10 px-3 py-1 text-[11px] text-[var(--danger)]">
                找不到部门「{focusMissing}」——可能已重命名或删除
                <button type="button" onClick={() => setFocusMissing(null)} aria-label="忽略聚焦提示"
                  className="text-[var(--fg-muted)] hover:text-[var(--fg)]">✕</button>
              </p>
            )}
            {focusGroup && (() => {
              // 聚焦状态不只是视觉胶囊：用 live region 播报，屏幕阅读器用户点完部门
              // 才知道「已经聚焦到哪个部门」，而不是只能靠眼神确认。
              // 顺带报出规模：聚焦后画面只留这棵子树，不报人数就不知道该看多少人。
              const node = layout.nodes.find(n => n.id === focusGroup);
              const facts = node ? `${node.memberCount} 人 · 下级 ${layout.nodes.filter(n => n.parentId === node.id && n.kind === 'group').length}` : '';
              // 与 3D 同口径：聚焦二层部门时给出它在哪条链上，避免只看到孤零零一个部门名。
              const byId = new Map(layout.nodes.map(n => [n.id, n]));
              const chain: string[] = [];
              for (let cur = node?.parentId ? byId.get(node.parentId) : undefined; cur && cur.kind !== 'core'; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
                chain.unshift(cur.label);
              }
              if (node) chain.push(node.label);
              const focusPath = chain.join(' / ');
              return (
              <span role="status" aria-live="polite" data-testid="legion-focus-status"
                className="mt-2 inline-flex items-center gap-2 rounded-full bg-[var(--bg-elevated)] px-3 py-1 text-[11px] text-[var(--fg)]">
                聚焦：{node?.label}
                {facts && <span data-testid="legion-focus-facts" className="text-[var(--fg-muted)] tabular-nums">{facts}</span>}
                {focusPath.includes(' / ') && (
                  <span data-testid="legion-2d-focus-path" className="text-[10px] text-[var(--fg-dim)]">{focusPath}</span>
                )}
                <span data-testid="legion-2d-focus" hidden>{node?.label}</span>
                <button type="button" onClick={() => setFocusGroup(null)} aria-label="取消聚焦" className="text-[var(--fg-muted)] hover:text-[var(--fg)]">
                  ✕
                </button>
              </span>
              );
            })()}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5">
              <input
                ref={searchRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="搜索成员 / 部门 / Agent"
                aria-label="搜索军团成员"
                className="w-40 bg-transparent text-sm text-white placeholder:text-[var(--fg-dim)] focus:outline-none sm:w-56"
              />
              {query && (
                <button
                  type="button"
                  data-testid="legion-search-clear"
                  aria-label="清空搜索"
                  onClick={() => { setQuery(''); searchRef.current?.focus(); }}
                  className="rounded px-1 text-[11px] text-[var(--fg-dim)] hover:text-[var(--fg)]"
                >
                  ✕
                </button>
              )}
            </div>
            {collapsed.size > 0 && (
              <button
                type="button"
                onClick={() => setCollapsed(new Set())}
                className="rounded-md px-2.5 py-1.5 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]"
              >
                全部展开（{collapsed.size}）
              </button>
            )}
            <button
              type="button"
              data-testid="legion-more-tools"
              aria-expanded={mobileToolsOpen}
              aria-controls="legion-more-tools-panel"
              onClick={() => setMobileToolsOpen(v => !v)}
              className="rounded-md px-2.5 py-1.5 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)] sm:hidden"
            >
              {mobileToolsOpen ? '收起操作' : '更多操作'}
            </button>
            <span
              id="legion-more-tools-panel"
              // contents 让这些按钮仍按原来的 flex 排列；移动端收起时整块隐藏。
              className={mobileToolsOpen ? 'contents' : 'hidden sm:contents'}
            >
            <button
              type="button"
              onClick={toggleFullscreen}
              aria-pressed={isFullscreen}
              aria-label={isFullscreen ? '退出全屏' : '全屏查看'}
              data-testid="legion-fullscreen"
              className={`rounded-md px-2.5 py-1.5 text-xs transition-colors ${isFullscreen ? 'bg-[var(--accent)]/15 text-[var(--accent-text)]' : 'text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]'}`}
            >
              {isFullscreen ? '退出全屏' : '全屏'}
            </button>
            <button
              type="button"
              onClick={() => setCleanView(v => !v)}
              aria-pressed={cleanView}
              aria-label={cleanView ? '恢复界面' : '净屏（隐藏界面）'}
              data-testid="legion-clean"
              className={`rounded-md px-2.5 py-1.5 text-xs transition-colors ${cleanView ? 'bg-[var(--accent)]/15 text-[var(--accent-text)]' : 'text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]'}`}
            >
              {cleanView ? '恢复界面' : '净屏'}
            </button>
            <button
              type="button"
              onClick={exportPng}
              disabled={exporting}
              data-testid="legion-export"
              className="rounded-md bg-[var(--bg-elevated)] px-2.5 py-1.5 text-xs text-[var(--fg)] hover:bg-[var(--hover-tint)] disabled:opacity-50"
            >
              {exporting ? '导出中…' : '导出 PNG'}
            </button>
            <button
              type="button"
              onClick={() => setListOpen(v => {
                const next = !v;
                // 打开时把焦点送进列表第一个选项：否则按 Tab 会先走完头部按钮。
                if (next) requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('[role="option"]')?.focus());
                return next;
              })}
              aria-expanded={listOpen}
              aria-controls="legion-node-list"
              data-testid="legion-list-toggle"
              className="rounded-md px-2.5 py-1.5 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]"
            >
              {listOpen ? '收起列表' : '节点列表'}
            </button>
            <Link
              // 带着上下文跳过去：优先「聚焦」的部门，其次「选中」的部门（两者都是用户
              // 正在看的目标）；否则在 2D 看了半天，切到 3D 又要重新找。
              href={(() => {
                const target = focusGroup ?? selected;
                const node = target ? layout.nodes.find(n => n.id === target) : null;
                return node && node.kind === 'group' ? `/legion/3d?focus=${encodeURIComponent(node.label)}` : '/legion/3d';
              })()}
              data-testid="legion-3d-link"
              className="rounded-md bg-[var(--accent)]/15 px-2.5 py-1.5 text-xs text-[var(--accent-text)] hover:bg-[var(--accent)]/25"
            >
              3D 视图
            </Link>
            <button
              type="button"
              data-testid="legion-2d-copy-view"
              onClick={async () => {
                const label = focusGroup ? layout.nodes.find(n => n.id === focusGroup)?.label : null;
                const picked = !label && selected ? layout.nodes.find(n => n.id === selected) : null;
                const params = new URLSearchParams(window.location.search);
                // 地址栏由上面的 effect 同步；这里再按当前状态兜一次，避免复制到上一帧的链接。
                if (label) params.set('focus', label); else params.delete('focus');
                if (picked && picked.kind !== 'group' && picked.kind !== 'core') params.set('node', picked.label); else params.delete('node');
                const qs = params.toString();
                const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                try {
                  await navigator.clipboard.writeText(url);
                  setShareInfo('已复制链接');
                } catch {
                  setShareInfo('复制失败，请手动复制地址栏');
                }
                window.setTimeout(() => setShareInfo(''), 2500);
              }}
              className="rounded-md px-2.5 py-1.5 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]"
            >
              复制链接
            </button>
            {shareInfo && (
              <span role="status" data-testid="legion-2d-share-info" className="text-[11px] text-[var(--fg-muted)]">{shareInfo}</span>
            )}
            <Link
              href="/legion/plaza"
              data-testid="legion-plaza-link"
              className="rounded-md px-2.5 py-1.5 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]"
            >
              平台视角
            </Link>
            <Link href="/org" className="rounded-md px-2.5 py-1.5 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]">
              列表视图
            </Link>
            </span>
          </div>
        </div>

        {error?.status === 401 ? (
          <div role="alert" className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
            会话已过期，<Link href="/login" className="underline">重新登录</Link> 后再看军团编制。
          </div>
        ) : null}
        {helpOpen && (
          <div role="dialog" aria-modal="true" aria-label="键盘快捷键" data-testid="legion-help"
            className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg)]/70 p-4" onClick={() => setHelpOpen(false)}>
            <div className="w-full max-w-sm rounded-xl bg-[var(--bg-secondary)] p-4 text-sm text-[var(--fg)]" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">键盘快捷键</h2>
                <button type="button" onClick={() => setHelpOpen(false)} aria-label="关闭" className="rounded px-1.5 py-0.5 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)]">✕</button>
              </div>
              <dl className="mt-3 space-y-1.5 text-xs text-[var(--fg-muted)]">
                {[
                  ['/ 或 Ctrl/⌘+K', '搜索军团成员'],
                  ['拖动 / 滚轮', '平移 / 缩放'],
                  ['点节点', '看详情'],
                  ['回车', '打开选中节点（焦点不在列表时）'],
                  ['列表内 ↑ ↓', '移动选中项；回车只选中'],
                  ['空格', '折叠/展开部门'],
                  ['? ', '打开/关闭这张表'],
                  ['Esc', '先清搜索，再取消选中'],
                ].map(([k, v]) => (
                  <div key={k} className="flex gap-3">
                    <dt className="w-32 shrink-0 font-mono text-[var(--fg)]">{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        )}

        {exportError ? (
          <div className="mb-4 rounded-lg bg-[var(--bg-secondary)] px-4 py-2 text-xs text-[var(--danger)]">
            导出失败：{exportError}
          </div>
        ) : null}
        {error && error.status !== 401 ? (
          <div role="alert" className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-300">
            读取失败：{error.message}
            <button type="button" onClick={() => { void people.mutate(); void hierarchy.mutate(); }} className="ml-3 underline">重试</button>
          </div>
        ) : null}

        {loading ? (
          <div className="flex h-[62vh] min-h-[420px] items-center justify-center rounded-xl bg-[var(--bg-secondary)]">
            <div className="h-40 w-40 animate-pulse rounded-full border border-[var(--border)]" />
          </div>
        ) : networkReady && !networkId ? (
          <NetworkRequiredNotice />
        ) : !error && layout.stats.people === 0 && layout.stats.orphans === 0 && layout.stats.groups === 0 ? (
          <EmptyState
            variant="nodes"
            title="军团还没有成员"
            sub="成员加入网络并绑定 Agent 后，这里会自动长出编制。"
          />
        ) : error ? null : (
          <div className={`grid gap-4 ${cleanView ? 'lg:grid-cols-1' : 'lg:grid-cols-[1fr_280px]'}`}>
            <div
              ref={stageCallbackRef}
              className={`relative overflow-hidden rounded-xl bg-[var(--bg-secondary)] ${cleanView ? 'h-[calc(100dvh-3rem)]' : isFullscreen ? 'h-[calc(100dvh-10rem)] min-h-[420px]' : 'h-[62vh] min-h-[420px] sm:h-[calc(100dvh-9.5rem)]'}`}
              onWheel={onWheel}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
              onDoubleClick={reset}
            >
              {listOpen && (
                <div
                  ref={listRef}
                  id="legion-node-list"
                  role="listbox"
                  aria-label="军团节点（Tab 浏览，回车选中）"
          onKeyDown={(e) => {
            // 列表内方向键移动焦点（标准 listbox 行为），避免几十次 Tab。
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            const items = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="option"]')];
            const i = items.indexOf(document.activeElement as HTMLElement);
            const next = items[Math.min(items.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
            if (next) { e.preventDefault(); next.focus(); }
          }}
                  data-testid="legion-node-list"
                  className="absolute left-3 top-3 z-10 max-h-[70%] w-56 overflow-y-auto rounded-xl bg-[var(--bg)]/95 p-1.5 text-xs shadow-lg backdrop-blur sm:w-60"
                >
                  <label className="mb-1 flex items-center gap-1.5 rounded px-1.5 py-1 text-[10px] text-[var(--fg-muted)]">
                    <input
                      type="checkbox"
                      data-testid="legion-list-depts-only"
                      checked={listDeptsOnly}
                      onChange={e => toggleDeptsOnly(e.target.checked)}
                      className="h-3 w-3"
                    />
                    只列部门与圆心
                  </label>
                  {(() => {
                    const baseAll = layout.nodes
                      .filter(n => n.kind === 'core' || n.kind === 'group' || layout.stats.people <= LEGION_LABEL_PEOPLE)
                      .filter(n => !listDeptsOnly || n.kind === 'core' || n.kind === 'group');
                    const qAll = query.trim().toLowerCase();
                    const shownAll = qAll ? baseAll.filter(n => (n.label || '').toLowerCase().includes(qAll)) : baseAll;
                    if (shownAll.length > 0) return null;
                    return (
                      <p data-testid="legion-list-empty-hint" className="px-2 py-2 text-[10px] leading-relaxed text-[var(--fg-muted)]">
                        {listDeptsOnly
                          ? '当前只列部门，可能被这个筛选挡住了。'
                          : '没有匹配的节点。'}
                        {listDeptsOnly && (
                          <button type="button" onClick={() => toggleDeptsOnly(false)} className="ml-1 underline hover:text-[var(--fg)]">
                            取消只列部门
                          </button>
                        )}
                      </p>
                    );
                  })()}
                  {(() => {
                    // 列表与搜索保持一致：之前搜索只影响图上的高亮，列表仍列全部，
                    // 用户搜了名字却看到一长串无关条目。
                    const base = layout.nodes
                      // 与 3D 一致：成员 ≤60 时把 Agent 也列出来，键盘能直接走到 Agent 详情。
                      .filter(n => n.kind === 'core' || n.kind === 'group' || layout.stats.people <= LEGION_LABEL_PEOPLE)
                      .filter(n => !listDeptsOnly || n.kind === 'core' || n.kind === 'group');
                    const q = query.trim().toLowerCase();
                    return q ? base.filter(n => (n.label || '').toLowerCase().includes(q)) : base;
                  })().map(n => (
                      <button
                        key={n.id}
                        type="button"
                        role="option"
                        aria-selected={selected === n.id}
                        data-selected={selected === n.id ? 'true' : undefined}
                        ref={el => { if (selected === n.id && el) el.scrollIntoView({ block: 'nearest' }); }}
                        onClick={() => {
                          if (selected === n.id) {
                            if (n.kind === 'agent') router.push(`/nodes/${encodeURIComponent(n.label)}`);
                            else if (n.kind === 'person' || n.kind === 'group') router.push('/org');
                          } else {
                            setSelected(n.id);
                            setHovered(null);
                          }
                        }}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--hl)] focus-visible:outline-offset-1 ${
                          selected === n.id
                            ? 'bg-[var(--accent)]/15 text-[var(--fg)]'
                            : 'text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]'
                        }`}
                      >
                        <span className="w-8 shrink-0 text-[10px] text-[var(--fg-dim)]">{ringLabel(n)}</span>
                        <span className="truncate">{n.label}</span>
                      </button>
                    ))}
                  {layout.stats.people > LEGION_LABEL_PEOPLE && (
                    <p className="px-2 py-1 text-[10px] text-[var(--fg-dim)]">成员超过 60，只列部门与核心；找成员请用搜索或直接点图。</p>
                  )}
                </div>
              )}
              <svg ref={svgRef} width={size.width || 1} height={size.height || 1} className="block touch-none select-none" role="img" aria-label="军团组织架构图" data-member-marks={selectedMemberIds?.size ?? 0}>
                <defs>
                  <radialGradient id="legion-core" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="var(--bg-elevated)" />
                    <stop offset="100%" stopColor="var(--bg-secondary)" />
                  </radialGradient>
                </defs>
                {/* 入场：整张编制图轻微放大淡入，像镜头把这张图「推到位」。
                    只在首帧挂一次；reduced-motion 下由 CSS 直接跳过。 */}
                <g data-role="legion-plate" transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
                  {layout.rings.map(ring => (
                    <circle
                      key={ring.ring}
                      cx={size.width / 2}
                      cy={size.height / 2}
                      r={(Math.min(size.width, size.height) / 2) * 0.84 * ring.radius}
                      fill="none"
                      stroke="var(--border)"
                      strokeDasharray="2 6"
                      opacity={0.7}
                    />
                  ))}

                  {/* 部门扇区：一条细弧把「这个部门占多大角度」画出来，
                      比纯圆点更容易看出编制比例，也不用引入新颜色。 */}
                  {layout.nodes.filter(n => n.kind === 'group' && n.span && n.spanStart !== undefined).map(node => {
                    const on = !activeSet || activeSet.has(node.id);
                    const focused = focusGroup === node.id;
                    return (
                      <g
                        key={`sector:${node.id}`}
                        // 聚焦某部门时，其它扇区轻微失焦（聚光）：只压暗不够，失焦才像「镜头对着这一个」。
                        // 是否启用交给 CSS 媒体查询（按视口判断）；窄屏不加，避免软光栅掉帧。
                        data-dim={focusGroup && !on ? 'true' : undefined}
                      >
                        {/* 扇区厚度随层级递进：外层部门粗而淡（表示「一大类」），
                            内层部门细而实（表示「具体科室」）。层级不再只靠半径区分。 */}
                        <path
                          data-role="sector"
                          data-depth={node.depth ?? 1}
                          d={arcPath(size.width / 2, size.height / 2, baseRadius * 0.33, node.spanStart!, node.span!)}
                          fill="none"
                          stroke={focused ? 'var(--hl)' : 'var(--border-hover)'}
                          strokeWidth={focused ? 3 : Math.min(4.5, 1.6 + 0.8 * (Math.max(1, node.depth ?? 1) - 1))}
                          strokeLinecap="butt"
                          opacity={on ? (focused ? 0.95 : Math.max(0.34, 0.62 - 0.12 * (Math.max(1, node.depth ?? 1) - 1))) : 0.08}
                        />
                        {/* 聚焦部门加一圈呼吸光弧：静态描边只能说「选中了」，动起来才像「镜头停在这儿」。
                            reduced-motion 下由 CSS 关掉动画，退化成静态弧。 */}
                        {focused && (
                          <path
                            data-role="focus-pulse"
                            d={arcPath(size.width / 2, size.height / 2, baseRadius * 0.33, node.spanStart!, node.span!)}
                            fill="none"
                            stroke="var(--hl)"
                            strokeWidth={6}
                            strokeLinecap="round"
                            opacity={0.6}
                            pointerEvents="none"
                          />
                        )}
                      </g>
                    );
                  })}

                  {layout.edges.map(edge => {
                    const a = points.get(edge.from);
                    const b = points.get(edge.to);
                    if (!a || !b) return null;
                    const target = layout.nodes.find(n => n.id === edge.to);
                    const dim = activeSet && !(activeSet.has(edge.from) && activeSet.has(edge.to));
                    const working = target?.kind === 'agent' && statusByAlias.get(target.label) === 'working';
                    return (
                      <path
                        key={edge.id}
                        d={`M ${a.x} ${a.y} Q ${(a.x + b.x) / 2} ${(a.y + b.y) / 2} ${b.x} ${b.y}`}
                        fill="none"
                        stroke={working ? 'var(--success)' : 'var(--border-hover)'}
                        strokeWidth={working ? 1.4 : 1}
                        strokeDasharray={working ? '4 4' : undefined}
                        className={working ? 'legion-flow' : undefined}
                        opacity={dim ? 0.08 : working ? 0.85 : 0.4}
                      />
                    );
                  })}

                  {layout.nodes.map(node => {
                    const p = points.get(node.id);
                    if (!p) return null;
                    const dim = activeSet ? !activeSet.has(node.id) : false;
                    const isSelected = selected === node.id;
                    const statusValue = node.kind === 'agent' ? statusByAlias.get(node.label) : undefined;
                    // 人多时把成员点收小：100 个 16px 圆挤在同一圈会连成一条白带，
                    // 看不出「一个个的人」；和 3D 的 crowd 缩放同一个思路。
                    const crowd = node.kind === 'person' && layout.stats.people > LEGION_LABEL_PEOPLE ? 0.72 : 1;
                    const deptR = node.kind === 'group' ? ((node.depth ?? 1) <= 1 ? 24 : 16) : 0;
                    const r = (node.kind === 'core' ? 48 : node.kind === 'group' ? deptR : node.kind === 'person' ? 16 : 7) * nodeScale * crowd;
                    const labelScale = Math.max(nodeScale, 0.85);
                    // 大盘（r≥18 的一级部门）把名字与人数都写在盘内两行；小盘仍在盘下。
                    const insideCount = node.kind === 'group' && (node.depth ?? 1) <= 1 && r >= 18;
                    return (
                      <g
                        key={node.id}
                        data-node-id={node.id}
                        transform={`translate(${p.x} ${p.y})`}
                        opacity={dim || (statusOnly && node.kind === 'agent' && (statusValue ?? 'offline') !== statusOnly) ? 0.18 : 1}
                        // roving tabindex：整张图只有一个 Tab 停点（选中项，未选中时是第一个节点），
                        // 其余为 -1，靠方向键移动。之前每个节点都是 0，几十个停点会挡住后面的面板。
                        tabIndex={(selected ?? layout.nodes[0]?.id) === node.id ? 0 : -1}
                        role="button"
                        aria-label={`${ringLabel(node)} ${node.label}`}
                        onMouseEnter={() => setHovered(node.id)}
                        onMouseLeave={() => setHovered(h => (h === node.id ? null : h))}
                        onFocus={() => setHovered(node.id)}
                        onBlur={() => setHovered(h => (h === node.id ? null : h))}
                        onClick={(e) => { e.stopPropagation(); setSelected(node.id); }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); setSelected(node.id); return; }
                          if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                            const nodes = layout.nodes;
                            const from = nodes.findIndex(n => n.id === node.id);
                            if (from < 0 || nodes.length < 2) return;
                            const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
                            const nextIndex = (from + (forward ? 1 : -1) + nodes.length) % nodes.length;
                            const nextNode = nodes[nextIndex];
                            e.preventDefault();
                            setSelected(nextNode.id);
                            // tabIndex 由 selected 驱动，等下一帧再聚焦新停点。
                            requestAnimationFrame(() => {
                              document.querySelector<SVGGElement>(`[data-node-id="${nextNode.id}"]`)?.focus();
                            });
                            return;
                          }
                          if (e.key === ' ') {
                            e.preventDefault();
                            if (node.kind === 'group' && canCollapse(node.id)) toggleCollapse(node.id);
                            else setSelected(node.id);
                          }
                        }}
                        className="cursor-pointer outline-none focus-visible:opacity-80"
                      >
                        {/* 透明命中区：<g> 的包围盒中心常常落在圆与标签之间的空白里，
                            只靠已绘制的圆去接点击，用户点“名字”是点不中的。
                            部门只放到 r+6：深度 2 时相邻部门圆心最近只有 ~29px，
                            r+14 会让「平台」的命中圆盖住「后端」，点谁都选后端。 */}
                        <circle
                          r={node.kind === 'core' ? 50 : node.kind === 'group' ? r + 6 : node.kind === 'person' ? r + 6 : r + 5}
                          fill="transparent"
                          style={{ pointerEvents: 'all' }}
                        />
                        {selectedMemberIds?.has(node.id) && (
                          <circle r={r + 3.5} fill="none" stroke="var(--accent)" strokeOpacity={0.55} strokeWidth={1.2} />
                        )}
                        {node.kind === 'core' ? (
                          <>
                            <circle r={r} fill="url(#legion-core)" stroke={isSelected ? 'var(--hl)' : 'var(--border-hover)'} strokeWidth={isSelected ? 2 : 1} />
                            <text textAnchor="middle" y={-2} className="fill-[var(--fg)] font-semibold" style={{ fontSize: 11 * Math.max(nodeScale, 0.9) }}>{node.label}</text>
                            <text textAnchor="middle" y={13 * Math.max(nodeScale, 0.9)} className="fill-[var(--fg-muted)]" style={{ fontSize: 10 * Math.max(nodeScale, 0.9) }}>
                              {layout.stats.people} 人 · {layout.stats.agents} Agent
                            </text>
                          </>
                        ) : node.kind === 'group' ? (
                          <>

                            {/* 部门外圈软光：和 3D 的编制带一个语言，纯 SVG 圆，
                                导出时由 inline() 解析颜色，不依赖滤镜。 */}
                            <circle r={r + 5} fill="var(--info)" opacity={0.07} />
                            <circle
                              r={r}
                              fill="var(--bg-elevated)"
                              stroke={isSelected ? 'var(--hl)' : 'var(--border-hover)'}
                              strokeWidth={isSelected ? 2 : 1.4}
                              strokeDasharray={node.collapsed ? '3 3' : undefined}
                            />
                            {/* 人数行：大盘（r≥18 的一级部门）直接写进盘里第二行——放在盘外会
                                被旁边的子部门盘盖住（研发 就是这样丢掉行的那一个）；小盘/子部门
                                仍只在悬停、选中或放大后出现在盘下方，右侧面板本来也有总数。 */}
                            {((node.memberCount ?? 0) + (node.agentCount ?? 0)) > 0
                              && (isSelected || hovered === node.id || view.k >= 1.4
                                || (layout.stats.people <= LEGION_LABEL_PEOPLE && insideCount)) && (
                              <text
                                textAnchor="middle"
                                y={insideCount ? r - 7 : r + 13 * labelScale}
                                data-role="dept-count"
                                className="fill-[var(--fg-muted)]"
                                style={{ fontSize: (insideCount ? 7.5 : 8.5) * labelScale }}
                              >
                                {node.memberCount ?? 0}人 · {node.agentCount ?? 0}A
                              </text>
                            )}
                            {/* 生产密度（13 个部门）里每个扇区只有 0.48 rad，按扇区宽度
                                判断名字的话，8 个子部门就是一圈没有名字的白盘。改成「盘装得下
                                就写」：小盘写 2 个字，大盘写 4 个字。 */}
                            {((node.span ?? 0) >= 1.0 || isSelected || hovered === node.id || view.k >= 1.25 || r >= 9) && (
                              <text
                                textAnchor="middle"
                                y={3.5 * labelScale}
                                className="fill-[var(--fg)]"
                                style={{ fontSize: Math.min(10, Math.max(7.5, r * 0.4)) * labelScale }}
                              >
                                {node.label.slice(0, r >= 24 ? 4 : r >= 12 ? 3 : 2)}
                              </text>
                            )}
                            {/* 部门不再画「N 人 · M Agent」：多层部门时这行字会压进圆心
                                （depth1 半径只有 0.30），且右侧面板本来就写着。*/}
                            {/* 折叠角标：虚线圆 + 「+N」把藏起来的人数说清楚，
                                点角标即可原地展开，不用先选中再按空格。 */}
                            {node.collapsed && (
                              <g
                                data-role="collapse-badge"
                                className="cursor-pointer"
                                onClick={(e) => { e.stopPropagation(); toggleCollapse(node.id); }}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); toggleCollapse(node.id); } }}
                                // 角标不进 Tab 序列（否则每个折叠部门再多一个停点）；
                                // 键盘路径是「选中部门 → 空格折叠」，角标保留给鼠标。
                                tabIndex={-1}
                                role="button"
                                aria-label={`展开 ${node.label}（${node.hiddenMembers ?? 0} 人 · ${node.hiddenAgents ?? 0} Agent）`}
                              >
                                <circle cx={r + 2} cy={-(r + 2)} r={9} fill="var(--bg)" stroke="var(--hl)" strokeWidth={1} />
                                <text x={r + 2} y={-(r + 2) + 3} textAnchor="middle" className="fill-[var(--hl)] text-[9px]">
                                  +{(node.hiddenMembers ?? 0) + (node.hiddenAgents ?? 0)}
                                </text>
                              </g>
                            )}
                          </>
                        ) : node.kind === 'person' ? (
                          <>
                            <circle r={r + 4} fill="var(--fg)" opacity={0.05} />
                            <circle r={r} fill="var(--bg)" stroke={isSelected ? 'var(--hl)' : 'var(--fg)'} strokeWidth={isSelected ? 2 : 1} />
                            {(() => {
                              const url = getAvatarUrl(node.sublabel?.replace(/^@/, '') || node.label);
                              if (!url || r < 7) return null;
                              return (
                                <image
                                  href={url}
                                  x={-r}
                                  y={-r}
                                  width={r * 2}
                                  height={r * 2}
                                  preserveAspectRatio="xMidYMid slice"
                                  style={{ clipPath: 'circle(50%)' }}
                                  aria-hidden
                                />
                              );
                            })()}
                            {layout.stats.people <= LEGION_LABEL_PEOPLE && (
                              <text textAnchor="middle" y={3.5 * labelScale} className="fill-[var(--fg)] font-medium" style={{ fontSize: 9 * labelScale }}>
                                {(node.label || '?').slice(0, 1).toUpperCase()}
                              </text>
                            )}
                            {(layout.stats.people <= LEGION_LABEL_PEOPLE || view.k >= 1.15 || isSelected || hovered === node.id) && (
                              <text
                                textAnchor="middle"
                                x={-Math.sin(node.angle) * (r + 22 * labelScale)}
                                y={Math.cos(node.angle) * (r + 22 * labelScale) + 3}
                                className="fill-[var(--fg)] [paint-order:stroke] [stroke:var(--bg-secondary)] [stroke-width:3px]"
                                style={{ fontSize: 10 * labelScale }}
                              >
                                {node.label.length > 8 ? `${node.label.slice(0, 8)}…` : node.label}
                              </text>
                            )}

                          </>
                        ) : (
                          <>
                            <circle r={r + 3} fill="none" stroke="var(--bg-secondary)" strokeWidth={2} />
                            {/* 状态色外圈：离线也保持低亮，不掉成灰点。 */}
                            <circle r={r + 5} fill={statusTone(statusValue)} opacity={statusValue === 'offline' ? 0.08 : 0.16} />
                            <circle r={r} fill={statusTone(statusValue)} stroke={isSelected ? 'var(--hl)' : 'none'} strokeWidth={isSelected ? 2 : 0} />
                            {(view.k >= 1.4 || isSelected) && (
                              <text
                                textAnchor="middle"
                                y={r + 14 * labelScale}
                                className="fill-[var(--fg-muted)]"
                                style={{ fontSize: 9 * labelScale }}
                              >
                                {node.label.length > 10 ? `${node.label.slice(0, 10)}…` : node.label}
                              </text>
                            )}
                          </>
                        )}
                      </g>
                    );
                  })}
                </g>
              </svg>

              <div className={`absolute bottom-3 left-3 flex items-center gap-1 rounded-lg bg-[var(--bg)]/80 p-1 backdrop-blur ${cleanView ? 'hidden' : ''}`}>
                <button type="button" onClick={() => zoomBy(1.2)} aria-label="放大" className="rounded px-2 py-1 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]">＋</button>
                <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="缩小" className="rounded px-2 py-1 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]">－</button>
                <button type="button" onClick={reset} aria-label="重置视图" className="rounded px-2 py-1 text-[10px] text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]">重置</button>
                <span className="px-1 text-[10px] tabular-nums text-[var(--fg-muted)]">{Math.round(view.k * 100)}%</span>
              </div>

              <div className="absolute right-3 top-3 flex flex-wrap items-center gap-2 rounded-lg bg-[var(--bg)]/80 px-2 py-1 text-[10px] text-[var(--fg-muted)] backdrop-blur">
                {/* 和 3D 页、导出图用同一套中文图例（之前这里是 working/idle/offline，
                    同一张图在页面上是英文、导出后是中文）。 */}
                {([
                  ['working', '运行中', 'var(--success)'],
                  ['idle', '空闲', 'var(--info)'],
                  ['offline', '离线 / 未上报', 'var(--fg-dim)'],
                ] as const).map(([key, label, color]) => {
                  const active = statusOnly === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setStatusOnly(active ? null : key)}
                      aria-pressed={active}
                      data-testid={`legion-filter-${key}`}
                      className={`inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors ${active ? 'bg-[var(--accent)]/15 text-[var(--fg)]' : 'hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]'}`}
                    >
                      <i aria-hidden className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                      {label}
                      <span className="tabular-nums text-[var(--fg-dim)]">{statusCounts[key]}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <aside ref={panelRef} tabIndex={-1} data-testid="legion-panel" data-clean={cleanView ? '1' : '0'} role="status" aria-live="polite" className={`rounded-xl bg-[var(--bg-secondary)] p-4 ${cleanView ? 'hidden' : ''} focus:outline-none`}>
              <div className="flex items-baseline justify-between">
                <h2 className="text-xs uppercase tracking-wide text-[var(--fg-muted)]">
                  {selectedNode ? ringLabel(selectedNode) : '编制'}
                </h2>
                {selectedNode && (
                  <button
                    type="button"
                    onClick={() => {
                      // 这个按钮点完就消失；把焦点交给面板，键盘用户不会掉回 body。
                      restoreFocusAfterUnmount(() => panelRef.current);
                      setSelected(null);
                    }}
                    className="text-[10px] text-[var(--fg-muted)] hover:text-[var(--fg)]"
                  >
                    返回全体
                  </button>
                )}
              </div>

              {selectedNode ? (
                <>
                  <div className="mt-2 flex items-start gap-2">
                    <p className="min-w-0 truncate text-sm font-semibold text-[var(--fg)]">{selectedNode.label}</p>
                    <button
                      type="button"
                      onClick={() => {
                        // 和 3D 一致：复制可直接发给别人的地址（?node=），不是光秃秃一个名字。
                        const params = new URLSearchParams(window.location.search);
                        params.set('node', selectedNode.label);
                        const share = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
                        void navigator.clipboard?.writeText(share).then(() => {
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1200);
                        }).catch(() => {});
                      }}
                      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]"
                      aria-label={`复制 ${selectedNode.label} 的分享链接`}
                    >
                      {copied ? '已复制' : '复制链接'}
                    </button>
                  </div>
                  {selectedNode.sublabel && <p className="text-[11px] text-[var(--fg-muted)]">{selectedNode.sublabel}</p>}
                  {selectedNode.kind === 'group' && (
                    <p className="mt-1 text-[11px] text-[var(--fg-muted)]">
                      {selectedNode.leader ? `负责人 ${selectedNode.leader} · ` : '未设负责人 · '}
                      {selectedNode.memberCount} 人（含下级）· 第 {selectedNode.depth} 层
                    </p>
                  )}

                  {selectedNode.kind === 'agent' && (
                    <Link
                      href={`/nodes/${encodeURIComponent(selectedNode.label)}`}
                      className="mt-3 inline-flex w-full items-center justify-center rounded-md bg-[var(--bg-elevated)] px-3 py-1.5 text-xs text-[var(--fg)] hover:bg-[var(--hover-tint)]"
                    >
                      打开会话
                    </Link>
                  )}
                  {selectedNode.kind === 'group' && (
                    <div className="mt-3 space-y-1.5">
                      <button
                        type="button"
                        onClick={() => setFocusGroup(f => (f === selectedNode.id ? null : selectedNode.id))}
                        className="inline-flex w-full items-center justify-center rounded-md bg-[var(--bg-elevated)] px-3 py-1.5 text-xs text-[var(--fg)] hover:bg-[var(--hover-tint)]"
                      >
                        {focusGroup === selectedNode.id ? '取消聚焦' : '只看这个部门'}
                      </button>
                      {canCollapse(selectedNode.id) && (
                        <button
                          type="button"
                          data-testid="legion-toggle-collapse"
                          onClick={() => toggleCollapse(selectedNode.id)}
                          className="inline-flex w-full items-center justify-center rounded-md bg-[var(--bg-elevated)] px-3 py-1.5 text-xs text-[var(--fg)] hover:bg-[var(--hover-tint)]"
                        >
                          {collapsed.has(selectedNode.id)
                            ? `展开下级（${selectedNode.hiddenMembers ?? selectedNode.memberCount} 人 / ${selectedNode.hiddenAgents ?? selectedNode.agentCount} Agent）`
                            : '折叠下级'}
                        </button>
                      )}
                    </div>
                  )}
                  {selectedChildren.length > 0 ? (
                    <ul className="mt-3 space-y-1.5">
                      {selectedChildren.map(child => (
                        <li key={child.id}>
                          <button
                            type="button"
                            onClick={() => setSelected(child.id)}
                            className="flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-xs text-[var(--fg)] hover:bg-[var(--hover-tint)]"
                          >
                            <span className="truncate">{child.label}</span>
                            <span className="ml-2 shrink-0 text-[10px] text-[var(--fg-muted)]">
                              {child.kind === 'agent' ? (statusByAlias.get(child.label) ?? '—') : `${child.agentCount}`}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-3 text-[11px] text-[var(--fg-muted)]">
                      {selectedNode.kind === 'agent'
                        ? `状态：${statusByAlias.get(selectedNode.label) ?? '未知'}`
                        : selectedNode.collapsed
                          ? `已折叠 ${selectedNode.hiddenMembers ?? 0} 人 / ${selectedNode.hiddenAgents ?? 0} Agent。展开后可见下级。`
                          : '没有下级节点。'}
                    </p>
                  )}
                </>
              ) : (
                <dl className="mt-3 space-y-2 text-xs">
                  {[
                    ['部门', layout.stats.groups],
                    ['成员', layout.stats.people],
                    ['Agent', layout.stats.agents],
                    ['无主 Agent', layout.stats.orphans],
                    ...(layout.stats.collapsed > 0 ? [['已折叠部门', layout.stats.collapsed] as [string, number]] : []),
                  ].map(([label, value]) => (
                    <div key={label} className="flex items-center justify-between">
                      <dt className="text-[var(--fg-muted)]">{label}</dt>
                      <dd className="tabular-nums text-[var(--fg)]">{value}</dd>
                    </div>
                  ))}
                  <p className="pt-2 text-[11px] leading-relaxed text-[var(--fg-muted)]">
                    点击任意节点查看它的下级；选中部门后按空格折叠/展开；滚轮缩放，拖拽平移，双击复位；右上角可导出 PNG。
                  </p>
                </dl>
              )}
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
