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

/**
 * The durable half of conflict surfacing.
 *
 * The engine never discards a conflicting edit: it keeps both versions (a
 * `… (conflict)` copy for items, `conflicted` content for note bodies). That
 * only helps if the user learns about it, so every conflict is recorded in
 * the webdav store, announced with a toast, and listed here — reachable from
 * the sync status indicator for as long as the entry has not been dismissed.
 */

import { Button, Flex, Text } from "@theme-ui/components";
import Dialog from "../components/dialog";
import { BaseDialogProps, DialogManager } from "../common/dialog-manager";
import { Alert, Dismiss } from "../components/icons";
import {
  useStore as useWebDavStore,
  SyncConflict
} from "../stores/webdav-store";
import { getFormattedDate } from "@notesnook/common";
import { strings } from "@notesnook/intl";

type SyncConflictsDialogProps = BaseDialogProps<false>;

export const SyncConflictsDialog = DialogManager.register(
  function SyncConflictsDialog({ onClose }: SyncConflictsDialogProps) {
    const conflicts = useWebDavStore((store) => store.conflicts);
    const dismissConflict = useWebDavStore((store) => store.dismissConflict);
    const clearConflicts = useWebDavStore((store) => store.clearConflicts);

    return (
      <Dialog
        testId="sync-conflicts-dialog"
        isOpen={true}
        title="Sync conflicts"
        description={
          conflicts.length
            ? "The same items were edited on more than one device. Nothing was thrown away — both versions are in your notes, the incoming one saved alongside yours. Open each item, keep what you want and delete the rest."
            : "Nothing is in conflict right now."
        }
        onClose={() => onClose(false)}
        positiveButton={{
          text: strings.done(),
          onClick: () => onClose(false)
        }}
        negativeButton={
          conflicts.length
            ? {
                text: "Clear list",
                onClick: () => clearConflicts()
              }
            : undefined
        }
      >
        <Flex
          sx={{
            flexDirection: "column",
            gap: 1,
            maxHeight: 320,
            overflowY: "auto"
          }}
        >
          {conflicts.map((conflict) => (
            <ConflictItem
              key={conflict.id}
              conflict={conflict}
              onDismiss={() => dismissConflict(conflict.id)}
            />
          ))}
        </Flex>
      </Dialog>
    );
  }
);

function ConflictItem(props: {
  conflict: SyncConflict;
  onDismiss: () => void;
}) {
  const { conflict, onDismiss } = props;
  return (
    <Flex
      sx={{
        alignItems: "center",
        gap: 2,
        p: 1,
        borderRadius: "default",
        bg: "background-secondary"
      }}
      data-test-id={`sync-conflict-${conflict.id}`}
    >
      <Alert size={16} color="icon-error" />
      <Flex sx={{ flexDirection: "column", flex: 1, overflow: "hidden" }}>
        <Text
          variant="body"
          sx={{
            color: "heading",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap"
          }}
        >
          {conflict.title}
        </Text>
        <Text variant="subBody">
          {conflict.entityType} &middot; {getFormattedDate(conflict.at)}
        </Text>
      </Flex>
      <Button
        variant="secondary"
        title={strings.dismiss()}
        sx={{ p: 1, bg: "transparent", flexShrink: 0 }}
        onClick={onDismiss}
      >
        <Dismiss size={16} color="icon" />
      </Button>
    </Flex>
  );
}
