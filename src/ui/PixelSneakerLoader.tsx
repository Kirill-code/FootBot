// Пиксельный кроссовок-лоадер (8-bit, side-view, в духе лыжного ботинка
// Crispolti из логотипа): белый/серый корпус, жёлтая подошва, шнуровка.
// Спрайт — inline SVG с crispEdges (без canvas/ассетов); «вращение» —
// покадровая анимация наклонов/подпрыгивания через steps(1), как в 8-битных
// спрайтах. Используется во всех состояниях ожидания сканирования.

// 16×10 пикселей. B — тёмный контур, W — белый корпус, L — шнуровка
// (светло-серый), Y — жёлтая подошва.
const SPRITE = [
  '................',
  '..BB............',
  '.BWWB...........',
  '.BWWWB..........',
  '.BWWWWWWBBB.....',
  '.BWWLLLLWWWWB...',
  '.BWLLLLLLWWWWB..',
  '.BWWWWWWWWWWWWB.',
  '.BYYYYYYYYYYYYYB.',
  '..BBBBBBBBBBBB..'
] as const

const PALETTE: Record<string, string> = {
  B: '#141414',
  W: '#f2f2f2',
  L: '#c9c9c9',
  Y: '#e8c547'
}

// Модульный расчёт один раз.
const RECTS: Array<{ x: number; y: number; fill: string }> = []
for (let y = 0; y < SPRITE.length; y++) {
  const row = SPRITE[y]
  for (let x = 0; x < row.length; x++) {
    const ch = row[x]
    if (ch !== '.') RECTS.push({ x, y, fill: PALETTE[ch] })
  }
}

interface PixelSneakerLoaderProps {
  /** Высота спрайта (ширина 1.6×). */
  size?: number
  text?: string
}

export default function PixelSneakerLoader({ size = 64, text }: PixelSneakerLoaderProps) {
  return (
    <div style={{ display: 'grid', justifyItems: 'center', gap: 8 }}>
      <div
        className="pixel-sneaker"
        role="img"
        aria-label="Идёт загрузка"
        style={{ width: size * 1.6, height: size }}
      >
        <svg
          viewBox="0 0 16 10"
          width="100%"
          height="100%"
          shapeRendering="crispEdges"
          style={{ display: 'block' }}
        >
          {RECTS.map((r, i) => (
            <rect key={i} x={r.x} y={r.y} width={1} height={1} fill={r.fill} />
          ))}
        </svg>
        <div className="pixel-sneaker-shadow" />
      </div>
      {text && (
        <p className="hint" style={{ margin: 0, textAlign: 'center' }}>
          {text}
        </p>
      )}
    </div>
  )
}
