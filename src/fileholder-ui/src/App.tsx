import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Navbar } from './shared/components/Navbar';
import { Footer } from './shared/components/Footer';
import { UploadPage } from './features/upload/UploadPage';
import { DownloadPage } from './features/download/DownloadPage';

function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen flex flex-col bg-canvas text-fg font-sans">
        <Navbar />
        <main className="flex-1">
          <Routes>
            <Route path="/" element={<UploadPage />} />
            <Route path="/f/:shareToken" element={<DownloadPage />} />
          </Routes>
        </main>
        <Footer />
      </div>
    </BrowserRouter>
  );
}

export default App;
