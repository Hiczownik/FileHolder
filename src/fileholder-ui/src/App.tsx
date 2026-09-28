import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Navbar } from './shared/components/Navbar';
import { UploadPage } from './features/upload/UploadPage';
import { DownloadPage } from './features/download/DownloadPage';

function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
        <Navbar />
        <main>
          <Routes>
            <Route path="/" element={<UploadPage />} />
            <Route path="/f/:shareToken" element={<DownloadPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default App;