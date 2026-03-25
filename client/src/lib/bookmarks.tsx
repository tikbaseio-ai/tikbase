import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { VideoWithProduct, Product } from './supabase';

interface BookmarkState {
  savedVideos: VideoWithProduct[];
  savedProducts: Product[];
  isVideoBookmarked: (videoId: number) => boolean;
  isProductBookmarked: (productId: string) => boolean;
  toggleVideoBookmark: (video: VideoWithProduct) => void;
  toggleProductBookmark: (product: Product) => void;
}

const BookmarkContext = createContext<BookmarkState | null>(null);

export function BookmarkProvider({ children }: { children: ReactNode }) {
  const [savedVideos, setSavedVideos] = useState<VideoWithProduct[]>([]);
  const [savedProducts, setSavedProducts] = useState<Product[]>([]);

  const isVideoBookmarked = useCallback(
    (videoId: number) => savedVideos.some(v => v.id === videoId),
    [savedVideos]
  );

  const isProductBookmarked = useCallback(
    (productId: string) => savedProducts.some(p => p.product_id === productId),
    [savedProducts]
  );

  const toggleVideoBookmark = useCallback((video: VideoWithProduct) => {
    setSavedVideos(prev => {
      const exists = prev.some(v => v.id === video.id);
      if (exists) return prev.filter(v => v.id !== video.id);
      return [...prev, video];
    });
  }, []);

  const toggleProductBookmark = useCallback((product: Product) => {
    setSavedProducts(prev => {
      const exists = prev.some(p => p.product_id === product.product_id);
      if (exists) return prev.filter(p => p.product_id !== product.product_id);
      return [...prev, product];
    });
  }, []);

  return (
    <BookmarkContext.Provider
      value={{
        savedVideos,
        savedProducts,
        isVideoBookmarked,
        isProductBookmarked,
        toggleVideoBookmark,
        toggleProductBookmark,
      }}
    >
      {children}
    </BookmarkContext.Provider>
  );
}

export function useBookmarks() {
  const ctx = useContext(BookmarkContext);
  if (!ctx) throw new Error('useBookmarks must be used within BookmarkProvider');
  return ctx;
}
