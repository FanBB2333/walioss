import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import Login from './pages/Login';
import Settings from './pages/Settings';
import AboutModal from './components/AboutModal';
import FileBrowser from './components/FileBrowser';
import TransferModal from './components/TransferModal';
import { main } from '../wailsjs/go/models';
import { EnqueueUploadPaths, GetSettings, GetTransferHistory, MoveObject } from '../wailsjs/go/main/OSSService';
import { GetAppInfo, OpenFile, OpenInFinder } from '../wailsjs/go/main/App';
import { EventsEmit, EventsOn, OnFileDrop, OnFileDropOff } from '../wailsjs/runtime/runtime';
import { canReadOssDragPayload, readOssDragPayload } from './ossDrag';

type GlobalView = 'session' | 'settings';

type AppTab = {
  id: string;
  title: string;
  isCustomTitle: boolean;
  bucket: string;
  prefix: string;
};

type TransferStatus = 'queued' | 'in-progress' | 'success' | 'error';
type TransferType = 'upload' | 'download';
type TransferView = 'all' | TransferType;

type TransferItem = {
  id: string;
  profileName?: string;
  name: string;
  type: TransferType;
  bucket: string;
  key: string;
  parentId?: string;
  isGroup?: boolean;
  fileCount?: number;
  doneCount?: number;
  successCount?: number;
  errorCount?: number;
  status: TransferStatus;
  message?: string;
  localPath?: string;
  totalBytes?: number;
  doneBytes?: number;
  speedBytesPerSec?: number;
  etaSeconds?: number;
  startedAtMs?: number;
  updatedAtMs?: number;
  finishedAtMs?: number;
};

type ToastType = 'success' | 'error' | 'info';
type Toast = { id: number; type: ToastType; message: string };

type AppInfo = {
  name: string;
  version: string;
  githubUrl?: string;
};

type TransferSummary = {
  taskCount: number;
  totalBytes: number;
  doneBytes: number;
  speedBytesPerSec: number;
  progressPercent: number | null;
};

const TAB_REORDER_DRAG_TYPE = 'application/x-walioss-tab-reorder';
const TRANSFER_DERIVED_SPEED_STALE_MS = 6000;
const TRANSFER_PROFILE_ANONYMOUS = '__anonymous__';

const canReadTabReorderPayload = (dt: DataTransfer | null | undefined) => {
  if (!dt) return false;
  try {
    return Array.from(dt.types || []).includes(TAB_REORDER_DRAG_TYPE);
  } catch {
    return false;
  }
};

const readTabReorderPayload = (dt: DataTransfer | null | undefined, fallback: string | null) => {
  if (dt) {
    try {
      const tabId = dt.getData(TAB_REORDER_DRAG_TYPE);
      if (tabId) return tabId;
    } catch {
      // Ignore and fallback to local state.
    }
  }
  return fallback;
};

const isTransferActive = (status: TransferStatus) => status === 'queued' || status === 'in-progress';

const formatBytesCompact = (bytes?: number) => {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
};

