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

import { mkdirSync, writeFileSync } from "fs";

type DataType =
  | "note"
  | "notebook"
  | "tag"
  | "reminder"
  | "color"
  | "attachment"
  | "item"
  | "shortcut"
  | "version";

type ActionDefinition = {
  action: string;
  label: string;
  dataTypes: DataType[];
};

type DataTypeStrings = {
  singular: string;
  singularCamelCase: string;
  plural: string;
  pluralCamelCase: string;
};

const DO_ACTIONS: ActionDefinition[] = [
  {
    action: "delete",
    label: "Delete",
    dataTypes: [
      "note",
      "item",
      "reminder",
      "notebook",
      "tag",
      "color",
      "attachment",
      "version"
    ]
  },
  { action: "unpin", label: "Unpin", dataTypes: ["note", "notebook"] },
  { action: "pin", label: "Pin", dataTypes: ["note", "notebook"] },
  { action: "unpublish", label: "Unpublish", dataTypes: ["note"] },
  { action: "publish", label: "Publish", dataTypes: ["note"] },
  {
    action: "permanentlyDelete",
    label: "Permanently delete",
    dataTypes: ["attachment", "item"]
  },
  {
    action: "restore",
    label: "Restore",
    dataTypes: ["note", "notebook"]
  },
  {
    action: "edit",
    label: "Edit",
    dataTypes: ["tag", "notebook", "reminder"]
  },
  {
    action: "rename",
    label: "Rename",
    dataTypes: ["attachment", "color", "tag"]
  },
  {
    action: "remove",
    label: "Remove",
    dataTypes: ["shortcut", "color", "attachment"]
  },
  {
    action: "download",
    label: "Download",
    dataTypes: ["attachment"]
  }
];

const ACTIONS: ActionDefinition[] = [
  {
    action: "deleted",
    label: "deleted",
    dataTypes: ["attachment", "reminder", "tag", "note", "notebook", "version"]
  },
  {
    action: "movedToTrash",
    label: "moved to trash",
    dataTypes: ["note", "notebook"]
  },
  {
    action: "permanentlyDeleted",
    label: "permanently deleted",
    dataTypes: ["note", "notebook", "item"]
  },
  { action: "published", label: "published", dataTypes: ["note"] },
  { action: "unpublished", label: "unpublished", dataTypes: ["note"] },
  {
    action: "restored",
    label: "restored",
    dataTypes: ["note", "notebook", "item"]
  },
  {
    action: "edited",
    label: "edited",
    dataTypes: ["tag", "notebook"]
  },
  {
    action: "created",
    label: "created",
    dataTypes: ["notebook", "tag", "shortcut"]
  },
  {
    action: "renamed",
    label: "renamed",
    dataTypes: ["color"]
  }
];

const ACTION_CONFIRMATIONS: ActionDefinition[] = [
  {
    action: "delete",
    label: "delete",
    dataTypes: [
      "note",
      "item",
      "reminder",
      "notebook",
      "tag",
      "color",
      "attachment"
    ]
  },
  {
    action: "permanentlyDelete",
    label: "permanently delete",
    dataTypes: ["note", "notebook", "version"]
  }
];

const ACTION_ERRORS: ActionDefinition[] = [
  {
    action: "unpublished",
    label: "unpublished",
    dataTypes: ["note"]
  },
  {
    action: "published",
    label: "published",
    dataTypes: ["note"]
  }
];

const IN_PROGRESS_ACTIONS: ActionDefinition[] = [
  {
    action: "deleting",
    label: "Deleting",
    dataTypes: ["note", "notebook", "attachment", "tag", "reminder"]
  },
  {
    action: "restoring",
    label: "Restoring",
    dataTypes: ["item"]
  },
  {
    action: "permanentlyDeleting",
    label: "permanently deleting",
    dataTypes: ["item"]
  }
];

const DATA_TYPES: Record<DataType, DataTypeStrings> = {
  note: {
    singular: `note`,
    singularCamelCase: `Note`,
    plural: `notes`,
    pluralCamelCase: `Notes`
  },
  notebook: {
    singular: `notebook`,
    singularCamelCase: `Notebook`,
    plural: `notebooks`,
    pluralCamelCase: `Notebooks`
  },
  tag: {
    singular: `tag`,
    singularCamelCase: `Tag`,
    plural: `tags`,
    pluralCamelCase: `Tags`
  },
  reminder: {
    singular: `reminder`,
    singularCamelCase: `Reminder`,
    plural: `reminders`,
    pluralCamelCase: `Reminders`
  },
  color: {
    singular: `color`,
    singularCamelCase: `Color`,
    plural: `colors`,
    pluralCamelCase: `Colors`
  },
  attachment: {
    singular: `attachment`,
    singularCamelCase: `Attachment`,
    plural: `attachments`,
    pluralCamelCase: `Attachments`
  },
  item: {
    singular: `item`,
    singularCamelCase: `Item`,
    plural: `items`,
    pluralCamelCase: `Items`
  },
  shortcut: {
    singular: `shortcut`,
    singularCamelCase: `Shortcut`,
    plural: `shortcuts`,
    pluralCamelCase: `Shortcuts`
  },
  version: {
    singular: `version`,
    singularCamelCase: `Version`,
    plural: `versions`,
    pluralCamelCase: `Versions`
  }
};

