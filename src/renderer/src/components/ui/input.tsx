import * as React from 'react'
import { Input as InputPrimitive } from '@base-ui/react/input'
import { cn } from '../../lib/utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  controlSize?: 'compact' | 'standard'
  unstyled?: boolean
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', controlSize = 'standard', unstyled = false, ...props }, ref) => (
    <InputPrimitive
      ref={ref}
      data-slot="input"
      type={type}
      className={
        unstyled
          ? className
          : cn(
              'w-full min-w-0 rounded-[var(--gs-semantic-radius-control)] border border-[var(--gs-component-field-border)] bg-[var(--gs-component-field-background)] px-3 py-2 text-[length:var(--gs-semantic-type-label-size)] leading-[var(--gs-semantic-type-label-line)] text-[var(--gs-component-field-text)] outline-none transition-colors placeholder:text-[var(--gs-component-field-placeholder)] focus-visible:border-[var(--gs-component-field-focus-border)] focus-visible:ring-2 focus-visible:ring-[var(--gs-component-field-focus-ring)] disabled:cursor-not-allowed disabled:bg-[var(--gs-component-field-disabled-background)] disabled:opacity-65 aria-[invalid=true]:border-[var(--gs-semantic-feedback-error-text)]',
              controlSize === 'compact'
                ? 'h-[var(--gs-semantic-density-control-compact)]'
                : 'h-[var(--gs-semantic-density-control-standard)]',
              className,
            )
      }
      {...props}
    />
  ),
)
Input.displayName = 'Input'

export { Input }
