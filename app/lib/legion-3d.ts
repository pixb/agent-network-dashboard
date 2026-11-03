/**
 * 军团 3D —— 把 2D 极坐标编制（legion-layout.ts）抬成三层轨道塔。
 *
 * 为什么要单独一层纯函数：
 *   3D 里「看起来对」比 2D 更容易骗人 —— 一个点画在左边，你没法从截图
 *   判断它是真的投影正确，还是旋转矩阵写错了某个符号。所以旋转、透视、
 *   深度排序、命中测试全部在这里算，组件只负责把结果画出来；断言在
 *   legion-3d.test.mjs 里钉住。
 *
 * 坐标约定（右手系，y 向上）：
 *   - 场景平面 x/z 复用 2D 布局的 x/y（单位 1 = 最外环半径）；
 *   - 高度 y 按环递减：圆心最高，部门 → 成员 → Agent 逐层下沉，
 *     从斜上方看是一叠错开的轨道，而不是一张贴平的饼图；
 *   - 相机在 +z 方向，yaw 绕 y 轴、pitch 绕 x 轴，先 yaw 后 pitch。
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Camera3D {
  /** 绕 y 轴旋转（弧度）。0 = 不转。 */
  yaw: number;
  /** 俯仰（弧度）。0 = 平视，Math.PI / 2 = 正俯视。 */
  pitch: number;
  /** 相机到原点的距离（场景单位）。 */
  dist: number;
  /** 焦距（像素）。通常取画布短边的一部分。 */
  focal: number;
  /** 投影中心（像素）。默认画布中心；缩放锚定鼠标时由页面传入偏移。 */
  cx?: number;
  cy?: number;
}

export interface ProjectedPoint {
  x: number;
  y: number;
  /** 透视缩放系数，用于算节点半径 / 标签字号。 */
  scale: number;
  /** 相机空间深度（越大越远）。排序与雾化都用它。 */
  depth: number;
}

/** 每层的高度（场景单位）。ring 0 = 圆心。 */
export const RING_HEIGHT: Record<number, number> = {
  0: 0,
  1: -0.18,
  2: -0.72,
  3: -1.0,
};

/** 节点在环上的微小高度抖动：让同一环不是一张绝对平的薄片。
 *  确定性（按 order 取正弦），同一份输入永远得到同一张图。 */
export function jitterHeight(order: number, ring: number): number {
  if (ring === 0) return 0;
  return Math.sin(order * 1.7) * 0.035;
}

/** 部门每深一层下沉多少：一级部门留在环高度上，子部门依次往下。
 *  12 个部门的生产密度里，父子部门原本压在同一张平面上，只能靠半径区分，
 *  看起来是一圈薄片；分层下沉之后才真的像一张三维编制图。 */
export const DEPTH_STEP = 0.36;

/** 部门层级的垂直偏移（非部门节点恒为 0，最多下沉两级）。 */
export function depthDrop(kind?: string, depth?: number): number {
  if (kind !== 'group' || !depth || depth < 2) return 0;
  return -Math.min(depth - 1, 2) * DEPTH_STEP;
}

/** 2D 布局节点 → 3D 坐标。x/z 用平面坐标，y 用环高度 + 部门层级 + 抖动。 */
export function nodeToVec3(
  node: { x: number; y: number; ring: number; order: number; kind?: string; depth?: number },
  scale = 1,
): Vec3 {
  return {
    x: node.x * scale,
    y: (RING_HEIGHT[node.ring] ?? 0) + depthDrop(node.kind, node.depth) + jitterHeight(node.order, node.ring),
    z: node.y * scale,
  };
}

/** 父部门 → 子部门这条线在屏幕上下垂多少像素。
 *  楼层化之后父子部门本来就有高度差，但镜头一斜，这条边和成员线几乎平行地混在
 *  一起；按「层数 + 端点屏幕落差」给控制点加一点下垂，连线才读得出「向下掉了一层」。
 *  非部门之间、同级部门之间返回 0（成员/Agent 连线保持原样）。 */
