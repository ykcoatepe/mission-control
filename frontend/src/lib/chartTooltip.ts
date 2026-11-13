/**
 * How every Recharts tooltip in the app is configured. A readout must never travel: Recharts moves its
 * tooltip wrapper with a CSS transform and, by default, animates that move, so the card slides in from
 * wherever it was last (or from its hidden resting place) to the pointer. Animation off means the card
 * is simply where the pointer is; `allowEscapeViewBox` off keeps it inside the chart at both edges
 * (it flips to the other side of the pointer instead of leaving the plot).
 */
export const CHART_TOOLTIP_PROPS = {
  isAnimationActive: false,
  animationDuration: 0,
  allowEscapeViewBox: { x: false, y: false },
  offset: 12,
} as const
