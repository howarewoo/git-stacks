import * as React from 'react'
import { cn } from '../../lib/utils'
import { Loader2 } from 'lucide-react'

function Spinner({ className, ...props }: React.ComponentProps<'svg'>) {
  return (
    <Loader2
      data-slot="spinner"
      aria-hidden="true"
      className={cn('size-4 animate-spin', className)}
      {...props}
    />
  )
}

export { Spinner }
