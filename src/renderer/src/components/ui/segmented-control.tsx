import * as React from 'react'
import { cn } from '../../lib/utils'

export interface SegmentedControlOption<T extends string> {
  value: T
  label: React.ReactNode
}

export interface SegmentedControlProps<T extends string> {
  label: string
  value: T
  options: readonly SegmentedControlOption<T>[]
  onValueChange: (value: T) => void
  className?: string
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onValueChange,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-1 rounded-[var(--gs-semantic-radius-pill)] bg-[var(--gs-semantic-surface-inset)] p-1',
        className,
      )}
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          className={cn(
            'min-h-8 rounded-[var(--gs-semantic-radius-pill)] px-3 text-[var(--gs-semantic-type-label-size)] font-medium text-[var(--gs-semantic-text-secondary)] outline-none transition-colors hover:text-[var(--gs-semantic-text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--gs-semantic-focus-ring)]',
            value === option.value
              ? 'bg-[var(--gs-semantic-surface-content)] text-[var(--gs-semantic-text-primary)] shadow-[var(--gs-semantic-elevation-small)]'
              : 'bg-transparent',
          )}
          onClick={() => onValueChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
