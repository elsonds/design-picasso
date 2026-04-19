import React, { useEffect, useMemo, useState } from 'react';
import { Download, Maximize2, X, ImageIcon, Copy, Check, FolderDown } from 'lucide-react';
import { fetchGallery, fetchGalleryImage, type GalleryEntry } from './api-service';

export interface GeneratedImage {
  id: string;
  url: string;
  description: string;
  metadata?: {
    mode: string;
    seed: number;
    width: number;
    height: number;
    time: number;
  };
  style?: string;
  // If this came from the persistent gallery, the S3 key so we can lazy-load
  s3Key?: string;
  email?: string;
  timestamp?: number;
}

interface ImageGridPanelProps {
  images: GeneratedImage[];          // In-session generations from App state
  isOpen: boolean;
  selectedImageId: string | null;
  onSelectImage: (image: GeneratedImage) => void;
  onDeselectImage: () => void;
  onClose: () => void;
  email?: string;                    // Current user's email for Mine tab
}

type Scope = 'session' | 'mine' | 'team';

function relativeTime(ts: number): string {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function ImageGridPanel({
  images,
  isOpen,
  selectedImageId,
  onSelectImage,
  onDeselectImage,
  onClose,
  email,
}: ImageGridPanelProps) {
  const [hoveredImageId, setHoveredImageId] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>('session');
  const [remote, setRemote] = useState<GalleryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  // Keyed by S3 key — data URLs lazy-loaded from the proxy endpoint
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Load remote gallery when scope changes
  useEffect(() => {
    if (!isOpen) return;
    if (scope === 'session') return;
    setLoading(true);
    setRemote([]);
    fetchGallery(scope, email).then((data) => {
      setRemote(data);
      setLoading(false);
    });
  }, [isOpen, scope, email]);

  // Build display list
  const displayed: GeneratedImage[] = useMemo(() => {
    if (scope === 'session') return [...images].reverse();
    return remote.map((e) => ({
      id: e.job_id,
      url: thumbs[e.key] || '', // will populate as thumbs load
      description: e.prompt,
      metadata: e.seed !== undefined
        ? {
            mode: e.mode || 'Prompt',
            seed: e.seed,
            width: e.width || 1328,
            height: e.height || 1328,
            time: e.execution_time || 0,
          }
        : undefined,
      style: e.style,
      s3Key: e.key,
      email: e.email,
      timestamp: e.timestamp,
    }));
  }, [scope, images, remote, thumbs]);

  // Lazy-load thumbnails for visible remote entries
  useEffect(() => {
    if (scope === 'session') return;
    const missing = remote.filter((e) => !thumbs[e.key]).slice(0, 24);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const entry of missing) {
        if (cancelled) return;
        const data = await fetchGalleryImage(entry.key);
        if (data && !cancelled) {
          setThumbs((prev) => ({ ...prev, [entry.key]: data }));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [scope, remote, thumbs]);

  const handleImageClick = (image: GeneratedImage) => {
    if (!image.url) return; // thumb not loaded yet
    if (selectedImageId === image.id) onDeselectImage();
    else onSelectImage(image);
  };

  const handleDownload = (e: React.MouseEvent, image: GeneratedImage) => {
    e.stopPropagation();
    if (!image.url) return;
    const link = document.createElement('a');
    link.href = image.url;
    link.download = `illustration-${image.id}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleExpand = (e: React.MouseEvent, image: GeneratedImage) => {
    e.stopPropagation();
    if (image.url) onSelectImage(image);
  };

  const [isDownloadingAll, setIsDownloadingAll] = useState(false);

  const handleDownloadAll = async () => {
    if (displayed.length === 0 || isDownloadingAll) return;
    setIsDownloadingAll(true);
    try {
      for (let i = 0; i < displayed.length; i++) {
        const img = displayed[i];
        if (!img.url) continue;
        const link = document.createElement('a');
        link.href = img.url;
        link.download = `${(img.style || 'illustration').toLowerCase()}-${img.metadata?.seed || img.id}.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        if (i < displayed.length - 1) await new Promise((r) => setTimeout(r, 250));
      }
    } finally {
      setIsDownloadingAll(false);
    }
  };

  const handleCopyPrompt = async (e: React.MouseEvent, image: GeneratedImage) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(image.description || '');
      setCopiedId(image.id);
      setTimeout(() => {
        setCopiedId((current) => (current === image.id ? null : current));
      }, 1500);
    } catch (err) {
      console.warn('[Gallery] Copy failed:', err);
    }
  };

  const styles = `
    @keyframes slideInFromRight {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideOutToRight {
      from { transform: translateX(0); opacity: 1; }
      to { transform: translateX(100%); opacity: 0; }
    }
    .image-grid-panel {
      animation: ${isOpen ? 'slideInFromRight' : 'slideOutToRight'} 0.3s ease-out forwards;
    }
    .image-card-description {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
    }
    .image-card-hover {
      opacity: 0;
      transition: opacity 0.2s ease-out;
    }
    .image-card:hover .image-card-hover {
      opacity: 1;
    }
  `;

  if (!isOpen && images.length === 0 && scope === 'session') {
    return null;
  }

  const count = scope === 'session' ? images.length : remote.length;

  return (
    <>
      <style>{styles}</style>
      <div
        className="image-grid-panel h-full flex flex-col flex-shrink-0"
        style={{
          width: '420px',
          backgroundColor: 'rgba(12, 15, 22, 0.97)',
          borderLeft: '1px solid rgba(148, 163, 184, 0.06)',
          backdropFilter: 'blur(20px)',
          display: isOpen ? 'flex' : 'none',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{
          borderBottomColor: 'rgba(148, 163, 184, 0.06)',
        }}>
          <div className="flex items-center gap-2">
            <ImageIcon size={16} className="text-slate-500" />
            <h2 className="text-sm font-semibold text-slate-300">
              Gallery
            </h2>
            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-400">
              {count}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {/* Save All */}
            <button
              onClick={handleDownloadAll}
              disabled={count === 0 || isDownloadingAll}
              className="p-1.5 rounded-md hover:bg-white/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ color: count > 0 && !isDownloadingAll ? '#e2e8f0' : '#64748b' }}
              title={count > 0 ? `Save all (${count})` : 'No images to save'}
            >
              <FolderDown size={15} />
            </button>
            {/* Close */}
            <button
              onClick={onClose}
              className="p-1 hover:bg-white/10 rounded-md transition-colors"
              aria-label="Close panel"
            >
              <X size={16} className="text-slate-500" />
            </button>
          </div>
        </div>

        {/* Scope tabs */}
        <div
          className="flex items-center gap-0.5 px-4 pt-3 pb-0"
          style={{ borderBottom: '1px solid rgba(148,163,184,0.04)' }}
        >
          {(['session', 'mine', 'team'] as Scope[]).map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className="px-3 py-1.5 text-xs font-medium transition-colors relative"
              style={{
                color: scope === s ? '#e2e8f0' : '#64748b',
              }}
            >
              {s === 'session' ? 'Session' : s === 'mine' ? 'Mine' : 'Team'}
              {scope === s && (
                <div
                  className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full"
                  style={{ backgroundColor: '#94a3b8' }}
                />
              )}
            </button>
          ))}
        </div>

        {/* Grid Container */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <p className="text-slate-600 text-[13px]">Loading...</p>
            </div>
          )}
          {!loading && displayed.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <ImageIcon size={32} className="text-slate-700 mb-3" />
              <p className="text-slate-600 text-[13px]">
                {scope === 'session'
                  ? 'No illustrations this session'
                  : scope === 'mine'
                    ? 'No saved illustrations yet'
                    : 'No team illustrations yet'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {displayed.map((image) => (
                <div
                  key={image.id}
                  className="image-card cursor-pointer"
                  onClick={() => handleImageClick(image)}
                  onMouseEnter={() => setHoveredImageId(image.id)}
                  onMouseLeave={() => setHoveredImageId(null)}
                >
                  <div
                    className="relative aspect-square rounded-lg overflow-hidden group transition-all"
                    style={{
                      border: selectedImageId === image.id
                        ? '2px solid #94a3b8'
                        : '1px solid rgba(148, 163, 184, 0.06)',
                      backgroundColor: 'rgba(15, 23, 42, 0.5)',
                    }}
                  >
                    {image.url ? (
                      <img
                        src={image.url}
                        alt={image.description}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-slate-700 text-[10px]">
                        Loading...
                      </div>
                    )}

                    {image.url && (
                      <div
                        className="image-card-hover absolute inset-0 flex items-center justify-center gap-2"
                        style={{
                          backgroundColor: 'rgba(0, 0, 0, 0.6)',
                          backdropFilter: 'blur(4px)',
                        }}
                      >
                        <button
                          onClick={(e) => handleDownload(e, image)}
                          className="p-2 rounded-md hover:bg-white/20 transition-colors"
                          title="Download"
                        >
                          <Download size={16} style={{ color: 'rgba(255, 255, 255, 0.9)' }} />
                        </button>
                        <button
                          onClick={(e) => handleCopyPrompt(e, image)}
                          className="p-2 rounded-md hover:bg-white/20 transition-colors"
                          title="Copy prompt"
                        >
                          {copiedId === image.id ? (
                            <Check size={16} style={{ color: '#86efac' }} />
                          ) : (
                            <Copy size={16} style={{ color: 'rgba(255, 255, 255, 0.9)' }} />
                          )}
                        </button>
                        <button
                          onClick={(e) => handleExpand(e, image)}
                          className="p-2 rounded-md hover:bg-white/20 transition-colors"
                          title="Expand"
                        >
                          <Maximize2 size={16} style={{ color: 'rgba(255, 255, 255, 0.9)' }} />
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="mt-2 flex items-start gap-1.5">
                    <p
                      className="image-card-description text-xs flex-1"
                      style={{ color: 'rgba(255, 255, 255, 0.5)', fontSize: '11px', lineHeight: '1.4' }}
                      title={image.description}
                    >
                      {image.description}
                    </p>
                    <button
                      onClick={(e) => handleCopyPrompt(e, image)}
                      className="p-0.5 rounded hover:bg-white/10 transition-colors flex-shrink-0"
                      title={copiedId === image.id ? 'Copied!' : 'Copy prompt'}
                      style={{ color: copiedId === image.id ? '#86efac' : '#64748b' }}
                    >
                      {copiedId === image.id ? <Check size={11} /> : <Copy size={11} />}
                    </button>
                  </div>
                  {(image.email || image.timestamp) && scope !== 'session' && (
                    <div className="text-[10px] text-slate-600 mt-0.5 flex gap-1">
                      {scope === 'team' && image.email && (
                        <span className="text-slate-500">{image.email.split('@')[0]}</span>
                      )}
                      {image.timestamp && <span>· {relativeTime(image.timestamp)}</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Metadata Footer (shown if image selected) */}
        {selectedImageId && displayed.find(img => img.id === selectedImageId)?.metadata && (
          <div
            className="px-4 py-3 border-t text-xs"
            style={{
              borderTopColor: 'rgba(148, 163, 184, 0.06)',
              color: '#64748b',
            }}
          >
            {(() => {
              const image = displayed.find(img => img.id === selectedImageId);
              if (!image?.metadata) return null;
              const { seed, width, height, time } = image.metadata;
              return (
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <span>Seed:</span>
                    <span className="font-mono text-slate-400">{seed}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Resolution:</span>
                    <span className="font-mono text-slate-400">{width}×{height}</span>
                  </div>
                  {time ? (
                    <div className="flex justify-between">
                      <span>Time:</span>
                      <span className="font-mono text-slate-400">{time}s</span>
                    </div>
                  ) : null}
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </>
  );
}
