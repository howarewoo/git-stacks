import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  controlSize?: 'compact' | 'standard'
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, controlSize = 'standard', children, ...props }, ref) => (
    <span className="relative block">
      <select
        ref={ref}
        className={cn(
          'peer w-full appearance-none rounded-[var(--gs-semantic-radius-control)] border border-[var(--gs-component-field-border)] bg-[var(--gs-component-field-background)] py-2 pl-3 pr-9 text-[var(--gs-component-field-text)] outline-none transition-colors placeholder:text-[var(--gs-component-field-placeholder)] focus-visible:border-[var(--gs-component-field-focus-border)] focus-visible:ring-2 focus-visible:ring-[var(--gs-component-field-focus-ring)] disabled:cursor-not-allowed disabled:bg-[var(--gs-component-field-disabled-background)] disabled:opacity-65 aria-[invalid=true]:border-[var(--gs-semantic-feedback-error-text)]',
          controlSize === 'compact'
            ? 'h-[var(--gs-semantic-density-control-compact)] text-[length:var(--gs-semantic-type-metadata-size)]'
            : 'h-[var(--gs-semantic-density-control-standard)] text-[length:var(--gs-semantic-type-label-size)]',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-[var(--gs-semantic-text-secondary)] peer-disabled:opacity-50"
      />
    </span>
  ),
)
Select.displayName = 'Select'
