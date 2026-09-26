import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'

const buttonVariants = cva(
  'gs-button inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[var(--gs-semantic-radius-control)] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--gs-semantic-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--gs-semantic-surface-content)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-55',
  {
    variants: {
      variant: {
        default:
          'bg-[var(--gs-component-button-primary-background)] text-[var(--gs-component-button-primary-foreground)] hover:bg-[var(--gs-component-button-primary-hover)] active:bg-[var(--gs-component-button-primary-pressed)]',
        secondary:
          'border border-[var(--gs-component-button-secondary-border)] bg-[var(--gs-component-button-secondary-background)] text-[var(--gs-component-button-secondary-foreground)] hover:bg-[var(--gs-semantic-action-secondary-hover)] active:bg-[var(--gs-semantic-surface-hover)]',
        ghost:
          'text-[var(--gs-semantic-text-secondary)] hover:bg-[var(--gs-semantic-surface-inset)] hover:text-[var(--gs-semantic-text-primary)]',
        subtle:
          'bg-[var(--gs-semantic-surface-inset)] text-[var(--gs-semantic-text-secondary)] hover:bg-[var(--gs-semantic-surface-hover)] hover:text-[var(--gs-semantic-text-primary)]',
        accent:
          'bg-[var(--gs-semantic-selection-text)] text-[var(--gs-semantic-text-inverse)] hover:bg-[var(--gs-semantic-selection-border)]',
        danger:
          'border border-[var(--gs-semantic-feedback-error-text)] bg-[var(--gs-semantic-feedback-error-surface)] text-[var(--gs-semantic-feedback-error-text)] hover:bg-[var(--gs-semantic-feedback-error-text)] hover:text-[var(--gs-semantic-text-inverse)]',
        link: 'h-auto rounded-none p-0 text-[var(--gs-component-button-link)] underline decoration-[var(--gs-semantic-selection-border)] underline-offset-4 hover:decoration-[var(--gs-component-button-link)]',
      },
      size: {
        sm: 'min-h-[var(--gs-semantic-density-control-compact)] px-3 text-[length:var(--gs-semantic-type-label-size)]',
        default:
          'min-h-[var(--gs-semantic-density-control-standard)] px-4 text-[length:var(--gs-semantic-type-label-size)]',
        lg: 'min-h-[var(--gs-semantic-density-control-standard)] px-5 text-[length:var(--gs-semantic-type-body-size)]',
        icon: 'size-11',
        'icon-sm': 'size-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  tooltip?: React.ReactNode
  loading?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, type = 'button', tooltip, loading = false, disabled, ...props },
    ref,
  ) => {
    const hint = tooltip ?? (size === 'icon' || size === 'icon-sm' ? props['aria-label'] : null)
    const isDisabled = disabled || loading
    const button = (
      <button
        ref={ref}
        type={type}
        aria-busy={loading || undefined}
        data-loading={loading || undefined}
        data-size={size ?? 'default'}
        className={cn(buttonVariants({ variant, size, className }))}
        disabled={isDisabled}
        {...props}
      />
    )
    if (!hint) return button
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {isDisabled ? (
            <span
              role="group"
              className="inline-flex shrink-0 rounded-[var(--gs-semantic-radius-control)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--gs-semantic-focus-ring)]"
              tabIndex={0}
              aria-label={typeof hint === 'string' ? hint : props['aria-label']}
            >
              {button}
            </span>
          ) : (
            button
          )}
        </TooltipTrigger>
        <TooltipContent>
          {hint}
          {isDisabled && !tooltip ? ' — unavailable' : null}
          {loading ? ' — working' : null}
        </TooltipContent>
      </Tooltip>
    )
  },
)
Button.displayName = 'Button'

export interface IconButtonProps extends Omit<ButtonProps, 'aria-label'> {
  label: string
}

const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, size = 'icon-sm', tooltip, ...props }, ref) => (
    <Button ref={ref} aria-label={label} size={size} tooltip={tooltip ?? label} {...props} />
  ),
)
IconButton.displayName = 'IconButton'

export { Button, IconButton, buttonVariants }
