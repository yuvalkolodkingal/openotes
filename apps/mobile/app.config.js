/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2026 Openotes contributors

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

// app.json is the configuration; this layers the version on top of it so a
// release build stamps the same number the desktop reports, and derives the
// Android versionCode from it -- 2.2.1 becomes 20201 -- so every release
// installs over the previous one instead of being refused as a downgrade.

module.exports = ({ config }) => {
  const version = process.env.OPENOTES_VERSION || config.version;
  const [major = 0, minor = 0, patch = 0] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  return {
    ...config,
    version,
    android: {
      ...config.android,
      versionCode: major * 10000 + minor * 100 + patch
    }
  };
};
