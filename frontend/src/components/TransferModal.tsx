import { useEffect, useMemo, useState } from 'react';
import './TransferModal.css';
import './Modal.css';

type TransferStatus = 'queued' | 'in-progress' | 'success' | 'error';
type TransferType = 'upload' | 'download';
type TransferView = 'all' | TransferType;

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

const pad2 = (n: number) => n.toString().padStart(2, '0');

function formatLocalDateTime(ms?: number) {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return '-';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '-';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatDurationMs(ms?: number) {
  if (ms === undefined || ms === null) return '-';
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${m}:${pad2(s)}`;
}

function formatProgress(doneBytes?: number, totalBytes?: number) {
  if (!doneBytes || !totalBytes || totalBytes <= 0) return 0;
  const p = (doneBytes / totalBytes) * 100;
  return Math.max(0, Math.min(100, p));
}

function isTransferCompleted(status: TransferStatus) {
  return status === 'success' || status === 'error';
}

function getTransferSizeBytes(t: TransferRecord) {
  const total = t.totalBytes && t.totalBytes > 0 ? t.totalBytes : 0;
  const done = t.doneBytes && t.doneBytes > 0 ? t.doneBytes : 0;
  const size = Math.max(total, done);
  return size > 0 ? size : undefined;
}

function getTransferAverageSpeed(t: TransferRecord) {
  const startedAt = t.startedAtMs;
  const finishedAt = t.finishedAtMs || t.updatedAtMs;
  if (!startedAt || !finishedAt || finishedAt <= startedAt) return undefined;
  const bytes = getTransferSizeBytes(t);
  if (!bytes) return undefined;
  const durationSeconds = (finishedAt - startedAt) / 1000;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return undefined;
  return bytes / durationSeconds;
}

function transferSortValue(t: TransferRecord) {
  return t.updatedAtMs || t.startedAtMs || t.finishedAtMs || 0;
}

function transferMatches(t: TransferRecord, q: string) {
  if (!q) return true;
  return `${t.name} ${t.bucket} ${t.key} ${t.localPath || ''}`.toLowerCase().includes(q);
}

function transferTypeLabel(type: TransferType) {
  return type === 'upload' ? 'Upload' : 'Download';
}

function transferTypeIcon(type: TransferType) {
  return type === 'upload' ? '↑' : '↓';
}

function transferStatusLabel(status: TransferStatus) {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'in-progress':
      return 'In progress';
    case 'success':
      return 'Success';
    case 'error':
      return 'Failed';
    default:
      return status;
  }
}

function transferStatusGlyph(status: TransferStatus) {
  switch (status) {
    case 'success':
      return '✓';
    case 'error':
      return '×';
    case 'in-progress':
      return '↻';
    case 'queued':
      return '…';
    default:
      return '•';
  }
}

function transferItemKindLabel(t: TransferRecord) {
  if (t.isGroup) return 'Folder';
  if ((t.key || '').endsWith('/')) return 'Folder';
  return 'File';
}

interface TransferModalProps {
  isOpen: boolean;
  activeTab: TransferView;
  onTabChange: (tab: TransferView) => void;
  transfers: TransferRecord[];
  onClose: () => void;
  onReveal: (path: string) => void;
  onOpen: (path: string) => void;
}

export default function TransferModal({ isOpen, activeTab, onTabChange, transfers, onClose, onReveal, onOpen }: TransferModalProps) {
  const [search, setSearch] = useState('');
  const [expandedItemIds, setExpandedItemIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) {
      setSearch('');
      setExpandedItemIds({});
    }
  }, [isOpen]);

  const view = useMemo(() => {
    const base = activeTab === 'all' ? transfers : transfers.filter((t) => t.type === activeTab);
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
      groupIds: grouped.map((g) => g.group.id),
      query: q,
      taskCount: grouped.length + standaloneVisible.length,
    };
  }, [activeTab, search, transfers]);

  if (!isOpen) return null;

  const handleRevealLocalPath = (localPath?: string) => {
    if (!localPath) return;
    onReveal(localPath);
  };

  const hasManualExpandState = (id: string) => Object.prototype.hasOwnProperty.call(expandedItemIds, id);
  const isItemExpanded = (id: string, autoExpanded = false) => {
    if (hasManualExpandState(id)) {
      return !!expandedItemIds[id];
    }
    return autoExpanded;
  };
  const toggleItemExpanded = (id: string, autoExpanded = false) => {
    setExpandedItemIds((prev) => {
      const current = Object.prototype.hasOwnProperty.call(prev, id) ? !!prev[id] : autoExpanded;
      return { ...prev, [id]: !current };
    });
  };
  const handleExpandAll = () => {
    setExpandedItemIds((prev) => {
      if (view.groupIds.length === 0) return prev;
      const next = { ...prev };
      for (const id of view.groupIds) {
        next[id] = true;
      }
      return next;
    });
  };
  const handleCollapseAll = () => {
    setExpandedItemIds((prev) => {
      if (view.groupIds.length === 0) return prev;
      const next = { ...prev };
      for (const id of view.groupIds) {
        next[id] = false;
      }
      return next;
    });
  };

  const renderTypeMark = (type: TransferType, compact = false) => (
    <span className={`transfer-type-mark ${type} ${compact ? 'compact' : ''}`} title={transferTypeLabel(type)}>
      {transferTypeIcon(type)}
    </span>
  );

  const renderKindBadge = (t: TransferRecord, compact = false) => {
    const label = transferItemKindLabel(t);
    const kind = label.toLowerCase();
    return (
      <span className={`transfer-kind-badge ${kind} ${compact ? 'compact' : ''}`} title={label}>
        {label}
      </span>
    );
  };

  const renderStatusIcon = (status: TransferStatus) => (
    <span
      className={`transfer-status-icon ${status}`}
      title={transferStatusLabel(status)}
      aria-label={transferStatusLabel(status)}
    >
      {transferStatusGlyph(status)}
    </span>
  );

  const renderCompletedSummary = (t: TransferRecord) => {
    if (!isTransferCompleted(t.status)) return null;
    const avgSpeed = getTransferAverageSpeed(t) || t.speedBytesPerSec;
    const sizeBytes = getTransferSizeBytes(t);

    return (
      <div className="transfer-header-meta" aria-label="Completed transfer summary">
        <div className="transfer-header-meta-item">
          <span className="meta-label">Size</span>
          <span className="meta-value">{formatBytes(sizeBytes)}</span>
        </div>
        <div className="transfer-header-meta-item">
          <span className="meta-label">Avg speed</span>
          <span className="meta-value">{formatSpeed(avgSpeed)}</span>
        </div>
      </div>
    );
  };

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

  const renderStatusMeta = (t: TransferRecord, isCompleted: boolean, speedForMeta?: number) => (
    <div className={`transfer-status-meta ${isCompleted ? 'completed' : ''}`} aria-label="Transfer summary">
      <div className="transfer-status-meta-item">
        <span className="meta-label">Size</span>
        <span className="meta-value">{formatBytes(getTransferSizeBytes(t))}</span>
      </div>
      <div className="transfer-status-meta-item">
        <span className="meta-label">{isCompleted ? 'Avg speed' : 'Speed'}</span>
        <span className="meta-value">{formatSpeed(speedForMeta)}</span>
      </div>
      {!isCompleted && (
        <div className="transfer-status-meta-item">
          <span className="meta-label">ETA</span>
          <span className="meta-value">{formatEta(t.etaSeconds)}</span>
        </div>
      )}
    </div>
  );

  const renderTransferTiming = (t: TransferRecord, compact = false) => {
    const isCompleted = isTransferCompleted(t.status);
    const startMs = t.startedAtMs || t.updatedAtMs || 0;
    const endMs = t.finishedAtMs || (isCompleted ? t.updatedAtMs || 0 : 0);
    const durationMs = startMs > 0 ? Math.max(0, (endMs > 0 ? endMs : Date.now()) - startMs) : undefined;
    const startText = startMs > 0 ? formatLocalDateTime(startMs) : '-';
    const endText = endMs > 0 ? formatLocalDateTime(endMs) : '-';
    const durationText = startMs > 0 ? formatDurationMs(durationMs) : '-';

    if (compact) {
      return (
        <div className="transfer-timing-inline" aria-label="Transfer timing">
          <span title={startText}>Start {startText}</span>
          <span aria-hidden="true">·</span>
          <span title={endText}>End {endText}</span>
          <span aria-hidden="true">·</span>
          <span title={durationText}>Duration {durationText}</span>
        </div>
      );
    }

    return (
      <div className="transfer-timing-meta" aria-label="Transfer timing">
        <div className="transfer-timing-item">
          <span className="meta-label">Start</span>
          <span className="meta-value" title={startText}>
            {startText}
          </span>
        </div>
        <div className="transfer-timing-item">
          <span className="meta-label">End</span>
          <span className="meta-value" title={endText}>
            {endText}
          </span>
        </div>
        <div className="transfer-timing-item">
          <span className="meta-label">Duration</span>
          <span className="meta-value" title={durationText}>
            {durationText}
          </span>
        </div>
      </div>
    );
  };

  const renderTransferEndpoints = (t: TransferRecord, compact = false) => {
    const ossPath = `oss://${t.bucket}/${t.key}`;
    const kind = t.type === 'upload' ? 'upload' : 'download';
    const fromLabel = t.type === 'upload' ? 'From (Local)' : 'From (OSS)';
    const toLabel = t.type === 'upload' ? 'To (OSS)' : 'To (Local)';

    const renderLocalValue = (localPath?: string) => {
      if (!localPath) return <div className="transfer-endpoint-value">-</div>;
      return (
        <button
          className={`transfer-endpoint-value transfer-local transfer-local-link ${compact ? 'compact' : ''}`.trim()}
          type="button"
          onClick={() => handleRevealLocalPath(localPath)}
          title={`Reveal in Finder: ${localPath}`}
          aria-label="Reveal local path in Finder"
        >
          {localPath}
        </button>
      );
    };

    const renderOssValue = () => (
      <div className={`transfer-endpoint-value ${compact ? 'compact' : ''}`} title={ossPath}>
        {ossPath}
      </div>
    );

    const fromValue = t.type === 'upload' ? renderLocalValue(t.localPath) : renderOssValue();
    const toValue = t.type === 'upload' ? renderOssValue() : renderLocalValue(t.localPath);

    return (
      <div className={`transfer-endpoints ${kind} ${compact ? 'compact' : ''}`.trim()} aria-label="Transfer route">
        <div className="transfer-endpoint-row">
          <span className="transfer-endpoint-label">{fromLabel}</span>
          {fromValue}
        </div>
        <div className="transfer-endpoint-row">
          <span className="transfer-endpoint-label">{toLabel}</span>
          {toValue}
        </div>
      </div>
    );
  };

  const renderTransferCard = (t: TransferRecord) => {
    const progress = formatProgress(t.doneBytes, t.totalBytes);
    const showProgress = t.status === 'in-progress' || t.status === 'queued';
    const isCompleted = isTransferCompleted(t.status);
    const speedForMeta = isCompleted ? getTransferAverageSpeed(t) || t.speedBytesPerSec : t.speedBytesPerSec;

    return (
      <div key={t.id} className="transfer-card transfer-single-card">
        <div className="transfer-card-top">
          <div className="transfer-main">
            <div className="transfer-title-row">
              {renderTypeMark(t.type)}
              <span className="transfer-type-text">{transferTypeLabel(t.type)}</span>
              <div className="transfer-name" title={t.name}>
                {t.name}
              </div>
              {renderKindBadge(t)}
            </div>
            {renderTransferEndpoints(t)}
            {renderTransferTiming(t)}
	          </div>
	          <div className="transfer-status transfer-status-single">
	            {renderStatusIcon(t.status)}
	            {renderStatusMeta(t, isCompleted, speedForMeta)}
	          </div>
	        </div>

        {showProgress && (
          <div className="transfer-progress transfer-progress-short">
            <div className="transfer-progress-bar">
              <div className="transfer-progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <div className="transfer-progress-meta">
              <span>{t.totalBytes ? `${formatBytes(t.doneBytes)} / ${formatBytes(t.totalBytes)}` : '-'}</span>
              <span>{progress > 0 ? `${progress.toFixed(1)}%` : '-'}</span>
            </div>
          </div>
        )}

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
              className={`transfer-tab-btn ${activeTab === 'all' ? 'active' : ''}`}
              type="button"
              onClick={() => onTabChange('all')}
              role="tab"
              aria-selected={activeTab === 'all'}
            >
              <span className="transfer-tab-inner">
                <span className="transfer-tab-icon all">⇅</span>
                <span>All</span>
              </span>
            </button>
            <button
              className={`transfer-tab-btn ${activeTab === 'download' ? 'active' : ''}`}
              type="button"
              onClick={() => onTabChange('download')}
              role="tab"
              aria-selected={activeTab === 'download'}
            >
              <span className="transfer-tab-inner">
                <span className="transfer-tab-icon download">↓</span>
                <span>Downloads</span>
              </span>
            </button>
            <button
              className={`transfer-tab-btn ${activeTab === 'upload' ? 'active' : ''}`}
              type="button"
              onClick={() => onTabChange('upload')}
              role="tab"
              aria-selected={activeTab === 'upload'}
            >
              <span className="transfer-tab-inner">
                <span className="transfer-tab-icon upload">↑</span>
                <span>Uploads</span>
              </span>
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
          <div className="transfer-toolbar-right">
            <div className="transfer-bulk-actions">
              <button
                className="transfer-bulk-btn"
                type="button"
                onClick={handleExpandAll}
                disabled={view.groupIds.length <= 0}
              >
                Expand All
              </button>
              <button
                className="transfer-bulk-btn"
                type="button"
                onClick={handleCollapseAll}
                disabled={view.groupIds.length <= 0}
              >
                Collapse All
              </button>
            </div>
            <div className="transfer-count">{view.taskCount} tasks</div>
          </div>
        </div>

        <div className="transfer-modal-body">
          {view.taskCount === 0 ? (
            <div className="transfer-empty-large">
              No {activeTab === 'all' ? 'transfers' : activeTab === 'download' ? 'downloads' : 'uploads'}.
            </div>
          ) : (
            <div className="transfer-list-large">
              {view.grouped.map(({ group, children, visibleChildren }) => {
                const autoExpanded = !!view.query && visibleChildren.length > 0;
                const expanded = isItemExpanded(group.id, autoExpanded);
                const progress = formatProgress(group.doneBytes, group.totalBytes);
                const showProgress = group.status === 'in-progress' || group.status === 'queued';
                const fileCount = group.fileCount || children.length;
                const doneCount = group.doneCount || 0;

                return (
                  <div key={group.id} className="transfer-card transfer-group-card">
                    <div className="transfer-card-top">
                      <div className="transfer-main">
                        <div className="transfer-group-head">
                          <button
                            className="transfer-expand-toggle"
                            type="button"
                            aria-label={expanded ? 'Collapse task details' : 'Expand task details'}
                            onClick={() => toggleItemExpanded(group.id, autoExpanded)}
                          >
                            {expanded ? '▾' : '▸'}
                          </button>
                          {renderTypeMark(group.type)}
                          <span className="transfer-type-text">{transferTypeLabel(group.type)}</span>
                          <div className="transfer-name" title={group.name}>
                            {group.name}
                          </div>
                          {renderKindBadge(group)}
                        </div>
                        {renderTransferEndpoints(group)}
                        {renderTransferTiming(group)}
                        <div className="transfer-group-summary">
                          {doneCount} / {fileCount} files
                          {group.errorCount ? ` (${group.errorCount} failed)` : ''}
                        </div>
	                      </div>
	                      <div className="transfer-status">
	                        {renderStatusIcon(group.status)}
	                        {renderCompletedSummary(group)}
	                      </div>
	                    </div>

                    {expanded && (
                      <>
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

                        <div className="transfer-group-children">
                          {(view.query ? visibleChildren : children).map((child) => {
                            const childProgress = formatProgress(child.doneBytes, child.totalBytes);
                            const childShowProgress = child.status === 'in-progress' || child.status === 'queued';

                            return (
                              <div key={child.id} className="transfer-child-card">
                                <div className="transfer-child-head">
                                  <div className="transfer-child-title">
                                    {renderTypeMark(child.type, true)}
                                    <span className="transfer-type-text compact">{transferTypeLabel(child.type)}</span>
                                    <div className="transfer-child-name" title={child.name}>
                                      {child.name}
                                    </div>
                                    {renderKindBadge(child, true)}
	                                  </div>
	                                  {renderStatusIcon(child.status)}
	                                </div>
                                {renderTransferEndpoints(child, true)}
                                {renderTransferTiming(child, true)}
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
                      </>
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
