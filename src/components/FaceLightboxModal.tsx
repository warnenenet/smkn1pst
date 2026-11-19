import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Columns2, X, ZoomIn, ZoomOut } from 'lucide-react';

export interface FaceGalleryItem {
  src: string;
  label: string;
  meta?: string | null;
  timestamp?: string | null;
  cameraName?: string | null;
  similarity?: number | null;
  qualityScore?: number | null;
  isReference?: boolean;
}

interface FaceLightboxModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  referenceItem?: FaceGalleryItem | null;
  items: FaceGalleryItem[];
  initialIndex?: number;
}

export const FaceLightboxModal: React.FC<FaceLightboxModalProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  referenceItem,
  items,
  initialIndex = 0,
}) => {
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const [zoom2x, setZoom2x] = useState(false);
  const [compareSideBySide, setCompareSideBySide] = useState(Boolean(referenceItem));

  useEffect(() => {
    if (isOpen) {
      setActiveIndex(Math.max(0, Math.min(initialIndex, Math.max(0, items.length - 1))));
      setZoom2x(false);
      setCompareSideBySide(Boolean(referenceItem));
    }
  }, [isOpen, initialIndex, items.length, referenceItem]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowLeft' && items.length > 1) {
        setActiveIndex((prev) => (prev - 1 + items.length) % items.length);
      } else if (e.key === 'ArrowRight' && items.length > 1) {
        setActiveIndex((prev) => (prev + 1) % items.length);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, items.length, onClose]);

  if (!isOpen || items.length === 0) return null;

  const current = items[Math.min(activeIndex, items.length - 1)];
  const showCompare = Boolean(compareSideBySide && referenceItem && referenceItem.src);

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl border border-slate-200 shadow-2xl w-full max-w-5xl max-h-[94vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="px-4 sm:px-6 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 bg-slate-50">
          <div className="min-w-0">
            <h2 className="text-sm sm:text-base font-bold text-slate-900 truncate">{title}</h2>
            {subtitle && <p className="text-xs text-slate-500 mt-0.5 truncate">{subtitle}</p>}
          </div>
          <div className="flex items-center gap-2">
            {referenceItem && referenceItem.src && (
              <button
                type="button"
                onClick={() => setCompareSideBySide((v) => !v)}
                aria-label="Bandingkan berdampingan"
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md border transition-colors ${
                  showCompare
                    ? 'bg-blue-700 text-white border-blue-700'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                }`}
              >
                <Columns2 className="w-3.5 h-3.5" />
                Dobel Crosscheck
              </button>
            )}
            <button
              type="button"
              onClick={() => setZoom2x((v) => !v)}
              aria-label={zoom2x ? 'Ukuran normal' : 'Perbesar 2x'}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md border transition-colors ${
                zoom2x
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
              }`}
            >
              {zoom2x ? <ZoomOut className="w-3.5 h-3.5" /> : <ZoomIn className="w-3.5 h-3.5" />}
              {zoom2x ? 'Normal (1x)' : 'Perbesar (2x)'}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Tutup pratinjau"
              className="p-1.5 rounded-md border border-slate-300 bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-100"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Main Viewer */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 bg-slate-900/95">
          <div className={`grid gap-4 items-stretch ${showCompare ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1'}`}>
            {showCompare && referenceItem && (
              <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 flex flex-col">
                <div className="flex items-center justify-between text-xs text-slate-300 pb-2 mb-2 border-b border-slate-800">
                  <span className="font-semibold text-emerald-400">{referenceItem.label}</span>
                  {referenceItem.meta && <span className="font-mono text-[11px] text-slate-400">{referenceItem.meta}</span>}
                </div>
                <div className="flex-1 min-h-[260px] sm:min-h-[360px] max-h-[54vh] overflow-auto flex items-center justify-center bg-black/40 rounded">
                  <img
                    src={referenceItem.src}
                    alt={referenceItem.label}
                    referrerPolicy="no-referrer"
                    className={`transition-transform duration-200 rounded object-contain ${
                      zoom2x ? 'scale-150 origin-center cursor-zoom-out' : 'max-h-[50vh] max-w-full cursor-zoom-in'
                    }`}
                    onClick={() => setZoom2x((v) => !v)}
                  />
                </div>
              </div>
            )}

            <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 flex flex-col relative">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-200 pb-2 mb-2 border-b border-slate-800">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-semibold text-amber-300 truncate">{current.label}</span>
                  <span className="font-mono text-[11px] text-slate-400">
                    ({activeIndex + 1}/{items.length})
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-slate-300 tabular-nums">
                  {typeof current.similarity === 'number' && (
                    <span className="px-2 py-0.5 rounded bg-blue-900/70 text-blue-200">
                      Kecocokan {(current.similarity * 100).toFixed(1)}%
                    </span>
                  )}
                  {typeof current.qualityScore === 'number' && (
                    <span className="px-2 py-0.5 rounded bg-emerald-900/70 text-emerald-200">
                      Kualitas {(current.qualityScore * 100).toFixed(1)}%
                    </span>
                  )}
                  {current.timestamp && <span>{current.timestamp}</span>}
                  {current.cameraName && <span>· {current.cameraName}</span>}
                </div>
              </div>

              <div className="flex-1 min-h-[260px] sm:min-h-[360px] max-h-[54vh] overflow-auto flex items-center justify-center bg-black/40 rounded relative">
                {items.length > 1 && (
                  <button
                    type="button"
                    aria-label="Foto sebelumnya"
                    onClick={() => setActiveIndex((prev) => (prev - 1 + items.length) % items.length)}
                    className="absolute left-2 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-slate-900/80 text-white hover:bg-slate-800 border border-slate-700"
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                )}

                <img
                  src={current.src}
                  alt={current.label}
                  referrerPolicy="no-referrer"
                  className={`transition-transform duration-200 rounded object-contain ${
                    zoom2x ? 'scale-150 origin-center cursor-zoom-out' : 'max-h-[50vh] max-w-full cursor-zoom-in'
                  }`}
                  onClick={() => setZoom2x((v) => !v)}
                />

                {items.length > 1 && (
                  <button
                    type="button"
                    aria-label="Foto berikutnya"
                    onClick={() => setActiveIndex((prev) => (prev + 1) % items.length)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-slate-900/80 text-white hover:bg-slate-800 border border-slate-700"
                  >
                    <ChevronRight className="w-5 h-5" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Thumbnail Strip of ALL images */}
        {items.length > 1 && (
          <div className="px-4 py-3 border-t border-slate-200 bg-slate-50">
            <div className="text-[11px] font-semibold text-slate-600 mb-2">
              Semua Foto / Gambar Hit ({items.length}) — klik untuk crosscheck
            </div>
            <div className="flex items-center gap-2.5 overflow-x-auto pb-1">
              {items.map((item, idx) => {
                const selected = idx === activeIndex;
                return (
                  <button
                    key={`${item.src}-${idx}`}
                    type="button"
                    onClick={() => setActiveIndex(idx)}
                    className={`shrink-0 rounded-md p-1 border transition-all text-left bg-white ${
                      selected
                        ? 'border-blue-600 ring-2 ring-blue-500/40'
                        : 'border-slate-200 hover:border-slate-400'
                    }`}
                  >
                    <img
                      src={item.src}
                      alt={item.label}
                      referrerPolicy="no-referrer"
                      className="w-16 h-16 rounded object-cover bg-slate-100"
                    />
                    <div className="mt-1 text-[10px] font-mono text-slate-700 truncate max-w-[68px]">
                      {typeof item.similarity === 'number'
                        ? `${Math.round(item.similarity * 100)}%`
                        : item.label}
                    </div>
                    {item.timestamp && (
                      <div className="text-[9px] font-mono text-slate-400 truncate max-w-[68px]">
                        {item.timestamp.slice(11, 19) || item.timestamp}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
