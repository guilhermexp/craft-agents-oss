import type { IconProps } from './types'

/**
 * Custom Folder icon with Lucide-compatible bounds.
 *
 * ADDING NEW ICONS: Ensure paths fill the 2-22 range (Lucide standard).
 * Use strokeWidth={2} to match Lucide visual weight.
 */
export function Icon_Folder({ size, className, ...props }: IconProps) {
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
      <path d="M2.53 9.88H21.47M7.68 3H6.75C5.59 3 5.01 3 4.53 3.14C3.37 3.47 2.47 4.37 2.14 5.53C2 6.01 2 6.59 2 7.75V13C2 16.77 2 18.66 3.17 19.83C4.34 21 6.23 21 10 21H14.32C17.78 21 19.51 21 20.64 20C20.77 19.89 20.89 19.77 21 19.64C22 18.51 22 16.78 22 13.32V12.75C22 9.84 22 8.39 21.28 7.36C21.01 6.97 20.67 6.64 20.29 6.37C19.26 5.65 17.8 5.65 14.9 5.65H13.16C12.1 5.65 11.09 5.16 10.42 4.32C9.76 3.49 8.75 3 7.68 3Z" />
    </svg>
  )
}
