'use client';

/**
 * 军团 · 3D 网络拓扑（owner 2026-10-26、与神明共同打磨视觉）。
 *
 * 和 `/legion` 同一份数据、同一套布局（legion-layout.ts），区别只在渲染：
 * 2D 是平铺的同心环，这里是把每层环抬到不同高度的「轨道塔」，用透视投影
 * 画在 Canvas 上 —— 斜着看是一叠错开的轨道，转起来有纵深。
 *
 * 三条硬约束（沿用 2D 页）：
 *   1. 坐标全部来自纯函数（legion-layout.ts + legion-3d.ts），组件不自己
 *      算角度/投影；3D 的旋转矩阵、深度排序、命中测试都有单测钉住。
 *   2. 颜色只读 globals.css 的 token（--accent / --success / --warning /
 *      --danger / --fg-*），深色、浅色、薄荷主题各自成立，不新增硬编码色。
 *   3. 空 / 加载 / 401 / 500 各有独立状态，绝不用「军团没人」掩盖故障。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { buildLegionLayout, nearestDept, deptWorldRadius, tourOrder, type LegionNode } from '../../lib/legion-layout';
import { tourStepMs } from '../../lib/legion-tour';
import { restoreFocusAfterUnmount } from '../../lib/focus-fallback';
import { LEGION_HEAVY_NODES, LEGION_HUGE_NODES, LEGION_LABEL_AGENTS, LEGION_LABEL_PEOPLE } from '../../lib/legion-view-constants';
import { legionFetcher, deptFetcher, legionReadError, scopedUrl, type PeopleResponse, type DepartmentsResponse, type StatusResponse } from '../../lib/legion-data';
import { useNetworkId } from '../../lib/network-context';
import { NetworkRequiredNotice } from '../../components/NetworkRequiredNotice';
import { departmentDisc, dropSag, fitProjectedBodies, hitTest, nodeToVec3, projectPoint, projectScene, ringPath, RING_HEIGHT, type SceneNode } from '../../lib/legion-3d';
import { legionLabelLeader, placeLegionLabel, wrapLegionLabel, type LabelEllipse, type LabelRect } from '../../lib/legion-labels';
import { drawLegionCore } from '../../lib/legion-core';
import { EXPORT_FPS, LOOP_DURATION_MS, containRect, exportDimensions, loopProgress, loopYaw, pickRecordingMime, recordingFileName } from '../../lib/legion-recording';
import { EmptyState } from '../../components/EmptyState';
import { getAvatarUrl } from '../../lib/avatars';
import { LegionChat } from '../LegionChat';

// 神明给的参数（PPT 首页 3D 图，admin 已认可）：俯仰约 25–30°、柔和透视
// （别用强广角，远景缩成点就没有军团体量感）、自转 0.02–0.03 rad/s。
// 实现上把「透视强度」和「缩放」拆开：dist 固定大一点 = 透视更平，
// 滚轮改的是 zoom（scale），不再同时改变透视。
// pitch 抬到 0.60：部门分三层之后需要一点俯角才看得见层级之间的落差。
const DEFAULT_VIEW = { yaw: 0.62, pitch: 0.60, dist: 4.9, zoom: 1.12, panX: 0, panY: 0 };
// 缩放范围：之前 0.62–2.4 太窄（自动取景后就剩 1.6× 可用），
// admin 反馈「滚轮能滚动的幅度太少」。放到 0.25–8，并让每格滚轮快一点。
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
// 聚焦部门时的取景保底倍率：低于它就看不出「只看这个部门」的实感。
const FOCUS_ZOOM = 1.35;
// 镜头转向的固定时长：巡礼切层/跳转都在这个时间内停稳，可被测。
const YAW_ANIM_MS = 480;
// 越往下的层级，镜头推得越近：顶层部门先看全貌，子部门再凑近看细节。
// 巡礼因此有了「由外向内」的层次感，而不是每一步都同倍率。
const FOCUS_ZOOM_BY_DEPTH = (depth: number) => Math.min(2, FOCUS_ZOOM + 0.35 * (Math.max(1, depth) - 1));
const SPIN_RAD_PER_SEC = 0.027;
const IDLE_BEFORE_SPIN = 3000;

const KIND_LABEL: Record<LegionNode['kind'], string> = {
  core: '网络',
  group: '部门',
  person: '成员',
  agent: 'Agent',
};

/** 世界坐标里的节点半径（屏幕半径 = 世界半径 × 透视缩放）。 */
const WORLD_R: Record<LegionNode['kind'], number> = {
  core: 0.085,
  group: 0.052,
  person: 0.033,
  agent: 0.021,
};

function nodeBody({ item, projected: p }: SceneNode<LegionNode>, people: number) {
  const crowd = item.kind === 'person' && people > LEGION_LABEL_PEOPLE ? 0.78 : 1;
  const worldR = item.kind === 'group' ? deptWorldRadius(item.depth ?? 1) : WORLD_R[item.kind];
  const radius = Math.max(1.4, worldR * p.scale * crowd);
  return { radius, ...(item.kind === 'group' ? departmentDisc(radius) : { rx: radius, ry: radius }) };
}

function readTokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: v('--bg', '#0b0b0d'),
    fg: v('--fg', '#e5e7eb'),
    muted: v('--fg-muted', '#9ca3af'),
    dim: v('--fg-dim', '#6b7280'),
    border: v('--border', '#26262b'),
    surface: v('--bg-secondary', '#161618'),
    accent: v('--accent', '#8b5cf6'),
    accentFg: v('--accent-fg', '#ffffff'),
    success: v('--success', '#10b981'),
    warning: v('--warning', '#f59e0b'),
    danger: v('--danger', '#ef4444'),
    info: v('--info', '#3b82f6'),
  };
}

type Tokens = ReturnType<typeof readTokens>;

/** 底色是不是深色。浅底上「辉光」会变成一圈脏灰，必须换画法：
 *  深底靠 shadowBlur 发光，浅底靠实心 + 描边。 */
