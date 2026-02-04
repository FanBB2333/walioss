import { useEffect, useMemo, useState } from 'react';
import './TransferModal.css';
import './Modal.css';

type TransferStatus = 'queued' | 'in-progress' | 'success' | 'error';
type TransferType = 'upload' | 'download';

export type TransferRecord = {
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

function formatBytes(bytes?: number) {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '-';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${sizes[i]}`;
}

function formatSpeed(speedBytesPerSec?: number) {
  if (!speedBytesPerSec || !Number.isFinite(speedBytesPerSec) || speedBytesPerSec <= 0) return '-';
  return `${formatBytes(speedBytesPerSec)}/s`;
}

function formatEta(seconds?: number) {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '-';
  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

function formatProgress(doneBytes?: number, totalBytes?: number) {
  if (!doneBytes || !totalBytes || totalBytes <= 0) return 0;
  const p = (doneBytes / totalBytes) * 100;
  return Math.max(0, Math.min(100, p));
}

interface TransferModalProps {
  isOpen: boolean;
  activeTab: TransferType;
  onTabChange: (tab: TransferType) => void;
  transfers: TransferRecord[];
  onClose: () => void;
  onReveal: (path: string) => void;
  onOpen: (path: string) => void;
}

export default function TransferModal({ isOpen, activeTab, onTabChange, transfers, onClose, onReveal, onOpen }: TransferModalProps) {
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!isOpen) {
      setSearch('');
    }
  }, [isOpen]);

  const filtered = useMemo(() => {
    const base = transfers.filter((t) => t.type === activeTab);
    const q = search.trim().toLowerCase();
    if (!q) return base;
    return base.filter((t) => `${t.name} ${t.bucket} ${t.key}`.toLowerCase().includes(q));
  }, [activeTab, search, transfers]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content transfer-modal" onClick={(e) => e.stopPropagation()}>
        <div className="transfer-modal-header">
          <div className="transfer-modal-title">Transfers</div>
          <div className="transfer-modal-tabs" role="tablist" aria-label="Transfer tabs">
            <button
              className={`transfer-tab-btn ${activeTab === 'download' ? 'active' : ''}`}
              type="button"
              onClick={() => onTabChange('download')}
              role="tab"
              aria-selected={activeTab === 'download'}
            >
              Downloads
            </button>
            <button
              className={`transfer-tab-btn ${activeTab === 'upload' ? 'active' : ''}`}
              type="button"
              onClick={() => onTabChange('upload')}
              role="tab"
              aria-selected={activeTab === 'upload'}
            >
              Uploads
            </button>
          </div>
          <button className="transfer-close-btn" type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="transfer-modal-toolbar">
          <input
            className="transfer-search"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name / bucket / key"
          />
          <div className="transfer-count">{filtered.length} items</div>
        </div>

        <div className="transfer-modal-body">
          {filtered.length === 0 ? (
            <div className="transfer-empty-large">No {activeTab === 'download' ? 'downloads' : 'uploads'}.</div>
          ) : (
            <div className="transfer-list-large">
              {filtered.map((t) => {
                const progress = formatProgress(t.doneBytes, t.totalBytes);
                const showProgress = t.status === 'in-progress' || t.status === 'queued';
                const ossPath = `oss://${t.bucket}/${t.key}`;

                return (
                  <div key={t.id} className="transfer-card">
                    <div className="transfer-card-top">
                      <div className="transfer-main">
                        <div className="transfer-name" title={t.name}>
                          {t.name}
                        </div>
                        <div className="transfer-path" title={ossPath}>
                          {ossPath}
                        </div>
                        {t.localPath && (
                          <div className="transfer-local" title={t.localPath}>
                            {t.localPath}
                          </div>
                        )}
                      </div>
                      <div className="transfer-status">
                        <span className={`transfer-badge ${t.status}`}>{t.status}</span>
                      </div>
                    </div>

                    {showProgress && (
                      <div className="transfer-progress">
                        <div className="transfer-progress-bar">
                          <div className="transfer-progress-fill" style={{ width: `${progress}%` }} />
                        </div>
                        <div className="transfer-progress-meta">
                          <span>{t.totalBytes ? `${formatBytes(t.doneBytes)} / ${formatBytes(t.totalBytes)}` : '-'}</span>
                          <span>{progress > 0 ? `${progress.toFixed(1)}%` : '-'}</span>
                        </div>
                      </div>
                    )}

                    <div className="transfer-meta-row">
                      <div className="transfer-meta-item">
                        <div className="meta-label">Size</div>
                        <div className="meta-value">{formatBytes(t.totalBytes)}</div>
                      </div>
                      <div className="transfer-meta-item">
                        <div className="meta-label">Speed</div>
                        <div className="meta-value">{formatSpeed(t.speedBytesPerSec)}</div>
                      </div>
                      <div className="transfer-meta-item">
                        <div className="meta-label">ETA</div>
                        <div className="meta-value">{formatEta(t.etaSeconds)}</div>
                      </div>
                    </div>

                    {t.message && <div className="transfer-message">{t.message}</div>}

                    {t.type === 'download' && t.status === 'success' && t.localPath && (
                      <div className="transfer-actions">
                        <button className="transfer-action-btn" type="button" onClick={() => onReveal(t.localPath!)}>
                          Reveal
                        </button>
                        <button className="transfer-action-btn primary" type="button" onClick={() => onOpen(t.localPath!)}>
                          Open
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

