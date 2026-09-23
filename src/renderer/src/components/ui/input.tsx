import * as React from 'react'
import { cn } from '../../lib/utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex h-9 w-full min-w-0 rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--ink)] shadow-none outline-none transition-colors placeholder:text-[var(--ink-muted)] focus:border-[var(--accent-line)] focus:ring-2 focus:ring-[var(--ring-soft)] disabled:cursor-not-allowed disabled:bg-[var(--surface-muted)] disabled:opacity-65',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'

export { Input }
