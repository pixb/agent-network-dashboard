/**
 * 军团 3D 配色（深空冷光 / 暖金仪式感）。
 *
 * 为什么做成设置项而不是写死：两种取向的差别是**品牌级审美选择**
 * （暖金会偏离客户端 accent 的蓝 family），应由使用者决定，不该由改动者
 * 单方面拍板。默认仍是深空冷光，行为与 `.392` 完全一致。
 *
 * 作用面仅限 3D 画布的**深色且非演示模式**（见 page.tsx 的 fxOn 门闩）；
 * 浅色主题与演示模式有各自已调好的配色，不受此开关影响。
 */
import { useSyncExternalStore } from 'react';

export type LegionPalette = 'deep' | 'warm';

export const LEGION_PALETTE_KEY = 'anet-legion-palette';
const PALETTE_EVENT = 'anet-legion-palette-change';

export const PALETTE_OPTIONS: readonly { key: LegionPalette; label: string; hint: string }[] = [
  { key: 'deep', label: '深空冷光', hint: '近黑冷底 + 蓝 family 强调色（默认）' },
  { key: 'warm', label: '暖金仪式感', hint: '暖褐底 + 琥珀金骨架' },
];

export function readLegionPalette(): LegionPalette {
  if (typeof window === 'undefined') return 'deep';
  try {
    return window.localStorage.getItem(LEGION_PALETTE_KEY) === 'warm' ? 'warm' : 'deep';
  } catch {
    return 'deep';
  }
}

export function applyLegionPalette(pref: LegionPalette): void {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  el.setAttribute('data-legion-palette', pref);
  window.dispatchEvent(new Event(PALETTE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(PALETTE_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(PALETTE_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

export function useLegionPalette(): LegionPalette {
  return useSyncExternalStore(subscribe, readLegionPalette, () => 'deep' as LegionPalette);
}
