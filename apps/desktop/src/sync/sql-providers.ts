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
 * A Postgres database as the place notes sync to, and the two hosts that
 * will create one on request.
 *
 * Three providers share one storage (packages/sync-sql):
 *
 *   postgres   A database the user already has. They paste a connection
 *              string; the table is created on first connect.
 *   neon       Neon hosts Postgres with a free tier and an HTTP endpoint for
 *              SQL. An API key from the Neon console lets Openotes create a
 *              project, read its connection string and set the table up --
 *              or use a project that already exists. Neon's OAuth is offered
 *              to commercial partners only, so an API key is the sign-in.
 *   supabase   Supabase hosts Postgres too, reached through its REST API.
 *              Its OAuth is open to anyone who registers an application, so
 *              signing in works the way the drives do (your own client id),
 *              and a personal access token is the shortcut. Openotes creates
 *              a project, waits for it, runs the schema through the
 *              management API and keeps the service key.
 *
 * What the database sees is what a WebDAV server sees: ciphertext under
 * opaque paths. The passphrase never leaves the device.
 */

import {
  describeConnection,
  ensureSchema,
  NeonHttpExecutor,
  SCHEMA_SQL,
  SqlRemoteStorage,
  supabaseProjectRef,
  SupabaseRestStorage,
} from "@notesnook/sync-sql";
import { PostgresExecutor } from "@notesnook/sync-sql/postgres";
import {
  PrefixedRemoteStorage,
  type RemoteStorage,
  SyncError,
} from "@notesnook/sync-core";
import type { OAuthClient, OAuthTokens } from "../security/oauth.ts";
import type {
  SqlProvenance,
  SyncProvider,
  WebDavSettings,
} from "../native/settings.ts";
import { logger } from "../native/logger.ts";

const log = logger.scope("sql");

export type SqlProvider = "postgres" | "neon" | "supabase";

export const SQL_PROVIDERS: readonly SqlProvider[] = [
  "postgres",
  "neon",
  "supabase",
];

export function isSqlProvider(value: unknown): value is SqlProvider {
  return SQL_PROVIDERS.includes(value as SqlProvider);
}

/** Credential-store keys. Everything secret about a SQL provider lives here. */
export const SQL_CREDENTIALS = {
  /** postgres, neon: the full connection string, password included. */
  connectionString: "sql.connectionString",
  /** supabase: the project's service key. */
  supabaseServiceKey: "supabase.serviceKey",
  /** neon: the API key used to create and list projects. */
  neonApiKey: "neon.apiKey",
  /** supabase: OAuth tokens (JSON) or a personal access token. */
  supabaseAccount: "supabase.account",
  /** supabase: the client secret of the user's own OAuth application. */
  supabaseClientSecret: "supabase.clientSecret",
} as const;

export interface SqlProviderDescription {
  provider: SqlProvider;
  label: string;
  /** One line for the picker. */
  summary: string;
  /** What the user pastes, when they set it up by hand. */
  manual: { label: string; hint: string }[];
  /** Whether Openotes can create the database for them. */
  provisions: boolean;
  /** How to get the token that lets it. */
  accountNotes: string[];
  /** The SQL a person can run themselves instead. */
  schemaSql: string;
}

