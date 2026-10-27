import { sendRingEvent } from "./send-ring-event";

const motionType = process.argv[2] ?? "human";

await sendRingEvent("motion_detected", motionType, motionType);