const DO_ACTIONS_TEMPLATE = (action: string, dataTypes: string) => `${action}: {
    ${dataTypes}
}`;

const UNKNOWN_DATA_TYPE_TEMPLATE = (
  exportName: string,
  action: string,
  types: DataType[],
  fallbackSingularTemplate: string,
  fallbackPluralTemplate: string
) => `unknown: (type: string, count: number) => {
  switch (type) {
    ${types
      .map(
        (type) => `case "${type}":
        return ${exportName}.${action}.${type}(count);`
      )
      .join("\n")}
    default:
      return plural(count, {
        one: \`${fallbackSingularTemplate}\`,
        other: \`${fallbackPluralTemplate}\`
      });
  }
}`;

const DATA_TYPES_TEMPLATE = (
  type: DataType,
  singularTemplate: string,
  pluralTemplate: string
) => `${type}: (count: number) => plural(count, {
  one: \`${singularTemplate}\`,
  other: \`${pluralTemplate}\`
})`;

const MODULE_TEMPLATE = (exportName: string, strings: string) =>
  `/* eslint-disable header/header */
// THIS FILE IS GENERATED. DO NOT EDIT MANUALLY.

import { plural } from "@lingui/core/macro";

export const ${exportName} = {
    ${strings}
};
`;

function generateDoActionsStrings(): string {
  const exportName = "doActions";

  return MODULE_TEMPLATE(
    exportName,
    generateStrings(
      exportName,
      DO_ACTIONS,
      (action, type) => `${action} ${DATA_TYPES[type].singular}`,
      (action, type) => `${action} # ${DATA_TYPES[type].plural}`
    )
  );
}

function generateActionsStrings(): string {
  const exportName = "actions";
  return MODULE_TEMPLATE(
    exportName,
    generateStrings(
      exportName,
      ACTIONS,
      (action, type) => `${DATA_TYPES[type].singularCamelCase} ${action}`,
      (action, type) => `# ${DATA_TYPES[type].plural} ${action}`
    )
  );
}

function generateActionConfirmationStrings(): string {
  const exportName = "actionConfirmations";
  return MODULE_TEMPLATE(
    exportName,
    generateStrings(
      exportName,
      ACTION_CONFIRMATIONS,
      (action, type) =>
        `Are you sure you want to ${action} this ${DATA_TYPES[type].singular}?`,
      (action, type) =>
        `Are you sure you to ${action} these ${DATA_TYPES[type].plural}?`
    )
  );
}

function generateActionErrorStrings(): string {
  const exportName = "actionErrors";
  return MODULE_TEMPLATE(
    exportName,
    generateStrings(
      exportName,
      ACTION_ERRORS,
      (action, type) =>
        `${DATA_TYPES[type].singularCamelCase} could not be ${action}`,
      (action, type) => `# ${DATA_TYPES[type].plural} could not be ${action}`
    )
  );
}

function generateInProgressActionsStrings(): string {
  const exportName = "inProgressActions";
  return MODULE_TEMPLATE(
    exportName,
    generateStrings(
      exportName,
      IN_PROGRESS_ACTIONS,
      (action, type) => `${action} ${DATA_TYPES[type].singular}...`,
      (action, type) => `${action} # ${DATA_TYPES[type].plural}...`
    )
  );
}

function generateStrings(
  exportName: string,
  actions: ActionDefinition[],
  singular: (action: string, type: DataType) => string,
  plural: (action: string, type: DataType) => string
): string {
  let result: string[] = [];
  for (const action of actions) {
    const subResults: string[] = [];
    const actionName = action.label;
    for (const type of action.dataTypes) {
      subResults.push(
        DATA_TYPES_TEMPLATE(
          type,
          singular(actionName, type),
          plural(actionName, type)
        )
      );
    }
    subResults.push(
      UNKNOWN_DATA_TYPE_TEMPLATE(
        exportName,
        action.action,
        action.dataTypes,
        singular(actionName, "item"),
        plural(actionName, "item")
      )
    );
    result.push(DO_ACTIONS_TEMPLATE(action.action, subResults.join(",\n")));
  }
  return result.join(",\n");
}

mkdirSync("./generated/", { recursive: true });

writeFileSync("./generated/do-actions.ts", generateDoActionsStrings());

writeFileSync("./generated/actions.ts", generateActionsStrings());

writeFileSync(
  "./generated/in-progress-actions.ts",
  generateInProgressActionsStrings()
);

writeFileSync("./generated/action-errors.ts", generateActionErrorStrings());

writeFileSync(
  "./generated/action-confirmations.ts",
  generateActionConfirmationStrings()
);
