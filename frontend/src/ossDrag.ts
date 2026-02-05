export const OSS_OBJECTS_DRAG_TYPE = 'application/x-walioss-oss-objects';

export type OssDragItem = {
  path: string;
  name: string;
  isFolder: boolean;
};

export type OssDragPayload = {
  type: 'walioss-oss-objects';
  source?: { bucket: string; prefix: string };
  items: OssDragItem[];
};

export const canReadOssDragPayload = (dt: DataTransfer | null | undefined) => {
  if (!dt) return false;
  try {
    return Array.from(dt.types || []).includes(OSS_OBJECTS_DRAG_TYPE);
  } catch {
    return false;
  }
};

export const readOssDragPayload = (dt: DataTransfer | null | undefined): OssDragPayload | null => {
  if (!dt) return null;
  let raw = '';
  try {
    raw = dt.getData(OSS_OBJECTS_DRAG_TYPE);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as OssDragPayload;
    if (!parsed || parsed.type !== 'walioss-oss-objects') return null;
    if (!Array.isArray(parsed.items)) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const writeOssDragPayload = (dt: DataTransfer | null | undefined, payload: OssDragPayload) => {
  if (!dt) return;
  dt.setData(OSS_OBJECTS_DRAG_TYPE, JSON.stringify(payload));

  const paths = payload.items
    .map((item) => item.path)
    .filter((p) => typeof p === 'string' && p.trim())
    .join('\n');
  if (paths) {
    dt.setData('text/plain', paths);
  }
};

