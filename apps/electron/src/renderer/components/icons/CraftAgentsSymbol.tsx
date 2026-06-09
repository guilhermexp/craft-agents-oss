interface CraftAgentsSymbolProps {
  className?: string
}

/**
 * Craft Agents "E" symbol - the small pixel art icon
 * Uses accent color from theme (currentColor from className)
 */
export function CraftAgentsSymbol({ className }: CraftAgentsSymbolProps) {
  return (
    <svg
      viewBox="452 368 115 129"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M474.78,393.8 L474.78,368 L566.67,368 L566.67,393.8 L474.78,393.8 Z M521.1,419.6 L521.1,445.4 L452,445.4 L452,393.8 L566.67,393.8 L566.67,419.6 L521.1,419.6 Z M474.78,497 L474.78,471.2 L452,471.2 L452,445.4 L566.67,445.4 L566.67,497 L474.78,497 Z"
        fill="currentColor"
        fillRule="nonzero"
      />
    </svg>
  )
}
