import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Navbar } from './shared/components/Navbar';
import { Footer } from './shared/components/Footer';
import { UploadPage } from './features/upload/UploadPage';
import { DownloadPage } from './features/download/DownloadPage';
import { TermsPage } from './features/legal/TermsPage';
import { PrivacyPage } from './features/legal/PrivacyPage';
import { SamplePage } from './features/sample/SamplePage';
import { ServiceStatusBanner } from './shared/components/ServiceStatusBanner';
import { ClosedPage } from './shared/components/ClosedPage';
import { useServiceStatus } from './shared/hooks/useServiceStatus';

// Only for timing passkey settings on a device (#78), so it isn't part of the main bundle.
const Argon2BenchmarkPage = lazy(() => import('./features/diagnostics/Argon2BenchmarkPage'));

function App() {
  // The owner's maintenance mode (README, Maintenance Modes): a banner while paused, one page while closed.
  const serviceStatus = useServiceStatus();

  return (
    <BrowserRouter>
      <div className="min-h-screen flex flex-col bg-canvas text-fg font-sans">
        <Navbar />
        <ServiceStatusBanner status={serviceStatus} />
        <main className="flex-1">
          {serviceStatus?.mode === 'Closed' ? <ClosedPage status={serviceStatus} /> : (
            <Routes>
              <Route path="/" element={<UploadPage />} />
              <Route path="/f/:shareToken" element={<DownloadPage />} />
              <Route path="/terms" element={<TermsPage />} />
              <Route path="/privacy" element={<PrivacyPage />} />
              <Route path="/sample" element={<SamplePage />} />
              <Route path="/diagnostics/argon2" element={<Suspense fallback={null}><Argon2BenchmarkPage /></Suspense>} />
            </Routes>
          )}
        </main>
        <Footer />
      </div>
    </BrowserRouter>
  );
}

export default App;
