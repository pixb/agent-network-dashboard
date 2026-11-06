/**
 * 界面密度（对齐客户端「设置 → 界面密度」）。
 *
 * 与字号是**两个独立开关**（客户端 src/ui-scale.ts 的约定）：密度只改行高与
 * 上下内边距，不改 font-size —— 字体大小要更大请用浏览器缩放/系统设置。
 *
 * 生效方式：`<html data-density="compact|comfortable">`，标准档不写属性，
 * 由 globals.css 里三条针对性的规则覆盖行内边距。之所以不改成 CSS 变量：
 * 这些行高来自 Tailwind 的 py-* / min-h-* 类，变量接不进去；只覆盖这三处
 * 高频列表（侧栏导航 / 节点列表 / 需求列表）是可控且可断言的。
 */
import { useSyncExternalStore } from 'react';

export type DensityPref = 'compact' | 'standard' | 'comfortable';

export const DENSITY_STORAGE_KEY = 'anet-density';

export const DENSITY_OPTIONS: readonly { key: DensityPref; label: string; hint: string }[] = [
  { key: 'compact', label: '紧凑', hint: '列表与侧栏更密，一屏看更多' },
  { key: 'standard', label: '标准', hint: '默认' },
  { key: 'comfortable', label: '宽松', hint: '行更高，触屏更好点' },
];

export function readDensity(): DensityPref {
  if (typeof window === 'undefined') return 'standard';
  try {
    const v = window.localStorage.getItem(DENSITY_STORAGE_KEY);
    return v === 'compact' || v === 'comfortable' ? v : 'standard';
  } catch {
    return 'standard';
  }
}

const DENSITY_EVENT = 'anet-density-change';

export function applyDensity(pref: DensityPref): void {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  if (pref === 'standard') el.removeAttribute('data-density');
  else el.setAttribute('data-density', pref);
  // 同一标签页内其它组件（例如头像尺寸）也要立刻跟着变；storage 事件只在别的标签页触发。
  window.dispatchEvent(new Event(DENSITY_EVENT));
}

function subscribeDensity(onChange: () => void): () => void {
  window.addEventListener(DENSITY_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(DENSITY_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

/**
 * 组件里读当前密度；切档时自动重渲染。
 *
 * 用 `useSyncExternalStore` 而不是 `useEffect` + `setState`：后者会被仓库的
 * `react-hooks/set-state-in-effect` 规则拦下（也确实会多一次级联渲染）。
 * 快照是字符串，直接读 localStorage 不会造成无限循环。
 */
export function useDensity(): DensityPref {
  return useSyncExternalStore(subscribeDensity, readDensity, () => 'standard' as DensityPref);
}

/** 头像尺寸随密度变化（与客户端一致：密度会缩放 AliasAvatar，不只是行高）。 */
export function densityAvatarSize(pref: DensityPref, standard = 32): number {
  if (pref === 'compact') return Math.round(standard * 0.82);
  if (pref === 'comfortable') return Math.round(standard * 1.15);
  return standard;
}
