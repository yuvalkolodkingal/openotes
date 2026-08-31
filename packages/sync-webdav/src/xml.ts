/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

import { SyncError } from "./types.ts";

/**
 * Minimal, namespace-tolerant parsing of WebDAV PROPFIND multistatus
 * responses. Servers differ wildly in prefixes (`D:`, `d:`, `lp1:`, none)
 * and in which optional props they return, so we match on local element
 * names only and treat everything optional as optional.
 */

export interface DavEntry {
  /** Decoded absolute path (the href without scheme/host). */
  href: string;
  isCollection: boolean;
  etag?: string;
  contentLength?: number;
  lastModified?: string;
  status?: number;
}

/** Find all elements with the given local name; returns inner content. */
function findElements(xml: string, localName: string): string[] {
  const results: string[] = [];
  // Matches <prefix:name ...>...</prefix:name> and <name ...>...</name>,
  // non-greedy, case-insensitive. WebDAV bodies are small enough for this.
  const re = new RegExp(
    `<(?:[A-Za-z0-9_-]+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${localName}\\s*>`,
    "gi",
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    results.push(match[1]);
  }
  return results;
}

function findFirst(xml: string, localName: string): string | undefined {
  return findElements(xml, localName)[0];
}

function hasSelfClosingOrElement(xml: string, localName: string): boolean {
  const re = new RegExp(
    `<(?:[A-Za-z0-9_-]+:)?${localName}(?:\\s[^>]*)?/?>`,
    "i",
  );
  return re.test(xml);
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(
      /&#x([0-9a-fA-F]+);/g,
      (_, hex) => String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}

function parseStatusLine(status: string | undefined): number | undefined {
  if (!status) return undefined;
  const match = /HTTP\/[\d.]+\s+(\d{3})/.exec(status);
  return match ? parseInt(match[1], 10) : undefined;
}

export function parseMultistatus(xml: string): DavEntry[] {
  if (!/<(?:[A-Za-z0-9_-]+:)?multistatus/i.test(xml)) {
    throw new SyncError(
      "Malformed PROPFIND response: no <multistatus> element",
      "corrupt-data",
    );
  }

  const entries: DavEntry[] = [];
  for (const response of findElements(xml, "response")) {
    const rawHref = findFirst(response, "href");
    if (rawHref === undefined) continue;

    let href = decodeXmlEntities(rawHref.trim());
    try {
      // Hrefs may be absolute URLs or absolute paths; normalize to a path.
      if (/^https?:\/\//i.test(href)) href = new URL(href).pathname;
      href = decodeURIComponent(href);
    } catch {
      // Keep the raw href if it cannot be decoded.
    }

    const propstats = findElements(response, "propstat");
    // Use the successful propstat when present, else the whole response.
    const okPropstat = propstats.find((p) =>
      parseStatusLine(findFirst(p, "status")) === 200
    ) ??
      propstats[0] ??
      response;

    const contentLengthRaw = findFirst(okPropstat, "getcontentlength")?.trim();
    const etagRaw = findFirst(okPropstat, "getetag")?.trim();

    entries.push({
      href,
      isCollection: hasSelfClosingOrElement(
        findFirst(okPropstat, "resourcetype") ?? "",
        "collection",
      ) || href.endsWith("/"),
      etag: etagRaw ? decodeXmlEntities(etagRaw) : undefined,
      contentLength: contentLengthRaw && /^\d+$/.test(contentLengthRaw)
        ? parseInt(contentLengthRaw, 10)
        : undefined,
      lastModified: findFirst(okPropstat, "getlastmodified")?.trim(),
      status: parseStatusLine(findFirst(response, "status")),
    });
  }
  return entries;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:getetag/>
    <d:getcontentlength/>
    <d:getlastmodified/>
  </d:prop>
</d:propfind>`;
