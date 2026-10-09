import * as React from 'react'
import { AlertCircle, CheckCircle2, Info, TriangleAlert } from 'lucide-react'
import { cn } from '../../lib/utils'

export function Surface({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn(
        'rounded-[var(--gs-semantic-radius-workbench)] border border-[var(--gs-semantic-border-essential)] bg-[var(--gs-semantic-surface-content)] p-5 shadow-[var(--gs-semantic-elevation-small)]',
        className,
      )}
      {...props}
    />
  )
}

export function SurfaceHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-start justify-between gap-4', className)} {...props} />
}

export function SurfaceTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn(
        'm-0 text-[length:var(--gs-semantic-type-heading-size)] font-semibold leading-[var(--gs-semantic-type-heading-line)]',
        className,
      )}
      {...props}
    />
  )
}

export function SurfaceDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(
        'm-0 text-[length:var(--gs-semantic-type-body-size)] leading-[var(--gs-semantic-type-body-line)] text-[var(--gs-semantic-text-secondary)]',
        className,
      )}
      {...props}
    />
  )
}

const alertIcons = { info: Info, success: CheckCircle2, warning: TriangleAlert, error: AlertCircle }

export interface InlineAlertProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: keyof typeof alertIcons
  title?: React.ReactNode
}

export function InlineAlert({
  tone = 'info',
  title,
  className,
  children,
  ...props
}: InlineAlertProps) {
  const Icon = alertIcons[tone]
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-[var(--gs-semantic-radius-control)] px-3 py-2 text-[length:var(--gs-semantic-type-metadata-size)] leading-[var(--gs-semantic-type-metadata-line)]',
        tone === 'info' &&
          'bg-[var(--gs-semantic-feedback-info-surface)] text-[var(--gs-semantic-feedback-info-text)]',
        tone === 'success' &&
          'bg-[var(--gs-semantic-feedback-success-surface)] text-[var(--gs-semantic-feedback-success-text)]',
        tone === 'warning' &&
          'bg-[var(--gs-semantic-feedback-warning-surface)] text-[var(--gs-semantic-feedback-warning-text)]',
        tone === 'error' &&
          'bg-[var(--gs-semantic-feedback-error-surface)] text-[var(--gs-semantic-feedback-error-text)]',
        className,
      )}
      {...props}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="grid min-w-0 gap-1">
        {title ? (
          <strong className="block text-[length:var(--gs-semantic-type-label-size)] font-semibold leading-[var(--gs-semantic-type-label-line)]">
            {title}
          </strong>
        ) : null}
        {children ? <div>{children}</div> : null}
      </div>
    </div>
  )
}

export function EmptyState({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'gs-empty-state grid justify-items-center gap-2 rounded-[var(--gs-semantic-radius-item)] border border-dashed border-[var(--gs-semantic-border-essential)] bg-[var(--gs-semantic-surface-inset)] p-8 text-center',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export function LoadingState({
  className,
  children = 'Loading…',
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="status"
      aria-busy="true"
      className={cn(
        'flex items-center gap-2 text-[length:var(--gs-semantic-type-label-size)] leading-[var(--gs-semantic-type-label-line)] text-[var(--gs-semantic-text-secondary)]',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className="size-4 animate-spin rounded-full border-2 border-[var(--gs-semantic-border-essential)] border-t-[var(--gs-semantic-selection-border)]"
      />
      {children}
    </div>
  )
}
