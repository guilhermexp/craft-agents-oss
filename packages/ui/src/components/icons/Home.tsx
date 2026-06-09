import type { IconProps } from './types'

/**
 * Custom Home icon for the working directory badge.
 * Rounded house outline — clean silhouette.
 *
 * ADDING NEW ICONS: Ensure paths fill the 2-22 range (Lucide standard).
 * Use strokeWidth={2} to match Lucide visual weight.
 */
export function Icon_Home({ size, className, ...props }: IconProps) {
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
      <path d="M2.5 11.95C2.5 10.06 2.5 9.11 2.89 8.29C3.29 7.47 4.03 6.88 5.5 5.7L7 4.5C9.4 2.58 10.6 1.62 12 1.62C13.4 1.62 14.6 2.58 17 4.5L18.5 5.7C19.97 6.88 20.71 7.47 21.11 8.29C21.5 9.11 21.5 10.06 21.5 11.95V14C21.5 17.77 21.5 19.66 20.33 20.83C19.16 22 17.27 22 13.5 22H10.5C6.73 22 4.84 22 3.67 20.83C2.5 19.66 2.5 17.77 2.5 14V11.95Z" />
    </svg>
  )
}
