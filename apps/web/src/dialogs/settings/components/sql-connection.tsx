/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited
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

/**
 * Connecting a Postgres database: yours, or one Neon or Supabase creates.
 *
 * Three providers, one panel. Each has a "let Openotes create it" path
 * (Neon: API key; Supabase: sign in with your own OAuth app, or a personal
 * access token) and a "paste what you have" path (a connection string, or a
 * project URL and service key). Both end in the same place: a table in that
 * database holding ciphertext, and a passphrase that never leaves here.
 */

import { useCallback, useEffect, useState } from "react";
import { Button, Flex, Text } from "@theme-ui/components";
import Field from "../../../components/field";
import { ErrorText } from "../../../components/error-text";
import { showToast } from "../../../utils/toast";
import {
  store as webDavStore,
  useStore as useWebDavStore,
  type TestConnectionResult,
  type WebDavSyncStatus
} from "../../../stores/webdav-store";
import { desktopCall } from "../../../common/desktop-bridge/index.desktop";
import { WebDavStatusPill } from "../../../components/status-bar/webdav-sync-status";

type SqlSetup = {
  provider: "postgres" | "neon" | "supabase";
  label: string;
  summary: string;
  manual: { label: string; hint: string }[];
  provisions: boolean;
  accountNotes: string[];
  schemaSql: string;
  supabaseRegistrationNotes: string[];
};

type NeonAccount = {
  regions: { id: string; name: string; default: boolean }[];
  projects: { id: string; name: string; regionId: string }[];
};

type SupabaseAccountView = {
  organizations: { id: string; slug: string; name: string }[];
  projects: {
    id: string;
    ref: string;
    name: string;
    region: string;
    status: string;
    organizationSlug: string;
  }[];
};

const NEW_PROJECT = "__new__";

