import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const badgeVariants = cva(
  'inline-flex shrink-0 items-center gap-1 rounded-[var(--gs-semantic-radius-pill)] border px-2 py-0.5 text-[length:var(--gs-semantic-type-metadata-size)] font-medium leading-4',
  {
    variants: {
      variant: {
        default:
          'border-[var(--gs-component-badge-neutral-border)] bg-[var(--gs-component-badge-neutral-background)] text-[var(--gs-component-badge-neutral-text)]',
        secondary:
          'border-[var(--gs-component-badge-neutral-border)] bg-[var(--gs-component-badge-neutral-background)] text-[var(--gs-component-badge-neutral-text)]',
        outline:
          'border-[var(--gs-component-badge-neutral-border)] bg-transparent text-[var(--gs-component-badge-neutral-text)]',
        accent:
          'border-[var(--gs-semantic-selection-border)] bg-[var(--gs-semantic-selection-background)] text-[var(--gs-semantic-selection-text)]',
        info: 'border-[var(--gs-component-badge-info-text)] bg-[var(--gs-component-badge-info-background)] text-[var(--gs-component-badge-info-text)]',
        success:
          'border-[var(--gs-component-badge-success-text)] bg-[var(--gs-component-badge-success-background)] text-[var(--gs-component-badge-success-text)]',
        warning:
          'border-[var(--gs-component-badge-warning-text)] bg-[var(--gs-component-badge-warning-background)] text-[var(--gs-component-badge-warning-text)]',
        danger:
          'border-[var(--gs-semantic-feedback-error-text)] bg-[var(--gs-component-badge-error-background)] text-[var(--gs-component-badge-error-text)]',
        merged:
          'border-[var(--gs-component-badge-merged-text)] bg-[var(--gs-component-badge-merged-background)] text-[var(--gs-component-badge-merged-text)]',
      },
    },
    defaultVariants: { variant: 'secondary' },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />
}

export { badgeVariants }
