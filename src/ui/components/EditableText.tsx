import { useEffect, useRef, useState } from 'react'
import { PencilIcon } from './Icons'

export interface EditableTextProps {
  value: string
  /** Called only when the text actually changed and is non-empty. */
  onCommit: (next: string) => void
  /** Accessible name for the "edit" affordance, e.g. "Rename session". */
  label: string
  placeholder?: string
  className?: string
  inputClassName?: string
  maxLength?: number
}

/** Click-to-edit text. Enter commits, Escape cancels, blur commits. */
export function EditableText({
  value,
  onCommit,
  label,
  placeholder,
  className,
  inputClassName,
  maxLength = 120,
}: EditableTextProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelledRef = useRef(false)

  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  function commit() {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== value) onCommit(next)
    else setDraft(value)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        aria-label={label}
        className={['editable__input', inputClassName ?? ''].filter(Boolean).join(' ')}
        value={draft}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (cancelledRef.current) {
            cancelledRef.current = false
            return
          }
          commit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            cancelledRef.current = true
            setDraft(value)
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <button
      type="button"
      className={['editable', className ?? ''].filter(Boolean).join(' ')}
      aria-label={`${label}: ${value || placeholder || ''}`}
      onClick={() => setEditing(true)}
    >
      <span className="editable__text">{value || placeholder}</span>
      <PencilIcon className="editable__pencil" />
    </button>
  )
}
