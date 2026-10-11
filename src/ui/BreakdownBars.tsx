import type { ScoreBreakdown } from '../matching/scoring'

const ROWS: { key: keyof ScoreBreakdown; label: string }[] = [
  { key: 'S_length', label: 'Длина' },
  { key: 'S_width', label: 'Полнота' },
  { key: 'S_volume', label: 'Подъём' },
  { key: 'S_last', label: 'Колодка' },
  { key: 'S_purpose', label: 'Назначение' }
]

/** Мини-бары раскладки Score по компонентам (значения 0..1). */
export default function BreakdownBars({ breakdown }: { breakdown: ScoreBreakdown }) {
  return (
    <div className="score-breakdown">
      {ROWS.map(({ key, label }) => {
        const value = breakdown[key]
        const percent = Math.round(value * 100)
        return (
          <div className="score-bar-row" key={key} title={`${label}: ${percent}%`}>
            <span className="score-bar-label">{label}</span>
            <span className="score-bar-track">
              <span className="score-bar-fill" style={{ width: `${percent}%` }} />
            </span>
            <span className="score-bar-value">{percent}%</span>
          </div>
        )
      })}
    </div>
  )
}
