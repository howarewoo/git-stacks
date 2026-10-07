import * as React from 'react'
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import { cn } from '../../lib/utils'

const TooltipProvider = TooltipPrimitive.Provider
const TooltipContext = React.createContext<{ id: string; open: boolean } | null>(null)

function Tooltip({
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  ...props
}: TooltipPrimitive.Root.Props) {
  const id = React.useId()
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
  const open = controlledOpen ?? uncontrolledOpen
  return (
    <TooltipContext.Provider value={{ id, open }}>
      <TooltipPrimitive.Root
        {...props}
        open={open}
        onOpenChange={(next, details) => {
          onOpenChange?.(next, details)
          if (!details.isCanceled) setUncontrolledOpen(next)
        }}
      />
    </TooltipContext.Provider>
  )
}

const TooltipTrigger = React.forwardRef<HTMLButtonElement, TooltipPrimitive.Trigger.Props>(
  (props, ref) => {
    const tooltip = React.useContext(TooltipContext)
    const description = tooltip?.open
      ? props['aria-describedby']
        ? `${props['aria-describedby']} ${tooltip.id}`
        : tooltip.id
      : props['aria-describedby']
    return <TooltipPrimitive.Trigger {...props} ref={ref} aria-describedby={description} />
  },
)
TooltipTrigger.displayName = 'TooltipTrigger'

type TooltipContentProps = Omit<TooltipPrimitive.Popup.Props, 'className'> &
  Pick<
    TooltipPrimitive.Positioner.Props,
    'side' | 'sideOffset' | 'align' | 'alignOffset' | 'collisionPadding'
  > & {
    className?: string
  }

const TooltipContent = React.forwardRef<HTMLDivElement, TooltipContentProps>(
  (
    {
      className,
      side = 'top',
      sideOffset = 6,
      align = 'center',
      alignOffset = 0,
      collisionPadding = 12,
      ...props
    },
    ref,
  ) => {
    const tooltip = React.useContext(TooltipContext)
    return (
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner
          side={side}
          sideOffset={sideOffset}
          align={align}
          alignOffset={alignOffset}
          collisionPadding={collisionPadding}
          className="isolate z-[var(--gs-component-overlay-popover-z-index)]"
        >
          <TooltipPrimitive.Popup
            ref={ref}
            data-slot="tooltip-content"
            className={cn(
              'max-w-[min(20rem,calc(100vw-24px))] rounded-[var(--gs-semantic-radius-control)] bg-[var(--gs-semantic-text-primary)] px-3 py-2 text-[length:var(--gs-semantic-type-metadata-size)] leading-[var(--gs-semantic-type-metadata-line)] text-[var(--gs-semantic-text-inverse)] shadow-[var(--gs-semantic-elevation-medium)] [overflow-wrap:anywhere]',
              className,
            )}
            {...props}
            id={tooltip?.id ?? props.id}
            role="tooltip"
          />
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    )
  },
)
TooltipContent.displayName = 'TooltipContent'

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
