export const GAME = {
  W: 900,
  H: 450
};

export function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

export function xpToLevel(xp) {
  return 1 + Math.floor(Math.sqrt(Math.max(0, xp) / 120));
}
