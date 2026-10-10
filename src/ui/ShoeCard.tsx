import { catalogImageUrl } from '../catalog/catalogApi'
import type { Fit, Purpose, ShoeModel } from '../catalog/types'

const PURPOSE_LABELS: Record<Purpose, string> = {
  casual: 'Повседневные',
  running: 'Бег',
  basketball: 'Баскетбол',
  trail: 'Трейл'
}

const FIT_LABELS: Record<Fit, string> = {
  narrow: 'Узкие',
  medium: 'Средние',
  wide: 'Широкие'
}

interface Props {
  model: ShoeModel
  score?: number
  verdict?: 'perfect' | 'good' | 'poor'
  /** Рекомендуемый US-размер (уже отформатированный). */
  recommendedUs?: string
  /** Рекомендуемый EU-размер. */
  recommendedEu?: string
}

export default function ShoeCard({ model, score, verdict, recommendedUs, recommendedEu }: Props) {
  return (
    <article className="shoe-card">
      {model.image && <img className="shoe-card-img" src={catalogImageUrl(model.image)} alt={model.name} loading="lazy" />}
      <div className="shoe-card-body">
        <span className="shoe-card-brand">{model.brand}</span>
        <span className="shoe-card-name">{model.name}</span>
        <div className="shoe-card-tags">
          <span className="tag">{PURPOSE_LABELS[model.purpose]}</span>
          <span className="tag">{FIT_LABELS[model.fit]}</span>
          {score !== undefined && (
            <span className={`tag verdict-${verdict}`}>
              {score}% {verdict === 'perfect' ? 'ваш размер' : verdict === 'good' ? 'с нюансами' : 'низкая совместимость'}
            </span>
          )}
        </div>
        {recommendedUs !== undefined && (
          <span className="shoe-card-rec">
            Ваш размер: US {recommendedUs} · EU {recommendedEu ?? '—'}
          </span>
        )}
        {model.priceUsd !== undefined && (
          <span className="shoe-card-price">${model.priceUsd}</span>
        )}
      </div>
    </article>
  )
}
