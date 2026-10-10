import * as React from 'react'
import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox'
import { Check, Minus } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface CheckboxProps
  extends Omit<
    CheckboxPrimitive.Root.Props,
    'className' | 'render' | 'nativeButton' | 'onCheckedChange' | 'children'
  > {
  className?: string
  label?: React.ReactNode
  description?: React.ReactNode
  error?: React.ReactNode
  onCheckedChange?: (checked: boolean) => void
}

export const Checkbox = React.forwardRef<HTMLElement, CheckboxProps>(
  ({ className, id, label, description, error, onCheckedChange, ...props }, ref) => {
    const generatedId = React.useId()
    const controlId = id ?? generatedId
    const labelId = label ? `${controlId}-label` : undefined
    const descriptionId = description ? `${controlId}-description` : undefined
    const errorId = error ? `${controlId}-error` : undefined
    const describedBy =
      [props['aria-describedby'], descriptionId, errorId].filter(Boolean).join(' ') || undefined

    return (
      <div className={cn('gs-checkbox grid min-h-9 gap-2', className)}>
        <label
          className={cn(
            'flex min-h-9 min-w-9 items-center gap-2 text-[length:var(--gs-semantic-type-label-size)] leading-[var(--gs-semantic-type-label-line)]',
            props.disabled ? 'cursor-not-allowed' : 'cursor-pointer',
          )}
          htmlFor={controlId}
        >
          <CheckboxPrimitive.Root
            {...props}
            ref={ref}
            id={controlId}
            nativeButton
            render={<button type="button" />}
            data-slot="checkbox"
            onCheckedChange={(checked) => onCheckedChange?.(checked)}
            aria-labelledby={
              props['aria-labelledby'] ?? (props['aria-label'] ? undefined : labelId)
            }
            aria-describedby={describedBy}
            aria-invalid={error ? true : props['aria-invalid']}
            className="group inline-flex size-5 shrink-0 items-center justify-center rounded-[4px] border border-[var(--gs-component-field-border)] bg-[var(--gs-component-field-background)] outline-none transition-colors data-[checked]:border-[var(--gs-semantic-selection-border)] data-[checked]:bg-[var(--gs-semantic-selection-border)] data-[indeterminate]:border-[var(--gs-semantic-selection-border)] data-[indeterminate]:bg-[var(--gs-semantic-selection-border)] focus-visible:ring-2 focus-visible:ring-[var(--gs-component-field-focus-ring)] disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-[var(--gs-semantic-feedback-error-text)]"
          >
            <CheckboxPrimitive.Indicator className="pointer-events-none text-[var(--gs-semantic-action-primary-foreground)]">
              <Check aria-hidden="true" className="size-3.5 group-data-[indeterminate]:hidden" />
              <Minus
                aria-hidden="true"
                className="hidden size-3.5 group-data-[indeterminate]:block"
              />
            </CheckboxPrimitive.Indicator>
          </CheckboxPrimitive.Root>
          {label ? (
            <span
              id={labelId}
              className="text-[length:var(--gs-semantic-type-label-size)] leading-[var(--gs-semantic-type-label-line)] text-[var(--gs-semantic-text-primary)]"
            >
              {label}
            </span>
          ) : null}
        </label>
        {description ? (
          <p
            id={descriptionId}
            className="m-0 text-[length:var(--gs-semantic-type-metadata-size)] leading-[var(--gs-semantic-type-metadata-line)] text-[var(--gs-semantic-text-secondary)]"
          >
            {description}
          </p>
        ) : null}
        {error ? (
          <p
            id={errorId}
            role="alert"
            className="m-0 text-[length:var(--gs-semantic-type-metadata-size)] leading-[var(--gs-semantic-type-metadata-line)] text-[var(--gs-semantic-feedback-error-text)]"
          >
            {error}
          </p>
        ) : null}
      </div>
    )
  },
)
Checkbox.displayName = 'Checkbox'
