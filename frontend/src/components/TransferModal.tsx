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
  parentId?: string;
  isGroup?: boolean;
  fileCount?: number;
  doneCount?: number;
  successCount?: number;
  errorCount?: number;
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

type GroupedTransfer = {
  group: TransferRecord;
  children: TransferRecord[];
  visibleChildren: TransferRecord[];
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

function transferSortValue(t: TransferRecord) {
  return t.updatedAtMs || t.startedAtMs || t.finishedAtMs || 0;
}

function transferMatches(t: TransferRecord, q: string) {
  if (!q) return true;
  return `${t.name} ${t.bucket} ${t.key} ${t.localPath || ''}`.toLowerCase().includes(q);
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
  const [expandedGroupIds, setExpandedGroupIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!isOpen) {
      setSearch('');
      setExpandedGroupIds({});
    }
  }, [isOpen]);

  const view = useMemo(() => {
    const base = transfers.filter((t) => t.type === activeTab);
    const byId = new Map(base.map((t) => [t.id, t]));
    const childrenByParent = new Map<string, TransferRecord[]>();
    const groups: TransferRecord[] = [];
    const standalone: TransferRecord[] = [];
    const q = search.trim().toLowerCase();

    for (const t of base) {
      if (t.parentId) {
        const arr = childrenByParent.get(t.parentId) || [];
        arr.push(t);
        childrenByParent.set(t.parentId, arr);
      } else if (t.isGroup) {
        groups.push(t);
      } else {
        standalone.push(t);
      }
    }

    for (const [parentId, children] of childrenByParent.entries()) {
      const parent = byId.get(parentId);
      if (!parent || !parent.isGroup) {
        standalone.push(...children);
        childrenByParent.delete(parentId);
      }
    }

    const grouped = groups
      .map((group): GroupedTransfer | null => {
        const children = [...(childrenByParent.get(group.id) || [])].sort((a, b) => transferSortValue(b) - transferSortValue(a));
        const visibleChildren = q ? children.filter((c) => transferMatches(c, q)) : children;
        const groupMatch = transferMatches(group, q);
        if (q && !groupMatch && visibleChildren.length === 0) return null;
        return { group, children, visibleChildren };
      })
      .filter((g): g is GroupedTransfer => !!g)
      .sort((a, b) => transferSortValue(b.group) - transferSortValue(a.group));

    const standaloneVisible = standalone
      .filter((t) => transferMatches(t, q))
      .sort((a, b) => transferSortValue(b) - transferSortValue(a));

    return {
      grouped,
      standalone: standaloneVisible,
      query: q,
      taskCount: grouped.length + standaloneVisible.length,
    };
  }, [activeTab, search, transfers]);

  if (!isOpen) return null;

  const renderTransferActions = (t: TransferRecord) =>
    t.type === 'download' &&
    t.status === 'success' &&
    t.localPath && (
      <div className="transfer-actions">
        <button className="transfer-action-btn" type="button" onClick={() => onReveal(t.localPath!)}>
          Reveal
        </button>
        <button className="transfer-action-btn primary" type="button" onClick={() => onOpen(t.localPath!)}>
          Open
        </button>
      </div>
    );

  const renderTransferCard = (t: TransferRecord) => {
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
        {renderTransferActions(t)}
      </div>
    );
  };

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
          <button className="icon-close-btn transfer-close-btn" type="button" onClick={onClose} aria-label="Close transfers" title="Close">
            ×
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
          <div className="transfer-count">{view.taskCount} tasks</div>
        </div>

        <div className="transfer-modal-body">
          {view.taskCount === 0 ? (
            <div className="transfer-empty-large">No {activeTab === 'download' ? 'downloads' : 'uploads'}.</div>
          ) : (
            <div className="transfer-list-large">
              {view.grouped.map(({ group, children, visibleChildren }) => {
                const expanded = !!expandedGroupIds[group.id] || (!!view.query && visibleChildren.length > 0);
                const progress = formatProgress(group.doneBytes, group.totalBytes);
                const showProgress = group.status === 'in-progress' || group.status === 'queued';
                const ossPath = `oss://${group.bucket}/${group.key}`;
                const fileCount = group.fileCount || children.length;
                const doneCount = group.doneCount || 0;

                return (
                  <div key={group.id} className="transfer-card transfer-group-card">
                    <div className="transfer-card-top">
                      <div className="transfer-main">
                        <div className="transfer-group-head">
                          <button
                            className="transfer-group-toggle"
                            type="button"
                            aria-label={expanded ? 'Collapse task details' : 'Expand task details'}
                            onClick={() => setExpandedGroupIds((prev) => ({ ...prev, [group.id]: !expanded }))}
                          >
                            {expanded ? '▾' : '▸'}
                          </button>
                          <div className="transfer-name" title={group.name}>
                            {group.name}
                          </div>
                        </div>
                        <div className="transfer-path" title={ossPath}>
                          {ossPath}
                        </div>
                        {group.localPath && (
                          <div className="transfer-local" title={group.localPath}>
                            {group.localPath}
                          </div>
                        )}
                        <div className="transfer-group-summary">
                          {doneCount} / {fileCount} files
                          {group.errorCount ? ` (${group.errorCount} failed)` : ''}
                        </div>
                      </div>
                      <div className="transfer-status">
                        <span className={`transfer-badge ${group.status}`}>{group.status}</span>
                      </div>
                    </div>

                    {showProgress && (
                      <div className="transfer-progress">
                        <div className="transfer-progress-bar">
                          <div className="transfer-progress-fill" style={{ width: `${progress}%` }} />
                        </div>
                        <div className="transfer-progress-meta">
                          <span>{group.totalBytes ? `${formatBytes(group.doneBytes)} / ${formatBytes(group.totalBytes)}` : '-'}</span>
                          <span>{progress > 0 ? `${progress.toFixed(1)}%` : '-'}</span>
                        </div>
                      </div>
                    )}

                    {group.message && <div className="transfer-message">{group.message}</div>}
                    {renderTransferActions(group)}

                    {expanded && (
                      <div className="transfer-group-children">
                        {(view.query ? visibleChildren : children).map((child) => {
                          const childProgress = formatProgress(child.doneBytes, child.totalBytes);
                          const childShowProgress = child.status === 'in-progress' || child.status === 'queued';
                          const childOssPath = `oss://${child.bucket}/${child.key}`;

                          return (
                            <div key={child.id} className="transfer-child-card">
                              <div className="transfer-child-head">
                                <div className="transfer-child-name" title={child.name}>
                                  {child.name}
                                </div>
                                <span className={`transfer-badge ${child.status}`}>{child.status}</span>
                              </div>
                              <div className="transfer-child-path" title={childOssPath}>
                                {childOssPath}
                              </div>
                              {childShowProgress && (
                                <div className="transfer-child-progress">
                                  <div className="transfer-progress-bar">
                                    <div className="transfer-progress-fill" style={{ width: `${childProgress}%` }} />
                                  </div>
                                  <div className="transfer-progress-meta">
                                    <span>{child.totalBytes ? `${formatBytes(child.doneBytes)} / ${formatBytes(child.totalBytes)}` : '-'}</span>
                                    <span>{childProgress > 0 ? `${childProgress.toFixed(1)}%` : '-'}</span>
                                  </div>
                                </div>
                              )}
                              {child.message && <div className="transfer-message">{child.message}</div>}
                              {renderTransferActions(child)}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}

              {view.standalone.map((t) => renderTransferCard(t))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
