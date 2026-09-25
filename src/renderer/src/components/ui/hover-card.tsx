import * as React from 'react'
import { HoverCard as HoverCardPrimitive } from 'radix-ui'
import { cn } from '../../lib/utils'

const HoverCard = HoverCardPrimitive.Root
const HoverCardTrigger = HoverCardPrimitive.Trigger
const HoverCardContent = React.forwardRef<
  React.ElementRef<typeof HoverCardPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Content>
>(({ className, align = 'start', sideOffset = 8, collisionPadding = 12, ...props }, ref) => (
  <HoverCardPrimitive.Portal>
    <HoverCardPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        'z-[var(--gs-component-overlay-popover-z-index)] w-80 max-w-[calc(100vw-24px)] rounded-xl bg-[var(--gs-component-overlay-background)] p-4 text-sm text-[var(--gs-component-overlay-text)] shadow-[var(--gs-semantic-elevation-medium)] outline-none [overflow-wrap:anywhere]',
        className,
      )}
      {...props}
    />
  </HoverCardPrimitive.Portal>
))
HoverCardContent.displayName = HoverCardPrimitive.Content.displayName

export { HoverCard, HoverCardTrigger, HoverCardContent }
