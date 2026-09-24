import * as React from 'react'
import { cn } from '../../lib/utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex h-9 w-full min-w-0 rounded-md border border-[var(--gs-component-field-border)] bg-[var(--gs-component-field-background)] px-3 py-2 text-sm text-[var(--gs-component-field-text)] shadow-none outline-none transition-colors placeholder:text-[var(--gs-component-field-placeholder)] focus:border-[var(--gs-component-field-focus-border)] focus:ring-2 focus:ring-[var(--gs-component-field-focus-ring)] disabled:cursor-not-allowed disabled:bg-[var(--gs-component-field-disabled-background)] disabled:opacity-65',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'

export { Input }
