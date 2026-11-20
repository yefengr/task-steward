import { useEffect, useMemo, useState } from 'react';

const FLOATING_EDGE_GAP = 5;

function readSafeAreaInsets() {
  // 自定义属性会保留 env()，需用计算后的内边距读取实际像素。
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;width:0;height:0;'
    + 'padding:var(--pwa-safe-top) var(--pwa-safe-right) var(--pwa-safe-bottom) var(--pwa-safe-left)';
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const insets = {
    top: parseFloat(style.paddingTop) || 0,
    right: parseFloat(style.paddingRight) || 0,
    bottom: parseFloat(style.paddingBottom) || 0,
    left: parseFloat(style.paddingLeft) || 0,
  };
  probe.remove();
  return insets;
}

export function useFloatingSafeMiddlewares() {
  const [insets, setInsets] = useState(readSafeAreaInsets);
  useEffect(() => {
    const update = () => setInsets(readSafeAreaInsets());
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return useMemo(() => ({ shift: { padding: {
    top: Math.max(FLOATING_EDGE_GAP, insets.top), right: Math.max(FLOATING_EDGE_GAP, insets.right),
    bottom: Math.max(FLOATING_EDGE_GAP, insets.bottom), left: Math.max(FLOATING_EDGE_GAP, insets.left),
  } } }), [insets]);
}
