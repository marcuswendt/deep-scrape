import { promises as fs } from 'fs';
import path from 'path';
import { getVisualHash, getImageDimensions } from './utils/file-utils.js';
import { logger } from './utils/logger.js';

interface ImageInfo {
  path: string;
  hash: string;
  pixels: number;
  size: number;
}

export class VisualDeduplicator {
  async deduplicate(outputDir: string, dryRun: boolean = false): Promise<number> {
    if (dryRun) {
      return 0;
    }

    logger.info('Scanning for visually similar images...');

    // Find all image files
    const imageFiles = await this.findImageFiles(outputDir);

    if (imageFiles.length < 2) {
      logger.debug('Not enough images for deduplication');
      return 0;
    }

    logger.debug(`Analyzing ${imageFiles.length} images...`);

    // Generate visual hashes for all images
    const imageInfos: ImageInfo[] = [];

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
      } catch (error) {
        logger.debug(`Failed to process: ${filepath}`);
      }
    }

    // Group by visual hash
    const hashGroups = new Map<string, ImageInfo[]>();

    for (const info of imageInfos) {
      const group = hashGroups.get(info.hash) || [];
      group.push(info);
      hashGroups.set(info.hash, group);
    }

    // Find duplicates and keep only the highest quality version
    let removed = 0;

    for (const [hash, group] of hashGroups) {
      if (group.length < 2) continue;

      // Sort by pixels (descending), then by file size (descending)
      group.sort((a, b) => {
        if (b.pixels !== a.pixels) {
          return b.pixels - a.pixels;
        }
        return b.size - a.size;
      });

      // Keep the first one (highest quality), remove the rest
      logger.debug(`Keeping: ${group[0].path}`);

      for (let i = 1; i < group.length; i++) {
        try {
          await fs.unlink(group[i].path);
          logger.debug(`Removed duplicate: ${group[i].path}`);
          removed++;
        } catch (error) {
          logger.debug(`Failed to remove: ${group[i].path}`);
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
    }

    await walk(dir);
    return imageFiles;
  }
}
