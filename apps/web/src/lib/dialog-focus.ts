export const isValidDialogFocus = (node: HTMLElement | null): node is HTMLElement => Boolean(node?.isConnected
  && node !== document.body && node !== document.documentElement
  && !node.closest('[inert], [aria-hidden="true"], [role="dialog"]')
  && !node.matches(':disabled, [aria-disabled="true"]')
  && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');

// Mantine 先尝试返回来源；仅在焦点失效时使用当前任务的明确后备入口。
export function restoreDialogFocus(source: HTMLElement | null, fallback: () => HTMLElement | null) {
  if (isValidDialogFocus(document.activeElement as HTMLElement | null)) return;
  const target = isValidDialogFocus(source) ? source : fallback();
  if (!isValidDialogFocus(target)) return;
  target.focus({ preventScroll: true });
}
