import * as cheerio from 'cheerio';
import { MediaFile, FileType, extractExtension, getFileType } from '../shared/types';

export class HttpDirectoryParser {
  static parse(html: string, baseUrl: string): MediaFile[] {
    const results: MediaFile[] = [];
    const seenUrls = new Set<string>();

    try {
      const $ = cheerio.load(html);
      const normalizedBaseUrl = this.normalizeUrl(baseUrl);

      // 1. Check if there are table rows (Standard Apache / Nginx / Lighttpd directory listing)
      const tableRows = $('table tr');
      if (tableRows.length > 0) {
        tableRows.each((_, row) => {
          const $row = $(row);
          const $link = $row.find('a').first();
          if (!$link.length) return;

          const href = $link.attr('href')?.trim() || '';
          const linkText = $link.text().trim();

          if (this.isIgnoredLink(href, linkText)) return;

          const fullUrl = this.resolveUrl(normalizedBaseUrl, href);
          if (!fullUrl || seenUrls.has(fullUrl)) return;

          const rowText = $row.text();
          const rawName = linkText || href;
          const extension = extractExtension(rawName);

          // Determine if directory
          const isDir = 
            href.endsWith('/') || 
            href.includes('/?') || 
            rowText.includes('[DIR]') || 
            rowText.includes('Directory') ||
            (extension === '' && !href.includes('.'));

          // Extract date and size from sibling table columns
          const cols = $row.find('td');
          let dateStr: string | null = null;
          let sizeStr: string | null = null;

          if (cols.length >= 3) {
            cols.each((i, col) => {
              if (i === 0) return;
              const text = $(col).text().trim();
              if (/\d{4}-\d{2}-\d{2}|\d{2}-[a-zA-Z]{3}-\d{4}/.test(text)) {
                dateStr = text;
              } else if (/^[0-9.]+\s*[kKmMgGtT]?[bB]?$/.test(text) || /^[0-9]+$/.test(text)) {
                sizeStr = text;
              }
            });
          }

          const fileType = getFileType(isDir, extension);
          const cleanDisplayName = this.getCleanDisplayName(rawName);

          results.push({
            name: rawName,
            fullUrl,
            isDirectory: isDir,
            sizeString: sizeStr,
            dateString: dateStr,
            extension,
            fileType,
            cleanDisplayName,
            isPlayableVideo: fileType === FileType.VIDEO,
            isSubtitleFile: fileType === FileType.SUBTITLE
          });
          seenUrls.add(fullUrl);
        });
      }

      // 2. Generic <a> links or <pre> listing fallback
      if (results.length === 0) {
        $('a').each((_, link) => {
          const $link = $(link);
          const href = $link.attr('href')?.trim() || '';
          const linkText = $link.text().trim();

          if (this.isIgnoredLink(href, linkText)) return;

          const fullUrl = this.resolveUrl(normalizedBaseUrl, href);
          if (!fullUrl || seenUrls.has(fullUrl)) return;

          const rawName = linkText || href;
          const extension = extractExtension(rawName);
          const isDir = href.endsWith('/') || href.includes('/?') || linkText.endsWith('/') || (extension === '' && !href.includes('.'));
          const fileType = getFileType(isDir, extension);
          const cleanDisplayName = this.getCleanDisplayName(rawName);

          results.push({
            name: rawName,
            fullUrl,
            isDirectory: isDir,
            sizeString: null,
            dateString: null,
            extension,
            fileType,
            cleanDisplayName,
            isPlayableVideo: fileType === FileType.VIDEO,
            isSubtitleFile: fileType === FileType.SUBTITLE
          });
          seenUrls.add(fullUrl);
        });
      }
    } catch (e) {
      console.error('Failed to parse directory HTML:', e);
    }

    // Sort: Directories first, then alphabetical
    return results.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.cleanDisplayName.localeCompare(b.cleanDisplayName, undefined, { sensitivity: 'base' });
    });
  }

  private static normalizeUrl(urlStr: string): string {
    const trimmed = urlStr.trim();
    if (!trimmed.endsWith('/') && !trimmed.includes('?')) {
      return `${trimmed}/`;
    }
    return trimmed;
  }

  private static isIgnoredLink(href: string, linkText: string): boolean {
    if (!href || href === '#' || href.startsWith('javascript:')) return true;

    let decodedHref = href;
    let decodedText = linkText;
    try {
      decodedHref = decodeURIComponent(href);
      decodedText = decodeURIComponent(linkText);
    } catch {
      // keep raw
    }

    if (
      decodedHref === '../' ||
      decodedHref === '..' ||
      decodedHref.startsWith('?C=') ||
      decodedHref.startsWith('?O=') ||
      decodedHref.startsWith('?N=') ||
      decodedHref.startsWith('?S=') ||
      decodedHref.startsWith('?D=')
    ) {
      return true;
    }

    const lowerText = decodedText.toLowerCase();
    if (
      lowerText === 'parent directory' ||
      lowerText === '../' ||
      lowerText === '[to parent directory]' ||
      lowerText === 'name' ||
      lowerText === 'last modified' ||
      lowerText === 'size' ||
      lowerText === 'description'
    ) {
      return true;
    }

    return false;
  }

  private static resolveUrl(baseUrl: string, href: string): string | null {
    try {
      const base = new URL(baseUrl);
      const resolved = new URL(href, base);
      return resolved.toString();
    } catch {
      try {
        const cleanBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
        const cleanHref = href.startsWith('/') ? href.slice(1) : href;
        return `${cleanBase}${cleanHref}`;
      } catch {
        return null;
      }
    }
  }

  private static getCleanDisplayName(name: string): string {
    try {
      const decoded = decodeURIComponent(name);
      return decoded.endsWith('/') && decoded.length > 1 ? decoded.slice(0, -1) : decoded;
    } catch {
      return name.endsWith('/') && name.length > 1 ? name.slice(0, -1) : name;
    }
  }
}
