import { cn } from '../../lib/utils'
import type { ButtonHTMLAttributes } from 'react'

export const Button = ({ className, type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex h-10 items-center justify-center rounded-md bg-sky-500 px-4 text-sm font-medium text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    />
  )
}
