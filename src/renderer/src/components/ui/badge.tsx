import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const badgeVariants = cva(
  'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-[var(--ink)] text-white',
        secondary: 'border-[var(--line)] bg-[var(--surface-muted)] text-[var(--ink-soft)]',
        outline: 'border-[var(--line)] bg-transparent text-[var(--ink-soft)]',
        accent: 'border-[var(--accent-line)] bg-[var(--accent-wash)] text-[var(--accent-strong)]',
        success: 'border-[var(--success-line)] bg-[var(--success-wash)] text-[var(--success)]',
        warning: 'border-[var(--warning-line)] bg-[var(--warning-wash)] text-[var(--warning)]',
        danger: 'border-[var(--danger-line)] bg-[var(--danger-wash)] text-[var(--danger)]',
      },
    },
    defaultVariants: { variant: 'secondary' },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />
}

export { Badge, badgeVariants }
