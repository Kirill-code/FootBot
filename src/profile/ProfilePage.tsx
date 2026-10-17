import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import { useEffect, useState } from 'react'
import ResultSnapshot from '../camera/ResultSnapshot'

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
  const model = useLiveQuery(() => db.footModels.orderBy('createdAt').reverse().first(), [])
  // Контур top-ракурса хранится на замере; фото — последний top-снимок.
  const lastMeasurement = useLiveQuery(() => db.measurements.orderBy('createdAt').reverse().first(), [])

  const volumeText = { low: 'низкий', medium: 'средний', high: 'высокий' } as const

  const topPhoto = photos?.find((p) => p.footWidthMm !== null)
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!topPhoto) return
    const u = URL.createObjectURL(topPhoto.blob)
    setSnapshotUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [topPhoto])

  return (
    <main className="page">
      <h1 className="page-title">Профиль</h1>
      <p className="page-subtitle">Ваши фото стоп и замеры</p>

      {model && (
        <div className="card" style={{ display: 'grid', gap: 6 }}>
          <p style={{ margin: 0, fontWeight: 600 }}>Модель стопы</p>
          {snapshotUrl && lastMeasurement?.contour && lastMeasurement.contour.length >= 3 && (
            <ResultSnapshot url={snapshotUrl} contour={lastMeasurement.contour} recognized />
          )}
          <p className="hint">
            {model.lengthMm !== null && <>Длина <strong>{model.lengthMm} мм</strong> · </>}
            {model.widthMm !== null && <>ширина <strong>{model.widthMm} мм</strong> · </>}
            {model.instepHeightMm !== null && <>подъём <strong>{model.instepHeightMm} мм</strong> · </>}
            {model.ballWidthMm !== null && <>передний отдел <strong>{model.ballWidthMm} мм</strong> · </>}
            {model.volumeHint !== null && <>объём: <strong>{volumeText[model.volumeHint]}</strong></>}
          </p>
          {model.inconsistent && (
            <p className="hint" style={{ color: '#ff7a7a' }}>Замеры ракурсов различаются — пересните.</p>
          )}
        </div>
      )}

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
