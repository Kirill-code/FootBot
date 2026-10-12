// Экранная панель отладки: перехватывает ошибки и логи консоли,
// показывает их поверх приложения. Включается параметром ?debug=1
// или тапом по красному бейджу с количеством ошибок.
import { useEffect, useRef, useState } from 'react'

interface LogEntry {
  time: string
  kind: 'error' | 'warn' | 'log'
  text: string
}

const MAX_ENTRIES = 30

export default function DebugOverlay() {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).has('debug'))
  const [errorCount, setErrorCount] = useState(0)
  const bufRef = useRef<LogEntry[]>([])

  useEffect(() => {
    const push = (kind: LogEntry['kind'], text: string) => {
      const entry: LogEntry = { time: new Date().toLocaleTimeString(), kind, text: text.slice(0, 400) }
      bufRef.current = [...bufRef.current, entry].slice(-MAX_ENTRIES)
      setEntries(bufRef.current)
      if (kind === 'error') setErrorCount((c) => c + 1)
    }
    const fmt = (args: unknown[]) =>
      args
        .map((a) => {
          if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ''}`
          try {
            return typeof a === 'string' ? a : JSON.stringify(a)
          } catch {
            return String(a)
          }
        })
        .join(' ')

    const origError = console.error.bind(console)
    const origWarn = console.warn.bind(console)
    const origLog = console.log.bind(console)
    console.error = (...args: unknown[]) => {
      origError(...args)
      push('error', fmt(args))
    }
    console.warn = (...args: unknown[]) => {
      origWarn(...args)
      push('warn', fmt(args))
    }
    console.log = (...args: unknown[]) => {
      origLog(...args)
      push('log', fmt(args))
    }

    const onError = (e: ErrorEvent) => push('error', `onerror: ${e.message} @ ${e.filename}:${e.lineno}`)
    const onRejection = (e: PromiseRejectionEvent) =>
      push('error', `unhandledrejection: ${fmt([e.reason])}`)
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      console.error = origError
      console.warn = origWarn
      console.log = origLog
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  return (
    <>
      {errorCount > 0 && !open && (
        <button
          onClick={() => setOpen(true)}
          style={{
            position: 'fixed',
            top: 8,
            right: 8,
            zIndex: 999,
            background: '#dc2626',
            color: '#fff',
            border: 'none',
            borderRadius: 12,
            padding: '4px 10px',
            fontSize: 12,
            fontWeight: 700
          }}
        >
          🐞 {errorCount}
        </button>
      )}
      {open && (
        <div
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: 0,
            maxHeight: '45vh',
            overflowY: 'auto',
            background: 'rgba(0,0,0,0.92)',
            color: '#d1d5db',
            font: '11px/1.5 monospace',
            padding: 8,
            zIndex: 999,
            borderTop: '1px solid #374151',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all'
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <strong style={{ color: '#fff' }}>Debug ({entries.length})</strong>
            <button onClick={() => setOpen(false)} style={{ color: '#9ca3af', background: 'none', border: 'none' }}>
              свернуть ✕
            </button>
          </div>
          {entries.length === 0 && <div>пока пусто — ошибок нет</div>}
          {entries.map((e, i) => (
            <div key={i} style={{ color: e.kind === 'error' ? '#f87171' : e.kind === 'warn' ? '#e8c547' : '#9ca3af' }}>
              [{e.time}] {e.text}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
