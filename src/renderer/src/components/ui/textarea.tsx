import * as React from 'react'
import { cn } from '../../lib/utils'

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  size?: 'compact' | 'standard'
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, size = 'standard', ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'w-full resize-y rounded-[var(--gs-semantic-radius-control)] border border-[var(--gs-component-field-border)] bg-[var(--gs-component-field-background)] px-3 py-2 text-[var(--gs-component-field-text)] outline-none transition-colors placeholder:text-[var(--gs-component-field-placeholder)] focus-visible:border-[var(--gs-component-field-focus-border)] focus-visible:ring-2 focus-visible:ring-[var(--gs-component-field-focus-ring)] disabled:cursor-not-allowed disabled:bg-[var(--gs-component-field-disabled-background)] disabled:opacity-65',
        size === 'compact'
          ? 'min-h-20 text-[var(--gs-semantic-type-metadata-size)]'
          : 'min-h-24 text-[var(--gs-semantic-type-label-size)]',
        className,
      )}
      {...props}
    />
  ),
)
Textarea.displayName = 'Textarea'