function isDarkBg(hex: string): boolean {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return true;
  const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

/** token 颜色 → 带 alpha 的 rgba（Canvas 渐变要 alpha 停靠点）。
 *  token 目前都是 #rrggbb；万一主题换成 rgb()/oklch，退回一个中性紫，
 *  不让一个颜色格式把整张图搞成透明。 */
function hexToRgba(color: string, alpha: number): string {
  const hex = color.trim();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (m) {
    const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(hex);
  if (rgb) {
    const [r, g, b] = rgb[1].split(',').map(v => parseFloat(v));
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return `rgba(139,92,246,${alpha})`;
}

function statusColor(status: string | undefined, tk: Tokens): string {
  if (status === 'working') return tk.success;
  if (status === 'blocked') return tk.warning;
  if (status === 'error') return tk.danger;
  // 神明：深底上灰色会「消失」，离线/空闲不要换成灰，改用主色降透明度。
  if (status === 'idle') return tk.fg;
  return tk.fg;
}

function nodeColor(node: LegionNode, tk: Tokens, statusByAlias: Map<string, string>): string {
  if (node.kind === 'core') return tk.accent;
  if (node.kind === 'group') return tk.info;
  // 神明 2026-10-27：层次只靠明度 —— 人环 --fg，Agent 环 --fg-muted，
  // 不新增颜色。有状态的 Agent 仍然按成功/阻塞/错误上色。
  if (node.kind === 'agent') {
    const st = statusByAlias.get(node.label);
    if (!st || st === 'idle') return tk.muted;
    return statusColor(st, tk);
  }
  // 成员：有任意 Agent 在跑就跟着亮；否则用正文色（比 Agent 环亮一档）。
  const working = node.agentCount > 0 && statusByAlias.get(node.label) === 'working';
  return working ? tk.success : tk.fg;
}

/** 光晕精灵缓存：一个颜色一张 128×128 的径向渐变贴图，按需缩放。
 *  逐帧 shadowBlur 在软件光栅下开销极大（headless 实测 30fps），
 *  预先画好再 drawImage 是同类效果里最便宜的做法。 */
/** 头像图片缓存：同一个 URL 只 new 一次 Image，加载完由渲染循环自动画出来
 *  （循环每帧都在跑，不需要额外的 re-render）。 */
const AVATAR_IMAGES = new Map<string, HTMLImageElement>();
function avatarImage(url: string): HTMLImageElement | null {
  if (!url) return null;
  let img = AVATAR_IMAGES.get(url);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.src = url;
    AVATAR_IMAGES.set(url, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

const HALO_CACHE = new Map<string, HTMLCanvasElement>();
function haloFor(color: string): HTMLCanvasElement {
  const hit = HALO_CACHE.get(color);
  if (hit) return hit;
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const g = cv.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0, hexToRgba(color, 0.55));
    grad.addColorStop(0.45, hexToRgba(color, 0.22));
    grad.addColorStop(1, hexToRgba(color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
  }
  HALO_CACHE.set(color, cv);
  return cv;
}

/** 深空微尘：相位只跟 yaw 走，录屏绕一圈回到原点时微尘也回到原位，
 *  所以无缝循环不会被它破坏；减少动态效果时相位固定为 0。 */
function makeDust(count: number) {
  let seed = 20261031;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  return Array.from({ length: count }, () => ({
    x: rand(),
    y: rand(),
    r: 0.5 + rand() * 0.8,
    a: 0.04 + rand() * 0.12,
    par: 1 + Math.floor(rand() * 3), // 整数圈数，yaw+2π 时回到原位
    amp: 6 + rand() * 20,
    phase: rand() * Math.PI * 2,
    tint: rand() < 0.22 ? 'accent' : 'fg',
  }));
}

const DUST = typeof window === 'undefined' ? [] : makeDust(64);



/** 确定性星空（同一块画布每次刷新星位一致，不会「闪」成噪点）。 */
function makeStars(count: number) {
  let seed = 20261026;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  return Array.from({ length: count }, () => ({
    x: rand(),
    y: rand(),
    r: 0.4 + rand() * 1.1,
    a: 0.08 + rand() * 0.32,
    speed: 0.3 + rand() * 1.4,
  }));
}

export default function Legion3DPage() {
  // #1636-P1 —— 当前选中网络拼进 SWR key（切网即换 key，避免串网）。
  const { networkId, ready: networkReady } = useNetworkId();
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(null);
  const [chatAlias, setChatAlias] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // 大网络提示条：一次会话里关掉就不再弹（sessionStorage）。
  const [hintDismissed, setHintDismissed] = useState(false);
  // 键盘/读屏入口：canvas 本身没法被 Tab 遍历，给一个可滚动的节点列表。
  const [listOpen, setListOpen] = useState(false);
  // 缩放倍率是给用户看的数字：view.zoom 在 ref 里（每帧读），单独镜像一份 state。
  const [zoomPct, setZoomPct] = useState(Math.round(DEFAULT_VIEW.zoom * 100));
  // 全屏演示：给会议室/PPT 用 —— 把整张拓扑铺满屏幕，只剩画布与图例。
  const [isFullscreen, setIsFullscreen] = useState(false);
  // 净屏：把标题/按钮/图例/提示全隐掉，只留拓扑 —— 截屏、做 PPT 用。
  const [cleanView, setCleanView] = useState(false);
  // 图例即筛选：点「运行中」只看在跑的 Agent，再看部门/人环做背景。
  const [statusOnly, setStatusOnly] = useState<'working' | 'idle' | 'blocked' | 'error' | 'offline' | null>(null);
  const [copied, setCopied] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const helpRef = useRef<HTMLDivElement | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const toolsToggleRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [spin, setSpin] = useState(true);
  const [flow, setFlow] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  // 演示/录屏模式：隐藏鼠标与悬浮提示、匀速环绕，并可直接导出 16 秒循环。
  const [presenting, setPresenting] = useState(false);
  // 演示前自检：后台标签页/减动效/窗口过小都会让录屏白拍，进入演示时就地说明。
  const [presentChecks, setPresentChecks] = useState<string[] | null>(null);
  const runPresentChecks = useCallback(() => {
    const issues: string[] = [];
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      issues.push('标签页在后台，录到的会是静止帧');
    }
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      issues.push('系统开启「减少动态效果」，巡礼不会自动推进');
    }
    if (typeof window !== 'undefined' && (window.innerWidth < 1280 || window.innerHeight < 720)) {
      issues.push('窗口小于 1280×720，导出会缩放');
    }
    setPresentChecks(issues);
  }, []);
  // 与 2D 对齐：大网络里列表很长，可只看部门与圆心。
  const [listDeptsOnly, setListDeptsOnly] = useState(false);
  // 与 2D 共用同一个本地偏好：切视图后不用重新勾一次。
  useEffect(() => {
    setListDeptsOnly(window.localStorage.getItem('legion-list-depts-only') === '1');
  }, []);
  const toggleDeptsOnly = (next: boolean) => {
    setListDeptsOnly(next);
    window.localStorage.setItem('legion-list-depts-only', next ? '1' : '0');
  };
  const [tour, setTour] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [captureProgress, setCaptureProgress] = useState(0);
  const [captureError, setCaptureError] = useState('');
  const [captureInfo, setCaptureInfo] = useState('');
  const [size, setSize] = useState({ width: 0, height: 0 });
  // 舞台高度按「窗口底 − 舞台顶 − 父级底部安全区」算：顶部有 HealthBanner、
  // 手机底部有 5rem 安全区，写死 100vh 一定会多出一条滚动条。
  const [stageHeight, setStageHeight] = useState<number | null>(null);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);
  const fitBoundsRef = useRef<LabelRect | null>(null);
  const labelUiRectsRef = useRef<LabelRect[]>([]);
  const corePhaseRef = useRef(0);
  const flowTimeRef = useRef(0);
  const flowRef = useRef(true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef({ ...DEFAULT_VIEW });
  const spinRef = useRef(true);
  const selectedRef = useRef<string | null>(null);
  const lastInteract = useRef(0);
  const yawTarget = useRef<number | null>(null);
  // 部门切换的「抬升-落位」：大角度转场时镜头在中段略微拉远再落回，
  // 不再从画面中心一眼糊过去。纯装饰，减少动态效果下不跑（peak 恒为 0）。
  const camArcRef = useRef<{ t0: number; peak: number }>({ t0: 0, peak: 0 });
  const presentingRef = useRef(false);
  const [shareInfo, setShareInfo] = useState('');
  const [exportHigh, setExportHigh] = useState(false);
  const sharedView = useRef<{ yaw: number; pitch: number; zoom: number } | null>(null);
  // 分享视角生效后先锁住自动取景：尺寸观察器晚一帧回调时也会触发 fit，
  // 不锁就会把链接里的角度立刻覆盖掉。"重置视角"会解锁。
  const sharedLock = useRef(false);
  const tourRef = useRef(false);
  const tourAt = useRef(0);
  // 演示/录屏的镜头呼吸相位（只在 0–1 之间循环，录屏首尾自然对齐）。
  const breathRef = useRef(0);
  const tourIndex = useRef(-1);
  // 巡礼可以暂停：讲解时不会被动跟着镜头跑。
  const tourPausedRef = useRef(false);
  const [tourPaused, setTourPaused] = useState(false);
  // 演示时控制条 4 秒不动就淡出：投屏/讲解画面更干净；动鼠标或按键立刻恢复。
  // 只淡出、不移除，也不改 pointer-events —— 套件里有大量点击演示控件的用例。
  const [chromeIdle, setChromeIdle] = useState(false);
  // 进度条（第 N/M 步 + 本步剩余比例）。每帧 setState 会把画布拖垮，
  // 所以节流到 ~4Hz。
  const [tourProgress, setTourProgress] = useState<{ index: number; total: number; frac: number } | null>(null);
  const tourProgressAt = useRef(0);
  const captureRef = useRef<null | {
    startedAt: number; startYaw: number; durationMs: number; mime: string; width: number; height: number;
    out: HTMLCanvasElement; octx: CanvasRenderingContext2D;
    recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; finished: boolean; cancelled: boolean; timer: number | null; safety: number | null;
  }>(null);
  // 交互中（拖动/缩放）先降特效，停手 180ms 后恢复 —— 大网络里保证跟手。
  const interactingUntil = useRef(0);
  // 首屏 / 重置视角后自动取景（见渲染循环里的 fitPending 分支）。
  const fitPending = useRef(true);
  const lastFitSize = useRef<{ w: number; h: number } | null>(null);
  // 用户自己缩放过就尊重他的视角；只有「还没动过」时，尺寸变化（首帧
  // 布局落定、窗口缩放）才重新取景。
  const userAdjusted = useRef(false);
  // 首次进入的「镜头推近」：从 0.62× 缓动到取景比例，约 0.9 秒。
  // 只在第一次打开时跑一次（sessionStorage 记住），并尊重 prefers-reduced-motion。
  const introRef = useRef<{ t0: number; from: number; to: number } | null>(null);
  const yawAnimRef = useRef<{ t0: number; from: number; to: number } | null>(null);
  const introDone = useRef(false);
  const dragRef = useRef<{ x: number; y: number; yaw: number; pitch: number; moved: number } | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ span: number; dist: number } | null>(null);
  const screenRef = useRef<Array<SceneNode<LegionNode>>>([]);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const hoverRef = useRef<string | null>(null);
  // 呼吸相位：-1 = 当前没有聚焦/选中的部门（不呼吸），0..1 = 绘制实际使用的相位。
  const breathePhaseRef = useRef(-1);
  const lastViewExpose = useRef(0);
  // 节点实体在屏幕上的包围盒（含描边/呼吸余量）。窄屏取景到底有没有把图装进去，
  // 不能靠看截图判断——把实测数字写到画布上，断言才有依据。
  const lastFitExpose = useRef(0);
  // 聚焦部门时请求一次重新取景：镜头会重新框住画面，并保底 1.35×，
  // 让「只看这个部门」在画面上也有换视角的实感。走的是既有取景逻辑，
  // 不另起一套动画——之前那版独立缓动就是被取景覆盖掉的（实测停在 86%）。
  const focusZoomRef = useRef(0);
  // 层级预览：鼠标停在某部门（或键盘停在列表某行）时，其它层压暗、同层保持，
  // 并在画面上标明「第 N 层 · 同层 M 个部门」。渲染读 ref，DOM 角标读 state。
  const depthPreviewRef = useRef<number | null>(null);
  const [depthPreview, setDepthPreview] = useState<number | null>(null);
  const applyDepthPreview = useCallback((depth: number | null) => {
    if (depthPreviewRef.current === depth) return;
    depthPreviewRef.current = depth;
    setDepthPreview(depth);
  }, []);
  // 悬停提示需要指针位置（canvas 坐标），只存在 ref 里，避免每帧 setState。
  const hoverPos = useRef<{ x: number; y: number } | null>(null);
  const starsRef = useRef(makeStars(160));
  // 点部门：镜头转到它正面（沿用 yawTarget 的缓动），并在落点闪一圈，
  // 让人知道「我飞到这里了」。闪圈用 HTML 覆盖层，不写进画布的每帧绘制。
  const [flyFlash, setFlyFlash] = useState<{ x: number; y: number; r: number; label: string } | null>(null);
  const flyTimer = useRef<number | null>(null);

  // 换数据 key 不会重置本地状态；旧节点 id 会让新网络所有节点落进淡出分支。
  // 只在网络身份改变时清理，同网络轮询/重新验证保留当前选择。
  const [viewNetworkId, setViewNetworkId] = useState(networkId);
  if (viewNetworkId !== networkId) {
    setViewNetworkId(networkId);
    setSelected(null);
    setChatAlias(null);
    setFocus(null);
    setZoomPct(Math.round(DEFAULT_VIEW.zoom * 100));
  }
  // 分享链接：`?view=yaw,pitch,zoom` 在首帧前写进 ref，等网络就绪后再应用，
  // 免得被“换网络重置视角”覆盖。非法数值直接忽略，不报错也不假装生效。
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get('view');
    if (!raw) return;
    const [yaw, pitch, zoom] = raw.split(',').map(Number);
    if (![yaw, pitch, zoom].every(Number.isFinite)) return;
    sharedView.current = {
      yaw,
      pitch: Math.min(1.1, Math.max(-1.1, pitch)),
      zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)),
    };
  }, []);

  useEffect(() => {
    hoverRef.current = null;
    hoverPos.current = null;
    yawTarget.current = null;
    yawAnimRef.current = null;
    introRef.current = null;
    viewRef.current = { ...DEFAULT_VIEW };
    fitPending.current = true;
    userAdjusted.current = false;
    lastFitSize.current = null;
    const shared = sharedView.current;
    if (shared) {
      viewRef.current = { ...DEFAULT_VIEW, ...shared };
      setZoomPct(Math.round(shared.zoom * 100));
      userAdjusted.current = true;
      introDone.current = true;
      introRef.current = null;
      fitPending.current = false;
      sharedLock.current = true;
      return;
    }
    // 没有分享链接时，恢复本机记住的视角（只认有限数值）。
    let saved: { yaw?: number; pitch?: number; zoom?: number } | null = null;
    try { saved = JSON.parse(localStorage.getItem(`legion3d-view:${networkId}`) || 'null'); } catch { saved = null; }
    if (saved && [saved.yaw, saved.pitch, saved.zoom].every(value => typeof value === 'number' && Number.isFinite(value))) {
      viewRef.current = {
        ...DEFAULT_VIEW,
        yaw: saved.yaw as number,
        pitch: Math.min(1.1, Math.max(-1.1, saved.pitch as number)),
        zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, saved.zoom as number)),
      };
      setZoomPct(Math.round(viewRef.current.zoom * 100));
      sharedLock.current = true;
    }
  }, [networkId]);

  const people = useSWR<PeopleResponse>(networkReady && networkId ? scopedUrl('/api/hub/people?limit=200&offset=0', networkId) : null, legionFetcher, {
    refreshInterval: 30000,
    shouldRetryOnError: false,
  });
  const hierarchy = useSWR<DepartmentsResponse | null>(networkReady && networkId ? scopedUrl('/api/hub/departments', networkId) : null, deptFetcher, {
    refreshInterval: 60000,
    shouldRetryOnError: false,
  });
  const status = useSWR<StatusResponse>(networkReady && networkId ? scopedUrl('/api/hub/status', networkId) : null, legionFetcher, {
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
    }),
    [peopleList, orphans, hierarchy.data],
  );

  // 只在「结构变了」（人数/部门数/节点数）时重新取景；30s 轮询刷新同一批人
  // 不能把用户拖好的视角弹回去。
  const layoutSig = `${layout.nodes.length}:${layout.rings.length}:${layout.stats.people}`;
  useEffect(() => { fitPending.current = true; }, [layoutSig]);

  // /legion/3d?focus=<部门名>：和 2D、/org 的深链口径一致（按部门名匹配，
  // 不用 id —— id 是布局内部生成的，换一次数据就变了，链接会失效）。
  // 注意：URL 里的 focus 没应用完之前，不要往回写 URL —— StrictMode 会重跑
  // effect，一次性 guard 拦不住，会把 ?focus= 抹掉（踩过）。
  // ?present=1：直接进演示模式（PPT/录屏可以只放一条链接，不必现场点按钮）。
  // 只读一次 URL，不在退出后回写——用户按 Esc 退出就该退出。
  const presentDeeplinkSettled = useRef(false);
  const [tourPending, setTourPending] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || presentDeeplinkSettled.current) return;
    presentDeeplinkSettled.current = true;
    const params = new URLSearchParams(window.location.search);
    if (params.get('present') !== '1') return;
    presentingRef.current = true;
    setPresenting(true);
    runPresentChecks();
    // ?tour=1 连巡礼一起开：录屏只放一条链接就能直接开始讲。
    // 减少动态效果时不自动开（与按钮的 aria-disabled 一致，避免「链接能开、按钮不能」的矛盾）。
    // 直接读系统偏好：reducedMotion 是 state，首帧还是默认 false，
    // 用它判断会让「减动效下链接也自动开巡礼」，与按钮的 disabled 自相矛盾。
    const prefersReduce = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (params.get('tour') === '1' && !prefersReduce) setTourPending(true);
  }, [runPresentChecks]);

  // 巡礼深链要等布局真的有部门（首帧只有圆心），所以单独等一次。
  useEffect(() => {
    if (!tourPending) return;
    const depts = tourOrder(layout.nodes);
    if (!depts.length) return;
    setTourPending(false);
    setTour(true);
    tourIndex.current = 0;
    setFocus(depts[0].id);
    yawTarget.current = depts[0].angle;
  }, [tourPending, layout.nodes]);

  const urlFocusSettled = useRef(false);
  // 深链指向的部门不存在时给明确提示（与 2D 同口径），而不是静默给一张没聚焦的图。
  const [focusMissing, setFocusMissing] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined' || urlFocusSettled.current) return;
    const want = new URLSearchParams(window.location.search).get('focus');
    if (!want) { urlFocusSettled.current = true; return; }
    const node = layout.nodes.find(n => n.kind === 'group' && n.label === want);
    // 首帧布局里只有 core（nodes.length 1），不能据此判定「部门不存在」，
    // 否则一上来就把 ?focus= 判死、参数被清掉。
    const loaded = layout.stats.people + layout.stats.agents > 0;
    if (!node) {
      if (loaded) { urlFocusSettled.current = true; setFocusMissing(want); }
      return;
    }
    urlFocusSettled.current = true;
    setFocus(node.id);
    setSelected(node.id);
    let delta = node.angle - viewRef.current.yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    yawTarget.current = viewRef.current.yaw + delta;
  }, [layout.nodes]);

  // /legion/3d?node=<名字>：从节点页/通知点进来时直接选中那个 Agent 或成员，
  // 并把镜头转到它所在的扇区。名字口径与节点页一致（Agent 用 alias）。
  const urlNodeSettled = useRef(false);
  useEffect(() => {
    if (typeof window === 'undefined' || urlNodeSettled.current) return;
    const want = new URLSearchParams(window.location.search).get('node');
    if (!want) { urlNodeSettled.current = true; return; }
    const node = layout.nodes.find(n => n.label === want && n.kind !== 'group');
    const loaded = layout.stats.people + layout.stats.agents > 0;
    if (!node) {
      // 数据到位还找不到 → 节点没了/拼错了，别把死参数一直挂在地址上。
      if (loaded) urlNodeSettled.current = true;
      return;
    }
    urlNodeSettled.current = true;
    setSelected(node.id);
    setFocus(null);
    let delta = node.angle - viewRef.current.yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    yawTarget.current = viewRef.current.yaw + delta;
  }, [layout.nodes]);

  // 选中节点写回 URL（?node=），这样「这个 Agent 在军团里」的地址也能直接发人。
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

  // 聚焦状态写回 URL，复制地址就能把同一个部门视角发给别人。
  useEffect(() => {
    if (typeof window === 'undefined' || !urlFocusSettled.current) return;
    const params = new URLSearchParams(window.location.search);
    const label = focus ? layout.nodes.find(n => n.id === focus)?.label : null;
    if (label) params.set('focus', label);
    else params.delete('focus');
    const qs = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  }, [focus, layout.nodes]);

  const statusByAlias = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of status.data?.sessions ?? []) map.set(s.alias, s.status);
    return map;
  }, [status.data]);

  // 图例带数量：一眼知道「现在有几个在跑」，不用逐个看。
  const statusCounts = useMemo(() => {
    const counts = { working: 0, idle: 0, blocked: 0, error: 0, offline: 0 };
    for (const n of layout.nodes) {
      if (n.kind !== 'agent') continue;
      const st = statusByAlias.get(n.label);
      if (!st) counts.offline += 1;
      else if (st === 'working' || st === 'blocked' || st === 'error') counts[st] += 1;
      else counts.idle += 1;
    }
    return counts;
  }, [layout.nodes, statusByAlias]);

  const selectedNode = useMemo(
    () => (selected ? layout.nodes.find(n => n.id === selected) ?? null : null),
    [layout.nodes, selected],
  );

  /** 选中节点的「血脉」：向上到圆心、向下到子孙，与 2D 页高亮口径一致。 */
  const related = useMemo(() => {
    if (!selected) return null;
    const children = new Map<string, string[]>();
    const parent = new Map<string, string>();
    for (const e of layout.edges) {
      const arr = children.get(e.from) ?? [];
      arr.push(e.to);
      children.set(e.from, arr);
      parent.set(e.to, e.from);
    }
    const set = new Set<string>([selected]);
    for (let cur = parent.get(selected); cur && !set.has(cur); cur = parent.get(cur)) set.add(cur);
    const stack = [selected];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const child of children.get(cur) ?? []) {
        if (!set.has(child)) { set.add(child); stack.push(child); }
      }
    }
    return set;
  }, [layout.edges, selected]);

  /** 部门聚焦：只保留该部门子树（含自身），其余淡出。2D 页同款语义。 */
  const focusSet = useMemo(() => {
    if (!focus) return null;
    const children = new Map<string, string[]>();
    for (const e of layout.edges) {
      const arr = children.get(e.from) ?? [];
      arr.push(e.to);
      children.set(e.from, arr);
    }
    const set = new Set<string>([focus]);
    const stack = [focus];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const child of children.get(cur) ?? []) {
        if (!set.has(child)) { set.add(child); stack.push(child); }
      }
    }
    return set;
  }, [focus, layout.edges]);

  /** 搜索命中：先按名字/子标题命中，再把命中节点的子孙一起点亮 ——
   *  搜「平台」只亮一个部门点没有意义，要看见这个部门的人和 Agent。 */
  const matchedSet = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const hit = new Set<string>();
    for (const node of layout.nodes) {
      if (`${node.label} ${node.sublabel ?? ''}`.toLowerCase().includes(q)) hit.add(node.id);
    }
    if (hit.size === 0) return hit;
    const children = new Map<string, string[]>();
    for (const e of layout.edges) {
      const arr = children.get(e.from) ?? [];
      arr.push(e.to);
      children.set(e.from, arr);
    }
    const stack = [...hit];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const child of children.get(cur) ?? []) {
        if (!hit.has(child)) { hit.add(child); stack.push(child); }
      }
    }
    return hit;
  }, [query, layout.edges, layout.nodes]);

  // 搜索优先于聚焦/选中：正在找东西时，别让其它高亮盖掉命中结果。
  const activeSet = matchedSet ?? related ?? focusSet;
  // 选中部门时，画布会把它名下的成员/Agent 各描一圈淡环；这里把人数同步成
  // 一个属性，探针才能证明「这条路径真的走到了」，而不是只靠肉眼看截图。
  const memberHaloCount = useMemo(() => {
    const sel = layout.nodes.find(n => n.id === selected);
    if (!sel || sel.kind !== 'group' || !related) return 0;
    return layout.nodes.filter(n => (n.kind === 'person' || n.kind === 'agent') && related.has(n.id)).length;
  }, [layout.nodes, selected, related]);
  // 只做部门聚焦（没有选中/搜索）时，把其余部门扇区再压低一档。
  const focusingDept = !!focusSet && !related && !matchedSet;
  const noMatch = matchedSet !== null && matchedSet.size === 0;

  const ringRadii = useMemo(() => layout.rings.map(r => ({ ring: r.ring, radius: r.radius })), [layout.rings]);

  useEffect(() => {
    try {
      if (sessionStorage.getItem('legion3d-hint-dismissed') === '1') setHintDismissed(true);
    } catch { /* 隐私模式下读不到就每次都提示，无害 */ }
  }, []);

  useEffect(() => { spinRef.current = spin; }, [spin]);
  // 注意：不要用 effect 让 ref 跟随 state。深链那一帧 render 里 presenting 还是 false，
  // 这个 effect 会把「刚在深链里设成 true 的 ref」覆盖回 false，直到下一次 render 才恢复。
  // 那一个窗口里按 Esc 会被忽略（.295 实测偶发失败）。ref 只在真正改动演示状态处显式写。
  // 演示是「整屏」的事：侧栏/手机导航在应用壳里，读不到这个页面的状态，
  // 所以用一个 html 级标记让它们一起淡出；退出或卸载时清掉。
  useEffect(() => {
    const root = document.documentElement;
    if (presenting) root.setAttribute('data-legion-present', '1');
    else root.removeAttribute('data-legion-present');
    return () => { root.removeAttribute('data-legion-present'); };
  }, [presenting]);
  useEffect(() => { tourRef.current = tour; }, [tour]);

  // 演示态下 4 秒无鼠标/键盘动作就把控制条淡出；任何输入立即恢复。
  useEffect(() => {
    if (!presenting) { setChromeIdle(false); return; }
    let timer = 0;
    const wake = () => {
      setChromeIdle(false);
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => setChromeIdle(true), 4000);
    };
    wake();
    window.addEventListener('mousemove', wake);
    window.addEventListener('keydown', wake);
    window.addEventListener('touchstart', wake);
    return () => {
      if (timer) window.clearTimeout(timer);
      window.removeEventListener('mousemove', wake);
      window.removeEventListener('keydown', wake);
      window.removeEventListener('touchstart', wake);
    };
  }, [presenting]);
  useEffect(() => {
    try { setExportHigh(localStorage.getItem('legion3d-export-1080') === '1'); } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem('legion3d-export-1080', exportHigh ? '1' : '0'); } catch { /* ignore */ }
  }, [exportHigh]);
  // 退出演示就结束巡礼，别让下一次进入从一半开始。
  useEffect(() => {
    if (presenting) return;
    setTour(false);
    tourIndex.current = -1;
    tourAt.current = 0;
    tourPausedRef.current = false;
    setTourPaused(false);
    setTourProgress(null);
  }, [presenting]);
  useEffect(() => { flowRef.current = flow; }, [flow]);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(preference.matches);
    update();
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  useEffect(() => {
    if (!toolsOpen) return;
    const onOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !toolbarRef.current?.contains(event.target)) setToolsOpen(false);
    };
    document.addEventListener('pointerdown', onOutside);
    return () => document.removeEventListener('pointerdown', onOutside);
  }, [toolsOpen]);

  useEffect(() => {
    const wide = window.matchMedia('(min-width: 640px)');
    const onBreakpoint = () => {
      const active = document.activeElement;
      if (wide.matches && active === toolsToggleRef.current) {
        toolbarRef.current?.querySelector<HTMLButtonElement>('[data-testid="legion-3d-spin"]')?.focus();
      } else if (!wide.matches && active?.closest('#legion-3d-more-tools')) {
        toolsToggleRef.current?.focus();
      }
      setToolsOpen(false);
    };
    wide.addEventListener('change', onBreakpoint);
    return () => wide.removeEventListener('change', onBreakpoint);
  }, []);

  useEffect(() => {
    if (!helpOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const stage = wrapRef.current;
    helpRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      if (previous?.isConnected && previous.getClientRects().length) previous.focus();
      else stage?.focus();
    };
  }, [helpOpen]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const fit = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      const padB = parseFloat(getComputedStyle(el.parentElement ?? document.body).paddingBottom) || 0;
      setStageHeight(Math.max(480, Math.round(window.innerHeight - top - padB)));
    };
    // 首帧时 HealthBanner / 侧栏可能还没定高，直接读 top 会读到 0；
    // 放到下一帧再量，并补一次 300ms 后的校正（字体/横幅落位）。
    const raf = requestAnimationFrame(fit);
    const t = setTimeout(fit, 300);
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', fit);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
      window.removeEventListener('resize', fit);
      window.removeEventListener('orientationchange', fit);
    };
  }, []);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      setSize({ width: Math.max(1, Math.round(box.width)), height: Math.max(1, Math.round(box.height)) });
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const header = headerRef.current;
    const wrap = wrapRef.current;
    if (!header || !wrap) return;
    const measure = () => {
      const stage = wrap.getBoundingClientRect();
      const rect = (el: HTMLElement) => {
        const box = el.getBoundingClientRect();
        return { x1: box.left - stage.left - 4, y1: box.top - stage.top - 4,
          x2: box.right - stage.left + 4, y2: box.bottom - stage.top + 4 };
      };
      const top = rect(header);
      wrap.style.setProperty('--legion-list-top', `${top.y2 + 8}px`);
      const footer = footerRef.current;
      const bottom = footer && footer.offsetHeight > 0 ? rect(footer) : null;
      labelUiRectsRef.current = cleanView ? [] : [top, ...(bottom ? [bottom] : [])];
      const previous = fitBoundsRef.current;
      const bounds = {
        x1: 24, x2: stage.width - 24,
        y1: cleanView ? 24 : top.y2 + 16,
        y2: cleanView ? stage.height - 24 : (bottom?.y1 ?? stage.height - 24) - 24,
      };
      fitBoundsRef.current = bounds;
      // Restoring controls can shrink the safe area without resizing the canvas.
      // Expanding it alone must not move a manually positioned camera.
      if (previous && !userAdjusted.current && (
        bounds.x1 > previous.x1 + 1 || bounds.y1 > previous.y1 + 1
        || bounds.x2 < previous.x2 - 1 || bounds.y2 < previous.y2 - 1
        || previous.x2 <= previous.x1 || previous.y2 <= previous.y1
      )) fitPending.current = true;
    };
    // Responsive controls are measured on resize, never during Canvas frames.
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    if (footerRef.current) observer.observe(footerRef.current);
    observer.observe(wrap);
    measure();
    return () => observer.disconnect();
  }, [cleanView]);

  /* ── 渲染循环 ───────────────────────────────────────────────────── */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width < 2 || size.height < 2) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // 交互期间的背板缩放：低 DPI 屏降太多会明显糊，按 dpr 分档
    const RES_LOW = dpr >= 2 ? 0.6 : 0.75;
    let resScale = 0; // 0 = 还没设过背板尺寸，保证首次 applyResolution(1) 真的执行
    const applyResolution = (scale: number) => {
      if (scale === resScale) return;
      resScale = scale;
      canvas.width = Math.round(size.width * dpr * scale);
      canvas.height = Math.round(size.height * dpr * scale);
    };
    applyResolution(1);
    const tkLive = readTokens();
    // 演示模式用「深场」配色：整块画布（底色/文字/连线）切到深底浅字，
    // 与真实深色主题同一套对比关系，所以不是临时凑的颜色——浅色皮肤下
    // 演示时也不会出现「深底上写着深字」。
    const presentingInk = {
      ...tkLive,
      bg: '#070b12',
      surface: '#0d1420',
      fg: '#e9eef5',
      muted: '#a8b3c1',
      dim: '#7f8b99',
      border: '#2a3140',
    };
    // 每帧按「是否在演示」挑一份 token：进入/退出演示是运行时状态，
    // 只在 effect 里选一次的话，切换后画布不会跟着换配色（踩过）。
    let tk = presentingRef.current ? presentingInk : tkLive;
    let dark = isDarkBg(tk.bg);
    let raf = 0;
    let stopped = false;
    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const labelMetrics = new Map<string, { lines: string[]; width: number; height: number; lineHeight: number }>();
    let lastFrame = performance.now();

    let frame = 0;
    let bgLayer: HTMLCanvasElement | null = null;
    let bgKey = '';
    const buildBackdrop = () => {
      const cv = document.createElement('canvas');
      cv.width = Math.round(size.width * dpr);
      cv.height = Math.round(size.height * dpr);
      const g2 = cv.getContext('2d');
      if (!g2) return null;
      g2.setTransform(dpr, 0, 0, dpr, 0, 0);
      g2.fillStyle = tk.bg;
      g2.fillRect(0, 0, size.width, size.height);
      const grad = g2.createRadialGradient(
        size.width / 2, size.height * 0.5, 0,
        size.width / 2, size.height * 0.5, Math.max(size.width, size.height) * 0.7,
      );
      // 浅底上大面积的 accent 晕染会把整张图洗成一片绿；白天只留很薄一层，
      // 深底保持原来的呼吸感。
      const present = presentingRef.current;
      grad.addColorStop(0, hexToRgba(tk.accent, present ? 0.16 : dark ? 0.11 : 0.032));
      grad.addColorStop(0.55, hexToRgba(tk.accent, present ? 0.055 : dark ? 0.035 : 0.012));
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g2.fillStyle = grad;
      g2.fillRect(0, 0, size.width, size.height);
      g2.fillStyle = tk.fg;
      for (const st of starsRef.current) {
        g2.globalAlpha = st.a;
        g2.beginPath();
        g2.arc(st.x * size.width, st.y * size.height, st.r, 0, Math.PI * 2);
        g2.fill();
      }
      g2.globalAlpha = 1;
      if (!dark) {
        // 浅底没有暗部兜住画面，四周会散开；一层极轻的暗角把视线收回中心。
        const vig = g2.createRadialGradient(
          size.width / 2, size.height * 0.5, Math.min(size.width, size.height) * 0.28,
          size.width / 2, size.height * 0.5, Math.max(size.width, size.height) * 0.78,
        );
        vig.addColorStop(0, hexToRgba(tk.fg, 0));
        vig.addColorStop(1, hexToRgba(tk.fg, 0.055));
        g2.fillStyle = vig;
        g2.fillRect(0, 0, size.width, size.height);
      }
      return cv;
    };
    const draw = (now: number) => {
      if (stopped) return;
      // 每 30 帧重读一次 token 就够跟手（主题切换不是逐帧事件）。
      // 注意只能改写「实时那份」：演示配色是另一个对象，别被这行一起冲掉。
      if (frame++ % 30 === 0) Object.assign(tkLive, readTokens());
      const view = viewRef.current;
      const dt = Math.min(0.05, (now - lastFrame) / 1000);
      lastFrame = now;
      tk = presentingRef.current ? presentingInk : tkLive;
      dark = isDarkBg(tk.bg);
      const capture = captureRef.current;
      if (capture) {
        // 录屏时 yaw 只由「已录时长」决定：一圈固定 2π，接缝不会因掉帧漂移。
        view.yaw = loopYaw(capture.startYaw, now - capture.startedAt, capture.durationMs);
      }
      if (capture) {
        // 已由循环函数接管
      } else if (yawTarget.current !== null) {
        // 定时缓动（ease-out cubic，480ms）：与指数逼近不同，这里保证「一定在 0.48s 内停稳」，
        // 巡礼切层因此可以断言「多久之后镜头不再动」，而不是只能看着像停了。
        if (!yawAnimRef.current) {
          // 差角取环上的最短距离：从 6.2 rad 转到 0.1 rad 是 0.18，不是 6.1。
          const raw = Math.abs(yawTarget.current - view.yaw) % (Math.PI * 2);
          const delta = Math.min(raw, Math.PI * 2 - raw);
          camArcRef.current = {
            t0: now,
            peak: !motionPreference.matches && delta >= 0.35 ? 0.2 : 0,
          };
          yawAnimRef.current = { t0: now, from: view.yaw, to: yawTarget.current };
        }
        const anim = yawAnimRef.current;
        const progress = Math.min(1, (now - anim.t0) / YAW_ANIM_MS);
        const ease = 1 - Math.pow(1 - progress, 3);
        view.yaw = anim.from + (anim.to - anim.from) * ease;
        if (progress >= 1) {
          view.yaw = anim.to;
          yawTarget.current = null;
          yawAnimRef.current = null;
        }
      } else if (!capture && !motionPreference.matches && spinRef.current && now - lastInteract.current > IDLE_BEFORE_SPIN) {
        view.yaw += SPIN_RAD_PER_SEC * dt;
      }
      // 小屏用更长的焦距把图放大：375 宽时 min(w,h) 只有 375，
      // 按桌面系数算整张图只有硬币大，留白像坏了。
      if (introRef.current) {
        const a = introRef.current;
        const t = Math.min(1, (now - a.t0) / 900);
        const ease = 1 - Math.pow(1 - t, 3);
        view.zoom = a.from + (a.to - a.from) * ease;
        if (t >= 1) {
          view.zoom = a.to;
          introRef.current = null;
          setZoomPct(Math.round(a.to * 100));
          // 动画结束就把「保护标记」放下：之后尺寸/结构变化可以正常重新取景。
          userAdjusted.current = false;
        }
      }

      const narrow = size.width < 640;
      // 演示模式的部门巡礼：按顺序逐个聚焦，镜头同时转向该部门。
      // 录屏与减少动态效果时不自动推进（录屏必须保持一条无缝轨道）。
      if (presentingRef.current && tourRef.current && !capture && !motionPreference.matches) {
        // 按楼层排序巡礼：浅层先走，深层后走（见 tourOrder 的注释）。
        const depts = tourOrder(layout.nodes);
        if (depts.length > 1) {
          if (tourAt.current === 0) tourAt.current = now;
          const current = depts[Math.max(0, tourIndex.current % depts.length)];
          const stepMs = tourStepMs(current?.memberCount ?? 0, current?.agentCount ?? 0);
          if (!tourPausedRef.current && now - tourAt.current >= stepMs) {
            tourAt.current = now;
            tourIndex.current = (tourIndex.current + 1) % depts.length;
            const next = depts[tourIndex.current];
            setFocus(next.id);
            yawTarget.current = next.angle;
          }
          if (now - tourProgressAt.current > 250) {
            tourProgressAt.current = now;
            const idx = ((tourIndex.current % depts.length) + depts.length) % depts.length;
            setTourProgress({ index: idx + 1, total: depts.length, frac: Math.min(1, (now - tourAt.current) / stepMs) });
          }
        }
      }

      // 演示与录屏时给镜头一点“呼吸”：±3.5% 推拉 + 极小俯仰摆动。
      // 相位按循环时长归一化，录屏一圈正好回到原点，首尾帧仍能对上。
      if (capture) {
        breathRef.current = loopProgress(now - capture.startedAt, capture.durationMs);
      } else if (presentingRef.current && !motionPreference.matches) {
        breathRef.current = (breathRef.current + dt / (LOOP_DURATION_MS / 1000)) % 1;
      } else {
        breathRef.current = 0;
      }
      const breathe = (capture || (presentingRef.current && !motionPreference.matches)) ? breathRef.current : 0;
      const dolly = 1 + Math.sin(breathe * Math.PI * 2) * 0.035;
      // 转场弧线：与 yaw 缓动同一时基（480ms），中途拉远 20%，两端归零，
      // 所以「停下」时画面上不会有残留的推拉。
      const arcAnim = camArcRef.current;
      let camArc = 0;
      if (arcAnim.peak > 0) {
        const p = Math.min(1, (now - arcAnim.t0) / YAW_ANIM_MS);
        camArc = Math.sin(Math.PI * p) * arcAnim.peak;
        if (p >= 1) camArcRef.current = { t0: 0, peak: 0 };
      }
      if (canvasRef.current) canvasRef.current.dataset.camArc = camArc.toFixed(3);
      const cam = {
        yaw: view.yaw,
        pitch: view.pitch + (breathe ? Math.sin(breathe * Math.PI * 2 + Math.PI / 2) * 0.012 : 0),
        dist: view.dist * dolly * (1 + camArc),
        focal: Math.min(size.width, size.height) * (narrow ? 2.4 : 1.73) * view.zoom,
        cx: size.width / 2 + view.panX,
        cy: size.height / 2 + view.panY,
      };

      // 大网络降级：200 个节点的网络里，逐节点 shadowBlur + 逐边光晕会把
      // 帧率打到个位数。装饰性开销按规模递减，结构和信息一律不减。
      const heavy = layout.nodes.length > LEGION_HEAVY_NODES;
      // 400 级别（100 人 / 300 Agent）再降一档：只留结构和一档动效。
      const huge = layout.nodes.length > LEGION_HUGE_NODES;
      // 交互中：大网络先不画标签与数据包，停手后自动恢复（跟手优先）。
      const interacting = huge && now < interactingUntil.current;
      // Pause also freezes the new core ornament; reduced-motion is read live.
      if (!capture && !motionPreference.matches && spinRef.current && !interacting) corePhaseRef.current += dt * 0.24;
      // A local clock freezes every relationship/ring ornament together. Using
      // wall time here would jump the streaks when resuming or switching tabs.
      if (!capture && !motionPreference.matches && flowRef.current && !interacting) flowTimeRef.current += dt;
      const flowTime = flowTimeRef.current;
      applyResolution(interacting ? RES_LOW : 1);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const key = `${Math.round(size.width)}x${Math.round(size.height)}:${tk.bg}:${tk.accent}:${dark}`;
      if (!bgLayer || key !== bgKey) {
        bgLayer = buildBackdrop();
        bgKey = key;
      }
      if (bgLayer) ctx.drawImage(bgLayer, 0, 0, canvas.width, canvas.height);
      else {
        ctx.fillStyle = tk.bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // 极少量视差微尘：给纯色底一点空间深度，不参与命中或语义。
      if (!interacting && DUST.length) {
        const phase = motionPreference.matches ? 0 : view.yaw;
        const tintAlpha = dark ? 1 : 0.55;
        for (const speck of DUST) {
          const x = speck.x * size.width + Math.sin(phase * speck.par + speck.phase) * speck.amp;
          const y = speck.y * size.height + Math.cos(phase * speck.par + speck.phase) * speck.amp * 0.6;
          ctx.globalAlpha = speck.a * tintAlpha;
          ctx.fillStyle = speck.tint === 'accent' ? tk.accent : tk.fg;
          ctx.beginPath();
          ctx.arc(x, y, speck.r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      const toPoint = (n: LegionNode) => nodeToVec3({ ...n });
      let nodes = projectScene(layout.nodes, toPoint, cam, size);

      // 自动取景：默认 zoom=1.12 时整张图只占画布 40% 左右，剩下大半是空的。
      // 首屏和「重置视角」后按节点实体包围盒取景，留出实测标题/工具栏和图例。
      // 只在结构/尺寸变化时做，不跟用户的拖动/缩放抢。
      const sizeDrift = !lastFitSize.current
        || Math.abs(size.width - lastFitSize.current.w) > 8
        || Math.abs(size.height - lastFitSize.current.h) > 8;
      const fitBounds = fitBoundsRef.current ?? { x1: 24, y1: 24, x2: size.width - 24, y2: size.height - 24 };
      const initialZoom = view.zoom;
      const framingBodies = (zoom = initialZoom) => {
        const fittingCam = { ...cam, focal: cam.focal * zoom / initialZoom };
        const projected = zoom === initialZoom ? nodes : projectScene(layout.nodes, toPoint, fittingCam, size);
        const bodies = projected.map(sn => {
          const { rx, ry } = nodeBody(sn, layout.stats.people);
          // Includes the widest hover/selection stroke, also at the pixel floor.
          return { x: sn.projected.x, y: sn.projected.y, rx: rx + 6, ry: ry + 6 };
        });
        // Sparse nodes cover only one side of an orbit; include the visible
        // tracks and packets both in initial fitting and in recovery checks.
        for (const ring of ringRadii) {
          for (const p of ringPath(ring.radius, RING_HEIGHT[ring.ring] ?? 0, fittingCam, size, 64)) {
            bodies.push({ x: p.x, y: p.y, rx: 4, ry: 4 });
          }
        }
        return bodies;
      };
      // 入场动画期间不要重新取景：动画会让 view.zoom 每一帧都变，
      // 再按当前 zoom 算包围盒会滚雪球（实测直接顶到 MAX_ZOOM）。
      // 画布还没量到真实尺寸时不要取景：首帧 stage 只有几十像素，
      // 按那个尺寸算出来会被 MAX_ZOOM 夹到 240%，随后再跳回正常值（实测）。
      // 自愈：出现过「取景算早了 → 内容缩成一小坨、之后再也不重算」的情况
      // （admin 截图里 240% 却只有中间一小团）。用户没手动缩放过时，每 ~1 秒
      // 检查一次内容包围盒，占画面不到 35% 就重新取景。
      if (!userAdjusted.current && !introRef.current && !fitPending.current && frame % 60 === 0 && nodes.length > 3) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const body of framingBodies()) {
          minX = Math.min(minX, body.x - body.rx);
          maxX = Math.max(maxX, body.x + body.rx);
          minY = Math.min(minY, body.y - body.ry);
          maxY = Math.max(maxY, body.y + body.ry);
        }
        const spanNow = Math.max(maxX - minX, maxY - minY, 1);
        if (spanNow < Math.min(fitBounds.x2 - fitBounds.x1, fitBounds.y2 - fitBounds.y1) * 0.35) fitPending.current = true;
      }

      const sizeReady = size.width > 240 && size.height > 300;
      // 只有 core 时不取景；仅有部门的编制也有真实实体和轨道，需要避让展开控件。
      const dataReady = layout.stats.groups + layout.stats.people + layout.stats.agents > 0;
      if (sizeReady && dataReady && !sharedLock.current && (fitPending.current || (sizeDrift && !userAdjusted.current)) && !introRef.current && nodes.length > 0) {
        const fit = fitProjectedBodies(framingBodies, view, size, fitBounds, { min: MIN_ZOOM, max: MAX_ZOOM });
        // If controls exhaust the usable area, keep drawing the current scene.
        // A later valid bounds measurement will request another fit.
        if (fit) {
          const want = Math.min(MAX_ZOOM, Math.max(fit.zoom, focusZoomRef.current));
          Object.assign(view, { ...fit, zoom: want });
          setZoomPct(Math.round(want * 100));
          // 首次进入：先落在 62% 处，再缓动到目标（镜头推近的感觉）。
          if (!introDone.current) {
            introDone.current = true;
            const reduce = typeof window !== 'undefined'
              && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
            let seen = false;
            try { seen = sessionStorage.getItem('legion3d-intro') === '1'; } catch {}
            if (!reduce && !seen) {
              // 入场时镜头先偏一点，再靠定时缓动转回正位：开场有「推到位」的运动感，
              // 且因为缓动是定时的（480ms），不会影响「入场后镜头必须停住」的断言。
              view.yaw -= 0.35;
              yawTarget.current = view.yaw + 0.35;
              view.zoom = want * 0.62;
              // 动画期间也别让「尺寸漂移」触发重算。
              userAdjusted.current = true;
              introRef.current = { t0: now, from: want * 0.62, to: want };
              try { sessionStorage.setItem('legion3d-intro', '1'); } catch {}
            }
          }
          userAdjusted.current = false;
        }
        fitPending.current = false;
        lastFitSize.current = { w: size.width, h: size.height };
        // Render and hit-test the final zoom in this frame, not the pre-fit scene.
        cam.focal *= view.zoom / initialZoom;
        cam.cx = size.width / 2 + view.panX;
        cam.cy = size.height / 2 + view.panY;
        nodes = projectScene(layout.nodes, toPoint, cam, size);
      }
      screenRef.current = nodes;
      const byId = new Map(nodes.map(n => [n.item.id, n]));
      const core = byId.get('core');
      const byIdProbe = () => (core ? { x: core.projected.x, y: core.projected.y } : null);

      const near = Math.max(0.2, cam.dist - 1.1);
      const far = cam.dist + 1.6;

      // 楼层阴影：每个部门在最底下一层「地面」上投一片柔光斑。
      // 高度差越大，光斑离本体越远——不转镜头也能读出这家部门在几层。
      // 用径向渐变而不是实心椭圆：实心在浅色主题上像一块脏印（试过）。
      {
        const GROUND_Y = (RING_HEIGHT[3] ?? 0) - 0.12;
        for (const node of layout.nodes) {
          if (node.kind !== 'group') continue;
          const sn = byId.get(node.id);
          if (!sn) continue;
          const v = nodeToVec3(node);
          const hit = projectPoint({ x: v.x, y: GROUND_Y, z: v.z }, cam, size);
          if (!hit) continue;
          const { rx: bodyRx } = nodeBody(sn, layout.stats.people);
          const nearness = Math.max(0.3, Math.min(1, hit.scale / (cam.focal / Math.max(0.6, cam.dist))));
          const lit = selectedRef.current === node.id || hoverRef.current === node.id;
          const strength = (lit ? 0.3 : dark ? 0.2 : 0.13) * nearness;
          const radius = bodyRx * 1.7;
          ctx.save();
          ctx.translate(hit.x, hit.y);
          ctx.scale(1, 0.42);
          const pool = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
          pool.addColorStop(0, lit ? `rgba(46, 196, 182, ${strength})` : `rgba(15, 23, 42, ${strength})`);
          pool.addColorStop(0.55, lit ? `rgba(46, 196, 182, ${strength * 0.35})` : `rgba(15, 23, 42, ${strength * 0.3})`);
          pool.addColorStop(1, 'rgba(15, 23, 42, 0)');
          ctx.fillStyle = pool;
          ctx.beginPath();
          ctx.arc(0, 0, radius, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }

      // 部门扇区：把每个部门在环上占的弧度画成一段半透明弧带。
      // 只有一层环没有层级感；有了扇区，一眼能看出「这块是哪个部门」。
      for (const node of layout.nodes) {
        if (node.kind !== 'group' || !node.span || node.span < 0.22) continue;
        const rOuter = node.radius;
        const rInner = Math.max(0.08, node.radius - 0.042);
        const y = RING_HEIGHT[1] ?? 0;
        const steps = Math.max(6, Math.round(node.span * 18));
        const outer: Array<{ x: number; y: number }> = [];
        const inner: Array<{ x: number; y: number }> = [];
        for (let i = 0; i <= steps; i++) {
          const a = (node.spanStart ?? 0) + node.span * (i / steps);
          const po = projectPoint({ x: Math.sin(a) * rOuter, y, z: Math.cos(a) * rOuter }, cam, size);
          const pi = projectPoint({ x: Math.sin(a) * rInner, y, z: Math.cos(a) * rInner }, cam, size);
          if (po) outer.push({ x: po.x, y: po.y });
          if (pi) inner.push({ x: pi.x, y: pi.y });
        }
        if (outer.length < 2 || inner.length < 2) continue;
        const lit = activeSet?.has(node.id) ?? false;
        const bandColor = lit ? tk.accent : tk.info;
        const fillAlpha = activeSet
          ? (lit ? (focusingDept ? 0.26 : 0.22) : (focusingDept ? 0.015 : 0.04))
          : (dark ? 0.085 : 0.11);
        const edgeAlpha = activeSet
          ? (lit ? (focusingDept ? 0.55 : 0.5) : (focusingDept ? 0.03 : 0.08))
          : (dark ? 0.22 : 0.3);

        // 编制带：外侧渐隐的径向渐变 + 内侧高光，一眼看出「这块属于哪个部门」，
        // 同时不新增颜色（仍用 accent/info 单色系）。
        ctx.beginPath();
        outer.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
        for (let i = inner.length - 1; i >= 0; i--) ctx.lineTo(inner[i].x, inner[i].y);
        ctx.closePath();
        const midAngle = (node.spanStart ?? 0) + node.span / 2;
        const outerMid = projectPoint({ x: Math.sin(midAngle) * rOuter, y, z: Math.cos(midAngle) * rOuter }, cam, size);
        const innerMid = projectPoint({ x: Math.sin(midAngle) * rInner, y, z: Math.cos(midAngle) * rInner }, cam, size);
        if (outerMid && innerMid) {
          const band = ctx.createLinearGradient(innerMid.x, innerMid.y, outerMid.x, outerMid.y);
          band.addColorStop(0, hexToRgba(bandColor, fillAlpha));
          band.addColorStop(1, hexToRgba(bandColor, 0));
          ctx.fillStyle = band;
        } else {
          ctx.fillStyle = hexToRgba(bandColor, fillAlpha);
        }
        ctx.globalAlpha = 1;
        ctx.fill();

        // 内侧高光：把带子的内缘勾出来，和轨道线区分开。
        ctx.globalAlpha = edgeAlpha;
        ctx.strokeStyle = bandColor;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        inner.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
        ctx.stroke();

        // 编制刻度：每位成员一个点，沿带子中线分布；人数多的部门不铺满，
        // 上限 24 个，仍然能看出规模差。
        const seats = Math.min(node.memberCount ?? 0, 24);
        if (seats > 0) {
          const seatRadius = rInner + (rOuter - rInner) * 0.55;
          ctx.globalAlpha = activeSet ? (lit ? 0.7 : 0.06) : (dark ? 0.5 : 0.42);
          ctx.fillStyle = lit ? tk.accent : tk.fg;
          for (let s = 0; s < seats; s++) {
            const a = (node.spanStart ?? 0) + node.span * ((s + 0.5) / seats);
            const pt = projectPoint({ x: Math.sin(a) * seatRadius, y, z: Math.cos(a) * seatRadius }, cam, size);
            if (!pt) continue;
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 1.6, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
      }
      ctx.globalAlpha = 1;

      // 圆心光晕：给整张图一个视觉重心，不然四周的环会散掉。
      const coreCenter = byIdProbe();
      if (coreCenter) {
        const halo = ctx.createRadialGradient(coreCenter.x, coreCenter.y, 0, coreCenter.x, coreCenter.y, Math.min(size.width, size.height) * 0.34);
        // 浅底上这层核心光晕是整张图泛绿的主因：只留到能看出重心为止。
        halo.addColorStop(0, hexToRgba(tk.accent, dark ? 0.16 : 0.035));
        halo.addColorStop(0.45, hexToRgba(tk.accent, dark ? 0.05 : 0.012));
        halo.addColorStop(1, hexToRgba(tk.accent, 0));
        ctx.fillStyle = halo;
        ctx.fillRect(0, 0, size.width, size.height);
      }

      // 选中节点的聚光：把视线钉在被选中的那一个上，周围再按 activeSet 压暗。
      const selectedNode = selectedRef.current ? byId.get(selectedRef.current) : null;
      if (selectedNode && !interacting) {
        const { rx, ry } = nodeBody(selectedNode, layout.stats.people);
        const halo = haloFor(tk.accent);
        // 半径跟着节点走，但别把部门大的椭圆放大成一片背景光；
        // 浅底上更要收，否则整块画布都被染绿。
        const hr = Math.max(104, (rx + ry) * 3.2);
        ctx.globalAlpha = dark ? 0.42 : 0.18;
        ctx.drawImage(halo, selectedNode.projected.x - hr / 2, selectedNode.projected.y - hr / 2, hr, hr);
        ctx.globalAlpha = 1;
      }

      // Structural light channels stay visible in a dense scene. Moving streaks
      // illustrate parent-to-child relationships, not live task traffic.
      const curveOf = (ax: number, ay: number, bx: number, by: number, i: number) => {
        const dx = bx - ax;
        const dy = by - ay;
        const d = Math.hypot(dx, dy) || 1;
        const off = Math.min(56, d * 0.16) * (i % 2 ? -1 : 1);
        return { cx: (ax + bx) / 2 - (dy / d) * off, cy: (ay + by) / 2 + (dx / d) * off };
      };
      const quadAt = (ax: number, ay: number, cx: number, cy: number, bx: number, by: number, t: number) => {
        const u = 1 - t;
        return [u * u * ax + 2 * u * t * cx + t * t * bx, u * u * ay + 2 * u * t * cy + t * t * by];
      };
      type EdgeDraw = { a: SceneNode<LegionNode>; b: SceneNode<LegionNode>; cx: number; cy: number; lit: boolean; trunk: boolean };
      const edgeDraws: EdgeDraw[] = [];
      layout.edges.forEach((edge, i) => {
        const a = byId.get(edge.from);
        const b = byId.get(edge.to);
        if (!a || !b) return;
        const lit = !activeSet || (activeSet.has(edge.from) && activeSet.has(edge.to));
        const { cx, cy } = curveOf(a.projected.x, a.projected.y, b.projected.x, b.projected.y, i);
        // 父子部门之间的连线向下垂一层，读得出「这条线是往下走的」。
        const sag = dropSag(
          a.item.kind === 'group' ? a.item.depth ?? 1 : undefined,
          b.item.kind === 'group' ? b.item.depth ?? 1 : undefined,
          b.projected.y - a.projected.y,
        );
        edgeDraws.push({ a, b, cx, cy: cy + sag, lit, trunk: b.item.kind === 'group' });
      });

      // Broad bloom is reserved for the hierarchy spine or an explicit selection.
      // No per-edge blur; bounded strokes keep large networks responsive.
      const glowBudget = huge ? 24 : heavy ? 40 : 64;
      let glowDrawn = 0;
      if (dark && !interacting) {
        ctx.save();
        ctx.strokeStyle = tk.accent;
        for (const e of edgeDraws) {
          if (!e.lit || (!e.trunk && !activeSet)) continue;
          if (++glowDrawn > glowBudget) break;
          ctx.beginPath();
          ctx.moveTo(e.a.projected.x, e.a.projected.y);
          ctx.quadraticCurveTo(e.cx, e.cy, e.b.projected.x, e.b.projected.y);
          ctx.lineWidth = 9;
          ctx.globalAlpha = e.trunk ? 0.055 : 0.035;
          ctx.stroke();
          ctx.lineWidth = 4;
          ctx.globalAlpha = e.trunk ? 0.15 : 0.09;
          ctx.stroke();
        }
        ctx.restore();
      }
      for (const e of edgeDraws) {
        ctx.beginPath();
        ctx.moveTo(e.a.projected.x, e.a.projected.y);
        ctx.quadraticCurveTo(e.cx, e.cy, e.b.projected.x, e.b.projected.y);
        ctx.strokeStyle = e.lit && (activeSet || e.trunk) ? tk.accent : tk.info;
        ctx.globalAlpha = e.lit ? (activeSet ? 0.65 : e.trunk ? (dark ? 0.5 : 0.58) : (dark ? 0.13 : 0.2)) : 0.045;
        ctx.lineWidth = e.trunk ? 1.5 : huge ? 0.7 : e.lit && activeSet ? 1.4 : 0.8;
        ctx.stroke();
      }
      // Continuous tapered trails read as light flow rather than scattered dots.
      // Prefer department links; sample leaf links and cap total decorations.
      const cometStride = huge ? 14 : heavy ? 5 : 1;
      const flowBudget = huge ? 32 : heavy ? 48 : 64;
      let flowDrawn = 0;
      ctx.save();
      ctx.lineCap = 'round';
      edgeDraws.map((edge, index) => ({ edge, index })).sort((a, b) => Number(b.edge.trunk) - Number(a.edge.trunk)).forEach(({ edge: e, index: i }) => {
        if (interacting || !e.lit || (!e.trunk && i % cometStride !== 0) || flowDrawn >= flowBudget) return;
        const ax = e.a.projected.x, ay = e.a.projected.y, bx = e.b.projected.x, by = e.b.projected.y;
        const length = Math.hypot(e.cx - ax, e.cy - ay) + Math.hypot(bx - e.cx, by - e.cy);
        if (length < 24) return;
        flowDrawn++;
        // Phase belongs to the world-space edge. Projected length changes when
        // the camera moves, which must not move paused light along that edge.
        const worldLength = Math.hypot(e.b.point.x - e.a.point.x, e.b.point.y - e.a.point.y, e.b.point.z - e.a.point.z);
        const t = (flowTime * 0.18 / Math.max(0.35, worldLength) + i * 0.173) % 1;
        const trail = Math.min(0.3, (e.trunk ? 48 : 32) / length);
        // Fade near endpoints so light enters/leaves a node instead of teleporting.
        const envelope = Math.min(1, t * 12, (1 - t) * 12);
        for (let k = 6; k >= 1; k--) {
          const tail = Math.max(0, t - trail * k / 6);
          const tip = Math.max(0, t - trail * (k - 1) / 6);
          const [x1, y1] = quadAt(ax, ay, e.cx, e.cy, bx, by, tail);
          const [x2, y2] = quadAt(ax, ay, e.cx, e.cy, bx, by, tip);
          ctx.strokeStyle = dark && k === 1 ? tk.fg : tk.accent;
          ctx.globalAlpha = envelope * (1 - k / 7) * (e.trunk ? 0.9 : 0.64);
          ctx.lineWidth = e.trunk ? 2.6 : 1.7;
          ctx.beginPath();
          ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
          ctx.stroke();
        }
        const [hx, hy] = quadAt(ax, ay, e.cx, e.cy, bx, by, t);
        if (dark && e.trunk) {
          ctx.globalAlpha = envelope * 0.7;
          ctx.drawImage(haloFor(tk.accent), hx - 10, hy - 10, 20, 20);
        }
        ctx.globalAlpha = envelope * 0.95;
        ctx.fillStyle = dark ? tk.fg : tk.accent;
        ctx.beginPath(); ctx.arc(hx, hy, e.trunk ? 1.8 : 1.3, 0, Math.PI * 2); ctx.fill();
      });
      ctx.restore();
      ctx.globalAlpha = 1;

      // 部门内部短弧线（神明 phalanx18 的 pr 弧）：同部门相邻成员之间一条
      // 朝圆心收的二次曲线 —— 细彩线打底 + 白色短划，比部门间连线细一档。
      {
        const kids = new Map<string, LegionNode[]>();
        for (const edge of layout.edges) {
          const to = byId.get(edge.to);
          if (!to || to.item.kind !== 'person') continue;
          const arr = kids.get(edge.from) ?? [];
          arr.push(to.item);
          kids.set(edge.from, arr);
        }
        for (const [groupId, members] of kids) {
          if (members.length < 2) continue;
          for (let i = 0; i < members.length - 1; i++) {
            const a = byId.get(members[i].id);
            const b = byId.get(members[i + 1].id);
            if (!a || !b) continue;
            const lit = !activeSet || (activeSet.has(groupId) && activeSet.has(a.item.id) && activeSet.has(b.item.id));
            if (!lit) continue;
            const mx = (a.projected.x + b.projected.x) / 2;
            const my = (a.projected.y + b.projected.y) / 2;
            const cx = mx + (size.width / 2 - mx) * 0.12;
            const cy = my + (size.height / 2 - my) * 0.12;
            ctx.globalAlpha = activeSet ? 0.34 : 0.18;
            ctx.strokeStyle = tk.accent;
            ctx.lineWidth = 0.9;
            ctx.beginPath();
            ctx.moveTo(a.projected.x, a.projected.y);
            ctx.quadraticCurveTo(cx, cy, b.projected.x, b.projected.y);
            ctx.stroke();
            ctx.globalAlpha = activeSet ? 0.45 : 0.22;
            ctx.strokeStyle = tk.fg;
            ctx.lineWidth = 1.1;
            ctx.setLineDash([1.5, 11]);
            ctx.beginPath();
            ctx.moveTo(a.projected.x, a.projected.y);
            ctx.quadraticCurveTo(cx, cy, b.projected.x, b.projected.y);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
        ctx.globalAlpha = 1;
      }

      // 节点：远→近（projectScene 已排序），近的盖住远的。
      // 选中的是不是部门：是的话要给「它名下的人」描一圈，飞过去之后一眼看出
      // 这个部门有谁。每帧算一次，别在每个节点里 linear find。
      const selectedIsGroup = !!selectedRef.current
        && layout.nodes.some(n => n.id === selectedRef.current && n.kind === 'group');
      const labelQueue: Array<{ node: LegionNode; text: string; anchor: LabelEllipse; alpha: number; dim: boolean; priority: number }> = [];
      // 本帧「节点文字」实际用过的最低透明度。窄屏/密集网络里淡出的子部门如果
      // 还画字，就会出现能看见却读不清的幽灵标签（实拍）。用数字断言，不靠眼。
      let nodeTextAlphaMin = 1;
      const labelBodies: LabelEllipse[] = [];
      // 可见实体包围盒：alpha<0.25 的节点实际看不见（深部/离线/空部门会到 0.12–0.42），
      // 却照样参与取景包围盒——先把这个差值暴露出来量，再决定要不要改取景规则。
      let visMinX = Infinity, visMinY = Infinity, visMaxX = -Infinity, visMaxY = -Infinity, visCount = 0;
      for (const sn of nodes) {
        const node = sn.item;
        const p = sn.projected;
        // 人多的时候成员环会连成一条「白香肠」：100 个人挤在一圈上，半径再大
        // 就互相吃掉轮廓。>60 人时把成员点收小一档，让环重新变成一颗颗。
        const { radius: r, rx, ry } = nodeBody(sn, layout.stats.people);
        const depthT = Math.min(1, Math.max(0, (p.depth - near) / (far - near)));
        const st = node.kind === 'agent' ? (statusByAlias.get(node.label) ?? 'offline') : null;
        const statusMiss = statusOnly !== null && node.kind === 'agent' && st !== statusOnly;
        const dim = (activeSet && !activeSet.has(node.id)) || statusMiss;
        // 聚焦/选中的部门轻微呼吸：相位由同一次 now 算出，并写回画布 DOM，
        // 让断言读到的就是绘制用的那个数（不另造一份给测试用）。
        const breatheTarget = !motionPreference.matches && node.kind === 'group'
          && (selectedRef.current === node.id || activeSet?.has(node.id));
        if (breatheTarget) {
          const phase = ((now % 1800) / 1800);
          breathePhaseRef.current = phase;
          const canvasEl = canvasRef.current;
          if (canvasEl) canvasEl.dataset.pulsePhase = phase.toFixed(3);
        }
        // 镜头朝向也镜像到画布上（节流 200ms）：入场/巡礼结束是否真的停住，
        // 需要能读到「当前 yaw」而不是靠截图猜。
        // 节点包围盒实测（含描边余量）：窄屏是否把整张图装进画布，用数字说话。
        if (now - lastFitExpose.current > 400) {
          lastFitExpose.current = now;
          const canvasEl = canvasRef.current;
          if (canvasEl) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const sn of nodes) {
              const { rx, ry } = nodeBody(sn, layout.stats.people);
              minX = Math.min(minX, sn.projected.x - rx);
              minY = Math.min(minY, sn.projected.y - ry);
              maxX = Math.max(maxX, sn.projected.x + rx);
              maxY = Math.max(maxY, sn.projected.y + ry);
            }
            if (Number.isFinite(minX)) {
              canvasEl.dataset.fitBounds = `${Math.round(minX)},${Math.round(minY)},${Math.round(maxX)},${Math.round(maxY)}`;
              canvasEl.dataset.fitView = `${Math.round(size.width)}x${Math.round(size.height)}`;
              if (Number.isFinite(visMinX)) {
                canvasEl.dataset.visBounds = `${Math.round(visMinX)},${Math.round(visMinY)},${Math.round(visMaxX)},${Math.round(visMaxY)}`;
                canvasEl.dataset.visCount = `${visCount}/${nodes.length}`;
              }
              // 选中节点的屏幕坐标：手机上的详情卡会不会挡住焦点，用坐标判断。
              const focusedSn = nodes.find(sn => sn.item.id === selectedRef.current);
              if (focusedSn) {
                canvasEl.dataset.focusAt = `${Math.round(focusedSn.projected.x)},${Math.round(focusedSn.projected.y)}`;
              } else {
                delete canvasEl.dataset.focusAt;
              }
            }
            // 噪点基线：多少个 Agent 圆点、其中多少离线/未上报、实体占画面比例。
            // 「看起来乱」必须先变成数字，否则改动只能靠猜。
            {
              let agents = 0, offlineAgents = 0, area = 0;
              for (const sn of nodes) {
                const { rx, ry } = nodeBody(sn, layout.stats.people);
                area += Math.PI * rx * ry;
                if (sn.item.kind === 'agent') {
                  agents += 1;
                  const st = statusByAlias.get(sn.item.label);
                  if (!st || st === 'offline') offlineAgents += 1;
                }
              }
              const cover = size.width > 0 && size.height > 0 ? area / (size.width * size.height) : 0;
              canvasEl.dataset.noise = `agents=${agents},offline=${offlineAgents},cover=${cover.toFixed(3)}`;
            }
          }
        }
        if (now - lastViewExpose.current > 200) {
          lastViewExpose.current = now;
          const canvasEl = canvasRef.current;
          if (canvasEl) canvasEl.dataset.viewYaw = view.yaw.toFixed(3);
        }
        const offline = node.kind === 'agent' && !statusByAlias.get(node.label);
        // 深一层部门在默认缩放下淡出：13 个部门全画会在内圈叠成一团，放大
        // （≥1.8×）或聚焦/选中时才实心显示。
        // 空部门（没有人也没有 Agent）同样淡出：生产 13 个部门只有 1 个有人，
        // 全实心会让画面全是空泡泡。放大/聚焦/选中时才回到实心。
        // 「无主 Agent」这类只有 Agent 的分组不算空，否则它一出现就是灰的。
        const emptyDept = node.kind === 'group' && (node.memberCount ?? 0) + (node.agentCount ?? 0) === 0
          && selectedRef.current !== node.id && !activeSet?.has(node.id) && view.zoom < 1.8;
        const deepDept = node.kind === 'group' && (node.depth ?? 1) > 1
          && view.zoom < 1.8 && selectedRef.current !== node.id && !activeSet?.has(node.id);
        // 深度淡出：最远的标签会淡到 1-0.55=0.45，实测那是 4.04:1（浅色只有 2.95:1），
        // 都低于 4.5 —— 远端标签「看得见但读不清」。底色深浅决定能淡多少：
        // 深底 0.55、浅底 0.65，最差情况分别是 5.5:1 与 5.6:1。
        const depthFade = dark ? 0.45 : 0.35;
        // 层级预览：停在某部门时，其它层的部门退到背景（成员/Agent 不动，
        // 否则会连「这个部门有谁」一起看不清）。
        const previewDepth = depthPreviewRef.current;
        const offLayer = previewDepth !== null && node.kind === 'group' && Math.max(1, node.depth ?? 1) !== previewDepth;
        const breathe = breatheTarget && breathePhaseRef.current >= 0
          ? 1 - Math.abs(0.5 - breathePhaseRef.current) * 0.12
          : 1;
        let alpha = (1 - depthT * depthFade) * (dim ? (selectedRef.current ? 0.14 : 0.22) : 1) * (offline ? 0.42 : 1)
          * (emptyDept ? 0.3 : deepDept ? 0.12 : 1)
          * (offLayer ? 0.34 : 1) * breathe;
        if (node.kind === 'core') alpha = Math.min(1, alpha + 0.15);
        const color = nodeColor(node, tk, statusByAlias);
        // Stable core size keeps the logo crisp and its labels still.
        const radiusPx = r;
        // This same object must reach bodies, labelQueue and the leader: the
        // leader router excludes its own body by reference, not by coordinates.
        const anchor = { x: p.x, y: p.y, rx: rx + 2, ry: ry + 2 };
        if (alpha >= 0.25) {
          visCount += 1;
          if (anchor.x - anchor.rx < visMinX) visMinX = anchor.x - anchor.rx;
          if (anchor.y - anchor.ry < visMinY) visMinY = anchor.y - anchor.ry;
          if (anchor.x + anchor.rx > visMaxX) visMaxX = anchor.x + anchor.rx;
          if (anchor.y + anchor.ry > visMaxY) visMaxY = anchor.y + anchor.ry;
        }
        // Compact/expanded mobile framing can bring Agent dots beside the core
        // label. Every painted body participates, even when it has no label.
        labelBodies.push(anchor);

        ctx.globalAlpha = alpha;
        const ring = Math.max(1.4, Math.min(3.5, radiusPx * 0.34));

        // 头像：成员用 display_name、Agent 用 alias 取头像（和列表页同一套解析链）。
        // 半径太小时照片必然糊成噪点，所以 Agent 只在近处（>5px）才换头像。
        const avatarUrl = node.kind === 'person'
          ? getAvatarUrl(node.sublabel?.replace(/^@/, '') || node.label)
          : node.kind === 'agent'
            ? getAvatarUrl(node.label)
            : '';
        const face = avatarUrl && radiusPx >= 4.5 ? avatarImage(avatarUrl) : null;
        if (node.kind === 'core') {
          drawLegionCore(ctx, p.x, p.y, radiusPx, { ...tk, isDark: dark }, corePhaseRef.current, !interacting);
        } else if (node.kind === 'group') {
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI * 2);
          ctx.fillStyle = hexToRgba(color, dark ? 0.24 : 0.12);
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.4;
          ctx.stroke();
        } else if (face) {
          if (dark) {
            const halo = haloFor(color);
            const hr = radiusPx * 3.4;
            ctx.drawImage(halo, p.x - hr / 2, p.y - hr / 2, hr, hr);
          }
          ctx.save();
          ctx.beginPath();
          ctx.arc(p.x, p.y, radiusPx, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(face, p.x - radiusPx, p.y - radiusPx, radiusPx * 2, radiusPx * 2);
          ctx.restore();
          ctx.beginPath();
          ctx.arc(p.x, p.y, radiusPx, 0, Math.PI * 2);
          ctx.strokeStyle = color;
          ctx.lineWidth = ring;
          ctx.stroke();
        } else if ((huge && node.kind === 'agent') || interacting) {
          // 300 个 Agent 时每个都画「白芯 + 描边」纯属浪费：一个色点足够，
          // 状态色仍然可读，鼠标悬停/命中半径不变。
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(1.6, radiusPx * 0.82), 0, Math.PI * 2);
          ctx.fill();
        } else if (dark) {
          // 深底（神明 cover14 的节点画法）：彩色外晕 → 白芯 → 彩色描边。
          // 只画实心色块时深底上是一团糊光；白芯给每个节点一个硬边。
          const wantHalo = !heavy || activeSet?.has(node.id);
          if (wantHalo) {
            const halo = haloFor(color);
            const hr = radiusPx * 3.4;
            ctx.drawImage(halo, p.x - hr / 2, p.y - hr / 2, hr, hr);
          }
          ctx.fillStyle = tk.fg;
          ctx.beginPath();
          ctx.arc(p.x, p.y, radiusPx, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.lineWidth = ring;
          ctx.stroke();
        } else {
          // 浅底（神明 phalanx18 的参数）：7px 彩色 .18 外圈 + 白芯 + 3.5px 描边。
          // 浅底不要辉光，靠描边定轮廓。
          ctx.fillStyle = hexToRgba(color, 0.14);
          ctx.beginPath();
          ctx.arc(p.x, p.y, radiusPx + 7, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = tk.surface;
          ctx.beginPath();
          ctx.arc(p.x, p.y, radiusPx, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.lineWidth = Math.max(1.6, Math.min(3.5, radiusPx * 0.5));
          ctx.stroke();
        }

        // 圆心内容：部门写短名、没有头像的成员写首字母 —— 否则大圆点就是一片空白，
        // 远看全是「白饼」（admin 截图里最扎眼的就是这个）。
        if (!dim) {
          const textColor = dark ? tk.bg : tk.fg;
          // alpha < 0.5 的实体是「故意淡出」的（深一层部门/空部门）：这时画字
          // 只会留下读不清的残影。要么清楚，要么不画。
          if (alpha >= 0.5 && node.kind === 'group' && radiusPx >= 9) {
            const short = Array.from(node.label.replace(/[*+\s]/g, '')).slice(0, rx >= 28 ? 3 : 2).join('');
            if (short) {
              nodeTextAlphaMin = Math.min(nodeTextAlphaMin, alpha);
              const fs = Math.min(13, Math.max(11, ry * 1.25));
              ctx.font = `600 ${fs}px system-ui, -apple-system, "Noto Sans SC", sans-serif`;
              ctx.fillStyle = tk.fg;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(short, p.x, p.y + 0.5);
            }
          } else if (alpha >= 0.5 && node.kind === 'person' && !face && radiusPx >= 8) {
            nodeTextAlphaMin = Math.min(nodeTextAlphaMin, alpha);
            const initial = (node.label || '?').trim().slice(0, 1).toUpperCase();
            ctx.font = `600 ${Math.min(radiusPx * 0.9, 12)}px system-ui, -apple-system, "Noto Sans SC", sans-serif`;
            ctx.fillStyle = textColor;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(initial, p.x, p.y + 0.5);
          }
        }

        // 悬停：鼠标下的节点描一圈细线，来得及看清「我点的是哪一个」。
        if (hoverRef.current === node.id && selectedRef.current !== node.id) {
          ctx.globalAlpha = 0.55;
          ctx.strokeStyle = tk.accent;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, rx + 5, ry + 5, 0, 0, Math.PI * 2);
          ctx.stroke();
        }

        // 选中部门时：它名下的成员与 Agent 各描一圈淡环。
        // 部门本身已经有扫描环，这里只标「这个部门有谁」，别的部门不描。
        if (selectedIsGroup && selectedRef.current !== node.id && activeSet?.has(node.id)
            && node.kind !== 'group' && node.kind !== 'core') {
          ctx.globalAlpha = 0.45;
          ctx.strokeStyle = tk.accent;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, rx + 3.5, ry + 3.5, 0, 0, Math.PI * 2);
          ctx.stroke();
        }

        // 选中/高亮节点加一圈描边，别只靠亮度差（截图上容易看不出来）。
        if (selectedRef.current === node.id) {
          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = tk.fg;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, rx + 4, ry + 4, 0, 0, Math.PI * 2);
          ctx.stroke();
          // 缓慢转动的虚线扫描环：一眼认出「现在聚焦的是这个」。
          // 相位按 yaw 归一化到整数个图案周期，录屏绕一圈首尾仍对齐。
          const scan = Math.max(rx, ry) + 10;
          const pattern = 4 + 7;
          const turns = 4;
          ctx.globalAlpha = 0.6;
          ctx.strokeStyle = tk.accent;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 7]);
          ctx.lineDashOffset = -((view.yaw / (Math.PI * 2)) % 1) * pattern * turns;
          ctx.beginPath();
          ctx.arc(p.x, p.y, scan, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // 标签：Agent 太多，只有近处或高亮时才画，避免糊成一片。
        // 部门的短名已经写在圆点里；名字短到圆心能写全时，外面再画一个一样的
        // 名字只是重复（密集网络里尤其明显），只有悬停/选中才补。
        const shortInside = node.kind === 'group' && radiusPx >= 9
          && Array.from(node.label.replace(/[*+\s]/g, '')).length <= (rx >= 28 ? 3 : 2);
        const groupWanted = node.kind === 'group'
          && ((node.span ?? 0) >= 1.0 || selectedRef.current === node.id || hoverRef.current === node.id || p.scale > cam.focal * 0.55);
        const showLabel =
          node.kind === 'core' ||
          (groupWanted && !shortInside) ||
          (groupWanted && (selectedRef.current === node.id || hoverRef.current === node.id)) ||
          (!heavy && node.kind === 'person' && layout.stats.people <= LEGION_LABEL_PEOPLE
            && (p.scale > cam.focal * 0.16 || activeSet?.has(node.id))) ||
          (heavy && !huge && activeSet?.has(node.id)) ||
          // Agent 名字在密集网络里是噪声：42 个运行时，标签会把环压满（实拍）。
          // 少于 12 个 Agent 时仍按近处自动显示，其余靠悬停/选中。
          (node.kind === 'agent' && (selectedRef.current === node.id || hoverRef.current === node.id
            || (layout.stats.agents <= LEGION_LABEL_AGENTS && p.scale > cam.focal * 0.2))) ||
          hoverRef.current === node.id;
        // 状态筛选开着时，不匹配的 Agent 不要标签（否则压暗了还在喊自己）。
        const filteredOut = statusOnly !== null && node.kind === 'agent'
          && (statusByAlias.get(node.label ?? '') ?? 'offline') !== statusOnly;
        if (showLabel && !interacting && !filteredOut) {
          labelQueue.push({
            node,
            text: node.kind !== 'group' && node.label.length > 12 ? `${node.label.slice(0, 11)}…` : node.label,
            anchor,
            // 标签的深度淡出比节点保守，并且有下限 0.8：11px 文字掉到 0.45 时
            // 对底色的有效对比度会跌破 4.5:1（实测深底 3.67、浅底 3.14）。
            // 被主动淡出的节点（dim）保持 0.35，那是「这不属于当前筛选」的语义。
            alpha: dim ? 0.35 : Math.max(0.8, 1 - depthT * 0.35),
            dim: !!dim,
            // 一级部门优先占位：两层部门树时，二级组的标签会把一级部门挤开、看起来更乱。
            priority: node.kind === 'core' ? 0 : (hoverRef.current === node.id || selectedRef.current === node.id) ? 1 : node.kind === 'group' ? ((node.depth ?? 1) <= 1 ? 2 : 2.5) : 3,
          });
        }
        ctx.globalAlpha = 1;
      }

      // 保留现有可见性/优先级；文字避开实体、已有标签和控件。
      // 部门全文换行，没有可读位置时留白，详情里仍可读完整名称。
      {
        labelQueue.sort((a, b) => a.priority - b.priority);
        const placed: LabelRect[] = [...labelUiRectsRef.current];
        const leaders: Array<{ anchor: LabelEllipse; rect: LabelRect; alpha: number }> = [];
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // 最多画 N 个标签：搜索命中会一次性点亮几百个节点，逐个 measureText +
        // roundRect 会把帧率拖回 30fps。少画几个名字不影响「找到它」。
        const labelBudget = huge ? 16 : heavy ? 40 : Number.POSITIVE_INFINITY;
        const attemptBudget = labelBudget * 2;
        let drawnLabels = 0;
        let attemptedLabels = 0;
        for (const item of labelQueue) {
          if (drawnLabels >= labelBudget || attemptedLabels >= attemptBudget) break;
          attemptedLabels++;
          const big = item.node.kind === 'core';
          ctx.font = `${big ? 600 : 400} ${big ? 14 : 12}px system-ui, -apple-system, "Noto Sans SC", sans-serif`;
          // Circular nodes have tighter gaps than the wide department discs.
          // At 12px this caps each line at about 15 CJK characters.
          const maxTextWidth = Math.min(180, Math.max(120, (size.width - 32) / 2));
          const metricKey = `${ctx.font}:${maxTextWidth}:${item.text}`;
          let metric = labelMetrics.get(metricKey);
          if (!metric) {
            const lines = item.node.kind === 'group' ? wrapLegionLabel(item.text, maxTextWidth, text => ctx.measureText(text).width) : [item.text];
            const lineHeight = big ? 16 : 14;
            metric = { lines, width: Math.max(0, ...lines.map(text => ctx.measureText(text).width)) + 8, height: lines.length * lineHeight + 6, lineHeight };
            labelMetrics.set(metricKey, metric);
          }
          const spot = placeLegionLabel({ anchor: item.anchor, width: metric.width, height: metric.height,
            bounds: { x1: 12, y1: 12, x2: size.width - 12, y2: size.height - 12 }, occupied: placed, bodies: labelBodies });
          if (!spot) continue;
          placed.push(spot);
          drawnLabels++;
          if (item.node.kind === 'group') leaders.push({ anchor: item.anchor, rect: spot, alpha: item.alpha });
          if (heavy || item.node.kind === 'group') {
            ctx.globalAlpha = 0.42 * item.alpha;
            ctx.fillStyle = tk.bg;
            ctx.beginPath();
            ctx.roundRect(spot.x1, spot.y1, metric.width, metric.height, 4);
            ctx.fill();
          }
          ctx.globalAlpha = item.alpha;
          nodeTextAlphaMin = Math.min(nodeTextAlphaMin, item.alpha);
          ctx.fillStyle = tk.fg;
          for (const [index, line] of metric.lines.entries()) {
            ctx.fillText(line, (spot.x1 + spot.x2) / 2, spot.y1 + 3 + metric.lineHeight * (index + 0.5));
          }
        }
        // Check the route only after every label has its final position.
        for (const item of leaders) {
          const leader = legionLabelLeader(item.anchor, item.rect, placed, labelBodies);
          if (!leader) continue;
          ctx.globalAlpha = 0.45 * item.alpha;
          ctx.strokeStyle = tk.dim;
          ctx.lineWidth = 0.75;
          ctx.beginPath();
          ctx.moveTo(leader.from.x, leader.from.y);
          ctx.lineTo(leader.to.x, leader.to.y);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        // 整帧画完再记：此时 nodeTextAlphaMin 已经覆盖本帧所有节点文字。
        if (canvasRef.current) canvasRef.current.dataset.nodeTextAlpha = nodeTextAlphaMin.toFixed(2);

        // 悬停提示：不点也能知道「这是谁、什么状态」。
        // 选中时不画（右侧详情卡已经有完整信息）。
        const hv = hoverRef.current;
        const hp = hoverPos.current;
        if (hv && hp && !selectedRef.current && !interacting) {
          const hitNode = nodes.find(n => n.item.id === hv);
          if (hitNode) {
            const nd = hitNode.item;
            const status = nd.kind === 'agent' ? (statusByAlias.get(nd.label) ?? '未上报') : nd.kind === 'person' ? `${nd.agentCount} 个 Agent` : '';
            const text = status ? `${nd.label} · ${status}` : nd.label;
            ctx.font = '400 11px system-ui, -apple-system, "Noto Sans SC", sans-serif';
            const w = ctx.measureText(text).width;
            const padX = 6;
            const boxW = w + padX * 2;
            const boxH = 20;
            const x = Math.max(6, Math.min(size.width - boxW - 6, hp.x + 14));
            const y = Math.max(6, hp.y - boxH - 8);
            ctx.globalAlpha = 0.94;
            ctx.fillStyle = tk.surface;
            ctx.beginPath();
            ctx.roundRect(x, y, boxW, boxH, 5);
            ctx.fill();
            ctx.strokeStyle = tk.border;
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.fillStyle = tk.fg;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, x + padX, y + boxH / 2);
            ctx.globalAlpha = 1;
          }
        }
      }

      // 环上彗星：头亮、尾巴 6 段渐隐，双向各一颗（神明参数：比虚线更有「通信」感）。
      for (const ring of ringRadii) {
        const y = RING_HEIGHT[ring.ring] ?? 0;
        for (let k = 0; k < 2; k++) {
          const dir = k === 0 ? 1 : -1;
          const head = flowTime * 0.28 * dir + ring.ring * 1.7 + k * Math.PI;
          for (let seg = 6; seg >= 0; seg--) {
            const a = head - dir * seg * 0.05;
            const pt = projectPoint({ x: Math.sin(a) * ring.radius, y, z: Math.cos(a) * ring.radius }, cam, size);
            if (!pt) continue;
            const t = 1 - seg / 7;
            ctx.globalAlpha = (dark ? 0.45 : 0.28) * t * t;
            ctx.fillStyle = seg === 0 ? tk.fg : tk.accent;
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 2.1 * t + 0.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      ctx.globalAlpha = 1;

      if (capture) {
        // 等比放进导出画幅（默认 1280×720）：竖屏/宽屏都留主题底色，不把圆环拉成椭圆。
        const rect = containRect(size.width, size.height, capture.width, capture.height);
        capture.octx.fillStyle = tk.bg;
        capture.octx.fillRect(0, 0, capture.width, capture.height);
        capture.octx.drawImage(canvas, rect.x, rect.y, rect.width, rect.height);
        if (!capture.finished && loopProgress(now - capture.startedAt, capture.durationMs) >= 1) {
          capture.finished = true;
          try { if (capture.recorder.state !== 'inactive') capture.recorder.stop(); } catch { /* stopped already */ }
        }
      }

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => { stopped = true; cancelAnimationFrame(raf); };
  }, [layout, ringRadii, size, statusByAlias, activeSet]);

  /* ── 交互 ───────────────────────────────────────────────────────── */

  /** 选中节点最近的祖先部门（Agent/成员 → 其所属部门）。 */
  const ancestorDept = useMemo(
    () => (selectedNode ? nearestDept(selectedNode.id, layout.nodes) : null),
    [layout.nodes, selectedNode],
  );

  /** Agent 在当前场景对话；列表、回车、画布双击走同一入口。 */
  const openNode = useCallback((node: LegionNode) => {
    if (node.kind === 'agent') {
      setCleanView(false);
      setHelpOpen(false);
      setToolsOpen(false);
      setChatAlias(node.label);
      yawTarget.current = null;
    yawAnimRef.current = null;
      lastInteract.current = performance.now();
    }
    else if (node.kind === 'person' || node.kind === 'group') router.push('/org');
  }, [router]);

  /** 从列表里选一个节点：和点击画布等价，另外把镜头转过去。 */
  const pickNode = useCallback((node: LegionNode) => {
    setSelected(node.id);
    // 手机上列表与详情卡会互相压：选完就收起列表，按钮状态也跟着一致。
    if (typeof window !== 'undefined' && window.innerWidth < 640) setListOpen(false);
    setFocus(null);
    if (node.kind !== 'core') {
      let delta = node.angle - viewRef.current.yaw;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      yawTarget.current = viewRef.current.yaw + delta;
    }
    // 从列表选部门时也闪一圈：和点画布是同一件事（相机已经转过去了，
    // 但列表选项离画布很远，没有落点提示就不知道飞到了哪）。
    if (node.kind === 'group') {
      const onScene = screenRef.current.find(n => n.item.id === node.id);
      if (onScene) {
        setFlyFlash({ x: onScene.projected.x, y: onScene.projected.y, r: Math.max(26, (onScene.projected.scale || 1) * 34), label: node.label });
        if (flyTimer.current) window.clearTimeout(flyTimer.current);
        flyTimer.current = window.setTimeout(() => setFlyFlash(null), 1300);
      }
    }
    lastInteract.current = performance.now();
  }, []);

  // 手动步进部门：巡礼在「减少动态效果」下按设计静止，但讲解需要能一个部门一个部门地过。
  // 步进不改巡礼开关，只移动聚焦；减动效时干脆不做镜头滑动（否则等于变相动画）。
  // 聚焦部门 → 请求一次重新取景（倍率按层级保底）；解除聚焦 → 回到自然取景。
  useEffect(() => {
    const node = focus ? layout.nodes.find(n => n.id === focus) : null;
    focusZoomRef.current = node && node.kind === 'group' ? FOCUS_ZOOM_BY_DEPTH(node.depth ?? 1) : 0;
    fitPending.current = true;
  }, [focus, layout.nodes]);

  const stepDept = useCallback((dir: 1 | -1) => {
    const depts = tourOrder(layout.nodes);
    if (!depts.length) return;
    const current = depts.findIndex(d => d.id === focus);
    const nextIndex = current < 0 ? 0 : (current + dir + depts.length) % depts.length;
    const target = depts[nextIndex];
    setFocus(target.id);
    tourIndex.current = nextIndex;
    tourAt.current = 0;
    if (reducedMotion) {
      viewRef.current.yaw = target.angle;
      yawTarget.current = null;
    } else {
      yawTarget.current = target.angle;
    }
    if (tourRef.current) setTourProgress({ index: nextIndex + 1, total: depts.length, frac: 0 });
  }, [layout.nodes, focus, reducedMotion]);

  const copyViewLink = useCallback(async () => {
    const view = viewRef.current;
    const params = new URLSearchParams({
      view: `${view.yaw.toFixed(3)},${view.pitch.toFixed(3)},${view.zoom.toFixed(3)}`,
    });
    const url = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
    try {
      await navigator.clipboard.writeText(url);
      setShareInfo('已复制视角链接');
    } catch {
      setShareInfo('复制失败，请手动复制地址栏');
    }
    window.setTimeout(() => setShareInfo(''), 2500);
  }, []);

  // 视角记忆：拖拽/缩放后把当前相机存到本机，下次打开同一网络接着看。
  // 分享链接（?view=）优先级更高，不会被记忆覆盖。
  const persistTimer = useRef<number | null>(null);
  const persistView = useCallback(() => {
    if (typeof window === 'undefined' || !networkId) return;
    if (persistTimer.current !== null) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      const v = viewRef.current;
      try {
        localStorage.setItem(`legion3d-view:${networkId}`, JSON.stringify({ yaw: v.yaw, pitch: v.pitch, zoom: v.zoom }));
      } catch { /* 隐私模式写不进去就只影响记忆，不影响画面 */ }
    }, 300);
  }, [networkId]);

  // 滚轮必须在非 passive 监听里 preventDefault，否则页面会跟着滚，控制台还会报
  // “Unable to preventDefault inside passive event listener”。React 的 onWheel 是 passive。
  useEffect(() => {
    // 用 document 级监听：舞台可能是后挂载的（先显示“正在确认网络”），
    // 绑在 ref 上会错过挂载时机；这里按事件目标判断是否在舞台上。
    const onWheelNative = (event: WheelEvent) => {
      const el = (event.target as Element | null)?.closest?.('[data-testid="legion-3d-stage"]');
      if (!el || presentingRef.current) return;
      event.preventDefault();
      lastInteract.current = performance.now();
      interactingUntil.current = performance.now() + 180;
      introRef.current = null;
      const v = viewRef.current;
      const factor = event.deltaY > 0 ? 1 / 1.12 : 1.12;
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
      const rect = (el as HTMLElement).getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const mx = event.clientX - rect.left - cx;
      const my = event.clientY - rect.top - cy;
      const k = next / v.zoom;
      v.panX = mx - k * (mx - v.panX);
      v.panY = my - k * (my - v.panY);
      v.zoom = next;
      userAdjusted.current = true;
      fitPending.current = false;
      setZoomPct(Math.round(next * 100));
      persistView();
    };
    document.addEventListener('wheel', onWheelNative, { passive: false });
    return () => document.removeEventListener('wheel', onWheelNative);
  }, [persistView]);

  const resetView = useCallback(() => {
    sharedLock.current = false;
    try { localStorage.removeItem(`legion3d-view:${networkId}`); } catch { /* ignore */ }
    yawTarget.current = null;
    viewRef.current = { ...DEFAULT_VIEW };
    setZoomPct(Math.round(DEFAULT_VIEW.zoom * 100));
    fitPending.current = true;
    userAdjusted.current = false;
    lastInteract.current = performance.now();
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const el = wrapRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await el.requestFullscreen();
    } catch {
      // 浏览器拒绝（iframe / 权限策略）时保持原样，不做假动作
    }
  }, []);

  // 净屏后按钮是 invisible，焦点会掉回 body，stage 的 onKeyDown 收不到 Esc；
  // 所以净屏期间单独挂一个 window 级的退出键。
  useEffect(() => {
    if (!cleanView) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Nonmodal chat can coexist with clean view. Its focused window (or
      // nested image dialog) owns Escape before the background scene.
      if (e.target instanceof Element && e.target.closest('[data-testid="legion-chat"]')) return;
      e.preventDefault();
      e.stopPropagation();
      // Capture runs before the stage handler; dismiss the topmost layer first.
      if (helpOpen) setHelpOpen(false);
      else setCleanView(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [cleanView, helpOpen]);

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const hitBody = (sn: SceneNode<LegionNode>) => {
    const { rx, ry } = nodeBody(sn, layout.stats.people);
    return { rx: rx + 6, ry: ry + 6 };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (presentingRef.current) return; // 演示/录屏：画面只做匀速环绕，不接受交互
    introRef.current = null; // 手动交互优先，别跟用户的拖动抢
    const target = e.currentTarget as HTMLElement;
    yawTarget.current = null; // 手动拖动优先，打断自动对准
    target.setPointerCapture?.(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lastInteract.current = performance.now();
    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      pinchRef.current = { span: Math.hypot(a.x - b.x, a.y - b.y), dist: viewRef.current.zoom };
      dragRef.current = null;
      return;
    }
    dragRef.current = {
      x: e.clientX,
      y: e.clientY,
      yaw: viewRef.current.yaw,
      pitch: viewRef.current.pitch,
      moved: 0,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (presentingRef.current) return; // 演示/录屏：不产生 hover 提示，避免镜头里出现浮框
    // 之前这里一上来就要求「指针已在 map 里」（按下时才登记），导致**悬停永远不会触发**：
    // 光标不变、悬停高亮不亮、提示框也不出。现在只区分「按下」与「未按下」。
    const down = pointersRef.current.has(e.pointerId);
    if (down) pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lastInteract.current = performance.now();

    if (down && pointersRef.current.size === 2 && pinchRef.current) {
      const [a, b] = [...pointersRef.current.values()];
      const span = Math.hypot(a.x - b.x, a.y - b.y);
      if (span > 4 && pinchRef.current.span > 4) {
        interactingUntil.current = performance.now() + 180;
        const ratio = span / pinchRef.current.span;
        viewRef.current.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinchRef.current.dist * ratio));
        userAdjusted.current = true;
        fitPending.current = false;
        setZoomPct(Math.round(viewRef.current.zoom * 100));
      }
      return;
    }

    if (!dragRef.current) {
      // 没按下的移动 = 悬停：只更新 ref，不触发 React 重渲染。
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const hit = hitTest(screenRef.current, e.clientX - rect.left, e.clientY - rect.top, 18, hitBody);
      const next = hit ? hit.item.id : null;
      hoverPos.current = next ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : null;
      if (next !== hoverRef.current) {
        hoverRef.current = next;
        // 与画布 hover 同一处更新：同一条规则驱动渲染与角标，不另造一份判断。
        const hoverNode = next ? layout.nodes.find(n => n.id === next) : null;
        applyDepthPreview(hoverNode && hoverNode.kind === 'group' ? Math.max(1, hoverNode.depth ?? 1) : null);
        (e.currentTarget as HTMLElement).style.cursor = next ? 'pointer' : 'grab';
      }
      return;
    }

    const drag = dragRef.current;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
    if (dx !== 0 || dy !== 0) {
      userAdjusted.current = true;
      fitPending.current = false;
    }
    interactingUntil.current = performance.now() + 180;
    viewRef.current.yaw = drag.yaw + dx * 0.008;
    viewRef.current.pitch = Math.min(1.45, Math.max(0.12, drag.pitch + dy * 0.005));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    lastInteract.current = performance.now();
    if (drag && drag.moved > 6) yawTarget.current = null;
    if (drag && drag.moved > 0) persistView();
    if (!drag) return;
    dragRef.current = null;
    if (drag.moved > 6) return; // 拖动不是点击

    // 触屏没有 Esc：净屏后轻点画布恢复，拖动仍用于旋转。
    // 这次轻点只退出净屏，不顺带选择背后的节点。
    if (cleanView) { setCleanView(false); return; }

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const hit = hitTest(screenRef.current, e.clientX - rect.left, e.clientY - rect.top, 16, hitBody);
    setSelected(hit ? hit.item.id : null);
    // 点部门：镜头转到它正面，并在落点闪一圈（成员/Agent 不做，避免每次点都动）。
    const picked = hit ? screenRef.current.find(n => n.item.id === hit.item.id) : null;
    if (hit && picked && hit.item.kind === 'group') {
      let delta = picked.item.angle - viewRef.current.yaw;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      yawTarget.current = viewRef.current.yaw + delta;
      setFlyFlash({ x: picked.projected.x, y: picked.projected.y, r: Math.max(26, (picked.projected.scale || 1) * 34), label: hit.item.label });
      if (flyTimer.current) window.clearTimeout(flyTimer.current);
      flyTimer.current = window.setTimeout(() => setFlyFlash(null), 1300);
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const hit = hitTest(screenRef.current, e.clientX - rect.left, e.clientY - rect.top, 18, hitBody);
    if (!hit) {
      // 双击空白 = 复位视角（含缩放锚点），省得再去右上角点按钮。
      resetView();
      return;
    }
    openNode(hit.item);
  };

  const onPointerLeave = () => {
    hoverRef.current = null;
    hoverPos.current = null;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // The help dialog owns keyboard input above the disclosure and canvas.
    if (helpOpen) {
      e.stopPropagation();
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        setHelpOpen(false);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        helpRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
      }
      return;
    }
    if (e.key === 'Escape' && toolsOpen) {
      e.preventDefault();
      e.stopPropagation();
      setToolsOpen(false);
      toolsToggleRef.current?.focus();
      return;
    }
    // 在输入框里打字时，方向键/加减号归输入框，不能拿去转镜头。
    // 唯一例外是 Esc：清掉搜索词，但保持焦点（用户接着改词）。
    const target = e.target as HTMLElement | null;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
      if (e.key === 'Escape' && query) {
        e.preventDefault();
        setQuery('');
      }
      return;
    }
    lastInteract.current = performance.now();
    yawTarget.current = null;
    const v = viewRef.current;
    // 键盘找节点：/ 直接进本页搜索。整站 Quick search 也绑了 `/`，
    // 这里 stopPropagation 把它拦在舞台内（全局面板仍可用 ⌘K）。
    if (e.key === '/') {
      e.preventDefault();
      e.stopPropagation();
      searchRef.current?.focus();
      return;
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-'].includes(e.key)) {
      introRef.current = null;
      userAdjusted.current = true;
      fitPending.current = false;
    }
    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); v.yaw -= 0.12; userAdjusted.current = true; break;
      case 'ArrowRight': e.preventDefault(); v.yaw += 0.12; userAdjusted.current = true; break;
      case 'ArrowUp': e.preventDefault(); v.pitch = Math.min(1.45, v.pitch + 0.08); userAdjusted.current = true; break;
      case 'ArrowDown': e.preventDefault(); v.pitch = Math.max(0.12, v.pitch - 0.08); userAdjusted.current = true; break;
      case '+': case '=': e.preventDefault(); v.zoom = Math.min(MAX_ZOOM, v.zoom * 1.1); userAdjusted.current = true; setZoomPct(Math.round(v.zoom * 100)); persistView(); break;
      case '-': e.preventDefault(); v.zoom = Math.max(MIN_ZOOM, v.zoom / 1.1); userAdjusted.current = true; setZoomPct(Math.round(v.zoom * 100)); persistView(); break;
      case 'Enter': {
        // 焦点还在节点列表里时，回车只负责「选中」（按钮自身行为），
        // 不要在列表里按一下就跳走；再按一次才打开（见列表项的 onClick）。
        if (document.activeElement?.closest('[role="listbox"]')) break;
        // 选中节点后回车 = 页内对话（成员/部门仍去 /org）。
        // 省掉「Tab 到详情卡里的链接再回车」这一步。
        const sel = selectedRef.current;
        if (sel) {
          const node = layout.nodes.find(n => n.id === sel);
          if (node) { e.preventDefault(); openNode(node); }
        }
        break;
      }
      case '?':
        // 全站 HelpOverlay 也绑了 `?`（window keydown）。在军团页上让本页速查表
        // 优先，否则弹出来的是全局英文快捷键表。
        e.preventDefault();
        e.stopPropagation();
        setToolsOpen(false);
        setHelpOpen(v => !v);
        break;
      case 'r': case 'R': resetView(); break;
      case 'f': case 'F': e.preventDefault(); void toggleFullscreen(); break;
      case 'Escape':
        e.preventDefault();
        // 演示/录屏先退出（并丢弃未完成的录制），再退回净屏。
        if (presentingRef.current) { exitPresenting(); break; }
        // 净屏优先退出，也可轻点画布恢复。
        if (cleanView) { setCleanView(false); break; }
        // 状态筛选次之，然后才是搜索/选中。
        if (statusOnly) { setStatusOnly(null); break; }
        // 先退搜索，再退选中：一次 Esc 只做一件事。
        if (query) setQuery('');
        else setSelected(null);
        break;
      default: break;
    }
  };

  /* ── 演示 / 录屏模式 ─────────────────────────────────────────────── */

  const endCapture = useCallback((cancelled: boolean) => {
    const capture = captureRef.current;
    if (!capture) return;
    capture.cancelled = cancelled;
    if (cancelled) {
      // 取消反馈立即给：不依赖 MediaRecorder 的 onstop 在什么时机到达。
      setCaptureInfo('已取消录屏，未生成文件。');
      setCaptureProgress(0);
    }
    try { if (capture.recorder.state !== 'inactive') capture.recorder.stop(); } catch { /* already stopped */ }
  }, []);

  const exitPresenting = useCallback(() => {
    presentingRef.current = false;
    endCapture(true);
    setPresenting(false);
    setCleanView(false);
    setCaptureProgress(0);
  }, [endCapture]);

  const togglePresenting = useCallback(() => {
    if (presentingRef.current) { exitPresenting(); return; }
    presentingRef.current = true;
    setPresenting(true);
    runPresentChecks();
    setCleanView(true);
    setCaptureError('');
    setCaptureInfo('');
    setSpin(true);
    spinRef.current = true;
    hoverRef.current = null;
    hoverPos.current = null;
    yawTarget.current = null;
  }, [exitPresenting]);

  // 演示/录屏时焦点可能落在 body（点了工具栏按钮后按钮重渲染），舞台的
  // onKeyDown 收不到事件；Esc 必须在任何焦点下都能退出，并丢弃未完成录制。
  // 常驻监听，不跟着 presenting 一起挂/卸：深链进入演示的那一刻，effect 还没跑完，
  // 此时按 Esc 会丢——`?present=1` 的暗场里最容易发生。判断放在监听器内部。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !presentingRef.current) return;
      event.preventDefault();
      exitPresenting();
    };
    // 捕获阶段：别的组件（帮助浮层、命令面板）在冒泡里 stopPropagation 也拦不住出口。
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [exitPresenting]);

  const startCapture = useCallback(() => {
    if (captureRef.current) return;
    setCaptureError('');
    setCaptureInfo('');
    if (typeof MediaRecorder === 'undefined') {
      setCaptureError('当前浏览器不支持 MediaRecorder，无法导出循环视频');
      return;
    }
    const mime = pickRecordingMime(type => MediaRecorder.isTypeSupported(type));
    if (!mime) {
      setCaptureError('当前浏览器没有可用的视频编码器（mp4 / webm 均不支持）');
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) { setCaptureError('画布尚未就绪'); return; }
    const dims = exportDimensions(exportHigh);
    const out = document.createElement('canvas');
    out.width = dims.width;
    out.height = dims.height;
    const octx = out.getContext('2d');
    if (!octx) { setCaptureError('浏览器不支持 canvas'); return; }
    const tk = readTokens();
    octx.fillStyle = tk.bg;
    octx.fillRect(0, 0, dims.width, dims.height);
    const rect = containRect(size.width, size.height, dims.width, dims.height);
    octx.drawImage(canvas, rect.x, rect.y, rect.width, rect.height);

    let stream: MediaStream;
    try { stream = out.captureStream(EXPORT_FPS); } catch { setCaptureError('无法捕获画布，无法导出视频'); return; }
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: exportHigh ? 14_000_000 : 8_000_000 });
    } catch {
      setCaptureError('视频编码器启动失败，请换一个浏览器再试');
      return;
    }
    const chunks: Blob[] = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => {
      const capture = captureRef.current;
      if (!capture) return;
      if (capture.timer !== null) window.clearInterval(capture.timer);
      if (capture.safety !== null) window.clearTimeout(capture.safety);
      for (const track of capture.stream.getTracks()) track.stop();
      captureRef.current = null;
      setCapturing(false);
      setCaptureProgress(0);
      if (capture.cancelled) { setCaptureInfo('已取消录屏，未生成文件。'); return; }
      const blob = new Blob(chunks, { type: mime });
      if (!blob.size) { setCaptureError('录屏没有产生数据，请重试'); return; }
      const name = recordingFileName(mime, new Date(), dims.width, dims.height);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setCaptureInfo(`已导出 ${name}（${(blob.size / 1024 / 1024).toFixed(1)} MB · ${LOOP_DURATION_MS / 1000} 秒无缝循环）`);
    };

    const startYaw = ((viewRef.current.yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    // 后台标签页会停掉 rAF：循环内永远等不到收尾。兜底定时器保证一定会停，
    // 即使那一次录出来的帧数不完整，也不会占着 MediaRecorder 不放。
    const safety = window.setTimeout(() => {
      const current = captureRef.current;
      if (!current || current.finished) return;
      current.finished = true;
      try { if (current.recorder.state !== 'inactive') current.recorder.stop(); } catch { /* already stopped */ }
    }, LOOP_DURATION_MS + 2000);
    recorder.start(250);
    captureRef.current = {
      startedAt: performance.now(), startYaw, durationMs: LOOP_DURATION_MS, mime, width: dims.width, height: dims.height, out, octx,
      recorder, stream, chunks, finished: false, cancelled: false,
      timer: window.setInterval(() => {
        const current = captureRef.current;
        if (current) setCaptureProgress(loopProgress(performance.now() - current.startedAt, current.durationMs));
      }, 200),
      safety,
    };
    presentingRef.current = true;
    setPresenting(true);
    runPresentChecks();
    setCleanView(true);
    setCapturing(true);
    setSpin(true);
    spinRef.current = true;
    hoverRef.current = null;
    hoverPos.current = null;
    yawTarget.current = null;
    wrapRef.current?.focus();
  }, [size.width, size.height, exportHigh]);

  /* ── 导出 ───────────────────────────────────────────────────────── */

  const exportPng = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setExporting(true);
    setExportError('');
    try {
      // 交互期背板可能还是 0.6×：导出前先让绘制循环回到全分辨率，
      // 否则会把降采样的糊图导出去（画质没法事后补救）。
      interactingUntil.current = 0;
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

      // 和 2D 页一样，导出图自带标题栏、计数、图例与导出时间 ——
      // 一张裸图存到相册里过几天就说不清是谁的编制。
      const tk2 = readTokens();
      const scale = canvas.width / Math.max(1, canvas.clientWidth);
      const head = Math.round(58 * scale);
      const foot = Math.round(32 * scale);
      const out = document.createElement('canvas');
      out.width = canvas.width;
      out.height = canvas.height + head + foot;
      const g = out.getContext('2d');
      if (!g) throw new Error('浏览器不支持 canvas');
      g.fillStyle = tk2.bg;
      g.fillRect(0, 0, out.width, out.height);
      g.drawImage(canvas, 0, head);
      const font = 'system-ui, -apple-system, "Segoe UI", "Noto Sans SC", sans-serif';
      const px = (n: number) => Math.round(n * scale);
      g.textBaseline = 'middle';
      g.textAlign = 'left';
      g.fillStyle = tk2.fg;
      g.font = `600 ${px(18)}px ${font}`;
      g.fillText('军团 · 3D 网络拓扑', px(16), px(24));
      g.fillStyle = tk2.muted;
      g.font = `${px(12)}px ${font}`;
      const filterLabel = statusOnly ? ({ working: '运行中', idle: '空闲', blocked: '阻塞', error: '错误', offline: '未上报' } as const)[statusOnly] : null;
      g.fillText(
        `${layout.stats.groups} 个部门 · ${layout.stats.people} 名成员 · ${layout.stats.agents} 个 Agent`
          + (filterLabel ? ` · 仅显示 ${filterLabel}` : ''),
        px(16), px(44),
      );
      g.textAlign = 'right';
      g.font = `${px(11)}px ${font}`;
      g.fillText(`导出 ${new Date().toLocaleString('zh-CN', { hour12: false })}`, out.width - px(16), px(24));

      // 底部图例：颜色语义与页面一致（深底是发光圆点，浅底是描边圆）。
      const legend: Array<[string, string]> = [
        [tk2.success, '运行中'],
        [tk2.muted, '空闲'],
        [tk2.warning, '阻塞'],
        [tk2.danger, '错误'],
      ];
      let lx = px(20);
      const ly = out.height - foot / 2;
      g.textAlign = 'left';
      for (const [color, label] of legend) {
        g.beginPath();
        g.arc(lx, ly, px(4), 0, Math.PI * 2);
        g.fillStyle = color;
        g.fill();
        g.fillStyle = tk2.muted;
        g.font = `${px(11)}px ${font}`;
        g.fillText(label, lx + px(10), ly);
        lx += px(10 + 11 * label.length + 22);
      }
      g.textAlign = 'right';
      g.fillText('ANet · Legion 3D', out.width - px(16), ly);

      const blob = await new Promise<Blob | null>(resolve => out.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('PNG 编码失败');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `legion-3d-${new Date().toISOString().slice(0, 10)}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 0);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : '导出失败');
    } finally {
      setExporting(false);
    }
  }, [layout.stats]);

  /* ── 页面 ───────────────────────────────────────────────────────── */

  // 网络未确定 ⇒ 也算 loading（null key 时 SWR 的 isLoading 是 false，会把等待误判成「空」）
  const loading = !networkReady || people.isLoading || hierarchy.isLoading || status.isLoading;
  const readError = legionReadError(people.error, hierarchy.error);
  // #73 —— 不再维护 needsLogin 这个「只置位不清零」的 state：SWR 成功后 error 会自己清掉，
  // 直接派生就能「登录恢复后立刻收起过期提示」。no-network 分支是 #72 的网络就绪判定。
  const fatal = readError?.status === 401 ? 'login'
    : networkReady && !networkId ? 'no-network'
    : readError ? 'error' : null;
  const isEmpty = !loading && !fatal && people.data != null && layout.nodes.length <= 1;

  const path = useMemo(() => {
    if (!selectedNode) return [] as string[];
    const byId = new Map(layout.nodes.map(n => [n.id, n]));
    const out: string[] = [];
    for (let cur: LegionNode | undefined = selectedNode; cur && cur.parentId; cur = byId.get(cur.parentId)) {
      const parent = byId.get(cur.parentId);
      if (!parent || parent.kind === 'core') break; // 圆心是网络本身，不写进部门路径
      out.unshift(parent.label);
    }
    return out;
  }, [layout.nodes, selectedNode]);

  const detailHref = selectedNode?.kind === 'agent'
    ? `/nodes/${encodeURIComponent(selectedNode.label)}`
    : selectedNode?.kind === 'group'
      ? `/org?focus=${encodeURIComponent(selectedNode.label)}`
      : '/org';

  // 演示是整屏的事：应用侧栏虽然淡到 0.18，仍占着左边一条浅色，投屏/录屏时会割裂
  // 画面。演示态把舞台铺满视口（盖住侧栏）；出口是舞台里的「退出演示（Esc）」按钮，
  // 所以不会出现「进了演示找不回来」。
  return (
    <div
      ref={wrapRef}
      data-legion-root
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-legion-stage="3d"
      style={{ height: presenting || isFullscreen ? '100dvh' : (stageHeight ?? 'calc(100dvh - 7.5rem)') }}
      // position 必须二选一：`relative` 与 `fixed` 同在一条 class 里时，胜负由样式表
      // 顺序决定（实测 relative 赢），元素留在文档流里只被拉大成 100vw，量出来是
      // 「从侧栏右边开始的一大块」——.293 第一版就这么错了。
      className={`${presenting ? 'fixed inset-0 z-40' : 'relative w-full'} overflow-hidden bg-[var(--bg)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]`}
      aria-label="军团 3D 网络拓扑"
      data-testid="legion-3d-stage"
      data-hover-depth={depthPreview ?? ''}
      data-zoom={zoomPct}
      data-fly-target={flyFlash?.label || ''}
      data-present-ink={presenting ? 'dark' : ''}
      data-member-halo={memberHaloCount}
    >
      <style>{`@keyframes legion-fly-flash {
        from { opacity: .9; transform: scale(.7); }
        to   { opacity: 0;  transform: scale(1.25); }
      }`}</style>
      {/* 点部门后镜头飞过去，落点闪一圈：只闪，不拦截指针。 */}
      {flyFlash && (
        <span
          data-testid="legion-3d-fly-ring"
          aria-hidden
          className="pointer-events-none absolute rounded-full border-2 border-[var(--accent)]/70"
          style={{
            left: `${flyFlash.x - flyFlash.r}px`,
            top: `${flyFlash.y - flyFlash.r}px`,
            width: `${flyFlash.r * 2}px`,
            height: `${flyFlash.r * 2}px`,
            animation: 'legion-fly-flash 1.2s ease-out forwards',
          }}
        />
      )}
      <p id="legion-3d-hint" className="sr-only">可拖动旋转、滚轮或双指缩放；点击节点查看详情，双击 Agent 在页内对话，双击成员或部门进入组织列表；按 / 搜索，R 重置视角。</p>
      <canvas
        ref={canvasRef}
        className={`block h-full w-full touch-none ${presenting ? 'cursor-none' : 'cursor-grab active:cursor-grabbing'}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        onDoubleClick={onDoubleClick}
        role="img"
        aria-label="军团三维拓扑图"
        aria-describedby="legion-3d-hint"
        tabIndex={-1}
      />

      {!presenting && depthPreview !== null && (
        <span
          role="status"
          data-testid="legion-3d-depth-chip"
          className="pointer-events-none absolute bottom-3 left-3 z-20 rounded-md bg-[var(--bg-secondary)]/92 px-2 py-1 text-[11px] text-[var(--fg-muted)] backdrop-blur"
        >
          第 {depthPreview} 层 · 同层 {layout.nodes.filter(n => n.kind === 'group' && Math.max(1, n.depth ?? 1) === depthPreview).length} 个部门
        </span>
      )}
      {presenting && (
        // 演示控制条放右下角：右上角是工具栏（导出循环、复制视角…），
        // 放在同一角会直接盖住那些按钮——鼠标点不到，实测导出按钮被拦截。
        <div
          data-testid="legion-3d-present-bar"
          data-idle={chromeIdle ? '1' : '0'}
          className={`pointer-events-auto absolute bottom-3 right-3 z-20 flex max-w-[70vw] flex-wrap items-center justify-end gap-2 transition-opacity duration-500 ${chromeIdle ? 'opacity-0' : 'opacity-100'}`}
        >
          <button
            type="button"
            data-testid="legion-3d-step-prev"
            onClick={() => stepDept(-1)}
            aria-label="上一个部门"
            title="上一个部门（减少动态效果时也可用）"
            className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/90 px-2.5 py-1.5 text-xs text-[var(--fg-muted)] backdrop-blur hover:text-[var(--fg)]"
          >
            ← 上一部门
          </button>
          <button
            type="button"
            data-testid="legion-3d-step-next"
            onClick={() => stepDept(1)}
            aria-label="下一个部门"
            title="下一个部门（减少动态效果时也可用）"
            className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/90 px-2.5 py-1.5 text-xs text-[var(--fg-muted)] backdrop-blur hover:text-[var(--fg)]"
          >
            下一部门 →
          </button>
          <button
            type="button"
            data-testid="legion-3d-tour"
            aria-pressed={tour}
            aria-disabled={reducedMotion}
            title={reducedMotion ? '系统减少动态效果时巡礼保持静止' : '按顺序逐个聚焦部门，镜头跟着转'}
            onClick={() => {
              if (reducedMotion) return;
              const next = !tour;
              setTour(next);
              tourAt.current = 0;
              if (!next) { setFocus(null); tourIndex.current = -1; return; }
              const depts = tourOrder(layout.nodes);
              tourIndex.current = depts.length ? 0 : -1;
              if (depts[0]) { setFocus(depts[0].id); yawTarget.current = depts[0].angle; }
            }}
            className={`rounded-md border px-2.5 py-1.5 text-xs backdrop-blur transition-colors ${tour ? 'border-[var(--accent)] bg-[var(--bg-secondary)]/90 text-[var(--accent-text)]' : 'border-[var(--border)] bg-[var(--bg-secondary)]/90 text-[var(--fg-muted)] hover:text-[var(--fg)]'} ${reducedMotion ? 'opacity-50' : ''}`}
          >
            部门巡礼{reducedMotion ? '（静止）' : ''}
          </button>
          {tour && (
            <button
              type="button"
              data-testid="legion-3d-tour-pause"
              aria-pressed={tourPaused}
              title={tourPaused ? '继续巡礼' : '暂停巡礼（讲解时用）'}
              onClick={() => {
                const next = !tourPaused;
                setTourPaused(next);
                tourPausedRef.current = next;
                // 恢复时把本步的计时起点往后挪，避免一恢复就立刻跳到下一步。
                if (!next) tourAt.current = 0;
              }}
              className={`rounded-md border px-2.5 py-1.5 text-xs backdrop-blur transition-colors ${tourPaused ? 'border-[var(--accent)] bg-[var(--bg-secondary)]/90 text-[var(--accent-text)]' : 'border-[var(--border)] bg-[var(--bg-secondary)]/90 text-[var(--fg-muted)] hover:text-[var(--fg)]'}`}
            >
              {tourPaused ? '继续' : '暂停'}
            </button>
          )}
          {tour && (
            <span role="status" aria-live="polite" data-testid="legion-3d-tour-status"
              className="rounded-md bg-[var(--bg-secondary)]/90 px-2 py-1 text-[11px] text-[var(--fg-muted)] backdrop-blur">
              {(() => {
                const node = layout.nodes.find(n => n.id === focus);
                if (!node) return '巡礼中';
                // 分层之后光报部门名看不出「现在在第几层」，把层号一起报出来。
                return `第 ${Math.max(1, node.depth ?? 1)} 层 · ${node.label}`;
              })()}
              {tourProgress && (
                <span data-testid="legion-3d-tour-step" className="ml-2 tabular-nums text-[var(--fg-dim)]">
                  {tourProgress.index}/{tourProgress.total}
                </span>
              )}
            </span>
          )}
          {tour && tourProgress && (
            // 本步进度：讲解时知道「还有多久切下一个」，而不是突然切走。
            <span
              data-testid="legion-3d-tour-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(tourProgress.frac * 100)}
              className="h-1 w-16 overflow-hidden rounded-full bg-[var(--border)]/60 backdrop-blur"
            >
              <span className="block h-full rounded-full bg-[var(--accent)]/70 transition-[width] duration-200" style={{ width: `${Math.round(tourProgress.frac * 100)}%` }} />
            </span>
          )}
          {presentChecks && (
            <span
              role="status"
              data-testid="legion-3d-present-checks"
              className={`max-w-[60vw] rounded-md px-2 py-1 text-[11px] backdrop-blur ${presentChecks.length ? 'bg-[var(--danger)]/15 text-[var(--danger)]' : 'bg-[var(--bg-secondary)]/90 text-[var(--fg-muted)]'}`}
            >
              演示检查：{presentChecks.length ? presentChecks.join(' · ') : '就绪'}
            </span>
          )}
          <button
            type="button"
            data-testid="legion-3d-present-exit"
            onClick={exitPresenting}
            className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/90 px-2.5 py-1.5 text-xs text-[var(--fg-muted)] backdrop-blur transition-colors hover:text-[var(--fg)]"
          >
            退出演示（Esc）
          </button>
        </div>
      )}
      {/* 巡礼讲解条（左下角，像电视的 lower-third）：镜头转到哪个部门，就把它的层级、
          人数和直属下级一起报出来——原来只有一行「第 N 层 · 名字」，录屏时观众看不出规模。
          pointer-events-none：演示中点击仍归画布，不会误触。 */}
      {presenting && tour && (() => {
        const node = layout.nodes.find(n => n.id === focus && n.kind === 'group');
        if (!node) return null;
        const children = layout.nodes.filter(n => n.parentId === node.id && n.kind === 'group').length;
        return (
          <div
            data-testid="legion-3d-caption"
            className="pointer-events-none absolute bottom-5 left-4 z-20 max-w-[76vw] rounded-lg bg-[var(--bg-secondary)]/90 px-3 py-2 backdrop-blur sm:left-6"
          >
            <p data-testid="legion-3d-caption-title" className="text-base font-medium text-[var(--fg)] sm:text-lg">{node.label}</p>
            <p data-testid="legion-3d-caption-meta" className="mt-0.5 text-[11px] text-[var(--fg-muted)]">
              第 {Math.max(1, node.depth ?? 1)} 层 · {node.memberCount} 人 · 下级 {children}
              {node.leader ? ` · 负责人 ${node.leader}` : ''}
            </p>
            {/* 讲解条也带上路径：演示时观众一直知道当前讲的是哪条链上的部门。 */}
            <p data-testid="legion-3d-caption-path" className="mt-0.5 text-[10px] text-[var(--fg-dim)]">
              {(() => {
                const byId = new Map(layout.nodes.map(n => [n.id, n]));
                const chain: string[] = [];
                for (let cur = node.parentId ? byId.get(node.parentId) : undefined; cur && cur.kind !== 'core'; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
                  chain.unshift(cur.label);
                }
                chain.push(node.label);
                return chain.join(' / ');
              })()}
            </p>
          </div>
        );
      })()}
      {capturing && (
        <div role="status" data-testid="legion-3d-capture-status" className="pointer-events-auto absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded-md bg-[var(--bg-secondary)]/92 px-3 py-1 text-xs text-[var(--fg-muted)] backdrop-blur">
          <span>录屏中 {Math.round(captureProgress * 100)}% · {LOOP_DURATION_MS / 1000} 秒无缝循环</span>
          <button
            type="button"
            data-testid="legion-3d-capture-cancel"
            onClick={() => endCapture(true)}
            className="rounded px-1.5 py-0.5 text-[var(--fg)] underline underline-offset-2 hover:text-[var(--fg-muted)]"
          >
            取消
          </button>
        </div>
      )}
      {captureInfo && !capturing && (
        <p role="status" data-testid="legion-3d-capture-info" className="pointer-events-none absolute bottom-4 left-1/2 z-20 max-w-[92vw] -translate-x-1/2 rounded-md bg-[var(--bg-secondary)]/92 px-3 py-1 text-center text-xs text-[var(--fg-muted)] backdrop-blur">
          {captureInfo}
        </p>
      )}
      {captureError && (
        <p role="alert" data-testid="legion-3d-capture-error" className="pointer-events-none absolute bottom-4 left-1/2 z-20 max-w-[92vw] -translate-x-1/2 rounded-md border border-red-500/30 bg-[var(--bg-secondary)]/95 px-3 py-1 text-center text-xs text-red-300 backdrop-blur">
          {captureError}
        </p>
      )}

      {/* 顶部信息区：手机上「标题 → 搜索 → 按钮」竖排，桌面上标题在左、按钮在右。
          之前按钮绝对定位在 top-16，加了搜索框后正好压住输入框。 */}
      <div ref={headerRef} data-testid="legion-3d-header" className={`pointer-events-none absolute inset-x-3 top-3 flex flex-col gap-2 transition-opacity duration-300 sm:inset-x-4 sm:top-4 sm:flex-row sm:items-start sm:justify-between ${cleanView ? 'invisible' : 'visible'}`}>
      <div className="pointer-events-none min-w-0 max-w-full sm:max-w-sm">
        <div className="flex min-h-11 items-center gap-2 pr-20 sm:min-h-0 sm:items-baseline sm:pr-0">
          <h1 className="text-lg font-semibold text-[var(--fg)]">军团 · 3D</h1>
          <span className="hidden text-[11px] text-[var(--fg-dim)] sm:inline">Legion Topology</span>
        </div>
        <p className="mt-1 text-xs text-[var(--fg-muted)]">
          {loading
            ? '正在读取编制…'
            : `${layout.stats.groups} 个部门 · ${layout.stats.people} 名成员 · ${layout.stats.agents} 个 Agent`
              + (statusOnly ? ` · 仅显示 ${({ working: '运行中', idle: '空闲', blocked: '阻塞', error: '错误', offline: '未上报' } as const)[statusOnly]}` : '')}
        </p>
        {/* 第一次看 3D 的人不知道三环各是什么；2D 页有这行说明，这里补上（演示时更不用口头解释）。 */}
        <p className="mt-0.5 hidden text-[11px] text-[var(--fg-dim)] sm:block" data-testid="legion-3d-legend">
          圆心是网络，外三环依次是部门、成员与名下 Agent。
        </p>
        <div className="pointer-events-auto mt-2 flex items-center gap-2">
          <input
            ref={searchRef}
            value={query}
            onChange={e => {
              const next = e.target.value;
              setQuery(next);
              // 搜索和部门聚焦是两种「缩小范围」，同时开会互相打架：
              // 镜头还对着旧部门，亮的却是搜索结果。开始搜索就退掉聚焦。
              if (next && focus) {
                setFocus(null);
                yawTarget.current = null;
              }
            }}
            placeholder="搜索成员 / 部门 / Agent"
            aria-label="搜索军团成员"
            data-testid="legion-3d-search"
            className="w-44 rounded-md bg-[var(--bg-secondary)]/85 px-2.5 py-1 text-xs text-[var(--fg)] placeholder:text-[var(--fg-dim)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)] sm:w-56"
          />
          {query.trim() !== '' && (
            // 与 2D 同口径：搜索要有数量反馈，读屏器才知道筛出了几个节点。
            // 不依赖 matchedSet 是否已算出：有查询词就先给出这一块，避免瞬时为空。
            <span role="status" aria-live="polite" data-testid="legion-3d-search-status"
              className="text-[11px] text-[var(--fg-muted)]">
              匹配 {matchedSet?.size ?? 0} 个节点
            </span>
          )}
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="清空搜索"
              className="rounded-md px-1.5 py-0.5 text-[11px] text-[var(--fg-dim)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]"
            >
              ✕
            </button>
          )}
        </div>
        {noMatch && (
          <p className="mt-1 flex items-center gap-2 text-[11px] text-[var(--fg-muted)]">
            没有匹配的成员或部门
            <button
              type="button"
              onClick={() => setQuery('')}
              className="rounded px-1.5 py-0.5 text-[11px] text-[var(--accent-text)] hover:bg-[var(--hover-tint)]"
            >
              清空搜索
            </button>
          </p>
        )}
        {focus && (
          <button
            type="button"
            onClick={() => { setFocus(null); yawTarget.current = null; }}
            className="pointer-events-auto mt-2 inline-flex items-center gap-2 rounded-full bg-[var(--accent)]/12 px-3 py-1 text-[11px] text-[var(--fg)]"
          >
            <span data-testid="legion-3d-focus">聚焦：{(() => {
              const node = layout.nodes.find(n => n.id === focus);
              if (!node) return '部门';
              // 与 2D 同口径：聚焦/演示时一并报出人数与直属下级。
              const children = layout.nodes.filter(n => n.parentId === node.id && n.kind === 'group').length;
              return `${node.label} · ${node.memberCount} 人 · 下级 ${children}`;
            })()}</span>
            {/* 聚焦路径：深链/巡礼走到下一层部门时，观众需要知道它挂在哪条链上。 */}
            <span data-testid="legion-3d-focus-path" className="text-[10px] text-[var(--fg-dim)]">
              {(() => {
                const node = layout.nodes.find(n => n.id === focus);
                if (!node || node.kind !== 'group') return '';
                const byId = new Map(layout.nodes.map(n => [n.id, n]));
                const chain: string[] = [];
                for (let cur = node.parentId ? byId.get(node.parentId) : undefined; cur && cur.kind !== 'core'; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
                  chain.unshift(cur.label);
                }
                // 顶层部门没有上级：路径就是它自己，和胶囊开头的名字重复
                // （实拍显示成「聚焦：平台 · 1人 · 下级 0 · 平台」）。
                if (!chain.length) return '';
                chain.push(node.label);
                return chain.join(' / ');
              })()}
            </span>
            <span aria-hidden>✕</span>
          </button>
        )}
        {focusMissing && (
          <p role="status" data-testid="legion-3d-focus-missing"
            className="pointer-events-auto mt-2 inline-flex items-center gap-2 rounded-full bg-[var(--danger)]/10 px-3 py-1 text-[11px] text-[var(--danger)]">
            找不到部门「{focusMissing}」——可能已重命名或删除
            <button type="button" onClick={() => setFocusMissing(null)} aria-label="忽略聚焦提示"
              className="text-[var(--fg-muted)] hover:text-[var(--fg)]">✕</button>
          </p>
        )}
        {!loading && layout.stats.people === 0 && layout.stats.groups > 0 && (
          <p role="status" className="mt-1 text-[11px] text-[var(--fg-muted)]" data-testid="legion-3d-empty-members">
            已有 {layout.stats.groups} 个部门，还没有成员加入 —— 成员绑定 Agent 后会自动出现在环上。
            <span className="text-[var(--fg-dim)]">绑定在客户端完成；本页会自动刷新，不用手动重载。</span>
          </p>
        )}
        {hierarchy.data === null && (
          <p className="mt-1 text-[11px] text-[var(--fg-muted)]">
            当前 Hub 没有部门树接口，按部门名扁平分组（升级 Hub 后自动分层次）。
          </p>
        )}
      </div>

      <div
        ref={toolbarRef}
        data-testid="legion-3d-toolbar"
        // 窄屏单行横向滚动：两行工具条会占掉约 90px 高度（实测 390 下顶部合计 ~300px，
        // 视口的 35%），收成一行可以多给画布 ~50px，且不隐藏任何功能。
        // flex 子项默认会收缩：只写 nowrap 会把按钮压到 48px、标签折成两行（实拍）。
        // 用 [&>*]:shrink-0 保持自然宽度，整行横向滚动。
        className="pointer-events-auto flex flex-nowrap items-center gap-1.5 overflow-x-auto pb-0.5 [&>*]:shrink-0 sm:flex-wrap sm:justify-end sm:overflow-visible sm:pb-0"
        onKeyDown={e => {
          // Enter activates the focused control, even when a node is selected.
          if (e.key === 'Enter') e.stopPropagation();
        }}
      >
        <button
          type="button"
          onClick={() => { if (!reducedMotion) setSpin(v => !v); }}
          aria-pressed={spin && !reducedMotion}
          aria-disabled={reducedMotion}
          data-testid="legion-3d-spin"
          className={`max-sm:order-last rounded-md px-2.5 py-1.5 text-xs transition-colors ${spin && !reducedMotion ? 'bg-[var(--accent)]/15 text-[var(--accent-text)]' : 'text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]'}`}
        >
          {reducedMotion ? '自转静止' : spin ? '自转中' : '自转已停'}
        </button>
        <button
          type="button"
          onClick={() => { if (!reducedMotion) setFlow(v => !v); }}
          aria-pressed={flow && !reducedMotion}
          aria-disabled={reducedMotion}
          title="光流仅示意组织连接，不表示节点在线或任务运行；系统减少动态效果时保持静止"
          data-testid="legion-3d-flow"
          className={`min-h-11 rounded-md px-2.5 py-1.5 text-xs transition-colors sm:min-h-0 ${flow && !reducedMotion ? 'bg-[var(--accent)]/15 text-[var(--accent-text)]' : 'text-[var(--fg-muted)] hover:bg-[var(--hover-tint)]'} focus-visible:outline-2 focus-visible:outline-[var(--accent-text)] max-sm:order-last`}
        >
          {reducedMotion ? '光流静止' : flow ? '光流开启' : '光流暂停'}
        </button>
        <button
          type="button"
          onClick={resetView}
          className="max-sm:order-last rounded-md px-2.5 py-1.5 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]"
        >
          重置视角
        </button>
        <button
          type="button"
          data-testid="legion-3d-copy-view"
          onClick={() => void copyViewLink()}
          className="max-sm:order-last rounded-md px-2.5 py-1.5 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]"
        >
          复制视角链接
        </button>
        {shareInfo && (
          <span role="status" data-testid="legion-3d-share-info" className="text-[11px] text-[var(--fg-muted)]">{shareInfo}</span>
        )}
        <button
          type="button"
          onClick={() => {
            setToolsOpen(false);
            setListOpen(v => {
              const next = !v;
              // 收起列表时清掉层级预览：角标不能留在屏幕上却没有对应来源。
              if (!next) applyDepthPreview(null);
              if (next) requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('[role="option"]')?.focus());
              return next;
            });
          }}
          aria-expanded={listOpen}
          aria-controls="legion-3d-node-list"
          data-testid="legion-3d-list-toggle"
          className="rounded-md px-2.5 py-1.5 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]"
        >
          {listOpen ? '收起列表' : '节点列表'}
        </button>
        <button
          ref={toolsToggleRef}
          type="button"
          onClick={() => { setToolsOpen(v => !v); setListOpen(false); }}
          aria-expanded={toolsOpen}
          aria-controls="legion-3d-more-tools"
          data-testid="legion-3d-tools-toggle"
          className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/85 px-2.5 py-1.5 text-xs text-[var(--fg)] hover:bg-[var(--hover-tint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] sm:hidden"
        >
          {toolsOpen ? '收起操作' : '更多操作'}
        </button>
        <div
          id="legion-3d-more-tools"
          role="group"
          aria-label="更多军团操作"
          data-testid="legion-3d-more-tools"
          className={`${toolsOpen ? 'grid' : 'hidden'} basis-full grid-cols-3 gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]/95 p-1.5 sm:contents`}
        >
        <button
          type="button"
          onClick={toggleFullscreen}
          aria-pressed={isFullscreen}
          aria-label={isFullscreen ? '退出全屏' : '全屏查看'}
          data-testid="legion-3d-fullscreen"
          className={`rounded-md px-2.5 py-1.5 text-xs transition-colors ${isFullscreen ? 'bg-[var(--accent)]/15 text-[var(--accent-text)]' : 'text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]'}`}
        >
          {isFullscreen ? '退出全屏' : '全屏'}
        </button>
        <button
          type="button"
          onClick={() => { setToolsOpen(false); setCleanView(true); wrapRef.current?.focus(); }}
          aria-pressed={cleanView}
          aria-label={cleanView ? '恢复界面' : '净屏（隐藏界面）'}
          data-testid="legion-3d-clean"
          className={`rounded-md px-2.5 py-1.5 text-xs transition-colors ${cleanView ? 'bg-[var(--accent)]/15 text-[var(--accent-text)]' : 'text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]'}`}
        >
          {cleanView ? '恢复界面' : '净屏'}
        </button>
        <button
          type="button"
          onClick={togglePresenting}
          aria-pressed={presenting}
          title="隐藏界面、鼠标与悬浮提示，匀速环绕；按 Esc 退出"
          data-testid="legion-3d-present"
          className={`rounded-md px-2.5 py-1.5 text-xs transition-colors ${presenting ? 'bg-[var(--accent)]/15 text-[var(--accent-text)]' : 'text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]'}`}
        >
          演示模式
        </button>
        <button
          type="button"
          onClick={startCapture}
          disabled={capturing}
          title={`录制一圈 16 秒，导出 ${exportHigh ? '1920×1080' : '1280×720'} 无缝循环视频`}
          data-testid="legion-3d-record"
          className="rounded-md px-2.5 py-1.5 text-xs text-[var(--fg-muted)] transition-colors hover:bg-[var(--hover-tint)] hover:text-[var(--fg)] disabled:opacity-60"
        >
          {capturing ? `录屏 ${Math.round(captureProgress * 100)}%` : '导出循环'}
        </button>
        <label
          title="默认 720p（PPT 最稳）；1080p 仅用于其他场合"
          className="flex items-center gap-1 rounded-md px-1.5 py-1.5 text-[10px] text-[var(--fg-muted)]"
        >
          <input
            type="checkbox"
            checked={exportHigh}
            disabled={capturing}
            onChange={event => setExportHigh(event.target.checked)}
            data-testid="legion-3d-export-1080"
            className="h-3.5 w-3.5 accent-[var(--hl)]"
          />
          1080p
        </label>
        <button
          type="button"
          onClick={exportPng}
          disabled={exporting}
          data-testid="legion-3d-export"
          className="rounded-md bg-[var(--bg-elevated)] px-2.5 py-1.5 text-xs text-[var(--fg)] hover:bg-[var(--hover-tint)] disabled:opacity-50"
        >
          {exporting ? '导出中…' : '导出 PNG'}
        </button>
        <Link
          href="/legion/plaza"
          className="flex min-h-11 items-center justify-center rounded-md px-2.5 py-1.5 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)] sm:min-h-0"
        >
          平台视角
        </Link>
        <p className="col-span-3 px-2 py-1 text-[11px] text-[var(--fg-muted)] sm:hidden">净屏后轻点画布恢复，也可按 Esc。</p>
        </div>
        <Link
          href={focus ? `/legion?focus=${encodeURIComponent(layout.nodes.find(n => n.id === focus)?.label || '')}` : '/legion'}
          data-testid="legion-3d-2d"
          className="absolute right-0 top-0 flex min-h-11 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/85 px-2.5 py-1.5 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)] sm:static sm:min-h-0 sm:border-0 sm:bg-transparent"
        >
          2D 视图
        </Link>
      </div>
      </div>

      {helpOpen && (
        <div
          ref={helpRef}
          role="dialog"
          aria-modal="true"
          aria-label="键盘快捷键"
          data-testid="legion-3d-help"
          className="absolute inset-0 z-20 flex items-center justify-center bg-[var(--bg)]/70 p-4"
          onClick={() => setHelpOpen(false)}
        >
          <div className="w-full max-w-sm rounded-xl bg-[var(--bg-secondary)] p-4 text-sm text-[var(--fg)]" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">键盘快捷键</h2>
              <button type="button" onClick={() => setHelpOpen(false)} aria-label="关闭" className="rounded px-1.5 py-0.5 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)]">✕</button>
            </div>
            <dl className="mt-3 space-y-1.5 text-xs text-[var(--fg-muted)]">
              {[
                ['/ 或 Ctrl/⌘+K', '搜索军团成员'],
                ['拖动 / 方向键', '旋转视角'],
                ['滚轮 / 双指 / + -', '缩放'],
                ['点节点', '看详情'],
                ['双击节点 / 回车', 'Agent 页内对话，成员/部门进入列表'],
                ['列表内 ↑ ↓', '移动选中项；回车只选中'],
                ['双击空白', '复位视角'],
                ['? ', '打开/关闭这张表'],
                ['Esc', '先清搜索，再取消选中'],
                ['R', '重置视角'],
                ['F', '全屏演示（再按退出）'],
                ['净屏', '隐藏全部界面（轻点画布或 Esc 恢复）'],
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

      {exportError && (
        <div className="absolute left-1/2 top-16 -translate-x-1/2 rounded-lg bg-[var(--danger)]/12 px-3 py-1.5 text-xs text-[var(--danger)]">
          导出失败：{exportError}
        </div>
      )}

      {/* 底部左：图例与操作提示 */}
      <div ref={footerRef} className={`pointer-events-none absolute bottom-4 left-4 space-y-1 text-[11px] text-[var(--fg-dim)] ${cleanView ? 'invisible' : 'visible'} ${selectedNode ? 'hidden sm:block' : ''}`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {/* 图例即筛选：点一下只看这个状态，再点取消（Esc 也能清）。 */}
          {([
            ['working', '运行中', 'var(--success)'],
            ['idle', '空闲', 'var(--fg-muted)'],
            ['blocked', '阻塞', 'var(--warning)'],
            ['error', '错误', 'var(--danger)'],
            ['offline', '未上报', 'var(--fg-dim)'],
          ] as const).map(([key, label, color]) => {
            const active = statusOnly === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setStatusOnly(active ? null : key)}
                aria-pressed={active}
                data-testid={`legion-3d-filter-${key}`}
                className={`pointer-events-auto inline-flex items-center gap-1.5 rounded px-1 py-0.5 transition-colors ${active ? 'bg-[var(--accent)]/15 text-[var(--fg)]' : 'hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]'}`}
              >
                <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                {label}
                <span className="tabular-nums text-[var(--fg-dim)]">{statusCounts[key]}</span>
              </button>
            );
          })}
        </div>
        <p>拖动环绕 · 滚轮或双指缩放（当前 {zoomPct}%）· 双击 Agent 对话 · / 搜索 · 回车打开选中 · R 重置</p>
        <p className="text-[var(--fg-muted)]">光流示意组织连接，节点状态以图例为准。</p>
      </div>

      {/* 键盘/读屏的节点列表：canvas 不可 Tab，靠这张列表选节点 */}
      {listOpen && (
        <div
          ref={listRef}
          id="legion-3d-node-list"
          role="listbox"
          aria-label="军团节点（方向键/Tab 浏览，回车选中）"
          onKeyDown={(e) => {
            // 列表内方向键移动焦点（标准 listbox 行为），避免几十次 Tab。
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            const items = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="option"]')];
            const i = items.indexOf(document.activeElement as HTMLElement);
            const next = items[Math.min(items.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
            if (next) { e.preventDefault(); next.focus(); }
          }}
          data-testid="legion-3d-node-list"
          style={{ maxHeight: 'min(52vh, calc(100% - var(--legion-list-top, 11rem) - 12px))' }}
          className={`absolute left-3 top-[var(--legion-list-top,11rem)] z-10 w-64 overflow-y-auto rounded-xl bg-[var(--bg-secondary)]/96 p-1.5 text-xs shadow-lg backdrop-blur sm:block ${cleanView ? 'invisible' : 'visible'} ${listOpen ? 'block' : 'hidden'}`}
        >
          <label className="mb-1 flex items-center gap-1.5 rounded px-1.5 py-1 text-[10px] text-[var(--fg-muted)]">
            <input
              type="checkbox"
              data-testid="legion-3d-list-depts-only"
              checked={listDeptsOnly}
              onChange={e => toggleDeptsOnly(e.target.checked)}
              className="h-3 w-3"
            />
            只列部门与圆心
          </label>
          {(() => {
            const baseAll = layout.nodes
              // 小网络里把 Agent 也列出来：键盘用户才可以直接走到 Agent 详情页。
              .filter(n => n.kind === 'core' || n.kind === 'group' || layout.stats.people <= LEGION_LABEL_PEOPLE)
              .filter(n => !listDeptsOnly || n.kind === 'core' || n.kind === 'group');
            const qAll = query.trim().toLowerCase();
            const shownAll = qAll ? baseAll.filter(n => (n.label || '').toLowerCase().includes(qAll)) : baseAll;
            if (shownAll.length > 0) return null;
            // 与 2D 同口径：空列表要说清是搜索没命中，还是被「只列部门」挡住了。
            return (
              <p data-testid="legion-3d-list-empty-hint" className="px-2 py-2 text-[10px] leading-relaxed text-[var(--fg-muted)]">
                {listDeptsOnly ? '当前只列部门，可能被这个筛选挡住了。' : '没有匹配的节点。'}
                {listDeptsOnly && (
                  <button type="button" onClick={() => toggleDeptsOnly(false)} className="ml-1 underline hover:text-[var(--fg)]">
                    取消只列部门
                  </button>
                )}
              </p>
            );
          })()}
          {(() => {
            const base = layout.nodes
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
                onFocus={e => {
                  applyDepthPreview(n.kind === 'group' ? Math.max(1, n.depth ?? 1) : null);
                  // 列表有最大高度：方向键往下走时，焦点会跑到看不见的地方。
                  // 滚动到可见（nearest 不会把整页带动）。
                  e.currentTarget.scrollIntoView({ block: 'nearest' });
                }}
                onMouseEnter={() => applyDepthPreview(n.kind === 'group' ? Math.max(1, n.depth ?? 1) : null)}
                onBlur={() => applyDepthPreview(null)}
                ref={el => { if (selected === n.id && el) el.scrollIntoView({ block: 'nearest' }); }}
                onClick={() => {
                  // 已经选中过 → 再点一次就是打开（与「回车两次」一致）
                  if (selected === n.id) openNode(n);
                  else pickNode(n);
                }}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--hl)] focus-visible:outline-offset-1 ${
                  selected === n.id
                    ? 'bg-[var(--accent)]/15 text-[var(--accent-text)]'
                    : 'text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]'
                }`}
              >
                <span className="w-8 shrink-0 text-[11px] text-[var(--fg-dim)]">{KIND_LABEL[n.kind]}</span>
                <span className="truncate">{n.label}</span>
                {/* 列表里直接给规模：挑部门时不必先点开看详情，也免得「平台」和「平台2组」看起来一样大。 */}
                <span className="ml-auto shrink-0 tabular-nums text-[10px] text-[var(--fg-dim)]" data-testid={`legion-3d-list-facts-${n.id}`}>
                  {n.kind === 'group'
                    ? `${n.memberCount} 人 · ${layout.nodes.filter(x => x.parentId === n.id && x.kind === 'group').length} 下级`
                    : n.kind === 'core'
                      ? ''
                      : `${n.agentCount} Agent`}
                </span>
              </button>
            ))}
          {layout.stats.people > LEGION_LABEL_PEOPLE && (
            <p className="px-2 py-1 text-[11px] text-[var(--fg-dim)]">成员超过 60，列表只列部门与核心（避免上百个 Tab 停点）；找成员请用搜索或点画布。</p>
          )}
        </div>
      )}

      {/* 大网络提示：节点多时给一条可关掉的建议，不挡图 */}
      {!hintDismissed && layout.nodes.length > 120 && (
        <div className={`pointer-events-auto absolute bottom-16 left-1/2 max-w-[94vw] -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-lg bg-[var(--bg-secondary)]/92 px-3 py-0 text-[11px] sm:py-1 text-[var(--fg-muted)] backdrop-blur sm:bottom-6 ${selectedNode || cleanView ? 'hidden' : 'hidden sm:flex'}`} data-testid="legion-3d-scale-hint">
          <span>规模较大 · {layout.nodes.length} 节点 · 试试搜索或部门聚焦</span>
          <button
            type="button"
            onClick={() => {
              setHintDismissed(true);
              try { sessionStorage.setItem('legion3d-hint-dismissed', '1'); } catch {}
            }}
            aria-label="关闭提示"
            className="shrink-0 rounded px-1 text-[var(--fg-dim)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]"
          >
            ✕
          </button>
        </div>
      )}

      {/* 选中节点详情 */}
      {selectedNode && (
        <div
          data-testid="legion-3d-detail"
          role="status"
          aria-live="polite"
          className={`absolute inset-x-3 bottom-3 rounded-xl bg-[var(--bg-secondary)]/95 p-3 backdrop-blur sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-72 ${cleanView ? 'invisible' : 'visible'} ${listOpen || toolsOpen ? 'hidden sm:block' : 'block'}`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[11px] text-[var(--fg-dim)]">{KIND_LABEL[selectedNode.kind]}{path.length > 0 ? ` · ${path.join(' / ')}` : ''}</p>
              <div className="mt-0.5 flex items-start gap-2">
                <p className="min-w-0 flex-1 [overflow-wrap:anywhere] text-sm font-semibold text-[var(--fg)]">{selectedNode.label}</p>
                <button
                  type="button"
                  onClick={() => {
                    // 复制的是「能直接发人的地址」，不是光秃秃一个名字 ——
                    // 收到链接的人打开就落在同一个节点上（?node= 由本页读取）。
                    const params = new URLSearchParams(window.location.search);
                    params.set('node', selectedNode.label);
                    const share = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
                    void navigator.clipboard?.writeText(share).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1200);
                    }).catch(() => {});
                  }}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]"
                  aria-label={`复制 ${selectedNode.label} 的分享链接`}
                  data-testid="legion-3d-copy"
                >
                  {copied ? '已复制' : '复制链接'}
                </button>
              </div>
              {selectedNode.kind === 'group' && (
                <p className="mt-1 text-[11px] text-[var(--fg-muted)]">
                  {selectedNode.leader ? `负责人 ${selectedNode.leader} · ` : '未设负责人 · '}
                  {selectedNode.memberCount} 人（含下级） · {selectedNode.agentCount} Agent · 第 {selectedNode.depth} 层
                </p>
              )}
              {selectedNode.kind === 'person' && (
                <p className="mt-1 text-[11px] text-[var(--fg-muted)]">名下 {selectedNode.agentCount} 个 Agent</p>
              )}
              {selectedNode.kind === 'agent' && (
                <p className="mt-1 text-[11px] text-[var(--fg-muted)]">
                  {statusByAlias.get(selectedNode.label) ?? '未上报状态'}
                </p>
              )}
              {selectedNode.kind === 'core' && (
                <p className="mt-1 text-[11px] text-[var(--fg-muted)]">
                  {layout.stats.people} 名成员 · {layout.stats.agents} 个 Agent
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                // 详情面板会整体卸载；不接管焦点就掉回 body，键盘用户凭空消失。
                // 回到画布（tabIndex=-1，键盘仍可继续环绕/缩放）。
                restoreFocusAfterUnmount(() => canvasRef.current);
                setSelected(null);
              }}
              aria-label="关闭详情"
              className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-[var(--fg-dim)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]"
            >
              ✕
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            {selectedNode.kind !== 'group' && ancestorDept && (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  setFocus(ancestorDept.id);
                  if (ancestorDept.kind !== 'core') {
                    let delta = ancestorDept.angle - viewRef.current.yaw;
                    while (delta > Math.PI) delta -= Math.PI * 2;
                    while (delta < -Math.PI) delta += Math.PI * 2;
                    yawTarget.current = viewRef.current.yaw + delta;
                  }
                }}
                className="rounded-md px-2 py-1 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]"
              >
                聚焦所在部门
              </button>
            )}
          {selectedNode.kind === 'group' && (
            <button
              type="button"
              onClick={() => {
                const next = focus === selectedNode.id ? null : selectedNode.id;
                if (next && query) setQuery('');
                setFocus(next);
                // 聚焦时把镜头转到该部门所在的扇区（yaw = 节点角度，最短路径）。
                if (next) {
                  const target = selectedNode.angle;
                  let delta = target - viewRef.current.yaw;
                  while (delta > Math.PI) delta -= Math.PI * 2;
                  while (delta < -Math.PI) delta += Math.PI * 2;
                  yawTarget.current = viewRef.current.yaw + delta;
                } else {
                  yawTarget.current = null;
                }
              }}
              className="mt-2 mr-3 rounded-md px-2 py-1 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]"
            >
              {focus === selectedNode.id ? '取消聚焦' : '聚焦此部门'}
            </button>
          )}
            {selectedNode.kind === 'agent' && (
              <button type="button" onClick={() => openNode(selectedNode)} data-testid="legion-3d-chat"
                onKeyDown={e => e.stopPropagation()}
                className="min-h-11 rounded-md px-3 text-xs text-[var(--accent-text)] hover:bg-[var(--hover-tint)]">开始对话</button>
            )}
            {(selectedNode.kind === 'person' || selectedNode.kind === 'group') && (
              <Link
                href={detailHref}
                className="inline-flex items-center gap-1 text-xs text-[var(--accent-text)] hover:underline"
              >
                在部门列表里看 →
              </Link>
            )}
          </div>
        </div>
      )}

      {chatAlias && networkReady && networkId && !fatal && (
        <LegionChat key={`${networkId}:${chatAlias}`} alias={chatAlias} networkId={networkId}
          onClose={() => { setChatAlias(null); lastInteract.current = performance.now(); }} />
      )}

      {/* 三态：只在真·空/真·错时覆盖画布，不用空态掩盖故障 */}
      {fatal === 'no-network' && (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg)]/92 px-6">
          <NetworkRequiredNotice className="max-w-md" />
        </div>
      )}
      {fatal === 'login' && (
        <div role="alert" className="absolute inset-0 flex items-center justify-center bg-[var(--bg)]/92 px-6 text-center">
          <p className="text-sm text-[var(--warning)]">
            会话已过期，<Link href="/login" className="underline">重新登录</Link> 后再看军团。
          </p>
        </div>
      )}
      {fatal === 'error' && (
        <div role="alert" className="absolute inset-0 flex items-center justify-center bg-[var(--bg)]/92 px-6">
          <div className="max-w-sm text-center">
            <p className="text-sm text-[var(--danger)]">读取军团编制失败：{readError?.message ?? '未知错误'}</p>
            <button
              type="button"
              onClick={() => { void people.mutate(); void hierarchy.mutate(); void status.mutate(); }}
              className="mt-3 rounded-md bg-[var(--bg-elevated)] px-3 py-1.5 text-xs text-[var(--fg)] hover:bg-[var(--hover-tint)]"
            >
              重试
            </button>
          </div>
        </div>
      )}
      {isEmpty && (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg)]/92 px-6">
          <EmptyState
            variant="nodes"
            title="军团还没有成员"
            sub="成员加入网络并绑定 Agent 后，这里会自动长出三维编制。"
            cta={{ label: '去部门列表', href: '/org' }}
          />
        </div>
      )}
    </div>
  );
}
