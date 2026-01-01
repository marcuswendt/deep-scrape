export interface Config {
  url: string;
  depth: number;
  outputDir: string;
  concurrency: number;
  verbose: boolean;
  dryRun: boolean;
  minWidth: number;
  minHeight: number;
  skipDuplicates: boolean;
  visualDedup: boolean;
  delayMs: number;
  timeout: number;
  maxRetries: number;
}

export interface MediaFile {
  url: string;
  domain: string;
  filename: string;
  filepath: string;
}

export interface CrawlState {
  visitedUrls: Set<string>;
  allowedDomains: Set<string>;
  downloadedUrls: Set<string>;
  contentHashes: Set<string>;
}

export const MEDIA_EXTENSIONS = {
  images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif', 'ico'],
  videos: ['mp4', 'webm', 'mov', 'avi', 'mkv']
};
