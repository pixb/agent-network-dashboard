/**
 * 字号缩放（对齐客户端「设置 → 字体大小」）。
 *
 * 与「界面密度」是两个独立开关（客户端 src/ui-scale.ts 的约定）：
 * 密度改行高/间距，字号只改文字。这里通过 `[data-font]` + `--font-scale`
 * 只覆盖**排版类**（Tailwind 的 text-* 与项目里的 text-[11px]/[12px]），
 * 不碰 padding、gap、行高以外的尺寸，所以不会像直接缩放根字号那样
 * 连带改变整个布局的间距。
 *
 * 行高参与虚拟化计算的列表（节点列表）会按同一倍率放大行高，
 * 否则 xlarge 下文字会被固定行高裁掉 —— 那才是真正的「改了但坏了」。
 */
import { useSyncExternalStore } from 'react';

export type FontScalePref = 'small' | 'standard' | 'large' | 'xlarge';

export const FONT_STORAGE_KEY = 'anet-font-scale';
const FONT_EVENT = 'anet-font-scale-change';

export const FONT_OPTIONS: readonly { key: FontScalePref; label: string; scale: number }[] = [
  { key: 'small', label: '小', scale: 0.9 },
  { key: 'standard', label: '标准', scale: 1 },
  { key: 'large', label: '大', scale: 1.15 },
  { key: 'xlarge', label: '特大', scale: 1.3 },
];

export function fontScaleOf(pref: FontScalePref): number {
  return FONT_OPTIONS.find(o => o.key === pref)?.scale ?? 1;
}

export function readFontScale(): FontScalePref {
  if (typeof window === 'undefined') return 'standard';
  try {
    const v = window.localStorage.getItem(FONT_STORAGE_KEY);
    return FONT_OPTIONS.some(o => o.key === v) ? (v as FontScalePref) : 'standard';
  } catch {
    return 'standard';
  }
}

export function applyFontScale(pref: FontScalePref): void {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  if (pref === 'standard') {
    el.removeAttribute('data-font');
    el.style.removeProperty('--font-scale');
  } else {
    el.setAttribute('data-font', pref);
    el.style.setProperty('--font-scale', String(fontScaleOf(pref)));
  }
  window.dispatchEvent(new Event(FONT_EVENT));
}

function subscribeFontScale(onChange: () => void): () => void {
  window.addEventListener(FONT_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(FONT_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

export function useFontScale(): FontScalePref {
  return useSyncExternalStore(subscribeFontScale, readFontScale, () => 'standard' as FontScalePref);
}

/** 行高按字号倍率放大，保证固定行高的列表不会把字裁掉。 */
export function scaleRowHeight(base: number, pref: FontScalePref): number {
  return Math.round(base * fontScaleOf(pref));
}
