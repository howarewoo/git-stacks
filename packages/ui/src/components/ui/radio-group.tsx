import * as React from 'react'
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group'
import { Radio as RadioPrimitive } from '@base-ui/react/radio'
import { cn } from '../../lib/utils'

export interface RadioGroupProps
  extends Omit<RadioGroupPrimitive.Props<string>, 'className' | 'onValueChange'> {
  className?: string
  onValueChange?: (value: string) => void
}

export function RadioGroup({ className, onValueChange, ...props }: RadioGroupProps) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={className}
      onValueChange={(value) => onValueChange?.(value)}
      {...props}
    />
  )
}

export interface RadioGroupItemProps {
  value: string
  disabled?: boolean
  className?: string
  title?: string
  children: React.ReactNode
}

export function RadioGroupItem({
  value,
  disabled,
  className,
  title,
  children,
}: RadioGroupItemProps) {
  const id = React.useId()
  const labelId = `${id}-label`
  return (
    <label
      htmlFor={id}
      title={title}
      className={cn(
        'inline-flex min-h-9 items-center gap-2 text-[length:var(--gs-semantic-type-label-size)] leading-[var(--gs-semantic-type-label-line)] text-[var(--gs-semantic-text-primary)]',
        disabled ? 'cursor-not-allowed' : 'cursor-pointer',
        className,
      )}
    >
      <RadioPrimitive.Root
        id={id}
        value={value}
        disabled={disabled}
        nativeButton
        render={<button type="button" />}
        aria-labelledby={labelId}
        data-slot="radio-group-item"
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-[var(--gs-component-field-border)] bg-[var(--gs-component-field-background)] outline-none transition-colors data-[checked]:border-[var(--gs-semantic-selection-border)] data-[checked]:bg-[var(--gs-semantic-selection-border)] focus-visible:ring-2 focus-visible:ring-[var(--gs-component-field-focus-ring)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        <RadioPrimitive.Indicator className="size-2 rounded-full bg-[var(--gs-semantic-action-primary-foreground)]" />
      </RadioPrimitive.Root>
      <span id={labelId}>{children}</span>
    </label>
  )
}
