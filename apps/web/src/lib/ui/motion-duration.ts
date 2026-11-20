const PWA_MOTION_FALLBACK_MS = { '--pwa-duration-modal-in': 400, '--pwa-duration-modal-out': 200 } as const;

export function readPwaMotionDuration(variable: keyof typeof PWA_MOTION_FALLBACK_MS): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  const duration = Number.parseFloat(value);
  return value.endsWith('ms') && Number.isFinite(duration) ? duration : PWA_MOTION_FALLBACK_MS[variable];
}
