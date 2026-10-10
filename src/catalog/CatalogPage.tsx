import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { loadCatalog } from './catalogApi'
import type { ShoeModel } from './types'
import ShoeCard from '../ui/ShoeCard'

export default function CatalogPage() {
  const [models, setModels] = useState<ShoeModel[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadCatalog()
      .then(setModels)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Ошибка загрузки'))
  }, [])

  return (
    <main className="page">
      <h1 className="page-title">Каталог</h1>
      <p className="page-subtitle">Все модели из базы FootBot</p>

      {error && <p className="hint" style={{ color: 'var(--danger)' }}>{error}</p>}
      {models === null && !error && <p className="hint">Загрузка…</p>}
      {models !== null && models.length === 0 && (
        <div className="empty-state">
          Каталог пока пуст —<br />модели скоро появятся.
        </div>
      )}
      {models !== null && models.length > 0 && (
        <div className="shoe-grid">
          {models.map((m) => (
            <Link key={m.id} to={`/catalog/${m.id}`}>
              <ShoeCard model={m} />
            </Link>
          ))}
        </div>
      )}
    </main>
  )
}
