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
 * The WebDAV connection form.
 *
 * Two secrets are involved and they are deliberately different things:
 *
 *  - the **WebDAV password** authenticates to the server (often an app
 *    password), and
 *  - the **sync passphrase** derives the key that encrypts every note before
 *    it is uploaded. The server never sees it, so it cannot be recovered from
 *    the server, and every device that syncs the same repository must use the
 *    same one.
 *
 * Neither is ever read back into the form: `webdav.getConfig` returns
 * `hasPassword`, not the password, and the passphrase is only ever written.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Checkbox, Flex, Label, Text } from "@theme-ui/components";
import Field from "../../../components/field";
import { ErrorText } from "../../../components/error-text";
import { Loading } from "../../../components/icons";
import { showToast } from "../../../utils/toast";
import { strings } from "@notesnook/intl";
import {
  useStore as useWebDavStore,
  store as webDavStore,
  TestConnectionResult
} from "../../../stores/webdav-store";
import { WebDavStatusPill } from "../../../components/status-bar/webdav-sync-status";

export type WebDavConnectionFormProps = {
  /**
   * Onboarding has no Advanced section, so it carries the plain-HTTP opt-in
   * inline. In Settings the same flag lives with the other advanced options.
   */
  showInsecureHttpOption?: boolean;
  submitText?: string;
  /** Called after a successful save (and connect, if this was the first one). */
  onSaved?: () => void;
};

type FormValues = {
  serverUrl: string;
  username: string;
  password: string;
  directory: string;
  passphrase: string;
  confirmPassphrase: string;
};

function readForm(form: HTMLFormElement): FormValues {
  const data = new FormData(form);
  const read = (name: string) => (data.get(name)?.toString() ?? "").trim();
  return {
    serverUrl: read("serverUrl").replace(/\/+$/, ""),
    username: read("username"),
    // Passwords and passphrases keep their whitespace: trimming them would
    // silently change a secret the user actually typed.
    password: data.get("password")?.toString() ?? "",
    directory: read("directory") || "Openotes",
    passphrase: data.get("passphrase")?.toString() ?? "",
    confirmPassphrase: data.get("confirmPassphrase")?.toString() ?? ""
  };
}

/**
 * The fields are uncontrolled (`defaultValue`), so they must not mount before
 * the stored configuration has arrived — hence the gate in
 * {@link WebDavConnectionForm} around this component.
 */
