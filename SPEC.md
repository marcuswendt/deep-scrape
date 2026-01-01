# Image & Video Downloader - Specification

## Overview

A macOS command-line tool that recursively downloads images and video files from a given URL, following links up to a configurable depth.

## Features

### Core Functionality

- **Download media files**: Images (jpg, jpeg, png, gif, webp, svg, avif, ico) and videos (mp4, webm, mov, avi, mkv)
- **Recursive crawling**: Follow links on pages up to a configurable depth
- **Domain filtering**: Only download from domains discovered on the initial page
- **Visual similarity detection**: Identifies scaled/resized versions of the same image and keeps only the highest quality
- **Duplicate detection**: Skips exact duplicate files by content hash

### Domain Discovery & Filtering

The tool builds an "allowed domains" list from the initial page:
1. The source URL's domain (e.g., `silvanozeiter.com`)
2. Any domains referenced in media URLs on the initial page (e.g., `images.squarespace-cdn.com`)
3. Subdomains are treated as separate domains but included if found

This prevents the crawler from wandering to unrelated external sites while still capturing CDN-hosted assets.

## Usage

```bash
./media-downloader <url> [options]
```

### Arguments

| Argument | Description | Default |
|----------|-------------|---------|
| `<url>` | Source URL to crawl | Required |
| `-d, --depth <n>` | Recursion depth (0 = initial page only) | 1 |
| `-o, --output <dir>` | Output directory | `./<domain>` |
| `-c, --concurrency <n>` | Parallel downloads | 5 |
| `-v, --verbose` | Verbose output | false |
| `--dry-run` | Show what would be downloaded without downloading | false |
| `--min-width <px>` | Minimum image width in pixels | 0 |
| `--min-height <px>` | Minimum image height in pixels | 0 |
| `--min-dim <px>` | Set both min-width and min-height at once | 0 |
| `--allow-duplicates` | Allow downloading duplicate files (by content) | false |
| `--no-visual-dedup` | Disable visual similarity detection | false |

### Examples

```bash
# Download from a portfolio site, default depth of 1
./media-downloader https://silvanozeiter.com/

# Download with depth 2, custom output folder
./media-downloader https://example.com -d 2 -o ~/Pictures/scraped

# Preview what would be downloaded
./media-downloader https://example.com --dry-run

# Only download images at least 800px on each side
./media-downloader https://example.com --min-dim 800
```

## Technical Design

### Dependencies

- `curl` - HTTP requests (pre-installed on macOS)
- `grep`, `sed`, `awk` - Text processing (pre-installed on macOS)
- `sips` - Image dimension detection (pre-installed on macOS)
- `md5` - Content hashing for duplicate detection (pre-installed on macOS)
- No external dependencies required

### Algorithm

```
1. INITIALIZE:
   - Parse command-line arguments
   - Create output directory
   - Initialize visited URLs set
   - Initialize allowed domains set

2. DISCOVER ALLOWED DOMAINS (from initial page):
   - Fetch initial page HTML
   - Extract all media URLs (img src, video src, source src, CSS backgrounds)
   - Extract domains from these URLs
   - Add to allowed domains set

3. CRAWL (recursive):
   - If URL already visited or depth exceeded, return
   - Mark URL as visited
   - Fetch page content
   - Extract and download media files (if domain is allowed)
   - Extract links to other pages
   - For each link (if domain matches source domain):
     - Recursively crawl at depth - 1

4. DOWNLOAD MEDIA:
   - Skip if already downloaded (by URL)
   - Create subdirectory structure by domain
   - Download with curl, preserving original filename
   - Handle filename collisions with numeric suffix
   - Check image dimensions against min-width/min-height (if specified)
   - Compute content hash (MD5) and skip if duplicate content exists

5. VISUAL DEDUPLICATION (post-download):
   - Generate perceptual hash for each image (8x8 thumbnail hash)
   - Group images by visual hash
   - For each group, keep only the highest resolution version
   - Delete lower quality duplicates
```

### Output Structure

```text
silvanozeiter.com/
├── silvanozeiter.com/
│   └── (any direct images from main domain)
├── images.squarespace-cdn.com/
│   ├── image1.jpg
│   ├── image2.png
│   └── ...
└── download.log
```

### URL Extraction Patterns

The tool extracts URLs from:
- `<img src="...">` and `<img srcset="...">`
- `<video src="...">` and `<video poster="...">`
- `<source src="...">`
- `<a href="...">` (for crawling)
- `style="background-image: url(...)"`
- `<meta property="og:image" content="...">`

### Error Handling

- Skip invalid/malformed URLs
- Retry failed downloads up to 3 times
- Log errors to `download.log`
- Continue on individual file failures
- Respect HTTP status codes (skip 404s, handle redirects)

### Rate Limiting

- 100ms delay between requests to same domain
- Respects `robots.txt` (optional, disabled by default)

## Limitations

- Does not execute JavaScript (won't capture dynamically loaded content)
- Does not handle authentication/login-protected pages
- Maximum file size: 500MB per file
- Timeout: 30 seconds per request

## Future Enhancements (Out of Scope)

- JavaScript rendering support
- Resume interrupted downloads
- Custom file type filtering
- Proxy support
