// Settings information architecture — data separated from the page so the
// ordering invariant and the "no dead links" invariant can be asserted in
// tests (a settings page shipped with a link to a non-existent route before).
//
// Group order mirrors the desktop client's `src/settings-model.ts`
// (账号 → 用户管理 → Agent 组织架构 → 本地 Hub → 外观 → 通知 → 快捷键 → 关于).
// Dashboard only ships the groups it can back with real data; 通知 / 语音输入 /
// 快捷键 三组客户端有、Dashboard 没有对应能力，不画假开关。

export interface SettingsSection {
  /** DOM anchor id, also the `data-settings-group` value. */
  id: string;
  label: string;
}

export interface SettingsLink {
  href: string;
  title: string;
  desc: string;
  action: string;
  /** 'team' → 成员与组织组；'resource' → 资源组。 */
  group: 'team' | 'resource';
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: 'account', label: 'Account' },
  { id: 'connection', label: 'Connection' },
  { id: 'team', label: 'Team' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'resources', label: 'Resources' },
  { id: 'about', label: 'About' },
];

export const SETTINGS_LINKS: SettingsLink[] = [
  { href: '/admin', title: 'Members & access', desc: '成员、可访问的 Agent 与授权。', action: 'Manage', group: 'team' },
  { href: '/org', title: 'Organization', desc: '部门层级、负责人与编制；也可以看军团图。', action: 'Open', group: 'team' },
  { href: '/settings/tokens', title: 'API Tokens', desc: 'Create and manage tokens for CLI access.', action: 'Manage', group: 'resource' },
  { href: '/settings/networks', title: 'Networks', desc: 'Create, manage, and delete agent networks.', action: 'Manage', group: 'resource' },
  { href: '/providers', title: 'Model Providers', desc: 'Configure model providers and per-server reachability.', action: 'Manage', group: 'resource' },
  { href: '/messages', title: 'Messages', desc: 'Global timeline of CommHub messages across all agents.', action: 'Open', group: 'resource' },
  { href: '/logs', title: 'Audit Log', desc: 'Authentication, token rotations, and admin actions.', action: 'Open', group: 'resource' },
  { href: '/server-logs', title: 'Server Logs', desc: 'Live stdout / stderr from the CommHub server.', action: 'Open', group: 'resource' },
];

export const SETTINGS_THEMES = [
  { id: 'cyber', label: 'Dark', swatch: '#0b0b0d' },
  { id: 'light', label: 'Light', swatch: '#f6f7f9' },
  { id: 'slack', label: 'Slack', swatch: '#3f0e40' },
  // 与客户端对齐：跟随操作系统的明暗偏好（web 走 prefers-color-scheme）。
  { id: 'system', label: 'System', swatch: 'linear-gradient(135deg,#0b0b0d 0 50%,#f6f7f9 50% 100%)' },
] as const;

/** Client-aligned group order. Kept as a literal so a reorder is a test failure. */
export const SETTINGS_GROUP_ORDER = ['account', 'connection', 'team', 'appearance', 'resources', 'about'];
