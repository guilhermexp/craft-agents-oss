import type { SVGProps } from "react"

/**
 * Custom left sidebar panel icon with rounded design.
 * Vertical divider on the left side, no arrow.
 */
export function PanelLeftRounded(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M9 4V20M3.5 11.5L3.5 12.5C3.5 16.27 3.5 18.16 4.67 19.33C5.84 20.5 7.73 20.5 11.5 20.5L12.5 20.5C16.27 20.5 18.16 20.5 19.33 19.33C20.5 18.16 20.5 16.27 20.5 12.5L20.5 11.5C20.5 7.73 20.5 5.84 19.33 4.67C18.16 3.5 16.27 3.5 12.5 3.5L11.5 3.5C7.73 3.5 5.84 3.5 4.67 4.67C3.5 5.84 3.5 7.73 3.5 11.5Z" />
    </svg>
  )
}
