'use client';

import { useEffect } from 'react';

/**
 * 「小控件 = item 圆角」的渲染期打标（客户端 theme.ts 语义刻度）。
 *
 * 为什么不在 CSS 里做：客户端的规则是**按渲染高度**定义的 ——
 * 「高度 ≤32 的控件属 item（8px），其余控件属 control（12px）」。
 * CSS 选择器看不到自身高度，只能拿类名当线索；第二批实测四轮都不可收敛
 * （漏 rounded-md、把 30 个小控件推到 12、!important 被 (0,7,0) 特异性压过、
 * text-xs 误伤 44px 的分区标签）。所以这里直接量高度。
 *
 * 代价与约束：
 * - 只在挂载后跑一次 + MutationObserver 合并到 rAF，不做逐元素 ResizeObserver；
 * - 不监听 attributes，避免「打标 → 触发变更 → 再打标」的自激；
 * - 打出的只是 `data-radius-tier="item"`，真正的圆角值仍由 globals.css 决定。
 */
const SELECTOR = 'button, a, input:not([type="hidden"]), select, textarea, [role="button"]';
const ITEM_MAX_HEIGHT = 32;

function mark(): void {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(SELECTOR))) {
    const h = el.getBoundingClientRect().height;
    // 隐藏元素（h=0）不参与：它们没有可判断的渲染高度，保持现状即可。
    if (h > 0 && h <= ITEM_MAX_HEIGHT) {
      if (el.dataset.radiusTier !== 'item') el.dataset.radiusTier = 'item';
    } else if (el.dataset.radiusTier === 'item') {
      delete el.dataset.radiusTier;
    }
  }
}

export function useRadiusTier(): void {
  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        mark();
      });
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, []);
}
