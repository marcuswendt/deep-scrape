# Media Downloader

A modern Node.js + TypeScript application that downloads images and videos from websites using browser automation. Unlike traditional scrapers, this tool uses a headless browser (Playwright) to handle JavaScript-rendered content, making it perfect for modern single-page applications and dynamic websites.

## Features

- **Browser Automation**: Uses Playwright to render JavaScript and capture dynamically loaded content
- **Recursive Crawling**: Follow links on pages up to a configurable depth
- **Smart Domain Filtering**: Only downloads from domains discovered on the initial page (including CDNs)
- **Duplicate Detection**:
  - Content-based hashing to skip exact duplicates
  - Visual similarity detection to identify and remove scaled/resized versions
- **Dimension Filtering**: Skip images below minimum width/height thresholds
- **Concurrent Downloads**: Parallel downloads with configurable concurrency
- **Progress Logging**: Colored terminal output with verbose mode
- **Dry Run Mode**: Preview what would be downloaded without actually downloading

## Installation

```bash
npm install
npx playwright install chromium
```

## Usage

### Basic Usage

```bash
npm start -- <url> [options]
```

### Development

```bash
npm run dev -- <url> [options]
```

### Build for Production

```bash
npm run build
node dist/index.js <url> [options]
```

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `<url>` | Source URL to crawl | Required |
| `-d, --depth <n>` | Recursion depth (0 = initial page only) | 1 |
| `-o, --output <dir>` | Output directory | `./<domain>` |
| `-c, --concurrency <n>` | Parallel downloads | 5 |
| `-v, --verbose` | Verbose output | false |
| `--dry-run` | Show what would be downloaded | false |
| `--min-width <px>` | Minimum image width | 0 |
| `--min-height <px>` | Minimum image height | 0 |
| `--min-dim <px>` | Set both min-width and min-height | 0 |
| `--allow-duplicates` | Allow duplicate files | false |
| `--no-visual-dedup` | Disable visual similarity detection | false |

## Examples

```bash
# Download from a portfolio site with default depth of 1
npm start -- https://silvanozeiter.com/

# Download with depth 2, custom output folder
npm start -- https://example.com -d 2 -o ~/Pictures/scraped

# Preview what would be downloaded
npm start -- https://example.com --dry-run

# Only download images at least 800px on each side
npm start -- https://example.com --min-dim 800

# Verbose output to see all discovered URLs
npm start -- https://example.com -v

# Download with higher concurrency
npm start -- https://example.com -c 10
```

## How It Works

1. **Domain Discovery**: Fetches the initial page and discovers all domains that host media files
2. **Browser Rendering**: Uses Playwright Chromium to render pages and execute JavaScript
3. **Media Extraction**: Extracts media URLs from:
   - `<img>` tags (src, srcset, data-src, data-image)
   - `<video>` and `<source>` tags
   - CSS background images
   - Meta tags (og:image)
   - Common lazy-loading attributes
4. **Recursive Crawling**: Follows same-domain links up to specified depth
5. **Smart Downloading**:
   - Checks domain allowlist
   - Skips already downloaded URLs
   - Validates file dimensions
   - Detects duplicate content via MD5 hashing
6. **Visual Deduplication**: Groups visually similar images and keeps only the highest resolution version

## Output Structure

```
example.com/
├── example.com/
│   └── (images directly from the main domain)
├── images.cdn.com/
│   ├── image1.jpg
│   ├── image2.png
│   └── ...
└── static.example.com/
    └── video.mp4
```

## Comparison with Bash Version

The original bash script (`media-downloader`) had limitations with JavaScript-rendered pages. This TypeScript version improves upon it:

| Feature | Bash Version | TypeScript Version |
|---------|--------------|-------------------|
| JavaScript Support | ❌ No | ✅ Yes (Playwright) |
| Concurrent Downloads | ✅ Limited | ✅ Full (p-queue) |
| Visual Dedup | ✅ sips (macOS only) | ✅ sharp (cross-platform) |
| Image Processing | ✅ sips (macOS only) | ✅ sharp (cross-platform) |
| Error Handling | ⚠️ Basic | ✅ Robust |
| Type Safety | ❌ No | ✅ TypeScript |
| Platform Support | 🍎 macOS only | 🌍 Cross-platform |

## Architecture

```
src/
├── index.ts           # CLI entry point and main orchestration
├── types.ts           # TypeScript type definitions
├── crawler.ts         # Browser automation and URL extraction
├── downloader.ts      # File download manager with concurrency
├── deduplicator.ts    # Visual similarity detection
└── utils/
    ├── logger.ts      # Colored console logging
    ├── url-utils.ts   # URL parsing and normalization
    └── file-utils.ts  # File hashing and image processing
```

## Dependencies

- **playwright**: Headless browser automation for JavaScript rendering
- **commander**: CLI argument parsing
- **sharp**: Fast image processing (dimensions, visual hashing)
- **p-queue**: Promise-based queue for concurrency control
- **chalk**: Terminal colors for better UX

## Requirements

- Node.js 18+ (for native fetch and modern features)
- Chromium browser (installed via Playwright)

## Troubleshooting

### Browser fails to launch

Make sure Playwright browsers are installed:
```bash
npx playwright install chromium
```

### Downloads failing

- Check internet connection
- Try reducing concurrency: `--concurrency 3`
- Enable verbose mode to see errors: `-v`

### Too many files downloaded

- Reduce depth: `-d 0` (initial page only)
- Increase minimum dimensions: `--min-dim 1000`

## License

ISC

## Contributing

This is a personal project but suggestions and improvements are welcome!
