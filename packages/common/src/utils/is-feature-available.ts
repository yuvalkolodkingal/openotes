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

import { SubscriptionPlan } from "@notesnook/core";
import { database as db } from "../database.js";

/**
 * Openotes is a local-only desktop fork of Notesnook: there is no hosted
 * account, no billing and therefore no tiers. Instead of asking a server
 * which plan the user is on, every gate in the app is answered from this
 * single capability declaration.
 *
 * Everything the app can do locally is available and unmetered, so every
 * feature check resolves to "allowed" and every quota resolves to
 * "unlimited". The module keeps the shape of the upstream feature matrix
 * (ids, titles, per-plan availability records) so that call sites across
 * the UI keep compiling and rendering unchanged.
 */
export const capabilities = {
  allLocalFeatures: true
} as const;

type CaptionValue = ("infinity" | (string & {})) | boolean | number;
type Limit<TCaption extends CaptionValue = CaptionValue> = {
  caption: TCaption;
  value: number | boolean;
  isAllowed: (value?: number) => Promise<boolean> | boolean;
};
type FeatureAvailability<TCaption extends CaptionValue = CaptionValue> = {
  free: Limit<TCaption>;
  essential: Limit<TCaption>;
  pro: Limit<TCaption>;
  believer: Limit<TCaption>;

  legacyPro: Limit<TCaption>;
};
export type Feature<TCaption extends CaptionValue = CaptionValue> = {
  id: string;
  title: string;
  error: (limit: Limit) => string;
  used?: () => Promise<number> | number;
  availability: FeatureAvailability<TCaption>;
};

export type FeatureResult<TId extends FeatureId = FeatureId> = {
  id: TId;
  isAllowed: boolean;
  availableOn?: SubscriptionPlan;
  caption: Caption<TId>;
  error: string;
};

/**
 * A capability that is simply on, e.g. app lock or callouts.
 */
function enabled(): Limit<CaptionValue> {
  return {
    caption: true,
    value: true,
    isAllowed: () => capabilities.allLocalFeatures
  };
}

/**
 * A capability that used to be metered (notebooks, tags, file size, ...)
 * and is now unbounded.
 */
function unlimited(): Limit<CaptionValue> {
  return {
    caption: "infinity",
    value: Infinity,
    isAllowed: () => capabilities.allLocalFeatures
  };
}

function createFeature(feature: {
  id: string;
  title: string;
  /**
   * `enabled` for on/off capabilities, `unlimited` for quotas.
   */
  limit: "enabled" | "unlimited";
  used?: Feature["used"];
  error?: Feature["error"];
}): Feature<CaptionValue> {
  const limit = feature.limit === "unlimited" ? unlimited() : enabled();
  return {
    id: feature.id,
    title: feature.title,
    used: feature.used,
    error:
      feature.error ?? (() => `${feature.title} is available without limits.`),
    availability: {
      free: limit,
      essential: limit,
      pro: limit,
      believer: limit,
      legacyPro: limit
    }
  };
}

export type FeatureId = keyof typeof features;
type Features = typeof features;
type Caption<TId extends FeatureId> =
  Features[TId]["availability"][keyof FeatureAvailability]["caption"];

