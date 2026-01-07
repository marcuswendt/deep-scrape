import { promises as fs, createWriteStream } from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import PQueue from 'p-queue';
import { logger } from './utils/logger.js';
import { getDomain, getFilenameFromUrl } from './utils/url-utils.js';
import { getFileHash, getImageDimensions, ensureUniqueFilepath } from './utils/file-utils.js';
import { Config, CrawlState } from './types.js';

export class Downloader {
  private queue: PQueue;

  constructor(private config: Config, private state: CrawlState) {
    this.queue = new PQueue({ concurrency: config.concurrency });
  }

  private async downloadFile(url: string, filepath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const parsedUrl = new URL(url);
      const client = parsedUrl.protocol === 'https:' ? https : http;

      const request = client.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        },
        timeout: this.config.timeout * 1000
      }, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            this.downloadFile(redirectUrl, filepath).then(resolve);
            return;
          }
        }

        if (response.statusCode !== 200) {
          logger.debug(`Failed to download (${response.statusCode}): ${url}`);
          resolve(false);
          return;
        }

        const fileStream = createWriteStream(filepath);
        response.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close();
          resolve(true);
        });

        fileStream.on('error', () => {
          resolve(false);
        });
      });

      request.on('error', () => {
        resolve(false);
      });

      request.on('timeout', () => {
        request.destroy();
        resolve(false);
      });
    });
  }

  async processDownload(url: string): Promise<void> {
    if (this.state.downloadedUrls.has(url)) {
      return;
    }

    const domain = getDomain(url);
    if (!this.state.allowedDomains.has(domain)) {
      logger.debug(`Skipping (domain not allowed): ${domain}`);
      return;
    }

    this.state.downloadedUrls.add(url);

    const domainDir = path.join(this.config.outputDir, domain);
    await fs.mkdir(domainDir, { recursive: true });

    const filename = getFilenameFromUrl(url);
    let filepath = path.join(domainDir, filename);

    // Check if file already exists (resume mode)
    if (this.config.resume) {
      try {
        const stats = await fs.stat(filepath);
        if (stats.size > 0) {
          logger.debug(`Skipping (already exists): ${filename}`);
          return;
        }
      } catch {
        // File doesn't exist, continue with download
      }
    }

    filepath = await ensureUniqueFilepath(filepath);

    if (this.config.dryRun) {
      console.log(`[DRY-RUN] Would download: ${url} -> ${filepath}`);
      return;
    }

    // Try downloading with retries
    let success = false;
    for (let retry = 0; retry < this.config.maxRetries; retry++) {
      if (retry > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      success = await this.downloadFile(url, filepath);

      if (success) {
        break;
      }
    }

    if (!success) {
      logger.error(`Failed: ${url}`);
      await fs.unlink(filepath).catch(() => {});
      return;
    }

    // Check if file exists and has content
    try {
      const stats = await fs.stat(filepath);
      if (stats.size === 0) {
        logger.debug(`Skipping (empty file): ${filename}`);
        await fs.unlink(filepath);
        return;
      }
    } catch {
      logger.debug(`Skipping (file not found): ${filename}`);
      return;
    }

    // Check for duplicate content
    if (this.config.skipDuplicates) {
      const fileHash = await getFileHash(filepath);
      if (this.state.contentHashes.has(fileHash)) {
        logger.debug(`Skipping duplicate: ${filename}`);
        await fs.unlink(filepath).catch(() => {});
        return;
      }
      this.state.contentHashes.add(fileHash);
    }

    // Check image dimensions
    const ext = path.extname(filepath).toLowerCase().slice(1);
    const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'];

    if (imageExtensions.includes(ext)) {
      const dimensions = await getImageDimensions(filepath);
      if (dimensions) {
        const { width, height } = dimensions;
        if (
          (this.config.minWidth > 0 && width < this.config.minWidth) ||
          (this.config.minHeight > 0 && height < this.config.minHeight)
        ) {
          logger.debug(`Skipping (too small): ${filename} (${width}x${height})`);
          await fs.unlink(filepath).catch(() => {});
          return;
        }
      }
    }

    logger.success(`Downloaded: ${filename}`);

    // Rate limiting
    if (this.config.delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.config.delayMs));
    }
  }

  async downloadAll(urls: string[]): Promise<void> {
    const uniqueUrls = [...new Set(urls)];
    logger.info(`Queueing ${uniqueUrls.length} files for download...`);

    const promises = uniqueUrls.map(url =>
      this.queue.add(() => this.processDownload(url))
    );

    await Promise.all(promises);
    await this.queue.onIdle();
  }

  async waitForCompletion(): Promise<void> {
    await this.queue.onIdle();
  }
}
