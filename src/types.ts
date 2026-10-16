export type Point = [number, number];
export type Ring = Point[];

export interface Artwork {
  id: string;
  name: string;
  image: string;
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  demo?: boolean;
  thumbnail?: string;
}

export type ArtworkSummary = Omit<Artwork, 'pixels' | 'thumbnail'>;
export type TracedSummary = ArtworkSummary & { rings: Ring[]; error?: string };
export interface DownloadPart { id: string; name: string; bytes: number; designCount: number }

export interface Settings {
  widthMm: number;
  offsetMm: number;
  threshold: number;
  smoothing: number;
  background: 'alpha' | 'white';
  holes: boolean;
  includeArtwork: boolean;
  layout: 'individual' | 'a4';
}

export interface TracedArtwork extends Artwork {
  rings: Ring[];
  error?: string;
}

export const defaultSettings: Settings = {
  widthMm: 80,
  offsetMm: 2,
  threshold: 128,
  smoothing: 0.35,
  background: 'alpha',
  holes: false,
  includeArtwork: true,
  layout: 'individual',
};
