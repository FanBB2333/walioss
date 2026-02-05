import { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';
import Login from './pages/Login';
import Settings from './pages/Settings';
import AboutModal from './components/AboutModal';
import FileBrowser from './components/FileBrowser';
import TransferModal from './components/TransferModal';
import { main } from '../wailsjs/go/models';
import { GetSettings, MoveObject } from '../wailsjs/go/main/OSSService';
import { GetAppInfo, OpenFile, OpenInFinder } from '../wailsjs/go/main/App';
import { EventsEmit, EventsOn } from '../wailsjs/runtime/runtime';
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

type TransferItem = {
  id: string;
  name: string;
  type: TransferType;
  bucket: string;
  key: string;
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

function App() {
  const [globalView, setGlobalView] = useState<GlobalView>('session');
  const [theme, setTheme] = useState<string>('dark');
  const [newTabNameRule, setNewTabNameRule] = useState<'folder' | 'newTab'>('folder');
  const nextTabNumber = useRef(2);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
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
  const [transferView, setTransferView] = useState<TransferType>('download');
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const [aboutOpen, setAboutOpen] = useState<boolean>(false);
  const [aboutLoading, setAboutLoading] = useState<boolean>(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

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
    const off = EventsOn('transfer:update', (payload: any) => {
      const update = payload as any;
      if (!update?.id) return;

      setTransfers((prev) => {
        const index = prev.findIndex((t) => t.id === update.id);
        const next: TransferItem = {
          id: update.id,
          name: update.name || (index >= 0 ? prev[index].name : 'Transfer'),
          type: update.type,
          bucket: update.bucket,
          key: update.key,
          status: update.status,
          message: update.message,
          localPath: update.localPath,
          totalBytes: update.totalBytes,
          doneBytes: update.doneBytes,
          speedBytesPerSec: update.speedBytesPerSec,
          etaSeconds: update.etaSeconds,
          startedAtMs: update.startedAtMs,
          updatedAtMs: update.updatedAtMs,
          finishedAtMs: update.finishedAtMs,
        };

        if (index === -1) {
          return [next, ...prev];
        }

        const updated = [...prev];
        updated[index] = { ...prev[index], ...next };
        return updated;
      });
    });
    return () => off();
  }, []);

  useEffect(() => {
    const off = EventsOn('app:about', () => {
      openAbout();
    });
    return () => off();
  }, [openAbout]);

  // Titlebar drag region for macOS
  const TitlebarDrag = () => <div className="titlebar-drag" />;

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

  const handleTabDragEnter = (e: React.DragEvent, tabId: string) => {
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
    if (!canReadOssDragPayload(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverTabId(tabId);
  };

  const handleTabDragLeave = (e: React.DragEvent, tabId: string) => {
    const related = e.relatedTarget as Node | null;
    if (related && e.currentTarget.contains(related)) return;
    setDragOverTabId((prev) => (prev === tabId ? null : prev));
    if (tabHoverSwitchTargetRef.current === tabId) {
      clearTabHoverSwitch();
    }
  };

  const handleTabDrop = async (e: React.DragEvent, tab: AppTab) => {
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

  const inProgressCount = transfers.filter((t) => t.status === 'in-progress' || t.status === 'queued').length;

  return (
    <>
      <TitlebarDrag />
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
	              <h1 className="app-name">Walioss</h1>
	            </div>
	            <div className="header-info">
              {sessionConfig && (
                <div className="transfer-toggle">
                  <button
                    className="transfer-btn"
                    type="button"
                    onClick={() => {
                      setTransferView('download');
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
                    className={`window-tab ${t.id === activeTabId ? 'active' : ''} ${dragOverTabId === t.id ? 'drag-over' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => openTab(t.id)}
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
