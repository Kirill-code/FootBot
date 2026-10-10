import { HashRouter, Route, Routes } from 'react-router'
import Layout from './Layout'
import HomePage from './HomePage'
import ScanPage from '../camera/ScanPage'
import ProfilePage from '../profile/ProfilePage'
import RecommendationsPage from '../matching/RecommendationsPage'
import CatalogPage from '../catalog/CatalogPage'
import CatalogDetailPage from '../catalog/CatalogDetailPage'

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/scan" element={<ScanPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/recommendations" element={<RecommendationsPage />} />
          <Route path="/catalog" element={<CatalogPage />} />
          <Route path="/catalog/:id" element={<CatalogDetailPage />} />
          <Route path="*" element={<HomePage />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}
