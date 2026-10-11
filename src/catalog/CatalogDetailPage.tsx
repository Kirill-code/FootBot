import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { getModelById, catalogImageUrl } from './catalogApi'
import type { Fit, Purpose, ShoeModel } from './types'
import { scoreModel } from '../matching/scoring'
import type { ScoreResult } from '../matching/scoring'
import { loadProfile } from '../matching/profile'
import type { UserProfile } from '../matching/profile'
import BreakdownBars from '../ui/BreakdownBars'

const PURPOSE_LABELS: Record<Purpose, string> = {
  casual: 'Повседневные',
  running: 'Беговые',
  basketball: 'Баскетбольные',
  trail: 'Трейловые'
}

const FIT_LABELS: Record<Fit, string> = {
  narrow: 'Узкая',
  medium: 'Средняя',
  wide: 'Широкая'
}

const INSTEP_LABELS: Record<'low' | 'medium' | 'high', string> = {
  low: 'Низкий крой',
  medium: 'Средний',
  high: 'Высокий крой'
}

export default function CatalogDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [model, setModel] = useState<ShoeModel | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [profile, setProfile] = useState<UserProfile | null>(null)

  useEffect(() => {
    if (!id) return
    setModel(null)
    setNotFound(false)
    getModelById(id)
      .then((m) => (m ? setModel(m) : setNotFound(true)))
      .catch(() => setNotFound(true))
  }, [id])

  useEffect(() => {
    let cancelled = false
    loadProfile()
      .then((p) => {
        if (!cancelled) setProfile(p)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const score = useMemo<ScoreResult | null>(() => {
    if (!profile || !model) return null
    return scoreModel(profile, model)
  }, [profile, model])

  return (
    <main className="page">
      <Link to="/catalog" className="hint">← Назад в каталог</Link>

      {notFound && (
        <div className="empty-state">
          Модель не найдена.<br />
          Возможно, она была удалена из каталога.
        </div>
      )}

      {model === null && !notFound && <p className="hint">Загрузка…</p>}

      {model !== null && (
        <>
          <h1 className="page-title">{model.name}</h1>
          <p className="page-subtitle">{model.brand}</p>
          {model.image && <img className="shoe-card-img" style={{ borderRadius: 14 }} src={catalogImageUrl(model.image)} alt={model.name} />}

          {model.priceUsd !== undefined && (
            <p className="page-title" style={{ fontSize: 20 }}>${model.priceUsd}</p>
          )}

          {model.description && (
            <div className="card">
              <p className="hint">{model.description}</p>
            </div>
          )}

          <div className="card">
            <p className="hint">
              Назначение: {PURPOSE_LABELS[model.purpose]}<br />
              Полнота: {FIT_LABELS[model.fit]}<br />
              Колодка: {FIT_LABELS[model.last]}<br />
              Подъём: {INSTEP_LABELS[model.instepTolerance ?? 'medium']}
              {model.fitAdjustment !== 0 && (
                <>
                  <br />
                  Поправка к размеру: {model.fitAdjustment > 0 ? '+' : ''}
                  {model.fitAdjustment} US
                </>
              )}
            </p>
          </div>

          {score && (
            <div className="card">
              <p className="hint" style={{ marginBottom: 8 }}>
                Ваша оценка совместимости:
              </p>
              <p className={`verdict-${score.verdict}`} style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
                {score.score}% ·{' '}
                {score.verdict === 'perfect' ? 'ваш размер' : score.verdict === 'good' ? 'подходит с нюансами' : 'низкая совместимость'}
              </p>
              <p className="hint" style={{ marginTop: 8 }}>
                Рекомендуемый размер: US {Number.isInteger(score.recommendedUs) ? score.recommendedUs : score.recommendedUs.toFixed(1)} · EU {score.recommendedEu}
              </p>
              <BreakdownBars breakdown={score.breakdown} />
              {score.notes.length > 0 && (
                <ul className="compat-notes">
                  {score.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {!profile && (
            <p className="hint">
              <Link to="/scan" style={{ textDecoration: 'underline' }}>Сканируйте стопу</Link> или{' '}
              <Link to="/recommendations" style={{ textDecoration: 'underline' }}>укажите размер вручную</Link>,
              чтобы увидеть оценку совместимости.
            </p>
          )}

          <div className="card">
            <p className="hint" style={{ marginBottom: 8 }}>Размерная сетка:</p>
            <table className="size-table">
              <thead>
                <tr>
                  <th>US</th>
                  <th>UK</th>
                  <th>EU</th>
                  <th>Стопа, мм</th>
                </tr>
              </thead>
              <tbody>
                {model.sizeChart.map((s) => (
                  <tr
                    key={`${s.us}-${s.eu}`}
                    className={score && s.us === score.recommendedUs ? 'size-row-recommended' : undefined}
                  >
                    <td>{Number.isInteger(s.us) ? s.us : s.us.toFixed(1)}</td>
                    <td>{Number.isInteger(s.uk) ? s.uk : s.uk.toFixed(1)}</td>
                    <td>{s.eu}</td>
                    <td>{s.footLengthMm}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {score && (
              <p className="hint" style={{ marginTop: 8 }}>Подсвечена строка с рекомендуемым размером.</p>
            )}
          </div>
        </>
      )}
    </main>
  )
}
