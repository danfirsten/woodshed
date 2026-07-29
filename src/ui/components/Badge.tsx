import type { ReactNode } from 'react'

export type BadgeTone = 'neutral' | 'accent' | 'muted' | 'danger'

export function Badge({
  tone = 'neutral',
  dot = false,
  className,
  children,
}: {
  tone?: BadgeTone
  dot?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <span
      className={['badge', tone !== 'neutral' ? `badge--${tone}` : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
    >
      {dot && <span className="badge__dot" aria-hidden="true" />}
      {children}
    </span>
  )
}
