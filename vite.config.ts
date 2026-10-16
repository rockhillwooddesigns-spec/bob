import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import metadata from './package.json';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  if (env.VITE_BILLING_ENABLED === 'true' && (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY)) throw new Error('Hosted build requires VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY. Configure them in Netlify before deploying customer access. Use VITE_BILLING_ENABLED=false for an owner build.');
  return { plugins: [react(), { name: 'contour-build-info', generateBundle() { this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify({ version: metadata.version, edition: env.VITE_BILLING_ENABLED === 'true' ? 'hosted' : 'owner' }) }); } }], worker: { format: 'es' } };
});
