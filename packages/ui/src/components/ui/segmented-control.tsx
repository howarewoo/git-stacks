import * as React from 'react'
import { ToggleGroup } from '@base-ui/react/toggle-group'
import { Toggle } from '@base-ui/react/toggle'
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
  disabled?: boolean
  className?: string
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onValueChange,
  disabled = false,
  className,
}: SegmentedControlProps<T>) {
  return (
    <ToggleGroup<T>
      className={cn(
        'gs-segmented-control inline-flex items-center gap-1 rounded-[var(--gs-semantic-radius-pill)] bg-[var(--gs-semantic-surface-inset)] p-1',
        className,
      )}
      value={[value]}
      disabled={disabled}
      onValueChange={(next, details) => {
        const selected = next[0]
        if (selected === undefined || !options.some((option) => option.value === selected)) {
          details.cancel()
          return
        }
        onValueChange(selected)
      }}
      aria-label={label}
    >
      {options.map((option) => (
        <Toggle
          key={option.value}
          value={option.value}
          type="button"
          className={cn(
            'min-h-[var(--gs-semantic-density-control-compact)] rounded-[var(--gs-semantic-radius-pill)] px-3 text-[length:var(--gs-semantic-type-label-size)] font-medium leading-[var(--gs-semantic-type-label-line)] text-[var(--gs-semantic-text-secondary)] outline-none transition-colors hover:text-[var(--gs-semantic-text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--gs-semantic-focus-ring)]',
            value === option.value
              ? 'bg-[var(--gs-semantic-selection-background)] text-[var(--gs-semantic-selection-text)]'
              : 'bg-transparent',
          )}
          onPressedChange={(pressed, details) => {
            if (!pressed) details.cancel()
          }}
        >
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  )
}
