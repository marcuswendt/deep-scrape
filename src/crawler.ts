import { chromium, Browser, Page } from 'playwright';
import { logger } from './utils/logger.js';
import { getDomain, normalizeUrl, isMediaUrl } from './utils/url-utils.js';
import { Config, CrawlState } from './types.js';
import { Downloader } from './downloader.js';

export class BrowserCrawler {
  private browser: Browser | null = null;
  private shuttingDown = false;

  async init() {
    logger.debug('Launching browser...');
    this.browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }

  async close() {
    this.shuttingDown = true;
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  async extractMediaUrls(page: Page, baseUrl: string): Promise<string[]> {
    const mediaUrls: string[] = [];

    try {
      // Wait for page to be fully loaded
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

      // Extract URLs from various sources
      const urls = await page.evaluate(() => {
        const foundUrls: string[] = [];

        // Image sources
        document.querySelectorAll('img').forEach((img: any) => {
          if (img.src) foundUrls.push(img.src);
          if (img.dataset.src) foundUrls.push(img.dataset.src);
          if (img.dataset.image) foundUrls.push(img.dataset.image);

          // Handle srcset
          if (img.srcset) {
            const srcsetUrls = img.srcset.split(',').map((s: any) => s.trim().split(' ')[0]);
            foundUrls.push(...srcsetUrls);
          }
        });

        // Video sources
        document.querySelectorAll('video').forEach((video: any) => {
          if (video.src) foundUrls.push(video.src);
          if (video.poster) foundUrls.push(video.poster);
        });

        document.querySelectorAll('source').forEach((source: any) => {
          if (source.src) foundUrls.push(source.src);
        });

        // Background images in styles
        document.querySelectorAll('[style*="background"]').forEach((el: any) => {
          const style = el.style.backgroundImage;
          const match = style.match(/url\(['"]?([^'"()]+)['"]?\)/);
          if (match) foundUrls.push(match[1]);
        });

        // Meta tags
        document.querySelectorAll('meta[property="og:image"]').forEach((meta: any) => {
          const content = meta.getAttribute('content');
          if (content) foundUrls.push(content);
        });

        // Look for common data attributes
        document.querySelectorAll('[data-src], [data-original], [data-lazy-src]').forEach((el: any) => {
          ['data-src', 'data-original', 'data-lazy-src'].forEach(attr => {
            const val = el.getAttribute(attr);
            if (val) foundUrls.push(val);
          });
        });

        return foundUrls;
      });

      // Normalize and filter media URLs
      for (const url of urls) {
        if (!url) continue;
        const normalized = normalizeUrl(url, baseUrl);
        if (normalized && isMediaUrl(normalized)) {
          mediaUrls.push(normalized);
        }
      }

      // Deduplicate
      return [...new Set(mediaUrls)];
    } catch (error) {
      logger.error(`Failed to extract media URLs: ${error}`);
      return [];
    }
  }

  async extractPageLinks(page: Page, baseUrl: string, sourceDomain: string): Promise<string[]> {
    try {
      const links = await page.evaluate(() => {
        const foundLinks: string[] = [];

        document.querySelectorAll('a[href]').forEach((link: any) => {
          const href = link.getAttribute('href');
          if (href) foundLinks.push(href);
        });

        return foundLinks;
      });

      const pageLinks: string[] = [];

      for (let link of links) {
        // Skip javascript and mailto links
        if (link.startsWith('javascript:') || link.startsWith('mailto:')) {
          continue;
        }

        // Handle hash-based URLs
        if (link.startsWith('#/')) {
          link = link.slice(1);
        } else if (link.startsWith('#')) {
          continue;
        }

        const normalized = normalizeUrl(link, baseUrl);
        if (!normalized) continue;

        const domain = getDomain(normalized);
        if (domain === sourceDomain || domain === `www.${sourceDomain}`) {
          pageLinks.push(normalized);
        }
      }

      return [...new Set(pageLinks)];
    } catch (error) {
      logger.error(`Failed to extract page links: ${error}`);
      return [];
    }
  }

  async discoverAllowedDomains(url: string): Promise<Set<string>> {
    const allowedDomains = new Set<string>();
    const sourceDomain = getDomain(url);
    allowedDomains.add(sourceDomain);

    if (!this.browser) {
      throw new Error('Browser not initialized. Call init() first.');
    }

    const page = await this.browser.newPage();

    try {
      logger.debug(`Discovering domains from: ${url}`);
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

      // Extract all URLs from the page
      const allUrls = await page.evaluate(() => {
        const urls: string[] = [];
        document.querySelectorAll('[src], [href]').forEach((el: any) => {
          const src = el.getAttribute('src');
          const href = el.getAttribute('href');
          if (src) urls.push(src);
          if (href) urls.push(href);
        });
        return urls;
      });

      // Extract domains from media URLs
      for (const rawUrl of allUrls) {
        const normalized = normalizeUrl(rawUrl, url);
        if (normalized && isMediaUrl(normalized)) {
          const domain = getDomain(normalized);
          if (domain) {
            allowedDomains.add(domain);
          }
        }
      }

      // Filter to only keep CDN and image hosting domains
      const filteredDomains = new Set<string>();
      filteredDomains.add(sourceDomain);

      for (const domain of allowedDomains) {
        if (
          domain === sourceDomain ||
          domain.includes('cdn') ||
          domain.includes('cloudinary') ||
          domain.includes('imgix') ||
          domain.includes('images') ||
          domain.includes('static') ||
          domain.includes('squarespace')
        ) {
          filteredDomains.add(domain);
        }
      }

      return filteredDomains;
    } catch (error) {
      logger.error(`Failed to discover domains: ${error}`);
      return allowedDomains;
    } finally {
      await page.close();
    }
  }

  async crawlPage(
    url: string,
    depth: number,
    sourceDomain: string,
    state: CrawlState,
    config: Config,
    downloader?: Downloader
  ): Promise<string[]> {
    // Check for shutdown before starting
    if (this.shuttingDown || depth < 0 || state.visitedUrls.has(url)) {
      return [];
    }

    state.visitedUrls.add(url);
    logger.info(`Crawling (depth=${depth}): ${url}`);

    if (!this.browser || this.shuttingDown) {
      return [];
    }

    let page;
    try {
      page = await this.browser.newPage();
    } catch {
      // Browser was closed (likely Ctrl+C)
      return [];
    }
    const mediaUrls: string[] = [];

    try {
      // Use 'load' instead of 'networkidle' - many sites have continuous polling
      // that prevents networkidle from ever resolving
      await page.goto(url, {
        waitUntil: 'load',
        timeout: config.timeout * 1000
      });

      // Wait a bit for lazy-loaded content, but don't fail if network stays active
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

      // Extract media URLs
      const extractedMedia = await this.extractMediaUrls(page, url);
      logger.info(`Found ${extractedMedia.length} media files`);

      // Start downloading immediately if downloader provided
      if (downloader) {
        downloader.queueUrls(extractedMedia);
      } else {
        mediaUrls.push(...extractedMedia);
      }

      // If we should crawl deeper, extract and follow links
      if (depth > 0) {
        const links = await this.extractPageLinks(page, url, sourceDomain);
        logger.info(`Found ${links.length} page links to crawl`);
        for (const l of links.slice(0, 10)) {
          logger.debug(`  Link: ${l}`);
        }

        for (const link of links) {
          // Check for shutdown between crawls
          if (this.shuttingDown) break;

          const linkMediaUrls = await this.crawlPage(
            link,
            depth - 1,
            sourceDomain,
            state,
            config,
            downloader
          );
          mediaUrls.push(...linkMediaUrls);
        }
      }

      return mediaUrls;
    } catch (error) {
      if (!this.shuttingDown) {
        logger.warn(`Could not fetch: ${url} - ${error}`);
      }
      return mediaUrls;
    } finally {
      await page.close().catch(() => {});
    }
  }
}