export function describeSqlProvider(
  provider: SqlProvider,
): SqlProviderDescription {
  switch (provider) {
    case "postgres":
      return {
        provider,
        label: "PostgreSQL",
        summary: "A Postgres database you run or rent.",
        manual: [{
          label: "Connection string",
          hint:
            "postgresql://user:password@host:5432/database — the table is " +
            "created for you on the first connection.",
        }],
        provisions: false,
        accountNotes: [],
        schemaSql: SCHEMA_SQL,
      };
    case "neon":
      return {
        provider,
        label: "Neon",
        summary: "Hosted Postgres with a free tier. Openotes can create the " +
          "project for you.",
        manual: [{
          label: "Connection string",
          hint: "From the Neon console: Connect → copy the connection string.",
        }],
        provisions: true,
        accountNotes: [
          "Neon console → Account settings → API keys → Create new API key.",
          "Paste it below. Openotes uses it to create a project (or list " +
          "yours), read the connection string and create the table. It " +
          "is stored encrypted with your other sync credentials.",
          "Neon's OAuth sign-in is available to commercial partners only, " +
          "which is why this asks for a key rather than opening a browser.",
        ],
        schemaSql: SCHEMA_SQL,
      };
    case "supabase":
      return {
        provider,
        label: "Supabase",
        summary: "Hosted Postgres with a free tier. Openotes can create the " +
          "project for you.",
        manual: [
          {
            label: "Project URL",
            hint:
              "https://<project-ref>.supabase.co, from Project settings → API.",
          },
          {
            label: "Service key",
            hint:
              "The service_role (or a secret) key from Project settings → " +
              "API keys. Not the anon key: it cannot reach this table.",
          },
        ],
        provisions: true,
        accountNotes: [
          "Either sign in: register an OAuth app at Supabase → Organization " +
          "settings → OAuth Apps, with the redirect URI shown below, and " +
          "paste its client ID and secret.",
          "Or paste a personal access token from " +
          "supabase.com/dashboard/account/tokens.",
          "Openotes then creates a project (or uses one of yours), creates " +
          "the table through the management API and keeps the project's " +
          "service key encrypted with your other sync credentials.",
        ],
        schemaSql: SCHEMA_SQL,
      };
  }
}

// ---------------------------------------------------------------------------
// The storage the engine writes through
// ---------------------------------------------------------------------------

export interface SqlSecrets {
  connectionString?: string;
  supabaseServiceKey?: string;
}

/**
 * Build the storage for the configured SQL provider.
 *
 * The repository lives under `directory` inside the one table, so a second
 * repository can share the database -- the same thing a WebDAV directory or
 * a drive folder does.
 */
export function sqlStorage(
  config: Pick<
    WebDavSettings,
    "provider" | "directory" | "sqlTransport" | "supabaseUrl" | "timeoutSeconds"
  >,
  secrets: SqlSecrets,
  fetchFn: typeof fetch = fetch,
): { storage: RemoteStorage; close(): Promise<void> } {
  const prefix = config.directory.replace(/^\/+|\/+$/g, "") || "Openotes";
  let inner: RemoteStorage;
  let close: () => Promise<void> = () => Promise.resolve();

  switch (config.provider) {
    case "supabase": {
      if (!config.supabaseUrl || !secrets.supabaseServiceKey) {
        throw new SyncError(
          "Supabase is not connected. Sign in or paste the project URL and " +
            "service key in Settings → Synchronization.",
          "unauthorized",
        );
      }
      inner = new SupabaseRestStorage(
        config.supabaseUrl,
        secrets.supabaseServiceKey,
        fetchFn,
      );
      break;
    }
    case "neon":
    case "postgres": {
      if (!secrets.connectionString) {
        throw new SyncError(
          "The database connection string is not available. Unlock the " +
            "vault, or connect again in Settings → Synchronization.",
          "unauthorized",
        );
      }
      if (config.provider === "neon" && config.sqlTransport === "http") {
        inner = new SqlRemoteStorage(
          new NeonHttpExecutor(secrets.connectionString, fetchFn),
        );
      } else {
        const executor = new PostgresExecutor(secrets.connectionString, {
          timeoutSeconds: config.timeoutSeconds,
        });
        inner = new SqlRemoteStorage(executor);
        close = () => executor.close();
      }
      break;
    }
    default:
      throw new SyncError(
        `${config.provider} is not a SQL provider`,
        "corrupt-data",
      );
  }
  return { storage: new PrefixedRemoteStorage(inner, prefix), close };
}

/**
 * Make sure the table exists, for the providers that let a client run DDL.
 * Supabase's REST API cannot; there the schema is created at provisioning
 * time through the management API, or by the user in the SQL editor.
 */
export async function prepareSqlDatabase(
  provider: SqlProvider,
  connectionString: string,
  transport: "socket" | "http",
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (provider === "supabase") return;
  if (provider === "neon" && transport === "http") {
    await ensureSchema(new NeonHttpExecutor(connectionString, fetchFn));
    return;
  }
  const executor = new PostgresExecutor(connectionString);
  try {
    await ensureSchema(executor);
  } finally {
    await executor.close();
  }
}

/** The non-secret summary that goes into settings. */
export function sqlSummary(
  connectionString: string,
): Pick<WebDavSettings, "sqlHost" | "sqlDatabase" | "sqlUser"> {
  const summary = describeConnection(connectionString);
  return {
    sqlHost: summary.host,
    sqlDatabase: summary.database,
    sqlUser: summary.user,
  };
}

