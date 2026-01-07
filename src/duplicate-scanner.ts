import { promises as fs } from 'fs';
import path from 'path';
import { logger } from './utils/logger.js';
import { getFileHash, getVisualHash, getImageDimensions } from './utils/file-utils.js';
import { MEDIA_EXTENSIONS } from './types.js';

interface FileInfo {
  filepath: string;
  filename: string;
  baseName: string;
  ext: string;
  size: number;
  contentHash?: string;
  visualHash?: string | null;
  width?: number;
  height?: number;
  pixels?: number;
}

interface DuplicateGroup {
  original: FileInfo;
  duplicates: FileInfo[];
  reason: 'identical' | 'visual' | 'filename';
}

export class DuplicateScanner {
  private mediaExtensions: string[];
  private imageExtensions: string[];

  constructor() {
    this.mediaExtensions = [
      ...MEDIA_EXTENSIONS.images,
      ...MEDIA_EXTENSIONS.videos
    ];
    this.imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'];
  }

  /**
   * Extract the base name by removing trailing suffixes like _2, _3, -2, -3, etc.
   */
  private getBaseName(filename: string): string {
    const ext = path.extname(filename);
    const nameWithoutExt = filename.slice(0, -ext.length || undefined);

    const cleaned = nameWithoutExt
      .replace(/[_-]\d+$/, '')
      .replace(/\s*\(\d+\)$/, '')
      .replace(/\s+copy(\s+\d+)?$/i, '');

    return cleaned + ext.toLowerCase();
  }

