import * as React from 'react'
import { cn } from '../../lib/utils'

export interface FieldProps {
  id: string
  label: React.ReactNode
  children: React.ReactElement
  description?: React.ReactNode
  error?: React.ReactNode
  required?: boolean
  className?: string
}

export function Field({
  id,
  label,
  children,
  description,
  error,
  required = false,
  className,
}: FieldProps) {
  const descriptionId = description ? `${id}-description` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined

  return (
    <div className={cn('grid min-w-0 gap-2 [overflow-wrap:anywhere]', className)}>
      <label
        className="text-[length:var(--gs-semantic-type-label-size)] font-medium leading-[var(--gs-semantic-type-label-line)] text-[var(--gs-semantic-text-primary)]"
        htmlFor={id}
      >
        {label}
        {required ? (
          <span className="ml-1 text-[var(--gs-semantic-feedback-error-text)]" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        id,
        required,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
      })}
      {description ? (
        <p
          className="m-0 text-[length:var(--gs-semantic-type-metadata-size)] leading-[var(--gs-semantic-type-metadata-line)] text-[var(--gs-semantic-text-secondary)]"
          id={descriptionId}
        >
          {description}
        </p>
      ) : null}
      {error ? (
        <p
          className="m-0 text-[length:var(--gs-semantic-type-metadata-size)] leading-[var(--gs-semantic-type-metadata-line)] text-[var(--gs-semantic-feedback-error-text)]"
          id={errorId}
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  )
}
