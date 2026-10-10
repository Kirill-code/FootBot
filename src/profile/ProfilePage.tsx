import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import { useEffect, useState } from 'react'

function PhotoItem({ blob, foot, createdAt, footLengthMm, footWidthMm }: { blob: Blob; foot: 'left' | 'right'; createdAt: number; footLengthMm: number | null; footWidthMm: number | null }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    const objectUrl = URL.createObjectURL(blob)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [blob])

  return (
    <div className="photo-item">
      {url && <img src={url} alt={foot === 'left' ? 'Левая стопа' : 'Правая стопа'} />}
      <div className="photo-item-meta">
        <span>{foot === 'left' ? 'Левая стопа' : 'Правая стопа'}</span>
        <span className="dim">{new Date(createdAt).toLocaleString('ru-RU')}</span>
        {footLengthMm != null && footWidthMm != null ? (
          <span className="dim">Длина {footLengthMm} мм · Ширина {footWidthMm} мм</span>
        ) : (
          <span className="dim">Не измерено</span>
        )}
      </div>
    </div>
  )
}

export default function ProfilePage() {
  const photos = useLiveQuery(() => db.photos.orderBy('createdAt').reverse().toArray(), [])

  return (
    <main className="page">
      <h1 className="page-title">Профиль</h1>
      <p className="page-subtitle">Ваши фото стоп и замеры</p>

      {photos === undefined ? (
        <p className="hint">Загрузка…</p>
      ) : photos.length === 0 ? (
        <div className="empty-state">
          Пока нет ни одного фото.<br />
          Сделайте первое сканирование стопы!
        </div>
      ) : (
        <div className="photo-list">
          {photos.map((p) => (
            <PhotoItem key={p.id} blob={p.blob} foot={p.foot} createdAt={p.createdAt} footLengthMm={p.footLengthMm} footWidthMm={p.footWidthMm} />
          ))}
        </div>
      )}
    </main>
  )
}
