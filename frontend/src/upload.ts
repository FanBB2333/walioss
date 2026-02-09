import { main } from '../wailsjs/go/models';

export type UploadRootSpec = {
  localPath: string;
  remoteName?: string;
};

type UploadNameCollision = {
  name: string;
  fileExists: boolean;
  folderExists: boolean;
};

function normalizeUploadPrefix(prefix: string) {
  let p = (prefix || '').trim().replace(/^\/+/, '');
  if (!p) return '';
  if (!p.endsWith('/')) p += '/';
  return p;
}

function baseNameFromPath(inputPath: string) {
  let p = (inputPath || '').trim();
  p = p.replace(/[\\/]+$/, '');
  if (!p) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

function withRenameSuffix(name: string, index: number) {
  const trimmed = (name || '').trim();
  if (!trimmed) return '';
  const dot = trimmed.lastIndexOf('.');
  if (dot > 0 && dot < trimmed.length - 1) {
    const base = trimmed.slice(0, dot);
    const ext = trimmed.slice(dot);
    return `${base} (${index})${ext}`;
  }
  return `${trimmed} (${index})`;
}

async function checkUploadNameCollisions(config: main.OSSConfig, bucket: string, prefix: string, names: string[]) {
  const fn = (window as any)?.go?.main?.OSSService?.CheckUploadNameCollisions;
  if (typeof fn !== 'function') {
    throw new Error('CheckUploadNameCollisions is not available');
  }
  const res = (await fn(config, bucket, prefix, names)) as UploadNameCollision[];
  return Array.isArray(res) ? res : [];
}

async function enqueueUploadRoots(config: main.OSSConfig, bucket: string, prefix: string, roots: UploadRootSpec[]) {
  const fn = (window as any)?.go?.main?.OSSService?.EnqueueUploadRoots;
  if (typeof fn !== 'function') {
    throw new Error('EnqueueUploadRoots is not available');
  }
  const res = (await fn(config, bucket, prefix, roots)) as string[];
  return Array.isArray(res) ? res : [];
}

export async function enqueueUploadWithRenamePrompt(config: main.OSSConfig, bucket: string, prefix: string, paths: string[]) {
  const cleaned = (paths || []).map((p) => (p || '').trim()).filter((p) => !!p);
  if (cleaned.length === 0) return [];

  const normalizedBucket = (bucket || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const normalizedPrefix = normalizeUploadPrefix(prefix);
  if (!normalizedBucket) {
    throw new Error('Bucket is empty');
  }

  const baseNames = cleaned.map((p) => baseNameFromPath(p)).filter((n) => !!n);
  const localNameCount = new Map<string, number>();
  for (const name of baseNames) {
    localNameCount.set(name, (localNameCount.get(name) || 0) + 1);
  }

  const uniqueNames = Array.from(new Set(baseNames));
  const collisions = await checkUploadNameCollisions(config, normalizedBucket, normalizedPrefix, uniqueNames);
  const collisionMap = new Map<string, UploadNameCollision>();
  for (const c of collisions) {
    if (!c?.name) continue;
    collisionMap.set(c.name, c);
  }

  const reservedRemoteNames = new Set<string>();
  const roots: UploadRootSpec[] = [];

  for (const localPath of cleaned) {
    const originalName = baseNameFromPath(localPath);
    if (!originalName) continue;

    const remoteCollision = collisionMap.get(originalName);
    const remoteExists = !!remoteCollision && (remoteCollision.fileExists || remoteCollision.folderExists);
    const localDup = (localNameCount.get(originalName) || 0) > 1;
    const reserved = reservedRemoteNames.has(originalName);

    if (!remoteExists && !localDup && !reserved) {
      roots.push({ localPath });
      reservedRemoteNames.add(originalName);
      continue;
    }

    const targetOssPath = `oss://${normalizedBucket}/${normalizedPrefix}${originalName}`;
    const msgParts = [];
    if (remoteExists) {
      msgParts.push(`An item named "${originalName}" already exists at:\n${targetOssPath}`);
    }
    if (localDup || reserved) {
      msgParts.push(`Multiple selected items are named "${originalName}".`);
    }
    msgParts.push('Choose OK to overwrite, or Cancel to rename.');

    const overwrite = window.confirm(msgParts.join('\n\n'));
    if (overwrite) {
      roots.push({ localPath });
      reservedRemoteNames.add(originalName);
      continue;
    }

    let suggested = '';
    for (let i = 1; i < 1000; i += 1) {
      const candidate = withRenameSuffix(originalName, i);
      if (!candidate) continue;
      if (reservedRemoteNames.has(candidate)) continue;
      const cs = await checkUploadNameCollisions(config, normalizedBucket, normalizedPrefix, [candidate]);
      const hasRemote = cs.some((x) => x?.name === candidate && (x.fileExists || x.folderExists));
      if (!hasRemote) {
        suggested = candidate;
        break;
      }
    }
    if (!suggested) {
      suggested = withRenameSuffix(originalName, 1);
    }

    while (true) {
      const input = window.prompt(`Rename "${originalName}" to:`, suggested);
      if (input === null) {
        return [];
      }
      const nextName = (input || '').trim();
      if (!nextName) continue;
      if (nextName.includes('/') || nextName.includes('\\')) {
        alert('Name cannot contain slashes.');
        continue;
      }
      if (reservedRemoteNames.has(nextName)) {
        alert('Name already used in this upload.');
        continue;
      }
      const cs = await checkUploadNameCollisions(config, normalizedBucket, normalizedPrefix, [nextName]);
      const hasRemote = cs.some((x) => x?.name === nextName && (x.fileExists || x.folderExists));
      if (hasRemote) {
        alert('An item with this name already exists. Please choose another name.');
        continue;
      }

      roots.push({ localPath, remoteName: nextName });
      reservedRemoteNames.add(nextName);
      break;
    }
  }

  if (roots.length === 0) return [];
  return enqueueUploadRoots(config, normalizedBucket, normalizedPrefix, roots);
}

