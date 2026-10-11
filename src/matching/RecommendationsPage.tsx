import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { loadCatalog } from '../catalog/catalogApi'
import type { Fit, Purpose, ShoeModel } from '../catalog/types'
import ShoeCard from '../ui/ShoeCard'
import BreakdownBars from '../ui/BreakdownBars'
import { scoreModel } from './scoring'
import type { ScoreResult } from './scoring'
import { loadProfile, saveManualProfile } from './profile'
import type { UserProfile } from './profile'

interface ScoredModel {
  model: ShoeModel
  result: ScoreResult
}

const FULLNESS_OPTIONS: { value: Fit; label: string }[] = [
  { value: 'narrow', label: 'Узкая' },
  { value: 'medium', label: 'Средняя' },
  { value: 'wide', label: 'Широкая' }
]

const PURPOSE_OPTIONS: { value: Purpose; label: string }[] = [
  { value: 'casual', label: 'Повседневная носка' },
  { value: 'running', label: 'Бег' },
  { value: 'basketball', label: 'Баскетбол' },
  { value: 'trail', label: 'Трейл' }
]

function formatUs(us: number): string {
  return Number.isInteger(us) ? String(us) : us.toFixed(1)
}

/** Форма быстрого ввода профиля без сканирования. */
function QuickProfileForm({ onSubmit }: { onSubmit: (profile: UserProfile) => void }) {
  const [length, setLength] = useState('')
  const [fullness, setFullness] = useState<Fit>('medium')
  const [purpose, setPurpose] = useState<Purpose>('casual')
  const [error, setError] = useState<string | null>(null)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const footLengthMm = Number(length)
    if (!Number.isFinite(footLengthMm) || footLengthMm < 150 || footLengthMm > 350) {
      setError('Введите длину стопы в миллиметрах (150–350).')
      return
    }
    onSubmit({ footLengthMm: Math.round(footLengthMm), fullness, purpose, fitPreference: 'comfort' })
  }

  return (
    <form className="card" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
        Длина стопы, мм
        <input
          className="input"
          type="number"
          inputMode="decimal"
          min={150}
          max={350}
          placeholder="например, 265"
          value={length}
          onChange={(e) => setLength(e.target.value)}
        />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
        Полнота стопы
        <select className="input" value={fullness} onChange={(e) => setFullness(e.target.value as Fit)}>
          {FULLNESS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
        Назначение
        <select className="input" value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose)}>
          {PURPOSE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>
      {error && <p className="hint" style={{ color: 'var(--danger)' }}>{error}</p>}
      <button className="btn btn-block" type="submit">Показать подбор</button>
    </form>
  )
}

export default function RecommendationsPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(true)
  const [models, setModels] = useState<ShoeModel[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    loadProfile()
      .then((p) => {
        if (!cancelled) setProfile(p)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setProfileLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!profile) return
    let cancelled = false
    loadCatalog()
      .then((catalog) => {
        if (!cancelled) setModels(catalog)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Ошибка загрузки каталога')
      })
    return () => {
      cancelled = true
    }
  }, [profile])

  const results = useMemo<ScoredModel[]>(() => {
    if (!profile || !models) return []
    return models
      .map((model) => ({ model, result: scoreModel(profile, model) }))
      .sort((a, b) => b.result.score - a.result.score)
  }, [profile, models])

  const handleQuickSubmit = (p: UserProfile) => {
    saveManualProfile(p)
    setProfile(p)
  }

  return (
    <main className="page">
      <h1 className="page-title">Мой подбор</h1>
      <p className="page-subtitle">Персональные рекомендации кроссовок</p>

      {profileLoading && <p className="hint">Загрузка…</p>}

      {!profileLoading && !profile && (
        <>
          <div className="empty-state">
            Чтобы собрать персональный подбор, сначала измерьте стопу.<br />
            <Link to="/scan" className="btn" style={{ marginTop: 12 }}>Сканировать стопу</Link>
          </div>
          <p className="hint">Или укажите данные вручную — без фото:</p>
          <QuickProfileForm onSubmit={handleQuickSubmit} />
        </>
      )}

      {profile && (
        <div className="card">
          <p className="hint">
            Длина стопы: {profile.footLengthMm} мм
            {profile.footWidthMm != null && ` · Ширина: ${profile.footWidthMm} мм`}
            {profile.instepHeightMm != null && ` · Подъём: ${profile.instepHeightMm} мм`} ·{' '}
            {FULLNESS_OPTIONS.find((o) => o.value === profile.fullness)?.label.toLowerCase()} полнота ·{' '}
            {PURPOSE_OPTIONS.find((o) => o.value === profile.purpose)?.label.toLowerCase()}
          </p>
        </div>
      )}

      {error && <p className="hint" style={{ color: 'var(--danger)' }}>{error}</p>}
      {profile && !error && models === null && <p className="hint">Загрузка каталога…</p>}

      {results.length > 0 && (
        <>
          <div className="shoe-grid">
            {results.map(({ model, result }) => (
              <div key={model.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Link to={`/catalog/${model.id}`}>
                  <ShoeCard
                    model={model}
                    score={result.score}
                    verdict={result.verdict}
                    recommendedUs={formatUs(result.recommendedUs)}
                    recommendedEu={result.recommendedEu}
                  />
                </Link>
                {result.notes.length > 0 && (
                  <p className="shoe-card-note">
                    {result.notes.slice(0, 2).join(' · ')}
                    {result.notes.length > 2 && '…'}
                  </p>
                )}
                <details className="compat-details">
                  <summary>Детали оценки</summary>
                  <BreakdownBars breakdown={result.breakdown} />
                </details>
              </div>
            ))}
          </div>
          <p className="hint">
            Подбор по длине не учитывает полноту и подъём — рекомендуем примерку.
          </p>
        </>
      )}
    </main>
  )
}
