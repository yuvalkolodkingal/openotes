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

import { Button, Flex, Text } from "@theme-ui/components";
import EditorFooter from "../editor/footer";
import {
  Loading,
  Update,
  Unlock,
  CellphoneLock,
  ConsoleLine
} from "../icons";
import { useStore as useAppStore } from "../../stores/app-store";
import { WebDavSyncStatus } from "./webdav-sync-status";
import { useAutoUpdater, UpdateStatus } from "../../hooks/use-auto-updater";
import useStatus, { statusToString } from "../../hooks/use-status";
import { ScopedThemeProvider } from "../theme-provider";
import { checkForUpdate, installUpdate } from "../../utils/updater";
import { showUpdateAvailableNotice } from "../../dialogs/confirm";
import { strings } from "@notesnook/intl";
import { useVault } from "../../hooks/use-vault";
import { useKeyStore } from "../../interfaces/key-store";
import { STATUS_BAR_HEIGHT } from "../../common/constants";
import { CommandPaletteDialog } from "../../dialogs/command-palette";

function StatusBar() {
  const statuses = useStatus();
  const updateStatus = useAutoUpdater();
  const isFocusMode = useAppStore((state) => state.isFocusMode);
  const { isVaultLocked, lockVault } = useVault();
  const { activeCredentials, relock } = useKeyStore();

  return (
    <ScopedThemeProvider
      scope="statusBar"
      bg="background"
      sx={{
        borderTop: "1px solid",
        borderTopColor: "separator",
        justifyContent: "space-between",
        display: ["none", "flex", "flex"],
        flexShrink: 0,
        height: STATUS_BAR_HEIGHT
      }}
      px={2}
    >
      {isFocusMode ? (
        <Flex />
      ) : (
        <Flex sx={{ gap: "small" }}>
          <Button
            variant="statusitem"
            onClick={() => CommandPaletteDialog.show({ isCommandMode: true })}
            sx={{
              alignItems: "center",
              justifyContent: "center",
              display: "flex",
              color: "paragraph",
              height: "100%"
            }}
            title={"Open command palette"}
          >
            <ConsoleLine size={12} />
          </Button>
          <WebDavSyncStatus />
          {activeCredentials().length > 0 && (
            <Button
              variant="statusitem"
              onClick={relock}
              sx={{
                alignItems: "center",
                justifyContent: "center",
                display: "flex",
                color: "paragraph",
                height: "100%"
              }}
              title={"Lock app"}
              data-test-id="lock-app"
            >
              <CellphoneLock size={12} />
            </Button>
          )}
          {statuses?.map((status) => {
            const { key, icon: Icon } = status;
            return (
              <Flex
                key={key}
                ml={1}
                sx={{ alignItems: "center", justifyContent: "center" }}
              >
                {Icon ? <Icon size={12} /> : <Loading size={12} />}
                <Text variant="subBody" ml={1} sx={{ color: "paragraph" }}>
                  {statusToString(status)}
                </Text>
              </Flex>
            );
          })}

          {updateStatus && updateStatus.type !== "updated" && (
            <Button
              variant="statusitem"
              onClick={async () => {
                if (updateStatus.type === "available") {
                  await showUpdateAvailableNotice(updateStatus);
                } else if (updateStatus.type === "completed") {
                  installUpdate();
                } else {
                  checkForUpdate();
                }
              }}
              sx={{
                ml: 1,
                alignItems: "center",
                justifyContent: "center",
                display: "flex",
                height: "100%"
              }}
            >
              <Update
                rotate={
                  updateStatus.type !== "completed" &&
                  updateStatus.type !== "available"
                }
                rotateDirection="counterclockwise"
                color={
                  updateStatus.type === "available" ? "accent" : "paragraph"
                }
                size={12}
              />
              <Text variant="subBody" ml={1} sx={{ color: "paragraph" }}>
                {statusToInfoText(updateStatus)}
              </Text>
            </Button>
          )}
          {!isVaultLocked && (
            <Button
              variant="statusitem"
              onClick={lockVault}
              sx={{
                alignItems: "center",
                justifyContent: "center",
                display: "flex",
                height: "100%"
              }}
              data-test-id="vault-unlocked"
            >
              <Unlock size={10} />
              <Text variant="subBody" ml={1} sx={{ color: "paragraph" }}>
                {strings.vaultUnlocked()}
              </Text>
            </Button>
          )}
        </Flex>
      )}
      <EditorFooter />
    </ScopedThemeProvider>
  );
}

export default StatusBar;

function statusToInfoText(status: UpdateStatus) {
  const { type } = status;
  return type === "checking"
    ? strings.checkingForUpdates()
    : type === "downloading"
    ? strings.updating(Math.round(status.progress))
    : type === "completed"
    ? strings.updateCompleted(status.version)
    : type === "available"
    ? strings.updateNewVersionAvailable(status.version)
    : "";
}

