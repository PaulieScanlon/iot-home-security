import { sendRingEvent } from "./send-ring-event";

const recordedTimestamp = process.env.RING_BUTTON_PRESS_TIMESTAMP ? Number(process.env.RING_BUTTON_PRESS_TIMESTAMP) : undefined;

await sendRingEvent("button_press", "ding", undefined, recordedTimestamp);
