import * as React from 'react'
import { cn } from '../../lib/utils'

export interface WorkbenchPaneProps extends React.HTMLAttributes<HTMLElement> {
  header: React.ReactNode
  footer?: React.ReactNode
  bodyClassName?: string
}

/** A bounded work surface: persistent chrome around independently scrolling content. */
export function WorkbenchPane({
  header,
  footer,
  bodyClassName,
  children,
  className,
  ...props
}: WorkbenchPaneProps) {
  return (
    <section
      className={cn(
        'flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[var(--gs-semantic-radius-workbench)] bg-[var(--gs-semantic-surface-content)]',
        className,
      )}
      {...props}
    >
      <div className="shrink-0">{header}</div>
      <div className={cn('min-h-0 flex-1 overflow-auto', bodyClassName)}>{children}</div>
      {footer ? <div className="shrink-0">{footer}</div> : null}
    </section>
  )
}
