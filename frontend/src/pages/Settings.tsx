import { useState, useEffect } from 'react';
import { main } from '../../wailsjs/go/models';
import { GetSettings, SaveSettings, CheckOssutilInstalled, GetOssutilPath, SetOssutilPath } from '../../wailsjs/go/main/OSSService';
import '../components/Modal.css';
import './Settings.css';

interface SettingsProps {
  isOpen: boolean;
  onBack: () => void;
  onThemeChange?: (theme: string) => void;
  onNotify?: (toast: { type: 'success' | 'error' | 'info'; message: string }) => void;
  onSettingsSaved?: (settings: main.AppSettings) => void;
}

function Settings({ isOpen, onBack, onThemeChange, onNotify, onSettingsSaved }: SettingsProps) {
  const [settings, setSettings] = useState<main.AppSettings>({
    ossutilPath: '',
    defaultRegion: '',
    defaultEndpoint: '',
    theme: 'dark',
    maxTransferThreads: 3,
    newTabNameRule: 'folder',
  } as main.AppSettings);

  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    loadSettings();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onBack();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onBack]);

  const loadSettings = async () => {
    try {
      const loaded = await GetSettings();
      setSettings({
        ...loaded,
        newTabNameRule: loaded?.newTabNameRule === 'newTab' ? 'newTab' : 'folder',
      });
      if (onThemeChange) {
        onThemeChange(loaded?.theme || 'dark');
      }
    } catch (err: any) {
      onNotify?.({ type: 'error', message: 'Failed to load settings' });
    }
  };

  const handleThemeSelect = (theme: 'dark' | 'light') => {
    setSettings((prev) => ({ ...prev, theme }));
    if (onThemeChange) {
      onThemeChange(theme);
    }
  };

  const handleSave = async () => {
    setLoading(true);
    try {
      await SaveSettings(settings);
      if (onThemeChange) {
        onThemeChange(settings.theme);
      }
      onSettingsSaved?.(settings);
      onNotify?.({ type: 'success', message: 'Settings saved' });
      onBack();
    } catch (err: any) {
      onNotify?.({ type: 'error', message: err.message || 'Failed to save settings' });
    } finally {
      setLoading(false);
    }
  };

  const handleTestOssutil = async () => {
    setLoading(true);
    let originalPath: string | null = null;
    try {
      originalPath = await GetOssutilPath();
      await SetOssutilPath(settings.ossutilPath);

      const result = await CheckOssutilInstalled();
      if (result.success) {
        onNotify?.({ type: 'success', message: `ossutil found: ${result.message}` });
      } else {
        onNotify?.({ type: 'error', message: result.message });
      }
    } catch (err: any) {
      onNotify?.({ type: 'error', message: err.message || 'Test failed' });
    } finally {
      if (originalPath !== null) {
        try {
          await SetOssutilPath(originalPath);
        } catch {}
      }
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onBack}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-container">
          <div className="settings-header">
            <h1 className="settings-title">Settings</h1>
            <button
              className="icon-close-btn settings-close-btn"
              type="button"
              onClick={onBack}
              aria-label="Close settings"
              title="Close"
            >
              ×
            </button>
          </div>

          <div className="settings-content">
            {/* Ossutil Configuration */}
            <div className="settings-section">
              <h2 className="section-title">Ossutil Configuration</h2>
              <div className="form-group">
                <label className="form-label">Ossutil Path</label>
                <div className="form-inline">
                  <input
                    type="text"
                    className="form-input"
                    value={settings.ossutilPath}
                    onChange={(e) => setSettings({ ...settings, ossutilPath: e.target.value })}
                    placeholder="Leave empty to use auto-detected ossutil"
                  />
                  <button className="back-btn form-inline-btn" type="button" onClick={handleTestOssutil} disabled={loading}>
                    Test
                  </button>
                </div>
              </div>
            </div>

            {/* Transfers */}
            <div className="settings-section">
              <h2 className="section-title">Transfers</h2>
              <div className="form-group">
                <label className="form-label">Max Concurrent Transfers</label>
                <input
                  type="number"
                  className="form-input"
                  value={settings.maxTransferThreads ?? 3}
                  min={1}
                  max={64}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    setSettings({ ...settings, maxTransferThreads: Number.isFinite(v) ? v : 1 });
                  }}
                  placeholder="e.g., 3"
                />
              </div>
            </div>

            {/* Appearance */}
            <div className="settings-section">
              <h2 className="section-title">Appearance</h2>
              <div className="form-group">
                <label className="form-label">Theme</label>
                <div className="theme-toggle">
                  <div className={`theme-option ${settings.theme === 'dark' ? 'active' : ''}`} onClick={() => handleThemeSelect('dark')}>
                    Dark
                  </div>
                  <div className={`theme-option ${settings.theme === 'light' ? 'active' : ''}`} onClick={() => handleThemeSelect('light')}>
                    Light
                  </div>
                </div>
              </div>
            </div>

            {/* Tabs */}
            <div className="settings-section">
              <h2 className="section-title">Tabs</h2>
              <div className="form-group">
                <label className="form-label">New Tab Naming</label>
                <div className="theme-toggle">
                  <div
                    className={`theme-option ${settings.newTabNameRule === 'folder' ? 'active' : ''}`}
                    onClick={() => setSettings((prev) => ({ ...prev, newTabNameRule: 'folder' }))}
                  >
                    Current Folder
                  </div>
                  <div
                    className={`theme-option ${settings.newTabNameRule === 'newTab' ? 'active' : ''}`}
                    onClick={() => setSettings((prev) => ({ ...prev, newTabNameRule: 'newTab' }))}
                  >
                    New Tab
                  </div>
                </div>
              </div>
            </div>

            {/* Default Connection */}
            <div className="settings-section">
              <h2 className="section-title">Default Connection</h2>
              <div className="form-group">
                <label className="form-label">Default Region</label>
                <input
                  type="text"
                  className="form-input"
                  value={settings.defaultRegion}
                  onChange={(e) => setSettings({ ...settings, defaultRegion: e.target.value })}
                  placeholder="e.g., cn-hangzhou"
                />
              </div>
              <div className="form-group">
                <label className="form-label">Default Endpoint</label>
                <input
                  type="text"
                  className="form-input"
                  value={settings.defaultEndpoint}
                  onChange={(e) => setSettings({ ...settings, defaultEndpoint: e.target.value })}
                  placeholder="e.g., oss-cn-hangzhou.aliyuncs.com"
                />
              </div>
            </div>

            <button className="save-btn" type="button" onClick={handleSave} disabled={loading}>
              {loading ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Settings;
