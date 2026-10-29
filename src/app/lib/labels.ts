const platformNames: Record<string, string> = {
  imessage: "iMessage",
  slack: "Slack",
  discord: "Discord",
  telegram: "Telegram",
  teams: "Teams",
  whatsapp: "WhatsApp"
};

export const platformName = (platform: string | undefined) => {
  if (!platform) {
    return "Channel";
  }
  return platformNames[platform] ?? platform;
};

const ringKinds: Record<string, string> = {
  button_press: "Doorbell",
  motion_detected: "Motion",
  device_online: "Online",
  device_offline: "Offline"
};

export const ringKindName = (kind: string | undefined) => {
  if (!kind) {
    return "Event";
  }
  return ringKinds[kind] ?? kind;
};

export const formatTime = (value: string | undefined) => {
  if (!value) {
    return "";
  }
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

export const formatDay = (value: string | undefined) => {
  if (!value) {
    return "";
  }
  return new Date(value).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
};

export const dayLabel = (value: string | undefined) => {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (date.toDateString() === today.toDateString()) {
    return "Today";
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return "Yesterday";
  }
  return date.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
};
