import * as React from 'react'
import { PreviewCard as HoverCardPrimitive } from '@base-ui/react/preview-card'
import { cn } from '../../lib/utils'

const HoverCard = HoverCardPrimitive.Root
const HoverCardTrigger = HoverCardPrimitive.Trigger

type HoverCardContentProps = Omit<HoverCardPrimitive.Popup.Props, 'className'> &
  Pick<
    HoverCardPrimitive.Positioner.Props,
    'side' | 'sideOffset' | 'align' | 'alignOffset' | 'collisionPadding'
  > & {
    className?: string
  }

const HoverCardContent = React.forwardRef<HTMLDivElement, HoverCardContentProps>(
  (
    {
      className,
      side = 'bottom',
      align = 'start',
      alignOffset = 0,
      sideOffset = 8,
      collisionPadding = 12,
      ...props
    },
    ref,
  ) => (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Positioner
        side={side}
        align={align}
        alignOffset={alignOffset}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className="isolate z-[var(--gs-component-overlay-popover-z-index)]"
      >
        <HoverCardPrimitive.Popup
          ref={ref}
          data-slot="hover-card-content"
          className={cn(
            'w-80 max-w-[calc(100vw-24px)] rounded-[var(--gs-semantic-radius-item)] bg-[var(--gs-component-overlay-background)] p-4 text-[length:var(--gs-semantic-type-body-size)] text-[var(--gs-component-overlay-text)] shadow-[var(--gs-semantic-elevation-medium)] outline-none [overflow-wrap:anywhere]',
            className,
          )}
          {...props}
        />
      </HoverCardPrimitive.Positioner>
    </HoverCardPrimitive.Portal>
  ),
)
HoverCardContent.displayName = 'HoverCardContent'

export { HoverCard, HoverCardTrigger, HoverCardContent }