// ---------------------------------------------------------------------------
// Neon
// ---------------------------------------------------------------------------

const NEON_API = "https://console.neon.tech/api/v2";

export interface NeonRegion {
  id: string;
  name: string;
  default: boolean;
}

export interface NeonProjectSummary {
  id: string;
  name: string;
  regionId: string;
  createdAt: string;
}

/** Talks to the Neon API with one API key. */
export class NeonAccount {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly base = NEON_API,
  ) {}

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.apiKey}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new SyncError(
        `Could not reach Neon: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "network",
      );
    }
    const text = await response.text();
    const payload = text ? safeJson(text) : undefined;
    if (response.status === 401 || response.status === 403) {
      throw new SyncError(
        "Neon refused the API key. Create a new one in the Neon console " +
          "under Account settings → API keys.",
        "unauthorized",
        response.status,
      );
    }
    if (!response.ok) {
      const message = (payload as { message?: string } | undefined)?.message;
      throw new SyncError(
        `Neon answered HTTP ${response.status}${message ? `: ${message}` : ""}`,
        response.status >= 500 ? "server-error" : "network",
        response.status,
      );
    }
    return payload as T;
  }

  async regions(): Promise<NeonRegion[]> {
    const payload = await this.call<{
      regions?: { region_id: string; name: string; default?: boolean }[];
    }>("GET", "/regions");
    return (payload.regions ?? []).map((region) => ({
      id: region.region_id,
      name: region.name,
      default: region.default === true,
    }));
  }

  async projects(): Promise<NeonProjectSummary[]> {
    const payload = await this.call<{
      projects?: {
        id: string;
        name: string;
        region_id: string;
        created_at: string;
      }[];
    }>("GET", "/projects?limit=100");
    return (payload.projects ?? []).map((project) => ({
      id: project.id,
      name: project.name,
      regionId: project.region_id,
      createdAt: project.created_at,
    }));
  }

  /**
   * Create a project and return its connection string.
   *
   * The response of a create carries the connection URI directly, with the
   * generated role password inside it -- the one moment Neon hands that
   * out, which is why it goes straight into the credential store.
   */
  async createProject(options: {
    name: string;
    regionId?: string;
  }): Promise<{ project: NeonProjectSummary; connectionString: string }> {
    const payload = await this.call<{
      project: {
        id: string;
        name: string;
        region_id: string;
        created_at: string;
      };
      connection_uris?: { connection_uri: string }[];
    }>("POST", "/projects", {
      project: {
        name: options.name,
        ...(options.regionId ? { region_id: options.regionId } : {}),
      },
    });
    const uri = payload.connection_uris?.[0]?.connection_uri;
    if (!uri) {
      throw new SyncError(
        "Neon created the project but returned no connection string.",
        "server-error",
      );
    }
    return {
      project: {
        id: payload.project.id,
        name: payload.project.name,
        regionId: payload.project.region_id,
        createdAt: payload.project.created_at,
      },
      connectionString: uri,
    };
  }

  /**
   * The connection string of an existing project's default branch, for its
   * first database and that database's owner role. Three calls, because the
   * URI endpoint wants the names and a project can have several of each.
   */
  async connectionString(projectId: string): Promise<string> {
    const branches = await this.call<{
      branches?: { id: string; default?: boolean; primary?: boolean }[];
    }>("GET", `/projects/${encodeURIComponent(projectId)}/branches`);
    const branch = branches.branches?.find((b) => b.default || b.primary) ??
      branches.branches?.[0];
    if (!branch) {
      throw new SyncError("That Neon project has no branches.", "not-found");
    }
    const databases = await this.call<{
      databases?: { name: string; owner_name: string }[];
    }>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/branches/${
        encodeURIComponent(branch.id)
      }/databases`,
    );
    const database = databases.databases?.[0];
    if (!database) {
      throw new SyncError("That Neon project has no database.", "not-found");
    }
    const uri = await this.call<{ uri: string }>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/connection_uri?` +
        new URLSearchParams({
          branch_id: branch.id,
          database_name: database.name,
          role_name: database.owner_name,
        }).toString(),
    );
    if (!uri.uri) {
      throw new SyncError(
        "Neon returned no connection string for that project.",
        "server-error",
      );
    }
    return uri.uri;
  }
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

const SUPABASE_API = "https://api.supabase.com/v1";
const SUPABASE_CALLBACK_PATH = "/openotes/oauth";

/** The OAuth client for the application the user registered with Supabase. */
export function supabaseOAuthClient(
  credentials: { clientId: string; clientSecret: string },
): OAuthClient {
  return {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    authorizeUrl: "https://api.supabase.com/v1/oauth/authorize",
    tokenUrl: "https://api.supabase.com/v1/oauth/token",
    // Supabase has no scopes: an app sees whatever the user's organisation
    // grants it on the consent screen.
    scopes: [],
    tokenAuth: "basic",
  };
}

export const SUPABASE_REGISTRATION_NOTES: string[] = [
  "Supabase dashboard → Organization settings → OAuth Apps → Add application.",
  `Authorized redirect URI: http://localhost${SUPABASE_CALLBACK_PATH} — the port changes each time, which Supabase allows for loopback.`,
  "Copy the client ID and the client secret.",
];

