import type { SVGProps } from "react"

/**
 * MCP (Model Context Protocol) logo icon
 * Official logo from https://github.com/modelcontextprotocol/docs
 */
export function McpIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="18 22 150 170"
      fill="none"
      stroke="currentColor"
      strokeWidth="12"
      strokeLinecap="round"
      {...props}
    >
      <path d="M25 97.85L92.88 29.97C102.26 20.6 117.45 20.6 126.82 29.97V29.97C136.2 39.34 136.2 54.54 126.82 63.91L75.56 115.18" />
      <path d="M76.27 114.47L126.82 63.91C136.2 54.54 151.39 54.54 160.77 63.91L161.12 64.27C170.49 73.64 170.49 88.83 161.12 98.21L99.72 159.6C96.6 162.72 96.6 167.79 99.72 170.91L112.33 183.52" />
      <path d="M109.85 46.94L59.65 97.15C50.28 106.52 50.28 121.71 59.65 131.09V131.09C69.02 140.46 84.22 140.46 93.59 131.09L143.79 80.88" />
    </svg>
  )
}
