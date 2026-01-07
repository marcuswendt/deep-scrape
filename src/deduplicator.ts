import { promises as fs } from 'fs';
import path from 'path';
import { getVisualHash, getImageDimensions, getFileHash, areVisuallySimular } from './utils/file-utils.js';
import { logger } from './utils/logger.js';

interface ImageInfo {
  path: string;
  filename: string;
  baseName: string;  // filename without _N suffix
  ext: string;
  pixels: number;
  size: number;
  contentHash?: string | null;
  visualHash?: string | null;
}

export class VisualDeduplicator {
  async deduplicate(outputDir: string, dryRun: boolean = false): Promise<number> {
    if (dryRun) {
      return 0;
    }

    logger.info('Scanning for duplicate images...');

    // Find all image files
    const imageFiles = await this.findImageFiles(outputDir);

    if (imageFiles.length < 2) {
      logger.debug('Not enough images for deduplication');
      return 0;
    }

    logger.debug(`Analyzing ${imageFiles.length} images...`);

    // Build image info for all files
    const imageInfos: ImageInfo[] = [];

    for (const filepath of imageFiles) {
      try {
        const filename = path.basename(filepath);
        const ext = path.extname(filename);
        const nameWithoutExt = filename.slice(0, -ext.length);

        // Extract base name (remove _1, _2, etc. suffix)
        const baseName = nameWithoutExt.replace(/_\d+$/, '');

        const dimensions = await getImageDimensions(filepath);
        const pixels = dimensions ? dimensions.width * dimensions.height : 0;
        const stats = await fs.stat(filepath);

        imageInfos.push({
          path: filepath,
          filename,
          baseName,
          ext: ext.toLowerCase(),
          pixels,
          size: stats.size
        });
      } catch (error) {
        logger.debug(`Failed to process: ${filepath}`);
      }
    }

    let totalRemoved = 0;

    // Step 1: Find filename-based duplicates (name_1.jpg matches name.jpg)
    totalRemoved += await this.removeFilenameDuplicates(imageInfos);

    // Rebuild list after removals
    const remainingFiles = await this.findImageFiles(outputDir);
    const remainingInfos: ImageInfo[] = [];

    for (const filepath of remainingFiles) {
      const info = imageInfos.find(i => i.path === filepath);
      if (info) {
        remainingInfos.push(info);
      }
    }

    // Step 2: Find content-hash duplicates (identical files)
    totalRemoved += await this.removeContentDuplicates(remainingInfos);

    // Step 3: Find visual duplicates (same image, different resolution)
    const stillRemaining = await this.findImageFiles(outputDir);
    totalRemoved += await this.removeVisualDuplicates(stillRemaining);

    if (totalRemoved > 0) {
      logger.info(`Removed ${totalRemoved} duplicate images`);
    }

    return totalRemoved;
  }

  private async removeFilenameDuplicates(imageInfos: ImageInfo[]): Promise<number> {
    // Group by directory + baseName + extension
    const groups = new Map<string, ImageInfo[]>();

    for (const info of imageInfos) {
      const dir = path.dirname(info.path);
      const key = `${dir}/${info.baseName}${info.ext}`;

      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(info);
    }

    let removed = 0;

    for (const [key, group] of groups) {
      if (group.length < 2) continue;

      // Sort by pixels (descending), then by file size (descending)
      group.sort((a, b) => {
        if (b.pixels !== a.pixels) return b.pixels - a.pixels;
        return b.size - a.size;
      });

      // Keep the highest quality, remove the rest
      const keep = group[0];
      logger.debug(`Keeping (filename group): ${keep.filename}`);

      for (let i = 1; i < group.length; i++) {
        try {
          await fs.unlink(group[i].path);
          logger.debug(`Removed (filename duplicate): ${group[i].filename}`);
          removed++;
        } catch {
          // File may already be deleted
        }
      }
    }

    if (removed > 0) {
      logger.info(`Removed ${removed} filename-based duplicates`);
    }

    return removed;
  }

  private async removeContentDuplicates(imageInfos: ImageInfo[]): Promise<number> {
    // Compute content hashes
    for (const info of imageInfos) {
      info.contentHash = await getFileHash(info.path);
    }

    // Group by content hash
    const groups = new Map<string, ImageInfo[]>();

    for (const info of imageInfos) {
      if (!info.contentHash) continue;

      if (!groups.has(info.contentHash)) {
        groups.set(info.contentHash, []);
      }
      groups.get(info.contentHash)!.push(info);
    }

    let removed = 0;

    for (const [hash, group] of groups) {
      if (group.length < 2) continue;

      // For identical files, prefer shorter filename (no _1 suffix)
      group.sort((a, b) => a.filename.length - b.filename.length);

      const keep = group[0];
      logger.debug(`Keeping (identical): ${keep.filename}`);

      for (let i = 1; i < group.length; i++) {
        try {
          await fs.unlink(group[i].path);
          logger.debug(`Removed (identical): ${group[i].filename}`);
          removed++;
        } catch {
          // File may already be deleted
        }
      }
    }

    if (removed > 0) {
      logger.info(`Removed ${removed} identical duplicates`);
    }

    return removed;
  }

  private async removeVisualDuplicates(imageFiles: string[]): Promise<number> {
    const imageInfos: Array<{
      path: string;
      hash: string;
      pixels: number;
      size: number;
    }> = [];

    for (const filepath of imageFiles) {
      try {
        const hash = await getVisualHash(filepath);
        if (!hash) continue;

        const dimensions = await getImageDimensions(filepath);
        const pixels = dimensions ? dimensions.width * dimensions.height : 0;
        const stats = await fs.stat(filepath);

        imageInfos.push({
          path: filepath,
          hash,
          pixels,
          size: stats.size
        });
      } catch {
        // Skip files that can't be processed
      }
    }

    // Find similar images using hamming distance clustering
    const used = new Set<number>();
    let removed = 0;

    for (let i = 0; i < imageInfos.length; i++) {
      if (used.has(i)) continue;

      const group = [imageInfos[i]];
      used.add(i);

      // Find all similar images
      for (let j = i + 1; j < imageInfos.length; j++) {
        if (used.has(j)) continue;

        if (areVisuallySimular(imageInfos[i].hash, imageInfos[j].hash)) {
          group.push(imageInfos[j]);
          used.add(j);
        }
      }

      if (group.length < 2) continue;

      // Sort by pixels (descending), then by file size (descending)
      group.sort((a, b) => {
        if (b.pixels !== a.pixels) return b.pixels - a.pixels;
        return b.size - a.size;
      });

      const keep = group[0];
      logger.debug(`Keeping (visual): ${path.basename(keep.path)}`);

      for (let i = 1; i < group.length; i++) {
        try {
          await fs.unlink(group[i].path);
          logger.debug(`Removed (visual duplicate): ${path.basename(group[i].path)}`);
          removed++;
        } catch {
          // File may already be deleted
        }
      }
    }

    if (removed > 0) {
      logger.info(`Removed ${removed} visual duplicates`);
    }

    return removed;
  }

  private async findImageFiles(dir: string): Promise<string[]> {
    const imageFiles: string[] = [];
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif'];

    async function walk(directory: string) {
      try {
        const entries = await fs.readdir(directory, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(directory, entry.name);

          if (entry.isDirectory()) {
            await walk(fullPath);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (imageExtensions.includes(ext)) {
              imageFiles.push(fullPath);
            }
          }
        }
      } catch {
        // Directory may have been deleted
      }
    }

    await walk(dir);
    return imageFiles;
  }
}
