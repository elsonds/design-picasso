import React, { useState } from 'react';
import { Download, Maximize2, X, ChevronRight, ImageIcon } from 'lucide-react';

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
}

interface ImageGridPanelProps {
  images: GeneratedImage[];
  isOpen: boolean;
  selectedImageId: string | null;
  onSelectImage: (image: GeneratedImage) => void;
  onDeselectImage: () => void;
  onClose: () => void;
}

export function ImageGridPanel({
  images,
  isOpen,
  selectedImageId,
  onSelectImage,
  onDeselectImage,
  onClose,
}: ImageGridPanelProps) {
  const [hoveredImageId, setHoveredImageId] = useState<string | null>(null);

  const sortedImages = [...images].reverse();

  const handleImageClick = (image: GeneratedImage) => {
    if (selectedImageId === image.id) {
      onDeselectImage();
    } else {
      onSelectImage(image);
    }
  };

  const handleDownload = (e: React.MouseEvent, image: GeneratedImage) => {
    e.stopPropagation();
    const link = document.createElement('a');
    link.href = image.url;
    link.download = `illustration-${image.id}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleExpand = (e: React.MouseEvent, image: GeneratedImage) => {
    e.stopPropagation();
    onSelectImage(image);
  };

  const styles = `
    @keyframes slideInFromRight {
      from {
        transform: translateX(100%);
        opacity: 0;
      }
      to {
        transform: translateX(0);
        opacity: 1;
      }
    }

    @keyframes slideOutToRight {
      from {
        transform: translateX(0);
        opacity: 1;
      }
      to {
        transform: translateX(100%);
        opacity: 0;
      }
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

  if (!isOpen && images.length === 0) {
    return null;
  }

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
              {images.length}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-white/10 rounded-md transition-colors"
            aria-label="Close panel"
          >
            <X size={16} className="text-slate-500" />
          </button>
        </div>

        {/* Grid Container */}
        <div className="flex-1 overflow-y-auto p-4">
          {sortedImages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <ImageIcon size={32} className="text-slate-700 mb-3" />
              <p className="text-slate-600 text-[13px]">
                No illustrations yet
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {sortedImages.map((image) => (
                <div
                  key={image.id}
                  className="image-card cursor-pointer"
                  onClick={() => handleImageClick(image)}
                >
                  {/* Image Container */}
                  <div
                    className="relative aspect-square rounded-lg overflow-hidden group transition-all"
                    style={{
                      border: selectedImageId === image.id
                        ? '2px solid #94a3b8'
                        : '1px solid rgba(148, 163, 184, 0.06)',
                      backgroundColor: 'rgba(15, 23, 42, 0.5)',
                    }}
                  >
                    {/* Image */}
                    <img
                      src={image.url}
                      alt={image.description}
                      className="w-full h-full object-cover"
                    />

                    {/* Hover Overlay */}
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
                        onClick={(e) => handleExpand(e, image)}
                        className="p-2 rounded-md hover:bg-white/20 transition-colors"
                        title="Expand"
                      >
                        <Maximize2 size={16} style={{ color: 'rgba(255, 255, 255, 0.9)' }} />
                      </button>
                    </div>
                  </div>

                  {/* Description */}
                  <p
                    className="image-card-description mt-2 text-xs"
                    style={{
                      color: 'rgba(255, 255, 255, 0.5)',
                      fontSize: '11px',
                      lineHeight: '1.4',
                    }}
                    title={image.description}
                  >
                    {image.description}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Metadata Footer (shown if image selected) */}
        {selectedImageId && sortedImages.find(img => img.id === selectedImageId)?.metadata && (
          <div
            className="px-4 py-3 border-t text-xs"
            style={{
              borderTopColor: 'rgba(148, 163, 184, 0.06)',
              color: '#64748b',
            }}
          >
            {(() => {
              const image = sortedImages.find(img => img.id === selectedImageId);
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
                  {time && (
                    <div className="flex justify-between">
                      <span>Time:</span>
                      <span className="font-mono text-slate-400">{(time / 1000).toFixed(2)}s</span>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </>
  );
}