/** Stored account: OAuth tokens from a sign-in, or a personal access token. */
export type SupabaseAccount =
  | { kind: "oauth"; tokens: OAuthTokens }
  | { kind: "token"; token: string };

export interface SupabaseOrganization {
  id: string;
  slug: string;
  name: string;
}

export interface SupabaseProjectSummary {
  id: string;
  ref: string;
  name: string;
  region: string;
  status: string;
  organizationSlug: string;
}

const PROJECT_READY = "ACTIVE_HEALTHY";
const PROJECT_FAILED = new Set(["INIT_FAILED", "REMOVED", "RESTORE_FAILED"]);

/** Talks to the Supabase management API for one account. */
export class SupabaseManagement {
  constructor(
    private readonly accessToken: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly base = SUPABASE_API,
    /** How long to wait between status polls; tests shorten it. */
    private readonly pollMs = 5000,
  ) {}

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.accessToken}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new SyncError(
        `Could not reach Supabase: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "network",
      );
    }
    const text = await response.text();
    const payload = text ? safeJson(text) : undefined;
    if (response.status === 401 || response.status === 403) {
      throw new SyncError(
        "Supabase refused the access token. Sign in again, or create a new " +
          "personal access token.",
        "unauthorized",
        response.status,
      );
    }
    if (!response.ok) {
      const message = (payload as { message?: string } | undefined)?.message;
      throw new SyncError(
        `Supabase answered HTTP ${response.status}${
          message ? `: ${message}` : ""
        }`,
        response.status >= 500 ? "server-error" : "network",
        response.status,
      );
    }
    return payload as T;
  }

  async organizations(): Promise<SupabaseOrganization[]> {
    const payload = await this.call<
      { id: string; slug: string; name: string }[]
    >("GET", "/organizations");
    return (payload ?? []).map((org) => ({
      id: org.id,
      slug: org.slug,
      name: org.name,
    }));
  }

  async projects(): Promise<SupabaseProjectSummary[]> {
    const payload = await this.call<
      {
        id: string;
        ref: string;
        name: string;
        region: string;
        status: string;
        organization_slug: string;
      }[]
    >("GET", "/projects");
    return (payload ?? []).map(toProjectSummary);
  }

  async project(ref: string): Promise<SupabaseProjectSummary> {
    const payload = await this.call<{
      id: string;
      ref: string;
      name: string;
      region: string;
      status: string;
      organization_slug: string;
    }>("GET", `/projects/${encodeURIComponent(ref)}`);
    return toProjectSummary(payload);
  }

  /**
   * Create a project. The database password is generated here and never
   * needed again: the sync path uses the service key, and the management
   * API runs the schema. It is returned so the caller can keep it beside
   * the other secrets for the user's own use.
   */
  async createProject(options: {
    name: string;
    organizationSlug: string;
    region?: string;
  }): Promise<{ project: SupabaseProjectSummary; databasePassword: string }> {
    const databasePassword = randomPassword();
    const payload = await this.call<{
      id: string;
      ref: string;
      name: string;
      region: string;
      status: string;
      organization_slug: string;
    }>("POST", "/projects", {
      name: options.name,
      organization_slug: options.organizationSlug,
      db_pass: databasePassword,
      region: options.region ?? "us-east-1",
    });
    return { project: toProjectSummary(payload), databasePassword };
  }

  /** Wait for a new project to come up. Supabase takes a minute or two. */
  async waitUntilReady(
    ref: string,
    timeoutMs = 6 * 60_000,
    onStatus?: (status: string) => void,
  ): Promise<void> {
    const started = Date.now();
    for (;;) {
      const project = await this.project(ref);
      onStatus?.(project.status);
      if (project.status === PROJECT_READY) return;
      if (PROJECT_FAILED.has(project.status)) {
        throw new SyncError(
          `Supabase could not start the project (${project.status}).`,
          "server-error",
        );
      }
      if (Date.now() - started > timeoutMs) {
        throw new SyncError(
          `The Supabase project is still ${project.status} after ` +
            `${Math.round(timeoutMs / 60_000)} minutes. Try connecting again ` +
            `in a little while.`,
          "timeout",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  /** Run SQL as the project owner, through the management API. */
  async runSql(ref: string, query: string): Promise<void> {
    await this.call(
      "POST",
      `/projects/${encodeURIComponent(ref)}/database/query`,
      {
        query,
      },
    );
  }

  /**
   * The key that can reach the table: `service_role`, or a secret key on
   * projects created after the legacy keys were retired. Never the anon or
   * publishable key -- row-level security is on precisely so those cannot.
   */
  async serviceKey(ref: string): Promise<string> {
    const keys = await this.call<
      { name: string; api_key?: string; type?: string | null }[]
    >("GET", `/projects/${encodeURIComponent(ref)}/api-keys?reveal=true`);
    const service = keys.find((k) => k.name === "service_role" && k.api_key) ??
      keys.find((k) => k.type === "secret" && k.api_key);
    if (service?.api_key) return service.api_key;

    // No secret key exists yet: create one. Only allowed on projects that
    // have moved to the new key system, which is exactly when the legacy
    // service_role is absent.
    const created = await this.call<{ api_key?: string }>(
      "POST",
      `/projects/${encodeURIComponent(ref)}/api-keys?reveal=true`,
      { type: "secret", name: "openotes_sync", description: "Openotes sync" },
    );
    if (!created.api_key) {
      throw new SyncError(
        "Supabase returned no service key for the project.",
        "server-error",
      );
    }
    return created.api_key;
  }
}

function toProjectSummary(payload: {
  id: string;
  ref: string;
  name: string;
  region: string;
  status: string;
  organization_slug: string;
}): SupabaseProjectSummary {
  return {
    id: payload.id,
    ref: payload.ref,
    name: payload.name,
    region: payload.region,
    status: payload.status,
    organizationSlug: payload.organization_slug,
  };
}

export function supabaseProjectUrl(ref: string): string {
  if (!/^[a-z]{20}$/.test(ref)) {
    throw new SyncError(
      `"${ref}" is not a Supabase project ref`,
      "corrupt-data",
    );
  }
  return `https://${ref}.supabase.co`;
}

