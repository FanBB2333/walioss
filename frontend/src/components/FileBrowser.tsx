import { useState, useEffect, useRef } from 'react';
import { main } from '../../wailsjs/go/models';
import { ListBuckets, ListObjects, UploadFile, DownloadFile, DeleteObject } from '../../wailsjs/go/main/OSSService';
import { SelectFile, SelectSaveFile } from '../../wailsjs/go/main/App';
import ConfirmationModal from './ConfirmationModal';
import './FileBrowser.css';
import './Modal.css';

type TransferStatus = 'in-progress' | 'success' | 'error';

interface FileBrowserProps {
  config: main.OSSConfig;
  profileName: string | null;
  onTransferStart?: (payload: { name: string; type: 'upload' | 'download'; bucket: string; key: string; status?: TransferStatus }) => string;
  onTransferFinish?: (id: string, status: TransferStatus, message?: string) => void;
}

type Bookmark = {
  id: string;
  bucket: string;
  prefix: string;
  label: string;
};

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  object: main.ObjectInfo | null;
}

function FileBrowser({ config, profileName, onTransferStart, onTransferFinish }: FileBrowserProps) {
  const [currentBucket, setCurrentBucket] = useState('');
  const [currentPrefix, setCurrentPrefix] = useState('');
  
  const [buckets, setBuckets] = useState<main.BucketInfo[]>([]);
  const [objects, setObjects] = useState<main.ObjectInfo[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Context Menu State
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0, object: null });
  
  // Modal State
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [propertiesModalOpen, setPropertiesModalOpen] = useState(false);
  const [operationLoading, setOperationLoading] = useState(false);

  // Address bar edit state
  const [addressBarEditing, setAddressBarEditing] = useState(false);
  const [addressBarValue, setAddressBarValue] = useState('');
  const addressInputRef = useRef<HTMLInputElement>(null);

  const storageKey = profileName ? `oss-bookmarks:${profileName}` : null;

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

  // Load buckets on mount
  useEffect(() => {
    loadBuckets();
  }, [config]); 

  useEffect(() => {
    loadBookmarks();
  }, [storageKey]);

  // Close context menu on click elsewhere
  useEffect(() => {
    const handleClick = () => setContextMenu({ ...contextMenu, visible: false });
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [contextMenu]);

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

  const loadObjects = async (bucket: string, prefix: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await ListObjects(config, bucket, prefix);
      setObjects(result || []);
    } catch (err: any) {
      setError(err.message || "Failed to list objects");
    } finally {
      setLoading(false);
    }
  };

  const handleBucketClick = (bucketName: string) => {
    setCurrentBucket(bucketName);
    setCurrentPrefix('');
    loadObjects(bucketName, '');
  };

  const handleFolderClick = (folderName: string) => {
    const newPrefix = currentPrefix + folderName + '/';
    setCurrentPrefix(newPrefix);
    loadObjects(currentBucket, newPrefix);
  };

  const handleBack = () => {
    if (!currentBucket) return;
    
    if (currentPrefix === '') {
      setCurrentBucket('');
      setObjects([]);
      loadBuckets(); 
    } else {
      const parts = currentPrefix.split('/').filter(p => p);
      parts.pop();
      const newPrefix = parts.length > 0 ? parts.join('/') + '/' : '';
      setCurrentPrefix(newPrefix);
      loadObjects(currentBucket, newPrefix);
    }
  };

  const handleRefresh = () => {
    if (!currentBucket) {
      loadBuckets();
      return;
    }
    loadObjects(currentBucket, currentPrefix);
  };

  const handleBreadcrumbClick = (index: number) => {
      if (index === -1) {
          setCurrentBucket('');
          setCurrentPrefix('');
          loadBuckets();
          return;
      }
      
      if (index === 0) {
          setCurrentPrefix('');
          loadObjects(currentBucket, '');
          return;
      }
      
      const parts = currentPrefix.split('/').filter(p => p);
      const newParts = parts.slice(0, index);
      const newPrefix = newParts.join('/') + '/';
      setCurrentPrefix(newPrefix);
      loadObjects(currentBucket, newPrefix);
  };

  // Generate current OSS path
  const getCurrentOssPath = () => {
    if (!currentBucket) return 'oss://';
    if (!currentPrefix) return `oss://${currentBucket}/`;
    return `oss://${currentBucket}/${currentPrefix}`;
  };

  // Parse OSS path and navigate
  const parseAndNavigateOssPath = (path: string) => {
    const trimmed = path.trim();
    
    // Handle oss:// prefix
    let pathToParse = trimmed;
    if (pathToParse.startsWith('oss://')) {
      pathToParse = pathToParse.substring(6);
    }
    
    // If empty, go to bucket list
    if (!pathToParse || pathToParse === '/') {
      setCurrentBucket('');
      setCurrentPrefix('');
      loadBuckets();
      return;
    }
    
    // Split into bucket and prefix
    const parts = pathToParse.split('/');
    const bucket = parts[0];
    const prefix = parts.slice(1).filter(p => p).join('/');
    const normalizedPrefix = prefix ? prefix + '/' : '';
    
    setCurrentBucket(bucket);
    setCurrentPrefix(normalizedPrefix);
    loadObjects(bucket, normalizedPrefix);
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

  const handleBookmarkClick = (bookmark: Bookmark) => {
    setCurrentBucket(bookmark.bucket);
    setCurrentPrefix(bookmark.prefix);
    loadObjects(bookmark.bucket, bookmark.prefix);
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

  const handleUpload = async () => {
    let transferId: string | undefined;
    try {
      const filePath = await SelectFile();
      if (!filePath) return;

      const fileName = filePath.split(/[/\\]/).pop() || 'file';

      setLoading(true); // Show global loading or toast
      transferId = onTransferStart?.({
        name: fileName,
        type: 'upload',
        bucket: currentBucket,
        key: `${currentPrefix}${fileName}`,
      });

      await UploadFile(config, currentBucket, currentPrefix, filePath);
      transferId && onTransferFinish?.(transferId, 'success');
      await loadObjects(currentBucket, currentPrefix); // Refresh
    } catch (err: any) {
      if (transferId) {
        onTransferFinish?.(transferId, 'error', err?.message || 'Upload failed');
      }
      setError(err?.message || "Upload failed");
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async (target?: main.ObjectInfo) => {
    let transferId: string | undefined;
    const obj = target || contextMenu.object;
    if (!obj || isFolder(obj) || !currentBucket) return;

    try {
      const savePath = await SelectSaveFile(obj.name);
      if (!savePath) return;

      setOperationLoading(true);
      const fullKey = obj.path.substring(`oss://${currentBucket}/`.length);
      transferId = onTransferStart?.({
        name: obj.name,
        type: 'download',
        bucket: currentBucket,
        key: fullKey,
      });
      // We pass the relative path (obj.name) if it's in root, but obj.name is just display name?
      // Wait, ListObjects returns Name as display name.
      // We need the key relative to bucket.
      // In ListObjects implementation:
      // Name: displayName (e.g. "file.txt" inside "folder/")
      // But we need "folder/file.txt" for download.
      // Ah, wait. In `oss_service.go`, `DownloadFile` takes `object`.
      // My `ListObjects` implementation returns `ObjectInfo` where `Name` is the display name (relative to prefix).
      // But `Path` is full oss path "oss://bucket/prefix/name".
      
      // Let's rely on `Path` but trim `oss://bucket/`.

      await DownloadFile(config, currentBucket, fullKey, savePath);
      transferId && onTransferFinish?.(transferId, 'success');
    } catch (err: any) {
      if (transferId) {
        onTransferFinish?.(transferId, 'error', err?.message || 'Download failed');
      }
      alert("Download failed: " + err.message);
    } finally {
      setOperationLoading(false);
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
      loadObjects(currentBucket, currentPrefix); // Refresh
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

  const isFolder = (obj: main.ObjectInfo) => obj.type === 'Folder' || obj.path.endsWith('/') || obj.name.endsWith('/');

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
        className={`crumb ${isRootActive ? 'active' : ''}`} 
        onClick={(e) => {
          if (!isRootActive) {
            e.stopPropagation();
            handleBreadcrumbClick(-1);
          }
        }}
      >
        All Buckets
      </span>
    );

    if (currentBucket) {
      crumbs.push(<span key="sep-root" className="separator">/</span>);
      const isBucketActive = !currentPrefix;
      crumbs.push(
        <span 
          key="bucket" 
          className={`crumb ${isBucketActive ? 'active' : ''}`} 
          onClick={(e) => {
            if (!isBucketActive) {
              e.stopPropagation();
              handleBreadcrumbClick(0);
            }
          }}
        >
          {currentBucket}
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
      <div className="bookmark-bar">
        <button
          className="bookmark-star-btn"
          onClick={handleAddBookmark}
          disabled={!currentBucket || !profileName}
          title={profileName ? 'Add current path to bookmarks' : 'Save connection as profile to enable bookmarks'}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
          </svg>
        </button>
        <div className="bookmark-list">
          {bookmarks.length === 0 ? (
            <span className="bookmark-empty">No bookmarks</span>
          ) : (
            bookmarks.map((bm) => (
              <div key={bm.id} className="bookmark-chip">
                <button className="bookmark-chip-label" onClick={() => handleBookmarkClick(bm)} title={`${bm.bucket}/${bm.prefix}`}>
                  {bm.label}
                </button>
                <button className="bookmark-chip-remove" onClick={() => handleRemoveBookmark(bm.id)} title="Remove bookmark">
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      </div>
      <div className="browser-header">
        <div className="nav-controls">
          <button className="nav-btn" onClick={handleBack} disabled={!currentBucket} title="Go Back">←</button>
          <button className="nav-btn" onClick={handleRefresh} disabled={loading} title="Refresh">↻</button>
          <button className="nav-btn" onClick={handleUpload} disabled={!currentBucket} title="Upload File">↑ Upload</button>
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
             <button className="btn btn-secondary" onClick={() => currentBucket ? loadObjects(currentBucket, currentPrefix) : loadBuckets()}>Retry</button>
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
            <div className="file-table-container">
              <table className="file-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Size</th>
                    <th>Type</th>
                    <th>Last Modified</th>
                    <th>Storage Class</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {objects.map((obj) => (
                    <tr 
                      key={obj.path || obj.name} 
                      onClick={() => isFolder(obj) && handleFolderClick(obj.name)}
                      onContextMenu={(e) => handleContextMenu(e, obj)}
                    >
                      <td className="file-name-cell">
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
                      </td>
                      <td>{!isFolder(obj) ? formatSize(obj.size) : '-'}</td>
                      <td>{displayType(obj)}</td>
                      <td>{obj.lastModified || '-'}</td>
                      <td>{obj.storageClass || '-'}</td>
                      <td className="file-actions">
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
                          <button
                            className="link-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDownload(obj);
                            }}
                          >
                            Download
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
