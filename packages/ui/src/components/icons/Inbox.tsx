import type { IconProps } from './types'

/**
 * Custom Inbox icon with Lucide-compatible bounds.
 *
 * ADDING NEW ICONS: Ensure paths fill the 2-22 range (Lucide standard).
 * Use strokeWidth={2} to match Lucide visual weight.
 */
export function Icon_Inbox({ size, className, ...props }: IconProps) {
  const sizeProps = className ? {} : { width: size ?? 24, height: size ?? 24 }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...sizeProps}
      {...props}
    >
      <path d="M2.53 11.23H6.77C7.62 11.23 8.32 11.92 8.32 12.77C8.32 13.63 9.01 14.32 9.86 14.32H14.14C14.99 14.32 15.68 13.63 15.68 12.77C15.68 11.92 16.38 11.23 17.23 11.23H21.47M21.06 9.61L20.1 7.97C18.97 6.03 18.41 5.06 17.48 4.53C16.56 4 15.44 4 13.19 4H10.81C8.56 4 7.44 4 6.52 4.53C5.59 5.06 5.03 6.03 3.9 7.97L2.94 9.61C2.55 10.29 2.35 10.62 2.22 10.99C2.16 11.17 2.11 11.36 2.07 11.54C2 11.92 2 12.31 2 13.09C2 15.81 2 17.17 2.63 18.16C2.94 18.64 3.36 19.06 3.84 19.37C4.83 20 6.19 20 8.91 20H15.09C17.81 20 19.17 20 20.16 19.37C20.64 19.06 21.06 18.64 21.37 18.16C22 17.17 22 15.81 22 13.09C22 12.31 22 11.92 21.93 11.54C21.89 11.36 21.84 11.17 21.78 10.99C21.65 10.62 21.45 10.29 21.06 9.61Z" />
    </svg>
  )
}
