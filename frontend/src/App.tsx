import { useEffect, useRef, useState } from 'react';
import './App.css';
import Login from './pages/Login';
import Settings from './pages/Settings';
import FileBrowser from './components/FileBrowser';
import { main } from '../wailsjs/go/models';
import { GetSettings } from '../wailsjs/go/main/OSSService';

type GlobalView = 'session' | 'settings';

type AppTab = {
  id: string;
  title: string;
};

function App() {
  const [globalView, setGlobalView] = useState<GlobalView>('session');
  const [theme, setTheme] = useState<string>('dark');
  const nextTabNumber = useRef(2);

  const [sessionConfig, setSessionConfig] = useState<main.OSSConfig | null>(null);

  const [tabs, setTabs] = useState<AppTab[]>([
    { id: 't1', title: 'Tab 1' },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>('t1');

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

  const handleLoginSuccess = (config: main.OSSConfig) => {
    setSessionConfig(config);
    setGlobalView('session');
  };

  const handleLogout = () => {
    setSessionConfig(null);
    setGlobalView('session');
    setTabs([{ id: 't1', title: 'Tab 1' }]);
    setActiveTabId('t1');
    nextTabNumber.current = 2;
  };

  const openTab = (tabId: string) => {
    setActiveTabId(tabId);
    setGlobalView('session');
  };

  const addTab = () => {
    if (!sessionConfig) return;
    const number = nextTabNumber.current++;
    const id = `t${number}`;
    setTabs((prev) => [...prev, { id, title: `Tab ${number}` }]);
    openTab(id);
  };

  const closeTab = (tabId: string) => {
    if (tabs.length <= 1) {
      handleLogout();
      return;
    }
    setTabs((prev) => prev.filter((t) => t.id !== tabId));
  };

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
                  <span className="window-tab-icon">{index + 1}</span>
                  <span className="window-tab-title">{t.title}</span>
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
                  <FileBrowser config={sessionConfig} />
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
