import * as React from 'react'
import { cn } from '../../lib/utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  controlSize?: 'compact' | 'standard'
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', controlSize = 'standard', ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'w-full min-w-0 rounded-[var(--gs-semantic-radius-control)] border border-[var(--gs-component-field-border)] bg-[var(--gs-component-field-background)] px-3 py-2 text-[var(--gs-component-field-text)] outline-none transition-colors placeholder:text-[var(--gs-component-field-placeholder)] focus-visible:border-[var(--gs-component-field-focus-border)] focus-visible:ring-2 focus-visible:ring-[var(--gs-component-field-focus-ring)] disabled:cursor-not-allowed disabled:bg-[var(--gs-component-field-disabled-background)] disabled:opacity-65 aria-[invalid=true]:border-[var(--gs-semantic-feedback-error-text)]',
        controlSize === 'compact'
          ? 'h-[var(--gs-semantic-density-control-compact)] text-[var(--gs-semantic-type-metadata-size)]'
          : 'h-[var(--gs-semantic-density-control-standard)] text-[var(--gs-semantic-type-label-size)]',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'

export { Input }
