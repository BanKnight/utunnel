import { cn } from '../../lib/utils'
import type { HTMLAttributes } from 'react'

export const Card = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => {
  return <div className={cn('rounded-xl border border-slate-800 bg-slate-900/70 p-5', className)} {...props} />
}
