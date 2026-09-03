// Wires `wyzr devices list` together: WyzeAuthSession (login + getObjectList)
// + this module's own allowlist projection (src/devices.ts) + src/output.ts.
// Written against WyzeTransport/Credentials only, never against a concrete
// implementation, so runDevicesList() is fully exercisable with
// FakeWyzeTransport and fixture credentials — zero credentials file, zero
// network — per the ticket's requirement. src/cli.ts's real dispatch is the
// only place that supplies RealWyzeTransport and loadCredentials().

import { WyzeAuthSession } from "./auth-session.ts";
import type { Credentials } from "./credentials.ts";
import { DEVICE_LIST_SCHEMA_VERSION, formatDeviceListHuman, projectDeviceList } from "./devices.ts";
import { ExitCode } from "./errors.ts";
import { printHuman, printJson } from "./output.ts";
import type { WyzeTransport } from "./transport.ts";

export interface DevicesListDeps {
  transport: WyzeTransport;
  credentials: Credentials;
}

/** `--json` shape: `{ schemaVersion, devices: DeviceRecord[] }` — see
 * README's "--json contract" section for the field-by-field documentation
 * this shape must match. */
export async function runDevicesList(deps: DevicesListDeps, json: boolean): Promise<number> {
  const session = new WyzeAuthSession({ transport: deps.transport, credentials: deps.credentials });
  await session.login();
  const raw = await session.getObjectList();
  const devices = projectDeviceList(raw);

  if (json) {
    printJson({ schemaVersion: DEVICE_LIST_SCHEMA_VERSION, devices });
  } else {
    printHuman(formatDeviceListHuman(devices));
  }
  return ExitCode.Ok;
}
