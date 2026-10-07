import * as React from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  HTMLDivElement,
  Omit<DialogPrimitive.Backdrop.Props, 'className'> & { className?: string }
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Backdrop
    ref={ref}
    data-slot="dialog-overlay"
    className={cn(
      'fixed inset-0 z-[var(--gs-component-overlay-z-index)] bg-[color-mix(in_srgb,var(--gs-semantic-text-primary)_34%,transparent)]',
      className,
    )}
    {...props}
  />
))
DialogOverlay.displayName = 'DialogOverlay'

const DialogContent = React.forwardRef<
  HTMLDivElement,
  Omit<DialogPrimitive.Popup.Props, 'className'> & { className?: string }
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Popup
      ref={ref}
      data-slot="dialog-content"
      className={cn(
        'fixed left-1/2 top-1/2 z-[var(--gs-component-overlay-z-index)] grid max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-5 overflow-y-auto rounded-[var(--gs-semantic-radius-workbench)] border border-[var(--gs-semantic-border-essential)] bg-[var(--gs-component-overlay-background)] p-5 text-[var(--gs-component-overlay-text)] shadow-[var(--gs-semantic-elevation-large)] outline-none data-[open]:animate-dialog-in',
        className,
      )}
      {...props}
    >
      {children}
      <Tooltip>
        <TooltipTrigger
          render={
            <DialogPrimitive.Close
              type="button"
              aria-label="Close dialog"
              className="gs-button absolute right-3 top-3 inline-flex size-9 items-center justify-center rounded-[var(--gs-semantic-radius-control)] text-[var(--gs-semantic-text-secondary)] outline-none hover:bg-[var(--gs-semantic-surface-inset)] hover:text-[var(--gs-semantic-text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--gs-semantic-focus-ring)]"
            />
          }
        >
          <X aria-hidden="true" className="size-4" />
        </TooltipTrigger>
        <TooltipContent>Close dialog · Esc</TooltipContent>
      </Tooltip>
    </DialogPrimitive.Popup>
  </DialogPortal>
))
DialogContent.displayName = 'DialogContent'

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col gap-2 pr-8 text-left', className)} {...props} />
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
  React.ComponentRef<typeof DialogPrimitive.Title>,
  Omit<DialogPrimitive.Title.Props, 'className'> & { className?: string }
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    data-slot="dialog-title"
    className={cn(
      'text-[length:var(--gs-semantic-type-heading-size)] font-semibold leading-[var(--gs-semantic-type-heading-line)]',
      className,
    )}
    {...props}
  />
))
DialogTitle.displayName = 'DialogTitle'

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  Omit<DialogPrimitive.Description.Props, 'className'> & { className?: string }
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    data-slot="dialog-description"
    className={cn(
      'text-[length:var(--gs-semantic-type-body-size)] leading-[var(--gs-semantic-type-body-line)] text-[var(--gs-semantic-text-secondary)]',
      className,
    )}
    {...props}
  />
))
DialogDescription.displayName = 'DialogDescription'

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
