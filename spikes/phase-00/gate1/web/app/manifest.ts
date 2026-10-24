import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'noteOS',
    short_name: 'noteOS',
    description: 'Private notes saved on this device.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone'],
    background_color: '#f7f5f0',
    theme_color: '#f7f5f0',
    icons: [
      { src: '/icons/noteos-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/noteos-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/noteos-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
