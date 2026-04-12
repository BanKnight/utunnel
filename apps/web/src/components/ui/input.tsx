import { cn } from '../../lib/utils'
import type { InputHTMLAttributes } from 'react'

export const Input = ({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) => {
  return (
    <input
      className={cn(
        'flex h-10 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none ring-0 placeholder:text-slate-500 focus:border-sky-500',
        className,
      )}
      {...props}
    />
  )
}
