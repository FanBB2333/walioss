import { useEffect, useRef, useState } from 'react';
import './App.css';
import Login from './pages/Login';
import Settings from './pages/Settings';
import FileBrowser from './components/FileBrowser';
import { main } from '../wailsjs/go/models';
import { GetSettings } from '../wailsjs/go/main/OSSService';
import { OpenInFinder } from '../wailsjs/go/main/App';

type GlobalView = 'session' | 'settings';

type AppTab = {
  id: string;
  title: string;
};

type TransferStatus = 'in-progress' | 'success' | 'error';
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
};

function App() {
  const [globalView, setGlobalView] = useState<GlobalView>('session');
  const [theme, setTheme] = useState<string>('dark');
  const nextTabNumber = useRef(2);

  const [sessionConfig, setSessionConfig] = useState<main.OSSConfig | null>(null);
  const [sessionProfileName, setSessionProfileName] = useState<string | null>(null);

  const [tabs, setTabs] = useState<AppTab[]>([
    { id: 't1', title: 'New Tab' },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>('t1');
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState<string>('');
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [showTransfers, setShowTransfers] = useState<boolean>(false);

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
      } catch {
        handleThemeChange('dark');
      }
    };
    applySavedTheme();
  }, []);

  // Titlebar drag region for macOS
  const TitlebarDrag = () => <div className="titlebar-drag" />;

  const handleLoginSuccess = (config: main.OSSConfig, profileName?: string | null) => {
    setSessionConfig(config);
    setGlobalView('session');
    setSessionProfileName(profileName || null);
    setTransfers([]);
    setShowTransfers(false);
  };

  const handleLogout = () => {
    setSessionConfig(null);
    setGlobalView('session');
    setTabs([{ id: 't1', title: 'New Tab' }]);
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

  const addTab = () => {
    if (!sessionConfig) return;
    const number = nextTabNumber.current++;
    const id = `t${number}`;
    setTabs((prev) => [...prev, { id, title: 'New Tab' }]);
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
    setTabs((prev) => prev.map((t) => (t.id === renamingTabId ? { ...t, title } : t)));
    cancelRename();
  };

  const startTransfer = (payload: Omit<TransferItem, 'id' | 'status'> & { status?: TransferStatus }) => {
    const id = `tr-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setTransfers((prev) => [{ ...payload, id, status: payload.status ?? 'in-progress' }, ...prev]);
    return id;
  };

  const finishTransfer = (id: string, status: TransferStatus, message?: string) => {
    setTransfers((prev) => prev.map((t) => (t.id === id ? { ...t, status, message } : t)));
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

  const inProgressCount = transfers.filter((t) => t.status === 'in-progress').length;

  return (
    <>
      <TitlebarDrag />
      <div className="dashboard-container">
        <header className="dashboard-header">
          <div className="app-brand">
            <img className="app-icon" src="/appicon.png" alt="Walioss" />
            <h1 className="app-name">Walioss</h1>
          </div>
          <div className="window-tabs" aria-label="Windows">
            {sessionConfig &&
              tabs.map((t, index) => (
                <div
                  key={t.id}
                  className={`window-tab ${t.id === activeTabId ? 'active' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => openTab(t.id)}
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
                    <span
                      className="window-tab-title"
                      onDoubleClick={() => startRename(t.id, t.title)}
                      title="Double-click to rename"
                    >
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
            {sessionConfig && (
              <button className="window-new-btn" type="button" onClick={addTab} title="New Tab">
                +
              </button>
            )}
          </div>
          <div className="header-info">
            {sessionConfig && (
              <div className="transfer-toggle">
                <button
                  className="transfer-btn"
                  type="button"
                  onClick={() => setShowTransfers((v) => !v)}
                  title="传输进度"
                >
                  ⇅
                  {inProgressCount > 0 && <span className="transfer-badge">{inProgressCount}</span>}
                </button>
              {showTransfers && (
                  <div className="transfer-panel">
                    <h4>Transfers</h4>
                    {transfers.length === 0 ? (
                      <div className="transfer-empty">No transfers</div>
                    ) : (
                      <div className="transfer-sections">
                        {/* Downloads Section */}
                        {transfers.filter(t => t.type === 'download').length > 0 && (
                          <div className="transfer-section">
                            <div className="transfer-section-title">Downloads</div>
                            <div className="transfer-list">
                              {transfers.filter(t => t.type === 'download').map((t) => (
                                <div key={t.id} className="transfer-item compact">
                                  <div className="transfer-row">
                                    <span className="transfer-name" title={t.name}>{t.name}</span>
                                    <span className={`status-dot ${t.status}`} />
                                    {t.status === 'success' && t.localPath && (
                                      <button 
                                        className="open-folder-btn" 
                                        onClick={() => OpenInFinder(t.localPath!)}
                                        title="Open in Finder"
                                      >
                                        Open
                                      </button>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {/* Uploads Section */}
                        {transfers.filter(t => t.type === 'upload').length > 0 && (
                          <div className="transfer-section">
                            <div className="transfer-section-title">Uploads</div>
                            <div className="transfer-list">
                              {transfers.filter(t => t.type === 'upload').map((t) => (
                                <div key={t.id} className="transfer-item compact">
                                  <div className="transfer-row">
                                    <span className="transfer-name" title={t.name}>{t.name}</span>
                                    <span className={`status-dot ${t.status}`} />
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            <span>Region: {sessionConfig?.region || '-'}</span>
            <button className="btn-settings" onClick={() => setGlobalView('settings')}>Settings</button>
            {sessionConfig && <button className="btn-logout" onClick={handleLogout}>Logout</button>}
          </div>
        </header>
        <main className="dashboard-main">
          {globalView === 'settings' ? (
            <Settings onBack={() => setGlobalView('session')} onThemeChange={handleThemeChange} />
          ) : !sessionConfig ? (
            <Login onLoginSuccess={handleLoginSuccess} />
          ) : (
            <div className="window-stack">
              {tabs.map((t) => (
                <div key={t.id} className={`window-panel ${t.id === activeTabId ? 'active' : ''}`}>
                  <FileBrowser
                    config={sessionConfig}
                    profileName={sessionProfileName}
                    initialPath={sessionConfig.defaultPath}
                    onTransferStart={startTransfer}
                    onTransferFinish={finishTransfer}
                  />
                </div>
              ))}
            </div>
          )}
        </main>
      </div>
    </>
  );
}

export default App;
