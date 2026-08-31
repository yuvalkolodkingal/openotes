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

import { ManifestOptions } from "vite-plugin-pwa";

export const WEB_MANIFEST: Partial<ManifestOptions> = {
  name: "Openotes",
  description: "Offline-first, end-to-end encrypted notes with WebDAV sync.",
  short_name: "Openotes",
  shortcuts: [
    {
      name: "New note",
      url: "/#/notes/create",
      description: "Create a new note",
      icons: [
        {
          src: "/android-chrome-192x192.png",
          sizes: "192x192",
          type: "image/png"
        }
      ]
    },
    {
      name: "New notebook",
      url: "/#/notebooks/create",
      description: "Create a new notebook",
      icons: [
        {
          src: "/android-chrome-192x192.png",
          sizes: "192x192",
          type: "image/png"
        }
      ]
    }
  ],
  icons: [
    {
      src: "/android-chrome-192x192.png",
      sizes: "192x192",
      type: "image/png"
    },
    {
      src: "/android-chrome-512x512.png",
      sizes: "512x512",
      type: "image/png"
    },
    {
      src: "/android-chrome-maskable-192x192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "maskable"
    },
    {
      src: "/android-chrome-maskable-512x512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable"
    }
  ],
  // No store screenshots: the upstream set showed the Notesnook app, and
  // this fork does not ship as an installable store listing.
  // Openotes has no mobile apps and does not point users at Notesnook's, so
  // there are no related applications and none are preferred.
  orientation: "any",
  start_url: ".",
  theme_color: "#0f766e",
  background_color: "#fafaf9",
  display: "standalone",
  categories: ["productivity", "lifestyle", "education", "books"]
};
