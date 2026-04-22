import { type ReactNode } from 'react'

interface Props {
  title: string
  right?: ReactNode
  className?: string
  contentClassName?: string
  children: ReactNode
}

/**
 * Panel shell used across the Market workbench.
 * Just title + optional right slot + content. No cross-panel smarts — each
 * panel owns its own fetch and render inside the children.
 */
export function Card({ title, right, className, contentClassName, children }: Props) {
  return (
    <section className={`flex flex-col border border-border rounded bg-bg-secondary/30 ${className ?? ''}`}>
      <header className="flex items-center justify-between gap-3 px-3 py-2 border-b border-border/60">
        <h3 className="text-[13px] font-medium text-text truncate">{title}</h3>
        {right && <div className="shrink-0">{right}</div>}
      </header>
      <div className={contentClassName ?? 'p-3'}>{children}</div>
    </section>
  )
}
