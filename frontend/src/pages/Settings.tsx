import { useState, useEffect } from 'react';
import { main } from '../../wailsjs/go/models';
import { GetSettings, SaveSettings, CheckOssutilInstalled } from '../../wailsjs/go/main/OSSService';
import './Settings.css';

interface SettingsProps {
  onBack: () => void;
  onThemeChange?: (theme: string) => void;
}

function Settings({ onBack, onThemeChange }: SettingsProps) {
  const [settings, setSettings] = useState<main.AppSettings>({
    ossutilPath: 'ossutil',
    defaultRegion: '',
    defaultEndpoint: '',
    theme: 'dark',
  } as main.AppSettings);
  
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const loaded = await GetSettings();
      setSettings(loaded);
    } catch (err: any) {
      setMessage({ type: 'error', text: 'Failed to load settings' });
    }
  };

  const handleSave = async () => {
    setLoading(true);
    setMessage(null);
    try {
      await SaveSettings(settings);
      setMessage({ type: 'success', text: 'Settings saved successfully' });
      if (onThemeChange) {
        onThemeChange(settings.theme);
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to save settings' });
    } finally {
      setLoading(false);
    }
  };

  const handleTestOssutil = async () => {
    setLoading(true);
    setMessage(null);
    try {
      // Temporarily apply the path to test
      const tempSettings = { ...settings };
      await SaveSettings(tempSettings);
      
      const result = await CheckOssutilInstalled();
      if (result.success) {
        setMessage({ type: 'success', text: `ossutil found: ${result.message}` });
      } else {
        setMessage({ type: 'error', text: result.message });
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Test failed' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="settings-container">
      <div className="settings-header">
        <button className="back-btn" onClick={onBack}>← Back</button>
        <h1 className="settings-title">Settings</h1>
      </div>

      <div className="settings-content">
        {/* Ossutil Configuration */}
        <div className="settings-section">
          <h2 className="section-title">Ossutil Configuration</h2>
          <div className="form-group">
            <label className="form-label">Ossutil Path</label>
            <input
              type="text"
              className="form-input"
              value={settings.ossutilPath}
              onChange={(e) => setSettings({ ...settings, ossutilPath: e.target.value })}
              placeholder="ossutil (default: system PATH)"
            />
          </div>
          <button 
            className="back-btn" 
            onClick={handleTestOssutil}
            disabled={loading}
            style={{ marginTop: '8px' }}
          >
            Test ossutil
          </button>
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

        {/* Appearance */}
        <div className="settings-section">
          <h2 className="section-title">Appearance</h2>
          <div className="form-group">
            <label className="form-label">Theme</label>
            <div className="theme-toggle">
              <div 
                className={`theme-option ${settings.theme === 'dark' ? 'active' : ''}`}
                onClick={() => setSettings({ ...settings, theme: 'dark' })}
              >
                Dark
              </div>
              <div 
                className={`theme-option ${settings.theme === 'light' ? 'active' : ''}`}
                onClick={() => setSettings({ ...settings, theme: 'light' })}
              >
                Light
              </div>
            </div>
          </div>
        </div>

        <button 
          className="save-btn" 
          onClick={handleSave}
          disabled={loading}
        >
          {loading ? 'Saving...' : 'Save Settings'}
        </button>

        {message && (
          <div className={`message ${message.type}`}>
            {message.text}
          </div>
        )}
      </div>
    </div>
  );
}

export default Settings;
