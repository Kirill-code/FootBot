// Полноэкранный режим сканирования: оба ракурса в одной сессии.
// Покрывает весь viewport (position: fixed), поверх CameraView (chrome=false)
// рисует свои компактные подсказки: плашка шага с точками-прогрессом,
// строка-подсказка, круглая кнопка спуска, галерея, переключатель Л/П,
// крестик закрытия. После спуска side — onComplete → родитель запускает
// анализ (Web Worker). Камера останавливается размонтированием CameraView.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FootView } from '../analysis/measureFoot'
import type { FootSide } from '../profile/db'
import CameraView, { type CameraShot } from './CameraView'

export interface ScanShots {
  top: CameraShot
  side: CameraShot
}

interface FullScanScreenProps {
  foot: FootSide
  onFootChange: (side: FootSide) => void
  onClose: () => void
  onComplete: (shots: ScanShots) => void
}

type Stage = 'top' | 'transition' | 'side'

const STEP_INFO: Record<'top' | 'side', { n: number; title: string; hint: string }> = {
  top: { n: 1, title: 'Сверху — длина и ширина', hint: 'пальцы от вас · карта в углу рамки · босиком' },
  side: { n: 2, title: 'Сбоку — подъём', hint: 'камера у пола · видны пятка и носок · босиком' }
}

const smallRoundBtn: React.CSSProperties = {
  width: 46,
  height: 46,
  borderRadius: '50%',
  border: '1px solid rgba(255,255,255,0.35)',
  background: 'rgba(255,255,255,0.12)',
  color: '#fff',
  fontSize: 16,
  cursor: 'pointer'
}

export default function FullScanScreen({ foot, onFootChange, onClose, onComplete }: FullScanScreenProps) {
  const [stage, setStage] = useState<Stage>('top')
  const [camLive, setCamLive] = useState(false)
  const topShot = useRef<CameraShot | null>(null)
  const actionsRef = useRef<{ capture: () => void; openGallery: () => void } | null>(null)

  const handleCapture = useCallback(
    (shot: CameraShot) => {
      if (stage === 'top') {
        topShot.current = shot
        setStage('transition')
      } else if (stage === 'side') {
        if (topShot.current) onComplete({ top: topShot.current, side: shot })
      }
    },
    [stage, onComplete]
  )

  // Короткий переход между ракурсами — полсекунды.
  useEffect(() => {
    if (stage !== 'transition') return
    const t = setTimeout(() => setStage('side'), 600)
    return () => clearTimeout(t)
  }, [stage])

  const view: FootView = stage === 'side' ? 'side' : 'top'
  const info = STEP_INFO[view]

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: '#000',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <div style={{ position: 'absolute', inset: 0 }}>
        <CameraView
          view={view}
          onCapture={handleCapture}
          foot={foot}
          onFootGuess={onFootChange}
          chrome={false}
          actionsRef={actionsRef}
          onCameraState={(st) => setCamLive(st === 'live')}
        />
      </div>

      {/* Верхняя плашка: шаг + точки-прогресс + закрыть. */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          padding: '14px 16px',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          background: 'linear-gradient(rgba(0,0,0,0.65), transparent)',
          color: '#fff',
          pointerEvents: 'none'
        }}
      >
        <div>
          <div style={{ fontWeight: 600, fontSize: 16 }}>
            Шаг {info.n}/2 · {info.title}
          </div>
          <div style={{ fontSize: 12, color: 'var(--accent)', letterSpacing: 4, marginTop: 3 }}>
            {view === 'top' ? '● ○' : '● ●'}
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Закрыть сканирование"
          style={{ ...smallRoundBtn, pointerEvents: 'auto', fontSize: 18 }}
        >
          ✕
        </button>
      </div>

      {/* Нижняя зона: строка-подсказка + кнопки. */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          padding: '20px 16px 26px',
          display: 'grid',
          justifyItems: 'center',
          gap: 14,
          background: 'linear-gradient(transparent, rgba(0,0,0,0.78))'
        }}
      >
        <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: 12, textAlign: 'center' }}>{info.hint}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 36 }}>
          <button
            onClick={() => actionsRef.current?.openGallery()}
            aria-label="Выбрать из галереи"
            style={smallRoundBtn}
          >
            🖼
          </button>
          <button
            onClick={() => actionsRef.current?.capture()}
            aria-label="Снять"
            disabled={stage === 'transition'}
            style={{
              width: 76,
              height: 76,
              borderRadius: '50%',
              border: '4px solid #fff',
              background: 'rgba(255,255,255,0.25)',
              cursor: 'pointer',
              opacity: stage === 'transition' ? 0.4 : 1
            }}
          />
          <button
            onClick={() => onFootChange(foot === 'left' ? 'right' : 'left')}
            aria-label="Сменить стопу"
            title="Левая/правая стопа"
            style={{ ...smallRoundBtn, fontWeight: 700 }}
          >
            {foot === 'left' ? 'Л' : 'П'}
          </button>
        </div>
      </div>

      {/* Переход между ракурсами: висит, пока камера шага 2 не открылась
          (при смене view поток перезапускается — не показываем чёрный экран). */}
      {stage === 'transition' && !camLive && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            background: 'rgba(0,0,0,0.72)',
            color: '#fff',
            textAlign: 'center'
          }}
        >
          <div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>Готово ✓</div>
            <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.8)', marginTop: 6 }}>
              Теперь снимите стопу СБОКУ
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