const features = {
  storage: createFeature({
    id: "storage",
    title: "Storage",
    limit: "unlimited"
  }),
  fileSize: createFeature({
    id: "fileSize",
    title: "Maximum file size",
    limit: "unlimited"
  }),
  fullQualityImages: createFeature({
    id: "fullQualityImages",
    title: "Full quality images",
    limit: "enabled"
  }),
  blockLinking: createFeature({
    id: "blockLinking",
    title: "Block-level note links",
    limit: "enabled"
  }),
  taskList: createFeature({
    id: "taskList",
    title: "Task list",
    limit: "enabled"
  }),
  outlineList: createFeature({
    id: "outlineList",
    title: "Outline list",
    limit: "enabled"
  }),
  callout: createFeature({
    id: "callout",
    title: "Callouts",
    limit: "enabled"
  }),
  colors: createFeature({
    id: "colors",
    title: "Colors",
    limit: "unlimited",
    used: () => db.colors.all.count()
  }),
  tags: createFeature({
    id: "tags",
    title: "Tags",
    limit: "unlimited",
    used: () => db.tags.all.count()
  }),
  notebooks: createFeature({
    id: "notebooks",
    title: "Notebooks",
    limit: "unlimited",
    used: () => db.notebooks.all.count()
  }),
  activeReminders: createFeature({
    id: "activeReminders",
    title: "Active reminders",
    limit: "unlimited",
    used: () => db.reminders.active.count()
  }),
  shortcuts: createFeature({
    id: "shortcuts",
    title: "Shortcuts",
    limit: "unlimited",
    used: () => db.shortcuts.all.length
  }),
  defaultNotebookAndTag: createFeature({
    id: "defaultNotebookAndTag",
    title: "Default notebook & tag",
    limit: "enabled"
  }),
  recurringReminders: createFeature({
    id: "recurringReminders",
    title: "Recurring reminders",
    limit: "enabled"
  }),
  pinNoteInNotification: createFeature({
    id: "pinNoteInNotification",
    title: "Pin note in notification",
    limit: "enabled"
  }),
  createNoteFromNotificationDrawer: createFeature({
    id: "createNoteFromNotificationDrawer",
    title: "Create note from notification drawer",
    limit: "enabled"
  }),
  defaultSidebarTab: createFeature({
    id: "defaultSidebarTab",
    title: "Default sidebar tab",
    limit: "enabled"
  }),
  customHomepage: createFeature({
    id: "customHomepage",
    title: "Custom homepage",
    limit: "enabled"
  }),
  markdownShortcuts: createFeature({
    id: "markdownShortcuts",
    title: "Markdown shortcuts",
    limit: "enabled"
  }),
  fontLigatures: createFeature({
    id: "fontLigatures",
    title: "Font ligatures",
    limit: "enabled"
  }),
  customToolbarPreset: createFeature({
    id: "customToolbarPreset",
    title: "Custom toolbar preset",
    limit: "enabled"
  }),
  customizableSidebar: createFeature({
    id: "customizableSidebar",
    title: "Customizable sidebar",
    limit: "enabled"
  }),
  disableTrashCleanup: createFeature({
    id: "disableTrashCleanup",
    title: "Disable trash cleanup",
    limit: "enabled"
  }),
  appLock: createFeature({
    id: "appLock",
    title: "App lock",
    limit: "enabled"
  }),
  maxNoteVersions: createFeature({
    id: "maxNoteVersions",
    title: "Maximum note versions",
    limit: "unlimited"
  }),
  fullOfflineMode: createFeature({
    id: "fullOfflineMode",
    title: "Full offline mode",
    limit: "enabled"
  }),
  syncControls: createFeature({
    id: "syncControls",
    title: "Sync controls",
    limit: "enabled"
  }),
  monographLinksAndEmbeds: createFeature({
    id: "monographLinksAndEmbeds",
    title: "Links & embeds in monographs",
    limit: "enabled"
  }),
  monographAnalytics: createFeature({
    id: "monographAnalytics",
    title: "Monographs analytics",
    limit: "enabled"
  }),
  sms2FA: createFeature({
    id: "sms2FA",
    title: "2FA via SMS",
    limit: "enabled"
  }),
  notesnookCircle: createFeature({
    id: "notesnookCircle",
    title: "Notesnook Circle",
    limit: "enabled"
  }),
  androidLauncherShortcuts: createFeature({
    id: "androidLauncherShortcuts",
    title: "Android Launcher Shortcuts",
    limit: "enabled"
  }),
  expiringNotes: createFeature({
    id: "expiringNotes",
    title: "Expiring notes",
    limit: "enabled"
  }),
  exportTableAsCsv: createFeature({
    id: "exportTableAsCsv",
    title: "Export table as CSV",
    limit: "enabled"
  }),
  importCsvToTable: createFeature({
    id: "importCsvToTable",
    title: "Import CSV to table",
    limit: "enabled"
  })
};

