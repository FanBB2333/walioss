import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { main } from '../../wailsjs/go/models';
import { CreateFile, CreateFolder, DeleteObject, EnqueueDownload, EnqueueDownloadFolder, ListBuckets, ListObjectsPage, MoveObject, PresignObject } from '../../wailsjs/go/main/OSSService';
import { SelectDirectory, SelectFile, SelectSaveFile } from '../../wailsjs/go/main/App';
import ConfirmationModal from './ConfirmationModal';
import FilePreviewModal from './FilePreviewModal';
import { EventsEmit, EventsOn } from '../../wailsjs/runtime/runtime';
import { canReadOssDragPayload, OssDragPayload, readOssDragPayload, writeOssDragPayload } from '../ossDrag';
import { enqueueUploadWithRenamePrompt } from '../upload';
import './FileBrowser.css';
import './Modal.css';

interface FileBrowserProps {
  config: main.OSSConfig;
  profileName: string | null;
  initialPath?: string;
  onLocationChange?: (location: { bucket: string; prefix: string }) => void;
  onNotify?: (toast: { type: 'success' | 'error' | 'info'; message: string }) => void;
}

// Columns: Select, Name, Size, Type, Last Modified, Actions
const DEFAULT_TABLE_COLUMN_WIDTHS = [44, 440, 110, 120, 190, 200];
const MIN_TABLE_COLUMN_WIDTHS = [44, 180, 70, 80, 120, 160];
const DEFAULT_PAGE_SIZE = 100;
const BOOKMARK_POPUP_DEFAULT_WIDTH = 560;
const BOOKMARK_POPUP_MIN_WIDTH = 420;
const BOOKMARK_POPUP_VIEWPORT_MARGIN = 56;

const IMAGE_THUMB_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tif', 'tiff']);

const getFileExtensionLower = (name: string) => {
  const trimmed = (name || '').trim();
  const dot = trimmed.lastIndexOf('.');
  if (dot <= 0 || dot === trimmed.length - 1) return '';
  return trimmed.slice(dot + 1).toLowerCase();
};

const isFolderObjectInfo = (obj: main.ObjectInfo) => {
  if (!obj) return false;
  if (obj.type === 'File') return false;
  if (obj.type === 'Folder') return true;
  return (obj.path || '').endsWith('/') || (obj.name || '').endsWith('/');
};

const isImageObjectInfo = (obj: main.ObjectInfo) => {
  if (!obj) return false;
  if (isFolderObjectInfo(obj)) return false;
  const ext = getFileExtensionLower(obj.name || '');
  return IMAGE_THUMB_EXTENSIONS.has(ext);
};

const clampBookmarkPopupWidth = (value: number) => {
  const viewportMax = typeof window !== 'undefined'
    ? Math.max(BOOKMARK_POPUP_MIN_WIDTH, window.innerWidth - BOOKMARK_POPUP_VIEWPORT_MARGIN)
    : BOOKMARK_POPUP_DEFAULT_WIDTH;
  return Math.max(BOOKMARK_POPUP_MIN_WIDTH, Math.min(Math.round(value), viewportMax));
};

const sumWidths = (widths: number[]) => widths.reduce((sum, w) => sum + w, 0);

const fitWidthsToContainer = (widths: number[], targetWidth: number) => {
  if (!Number.isFinite(targetWidth) || targetWidth <= 0) return widths;
  if (widths.length !== MIN_TABLE_COLUMN_WIDTHS.length) return widths;
  const stretchIndex = widths.length > 1 ? 1 : 0;

  const total = sumWidths(widths);
  if (!Number.isFinite(total) || total <= 0) return widths;

  const minTotal = sumWidths(MIN_TABLE_COLUMN_WIDTHS);
  if (minTotal > targetWidth) return widths;

  const scale = targetWidth / total;
  const next = widths.map((w, i) => Math.max(MIN_TABLE_COLUMN_WIDTHS[i], Math.round(w * scale)));

  let diff = targetWidth - sumWidths(next);
  if (diff > 0) {
    next[stretchIndex] += diff;
    return next;
  }

  if (diff < 0) {
    let remaining = -diff;
    for (let i = 0; i < next.length && remaining > 0; i++) {
      const slack = next[i] - MIN_TABLE_COLUMN_WIDTHS[i];
      if (slack <= 0) continue;
      const take = Math.min(slack, remaining);
      next[i] -= take;
      remaining -= take;
    }
  }

  const final = sumWidths(next);
  if (final !== targetWidth) {
    next[stretchIndex] = Math.max(MIN_TABLE_COLUMN_WIDTHS[stretchIndex], next[stretchIndex] + (targetWidth - final));
  }

  return next;
};

type Bookmark = {
  id: string;
  bucket: string;
  prefix: string;
  label: string;
};

type NavLocation = {
  bucket: string;
  prefix: string;
};

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  object: main.ObjectInfo | null;
}

type CrumbPopoverState = {
  bucket: string;
  prefix: string;
  x: number;
  y: number;
  items: main.ObjectInfo[];
  nextMarker: string;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
};

