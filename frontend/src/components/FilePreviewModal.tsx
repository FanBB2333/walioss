import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { main } from '../../wailsjs/go/models';
import { GetObjectText, PresignObject, PutObjectText } from '../../wailsjs/go/main/OSSService';
import './FilePreviewModal.css';
import './Modal.css';

type PreviewKind = 'text' | 'image' | 'video' | 'pdf' | 'unsupported';

const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;
const MAX_TEXT_EDIT_BYTES = 1024 * 1024;
const MAX_HIGHLIGHT_CHARS = 300 * 1024;

const textExtensions = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'jsonl',
  'jsonc',
  'yaml',
  'yml',
  'xml',
  'csv',
  'tsv',
  'log',
  'ini',
  'conf',
  'toml',
  'env',
  'go',
  'js',
  'jsx',
  'ts',
  'tsx',
  'css',
  'scss',
  'less',
  'html',
  'htm',
  'java',
  'py',
  'rb',
  'rs',
  'c',
  'cpp',
  'h',
  'hpp',
  'sh',
  'bash',
  'zsh',
  'sql',
]);

const codeExtensions = new Set([
  'go',
  'js',
  'jsx',
  'ts',
  'tsx',
  'css',
  'scss',
  'less',
  'html',
  'htm',
  'java',
  'py',
  'rb',
  'rs',
  'c',
  'cpp',
  'h',
  'hpp',
  'sh',
  'bash',
  'zsh',
  'sql',
  'json',
  'jsonl',
  'jsonc',
  'yaml',
  'yml',
  'xml',
  'toml',
  'ini',
  'conf',
  'env',
  'md',
  'markdown',
]);

const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
const videoExtensions = new Set(['mp4', 'webm', 'mov', 'mkv']);
const pdfExtensions = new Set(['pdf']);

function getFileExtension(name: string) {
  const parts = name.split('.');
  if (parts.length < 2) return '';
  return parts[parts.length - 1].toLowerCase();
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function highlightText(text: string) {
  const keywords = new Set(['true', 'false', 'null', 'undefined']);
  const isWordChar = (ch: string) => /[a-zA-Z0-9_$]/.test(ch);
  const isDigit = (ch: string) => /[0-9]/.test(ch);

  let out = '';
  let i = 0;
  let state: 'normal' | 'string' | 'comment' = 'normal';
  let quote = '"';

  const open = (cls: string) => {
    out += `<span class="${cls}">`;
  };
  const close = () => {
    out += '</span>';
  };

  while (i < text.length) {
    const ch = text[i];

    if (state === 'comment') {
      if (ch === '\n') {
        close();
        out += '\n';
        state = 'normal';
        i += 1;
        continue;
      }
      out += escapeHtml(ch);
      i += 1;
      continue;
    }

    if (state === 'string') {
      out += escapeHtml(ch);
      if (ch === '\\' && i + 1 < text.length) {
        out += escapeHtml(text[i + 1]);
        i += 2;
        continue;
      }
      if (ch === quote) {
        close();
        state = 'normal';
      }
      i += 1;
      continue;
    }

    // normal
    if (ch === '"' || ch === "'") {
      quote = ch;
      open('token-string');
      out += escapeHtml(ch);
      state = 'string';
      i += 1;
      continue;
    }

    if (ch === '/' && i + 1 < text.length && text[i + 1] === '/') {
      open('token-comment');
      out += '//';
      state = 'comment';
      i += 2;
      continue;
    }

    if (ch === '#') {
      open('token-comment');
      out += '#';
      state = 'comment';
      i += 1;
      continue;
    }

    if (isDigit(ch) || (ch === '-' && i + 1 < text.length && isDigit(text[i + 1]))) {
      let j = i + 1;
      while (j < text.length && /[0-9.eE+-]/.test(text[j])) j += 1;
      const token = text.slice(i, j);
      open('token-number');
      out += escapeHtml(token);
      close();
      i = j;
      continue;
    }

    if (/[a-zA-Z_$]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && isWordChar(text[j])) j += 1;
      const word = text.slice(i, j);
      if (keywords.has(word)) {
        open('token-keyword');
        out += escapeHtml(word);
        close();
      } else {
        out += escapeHtml(word);
      }
      i = j;
      continue;
    }

    out += escapeHtml(ch);
    i += 1;
  }

  if (state === 'comment' || state === 'string') {
    close();
  }

  return out;
}

