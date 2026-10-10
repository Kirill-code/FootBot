import { Link } from 'react-router'

export default function HomePage() {
  return (
    <main className="page">
      <h1 className="page-title">FootBot</h1>
      <p className="page-subtitle">Подберём кроссовки по фото вашей стопы</p>

      <div className="card">
        <p className="hint">
          Сфотографируйте стопу, и FootBot измерит её, подберёт размер и предложит
          подходящие модели из каталога.
        </p>
      </div>

      <Link className="btn" to="/scan">Сканировать стопу</Link>
      <Link className="btn btn-secondary" to="/recommendations">Мой подбор</Link>
      <Link className="btn btn-secondary" to="/catalog">Каталог кроссовок</Link>
    </main>
  )
}
