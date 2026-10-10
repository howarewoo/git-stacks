import * as React from 'react'
import { Select as SelectPrimitive } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface SelectOption {
  value: string
  label: React.ReactNode
  disabled?: boolean
}

export interface SelectProps
  extends Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    'value' | 'defaultValue' | 'onChange' | 'children' | 'type'
  > {
  options: readonly SelectOption[]
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  controlSize?: 'compact' | 'standard'
  required?: boolean
  readOnly?: boolean
  autoComplete?: string
}

export const Select = React.forwardRef<HTMLButtonElement, SelectProps>(
  (
    {
      options,
      value,
      defaultValue,
      onValueChange,
      className,
      controlSize = 'standard',
      id,
      disabled,
      required,
      readOnly,
      name,
      form,
      autoComplete,
      ...props
    },
    ref,
  ) => (
    <SelectPrimitive.Root<string>
      items={options}
      value={value}
      defaultValue={defaultValue}
      id={id}
      disabled={disabled}
      required={required}
      readOnly={readOnly}
      name={name}
      form={form}
      autoComplete={autoComplete}
      onValueChange={(next) => {
        if (next !== null) onValueChange?.(next)
      }}
    >
      <SelectPrimitive.Trigger
        ref={ref}
        data-slot="select-trigger"
        className={cn(
          'flex w-full min-w-0 items-center justify-between gap-2 rounded-[var(--gs-semantic-radius-control)] border border-[var(--gs-component-field-border)] bg-[var(--gs-component-field-background)] py-2 pl-3 pr-3 text-[length:var(--gs-semantic-type-label-size)] leading-[var(--gs-semantic-type-label-line)] text-[var(--gs-component-field-text)] outline-none transition-colors focus-visible:border-[var(--gs-component-field-focus-border)] focus-visible:ring-2 focus-visible:ring-[var(--gs-component-field-focus-ring)] disabled:cursor-not-allowed disabled:bg-[var(--gs-component-field-disabled-background)] disabled:opacity-65 aria-[invalid=true]:border-[var(--gs-semantic-feedback-error-text)]',
          controlSize === 'compact'
            ? 'h-[var(--gs-semantic-density-control-compact)]'
            : 'h-[var(--gs-semantic-density-control-standard)]',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Value
          data-slot="select-value"
          className="min-w-0 flex-1 truncate text-left"
        />
        <SelectPrimitive.Icon className="shrink-0 text-[var(--gs-semantic-text-secondary)]">
          <ChevronDown aria-hidden="true" className="size-4" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          align="start"
          sideOffset={4}
          collisionPadding={12}
          alignItemWithTrigger={false}
          className="isolate z-[var(--gs-component-overlay-popover-z-index)]"
        >
          <SelectPrimitive.Popup
            data-slot="select-content"
            className="max-h-[var(--available-height)] min-w-[var(--anchor-width)] max-w-[var(--available-width)] overflow-x-hidden overflow-y-auto overscroll-contain rounded-[var(--gs-semantic-radius-item)] bg-[var(--gs-component-overlay-background)] p-1 text-[var(--gs-component-overlay-text)] shadow-[var(--gs-semantic-elevation-medium)] outline-none"
          >
            <SelectPrimitive.List>
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  data-slot="select-item"
                  className="relative flex min-h-9 cursor-default select-none items-center gap-2 rounded-[var(--gs-semantic-radius-control)] py-2 pl-3 pr-9 text-[length:var(--gs-semantic-type-label-size)] leading-[var(--gs-semantic-type-label-line)] outline-none data-[highlighted]:bg-[var(--gs-semantic-selection-background)] data-[highlighted]:text-[var(--gs-semantic-selection-text)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                >
                  <SelectPrimitive.ItemText className="min-w-0 break-words">
                    {option.label}
                  </SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="absolute right-3">
                    <Check aria-hidden="true" className="size-4" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  ),
)
Select.displayName = 'Select'
