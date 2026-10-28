import { sendRingEvent } from "./send-ring-event";

const motionType = process.argv[2] ?? "human";
const recordedTimestamp = process.env.RING_MOTION_TIMESTAMP ? Number(process.env.RING_MOTION_TIMESTAMP) : undefined;

await sendRingEvent("motion_detected", motionType, motionType, recordedTimestamp);
