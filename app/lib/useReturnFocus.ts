'use client';

import { useEffect } from 'react';

/**
 * 弹层关闭（组件卸载）时把焦点还给「打开它的那个元素」。
 *
 * 只适用于「打开即挂载」的弹层（父级 `{open && <Dialog/>}` 渲染的那种）。
 *
 * 两个实测坑（都踩过）：
 *  1. 不能直接读 document.activeElement：弹层挂载时 autoFocus 到内部输入框，
 *     useEffect 跑起来时读到的已经是弹层内的元素，归还只会落到即将被移除的节点。
 *  2. 跟踪器不能在弹层挂载时才安装：触发按钮的 focusin 发生在挂载之前，
 *     那时监听还没挂上，记到的是 null（实测 __rfDebug.last === undefined）。
 *
 * 所以：模块加载时就装全局 focusin（捕获阶段），只记录 [role="dialog"] 之外的焦点；
 * 弹层挂载时再兜底判断 activeElement 是否在弹层外（例如点击触发且浏览器已把焦点
 * 交给按钮）。
 */

let lastFocusOutsideDialog: HTMLElement | null = null;

if (typeof document !== 'undefined') {
  document.addEventListener(
    'focusin',
    (e) => {
      const target = e.target as HTMLElement | null;
      if (!target || typeof target.closest !== 'function') return;
      if (target.closest('[role="dialog"]')) return;
      if (target === document.body) return;
      lastFocusOutsideDialog = target;
    },
    true,
  );
}

export function useReturnFocus() {
  useEffect(() => {
    const atMount = document.activeElement as HTMLElement | null;
    const mountIsOutside = !!atMount
      && typeof atMount.closest === 'function'
      && !atMount.closest('[role="dialog"]')
      && atMount !== document.body;
    const opener = mountIsOutside ? atMount : lastFocusOutsideDialog;

    return () => {
      if (!opener || !document.contains(opener)) return;
      // 若卸载的同时已经有别的弹层接管（菜单项打开设置抽屉就是这种），
      // 不要再把焦点抢回原按钮——否则抽屉刚聚焦就被夺走，Esc 也随之失效
      //（实测：会话设置抽屉打开后焦点停在 ⋮ 上，按 Esc 关不掉）。
      if (document.querySelector('[role="dialog"]')) return;
      // 等一帧：遮罩先卸载，避免焦点被随后移除的元素吞掉
      setTimeout(() => {
        try {
          opener.focus({ preventScroll: true });
        } catch {
          /* 元素已不可聚焦，忽略 */
        }
      }, 0);
    };
  }, []);
}
