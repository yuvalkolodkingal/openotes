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

import { useState } from "react";
import { Box, Button, Flex, Text } from "@theme-ui/components";
import Dialog from "../components/dialog";
import Field from "../components/field";
import { BaseDialogProps, DialogManager } from "../common/dialog-manager";
import { strings } from "@notesnook/intl";
import { db } from "../common/db";
import { store as appStore } from "../stores/app-store";
import { importBackup } from "../common";
import { SettingsDialog } from "./settings";
import { WebDavConnectionForm } from "./settings/components/webdav-connection";
import Config from "../utils/config";
import { showToast } from "../utils/toast";
import { ShieldLock, Sync, Import } from "../components/icons";

const ONBOARDING_CONFIG_KEY = "onboarding:completed";

export function isOnboardingComplete() {
  return !!Config.get(ONBOARDING_CONFIG_KEY, false);
}

function completeOnboarding() {
  Config.set(ONBOARDING_CONFIG_KEY, true);
}

type Step = "welcome" | "vault" | "sync" | "import";

type OnboardingDialogProps = BaseDialogProps<boolean>;

/**
 * First run of Openotes. There is no account to create and nothing to sign
 * up for: the vault is already on disk by the time this dialog opens, so the
 * flow only walks through the local setup — protect the vault, point sync at
 * a WebDAV server, bring existing notes in — and every step can be skipped.
 */
export const OnboardingDialog = DialogManager.register(
  function OnboardingDialog({ onClose }: OnboardingDialogProps) {
    const [step, setStep] = useState<Step>("welcome");
    const [isWorking, setIsWorking] = useState(false);
    const [error, setError] = useState<string>();

    function finish(action?: () => void) {
      completeOnboarding();
      onClose(true);
      action?.();
    }

    if (step === "welcome")
      return (
        <Dialog
          testId="onboarding-dialog"
          isOpen={true}
          title="Welcome to Openotes"
          description="A private, offline-first notes app. Your notes live in an encrypted database on this device — no account, no cloud, no subscription."
          onClose={() => finish()}
          positiveButton={{
            text: strings.continue(),
            onClick: () => setStep("vault")
          }}
          negativeButton={{
            text: strings.skipIntroduction(),
            onClick: () => finish()
          }}
        >
          <Flex sx={{ flexDirection: "column", gap: 2 }}>
            <Highlight
              icon={<ShieldLock size={16} color="accent" />}
              title="Lock your private notes"
              description="Set a vault password to keep individual notes encrypted behind it."
            />
            <Highlight
              icon={<Sync size={16} color="accent" />}
              title="Sync with your own server"
              description="Openotes syncs end-to-end encrypted data to any WebDAV server you control."
            />
            <Highlight
              icon={<Import size={16} color="accent" />}
              title="Bring your notes with you"
              description="Import from other apps or restore an existing backup."
            />
          </Flex>
        </Dialog>
      );

    if (step === "vault")
      return (
        <Dialog
          testId="onboarding-dialog"
          isOpen={true}
          title={strings.createVault()}
          description={strings.createVaultDesc()}
          onClose={() => finish()}
          positiveButton={{
            form: "onboardingVaultForm",
            type: "submit",
            text: strings.createVault(),
            loading: isWorking,
            disabled: isWorking
          }}
          negativeButton={{
            text: strings.skip(),
            onClick: () => setStep("sync")
          }}
        >
          <Box
            id="onboardingVaultForm"
            as="form"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(undefined);
              setIsWorking(true);
              try {
                const formData = new FormData(e.target as HTMLFormElement);
                const password = formData.get("password")?.toString();
                const confirmPassword = formData
                  .get("confirmPassword")
                  ?.toString();
                if (!password || password !== confirmPassword)
                  throw new Error(strings.passwordNotMatched());

                await db.vault.create(password);
                appStore.get().setIsVaultCreated(true);
                showToast("success", strings.vaultCreated());
                setStep("sync");
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setIsWorking(false);
              }
            }}
          >
            <Field
              id="password"
              name="password"
              label={strings.password()}
              type="password"
              autoComplete="new-password"
              required
              autoFocus
            />
            <Field
              id="confirmPassword"
              name="confirmPassword"
              label={strings.confirmPassword()}
              type="password"
              autoComplete="new-password"
              required
              sx={{ mt: 1 }}
            />
            {error ? (
              <Text variant="error" mt={1}>
                {error}
              </Text>
            ) : null}
          </Box>
        </Dialog>
      );

    if (step === "sync")
      return (
        <Dialog
          testId="onboarding-dialog"
          isOpen={true}
          title="Connect WebDAV"
          description="Openotes syncs through a WebDAV server that you own. Everything is encrypted on this device before it leaves it, so the server only ever holds ciphertext. This is entirely optional — skip it and the vault stays on this computer."
          onClose={() => finish()}
          width={520}
          positiveButton={null}
          negativeButton={{
            text: strings.later(),
            onClick: () => setStep("import")
          }}
        >
          <Flex sx={{ flexDirection: "column", gap: 2 }}>
            <WebDavConnectionForm
              showInsecureHttpOption
              submitText="Connect"
              onSaved={() => setStep("import")}
            />
            <Text variant="subBody">
              You can also do this later from Settings &rarr; {strings.sync()}.
            </Text>
          </Flex>
        </Dialog>
      );

    return (
      <Dialog
        testId="onboarding-dialog"
        isOpen={true}
        title="Bring in your notes"
        description="Already have notes elsewhere? Import them now, or start writing with an empty vault."
        onClose={() => finish()}
        positiveButton={{
          text: "Import notes",
          onClick: () =>
            finish(() => SettingsDialog.show({ activeSection: "importer" }))
        }}
        negativeButton={{
          text: strings.skip(),
          onClick: () => finish()
        }}
      >
        <Button
          variant="secondary"
          sx={{ alignSelf: "start" }}
          onClick={() => finish(() => importBackup())}
        >
          {strings.restoreBackup()}
        </Button>
      </Dialog>
    );
  }
);

function Highlight(props: {
  icon: JSX.Element;
  title: string;
  description: string;
}) {
  return (
    <Flex sx={{ gap: 2, alignItems: "start" }}>
      <Box sx={{ mt: "3px" }}>{props.icon}</Box>
      <Flex sx={{ flexDirection: "column" }}>
        <Text variant="subtitle">{props.title}</Text>
        <Text variant="body" sx={{ color: "paragraph-secondary" }}>
          {props.description}
        </Text>
      </Flex>
    </Flex>
  );
}
