#!/usr/bin/env node

import { Command } from 'commander';
import { promises as fs } from 'fs';
import path from 'path';
import { BrowserCrawler } from './crawler.js';
import { Downloader } from './downloader.js';
import { VisualDeduplicator } from './deduplicator.js';
import { DuplicateScanner } from './duplicate-scanner.js';
import { logger } from './utils/logger.js';
import { getDomain } from './utils/url-utils.js';
import { Config, CrawlState } from './types.js';

const program = new Command();

program
  .name('media-downloader')
  .description('Downloads images and videos from websites using browser automation')
  .version('2.0.0');

// Download command (default)
program
  .command('download <url>', { isDefault: true })
  .description('Download media from a URL')
  .option('-d, --depth <n>', 'Recursion depth (0 = initial page only)', '1')
  .option('-o, --output <dir>', 'Output directory')
  .option('-c, --concurrency <n>', 'Parallel downloads', '5')
  .option('-v, --verbose', 'Verbose output', false)
  .option('--dry-run', 'Show what would be downloaded', false)
  .option('--min-width <px>', 'Minimum image width', '0')
  .option('--min-height <px>', 'Minimum image height', '0')
  .option('--min-dim <px>', 'Set both min-width and min-height')
  .option('--allow-duplicates', 'Allow duplicate files', false)
  .option('--no-visual-dedup', 'Disable visual similarity detection', false)
  .action(downloadAction);

// Dedup command
program
  .command('dedup <directory>')
  .description('Scan a directory for duplicate files and remove them')
  .option('-v, --verbose', 'Verbose output', false)
  .option('--dry-run', 'Show what would be deleted without deleting', false)
  .action(dedupAction);

program.parse();

async function downloadAction(url: string, options: any) {
  // Ensure URL has protocol
  if (!url.match(/^https?:\/\//)) {
    url = `https://${url}`;
  }

  const sourceDomain = getDomain(url);
  const outputDir = options.output || `./${sourceDomain}`;

  // Parse options
  const config: Config = {
    url,
    depth: parseInt(options.depth),
    outputDir,
    concurrency: parseInt(options.concurrency),
    verbose: options.verbose,
    dryRun: options.dryRun,
    minWidth: options.minDim ? parseInt(options.minDim) : parseInt(options.minWidth),
    minHeight: options.minDim ? parseInt(options.minDim) : parseInt(options.minHeight),
    skipDuplicates: !options.allowDuplicates,
    visualDedup: options.visualDedup !== false,
    delayMs: 100,
    timeout: 30,
    maxRetries: 3
  };

  // Configure logger
  logger.setVerbose(config.verbose);

  // Create output directory
  await fs.mkdir(config.outputDir, { recursive: true });

  // Initialize state
  const state: CrawlState = {
    visitedUrls: new Set(),
    allowedDomains: new Set(),
    downloadedUrls: new Set(),
    contentHashes: new Set()
  };

  // Display configuration
  logger.info(`Starting download from: ${url}`);
  logger.info(`Source domain: ${sourceDomain}`);
  logger.info(`Recursion depth: ${config.depth}`);
  logger.info(`Output directory: ${config.outputDir}`);

  if (config.minWidth > 0 || config.minHeight > 0) {
    logger.info(`Minimum dimensions: ${config.minWidth}x${config.minHeight}px`);
  }

  if (config.skipDuplicates) {
    logger.info('Duplicate detection: enabled');
  }

  if (config.visualDedup) {
    logger.info('Visual similarity detection: enabled');
  }

  if (config.dryRun) {
    logger.info('DRY RUN MODE');
  }

  console.log('');

  const crawler = new BrowserCrawler();

  try {
    // Initialize browser
    await crawler.init();

    // Discover allowed domains
    logger.info('Discovering allowed domains...');
    state.allowedDomains = await crawler.discoverAllowedDomains(url);

    logger.info('Allowed domains:');
    for (const domain of state.allowedDomains) {
      logger.info(`  - ${domain}`);
    }
    console.log('');

    // Crawl and extract media URLs
    const mediaUrls = await crawler.crawlPage(
      url,
      config.depth,
      sourceDomain,
      state,
      config
    );

    console.log('');

    // Download files
    const downloader = new Downloader(config, state);
    await downloader.downloadAll(mediaUrls);
    await downloader.waitForCompletion();

    console.log('');

    // Visual deduplication
    if (config.visualDedup) {
      const deduplicator = new VisualDeduplicator();
      await deduplicator.deduplicate(config.outputDir, config.dryRun);
      console.log('');
    }

    // Count final files
    const finalFiles = await countMediaFiles(config.outputDir);
    logger.info('Download complete!');
    logger.info(`Total files: ${finalFiles}`);
    logger.info(`Saved to: ${config.outputDir}`);

  } catch (error) {
    logger.error(`Fatal error: ${error}`);
    process.exit(1);
  } finally {
    await crawler.close();
  }
}

async function dedupAction(directory: string, options: any) {
  // Resolve to absolute path
  const absDir = path.resolve(directory);

  logger.setVerbose(options.verbose);

  const scanner = new DuplicateScanner();

  try {
    await scanner.scan(absDir, {
      dryRun: options.dryRun,
      verbose: options.verbose
    });
  } catch (error) {
    logger.error(`Failed: ${error}`);
    process.exit(1);
  }
}

async function countMediaFiles(dir: string): Promise<number> {
  let count = 0;
  const mediaExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm', '.mov'];

  async function walk(directory: string) {
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (mediaExtensions.includes(ext)) {
            count++;
          }
        }
      }
    } catch {
      // Ignore errors
    }
  }

  await walk(dir);
  return count;
}
