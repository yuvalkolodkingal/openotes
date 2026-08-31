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

import { useEffect, useState } from "react";
import {
  areFeaturesAvailable,
  FeatureId,
  FeatureResult,
  isFeatureAvailable
} from "../utils/index.js";

/**
 * Availability is derived from a static capability declaration (see
 * `utils/is-feature-available.ts`), so it is resolved once and never
 * invalidated — there is no subscription that could change it.
 */
export function useIsFeatureAvailable<TId extends FeatureId>(
  id: TId | undefined,
  value?: number
) {
  const [result, setResult] = useState<FeatureResult<TId>>();

  useEffect(() => {
    if (!id) return;

    let cancelled = false;
    isFeatureAvailable(id, value).then((result) => {
      if (!cancelled) setResult(result);
    });
    return () => {
      cancelled = true;
    };
  }, [id, value]);

  return result;
}

export function useAreFeaturesAvailable<TIds extends FeatureId[]>(
  ids: TIds,
  values: number[] = []
) {
  const [result, setResult] =
    useState<{ [K in TIds[number]]: FeatureResult<K> }>();

  useEffect(() => {
    let cancelled = false;
    areFeaturesAvailable(ids, values).then((result) => {
      if (!cancelled) setResult(result);
    });
    return () => {
      cancelled = true;
    };
  }, [ids.join(","), values.join(",")]);

  return result;
}
