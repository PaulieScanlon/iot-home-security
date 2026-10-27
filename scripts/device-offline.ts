import { sendRingEvent } from "./send-ring-event";

for (let count = 1; count <= 5; count++) {
  await sendRingEvent("device_offline", "device_offline");
}
