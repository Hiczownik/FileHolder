import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Navbar } from './shared/components/Navbar';
import { Footer } from './shared/components/Footer';
import { UploadPage } from './features/upload/UploadPage';
import { DownloadPage } from './features/download/DownloadPage';

// Only for timing passkey settings on a device (#78), so it isn't part of the main bundle.
const Argon2BenchmarkPage = lazy(() => import('./features/diagnostics/Argon2BenchmarkPage'));

function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen flex flex-col bg-canvas text-fg font-sans">
        <Navbar />
        <main className="flex-1">
          <Routes>
            <Route path="/" element={<UploadPage />} />
            <Route path="/f/:shareToken" element={<DownloadPage />} />
            <Route path="/diagnostics/argon2" element={<Suspense fallback={null}><Argon2BenchmarkPage /></Suspense>} />
          </Routes>
        </main>
        <Footer />
      </div>
    </BrowserRouter>
  );
}

export default App;
