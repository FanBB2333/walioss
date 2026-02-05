import { useEffect } from 'react';
import { BrowserOpenURL } from '../../wailsjs/runtime/runtime';
import './Modal.css';
import './AboutModal.css';

type AppInfo = {
  name: string;
  version: string;
  githubUrl?: string;
};

interface AboutModalProps {
  isOpen: boolean;
  info: AppInfo | null;
  loading?: boolean;
  onClose: () => void;
}

function formatVersion(version: string) {
  const v = (version || '').trim();
  if (!v) return '-';
  return v.startsWith('v') ? v : `v${v}`;
}

function AboutModal({ isOpen, info, loading, onClose }: AboutModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const name = info?.name || 'Walioss';
  const version = formatVersion(info?.version || '');
  const githubUrl = info?.githubUrl || '';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content about-modal" onClick={(e) => e.stopPropagation()}>
        <div className="about-header">
          <div className="about-titlegroup">
            <img className="about-icon" src="/appicon.png" alt={name} />
            <div className="about-titles">
              <div className="about-name">{name}</div>
              <div className="about-subtitle">{loading ? 'Loading…' : version}</div>
            </div>
          </div>
          <button className="icon-close-btn" type="button" onClick={onClose} aria-label="Close about" title="Close">
            ×
          </button>
        </div>

        <div className="about-body">
          <div className="property-row">
            <div className="property-label">GitHub</div>
            <div className="property-value">
              {loading ? (
                'Loading…'
              ) : githubUrl ? (
                <button className="about-link" type="button" onClick={() => BrowserOpenURL(githubUrl)} title="Open in browser">
                  {githubUrl}
                </button>
              ) : (
                '-'
              )}
            </div>
          </div>
        </div>

        <div className="modal-actions">
          <button className="modal-btn modal-btn-cancel" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export default AboutModal;