const formatSpeedCompact = (bytesPerSec?: number) => {
  if (!bytesPerSec || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '-';
  return `${formatBytesCompact(bytesPerSec)}/s`;
};

const summarizeTransfers = (items: TransferItem[], type: TransferType): TransferSummary => {
  const roots = items.filter((item) => !item.parentId && item.type === type && isTransferActive(item.status));
  let totalBytes = 0;
  let doneBytes = 0;
  let speedBytesPerSec = 0;

  for (const item of roots) {
    const total = Math.max(0, item.totalBytes || 0);
    const done = Math.max(0, item.doneBytes || 0);
    if (total > 0) {
      totalBytes += total;
      doneBytes += Math.min(done, total);
    }
    if (item.status === 'in-progress' && (item.speedBytesPerSec || 0) > 0) {
      speedBytesPerSec += item.speedBytesPerSec || 0;
    }
  }

  const progressPercent = totalBytes > 0 ? Math.max(0, Math.min(100, (doneBytes / totalBytes) * 100)) : null;
  return {
    taskCount: roots.length,
    totalBytes,
    doneBytes,
    speedBytesPerSec,
    progressPercent,
  };
};

const formatSummaryProgress = (summary: TransferSummary) => {
  if (summary.taskCount <= 0) return '-';
  if (summary.totalBytes > 0 && summary.progressPercent !== null) {
    return `${formatBytesCompact(summary.doneBytes)} / ${formatBytesCompact(summary.totalBytes)} (${summary.progressPercent.toFixed(1)}%)`;
  }
  return `${summary.taskCount} task${summary.taskCount > 1 ? 's' : ''}`;
};

const normalizeTransferProfileName = (profileName: unknown) => {
  if (typeof profileName !== 'string') return TRANSFER_PROFILE_ANONYMOUS;
  const normalized = profileName.trim();
  return normalized || TRANSFER_PROFILE_ANONYMOUS;
};

const finiteNumber = (value: unknown) => {
  if (typeof value !== 'number') return undefined;
  return Number.isFinite(value) ? value : undefined;
};

function App() {
  const [globalView, setGlobalView] = useState<GlobalView>('session');
  const [theme, setTheme] = useState<string>('dark');
  const [newTabNameRule, setNewTabNameRule] = useState<'folder' | 'newTab'>('folder');
  const nextTabNumber = useRef(2);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const tabHoverSwitchTimerRef = useRef<number | null>(null);
  const tabHoverSwitchTargetRef = useRef<string | null>(null);

  const [sessionConfig, setSessionConfig] = useState<main.OSSConfig | null>(null);
  const [sessionProfileName, setSessionProfileName] = useState<string | null>(null);

  const [tabs, setTabs] = useState<AppTab[]>([
    { id: 't1', title: 'Buckets', isCustomTitle: false, bucket: '', prefix: '' },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>('t1');
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState<string>('');
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [showTransfers, setShowTransfers] = useState<boolean>(false);
  const [transferView, setTransferView] = useState<TransferView>('all');
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const [aboutOpen, setAboutOpen] = useState<boolean>(false);
  const [aboutLoading, setAboutLoading] = useState<boolean>(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  const appDisplayName = appInfo?.name?.trim() || 'Walioss';
  const appDisplayVersion = appInfo?.version?.trim() || '';
  const activeTransferProfile = useMemo(() => normalizeTransferProfileName(sessionProfileName), [sessionProfileName]);
  const transferSummary = useMemo(() => {
    return {
      upload: summarizeTransfers(transfers, 'upload'),
      download: summarizeTransfers(transfers, 'download'),
    };
  }, [transfers]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      const tag = target.tagName?.toLowerCase?.() || '';
      if (tag === 'input' || tag === 'textarea' || target.isContentEditable) return;

      e.preventDefault();
    };

    window.addEventListener('contextmenu', handler);
    return () => window.removeEventListener('contextmenu', handler);
  }, []);

  useEffect(() => {
    if (!tabs.some((t) => t.id === activeTabId)) {
      setActiveTabId(tabs[0]?.id ?? 't1');
    }
  }, [activeTabId, tabs]);

  const handleThemeChange = (newTheme: string) => {
    setTheme(newTheme);
    const themeClass = newTheme === 'light' ? 'theme-light' : 'theme-dark';
    document.body.classList.remove('theme-light', 'theme-dark');
    document.body.classList.add(themeClass);
  };

  useEffect(() => {
  const applySavedTheme = async () => {
      try {
        const settings = await GetSettings();
        handleThemeChange(settings?.theme || 'dark');
        setNewTabNameRule(settings?.newTabNameRule === 'newTab' ? 'newTab' : 'folder');
      } catch {
        handleThemeChange('dark');
      }
    };
    applySavedTheme();
  }, []);

  const folderNameFromPrefix = (prefix: string) => {
    const trimmed = (prefix || '').replace(/\/+$/, '');
    if (!trimmed) return '';
    const parts = trimmed.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
  };

  const autoTitleFromLocation = (bucket: string, prefix: string) => {
    if (!bucket) return 'Buckets';
    const folder = folderNameFromPrefix(prefix);
    return folder || bucket;
  };

  const parseOssPathLocation = (path: string | undefined | null) => {
    let p = (path || '').trim();
    if (!p) return { bucket: '', prefix: '' };
    if (p.startsWith('oss://')) p = p.slice(6);
    p = p.replace(/^\/+/, '');
    if (!p) return { bucket: '', prefix: '' };
    const parts = p.split('/').filter(Boolean);
    const bucket = parts[0] || '';
    const prefixPart = parts.slice(1).join('/');
    const prefix = prefixPart ? (prefixPart.endsWith('/') ? prefixPart : `${prefixPart}/`) : '';
    return { bucket, prefix };
  };

  const normalizeBucketName = (bucket: string) => bucket.trim().replace(/^\/+/, '').replace(/\/+$/, '');

  const normalizePrefix = (prefix: string) => {
    let p = (prefix || '').trim().replace(/^\/+/, '');
    if (!p) return '';
    if (!p.endsWith('/')) p += '/';
    return p;
  };

  const parseOssObjectPath = (path: string | undefined | null) => {
    let p = (path || '').trim();
    if (!p.startsWith('oss://')) return null;
    p = p.slice(6);
    p = p.replace(/^\/+/, '');
    if (!p) return null;
    const parts = p.split('/');
    const bucket = normalizeBucketName(parts[0] || '');
    if (!bucket) return null;
    const key = parts.slice(1).join('/');
    return { bucket, key };
  };

  const defaultTabTitleForRule = (rule: 'folder' | 'newTab', bucket: string, prefix: string) => {
    if (rule === 'newTab') return 'New Tab';
    return autoTitleFromLocation(bucket, prefix);
  };

  const toTransferItem = useCallback((update: any, previous?: TransferItem): TransferItem => {
    const status = (update.status || previous?.status || 'queued') as TransferStatus;
    const totalBytesRaw = finiteNumber(update.totalBytes) ?? previous?.totalBytes;
    const totalBytes = typeof totalBytesRaw === 'number' ? Math.max(0, totalBytesRaw) : undefined;
    const doneBytesRaw = finiteNumber(update.doneBytes) ?? previous?.doneBytes;
    let doneBytes = typeof doneBytesRaw === 'number' ? Math.max(0, doneBytesRaw) : undefined;
    if (typeof totalBytes === 'number' && typeof doneBytes === 'number') {
      doneBytes = Math.min(doneBytes, totalBytes);
    }

    const nowMs = Date.now();
    const updatedAtMs = finiteNumber(update.updatedAtMs) ?? previous?.updatedAtMs ?? nowMs;
    const previousUpdatedAt = previous?.updatedAtMs ?? updatedAtMs;
    const deltaMs = updatedAtMs - previousUpdatedAt;
    const previousDoneBytes = previous?.doneBytes ?? 0;
    const currentDoneBytes = doneBytes ?? previousDoneBytes;
    const deltaDone = currentDoneBytes - previousDoneBytes;

    const incomingSpeed = finiteNumber(update.speedBytesPerSec);
    let speedBytesPerSec = incomingSpeed ?? previous?.speedBytesPerSec ?? 0;
    if (status === 'in-progress') {
      if (!(incomingSpeed && incomingSpeed > 0)) {
        if (deltaDone > 0 && deltaMs > 0) {
          const derivedSpeed = deltaDone / (deltaMs / 1000);
          if (Number.isFinite(derivedSpeed) && derivedSpeed > 0) {
            const prevSpeed = (previous?.speedBytesPerSec || 0) > 0 ? (previous?.speedBytesPerSec as number) : 0;
            speedBytesPerSec = prevSpeed > 0 ? prevSpeed * 0.65 + derivedSpeed * 0.35 : derivedSpeed;
          }
        } else {
          const prevSpeed = previous?.speedBytesPerSec || 0;
          speedBytesPerSec =
            prevSpeed > 0 && updatedAtMs - previousUpdatedAt <= TRANSFER_DERIVED_SPEED_STALE_MS ? prevSpeed : 0;
        }
      }
    } else if (!(incomingSpeed && incomingSpeed > 0)) {
      speedBytesPerSec = previous?.speedBytesPerSec || 0;
    }

    const incomingEta = finiteNumber(update.etaSeconds);
    let etaSeconds = incomingEta ?? previous?.etaSeconds ?? 0;
    if (status === 'in-progress') {
      if (!(incomingEta && incomingEta > 0)) {
        if (
          typeof totalBytes === 'number' &&
          totalBytes > 0 &&
          typeof currentDoneBytes === 'number' &&
          currentDoneBytes >= 0 &&
          currentDoneBytes < totalBytes &&
          speedBytesPerSec > 0
        ) {
          etaSeconds = Math.max(0, Math.ceil((totalBytes - currentDoneBytes) / speedBytesPerSec));
        } else if (currentDoneBytes >= (totalBytes || 0) && (totalBytes || 0) > 0) {
          etaSeconds = 0;
        }
      }
    } else if (!(incomingEta && incomingEta > 0)) {
      etaSeconds = 0;
    }

    if (status === 'success' && typeof totalBytes === 'number' && totalBytes > 0) {
      doneBytes = totalBytes;
    }

    return {
      id: update.id,
      profileName: normalizeTransferProfileName(update.profileName ?? previous?.profileName),
      name: update.name || previous?.name || 'Transfer',
      type: update.type || previous?.type || 'download',
      bucket: update.bucket || previous?.bucket || '',
      key: update.key || previous?.key || '',
      parentId: update.parentId ?? previous?.parentId,
      isGroup: update.isGroup ?? previous?.isGroup ?? false,
      fileCount: finiteNumber(update.fileCount) ?? previous?.fileCount,
      doneCount: finiteNumber(update.doneCount) ?? previous?.doneCount,
      successCount: finiteNumber(update.successCount) ?? previous?.successCount,
      errorCount: finiteNumber(update.errorCount) ?? previous?.errorCount,
      status,
      message: update.message ?? previous?.message,
      localPath: update.localPath ?? previous?.localPath,
      totalBytes,
      doneBytes,
      speedBytesPerSec,
      etaSeconds,
      startedAtMs: finiteNumber(update.startedAtMs) ?? previous?.startedAtMs,
      updatedAtMs,
      finishedAtMs: finiteNumber(update.finishedAtMs) ?? previous?.finishedAtMs,
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!sessionConfig) {
      setTransfers([]);
      return () => {
        cancelled = true;
      };
    }

    const loadTransferHistory = async () => {
      try {
        const history = await GetTransferHistory();
        if (cancelled || !Array.isArray(history)) {
          return;
        }
        const normalized = history
          .filter((item: any) => !!item?.id)
          .map((item: any) => toTransferItem(item));
        const filtered = normalized.filter((item) => normalizeTransferProfileName(item.profileName) === activeTransferProfile);
        setTransfers(filtered);
      } catch (error) {
        console.error('Failed to load transfer history:', error);
      }
    };
    void loadTransferHistory();
    return () => {
      cancelled = true;
    };
  }, [activeTransferProfile, sessionConfig, toTransferItem]);

  const showToast = useCallback((type: ToastType, message: string, timeoutMs = 2600) => {
    const id = Date.now();
    setToast({ id, type, message });
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast((prev) => (prev?.id === id ? null : prev));
    }, timeoutMs);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const ensureAppInfo = useCallback(async () => {
    if (aboutLoading || appInfo) return;
    setAboutLoading(true);
    try {
      const info = (await GetAppInfo()) as any;
      setAppInfo(info as AppInfo);
    } catch (err: any) {
      showToast('error', err?.message || 'Failed to load app info');
    } finally {
      setAboutLoading(false);
    }
  }, [aboutLoading, appInfo, showToast]);

  const openAbout = useCallback(() => {
    setAboutOpen(true);
    void ensureAppInfo();
  }, [ensureAppInfo]);

  useEffect(() => {
    let cancelled = false;
    const preloadAppInfo = async () => {
      try {
        const info = (await GetAppInfo()) as any;
        if (cancelled) return;
        setAppInfo(info as AppInfo);
      } catch {
        // Ignore preload failures; explicit About open still reports errors.
      }
    };
    void preloadAppInfo();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const off = EventsOn('transfer:update', (payload: any) => {
      if (!sessionConfig) return;
      const update = payload as any;
      if (!update?.id) return;
      const updateProfile = normalizeTransferProfileName(update?.profileName);
      if (updateProfile !== activeTransferProfile) return;

      if (update?.isGroup && update?.status === 'queued' && (update?.type === 'upload' || update?.type === 'download')) {
        setTransferView(update.type as TransferType);
        setShowTransfers(true);
      }

      setTransfers((prev) => {
        const index = prev.findIndex((t) => t.id === update.id);
        const next: TransferItem = toTransferItem(update, index >= 0 ? prev[index] : undefined);

        if (index === -1) {
          return [next, ...prev];
        }

        const updated = [...prev];
        updated[index] = { ...prev[index], ...next };
        return updated;
      });
    });
    return () => off();
  }, [activeTransferProfile, sessionConfig, toTransferItem]);

  useEffect(() => {
    const off = EventsOn('app:about', () => {
      openAbout();
    });
    return () => off();
  }, [openAbout]);

  useEffect(() => {
    if (!sessionConfig) {
      OnFileDropOff();
      return;
    }

    OnFileDrop((_x: number, _y: number, paths: string[]) => {
      if (!sessionConfig) return;
      if (!Array.isArray(paths) || paths.length === 0) return;
      const bucket = normalizeBucketName(activeTab?.bucket || '');
      if (!bucket) {
        showToast('error', 'Open a bucket before uploading files');
        return;
      }

      const prefix = normalizePrefix(activeTab?.prefix || '');
      void EnqueueUploadPaths(sessionConfig, bucket, prefix, paths)
        .then((ids) => {
          if (!Array.isArray(ids) || ids.length === 0) return;
          setTransferView('upload');
          setShowTransfers(true);
          showToast('info', ids.length > 1 ? `Queued ${ids.length} upload tasks` : 'Queued upload task');
        })
        .catch((err: any) => {
          showToast('error', err?.message || 'Upload failed');
        });
    }, true);

    return () => OnFileDropOff();
  }, [activeTab?.bucket, activeTab?.prefix, sessionConfig, showToast]);

  const handleLoginSuccess = (config: main.OSSConfig, profileName?: string | null) => {
    const initialLoc = parseOssPathLocation(config?.defaultPath);
    setSessionConfig(config);
    setGlobalView('session');
    setSessionProfileName(profileName || null);
    setTransfers([]);
    setShowTransfers(false);
    setTabs((prev) =>
      prev.map((t) =>
        t.isCustomTitle
          ? t
          : {
              ...t,
              bucket: initialLoc.bucket,
              prefix: initialLoc.prefix,
              title: defaultTabTitleForRule(newTabNameRule, initialLoc.bucket, initialLoc.prefix),
            },
      ),
    );
  };

  const handleLogout = () => {
    setSessionConfig(null);
    setGlobalView('session');
    setTabs([{ id: 't1', title: 'Buckets', isCustomTitle: false, bucket: '', prefix: '' }]);
    setActiveTabId('t1');
    nextTabNumber.current = 2;
    setSessionProfileName(null);
    setTransfers([]);
    setShowTransfers(false);
    setDragOverTabId(null);
    setDraggingTabId(null);
  };

  const openTab = (tabId: string) => {
    setActiveTabId(tabId);
    setGlobalView('session');
  };

  const clearTabHoverSwitch = () => {
    if (tabHoverSwitchTimerRef.current) {
      window.clearTimeout(tabHoverSwitchTimerRef.current);
    }
    tabHoverSwitchTimerRef.current = null;
    tabHoverSwitchTargetRef.current = null;
  };

  useEffect(() => {
    return () => clearTabHoverSwitch();
  }, []);

  const reorderTabs = (sourceTabId: string, targetTabId: string, placeAfter: boolean) => {
    if (!sourceTabId || sourceTabId === targetTabId) return;
    setTabs((prev) => {
      const sourceIndex = prev.findIndex((t) => t.id === sourceTabId);
      const targetIndex = prev.findIndex((t) => t.id === targetTabId);
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return prev;

      const next = [...prev];
      const [moved] = next.splice(sourceIndex, 1);
      if (!moved) return prev;

      let insertIndex = targetIndex + (placeAfter ? 1 : 0);
      if (sourceIndex < insertIndex) insertIndex -= 1;
      insertIndex = Math.max(0, Math.min(insertIndex, next.length));
      if (insertIndex === sourceIndex) return prev;

      next.splice(insertIndex, 0, moved);
      return next;
    });
  };

  const reorderTabsByPointer = (e: React.DragEvent, targetTabId: string, sourceTabId: string) => {
    if (!sourceTabId || sourceTabId === targetTabId) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const placeAfter = e.clientX > rect.left + rect.width / 2;
    reorderTabs(sourceTabId, targetTabId, placeAfter);
  };

  const handleTabDragStart = (e: React.DragEvent, tabId: string) => {
    setDraggingTabId(tabId);
    clearTabHoverSwitch();
    setDragOverTabId(null);

    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData(TAB_REORDER_DRAG_TYPE, tabId);
      e.dataTransfer.setData('text/plain', tabId);
    } catch {
      // Some webviews may block custom mime types; local state is fallback.
    }
  };

  const handleTabDragEnd = () => {
    clearTabHoverSwitch();
    setDragOverTabId(null);
    setDraggingTabId(null);
  };

  const handleTabDragEnter = (e: React.DragEvent, tabId: string) => {
    if (canReadTabReorderPayload(e.dataTransfer) || draggingTabId) {
      e.preventDefault();
      const sourceTabId = readTabReorderPayload(e.dataTransfer, draggingTabId);
      if (!sourceTabId) return;
      reorderTabsByPointer(e, tabId, sourceTabId);
      clearTabHoverSwitch();
      setDragOverTabId(null);
      return;
    }

    if (!canReadOssDragPayload(e.dataTransfer)) return;
    e.preventDefault();
    setDragOverTabId(tabId);

    if (tabId === activeTabId) return;
    clearTabHoverSwitch();
    tabHoverSwitchTargetRef.current = tabId;
    tabHoverSwitchTimerRef.current = window.setTimeout(() => {
      if (tabHoverSwitchTargetRef.current === tabId) {
        openTab(tabId);
      }
    }, 320);
  };

  const handleTabDragOver = (e: React.DragEvent, tabId: string) => {
    if (canReadTabReorderPayload(e.dataTransfer) || draggingTabId) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const sourceTabId = readTabReorderPayload(e.dataTransfer, draggingTabId);
      if (sourceTabId) {
        reorderTabsByPointer(e, tabId, sourceTabId);
      }
      return;
    }

    if (!canReadOssDragPayload(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverTabId(tabId);
  };

  const handleTabDragLeave = (e: React.DragEvent, tabId: string) => {
    if (canReadTabReorderPayload(e.dataTransfer) || draggingTabId) return;

    const related = e.relatedTarget as Node | null;
    if (related && e.currentTarget.contains(related)) return;
    setDragOverTabId((prev) => (prev === tabId ? null : prev));
    if (tabHoverSwitchTargetRef.current === tabId) {
      clearTabHoverSwitch();
    }
  };

  const handleTabDrop = async (e: React.DragEvent, tab: AppTab) => {
    const sourceTabId = readTabReorderPayload(e.dataTransfer, draggingTabId);
    if (sourceTabId) {
      e.preventDefault();
      e.stopPropagation();
      reorderTabsByPointer(e, tab.id, sourceTabId);
      clearTabHoverSwitch();
      setDragOverTabId(null);
      setDraggingTabId(null);
      return;
    }

    if (!sessionConfig) return;
    const payload = readOssDragPayload(e.dataTransfer);
    if (!payload || !payload.items.length) return;

    e.preventDefault();
    e.stopPropagation();
    clearTabHoverSwitch();
    setDragOverTabId(null);

    const destBucket = normalizeBucketName(tab.bucket);
    const destPrefix = normalizePrefix(tab.prefix);
    if (!destBucket) {
      showToast('error', 'Open a bucket first to move items into it.');
      return;
    }

    try {
      for (const item of payload.items) {
        const parsed = parseOssObjectPath(item.path);
        if (!parsed?.bucket) continue;

        const srcBucket = parsed.bucket;
        const srcKey = parsed.key;
        const cleanName = (item.name || '').replace(/\/+$/, '');
        const destKey = `${destPrefix || ''}${cleanName}${item.isFolder ? '/' : ''}`;

        if (srcBucket === destBucket && srcKey === destKey) continue;

        if (item.isFolder && srcBucket === destBucket) {
          const srcKeyFolder = srcKey.endsWith('/') ? srcKey : `${srcKey}/`;
          if (destKey.startsWith(srcKeyFolder)) {
            throw new Error('Cannot move a folder into itself.');
          }
        }

        await MoveObject(sessionConfig, srcBucket, srcKey, destBucket, destKey);
      }

      const sourceBucket = normalizeBucketName(payload.source?.bucket || '');
      const sourcePrefix = normalizePrefix(payload.source?.prefix || '');
      if (sourceBucket) {
        EventsEmit('objects:changed', { bucket: sourceBucket, prefix: sourcePrefix }, { bucket: destBucket, prefix: destPrefix });
      } else {
        EventsEmit('objects:changed', { bucket: destBucket, prefix: destPrefix });
      }

      showToast('success', payload.items.length > 1 ? `Moved ${payload.items.length} items` : 'Moved 1 item');
      openTab(tab.id);
    } catch (err: any) {
      showToast('error', err?.message || 'Move failed');
    }
  };

  const addTab = () => {
    if (!sessionConfig) return;
    const number = nextTabNumber.current++;
    const id = `t${number}`;
    const initialLoc = parseOssPathLocation(sessionConfig?.defaultPath);
    const title = defaultTabTitleForRule(newTabNameRule, initialLoc.bucket, initialLoc.prefix);
    setTabs((prev) => [...prev, { id, title, isCustomTitle: false, bucket: initialLoc.bucket, prefix: initialLoc.prefix }]);
    openTab(id);
  };

  const startRename = (tabId: string, currentTitle: string) => {
    setRenamingTabId(tabId);
    setRenameValue(currentTitle);
  };

  const cancelRename = () => {
    setRenamingTabId(null);
    setRenameValue('');
  };

  const commitRename = () => {
    if (!renamingTabId) return;
    const title = renameValue.trim() || 'New Tab';
    setTabs((prev) =>
      prev.map((t) => (t.id === renamingTabId ? { ...t, title, isCustomTitle: true } : t)),
    );
    cancelRename();
  };

  const handleTabLocationChange = (tabId: string, bucket: string, prefix: string) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId) return t;
        const next = { ...t, bucket, prefix };
        if (!t.isCustomTitle && newTabNameRule === 'folder') {
          const nextTitle = autoTitleFromLocation(bucket, prefix);
          if (nextTitle && nextTitle !== t.title) {
            next.title = nextTitle;
          }
        }
        return next;
      }),
    );
  };

  const applyNewTabNameRule = (rule: 'folder' | 'newTab') => {
    setNewTabNameRule(rule);
    setTabs((prev) =>
      prev.map((t) => {
        if (t.isCustomTitle) return t;
        const title = defaultTabTitleForRule(rule, t.bucket, t.prefix);
        return { ...t, title };
      }),
    );
  };

  const closeTab = (tabId: string) => {
    if (tabs.length <= 1) {
      handleLogout();
      return;
    }
    if (renamingTabId === tabId) {
      cancelRename();
    }
    setTabs((prev) => prev.filter((t) => t.id !== tabId));
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isCmdOrCtrl = e.metaKey || e.ctrlKey;
      if (!isCmdOrCtrl) return;

      const key = e.key.toLowerCase();

      // Cmd/Ctrl + 1..9: switch tab
      if (/^[1-9]$/.test(key)) {
        e.preventDefault();
        const index = parseInt(key, 10) - 1;
        const target = tabs[index];
        if (target) {
          openTab(target.id);
        }
        return;
      }

      // Cmd/Ctrl + T: new tab
      if (key === 't') {
        e.preventDefault();
        addTab();
      }

      // Cmd/Ctrl + W: close active tab
      if (key === 'w') {
        e.preventDefault();
        if (activeTabId) {
          closeTab(activeTabId);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeTabId, tabs]);

  const inProgressCount = transferSummary.upload.taskCount + transferSummary.download.taskCount;

  return (
    <>
      <div className="dashboard-container">
	        <header className="dashboard-header">
	          <div className="dashboard-topbar">
	            <div
	              className="app-brand app-brand-clickable"
	              role="button"
	              tabIndex={0}
	              onClick={openAbout}
	              onKeyDown={(e) => {
	                if (e.key === 'Enter' || e.key === ' ') {
	                  e.preventDefault();
	                  openAbout();
	                }
	              }}
	              title="About"
	            >
	              <img className="app-icon" src="/appicon.png" alt="Walioss" />
	              <div className="app-name-wrap">
	                <h1 className="app-name">{appDisplayName}</h1>
	                {appDisplayVersion && <span className="app-version">v{appDisplayVersion}</span>}
	              </div>
	            </div>
	            <div className="header-info">
	              {sessionConfig && (
                  <div
                    className="transfer-summary"
                    title={[
                      `Upload: ${formatSummaryProgress(transferSummary.upload)} @ ${formatSpeedCompact(transferSummary.upload.speedBytesPerSec)}`,
                      `Download: ${formatSummaryProgress(transferSummary.download)} @ ${formatSpeedCompact(transferSummary.download.speedBytesPerSec)}`,
                    ].join('\n')}
                  >
                    <div className="transfer-summary-row">
                      <span className="transfer-summary-label up">↑ Up</span>
                      <span className="transfer-summary-progress">{formatSummaryProgress(transferSummary.upload)}</span>
                      <span className="transfer-summary-speed">{formatSpeedCompact(transferSummary.upload.speedBytesPerSec)}</span>
                    </div>
                    <div className="transfer-summary-row">
                      <span className="transfer-summary-label down">↓ Down</span>
                      <span className="transfer-summary-progress">{formatSummaryProgress(transferSummary.download)}</span>
                      <span className="transfer-summary-speed">{formatSpeedCompact(transferSummary.download.speedBytesPerSec)}</span>
                    </div>
                  </div>
                )}
                {sessionConfig && (
	                <div className="transfer-toggle">
	                  <button
                    className="transfer-btn"
                    type="button"
                    onClick={() => {
                      setTransferView('all');
                      setShowTransfers(true);
                    }}
                    title="传输进度"
                  >
                    ⇅
                    {inProgressCount > 0 && <span className="transfer-badge">{inProgressCount}</span>}
                  </button>
                </div>
              )}
              <span>Region: {sessionConfig?.region || '-'}</span>
              <button className="btn-settings" onClick={() => setGlobalView('settings')}>
                Settings
              </button>
              {sessionConfig && (
                <button className="btn-logout" onClick={handleLogout}>
                  Logout
                </button>
              )}
            </div>
          </div>

          {sessionConfig && (
            <div className="dashboard-tabbar">
              <div className="window-tabs" aria-label="Windows">
                {tabs.map((t, index) => (
                  <div
                    key={t.id}
                    className={`window-tab ${t.id === activeTabId ? 'active' : ''} ${dragOverTabId === t.id ? 'drag-over' : ''} ${draggingTabId === t.id ? 'dragging' : ''}`}
                    role="button"
                    tabIndex={0}
                    draggable={renamingTabId !== t.id}
                    onClick={() => openTab(t.id)}
                    onDragStart={(e) => handleTabDragStart(e, t.id)}
                    onDragEnd={handleTabDragEnd}
                    onDragEnter={(e) => handleTabDragEnter(e, t.id)}
                    onDragOver={(e) => handleTabDragOver(e, t.id)}
                    onDragLeave={(e) => handleTabDragLeave(e, t.id)}
                    onDrop={(e) => void handleTabDrop(e, t)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openTab(t.id);
                      }
                    }}
                    title={t.title}
                  >
                    <span className="window-tab-number">#{index + 1}</span>
                    {renamingTabId === t.id ? (
                      <input
                        className="window-tab-rename"
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename();
                          if (e.key === 'Escape') cancelRename();
                        }}
                      />
                    ) : (
                      <span className="window-tab-title" onDoubleClick={() => startRename(t.id, t.title)} title="Double-click to rename">
                        {t.title}
                      </span>
                    )}
                    <button
                      className="window-tab-close"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(t.id);
                      }}
                      aria-label="Close tab"
                      title="Close"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button className="window-new-btn" type="button" onClick={addTab} title="New Tab">
                  +
                </button>
              </div>
            </div>
          )}
        </header>
        <main className="dashboard-main">
          {!sessionConfig ? (
            <Login onLoginSuccess={handleLoginSuccess} />
          ) : (
            <div className="window-stack">
		              {tabs.map((t) => (
		                <div key={t.id} className={`window-panel ${t.id === activeTabId ? 'active' : ''}`}>
		                  <FileBrowser
		                    config={sessionConfig}
		                    profileName={sessionProfileName}
		                    initialPath={sessionConfig.defaultPath}
		                    onLocationChange={(loc) => handleTabLocationChange(t.id, loc.bucket, loc.prefix)}
                        onNotify={(t) => showToast(t.type, t.message)}
		                  />
		                </div>
		              ))}
	            </div>
	          )}
        </main>
	        <Settings
	          isOpen={globalView === 'settings'}
	          onBack={() => setGlobalView('session')}
	          onThemeChange={handleThemeChange}
	          onNotify={(t) => showToast(t.type, t.message)}
	          onSettingsSaved={(settings) => applyNewTabNameRule(settings?.newTabNameRule === 'newTab' ? 'newTab' : 'folder')}
	        />
	        <AboutModal isOpen={aboutOpen} info={appInfo} loading={aboutLoading} onClose={() => setAboutOpen(false)} />
	        <TransferModal
	          isOpen={showTransfers}
	          activeTab={transferView}
	          onTabChange={setTransferView}
	          transfers={transfers}
          onClose={() => setShowTransfers(false)}
          onReveal={(p) => OpenInFinder(p)}
          onOpen={(p) => OpenFile(p)}
        />
        {toast && (
          <div className={`toast toast-${toast.type}`} role="status">
            <div className="toast-message">{toast.message}</div>
            <button
              className="toast-close"
              type="button"
              aria-label="Dismiss notification"
              title="Dismiss"
              onClick={() => setToast(null)}
            >
              ×
            </button>
          </div>
        )}
      </div>
    </>
  );
}

export default App;
