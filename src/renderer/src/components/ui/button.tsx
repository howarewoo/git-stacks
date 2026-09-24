import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--gs-component-button-focus-ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--gs-semantic-surface-content)] disabled:pointer-events-none disabled:opacity-45',
  {
    variants: {
      variant: {
        default:
          'bg-[var(--gs-component-button-primary-background)] text-[var(--gs-component-button-primary-foreground)] hover:bg-[var(--gs-component-button-primary-hover)] active:bg-[var(--gs-component-button-primary-pressed)]',
        secondary:
          'border border-[var(--gs-component-button-secondary-border)] bg-[var(--gs-component-button-secondary-background)] text-[var(--gs-component-button-secondary-foreground)] hover:bg-[var(--gs-component-button-secondary-hover)]',
        ghost:
          'text-[var(--gs-semantic-text-secondary)] hover:bg-[var(--gs-semantic-surface-inset)] hover:text-[var(--gs-semantic-text-primary)]',
        subtle:
          'bg-[var(--gs-semantic-surface-inset)] text-[var(--gs-semantic-text-secondary)] hover:bg-[var(--gs-semantic-surface-hover)] hover:text-[var(--gs-semantic-text-primary)]',
        accent: 'bg-[var(--gs-semantic-selection-text)] text-white hover:bg-[var(--gs-semantic-selection-border)]',
        danger:
          'border border-[var(--gs-semantic-feedback-error-text)] bg-[var(--gs-semantic-feedback-error-surface)] text-[var(--gs-semantic-feedback-error-text)] hover:bg-[var(--gs-semantic-feedback-error-surface)]',
        link: 'text-[var(--gs-component-button-link)] underline decoration-[var(--gs-semantic-selection-border)] underline-offset-4 hover:decoration-[var(--gs-component-button-link)]',
      },
      size: {
        default: 'h-9 px-3',
        sm: 'h-8 px-2.5 text-[12px]',
        lg: 'h-10 px-4',
        icon: 'size-9',
        'icon-sm': 'size-8',
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
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', tooltip, ...props }, ref) => {
    const hint = tooltip ?? (size === 'icon' || size === 'icon-sm' ? props['aria-label'] : null)
    const button = (
      <button
        ref={ref}
        type={type}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      />
    )
    if (!hint) return button
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {props.disabled ? (
            <span
              className="inline-flex shrink-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
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
          {props.disabled && !tooltip ? ' — unavailable' : null}
        </TooltipContent>
      </Tooltip>
    )
  },
)
Button.displayName = 'Button'

export { Button, buttonVariants }
