/**
 * 桌面通知（Web Notifications）—— 对齐客户端「通知设置」的最小实现。
 *
 * 设计约束（都是刻意的）：
 *  1. **默认关闭**：不改任何人的现有体验；只有在设置页显式开启并授权后才生效。
 *  2. **只在页面不可见时提示**：用户正盯着 Dashboard 时，再弹一条系统通知是干扰。
 *  3. **不引入 Hub 契约**：只消费已有的 SSE 事件，不需要订阅表/推送令牌。
 *  4. 纯函数决定「要不要弹、弹什么」，方便单测；副作用（Notification 构造）留在调用处。
 */

export const NOTIFY_STORAGE_KEY = 'anet-desktop-notify';

/** 会触发系统通知的事件类型（与聊天面板消费的类型一致）。 */
const NOTIFY_TYPES = new Set(['new_task', 'new_message', 'new_reply', 'broadcast']);

export interface NotifyMessage {
  title: string;
  body: string;
  tag: string;
}

export interface NotifyContext {
  /** 用户在设置里是否开启 */
  enabled: boolean;
  /** 浏览器权限是否已授予 */
  permission: 'default' | 'denied' | 'granted';
  /** 页面是否不可见（后台标签/最小化） */
  hidden: boolean;
  /** 当前活动会话的 alias（用来跳过自己发出的消息） */
  selfAlias?: string | null;
}

function str(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * 决定这条 SSE 事件是否值得弹系统通知；值得就给出文案。
 * 返回 null 表示不弹。
 */
export function notificationFor(event: Record<string, unknown> | null | undefined, ctx: NotifyContext): NotifyMessage | null {
  if (!event) return null;
  if (!ctx.enabled || ctx.permission !== 'granted' || !ctx.hidden) return null;
  const type = typeof event.type === 'string' ? event.type : '';
  if (!NOTIFY_TYPES.has(type)) return null;

  // 自己发出的消息不提示（Dashboard 以「发给某个 Agent 的任务」为载体）。
  const from = str(event.from_name, 40);
  if (ctx.selfAlias && from && from === ctx.selfAlias) return null;

  const to = str(event.to_name, 40);
  const body = str(event.content, 120) || str(event.result, 120);
  if (!body) return null;

  const title = from && to ? `${from} → ${to}` : from || to || 'Agent Network';
  const id = str(event.task_id, 80);
  return { title: `Agent Network · ${title}`, body, tag: id || `anet-${type}` };
}

/** 读取用户开关；任何异常都按「关闭」处理。 */
export function readNotifyPreference(storage: Pick<Storage, 'getItem'> | null | undefined): boolean {
  try {
    return storage?.getItem(NOTIFY_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** 写入用户开关；失败不抛（隐私模式下 localStorage 可能不可用）。 */
export function writeNotifyPreference(storage: Pick<Storage, 'setItem'> | null | undefined, enabled: boolean): boolean {
  try {
    storage?.setItem(NOTIFY_STORAGE_KEY, enabled ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}
