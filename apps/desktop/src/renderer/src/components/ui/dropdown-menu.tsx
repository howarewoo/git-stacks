import * as React from 'react'
import { Menu as DropdownMenuPrimitive } from '@base-ui/react/menu'
import { cn } from '../../lib/utils'

const DropdownMenuRoot = DropdownMenuPrimitive.Root
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger
const DropdownMenuPortal = DropdownMenuPrimitive.Portal
const DropdownMenuSeparator = React.forwardRef<
  HTMLDivElement,
  Omit<DropdownMenuPrimitive.Separator.Props, 'className'> & { className?: string }
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    data-slot="dropdown-menu-separator"
    className={cn('my-1 h-px bg-[var(--gs-semantic-border-decorative)]', className)}
    {...props}
  />
))
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator'

type DropdownMenuContentProps = Omit<DropdownMenuPrimitive.Popup.Props, 'className'> &
  Pick<
    DropdownMenuPrimitive.Positioner.Props,
    'side' | 'sideOffset' | 'align' | 'alignOffset' | 'collisionPadding'
  > & {
    className?: string
  }

const DropdownMenuContent = React.forwardRef<HTMLDivElement, DropdownMenuContentProps>(
  (
    {
      className,
      side = 'bottom',
      sideOffset = 6,
      align = 'center',
      alignOffset = 0,
      collisionPadding = 12,
      ...props
    },
    ref,
  ) => (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        collisionPadding={collisionPadding}
        className="isolate z-[var(--gs-component-overlay-popover-z-index)]"
      >
        <DropdownMenuPrimitive.Popup
          ref={ref}
          data-slot="dropdown-menu-content"
          className={cn(
            'min-w-48 max-h-[var(--available-height)] overflow-y-auto rounded-[var(--gs-semantic-radius-item)] border border-[var(--gs-semantic-border-essential)] bg-[var(--gs-component-overlay-background)] p-1 text-[var(--gs-component-overlay-text)] shadow-[var(--gs-semantic-elevation-medium)] outline-none',
            className,
          )}
          {...props}
        />
      </DropdownMenuPrimitive.Positioner>
    </DropdownMenuPrimitive.Portal>
  ),
)
DropdownMenuContent.displayName = 'DropdownMenuContent'

const DropdownMenuItem = React.forwardRef<
  HTMLDivElement,
  Omit<DropdownMenuPrimitive.Item.Props, 'className'> & { className?: string }
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    data-slot="dropdown-menu-item"
    className={cn(
      'flex min-h-9 cursor-default select-none items-center rounded-[var(--gs-semantic-radius-control)] px-3 text-[length:var(--gs-semantic-type-label-size)] leading-[var(--gs-semantic-type-label-line)] text-[var(--gs-semantic-text-primary)] outline-none data-[highlighted]:bg-[var(--gs-semantic-selection-background)] data-[highlighted]:text-[var(--gs-semantic-selection-text)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      className,
    )}
    {...props}
  />
))
DropdownMenuItem.displayName = 'DropdownMenuItem'

export const DropdownMenu = {
  Root: DropdownMenuRoot,
  Trigger: DropdownMenuTrigger,
  Portal: DropdownMenuPortal,
  Content: DropdownMenuContent,
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
}
