import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--surface)] disabled:pointer-events-none disabled:opacity-45',
  {
    variants: {
      variant: {
        default: 'bg-[var(--ink)] text-white hover:bg-[var(--ink-soft)]',
        secondary:
          'border border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] hover:bg-[var(--surface-muted)]',
        ghost: 'text-[var(--ink-soft)] hover:bg-[var(--surface-muted)] hover:text-[var(--ink)]',
        subtle:
          'bg-[var(--surface-muted)] text-[var(--ink-soft)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)]',
        accent: 'bg-[var(--accent)] text-white hover:bg-[var(--accent-strong)]',
        danger:
          'border border-[var(--danger-line)] bg-[var(--danger-wash)] text-[var(--danger)] hover:bg-[var(--danger-wash-strong)]',
        link: 'text-[var(--accent-strong)] underline decoration-[var(--accent-line)] underline-offset-4 hover:decoration-[var(--accent-strong)]',
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
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  ),
)
Button.displayName = 'Button'

export { Button, buttonVariants }
