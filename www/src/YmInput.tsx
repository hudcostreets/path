import { useEffect, useState } from "react"

const selectStyle: React.CSSProperties = {
  background: '#222',
  color: '#ddd',
  border: '1px solid #444',
  borderRadius: 4,
  padding: '0.15em 0.4em',
  fontSize: '0.85rem',
}

// Parse "YY-?MM" / "YYYY-?MM" → "YYYY-MM". Accepts "26-2", "2602", "2026-02".
// Returns null when no available month matches.
export function parseYmInput(s: string, allYms: string[]): string | null {
  const t = s.trim()
  if (!t) return null
  const m4 = t.match(/^(\d{4})-?(\d{1,2})$/)
  const m2 = t.match(/^(\d{2})-?(\d{1,2})$/)
  let yyyy: number, mm: number
  if (m4) { yyyy = parseInt(m4[1]); mm = parseInt(m4[2]) }
  else if (m2) { yyyy = 2000 + parseInt(m2[1]); mm = parseInt(m2[2]) }
  else return null
  if (mm < 1 || mm > 12) return null
  const ym = `${yyyy}-${String(mm).padStart(2, '0')}`
  return allYms.includes(ym) ? ym : null
}

export const ymToInput = (ym: string) => ym ? `${ym.slice(2, 4)}-${ym.slice(5, 7)}` : ''

export function YmInput({ value, onChange, allYms }: {
  value: string
  onChange: (v: string) => void
  allYms: string[]
}) {
  const [text, setText] = useState(ymToInput(value))
  useEffect(() => { setText(ymToInput(value)) }, [value])
  const commit = (raw: string) => {
    const parsed = parseYmInput(raw, allYms)
    if (parsed) {
      onChange(parsed)
      setText(ymToInput(parsed))
    } else {
      setText(ymToInput(value))
    }
  }
  return (
    <input
      type="text"
      value={text}
      onChange={e => setText(e.target.value)}
      onBlur={e => commit(e.currentTarget.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.currentTarget.blur() }
        else if (e.key === 'Escape') { setText(ymToInput(value)); e.currentTarget.blur() }
      }}
      placeholder="YY-MM"
      style={{
        ...selectStyle,
        width: '4.5em',
        textAlign: 'center',
        fontFamily: 'ui-monospace, monospace',
      }}
    />
  )
}
