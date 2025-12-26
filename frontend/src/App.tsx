import { useState } from 'react';
import './App.css';
import Login from './pages/Login';
import Settings from './pages/Settings';
import FileBrowser from './components/FileBrowser';
import { main } from '../wailsjs/go/models';

type AppView = 'login' | 'dashboard' | 'settings';

function App() {
  const [currentView, setCurrentView] = useState<AppView>('login');
  const [currentConfig, setCurrentConfig] = useState<main.OSSConfig | null>(null);
  const [theme, setTheme] = useState<string>('dark');

  const handleLoginSuccess = (config: main.OSSConfig) => {
    setCurrentConfig(config);
    setCurrentView('dashboard');
  };

  const handleLogout = () => {
    setCurrentConfig(null);
    setCurrentView('login');
  };

  const handleThemeChange = (newTheme: string) => {
    setTheme(newTheme);
    document.body.className = newTheme === 'light' ? 'theme-light' : 'theme-dark';
  };

  // Titlebar drag region for macOS
  const TitlebarDrag = () => <div className="titlebar-drag" />;

  if (currentView === 'login') {
    return (
      <>
        <TitlebarDrag />
        <Login onLoginSuccess={handleLoginSuccess} />
      </>
    );
  }

  if (currentView === 'settings') {
    return (
      <>
        <TitlebarDrag />
        <Settings 
          onBack={() => setCurrentView('dashboard')} 
          onThemeChange={handleThemeChange}
        />
      </>
    );
  }

  return (
    <>
      <TitlebarDrag />
      <div className="dashboard-container">
        <header className="dashboard-header">
          <h1>Walioss</h1>
          <div className="header-info">
            <span>Region: {currentConfig?.region}</span>
            <button className="btn-settings" onClick={() => setCurrentView('settings')}>Settings</button>
            <button className="btn-logout" onClick={handleLogout}>Logout</button>
          </div>
        </header>
        <main className="dashboard-main">
          {currentConfig && <FileBrowser config={currentConfig} />}
        </main>
      </div>
    </>
  );
}

export default App;
