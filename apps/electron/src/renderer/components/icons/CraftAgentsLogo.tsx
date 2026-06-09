interface CraftAgentsLogoProps {
  className?: string
}

/**
 * Craft Agents pixel art logo - uses accent color from theme
 * Apply text-accent class to get the brand purple color
 */
export function CraftAgentsLogo({ className }: CraftAgentsLogoProps) {
  return (
    <svg
      viewBox="0 0 408 66"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M15.07,65.95 L15.07,52.95 L0,52.95 L0,13.95 L15.07,13.95 L15.07,0.95 L75.86,0.95 L75.86,26.95 L45.72,26.95 L45.72,39.95 L75.86,39.95 L75.86,65.95 L15.07,65.95 Z M158.76,52.95 L158.76,65.95 L128.11,65.95 L128.11,52.95 L113.54,52.95 L113.54,65.95 L82.9,65.95 L82.9,0.95 L151.22,0.95 L151.22,13.95 L158.76,13.95 L158.76,39.95 L143.69,39.95 L143.69,52.95 L158.76,52.95 Z M241.66,65.95 L211.01,65.95 L211.01,52.95 L196.44,52.95 L196.44,65.95 L165.79,65.95 L165.79,13.95 L180.87,13.95 L180.87,0.95 L226.58,0.95 L226.58,13.95 L241.66,13.95 L241.66,65.95 Z M324.55,0.95 L324.55,13.95 L317.02,13.95 L317.02,26.95 L309.48,26.95 L309.48,39.95 L301.95,39.95 L301.95,52.95 L286.87,52.95 L286.87,65.95 L248.69,65.95 L248.69,0.95 L324.55,0.95 Z M392.38,65.95 L346.66,65.95 L346.66,39.95 L331.59,39.95 L331.59,0.95 L407.45,0.95 L407.45,39.95 L392.38,39.95 L392.38,65.95 Z"
        fill="currentColor"
        fillRule="nonzero"
      />
    </svg>
  )
}