function ConnectionFields(props: WebDavConnectionFormProps) {
  const { showInsecureHttpOption, submitText, onSaved } = props;
  const config = useWebDavStore((store) => store.config);
  const formRef = useRef<HTMLFormElement>(null);

  const [allowInsecureHttp, setAllowInsecureHttp] = useState(
    () => webDavStore.get().config?.allowInsecureHttp ?? false
  );
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResult>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (config) setAllowInsecureHttp(config.allowInsecureHttp);
  }, [config]);

  const validate = useCallback(
    (values: FormValues) => {
      if (!values.serverUrl) return "Enter the URL of your WebDAV server.";
      if (!/^https?:\/\//i.test(values.serverUrl))
        return "The server URL must start with https:// or http://.";
      if (
        values.serverUrl.toLowerCase().startsWith("http://") &&
        !allowInsecureHttp
      )
        return showInsecureHttpOption
          ? "This URL uses plain HTTP. Tick “Allow plain HTTP” below if this " +
              "server is on a network you trust, or use https:// instead."
          : "This URL uses plain HTTP. Turn on “Allow plain HTTP” under " +
              "Advanced if this server is on a network you trust, or use " +
              "https:// instead.";
      if (!values.username) return "Enter the username for your WebDAV server.";
      if (values.passphrase && values.passphrase !== values.confirmPassphrase)
        return "The two sync passphrases do not match.";
      if (!values.passphrase && !config?.hasPassword)
        return (
          "Set a sync passphrase. It is what encrypts your notes before they " +
          "are uploaded."
        );
      return undefined;
    },
    [allowInsecureHttp, config?.hasPassword, showInsecureHttpOption]
  );

  const onTest = useCallback(async () => {
    const form = formRef.current;
    if (!form) return;
    const values = readForm(form);
    setError(undefined);
    setTestResult(undefined);

    const problem = validate(values);
    if (problem) return setError(problem);
    if (!values.password)
      return setError(
        "Type the WebDAV password to test the connection. It is stored " +
          "encrypted and never sent back to this form, so it has to be " +
          "entered again here."
      );
    if (!values.passphrase)
      return setError(
        "Type the sync passphrase to test the connection: it is needed to " +
          "check that this device can read the remote repository."
      );

    setIsTesting(true);
    try {
      const result = await webDavStore.testConnection({
        serverUrl: values.serverUrl,
        username: values.username,
        password: values.password,
        directory: values.directory,
        passphrase: values.passphrase,
        allowInsecureHttp,
        timeoutSeconds: config?.timeoutSeconds ?? 30
      });
      setTestResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsTesting(false);
    }
  }, [allowInsecureHttp, config?.timeoutSeconds, validate]);

  const onSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = readForm(form);
      setError(undefined);
      setTestResult(undefined);

      const problem = validate(values);
      if (problem) return setError(problem);
      if (!values.password && !config?.hasPassword)
        return setError("Enter the password for your WebDAV server.");

      setIsSaving(true);
      try {
        // Credentials go first: reconfiguring sync with a server URL whose
        // password has not been stored yet would only fail on the next cycle.
        if (values.password || values.passphrase) {
          await webDavStore.setCredentials({
            password: values.password || undefined,
            passphrase: values.passphrase || undefined
          });
        }
        await webDavStore.saveConfig({
          serverUrl: values.serverUrl,
          username: values.username,
          directory: values.directory,
          allowInsecureHttp
        });
        if (webDavStore.get().config?.enabled) {
          showToast("success", "WebDAV settings saved.");
        } else {
          // First time through: turn sync on and run the first cycle, which
          // is also what proves the credentials and the passphrase work.
          await webDavStore.connect();
          showToast("success", "Connected. Your notes are syncing now.");
        }

        // Secrets must not linger in the DOM once they are stored.
        for (const name of ["password", "passphrase", "confirmPassphrase"]) {
          const input = form.elements.namedItem(name);
          if (input instanceof HTMLInputElement) input.value = "";
        }
        onSaved?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setIsSaving(false);
      }
    },
    [allowInsecureHttp, config?.hasPassword, onSaved, validate]
  );

  const isBusy = isTesting || isSaving;

  return (
    <form
      ref={formRef}
      id="webdavConnectionForm"
      onSubmit={onSubmit}
      style={{ width: "100%" }}
      data-test-id="webdav-connection-form"
    >
      <Field
        id="webdav-serverUrl"
        name="serverUrl"
        label="Server URL"
        helpText="For example https://cloud.example.com/remote.php/dav/files/you"
        defaultValue={config?.serverUrl}
        placeholder="https://cloud.example.com/remote.php/dav/files/you"
        autoComplete="off"
        data-test-id="webdav-server-url"
      />
      <Field
        id="webdav-username"
        name="username"
        label="Username"
        defaultValue={config?.username}
        autoComplete="off"
        sx={{ mt: 2 }}
        data-test-id="webdav-username"
      />
      <Field
        id="webdav-password"
        name="password"
        type="password"
        label="Password or app password"
        helpText={
          config?.hasPassword
            ? "A password is already stored for this server. Leave this empty to keep it, or type a new one to replace it."
            : "Many servers can issue a dedicated app password — prefer one over your account password."
        }
        placeholder={config?.hasPassword ? "••••••••  (saved)" : undefined}
        autoComplete="new-password"
        sx={{ mt: 2 }}
        data-test-id="webdav-password"
      />
      <Field
        id="webdav-directory"
        name="directory"
        label="Remote directory"
        helpText="Folder on the server that holds the encrypted repository. It is created if it does not exist."
        defaultValue={config?.directory ?? "Openotes"}
        placeholder="Openotes"
        autoComplete="off"
        sx={{ mt: 2 }}
        data-test-id="webdav-directory"
      />

      <Text
        variant="subtitle"
        sx={{ mt: 4, display: "block", color: "heading" }}
      >
        Sync passphrase
      </Text>
      <Text variant="body" sx={{ color: "paragraph-secondary" }}>
        This passphrase encrypts your notes on this device before anything is
        uploaded — the server only ever stores ciphertext. Use the same
        passphrase on every device that syncs this repository.
      </Text>
      <ErrorText
        error={
          "There is no way to recover it. If you lose this passphrase, the data on the server can never be decrypted again — not by you, not by the server's owner, not by Openotes."
        }
        sx={{ mt: 1 }}
      />
      <Field
        id="webdav-passphrase"
        name="passphrase"
        type="password"
        label="Sync passphrase"
        placeholder={config?.hasPassword ? "unchanged" : undefined}
        helpText={
          config?.hasPassword
            ? "Leave both fields empty to keep the passphrase this device already uses."
            : undefined
        }
        autoComplete="new-password"
        sx={{ mt: 2 }}
        data-test-id="webdav-passphrase"
      />
      <Field
        id="webdav-confirmPassphrase"
        name="confirmPassphrase"
        type="password"
        label="Confirm sync passphrase"
        autoComplete="new-password"
        sx={{ mt: 1 }}
        data-test-id="webdav-confirm-passphrase"
      />

      {showInsecureHttpOption && (
        <Label
          sx={{ mt: 3, alignItems: "start", gap: 1, width: "auto" }}
          data-test-id="webdav-allow-http"
        >
          <Checkbox
            checked={allowInsecureHttp}
            onChange={(e) => setAllowInsecureHttp(e.currentTarget.checked)}
            sx={{ flexShrink: 0 }}
          />
          <Flex sx={{ flexDirection: "column" }}>
            <Text variant="body" sx={{ color: "heading" }}>
              Allow plain HTTP
            </Text>
            <Text variant="subBody">
              Off by default. Without TLS, anyone on the network can see and
              tamper with the traffic; your notes stay encrypted, but the
              server address, your username and the request pattern do not.
              Only turn this on for a server on a network you control.
            </Text>
          </Flex>
        </Label>
      )}

      {error && <ErrorText error={error} sx={{ mt: 2 }} />}
      {testResult && (
        <Text
          variant="body"
          sx={{ mt: 2, color: testResult.ok ? "accent" : "error" }}
          data-test-id="webdav-test-result"
        >
          {testResult.message}
        </Text>
      )}

      <Flex sx={{ mt: 3, gap: 1, alignItems: "center", flexWrap: "wrap" }}>
        <Button
          type="button"
          variant="secondary"
          disabled={isBusy}
          onClick={onTest}
          data-test-id="webdav-test-connection"
        >
          {isTesting ? (
            <Loading size={16} />
          ) : (
            strings.testConnection()
          )}
        </Button>
        <Button
          type="submit"
          variant="accent"
          disabled={isBusy}
          data-test-id="webdav-save"
        >
          {isSaving ? <Loading size={16} /> : submitText ?? strings.save()}
        </Button>
      </Flex>
    </form>
  );
}

/**
 * The connection form, held back until the stored configuration is in the
 * store so that the uncontrolled fields mount with the right values.
 */
export function WebDavConnectionForm(props: WebDavConnectionFormProps) {
  const isLoaded = useWebDavStore((store) => store.isLoaded);

  useEffect(() => {
    void webDavStore.refresh().catch(() => {
      /* the status line reports the failure */
    });
  }, []);

  if (!isLoaded)
    return (
      <Flex sx={{ alignItems: "center", gap: 1, my: 2 }}>
        <Loading size={16} />
        <Text variant="body">{strings.loading()}</Text>
      </Flex>
    );
  return <ConnectionFields {...props} />;
}

/**
 * What the Settings panel renders: the live status, then the form. Kept in
 * one custom component so the connection details stay visually together
 * instead of being split across five generic setting rows.
 */
export function WebDavConnectionPanel() {
  return (
    <Flex sx={{ flexDirection: "column", gap: 2, mt: 2, width: "100%" }}>
      <WebDavStatusPill />
      <WebDavConnectionForm />
    </Flex>
  );
}
