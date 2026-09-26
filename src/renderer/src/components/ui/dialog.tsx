import * as React from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-[var(--gs-component-overlay-z-index)] bg-[color-mix(in_srgb,var(--gs-semantic-text-primary)_34%,transparent)]',
      className,
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, onCloseAutoFocus, ...props }, ref) => {
  const opener = React.useRef<HTMLElement | null>(null)
  // Ref callbacks run in the commit phase, before the focus scope claims focus,
  // so this is the last moment the initiating control is still known.
  const attach = React.useCallback(
    (node: HTMLDivElement | null) => {
      if (node) {
        const active = document.activeElement
        if (active instanceof HTMLElement && active !== document.body) {
          opener.current = active
        }
      }
      if (typeof ref === 'function') ref(node)
      else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node
    },
    [ref],
  )
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={attach}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event)
          if (event.defaultPrevented) return
          // Dialogs here are opened from a plain onClick, so there is no trigger
          // for the focus scope to return to. Hand focus back to the control the
          // user actually pressed, so the next Tab starts where they left off.
          const target = opener.current
          opener.current = null
          if (target?.isConnected) {
            event.preventDefault()
            target.focus()
          }
        }}
        className={cn(
          'fixed left-1/2 top-1/2 z-[var(--gs-component-overlay-z-index)] grid max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-5 overflow-y-auto rounded-[var(--gs-semantic-radius-workbench)] border border-[var(--gs-semantic-border-essential)] bg-[var(--gs-component-overlay-background)] p-5 text-[var(--gs-component-overlay-text)] shadow-[var(--gs-semantic-elevation-large)] outline-none data-[state=open]:animate-dialog-in',
          className,
        )}
        {...props}
      >
        {children}
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogPrimitive.Close
              type="button"
              aria-label="Close dialog"
              className="gs-button absolute right-3 top-3 inline-flex size-9 items-center justify-center rounded-[var(--gs-semantic-radius-control)] text-[var(--gs-semantic-text-secondary)] outline-none hover:bg-[var(--gs-semantic-surface-inset)] hover:text-[var(--gs-semantic-text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--gs-semantic-focus-ring)]"
            >
              <X aria-hidden="true" className="size-4" />
            </DialogPrimitive.Close>
          </TooltipTrigger>
          <TooltipContent>Close dialog · Esc</TooltipContent>
        </Tooltip>
      </DialogPrimitive.Content>
    </DialogPortal>
  )
})
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col gap-1.5 pr-8 text-left', className)} {...props} />
)
DialogHeader.displayName = 'DialogHeader'

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end', className)}
    {...props}
  />
)
DialogFooter.displayName = 'DialogFooter'

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      'text-[length:var(--gs-semantic-type-heading-size)] font-semibold leading-[var(--gs-semantic-type-heading-line)]',
      className,
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn(
      'text-[length:var(--gs-semantic-type-label-size)] leading-5 text-[var(--gs-semantic-text-secondary)]',
      className,
    )}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
