import * as React from 'react'
import { Check, Minus } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: React.ReactNode
  description?: React.ReactNode
  error?: React.ReactNode
  indeterminate?: boolean
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, id, label, description, error, indeterminate = false, ...props }, ref) => {
    const generatedId = React.useId()
    const inputId = id ?? generatedId
    const descriptionId = description ? `${inputId}-description` : undefined
    const errorId = error ? `${inputId}-error` : undefined
    const describedBy =
      [props['aria-describedby'], descriptionId, errorId].filter(Boolean).join(' ') || undefined
    const inputRef = React.useRef<HTMLInputElement>(null)

    React.useImperativeHandle(ref, () => inputRef.current as HTMLInputElement)
    React.useEffect(() => {
      if (inputRef.current) inputRef.current.indeterminate = indeterminate
    }, [indeterminate])

    return (
      <div className={cn('gs-checkbox grid min-h-9 gap-1.5', className)}>
        <label
          className={cn(
            'flex min-h-9 min-w-9 items-center gap-2',
            props.disabled ? 'cursor-not-allowed' : 'cursor-pointer',
          )}
          htmlFor={inputId}
        >
          <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
            <input
              {...props}
              ref={inputRef}
              id={inputId}
              type="checkbox"
              aria-describedby={describedBy}
              aria-invalid={error ? true : props['aria-invalid']}
              className="peer absolute inset-0 size-5 cursor-pointer appearance-none rounded-[4px] border border-[var(--gs-component-field-border)] bg-[var(--gs-component-field-background)] outline-none transition-colors checked:border-[var(--gs-semantic-selection-border)] checked:bg-[var(--gs-semantic-selection-border)] indeterminate:border-[var(--gs-semantic-selection-border)] indeterminate:bg-[var(--gs-semantic-selection-border)] focus-visible:ring-2 focus-visible:ring-[var(--gs-component-field-focus-ring)] disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-[var(--gs-semantic-feedback-error-text)]"
            />
            <span className="pointer-events-none relative z-10 hidden text-[var(--gs-semantic-text-inverse)] peer-checked:block peer-indeterminate:hidden">
              <Check aria-hidden="true" className="size-3.5" />
            </span>
            <span className="pointer-events-none relative z-10 hidden text-[var(--gs-semantic-text-inverse)] peer-indeterminate:block">
              <Minus aria-hidden="true" className="size-3.5" />
            </span>
          </span>
          {label ? (
            <span className="text-[length:var(--gs-semantic-type-label-size)] text-[var(--gs-semantic-text-primary)]">
              {label}
            </span>
          ) : null}
        </label>
        {description ? (
          <p
            className="text-[length:var(--gs-semantic-type-metadata-size)] text-[var(--gs-semantic-text-secondary)]"
            id={descriptionId}
          >
            {description}
          </p>
        ) : null}
        {error ? (
          <p
            className="text-[length:var(--gs-semantic-type-metadata-size)] text-[var(--gs-semantic-feedback-error-text)]"
            id={errorId}
            role="alert"
          >
            {error}
          </p>
        ) : null}
      </div>
    )
  },
)
Checkbox.displayName = 'Checkbox'