export async function isFeatureAvailable<TId extends FeatureId>(
  id: TId,
  value?: number
): Promise<FeatureResult<TId>> {
  const feature = getFeature(id);
  const limit = await getFeatureLimit(feature);
  return {
    id,
    isAllowed: await limit.isAllowed(value),
    caption: limit.caption,
    error: features[id].error(limit)
  };
}

export async function getFeatureLimit<TId extends FeatureId>(
  feature: Feature<TId>
): Promise<Limit<Caption<TId>>> {
  return limitOf(feature);
}

export async function areFeaturesAvailable<TIds extends FeatureId[]>(
  ids: TIds,
  values: number[] = []
): Promise<{
  [K in TIds[number]]: FeatureResult<K>;
}> {
  const results = {} as {
    [K in TIds[number]]: FeatureResult<K>;
  };
  for (let i = 0; i < ids.length; ++i) {
    const value = values.at(i);
    const id = ids[i];

    const feature = getFeature(id);
    const limit = limitOf(feature);

    results[id as TIds[number]] = {
      id: id as TIds[number],
      isAllowed: await limit.isAllowed(value),
      caption: limit.caption as Caption<TIds[number]>,
      error: features[id].error(limit)
    };
  }

  return results;
}

export function getFeature<TId extends FeatureId>(id: TId): Feature<TId> {
  return features[id] as unknown as Feature<TId>;
}

export function planToAvailability(plan: SubscriptionPlan) {
  return PLAN_TO_AVAILABILITY[plan];
}

export function getFeaturesTable() {
  // Feature  FREE  ESSENTIAL  PRO   BELIEVER
  // (the four columns are kept for layout compatibility; they are identical)
  const rows: [string, Limit, Limit, Limit, Limit][] = [];
  for (const key in features) {
    const feature = features[key as FeatureId];
    rows.push([
      feature.title,
      feature.availability.free,
      feature.availability.essential,
      feature.availability.pro,
      feature.availability.believer
    ]);
  }
  return rows;
}

export type FeatureUsage = {
  id: FeatureId;
  total: number;
  used: number;
};
export async function getFeaturesUsage(): Promise<FeatureUsage[]> {
  const usage: FeatureUsage[] = [];
  for (const key in features) {
    const feature = getFeature(key as FeatureId);
    const limit = limitOf(feature);
    if (!feature.used || typeof limit.value !== "number") continue;
    usage.push({
      id: key as FeatureId,
      total: limit.value,
      used: await feature.used()
    });
  }
  return usage;
}

/**
 * Every plan resolves to the same set of limits, so the availability key is
 * irrelevant; picking one keeps the record shape (and its consumers) intact.
 */
function limitOf<TId extends FeatureId>(
  feature: Feature<TId>
): Limit<Caption<TId>> {
  return feature.availability[LOCAL_AVAILABILITY] as unknown as Limit<
    Caption<TId>
  >;
}

const LOCAL_AVAILABILITY: keyof Feature["availability"] = "pro";

const PLAN_TO_AVAILABILITY: Record<
  SubscriptionPlan,
  keyof Feature["availability"]
> = {
  [SubscriptionPlan.FREE]: LOCAL_AVAILABILITY,
  [SubscriptionPlan.ESSENTIAL]: LOCAL_AVAILABILITY,
  [SubscriptionPlan.PRO]: LOCAL_AVAILABILITY,
  [SubscriptionPlan.BELIEVER]: LOCAL_AVAILABILITY,
  [SubscriptionPlan.EDUCATION]: LOCAL_AVAILABILITY,
  [SubscriptionPlan.LEGACY_PRO]: LOCAL_AVAILABILITY
};