/**
 * Set a Supabase project up for sync: the table, then the key that reaches
 * it. Idempotent -- the schema is IF NOT EXISTS and the key is looked up
 * before one is made.
 */
export async function provisionSupabaseProject(
  management: SupabaseManagement,
  ref: string,
): Promise<{ url: string; serviceKey: string }> {
  await management.runSql(ref, SCHEMA_SQL);
  const serviceKey = await management.serviceKey(ref);
  const url = supabaseProjectUrl(ref);
  // Prove the key reaches the table before anything is saved.
  await new SupabaseRestStorage(url, serviceKey).probe();
  return { url, serviceKey };
}

export function provenanceOf(
  provider: "neon" | "supabase",
  project: { id: string; name: string; region?: string },
): SqlProvenance {
  log.info("Database provisioned", { provider, project: project.id });
  return {
    projectId: project.id,
    projectName: project.name,
    region: project.region,
    createdAt: Date.now(),
  };
}

export function isSupabaseUrl(value: string): boolean {
  return supabaseProjectRef(value) !== undefined;
}

export function providerLabel(provider: SyncProvider): string {
  return isSqlProvider(provider)
    ? describeSqlProvider(provider).label
    : provider;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** A database password nobody needs to remember: 32 URL-safe characters. */
function randomPassword(): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}
