import * as React from 'react'
import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { Check, ChevronRight } from 'lucide-react'
import { cn } from '../../lib/utils'

function DropdownMenuRoot(props: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuPortal(props: MenuPrimitive.Portal.Props) {
  return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
}

function DropdownMenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

function DropdownMenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
}

const DropdownMenuSeparator = React.forwardRef<
  HTMLDivElement,
  Omit<MenuPrimitive.Separator.Props, 'className'> & { className?: string }
>(({ className, ...props }, ref) => (
  <MenuPrimitive.Separator
    ref={ref}
    data-slot="dropdown-menu-separator"
    className={cn('my-1 h-px bg-[var(--gs-semantic-border-decorative)]', className)}
    {...props}
  />
))
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator'

type DropdownMenuContentProps = Omit<MenuPrimitive.Popup.Props, 'className'> &
  Pick<
    MenuPrimitive.Positioner.Props,
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
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        collisionPadding={collisionPadding}
        className="isolate z-[var(--gs-component-overlay-popover-z-index)]"
      >
        <MenuPrimitive.Popup
          ref={ref}
          data-slot="dropdown-menu-content"
          className={cn(
            'min-w-48 max-h-[var(--available-height)] overflow-y-auto rounded-[var(--gs-semantic-radius-item)] bg-[var(--gs-component-overlay-background)] p-1 text-[var(--gs-component-overlay-text)] shadow-[var(--gs-semantic-elevation-medium)] outline-none',
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  ),
)
DropdownMenuContent.displayName = 'DropdownMenuContent'

export interface DropdownMenuItemProps extends Omit<MenuPrimitive.Item.Props, 'className'> {
  className?: string
  inset?: boolean
  variant?: 'default' | 'destructive'
}

const DropdownMenuItem = React.forwardRef<HTMLDivElement, DropdownMenuItemProps>(
  ({ className, inset, variant = 'default', ...props }, ref) => (
    <MenuPrimitive.Item
      ref={ref}
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        'flex min-h-9 cursor-default select-none items-center rounded-[var(--gs-semantic-radius-control)] px-3 text-[length:var(--gs-semantic-type-label-size)] leading-[var(--gs-semantic-type-label-line)] text-[var(--gs-semantic-text-primary)] outline-none data-[highlighted]:bg-[var(--gs-semantic-selection-background)] data-[highlighted]:text-[var(--gs-semantic-selection-text)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    />
  ),
)
DropdownMenuItem.displayName = 'DropdownMenuItem'

function DropdownMenuLabel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="dropdown-menu-label"
      className={cn(
        'px-3 py-1.5 text-xs font-semibold text-[var(--gs-semantic-text-secondary)]',
        className,
      )}
      {...props}
    />
  )
}

function DropdownMenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />
}

function DropdownMenuRadioItem({ className, children, ...props }: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(
        'relative flex min-h-9 cursor-default select-none items-center rounded-[var(--gs-semantic-radius-control)] py-1.5 pl-8 pr-3 text-[length:var(--gs-semantic-type-label-size)] text-[var(--gs-semantic-text-primary)] outline-none data-[highlighted]:bg-[var(--gs-semantic-selection-background)] data-[highlighted]:text-[var(--gs-semantic-selection-text)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <MenuPrimitive.RadioItemIndicator className="absolute left-2.5 flex size-4 items-center justify-center">
        <Check className="size-3.5" />
      </MenuPrimitive.RadioItemIndicator>
      {children}
    </MenuPrimitive.RadioItem>
  )
}

function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: MenuPrimitive.CheckboxItem.Props) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(
        'relative flex min-h-9 cursor-default select-none items-center rounded-[var(--gs-semantic-radius-control)] py-1.5 pl-8 pr-3 text-[length:var(--gs-semantic-type-label-size)] text-[var(--gs-semantic-text-primary)] outline-none data-[highlighted]:bg-[var(--gs-semantic-selection-background)] data-[highlighted]:text-[var(--gs-semantic-selection-text)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <MenuPrimitive.CheckboxItemIndicator className="absolute left-2.5 flex size-4 items-center justify-center">
        <Check className="size-3.5" />
      </MenuPrimitive.CheckboxItemIndicator>
      {children}
    </MenuPrimitive.CheckboxItem>
  )
}

function DropdownMenuSub(props: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      className={cn(
        'flex min-h-9 cursor-default select-none items-center rounded-[var(--gs-semantic-radius-control)] px-3 text-[length:var(--gs-semantic-type-label-size)] text-[var(--gs-semantic-text-primary)] outline-none data-[highlighted]:bg-[var(--gs-semantic-selection-background)] data-[highlighted]:text-[var(--gs-semantic-selection-text)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto size-4" />
    </MenuPrimitive.SubmenuTrigger>
  )
}

function DropdownMenuSubContent({ className, ...props }: MenuPrimitive.Popup.Props) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner sideOffset={2} alignOffset={-4}>
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-sub-content"
          className={cn(
            'min-w-40 rounded-[var(--gs-semantic-radius-item)] bg-[var(--gs-component-overlay-background)] p-1 text-[var(--gs-component-overlay-text)] shadow-[var(--gs-semantic-elevation-medium)] outline-none',
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

function DropdownMenuShortcut({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'ml-auto font-mono text-xs tracking-widest text-[var(--gs-semantic-text-secondary)]',
        className,
      )}
      {...props}
    />
  )
}

const DropdownMenu = Object.assign(DropdownMenuRoot, {
  Root: DropdownMenuRoot,
  Trigger: DropdownMenuTrigger,
  Portal: DropdownMenuPortal,
  Content: DropdownMenuContent,
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Group: DropdownMenuGroup,
  Label: DropdownMenuLabel,
  RadioGroup: DropdownMenuRadioGroup,
  RadioItem: DropdownMenuRadioItem,
  CheckboxItem: DropdownMenuCheckboxItem,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
  Shortcut: DropdownMenuShortcut,
})

export {
  DropdownMenu,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuShortcut,
}