export function dropSag(fromDepth?: number, toDepth?: number, screenGap = 0): number {
  if (fromDepth == null || toDepth == null || fromDepth === toDepth) return 0;
  const tiers = Math.abs(toDepth - fromDepth);
  return Math.min(30, 10 * tiers + Math.abs(screenGap) * 0.25);
}

/** 单个 3D 点 → 屏幕坐标。相机背后（depth <= 0.05）返回 null。 */
export function projectPoint(
  p: Vec3,
  cam: Camera3D,
  size: { width: number; height: number },
): ProjectedPoint | null {
  const cosY = Math.cos(cam.yaw);
  const sinY = Math.sin(cam.yaw);
  const x1 = p.x * cosY - p.z * sinY;
  const z1 = p.x * sinY + p.z * cosY;

  const cosP = Math.cos(cam.pitch);
  const sinP = Math.sin(cam.pitch);
  const y2 = p.y * cosP - z1 * sinP;
  const z2 = p.y * sinP + z1 * cosP;

  // 相机在 +z 侧、看向 -z：z2 越大越靠近相机，所以深度是 dist - z2。
  const depth = cam.dist - z2;
  if (!Number.isFinite(depth) || depth <= 0.05) return null;

  const scale = cam.focal / depth;
  const cx = cam.cx ?? size.width / 2;
  const cy = cam.cy ?? size.height / 2;
  return {
    x: cx + x1 * scale,
    y: cy - y2 * scale,
    scale,
    depth,
  };
}

export interface SceneNode<T> {
  item: T;
  point: Vec3;
  projected: ProjectedPoint;
}

/**
 * 整场景投影 + 远→近排序。画家算法在这里够用：节点之间不重叠成
 * 互相穿插的实体，先画远的再画近的就不会被盖穿。
 */
export function projectScene<T>(
  items: T[],
  toPoint: (item: T) => Vec3,
  cam: Camera3D,
  size: { width: number; height: number },
): Array<SceneNode<T>> {
  const out: Array<SceneNode<T>> = [];
  for (const item of items) {
    const point = toPoint(item);
    const projected = projectPoint(point, cam, size);
    if (projected) out.push({ item, point, projected });
  }
  out.sort((a, b) => b.projected.depth - a.projected.depth);
  return out;
}

export interface ScreenAxes { rx: number; ry: number }
export type FramingBody = { x: number; y: number } & (ScreenAxes | { radius: number });

/** One department shape for paint, feedback, picking and label/framing bounds. */
/** 部门盘的最小半宽（屏幕像素）与扁率：0.42 在小半径上会变成一条细缝，
 *  子部门看不见是「盘」，只是一道灰弧；0.52 仍比一级部门薄，但读得出是部门。 */
export const DEPT_DISC_MIN_RX = 16;
export const DEPT_DISC_ASPECT = 0.52;

export function departmentDisc(radius: number): ScreenAxes {
  const rx = Math.max(DEPT_DISC_MIN_RX, 2.1 * radius);
  return { rx, ry: DEPT_DISC_ASPECT * rx };
}

function bodyBounds(bodies: ReadonlyArray<FramingBody>) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const body of bodies) {
    const rx = 'rx' in body ? body.rx : body.radius;
    const ry = 'ry' in body ? body.ry : body.radius;
    minX = Math.min(minX, body.x - rx);
    maxX = Math.max(maxX, body.x + rx);
    minY = Math.min(minY, body.y - ry);
    maxY = Math.max(maxY, body.y + ry);
  }
  return { minX, maxX, minY, maxY };
}

/** Fit bodies and complete orbits clear of controls. A projector recomputes
 * pixel minima and fixed-width strokes at the final zoom, with the old pan. */
