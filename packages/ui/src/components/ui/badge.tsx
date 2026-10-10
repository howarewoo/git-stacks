import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const badgeVariants = cva(
  'inline-flex shrink-0 items-center gap-1 rounded-[var(--gs-semantic-radius-pill)] px-2 py-0.5 text-[length:var(--gs-semantic-type-metadata-size)] font-medium leading-[var(--gs-semantic-type-metadata-line)]',
  {
    variants: {
      variant: {
        default:
          'bg-[var(--gs-component-badge-neutral-background)] text-[var(--gs-component-badge-neutral-text)]',
        secondary:
          'bg-[var(--gs-component-badge-neutral-background)] text-[var(--gs-component-badge-neutral-text)]',
        outline:
          'border border-[var(--gs-component-badge-neutral-border)] bg-transparent text-[var(--gs-component-badge-neutral-text)]',
        accent:
          'bg-[var(--gs-semantic-selection-background)] text-[var(--gs-semantic-selection-text)]',
        info: 'bg-[var(--gs-component-badge-info-background)] text-[var(--gs-component-badge-info-text)]',
        success:
          'bg-[var(--gs-component-badge-success-background)] text-[var(--gs-component-badge-success-text)]',
        warning:
          'bg-[var(--gs-component-badge-warning-background)] text-[var(--gs-component-badge-warning-text)]',
        danger:
          'bg-[var(--gs-component-badge-error-background)] text-[var(--gs-component-badge-error-text)]',
        merged:
          'bg-[var(--gs-component-badge-merged-background)] text-[var(--gs-component-badge-merged-text)]',
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
