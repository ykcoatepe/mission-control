interface MissionControlMarkProps {
  size?: number
}

/**
 * Orbital tracking mark used as the Mission Control logo.
 * Draws in `currentColor`, so it takes its colour from the brand tile around it.
 */
export function MissionControlMark({ size = 19 }: MissionControlMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.6" />
      <ellipse
        cx="12"
        cy="12"
        rx="8"
        ry="3.4"
        transform="rotate(-30 12 12)"
        stroke="currentColor"
        strokeOpacity="0.92"
        strokeWidth="1.6"
      />
      <circle cx="12" cy="12" r="2.7" fill="currentColor" />
      <circle cx="19.1" cy="7.8" r="1.7" fill="currentColor" />
    </svg>
  )
}
