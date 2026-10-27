import "dotenv/config";
import { createHmac, randomBytes } from "node:crypto";

const deviceId = process.env.RING_DEVICE_ID ?? "ava1.ring.device.example";
const accountId = process.env.RING_ACCOUNT_ID ?? "ava1.ring.account.example";

const serverUrl = process.env.MASTRA_SERVER_URL ?? "http://localhost:4111";

export const sendRingEvent = async (type: string, idSuffix: string, subType?: string) => {
  const timestamp = Date.now();

  const rawBody = JSON.stringify({
    meta: {
      version: "1.1",
      time: new Date(timestamp).toISOString(),
      request_id: randomBytes(16).toString("hex"),
      account_id: accountId,
    },
    data: {
      id: `${deviceId}_${idSuffix}_${timestamp}`,
      type,
      attributes: {
        source: deviceId,
        source_type: "devices",
        timestamp,
        ...(subType ? { sub_type: subType } : {}),
      },
      relationships: {
        devices: { links: { self: `/v1/devices/${deviceId}` } },
      },
    },
  });

  const signature = `sha256=${createHmac("sha256", process.env.RING_HMAC_KEY!).update(rawBody).digest("hex")}`;

  const response = await fetch(`${serverUrl}/ring/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Signature": signature },
    body: rawBody,
  });

  console.log(serverUrl, type, response.status);
  console.log(JSON.stringify(await response.json(), null, 2));
};