function isLikelyTextContent(content: string) {
  if (!content) return true;
  const sample = content.slice(0, 8192);
  let suspicious = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code === 0) return false;
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      suspicious++;
    }
  }
  return suspicious / sample.length < 0.02;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${sizes[i]}`;
}

function formatDuration(totalSeconds: number) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '-';
  const seconds = Math.floor(totalSeconds);
  const s = seconds % 60;
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600);
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

function formatElapsedMs(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = ms / 1000;
  return `${s.toFixed(3)}(s) elapsed`;
}

interface FilePreviewModalProps {
  isOpen: boolean;
  config: main.OSSConfig;
  bucket: string;
  object: main.ObjectInfo | null;
  onClose: () => void;
  onDownload?: (obj: main.ObjectInfo) => void;
  onSaved?: () => void;
  onNavigate?: (direction: -1 | 1) => void;
  onNotify?: (toast: { type: 'success' | 'error' | 'info'; message: string }) => void;
}

export default function FilePreviewModal({
  isOpen,
  config,
  bucket,
  object,
  onClose,
  onDownload,
  onSaved,
  onNavigate,
  onNotify,
}: FilePreviewModalProps) {
  const [kind, setKind] = useState<PreviewKind>('unsupported');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [presignedUrl, setPresignedUrl] = useState<string>('');
  const [presignedForPath, setPresignedForPath] = useState<string>('');
  const [mediaUrl, setMediaUrl] = useState<string>('');
  const [mediaFallbackTried, setMediaFallbackTried] = useState(false);
  const [text, setText] = useState<string>('');
  const [originalText, setOriginalText] = useState<string>('');
  const [truncated, setTruncated] = useState(false);
  const [loadElapsedMs, setLoadElapsedMs] = useState<number | null>(null);
  const [pathCopyState, setPathCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [highlightHtml, setHighlightHtml] = useState<string>('');
  const [imageResolution, setImageResolution] = useState<{ width: number; height: number } | null>(null);
  const [videoMeta, setVideoMeta] = useState<{ width: number; height: number; duration: number } | null>(null);
  const highlightLayerRef = useRef<HTMLPreElement>(null);
  const editorInputRef = useRef<HTMLTextAreaElement>(null);
  const pathCopyTimerRef = useRef<number | null>(null);
  const loadSeqRef = useRef(0);

  const fileKey = useMemo(() => {
    if (!object?.path || !bucket) return '';
    const prefix = `oss://${bucket}/`;
    return object.path.startsWith(prefix) ? object.path.slice(prefix.length) : '';
  }, [bucket, object?.path]);

  const extension = useMemo(() => (object ? getFileExtension(object.name) : ''), [object]);

  const canEditText = useMemo(() => {
    if (!object) return false;
    if (!textExtensions.has(extension) && object.name.toLowerCase() !== 'dockerfile' && object.name.toLowerCase() !== 'makefile') return false;
    return object.size <= MAX_TEXT_EDIT_BYTES;
  }, [extension, object]);

  const isCodeText = useMemo(() => {
    if (!object) return false;
    const nameLower = object.name.toLowerCase();
    return nameLower === 'dockerfile' || nameLower === 'makefile' || codeExtensions.has(extension);
  }, [extension, object]);

  const kindFromName = useMemo((): PreviewKind => {
    if (!object) return 'unsupported';
    const nameLower = object.name.toLowerCase();
    const ext = getFileExtension(nameLower);
    if (imageExtensions.has(ext)) return 'image';
    if (videoExtensions.has(ext)) return 'video';
    if (pdfExtensions.has(ext)) return 'pdf';
    if (textExtensions.has(ext) || nameLower === 'dockerfile' || nameLower === 'makefile') return 'text';
    return 'unsupported';
  }, [object]);

  const shouldTryTextFallback = useMemo(() => {
    if (!object) return false;
    if (kindFromName !== 'unsupported') return false;
    return object.size <= MAX_TEXT_PREVIEW_BYTES;
  }, [kindFromName, object]);

  const dirty = canEditText && text !== originalText;

  const requestClose = useCallback(() => {
    if (dirty) {
      const ok = window.confirm('You have unsaved changes. Discard them?');
      if (!ok) return;
    }
    onClose();
  }, [dirty, onClose]);

  useLayoutEffect(() => {
    if (!isOpen || !object) return;
    const seq = (loadSeqRef.current += 1);
    const objectPath = object.path || '';

    setKind(kindFromName);
    setLoading(true);
    setSaving(false);
    setError(null);
    setPresignedUrl('');
    setPresignedForPath('');
    setMediaUrl('');
    setMediaFallbackTried(false);
    setText('');
    setOriginalText('');
    setTruncated(false);
    setLoadElapsedMs(null);
    setPathCopyState('idle');
    setHighlightHtml('');
    setImageResolution(null);
    setVideoMeta(null);

    const load = async () => {
      const startedAt = performance.now();
      try {
        if (!fileKey) {
          if (loadSeqRef.current !== seq) return;
          setError('Invalid object path');
          setKind('unsupported');
          return;
        }

        if (kindFromName === 'image' || kindFromName === 'video' || kindFromName === 'pdf') {
          const url = await PresignObject(config, bucket, fileKey, '30m');
          if (loadSeqRef.current !== seq) return;
          setPresignedForPath(objectPath);
          setPresignedUrl(url);
          setMediaUrl(url);
          setMediaFallbackTried(false);
          return;
        }

        if (kindFromName === 'text') {
          const maxBytes = canEditText ? MAX_TEXT_EDIT_BYTES : MAX_TEXT_PREVIEW_BYTES;
          const content = await GetObjectText(config, bucket, fileKey, maxBytes);
          if (loadSeqRef.current !== seq) return;
          setText(content);
          setOriginalText(content);
          setTruncated(!!object.size && object.size > maxBytes);
          return;
        }

        if (shouldTryTextFallback) {
          try {
            const content = await GetObjectText(config, bucket, fileKey, MAX_TEXT_PREVIEW_BYTES);
            if (loadSeqRef.current !== seq) return;
            if (isLikelyTextContent(content)) {
              setKind('text');
              setText(content);
              setOriginalText(content);
              setTruncated(!!object.size && object.size > MAX_TEXT_PREVIEW_BYTES);
            }
          } catch {
            // Keep unsupported mode for non-text files.
          }
          return;
        }
      } catch (err: any) {
        if (loadSeqRef.current !== seq) return;
        setError(err?.message || 'Preview failed');
      } finally {
        if (loadSeqRef.current !== seq) return;
        setLoadElapsedMs(performance.now() - startedAt);
        setLoading(false);
      }
    };

    void load();
  }, [bucket, canEditText, config, fileKey, isOpen, kindFromName, object, shouldTryTextFallback]);

  useEffect(() => {
    return () => {
      if (pathCopyTimerRef.current) {
        window.clearTimeout(pathCopyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        requestClose();
        return;
      }

      const isArrow =
        e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown';
      if (!isArrow || !onNavigate) return;

      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase() || '';
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;

      e.preventDefault();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        onNavigate(-1);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        onNavigate(1);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onNavigate, requestClose]);

  const handleCopyPath = async () => {
    if (!object?.path) return;
    try {
      await navigator.clipboard.writeText(object.path);
      setPathCopyState('copied');
      onNotify?.({ type: 'success', message: 'Path copied to clipboard' });
    } catch {
      setPathCopyState('failed');
      onNotify?.({ type: 'error', message: 'Failed to copy path' });
    }
    if (pathCopyTimerRef.current) {
      window.clearTimeout(pathCopyTimerRef.current);
    }
    pathCopyTimerRef.current = window.setTimeout(() => setPathCopyState('idle'), 1200);
  };

  const handleMediaError = () => {
    if (!object?.path) return;
    if (!presignedUrl || presignedForPath !== object.path) return;
    if (mediaFallbackTried) {
      setError((prev) => prev || 'Failed to load preview.');
      return;
    }
    const encoded = encodeURI(presignedUrl);
    if (encoded && encoded !== mediaUrl) {
      setMediaFallbackTried(true);
      setMediaUrl(encoded);
      return;
    }
    setMediaFallbackTried(true);
    setError((prev) => prev || 'Failed to load preview.');
  };

  useEffect(() => {
    if (!isOpen || kind !== 'text') return;
    const timer = window.setTimeout(() => {
      const head = text.slice(0, MAX_HIGHLIGHT_CHARS);
      const tail = text.slice(MAX_HIGHLIGHT_CHARS);
      setHighlightHtml(highlightText(head) + escapeHtml(tail));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [isOpen, kind, text]);

  if (!isOpen || !object) return null;

  const effectivePresignedUrl = presignedForPath && presignedForPath === object.path ? presignedUrl : '';
  const effectiveMediaUrl = presignedForPath && presignedForPath === object.path ? mediaUrl : '';

  const handleSave = async () => {
    if (!canEditText || !fileKey) return;
    setSaving(true);
    setError(null);
    try {
      await PutObjectText(config, bucket, fileKey, text);
      setOriginalText(text);
      onSaved?.();
    } catch (err: any) {
      setError(err?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const renderBody = () => {
    if (loading) {
      return (
        <div className="preview-loading">
          <div className="loading-spinner"></div>
          <p>Loading preview…</p>
        </div>
      );
    }

    if (kind === 'image') {
      return (
        <div className="preview-media">
          {effectivePresignedUrl ? (
            <img
              className="preview-image"
              src={effectiveMediaUrl || effectivePresignedUrl}
              alt={object.name}
              onError={handleMediaError}
              onLoad={(e) => {
                const img = e.currentTarget;
                if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                  setImageResolution({ width: img.naturalWidth, height: img.naturalHeight });
                }
              }}
            />
          ) : (
            <div className="preview-empty">No preview URL</div>
          )}
        </div>
      );
    }

    if (kind === 'video') {
      return (
        <div className="preview-media">
          {effectivePresignedUrl ? (
            <video
              className="preview-video"
              src={effectiveMediaUrl || effectivePresignedUrl}
              controls
              preload="metadata"
              onError={handleMediaError}
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                const duration = Number.isFinite(v.duration) ? v.duration : 0;
                const width = v.videoWidth || 0;
                const height = v.videoHeight || 0;
                if (duration > 0 || (width > 0 && height > 0)) {
                  setVideoMeta({ duration, width, height });
                }
              }}
            />
          ) : (
            <div className="preview-empty">No preview URL</div>
          )}
        </div>
      );
    }

    if (kind === 'pdf') {
      return (
        <div className="preview-media">
          {effectivePresignedUrl ? (
            <iframe
              className="preview-pdf"
              src={effectiveMediaUrl || effectivePresignedUrl}
              title={object.name}
              onError={handleMediaError}
            />
          ) : (
            <div className="preview-empty">No preview URL</div>
          )}
        </div>
      );
    }

    if (kind === 'text') {
      if (!canEditText) {
        return (
          <div className="preview-text">
            {truncated && (
              <div className="preview-banner">
                Preview is truncated to {formatBytes(MAX_TEXT_PREVIEW_BYTES)}.
              </div>
            )}
            <pre className={`preview-code ${isCodeText ? 'high-contrast' : ''}`}>
              <code dangerouslySetInnerHTML={{ __html: highlightHtml || escapeHtml(text) }} />
            </pre>
          </div>
        );
      }

      return (
        <div className="preview-text">
          {truncated && <div className="preview-banner">Preview is truncated to {formatBytes(MAX_TEXT_EDIT_BYTES)}.</div>}
          {text.length > MAX_HIGHLIGHT_CHARS && <div className="preview-hint">Syntax highlighting is simplified after {formatBytes(MAX_HIGHLIGHT_CHARS)} for performance.</div>}
          <div className={`highlight-editor ${isCodeText ? 'high-contrast' : ''}`}>
            <pre ref={highlightLayerRef} className="highlight-layer" aria-hidden="true">
              <code dangerouslySetInnerHTML={{ __html: highlightHtml || escapeHtml(text) }} />
            </pre>
            <textarea
              ref={editorInputRef}
              className="highlight-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onScroll={(e) => {
                const pre = highlightLayerRef.current;
                if (!pre) return;
                pre.scrollTop = e.currentTarget.scrollTop;
                pre.scrollLeft = e.currentTarget.scrollLeft;
              }}
              wrap="off"
              spellCheck={false}
            />
          </div>
        </div>
      );
    }

    return (
      <div className="preview-empty">
        <p>Preview not available for this file type.</p>
      </div>
    );
  };

  return (
    <div className="modal-overlay" onClick={requestClose}>
      <div className="modal-content preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="preview-header">
          <div className="preview-title">
            <div className="preview-name" title={object.name}>
              {object.name}
            </div>
            <div className="preview-subtitle">
              <button
                className="preview-path preview-path-btn"
                type="button"
                onClick={handleCopyPath}
                data-copy-state={pathCopyState}
                title={pathCopyState === 'copied' ? `Copied\n${object.path}` : `${object.path}\nClick to copy full path`}
                aria-label="Copy full path"
              >
                {object.path}
              </button>
            </div>
            <div className="preview-meta">
              <div className="meta-chip">
                <span className="meta-label">Type</span>
                <span className="meta-value">
                  {kind === 'text'
                    ? 'Text'
                    : kind === 'image'
                      ? 'Image'
                      : kind === 'video'
                        ? 'Video'
                        : kind === 'pdf'
                          ? 'PDF'
                          : 'File'}
                </span>
              </div>
              {object.size > 0 && (
                <div className="meta-chip">
                  <span className="meta-label">Size</span>
                  <span className="meta-value">{formatBytes(object.size)}</span>
                </div>
              )}
              {kind === 'image' && imageResolution && (
                <div className="meta-chip">
                  <span className="meta-label">Resolution</span>
                  <span className="meta-value">
                    {imageResolution.width}×{imageResolution.height}
                  </span>
                </div>
              )}
              {kind === 'video' && videoMeta?.width && videoMeta?.height && (
                <div className="meta-chip">
                  <span className="meta-label">Resolution</span>
                  <span className="meta-value">
                    {videoMeta.width}×{videoMeta.height}
                  </span>
                </div>
              )}
              {kind === 'video' && videoMeta?.duration ? (
                <div className="meta-chip">
                  <span className="meta-label">Duration</span>
                  <span className="meta-value">{formatDuration(videoMeta.duration)}</span>
                </div>
              ) : null}
              {object.storageClass && (
                <div className="meta-chip">
                  <span className="meta-label">Storage</span>
                  <span className="meta-value">{object.storageClass}</span>
                </div>
              )}
              {object.lastModified && (
                <div className="meta-chip">
                  <span className="meta-label">Modified</span>
                  <span className="meta-value">{object.lastModified}</span>
                </div>
              )}
              {loadElapsedMs !== null && (
                <div className="meta-chip">
                  <span className="meta-label">Elapsed</span>
                  <span className="meta-value">{formatElapsedMs(loadElapsedMs)}</span>
                </div>
              )}
            </div>
          </div>
          <div className="preview-actions">
            {kind === 'text' && canEditText && (
              <button className="preview-btn primary" onClick={handleSave} disabled={!dirty || saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            )}
            {onDownload && (
              <button className="preview-btn" onClick={() => onDownload(object)} disabled={saving || loading}>
                Download
              </button>
            )}
            <button
              className="icon-close-btn"
              type="button"
              onClick={requestClose}
              disabled={saving}
              aria-label="Close preview"
              title="Close"
            >
              ×
            </button>
          </div>
        </div>
        <div className="preview-body">
          {error && <div className="preview-error-banner">{error}</div>}
          {renderBody()}
        </div>
      </div>
    </div>
  );
}
