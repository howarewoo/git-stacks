'use client'

import * as React from 'react'
import {
  DirectionProvider as DirectionPrimitive,
  useDirection,
  type TextDirection,
} from '@base-ui/react/direction-provider'

export interface DirectionProps {
  direction?: TextDirection
  children: React.ReactNode
}

export function Direction({ direction = 'ltr', children }: DirectionProps) {
  return <DirectionPrimitive direction={direction}>{children}</DirectionPrimitive>
}

export { useDirection }
export type { TextDirection }