export function fitProjectedBodies(
  bodies: ReadonlyArray<FramingBody> | ((zoom: number) => ReadonlyArray<FramingBody>),
  view: { zoom: number; panX: number; panY: number },
  size: { width: number; height: number },
  bounds: { x1: number; y1: number; x2: number; y2: number },
  limits: { min: number; max: number },
): { zoom: number; panX: number; panY: number } | null {
  const initial = typeof bodies === 'function' ? bodies(view.zoom) : bodies;
  if (!initial.length || view.zoom <= 0 || bounds.x2 <= bounds.x1 || bounds.y2 <= bounds.y1) return null;
  // 短轴密度的目标占比。原来是 0.82，画布四周留白偏多、投屏时图显得小；
  // 0.90 仍留出标签与图例的空间（fitBounds 已经把标题/工具栏/图例扣掉）。
  // 0.90 → 0.94：实测 1440 演示态填充 0.740 → 0.772、390 0.312 → 0.326，
  // 且内容包围盒仍完整落在画布内（1440 四边留白 373/89/336/116，390 为 58/280/43/289）。
  // 再往上（0.96+）边际收益变小、边缘标签更容易放不下，故停在这里。
  const target = Math.min(bounds.x2 - bounds.x1, bounds.y2 - bounds.y1) * 0.94;
  if (typeof bodies === 'function') {
    // Extents are monotonic in zoom for a fixed orientation. Binary search
    // handles the 16px disc floor without pretending that it scales down.
    let low = limits.min, high = limits.max;
    for (let i = 0; i < 24; i++) {
      const mid = (low + high) / 2;
      const b = bodyBounds(bodies(mid));
      if (Math.max(b.maxX - b.minX, b.maxY - b.minY) <= target) low = mid;
      else high = mid;
    }
    const b = bodyBounds(bodies(low));
    if (b.maxX - b.minX > bounds.x2 - bounds.x1 || b.maxY - b.minY > bounds.y2 - bounds.y1) return null;
    return { zoom: low,
      panX: (bounds.x1 + bounds.x2 - b.minX - b.maxX) / 2 + view.panX,
      panY: (bounds.y1 + bounds.y2 - b.minY - b.maxY) / 2 + view.panY };
  }
  const { minX, maxX, minY, maxY } = bodyBounds(initial);
  const scale = target / Math.max(1, maxX - minX, maxY - minY);
  const zoom = Math.min(limits.max, Math.max(limits.min, view.zoom * scale));
  const k = zoom / view.zoom;
  return {
    zoom,
    panX: (bounds.x1 + bounds.x2 - size.width) / 2 - ((minX + maxX - size.width) / 2 - view.panX) * k,
    panY: (bounds.y1 + bounds.y2 - size.height) / 2 - ((minY + maxY - size.height) / 2 - view.panY) * k,
  };
}

/**
 * 命中测试：屏幕点周围 radius 像素内、**离相机最近**的那个节点。
 * 传的是已排序（远→近）的数组，所以从后往前找第一个命中即可。
 */
export function hitTest<T>(
  nodes: Array<SceneNode<T>>,
  x: number,
  y: number,
  radius: number,
  // 节点自身的屏幕半径：核心/部门直径 40–60px，只按固定 18px 判会「看得见点不着」。
  radiusOf?: (node: SceneNode<T>) => number | ScreenAxes,
): SceneNode<T> | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    const shape = radiusOf?.(n) ?? radius;
    const rx = Math.max(radius, typeof shape === 'number' ? shape : shape.rx);
    const ry = Math.max(radius, typeof shape === 'number' ? shape : shape.ry);
    const dx = n.projected.x - x;
    const dy = n.projected.y - y;
    if ((dx / rx) ** 2 + (dy / ry) ** 2 <= 1) return n;
  }
  return null;
}

/** 深度雾化系数：0 = 最近（最实），1 = 最远（最淡）。 */
export function fog(depth: number, near: number, far: number): number {
  if (far <= near) return 0;
  const t = (depth - near) / (far - near);
  return Math.min(1, Math.max(0, t));
}

/** 画一圈参考轨道：给定半径与高度，采样 segments 个点后投影。 */
export function ringPath(
  radius: number,
  height: number,
  cam: Camera3D,
  size: { width: number; height: number },
  segments = 96,
): Array<{ x: number; y: number; depth: number }> {
  const points: Array<{ x: number; y: number; depth: number }> = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const p = projectPoint({ x: Math.sin(a) * radius, y: height, z: Math.cos(a) * radius }, cam, size);
    if (p) points.push({ x: p.x, y: p.y, depth: p.depth });
  }
  return points;
}
