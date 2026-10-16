import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { embedded } from './storefront';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/manrope';
import './styles.css';
import './batch.css';
import './modern.css';

function Workspace() {
  const [storage, setStorage] = useState<'checking' | 'ready' | 'blocked'>(embedded ? 'checking' : 'ready');
  useEffect(() => {
    if (!embedded) return;
    let active = true;
    const finish = (allowed: boolean) => { if (active) setStorage(allowed ? 'ready' : 'blocked'); };
    let request: IDBOpenDBRequest | undefined;
    const timer = setTimeout(() => finish(false), 5000);
    try {
      // Fail early: browsers may allow the frame while denying its database.
      localStorage.setItem('contour-storage-check', '1');
      localStorage.removeItem('contour-storage-check');
      request = indexedDB.open('contour-embed-storage-check');
      request.onsuccess = () => { request!.result.close(); clearTimeout(timer); finish(true); };
      request.onerror = () => { clearTimeout(timer); finish(false); };
    } catch { clearTimeout(timer); finish(false); }
    return () => { active = false; clearTimeout(timer); };
  }, []);
  return <>{embedded && <aside className="storefront-banner"><span>Contour Studio · Store workspace</span><a href={location.origin} target="_blank" rel="noopener noreferrer">Open full workspace ↗</a><small>If sign-in, storage, or downloads are blocked by your browser, open the full workspace.</small></aside>}{storage === 'ready' ? <App /> : <main className="storefront-storage"><h1>{storage === 'checking' ? 'Preparing your workspace…' : 'Open your workspace in a new tab'}</h1>{storage === 'blocked' && <><p>Your browser blocks storage inside this store page. Open the full workspace to upload artwork, sign in, and export your contour PDFs.</p><a href={location.origin} target="_blank" rel="noopener noreferrer">Open Contour Studio ↗</a></>}</main>}</>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><Workspace /></React.StrictMode>,
);
