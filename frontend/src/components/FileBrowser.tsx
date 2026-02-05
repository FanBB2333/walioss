import { useState, useEffect, useRef } from 'react';
import { main } from '../../wailsjs/go/models';
import { DeleteObject, EnqueueDownload, EnqueueUpload, ListBuckets, ListObjectsPage } from '../../wailsjs/go/main/OSSService';
import { SelectFile, SelectSaveFile } from '../../wailsjs/go/main/App';
import ConfirmationModal from './ConfirmationModal';
import FilePreviewModal from './FilePreviewModal';
import { EventsOn } from '../../wailsjs/runtime/runtime';
import './FileBrowser.css';
import './Modal.css';

interface FileBrowserProps {
  config: main.OSSConfig;
  profileName: string | null;
  initialPath?: string;
}

// Columns: Name, Size, Type, Last Modified, Actions
const DEFAULT_TABLE_COLUMN_WIDTHS = [440, 110, 120, 190, 200];
const MIN_TABLE_COLUMN_WIDTHS = [180, 70, 80, 120, 160];
const DEFAULT_PAGE_SIZE = 200;

const sumWidths = (widths: number[]) => widths.reduce((sum, w) => sum + w, 0);

const fitWidthsToContainer = (widths: number[], targetWidth: number) => {
  if (!Number.isFinite(targetWidth) || targetWidth <= 0) return widths;
  if (widths.length !== MIN_TABLE_COLUMN_WIDTHS.length) return widths;

  const total = sumWidths(widths);
  if (!Number.isFinite(total) || total <= 0) return widths;

  const minTotal = sumWidths(MIN_TABLE_COLUMN_WIDTHS);
  if (minTotal > targetWidth) return widths;

  const scale = targetWidth / total;
  const next = widths.map((w, i) => Math.max(MIN_TABLE_COLUMN_WIDTHS[i], Math.round(w * scale)));

  let diff = targetWidth - sumWidths(next);
  if (diff > 0) {
    next[0] += diff;
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
    next[0] = Math.max(MIN_TABLE_COLUMN_WIDTHS[0], next[0] + (targetWidth - final));
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

function FileBrowser({ config, profileName, initialPath }: FileBrowserProps) {
  const [currentBucket, setCurrentBucket] = useState('');
  const [currentPrefix, setCurrentPrefix] = useState('');
  const [navState, setNavState] = useState<{ stack: NavLocation[]; index: number }>({
    stack: [{ bucket: '', prefix: '' }],
    index: 0,
  });
  
  const [buckets, setBuckets] = useState<main.BucketInfo[]>([]);
  const [objects, setObjects] = useState<main.ObjectInfo[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);

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
  const [propertiesModalOpen, setPropertiesModalOpen] = useState(false);
  const [operationLoading, setOperationLoading] = useState(false);
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [previewObject, setPreviewObject] = useState<main.ObjectInfo | null>(null);
  const [bookmarkMenuOpen, setBookmarkMenuOpen] = useState(false);

  // Address bar edit state
  const [addressBarEditing, setAddressBarEditing] = useState(false);
  const [addressBarValue, setAddressBarValue] = useState('');
  const addressInputRef = useRef<HTMLInputElement>(null);

  const tableContainerRef = useRef<HTMLDivElement>(null);
  const [columnWidths, setColumnWidths] = useState<number[]>(() => {
    const fallbackWidth = Math.max(720, window.innerWidth - 160);
    return fitWidthsToContainer(DEFAULT_TABLE_COLUMN_WIDTHS, fallbackWidth);
  });

  const tableVisible = !!currentBucket && objects.length > 0;

  const storageKey = profileName ? `oss-bookmarks:${profileName}` : null;

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
    setPreviewModalOpen(false);
    setPreviewObject(null);
  }, [currentBucket, currentPrefix]);

  useEffect(() => {
    if (!currentBucket) return;
    loadObjectsFirstPage(currentBucket, currentPrefix);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSize]);

  useEffect(() => {
    if (!tableVisible) return;
    const el = tableContainerRef.current;
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
    if (!currentBucket) return;
    const off = EventsOn('transfer:update', (payload: any) => {
      const update = payload as any;
      if (update?.type !== 'upload' || update?.status !== 'success') return;
      if (update?.bucket !== currentBucket) return;
      if (typeof update?.key === 'string' && !update.key.startsWith(currentPrefix)) return;
      const marker = markerForPage(pageIndex);
      loadObjectsPage(currentBucket, currentPrefix, marker, pageIndex);
    });
    return () => off();
  }, [config, currentBucket, currentPrefix, pageIndex, pageMarkers, pageSize]);

  // Close menus on click elsewhere
  useEffect(() => {
    const handleClick = () => {
      setContextMenu((prev) => (prev.visible ? { ...prev, visible: false } : prev));
      setBookmarkMenuOpen(false);
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

  const handlePreview = (obj?: main.ObjectInfo) => {
    const target = obj || contextMenu.object;
    if (!target || !currentBucket || isFolder(target)) return;
    setPreviewObject(target);
    setPreviewModalOpen(true);
    setContextMenu((prev) => ({ ...prev, visible: false }));
  };

  const handleUpload = async () => {
    try {
      const filePath = await SelectFile();
      if (!filePath) return;
      await EnqueueUpload(config, currentBucket, currentPrefix, filePath);
    } catch (err: any) {
      setError(err?.message || "Upload failed");
    }
  };

  const handleDownload = async (target?: main.ObjectInfo) => {
    const obj = target || contextMenu.object;
    if (!obj || isFolder(obj) || !currentBucket) return;

    try {
      const savePath = await SelectSaveFile(obj.name);
      if (!savePath) return;
      const fullKey = obj.path.substring(`oss://${currentBucket}/`.length);
      await EnqueueDownload(config, currentBucket, fullKey, savePath, obj.size);
    } catch (err: any) {
      alert("Download failed: " + err.message);
    }
  };

  const handleDeleteClick = () => {
    setDeleteModalOpen(true);
  };

  const confirmDelete = async () => {
    const obj = contextMenu.object;
    if (!obj) return;

    setOperationLoading(true);
    try {
      // Construct key from Path
       const fullKey = obj.path.substring(`oss://${currentBucket}/`.length);
       
      await DeleteObject(config, currentBucket, fullKey);
      setDeleteModalOpen(false);
      const marker = markerForPage(pageIndex);
      loadObjectsPage(currentBucket, currentPrefix, marker, pageIndex); // Refresh
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
        >
          {bucketDisplay}
        </span>
      );

      if (currentPrefix) {
        const parts = currentPrefix.split('/').filter(p => p);
        parts.forEach((part, index) => {
          crumbs.push(<span key={`sep-${index}`} className="separator">/</span>);
          const isLast = index === parts.length - 1;
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
            >
              {part}
            </span>
          );
        });
      }
    }
    return crumbs;
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
              <div className="bookmark-popup" onClick={(e) => e.stopPropagation()}>
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
        <div className="header-actions">
          <button className="nav-btn" onClick={handleUpload} disabled={!currentBucket} title="Upload File">
            Upload
          </button>
        </div>
      </div>

      <div className="browser-content">
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
            <div className="file-table-container" ref={tableContainerRef}>
              <table className="file-table">
                <colgroup>
                  {columnWidths.map((w, i) => (
                    <col key={i} style={{ width: `${w}px` }} />
                  ))}
                </colgroup>
                <thead>
                  <tr>
                    <th className="resizable">
                      <span className="th-label">Name</span>
                      <div className="col-resizer" onPointerDown={(e) => startColumnResize(0, e)} />
                    </th>
                    <th className="resizable">
                      <span className="th-label">Size</span>
                      <div className="col-resizer" onPointerDown={(e) => startColumnResize(1, e)} />
                    </th>
                    <th className="resizable">
                      <span className="th-label">Type</span>
                      <div className="col-resizer" onPointerDown={(e) => startColumnResize(2, e)} />
                    </th>
                    <th className="resizable">
                      <span className="th-label">Last Modified</span>
                      <div className="col-resizer" onPointerDown={(e) => startColumnResize(3, e)} />
                    </th>
                    <th>
                      <span className="th-label">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {objects.map((obj) => (
                    <tr 
                      key={obj.path || obj.name} 
                      onClick={() => (isFolder(obj) ? handleFolderClick(obj.name) : handlePreview(obj))}
                      onContextMenu={(e) => handleContextMenu(e, obj)}
                    >
                      <td className="file-name-td">
                        <div className="file-name-cell">
                          <div className={`file-icon ${isFolder(obj) ? 'folder-icon' : 'item-icon'}`}>
                             {isFolder(obj) ? (
                               <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                                 <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
                               </svg>
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
                            <button
                              className="link-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleFolderClick(obj.name);
                              }}
                            >
                              Open
                            </button>
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

      <FilePreviewModal
        isOpen={previewModalOpen}
        config={config}
        bucket={currentBucket}
        object={previewObject}
        onClose={() => setPreviewModalOpen(false)}
        onDownload={(obj) => handleDownload(obj)}
        onSaved={() => currentBucket && loadObjectsPage(currentBucket, currentPrefix, markerForPage(pageIndex), pageIndex)}
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
        title="Delete Object"
        description={`Are you sure you want to delete "${contextMenu.object?.name}"?`}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteModalOpen(false)}
        isLoading={operationLoading}
      />
    </div>
  );
}

export default FileBrowser;
