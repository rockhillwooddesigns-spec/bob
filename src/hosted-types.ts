import type { Settings } from './types';

export interface Entitlements { pro: boolean; used: number; limit: number; remaining: number; resetAt: string; canManageBilling?: boolean }
export interface Preset { id: string; name: string; settings: Settings }
export interface ExportManifest { id: string; name: string; width: number; height: number; hash: string }
export interface ExportJob { id: string; user_id: string; status: 'reserved' | 'completed' | 'canceled'; plan: 'free' | 'pro'; manifest: ExportManifest[]; settings: Settings; expires_at: string }
