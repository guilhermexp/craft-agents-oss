import type { SVGProps } from "react"

/**
 * Custom right sidebar toggle icon with rounded design
 */
export function PanelRightRounded(props: SVGProps<SVGSVGElement>) {
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
      <path d="M15 3.5C15.55 9.2 15.55 14.8 15 20.5M3.5 11.5V12.5C3.5 16.27 3.5 18.16 4.67 19.33C5.84 20.5 7.73 20.5 11.5 20.5H12.5C16.27 20.5 18.16 20.5 19.33 19.33C20.5 18.16 20.5 16.27 20.5 12.5V11.5C20.5 7.73 20.5 5.84 19.33 4.67C18.16 3.5 16.27 3.5 12.5 3.5H11.5C7.73 3.5 5.84 3.5 4.67 4.67C3.5 5.84 3.5 7.73 3.5 11.5Z" />
    </svg>
  )
}