function FileBrowser({ config, profileName, initialPath, onLocationChange, onNotify }: FileBrowserProps) {
  const [currentBucket, setCurrentBucket] = useState('');
  const [currentPrefix, setCurrentPrefix] = useState('');
  const [navState, setNavState] = useState<{ stack: NavLocation[]; index: number }>({
    stack: [{ bucket: '', prefix: '' }],
    index: 0,
  });
  
  const [buckets, setBuckets] = useState<main.BucketInfo[]>([]);
  const [objects, setObjects] = useState<main.ObjectInfo[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const selectAllRef = useRef<HTMLInputElement>(null);

  const thumbUrlCacheRef = useRef<Map<string, string>>(new Map());
  const thumbLoadingRef = useRef<Set<string>>(new Set());
  const [_thumbTick, setThumbTick] = useState(0);
  const configSignature = useMemo(() => {
    return `${config.accessKeyId}|${config.endpoint}|${config.region}`;
  }, [config.accessKeyId, config.endpoint, config.region]);

  useEffect(() => {
    thumbUrlCacheRef.current.clear();
    thumbLoadingRef.current.clear();
    setThumbTick((t) => t + 1);
  }, [configSignature]);
  const lastSelectionIndexRef = useRef<number | null>(null);
  const shiftPressedRef = useRef(false);
  const checkboxPointerShiftRef = useRef(false);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);

  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [pageIndex, setPageIndex] = useState<number>(1);
  const [pageMarkers, setPageMarkers] = useState<string[]>(['']); // page 1 marker
  const [pageHasNext, setPageHasNext] = useState<boolean>(false);
  const [knownLastPage, setKnownLastPage] = useState<number | null>(null);
  const [jumpToPage, setJumpToPage] = useState<string>('');
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Context Menu State
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0, object: null });
  
  // Modal State
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<main.ObjectInfo[]>([]);
  const [createFolderModalOpen, setCreateFolderModalOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [createFileModalOpen, setCreateFileModalOpen] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [moveModalOpen, setMoveModalOpen] = useState(false);
  const [moveDestValue, setMoveDestValue] = useState('');
  const [moveTargets, setMoveTargets] = useState<main.ObjectInfo[]>([]);
  const [propertiesModalOpen, setPropertiesModalOpen] = useState(false);
  const [operationLoading, setOperationLoading] = useState(false);
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [previewObject, setPreviewObject] = useState<main.ObjectInfo | null>(null);
  const [bookmarkMenuOpen, setBookmarkMenuOpen] = useState(false);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const [crumbPopover, setCrumbPopover] = useState<CrumbPopoverState | null>(null);
  const crumbPopoverRequestIdRef = useRef(0);
  const crumbPopoverCloseTimerRef = useRef<number | null>(null);
  const crumbPopoverFetchingRef = useRef(false);
  const crumbPopoverFetchingRequestIdRef = useRef(0);

  // Address bar edit state
  const [addressBarEditing, setAddressBarEditing] = useState(false);
  const [addressBarValue, setAddressBarValue] = useState('');
  const addressInputRef = useRef<HTMLInputElement>(null);
  const createFolderInputRef = useRef<HTMLInputElement>(null);
  const createFileInputRef = useRef<HTMLInputElement>(null);
  const moveInputRef = useRef<HTMLInputElement>(null);

  const tableViewportRef = useRef<HTMLDivElement>(null);
  const [columnWidths, setColumnWidths] = useState<number[]>(() => {
    const fallbackWidth = Math.max(720, window.innerWidth - 160);
    return fitWidthsToContainer(DEFAULT_TABLE_COLUMN_WIDTHS, fallbackWidth);
  });

  const tableVisible = !!currentBucket && objects.length > 0;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') shiftPressedRef.current = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') shiftPressedRef.current = false;
    };
    const onWindowBlur = () => {
      shiftPressedRef.current = false;
      checkboxPointerShiftRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, []);

  const storageKey = profileName ? `oss-bookmarks:${profileName}` : null;
  const bookmarkPopupWidthStorageKey = profileName ? `oss-bookmark-popup-width:${profileName}` : 'oss-bookmark-popup-width:default';
  const [bookmarkPopupWidth, setBookmarkPopupWidth] = useState<number>(BOOKMARK_POPUP_DEFAULT_WIDTH);
  const bookmarkPopupResizeStateRef = useRef<{ active: boolean; startX: number; startWidth: number }>({
    active: false,
    startX: 0,
    startWidth: BOOKMARK_POPUP_DEFAULT_WIDTH,
  });

  const normalizeBucketName = (bucket: string) => bucket.trim().replace(/^\/+/, '').replace(/\/+$/, '');

  const normalizePrefix = (prefix: string) => {
    let p = prefix.trim().replace(/^\/+/, '');
    if (!p) return '';
    if (!p.endsWith('/')) p += '/';
    return p;
  };

  const loadBookmarks = () => {
    if (!storageKey) {
      setBookmarks([]);
      return;
    }
    try {
      const raw = localStorage.getItem(storageKey);
      setBookmarks(raw ? JSON.parse(raw) : []);
    } catch {
      setBookmarks([]);
    }
  };

  const persistBookmarks = (items: Bookmark[]) => {
    if (!storageKey) return;
    localStorage.setItem(storageKey, JSON.stringify(items));
  };

  // Load initial path or buckets on mount
  useEffect(() => {
    if (initialPath) {
      parseAndNavigateOssPath(initialPath);
    } else {
      loadBuckets();
    }
  }, [config]); 

  useEffect(() => {
    loadBookmarks();
  }, [storageKey]);

  useEffect(() => {
    setBookmarkMenuOpen(false);
  }, [storageKey]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(bookmarkPopupWidthStorageKey);
      if (!raw) {
        setBookmarkPopupWidth(clampBookmarkPopupWidth(BOOKMARK_POPUP_DEFAULT_WIDTH));
        return;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setBookmarkPopupWidth(clampBookmarkPopupWidth(BOOKMARK_POPUP_DEFAULT_WIDTH));
        return;
      }
      setBookmarkPopupWidth(clampBookmarkPopupWidth(parsed));
    } catch {
      setBookmarkPopupWidth(clampBookmarkPopupWidth(BOOKMARK_POPUP_DEFAULT_WIDTH));
    }
  }, [bookmarkPopupWidthStorageKey]);

  useEffect(() => {
    try {
      localStorage.setItem(bookmarkPopupWidthStorageKey, String(Math.round(bookmarkPopupWidth)));
    } catch {
      // Ignore localStorage write errors.
    }
  }, [bookmarkPopupWidth, bookmarkPopupWidthStorageKey]);

  useEffect(() => {
    const handleResize = () => {
      setBookmarkPopupWidth((prev) => clampBookmarkPopupWidth(prev));
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const stopResizing = () => {
      if (!bookmarkPopupResizeStateRef.current.active) return;
      bookmarkPopupResizeStateRef.current.active = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    const handleMouseMove = (event: MouseEvent) => {
      const state = bookmarkPopupResizeStateRef.current;
      if (!state.active) return;
      const delta = event.clientX - state.startX;
      setBookmarkPopupWidth(clampBookmarkPopupWidth(state.startWidth + delta));
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', stopResizing);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', stopResizing);
      stopResizing();
    };
  }, []);

  useEffect(() => {
    setPreviewModalOpen(false);
    setPreviewObject(null);
  }, [currentBucket, currentPrefix]);

  useEffect(() => {
    setSelectedPaths(new Set());
    setDropTargetPath(null);
    lastSelectionIndexRef.current = null;
  }, [currentBucket, currentPrefix, pageIndex]);

  useEffect(() => {
    if (!currentBucket) return;
    loadObjectsFirstPage(currentBucket, currentPrefix);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSize]);

  useEffect(() => {
    if (!createFolderModalOpen) return;
    setTimeout(() => createFolderInputRef.current?.focus(), 0);
  }, [createFolderModalOpen]);

  useEffect(() => {
    if (!createFileModalOpen) return;
    setTimeout(() => createFileInputRef.current?.focus(), 0);
  }, [createFileModalOpen]);

  useEffect(() => {
    if (!moveModalOpen) return;
    setTimeout(() => moveInputRef.current?.focus(), 0);
  }, [moveModalOpen]);

  useEffect(() => {
    if (!tableVisible) return;
    const el = tableViewportRef.current;
    if (!el) return;

    let raf = 0;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = Math.floor(entry.contentRect.width);
      if (!Number.isFinite(width) || width <= 0) return;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setColumnWidths((prev) => {
          const next = fitWidthsToContainer(prev, width);
          return next.every((w, i) => w === prev[i]) ? prev : next;
        });
      });
    });

    observer.observe(el);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [tableVisible]);

  useEffect(() => {
    const el = selectAllRef.current;
    if (!el) return;
    const total = objects.length;
    if (total <= 0) {
      el.indeterminate = false;
      return;
    }
    const selected = objects.reduce((count, obj) => count + (obj.path && selectedPaths.has(obj.path) ? 1 : 0), 0);
    el.indeterminate = selected > 0 && selected < total;
  }, [objects, selectedPaths]);

  useEffect(() => {
    if (!currentBucket) return;
    const off = EventsOn('transfer:update', (payload: any) => {
      const update = payload as any;
      if (update?.type !== 'upload' || update?.status !== 'success') return;
      if (update?.parentId && !update?.isGroup) return;
      if (update?.bucket !== currentBucket) return;
      if (typeof update?.key === 'string' && !update.key.startsWith(currentPrefix)) return;
      const marker = markerForPage(pageIndex);
      loadObjectsPage(currentBucket, currentPrefix, marker, pageIndex);
    });
    return () => off();
  }, [config, currentBucket, currentPrefix, pageIndex, pageMarkers, pageSize]);

  useEffect(() => {
    const off = EventsOn('objects:changed', (...args: any[]) => {
      if (!currentBucket) return;
      const currentPrefixNormalized = normalizePrefix(currentPrefix);

      for (const payload of args) {
        const bucket = normalizeBucketName(payload?.bucket || '');
        const prefix = normalizePrefix(payload?.prefix || '');
        if (bucket && bucket === currentBucket && prefix === currentPrefixNormalized) {
          handleRefresh();
          break;
        }
      }
    });

    return () => off();
  }, [config, currentBucket, currentPrefix, pageIndex, pageMarkers, pageSize]);

  // Close menus on click elsewhere
  useEffect(() => {
    const handleClick = () => {
      setContextMenu((prev) => (prev.visible ? { ...prev, visible: false } : prev));
      setBookmarkMenuOpen(false);
      setUploadMenuOpen(false);
      setCrumbPopover(null);
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  const loadBuckets = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await ListBuckets(config);
      setBuckets(result || []);
    } catch (err: any) {
      setError(err.message || "Failed to list buckets");
    } finally {
      setLoading(false);
    }
  };

  const resetPagination = () => {
    setPageIndex(1);
    setPageMarkers(['']);
    setPageHasNext(false);
    setKnownLastPage(null);
    setJumpToPage('');
  };

  const markerForPage = (page: number) => {
    if (page <= 1) return '';
    return pageMarkers[page - 1] ?? '';
  };

  const loadObjectsPage = async (bucket: string, prefix: string, marker: string, targetPage: number) => {
    setLoading(true);
    setError(null);
    try {
      const result = await ListObjectsPage(config, bucket, prefix, marker, pageSize);
      setObjects(result?.items || []);
      setPageIndex(targetPage);

      const hasNext = !!result?.isTruncated && !!result?.nextMarker;
      setPageHasNext(hasNext);

      setPageMarkers((prev) => {
        const next = [...prev];
        while (next.length < targetPage) next.push('');
        next[targetPage - 1] = marker;

        if (hasNext) {
          next[targetPage] = result.nextMarker;
        } else {
          next.length = Math.min(next.length, targetPage);
        }
        return next;
      });

      if (!hasNext) {
        setKnownLastPage(targetPage);
      }
    } catch (err: any) {
      setError(err.message || "Failed to list objects");
    } finally {
      setLoading(false);
    }
  };

  const loadObjectsFirstPage = (bucket: string, prefix: string) => {
    resetPagination();
    loadObjectsPage(bucket, prefix, '', 1);
  };

  const jumpToObjectsPage = async (targetPage: number) => {
    if (!currentBucket) return;
    if (targetPage < 1) return;

    if (knownLastPage !== null && targetPage > knownLastPage) {
      setError(`Page ${targetPage} is out of range.`);
      return;
    }

    const bucket = currentBucket;
    const prefix = currentPrefix;

    setLoading(true);
    setError(null);
    try {
      let markers = [...pageMarkers];
      let lastPage: number | null = knownLastPage;

      while (markers.length < targetPage) {
        const currentPage = markers.length;
        const pageMarker = markers[currentPage - 1] ?? '';
        const res = await ListObjectsPage(config, bucket, prefix, pageMarker, pageSize);
        const hasMore = !!res?.isTruncated && !!res?.nextMarker;
        if (!hasMore) {
          lastPage = currentPage;
          break;
        }
        markers.push(res.nextMarker);
      }

      if (markers.length < targetPage) {
        if (lastPage !== knownLastPage) {
          setKnownLastPage(lastPage);
        }
        throw new Error(`Page ${targetPage} is out of range.`);
      }

      const targetMarker = markers[targetPage - 1] ?? '';
      const result = await ListObjectsPage(config, bucket, prefix, targetMarker, pageSize);
      setObjects(result?.items || []);
      setPageIndex(targetPage);

      const hasNext = !!result?.isTruncated && !!result?.nextMarker;
      setPageHasNext(hasNext);

      if (hasNext) {
        markers[targetPage] = result.nextMarker;
      } else {
        lastPage = targetPage;
        markers = markers.slice(0, targetPage);
      }

      setPageMarkers(markers);
      if (!hasNext) {
        setKnownLastPage(targetPage);
      } else if (lastPage !== knownLastPage) {
        setKnownLastPage(lastPage);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to jump to page');
    } finally {
      setLoading(false);
    }
  };

  const navigateTo = (bucket: string, prefix: string, opts?: { pushHistory?: boolean }) => {
    const normalizedBucket = normalizeBucketName(bucket);
    const normalizedPrefix = normalizedBucket ? normalizePrefix(prefix) : '';

    if (!normalizedBucket) {
      setCurrentBucket('');
      setCurrentPrefix('');
      setObjects([]);
      resetPagination();
      loadBuckets();
    } else {
      setCurrentBucket(normalizedBucket);
      setCurrentPrefix(normalizedPrefix);
      loadObjectsFirstPage(normalizedBucket, normalizedPrefix);
    }

    onLocationChange?.({ bucket: normalizedBucket, prefix: normalizedPrefix });

    if (opts?.pushHistory === false) return;
    const nextLoc: NavLocation = { bucket: normalizedBucket, prefix: normalizedPrefix };

    setNavState((prev) => {
      const current = prev.stack[prev.index];
      if (current && current.bucket === nextLoc.bucket && current.prefix === nextLoc.prefix) return prev;
      const truncated = prev.stack.slice(0, prev.index + 1);
      truncated.push(nextLoc);
      return { stack: truncated, index: truncated.length - 1 };
    });
  };

  const handleBucketClick = (bucketName: string) => {
    navigateTo(bucketName, '');
  };

  const handleFolderClick = (folderName: string) => {
    const newPrefix = currentPrefix + folderName + '/';
    navigateTo(currentBucket, newPrefix);
  };

  const canGoBack = navState.index > 0;
  const canGoForward = navState.index < navState.stack.length - 1;

  const handleGoBack = () => {
    if (!canGoBack) return;
    const nextIndex = navState.index - 1;
    const target = navState.stack[nextIndex];
    setNavState((prev) => ({ ...prev, index: nextIndex }));
    navigateTo(target.bucket, target.prefix, { pushHistory: false });
  };

  const handleGoForward = () => {
    if (!canGoForward) return;
    const nextIndex = navState.index + 1;
    const target = navState.stack[nextIndex];
    setNavState((prev) => ({ ...prev, index: nextIndex }));
    navigateTo(target.bucket, target.prefix, { pushHistory: false });
  };

  const handleGoUp = () => {
    if (!currentBucket) return;

    if (currentPrefix === '') {
      navigateTo('', '');
      return;
    }

    const parts = currentPrefix.split('/').filter((p) => p);
    parts.pop();
    const newPrefix = parts.length > 0 ? parts.join('/') + '/' : '';
    navigateTo(currentBucket, newPrefix);
  };

  const handleRefresh = () => {
    if (!currentBucket) {
      loadBuckets();
      return;
    }
    const marker = markerForPage(pageIndex);
    loadObjectsPage(currentBucket, currentPrefix, marker, pageIndex);
  };

  const handlePrevPage = () => {
    if (!currentBucket) return;
    if (pageIndex <= 1) return;
    const target = pageIndex - 1;
    loadObjectsPage(currentBucket, currentPrefix, markerForPage(target), target);
  };

  const handleNextPage = () => {
    if (!currentBucket) return;
    if (!pageHasNext) return;
    const target = pageIndex + 1;
    const marker = markerForPage(target);
    if (!marker) return;
    loadObjectsPage(currentBucket, currentPrefix, marker, target);
  };

  const handleJumpSubmit = () => {
    const value = parseInt(jumpToPage, 10);
    if (!Number.isFinite(value) || value < 1) return;
    jumpToObjectsPage(value);
  };

  const startColumnResize = (boundaryIndex: number, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (boundaryIndex < 0 || boundaryIndex >= columnWidths.length - 1) return;

    const startX = e.clientX;
    const startWidths = [...columnWidths];

    const handleMove = (ev: PointerEvent) => {
      const delta = ev.clientX - startX;
      const a = boundaryIndex;
      const b = boundaryIndex + 1;
      const total = startWidths[a] + startWidths[b];

      const minA = MIN_TABLE_COLUMN_WIDTHS[a] ?? 80;
      const minB = MIN_TABLE_COLUMN_WIDTHS[b] ?? 80;

      let nextA = startWidths[a] + delta;
      nextA = Math.max(minA, Math.min(total - minB, nextA));
      const nextB = total - nextA;

      setColumnWidths((prev) => {
        const next = [...prev];
        next[a] = nextA;
        next[b] = nextB;
        return next;
      });
    };

    const stop = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', stop);
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', stop);
  };

  const handleBreadcrumbClick = (index: number) => {
      if (index === -1) {
          navigateTo('', '');
          return;
      }
      
      if (index === 0) {
          navigateTo(currentBucket, '');
          return;
      }
      
      const parts = currentPrefix.split('/').filter(p => p);
      const newParts = parts.slice(0, index);
      const newPrefix = newParts.join('/') + '/';
      navigateTo(currentBucket, newPrefix);
  };

  // Generate current OSS path
  const getCurrentOssPath = () => {
    const bucket = normalizeBucketName(currentBucket);
    const prefix = normalizePrefix(currentPrefix);
    if (!bucket) return 'oss://';
    if (!prefix) return `oss://${bucket}/`;
    return `oss://${bucket}/${prefix}`;
  };

  // Parse OSS path and navigate
  const parseAndNavigateOssPath = (path: string) => {
    const trimmed = path.trim();
    
    // Handle oss:// prefix
    let pathToParse = trimmed;
    if (pathToParse.startsWith('oss://')) {
      pathToParse = pathToParse.substring(6);
    }
    pathToParse = pathToParse.replace(/^\/+/, '');
    
    // If empty, go to bucket list
    if (!pathToParse || pathToParse === '/') {
      navigateTo('', '');
      return;
    }
    
    // Split into bucket and prefix
    const parts = pathToParse.split('/');
    const bucket = normalizeBucketName(parts[0] || '');
    const prefix = parts.slice(1).filter(p => p).join('/');
    const normalizedPrefix = normalizePrefix(prefix);

    if (!bucket) {
      navigateTo('', '');
      return;
    }

    navigateTo(bucket, normalizedPrefix);
  };

  const handleAddressBarClick = () => {
    setAddressBarValue(getCurrentOssPath());
    setAddressBarEditing(true);
    setTimeout(() => addressInputRef.current?.select(), 0);
  };

  const handleAddressBarSubmit = () => {
    setAddressBarEditing(false);
    parseAndNavigateOssPath(addressBarValue);
  };

  const handleAddressBarKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleAddressBarSubmit();
    } else if (e.key === 'Escape') {
      setAddressBarEditing(false);
    }
  };

  const handleAddressBarBlur = () => {
    setAddressBarEditing(false);
  };

  const handleAddBookmark = () => {
    if (!profileName || !currentBucket) return;

    const normalizedPrefix = currentPrefix.endsWith('/') ? currentPrefix : currentPrefix + (currentPrefix ? '/' : '');
    const labelSource = normalizedPrefix.replace(/\/$/, '');
    const fallbackLabel = normalizedPrefix ? labelSource.split('/').filter(Boolean).pop() : currentBucket;
    const label = fallbackLabel || currentBucket;

    const newBookmark: Bookmark = {
      id: `bm-${Date.now()}`,
      bucket: currentBucket,
      prefix: normalizedPrefix,
      label,
    };

    setBookmarks((prev) => {
      const exists = prev.some((b) => b.bucket === newBookmark.bucket && b.prefix === newBookmark.prefix);
      const updated = exists ? prev : [...prev, newBookmark];
      persistBookmarks(updated);
      return updated;
    });
  };

  const currentPrefixNormalized = currentPrefix.endsWith('/') ? currentPrefix : currentPrefix + (currentPrefix ? '/' : '');
  const isCurrentBookmarked = !!(profileName && currentBucket && bookmarks.some((b) => b.bucket === currentBucket && b.prefix === currentPrefixNormalized));

  const handleToggleBookmarkMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!profileName) return;
    setContextMenu((prev) => (prev.visible ? { ...prev, visible: false } : prev));
    setBookmarkMenuOpen((v) => !v);
  };

  const handleBookmarkPopupResizeStart = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    bookmarkPopupResizeStateRef.current = {
      active: true,
      startX: e.clientX,
      startWidth: bookmarkPopupWidth,
    };
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  };

  const handleBookmarkClick = (bookmark: Bookmark) => {
    const bucket = normalizeBucketName(bookmark.bucket);
    const prefix = normalizePrefix(bookmark.prefix);
    navigateTo(bucket, prefix);
  };

  const handleRemoveBookmark = (id: string) => {
    setBookmarks((prev) => {
      const updated = prev.filter((b) => b.id !== id);
      persistBookmarks(updated);
      return updated;
    });
  };

  const handleContextMenu = (e: React.MouseEvent, obj: main.ObjectInfo) => {
    e.preventDefault();
    setContextMenu({
      visible: true,
      x: e.pageX,
      y: e.pageY,
      object: obj,
    });
  };

  const parseObjectPath = (path: string) => {
    let p = (path || '').trim();
    if (!p.startsWith('oss://')) return null;
    p = p.substring(6);
    p = p.replace(/^\/+/, '');
    if (!p) return null;

    const parts = p.split('/');
    const bucket = normalizeBucketName(parts[0] || '');
    if (!bucket) return null;
    const key = parts.slice(1).join('/');
    return { bucket, key };
  };

  const clearSelection = () => {
    setSelectedPaths(new Set());
    lastSelectionIndexRef.current = null;
  };

  const objectNameForKey = (name: string) => (name || '').replace(/\/+$/, '');

  const moveDragPayload = async (payload: OssDragPayload, destBucket: string, destPrefix: string) => {
    if (!payload.items.length) return;
    if (!destBucket) return;

    const normalizedDestPrefix = normalizePrefix(destPrefix);
    setOperationLoading(true);
    try {
      for (const item of payload.items) {
        const parsed = parseObjectPath(item.path);
        if (!parsed?.bucket) continue;
        const srcBucket = parsed.bucket;
        const srcKey = parsed.key;
        const cleanName = objectNameForKey(item.name);
        const destKey = `${normalizedDestPrefix || ''}${cleanName}${item.isFolder ? '/' : ''}`;

        if (srcBucket === destBucket && srcKey === destKey) continue;

        if (item.isFolder && srcBucket === destBucket) {
          const srcKeyFolder = srcKey.endsWith('/') ? srcKey : `${srcKey}/`;
          if (destKey.startsWith(srcKeyFolder)) {
            throw new Error('Cannot move a folder into itself.');
          }
        }

        await MoveObject(config, srcBucket, srcKey, destBucket, destKey);
      }

      const sourceBucket = normalizeBucketName(payload.source?.bucket || currentBucket);
      const sourcePrefix = normalizePrefix(payload.source?.prefix || currentPrefix);
      EventsEmit('objects:changed', { bucket: sourceBucket, prefix: sourcePrefix }, { bucket: destBucket, prefix: normalizedDestPrefix });

      clearSelection();
      handleRefresh();
    } catch (err: any) {
      alert('Move failed: ' + (err?.message || String(err)));
    } finally {
      setOperationLoading(false);
      setDropTargetPath(null);
    }
  };

  const handleObjectDragStart = (e: React.DragEvent, obj: main.ObjectInfo) => {
    if (operationLoading) {
      e.preventDefault();
      return;
    }
    if (!obj.path || !currentBucket) {
      e.preventDefault();
      return;
    }

    const objPath = obj.path;
    const isSelected = selectedPaths.has(objPath);
    const candidates = isSelected ? objects.filter((o) => !!o.path && selectedPaths.has(o.path)) : [obj];
    const items = candidates
      .filter((o) => !!o.path)
      .map((o) => ({
        path: o.path as string,
        name: objectNameForKey(o.name),
        isFolder: isFolder(o),
      }));

    if (items.length === 0) {
      e.preventDefault();
      return;
    }

    e.dataTransfer.effectAllowed = 'move';
    writeOssDragPayload(e.dataTransfer, {
      type: 'walioss-oss-objects',
      source: { bucket: currentBucket, prefix: currentPrefix },
      items,
    });
  };

  const handleObjectDragEnd = () => {
    setDropTargetPath(null);
  };

  const handleRowDragOver = (e: React.DragEvent, obj: main.ObjectInfo) => {
    if (!isFolder(obj)) return;
    if (!canReadOssDragPayload(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleRowDragEnter = (e: React.DragEvent, obj: main.ObjectInfo) => {
    if (!isFolder(obj) || !obj.path) return;
    if (!canReadOssDragPayload(e.dataTransfer)) return;
    e.preventDefault();
    setDropTargetPath(obj.path);
  };

  const handleRowDragLeave = (e: React.DragEvent, obj: main.ObjectInfo) => {
    if (!isFolder(obj) || !obj.path) return;
    const related = e.relatedTarget as Node | null;
    if (related && e.currentTarget.contains(related)) return;
    setDropTargetPath((prev) => (prev === obj.path ? null : prev));
  };

  const handleRowDrop = async (e: React.DragEvent, obj: main.ObjectInfo) => {
    if (!currentBucket) return;
    if (!isFolder(obj)) return;

    const payload = readOssDragPayload(e.dataTransfer);
    if (!payload) return;

    e.preventDefault();
    e.stopPropagation();

    const folderName = objectNameForKey(obj.name);
    if (!folderName) return;

    const destPrefix = normalizePrefix(`${currentPrefix}${folderName}`);
    await moveDragPayload(payload, currentBucket, destPrefix);
  };

  const handleTableDragOver = (e: React.DragEvent) => {
    if (!currentBucket) return;
    if (!canReadOssDragPayload(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleTableDrop = (e: React.DragEvent) => {
    if (!currentBucket) return;
    const payload = readOssDragPayload(e.dataTransfer);
    if (!payload) return;

    e.preventDefault();
    e.stopPropagation();
    void moveDragPayload(payload, currentBucket, currentPrefix);
  };

  const handlePreview = (obj?: main.ObjectInfo) => {
    const target = obj || contextMenu.object;
    if (!target || !currentBucket || isFolder(target)) return;
    setPreviewObject(target);
    setPreviewModalOpen(true);
    setContextMenu((prev) => ({ ...prev, visible: false }));
  };

  const enqueueLocalUploadPaths = async (paths: string[]) => {
    if (!currentBucket) return;
    const cleaned = paths.map((p) => (p || '').trim()).filter((p) => !!p);
    if (cleaned.length === 0) return;
    await enqueueUploadWithRenamePrompt(config, currentBucket, currentPrefix, cleaned);
  };

  const handleUploadFile = async () => {
    try {
      const filePath = await SelectFile();
      setUploadMenuOpen(false);
      if (!filePath) return;
      await enqueueLocalUploadPaths([filePath]);
    } catch (err: any) {
      setError(err?.message || "Upload failed");
    }
  };

  const handleUploadFolder = async () => {
    try {
      const dirPath = await SelectDirectory('Select Folder to Upload');
      setUploadMenuOpen(false);
      if (!dirPath) return;
      await enqueueLocalUploadPaths([dirPath]);
    } catch (err: any) {
      setError(err?.message || "Upload folder failed");
    }
  };

  const requestCreateFolder = () => {
    if (!currentBucket) return;
    setNewFolderName('');
    setCreateFolderModalOpen(true);
  };

  const requestCreateFile = () => {
    if (!currentBucket) return;
    setNewFileName('');
    setCreateFileModalOpen(true);
  };

  const confirmCreateFolder = async () => {
    if (!currentBucket) return;
    const name = newFolderName.trim();
    if (!name) return;

    setOperationLoading(true);
    try {
      await CreateFolder(config, currentBucket, currentPrefix, name);
      setCreateFolderModalOpen(false);
      setNewFolderName('');
      EventsEmit('objects:changed', { bucket: currentBucket, prefix: currentPrefix });
      handleRefresh();
    } catch (err: any) {
      alert('Create folder failed: ' + (err?.message || String(err)));
    } finally {
      setOperationLoading(false);
    }
  };

  const confirmCreateFile = async () => {
    if (!currentBucket) return;
    const rawName = newFileName.trim();
    const cleanName = rawName.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!cleanName) return;

    setOperationLoading(true);
    try {
      await CreateFile(config, currentBucket, currentPrefix, cleanName);
      setCreateFileModalOpen(false);
      setNewFileName('');
      EventsEmit('objects:changed', { bucket: currentBucket, prefix: currentPrefix });
      handleRefresh();

      const key = `${normalizePrefix(currentPrefix)}${cleanName}`;
      const displayName = cleanName.split('/').filter(Boolean).pop() || cleanName;
      setPreviewObject({
        name: displayName,
        path: `oss://${currentBucket}/${key}`,
        size: 0,
        type: 'File',
        lastModified: '',
        storageClass: '',
      });
      setPreviewModalOpen(true);
    } catch (err: any) {
      alert('Create file failed: ' + (err?.message || String(err)));
    } finally {
      setOperationLoading(false);
    }
  };

  const parseMoveDestination = (value: string) => {
    const trimmed = (value || '').trim();
    if (!trimmed) return null;

    if (trimmed.startsWith('oss://')) {
      let pathToParse = trimmed.substring(6);
      pathToParse = pathToParse.replace(/^\/+/, '');
      if (!pathToParse) return null;
      const parts = pathToParse.split('/');
      const bucket = normalizeBucketName(parts[0] || '');
      if (!bucket) return null;
      const prefix = normalizePrefix(parts.slice(1).filter(Boolean).join('/'));
      return { bucket, prefix };
    }

    if (!currentBucket) return null;

    if (trimmed.startsWith('/')) {
      const prefix = normalizePrefix(trimmed.replace(/^\/+/, ''));
      return { bucket: currentBucket, prefix };
    }

    const prefix = normalizePrefix(`${currentPrefix || ''}${trimmed}`);
    return { bucket: currentBucket, prefix };
  };

  const requestMoveTo = (targets: main.ObjectInfo[]) => {
    if (!targets.length) return;
    setMoveTargets(targets);
    setMoveDestValue(getCurrentOssPath());
    setMoveModalOpen(true);
  };

  const confirmMoveTo = async () => {
    if (!moveTargets.length) return;
    const dest = parseMoveDestination(moveDestValue);
    if (!dest?.bucket) {
      alert('Invalid destination path');
      return;
    }

    setOperationLoading(true);
    try {
      for (const obj of moveTargets) {
        const parsed = parseObjectPath(obj.path);
        if (!parsed?.bucket) continue;
        const srcBucket = parsed.bucket;
        const srcKey = parsed.key;
        const folder = isFolder(obj) || srcKey.endsWith('/');
        const destKey = `${dest.prefix || ''}${objectNameForKey(obj.name)}${folder ? '/' : ''}`;
        await MoveObject(config, srcBucket, srcKey, dest.bucket, destKey);
      }

      setMoveModalOpen(false);
      setMoveTargets([]);
      setMoveDestValue('');
      clearSelection();
      EventsEmit('objects:changed', { bucket: currentBucket, prefix: currentPrefix }, { bucket: dest.bucket, prefix: dest.prefix });
      handleRefresh();
    } catch (err: any) {
      alert('Move failed: ' + (err?.message || String(err)));
    } finally {
      setOperationLoading(false);
    }
  };

  const handleDownload = async (target?: main.ObjectInfo) => {
    const obj = target || contextMenu.object;
    if (!obj || !currentBucket) return;
    const parsed = parseObjectPath(obj.path);
    if (!parsed?.key) return;

    try {
      if (isFolder(obj)) {
        const dirPath = await SelectDirectory(`Download "${obj.name}" To`);
        if (!dirPath) return;
        await EnqueueDownloadFolder(config, currentBucket, parsed.key, dirPath);
      } else {
        const savePath = await SelectSaveFile(obj.name);
        if (!savePath) return;
        await EnqueueDownload(config, currentBucket, parsed.key, savePath, obj.size);
      }
    } catch (err: any) {
      alert("Download failed: " + err.message);
    }
  };

  const requestDelete = (targets: main.ObjectInfo[]) => {
    if (!targets.length) return;
    setDeleteTargets(targets);
    setDeleteModalOpen(true);
    setContextMenu((prev) => (prev.visible ? { ...prev, visible: false } : prev));
  };

  const handleDeleteClick = () => {
    const obj = contextMenu.object;
    if (!obj) return;
    requestDelete([obj]);
  };

  const confirmDelete = async () => {
    if (!deleteTargets.length) return;

    setOperationLoading(true);
    try {
      for (const obj of deleteTargets) {
        const parsed = parseObjectPath(obj.path);
        if (!parsed?.bucket) continue;
        await DeleteObject(config, parsed.bucket, parsed.key);
      }
      setDeleteModalOpen(false);
      setDeleteTargets([]);
      clearSelection();
      EventsEmit('objects:changed', { bucket: currentBucket, prefix: currentPrefix });
      handleRefresh();
    } catch (err: any) {
      alert("Delete failed: " + err.message);
    } finally {
      setOperationLoading(false);
    }
  };

  const handleCopyPath = () => {
    const obj = contextMenu.object;
    if (!obj) return;
    navigator.clipboard.writeText(obj.path);
    setContextMenu({ ...contextMenu, visible: false });
  };

  const handleOpenFolder = () => {
    const obj = contextMenu.object;
    if (!obj || !isFolder(obj)) return;
    handleFolderClick(obj.name);
    setContextMenu({ ...contextMenu, visible: false });
  };

  const handleShowProperties = () => {
    setPropertiesModalOpen(true);
    setContextMenu({ ...contextMenu, visible: false });
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const isFolder = (obj: main.ObjectInfo) => {
    // If explicitly marked as File, it's not a folder
    if (obj.type === 'File') return false;
    // If explicitly marked as Folder, it is a folder
    if (obj.type === 'Folder') return true;
    // Fallback: check if path/name ends with /
    return obj.path.endsWith('/') || obj.name.endsWith('/');
  };

  const applyRowSelectionChange = (obj: main.ObjectInfo, rowIndex: number, checked: boolean, shiftRange: boolean) => {
    if (!obj.path) return;
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      const last = lastSelectionIndexRef.current;

      if (shiftRange && last !== null && last >= 0 && last < objects.length) {
        const start = Math.min(last, rowIndex);
        const end = Math.max(last, rowIndex);
        for (let i = start; i <= end; i++) {
          const item = objects[i];
          if (!item?.path) continue;
          if (checked) next.add(item.path);
          else next.delete(item.path);
        }
      } else {
        if (checked) next.add(obj.path);
        else next.delete(obj.path);
      }
      return next;
    });
    lastSelectionIndexRef.current = rowIndex;
  };

  const ensureThumbUrl = useCallback(
    async (obj: main.ObjectInfo) => {
      if (!obj?.path) return;
      if (!currentBucket) return;
      if (!isImageObjectInfo(obj)) return;

      const cacheKey = obj.path;
      if (thumbUrlCacheRef.current.has(cacheKey)) return;
      if (thumbLoadingRef.current.has(cacheKey)) return;
      thumbLoadingRef.current.add(cacheKey);

      try {
        const ossPrefix = `oss://${currentBucket}/`;
        const key = obj.path.startsWith(ossPrefix) ? obj.path.slice(ossPrefix.length) : '';
        if (!key) return;

        const url = await PresignObject(config, currentBucket, key, '30m');
        if (!url) return;
        thumbUrlCacheRef.current.set(cacheKey, url);
        setThumbTick((t) => t + 1);
      } catch {
        // Ignore thumbnail failures and fall back to generic icons.
      } finally {
        thumbLoadingRef.current.delete(cacheKey);
      }
    },
    [config, currentBucket],
  );

  useEffect(() => {
    if (!currentBucket) return;
    const candidates = objects.filter((o) => o?.path && isImageObjectInfo(o)).slice(0, 40);
    for (const obj of candidates) {
      void ensureThumbUrl(obj);
    }
  }, [currentBucket, ensureThumbUrl, objects]);

  const guessType = (name: string, fallback: string) => {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const map: Record<string, string> = {
      mp4: 'Video',
      mov: 'Video',
      mkv: 'Video',
      wav: 'Audio',
      mp3: 'Audio',
      flac: 'Audio',
      png: 'Image',
      jpg: 'Image',
      jpeg: 'Image',
      gif: 'Image',
      webp: 'Image',
      pdf: 'Document',
      txt: 'Text',
      json: 'JSON',
      csv: 'CSV',
      zip: 'Archive',
      rar: 'Archive',
      gz: 'Archive',
    };
    return map[ext] || fallback;
  };

  const displayType = (obj: main.ObjectInfo) => {
    if (isFolder(obj)) return 'Folder';
    return guessType(obj.name, obj.type || 'File');
  };

  const clearCrumbPopoverCloseTimer = () => {
    if (crumbPopoverCloseTimerRef.current) {
      window.clearTimeout(crumbPopoverCloseTimerRef.current);
    }
    crumbPopoverCloseTimerRef.current = null;
  };

  const scheduleCloseCrumbPopover = (delayMs = 160) => {
    clearCrumbPopoverCloseTimer();
    crumbPopoverCloseTimerRef.current = window.setTimeout(() => {
      setCrumbPopover(null);
    }, delayMs);
  };

  useEffect(() => {
    return () => {
      clearCrumbPopoverCloseTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (addressBarEditing) {
      setCrumbPopover(null);
      clearCrumbPopoverCloseTimer();
    }
  }, [addressBarEditing]);

  const loadCrumbPopoverPage = async (requestId: number, bucket: string, prefix: string, marker: string, append: boolean) => {
    try {
      const res = await ListObjectsPage(config, bucket, prefix, marker, 120);
      if (crumbPopoverRequestIdRef.current !== requestId) return;

      const folders = (res?.items || []).filter((item) => isFolder(item));
      const hasMore = !!res?.isTruncated && !!res?.nextMarker;
      const nextMarker = hasMore ? res.nextMarker : '';

      setCrumbPopover((prev) => {
        if (!prev) return prev;
        if (prev.bucket !== bucket || prev.prefix !== prefix) return prev;

        const combined = append ? [...prev.items, ...folders] : folders;
        const seen = new Set<string>();
        const unique = combined.filter((it) => {
          const key = it.path || it.name;
          if (!key) return false;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        return {
          ...prev,
          items: unique,
          nextMarker,
          hasMore,
          loading: false,
          error: null,
        };
      });
    } catch (err: any) {
      if (crumbPopoverRequestIdRef.current !== requestId) return;
      setCrumbPopover((prev) =>
        prev
          ? {
              ...prev,
              loading: false,
              error: err?.message || 'Failed to load folders',
              hasMore: false,
              nextMarker: '',
            }
          : prev,
      );
    } finally {
      if (crumbPopoverFetchingRequestIdRef.current === requestId) {
        crumbPopoverFetchingRef.current = false;
      }
    }
  };

  const openCrumbPopover = (bucket: string, prefix: string, anchorEl: HTMLElement) => {
    if (addressBarEditing) return;
    bucket = normalizeBucketName(bucket);
    if (!bucket) return;
    prefix = normalizePrefix(prefix);

    const rect = anchorEl.getBoundingClientRect();
    const maxWidth = 360;
    const margin = 12;
    const x = Math.max(margin, Math.min(Math.round(rect.left), window.innerWidth - maxWidth - margin));
    const y = Math.max(margin, Math.round(rect.bottom + 8));

    const requestId = ++crumbPopoverRequestIdRef.current;
    crumbPopoverFetchingRef.current = true;
    crumbPopoverFetchingRequestIdRef.current = requestId;
    clearCrumbPopoverCloseTimer();
    setCrumbPopover({
      bucket,
      prefix,
      x,
      y,
      items: [],
      nextMarker: '',
      hasMore: false,
      loading: true,
      error: null,
    });

    void loadCrumbPopoverPage(requestId, bucket, prefix, '', false);
  };

  const handleCrumbPopoverScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (!crumbPopover || crumbPopover.loading || !crumbPopover.hasMore || !crumbPopover.nextMarker) return;
    if (crumbPopoverFetchingRef.current) return;
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 24) return;
    const requestId = crumbPopoverRequestIdRef.current;

    crumbPopoverFetchingRef.current = true;
    crumbPopoverFetchingRequestIdRef.current = requestId;
    setCrumbPopover((prev) => (prev ? { ...prev, loading: true } : prev));
    void loadCrumbPopoverPage(requestId, crumbPopover.bucket, crumbPopover.prefix, crumbPopover.nextMarker, true);
  };

	  const renderBreadcrumbs = () => {
	    const crumbs = [];
    const isRootActive = !currentBucket;
    crumbs.push(
      <span 
        key="root" 
        className={`crumb crumb-root ${isRootActive ? 'active' : ''}`} 
        title="All Buckets"
        onClick={(e) => {
          if (!isRootActive) {
            e.stopPropagation();
            handleBreadcrumbClick(-1);
          }
        }}
      >
        oss://
      </span>
    );

    if (currentBucket) {
      const bucketDisplay = normalizeBucketName(currentBucket);
      const isBucketActive = !currentPrefix;
      crumbs.push(
        <span 
          key="bucket" 
          className={`crumb crumb-bucket ${isBucketActive ? 'active' : ''}`} 
          onClick={(e) => {
            if (!isBucketActive) {
              e.stopPropagation();
              handleBreadcrumbClick(0);
            }
          }}
          onMouseEnter={(e) => openCrumbPopover(bucketDisplay, '', e.currentTarget)}
          onMouseLeave={() => scheduleCloseCrumbPopover()}
        >
          {bucketDisplay}
        </span>
      );

      if (currentPrefix) {
        const parts = currentPrefix.split('/').filter(p => p);
        parts.forEach((part, index) => {
          crumbs.push(<span key={`sep-${index}`} className="separator">/</span>);
          const isLast = index === parts.length - 1;
          const partPrefix = parts.slice(0, index + 1).join('/') + '/';
          crumbs.push(
            <span 
                key={`part-${index}`} 
                className={`crumb ${isLast ? 'active' : ''}`}
                onClick={(e) => {
                  if (!isLast) {
                    e.stopPropagation();
                    handleBreadcrumbClick(index + 1);
                  }
                }}
                onMouseEnter={(e) => openCrumbPopover(bucketDisplay, partPrefix, e.currentTarget)}
                onMouseLeave={() => scheduleCloseCrumbPopover()}
            >
              {part}
            </span>
          );
        });
      }
    }
	    return crumbs;
	  };

	  const selectedObjects = objects.filter((obj) => !!obj.path && selectedPaths.has(obj.path));
	  const selectedCount = selectedObjects.length;
	  const allSelectedOnPage = objects.length > 0 && selectedCount === objects.length;
	  const previewableFiles = objects.filter((obj) => !isFolder(obj));
	  const previewIndex =
	    previewObject?.path ? previewableFiles.findIndex((obj) => obj.path === previewObject.path) : -1;

	  const handlePreviewNavigate = (direction: -1 | 1) => {
	    if (previewIndex < 0) return;
	    const target = previewableFiles[previewIndex + direction];
	    if (!target) return;
	    setPreviewObject(target);
	    setPreviewModalOpen(true);
	  };

	  return (
	    <div className="file-browser">
	      <div className="browser-header">
	        <div className="nav-controls">
          <div className="bookmark-toggle">
            <button
              className={`bookmark-icon-btn ${isCurrentBookmarked ? 'active' : ''}`}
              onClick={handleAddBookmark}
              disabled={!currentBucket || !profileName}
              title={profileName ? (isCurrentBookmarked ? 'Bookmarked' : 'Add bookmark') : 'Save connection as profile to enable bookmarks'}
            >
              {isCurrentBookmarked ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
              ) : (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                >
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
              )}
            </button>
            <button
              className="bookmark-icon-btn"
              onClick={handleToggleBookmarkMenu}
              disabled={!profileName}
              title="Bookmarks"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h16v2H4v-2z" />
              </svg>
            </button>
            {bookmarkMenuOpen && (
              <div
                className="bookmark-popup"
                onClick={(e) => e.stopPropagation()}
                style={{ width: `${bookmarkPopupWidth}px` }}
              >
                <div className="bookmark-popup-title">Bookmarks</div>
                {bookmarks.length === 0 ? (
                  <div className="bookmark-popup-empty">No bookmarks</div>
                ) : (
                  <div className="bookmark-popup-list">
                    {bookmarks.map((bm) => (
                      <div
                        key={bm.id}
                        className="bookmark-popup-item"
                        onClick={() => {
                          handleBookmarkClick(bm);
                          setBookmarkMenuOpen(false);
                        }}
                        title={`oss://${bm.bucket}/${bm.prefix}`}
                      >
                        <div className="bookmark-popup-main">
                          <div className="bookmark-popup-label">{bm.label}</div>
                          <div className="bookmark-popup-path">{`oss://${bm.bucket}/${bm.prefix}`}</div>
                        </div>
                        <button
                          className="bookmark-popup-remove"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRemoveBookmark(bm.id);
                          }}
                          title="Remove bookmark"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
	                <div
	                  className="bookmark-popup-resizer"
	                  onMouseDown={handleBookmarkPopupResizeStart}
	                  title="Drag to resize"
	                />
	              </div>
	            )}
          </div>
          <button className="nav-btn" onClick={handleGoBack} disabled={!canGoBack} title="Back">←</button>
          <button className="nav-btn" onClick={handleGoForward} disabled={!canGoForward} title="Forward">→</button>
          <button className="nav-btn" onClick={handleGoUp} disabled={!currentBucket} title="Up">↑</button>
          <button className="nav-btn" onClick={handleRefresh} disabled={loading} title="Refresh">↻</button>
        </div>
	        <div className="breadcrumbs" onClick={!addressBarEditing ? handleAddressBarClick : undefined}>
	          {addressBarEditing ? (
	            <input
              ref={addressInputRef}
              type="text"
              className="address-input"
              value={addressBarValue}
              onChange={(e) => setAddressBarValue(e.target.value)}
              onKeyDown={handleAddressBarKeyDown}
              onBlur={handleAddressBarBlur}
              placeholder="oss://bucket/path/"
              autoFocus
            />
	          ) : (
	            renderBreadcrumbs()
	          )}
	        </div>

	        {crumbPopover && !addressBarEditing && (
	          <div
	            className="crumb-popover"
	            style={{ top: `${crumbPopover.y}px`, left: `${crumbPopover.x}px` }}
	            onMouseEnter={clearCrumbPopoverCloseTimer}
	            onMouseLeave={() => scheduleCloseCrumbPopover()}
	            onClick={(e) => e.stopPropagation()}
	          >
	            <div className="crumb-popover-title" title={`oss://${crumbPopover.bucket}/${crumbPopover.prefix}`}>
	              {crumbPopover.prefix ? crumbPopover.prefix : '/'}
	            </div>
	            <div className="crumb-popover-list" onScroll={handleCrumbPopoverScroll}>
	              {crumbPopover.items.map((folder) => (
	                <button
	                  key={folder.path || folder.name}
	                  className="crumb-popover-item"
	                  type="button"
	                  onClick={(e) => {
	                    e.stopPropagation();
	                    navigateTo(crumbPopover.bucket, `${crumbPopover.prefix}${folder.name}/`);
	                    setCrumbPopover(null);
	                  }}
	                  title={folder.name}
	                >
	                  <span className="crumb-popover-item-icon" aria-hidden="true">
	                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
	                      <path d="M3 7a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
	                    </svg>
	                  </span>
	                  <span className="crumb-popover-item-name">{folder.name}</span>
	                </button>
	              ))}

	              {!crumbPopover.loading && crumbPopover.error && (
	                <div className="crumb-popover-empty">{crumbPopover.error}</div>
	              )}

	              {!crumbPopover.loading && !crumbPopover.error && crumbPopover.items.length === 0 && (
	                <div className="crumb-popover-empty">No subfolders</div>
	              )}

	              {crumbPopover.loading && (
	                <div className="crumb-popover-loading">
	                  <span className="crumb-popover-loading-dot" />
	                  <span>Loading…</span>
	                </div>
	              )}
	            </div>
	          </div>
	        )}
	      </div>

	      {currentBucket && (
	        <div className="browser-actions-bar">
	          <div className="browser-actions-left">
	            <div className={`selection-pill ${selectedCount > 0 ? 'active' : ''}`}>
	              <span className="selection-label">{selectedCount > 0 ? `${selectedCount} selected` : 'No selection'}</span>
	              {selectedCount > 0 && (
	                <button className="mini-link" type="button" onClick={clearSelection}>
	                  Clear
	                </button>
	              )}
	            </div>
	          </div>
	          <div className="browser-actions-right">
              <div className="upload-menu-wrap">
                <button
                  className={`action-btn ${uploadMenuOpen ? 'active' : ''}`}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setUploadMenuOpen((v) => !v);
                  }}
                  title="Upload"
                >
                  Upload
                </button>
                {uploadMenuOpen && (
                  <div className="upload-menu" onClick={(e) => e.stopPropagation()}>
                    <button className="upload-menu-item" type="button" onClick={() => void handleUploadFile()}>
                      Upload File
                    </button>
                    <button className="upload-menu-item" type="button" onClick={() => void handleUploadFolder()}>
                      Upload Folder
                    </button>
                  </div>
                )}
              </div>
	            <button className="action-btn" type="button" onClick={requestCreateFolder} title="New Folder">
	              New Folder
	            </button>
	            <button className="action-btn" type="button" onClick={requestCreateFile} title="New File">
	              New File
	            </button>
	            <button className="action-btn" type="button" onClick={() => requestMoveTo(selectedObjects)} disabled={selectedCount === 0} title="Move To">
	              Move To
	            </button>
	            <button
	              className="action-btn danger"
	              type="button"
	              onClick={() => requestDelete(selectedObjects)}
	              disabled={selectedCount === 0}
	              title="Delete"
	            >
	              Delete
	            </button>
	          </div>
	        </div>
	      )}

	      <div
          className={`browser-content ${currentBucket ? 'browser-upload-dropzone' : ''}`.trim()}
          style={currentBucket ? ({ ['--wails-drop-target' as any]: 'drop' }) : undefined}
        >
	        {loading ? (
          <div className="loading-container">
            <div className="loading-spinner"></div>
            <p>Loading...</p>
          </div>
        ) : error ? (
	           <div className="empty-state">
	             <span className="empty-icon">⚠</span>
	             <p>{error}</p>
	             <button
	               className="btn btn-secondary"
	               onClick={() =>
	                 currentBucket ? loadObjectsPage(currentBucket, currentPrefix, markerForPage(pageIndex), pageIndex) : loadBuckets()
	               }
	             >
	               Retry
	             </button>
	           </div>
	        ) : !currentBucket ? (
            <div className={`bucket-grid ${buckets.length === 0 ? 'empty' : ''}`}>
              {buckets.length === 0 ? (
                <div className="empty-state">
                    <span className="empty-icon">🪣</span>
                    <p>No buckets found.</p>
                </div>
              ) : (
                buckets.map(bucket => (
                    <div key={bucket.name} className="bucket-item" onClick={() => handleBucketClick(bucket.name)}>
                    <div className="bucket-icon">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M4 10h16v10a2 2 0 01-2 2H6a2 2 0 01-2-2V10zm2-4h12l-2-4H8L6 6z"/>
                        </svg>
                    </div>
                    <div className="bucket-name">{bucket.name}</div>
                    <div className="bucket-info">
                        <span>{bucket.region}</span>
                        <span>{bucket.creationDate}</span>
                    </div>
                    </div>
                ))
              )}
            </div>
        ) : (
          objects.length === 0 ? (
             <div className="empty-state">
                <span className="empty-icon">📂</span>
                <p>Folder is empty.</p>
             </div>
	          ) : (
	            <div className="file-table-container" onDragOver={handleTableDragOver} onDrop={handleTableDrop}>
	              <div className="file-table-scroll" ref={tableViewportRef}>
	                <table className="file-table">
	                  <colgroup>
	                    {columnWidths.map((w, i) => (
	                      <col key={i} style={{ width: `${w}px` }} />
	                    ))}
		                  </colgroup>
		                  <thead>
			                    <tr>
			                      <th className="select-col">
			                        <label className="row-checkbox-hitbox" onClick={(e) => e.stopPropagation()}>
			                          <input
			                            ref={selectAllRef}
			                            type="checkbox"
			                            className="row-checkbox"
			                            checked={allSelectedOnPage}
			                            onPointerDown={(e) => e.stopPropagation()}
			                            onClick={(e) => e.stopPropagation()}
			                            onChange={(e) => {
			                              const checked = e.target.checked;
			                              setSelectedPaths((prev) => {
			                                const next = new Set(prev);
			                                for (const obj of objects) {
			                                  if (!obj.path) continue;
			                                  if (checked) next.add(obj.path);
			                                  else next.delete(obj.path);
			                                }
			                                return next;
			                              });
			                            }}
			                            aria-label="Select all"
			                            title="Select all"
			                          />
			                        </label>
			                      </th>
		                      <th className="resizable">
		                        <span className="th-label">Name</span>
		                        <div className="col-resizer" onPointerDown={(e) => startColumnResize(1, e)} />
		                      </th>
		                      <th className="resizable">
		                        <span className="th-label">Size</span>
		                        <div className="col-resizer" onPointerDown={(e) => startColumnResize(2, e)} />
		                      </th>
		                      <th className="resizable">
		                        <span className="th-label">Type</span>
		                        <div className="col-resizer" onPointerDown={(e) => startColumnResize(3, e)} />
		                      </th>
		                      <th className="resizable">
		                        <span className="th-label">Last Modified</span>
		                        <div className="col-resizer" onPointerDown={(e) => startColumnResize(4, e)} />
		                      </th>
		                      <th>
		                        <span className="th-label">Actions</span>
		                      </th>
		                    </tr>
		                  </thead>
		                  <tbody>
		                    {objects.map((obj, rowIndex) => (
		                      <tr
		                        key={obj.path || obj.name}
		                        className={`${obj.path && selectedPaths.has(obj.path) ? 'selected' : ''} ${dropTargetPath && obj.path === dropTargetPath ? 'drop-target' : ''}`.trim()}
		                        onClick={() => (isFolder(obj) ? handleFolderClick(obj.name) : handlePreview(obj))}
		                        onContextMenu={(e) => handleContextMenu(e, obj)}
		                        onDragOver={(e) => handleRowDragOver(e, obj)}
		                        onDragEnter={(e) => handleRowDragEnter(e, obj)}
		                        onDragLeave={(e) => handleRowDragLeave(e, obj)}
		                        onDrop={(e) => void handleRowDrop(e, obj)}
		                      >
			                        <td className="select-col">
			                          <label className="row-checkbox-hitbox" onClick={(e) => e.stopPropagation()}>
			                            <input
			                              type="checkbox"
			                              className="row-checkbox"
			                              checked={!!obj.path && selectedPaths.has(obj.path)}
			                              onPointerDown={(e) => {
			                                checkboxPointerShiftRef.current = !!e.shiftKey;
			                                e.stopPropagation();
			                              }}
			                              onClick={(e) => e.stopPropagation()}
			                              onChange={(e) => {
			                                const checked = e.target.checked;
			                                const shiftRange = checkboxPointerShiftRef.current || shiftPressedRef.current;
			                                checkboxPointerShiftRef.current = false;
			                                applyRowSelectionChange(obj, rowIndex, checked, shiftRange);
			                              }}
			                              aria-label={`Select ${obj.name}`}
			                              title="Select"
			                            />
			                          </label>
			                        </td>
		                        <td className="file-name-td">
			                          <div
			                            className="file-name-cell"
			                            draggable={!!obj.path && !operationLoading}
			                            onDragStart={(e) => handleObjectDragStart(e, obj)}
			                            onDragEnd={handleObjectDragEnd}
			                            title="Drag to move"
			                          >
			                            <div
			                              className={`file-icon ${isFolder(obj) ? 'folder-icon' : 'item-icon'}`}
			                              onMouseEnter={() => {
			                                if (!isImageObjectInfo(obj)) return;
			                                void ensureThumbUrl(obj);
			                              }}
			                            >
			                               {isFolder(obj) ? (
			                                 <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
		                                   <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
		                                 </svg>
		                               ) : isImageObjectInfo(obj) ? (
		                                 thumbUrlCacheRef.current.get(obj.path) ? (
		                                   <img
		                                     className="file-thumb"
		                                     src={thumbUrlCacheRef.current.get(obj.path)}
		                                     alt=""
		                                     aria-hidden="true"
		                                     draggable={false}
		                                     loading="lazy"
		                                     onError={() => {
		                                       if (!obj.path) return;
		                                       thumbUrlCacheRef.current.delete(obj.path);
		                                       setThumbTick((t) => t + 1);
		                                     }}
		                                   />
		                                 ) : (
		                                   <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
		                                     <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
		                                   </svg>
		                                 )
		                               ) : (
		                                 <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
		                                   <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
		                                 </svg>
		                               )}
			                            </div>
	                            <span className="file-name-text">{obj.name}</span>
	                          </div>
	                        </td>
	                        <td>{!isFolder(obj) ? formatSize(obj.size) : '-'}</td>
	                        <td>{displayType(obj)}</td>
	                        <td>{obj.lastModified || '-'}</td>
	                        <td className="file-actions-td">
	                          <div className="file-actions">
	                            {isFolder(obj) ? (
                                <>
                                  <button
                                    className="link-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleFolderClick(obj.name);
                                    }}
                                  >
                                    Open
                                  </button>
                                  <button
                                    className="link-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleDownload(obj);
                                    }}
                                  >
                                    Download
                                  </button>
                                </>
	                            ) : (
	                              <>
	                                <button
	                                  className="link-btn"
	                                  onClick={(e) => {
	                                    e.stopPropagation();
	                                    handlePreview(obj);
	                                  }}
	                                >
	                                  Preview
	                                </button>
	                                <button
	                                  className="link-btn"
	                                  onClick={(e) => {
	                                    e.stopPropagation();
	                                    handleDownload(obj);
	                                  }}
	                                >
	                                  Download
	                                </button>
	                              </>
	                            )}
	                          </div>
	                        </td>
	                      </tr>
	                    ))}
	                  </tbody>
	                </table>
	              </div>
	              <div className="file-table-footer">
	                <div className="page-status">
	                  Page {pageIndex}
	                  {knownLastPage ? ` / ${knownLastPage}` : ''}
	                </div>
	                <div className="page-controls">
	                  <button className="page-btn" onClick={handlePrevPage} disabled={loading || pageIndex <= 1}>
	                    Prev
	                  </button>
	                  <button className="page-btn" onClick={handleNextPage} disabled={loading || !pageHasNext}>
	                    Next
	                  </button>
	                  <div className="page-jump">
	                    <input
	                      className="page-jump-input"
	                      type="number"
	                      min="1"
	                      inputMode="numeric"
	                      value={jumpToPage}
	                      onChange={(e) => setJumpToPage(e.target.value)}
	                      onKeyDown={(e) => {
	                        if (e.key === 'Enter') handleJumpSubmit();
	                      }}
	                      placeholder="Page"
	                      disabled={loading}
	                    />
	                    <button className="page-btn" onClick={handleJumpSubmit} disabled={loading || !jumpToPage.trim()}>
	                      Go
	                    </button>
	                  </div>
	                  <select
	                    className="page-size-select"
	                    value={pageSize}
	                    onChange={(e) => {
	                      const next = parseInt(e.target.value, 10);
	                      if (!Number.isFinite(next) || next <= 0) return;
	                      setPageSize(next);
	                    }}
	                    disabled={loading}
	                    title="Page size"
	                  >
	                    <option value={100}>100 / page</option>
	                    <option value={200}>200 / page</option>
	                    <option value={500}>500 / page</option>
	                    <option value={1000}>1000 / page</option>
	                  </select>
	                </div>
	              </div>
	            </div>
	          )
	        )}
      </div>

	      {contextMenu.visible && (
	        <div 
	          className="context-menu" 
	          style={{ top: contextMenu.y, left: contextMenu.x }}
	        >
          {contextMenu.object && isFolder(contextMenu.object) && (
            <div className="context-menu-item" onClick={handleOpenFolder}>
              <span className="context-menu-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
                </svg>
              </span>
              Open
            </div>
          )}
          {contextMenu.object && isFolder(contextMenu.object) && (
            <div className="context-menu-item" onClick={() => handleDownload()}>
              <span className="context-menu-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                </svg>
              </span>
              Download
            </div>
          )}
          {contextMenu.object && !isFolder(contextMenu.object) && (
            <div className="context-menu-item" onClick={() => handlePreview()}>
              <span className="context-menu-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 5c-7.633 0-10 7-10 7s2.367 7 10 7 10-7 10-7-2.367-7-10-7zm0 12c-2.761 0-5-2.239-5-5s2.239-5 5-5 5 2.239 5 5-2.239 5-5 5zm0-8a3 3 0 100 6 3 3 0 000-6z"/>
                </svg>
              </span>
              Preview
            </div>
          )}
          {contextMenu.object && !isFolder(contextMenu.object) && (
            <div className="context-menu-item" onClick={() => handleDownload()}>
              <span className="context-menu-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                </svg>
              </span>
              Download
            </div>
          )}
          <div className="context-menu-divider" />
          <div className="context-menu-item" onClick={handleCopyPath}>
            <span className="context-menu-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
              </svg>
            </span>
            Copy Path
          </div>
          <div className="context-menu-item" onClick={handleShowProperties}>
            <span className="context-menu-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M11 17h2v-6h-2v6zm1-15C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zM11 9h2V7h-2v2z"/>
              </svg>
            </span>
            Properties
          </div>
          <div className="context-menu-divider" />
          <div className="context-menu-item danger" onClick={handleDeleteClick}>
            <span className="context-menu-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
              </svg>
            </span>
            Delete
	          </div>
	        </div>
	      )}

	      {createFolderModalOpen && (
	        <div className="modal-overlay" onClick={() => setCreateFolderModalOpen(false)}>
	          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
	            <div className="modal-header">
	              <h3 className="modal-title">New Folder</h3>
	            </div>
	            <p className="modal-description">Create a folder under the current path.</p>
	            <input
	              ref={createFolderInputRef}
	              className="modal-input"
	              type="text"
	              value={newFolderName}
	              onChange={(e) => setNewFolderName(e.target.value)}
	              onKeyDown={(e) => {
	                if (e.key === 'Enter') void confirmCreateFolder();
	                if (e.key === 'Escape') setCreateFolderModalOpen(false);
	              }}
	              placeholder="Folder name"
	              disabled={operationLoading}
	            />
	            <div className="modal-actions">
	              <button className="modal-btn modal-btn-cancel" type="button" onClick={() => setCreateFolderModalOpen(false)} disabled={operationLoading}>
	                Cancel
	              </button>
	              <button
	                className="modal-btn modal-btn-primary"
	                type="button"
	                onClick={() => void confirmCreateFolder()}
	                disabled={operationLoading || !newFolderName.trim()}
	              >
	                {operationLoading ? 'Creating…' : 'Create'}
	              </button>
	            </div>
	          </div>
	        </div>
	      )}

	      {createFileModalOpen && (
	        <div className="modal-overlay" onClick={() => setCreateFileModalOpen(false)}>
	          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
	            <div className="modal-header">
	              <h3 className="modal-title">New File</h3>
	            </div>
	            <p className="modal-description">Create an empty file under the current path.</p>
	            <input
	              ref={createFileInputRef}
	              className="modal-input"
	              type="text"
	              value={newFileName}
	              onChange={(e) => setNewFileName(e.target.value)}
	              onKeyDown={(e) => {
	                if (e.key === 'Enter') void confirmCreateFile();
	                if (e.key === 'Escape') setCreateFileModalOpen(false);
	              }}
	              placeholder="File name (e.g. README.md)"
	              disabled={operationLoading}
	            />
	            <div className="modal-actions">
	              <button className="modal-btn modal-btn-cancel" type="button" onClick={() => setCreateFileModalOpen(false)} disabled={operationLoading}>
	                Cancel
	              </button>
	              <button
	                className="modal-btn modal-btn-primary"
	                type="button"
	                onClick={() => void confirmCreateFile()}
	                disabled={operationLoading || !newFileName.trim()}
	              >
	                {operationLoading ? 'Creating…' : 'Create'}
	              </button>
	            </div>
	          </div>
	        </div>
	      )}

	      {moveModalOpen && (
	        <div className="modal-overlay" onClick={() => setMoveModalOpen(false)}>
	          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
	            <div className="modal-header">
	              <h3 className="modal-title">Move To</h3>
	            </div>
	            <p className="modal-description">Destination folder (supports `oss://bucket/path/`, `/path/` or `relative/path/`).</p>
	            <input
	              ref={moveInputRef}
	              className="modal-input mono"
	              type="text"
	              value={moveDestValue}
	              onChange={(e) => setMoveDestValue(e.target.value)}
	              onKeyDown={(e) => {
	                if (e.key === 'Enter') void confirmMoveTo();
	                if (e.key === 'Escape') setMoveModalOpen(false);
	              }}
	              placeholder="oss://bucket/path/"
	              disabled={operationLoading}
	            />
	            <div className="modal-actions">
	              <button className="modal-btn modal-btn-cancel" type="button" onClick={() => setMoveModalOpen(false)} disabled={operationLoading}>
	                Cancel
	              </button>
	              <button
	                className="modal-btn modal-btn-primary"
	                type="button"
	                onClick={() => void confirmMoveTo()}
	                disabled={operationLoading || !moveDestValue.trim()}
	              >
	                {operationLoading ? 'Moving…' : 'Move'}
	              </button>
	            </div>
	          </div>
	        </div>
	      )}

	      <FilePreviewModal
	        isOpen={previewModalOpen}
	        config={config}
	        bucket={currentBucket}
	        object={previewObject}
	        onClose={() => setPreviewModalOpen(false)}
	        onDownload={(obj) => handleDownload(obj)}
	        onSaved={() => currentBucket && loadObjectsPage(currentBucket, currentPrefix, markerForPage(pageIndex), pageIndex)}
	        onNavigate={handlePreviewNavigate}
          onNotify={onNotify}
	      />

      {/* Properties Modal */}
      {propertiesModalOpen && contextMenu.object && (
        <div className="modal-overlay" onClick={() => setPropertiesModalOpen(false)}>
          <div className="modal-content properties-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Properties</h3>
            </div>
            <div className="properties-body">
              <div className="property-row">
                <span className="property-label">Name</span>
                <span className="property-value">{contextMenu.object.name}</span>
              </div>
              <div className="property-row">
                <span className="property-label">Path</span>
                <span className="property-value mono">{contextMenu.object.path}</span>
              </div>
              <div className="property-row">
                <span className="property-label">Type</span>
                <span className="property-value">{displayType(contextMenu.object)}</span>
              </div>
              {!isFolder(contextMenu.object) && (
                <>
                  <div className="property-row">
                    <span className="property-label">Size</span>
                    <span className="property-value">{formatSize(contextMenu.object.size)}</span>
                  </div>
                  <div className="property-row">
                    <span className="property-label">Storage Class</span>
                    <span className="property-value">{contextMenu.object.storageClass || '-'}</span>
                  </div>
                </>
              )}
              <div className="property-row">
                <span className="property-label">Last Modified</span>
                <span className="property-value">{contextMenu.object.lastModified || '-'}</span>
              </div>
            </div>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-cancel" onClick={() => setPropertiesModalOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

	      <ConfirmationModal
	        isOpen={deleteModalOpen}
	        title={deleteTargets.length > 1 ? `Delete ${deleteTargets.length} items` : 'Delete Object'}
	        description={
	          deleteTargets.length > 1
	            ? `Are you sure you want to delete ${deleteTargets.length} items?`
	            : `Are you sure you want to delete "${deleteTargets[0]?.name || ''}"?`
	        }
	        onConfirm={confirmDelete}
	        onCancel={() => {
	          setDeleteModalOpen(false);
	          setDeleteTargets([]);
	        }}
	        isLoading={operationLoading}
	      />
    </div>
  );
}

export default FileBrowser;
