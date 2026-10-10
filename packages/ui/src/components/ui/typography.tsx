'use client'

import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const typographyVariants = cva('', {
  variants: {
    variant: {
      h1: 'scroll-m-20 text-3xl font-bold tracking-tight lg:text-4xl',
      h2: 'scroll-m-20 text-2xl font-semibold tracking-tight first:mt-0',
      h3: 'scroll-m-20 text-xl font-semibold tracking-tight',
      h4: 'scroll-m-20 text-lg font-semibold tracking-tight',
      p: 'leading-7 [&:not(:first-child)]:mt-4',
      blockquote: 'mt-4 border-l-2 border-border pl-4 italic text-muted-foreground',
      list: 'my-4 ml-6 list-disc [&>li]:mt-1',
      inlineCode:
        'relative rounded bg-muted px-[0.3rem] py-[0.2rem] font-mono text-[0.875rem] font-semibold text-foreground',
      lead: 'text-xl text-muted-foreground',
      large: 'text-lg font-semibold',
      small:
        'text-[length:var(--gs-semantic-type-metadata-size)] font-medium leading-[var(--gs-semantic-type-metadata-line)]',
      muted: 'text-[length:var(--gs-semantic-type-metadata-size)] text-muted-foreground',
      /* Workbench canonical roles */
      heading:
        'text-[length:var(--gs-semantic-type-heading-size)] font-semibold leading-[var(--gs-semantic-type-heading-line)] text-foreground',
      body: 'text-[length:var(--gs-semantic-type-body-size)] leading-[var(--gs-semantic-type-body-line)] text-foreground',
      label:
        'text-[length:var(--gs-semantic-type-label-size)] font-medium leading-[var(--gs-semantic-type-label-line)] text-foreground',
      metadata:
        'text-[length:var(--gs-semantic-type-metadata-size)] leading-[var(--gs-semantic-type-metadata-line)] text-muted-foreground',
      code: 'font-mono text-[length:var(--gs-semantic-type-metadata-size)] leading-[var(--gs-semantic-type-metadata-line)] [font-variant-numeric:tabular-nums]',
    },
  },
  defaultVariants: {
    variant: 'body',
  },
})

export interface TypographyProps
  extends React.HTMLAttributes<HTMLElement>,
    VariantProps<typeof typographyVariants> {
  as?: React.ElementType
}

export function Typography({
  className,
  variant,
  as: Component,
  children,
  ...props
}: TypographyProps) {
  const Comp =
    Component ??
    (variant === 'h1'
      ? 'h1'
      : variant === 'h2'
        ? 'h2'
        : variant === 'h3'
          ? 'h3'
          : variant === 'h4'
            ? 'h4'
            : variant === 'blockquote'
              ? 'blockquote'
              : variant === 'list'
                ? 'ul'
                : variant === 'inlineCode' || variant === 'code'
                  ? 'code'
                  : 'p')
  return (
    <Comp className={cn(typographyVariants({ variant, className }))} {...props}>
      {children}
    </Comp>
  )
}

export { typographyVariants }