export function SqlConnectionPanel() {
  const config = useWebDavStore((store) => store.config);
  const provider = config?.provider;
  const [setup, setSetup] = useState<SqlSetup>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [result, setResult] = useState<TestConnectionResult>();

  // Shared inputs.
  const [directory, setDirectory] = useState("Openotes");
  const [passphrase, setPassphrase] = useState("");
  const [connectionString, setConnectionString] = useState("");
  const [supabaseUrl, setSupabaseUrl] = useState("");
  const [serviceKey, setServiceKey] = useState("");
  const [showManual, setShowManual] = useState(false);

  // Neon.
  const [neonKey, setNeonKey] = useState("");
  const [neon, setNeon] = useState<NeonAccount>();
  const [neonProject, setNeonProject] = useState(NEW_PROJECT);
  const [neonRegion, setNeonRegion] = useState("");
  const [projectName, setProjectName] = useState("openotes");

  // Supabase.
  const [supabaseClientId, setSupabaseClientId] = useState("");
  const [supabaseClientSecret, setSupabaseClientSecret] = useState("");
  const [supabaseToken, setSupabaseToken] = useState("");
  const [supabase, setSupabase] = useState<SupabaseAccountView>();
  const [supabaseProject, setSupabaseProject] = useState(NEW_PROJECT);
  const [supabaseOrg, setSupabaseOrg] = useState("");

  useEffect(() => {
    if (!provider || !["postgres", "neon", "supabase"].includes(provider))
      return;
    setError(undefined);
    setResult(undefined);
    setDirectory(config?.directory || "Openotes");
    setSupabaseUrl(config?.supabaseUrl ?? "");
    setSupabaseClientId(config?.clientId ?? "");
    setShowManual(provider === "postgres");
    desktopCall("webdav.sqlSetup", { provider })
      .then((value) => setSetup(value as SqlSetup))
      .catch((problem) =>
        setError(problem instanceof Error ? problem.message : String(problem))
      );
  }, [config?.clientId, config?.directory, config?.supabaseUrl, provider]);

  const run = useCallback(
    async (label: string, action: () => Promise<void>) => {
      setError(undefined);
      setBusy(label);
      try {
        await action();
      } catch (problem) {
        setError(problem instanceof Error ? problem.message : String(problem));
      } finally {
        setBusy(undefined);
      }
    },
    []
  );

  const needPassphrase = useCallback(() => {
    if (!config?.connected && !config?.hasPassword && !passphrase) {
      throw new Error(
        "Set a sync passphrase. It encrypts your notes before they reach " +
          "the database, and it is the one thing that cannot be recovered."
      );
    }
  }, [config?.connected, config?.hasPassword, passphrase]);

  const manualInput = useCallback(() => {
    if (provider === "supabase") {
      return {
        provider,
        supabaseUrl: supabaseUrl.trim(),
        supabaseServiceKey: serviceKey.trim() || undefined,
        directory: directory.trim() || "Openotes"
      };
    }
    return {
      provider,
      connectionString: connectionString.trim() || undefined,
      directory: directory.trim() || "Openotes",
      sqlTransport: provider === "neon" ? "http" : "socket"
    };
  }, [connectionString, directory, provider, serviceKey, supabaseUrl]);

  const finish = useCallback(
    async (message: string) => {
      await webDavStore.get().refresh();
      setPassphrase("");
      setConnectionString("");
      setServiceKey("");
      setNeonKey("");
      setSupabaseToken("");
      setSupabaseClientSecret("");
      showToast("success", message);
    },
    []
  );

  const test = () =>
    run("test", async () => {
      setResult(undefined);
      const outcome = (await desktopCall("webdav.testSql", {
        ...manualInput(),
        passphrase: passphrase || undefined
      })) as TestConnectionResult;
      setResult(outcome);
    });

  const connectManual = () =>
    run("connect", async () => {
      needPassphrase();
      (await desktopCall("webdav.connectSql", {
        ...manualInput(),
        passphrase: passphrase || undefined
      })) as { status: WebDavSyncStatus };
      await finish(`Connected. Your notes are syncing to ${setup?.label}.`);
    });

  const disconnect = () =>
    run("disconnect", async () => {
      await desktopCall("webdav.disconnectSql");
      await webDavStore.get().refresh();
      showToast("success", "Disconnected. The database was left untouched.");
    });

  const loadNeon = () =>
    run("neon", async () => {
      const account = (await desktopCall("webdav.neonAccount", {
        apiKey: neonKey.trim() || undefined
      })) as NeonAccount;
      setNeon(account);
      setNeonRegion(
        account.regions.find((r: { default: boolean }) => r.default)?.id ??
          account.regions[0]?.id ??
          ""
      );
    });

  const provisionNeon = () =>
    run("provision", async () => {
      needPassphrase();
      await desktopCall("webdav.provisionNeon", {
        apiKey: neonKey.trim() || undefined,
        projectId: neonProject === NEW_PROJECT ? undefined : neonProject,
        name: projectName,
        regionId: neonRegion || undefined,
        directory: directory.trim() || "Openotes",
        sqlTransport: "http",
        passphrase: passphrase || undefined
      });
      await finish("Connected. Your notes are syncing to Neon.");
    });

  const signInSupabase = () =>
    run("signin", async () => {
      showToast("success", "Finish signing in in your browser, then come back here.");
      await desktopCall("webdav.connectSupabaseAccount", {
        clientId: supabaseClientId.trim(),
        clientSecret: supabaseClientSecret.trim()
      });
      const account = (await desktopCall(
        "webdav.supabaseAccount",
        {}
      )) as SupabaseAccountView;
      setSupabase(account);
      setSupabaseOrg(account.organizations[0]?.slug ?? "");
    });

  const loadSupabase = () =>
    run("supabase", async () => {
      const account = (await desktopCall("webdav.supabaseAccount", {
        token: supabaseToken.trim() || undefined
      })) as SupabaseAccountView;
      setSupabase(account);
      setSupabaseOrg(account.organizations[0]?.slug ?? "");
    });

  const provisionSupabase = () =>
    run("provision", async () => {
      needPassphrase();
      await desktopCall("webdav.provisionSupabase", {
        ref: supabaseProject === NEW_PROJECT ? undefined : supabaseProject,
        name: projectName,
        organizationSlug: supabaseOrg || undefined,
        directory: directory.trim() || "Openotes",
        passphrase: passphrase || undefined
      });
      await finish("Connected. Your notes are syncing to Supabase.");
    });

  if (!setup) {
    return error ? <ErrorText error={error} /> : null;
  }

  const connected = !!config?.connected;
  const where = connected
    ? provider === "supabase"
      ? config?.supabaseUrl
      : `${config?.sqlUser ? `${config.sqlUser}@` : ""}${config?.sqlHost}/${config?.sqlDatabase}`
    : undefined;

  return (
    <Flex sx={{ flexDirection: "column", gap: 2, flex: 1 }}>
      {connected ? (
        <Flex sx={{ flexDirection: "column", gap: 1 }}>
          <Text variant="body">
            Connected to {setup.label}
            {config?.sqlProvenance
              ? ` — project “${config.sqlProvenance.projectName}”, created by Openotes`
              : ""}
            .
          </Text>
          <Text
            variant="subBody"
            sx={{ color: "paragraph-secondary", fontFamily: "monospace", wordBreak: "break-all" }}
          >
            {where}
          </Text>
          <Flex sx={{ gap: 1, alignItems: "center" }}>
            <Button variant="secondary" onClick={test} disabled={!!busy}>
              {busy === "test" ? "Testing…" : "Test connection"}
            </Button>
            <Button variant="errorSecondary" onClick={disconnect} disabled={!!busy}>
              Disconnect
            </Button>
            <WebDavStatusPill />
          </Flex>
          {result ? <Text variant="subBody">{result.message}</Text> : null}
          {error ? <ErrorText error={error} /> : null}
        </Flex>
      ) : (
        <>
          {setup.provisions ? (
            <Flex sx={{ flexDirection: "column", gap: 1 }}>
              <Text variant="subBody" sx={{ fontWeight: "bold" }}>
                Let Openotes create the database
              </Text>
              <Flex as="ol" sx={{ flexDirection: "column", gap: 1, pl: 3, m: 0 }}>
                {setup.accountNotes.map((note) => (
                  <Text as="li" key={note} variant="subBody">
                    {note}
                  </Text>
                ))}
              </Flex>

              {provider === "neon" ? (
                <>
                  <Field
                    id="neon-api-key"
                    label="Neon API key"
                    type="password"
                    value={neonKey}
                    onChange={(e) => setNeonKey(e.target.value)}
                    helpText="Kept encrypted so you are not asked again."
                  />
                  {!neon ? (
                    <Button variant="secondary" onClick={loadNeon} disabled={!!busy}>
                      {busy === "neon" ? "Checking…" : "Continue"}
                    </Button>
                  ) : (
                    <>
                      <ProjectChoice
                        label="Project"
                        value={neonProject}
                        onChange={setNeonProject}
                        options={neon.projects.map((p) => ({
                          value: p.id,
                          title: `${p.name} (${p.regionId})`
                        }))}
                      />
                      {neonProject === NEW_PROJECT ? (
                        <>
                          <Field
                            id="neon-project-name"
                            label="Project name"
                            value={projectName}
                            onChange={(e) => setProjectName(e.target.value)}
                          />
                          {neon.regions.length > 0 ? (
                            <Choice
                              label="Region"
                              value={neonRegion}
                              onChange={setNeonRegion}
                              options={neon.regions.map((r) => ({
                                value: r.id,
                                title: r.name
                              }))}
                            />
                          ) : null}
                        </>
                      ) : null}
                    </>
                  )}
                </>
              ) : null}

              {provider === "supabase" ? (
                <>
                  {!supabase ? (
                    <>
                      <Text variant="subBody" sx={{ fontWeight: "bold" }}>
                        Sign in with your own OAuth application
                      </Text>
                      <Flex as="ol" sx={{ flexDirection: "column", gap: 1, pl: 3, m: 0 }}>
                        {setup.supabaseRegistrationNotes.map((note) => (
                          <Text as="li" key={note} variant="subBody">
                            {note}
                          </Text>
                        ))}
                      </Flex>
                      <Field
                        id="supabase-client-id"
                        label="Client ID"
                        value={supabaseClientId}
                        onChange={(e) => setSupabaseClientId(e.target.value)}
                      />
                      <Field
                        id="supabase-client-secret"
                        label="Client secret"
                        type="password"
                        value={supabaseClientSecret}
                        onChange={(e) => setSupabaseClientSecret(e.target.value)}
                      />
                      <Button
                        variant="secondary"
                        onClick={signInSupabase}
                        disabled={!!busy || !supabaseClientId || !supabaseClientSecret}
                      >
                        {busy === "signin" ? "Waiting for the browser…" : "Sign in"}
                      </Button>
                      <Text variant="subBody" sx={{ fontWeight: "bold", mt: 1 }}>
                        Or use a personal access token
                      </Text>
                      <Field
                        id="supabase-token"
                        label="Personal access token"
                        type="password"
                        value={supabaseToken}
                        onChange={(e) => setSupabaseToken(e.target.value)}
                        helpText="From supabase.com/dashboard/account/tokens. Kept encrypted."
                      />
                      <Button variant="secondary" onClick={loadSupabase} disabled={!!busy}>
                        {busy === "supabase" ? "Checking…" : "Continue with the token"}
                      </Button>
                    </>
                  ) : (
                    <>
                      <ProjectChoice
                        label="Project"
                        value={supabaseProject}
                        onChange={setSupabaseProject}
                        options={supabase.projects.map((p) => ({
                          value: p.ref,
                          title: `${p.name} (${p.region}, ${p.status.toLowerCase()})`
                        }))}
                      />
                      {supabaseProject === NEW_PROJECT ? (
                        <>
                          <Field
                            id="supabase-project-name"
                            label="Project name"
                            value={projectName}
                            onChange={(e) => setProjectName(e.target.value)}
                          />
                          {supabase.organizations.length > 1 ? (
                            <Choice
                              label="Organisation"
                              value={supabaseOrg}
                              onChange={setSupabaseOrg}
                              options={supabase.organizations.map((o) => ({
                                value: o.slug,
                                title: o.name
                              }))}
                            />
                          ) : null}
                          <Text variant="subBody" sx={{ color: "paragraph-secondary" }}>
                            A new project takes a minute or two to start; this waits for it.
                          </Text>
                        </>
                      ) : null}
                    </>
                  )}
                </>
              ) : null}
            </Flex>
          ) : null}

          {setup.provisions ? (
            <Button
              variant="secondary"
              sx={{ alignSelf: "flex-start", fontSize: "subBody" }}
              onClick={() => setShowManual((v) => !v)}
            >
              {showManual ? "Hide the manual setup" : "I already have a database"}
            </Button>
          ) : null}

          {showManual ? (
            <Flex sx={{ flexDirection: "column", gap: 1 }}>
              {provider === "supabase" ? (
                <>
                  <Field
                    id="sql-supabase-url"
                    label={setup.manual[0].label}
                    helpText={setup.manual[0].hint}
                    value={supabaseUrl}
                    onChange={(e) => setSupabaseUrl(e.target.value)}
                  />
                  <Field
                    id="sql-service-key"
                    label={setup.manual[1].label}
                    helpText={setup.manual[1].hint}
                    type="password"
                    value={serviceKey}
                    onChange={(e) => setServiceKey(e.target.value)}
                  />
                  <Text variant="subBody" sx={{ color: "paragraph-secondary" }}>
                    Run this once in the project&apos;s SQL editor:
                  </Text>
                  <Text
                    as="pre"
                    variant="subBody"
                    sx={{ fontFamily: "monospace", whiteSpace: "pre-wrap", m: 0, p: 1, bg: "background-secondary", borderRadius: "default" }}
                  >
                    {setup.schemaSql}
                  </Text>
                </>
              ) : (
                <Field
                  id="sql-connection-string"
                  label={setup.manual[0].label}
                  helpText={setup.manual[0].hint}
                  type="password"
                  value={connectionString}
                  onChange={(e) => setConnectionString(e.target.value)}
                  autoComplete="off"
                />
              )}
            </Flex>
          ) : null}

          <Field
            id="sql-directory"
            label="Repository name"
            helpText="A prefix inside the table, so more than one repository can share a database."
            value={directory}
            onChange={(e) => setDirectory(e.target.value)}
          />
          <Field
            id="sql-passphrase"
            label="Sync passphrase"
            type="password"
            helpText={
              config?.hasPassword
                ? "Already set. Type a new one only to change it — every device must use the same."
                : "What encrypts your notes. It never leaves this machine, so the database cannot read them and cannot recover them."
            }
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoComplete="new-password"
          />

          {error ? <ErrorText error={error} /> : null}
          {result ? (
            <Text variant="subBody" sx={{ color: result.ok ? "accent" : "error" }}>
              {result.message}
            </Text>
          ) : null}

          <Flex sx={{ gap: 1, alignItems: "center", flexWrap: "wrap" }}>
            {provider === "neon" && neon && !showManual ? (
              <Button variant="accent" onClick={provisionNeon} disabled={!!busy}>
                {busy === "provision"
                  ? "Setting up…"
                  : neonProject === NEW_PROJECT
                  ? "Create the project and connect"
                  : "Connect to this project"}
              </Button>
            ) : null}
            {provider === "supabase" && supabase && !showManual ? (
              <Button variant="accent" onClick={provisionSupabase} disabled={!!busy}>
                {busy === "provision"
                  ? "Setting up… this can take a couple of minutes"
                  : supabaseProject === NEW_PROJECT
                  ? "Create the project and connect"
                  : "Set up this project and connect"}
              </Button>
            ) : null}
            {showManual ? (
              <>
                <Button variant="secondary" onClick={test} disabled={!!busy}>
                  {busy === "test" ? "Testing…" : "Test connection"}
                </Button>
                <Button variant="accent" onClick={connectManual} disabled={!!busy}>
                  {busy === "connect" ? "Connecting…" : "Connect"}
                </Button>
              </>
            ) : null}
            <WebDavStatusPill />
          </Flex>
        </>
      )}
    </Flex>
  );
}

function Choice(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; title: string }[];
}) {
  return (
    <Flex sx={{ flexDirection: "column", gap: "2px" }}>
      <Text variant="subBody">{props.label}</Text>
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        style={{ fontSize: "inherit", fontFamily: "inherit", padding: "4px" }}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.title}
          </option>
        ))}
      </select>
    </Flex>
  );
}

function ProjectChoice(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; title: string }[];
}) {
  return (
    <Choice
      {...props}
      options={[{ value: NEW_PROJECT, title: "Create a new project" }, ...props.options]}
    />
  );
}