  /**
   * Scan directory for all media files
   */
  private async findMediaFiles(directory: string): Promise<FileInfo[]> {
    const files: FileInfo[] = [];
    const self = this;

    async function walk(dir: string) {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            await walk(fullPath);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase().slice(1);
            if (self.mediaExtensions.includes(ext)) {
              const stat = await fs.stat(fullPath);
              files.push({
                filepath: fullPath,
                filename: entry.name,
                baseName: self.getBaseName(entry.name),
                ext: ext,
                size: stat.size
              });
            }
          }
        }
      } catch (error) {
        logger.debug(`Error reading directory ${dir}: ${error}`);
      }
    }

    await walk(directory);
    return files;
  }

  /**
   * Sort files by quality - highest quality first
   * Priority: resolution (pixels), then file size
   */
  private sortByQuality(files: FileInfo[]): FileInfo[] {
    return [...files].sort((a, b) => {
      // Higher resolution first
      const pixelDiff = (b.pixels || 0) - (a.pixels || 0);
      if (pixelDiff !== 0) return pixelDiff;

      // Larger file size first (likely better quality/less compression)
      return b.size - a.size;
    });
  }

  /**
   * Find duplicates using content hash (identical files)
   */
  private async findIdenticalFiles(files: FileInfo[]): Promise<DuplicateGroup[]> {
    logger.info('Checking for identical files (content hash)...');

    // Compute content hashes
    for (const file of files) {
      try {
        file.contentHash = await getFileHash(file.filepath);
      } catch (error) {
        logger.debug(`Failed to hash ${file.filename}: ${error}`);
      }
    }

    // Group by content hash
    const hashGroups = new Map<string, FileInfo[]>();
    for (const file of files) {
      if (!file.contentHash) continue;
      if (!hashGroups.has(file.contentHash)) {
        hashGroups.set(file.contentHash, []);
      }
      hashGroups.get(file.contentHash)!.push(file);
    }

    const duplicates: DuplicateGroup[] = [];
    for (const [hash, groupFiles] of hashGroups) {
      if (groupFiles.length < 2) continue;

      // Sort by quality (though identical files have same quality, prefer shorter filename)
      groupFiles.sort((a, b) => a.filename.length - b.filename.length);

      duplicates.push({
        original: groupFiles[0],
        duplicates: groupFiles.slice(1),
        reason: 'identical'
      });
    }

    return duplicates;
  }

  /**
   * Find duplicates using visual hash (same image at different resolutions)
   */
  private async findVisuallySimilar(files: FileInfo[], excludeHashes: Set<string>): Promise<DuplicateGroup[]> {
    logger.info('Checking for visually similar images (different resolutions)...');

    // Filter to only images that weren't already found as identical
    const imageFiles = files.filter(f => {
      if (!this.imageExtensions.includes(f.ext)) return false;
      if (f.contentHash && excludeHashes.has(f.contentHash)) return false;
      return true;
    });

    // Get dimensions and visual hashes
    for (const file of imageFiles) {
      try {
        const dims = await getImageDimensions(file.filepath);
        if (dims) {
          file.width = dims.width;
          file.height = dims.height;
          file.pixels = dims.width * dims.height;
        }
        file.visualHash = await getVisualHash(file.filepath);
      } catch (error) {
        logger.debug(`Failed to analyze ${file.filename}: ${error}`);
      }
    }

    // Group by visual hash
    const visualGroups = new Map<string, FileInfo[]>();
    for (const file of imageFiles) {
      if (!file.visualHash) continue;
      if (!visualGroups.has(file.visualHash)) {
        visualGroups.set(file.visualHash, []);
      }
      visualGroups.get(file.visualHash)!.push(file);
    }

    const duplicates: DuplicateGroup[] = [];
    for (const [hash, groupFiles] of visualGroups) {
      if (groupFiles.length < 2) continue;

      // Sort by quality - keep highest resolution/quality
      const sorted = this.sortByQuality(groupFiles);

      duplicates.push({
        original: sorted[0],
        duplicates: sorted.slice(1),
        reason: 'visual'
      });
    }

    return duplicates;
  }

  /**
   * Scan and optionally delete duplicates
   */
  async scan(directory: string, options: {
    dryRun?: boolean;
    verbose?: boolean;
  } = {}): Promise<{ found: number; deleted: number; freedBytes: number }> {
    const { dryRun = false, verbose = false } = options;

    logger.setVerbose(verbose);

    // Verify directory exists
    try {
      const stat = await fs.stat(directory);
      if (!stat.isDirectory()) {
        throw new Error(`${directory} is not a directory`);
      }
    } catch (error) {
      logger.error(`Cannot access directory: ${directory}`);
      throw error;
    }

    logger.info(`Scanning directory: ${directory}`);
    const files = await this.findMediaFiles(directory);
    logger.info(`Found ${files.length} media files`);
    console.log('');

    // Step 1: Find identical files
    const identicalGroups = await this.findIdenticalFiles(files);

    // Track which files are already marked as duplicates
    const processedFiles = new Set<string>();
    const excludeHashes = new Set<string>();

    for (const group of identicalGroups) {
      processedFiles.add(group.original.filepath);
      for (const dup of group.duplicates) {
        processedFiles.add(dup.filepath);
        if (dup.contentHash) excludeHashes.add(dup.contentHash);
      }
    }

    // Step 2: Find visually similar images (excluding already-found duplicates)
    const visualGroups = await this.findVisuallySimilar(files, excludeHashes);

    // Combine results
    const allGroups = [...identicalGroups, ...visualGroups];

    let totalDuplicates = 0;
    let deletedCount = 0;
    let freedBytes = 0;

    console.log('');

    for (const group of allGroups) {
      totalDuplicates += group.duplicates.length;

      const reasonLabel = group.reason === 'identical' ? 'IDENTICAL' : 'VISUAL MATCH';
      const dims = group.original.pixels
        ? ` (${group.original.width}x${group.original.height})`
        : '';

      logger.info(`[${reasonLabel}] Keeping: ${path.basename(group.original.filepath)}${dims}`);

      for (const dup of group.duplicates) {
        const relPath = path.relative(directory, dup.filepath);
        const dupDims = dup.pixels ? ` ${dup.width}x${dup.height}` : '';
        freedBytes += dup.size;

        if (dryRun) {
          logger.warn(`  Would delete: ${relPath} (${formatBytes(dup.size)}${dupDims})`);
        } else {
          try {
            await fs.unlink(dup.filepath);
            logger.success(`  Deleted: ${relPath} (${formatBytes(dup.size)}${dupDims})`);
            deletedCount++;
          } catch (error) {
            logger.error(`  Failed to delete: ${relPath} - ${error}`);
          }
        }
      }
    }

    console.log('');
    logger.info('=== Summary ===');
    logger.info(`Identical file groups: ${identicalGroups.length}`);
    logger.info(`Visually similar groups: ${visualGroups.length}`);
    logger.info(`Total duplicates: ${totalDuplicates}`);

    if (dryRun) {
      logger.info(`Would free: ${formatBytes(freedBytes)}`);
      logger.warn('Run without --dry-run to delete files');
    } else {
      logger.success(`Deleted: ${deletedCount} files`);
      logger.success(`Freed: ${formatBytes(freedBytes)}`);
    }

    return {
      found: totalDuplicates,
      deleted: deletedCount,
      freedBytes
    };
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}
