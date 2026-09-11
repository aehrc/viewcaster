/*
 * Copyright © 2026, Commonwealth Scientific and Industrial Research
 * Organisation (CSIRO) ABN 41 687 119 230.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy
 * of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations
 * under the License.
 *
 * @author John Grimes
 */

/**
 * Unit tests for loader connection configuration:
 * EZConnect string assembly, `ORACLE_*` environment fallbacks, the
 * `--connect-string` override, and missing-credential errors. These exercise
 * the pure configuration logic without opening a database connection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildConnectString, getDatabaseConfigFromEnv } from "./connection.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildConnectString", () => {
  it("assembles an EZConnect string from host, port and service name", () => {
    expect(
      buildConnectString({
        host: "db.example.com",
        port: 1521,
        serviceName: "ORCLPDB1",
      }),
    ).toBe("db.example.com:1521/ORCLPDB1");
  });

  it("applies the documented defaults for host, port and service name", () => {
    // Host defaults to localhost, port to 1521 and the
    // service name to FREEPDB1.
    expect(buildConnectString({})).toBe("localhost:1521/FREEPDB1");
  });

  it("uses an explicit connect string in preference to host/port/service-name", () => {
    expect(
      buildConnectString({
        host: "ignored.example.com",
        port: 1521,
        serviceName: "IGNORED",
        connectString: "tns-alias.example.com:1521/OTHER",
      }),
    ).toBe("tns-alias.example.com:1521/OTHER");
  });
});

describe("getDatabaseConfigFromEnv", () => {
  // The environment variables this configuration reads. Cleared before each
  // test so the assertions observe only what they set themselves, regardless
  // of the environment the suite runs in, and restored afterwards.
  const oracleEnvNames = [
    "ORACLE_HOST",
    "ORACLE_PORT",
    "ORACLE_SERVICE_NAME",
    "ORACLE_USER",
    "ORACLE_PASSWORD",
    "ORACLE_CONNECT_STRING",
    "ORACLE_RESOURCE_JSON_DATA_TYPE",
  ];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(
      oracleEnvNames.map((name) => [name, process.env[name]]),
    );
    for (const name of oracleEnvNames) delete process.env[name];
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("falls back to ORACLE_* environment variables", () => {
    vi.stubEnv("ORACLE_HOST", "envhost.example.com");
    vi.stubEnv("ORACLE_PORT", "1522");
    vi.stubEnv("ORACLE_SERVICE_NAME", "ENVPDB1");
    vi.stubEnv("ORACLE_USER", "env_user");
    vi.stubEnv("ORACLE_PASSWORD", "envpassword");

    const config = getDatabaseConfigFromEnv();
    expect(config.host).toBe("envhost.example.com");
    expect(config.port).toBe(1522);
    expect(config.serviceName).toBe("ENVPDB1");
    expect(config.user).toBe("env_user");
    expect(config.password).toBe("envpassword");
  });

  it("prefers explicit overrides over environment variables", () => {
    vi.stubEnv("ORACLE_HOST", "envhost.example.com");
    vi.stubEnv("ORACLE_USER", "envuser");
    vi.stubEnv("ORACLE_PASSWORD", "envpassword");

    const config = getDatabaseConfigFromEnv({
      host: "flaghost.example.com",
      port: 1523,
      serviceName: "FLAGPDB1",
      user: "flaguser",
      password: "flagpassword",
    });
    expect(config.host).toBe("flaghost.example.com");
    expect(config.port).toBe(1523);
    expect(config.serviceName).toBe("FLAGPDB1");
    expect(config.user).toBe("flaguser");
    expect(config.password).toBe("flagpassword");
  });

  it("applies the documented defaults when neither flags nor environment are set", () => {
    const config = getDatabaseConfigFromEnv({
      user: "someone",
      password: "secret",
    });
    expect(config.host).toBe("localhost");
    expect(config.port).toBe(1521);
    expect(config.serviceName).toBe("FREEPDB1");
  });

  it("throws when no user is available from flags or environment", () => {
    expect(() => getDatabaseConfigFromEnv({ password: "secret" })).toThrow(
      /ORACLE_USER/,
    );
  });

  it("throws when no password is available from flags or environment", () => {
    expect(() => getDatabaseConfigFromEnv({ user: "someone" })).toThrow(
      /ORACLE_PASSWORD/,
    );
  });

  it("keeps an explicit connect string intact for the pool configuration", () => {
    vi.stubEnv("ORACLE_CONNECT_STRING", "my-tns-alias");
    const config = getDatabaseConfigFromEnv({
      user: "someone",
      password: "secret",
    });
    expect(config.connectString).toBe("my-tns-alias");
  });
});
